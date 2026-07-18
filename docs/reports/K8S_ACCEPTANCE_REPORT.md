# Docker Desktop Kubernetes Acceptance Report — ProcessEngine test-shop 0.1.0

- **Date/time**: 2026-07-18 (UTC)
- **Milestone**: PE-M1 — local Kubernetes contour to verified release 0.1.0
- **Runtime source commit**: `6956299de7da03d8074530f0856339e0915c8146`
- **Application content tag**: `sha-d3eb3338ca20f71f`
- **Kubernetes context**: `docker-desktop`
- **Namespace / Helm release**: `processengine-test-shop` / `test-shop`

Documentation commits made after the runtime gates do not enter the Docker build
input set and therefore do not change this content tag. A separate
post-publication deployment is recorded in section 3.5.

## 1. Environment and deployed contour

| Item | Observed value |
| --- | --- |
| Docker Engine | 29.6.1 |
| Kubernetes server | v1.36.1 |
| kubectl client | v1.33.4 |
| Helm | v4.2.1 |
| Application/runtime Node | 22.13.0 |
| Host runner Node | 20.19.0; emits the expected `engines >=22` warning |
| Kafka | `apache/kafka:4.3.1`, KRaft, 1/1 Ready |
| PostgreSQL | `postgres:16.8-alpine`, 1/1 Ready |
| shop-host | 2/2 Ready |
| shop-warehouse | 2/2 Ready |
| shop-payment | 2/2 Ready |

All three Deployments and all six Ready application pods used the exact
`repository:sha-d3eb3338ca20f71f` image asserted by `assertWorkloads()` before
the business and resilience runners started. Both Kafka and PostgreSQL PVCs
were Bound. The migrations and topic Jobs completed. The final active flow was
restored to `1.0.0`; the Kubernetes contour was left running.

Deploy evidence (exit 0):
`test-shop/.artifacts/k8s/2026-07-18T19-11-45.201Z-deploy-pass/`.
Final steady-state snapshot:
`test-shop/.artifacts/k8s/2026-07-18T19-21-17.138Z-manual/`.

## 2. Delivery semantics

Transport delivery is **at-least-once**. Operation services deduplicate the
stable `requestId` in the same transaction as each domain change, and the
conductor accepts only the first valid completion for a pending operation. The
verified claim is therefore logically exactly-once domain effects over
at-least-once physical delivery; physical exactly-once delivery is not claimed.

## 3. Gate results

### 3.1 Deterministic and Compose gates — PASS

| Gate | Observed result | Evidence |
| --- | --- | --- |
| `npm run check` | exit 0; framework 57 passed, 8 live skipped; test-shop 42 passed | `test-shop/.artifacts/k8s/2026-07-18T19-22-15.3NZ-local-gates-pass/npm-check.log` |
| package smoke / tarballs | exit 0; clean install/import smoke; Apache-2.0 present in all packages | same directory |
| `compose:doctor/up/test` | exit 0; `business-acceptance=PASS`, 16/16; Compose stopped afterward without deleting volumes | same directory (`compose-*.log`) |

The host runner is Node 20.19.0, below the declared Node 22 engine, so npm
printed `EBADENGINE` warnings. The same packages built and the live suites ran
inside Node 22.13.0; the warning did not suppress a failed command.

### 3.2 Kubernetes business gate — PASS

`npm run k8s:test` exited 0. Helm health test phase was `Succeeded`, and
`gate=business-acceptance status=PASS` covered all 16 terminal outcomes,
terminal payload references, domain ledgers, duplicates and completion
anomalies.

Evidence:
`test-shop/.artifacts/k8s/2026-07-18T19-15-23.099Z-business-pass/`.

| # | Scenario | Outcome | Revision | Warehouse effects | Payment effects |
| --- | --- | --- | --- | --- | --- |
| 1 | success | APPROVED | 4 | 1 | 2 |
| 2 | service-duplicate-completion | APPROVED | 4 | 1 | 2 |
| 3 | out-of-stock | OUT_OF_STOCK | 2 | 1 | 0 |
| 4 | warehouse-error | WAREHOUSE_UNAVAILABLE | 2 | 1 | 0 |
| 5 | warehouse-handler-failed | WAREHOUSE_HANDLER_FAILED | 2 | 1 | 0 |
| 6 | payment-declined | PAYMENT_DECLINED | 4 | 2 | 1 |
| 7 | payment-error | PAYMENT_ERROR_COMPENSATED | 4 | 2 | 1 |
| 8 | payment-error + stock compensation failure | COMPENSATION_FAILED | 4 | 2 | 1 |
| 9 | payment-timeout (`completionTimeoutMs=60000`) | PAYMENT_ERROR_COMPENSATED | 4 | 2 | 1 |
| 10 | confirm-failure | PAYMENT_CONFIRM_FAILED | 6 | 2 | 3 |
| 11 | confirm-failure + stock compensation failure | COMPENSATION_FAILED | 6 | 2 | 3 |
| 12 | confirm-error | PAYMENT_CONFIRM_ERROR_COMPENSATED | 6 | 2 | 3 |
| 13 | confirm-error + stock compensation failure | COMPENSATION_FAILED | 6 | 2 | 3 |
| 14 | confirm-error + payment compensation failure | PAYMENT_COMPENSATION_FAILED | 5 | 1 | 3 |
| 15 | payment-compensation-failure | PAYMENT_COMPENSATION_FAILED | 5 | 1 | 3 |
| 16 | compensation-failure | COMPENSATION_FAILED | 4 | 2 | 1 |

The duplicate matrix included same/new message IDs, duplicate commands,
conflicting completion, foreign source/request ID, malformed input and a late
completion. The terminal process and domain-effect counters remained unchanged.

