# Task Contract: PR2.1 — DSL compatibility contract

## Outcome
Flow3 grammar changes have a defined additive-vs-breaking contract; old artifacts
execute identically on newer engines (equivalent digest / normalized behavior) or
are rejected explicitly. Versioning does **not** add a technical version field to
the compact business flow JSON.

## Scope
- In: versioning via `@processengine/conductor` major/minor and the published flow
  schema's `$id`; golden compatibility fixtures; `docs/dsl/COMPATIBILITY.md`.
- Out: new DSL step types; grammar redesign; state-model changes; **adding any
  `dsl` / `dslVersion` / `schemaVersion` field to the flow** (forbidden by the
  canon — see `processengine/docs/OPERATION_SCHEMA_PROFILE.md` §Versioning).

## Affected module
`conductor/src/compiler.ts`, `schema/flow.schema.json` (`$id` only), golden fixtures.

## Acceptance — frozen
- [ ] The grammar version is expressed by package semver + the flow schema `$id`,
      not by a field inside the business flow. If protocol negotiation is ever
      required it lives in the artifact-registry manifest/metadata, not the flow.
- [ ] Golden compatibility fixtures: an older flow compiled by the current engine
      yields an equivalent normalized digest, or the change is declared breaking.
- [ ] `COMPATIBILITY.md` enumerates additive vs breaking change classes.
- [ ] `npm --prefix processengine run check` exit 0.

## Required tests
Golden compatibility fixtures across grammar revisions; a breaking-change fixture
that must be declared breaking (digest change) rather than silently accepted.

## Dependencies
None. **Priority** P0 · **Size** M · **Blocks stable** yes.

## Docs
`docs/dsl/COMPATIBILITY.md`; cross-link `OPERATION_SCHEMA_PROFILE.md`.

## Stop conditions
A needed change implies breaking existing pinned artifacts → record as canonical
contradiction, escalate; do not silently break pinning. A proposal to add a
version field to the flow JSON is a canon violation → reject.
