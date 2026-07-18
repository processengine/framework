import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { OutboxRecord, ProcessRecord, StoredOperation } from '@processengine/conductor';
import { postgresMigrations } from '../src/migrations.js';
import { createPostgresStorage } from '../src/storage.js';

const NOW = '2026-01-01T00:00:00.000Z';

describe('PostgresStorage SQL contract', () => {
  it('claims outbox and timeout work with SKIP LOCKED leases and fencing versions', async () => {
    const fake = new FakePool();
    const storage = await initializedStorage(fake);

    const outbox = await storage.claimOutbox({ workerId: 'host-a', now: NOW, leaseMs: 10_000, limit: 20 });
    const timeouts = await storage.claimExpiredOperations({ workerId: 'host-b', now: NOW, leaseMs: 10_000, limit: 20 });

    expect(outbox[0]).toMatchObject({ messageId: 'instance-1:1:command', attempt: 1, claimVersion: 7, claimedBy: 'host-a' });
    expect(timeouts[0]).toMatchObject({ requestId: 'instance-1:1', timeoutClaimVersion: 4, timeoutClaimedBy: 'host-b' });

    const outboxClaim = fake.calls.find((call) => call.text.includes('attempt=LEAST(o.attempt+1,o.max_attempts)'))?.text ?? '';
    expect(outboxClaim).toContain('FOR UPDATE SKIP LOCKED');
    expect(outboxClaim).toContain('claim_version=o.claim_version+1');
    expect(outboxClaim).toContain('attempt=LEAST(o.attempt+1,o.max_attempts)');

    const timeoutClaim = fake.calls.find((call) => call.text.includes('timeout_claim_version=op.timeout_claim_version+1'))?.text ?? '';
    expect(timeoutClaim).toContain('FOR UPDATE SKIP LOCKED');
    expect(timeoutClaim).toContain('timeout_lease_until <= $1');
    expect(timeoutClaim).toContain("status = 'PUBLISHED'");
  });

  it('uses operation-before-outbox lock order while marking publication', async () => {
    const fake = new FakePool();
    const storage = await initializedStorage(fake);
    fake.calls.length = 0;

    await storage.markOutboxPublished({
      messageId: 'instance-1:1:command',
      workerId: 'host-a',
      claimVersion: 6,
      publishedAt: NOW,
    });

    const operationLock = fake.calls.findIndex((call) => call.text.includes('FOR UPDATE OF op'));
    const outboxLock = fake.calls.findIndex((call) => call.text.includes('SELECT * FROM "processengine"."outbox"')
      && call.text.includes('FOR UPDATE'));
    expect(operationLock).toBeGreaterThan(-1);
    expect(outboxLock).toBeGreaterThan(operationLock);
    expect(fake.calls.some((call) => call.text.includes("status='PUBLISHED',published_at=$2"))).toBe(true);
    expect(fake.calls.some((call) => call.text.includes("policy->>'completionTimeoutMs'"))).toBe(true);
  });

  it('commits a PENDING operation and cancels its outbox in the publish-before-mark response race', async () => {
    const fake = new FakePool();
    const storage = await initializedStorage(fake);
    fake.calls.length = 0;
    const nextState = { ...processRecord().state, revision: 2, updatedAt: '2026-01-01T00:00:01.000Z' };

    const result = await storage.commitOperation({
      instanceId: 'instance-1',
      expectedRevision: 1,
      requestId: 'instance-1:1',
      inboxMessageId: 'completion-1',
      resolution: 'SUCCESS',
      resolvedAt: nextState.updatedAt,
      nextState,
    });

    expect(result.kind).toBe('COMMITTED');
    const processLock = fake.calls.findIndex((call) => call.text.includes('FROM "processengine"."processes"') && call.text.includes('FOR UPDATE'));
    const operationLock = fake.calls.findIndex((call) => call.text.includes('FROM "processengine"."operations"') && call.text.includes('FOR UPDATE'));
    const outboxLock = fake.calls.findIndex((call) => call.text.includes('FROM "processengine"."outbox"') && call.text.includes('FOR UPDATE'));
    const inboxInsert = fake.calls.findIndex((call) => call.text.includes('INSERT INTO "processengine"."inbox"'));
    expect(processLock).toBeGreaterThan(-1);
    expect(operationLock).toBeGreaterThan(processLock);
    expect(outboxLock).toBeGreaterThan(operationLock);
    expect(inboxInsert).toBeGreaterThan(outboxLock);
    expect(fake.calls.some((call) => call.text.includes("SET status='CANCELLED'"))).toBe(true);
  });

  it('rejects a stale timeout fence without changing process state', async () => {
    const fake = new FakePool();
    fake.operation = { ...fake.operation, timeout_claimed_by: 'host-b', timeout_claim_version: '4' };
    const storage = await initializedStorage(fake);
    fake.calls.length = 0;
    const nextState = { ...processRecord().state, revision: 2, updatedAt: '2026-01-01T00:00:01.000Z' };

    const result = await storage.commitOperation({
      instanceId: 'instance-1',
      expectedRevision: 1,
      requestId: 'instance-1:1',
      resolution: 'TIMED_OUT',
      resolvedAt: nextState.updatedAt,
      nextState,
      timeoutClaim: { workerId: 'host-a', claimVersion: 3 },
    });

    expect(result).toEqual({ kind: 'STALE_CLAIM' });
    expect(fake.calls.some((call) => call.text.startsWith('UPDATE "processengine"."processes"'))).toBe(false);
    expect(fake.calls.at(-1)?.text).toBe('ROLLBACK');
  });
});

