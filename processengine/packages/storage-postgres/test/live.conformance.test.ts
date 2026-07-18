import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProcessStorageConformance } from '@processengine/conductor/testing';
import type { DurableDispatch, ProcessRecord } from '@processengine/conductor';
import { runPostgresMigrations } from '../src/migrations.js';
import { createPostgresStorage, type PostgresStorage } from '../src/storage.js';

const { Pool } = pg;
const connectionString = process.env.PROCESSENGINE_POSTGRES_URL;
const live = connectionString !== undefined && connectionString.length > 0;

describe.skipIf(!live)('PostgresStorage live conformance', () => {
  const schema = `processengine_live_${process.pid}_${Date.now()}`;
  let pool: pg.Pool;
  let hostA: PostgresStorage;
  let hostB: PostgresStorage;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString! });
    await runPostgresMigrations(pool, { schema });
    hostA = createPostgresStorage({ pool, schema });
    hostB = createPostgresStorage({ pool, schema });
    await Promise.all([hostA.initialize(), hostB.initialize()]);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it('passes the reusable ProcessStorage SPI conformance suite', async () => {
    await runProcessStorageConformance(() => createPostgresStorage({ pool, schema }));
  });

  it('resumes outbox work on another host and fences the stale publisher', async () => {
    const process = processRecord('resume-1');
    const dispatch = durableDispatch(process);
    expect((await hostA.createProcess({ process, dispatch })).kind).toBe('CREATED');
    expect((await hostB.createProcess({ process, dispatch })).kind).toBe('EXISTING');

    const first = (await hostA.claimOutbox({
      workerId: 'host-a', now: '2026-01-01T00:00:00.000Z', leaseMs: 10, limit: 1,
    }))[0]!;
    const recovered = (await hostB.claimOutbox({
      workerId: 'host-b', now: '2026-01-01T00:00:00.020Z', leaseMs: 10, limit: 1,
    }))[0]!;
    expect(recovered.claimVersion).toBeGreaterThan(first.claimVersion);

    await hostA.markOutboxPublished({
      messageId: first.messageId,
      workerId: 'host-a',
      claimVersion: first.claimVersion,
      publishedAt: '2026-01-01T00:00:00.021Z',
    });
    expect((await hostA.getOperation(first.requestId))?.status).toBe('PENDING');

    await hostB.markOutboxPublished({
      messageId: recovered.messageId,
      workerId: 'host-b',
      claimVersion: recovered.claimVersion,
      publishedAt: '2026-01-01T00:00:00.025Z',
    });
    expect((await hostA.getOperation(first.requestId))?.status).toBe('PUBLISHED');

    const completed = completedState(process);
    const committed = await hostB.commitOperation({
      instanceId: process.state.instanceId,
      expectedRevision: process.state.revision,
      requestId: dispatch.operation.requestId,
      inboxMessageId: `${dispatch.operation.requestId}:completion`,
      resolution: 'SUCCESS',
      resolvedAt: completed.updatedAt,
      nextState: completed,
    });
    expect(committed.kind).toBe('COMMITTED');

    const duplicate = await hostA.commitOperation({
      instanceId: process.state.instanceId,
      expectedRevision: process.state.revision,
      requestId: dispatch.operation.requestId,
      inboxMessageId: `${dispatch.operation.requestId}:completion`,
      resolution: 'SUCCESS',
      resolvedAt: completed.updatedAt,
      nextState: completed,
    });
    expect(duplicate.kind).toBe('DUPLICATE');

    const late = await hostA.commitOperation({
      instanceId: process.state.instanceId,
      expectedRevision: process.state.revision,
      requestId: dispatch.operation.requestId,
      inboxMessageId: `${dispatch.operation.requestId}:late-completion`,
      resolution: 'SUCCESS',
      resolvedAt: completed.updatedAt,
      nextState: completed,
    });
    expect(late.kind).not.toBe('COMMITTED');
    expect((await hostA.getProcess(process.state.instanceId))?.state.revision).toBe(completed.revision);
  });

  it('accepts a response after publish but before the local publication mark', async () => {
    const process = processRecord('publish-before-mark');
    const dispatch = durableDispatch(process);
    await hostA.createProcess({ process, dispatch });

    const publication = (await hostA.claimOutbox({
      workerId: 'host-a', now: '2026-01-01T00:00:00.000Z', leaseMs: 100, limit: 10,
    })).find((record) => record.requestId === dispatch.operation.requestId)!;
    const completed = completedState(process, '2026-01-01T00:00:00.010Z');

    const committed = await hostB.commitOperation({
      instanceId: process.state.instanceId,
      expectedRevision: process.state.revision,
      requestId: dispatch.operation.requestId,
      inboxMessageId: `${dispatch.operation.requestId}:completion`,
      resolution: 'SUCCESS',
      resolvedAt: completed.updatedAt,
      nextState: completed,
    });
    expect(committed.kind).toBe('COMMITTED');
    expect(await hostA.getOperation(dispatch.operation.requestId)).toMatchObject({
      status: 'SUCCESS',
      deadlineAt: null,
    });

    await hostA.markOutboxPublished({
      messageId: publication.messageId,
      workerId: 'host-a',
      claimVersion: publication.claimVersion,
      publishedAt: '2026-01-01T00:00:00.011Z',
    });
    expect(await hostA.getOperation(dispatch.operation.requestId)).toMatchObject({
      status: 'SUCCESS',
      deadlineAt: null,
    });
  });

  it('leases expired operations across hosts and rejects an obsolete timeout claim', async () => {
    const process = processRecord('timeout-1');
    const dispatch = durableDispatch(process, 1_000);
    await hostA.createProcess({ process, dispatch });

    const publication = (await hostA.claimOutbox({
      workerId: 'host-a', now: '2026-01-01T00:00:00.000Z', leaseMs: 100, limit: 10,
    })).find((record) => record.requestId === dispatch.operation.requestId)!;
    await hostA.markOutboxPublished({
      messageId: publication.messageId,
      workerId: 'host-a',
      claimVersion: publication.claimVersion,
      publishedAt: '2026-01-01T00:00:00.001Z',
    });

    const first = (await hostA.claimExpiredOperations({
      workerId: 'host-a', now: '2026-01-01T00:00:02.000Z', leaseMs: 10, limit: 1,
    })).find((operation) => operation.requestId === dispatch.operation.requestId)!;
    const recovered = (await hostB.claimExpiredOperations({
      workerId: 'host-b', now: '2026-01-01T00:00:02.020Z', leaseMs: 20, limit: 10,
    })).find((operation) => operation.requestId === dispatch.operation.requestId)!;
    expect(recovered.timeoutClaimVersion).toBeGreaterThan(first.timeoutClaimVersion);

    const timedOut = completedState(process, '2026-01-01T00:00:02.025Z');
    const stale = await hostA.commitOperation({
      instanceId: process.state.instanceId,
      expectedRevision: process.state.revision,
      requestId: dispatch.operation.requestId,
      resolution: 'TIMED_OUT',
      resolvedAt: timedOut.updatedAt,
      nextState: timedOut,
      timeoutClaim: { workerId: 'host-a', claimVersion: first.timeoutClaimVersion },
    });
    expect(stale.kind).toBe('STALE_CLAIM');

    const winner = await hostB.commitOperation({
      instanceId: process.state.instanceId,
      expectedRevision: process.state.revision,
      requestId: dispatch.operation.requestId,
      resolution: 'TIMED_OUT',
      resolvedAt: timedOut.updatedAt,
      nextState: timedOut,
      timeoutClaim: { workerId: 'host-b', claimVersion: recovered.timeoutClaimVersion },
    });
    expect(winner.kind).toBe('COMMITTED');
    expect((await hostA.getOperation(dispatch.operation.requestId))?.status).toBe('TIMED_OUT');
  });

  it('admits exactly one concurrent completion-or-timeout transition across hosts', async () => {
    const process = processRecord('completion-timeout-race');
    const dispatch = durableDispatch(process, 1_000);
    await hostA.createProcess({ process, dispatch });
    const publication = (await hostA.claimOutbox({
      workerId: 'host-a', now: '2026-01-01T00:00:00.000Z', leaseMs: 100, limit: 10,
    })).find((record) => record.requestId === dispatch.operation.requestId)!;
    await hostA.markOutboxPublished({
      messageId: publication.messageId,
      workerId: 'host-a',
      claimVersion: publication.claimVersion,
      publishedAt: '2026-01-01T00:00:00.001Z',
    });
    const timeoutClaim = (await hostB.claimExpiredOperations({
      workerId: 'host-b', now: '2026-01-01T00:00:02.000Z', leaseMs: 1_000, limit: 10,
    })).find((operation) => operation.requestId === dispatch.operation.requestId)!;

    const successState = completedState(process, '2026-01-01T00:00:02.010Z');
    const timeoutState: ProcessRecord['state'] = {
      ...successState,
      outcome: 'TIMED_OUT',
      response: null,
      error: { code: 'PROCESSENGINE_COMPLETION_TIMEOUT', message: 'Timed out', details: null },
    };
    const [completion, timeout] = await Promise.all([
      hostA.commitOperation({
        instanceId: process.state.instanceId,
        expectedRevision: process.state.revision,
        requestId: dispatch.operation.requestId,
        inboxMessageId: `${dispatch.operation.requestId}:completion`,
        resolution: 'SUCCESS',
        resolvedAt: successState.updatedAt,
        nextState: successState,
      }),
      hostB.commitOperation({
        instanceId: process.state.instanceId,
        expectedRevision: process.state.revision,
        requestId: dispatch.operation.requestId,
        resolution: 'TIMED_OUT',
        resolvedAt: timeoutState.updatedAt,
        nextState: timeoutState,
        timeoutClaim: { workerId: 'host-b', claimVersion: timeoutClaim.timeoutClaimVersion },
      }),
    ]);

    expect([completion.kind, timeout.kind].filter((kind) => kind === 'COMMITTED')).toHaveLength(1);
    const stored = await hostA.getProcess(process.state.instanceId);
    const operation = await hostA.getOperation(dispatch.operation.requestId);
    expect(stored?.state.revision).toBe(process.state.revision + 1);
    expect(operation?.status).toBe(completion.kind === 'COMMITTED' ? 'SUCCESS' : 'TIMED_OUT');
    expect(stored?.state.outcome).toBe(completion.kind === 'COMMITTED' ? 'DONE' : 'TIMED_OUT');
  });

  it('reports database and migration health', async () => {
    await expect(hostA.checkHealth()).resolves.toMatchObject({ ok: true, schema, currentMigration: 1 });
  });
});

