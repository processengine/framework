import { afterEach, describe, expect, it } from 'vitest';
import {
  compileFlow,
  Conductor,
  evolve,
  failure,
  FlowDefinitionError,
  operationCommandEnvelope,
  responseEnvelope,
  StaticArtifactRegistry,
  StaticOperationCatalog,
  success,
  assertOperationCommand,
} from '../src/index.js';
import {
  createMemoryStorage,
  ManualClock,
  MemoryMessageTransport,
  MemoryProcessStorage,
  runMessageTransportConformance,
  runProcessStorageConformance,
} from '../src/testing.js';
import type { MessageEnvelope, MessageTransport } from '../src/index.js';

const checkoutDefinition = {
  id: 'shop.checkout',
  version: '1.0.0',
  start: 'validate',
  steps: {
    validate: {
      type: 'operation', operation: 'payment.validate',
      next: 'route-validation', onError: 'route-validation-error',
    },
    'route-validation': {
      type: 'switch',
      input: { step: 'validate', resultType: 'response' },
      key: 'resultCode',
      routes: { VALID: 'valid', INVALID: 'remap' },
    },
    remap: {
      type: 'operation', operation: 'errors.remap',
      input: { step: 'validate', resultType: 'response' },
      next: 'invalid', onError: 'route-remap-error',
    },
    'route-validation-error': {
      type: 'switch',
      input: { step: 'validate', resultType: 'error' },
      key: 'code',
      routes: { PAYMENT_REJECTED: 'rejected', PROCESSENGINE_COMPLETION_TIMEOUT: 'unavailable' },
    },
    'route-remap-error': {
      type: 'switch',
      input: { step: 'remap', resultType: 'error' },
      key: 'code',
      routes: { REMAP_FAILED: 'remap-failed' },
    },
    valid: { type: 'end', outcome: 'VALID' },
    invalid: {
      type: 'end', outcome: 'INVALID',
      input: { step: 'remap', resultType: 'response' },
    },
    rejected: {
      type: 'end', outcome: 'REJECTED',
      input: { step: 'validate', resultType: 'error' },
    },
    unavailable: {
      type: 'end', outcome: 'UNAVAILABLE',
      input: { step: 'validate', resultType: 'error' },
    },
    'remap-failed': {
      type: 'end', outcome: 'REMAP_FAILED',
      input: { step: 'remap', resultType: 'error' },
    },
  },
};

describe('Flow3 compiler', () => {
  it('compiles the canonical operation/switch/end format', () => {
    const compiled = compileFlow(checkoutDefinition);
    expect(compiled.definition).toEqual(checkoutDefinition);
    expect(compiled.digest).toMatch(/^sha256:/u);
    expect(Object.isFrozen(compiled.definition)).toBe(true);
  });

  it('rejects legacy templates, select/cases/default and schemaVersion', () => {
    expect(() => compileFlow({ ...checkoutDefinition, schemaVersion: '1' })).toThrow(FlowDefinitionError);
    const legacy = structuredClone(checkoutDefinition) as Record<string, any>;
    legacy.steps['route-validation'] = {
      type: 'switch', select: { $ref: '$.results.validate.response.resultCode' },
      cases: [{ equals: 'VALID', next: 'valid' }], default: 'invalid',
    };
    expect(() => compileFlow(legacy)).toThrow(FlowDefinitionError);
  });

  it('rejects cycles and data references unavailable on the active status path', () => {
    const cyclic = structuredClone(checkoutDefinition) as Record<string, any>;
    cyclic.steps.valid = {
      type: 'switch', input: { step: 'validate', resultType: 'response' },
      key: 'resultCode', routes: { VALID: 'route-validation' },
    };
    expect(() => compileFlow(cyclic)).toThrowError(/acyclic/u);

    const wrongChannel = structuredClone(checkoutDefinition) as Record<string, any>;
    wrongChannel.steps.remap.input.resultType = 'error';
    expect(() => compileFlow(wrongChannel)).toThrowError(/not available/u);
  });

  it('allows a consumer to read an older guaranteed completion', () => {
    const flow = {
      id: 'older.source', version: '1', start: 'first',
      steps: {
        first: { type: 'operation', operation: 'first', next: 'second', onError: 'failed' },
        second: {
          type: 'operation', operation: 'second',
          input: { step: 'first', resultType: 'response' }, next: 'third', onError: 'failed-second',
        },
        third: {
          type: 'operation', operation: 'third',
          input: { step: 'first', resultType: 'response' }, next: 'done', onError: 'failed-third',
        },
        done: { type: 'end', outcome: 'DONE' },
        failed: { type: 'end', outcome: 'FAILED' },
        'failed-second': { type: 'end', outcome: 'FAILED_SECOND' },
        'failed-third': { type: 'end', outcome: 'FAILED_THIRD' },
      },
    };
    expect(() => compileFlow(flow)).not.toThrow();
  });

  it('recompiles supplied artifacts and rejects a forged pinned digest', () => {
    const compiled = compileFlow(checkoutDefinition);
    expect(() => new StaticArtifactRegistry([{ ...compiled, digest: 'sha256:forged' }]))
      .toThrowError(/invalid digest/u);
  });

  it('stores a verified frozen artifact independently of mutable caller data', () => {
    const compiled = compileFlow(checkoutDefinition);
    const mutableDefinition = structuredClone(compiled.definition) as Record<string, any>;
    const registry = new StaticArtifactRegistry([{ definition: mutableDefinition, digest: compiled.digest }]);
    mutableDefinition.steps.valid.outcome = 'MUTATED';
    const stored = registry.get('shop.checkout', '1.0.0');
    expect(stored?.definition.steps.valid).toMatchObject({ outcome: 'VALID' });
    expect(Object.isFrozen(stored?.definition)).toBe(true);
  });
});

