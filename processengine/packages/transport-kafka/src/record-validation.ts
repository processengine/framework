import type { MessageEnvelope } from '@processengine/conductor';
import type { InvalidKafkaMessage } from './kafka-transport.js';

export type KafkaRecordHeaders = Record<string, Buffer | string | (Buffer | string)[] | undefined>;

/**
 * Internal, pure validation seam used by the Kafka adapter and its unit tests.
 * It is deliberately not re-exported from the package entry point.
 */
export function validateKafkaRecord(input: {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
  readonly key: Buffer | null;
  readonly value: Buffer | null;
  readonly headers?: KafkaRecordHeaders | undefined;
}): InvalidKafkaMessage | undefined {
  const invalid = (reason: string): InvalidKafkaMessage => ({
    reason,
    topic: input.topic,
    partition: input.partition,
    offset: input.offset,
    key: input.key?.toString('utf8') ?? null,
    value: input.value?.toString('base64') ?? null,
  });

  if (input.value === null) return invalid('Kafka record has no value');

  let candidate: unknown;
  try {
    candidate = JSON.parse(input.value.toString('utf8')) as unknown;
  } catch {
    return invalid('Kafka record value is not valid JSON');
  }

  if (!isEnvelope(candidate)) return invalid('Kafka record is not a valid ProcessEngine envelope');
  if (input.key?.toString('utf8') !== candidate.partitionKey) {
    return invalid('Kafka record key does not match envelope partitionKey');
  }
  if (candidate.destination !== input.topic) {
    return invalid('Envelope destination does not match Kafka topic');
  }
  if (firstHeader(input.headers?.['message-id']) !== candidate.messageId) {
    return invalid('Kafka message-id header does not match envelope messageId');
  }
  if (firstHeader(input.headers?.['message-type']) !== candidate.type) {
    return invalid('Kafka message-type header does not match envelope type');
  }
  if (firstHeader(input.headers?.['protocol-version']) !== candidate.protocolVersion) {
    return invalid('Kafka protocol-version header does not match envelope protocolVersion');
  }

  return undefined;
}

function firstHeader(value: Buffer | string | (Buffer | string)[] | undefined): string | undefined {
  const item = Array.isArray(value) ? value[0] : value;
  return Buffer.isBuffer(item) ? item.toString('utf8') : item;
}

function isEnvelope(value: unknown): value is MessageEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<MessageEnvelope>;
  return item.protocolVersion === '1'
    && [item.messageId, item.type, item.source, item.destination, item.partitionKey, item.occurredAt]
      .every((field) => typeof field === 'string' && field.length > 0)
    && Object.hasOwn(item, 'payload');
}
