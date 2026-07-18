import { createHash, randomUUID } from 'node:crypto';
import {
  assertOperationCommand,
  operationCompletionEnvelope,
  type MessageEnvelope,
  type OperationCompletionPayload,
} from './conductor-adapter.js';
import type { Pool, PoolClient } from 'pg';
import type {
  OperationHandler,
  OperationHandlerOutcome,
  OperationLedgerStats,
} from './types.js';

interface AcceptResult {
  readonly command: ReturnType<typeof assertOperationCommand>;
  readonly outcome: OperationHandlerOutcome;
  readonly created: boolean;
}

interface ClaimedMessage {
  readonly messageId: string;
  readonly envelope: MessageEnvelope;
  readonly owner: string;
  readonly claimVersion: number;
}

export class PostgresOperationLedger {
  private readonly schema: string;

  constructor(
    private readonly pool: Pool,
    schema: string,
    private readonly source: string,
  ) {
    this.schema = quoteIdentifier(schema);
  }

  async migrate(): Promise<void> {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.schema}.operation_ledger (
        request_id text PRIMARY KEY,
        operation text NOT NULL,
        process_id text NOT NULL,
        step_id text NOT NULL,
        payload_hash text NOT NULL,
        command jsonb NOT NULL,
        outcome jsonb,
        response_envelope jsonb,
        suppressed boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        completed_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS operation_ledger_process_idx
        ON ${this.schema}.operation_ledger (process_id, operation);
      CREATE TABLE IF NOT EXISTS ${this.schema}.operation_outbox (
        message_id text PRIMARY KEY,
        request_id text NOT NULL REFERENCES ${this.schema}.operation_ledger(request_id),
        envelope jsonb NOT NULL,
        available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        attempts integer NOT NULL DEFAULT 0,
        lease_owner text,
        lease_until timestamptz,
        claim_version bigint NOT NULL DEFAULT 0,
        published_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS operation_outbox_pending_idx
        ON ${this.schema}.operation_outbox (available_at)
        WHERE published_at IS NULL;
      ALTER TABLE ${this.schema}.operation_outbox
        ADD COLUMN IF NOT EXISTS claim_version bigint NOT NULL DEFAULT 0;
    `);
  }

  async accept(message: MessageEnvelope, handler: OperationHandler): Promise<AcceptResult> {
    const command = assertOperationCommand(message);
    const hash = digest({
      operation: command.operation,
      instanceId: command.instanceId,
      stepId: command.stepId,
      input: command.input,
    });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<{ request_id: string }>(`
        INSERT INTO ${this.schema}.operation_ledger
          (request_id, operation, process_id, step_id, payload_hash, command)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        ON CONFLICT (request_id) DO NOTHING
        RETURNING request_id
      `, [command.requestId, command.operation, command.instanceId, command.stepId, hash, JSON.stringify(message)]);

      const selected = await client.query<{
        payload_hash: string;
        outcome: OperationHandlerOutcome | null;
        suppressed: boolean;
      }>(`
        SELECT payload_hash, outcome, suppressed
        FROM ${this.schema}.operation_ledger
        WHERE request_id = $1
        FOR UPDATE
      `, [command.requestId]);
      const stored = selected.rows[0];
      if (stored === undefined) throw new Error(`Operation ledger row ${command.requestId} disappeared`);
      if (stored.payload_hash !== hash) {
        throw new Error(`IDEMPOTENCY_CONFLICT: requestId ${command.requestId} was reused with another payload`);
      }

      if (inserted.rowCount === 0) {
        if (stored.outcome === null) throw new Error(`Operation ${command.requestId} has no durable outcome`);
        if (!stored.suppressed) {
          await client.query(`
            UPDATE ${this.schema}.operation_outbox
            SET published_at = NULL, available_at = clock_timestamp(), lease_owner = NULL, lease_until = NULL
            WHERE request_id = $1
          `, [command.requestId]);
        }
        await client.query('COMMIT');
        return { command, outcome: stored.outcome, created: false };
      }

      let outcome: OperationHandlerOutcome;
      await client.query('SAVEPOINT operation_handler');
      try {
        outcome = await handler({ command, db: client });
        await client.query('RELEASE SAVEPOINT operation_handler');
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT operation_handler');
        await client.query('RELEASE SAVEPOINT operation_handler');
        outcome = {
          kind: 'error',
          error: {
            code: 'HANDLER_FAILED',
            message: 'The operation handler could not process the command',
            details: null,
          },
        };
      }
      const completedAt = new Date().toISOString();
      if (outcome.kind === 'no-response') {
        await client.query(`
          UPDATE ${this.schema}.operation_ledger
          SET outcome = $2::jsonb, suppressed = true, completed_at = $3::timestamptz
          WHERE request_id = $1
        `, [command.requestId, JSON.stringify(outcome), completedAt]);
      } else {
        const completion: OperationCompletionPayload = outcome.kind === 'result'
          ? { requestId: command.requestId, response: outcome.result }
          : { requestId: command.requestId, error: outcome.error };
        const envelope = operationCompletionEnvelope({
          source: this.source,
          destination: command.replyTo,
          occurredAt: completedAt,
          instanceId: command.instanceId,
          completion,
        });
        await this.persistResponse(client, command.requestId, outcome, envelope, completedAt);
      }
      await client.query('COMMIT');
      return { command, outcome, created: true };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claim(limit: number, leaseMs: number): Promise<readonly ClaimedMessage[]> {
    const owner = randomUUID();
    const result = await this.pool.query<{ message_id: string; envelope: MessageEnvelope; lease_owner: string; claim_version: string | number }>(`
      WITH candidates AS (
        SELECT message_id FROM ${this.schema}.operation_outbox
        WHERE published_at IS NULL AND available_at <= clock_timestamp()
          AND (lease_until IS NULL OR lease_until < clock_timestamp())
        ORDER BY available_at, message_id FOR UPDATE SKIP LOCKED LIMIT $1
      )
      UPDATE ${this.schema}.operation_outbox AS outbox
      SET lease_owner = $2,
          lease_until = clock_timestamp() + ($3 * interval '1 millisecond'),
          attempts = attempts + 1,
          claim_version = claim_version + 1
      FROM candidates
      WHERE outbox.message_id = candidates.message_id
      RETURNING outbox.message_id, outbox.envelope, outbox.lease_owner, outbox.claim_version
    `, [limit, owner, leaseMs]);
    return result.rows.map((row) => ({ messageId: row.message_id, envelope: row.envelope,
      owner: row.lease_owner, claimVersion: Number(row.claim_version) }));
  }

  async markPublished(messageId: string, owner: string, claimVersion: number): Promise<void> {
    await this.pool.query(`
      UPDATE ${this.schema}.operation_outbox
      SET published_at = clock_timestamp(), lease_owner = NULL, lease_until = NULL
      WHERE message_id = $1 AND lease_owner = $2 AND claim_version = $3
    `, [messageId, owner, claimVersion]);
  }

  async reschedule(messageId: string, owner: string, claimVersion: number, delayMs: number): Promise<void> {
    await this.pool.query(`
      UPDATE ${this.schema}.operation_outbox
      SET available_at = clock_timestamp() + ($4 * interval '1 millisecond'),
          lease_owner = NULL, lease_until = NULL
      WHERE message_id = $1 AND published_at IS NULL AND lease_owner = $2 AND claim_version = $3
    `, [messageId, owner, claimVersion, delayMs]);
  }

  async stats(processId: string): Promise<OperationLedgerStats> {
    const result = await this.pool.query<{
      request_id: string;
      operation: string;
      response_envelope: MessageEnvelope | null;
      published_at: string | null;
    }>(`
      SELECT ledger.request_id, ledger.operation, ledger.response_envelope, outbox.published_at
      FROM ${this.schema}.operation_ledger AS ledger
      LEFT JOIN ${this.schema}.operation_outbox AS outbox ON outbox.request_id = ledger.request_id
      WHERE ledger.process_id = $1
      ORDER BY ledger.created_at, ledger.request_id
    `, [processId]);
    const operations: Record<string, number> = {};
    let publishedResponses = 0;
    for (const row of result.rows) {
      operations[row.operation] = (operations[row.operation] ?? 0) + 1;
      if (row.published_at !== null) publishedResponses += 1;
    }
    return {
      processId,
      total: result.rowCount ?? result.rows.length,
      operations,
      requestIds: result.rows.map((row) => row.request_id),
      publishedResponses,
    };
  }

  async responseEnvelopes(processId: string): Promise<readonly MessageEnvelope[]> {
    const result = await this.pool.query<{ response_envelope: MessageEnvelope }>(`
      SELECT response_envelope
      FROM ${this.schema}.operation_ledger
      WHERE process_id = $1 AND response_envelope IS NOT NULL
      ORDER BY completed_at, request_id
    `, [processId]);
    return result.rows.map((row) => row.response_envelope);
  }

  async commandEnvelopes(processId: string): Promise<readonly MessageEnvelope[]> {
    const result = await this.pool.query<{ command: MessageEnvelope }>(`
      SELECT command FROM ${this.schema}.operation_ledger
      WHERE process_id = $1 ORDER BY created_at, request_id
    `, [processId]);
    return result.rows.map((row) => row.command);
  }

  private async persistResponse(
    client: PoolClient,
    requestId: string,
    outcome: OperationHandlerOutcome,
    envelope: MessageEnvelope,
    completedAt: string,
  ): Promise<void> {
    await client.query(`
      UPDATE ${this.schema}.operation_ledger
      SET outcome = $2::jsonb, response_envelope = $3::jsonb, completed_at = $4::timestamptz
      WHERE request_id = $1
    `, [requestId, JSON.stringify(outcome), JSON.stringify(envelope), completedAt]);
    await client.query(`
      INSERT INTO ${this.schema}.operation_outbox (message_id, request_id, envelope)
      VALUES ($1, $2, $3::jsonb) ON CONFLICT (message_id) DO NOTHING
    `, [envelope.messageId, requestId, JSON.stringify(envelope)]);
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new TypeError(`Invalid PostgreSQL schema: ${value}`);
  return `"${value}"`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}
