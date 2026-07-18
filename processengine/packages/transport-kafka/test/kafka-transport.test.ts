import { beforeEach, describe, expect, it, vi } from 'vitest';

const kafka = vi.hoisted(() => ({
  constructorOptions: [] as unknown[],
  producerOptions: [] as unknown[],
  producer: {
    connect: vi.fn<() => Promise<void>>(),
    disconnect: vi.fn<() => Promise<void>>(),
    send: vi.fn<() => Promise<unknown>>(),
  },
  admin: {
    connect: vi.fn<() => Promise<void>>(),
    disconnect: vi.fn<() => Promise<void>>(),
  },
}));

vi.mock('kafkajs', () => ({
  logLevel: { NOTHING: 0 },
  Kafka: class {
    constructor(options: unknown) { kafka.constructorOptions.push(options); }
    producer(options: unknown) {
      kafka.producerOptions.push(options);
      return kafka.producer;
    }
    admin() { return kafka.admin; }
  },
}));

import { createKafkaTransport } from '../src/kafka-transport.js';

describe('Kafka transport configuration and lifecycle', () => {
  beforeEach(() => {
    kafka.constructorOptions.length = 0;
    kafka.producerOptions.length = 0;
    kafka.producer.connect.mockReset().mockResolvedValue(undefined);
    kafka.producer.disconnect.mockReset().mockResolvedValue(undefined);
    kafka.producer.send.mockReset().mockResolvedValue({});
    kafka.admin.connect.mockReset().mockResolvedValue(undefined);
    kafka.admin.disconnect.mockReset().mockResolvedValue(undefined);
  });

  it('gives the idempotent producer an explicit finite retry budget', () => {
    createKafkaTransport({ clientId: 'bounded-producer', brokers: ['kafka:9092'] });

    expect(kafka.producerOptions).toEqual([expect.objectContaining({
      idempotent: true,
      maxInFlightRequests: 1,
      retry: { retries: 2, initialRetryTime: 250, maxRetryTime: 1_000 },
    })]);
  });

  it('applies the configured finite retry policy to both client and producer', () => {
    const retry = { retries: 4, initialRetryTime: 50, maxRetryTime: 500 };
    createKafkaTransport({ clientId: 'custom-producer', brokers: ['kafka:9092'], retry });

    expect(kafka.constructorOptions[0]).toEqual(expect.objectContaining({ retry }));
    expect(kafka.producerOptions[0]).toEqual(expect.objectContaining({ retry }));
  });

  it('serializes stop behind an in-flight start', async () => {
    let releaseConnect!: () => void;
    kafka.producer.connect.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseConnect = resolve; }));
    const transport = createKafkaTransport({ clientId: 'lifecycle', brokers: ['kafka:9092'] });

    const starting = transport.start();
    const stopping = transport.stop();
    await vi.waitFor(() => expect(kafka.producer.connect).toHaveBeenCalledOnce());
    expect(kafka.admin.disconnect).not.toHaveBeenCalled();

    releaseConnect();
    await Promise.all([starting, stopping]);

    expect(kafka.admin.connect).toHaveBeenCalledOnce();
    expect(kafka.admin.disconnect).toHaveBeenCalledOnce();
    expect(kafka.producer.disconnect).toHaveBeenCalledOnce();
  });

  it('rejects a publish that exceeds publishTimeoutMs so the outbox can reschedule', async () => {
    // Simulate an unreachable broker: send never settles.
    kafka.producer.send.mockImplementationOnce(() => new Promise<never>(() => {}));
    const transport = createKafkaTransport({
      clientId: 'bounded-publish', brokers: ['kafka:9092'], publishTimeoutMs: 20,
    });
    await transport.start();

    const envelope = {
      destination: 'commands', partitionKey: 'k', messageId: 'm-1',
      type: 'processengine.command', protocolVersion: '1',
    } as unknown as Parameters<typeof transport.publish>[0];

    await expect(transport.publish(envelope)).rejects.toThrow(/publish exceeded 20ms/u);
  });
});
