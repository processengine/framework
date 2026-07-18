import { describe, expect, it } from 'vitest';
import type { MessageEnvelope } from '@processengine/conductor';
import { validateKafkaRecord, type KafkaRecordHeaders } from '../src/record-validation.js';

const envelope: MessageEnvelope = {
  messageId: 'request-1:completion',
  type: 'processengine.operation.completion',
  protocolVersion: '1',
  source: 'shop-payment',
  destination: 'shop.operation.completions',
  partitionKey: 'checkout-1',
  occurredAt: '2026-07-18T10:00:00.000Z',
  payload: { requestId: 'checkout-1:authorize-payment', response: { status: 'APPROVED' } },
};

function record(overrides: Partial<{
  topic: string;
  key: Buffer | null;
  value: Buffer | null;
  headers: KafkaRecordHeaders;
}> = {}) {
  return {
    topic: envelope.destination,
    partition: 2,
    offset: '41',
    key: Buffer.from(envelope.partitionKey),
    value: Buffer.from(JSON.stringify(envelope)),
    headers: {
      'message-id': Buffer.from(envelope.messageId),
      'message-type': Buffer.from(envelope.type),
      'protocol-version': Buffer.from(envelope.protocolVersion),
    },
    ...overrides,
  };
}

describe('Kafka record/envelope validation', () => {
  it('accepts a record only when record metadata and envelope agree', () => {
    expect(validateKafkaRecord(record())).toBeUndefined();
  });

  it.each([
    ['key', record({ key: Buffer.from('another-instance') }), 'Kafka record key does not match envelope partitionKey'],
    ['destination', record({ topic: 'another.topic' }), 'Envelope destination does not match Kafka topic'],
    ['message-id', record({ headers: {
      ...record().headers,
      'message-id': Buffer.from('another-message'),
    } }), 'Kafka message-id header does not match envelope messageId'],
    ['message-type', record({ headers: {
      ...record().headers,
      'message-type': Buffer.from('another.type'),
    } }), 'Kafka message-type header does not match envelope type'],
    ['protocol-version', record({ headers: {
      ...record().headers,
      'protocol-version': Buffer.from('2'),
    } }), 'Kafka protocol-version header does not match envelope protocolVersion'],
  ])('rejects a mismatched %s', (_field, input, reason) => {
    expect(validateKafkaRecord(input)).toMatchObject({
      reason,
      topic: input.topic,
      partition: 2,
      offset: '41',
    });
  });

  it('rejects missing headers instead of accepting unverifiable metadata', () => {
    expect(validateKafkaRecord(record({ headers: {} })))
      .toMatchObject({ reason: 'Kafka message-id header does not match envelope messageId' });
  });

  it('rejects a record with no value', () => {
    expect(validateKafkaRecord(record({ value: null })))
      .toMatchObject({ reason: 'Kafka record has no value', value: null });
  });

  it('rejects malformed JSON and keeps the original bytes as base64 evidence', () => {
    const value = Buffer.from('{not-json');
    expect(validateKafkaRecord(record({ value }))).toMatchObject({
      reason: 'Kafka record value is not valid JSON',
      value: value.toString('base64'),
    });
  });
});
