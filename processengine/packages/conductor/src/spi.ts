import type {
  CompiledProcessDefinition,
  JsonSchema,
  JsonValue,
  OperationContract,
  OperationContractRegistry,
  ProcessState,
} from './types.js';
import type { MessageEnvelope } from './protocol.js';

export interface ArtifactRegistry {
  get(id: string, version: string): Promise<CompiledProcessDefinition | undefined> | CompiledProcessDefinition | undefined;
}

export type ProcessArtifactRegistry = ArtifactRegistry;

export interface OperationPolicy {
  readonly id: string;
  readonly version: string;
  readonly completionTimeoutMs: number;
  readonly dispatch: {
    readonly maxAttempts: number;
    readonly retryDelayMs: number;
  };
}

export interface OperationBinding extends OperationContract {
  readonly destination: string;
  /** Exact MessageEnvelope.source accepted for this operation's completion. */
  readonly completionSource: string;
  readonly policy: OperationPolicy;
  readonly inputSchema?: JsonSchema;
  readonly responseSchema?: JsonSchema;
  readonly errorSchema?: JsonSchema;
}

export interface OperationCatalog extends OperationContractRegistry {
  get(operation: string): OperationBinding | undefined;
}

export interface MessageHandler {
  /**
   * The returned promise is the delivery acknowledgement boundary.
   * Resolving acknowledges this delivery. Rejecting must leave it unacknowledged
   * and the transport must redeliver it (with the same messageId) until a handler
   * resolves or the subscription/transport is stopped.
   */
  (message: MessageEnvelope): Promise<void>;
}

export interface MessageTransport {
  /** Idempotent while started; must support a new start after startup rollback calls stop(). */
  start(): Promise<void>;
  /**
   * Releases transport resources and stops future deliveries. Idempotent.
   * Conductor may call this to roll back a partial startup.
   */
  stop(): Promise<void>;
  /**
   * Resolves only after the underlying transport has durably accepted the
   * envelope. It does not mean that any consumer handler has acknowledged it.
   * A rejected publish must not be reported as accepted.
   */
  publish(message: MessageEnvelope): Promise<void>;
  /**
   * Within one destination and consumerGroup, subscriptions are competing
   * consumers: each accepted message is handled by exactly one of them. Separate
   * consumer groups each receive their own copy. Delivery is at-least-once.
   *
   * The returned unsubscribe function is idempotent. Once it resolves, that
   * subscription receives no new handler invocations. A handler rejection does
   * not acknowledge or skip the record; after a later successful retry, delivery
   * of following records must continue.
   */
  subscribe(options: {
    readonly destination: string;
    readonly consumerGroup: string;
    readonly handler: MessageHandler;
  }): Promise<() => Promise<void>>;
}

export type ProcessTransport = MessageTransport;

export interface ProcessRecord {
  readonly namespace: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly state: ProcessState;
}

export type StoredOperationStatus = 'PENDING' | 'PUBLISHED' | 'SUCCESS' | 'ERROR' | 'TIMED_OUT' | 'DISPATCH_FAILED';

export interface StoredOperation {
  readonly requestId: string;
  readonly instanceId: string;
  readonly stepId: string;
  readonly operation: string;
  readonly destination: string;
  readonly completionSource: string;
  readonly status: StoredOperationStatus;
  readonly policy: OperationPolicy;
  /** Null until the command publication is durably acknowledged. */
  readonly deadlineAt: string | null;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly timeoutClaimVersion: number;
  readonly timeoutClaimedBy?: string;
  readonly timeoutLeaseUntil?: string;
}

export type OutboxStatus = 'PENDING' | 'CLAIMED' | 'PUBLISHED' | 'DEAD' | 'CANCELLED';

