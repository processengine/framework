# Task Contract: PR6.1 — Kafka partitioning & ordering contract

## Outcome
The partitioning/ordering/durability contract of the Kafka transport is
documented and proven under multi-partition + consumer rebalance, so third
parties can size topics safely without breaking per-process correctness.

## Scope
- In: `transport-kafka/src/kafka-transport.ts`, `worker.ts`; live multi-partition
  test; `docs/ops/KAFKA.md` (contract section).
- Out: TLS/SASL (PR8.1), capacity tuning guide (PR6.2).

## Affected module
`@processengine/transport-kafka`.

## Acceptance — frozen
- [ ] Documented: which message key guarantees per-`instanceId`/per-`requestId`
      correlation, behavior under rebalance, and min RF/ISR for durable delivery.
- [ ] A live test on a ≥3-partition topic shows correct `requestId` correlation
      and **exactly one** domain effect across a triggered consumer-group rebalance.
- [ ] Producer uses `acks=all` (already set) — asserted in a test.

## Required tests
Extend `kafka.live.test.ts`: multi-partition round-trip + forced rebalance; effect
counter assertion via a stub operation.

## Dependencies
None (independent of PR8.1). **Priority** P0 · **Size** M · **Blocks stable** yes.

## Docs
`docs/ops/KAFKA.md`.

## Stop conditions
If correlation depends on single-partition assumption → record as canonical risk.
