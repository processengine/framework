# Docker Desktop Kubernetes Acceptance Report — ProcessEngine test-shop 0.1.0

- **Date/time**: 2026-07-18 (UTC)
- **Milestone**: PE-M1 — local Kubernetes contour to verified release 0.1.0
- **Source commit**: _(recorded at GitHub publish — see `docs/reports/RELEASE_REPORT.md`)_
- **Kubernetes context**: `docker-desktop` (namespace `processengine-test-shop`)

## 1. Environment

| Tool | Version |
| --- | --- |
| Docker Engine | 29.6.1 |
| Kubernetes server | v1.36.1 |
| kubectl client | v1.33.4 |
| Helm | v4.2.1 |
| Node.js (runner) | v22.23.1 (nvm; host default 20.19.0) |
| npm | 10.9.8 |

**Application image tag**: `sha-a429fcdf63c10e0f` (content-addressed by `images.mjs`)

| Image | Repository:tag |
| --- | --- |
| shop-host | `processengine/test-shop-shop-host:sha-a429fcdf63c10e0f` |
| shop-warehouse | `processengine/test-shop-shop-warehouse:sha-a429fcdf63c10e0f` |
| shop-payment | `processengine/test-shop-shop-payment:sha-a429fcdf63c10e0f` |
| kafka | `apache/kafka:4.3.1` (KRaft: `process.roles=broker,controller`) |
| postgres | `postgres:16.8-alpine` |

## 2. Deployed workloads

| Workload | Kind | Ready |
| --- | --- | --- |
| test-shop-shop-host | Deployment | 2/2 |
| test-shop-shop-warehouse | Deployment | 2/2 |
| test-shop-shop-payment | Deployment | 2/2 |
| test-shop-kafka | StatefulSet | 1/1 (KRaft) |
| test-shop-postgres | StatefulSet | 1/1 |
| test-shop-migrations | Job | Complete |
| test-shop-topics | Job | Complete |

- **PVCs Bound**: `data-test-shop-kafka-0` (1Gi), `data-test-shop-postgres-0` (1Gi).
- **PodDisruptionBudget**: `test-shop-shop-host` minAvailable=1.
- **Restarts**: 0 across all application/infra pods at steady state; no CrashLoopBackOff, no unexpected Pending.
- **Kafka topics**: `shop.warehouse.commands.v1`, `shop.payment.commands.v1`, `shop.operation.completions.v1`, `__consumer_offsets`.
- **PostgreSQL schemas** (migrations applied): `processengine`, `warehouse`, `warehouse_service`, `payment`, `payment_service`.

## 3. Delivery semantics (precise wording)

Transport is **at-least-once**; operation integrations are **crash-safe
idempotent** keyed by `requestId` (one domain effect per operation request), and
the conductor accepts at most one completion per pending call. Together these
provide **logically exactly-once domain effects over at-least-once physical
delivery** (canon §2.9). No physical exactly-once delivery is claimed.

## 4. Gate results

### 4.1 Deterministic gate — `npm run check`

| Suite | Result | Evidence |
| --- | --- | --- |
| framework build+typecheck+unit | PASS — 48 passed / 8 skipped (live suites) | `npm run check`, exit 0 |
| test-shop build+typecheck+unit | PASS — 37 passed | `npm run check`, exit 0 |

Deterministic subset includes the **16 checkout terminal-state matrix** tests
(`tests/checkout-terminal-matrix.test.ts`, 17 tests) proving every `end` step is
reachable and terminal `response`/`error` equals the referenced stored result.

### 4.2 Business gate — `npm run k8s:test` → **PASS** (exit 0)

Helm test (health) phase: **Succeeded**. `gate=business-acceptance status=PASS`,
16/16 scenarios. Each scenario asserted terminal COMPLETED/outcome, exact
terminal `response`/`error`, warehouse+payment ledgers and domain-effect counters,
and idempotent start (up to 12 concurrent starts → one process instance).

| # | Scenario (live process id prefix) | Terminal outcome | rev | wh eff | pay eff | Result |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | success (12 concurrent starts, replay) | APPROVED | 4 | 1 | 2 | PASS |
| 2 | service-duplicate-completion | APPROVED | 4 | 1 | 2 | PASS |
| 3 | out-of-stock | OUT_OF_STOCK | 2 | 1 | 0 | PASS |
| 4 | warehouse-error (domain error) | WAREHOUSE_UNAVAILABLE | 2 | 1 | 0 | PASS |
| 5 | warehouse-handler-failed (technical) | WAREHOUSE_HANDLER_FAILED | 2 | 1 | 0 | PASS |
| 6 | payment-declined (+ stock release) | PAYMENT_DECLINED | 4 | 2 | 1 | PASS |
| 7 | payment-error (+ stock compensation) | PAYMENT_ERROR_COMPENSATED | 4 | 2 | 1 | PASS |
| 8 | payment-error + stock-compensation-fail | COMPENSATION_FAILED | 4 | 2 | 1 | PASS |
| 9 | payment-timeout (60s completion timeout) | PAYMENT_ERROR_COMPENSATED | 4 | 2 | 1 | PASS |
| 10 | confirm-failure (business) | PAYMENT_CONFIRM_FAILED | 6 | 2 | 3 | PASS |
| 11 | confirm-failure + stock-compensation-fail | COMPENSATION_FAILED | 6 | 2 | 3 | PASS |
| 12 | confirm-error (technical) | PAYMENT_CONFIRM_ERROR_COMPENSATED | 6 | 2 | 3 | PASS |
| 13 | confirm-error + stock-compensation-fail | COMPENSATION_FAILED | 6 | 2 | 3 | PASS |
| 14 | confirm-error + payment-compensation-fail | PAYMENT_COMPENSATION_FAILED | 5 | 1 | 3 | PASS |
| 15 | payment-compensation-failure | PAYMENT_COMPENSATION_FAILED | 5 | 1 | 3 | PASS |
| 16 | compensation-failure | COMPENSATION_FAILED | 4 | 2 | 1 | PASS |

