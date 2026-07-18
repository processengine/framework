# Task Contract: PR1.1 — Curated public API surface + API report

## Outcome
`@processengine/*` expose an explicit, reviewed public surface instead of
`export *`. An API report is generated and CI fails on any unreviewed change.

## Scope
- In: `processengine/packages/*/src/index.ts` (+ `/testing`, `/worker`,
  `/migrations` entrypoints); add API-report tooling + CI gate.
- Out: behavior changes, renames beyond hiding internals, DSL/state changes.

## Affected module
All three packages; primarily `conductor/src/index.ts` (`export *` × 11 modules).

## Acceptance — frozen
- [ ] Each package `index.ts` re-exports only named, documented symbols; internals
      are `@internal` or under a non-exported path.
- [ ] A checked-in `api.md` (or `.api.json`) snapshot per package exists.
- [ ] Adding/removing/altering an exported symbol without updating the snapshot
      fails `npm run check:packages` (or a new `check:api`) with non-zero exit.
- [ ] `package-smoke.mjs` imports only documented symbols and passes.
- [ ] `npm --prefix processengine run check` still exit 0.

## Required tests
API-report diff gate; extended public-import smoke.

## Dependencies
None. **Priority** P0 · **Size** M · **Blocks stable** yes.

## Docs
`docs/api/README.md`, `SEMVER.md` (see PR1.2).

## Stop conditions
Hiding a symbol breaks `test-shop` public import → surface it in the contract, do
not re-widen silently.
