export interface ShopHostConfig {
  readonly port: number;
  readonly host: string;
  readonly databaseUrl: string;
  readonly databaseSchema: string;
  readonly kafkaBrokers: readonly string[];
  readonly kafkaClientId: string;
  readonly completionConsumerGroup: string;
  readonly completionTopic: string;
  readonly flowFiles: readonly string[];
  readonly operationsFile: string;
  readonly debugApi: boolean;
  readonly startupTimeoutMs: number;
  readonly activeFlowVersion: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ShopHostConfig {
  return {
    port: integer(env.PORT ?? '3000', 'PORT'),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: required(env.DATABASE_URL, 'DATABASE_URL'),
    databaseSchema: env.PROCESSENGINE_SCHEMA ?? 'processengine',
    kafkaBrokers: required(env.KAFKA_BROKERS, 'KAFKA_BROKERS').split(',').map((item) => item.trim()).filter(Boolean),
    kafkaClientId: env.KAFKA_CLIENT_ID ?? `test-shop-shop-host-${process.pid}`,
    completionConsumerGroup: env.KAFKA_CONSUMER_GROUP ?? 'test-shop-shop-host-v1',
    completionTopic: env.COMPLETION_TOPIC ?? 'shop.operation.completions.v1',
    flowFiles: (env.FLOW_FILES ?? 'flows/shop.checkout.v1.json,flows/shop.checkout.v2.json')
      .split(',').map((item) => item.trim()).filter(Boolean),
    operationsFile: env.OPERATIONS_FILE ?? 'config/operations.json',
    debugApi: env.DEBUG_API_ENABLED === 'true',
    startupTimeoutMs: integer(env.STARTUP_TIMEOUT_MS ?? '120000', 'STARTUP_TIMEOUT_MS'),
    activeFlowVersion: env.FLOW_ACTIVE_VERSION ?? '1.0.0',
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
