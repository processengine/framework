import pg from 'pg';
import type {
  CommitOperationResult,
  CreateProcessResult,
  DurableDispatch,
  OutboxRecord,
  ProcessRecord,
  ProcessStorage,
  StoredOperation,
} from '@processengine/conductor';
import {
  assertPostgresSchemaName,
  inspectPostgresMigrations,
  postgresMigrations,
  runPostgresMigrations,
  type PostgresConnectionProvider,
} from './migrations.js';

const { Pool } = pg;

export interface PostgresStorageOptions {
  readonly connectionString?: string;
  readonly pool?: pg.Pool;
  readonly schema?: string;
  readonly maxConnections?: number;
  readonly applicationName?: string;
  readonly ssl?: pg.PoolConfig['ssl'];
  readonly migrationMode?: 'validate' | 'apply';
  /** Observes errors emitted by idle pooled clients. The adapter always installs a listener so outages do not terminate Node.js. */
  readonly onPoolError?: (error: Error) => void;
}

export interface PostgresStorageHealth {
  readonly ok: true;
  readonly schema: string;
  readonly currentMigration: number;
  readonly latestMigration: number;
}

export class PostgresStorage implements ProcessStorage {
  private readonly pool: pg.Pool;
  private readonly schema: string;
  private readonly ownsPool: boolean;
  private readonly migrationMode: 'validate' | 'apply';
  private readonly poolErrorHandler: (error: Error) => void;
  private initialized = false;
  private closed = false;

  constructor(options: PostgresStorageOptions) {
    if (options.pool && options.connectionString) {
      throw new TypeError('Provide either pool or connectionString, not both');
    }
    if (!options.pool && !options.connectionString) {
      throw new TypeError('PostgreSQL connectionString or pool is required');
    }
    this.schema = options.schema ?? 'processengine';
    assertPostgresSchemaName(this.schema);
    this.migrationMode = options.migrationMode ?? 'validate';
    this.ownsPool = options.pool === undefined;
    this.pool = options.pool ?? new Pool({
      connectionString: options.connectionString,
      max: options.maxConnections ?? 10,
      application_name: options.applicationName ?? 'processengine-storage',
      ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
    });
    this.poolErrorHandler = options.onPoolError ?? ((error) => {
      console.error('[processengine:postgres] idle pool client failed', error);
    });
    this.pool.on('error', this.poolErrorHandler);
  }

  connectionProvider(): PostgresConnectionProvider {
    return this.pool;
  }