async function initializedStorage(fake: FakePool) {
  const storage = createPostgresStorage({ pool: fake as unknown as pg.Pool });
  await storage.initialize();
  return storage;
}

function processRecord(): ProcessRecord {
  return {
    namespace: 'test',
    idempotencyKey: 'checkout-1',
    fingerprint: 'sha256:test',
    state: {
      instanceId: 'instance-1',
      flow: { id: 'shop.checkout', version: '1.0.0', digest: 'sha256:flow' },
      lifecycle: 'WAITING',
      revision: 1,
      currentStep: 'reserve-stock',
      input: { checkoutId: 'checkout-1' },
      results: {},
      pending: { executionId: 'instance-1:1', requestId: 'instance-1:1', stepId: 'reserve-stock', operation: 'warehouse.reserve' },
      outcome: null,
      response: null,
      error: null,
      fault: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

class FakePool {
  readonly calls: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
  readonly process = processRecord();
  operation = operationRow();
  readonly outbox = outboxRow();

  async connect(): Promise<FakeClient> {
    return new FakeClient(this);
  }

  async query(text: string, values?: readonly unknown[]): Promise<QueryResultLike> {
    return this.execute(text, values);
  }

  async end(): Promise<void> {}

  execute(text: string, values?: readonly unknown[]): QueryResultLike {
    this.calls.push({ text, values });
    const normalized = text.replace(/\s+/gu, ' ').trim();
    if (normalized.startsWith('SELECT to_regclass')) return result([{ relation: 'processengine.schema_migrations' }]);
    if (normalized.includes('SELECT version,name,checksum')) {
      const migration = postgresMigrations()[0]!;
      return result([{ version: migration.version, name: migration.name, checksum: migration.checksum }]);
    }
    if (normalized.includes('attempt=LEAST(o.attempt+1,o.max_attempts)') && normalized.includes('UPDATE "processengine"."outbox"')) {
      return result([{ ...this.outbox, status: 'CLAIMED', attempt: 1, claim_version: '7', claimed_by: 'host-a' }]);
    }
    if (normalized.includes('timeout_claim_version=op.timeout_claim_version+1')) {
      return result([{
        ...this.operation,
        status: 'PUBLISHED',
        deadline_at: '2026-01-01T00:00:00.000Z',
        timeout_claim_version: '4',
        timeout_claimed_by: 'host-b',
      }]);
    }
    if (normalized.includes('SELECT op.request_id') && normalized.includes('FOR UPDATE OF op')) {
      return result([{ request_id: this.operation.request_id }]);
    }
    if (normalized.includes('SELECT * FROM "processengine"."operations"') && normalized.includes('FOR UPDATE')) {
      return result([this.operation]);
    }
    if (normalized.includes('SELECT * FROM "processengine"."outbox"') && normalized.includes('FOR UPDATE')) {
      return result([this.outbox]);
    }
    if (normalized.includes('FROM "processengine"."processes"') && normalized.includes('FOR UPDATE')) {
      return result([{
        namespace: this.process.namespace,
        idempotency_key: this.process.idempotencyKey,
        fingerprint: this.process.fingerprint,
        revision: this.process.state.revision,
        state: this.process.state,
      }]);
    }
    if (normalized.startsWith('SELECT 1 FROM "processengine"."inbox"')) return result([]);
    if (normalized.startsWith('INSERT INTO "processengine"."inbox"')) return result([{ message_id: 'completion-1' }]);
    if (normalized.startsWith('UPDATE')) return affected(1);
    return affected(0);
  }
}

class FakeClient {
  constructor(private readonly pool: FakePool) {}
  async query(text: string, values?: readonly unknown[]): Promise<QueryResultLike> {
    return this.pool.execute(text, values);
  }
  release(): void {}
}

function operationRow() {
  return {
    request_id: 'instance-1:1',
    instance_id: 'instance-1',
    step_id: 'reserve-stock',
    operation: 'warehouse.reserve',
    destination: 'warehouse.operations',
    completion_source: 'warehouse-service',
    status: 'PENDING' as StoredOperation['status'],
    policy: { id: 'normal', version: '1', completionTimeoutMs: 30_000, dispatch: { maxAttempts: 3, retryDelayMs: 100 } },
    deadline_at: null as string | null,
    timeout_claimed_by: null as string | null,
    timeout_lease_until: '2026-01-01T00:01:00.000Z' as string | null,
    timeout_claim_version: '3',
    created_at: NOW,
    resolved_at: null as string | null,
  };
}

function outboxRow() {
  const envelope: OutboxRecord['envelope'] = {
    messageId: 'instance-1:1:command',
    type: 'processengine.operation.command',
    protocolVersion: '1',
    source: 'checkout',
    destination: 'warehouse.operations',
    partitionKey: 'instance-1',
    occurredAt: NOW,
    payload: { requestId: 'instance-1:1' },
  };
  return {
    message_id: envelope.messageId,
    request_id: 'instance-1:1',
    instance_id: 'instance-1',
    envelope,
    status: 'CLAIMED' as OutboxRecord['status'],
    attempt: 1,
    max_attempts: 3,
    retry_delay_ms: 100,
    available_at: NOW,
    claimed_by: 'host-a' as string | null,
    lease_until: '2026-01-01T00:01:00.000Z' as string | null,
    claim_version: '6',
  };
}

interface QueryResultLike {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number;
}

function result(rows: readonly Record<string, unknown>[]): QueryResultLike {
  return { rows, rowCount: rows.length };
}

function affected(rowCount: number): QueryResultLike {
  return { rows: [], rowCount };
}
