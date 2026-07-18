import { createHash } from 'node:crypto';
import type { PoolClient, QueryResult } from 'pg';

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]*$/u;
const MIGRATION_LOCK_NAMESPACE = '@processengine/storage-postgres';

export interface PostgresMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly statements: readonly string[];
}

export interface PostgresMigrationStatus {
  readonly currentVersion: number;
  readonly latestVersion: number;
  readonly pendingVersions: readonly number[];
}

export interface PostgresMigrationOptions {
  readonly schema?: string;
}

export interface PostgresConnectionProvider {
  connect(): Promise<PoolClient>;
}

interface AppliedMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

const MIGRATION_TEMPLATES = [
  {
    version: 1,
    name: 'durable_process_storage',
    statements: [
      `CREATE TABLE {{schema}}.processes (
        instance_id text PRIMARY KEY,
        namespace text NOT NULL,
        idempotency_key text NOT NULL,
        fingerprint text NOT NULL,
        revision integer NOT NULL CHECK (revision >= 0),
        lifecycle text NOT NULL CHECK (lifecycle IN ('RUNNING','WAITING','COMPLETED','FAULTED')),
        state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CONSTRAINT processes_namespace_idempotency_key_unique UNIQUE (namespace, idempotency_key)
      )`,
      `CREATE INDEX processes_lifecycle_updated_idx
        ON {{schema}}.processes (lifecycle, updated_at, instance_id)`,
      `CREATE TABLE {{schema}}.operations (
        request_id text PRIMARY KEY,
        instance_id text NOT NULL REFERENCES {{schema}}.processes(instance_id),
        step_id text NOT NULL,
        operation text NOT NULL,
        destination text NOT NULL,
        completion_source text NOT NULL,
        status text NOT NULL CHECK (status IN ('PENDING','PUBLISHED','SUCCESS','ERROR','TIMED_OUT','DISPATCH_FAILED')),
        policy jsonb NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
        deadline_at timestamptz,
        timeout_claimed_by text,
        timeout_lease_until timestamptz,
        timeout_claim_version bigint NOT NULL DEFAULT 0 CHECK (timeout_claim_version >= 0),
        created_at timestamptz NOT NULL,
        resolved_at timestamptz,
        CONSTRAINT operations_timeout_lease_complete CHECK (
          (timeout_claimed_by IS NULL AND timeout_lease_until IS NULL)
          OR (timeout_claimed_by IS NOT NULL AND timeout_lease_until IS NOT NULL)
        ),
        CONSTRAINT operations_resolution_complete CHECK (
          (status = 'PENDING' AND resolved_at IS NULL AND deadline_at IS NULL)
          OR (status = 'PUBLISHED' AND resolved_at IS NULL AND deadline_at IS NOT NULL)
          OR (status IN ('SUCCESS','ERROR','TIMED_OUT','DISPATCH_FAILED') AND resolved_at IS NOT NULL)
        )
      )`,
      `CREATE INDEX operations_process_idx
        ON {{schema}}.operations (instance_id, request_id)`,
      `CREATE INDEX operations_timeout_due_idx
        ON {{schema}}.operations (deadline_at, timeout_lease_until, request_id)
        WHERE status = 'PUBLISHED' AND deadline_at IS NOT NULL`,
      `CREATE TABLE {{schema}}.outbox (
        message_id text PRIMARY KEY,
        request_id text NOT NULL UNIQUE REFERENCES {{schema}}.operations(request_id),
        instance_id text NOT NULL REFERENCES {{schema}}.processes(instance_id),
        envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
        status text NOT NULL CHECK (status IN ('PENDING','CLAIMED','PUBLISHED','DEAD','CANCELLED')),
        attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
        max_attempts integer NOT NULL CHECK (max_attempts > 0),
        retry_delay_ms integer NOT NULL CHECK (retry_delay_ms >= 0),
        available_at timestamptz NOT NULL,
        claimed_by text,
        lease_until timestamptz,
        claim_version bigint NOT NULL DEFAULT 0 CHECK (claim_version >= 0),
        published_at timestamptz,
        CONSTRAINT outbox_attempt_range CHECK (attempt <= max_attempts),
        CONSTRAINT outbox_claim_complete CHECK (
          (status = 'CLAIMED' AND claimed_by IS NOT NULL AND lease_until IS NOT NULL)
          OR (status <> 'CLAIMED' AND claimed_by IS NULL AND lease_until IS NULL)
        ),
        CONSTRAINT outbox_publication_complete CHECK (
          (status = 'PUBLISHED' AND published_at IS NOT NULL)
          OR (status <> 'PUBLISHED' AND published_at IS NULL)
        )
      )`,
      `CREATE INDEX outbox_due_idx
        ON {{schema}}.outbox (available_at, lease_until, message_id)
        WHERE status IN ('PENDING','CLAIMED')`,
      `CREATE INDEX outbox_process_idx
        ON {{schema}}.outbox (instance_id, message_id)`,
      `CREATE TABLE {{schema}}.inbox (
        message_id text PRIMARY KEY,
        request_id text NOT NULL REFERENCES {{schema}}.operations(request_id),
        instance_id text NOT NULL REFERENCES {{schema}}.processes(instance_id),
        received_at timestamptz NOT NULL
      )`,
      `CREATE INDEX inbox_received_idx
        ON {{schema}}.inbox (received_at, message_id)`,
    ],
  },
] as const;