function processRecord(suffix: string): ProcessRecord {
  const instanceId = `process-${suffix}`;
  const at = '2026-01-01T00:00:00.000Z';
  return {
    namespace: 'live-test',
    idempotencyKey: `checkout-${suffix}`,
    fingerprint: `sha256:${suffix}`,
    state: {
      instanceId,
      flow: { id: 'shop.checkout', version: '1.0.0', digest: 'sha256:flow' },
      lifecycle: 'WAITING',
      revision: 1,
      currentStep: 'reserve-stock',
      input: { checkoutId: suffix },
      results: {},
      pending: { executionId: `${instanceId}:1`, requestId: `${instanceId}:1`, stepId: 'reserve-stock', operation: 'warehouse.reserve' },
      outcome: null,
      response: null,
      error: null,
      fault: null,
      createdAt: at,
      updatedAt: at,
    },
  };
}

function durableDispatch(process: ProcessRecord, completionTimeoutMs = 30_000): DurableDispatch {
  const requestId = `${process.state.instanceId}:1`;
  const messageId = `${requestId}:command`;
  return {
    operation: {
      requestId,
      instanceId: process.state.instanceId,
      stepId: 'reserve-stock',
      operation: 'warehouse.reserve',
      destination: 'warehouse.operations',
      completionSource: 'warehouse-service',
      status: 'PENDING',
      policy: { id: 'normal', version: '1', completionTimeoutMs, dispatch: { maxAttempts: 3, retryDelayMs: 100 } },
      deadlineAt: null,
      createdAt: process.state.createdAt,
      timeoutClaimVersion: 0,
    },
    outbox: {
      messageId,
      requestId,
      instanceId: process.state.instanceId,
      envelope: {
        messageId,
        type: 'processengine.operation.command',
        protocolVersion: '1',
        source: 'checkout',
        destination: 'warehouse.operations',
        partitionKey: process.state.instanceId,
        occurredAt: process.state.createdAt,
        payload: { requestId },
      },
      status: 'PENDING',
      attempt: 0,
      maxAttempts: 3,
      retryDelayMs: 100,
      availableAt: process.state.createdAt,
      claimVersion: 0,
    },
  };
}

function completedState(process: ProcessRecord, updatedAt = '2026-01-01T00:00:01.000Z'): ProcessRecord['state'] {
  return {
    ...process.state,
    lifecycle: 'COMPLETED',
    revision: process.state.revision + 1,
    pending: null,
    outcome: 'DONE',
    response: { ok: true },
    updatedAt,
  };
}
