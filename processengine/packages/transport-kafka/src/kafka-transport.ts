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
  /**
   * Upper bound on one caller's wait for publish(). The default is 15 seconds.
   * A timeout after producer.send() begins has an unknown delivery result: the
   * send is not cancellable, remains the only local in-flight send, and a retry
   * with the same messageId joins or consumes its late result. Keep this below
   * the durable outbox lease.
   */
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

interface ActivePublish {
  readonly messageId: string;
  readonly serialized: string;
  readonly execution: Promise<void>;
  readonly generation: number;
  uncertain: boolean;
}

export type KafkaPublishDeliveryStatus = 'unknown' | 'not-attempted';

export class KafkaTransport implements MessageTransport {
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly admin: Admin;
  private readonly consumers = new Map<Consumer, { active: boolean }>();
  private lifecycleTail: Promise<void> = Promise.resolve();
  private started = false;
  private readonly publishTimeoutMs: number;
  private activePublish: ActivePublish | undefined;
  private readonly lateSuccesses = new Map<string, string>();
  private readonly publishWaiters = new Set<(error: Error) => void>();
  private publishGeneration = 0;

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
      const wasStarted = this.started;
      this.started = false;
      this.publishGeneration += 1;
      this.activePublish = undefined;
      this.lateSuccesses.clear();
      this.abortPublishWaiters(new KafkaTransportStoppedError());
      const consumers = [...this.consumers.entries()];
      this.consumers.clear();
      for (const [, state] of consumers) state.active = false;
      await Promise.allSettled(consumers.map(async ([consumer]) => {
        await consumer.stop();
        await consumer.disconnect();
      }));
      if (wasStarted) {
        await Promise.allSettled([this.admin.disconnect(), this.producer.disconnect()]);
      }
    });
  }

  async publish(message: MessageEnvelope): Promise<void> {
    this.assertStarted();
    const serialized = JSON.stringify(message);
    const deadline = Date.now() + this.publishTimeoutMs;

    while (true) {
      this.assertStarted();
      const lateSuccess = this.lateSuccesses.get(message.messageId);
      if (lateSuccess !== undefined) {
        this.assertSameMessage(message.messageId, lateSuccess, serialized);
        this.lateSuccesses.delete(message.messageId);
        return;
      }

      const active = this.activePublish;
      if (active === undefined) {
        const started = this.beginPublish(message, serialized);
        try {
          await this.waitUntil(started.execution, deadline, () => {
            started.uncertain = true;
            return new KafkaPublishTimeoutError(message.messageId, this.publishTimeoutMs, 'unknown');
          });
          this.lateSuccesses.delete(message.messageId);
          return;
        } catch (error) {
          if (error instanceof KafkaPublishTimeoutError) started.uncertain = true;
          throw error;
        }
      }

      if (active.messageId === message.messageId) {
        this.assertSameMessage(message.messageId, active.serialized, serialized);
        try {
          await this.waitUntil(active.execution, deadline, () => {
            active.uncertain = true;
            return new KafkaPublishTimeoutError(message.messageId, this.publishTimeoutMs, 'unknown');
          });
          this.lateSuccesses.delete(message.messageId);
          return;
        } catch (error) {
          if (error instanceof KafkaPublishTimeoutError) {
            active.uncertain = true;
            throw error;
          }
          if (this.activePublish !== active) continue;
          throw error;
        }
      }

      await this.waitUntil(
        active.execution.then(() => undefined, () => undefined),
        deadline,
        () => new KafkaPublishTimeoutError(message.messageId, this.publishTimeoutMs, 'not-attempted'),
      );
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

  private beginPublish(message: MessageEnvelope, serialized: string): ActivePublish {
    const generation = this.publishGeneration;
    const execution = Promise.resolve().then(() => this.producer.send({
      topic: message.destination,
      acks: -1,
      messages: [{
        key: message.partitionKey,
        value: serialized,
        headers: {
          'message-id': message.messageId,
          'message-type': message.type,
          'protocol-version': message.protocolVersion,
        },
      }],
    })).then(() => undefined);
    const active: ActivePublish = {
      messageId: message.messageId,
      serialized,
      execution,
      generation,
      uncertain: false,
    };
    this.activePublish = active;
    void execution.then(() => {
      if (active.uncertain && active.generation === this.publishGeneration && this.started) {
        this.rememberLateSuccess(active.messageId, active.serialized);
      }
      if (this.activePublish === active) this.activePublish = undefined;
    }, () => {
      if (this.activePublish === active) this.activePublish = undefined;
    });
    return active;
  }

  private waitUntil<T>(
    execution: Promise<T>,
    deadline: number,
    timeoutError: () => Error,
  ): Promise<T> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return Promise.reject(timeoutError());
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.publishWaiters.delete(abort);
        action();
      };
      const abort = (error: Error) => finish(() => reject(error));
      const timer = setTimeout(() => finish(() => reject(timeoutError())), remainingMs);
      this.publishWaiters.add(abort);
      void execution.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  private abortPublishWaiters(error: Error): void {
    for (const abort of [...this.publishWaiters]) abort(error);
  }

  private assertSameMessage(messageId: string, expected: string, actual: string): void {
    if (expected !== actual) throw new KafkaPublishIdentityConflictError(messageId);
  }

  private rememberLateSuccess(messageId: string, serialized: string): void {
    this.lateSuccesses.delete(messageId);
    this.lateSuccesses.set(messageId, serialized);
    if (this.lateSuccesses.size > 1_024) {
      const oldest = this.lateSuccesses.keys().next().value as string | undefined;
      if (oldest !== undefined) this.lateSuccesses.delete(oldest);
    }
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

export class KafkaPublishTimeoutError extends Error {
  readonly code = 'KAFKA_PUBLISH_TIMEOUT';

  constructor(
    readonly messageId: string,
    readonly timeoutMs: number,
    readonly deliveryStatus: KafkaPublishDeliveryStatus,
  ) {
    super(`Kafka publish exceeded ${timeoutMs}ms for ${messageId}; delivery is ${deliveryStatus}`);
    this.name = 'KafkaPublishTimeoutError';
  }
}

export class KafkaPublishIdentityConflictError extends Error {
  readonly code = 'KAFKA_PUBLISH_IDENTITY_CONFLICT';

  constructor(readonly messageId: string) {
    super(`Kafka messageId ${messageId} was reused with different content`);
    this.name = 'KafkaPublishIdentityConflictError';
  }
}

export class KafkaTransportStoppedError extends Error {
  readonly code = 'KAFKA_TRANSPORT_STOPPED';

  constructor() {
    super('Kafka transport stopped while publish was pending');
    this.name = 'KafkaTransportStoppedError';
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
