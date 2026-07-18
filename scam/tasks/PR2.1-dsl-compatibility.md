# Task Contract: PR2.1 — DSL compatibility contract

## Outcome
Flow3 schema changes have a defined additive-vs-breaking contract and a schema
version; old artifacts execute identically on newer engines or are rejected
explicitly.

## Scope
- In: `conductor/schema/flow.schema.json` (add `schemaVersion`), compiler
  compatibility tests, `docs/dsl/COMPATIBILITY.md`.
- Out: new DSL step types, grammar redesign, state-model changes.

## Affected module
`conductor/src/compiler.ts`, `schema.ts`, `schema/flow.schema.json`.

## Acceptance — frozen
- [ ] Flow schema carries an explicit version; engine rejects an unknown-higher
      schema version with a canonical error (not a crash).
- [ ] A v1 artifact compiled by the current engine yields byte-identical compiled
      output vs a stored golden (regression pin).
- [ ] `COMPATIBILITY.md` enumerates additive vs breaking change classes.
- [ ] `npm --prefix processengine run check` exit 0.

## Required tests
Compiler golden tests across ≥2 schema versions; explicit-rejection test.

## Dependencies
None. **Priority** P0 · **Size** M · **Blocks stable** yes.

## Docs
`docs/dsl/COMPATIBILITY.md`.

## Stop conditions
A needed change implies breaking existing pinned artifacts → record as canonical
contradiction, escalate; do not silently break pinning.