describe('operation protocol correlation', () => {
  it('binds command partition and request identity to the process occurrence', () => {
    const command = operationCommandEnvelope({
      source: 'host', destination: 'commands', responseDestination: 'completions',
      occurredAt: '2026-01-01T00:00:00.000Z',
      payload: {
        requestId: 'checkout-1:reserve', instanceId: 'checkout-1', stepId: 'reserve',
        operation: 'warehouse.reserve', input: {},
      },
    });
    expect(assertOperationCommand(command).requestId).toBe('checkout-1:reserve');
    expect(() => assertOperationCommand({ ...command, partitionKey: 'checkout-2' }))
      .toThrowError(/partitionKey/u);
    expect(() => assertOperationCommand({
      ...command,
      payload: { ...command.payload as Record<string, unknown>, requestId: 'forged-request' } as any,
    })).toThrowError(/requestId/u);
  });
});

describe('pure conductor kernel', () => {
  it('stores canonical completions and passes one whole response to the next operation', () => {
    const flow = compileFlow(checkoutDefinition);
    const started = evolve(flow, undefined, {
      type: 'START', instanceId: 'checkout-1', input: { amount: 120_000 }, at: '2026-01-01T00:00:00.000Z',
    });
    expect(started.action).toMatchObject({
      type: 'DISPATCH_OPERATION', requestId: 'checkout-1:validate', input: { amount: 120_000 },
    });

    const validation = { resultCode: 'INVALID', errors: [{ code: '10002', field: 'amount' }] };
    const remap = evolve(flow, started.state, {
      type: 'OPERATION_COMPLETED',
      requestId: 'checkout-1:validate',
      completion: success(validation),
      at: '2026-01-01T00:00:01.000Z',
    });
    expect(remap.action).toMatchObject({ type: 'DISPATCH_OPERATION', operation: 'errors.remap', input: validation });
    expect(remap.state.results.validate).toEqual({ status: 'SUCCESS', response: validation, error: null });

    const mapped = { errorsList: [{ field: 'amount' }] };
    const finished = evolve(flow, remap.state, {
      type: 'OPERATION_COMPLETED',
      requestId: 'checkout-1:remap',
      completion: success(mapped),
      at: '2026-01-01T00:00:02.000Z',
    });
    expect(finished.state).toMatchObject({
      lifecycle: 'COMPLETED', outcome: 'INVALID', response: mapped, error: null, pending: null,
    });
  });

  it('routes the explicit error channel and never adds a route field', () => {
    const flow = compileFlow(checkoutDefinition);
    const started = evolve(flow, undefined, {
      type: 'START', instanceId: 'checkout-2', input: {}, at: '2026-01-01T00:00:00.000Z',
    });
    const error = { code: 'PAYMENT_REJECTED', message: 'Rejected', details: null };
    const finished = evolve(flow, started.state, {
      type: 'OPERATION_COMPLETED', requestId: 'checkout-2:validate', completion: failure(error),
      at: '2026-01-01T00:00:01.000Z',
    });
    expect(finished.state).toMatchObject({ lifecycle: 'COMPLETED', outcome: 'REJECTED', response: null, error });
    expect(finished.state.results.validate).not.toHaveProperty('route');
  });

  it('turns an unknown switch value into durable FAULTED state', () => {
    const flow = compileFlow(checkoutDefinition);
    const started = evolve(flow, undefined, {
      type: 'START', instanceId: 'checkout-fault', input: {}, at: '2026-01-01T00:00:00.000Z',
    });
    const faulted = evolve(flow, started.state, {
      type: 'OPERATION_COMPLETED', requestId: 'checkout-fault:validate',
      completion: success({ resultCode: 'NEW_VALUE' }), at: '2026-01-01T00:00:01.000Z',
    });
    expect(faulted.action.type).toBe('PROCESS_FAULTED');
    expect(faulted.state).toMatchObject({ lifecycle: 'FAULTED', fault: { code: 'SWITCH_ROUTE_UNKNOWN' } });
  });
});

