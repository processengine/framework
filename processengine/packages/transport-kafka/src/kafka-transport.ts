import {
  Kafka,
  logLevel,
  type Admin,
  type Consumer,
  type ConsumerConfig,
  type KafkaConfig,
  type Producer,
} from 'kafkajs';
import type { MessageEnvelope, MessageTransport } from '@processengine/conductor';
import { superviseKafkaHandler, type KafkaHandlerRetryContext } from './handler-supervisor.js';
import { validateKafkaRecord } from './record-validation.js';

export type InvalidMessageStrategy = 'throw' | 'skip' | 'dead-letter';

export interface InvalidKafkaMessage {
  readonly reason: string;
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
  readonly key: string | null;
  readonly value: string | null;
}

export interface KafkaTransportOptions {
  readonly clientId: string;
  readonly brokers: readonly string[];
  readonly ssl?: KafkaConfig['ssl'];
  readonly sasl?: KafkaConfig['sasl'];
  readonly connectionTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  // Hard upper bound on a single publish() call. KafkaJS producer.send() can
  // otherwise block far longer than connection/request timeouts when a broker is
  // unreachable (the connection is silently dropped rather than refused), which
  // stalls durable outbox draining. When exceeded, publish() rejects so the
  // Conductor reschedules the record. Must stay below the outbox lease.
  readonly publishTimeoutMs?: number;
  readonly retry?: KafkaConfig['retry'];
  readonly logLevel?: logLevel;
  readonly allowAutoTopicCreation?: boolean;
  readonly fromBeginning?: boolean;
  readonly consumer?: Omit<ConsumerConfig, 'groupId' | 'allowAutoTopicCreation'>;
  readonly handlerFailure?: {
    readonly retryDelayMs?: number;
    readonly heartbeatIntervalMs?: number;
    readonly onError?: (error: unknown, context: KafkaHandlerRetryContext) => void | Promise<void>;
  };
  readonly invalidMessage?: {
    readonly strategy?: InvalidMessageStrategy;
    readonly deadLetterTopic?: string;
    readonly onInvalid?: (message: InvalidKafkaMessage) => void | Promise<void>;
  };
}

export interface KafkaTopicDefinition {
  readonly topic: string;
  readonly numPartitions?: number;
  readonly replicationFactor?: number;
}

export class KafkaTransport implements MessageTransport {
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly admin: Admin;
  private readonly consumers = new Map<Consumer, { active: boolean }>();
  private lifecycleTail: Promise<void> = Promise.resolve();
  private started = false;
  private readonly publishTimeoutMs: number;

  constructor(private readonly options: KafkaTransportOptions) {
    if (options.clientId.trim().length === 0) throw new TypeError('Kafka clientId is required');
    if (options.publishTimeoutMs !== undefined
      && (!Number.isSafeInteger(options.publishTimeoutMs) || options.publishTimeoutMs <= 0)) {
      throw new TypeError('publishTimeoutMs must be a positive integer');
    }
    this.publishTimeoutMs = options.publishTimeoutMs ?? 15_000;
    if (options.brokers.length === 0 || options.brokers.some((broker) => broker.trim().length === 0)) {
      throw new TypeError('At least one Kafka broker is required');
    }
    if (options.invalidMessage?.strategy === 'dead-letter' && !options.invalidMessage.deadLetterTopic) {
      throw new TypeError('deadLetterTopic is required for dead-letter invalid-message strategy');
    }
    if (options.handlerFailure?.retryDelayMs !== undefined
      && (!Number.isSafeInteger(options.handlerFailure.retryDelayMs) || options.handlerFailure.retryDelayMs <= 0)) {
      throw new TypeError('handlerFailure.retryDelayMs must be a positive integer');
    }
    if (options.handlerFailure?.heartbeatIntervalMs !== undefined
      && (!Number.isSafeInteger(options.handlerFailure.heartbeatIntervalMs)
        || options.handlerFailure.heartbeatIntervalMs <= 0)) {
      throw new TypeError('handlerFailure.heartbeatIntervalMs must be a positive integer');
    }

    this.kafka = new Kafka({
      clientId: options.clientId,
      brokers: [...options.brokers],
      ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
      ...(options.sasl === undefined ? {} : { sasl: options.sasl }),
      connectionTimeout: options.connectionTimeoutMs ?? 5_000,
      requestTimeout: options.requestTimeoutMs ?? 10_000,
      retry: options.retry ?? { retries: 2, initialRetryTime: 250, maxRetryTime: 1_000 },
      logLevel: options.logLevel ?? logLevel.NOTHING,
    });
    this.producer = this.kafka.producer({
      allowAutoTopicCreation: options.allowAutoTopicCreation ?? false,
      idempotent: true,
      maxInFlightRequests: 1,
      // KafkaJS otherwise gives idempotent producers Number.MAX_SAFE_INTEGER
      // retries. ProcessEngine needs one publish() call to remain bounded by
      // the outbox lease; durable retries are owned by Conductor instead.
      retry: options.retry ?? { retries: 2, initialRetryTime: 250, maxRetryTime: 1_000 },
    });
    this.admin = this.kafka.admin();
  }