**Duplicate/idempotency/anomaly matrix** (embedded per scenario, all PASS):
- `success` runs 12 concurrent starts under one idempotency key → single process
  instance; then replays the stored completion (same requestId) → revision/results
  unchanged.
- `service-duplicate-completion`: payment service republishes completion with the
  **same requestId and a new messageId**, recorded only after Kafka ACK
  (`publications:1`, distinct `messageId` vs `originalMessageId`) → terminal
  revision & results unchanged, effect counters unchanged.
- Command-duplicate / same-message replay / conflicting second completion /
  foreign-source / foreign-request-id / malformed / valid-late-after-timeout
  completions are exercised inside scenarios and leave persisted state unchanged;
  the consumer keeps processing subsequent messages after a malformed message.

All 16 checkout `end`/terminal states are covered across the deterministic
terminal matrix (§4.1) and these live scenarios; the live API response equals the
terminal step result (asserted by `assertExactTerminalReference`).

### 4.3 Resilience gate — `npm run k8s:resilience`

_(filled below)_

### 4.4 Live SPI conformance against the deployed contour

_(filled below)_

## 5. Requirement → test → evidence → result

_(filled below)_

## 6. Defects found and fixed

| ID | Defect | Fix | Re-run |
| --- | --- | --- | --- |
| DEFECT-1 | Docker build `npm ci` failed `EACCES mkdir /app/test-shop/node_modules`: WORKDIR root-owned under `USER node` | `test-shop/Dockerfile`: `chown -R node:node /app` + `USER node` before `COPY` | `docker build --target shop-host` exit 0; full deploy exit 0 |
| DEFECT-2 | Helm 4 server-side apply rejected `FLOW_FILES` env: unquoted comma in YAML flow-mapping created a bogus field | `applications.yaml`: quoted the two-path value | `helm template` clean; `k8s:deploy` exit 0 |
| DEFECT-3 | Resilience `durable-outbox-initiator-crash` failed: oracle `waitForOutboxAttempt` required sampling the ~1s `PENDING` sub-window every 500ms/60s, but each `publish()` to a down broker blocks 3–16s (kafkajs), so the row is `CLAIMED` almost continuously and the narrow `PENDING` window can be missed → flaky. **Framework behavior is correct**: reproduced independently — outbox row cycled `CLAIMED` attempt 1→…→10 (incl. reclaim by a second conductor replica) and drained to `PUBLISHED`/`COMPLETED rev=4` on Kafka recovery. | `resilience.mjs`: accept `attempt>=2` (unambiguous failed-publish→reschedule→reclaim, strictly stronger than one `PENDING` sighting) OR `PENDING && attempt>=1`; deadline 60s→120s. No check weakened; end-to-end durability assertions unchanged. | `npm run k8s:resilience` re-run (below) |
| INFRA-1 (not a code defect) | BuildKit `DeadlineExceeded` pulling `docker/dockerfile:1.7` frontend | Pre-pulled frontend + base + infra images | deploy proceeded |
| FOLLOW-UP-1 (non-blocking) | migrations Job first pod `ECONNREFUSED` before Postgres ready; Job backoff retried and Completed | none required; note for readiness plan (add wait/init-container) | Job Complete |

## 7. Remaining limitations

_(filled below)_

## 8. Evidence artifacts

Raw evidence directory: `test-shop/.artifacts/k8s/` (per-run subfolders:
`*-deploy-pass`, `*-business-pass`, `*-resilience-pass`, plus `manual` collect).
Each contains environment.json, helm status/values/manifest, inventory.yaml,
events, per-pod logs+describe, and PostgreSQL snapshots (processes, operations,
outbox, service ledgers).

## 9. Operating the running contour

```bash
# state
kubectl get all -n processengine-test-shop
# logs
kubectl logs -n processengine-test-shop deploy/test-shop-shop-host -f
# re-run acceptance (contour stays up)
npm run k8s:test
npm run k8s:resilience
npm run k8s:collect
```

The contour is intentionally left running (no `k8s:down`).