const oneCallDefinition = {
  id: 'test.one-call', version: '1', start: 'call',
  steps: {
    call: { type: 'operation', operation: 'test.call', next: 'done', onError: 'failed' },
    done: { type: 'end', outcome: 'DONE', input: { step: 'call', resultType: 'response' } },
    failed: { type: 'end', outcome: 'FAILED', input: { step: 'call', resultType: 'error' } },
  },
};

const running: Conductor[] = [];
afterEach(async () => {
  for (const conductor of running.splice(0)) await conductor.stop();
});

function runtimeParts(clock = new ManualClock(), transport: MessageTransport = new MemoryMessageTransport()) {
  const operations = new StaticOperationCatalog([{
    operation: 'test.call', destination: 'test.commands',
    completionSource: 'service',
    policy: { id: 'test', version: '1', completionTimeoutMs: 1_000, dispatch: { maxAttempts: 3, retryDelayMs: 10 } },
  }]);
  const compiled = compileFlow(oneCallDefinition, { operations });
  return { clock, transport, operations, artifacts: new StaticArtifactRegistry([compiled]), storage: createMemoryStorage() };
}

function conductorFor(parts: ReturnType<typeof runtimeParts>): Conductor {
  const conductor = new Conductor({
    source: 'host', completionDestination: 'host.completions',
    artifacts: parts.artifacts, operations: parts.operations,
    storage: parts.storage, transport: parts.transport, clock: parts.clock,
    worker: { pollIntervalMs: 60_000, outboxLeaseMs: 100 },
  });
  running.push(conductor);
  return conductor;
}