### 3.3 Kubernetes resilience gate — PASS

`npm run k8s:resilience` exited 0 with all eight scenarios. Evidence:
`test-shop/.artifacts/k8s/2026-07-18T19-19-07.805Z-resilience-pass/`.

| Scenario | Observed acceptance |
| --- | --- |
| initiating-instance-crash | Initiating host was force-deleted; the other host completed the pinned process, revision 2→4. |
| durable-outbox-initiator-crash | Kafka was actually absent (`spec=0`, `ready=0`, no pod); a stable unpublished durable request survived initiator deletion, drained after recovery and completed APPROVED. |
| operation-worker-crash-after-durable-commit | Payment pod restarted 0→1 after its atomic commit; command was delivered twice to two service instances; one domain effect and final revision 4. |
| artifact-activation | Only both host pods were replaced; warehouse/payment identities were unchanged; waiting v1 stayed at the same revision and flow 1.0.0, then completed; an earlier terminal process stayed unchanged and a new v2 process returned APPROVED_V2. |
| full-contour-rolling-update | Both replicas of host, warehouse and payment were replaced while a committed operation completion was held; v1 remained pinned and then completed with one effect per operation. |
| duplicate-late-completion | Replayed completion did not change terminal revision/results. |
| kafka-outage-recovery | Actual `spec=0/ready=0/no pod`; durable outbox row was not PUBLISHED during outage; all three rows became PUBLISHED and the process completed revision 4. |
| postgres-outage-recovery | Actual `spec=0/ready=0/no pod` held for 20 s; process completed APPROVED revision 4; all six application restart counts remained 0. |

### 3.4 Live SPI conformance — PASS

The exact live suites ran inside a temporary Node 22.13.0 pod in the namespace,
using the cluster Kafka listener and a Secret reference for PostgreSQL. The pod
was deleted afterward.

| Suite | Result |
| --- | --- |
| `@processengine/storage-postgres test:live` | exit 0; 6/6 passed |
| `@processengine/transport-kafka test:live` | exit 0; 2/2 passed, including reusable SPI conformance and real-broker round trip |

Evidence:
`test-shop/.artifacts/k8s/2026-07-18T19-19-52.3NZ-live-conformance-pass/`.

### 3.5 Published-package consumer smoke — PASS

After public registry verification, `test-shop` was changed from local tarball
references to exact registry versions `0.1.0`. Commit
`c6d6fcab49f52184c0349a6b7f07bd1dcd144f27` produced image content tag
`sha-d923f6427af27545`.

- anonymous Node 22 clean install and imports: PASS;
- test-shop deterministic gate: PASS, `42/42`;
- Helm revision 34: all six application pods Ready on the exact new tag;
- repeated Kubernetes business acceptance: PASS, `16/16`.

Evidence:

- deploy: `test-shop/.artifacts/k8s/2026-07-18T20-55-36.992Z-deploy-pass/`;
- business: `test-shop/.artifacts/k8s/2026-07-18T20-59-27.257Z-business-pass/`.

## 4. Defects found and fixed

| ID | Confirmed defect | Implemented fix | Verification |
| --- | --- | --- | --- |
| DEFECT-1 | Docker build ran `npm ci` in a root-owned WORKDIR. | Own `/app` before switching to `node`. | deploy exit 0 |
| DEFECT-2 | Unquoted comma in Helm flow-mapping corrupted `FLOW_FILES`. | Quote the env value. | Helm lint/render and deploy exit 0 |
| DEFECT-3 | Outage oracle hid terminating pods and inferred failed publication from `attempt>=2`. | Wait for pod deletion and assert StatefulSet `spec=0`, `ready=0`, no pods; assert durable unpublished row without interpreting attempt count. | Kafka/Postgres outage scenarios PASS |
| DEFECT-4 | `tok-upgrade-barrier` blocked a Kafka handler and created a rollout/rebalance circular wait; common flow config also rolled unrelated services. | Commit the domain result promptly and gate only service-outbox publication; scope `FLOW_ACTIVE_VERSION` to host; split artifact activation from full-contour rollout; restore 60 s timeout and 20 s grace period. | artifact activation and full rollout PASS |
| DEFECT-5 | A caller-only Kafka publish timeout left orphan sends and allowed repeated/concurrent sends. | Global single-flight, same-message coalescing, late-result handling, finite retry budget, explicit delivery status and stoppable callers. | 10 transport unit tests plus live Kafka 2/2 |
| DEFECT-6 | Idle `pg.Pool` errors could terminate processes; new connections could wait for the OS TCP timeout, while a claimed service-outbox row stayed leased. | Always observe pool errors; bound new connections to 5 s; retain fenced claims in a recovery queue and reschedule immediately when PostgreSQL returns. | storage unit tests, focused outage PASS, full outage PASS with zero app restarts |
| TEST-1 | Live Kafka round-trip published before the new consumer group settled. | Await subscription and the documented rebalance settle window, then publish; always unsubscribe. | live Kafka 2/2 |

## 5. Remaining boundary

This is a single-broker/single-PostgreSQL developer contour. Kafka/PostgreSQL
HA and backup/restore, TLS/SASL, application authn/authz, production secret
management, network policy, autoscaling, SLOs and observability backends remain
outside this acceptance and are tracked in `docs/production-readiness/PLAN.md`.

GitHub and npm publication are separate release gates and are not claimed by
this Kubernetes report.

## 6. Operating the contour

```bash
kubectl get all -n processengine-test-shop
npm run k8s:test
npm run k8s:resilience
npm run k8s:collect
```

The Kubernetes contour is intentionally left running. Compose is stopped.
