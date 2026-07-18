# Task Contract: PR1.2 — Semver & support policy

## Outcome
A written, enforceable versioning/deprecation/support policy for the three
published packages so consumers can predict breaking changes.

## Scope
- In: `SEMVER.md` at repo root; cross-links from each package README.
- Out: tooling automation (that is PR16.1), API extraction (PR1.1).

## Affected module
Repo-level governance; references all three packages.

## Acceptance — frozen
- [ ] `SEMVER.md` defines: what is public (per PR1.1), semver rules for
      DSL/schema/SPI/runtime, deprecation window (≥1 minor), and support/LTS intent.
- [ ] Each package README links to `SEMVER.md`.
- [ ] Policy states the at-least-once + idempotent (logical exactly-once) contract
      as a stability guarantee, not physical exactly-once.

## Required tests
Docs-only; link-check in CI.

## Dependencies
PR1.1 (defines "public"). **Priority** P0 · **Size** S · **Blocks stable** yes.

## Docs
`SEMVER.md`.

## Stop conditions
None expected.