describe('durable Conductor', () => {
  it('serializes concurrent starts and can retry after a transient subscription failure', async () => {
    class FailOnceSubscribeTransport extends MemoryMessageTransport {
      startCalls = 0;
      subscribeCalls = 0;
      stopCalls = 0;
      override async start(): Promise<void> { this.startCalls += 1; await super.start(); }
      override async subscribe(options: Parameters<MemoryMessageTransport['subscribe']>[0]): Promise<() => Promise<void>> {
        this.subscribeCalls += 1;
        await Promise.resolve();
        if (this.subscribeCalls === 1) throw new Error('subscription failed once');
        return super.subscribe(options);
      }
      override async stop(): Promise<void> { this.stopCalls += 1; await super.stop(); }
    }
    class TerminalClosingStorage extends MemoryProcessStorage {
      initializeCalls = 0;
      closeCalls = 0;
      closed = false;
      override async initialize(): Promise<void> {
        this.initializeCalls += 1;
        if (this.closed) throw new Error('terminal storage cannot be reopened');
        await super.initialize();
      }
      override async close(): Promise<void> {
        this.closeCalls += 1;
        this.closed = true;
        await super.close();
      }
    }
    const transport = new FailOnceSubscribeTransport();
    const storage = new TerminalClosingStorage();
    const parts = { ...runtimeParts(new ManualClock(), transport), storage };
    const conductor = conductorFor(parts);

    const starts = await Promise.allSettled([conductor.start(), conductor.start()]);
    expect(starts.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(transport.startCalls).toBe(1);
    expect(transport.subscribeCalls).toBe(1);
    expect(transport.stopCalls).toBe(1);
    expect(storage.initializeCalls).toBe(1);
    expect(storage.closeCalls).toBe(0);

    await expect(conductor.start()).resolves.toBeUndefined();
    expect(transport.startCalls).toBe(2);
    expect(transport.subscribeCalls).toBe(2);
    expect(storage.initializeCalls).toBe(1);
    expect(storage.closeCalls).toBe(0);

    await conductor.stop();
    expect(storage.closeCalls).toBe(1);
    await expect(conductor.start()).rejects.toMatchObject({ code: 'CONDUCTOR_STOPPED' });
  });

  it('ignores a completion with valid correlation ids from the wrong source', async () => {
    const parts = runtimeParts();
    const conductor = conductorFor(parts);
    await conductor.start();
    await conductor.startProcess({
      namespace: 'test', idempotencyKey: 'foreign-source', flow: { id: 'test.one-call', version: '1' },
      instanceId: 'foreign-source-1', input: {},
    });

    const foreign = responseEnvelope({
      source: 'other-service', destination: 'host.completions', instanceId: 'foreign-source-1',
      occurredAt: parts.clock.now().toISOString(),
      completion: { requestId: 'foreign-source-1:call', response: { forged: true } },
    });
    expect(await conductor.handleCompletion(foreign)).toBe('IGNORED');
    expect(await conductor.getProcess('foreign-source-1')).toMatchObject({
      lifecycle: 'WAITING', results: {}, pending: { requestId: 'foreign-source-1:call' },
    });
    expect((await parts.storage.getOperation('foreign-source-1:call'))?.completionSource).toBe('service');
  });

  it('resumes a durable outbox after one runtime stops and ignores duplicate completions', async () => {
    const parts = runtimeParts();
    const first = conductorFor(parts);
    await first.start();
    await first.startProcess({
      namespace: 'test', idempotencyKey: 'resume', flow: { id: 'test.one-call', version: '1' },
      instanceId: 'resume-1', input: { value: 1 },
    });
    await first.stop();
    running.splice(running.indexOf(first), 1);

    const transport = new MemoryMessageTransport();
    const second = conductorFor({ ...parts, transport });
    await second.start();
    let reply: MessageEnvelope | undefined;
    await transport.subscribe({
      destination: 'test.commands', consumerGroup: 'service', handler: async (message) => {
        const command = assertOperationCommand(message);
        reply = responseEnvelope({
          source: 'service', destination: command.replyTo, instanceId: command.instanceId,
          occurredAt: parts.clock.now().toISOString(),
          completion: { requestId: command.requestId, response: { accepted: true } },
        });
        await transport.publish(reply);
      },
    });
    await second.tick();
    expect(await second.getProcess('resume-1')).toMatchObject({ lifecycle: 'COMPLETED', outcome: 'DONE' });
    expect(reply).toBeDefined();
    const after = await second.getProcess('resume-1');
    expect(await second.handleCompletion(reply!)).toBe('IGNORED');
    expect(await second.getProcess('resume-1')).toEqual(after);
  });

  it('atomically accepts only one of two conflicting completions for the same operation', async () => {
    const parts = runtimeParts();
    const conductor = conductorFor(parts);
    await conductor.start();
    await conductor.startProcess({
      namespace: 'test', idempotencyKey: 'competing-completions', flow: { id: 'test.one-call', version: '1' },
      instanceId: 'competing-completions-1', input: {},
    });
    await conductor.tick();

    const succeeded = responseEnvelope({
      messageId: 'completion-success', source: 'service', destination: 'host.completions',
      instanceId: 'competing-completions-1', occurredAt: parts.clock.now().toISOString(),
      completion: { requestId: 'competing-completions-1:call', response: { accepted: true } },
    });
    const failed = responseEnvelope({
      messageId: 'completion-error', source: 'service', destination: 'host.completions',
      instanceId: 'competing-completions-1', occurredAt: parts.clock.now().toISOString(),
      completion: {
        requestId: 'competing-completions-1:call',
        error: { code: 'SECOND_REPLY_CONFLICT', message: 'Conflicting reply', details: null },
      },
    });

    const decisions = await Promise.all([
      conductor.handleCompletion(succeeded),
      conductor.handleCompletion(failed),
    ]);
    expect(decisions.sort()).toEqual(['COMMITTED', 'IGNORED']);

    const settled = await conductor.getProcess('competing-completions-1');
    expect(settled?.revision).toBe(2);
    expect(['DONE', 'FAILED']).toContain(settled?.outcome);
    expect(Object.keys(settled?.results ?? {})).toEqual(['call']);
    expect(await conductor.handleCompletion(succeeded)).toBe('IGNORED');
    expect(await conductor.handleCompletion(failed)).toBe('IGNORED');
    expect(await conductor.getProcess('competing-completions-1')).toEqual(settled);
  });

  it('atomically admits one winner when completion and timeout commit concurrently', async () => {
    class RacingStorage extends MemoryProcessStorage {
      private arrivals = 0;
      private release!: () => void;
      private readonly bothArrived = new Promise<void>((resolve) => { this.release = resolve; });
      readonly decisions: string[] = [];

      override async commitOperation(
        request: Parameters<MemoryProcessStorage['commitOperation']>[0],
      ): ReturnType<MemoryProcessStorage['commitOperation']> {
        if (request.requestId === 'timeout-race-1:call') {
          this.arrivals += 1;
          if (this.arrivals === 2) this.release();
          await this.bothArrived;
        }
        const decision = await super.commitOperation(request);
        if (request.requestId === 'timeout-race-1:call') this.decisions.push(decision.kind);
        return decision;
      }
    }

    const storage = new RacingStorage();
    const parts = { ...runtimeParts(), storage };
    const conductor = conductorFor(parts);
    await conductor.start();
    await conductor.startProcess({
      namespace: 'test', idempotencyKey: 'timeout-race', flow: { id: 'test.one-call', version: '1' },
      instanceId: 'timeout-race-1', input: {},
    });
    await conductor.tick();
    parts.clock.advance(1_001);

    const response = responseEnvelope({
      messageId: 'timeout-race-success', source: 'service', destination: 'host.completions',
      instanceId: 'timeout-race-1', occurredAt: parts.clock.now().toISOString(),
      completion: { requestId: 'timeout-race-1:call', response: { accepted: true } },
    });
    await Promise.all([conductor.tick(), conductor.handleCompletion(response)]);

    expect(storage.decisions).toHaveLength(2);
    expect(storage.decisions.filter((decision) => decision === 'COMMITTED')).toHaveLength(1);
    const settled = await conductor.getProcess('timeout-race-1');
    expect(settled?.revision).toBe(2);
    expect(['DONE', 'FAILED']).toContain(settled?.outcome);
    expect(Object.keys(settled?.results ?? {})).toEqual(['call']);
  });

  it('ignores a completion that arrives after timeout and keeps retry metadata outside process state', async () => {
    const parts = runtimeParts();
    const conductor = conductorFor(parts);
    await conductor.start();
    await conductor.startProcess({
      namespace: 'test', idempotencyKey: 'timeout', flow: { id: 'test.one-call', version: '1' },
      instanceId: 'timeout-1', input: {},
    });
    await conductor.tick();
    parts.clock.advance(1_001);
    await conductor.tick();
    const timedOut = await conductor.getProcess('timeout-1');
    expect(timedOut).toMatchObject({
      lifecycle: 'COMPLETED', outcome: 'FAILED',
      error: { code: 'PROCESSENGINE_COMPLETION_TIMEOUT', details: null },
    });
    expect(JSON.stringify(timedOut)).not.toMatch(/attempt|policyId|retry/u);

    const late = responseEnvelope({
      source: 'service', destination: 'host.completions', instanceId: 'timeout-1',
      occurredAt: parts.clock.now().toISOString(),
      completion: { requestId: 'timeout-1:call', response: { tooLate: true } },
    });
    expect(await conductor.handleCompletion(late)).toBe('IGNORED');
    expect(await conductor.getProcess('timeout-1')).toEqual(timedOut);
  });

  it('recovers after a transport outage by reclaiming the durable outbox', async () => {
    class FlakyTransport extends MemoryMessageTransport {
      failures = 1;
      override async publish(message: MessageEnvelope): Promise<void> {
        if (message.type === 'processengine.operation.command' && this.failures-- > 0) throw new Error('offline');
        await super.publish(message);
      }
    }
    const transport = new FlakyTransport();
    const parts = runtimeParts(new ManualClock(), transport);
    const conductor = conductorFor(parts);
    await conductor.start();
    await transport.subscribe({ destination: 'test.commands', consumerGroup: 'service', handler: async (message) => {
      const command = assertOperationCommand(message);
      await transport.publish(responseEnvelope({
        source: 'service', destination: command.replyTo, instanceId: command.instanceId,
        occurredAt: parts.clock.now().toISOString(),
        completion: { requestId: command.requestId, response: { recovered: true } },
      }));
    } });
    await conductor.startProcess({
      namespace: 'test', idempotencyKey: 'outage', flow: { id: 'test.one-call', version: '1' },
      instanceId: 'outage-1', input: {},
    });
    await conductor.tick();
    expect((await conductor.getProcess('outage-1'))?.lifecycle).toBe('WAITING');
    parts.clock.advance(10);
    await conductor.tick();
    expect(await conductor.getProcess('outage-1')).toMatchObject({ lifecycle: 'COMPLETED', outcome: 'DONE' });
    const snapshot = parts.storage.snapshot();
    expect(snapshot.outbox[0]?.attempt).toBe(2);
    expect(JSON.stringify(snapshot.processes[0]?.state)).not.toContain('attempt');
  });

  it('runs only one local worker tick while transport publication is in flight', async () => {
    class BlockingTransport extends MemoryMessageTransport {
      publications = 0;
      release: (() => void) | undefined;
      override async publish(message: MessageEnvelope): Promise<void> {
        if (message.type === 'processengine.operation.command') {
          this.publications += 1;
          await new Promise<void>((resolve) => { this.release = resolve; });
        }
        await super.publish(message);
      }
    }
    const transport = new BlockingTransport();
    const parts = runtimeParts(new ManualClock(), transport);
    const conductor = conductorFor(parts);
    await conductor.start();
    await conductor.startProcess({
      namespace: 'test', idempotencyKey: 'single-flight', flow: { id: 'test.one-call', version: '1' },
      instanceId: 'single-flight-1', input: {},
    });

    const first = conductor.tick();
    while (transport.publications === 0) await Promise.resolve();
    const second = conductor.tick();
    await Promise.resolve();
    expect(transport.publications).toBe(1);
    transport.release?.();
    await Promise.all([first, second]);
    expect(transport.publications).toBe(1);
  });

  it('waits for an in-flight worker claim before closing transport on graceful stop', async () => {
    class BlockingTransport extends MemoryMessageTransport {
      release: (() => void) | undefined;
      publicationStarted = false;
      stopCalls = 0;
      override async publish(message: MessageEnvelope): Promise<void> {
        if (message.type === 'processengine.operation.command') {
          this.publicationStarted = true;
          await new Promise<void>((resolve) => { this.release = resolve; });
        }
        await super.publish(message);
      }
      override async stop(): Promise<void> {
        this.stopCalls += 1;
        await super.stop();
      }
    }
    const transport = new BlockingTransport();
    const parts = runtimeParts(new ManualClock(), transport);
    const conductor = conductorFor(parts);
    await conductor.start();
    await conductor.startProcess({
      namespace: 'test', idempotencyKey: 'graceful-stop', flow: { id: 'test.one-call', version: '1' },
      instanceId: 'graceful-stop-1', input: {},
    });

    const ticking = conductor.tick();
    while (!transport.publicationStarted) await Promise.resolve();
    const stopping = conductor.stop();
    await Promise.resolve();
    expect(transport.stopCalls).toBe(0);
    transport.release?.();
    await Promise.all([ticking, stopping]);
    expect(transport.stopCalls).toBe(1);
  });

  it('does not start the completion timeout while Kafka publication is failing', async () => {
    class OfflineTransport extends MemoryMessageTransport {
      override async publish(message: MessageEnvelope): Promise<void> {
        if (message.type === 'processengine.operation.command') throw new Error('broker offline');
        await super.publish(message);
      }
    }
    const parts = runtimeParts(new ManualClock(), new OfflineTransport());
    const conductor = conductorFor(parts);
    await conductor.start();
    await conductor.startProcess({
      namespace: 'test', idempotencyKey: 'offline-no-timeout', flow: { id: 'test.one-call', version: '1' },
      instanceId: 'offline-no-timeout-1', input: {},
    });

    await conductor.tick();
    parts.clock.advance(5_000);
    await conductor.tick();

    expect(await conductor.getProcess('offline-no-timeout-1')).toMatchObject({
      lifecycle: 'WAITING', results: {},
    });
    expect(await parts.storage.getOperation('offline-no-timeout-1:call')).toMatchObject({
      status: 'PENDING', deadlineAt: null,
    });
  });

  it('resolves dispatch exhaustion independently of the completion timeout', async () => {
    class OfflineTransport extends MemoryMessageTransport {
      override async publish(message: MessageEnvelope): Promise<void> {
        if (message.type === 'processengine.operation.command') throw new Error('broker offline');
        await super.publish(message);
      }
    }
    const parts = runtimeParts(new ManualClock(), new OfflineTransport());
    const conductor = conductorFor(parts);
    await conductor.start();
    await conductor.startProcess({
      namespace: 'test', idempotencyKey: 'dispatch-exhaustion', flow: { id: 'test.one-call', version: '1' },
      instanceId: 'dispatch-exhaustion-1', input: {},
    });

    await conductor.tick();
    parts.clock.advance(10);
    await conductor.tick();
    parts.clock.advance(10);
    await conductor.tick();

    expect(await conductor.getProcess('dispatch-exhaustion-1')).toMatchObject({
      lifecycle: 'COMPLETED',
      outcome: 'FAILED',
      error: { code: 'PROCESSENGINE_DISPATCH_FAILED', details: null },
    });
    expect(await parts.storage.getOperation('dispatch-exhaustion-1:call')).toMatchObject({
      status: 'DISPATCH_FAILED', deadlineAt: null,
    });
  });

  it('never classifies a post-publish storage failure as DISPATCH_FAILED', async () => {
    class MarkFailureStorage extends MemoryProcessStorage {
      failures = 1;
      override async markOutboxPublished(request: Parameters<MemoryProcessStorage['markOutboxPublished']>[0]): Promise<void> {
        if (this.failures-- > 0) throw new Error('database unavailable after broker ack');
        await super.markOutboxPublished(request);
      }
    }
    const clock = new ManualClock();
    const transport = new MemoryMessageTransport();
    const storage = new MarkFailureStorage();
    const parts = { ...runtimeParts(clock, transport), storage };
    const conductor = conductorFor(parts);
    await conductor.start();
    await conductor.startProcess({
      namespace: 'test', idempotencyKey: 'mark-failure', flow: { id: 'test.one-call', version: '1' },
      instanceId: 'mark-failure-1', input: {},
    });

    await expect(conductor.tick()).rejects.toThrow(/database unavailable/u);
    expect(transport.published).toHaveLength(1);
    expect((await conductor.getProcess('mark-failure-1'))?.lifecycle).toBe('WAITING');

    clock.advance(101);
    await conductor.tick();
    expect(transport.published).toHaveLength(2);
    expect(transport.published[1]?.messageId).toBe(transport.published[0]?.messageId);
    expect(assertOperationCommand(transport.published[1]!).requestId).toBe('mark-failure-1:call');
    expect((await conductor.getProcess('mark-failure-1'))?.results).toEqual({});
  });
});

describe('connector conformance helpers', () => {
  it('exercise atomic storage transitions, fencing, transport groups and negative acknowledgements', async () => {
    await runProcessStorageConformance(createMemoryStorage);
    await runMessageTransportConformance(() => new MemoryMessageTransport());
  });
});
