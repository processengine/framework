import { Conductor } from './conductor.js';
import { createMemoryStorage, createMemoryTransport } from './memory.js';
import type { MessageEnvelope } from './protocol.js';
import type { ConductorOptions, DurableDispatch, MessageTransport, ProcessRecord, ProcessStorage } from './spi.js';
import type { ProcessState } from './types.js';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Conformance failure: ${message}`);
}

export class ManualClock {
  constructor(private milliseconds = Date.parse('2026-01-01T00:00:00.000Z')) {}
  now(): Date { return new Date(this.milliseconds); }
  advance(milliseconds: number): void { this.milliseconds += milliseconds; }
}

function waitingState(
  instanceId = 'conformance-instance',
  stepId = 'call',
  operation = 'conformance.call',
): ProcessState {
  const requestId = `${instanceId}:${stepId}`;
  return {
    instanceId,
    flow: { id: 'conformance.flow', version: '1.0.0', digest: 'sha256:conformance' },
    lifecycle: 'WAITING',
    revision: 1,
    currentStep: stepId,
    input: {},
    results: {},
    pending: {
      executionId: requestId,
      requestId,
      stepId,
      operation,
    },
    outcome: null,
    response: null,
    error: null,
    fault: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function conformanceDispatch(
  instanceId = 'conformance-instance',
  stepId = 'call',
  operation = 'conformance.call',
): DurableDispatch {
  const requestId = `${instanceId}:${stepId}`;
  const envelope: MessageEnvelope = {
    messageId: `${requestId}:command`,
    type: 'processengine.operation.command',
    protocolVersion: '1',
    source: 'conformance',
    destination: 'conformance.commands',
    partitionKey: instanceId,
    occurredAt: '2026-01-01T00:00:00.000Z',
    payload: {},
  };
  return {
    operation: {
      requestId,
      instanceId,
      stepId,
      operation,
      destination: 'conformance.commands',
      completionSource: 'conformance.service',
      status: 'PENDING',
      policy: {
        id: 'conformance',
        version: '1',
        completionTimeoutMs: 1_000,
        dispatch: { maxAttempts: 3, retryDelayMs: 10 },
      },
      deadlineAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      timeoutClaimVersion: 0,
    },
    outbox: {
      messageId: envelope.messageId,
      requestId,
      instanceId,
      envelope,
      status: 'PENDING',
      attempt: 0,
      maxAttempts: 3,
      retryDelayMs: 10,
      availableAt: '2026-01-01T00:00:00.000Z',
      claimVersion: 0,
    },
  };
}

function processRecord(instanceId: string): ProcessRecord {
  return {
    namespace: 'conformance',
    idempotencyKey: instanceId,
    fingerprint: `fingerprint:${instanceId}`,
    state: waitingState(instanceId),
  };
}

function completedState(
  process: ProcessRecord,
  outcome: string,
  resolvedAt: string,
  completion: ProcessState['results'][string],
): ProcessState {
  return {
    ...process.state,
    lifecycle: 'COMPLETED',
    revision: process.state.revision + 1,
    pending: null,
    results: { call: completion },
    outcome,
    response: completion.response,
    error: completion.error,
    updatedAt: resolvedAt,
  };
}

function continuedState(
  process: ProcessRecord,
  marker: string,
  resolvedAt: string,
): ProcessState {
  const requestId = `${process.state.instanceId}:follow-up`;
  return {
    ...process.state,
    lifecycle: 'WAITING',
    revision: process.state.revision + 1,
    currentStep: 'follow-up',
    results: {
      call: { status: 'SUCCESS', response: { marker }, error: null },
    },
    pending: {
      executionId: requestId,
      requestId,
      stepId: 'follow-up',
      operation: 'conformance.follow-up',
    },
    updatedAt: resolvedAt,
  };
}

export async function runProcessStorageConformance(factory: () => ProcessStorage): Promise<void> {
  const storage = factory();
  await storage.initialize();
  try {
    const process: ProcessRecord = {
      namespace: 'conformance',
      idempotencyKey: 'same',
      fingerprint: 'fingerprint-a',
      state: waitingState(),
    };
    const created = await storage.createProcess({ process, dispatch: conformanceDispatch() });
    check(created.kind === 'CREATED', 'first process creation must succeed');
    check((await storage.createProcess({ process })).kind === 'EXISTING', 'equal idempotent start must return existing');
    check((await storage.createProcess({ process: { ...process, fingerprint: 'fingerprint-b' } })).kind === 'IDEMPOTENCY_CONFLICT',
      'changed idempotent start must conflict');

    const firstOutboxClaim = await storage.claimOutbox({
      workerId: 'publisher-a', now: '2026-01-01T00:00:00.000Z', leaseMs: 100, limit: 10,
    });
    check(firstOutboxClaim.length === 1 && firstOutboxClaim[0]!.claimVersion === 1
      && firstOutboxClaim[0]!.attempt === 1,
    'first outbox claim must increment attempt and fencing token');
    const secondOutboxClaim = await storage.claimOutbox({
      workerId: 'publisher-b', now: '2026-01-01T00:00:00.101Z', leaseMs: 100, limit: 10,
    });
    check(secondOutboxClaim.length === 1 && secondOutboxClaim[0]!.claimVersion === 2
      && secondOutboxClaim[0]!.attempt === 2,
    'expired outbox lease must be reclaimable as a new attempt with a higher fencing token');
    const thirdOutboxClaim = await storage.claimOutbox({
      workerId: 'publisher-c', now: '2026-01-01T00:00:00.202Z', leaseMs: 100, limit: 10,
    });
    check(thirdOutboxClaim.length === 1 && thirdOutboxClaim[0]!.claimVersion === 3
      && thirdOutboxClaim[0]!.attempt === 3,
    'a reclaimed claim must advance to the dispatch-attempt ceiling');
    const finalOutboxReclaim = await storage.claimOutbox({
      workerId: 'publisher-d', now: '2026-01-01T00:00:00.303Z', leaseMs: 100, limit: 10,
    });
    check(finalOutboxReclaim.length === 1 && finalOutboxReclaim[0]!.claimVersion === 4
      && finalOutboxReclaim[0]!.attempt === 3,
    'an ambiguous final claim must remain recoverable without exceeding maxAttempts');
    await storage.markOutboxPublished({
      messageId: firstOutboxClaim[0]!.messageId,
      workerId: 'publisher-a', claimVersion: 1, publishedAt: '2026-01-01T00:00:00.050Z',
    });
    await storage.markOutboxPublished({
      messageId: secondOutboxClaim[0]!.messageId,
      workerId: 'publisher-b', claimVersion: 2, publishedAt: '2026-01-01T00:00:00.150Z',
    });
    await storage.markOutboxPublished({
      messageId: finalOutboxReclaim[0]!.messageId,
      workerId: 'publisher-d', claimVersion: 4, publishedAt: '2026-01-01T00:00:00.350Z',
    });
    const publishedOperation = await storage.getOperation('conformance-instance:call');
    check(publishedOperation?.status === 'PUBLISHED'
      && publishedOperation.deadlineAt === '2026-01-01T00:00:01.350Z',
    'publishing must atomically start the completion deadline from publishedAt');
    check((await storage.claimOutbox({
      workerId: 'publisher-e', now: '2026-01-01T00:00:00.500Z', leaseMs: 100, limit: 10,
    })).length === 0, 'stale publisher must not overwrite the current published claim');

    const firstTimeoutClaim = await storage.claimExpiredOperations({
      workerId: 'worker-a', now: '2026-01-01T00:00:02.000Z', leaseMs: 100, limit: 10,
    });
    check(firstTimeoutClaim.length === 1 && firstTimeoutClaim[0]!.timeoutClaimVersion === 1,
      'first timeout claim must increment fencing token');
    const secondTimeoutClaim = await storage.claimExpiredOperations({
      workerId: 'worker-b', now: '2026-01-01T00:00:02.101Z', leaseMs: 100, limit: 10,
    });
    check(secondTimeoutClaim.length === 1 && secondTimeoutClaim[0]!.timeoutClaimVersion === 2,
      'expired timeout lease must be reclaimable with a higher fencing token');

    const timeoutState: ProcessState = {
      ...waitingState(),
      lifecycle: 'COMPLETED',
      revision: 2,
      pending: null,
      outcome: 'TIMED_OUT',
      error: { code: 'PROCESSENGINE_COMPLETION_TIMEOUT', message: 'Timed out', details: null },
      updatedAt: '2026-01-01T00:00:02.150Z',
    };
    const stale = await storage.commitOperation({
      instanceId: process.state.instanceId,
      expectedRevision: 1,
      requestId: 'conformance-instance:call',
      resolution: 'TIMED_OUT',
      resolvedAt: '2026-01-01T00:00:02.150Z',
      nextState: timeoutState,
      timeoutClaim: { workerId: 'worker-a', claimVersion: 1 },
    });
    check(stale.kind === 'STALE_CLAIM', 'stale timeout worker must be fenced');
    const committed = await storage.commitOperation({
      instanceId: process.state.instanceId,
      expectedRevision: 1,
      requestId: 'conformance-instance:call',
      resolution: 'TIMED_OUT',
      resolvedAt: '2026-01-01T00:00:02.150Z',
      nextState: timeoutState,
      timeoutClaim: { workerId: 'worker-b', claimVersion: 2 },
    });
    check(committed.kind === 'COMMITTED', 'current timeout claim must commit');

    const successProcess = processRecord('conformance-success');
    const successDispatch = conformanceDispatch(successProcess.state.instanceId);
    check((await storage.createProcess({ process: successProcess, dispatch: successDispatch })).kind === 'CREATED',
      'success scenario process creation must succeed');
    const followUpDispatch = conformanceDispatch(
      successProcess.state.instanceId,
      'follow-up',
      'conformance.follow-up',
    );
    const completionA = {
      instanceId: successProcess.state.instanceId,
      expectedRevision: successProcess.state.revision,
      requestId: successDispatch.operation.requestId,
      inboxMessageId: 'conformance-success:completion-a',
      resolution: 'SUCCESS' as const,
      resolvedAt: '2026-01-01T00:00:03.000Z',
      nextState: continuedState(successProcess, 'A', '2026-01-01T00:00:03.000Z'),
      nextDispatch: followUpDispatch,
    };
    const completionB = {
      ...completionA,
      inboxMessageId: 'conformance-success:completion-b',
      nextState: continuedState(successProcess, 'B', '2026-01-01T00:00:03.000Z'),
    };
    const competing = await Promise.all([
      storage.commitOperation(completionA),
      storage.commitOperation(completionB),
    ]);
    check(competing.filter((result) => result.kind === 'COMMITTED').length === 1,
      'competing completions must atomically admit exactly one winner');
    check(competing.filter((result) => result.kind !== 'COMMITTED').length === 1,
      'the losing competing completion must not commit');
    const winnerIndex = competing[0]!.kind === 'COMMITTED' ? 0 : 1;
    const winnerRequest = winnerIndex === 0 ? completionA : completionB;
    const winnerMarker = winnerIndex === 0 ? 'A' : 'B';
    const storedSuccess = await storage.getProcess(successProcess.state.instanceId);
    check(storedSuccess?.state.revision === 2
      && storedSuccess.state.results.call?.status === 'SUCCESS'
      && (storedSuccess.state.results.call.response as { marker?: string }).marker === winnerMarker,
    'the winning SUCCESS completion and process revision must be stored together');
    check((await storage.getOperation(successDispatch.operation.requestId))?.status === 'SUCCESS',
      'the resolved operation must be SUCCESS in the same committed transition');
    check((await storage.getOperation(followUpDispatch.operation.requestId))?.status === 'PENDING',
      'nextDispatch operation must be inserted atomically with the successful transition');

    const duplicateInbox = await storage.commitOperation(winnerRequest);
    check(duplicateInbox.kind === 'DUPLICATE',
      'replaying the winning inbox message must be classified as DUPLICATE');
    check((await storage.getProcess(successProcess.state.instanceId))?.state.revision === 2,
      'duplicate and competing completions must not revise process state again');

    const followUpOutbox = (await storage.claimOutbox({
      workerId: 'follow-up-publisher', now: '2026-01-01T00:00:03.001Z', leaseMs: 100, limit: 10,
    })).filter((record) => record.requestId === followUpDispatch.operation.requestId);
    check(followUpOutbox.length === 1,
      'nextDispatch outbox must become claimable with its operation');
    await storage.markOutboxPublished({
      messageId: followUpOutbox[0]!.messageId,
      workerId: 'follow-up-publisher',
      claimVersion: followUpOutbox[0]!.claimVersion,
      publishedAt: '2026-01-01T00:00:03.010Z',
    });

    const failedProcess = processRecord('conformance-dispatch-failed');
    const failedDispatch = conformanceDispatch(failedProcess.state.instanceId);
    check((await storage.createProcess({ process: failedProcess, dispatch: failedDispatch })).kind === 'CREATED',
      'dispatch-failure scenario process creation must succeed');
    const obsoleteDispatchClaim = (await storage.claimOutbox({
      workerId: 'failed-publisher-a', now: '2026-01-01T00:00:04.000Z', leaseMs: 100, limit: 10,
    })).find((record) => record.requestId === failedDispatch.operation.requestId);
    check(obsoleteDispatchClaim !== undefined, 'first dispatch-failure claim must be acquired');
    const currentDispatchClaim = (await storage.claimOutbox({
      workerId: 'failed-publisher-b', now: '2026-01-01T00:00:04.101Z', leaseMs: 100, limit: 10,
    })).find((record) => record.requestId === failedDispatch.operation.requestId);
    check(currentDispatchClaim !== undefined
      && currentDispatchClaim.claimVersion > obsoleteDispatchClaim.claimVersion,
    'expired dispatch claim must be recovered with a higher fencing token');
    const dispatchFailedState = completedState(
      failedProcess,
      'DISPATCH_FAILED',
      '2026-01-01T00:00:04.150Z',
      {
        status: 'ERROR',
        response: null,
        error: { code: 'PROCESSENGINE_DISPATCH_FAILED', message: 'Dispatch failed', details: null },
      },
    );
    const staleDispatchFailure = await storage.commitOperation({
      instanceId: failedProcess.state.instanceId,
      expectedRevision: failedProcess.state.revision,
      requestId: failedDispatch.operation.requestId,
      resolution: 'DISPATCH_FAILED',
      resolvedAt: dispatchFailedState.updatedAt,
      nextState: dispatchFailedState,
      dispatchClaim: {
        workerId: 'failed-publisher-a',
        messageId: obsoleteDispatchClaim.messageId,
        claimVersion: obsoleteDispatchClaim.claimVersion,
      },
    });
    check(staleDispatchFailure.kind === 'STALE_CLAIM',
      'obsolete publisher must be fenced from committing DISPATCH_FAILED');
    const currentDispatchFailure = await storage.commitOperation({
      instanceId: failedProcess.state.instanceId,
      expectedRevision: failedProcess.state.revision,
      requestId: failedDispatch.operation.requestId,
      resolution: 'DISPATCH_FAILED',
      resolvedAt: dispatchFailedState.updatedAt,
      nextState: dispatchFailedState,
      dispatchClaim: {
        workerId: 'failed-publisher-b',
        messageId: currentDispatchClaim.messageId,
        claimVersion: currentDispatchClaim.claimVersion,
      },
    });
    check(currentDispatchFailure.kind === 'COMMITTED',
      'current publisher must atomically commit DISPATCH_FAILED');
    check((await storage.getOperation(failedDispatch.operation.requestId))?.status === 'DISPATCH_FAILED'
      && (await storage.getProcess(failedProcess.state.instanceId))?.state.outcome === 'DISPATCH_FAILED',
    'DISPATCH_FAILED must update the operation and process together');
    check(!(await storage.claimOutbox({
      workerId: 'failed-publisher-c', now: '2026-01-01T00:00:05.000Z', leaseMs: 100, limit: 10,
    })).some((record) => record.requestId === failedDispatch.operation.requestId),
    'a DEAD dispatch outbox must never become claimable again');
  } finally {
    await storage.close();
  }
}

export interface MessageTransportConformanceOptions {
  /** Existing destination/topic reserved for the conformance run. */
  readonly destination?: string;
  /** Maximum time allowed for asynchronous broker delivery. */
  readonly timeoutMs?: number;
  /** Optional broker group-rebalance settling time after subscriptions start. */
  readonly subscriptionSettleMs?: number;
}

let transportConformanceSequence = 0;

export async function runMessageTransportConformance(
  factory: () => MessageTransport,
  options: MessageTransportConformanceOptions = {},
): Promise<void> {
  const transport = factory();
  const destination = options.destination ?? 'events';
  const timeoutMs = options.timeoutMs ?? 10_000;
  const suffix = `${process.pid}-${Date.now()}-${transportConformanceSequence++}`;
  const sameGroup = `conformance-same-${suffix}`;
  const otherGroup = `conformance-other-${suffix}`;
  const retryGroup = `conformance-retry-${suffix}`;
  const sameDeliveries: string[] = [];
  const otherDeliveries: string[] = [];
  const retryAttempts = new Map<string, number>();
  const retryOrder: string[] = [];
  let stopped = false;
  await transport.start();
  try {
    await transport.start();
    const unsubscribeSameA = await transport.subscribe({
      destination,
      consumerGroup: sameGroup,
      handler: async (message) => { sameDeliveries.push(`a:${message.messageId}`); },
    });
    const unsubscribeSameB = await transport.subscribe({
      destination,
      consumerGroup: sameGroup,
      handler: async (message) => { sameDeliveries.push(`b:${message.messageId}`); },
    });
    const unsubscribeOther = await transport.subscribe({
      destination,
      consumerGroup: otherGroup,
      handler: async (message) => { otherDeliveries.push(message.messageId); },
    });
    const unsubscribeRetry = await transport.subscribe({
      destination,
      consumerGroup: retryGroup,
      handler: async (message) => {
        const attempts = (retryAttempts.get(message.messageId) ?? 0) + 1;
        retryAttempts.set(message.messageId, attempts);
        retryOrder.push(message.messageId);
        if (message.messageId === `retry-${suffix}` && attempts === 1) {
          throw new Error('intentional conformance rejection');
        }
      },
    });
    if ((options.subscriptionSettleMs ?? 0) > 0) {
      await delay(options.subscriptionSettleMs!);
    }

    const first = conformanceMessage(destination, `first-${suffix}`);
    const second = conformanceMessage(destination, `second-${suffix}`);
    await transport.publish(first);
    await transport.publish(second);
    await eventually(
      () => sameDeliveries.length >= 2 && otherDeliveries.length >= 2,
      timeoutMs,
      'consumer-group deliveries did not arrive',
    );
    for (const message of [first, second]) {
      check(sameDeliveries.filter((delivery) => delivery.endsWith(`:${message.messageId}`)).length === 1,
        'two subscribers in one consumer group must collectively acknowledge exactly one copy');
      check(otherDeliveries.filter((messageId) => messageId === message.messageId).length === 1,
        'a separate consumer group must acknowledge its own copy');
    }

    const retried = conformanceMessage(destination, `retry-${suffix}`);
    const afterRetry = conformanceMessage(destination, `after-retry-${suffix}`);
    await transport.publish(retried);
    await transport.publish(afterRetry);
    await eventually(
      () => (retryAttempts.get(retried.messageId) ?? 0) >= 2
        && (retryAttempts.get(afterRetry.messageId) ?? 0) >= 1,
      timeoutMs,
      'rejected delivery was not retried or blocked the following record',
    );
    check(retryAttempts.get(retried.messageId) === 2,
      'one handler rejection must cause one redelivery of the same message');
    check(retryAttempts.get(afterRetry.messageId) === 1,
      'the record after a successfully retried delivery must not remain stuck');
    check(retryOrder.lastIndexOf(retried.messageId) < retryOrder.indexOf(afterRetry.messageId),
      'the rejected record must be acknowledged before the following record is handled');

    await unsubscribeSameA();
    await unsubscribeSameA();
    await unsubscribeSameB();
    const afterUnsubscribe = conformanceMessage(destination, `after-unsubscribe-${suffix}`);
    await transport.publish(afterUnsubscribe);
    await eventually(
      () => otherDeliveries.includes(afterUnsubscribe.messageId),
      timeoutMs,
      'remaining consumer group did not receive the post-unsubscribe record',
    );
    check(!sameDeliveries.some((delivery) => delivery.endsWith(`:${afterUnsubscribe.messageId}`)),
      'resolved unsubscribe must prevent new handler invocations');
    await Promise.all([unsubscribeOther(), unsubscribeRetry()]);

    await transport.stop();
    stopped = true;
    await transport.stop();
    let publishRejected = false;
    try {
      await transport.publish(conformanceMessage(destination, `after-stop-${suffix}`));
    } catch {
      publishRejected = true;
    }
    check(publishRejected, 'publish after stop must reject');
    let subscribeRejected = false;
    try {
      await transport.subscribe({ destination, consumerGroup: sameGroup, handler: async () => undefined });
    } catch {
      subscribeRejected = true;
    }
    check(subscribeRejected, 'subscribe after stop must reject');
  } finally {
    if (!stopped) await transport.stop();
  }
}

function conformanceMessage(destination: string, messageId: string): MessageEnvelope {
  return {
    messageId,
    type: 'conformance',
    protocolVersion: '1',
    source: 'test',
    destination,
    partitionKey: 'p-1',
    occurredAt: '2026-01-01T00:00:00.000Z',
    payload: {},
  };
}

async function eventually(
  predicate: () => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Conformance failure: ${message}`);
    await delay(10);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createMemoryConductor(options: Omit<ConductorOptions, 'storage' | 'transport'>) {
  const storage = createMemoryStorage();
  const transport = createMemoryTransport();
  const conductor = new Conductor({ ...options, storage, transport });
  return { conductor, storage, transport } as const;
}
