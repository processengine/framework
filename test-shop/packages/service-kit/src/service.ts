import {
  assertOperationCommand,
  createKafkaTransport,
  operationCompletionEnvelope,
  type KafkaTransport,
  type MessageEnvelope,
} from './conductor-adapter.js';
import { Pool } from 'pg';
import { PostgresOperationLedger } from './postgres-ledger.js';
import {
  failure,
  type OperationHandler,
  type OperationLedgerStats,
  type OperationServiceOptions,
} from './types.js';
import { randomUUID } from 'node:crypto';

export class PostgresKafkaOperationService {
  readonly pool: Pool;
  private readonly transport: KafkaTransport;
  private readonly ledger: PostgresOperationLedger;
  private unsubscribe: (() => Promise<void>) | undefined;
  private relayTimer: NodeJS.Timeout | undefined;
  private relayActive = false;
  private started = false;
  private readonly serviceInstanceId = `${globalThis.process.env.HOSTNAME ?? 'local'}:${randomUUID()}`;

  constructor(private readonly options: OperationServiceOptions) {
    this.pool = new Pool({ connectionString: options.databaseUrl });
    this.transport = createKafkaTransport({
      brokers: options.kafka.brokers,
      clientId: options.kafka.clientId,
      connectionTimeoutMs: 5_000,
      requestTimeoutMs: 10_000,
      retry: { retries: 2, initialRetryTime: 250, maxRetryTime: 1_000 },
      // Short session/heartbeat so the group coordinator evicts a killed member
      // quickly and consumer-group rebalances during a rolling update complete in
      // seconds instead of stacking to minutes (6000 is the broker's minimum
      // group.min.session.timeout.ms).
      consumer: { sessionTimeout: 6_000, heartbeatInterval: 2_000, rebalanceTimeout: 12_000 },
    });
    this.ledger = new PostgresOperationLedger(this.pool, options.databaseSchema, options.source);
  }

  get ready(): boolean { return this.started; }

  async migrate(): Promise<void> {
    await this.pool.query('SELECT 1');
    await this.ledger.migrate();
    await this.options.migrateDomain?.(this.pool);
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.migrate();
    await this.transport.start();
    this.unsubscribe = await this.transport.subscribe({
      destination: this.options.kafka.commandTopic,
      consumerGroup: this.options.kafka.consumerGroup,
      handler: async (raw) => this.consume(raw),
    });
    this.started = true;
    this.scheduleRelay(0);
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.relayTimer !== undefined) clearTimeout(this.relayTimer);
    this.relayTimer = undefined;
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    if (unsubscribe !== undefined) await unsubscribe();
    while (this.relayActive) await new Promise((resolve) => setTimeout(resolve, 10));
    await this.transport.stop();
    await this.pool.end();
  }

  stats(processId: string): Promise<OperationLedgerStats> {
    return this.ledger.stats(processId);
  }

  async replayResponses(processId: string): Promise<number> {
    const responses = await this.ledger.responseEnvelopes(processId);
    for (const response of responses) await this.transport.publish(response);
    return responses.length;
  }

  async replayCommands(processId: string): Promise<number> {
    const commands = await this.ledger.commandEnvelopes(processId);
    for (const command of commands) await this.transport.publish(command);
    return commands.length;
  }

  async injectCompletion(
    processId: string,
    mode: 'new-message-id' | 'conflict' | 'foreign-source' | 'foreign-request-id' | 'malformed' | 'late-success',
  ): Promise<string> {
    const responses = await this.ledger.responseEnvelopes(processId);
    const original = responses[0];
    if (!original && mode === 'late-success') {
      const commands = await this.ledger.commandEnvelopes(processId);
      const commandEnvelope = commands[0];
      if (!commandEnvelope) throw new Error(`No command is stored for ${processId}`);
      const command = assertOperationCommand(commandEnvelope);
      const input = command.input as Record<string, unknown>;
      const envelope = operationCompletionEnvelope({
        source: this.options.source,
        destination: command.replyTo,
        occurredAt: new Date().toISOString(),
        instanceId: command.instanceId,
        completion: {
          requestId: command.requestId,
          response: {
            ...input,
            resultCode: 'AUTHORIZED',
            authorizationId: `late-${processId}`,
          },
        },
      });
      await this.transport.publish(envelope);
      return envelope.messageId;
    }
    if (!original) throw new Error(`No completion is stored for ${processId}`);
    const envelope = structuredClone(original) as unknown as {
      messageId: string;
      source: string;
      payload: Record<string, unknown>;
    };
    Object.assign(envelope, { messageId: `${original.messageId}:${mode}:${randomUUID()}` });
    if (mode === 'foreign-source') envelope.source = 'test-shop.foreign-service';
    else if (mode === 'foreign-request-id') envelope.payload.requestId = `${processId}:foreign-operation`;
    else if (mode === 'malformed') envelope.payload = { malformed: true };
    else if (mode === 'conflict') {
      envelope.payload = {
        requestId: envelope.payload.requestId,
        error: { code: 'CONFLICTING_SECOND_COMPLETION', message: 'Injected conflicting completion', details: null },
      };
    }
    await this.transport.publish(envelope as unknown as MessageEnvelope);
    return envelope.messageId;
  }

  private async consume(message: MessageEnvelope): Promise<void> {
    let command: ReturnType<typeof assertOperationCommand>;
    try { command = assertOperationCommand(message); }
    catch { return; }
    await this.options.beforeAccept?.({ command, serviceInstanceId: this.serviceInstanceId, pool: this.pool });
    const handler: OperationHandler = this.options.handlers[command.operation] ?? (async () => failure({
      code: 'UNKNOWN_OPERATION',
      message: `Service ${this.options.serviceName} does not handle ${command.operation}`,
      details: null,
    }));
    const accepted = await this.ledger.accept(message, handler);
    await this.options.afterCommit?.(accepted);
  }

  private scheduleRelay(delayMs: number): void {
    if (!this.started) return;
    this.relayTimer = setTimeout(() => void this.relay(), delayMs);
  }

  private async relay(): Promise<void> {
    if (!this.started || this.relayActive) return;
    this.relayActive = true;
    try {
      // The lease is deliberately longer than the bounded Kafka publish
      // attempt configured above, preventing concurrent reclaim while a
      // healthy owner is still waiting for the broker.
      const messages = await this.ledger.claim(20, 60_000);
      for (const message of messages) {
        try {
          await this.transport.publish(message.envelope);
          await this.ledger.markPublished(message.messageId, message.owner, message.claimVersion);
        } catch {
          await this.ledger.reschedule(message.messageId, message.owner, message.claimVersion, 1_000);
        }
      }
    } catch (error) {
      console.error(`[${this.options.serviceName}] outbox relay failed`, error);
    } finally {
      this.relayActive = false;
      this.scheduleRelay(this.options.outboxPollMs ?? 250);
    }
  }
}

export function createOperationService(options: OperationServiceOptions): PostgresKafkaOperationService {
  return new PostgresKafkaOperationService(options);
}
