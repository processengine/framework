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
