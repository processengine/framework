# Definition of done

The contour is accepted by executable oracles at deterministic/package,
business, resilience, and live-SPI levels. The resilience-accepted source commit
is `6956299de7da03d8074530f0856339e0915c8146`; its exact image content tag is
`sha-d3eb3338ca20f71f`. The post-publication consumer commit is
`c6d6fcab49f52184c0349a6b7f07bd1dcd144f27`; its registry-backed image tag is
`sha-d923f6427af27545`.

## Packaged and deterministic gate

| Requirement | Oracle | Verified result |
| --- | --- | --- |
| Host consumes only the three public ProcessEngine packages | registry lock, clean install, and public-import smoke | PASS |
| App inventory is `shop-host`, `shop-warehouse`, `shop-payment` | workspace, image, and Helm inventory tests | PASS |
| Explicit immutable flow v1 and v2 compile | public compiler/registry contract tests | PASS |
| Every one of the 16 v1 terminal steps is reachable | checkout terminal transition matrix | PASS |
| Every terminal payload equals its declared stored result | deterministic and live acceptance oracles | PASS |
| Strict build/typecheck and focused tests | framework/test-shop `npm run check` | PASS: framework 57 + 8 live skipped; test-shop 42 |
| Node deployment scripts and JSON artifacts parse | release syntax gate | PASS |
| Helm chart renders and lints | `npm run helm:render`, `npm run helm:lint` | PASS |

The framework remains the owning gate for atomic storage transitions, Kafka
redelivery/heartbeat, bounded publication, completion races, dispatch
exhaustion, timeout fencing, and startup lifecycle.

## Live business gate

Both Compose and Kubernetes executed `docs/ACCEPTANCE.md` through public HTTP
APIs. Each passed all `16/16` scenarios, including happy checkout, every fault
branch, compound compensation failures, timeout, concurrent idempotent starts,
duplicate commands, and completion anomalies.

The duplicate-response oracle observed a second completion with the same
`requestId` and a fresh `messageId`, broker acknowledgement recorded in durable
acceptance control, publication of the normal service-outbox completion, and no
change to the process result or either domain-effect ledger.

Evidence:

- Compose and deterministic gates:
  `test-shop/.artifacts/k8s/2026-07-18T19-22-15.3NZ-local-gates-pass/`.
- Kubernetes business gate:
  `test-shop/.artifacts/k8s/2026-07-18T19-15-23.099Z-business-pass/`.
- Post-publication registry-backed Kubernetes business gate:
  `test-shop/.artifacts/k8s/2026-07-18T20-59-27.257Z-business-pass/`.

## Live Kubernetes resilience gate

`npm run k8s:resilience` passed `8/8` scenarios:

1. initiating-instance crash;
2. durable initiator outbox with a real Kafka StatefulSet outage;
3. operation-worker crash after its durable domain commit;
4. host-only artifact activation;
5. full-contour rolling update;
6. duplicate/late completion;
7. Kafka outage recovery;
8. PostgreSQL outage recovery.

The outage scenarios observed the target StatefulSet at zero desired/ready
replicas with no remaining pods before restoration. Artifact activation
replaced only host pods; its separate full-contour scenario replaced all six
application pods. v1 work remained pinned, new work used v2, and final ledger
checks showed one logical domain effect. PostgreSQL recovery completed with all
six application restart counts unchanged.

Evidence:
`test-shop/.artifacts/k8s/2026-07-18T19-19-07.805Z-resilience-pass/`.

## Live SPI conformance

- PostgreSQL SPI: PASS `6/6`.
- Kafka SPI: PASS `2/2`.

The suites ran from an ephemeral Node `22.13.0` pod against the deployed Kafka
listener and PostgreSQL secret. The pod was removed after the run. Evidence:
`test-shop/.artifacts/k8s/2026-07-18T19-19-52.3NZ-live-conformance-pass/`.

## Image/source identity and contour state

- The image content tag hashes the actual build inputs; documentation/evidence
  edits do not change it, while application/config changes do.
- Every application Deployment and every Ready application pod used the exact
  repository/tag asserted by the deploy gate.
- After npm publication, Helm revision 34 ran all six application pods from
  `sha-d923f6427af27545`; its Docker build installed the registry lockfile and
  the repeated business gate passed `16/16`.
- Kubernetes context `docker-desktop`, namespace `processengine-test-shop`, and
  Helm release `test-shop` remain running.
- Compose is stopped with its volumes retained.

## Evidence rule

A live Kubernetes run is accepted only with machine-readable results,
Kubernetes inventory, Helm status, selected logs, and PostgreSQL snapshots under
`.artifacts/k8s/<run-id>/`. Generated evidence is excluded from source control.

## Reference-contour boundary

Production Kafka/PostgreSQL HA, disaster recovery, authn/authz, TLS, external
secret management, network policy, autoscaling, SLOs, and observability
backends remain deployment responsibilities beyond this local reference
contour. `docs/production-readiness/PLAN.md` and its P0/P1 SCAM tasks cover that
follow-up scope.
