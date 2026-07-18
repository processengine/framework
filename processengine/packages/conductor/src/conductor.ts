import { randomUUID } from 'node:crypto';
import { CORE_OPERATION_ERRORS } from './core-errors.js';
import { ConductorError } from './errors.js';
import { digestJson } from './json.js';
import { evolve, failure } from './kernel.js';
import { operationCommandEnvelope, parseOperationCompletion } from './protocol.js';
import type { MessageEnvelope } from './protocol.js';
import type {
  CompiledProcessDefinition,
  ConductorAction,
  JsonValue,
  OperationCompletion,
  OperationError,
  ProcessState,
} from './types.js';
import type {
  Clock,
  CommitOperationResult,
  ConductorOptions,
  DurableDispatch,
  OperationBinding,
  ProcessRecord,
  StartProcessRequest,
  StartProcessResult,
} from './spi.js';

const systemClock: Clock = { now: () => new Date() };

export class Conductor {
  private readonly clock: Clock;
  private readonly workerId = `conductor-${randomUUID()}`;
  private unsubscribe: (() => Promise<void>) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private tickInFlight: Promise<void> | undefined;
  private startInFlight: Promise<void> | undefined;
  private stopInFlight: Promise<void> | undefined;
  private storageInitialized = false;
  private transportStarted = false;
  private started = false;
  private terminated = false;

  constructor(private readonly options: ConductorOptions) {
    this.clock = options.clock ?? systemClock;
    if (!options.source || !options.completionDestination) {
      throw new ConductorError('CONDUCTOR_CONFIG_INVALID', 'source and completionDestination are required');
    }
  }

  async start(): Promise<void> {
    if (this.terminated) throw new ConductorError('CONDUCTOR_STOPPED', 'Conductor has been stopped');
    if (this.stopInFlight) throw new ConductorError('CONDUCTOR_STOPPING', 'Conductor is stopping');
    if (this.started) return;
    if (this.startInFlight) return this.startInFlight;
    const execution = this.startInternal();
    this.startInFlight = execution;
    try { await execution; }
    finally { if (this.startInFlight === execution) this.startInFlight = undefined; }
  }

  async stop(): Promise<void> {
    if (this.stopInFlight) return this.stopInFlight;
    const execution = this.stopInternal();
    this.stopInFlight = execution;
    try { await execution; }
    finally { if (this.stopInFlight === execution) this.stopInFlight = undefined; }
  }

