# Task Contract: PR4.1 — Connector authoring contract & guide

## Outcome
An external developer can implement a compliant storage or transport connector
using only public docs + the conformance kit, validated by a second reference
adapter.

## Scope
- In: `docs/spi/CONNECTORS.md` (semantic contract for each SPI method);
  an example second adapter (e.g. SQLite storage or NATS transport) in `examples/`.
- Out: shipping the example adapter as a published package.

## Affected module
`conductor` SPI docs; `examples/`.

## Acceptance — frozen
- [ ] Each SPI method's required semantics (atomicity boundary, redelivery duty,
      ack-before-timeout, ordering assumptions, fencing) is documented and
      cross-linked to a conformance assertion (PR3.1).
- [ ] The example adapter passes `runProcessStorageConformance` /
      `runMessageTransportConformance`.

## Required tests
Conformance suites run against the example adapter.

## Dependencies
PR3.1, PR1.1. **Priority** P1 · **Size** L · **Blocks stable** no.

## Docs
`docs/spi/CONNECTORS.md`.