export function assertPostgresSchemaName(schema: string): void {
  if (!SCHEMA_PATTERN.test(schema)) {
    throw new TypeError('PostgreSQL schema must match /^[a-z_][a-z0-9_]*$/');
  }
}

export function postgresMigrations(schema = 'processengine'): readonly PostgresMigration[] {
  assertPostgresSchemaName(schema);
  const quotedSchema = quoteIdentifier(schema);
  return MIGRATION_TEMPLATES.map((migration) => {
    const statements = migration.statements.map((statement) => statement.replaceAll('{{schema}}', quotedSchema));
    return Object.freeze({
      version: migration.version,
      name: migration.name,
      checksum: migrationChecksum(migration.version, migration.name, migration.statements),
      statements: Object.freeze(statements),
    });
  });
}

export async function inspectPostgresMigrations(
  provider: PostgresConnectionProvider,
  options: PostgresMigrationOptions = {},
): Promise<PostgresMigrationStatus> {
  const schema = options.schema ?? 'processengine';
  assertPostgresSchemaName(schema);
  const client = await provider.connect();
  try {
    const exists = await client.query<{ readonly relation: string | null }>(
      'SELECT to_regclass($1) AS relation',
      [`${schema}.schema_migrations`],
    );
    if (exists.rows[0]?.relation === null || exists.rows[0] === undefined) {
      const migrations = postgresMigrations(schema);
      return {
        currentVersion: 0,
        latestVersion: migrations.at(-1)?.version ?? 0,
        pendingVersions: migrations.map((migration) => migration.version),
      };
    }
    return await readMigrationStatus(client, schema);
  } finally {
    client.release();
  }
}

export async function runPostgresMigrations(
  provider: PostgresConnectionProvider,
  options: PostgresMigrationOptions = {},
): Promise<PostgresMigrationStatus> {
  const schema = options.schema ?? 'processengine';
  assertPostgresSchemaName(schema);
  const client = await provider.connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`${MIGRATION_LOCK_NAMESPACE}:${schema}`]);
    locked = true;
    await bootstrapMigrationTable(client, schema);

    const migrations = postgresMigrations(schema);
    const applied = await loadAppliedMigrations(client, schema);
    validateAppliedMigrations(applied, migrations);

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      await client.query('BEGIN');
      try {
        for (const statement of migration.statements) await client.query(statement);
        await client.query(
          `INSERT INTO ${qualified(schema, 'schema_migrations')} (version,name,checksum) VALUES ($1,$2,$3)`,
          [migration.version, migration.name, migration.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      }
    }

    return await readMigrationStatus(client, schema);
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`${MIGRATION_LOCK_NAMESPACE}:${schema}`]);
    }
    client.release();
  }
}

async function bootstrapMigrationTable(client: PoolClient, schema: string): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${qualified(schema, 'schema_migrations')} (
        version integer PRIMARY KEY CHECK (version > 0),
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )`,
    );
    await client.query('COMMIT');
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}

async function readMigrationStatus(client: PoolClient, schema: string): Promise<PostgresMigrationStatus> {
  const migrations = postgresMigrations(schema);
  const applied = await loadAppliedMigrations(client, schema);
  validateAppliedMigrations(applied, migrations);
  const versions = [...applied.keys()];
  return {
    currentVersion: versions.length === 0 ? 0 : Math.max(...versions),
    latestVersion: migrations.at(-1)?.version ?? 0,
    pendingVersions: migrations.filter((migration) => !applied.has(migration.version)).map((migration) => migration.version),
  };
}

async function loadAppliedMigrations(client: PoolClient, schema: string): Promise<Map<number, AppliedMigrationRow>> {
  const result: QueryResult<AppliedMigrationRow> = await client.query(
    `SELECT version,name,checksum FROM ${qualified(schema, 'schema_migrations')} ORDER BY version`,
  );
  return new Map(result.rows.map((row) => [row.version, row]));
}

function validateAppliedMigrations(
  applied: ReadonlyMap<number, AppliedMigrationRow>,
  migrations: readonly PostgresMigration[],
): void {
  const known = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const row of applied.values()) {
    const migration = known.get(row.version);
    if (!migration) throw new Error(`Database contains unknown ProcessEngine migration ${row.version}`);
    if (row.name !== migration.name || row.checksum !== migration.checksum) {
      throw new Error(`ProcessEngine migration ${row.version} does not match the packaged checksum`);
    }
  }
}

function migrationChecksum(version: number, name: string, statements: readonly string[]): string {
  const hash = createHash('sha256');
  hash.update(String(version));
  hash.update('\0');
  hash.update(name);
  for (const statement of statements) {
    hash.update('\0');
    hash.update(statement);
  }
  return `sha256:${hash.digest('hex')}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function qualified(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the migration error that caused the rollback.
  }
}
