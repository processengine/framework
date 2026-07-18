# Task Contract: PR3.1 — Conformance kit productization

## Outcome
`runProcessStorageConformance` / `runMessageTransportConformance` become a
documented, versioned, complete conformance product with a canon-invariant
coverage matrix and mutation-proven checks.

## Scope
- In: `conductor/src/conformance.ts`, `testing.ts`; `docs/spi/CONFORMANCE.md`;
  a coverage matrix; fill gaps (fencing, lease reclaim, outbox drain, inbox dedup).
- Out: new SPI methods, storage/transport implementations.

## Affected module
`conductor` (`conformance.ts`, `testing.ts`, `spi.ts`).

## Acceptance — frozen
- [ ] Coverage matrix maps each canon §3–§5 invariant → a named conformance
      assertion; no `UNCOVERED` rows.
- [ ] A trivial in-memory adapter passes the full suite.
- [ ] A deliberately broken adapter (one mutation per invariant) fails on that
      specific invariant (mutation test proving each check bites).
- [ ] Suites are exported from a stable public path (per PR1.1).

## Required tests
The conformance suites themselves + a mutation-adapter harness.

## Dependencies
PR1.1. **Priority** P0 · **Size** M · **Blocks stable** yes.

## Docs
`docs/spi/CONFORMANCE.md`.

## Stop conditions
An invariant proves unspecified in the canon → record as contradiction.
