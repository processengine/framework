import { describe, expect, it } from 'vitest';
import type { PoolClient, QueryResult } from 'pg';
import {
  assertPostgresSchemaName,
  postgresMigrations,
  runPostgresMigrations,
  type PostgresConnectionProvider,
} from '../src/migrations.js';

describe('PostgreSQL migration plan', () => {
  it('renders a deterministic, constrained durable-storage schema', () => {
    const first = postgresMigrations('tenant_engine');
    const second = postgresMigrations('tenant_engine');

    expect(first).toEqual(second);
    expect(first.map((migration) => migration.version)).toEqual([1]);
    expect(first[0]?.checksum).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const sql = first.flatMap((migration) => migration.statements).join('\n');
    expect(sql).toContain('"tenant_engine".processes');
    expect(sql).toContain('"tenant_engine".operations');
    expect(sql).toContain('"tenant_engine".outbox');
    expect(sql).toContain('"tenant_engine".inbox');
    expect(sql).toContain('timeout_claim_version');
    expect(sql).toContain('claim_version');
    expect(sql).toContain('published_at');
    expect(sql).toContain('completion_source text NOT NULL');
    expect(sql).toContain("WHERE status = 'PUBLISHED' AND deadline_at IS NOT NULL");
    expect(sql).toContain("WHERE status IN ('PENDING','CLAIMED')");
  });

  it('rejects schema names instead of interpolating arbitrary SQL identifiers', () => {
    for (const invalid of ['', 'ProcessEngine', 'public;drop table x', 'a-b', '1engine']) {
      expect(() => assertPostgresSchemaName(invalid)).toThrow(TypeError);
    }
    expect(() => assertPostgresSchemaName('processengine_2')).not.toThrow();
  });

  it('takes a session advisory lock and records each migration transactionally', async () => {
    const client = new RecordingClient();
    await runPostgresMigrations(client.provider(), { schema: 'processengine' });

    expect(client.calls[0]?.text).toContain('pg_advisory_lock');
    expect(client.calls.some((call) => call.text.startsWith('INSERT INTO "processengine"."schema_migrations"'))).toBe(true);
    expect(client.calls.filter((call) => call.text === 'BEGIN')).toHaveLength(2);
    expect(client.calls.filter((call) => call.text === 'COMMIT')).toHaveLength(2);
    expect(client.calls.at(-1)?.text).toContain('pg_advisory_unlock');
    expect(client.released).toBe(true);
  });

  it('refuses a changed checksum for an already applied migration', async () => {
    const client = new RecordingClient([{
      version: 1,
      name: 'durable_process_storage',
      checksum: 'sha256:not-the-packaged-checksum',
    }]);

    await expect(runPostgresMigrations(client.provider())).rejects.toThrow(/does not match the packaged checksum/u);
    expect(client.calls.at(-1)?.text).toContain('pg_advisory_unlock');
    expect(client.released).toBe(true);
  });
});

interface AppliedRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

class RecordingClient {
  readonly calls: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
  released = false;

  constructor(private readonly applied: readonly AppliedRow[] = []) {}

  provider(): PostgresConnectionProvider {
    return { connect: async () => this as unknown as PoolClient };
  }

  async query(text: string, values?: readonly unknown[]): Promise<QueryResult<AppliedRow>> {
    this.calls.push({ text, values });
    const rows = text.includes('SELECT version,name,checksum') ? [...this.applied] : [];
    return {
      command: 'MOCK',
      rowCount: rows.length,
      oid: 0,
      fields: [],
      rows,
    };
  }

  release(): void {
    this.released = true;
  }
}