  start(): Promise<void> {
    return this.withLifecycle(async () => {
      if (this.started) return;
      await this.producer.connect();
      try {
        await this.admin.connect();
        this.started = true;
      } catch (error) {
        await this.producer.disconnect();
        throw error;
      }
    });
  }

  stop(): Promise<void> {
    return this.withLifecycle(async () => {
      const consumers = [...this.consumers.entries()];
      this.consumers.clear();
      for (const [, state] of consumers) state.active = false;
      await Promise.allSettled(consumers.map(async ([consumer]) => {
        await consumer.stop();
        await consumer.disconnect();
      }));
      if (this.started) {
        await Promise.allSettled([this.admin.disconnect(), this.producer.disconnect()]);
      }
      this.started = false;
    });
  }

  async publish(message: MessageEnvelope): Promise<void> {
    this.assertStarted();
    const send = this.producer.send({
      topic: message.destination,
      acks: -1,
      messages: [{
        key: message.partitionKey,
        value: JSON.stringify(message),
        headers: {
          'message-id': message.messageId,
          'message-type': message.type,
          'protocol-version': message.protocolVersion,
        },
      }],
    });
    // Bound the call so an unreachable broker rejects promptly instead of
    // blocking; a rejected publish is a durable retry owned by the Conductor.
    // The abandoned send is idempotent (stable messageId) and deduplicated
    // downstream if it later lands.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        send.then(() => undefined),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Kafka publish exceeded ${this.publishTimeoutMs}ms for ${message.messageId}`)),
            this.publishTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  subscribe(options: {
    readonly destination: string;
    readonly consumerGroup: string;
    readonly handler: (message: MessageEnvelope) => Promise<void>;
  }): Promise<() => Promise<void>> {
    return this.withLifecycle(async () => {
      this.assertStarted();
      if (!options.destination || !options.consumerGroup) throw new TypeError('Kafka destination and consumerGroup are required');

      const consumer = this.kafka.consumer({
        ...this.options.consumer,
        groupId: options.consumerGroup,
        allowAutoTopicCreation: this.options.allowAutoTopicCreation ?? false,
      });
      const state = { active: true };
      let connected = false;
      try {
        await consumer.connect();
        connected = true;
        await consumer.subscribe({
          topic: options.destination,
          fromBeginning: this.options.fromBeginning ?? false,
        });
        await consumer.run({
          autoCommit: true,
          eachMessage: async ({ topic, partition, message, heartbeat }) => superviseKafkaHandler({
            isActive: () => state.active,
            heartbeat,
            heartbeatIntervalMs: this.options.handlerFailure?.heartbeatIntervalMs ?? 3_000,
            retryDelayMs: this.options.handlerFailure?.retryDelayMs ?? 1_000,
            context: { topic, partition, offset: message.offset },
            onError: this.options.handlerFailure?.onError ?? ((error, context) => {
              console.error('[processengine:kafka] message handler failed; partition remains blocked for retry', {
                ...context,
                error: error instanceof Error ? error.message : String(error),
              });
            }),
            handle: async () => {
              const invalid = validateKafkaRecord({
                topic,
                partition,
                offset: message.offset,
                key: message.key,
                value: message.value,
                headers: message.headers,
              });
              if (invalid) {
                await this.handleInvalid(invalid);
                return;
              }
              const envelope = JSON.parse(message.value!.toString('utf8')) as MessageEnvelope;
              await options.handler(envelope);
            },
          }),
        });
        this.consumers.set(consumer, state);
      } catch (error) {
        state.active = false;
        if (connected) await consumer.disconnect().catch(() => undefined);
        throw error;
      }

      return async () => this.withLifecycle(async () => {
        const registered = this.consumers.get(consumer);
        if (!registered) return;
        registered.active = false;
        this.consumers.delete(consumer);
        await consumer.stop();
        await consumer.disconnect();
      });
    });
  }

  async checkHealth(): Promise<{ readonly ok: true; readonly controllerId: number }> {
    this.assertStarted();
    const cluster = await this.admin.describeCluster();
    if (cluster.controller === null) {
      throw new Error('Kafka cluster has no elected controller');
    }
    return { ok: true, controllerId: cluster.controller };
  }

  async ensureTopics(topics: readonly KafkaTopicDefinition[]): Promise<void> {
    this.assertStarted();
    if (topics.length === 0) return;
    await this.admin.createTopics({
      waitForLeaders: true,
      topics: topics.map((topic) => ({
        topic: topic.topic,
        numPartitions: topic.numPartitions ?? 3,
        replicationFactor: topic.replicationFactor ?? 1,
      })),
    });
  }

  private async handleInvalid(message: InvalidKafkaMessage): Promise<void> {
    await this.options.invalidMessage?.onInvalid?.(message);
    const strategy = this.options.invalidMessage?.strategy ?? 'throw';
    if (strategy === 'skip') return;
    if (strategy === 'throw') throw new InvalidKafkaMessageError(message);

    await this.producer.send({
      topic: this.options.invalidMessage!.deadLetterTopic!,
      acks: -1,
      messages: [{
        key: message.key,
        value: JSON.stringify({
          type: 'processengine.transport.invalid-message',
          occurredAt: new Date().toISOString(),
          ...message,
        }),
      }],
    });
  }

  private assertStarted(): void {
    if (!this.started) throw new Error('Kafka transport is not started');
  }

  private withLifecycle<T>(action: () => Promise<T>): Promise<T> {
    const execution = this.lifecycleTail.then(action, action);
    this.lifecycleTail = execution.then(() => undefined, () => undefined);
    return execution;
  }
}

export class InvalidKafkaMessageError extends Error {
  readonly code = 'KAFKA_MESSAGE_INVALID';

  constructor(readonly invalidMessage: InvalidKafkaMessage) {
    super(invalidMessage.reason);
    this.name = 'InvalidKafkaMessageError';
  }
}

export function createKafkaTransport(options: KafkaTransportOptions): KafkaTransport {
  return new KafkaTransport(options);
}

export function kafkaConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  prefix = 'KAFKA_',
): Pick<KafkaTransportOptions, 'clientId' | 'brokers'> {
  const brokers = env[`${prefix}BROKERS`]?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
  const clientId = env[`${prefix}CLIENT_ID`]?.trim() ?? '';
  if (!clientId || brokers.length === 0) throw new TypeError(`${prefix}CLIENT_ID and ${prefix}BROKERS are required`);
  return { clientId, brokers };
}
