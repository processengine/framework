import type {
  MessageEnvelope,
  OperationCommandPayload,
  OperationError,
} from './conductor-adapter.js';
import type { Pool, PoolClient } from 'pg';

export type JsonValue = MessageEnvelope['payload'];

export type OperationHandlerOutcome =
  | { readonly kind: 'result'; readonly result: JsonValue }
  | { readonly kind: 'error'; readonly error: OperationError }
  | { readonly kind: 'no-response' };

export interface OperationHandlerContext {
  readonly command: OperationCommandPayload;
  readonly db: PoolClient;
}

export interface OperationHandler {
  (context: OperationHandlerContext): Promise<OperationHandlerOutcome>;
}

export interface OperationCommitEvent {
  readonly command: OperationCommandPayload;
  readonly outcome: OperationHandlerOutcome;
  readonly created: boolean;
}

export interface OperationBeforeAcceptEvent {
  readonly command: OperationCommandPayload;
  readonly serviceInstanceId: string;
  readonly pool: Pool;
}

export interface OperationBeforePublishEvent {
  readonly envelope: MessageEnvelope;
  readonly pool: Pool;
}

export type OperationPublishDecision =
  | { readonly kind: 'publish' }
  | { readonly kind: 'defer'; readonly retryAfterMs: number };

export interface OperationServiceOptions {
  readonly serviceName: string;
  readonly source: string;
  readonly databaseUrl: string;
  readonly databaseSchema: string;
  readonly kafka: {
    readonly brokers: readonly string[];
    readonly clientId: string;
    readonly commandTopic: string;
    readonly consumerGroup: string;
  };
  readonly handlers: Readonly<Record<string, OperationHandler>>;
  readonly migrateDomain?: (pool: Pool) => Promise<void>;
  readonly beforeAccept?: (event: OperationBeforeAcceptEvent) => Promise<void> | void;
  readonly afterCommit?: (event: OperationCommitEvent) => Promise<void> | void;
  readonly beforePublish?: (
    event: OperationBeforePublishEvent,
  ) => Promise<OperationPublishDecision> | OperationPublishDecision;
  readonly onPoolError?: (error: Error) => void;
  readonly postgresConnectionTimeoutMs?: number;
  readonly outboxPollMs?: number;
}

export interface OperationLedgerStats {
  readonly processId: string;
  readonly total: number;
  readonly operations: Readonly<Record<string, number>>;
  readonly requestIds: readonly string[];
  readonly publishedResponses: number;
}

export const result = (value: JsonValue): OperationHandlerOutcome => ({ kind: 'result', result: value });
export const failure = (error: OperationError): OperationHandlerOutcome => ({ kind: 'error', error });
export const noResponse = (): OperationHandlerOutcome => ({ kind: 'no-response' });
export const publishOperationCompletion = (): OperationPublishDecision => ({ kind: 'publish' });
export const deferOperationCompletion = (retryAfterMs: number): OperationPublishDecision => {
  if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs <= 0) {
    throw new TypeError('retryAfterMs must be a positive integer');
  }
  return { kind: 'defer', retryAfterMs };
};
