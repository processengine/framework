# Task Contract: PR5.2 — PostgreSQL backup / restore / PITR runbook

## Outcome
Operators have a tested procedure to back up and restore ProcessEngine state
(processes, operations, outbox, inbox) without corrupting in-flight execution.

## Scope
- In: `docs/ops/BACKUP_RESTORE.md`; a restore-drill script/test.
- Out: managed-DB-specific tooling.

## Affected module
`storage-postgres` schema; ops docs.

## Acceptance — frozen
- [ ] Documented backup + PITR procedure covering all ProcessEngine tables and
      the `schema_migrations` table.
- [ ] A restore drill: back up mid-execution, restore into a clean DB, and the
      conductor resumes pending processes with unchanged domain-effect counts.

## Required tests
Restore drill (can reuse the k8s contour + a scripted dump/restore).

## Dependencies
PR5.1. **Priority** P1 · **Size** M · **Blocks stable** no.

## Docs
`docs/ops/BACKUP_RESTORE.md`.