  private async startInternal(): Promise<void> {
    let unsubscribe: (() => Promise<void>) | undefined;
    try {
      if (!this.storageInitialized) {
        await this.options.storage.initialize();
        this.storageInitialized = true;
      }
      if (!this.transportStarted) {
        await this.options.transport.start();
        this.transportStarted = true;
      }
      unsubscribe = await this.options.transport.subscribe({
        destination: this.options.completionDestination,
        consumerGroup: this.options.consumerGroup ?? `${this.options.source}.completions`,
        handler: async (message) => { await this.handleCompletion(message); },
      });
      this.unsubscribe = unsubscribe;
      const interval = this.options.worker?.pollIntervalMs ?? 100;
      this.timer = setInterval(() => {
        void this.tick().catch((error: unknown) => {
          if (this.options.worker?.onError) this.options.worker.onError(error);
          else console.error('[processengine] conductor worker failed', error);
        });
      }, interval);
      this.timer.unref();
      this.started = true;
    } catch (error) {
      const cleanup = await Promise.allSettled([
        ...(unsubscribe ? [unsubscribe()] : []),
        ...(this.transportStarted ? [this.options.transport.stop()] : []),
      ]);
      const transportCleanupIndex = unsubscribe ? 1 : 0;
      if (this.transportStarted && cleanup[transportCleanupIndex]?.status === 'fulfilled') {
        this.transportStarted = false;
      }
      this.unsubscribe = undefined;
      this.started = false;
      const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length > 0) {
        throw new AggregateError(
          [error, ...failures.map((result) => result.reason)],
          'Conductor startup and rollback failed',
        );
      }
      throw error;
    }
  }

  private async stopInternal(): Promise<void> {
    // Explicit stop is the terminal ownership boundary for this runtime. A
    // failed start may be retried; a stopped runtime must be reconstructed with
    // fresh adapters because some adapters (notably owned pg.Pool instances)
    // cannot reopen after close().
    this.terminated = true;
    await this.startInFlight?.catch(() => undefined);
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // A graceful shutdown must not close storage or transport underneath an
    // already claimed record. The active caller still observes its own tick
    // error; shutdown only waits for ownership to settle before disconnecting.
    await this.tickInFlight?.catch(() => undefined);
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    const cleanup = await Promise.allSettled([
      ...(unsubscribe ? [unsubscribe()] : []),
      ...(this.transportStarted ? [this.options.transport.stop()] : []),
      ...(this.storageInitialized ? [this.options.storage.close()] : []),
    ]);
    this.started = false;
    this.transportStarted = false;
    this.storageInitialized = false;
    const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length > 0) throw new AggregateError(failures.map((result) => result.reason), 'Conductor shutdown failed');
  }

  async startProcess(request: StartProcessRequest): Promise<StartProcessResult> {
    const flow = await this.requireFlow(request.flow.id, request.flow.version);
    this.validateBindings(flow);
    const at = this.clock.now().toISOString();
    const instanceId = request.instanceId ?? randomUUID();
    const transition = evolve(flow, undefined, {
      type: 'START',
      instanceId,
      input: request.input,
      at,
    });
    const process: ProcessRecord = {
      namespace: request.namespace,
      idempotencyKey: request.idempotencyKey,
      fingerprint: digestJson({
        flow: { id: flow.definition.id, version: flow.definition.version, digest: flow.digest },
        input: request.input,
      }),
      state: transition.state,
    };
    const dispatch = transition.action.type === 'DISPATCH_OPERATION'
      ? this.prepareDispatch(transition.action, at)
      : undefined;
    const result = await this.options.storage.createProcess({ process, ...(dispatch ? { dispatch } : {}) });
    if (result.kind === 'IDEMPOTENCY_CONFLICT') return result;
    return { kind: result.kind === 'CREATED' ? 'STARTED' : 'EXISTING', process: result.process.state };
  }

  async getProcess(instanceId: string): Promise<ProcessState | undefined> {
    return (await this.options.storage.getProcess(instanceId))?.state;
  }

  async tick(): Promise<void> {
    if (this.tickInFlight) return this.tickInFlight;
    const execution = this.runTick();
    this.tickInFlight = execution;
    try {
      await execution;
    } finally {
      if (this.tickInFlight === execution) this.tickInFlight = undefined;
    }
  }

  private async runTick(): Promise<void> {
    await this.runOutbox();
    await this.runTimeouts();
  }

  async handleCompletion(message: MessageEnvelope): Promise<'COMMITTED' | 'IGNORED'> {
    let parsed;
    try {
      parsed = parseOperationCompletion(message);
    } catch {
      return 'IGNORED';
    }
    const operation = await this.options.storage.getOperation(parsed.requestId);
    if (!operation
      || message.destination !== this.options.completionDestination
      || message.partitionKey !== operation.instanceId
      || message.source !== operation.completionSource) return 'IGNORED';
    return this.resolveCompletion(parsed.requestId, parsed.completion, parsed.completion.status, message.messageId);
  }

  private async resolveCompletion(
    requestId: string,
    completion: OperationCompletion,
    resolution: 'SUCCESS' | 'ERROR' | 'TIMED_OUT' | 'DISPATCH_FAILED',
    inboxMessageId?: string,
    claim?:
      | { readonly kind: 'TIMEOUT'; readonly workerId: string; readonly claimVersion: number }
      | { readonly kind: 'DISPATCH'; readonly workerId: string; readonly messageId: string; readonly claimVersion: number },
  ): Promise<'COMMITTED' | 'IGNORED'> {
    const operation = await this.options.storage.getOperation(requestId);
    if (!operation || (operation.status !== 'PENDING' && operation.status !== 'PUBLISHED')) return 'IGNORED';
    const process = await this.options.storage.getProcess(operation.instanceId);
    if (!process) return 'IGNORED';
    const flow = await this.requirePinnedFlow(process.state);
    const at = this.clock.now().toISOString();
    const transition = evolve(flow, process.state, {
      type: 'OPERATION_COMPLETED',
      requestId,
      completion,
      at,
    });
    const dispatch = transition.action.type === 'DISPATCH_OPERATION'
      ? this.prepareDispatch(transition.action, at)
      : undefined;
    const committed: CommitOperationResult = await this.options.storage.commitOperation({
      instanceId: operation.instanceId,
      expectedRevision: process.state.revision,
      requestId,
      ...(inboxMessageId ? { inboxMessageId } : {}),
      resolution,
      resolvedAt: at,
      nextState: transition.state,
      ...(dispatch ? { nextDispatch: dispatch } : {}),
      ...(claim?.kind === 'TIMEOUT'
        ? { timeoutClaim: { workerId: claim.workerId, claimVersion: claim.claimVersion } }
        : {}),
      ...(claim?.kind === 'DISPATCH'
        ? { dispatchClaim: { workerId: claim.workerId, messageId: claim.messageId, claimVersion: claim.claimVersion } }
        : {}),
    });
    return committed.kind === 'COMMITTED' ? 'COMMITTED' : 'IGNORED';
  }

  private prepareDispatch(action: Extract<ConductorAction, { type: 'DISPATCH_OPERATION' }>, at: string): DurableDispatch {
    const binding = this.requireBinding(action.operation);
    const envelope = operationCommandEnvelope({
      source: this.options.source,
      destination: binding.destination,
      responseDestination: this.options.completionDestination,
      occurredAt: at,
      payload: {
        requestId: action.requestId,
        instanceId: action.instanceId,
        stepId: action.stepId,
        operation: action.operation,
        input: action.input,
      },
    });
    return {
      operation: {
        requestId: action.requestId,
        instanceId: action.instanceId,
        stepId: action.stepId,
        operation: action.operation,
        destination: binding.destination,
        completionSource: binding.completionSource,
        status: 'PENDING',
        policy: binding.policy,
        deadlineAt: null,
        createdAt: at,
        timeoutClaimVersion: 0,
      },
      outbox: {
        messageId: envelope.messageId,
        requestId: action.requestId,
        instanceId: action.instanceId,
        envelope,
        status: 'PENDING',
        attempt: 0,
        maxAttempts: binding.policy.dispatch.maxAttempts,
        retryDelayMs: binding.policy.dispatch.retryDelayMs,
        availableAt: at,
        claimVersion: 0,
      },
    };
  }

  private async runOutbox(): Promise<void> {
    // Claim immediately before processing each record. Claiming a large batch
    // up front would spend later records' leases while earlier publishes are
    // still in flight, allowing another runtime to reclaim valid work.
    const limit = this.options.worker?.outboxBatchSize ?? 20;
    for (let index = 0; index < limit; index += 1) {
      const [record] = await this.options.storage.claimOutbox({
        workerId: this.workerId,
        now: this.clock.now().toISOString(),
        leaseMs: this.options.worker?.outboxLeaseMs ?? 60_000,
        limit: 1,
      });
      if (!record) break;
      try {
        await this.options.transport.publish(record.envelope);
      } catch {
        if (record.attempt >= record.maxAttempts) {
          await this.resolveCoreFailure(record.requestId, 'DISPATCH_FAILED', {
            code: CORE_OPERATION_ERRORS.DISPATCH_FAILED,
            message: 'Operation command could not be published',
            details: null,
          }, {
            kind: 'DISPATCH',
            workerId: this.workerId,
            messageId: record.messageId,
            claimVersion: record.claimVersion,
          });
        } else {
          const availableAt = new Date(this.clock.now().getTime() + record.retryDelayMs).toISOString();
          await this.options.storage.rescheduleOutbox({
            messageId: record.messageId,
            workerId: this.workerId,
            claimVersion: record.claimVersion,
            availableAt,
          });
        }
        continue;
      }
      // A storage failure after a successful publish must not be classified as
      // a dispatch failure. The claim is left for lease-based recovery and the
      // stable message/request identifiers make a repeated publish deduplicable.
      await this.options.storage.markOutboxPublished({
        messageId: record.messageId,
        workerId: this.workerId,
        claimVersion: record.claimVersion,
        publishedAt: this.clock.now().toISOString(),
      });
    }
  }

  private async runTimeouts(): Promise<void> {
    const limit = this.options.worker?.timeoutBatchSize ?? 20;
    for (let index = 0; index < limit; index += 1) {
      const [operation] = await this.options.storage.claimExpiredOperations({
        workerId: this.workerId,
        now: this.clock.now().toISOString(),
        leaseMs: this.options.worker?.outboxLeaseMs ?? 60_000,
        limit: 1,
      });
      if (!operation) break;
      await this.resolveCoreFailure(operation.requestId, 'TIMED_OUT', {
        code: CORE_OPERATION_ERRORS.COMPLETION_TIMEOUT,
        message: 'Operation did not complete before its deadline',
        details: null,
      }, {
        kind: 'TIMEOUT',
        workerId: this.workerId,
        claimVersion: operation.timeoutClaimVersion,
      });
    }
  }

  private async resolveCoreFailure(
    requestId: string,
    resolution: 'TIMED_OUT' | 'DISPATCH_FAILED',
    error: OperationError,
    claim:
      | { readonly kind: 'TIMEOUT'; readonly workerId: string; readonly claimVersion: number }
      | { readonly kind: 'DISPATCH'; readonly workerId: string; readonly messageId: string; readonly claimVersion: number },
  ): Promise<void> {
    await this.resolveCompletion(requestId, failure(error), resolution, undefined, claim);
  }

  private async requireFlow(id: string, version: string): Promise<CompiledProcessDefinition> {
    const flow = await this.options.artifacts.get(id, version);
    if (!flow) throw new ConductorError('FLOW_NOT_FOUND', `Flow ${id}@${version} was not found`);
    return flow;
  }

  private async requirePinnedFlow(state: ProcessState): Promise<CompiledProcessDefinition> {
    const flow = await this.requireFlow(state.flow.id, state.flow.version);
    if (flow.digest !== state.flow.digest) {
      throw new ConductorError('FLOW_DEFINITION_CHANGED', 'Stored process digest no longer matches artifact registry');
    }
    return flow;
  }

  private validateBindings(flow: CompiledProcessDefinition): void {
    for (const step of Object.values(flow.definition.steps)) {
      if (step.type === 'operation') this.requireBinding(step.operation);
    }
  }

  private requireBinding(operation: string): OperationBinding {
    const binding = this.options.operations.get(operation);
    if (!binding) throw new ConductorError('OPERATION_NOT_CONFIGURED', `Operation ${operation} is not configured`);
    return binding;
  }
}

export function createConductor(options: ConductorOptions): Conductor {
  return new Conductor(options);
}
