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

function envelope(messageId: string, destination = 'commands') {
  return {
    destination,
    partitionKey: 'k',
    messageId,
    type: 'processengine.command',
    protocolVersion: '1',
  } as unknown as Parameters<ReturnType<typeof createKafkaTransport>['publish']>[0];
}

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

    await expect(transport.publish(envelope('m-1'))).rejects.toMatchObject({
      code: 'KAFKA_PUBLISH_TIMEOUT',
      deliveryStatus: 'unknown',
    });
  });

  it('coalesces repeated publish calls for the same messageId while send is active', async () => {
    let resolveSend!: () => void;
    kafka.producer.send.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSend = resolve; }));
    const transport = createKafkaTransport({
      clientId: 'coalesced-publish', brokers: ['kafka:9092'], publishTimeoutMs: 1_000,
    });
    await transport.start();

    const first = transport.publish(envelope('m-coalesced'));
    const second = transport.publish(envelope('m-coalesced'));
    await vi.waitFor(() => expect(kafka.producer.send).toHaveBeenCalledOnce());
    resolveSend();

    await Promise.all([first, second]);
    expect(kafka.producer.send).toHaveBeenCalledOnce();
  });

  it('consumes a late success after caller timeout without sending the same message again', async () => {
    let resolveSend!: () => void;
    kafka.producer.send.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSend = resolve; }));
    const transport = createKafkaTransport({
      clientId: 'late-success', brokers: ['kafka:9092'], publishTimeoutMs: 20,
    });
    await transport.start();

    await expect(transport.publish(envelope('m-late-success'))).rejects.toMatchObject({
      deliveryStatus: 'unknown',
    });
    resolveSend();
    await Promise.resolve();
    await Promise.resolve();

    await expect(transport.publish(envelope('m-late-success'))).resolves.toBeUndefined();
    expect(kafka.producer.send).toHaveBeenCalledOnce();
  });

  it('allows a normal retry after a timed-out send rejects late', async () => {
    let rejectSend!: (error: Error) => void;
    kafka.producer.send.mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectSend = reject; }));
    const transport = createKafkaTransport({
      clientId: 'late-rejection', brokers: ['kafka:9092'], publishTimeoutMs: 20,
    });
    await transport.start();

    await expect(transport.publish(envelope('m-late-rejection'))).rejects.toMatchObject({
      deliveryStatus: 'unknown',
    });
    rejectSend(new Error('broker remained unavailable'));
    await Promise.resolve();
    await Promise.resolve();
    kafka.producer.send.mockResolvedValueOnce({});

    await expect(transport.publish(envelope('m-late-rejection'))).resolves.toBeUndefined();
    expect(kafka.producer.send).toHaveBeenCalledTimes(2);
  });

  it('does not create parallel orphan sends while the active send never settles', async () => {
    kafka.producer.send.mockImplementationOnce(() => new Promise<never>(() => {}));
    const transport = createKafkaTransport({
      clientId: 'single-flight', brokers: ['kafka:9092'], publishTimeoutMs: 20,
    });
    await transport.start();

    await expect(transport.publish(envelope('m-never-settles'))).rejects.toMatchObject({
      deliveryStatus: 'unknown',
    });
    await expect(transport.publish(envelope('m-not-attempted'))).rejects.toMatchObject({
      deliveryStatus: 'not-attempted',
    });
    expect(kafka.producer.send).toHaveBeenCalledOnce();
  });

  it('releases a pending publish caller when stopped even if send never settles', async () => {
    kafka.producer.send.mockImplementationOnce(() => new Promise<never>(() => {}));
    const transport = createKafkaTransport({
      clientId: 'stop-hung-publish', brokers: ['kafka:9092'], publishTimeoutMs: 10_000,
    });
    await transport.start();

    const publishing = transport.publish(envelope('m-stop'));
    await vi.waitFor(() => expect(kafka.producer.send).toHaveBeenCalledOnce());
    await transport.stop();

    await expect(publishing).rejects.toMatchObject({ code: 'KAFKA_TRANSPORT_STOPPED' });
    expect(kafka.producer.disconnect).toHaveBeenCalledOnce();
  });

  it('rejects reuse of an active messageId with different content', async () => {
    kafka.producer.send.mockImplementationOnce(() => new Promise<never>(() => {}));
    const transport = createKafkaTransport({
      clientId: 'message-identity', brokers: ['kafka:9092'], publishTimeoutMs: 20,
    });
    await transport.start();

    const first = expect(transport.publish(envelope('m-conflict'))).rejects.toMatchObject({
      code: 'KAFKA_PUBLISH_TIMEOUT',
    });
    await vi.waitFor(() => expect(kafka.producer.send).toHaveBeenCalledOnce());
    await expect(transport.publish(envelope('m-conflict', 'other-commands'))).rejects.toMatchObject({
      code: 'KAFKA_PUBLISH_IDENTITY_CONFLICT',
    });
    await first;
  });
});
