# Milestone definition of done

The milestone is complete when the packaged framework and the deployed
`test-shop` contour pass every gate below. Each requirement has an executable
oracle; a written status is not a substitute for its evidence.

## 1. Framework and package gate

- `@processengine/conductor`, `@processengine/transport-kafka` and
  `@processengine/storage-postgres` build and typecheck independently;
- a clean external consumer installs and imports all three packed `.tgz`
  artifacts through their public exports;
- Flow3 accepts the canonical `operation`, `switch` and `end` model and rejects
  invalid graphs, unavailable inputs, cycles, forged artifact digests and
  unknown switch routes;
- the deterministic checkout transition matrix reaches every `end` step and
  proves that terminal `response` or `error` is exactly the referenced stored
  operation result;
- storage tests prove atomic process/operation/outbox commits, idempotent start,
  inbox deduplication, optimistic revision, competing completion first-wins,
  timeout and dispatch fencing, lease reclaim and stable attempts;
- transport tests prove envelope validation, per-group delivery, handler
  redelivery without offset advance, heartbeat while a handler or retry delay
  is active, bounded publication and clean concurrent lifecycle operations;
- framework lifecycle tests prove single-flight workers, graceful stop,
  partial-start rollback and a successful retry after transient startup failure.

Commands:

```bash
npm --prefix processengine run check
npm --prefix processengine run check:packages
npm --prefix test-shop run check
```

## 2. Live e-commerce business gate

`npm --prefix test-shop run compose:test` and
`npm --prefix test-shop run k8s:test` must exercise the public checkout API and
assert terminal state, exact terminal payload, operation ledgers and domain
effect counters for:

- approved checkout;
- out of stock, warehouse domain error and warehouse handler failure;
- declined payment followed by stock release;
- payment technical error and completion timeout followed by compensation;
- payment confirmation business failure and technical error followed by both
  payment cancellation and stock release;
- successful and failed compensation outcomes represented by the shipped flow;
- concurrent starts with one idempotency key and one process instance;
- duplicate command delivery with one durable domain effect per `requestId`;
- duplicate service completion with the same `requestId` and a new `messageId`;
- same-message replay, conflicting second completion, foreign source,
  foreign request ID, malformed completion and valid completion after timeout.

For the deliberate duplicate-service glitch, the payment service records the
second Kafka publication only after the broker acknowledges it. Acceptance
requires a fresh message ID, an unchanged terminal revision/result and unchanged
payment and warehouse effect counters.

## 3. Durable and concurrent runtime gate

Focused framework tests and the live contour together must prove:

- state and the first outbox command are stored atomically;
- command IDs and operation request IDs remain stable across retries and owner
  changes;
- completion timeout starts only after acknowledged publication is persisted;
- dispatch exhaustion and completion timeout are separate canonical errors;
- two conflicting valid completions and a timeout-versus-completion race admit
  one committed transition;
- duplicate, late, malformed and incorrectly correlated completions leave state
  unchanged;
- an expired lease is reclaimed with a higher fencing token and a stale owner
  cannot publish, reschedule or commit;
- an immutable `{id, version, digest}` remains pinned for the lifetime of a
  process and a digest mismatch is rejected;
- process, operation, inbox and outbox records remain inspectable after
  completion.

## 4. Docker Desktop Kubernetes resilience gate

`npm --prefix test-shop run k8s:resilience` must prove against the active
`docker-desktop` context:

- Apache Kafka in KRaft mode, PostgreSQL and exactly two ready replicas of each
  application become healthy;
- concurrent requests are served by multiple `shop-host` instances;
- deleting the host that initiated a durable `WAITING` process lets another
  host instance continue it;
- deleting an initiator during a Kafka publication outage preserves the durable
  outbox and a replacement drains it;
- crashing a payment worker after its atomic domain commit causes a different
  worker instance to receive the command and replay the stored result without a
  second domain effect;
- a rolling v1-to-v2 deployment keeps unfinished v1 processes pinned, preserves
  completed state and starts new processes on explicit v2 semantics;
- temporary Kafka and PostgreSQL outages stop progress safely and the contour
  resumes without deleting pods, ledgers or process data;
- application rescheduling retains process state, operation ledgers and domain
  effect counters.

## 5. Evidence and status rule

Every Kubernetes run writes machine-readable scenario results, Kubernetes
inventory, Helm status, selected logs and PostgreSQL snapshots under
`test-shop/.artifacts/k8s/<run-id>/`. The directory is generated by a live run
and is intentionally absent from source archives.

Static gates may be reported independently. The milestone itself remains
`NOT VERIFIED` until Docker Desktop business and resilience gates pass and
their evidence has been collected.
