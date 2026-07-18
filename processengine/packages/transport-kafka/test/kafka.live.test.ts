import { randomUUID } from 'node:crypto';
import { Kafka, logLevel } from 'kafkajs';
import { describe, expect, it } from 'vitest';
import { operationCompletionEnvelope, type MessageEnvelope } from '@processengine/conductor';
import { runMessageTransportConformance } from '@processengine/conductor/testing';
import { createKafkaTransport } from '../src/kafka-transport.js';

const brokers = process.env.KAFKA_LIVE_BROKERS?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
const describeLive = brokers.length > 0 ? describe : describe.skip;

describeLive('Kafka transport live conformance', () => {
  it('passes the reusable MessageTransport SPI conformance suite', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const topic = `processengine.conformance.spi.${suffix}`;
    const adminKafka = new Kafka({ clientId: `pe-conformance-admin-${suffix}`, brokers, logLevel: logLevel.NOTHING });
    const admin = adminKafka.admin();
    await admin.connect();
    try {
      await admin.createTopics({
        waitForLeaders: true,
        topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
      });
      await runMessageTransportConformance(
        () => createKafkaTransport({ clientId: `pe-conformance-${suffix}`, brokers }),
        { destination: topic, timeoutMs: 30_000, subscriptionSettleMs: 3_000 },
      );
    } finally {
      await admin.deleteTopics({ topics: [topic], timeout: 10_000 }).catch(() => undefined);
      await admin.disconnect();
    }
  }, 60_000);

  it('round-trips one validated envelope through a real Kafka broker', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const topic = `processengine.conformance.${suffix}`;
    const sender = createKafkaTransport({ clientId: `pe-sender-${suffix}`, brokers });
    const receiver = createKafkaTransport({ clientId: `pe-receiver-${suffix}`, brokers });
    const adminKafka = new Kafka({ clientId: `pe-cleanup-${suffix}`, brokers, logLevel: logLevel.NOTHING });
    const admin = adminKafka.admin();
    await sender.start();
    await receiver.start();
    await admin.connect();
    try {
      await sender.ensureTopics([{ topic, numPartitions: 1, replicationFactor: 1 }]);
      const received = new Promise<MessageEnvelope>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for Kafka message')), 20_000);
        void receiver.subscribe({
          destination: topic,
          consumerGroup: `pe-conformance-${suffix}`,
          handler: async (message) => {
            clearTimeout(timer);
            resolve(message);
          },
        }).catch((error: unknown) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      const envelope = operationCompletionEnvelope({
        source: 'conformance-worker',
        destination: topic,
        instanceId: 'instance-1',
        occurredAt: new Date().toISOString(),
        completion: { requestId: 'instance-1:step-1', response: { ok: true } },
      });
      await sender.publish(envelope);
      await expect(received).resolves.toEqual(envelope);
    } finally {
      await Promise.allSettled([sender.stop(), receiver.stop()]);
      await admin.deleteTopics({ topics: [topic], timeout: 10_000 }).catch(() => undefined);
      await admin.disconnect();
    }
  }, 30_000);
});
