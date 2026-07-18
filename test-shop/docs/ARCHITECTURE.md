# Architecture

The application follows one rule: domain code depends on ProcessEngine's public contracts, while deployment choices are composed at the host edge.

```text
HTTP client
    |
    v
shop-host x2 ---- @processengine/conductor
    |                 |              |
    |                 v              v
    |          storage-postgres   transport-kafka
    |                 |              |
    +---------------- PostgreSQL     Kafka
                                      |
                         +------------+------------+
                         v                         v
                 shop-warehouse x2         shop-payment x2
                         |                         |
                         +------ inbox/outbox -----+
                                      |
                                  PostgreSQL
```

## Canonical ProcessEngine principles made executable

1. **A process is durable state, not a call stack.** `shop-host` persists process state, operation requests, retry policy snapshots, and its outbox before publication. Any ready host replica can resume it.
2. **The Flow3 artifact is immutable identity.** A process is pinned to flow id, version, and digest. Both v1 and v2 are explicit JSON files loaded through `FLOW_FILES`; no version is synthesized in code. The resilience gate holds v1 at a distributed barrier, replaces every application pod through Helm, then proves v1 completes as `APPROVED` while new work exhibits v2's observable `APPROVED_V2` outcome.
3. **The DSL describes decisions; the host owns deployment.** The versioned `shop.checkout.v*.json` artifacts contain operation, switch, and end semantics. Topics, completion identities, timeouts, and dispatch policy live in `operations.json`.
4. **Operations are at-least-once; effects are idempotent.** Both domain workers durably claim a `requestId`, commit their domain effect and completion in one PostgreSQL transaction, and relay through an outbox. A repeated command republishes its stored result without repeating the effect.
5. **Completions are correlated and fenced.** ProcessEngine accepts the pending request from the configured completion source. Same-id duplicates, new-message-id duplicates, conflicting second replies, foreign sources, unknown request IDs, malformed envelopes, and late replies cannot rewrite advanced or terminal state.
6. **Errors are process data when the flow handles them.** Technical operation errors route through explicit switch/compensation paths. A process faults only for an unmodelled invariant or transition failure.
7. **Recovery is polling plus durable ownership fencing.** Host and worker outboxes use leases and monotonic claim versions. An expired owner cannot acknowledge a newer claim.

## Module boundaries

`@test-shop/host-adapter` is the only module that imports all three ProcessEngine packages. It assembles catalogs, artifact registry, storage, transport, migrations, and `Conductor`. The HTTP app sees a small `ShopConductor` interface.

`@test-shop/contracts` contains strict domain payload parsers. It has no framework or infrastructure dependency.

`@test-shop/service-kit` is reference application code, not framework API. It demonstrates how a separately owned service implements a PostgreSQL inbox/outbox around operation messages. A real service may replace it wholesale.

## Checkout semantics

The happy route is reserve stock → authorize payment → confirm payment → `APPROVED`.

Decline or authorization failure releases stock. Confirmation failure first cancels the authorization and only then releases stock. If payment cancellation fails, the process terminates as `PAYMENT_COMPENSATION_FAILED` with stock deliberately still reserved for manual handling. This ordering prevents the demo from reporting released inventory while retaining an untracked payment authorization.

No framework package contains a Kafka/PostgreSQL preset. The host composes transport and storage explicitly, so another host can select different adapters without changing the kernel or DSL.
