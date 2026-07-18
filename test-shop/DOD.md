# Definition of done

The contour is accepted by executable oracles at three levels. Static success
does not imply that Docker Desktop or Kubernetes was exercised.

## Packaged and deterministic gate

| Requirement | Oracle | Result in this build environment |
|---|---|---|
| Host consumes only the three public ProcessEngine packages | tarball install and import/package smoke | pass |
| App inventory is `shop-host`, `shop-warehouse`, `shop-payment` | workspace, image and Helm inventory tests | pass |
| Explicit immutable flow v1 and v2 compile | public compiler/registry contract tests | pass |
| Every one of the 16 v1 `end` steps is reachable by a deterministic scenario | checkout terminal transition matrix | pass |
| Every terminal payload exactly equals its declared stored result | transition matrix and live acceptance oracle | static pass; live pending |
| Strict TypeScript build/typecheck and all focused tests | `npm run check` | pass |
| Node deployment scripts and JSON artifacts parse | release syntax gate | pass |
| Helm chart renders and lints | `npm run helm:render`, `npm run helm:lint` | pending: Helm unavailable here |

The framework sibling remains the owning gate for atomic storage transitions,
Kafka handler redelivery/heartbeat, bounded publication, completion races,
dispatch exhaustion, timeout fencing and startup lifecycle.

## Live business gate

Both `npm run compose:test` and `npm run k8s:test` execute
[`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) through the public HTTP APIs. The
gate covers happy checkout, every e-commerce branch represented by a fault
fixture, compound payment/stock compensation failures, timeout, concurrent
idempotent starts, duplicate commands and all completion anomalies.

The service-originated duplicate-response scenario requires all of these facts:

- payment publishes a second completion with the same `requestId` and a fresh
  `messageId`;
- the broker acknowledges that publication and its message ID is stored in a
  durable acceptance-control row;
- the normal completion remains in the service outbox and is published;
- the process revision/results and both domain effect ledgers stay unchanged
  after the duplicate settles.

Current live result: **not executed here** because Docker is unavailable.

## Live Kubernetes resilience gate

`npm run k8s:resilience` executes every scenario in
[`docs/RESILIENCE.md`](docs/RESILIENCE.md): multiple replicas, initiating-host
loss, durable-outbox recovery by another host, worker crash after its atomic
domain commit and redelivery to another service instance, v1-to-v2 rolling
activation, Kafka outage, PostgreSQL outage, duplicate/late completion and
final database/ledger assertions.

Current live result: **not executed here** because Docker, kubectl and Helm are
unavailable. No Kubernetes PASS is claimed.

## Evidence rule

A live Kubernetes run is accepted only with machine-readable results,
Kubernetes inventory, Helm status, selected logs and PostgreSQL snapshots under
`.artifacts/k8s/<run-id>/`. These generated files are excluded from the source
archive.

## Reference-contour boundary

Production Kafka/PostgreSQL HA, disaster recovery, authn/authz, TLS, secret
management, network policy, autoscaling, SLOs and observability backends are
deployment responsibilities beyond this local reference contour.
