// Composition root for the three public ProcessEngine packages. No app or
// domain module imports ProcessEngine directly; evolving connector APIs are
// intentionally isolated here.
import { readFile } from 'node:fs/promises';
import {
  Conductor,
  StaticArtifactRegistry,
  StaticOperationCatalog,
  type OperationBinding,
  type ProcessState,
  type StartProcessResult,
} from '@processengine/conductor';
import {
  createPostgresStorage,
  runPostgresMigrations,
  type PostgresStorage,
} from '@processengine/storage-postgres';
import { createKafkaTransport, type KafkaTransport } from '@processengine/transport-kafka';

export interface ShopConductorOptions {
  readonly source: string;
  readonly completionDestination: string;
  readonly completionConsumerGroup: string;
  readonly flowFiles: readonly string[];
  readonly operationsFile: string;
  readonly databaseUrl: string;
  readonly databaseSchema?: string;
  readonly kafkaClientId: string;
  readonly kafkaBrokers: readonly string[];
  readonly activeFlowVersion?: string;
  readonly onWorkerError?: (error: unknown) => void;
}

export interface ShopConductor {
  readonly conductor: Conductor;
  readonly storage: PostgresStorage;
  readonly transport: KafkaTransport;
  start(): Promise<void>;
  stop(): Promise<void>;
  startCheckout(request: {
    readonly idempotencyKey: string;
    readonly input: import('@processengine/conductor').JsonValue;
  }): Promise<StartProcessResult>;
  getCheckout(instanceId: string): Promise<ProcessState | undefined>;
}

export async function createShopConductor(options: ShopConductorOptions): Promise<ShopConductor> {
  if (options.flowFiles.length === 0) throw new TypeError('At least one explicit Flow3 artifact is required');
  const [flows, bindings] = await Promise.all([
    Promise.all(options.flowFiles.map(readJson)),
    readJson(options.operationsFile) as Promise<readonly OperationBinding[]>,
  ]);
  const operations = new StaticOperationCatalog(bindings);
  const artifacts = new StaticArtifactRegistry(flows, { operations });
  const storage = createPostgresStorage({
    connectionString: options.databaseUrl,
    schema: options.databaseSchema ?? 'processengine',
  });
  const transport = createKafkaTransport({
    clientId: options.kafkaClientId,
    brokers: options.kafkaBrokers,
    allowAutoTopicCreation: false,
    connectionTimeoutMs: 5_000,
    requestTimeoutMs: 10_000,
    retry: { retries: 2, initialRetryTime: 250, maxRetryTime: 1_000 },
    invalidMessage: { strategy: 'throw' },
    // Fast group-membership turnover so completion-consumer rebalances during a
    // rolling update finish in seconds (see service-kit for rationale).
    consumer: { sessionTimeout: 6_000, heartbeatInterval: 2_000, rebalanceTimeout: 12_000 },
  });
  const conductor = new Conductor({
    source: options.source,
    completionDestination: options.completionDestination,
    consumerGroup: options.completionConsumerGroup,
    artifacts,
    operations,
    storage,
    transport,
    worker: {
      pollIntervalMs: 500,
      // Must exceed the connector's bounded publish attempt so another host
      // cannot reclaim the same record while this one is still publishing.
      outboxLeaseMs: 60_000,
      onError: options.onWorkerError ?? ((error) => console.error('[shop-host] conductor worker error', error)),
    },
  });
  return {
    conductor,
    storage,
    transport,
    start: () => conductor.start(),
    stop: () => conductor.stop(),
    startCheckout: ({ idempotencyKey, input }) => conductor.startProcess({
      namespace: 'test-shop.checkout',
      idempotencyKey,
      instanceId: idempotencyKey,
      flow: { id: 'shop.checkout', version: options.activeFlowVersion ?? '1.0.0' },
      input,
    }),
    getCheckout: (instanceId) => conductor.getProcess(instanceId),
  };
}

export async function migrateConductorStorage(options: {
  readonly databaseUrl: string;
  readonly databaseSchema?: string;
}): Promise<void> {
  const storage = createPostgresStorage({
    connectionString: options.databaseUrl,
    schema: options.databaseSchema ?? 'processengine',
  });
  try {
    await runPostgresMigrations(storage.connectionProvider(), {
      schema: options.databaseSchema ?? 'processengine',
    });
  } finally {
    await storage.close();
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
