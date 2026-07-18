# Task Contract: PR5.1 — Migration lifecycle + readiness gate

## Outcome
PostgreSQL migrations are documented forward-only with expand/contract guidance,
are idempotently re-runnable, and no longer error-loop when the DB is not yet
ready (observed transient `ECONNREFUSED` during deploy).

## Scope
- In: `storage-postgres/src/migrations.ts`; migrations Job template
  (`test-shop/deploy/helm/test-shop/templates/migrations-job.yaml`) readiness
  wait/init-container; `docs/ops/MIGRATIONS.md`.
- Out: rollback DDL (documented as forward-only), backup (PR5.2).

## Affected module
`storage-postgres` + test-shop migrations Job.

## Acceptance — frozen
- [ ] Running the migrator twice is a no-op (idempotent); checksum drift is
      rejected with a canonical error.
- [ ] Migrating against a not-yet-ready Postgres waits (bounded) then succeeds
      with **no failed pod / no CrashLoop**.
- [ ] `MIGRATIONS.md` documents forward-only + expand/contract policy.
- [ ] `storage-postgres` live migration test passes against a real PG.

## Required tests
Extend `migrations.test.ts` (idempotency + drift) and the live conformance suite;
a k8s deploy showing the migrations Job Completes without a failed attempt.

## Dependencies
None. **Priority** P0 · **Size** M · **Blocks stable** yes.

## Docs
`docs/ops/MIGRATIONS.md`.

## Stop conditions
None expected.
