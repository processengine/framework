import { randomUUID } from 'node:crypto';
import { ProtocolError } from './errors.js';
import { cloneJson, isRecord } from './json.js';
import { failure, normalizeCompletion, success } from './kernel.js';
import type { JsonValue, OperationCompletion, OperationError } from './types.js';

export const OPERATION_COMMAND = 'processengine.operation.command';
export const OPERATION_COMPLETION = 'processengine.operation.completion';

export interface MessageEnvelope<Payload extends JsonValue = JsonValue> {
  readonly messageId: string;
  readonly type: string;
  readonly protocolVersion: '1';
  readonly source: string;
  readonly destination: string;
  readonly partitionKey: string;
  readonly occurredAt: string;
  readonly payload: Payload;
}

export interface OperationCommandPayload {
  readonly requestId: string;
  readonly instanceId: string;
  readonly stepId: string;
  readonly operation: string;
  readonly replyTo: string;
  readonly input: JsonValue;
}

export type OperationCompletionPayload =
  | { readonly requestId: string; readonly response: JsonValue }
  | { readonly requestId: string; readonly error: OperationError };

function requiredText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function envelope(input: {
  messageId?: string;
  type: string;
  source: string;
  destination: string;
  partitionKey: string;
  occurredAt: string;
  payload: JsonValue;
}): MessageEnvelope {
  return {
    messageId: input.messageId ?? randomUUID(),
    type: input.type,
    protocolVersion: '1',
    source: input.source,
    destination: input.destination,
    partitionKey: input.partitionKey,
    occurredAt: input.occurredAt,
    payload: cloneJson(input.payload),
  };
}

export function operationCommandEnvelope(input: {
  readonly source: string;
  readonly destination: string;
  readonly responseDestination: string;
  readonly occurredAt: string;
  readonly payload: Omit<OperationCommandPayload, 'replyTo'>;
}): MessageEnvelope {
  const payload: OperationCommandPayload = { ...input.payload, replyTo: input.responseDestination };
  return envelope({
    messageId: `${input.payload.requestId}:command`,
    type: OPERATION_COMMAND,
    source: input.source,
    destination: input.destination,
    partitionKey: input.payload.instanceId,
    occurredAt: input.occurredAt,
    payload: payload as unknown as JsonValue,
  });
}

export function operationCompletionEnvelope(input: {
  readonly source: string;
  readonly destination: string;
  readonly occurredAt: string;
  readonly instanceId: string;
  readonly completion: OperationCompletionPayload;
  readonly messageId?: string;
}): MessageEnvelope {
  return envelope({
    messageId: input.messageId ?? `${input.completion.requestId}:completion`,
    type: OPERATION_COMPLETION,
    source: input.source,
    destination: input.destination,
    partitionKey: input.instanceId,
    occurredAt: input.occurredAt,
    payload: input.completion as unknown as JsonValue,
  });
}

export const responseEnvelope = operationCompletionEnvelope;

export function parseOperationCommand(message: MessageEnvelope): OperationCommandPayload {
  if (message.type !== OPERATION_COMMAND || message.protocolVersion !== '1' || !isRecord(message.payload)) {
    throw new ProtocolError('Message is not an operation command');
  }
  const payload = message.payload;
  if (![payload.requestId, payload.instanceId, payload.stepId, payload.operation, payload.replyTo].every(requiredText)
    || !Object.hasOwn(payload, 'input')) {
    throw new ProtocolError('Operation command payload is invalid');
  }
  if (message.partitionKey !== payload.instanceId) {
    throw new ProtocolError('Operation command partitionKey does not match instanceId');
  }
  if (payload.requestId !== `${payload.instanceId}:${payload.stepId}`) {
    throw new ProtocolError('Operation command requestId does not match instanceId and stepId');
  }
  return {
    requestId: payload.requestId as string,
    instanceId: payload.instanceId as string,
    stepId: payload.stepId as string,
    operation: payload.operation as string,
    replyTo: payload.replyTo as string,
    input: cloneJson(payload.input),
  };
}

export const assertOperationCommand = parseOperationCommand;

export function parseOperationCompletion(message: MessageEnvelope): {
  readonly requestId: string;
  readonly completion: OperationCompletion;
} {
  if (message.type !== OPERATION_COMPLETION || message.protocolVersion !== '1' || !isRecord(message.payload)) {
    throw new ProtocolError('Message is not an operation completion');
  }
  const payload = message.payload;
  if (!requiredText(payload.requestId)) throw new ProtocolError('Operation completion requestId is invalid');
  const hasResponse = Object.hasOwn(payload, 'response');
  const hasError = Object.hasOwn(payload, 'error');
  if (hasResponse === hasError) throw new ProtocolError('Operation completion must contain response or error');
  try {
    return {
      requestId: payload.requestId,
      completion: hasResponse
        ? success(cloneJson(payload.response))
        : failure(payload.error as unknown as OperationError),
    };
  } catch (error) {
    if (error instanceof Error) throw new ProtocolError(error.message);
    throw error;
  }
}

export function completionPayload(requestId: string, completion: OperationCompletion): OperationCompletionPayload {
  const normalized = normalizeCompletion(completion);
  return normalized.status === 'SUCCESS'
    ? { requestId, response: normalized.response }
    : { requestId, error: normalized.error };
}
