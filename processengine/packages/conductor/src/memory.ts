import type { MessageEnvelope } from './protocol.js';
import type {
  CommitOperationResult,
  CreateProcessResult,
  DurableDispatch,
  MessageHandler,
  MessageTransport,
  OutboxRecord,
  ProcessRecord,
  ProcessStorage,
  StoredOperation,
} from './spi.js';

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryProcessStorage implements ProcessStorage {
  private readonly processes = new Map<string, ProcessRecord>();
  private readonly idempotency = new Map<string, string>();
  private readonly operations = new Map<string, StoredOperation>();
  private readonly outbox = new Map<string, OutboxRecord>();
  private readonly inbox = new Set<string>();

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}

  async createProcess(request: { process: ProcessRecord; dispatch?: DurableDispatch }): Promise<CreateProcessResult> {
    const key = `${request.process.namespace}\u0000${request.process.idempotencyKey}`;
    const existingId = this.idempotency.get(key);
    if (existingId) {
      const existing = this.processes.get(existingId)!;
      return existing.fingerprint === request.process.fingerprint
        ? { kind: 'EXISTING', process: clone(existing) }
        : { kind: 'IDEMPOTENCY_CONFLICT', instanceId: existing.state.instanceId };
    }
    const instanceId = request.process.state.instanceId;
    if (this.processes.has(instanceId)) return { kind: 'IDEMPOTENCY_CONFLICT', instanceId };
    if (request.dispatch) this.assertDispatchAvailable(request.dispatch);
    this.processes.set(instanceId, clone(request.process));
    this.idempotency.set(key, instanceId);
    if (request.dispatch) this.insertDispatch(request.dispatch);
    return { kind: 'CREATED', process: clone(request.process) };
  }

  async getProcess(instanceId: string): Promise<ProcessRecord | undefined> {
    const value = this.processes.get(instanceId);
    return value ? clone(value) : undefined;
  }

  async getOperation(requestId: string): Promise<StoredOperation | undefined> {
    const value = this.operations.get(requestId);
    return value ? clone(value) : undefined;
  }

  async commitOperation(request: {
    instanceId: string;
    expectedRevision: number;
    requestId: string;
    inboxMessageId?: string;
    resolution: 'SUCCESS' | 'ERROR' | 'TIMED_OUT' | 'DISPATCH_FAILED';
    resolvedAt: string;
    nextState: ProcessRecord['state'];
    nextDispatch?: DurableDispatch;
    timeoutClaim?: { workerId: string; claimVersion: number };
    dispatchClaim?: { workerId: string; messageId: string; claimVersion: number };
  }): Promise<CommitOperationResult> {
    if (request.inboxMessageId && this.inbox.has(request.inboxMessageId)) return { kind: 'DUPLICATE' };
    const process = this.processes.get(request.instanceId);
    const operation = this.operations.get(request.requestId);
    if (!process || !operation) return { kind: 'NOT_FOUND' };
    if (process.state.revision !== request.expectedRevision) return { kind: 'CONFLICT' };
    if (operation.status !== 'PENDING' && operation.status !== 'PUBLISHED') return { kind: 'ALREADY_RESOLVED' };

    if (request.resolution === 'TIMED_OUT') {
      const claim = request.timeoutClaim;
      if (!claim || operation.timeoutClaimedBy !== claim.workerId
        || operation.timeoutClaimVersion !== claim.claimVersion
        || !operation.timeoutLeaseUntil || operation.timeoutLeaseUntil < request.resolvedAt) {
        return { kind: 'STALE_CLAIM' };
      }
    }
    if (request.resolution === 'DISPATCH_FAILED') {
      const claim = request.dispatchClaim;
      const outbox = claim ? this.outbox.get(claim.messageId) : undefined;
      if (!claim || !outbox || outbox.requestId !== request.requestId || outbox.status !== 'CLAIMED'
        || outbox.claimedBy !== claim.workerId || outbox.claimVersion !== claim.claimVersion
        || !outbox.leaseUntil || outbox.leaseUntil < request.resolvedAt) {
        return { kind: 'STALE_CLAIM' };
      }
    }
    if (request.nextDispatch) this.assertDispatchAvailable(request.nextDispatch);

    if (request.inboxMessageId) this.inbox.add(request.inboxMessageId);
    const nextProcess: ProcessRecord = { ...process, state: clone(request.nextState) };
    this.processes.set(request.instanceId, nextProcess);
    this.operations.set(request.requestId, {
      ...operation,
      status: request.resolution,
      resolvedAt: request.resolvedAt,
    });
    const currentOutbox = [...this.outbox.values()].find((item) => item.requestId === request.requestId);
    if (currentOutbox && currentOutbox.status !== 'PUBLISHED') {
      const { claimedBy: _claimedBy, leaseUntil: _leaseUntil, ...unclaimed } = currentOutbox;
      this.outbox.set(currentOutbox.messageId, {
        ...unclaimed,
        status: request.resolution === 'DISPATCH_FAILED' ? 'DEAD' : 'CANCELLED',
      });
    }
    if (request.nextDispatch) this.insertDispatch(request.nextDispatch);
    return { kind: 'COMMITTED', process: clone(nextProcess) };
  }

  async claimOutbox(request: {
    workerId: string;
    now: string;
    leaseMs: number;
    limit: number;
  }): Promise<readonly OutboxRecord[]> {
    const nowMs = Date.parse(request.now);
    const eligible = [...this.outbox.values()]
      .filter((item) => (item.status === 'PENDING' && Date.parse(item.availableAt) <= nowMs)
        || (item.status === 'CLAIMED' && item.leaseUntil !== undefined && Date.parse(item.leaseUntil) <= nowMs))
      .sort((left, right) => left.availableAt.localeCompare(right.availableAt) || left.messageId.localeCompare(right.messageId))
      .slice(0, request.limit);
    return eligible.map((item) => {
      const claimed: OutboxRecord = {
        ...item,
        status: 'CLAIMED',
        attempt: Math.min(item.attempt + 1, item.maxAttempts),
        claimVersion: item.claimVersion + 1,
        claimedBy: request.workerId,
        leaseUntil: new Date(nowMs + request.leaseMs).toISOString(),
      };
      this.outbox.set(item.messageId, claimed);
      return clone(claimed);
    });
  }

  async markOutboxPublished(request: {
    messageId: string;
    workerId: string;
    claimVersion: number;
    publishedAt: string;
  }): Promise<void> {
    const item = this.outbox.get(request.messageId);
    if (!item || item.status !== 'CLAIMED' || item.claimedBy !== request.workerId
      || item.claimVersion !== request.claimVersion || !item.leaseUntil || item.leaseUntil < request.publishedAt) return;
    const { claimedBy: _claimedBy, leaseUntil: _leaseUntil, ...unclaimed } = item;
    this.outbox.set(item.messageId, { ...unclaimed, status: 'PUBLISHED' });
    const operation = this.operations.get(item.requestId);
    if (operation?.status === 'PENDING') {
      this.operations.set(item.requestId, {
        ...operation,
        status: 'PUBLISHED',
        deadlineAt: new Date(
          Date.parse(request.publishedAt) + operation.policy.completionTimeoutMs,
        ).toISOString(),
      });
    }
  }

  async rescheduleOutbox(request: {
    messageId: string;
    workerId: string;
    claimVersion: number;
    availableAt: string;
  }): Promise<void> {
    const item = this.outbox.get(request.messageId);
    if (!item || item.status !== 'CLAIMED' || item.claimedBy !== request.workerId
      || item.claimVersion !== request.claimVersion) return;
    const { claimedBy: _claimedBy, leaseUntil: _leaseUntil, ...unclaimed } = item;
    this.outbox.set(item.messageId, { ...unclaimed, status: 'PENDING', availableAt: request.availableAt });
  }

  async claimExpiredOperations(request: {
    workerId: string;
    now: string;
    leaseMs: number;
    limit: number;
  }): Promise<readonly StoredOperation[]> {
    const eligible = [...this.operations.values()]
      .filter((item) => item.status === 'PUBLISHED'
        && item.deadlineAt !== null
        && item.deadlineAt <= request.now
        && (!item.timeoutLeaseUntil || item.timeoutLeaseUntil <= request.now))
      .sort((left, right) => left.deadlineAt!.localeCompare(right.deadlineAt!) || left.requestId.localeCompare(right.requestId))
      .slice(0, request.limit);
    const leaseUntil = new Date(Date.parse(request.now) + request.leaseMs).toISOString();
    return eligible.map((item) => {
      const claimed: StoredOperation = {
        ...item,
        timeoutClaimVersion: item.timeoutClaimVersion + 1,
        timeoutClaimedBy: request.workerId,
        timeoutLeaseUntil: leaseUntil,
      };
      this.operations.set(item.requestId, claimed);
      return clone(claimed);
    });
  }

  snapshot(): {
    readonly processes: readonly ProcessRecord[];
    readonly operations: readonly StoredOperation[];
    readonly outbox: readonly OutboxRecord[];
    readonly inbox: readonly string[];
  } {
    return {
      processes: [...this.processes.values()].map(clone),
      operations: [...this.operations.values()].map(clone),
      outbox: [...this.outbox.values()].map(clone),
      inbox: [...this.inbox],
    };
  }

  private assertDispatchAvailable(dispatch: DurableDispatch): void {
    if (this.operations.has(dispatch.operation.requestId) || this.outbox.has(dispatch.outbox.messageId)) {
      throw new Error('Duplicate durable dispatch');
    }
  }

  private insertDispatch(dispatch: DurableDispatch): void {
    this.operations.set(dispatch.operation.requestId, clone(dispatch.operation));
    this.outbox.set(dispatch.outbox.messageId, clone(dispatch.outbox));
  }
}