  async initialize(): Promise<void> {
    this.assertOpen();
    if (this.initialized) return;
    if (this.migrationMode === 'apply') {
      await runPostgresMigrations(this.pool, { schema: this.schema });
    }
    const status = await inspectPostgresMigrations(this.pool, { schema: this.schema });
    if (status.pendingVersions.length > 0) {
      throw new Error(`PostgreSQL schema ${this.schema} has pending ProcessEngine migrations: ${status.pendingVersions.join(', ')}`);
    }
    this.initialized = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.ownsPool) await this.pool.end();
    this.pool.off('error', this.poolErrorHandler);
    this.closed = true;
    this.initialized = false;
  }

  async checkHealth(): Promise<PostgresStorageHealth> {
    this.assertOpen();
    await this.pool.query('SELECT 1 AS processengine_storage_health');
    const status = await inspectPostgresMigrations(this.pool, { schema: this.schema });
    if (status.pendingVersions.length > 0) {
      throw new Error(`PostgreSQL schema ${this.schema} is not current; pending migrations: ${status.pendingVersions.join(', ')}`);
    }
    return {
      ok: true,
      schema: this.schema,
      currentMigration: status.currentVersion,
      latestMigration: status.latestVersion,
    };
  }

  async createProcess(request: { readonly process: ProcessRecord; readonly dispatch?: DurableDispatch }): Promise<CreateProcessResult> {
    this.assertReady();
    validateProcessRecord(request.process);
    if (request.dispatch) validateDispatch(request.dispatch, request.process.state.instanceId);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<{ readonly instance_id: string }>(
        `INSERT INTO ${this.q('processes')}
          (instance_id,namespace,idempotency_key,fingerprint,revision,lifecycle,state,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
         ON CONFLICT DO NOTHING RETURNING instance_id`,
        [
          request.process.state.instanceId,
          request.process.namespace,
          request.process.idempotencyKey,
          request.process.fingerprint,
          request.process.state.revision,
          request.process.state.lifecycle,
          JSON.stringify(request.process.state),
          request.process.state.createdAt,
          request.process.state.updatedAt,
        ],
      );

      if (inserted.rowCount === 0) {
        const existing = await client.query<ProcessRow>(
          `SELECT namespace,idempotency_key,fingerprint,state
             FROM ${this.q('processes')}
            WHERE namespace=$1 AND idempotency_key=$2`,
          [request.process.namespace, request.process.idempotencyKey],
        );
        await client.query('ROLLBACK');
        const row = existing.rows[0];
        if (!row) return { kind: 'IDEMPOTENCY_CONFLICT', instanceId: request.process.state.instanceId };
        const process = processFromRow(row);
        return row.fingerprint === request.process.fingerprint
          ? { kind: 'EXISTING', process }
          : { kind: 'IDEMPOTENCY_CONFLICT', instanceId: process.state.instanceId };
      }

      if (request.dispatch) await this.insertDispatch(client, request.dispatch);
      await client.query('COMMIT');
      return { kind: 'CREATED', process: request.process };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async getProcess(instanceId: string): Promise<ProcessRecord | undefined> {
    this.assertReady();
    const result = await this.pool.query<ProcessRow>(
      `SELECT namespace,idempotency_key,fingerprint,state FROM ${this.q('processes')} WHERE instance_id=$1`,
      [instanceId],
    );
    const row = result.rows[0];
    return row ? processFromRow(row) : undefined;
  }

  async getOperation(requestId: string): Promise<StoredOperation | undefined> {
    this.assertReady();
    const result = await this.pool.query<OperationRow>(
      `SELECT * FROM ${this.q('operations')} WHERE request_id=$1`,
      [requestId],
    );
    const row = result.rows[0];
    return row ? operationFromRow(row) : undefined;
  }

  async commitOperation(request: {
    readonly instanceId: string;
    readonly expectedRevision: number;
    readonly requestId: string;
    readonly inboxMessageId?: string;
    readonly resolution: 'SUCCESS' | 'ERROR' | 'TIMED_OUT' | 'DISPATCH_FAILED';
    readonly resolvedAt: string;
    readonly nextState: ProcessRecord['state'];
    readonly nextDispatch?: DurableDispatch;
    readonly timeoutClaim?: { readonly workerId: string; readonly claimVersion: number };
    readonly dispatchClaim?: { readonly workerId: string; readonly messageId: string; readonly claimVersion: number };
  }): Promise<CommitOperationResult> {
    this.assertReady();
    validateNextState(request.instanceId, request.expectedRevision, request.nextState);
    if (request.nextDispatch) validateDispatch(request.nextDispatch, request.instanceId);
    validateResolutionClaim(request);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Global lock order: process -> operation -> outbox -> inbox.
      const processResult = await client.query<ProcessLockRow>(
        `SELECT namespace,idempotency_key,fingerprint,revision,state
           FROM ${this.q('processes')} WHERE instance_id=$1 FOR UPDATE`,
        [request.instanceId],
      );
      const operationResult = await client.query<OperationRow>(
        `SELECT * FROM ${this.q('operations')} WHERE request_id=$1 FOR UPDATE`,
        [request.requestId],
      );
      const processRow = processResult.rows[0];
      const operationRow = operationResult.rows[0];
      if (!processRow || !operationRow) return await rollbackResult(client, { kind: 'NOT_FOUND' });
      if (operationRow.instance_id !== request.instanceId) return await rollbackResult(client, { kind: 'NOT_FOUND' });

      const outboxResult = await client.query<OutboxRow>(
        `SELECT * FROM ${this.q('outbox')} WHERE request_id=$1 FOR UPDATE`,
        [request.requestId],
      );
      const outboxRow = outboxResult.rows[0];
      if (!outboxRow || outboxRow.instance_id !== request.instanceId) {
        return await rollbackResult(client, { kind: 'NOT_FOUND' });
      }

      if (request.inboxMessageId) {
        const duplicate = await client.query(
          `SELECT 1 FROM ${this.q('inbox')} WHERE message_id=$1`,
          [request.inboxMessageId],
        );
        if ((duplicate.rowCount ?? 0) > 0) return await rollbackResult(client, { kind: 'DUPLICATE' });
      }
      if (processRow.revision !== request.expectedRevision) return await rollbackResult(client, { kind: 'CONFLICT' });
      if (operationRow.status !== 'PENDING' && operationRow.status !== 'PUBLISHED') {
        return await rollbackResult(client, { kind: 'ALREADY_RESOLVED' });
      }
      if (!matchesTimeoutClaim(operationRow, request.timeoutClaim, request.resolvedAt)
        || !matchesDispatchClaim(outboxRow, request.dispatchClaim, request.resolvedAt)) {
        return await rollbackResult(client, { kind: 'STALE_CLAIM' });
      }

      if (request.inboxMessageId) {
        const inbox = await client.query(
          `INSERT INTO ${this.q('inbox')}(message_id,request_id,instance_id,received_at)
           VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING message_id`,
          [request.inboxMessageId, request.requestId, request.instanceId, request.resolvedAt],
        );
        if (inbox.rowCount === 0) return await rollbackResult(client, { kind: 'DUPLICATE' });
      }

      const processUpdate = await client.query(
        `UPDATE ${this.q('processes')}
            SET revision=$2,lifecycle=$3,state=$4::jsonb,updated_at=$5
          WHERE instance_id=$1 AND revision=$6`,
        [
          request.instanceId,
          request.nextState.revision,
          request.nextState.lifecycle,
          JSON.stringify(request.nextState),
          request.nextState.updatedAt,
          request.expectedRevision,
        ],
      );
      if (processUpdate.rowCount !== 1) return await rollbackResult(client, { kind: 'CONFLICT' });

      await client.query(
        `UPDATE ${this.q('operations')}
            SET status=$2,resolved_at=$3,timeout_claimed_by=NULL,timeout_lease_until=NULL
          WHERE request_id=$1`,
        [request.requestId, request.resolution, request.resolvedAt],
      );

      if (request.resolution === 'DISPATCH_FAILED') {
        await client.query(
          `UPDATE ${this.q('outbox')}
              SET status='DEAD',claimed_by=NULL,lease_until=NULL
            WHERE message_id=$1`,
          [outboxRow.message_id],
        );
      } else if (outboxRow.status !== 'PUBLISHED') {
        await client.query(
          `UPDATE ${this.q('outbox')}
              SET status='CANCELLED',claimed_by=NULL,lease_until=NULL
            WHERE message_id=$1`,
          [outboxRow.message_id],
        );
      }

      if (request.nextDispatch) await this.insertDispatch(client, request.nextDispatch);
      await client.query('COMMIT');
      return {
        kind: 'COMMITTED',
        process: {
          namespace: processRow.namespace,
          idempotencyKey: processRow.idempotency_key,
          fingerprint: processRow.fingerprint,
          state: request.nextState,
        },
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimOutbox(request: {
    readonly workerId: string;
    readonly now: string;
    readonly leaseMs: number;
    readonly limit: number;
  }): Promise<readonly OutboxRecord[]> {
    this.assertReady();
    validateClaimRequest(request);
    const leaseUntil = addMilliseconds(request.now, request.leaseMs);
    const result = await this.pool.query<OutboxRow>(
      `WITH candidates AS (
         SELECT message_id
           FROM ${this.q('outbox')}
          WHERE (
            (status='PENDING' AND available_at <= $1 AND attempt < max_attempts)
            OR (status='CLAIMED' AND lease_until <= $1)
          )
          ORDER BY available_at,message_id
          FOR UPDATE SKIP LOCKED
          LIMIT $2
       )
       UPDATE ${this.q('outbox')} o
          SET status='CLAIMED',
              attempt=LEAST(o.attempt+1,o.max_attempts),
              claimed_by=$3,
              lease_until=$4,
              claim_version=o.claim_version+1
         FROM candidates c
        WHERE o.message_id=c.message_id
      RETURNING o.*`,
      [request.now, request.limit, request.workerId, leaseUntil],
    );
    return result.rows.map(outboxFromRow);
  }

  async markOutboxPublished(request: {
    readonly messageId: string;
    readonly workerId: string;
    readonly claimVersion: number;
    readonly publishedAt: string;
  }): Promise<void> {
    this.assertReady();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Lock operation before outbox: the same order used by commitOperation().
      const operation = await client.query<{ readonly request_id: string }>(
        `SELECT op.request_id
           FROM ${this.q('operations')} op
           JOIN ${this.q('outbox')} ob ON ob.request_id=op.request_id
          WHERE ob.message_id=$1
          FOR UPDATE OF op`,
        [request.messageId],
      );
      if (!operation.rows[0]) {
        await client.query('ROLLBACK');
        return;
      }
      const outbox = await client.query<OutboxRow>(
        `SELECT * FROM ${this.q('outbox')} WHERE message_id=$1 FOR UPDATE`,
        [request.messageId],
      );
      const row = outbox.rows[0];
      if (!row || row.status !== 'CLAIMED' || row.claimed_by !== request.workerId
        || integer(row.claim_version) !== request.claimVersion || row.lease_until === null
        || iso(row.lease_until) < request.publishedAt) {
        await client.query('ROLLBACK');
        return;
      }
      await client.query(
        `UPDATE ${this.q('outbox')}
            SET status='PUBLISHED',published_at=$2,claimed_by=NULL,lease_until=NULL
          WHERE message_id=$1`,
        [request.messageId, request.publishedAt],
      );
      await client.query(
        `UPDATE ${this.q('operations')}
            SET status='PUBLISHED',
                deadline_at=$2::timestamptz
                  + ((policy->>'completionTimeoutMs')::bigint * interval '1 millisecond')
          WHERE request_id=$1 AND status='PENDING'`,
        [row.request_id, request.publishedAt],
      );
      await client.query('COMMIT');
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async rescheduleOutbox(request: {
    readonly messageId: string;
    readonly workerId: string;
    readonly claimVersion: number;
    readonly availableAt: string;
  }): Promise<void> {
    this.assertReady();
    await this.pool.query(
      `UPDATE ${this.q('outbox')}
          SET status='PENDING',available_at=$4,claimed_by=NULL,lease_until=NULL
        WHERE message_id=$1 AND status='CLAIMED' AND claimed_by=$2 AND claim_version=$3`,
      [request.messageId, request.workerId, request.claimVersion, request.availableAt],
    );
  }

  async claimExpiredOperations(request: {
    readonly workerId: string;
    readonly now: string;
    readonly leaseMs: number;
    readonly limit: number;
  }): Promise<readonly StoredOperation[]> {
    this.assertReady();
    validateClaimRequest(request);
    const leaseUntil = addMilliseconds(request.now, request.leaseMs);
    const result = await this.pool.query<OperationRow>(
      `WITH candidates AS (
         SELECT request_id
           FROM ${this.q('operations')}
          WHERE status = 'PUBLISHED'
            AND deadline_at IS NOT NULL
            AND deadline_at <= $1
            AND (timeout_lease_until IS NULL OR timeout_lease_until <= $1)
          ORDER BY deadline_at,request_id
          FOR UPDATE SKIP LOCKED
          LIMIT $2
       )
       UPDATE ${this.q('operations')} op
          SET timeout_claimed_by=$3,
              timeout_lease_until=$4,
              timeout_claim_version=op.timeout_claim_version+1
         FROM candidates c
        WHERE op.request_id=c.request_id
      RETURNING op.*`,
      [request.now, request.limit, request.workerId, leaseUntil],
    );
    return result.rows.map(operationFromRow);
  }

  private async insertDispatch(client: pg.PoolClient, dispatch: DurableDispatch): Promise<void> {
    const operation = dispatch.operation;
    const outbox = dispatch.outbox;
    await client.query(
      `INSERT INTO ${this.q('operations')}
        (request_id,instance_id,step_id,operation,destination,completion_source,status,policy,deadline_at,
         timeout_claim_version,created_at,resolved_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,0,$10,$11)`,
      [
        operation.requestId,
        operation.instanceId,
        operation.stepId,
        operation.operation,
        operation.destination,
        operation.completionSource,
        operation.status,
        JSON.stringify(operation.policy),
        operation.deadlineAt,
        operation.createdAt,
        operation.resolvedAt ?? null,
      ],
    );
    await client.query(
      `INSERT INTO ${this.q('outbox')}
        (message_id,request_id,instance_id,envelope,status,attempt,max_attempts,retry_delay_ms,
         available_at,claim_version)
       VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,0)`,
      [
        outbox.messageId,
        outbox.requestId,
        outbox.instanceId,
        JSON.stringify(outbox.envelope),
        outbox.status,
        outbox.attempt,
        outbox.maxAttempts,
        outbox.retryDelayMs,
        outbox.availableAt,
      ],
    );
  }

  private q(table: string): string {
    return `"${this.schema}"."${table}"`;
  }

  private assertReady(): void {
    this.assertOpen();
    if (!this.initialized) throw new Error('PostgreSQL storage is not initialized');
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('PostgreSQL storage is closed');
  }
}

interface ProcessRow {
  readonly namespace: string;
  readonly idempotency_key: string;
  readonly fingerprint: string;
  readonly state: ProcessRecord['state'];
}

interface ProcessLockRow extends ProcessRow {
  readonly revision: number;
}

interface OperationRow {
  readonly request_id: string;
  readonly instance_id: string;
  readonly step_id: string;
  readonly operation: string;
  readonly destination: string;
  readonly completion_source: string;
  readonly status: StoredOperation['status'];
  readonly policy: StoredOperation['policy'];
  readonly deadline_at: Date | string | null;
  readonly timeout_claimed_by: string | null;
  readonly timeout_lease_until: Date | string | null;
  readonly timeout_claim_version: number | string;
  readonly created_at: Date | string;
  readonly resolved_at: Date | string | null;
}

interface OutboxRow {
  readonly message_id: string;
  readonly request_id: string;
  readonly instance_id: string;
  readonly envelope: OutboxRecord['envelope'];
  readonly status: OutboxRecord['status'];
  readonly attempt: number;
  readonly max_attempts: number;
  readonly retry_delay_ms: number;
  readonly available_at: Date | string;
  readonly claimed_by: string | null;
  readonly lease_until: Date | string | null;
  readonly claim_version: number | string;
}

function processFromRow(row: ProcessRow): ProcessRecord {
  return {
    namespace: row.namespace,
    idempotencyKey: row.idempotency_key,
    fingerprint: row.fingerprint,
    state: row.state,
  };
}

function operationFromRow(row: OperationRow): StoredOperation {
  return {
    requestId: row.request_id,
    instanceId: row.instance_id,
    stepId: row.step_id,
    operation: row.operation,
    destination: row.destination,
    completionSource: row.completion_source,
    status: row.status,
    policy: row.policy,
    deadlineAt: row.deadline_at === null ? null : iso(row.deadline_at),
    createdAt: iso(row.created_at),
    ...(row.resolved_at ? { resolvedAt: iso(row.resolved_at) } : {}),
    timeoutClaimVersion: integer(row.timeout_claim_version),
    ...(row.timeout_claimed_by ? { timeoutClaimedBy: row.timeout_claimed_by } : {}),
    ...(row.timeout_lease_until ? { timeoutLeaseUntil: iso(row.timeout_lease_until) } : {}),
  };
}

function outboxFromRow(row: OutboxRow): OutboxRecord {
  return {
    messageId: row.message_id,
    requestId: row.request_id,
    instanceId: row.instance_id,
    envelope: row.envelope,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    retryDelayMs: row.retry_delay_ms,
    availableAt: iso(row.available_at),
    claimVersion: integer(row.claim_version),
    ...(row.claimed_by ? { claimedBy: row.claimed_by } : {}),
    ...(row.lease_until ? { leaseUntil: iso(row.lease_until) } : {}),
  };
}

function validateProcessRecord(process: ProcessRecord): void {
  if (!process.namespace || !process.idempotencyKey || !process.fingerprint || !process.state.instanceId) {
    throw new TypeError('Process record identity fields are required');
  }
}

function validateNextState(instanceId: string, expectedRevision: number, state: ProcessRecord['state']): void {
  if (state.instanceId !== instanceId) throw new TypeError('nextState belongs to another process instance');
  if (!Number.isSafeInteger(expectedRevision) || state.revision !== expectedRevision + 1) {
    throw new TypeError('nextState revision must equal expectedRevision + 1');
  }
}

function validateDispatch(dispatch: DurableDispatch, instanceId: string): void {
  if (dispatch.operation.instanceId !== instanceId || dispatch.outbox.instanceId !== instanceId
    || dispatch.operation.requestId !== dispatch.outbox.requestId) {
    throw new TypeError('Durable dispatch does not belong to the process instance');
  }
  if (!dispatch.operation.completionSource || dispatch.operation.status !== 'PENDING'
    || dispatch.operation.deadlineAt !== null || dispatch.operation.timeoutClaimVersion !== 0
    || dispatch.operation.timeoutClaimedBy !== undefined || dispatch.operation.timeoutLeaseUntil !== undefined
    || dispatch.operation.resolvedAt !== undefined || dispatch.outbox.status !== 'PENDING'
    || dispatch.outbox.attempt !== 0 || dispatch.outbox.claimVersion !== 0
    || dispatch.outbox.claimedBy !== undefined || dispatch.outbox.leaseUntil !== undefined) {
    throw new TypeError('New durable dispatch must start unclaimed in PENDING state with attempt 0');
  }
}

function validateResolutionClaim(request: {
  readonly resolution: 'SUCCESS' | 'ERROR' | 'TIMED_OUT' | 'DISPATCH_FAILED';
  readonly timeoutClaim?: { readonly workerId: string; readonly claimVersion: number };
  readonly dispatchClaim?: { readonly workerId: string; readonly messageId: string; readonly claimVersion: number };
}): void {
  if ((request.resolution === 'TIMED_OUT') !== (request.timeoutClaim !== undefined)) {
    throw new TypeError('TIMED_OUT resolution requires exactly one timeout claim');
  }
  if ((request.resolution === 'DISPATCH_FAILED') !== (request.dispatchClaim !== undefined)) {
    throw new TypeError('DISPATCH_FAILED resolution requires exactly one dispatch claim');
  }
}

function matchesTimeoutClaim(
  row: OperationRow,
  claim: { readonly workerId: string; readonly claimVersion: number } | undefined,
  resolvedAt: string,
): boolean {
  if (!claim) return true;
  return row.timeout_claimed_by === claim.workerId
    && integer(row.timeout_claim_version) === claim.claimVersion
    && row.timeout_lease_until !== null
    && iso(row.timeout_lease_until) >= resolvedAt;
}

function matchesDispatchClaim(
  row: OutboxRow,
  claim: { readonly workerId: string; readonly messageId: string; readonly claimVersion: number } | undefined,
  resolvedAt: string,
): boolean {
  if (!claim) return true;
  return row.message_id === claim.messageId
    && row.status === 'CLAIMED'
    && row.claimed_by === claim.workerId
    && integer(row.claim_version) === claim.claimVersion
    && row.lease_until !== null
    && iso(row.lease_until) >= resolvedAt;
}

function validateClaimRequest(request: { readonly workerId: string; readonly now: string; readonly leaseMs: number; readonly limit: number }): void {
  if (!request.workerId || !Number.isFinite(Date.parse(request.now))
    || !Number.isSafeInteger(request.leaseMs) || request.leaseMs <= 0
    || !Number.isSafeInteger(request.limit) || request.limit <= 0) {
    throw new TypeError('Invalid storage claim request');
  }
}

function addMilliseconds(isoTimestamp: string, milliseconds: number): string {
  return new Date(Date.parse(isoTimestamp) + milliseconds).toISOString();
}

function integer(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`PostgreSQL returned unsafe integer ${String(value)}`);
  return parsed;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function rollbackQuietly(client: pg.PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original storage failure.
  }
}

async function rollbackResult<T extends CommitOperationResult>(client: pg.PoolClient, result: T): Promise<T> {
  await client.query('ROLLBACK');
  return result;
}

export function createPostgresStorage(options: PostgresStorageOptions): PostgresStorage {
  return new PostgresStorage(options);
}

export function latestPostgresStorageMigration(): number {
  return postgresMigrations().at(-1)?.version ?? 0;
}
