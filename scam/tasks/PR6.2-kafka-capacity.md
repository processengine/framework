# Task Contract: PR6.2 — Kafka capacity & tuning guide

## Outcome
A guide lets teams size Kafka for their process throughput (partitions, RF,
retention, producer/consumer tuning) with ProcessEngine-specific guidance.

## Scope
- In: `docs/ops/KAFKA.md` (capacity section).
- Out: contract/ordering semantics (PR6.1), security (PR8.1).

## Affected module
`transport-kafka` docs.

## Acceptance — frozen
- [ ] Guidance for partition count vs process concurrency, RF/ISR for durability,
      retention vs completion-timeout windows, producer `acks`, consumer lag.
- [ ] At least one measured example throughput/lag figure from the perf harness
      (PR12.1) is cited.

## Required tests
Docs; cite PR12.1 measurements.

## Dependencies
PR6.1, PR12.1. **Priority** P1 · **Size** M · **Blocks stable** no.

## Docs
`docs/ops/KAFKA.md`.