export interface OutboxRecord {
  readonly messageId: string;
  readonly requestId: string;
  readonly instanceId: string;
  readonly envelope: MessageEnvelope;
  readonly status: OutboxStatus;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  readonly availableAt: string;
  readonly claimVersion: number;
  readonly claimedBy?: string;
  readonly leaseUntil?: string;
}

export interface DurableDispatch {
  readonly operation: StoredOperation;
  readonly outbox: OutboxRecord;
}

export type CreateProcessResult =
  | { readonly kind: 'CREATED'; readonly process: ProcessRecord }
  | { readonly kind: 'EXISTING'; readonly process: ProcessRecord }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT'; readonly instanceId: string };

export type CommitOperationResult =
  | { readonly kind: 'COMMITTED'; readonly process: ProcessRecord }
  | { readonly kind: 'DUPLICATE' | 'CONFLICT' | 'NOT_FOUND' | 'ALREADY_RESOLVED' | 'STALE_CLAIM' };

export interface ProcessStorage {
  /** Idempotent while the adapter remains open. */
  initialize(): Promise<void>;
  /** Terminal for an adapter that owns non-reopenable resources such as a pg.Pool. */
  close(): Promise<void>;

  createProcess(request: {
    readonly process: ProcessRecord;
    readonly dispatch?: DurableDispatch;
  }): Promise<CreateProcessResult>;

  getProcess(instanceId: string): Promise<ProcessRecord | undefined>;
  getOperation(requestId: string): Promise<StoredOperation | undefined>;

  commitOperation(request: {
    readonly instanceId: string;
    readonly expectedRevision: number;
    readonly requestId: string;
    readonly inboxMessageId?: string;
    readonly resolution: 'SUCCESS' | 'ERROR' | 'TIMED_OUT' | 'DISPATCH_FAILED';
    readonly resolvedAt: string;
    readonly nextState: ProcessState;
    readonly nextDispatch?: DurableDispatch;
    readonly timeoutClaim?: {
      readonly workerId: string;
      readonly claimVersion: number;
    };
    readonly dispatchClaim?: {
      readonly workerId: string;
      readonly messageId: string;
      readonly claimVersion: number;
    };
  }): Promise<CommitOperationResult>;

  claimOutbox(request: {
    readonly workerId: string;
    readonly now: string;
    readonly leaseMs: number;
    readonly limit: number;
  }): Promise<readonly OutboxRecord[]>;

  markOutboxPublished(request: {
    readonly messageId: string;
    readonly workerId: string;
    readonly claimVersion: number;
    readonly publishedAt: string;
  }): Promise<void>;

  rescheduleOutbox(request: {
    readonly messageId: string;
    readonly workerId: string;
    readonly claimVersion: number;
    readonly availableAt: string;
  }): Promise<void>;

  claimExpiredOperations(request: {
    readonly workerId: string;
    readonly now: string;
    readonly leaseMs: number;
    readonly limit: number;
  }): Promise<readonly StoredOperation[]>;
}

export type ConductorStorage = ProcessStorage;

export interface Clock {
  now(): Date;
}

export interface ConductorOptions {
  readonly source: string;
  readonly completionDestination: string;
  readonly consumerGroup?: string;
  readonly artifacts: ArtifactRegistry;
  readonly operations: OperationCatalog;
  readonly storage: ProcessStorage;
  readonly transport: MessageTransport;
  readonly clock?: Clock;
  readonly worker?: {
    readonly pollIntervalMs?: number;
    readonly outboxBatchSize?: number;
    readonly timeoutBatchSize?: number;
    readonly outboxLeaseMs?: number;
    readonly onError?: (error: unknown) => void;
  };
}

export interface StartProcessRequest {
  readonly namespace: string;
  readonly idempotencyKey: string;
  readonly flow: { readonly id: string; readonly version: string };
  readonly input: JsonValue;
  readonly instanceId?: string;
}

export type StartProcessResult =
  | { readonly kind: 'STARTED' | 'EXISTING'; readonly process: ProcessState }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT'; readonly instanceId: string };
