# Task Contract: PR7.1 — HA reference topology & recovery guarantees

## Outcome
A documented, drilled multi-node HA topology with an explicit recovery-guarantee
table (RPO/RTO per failure class), replacing the single-node stand.

## Scope
- In: HA Helm values (multi-broker RF≥3, Postgres primary+standby, pod
  anti-affinity, tuned PDBs); `docs/ops/HA.md`.
- Out: managed-service specifics.

## Affected module
test-shop chart (as reference); docs.

## Acceptance — frozen
- [ ] HA values deploy ≥3 Kafka brokers (RF≥3) and a Postgres primary+standby.
- [ ] Broker-loss and Postgres-failover drills keep logical exactly-once effects
      and leave all processes resumable.
- [ ] `HA.md` states RPO/RTO per failure class.

## Required tests
Chaos drills (PR12.1 harness) against the HA topology.

## Dependencies
PR6.1, PR12.1. **Priority** P1 · **Size** L · **Blocks stable** no.

## Docs
`docs/ops/HA.md`.
