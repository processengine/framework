export interface WarehouseConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly brokers: readonly string[];
  readonly clientId: string;
  readonly consumerGroup: string;
  readonly commandTopic: string;
  readonly debugApi: boolean;
  readonly demoFaults: boolean;
  readonly outboxPollMs: number;
  readonly startupTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WarehouseConfig {
  return {
    port: integer(env.PORT ?? '8081', 'PORT'),
    databaseUrl: required(env.DATABASE_URL, 'DATABASE_URL'),
    brokers: required(env.KAFKA_BROKERS, 'KAFKA_BROKERS').split(',').map((item) => item.trim()).filter(Boolean),
    clientId: env.KAFKA_CLIENT_ID ?? 'test-shop-shop-warehouse',
    consumerGroup: env.KAFKA_CONSUMER_GROUP ?? 'test-shop-shop-warehouse-v1',
    commandTopic: env.COMMAND_TOPIC ?? 'shop.warehouse.commands.v1',
    debugApi: env.DEBUG_API_ENABLED === 'true',
    demoFaults: env.DEMO_FAULTS_ENABLED === 'true',
    outboxPollMs: integer(env.OUTBOX_POLL_MS ?? '200', 'OUTBOX_POLL_MS'),
    startupTimeoutMs: integer(env.STARTUP_TIMEOUT_MS ?? '120000', 'STARTUP_TIMEOUT_MS'),
  };
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

function integer(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}

