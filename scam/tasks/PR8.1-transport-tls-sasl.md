# Task Contract: PR8.1 — Kafka/PostgreSQL TLS + SASL + credential rotation

## Outcome
Both connectors support encrypted, authenticated connections (Kafka TLS/mTLS +
SASL; PostgreSQL TLS) with a documented config surface and a rotation procedure
that drops no messages or domain effects.

## Scope
- In: `transport-kafka/src/kafka-transport.ts` (ssl/sasl config passthrough +
  validation), `storage-postgres/src/index.ts` (ssl/connection config), secure
  values in the Helm chart, `docs/security/TRANSPORT_TLS_SASL.md`.
- Out: broker/DB provisioning; k8s network policy (PR9.1).

## Affected module
`transport-kafka`, `storage-postgres`, test-shop chart.

## Acceptance — frozen
- [ ] Kafka transport connects with TLS + SASL/SCRAM using file/env-injected
      secrets; invalid config fails fast with a typed error.
- [ ] Postgres storage connects with TLS (verify-full) config.
- [ ] The contour runs green against a TLS+SASL Kafka and TLS Postgres.
- [ ] A credential rotation (new SASL user / rotated PG password) completes with
      zero lost messages and unchanged domain-effect counts (asserted).

## Required tests
Live secure-broker + secure-PG conformance; rotation drill.

## Dependencies
PR6.1 helpful. **Priority** P0 · **Size** L · **Blocks stable** yes.

## Docs
`docs/security/TRANSPORT_TLS_SASL.md`.

## Stop conditions
Secrets must never be logged or committed; if a design needs plaintext secrets in
env, escalate.