interface Subscriber {
  readonly id: number;
  readonly handler: MessageHandler;
}

export class MemoryMessageTransport implements MessageTransport {
  private readonly subscriptions = new Map<string, Map<string, Subscriber[]>>();
  private readonly cursors = new Map<string, number>();
  private nextId = 1;
  private running = false;
  readonly published: MessageEnvelope[] = [];

  async start(): Promise<void> { this.running = true; }
  async stop(): Promise<void> {
    this.running = false;
    this.subscriptions.clear();
    this.cursors.clear();
  }

  async publish(message: MessageEnvelope): Promise<void> {
    if (!this.running) throw new Error('Memory transport is not started');
    this.published.push(clone(message));
    const groups = this.subscriptions.get(message.destination);
    if (!groups) return;
    for (const group of groups.keys()) {
      await this.deliverUntilAcknowledged(message.destination, group, message);
    }
  }

  async subscribe(options: {
    destination: string;
    consumerGroup: string;
    handler: MessageHandler;
  }): Promise<() => Promise<void>> {
    if (!this.running) throw new Error('Memory transport is not started');
    if (!options.destination || !options.consumerGroup) {
      throw new TypeError('Memory destination and consumerGroup are required');
    }
    const groups = this.subscriptions.get(options.destination) ?? new Map<string, Subscriber[]>();
    this.subscriptions.set(options.destination, groups);
    const subscribers = groups.get(options.consumerGroup) ?? [];
    groups.set(options.consumerGroup, subscribers);
    const subscriber = { id: this.nextId++, handler: options.handler };
    subscribers.push(subscriber);
    return async () => {
      const index = subscribers.findIndex((item) => item.id === subscriber.id);
      if (index >= 0) subscribers.splice(index, 1);
    };
  }

  private async deliverUntilAcknowledged(
    destination: string,
    group: string,
    message: MessageEnvelope,
  ): Promise<void> {
    const cursorKey = `${destination}\u0000${group}`;
    while (this.running) {
      const subscribers = this.subscriptions.get(destination)?.get(group);
      if (!subscribers || subscribers.length === 0) return;
      const cursor = this.cursors.get(cursorKey) ?? 0;
      const subscriber = subscribers[cursor % subscribers.length]!;
      try {
        await subscriber.handler(clone(message));
        this.cursors.set(cursorKey, cursor + 1);
        return;
      } catch {
        // Handler rejection is a negative acknowledgement. Yield before
        // redelivery so stop()/unsubscribe() can make progress.
        await Promise.resolve();
      }
    }
    throw new Error('Memory transport stopped before delivery was acknowledged');
  }
}

export function createMemoryStorage(): MemoryProcessStorage {
  return new MemoryProcessStorage();
}

export function createMemoryTransport(): MemoryMessageTransport {
  return new MemoryMessageTransport();
}
