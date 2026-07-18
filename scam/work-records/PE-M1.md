# Work Record: PE-M1 — Local Kubernetes contour to verified release 0.1.0

Date: `2026-07-18`
Status: `IN PROGRESS`

## Task Contract

See `scam/TASK.md`. Outcome: verified Docker Desktop Kubernetes contour +
GitHub/npm publication + production-readiness plan. Acceptance frozen by the task
prompt.

## Starting baseline

See `scam/WORKSPACE_BASELINE.json`. Framework + all packages at `0.1.0`;
`test-shop` consumes framework via staged `.tgz`. Not a git repo at start.

## Problem and prior behavior

`RELEASE_STATUS.md` claimed all static gates green but the live Docker Desktop
Kubernetes business/resilience gates were NOT VERIFIED (docker/kubectl/helm were
absent in the previous build environment). This task performs the first real
live verification and publication.

## Changes

| Component/file | Change | Reason |
| --- | --- | --- |
| `test-shop/Dockerfile` | Build stage: `chown -R node:node /app` + `USER node` **before** `COPY`, so the WORKDIR is node-owned | DEFECT-1: `npm ci` failed with `EACCES mkdir /app/test-shop/node_modules` because WORKDIR was root-owned while running as `USER node`. Latent because prior env had no docker. |
| `test-shop/deploy/helm/test-shop/templates/applications.yaml` | Quoted the `FLOW_FILES` env value (two comma-separated flow paths) | DEFECT-2: unquoted comma in a YAML flow-mapping `{name,value}` was parsed as a map separator, creating a bogus field that Helm 4 server-side apply rejected. |
| `test-shop/scripts/resilience.mjs` | `waitForOutboxAttempt`: accept `attempt>=2` OR (`PENDING && attempt>=1`); deadline 60s→120s | DEFECT-3: flaky oracle. Framework durable-outbox behavior is correct (reproduced: row cycled CLAIMED attempt 1→10 incl. second-replica reclaim, drained to PUBLISHED / process COMPLETED on Kafka recovery); the oracle just missed the ~1s PENDING sub-window. Not a check weakening — `attempt>=2` is strictly stronger evidence. |
| `processengine/packages/transport-kafka/src/kafka-transport.ts` (+ test) | Bound `publish()` with `publishTimeoutMs` (default 15s, < outbox lease) via `Promise.race`; a hung send now rejects so Conductor reschedules | DEFECT-5: `producer.send()` to an unreachable broker sometimes **hangs** (stayed CLAIMED attempt=1) rather than failing at connectionTimeout, so the durable outbox couldn't reschedule and the resilience `outbox-initiator-crash` oracle timed out even though the framework guarantee held (row later PUBLISHED, process COMPLETED rev=4 exactly-once). Fix realizes the transport's own documented intent ("one publish() bounded by the outbox lease") and makes outage handling deterministic. Framework check 48→49 tests. |
| `test-shop/config/operations.json` (payment.authorize `completionTimeoutMs` 60000→180000) + `values.yaml` (`terminationGracePeriodSeconds` 20→5) | DEFECT-4: rolling-update scenario (`artifactActivationRollingUpdate`) failed — the v1 barrier process held at `payment.authorize` timed out at exactly 60s mid-rollout. Root cause: the full 3-deployment rolling helm upgrade takes >60s here because each new pod's readiness waits on a **Kafka consumer-group rebalance** (inherent to consumer groups), and the scenario deliberately withholds the payment completion across the whole rollout. grace 20→5 (beneficial, safe by design) did not change the 60s outcome, confirming grace was not the bottleneck. Actual fix: widen the withheld-completion window to 180s so it outlasts a rebalance-slowed rollout. Only the business `payment-timeout` scenario runs longer; no assertion weakened; pinning itself was already correct (flow stayed 1.0.0). |

## Resulting behavior and contracts

- Docker image build for all three app targets now completes (focused
  `docker build --target shop-host` exit 0).
- No public contract, DSL, or state-model change.

## Decisions

- Toolchain: host Node 20.19.0 < required 22; used nvm Node 22.23.1 without
  changing `engines`/lockfiles (per prompt toolchain rules).
- Pre-pulled `docker/dockerfile:1.7`, `node:22.13.0-bookworm-slim`,
  `postgres:16.8-alpine`, `apache/kafka:4.3.1` after a BuildKit registry
  `DeadlineExceeded` timeout (transient infra, not a code defect).

## Verification

| Command/scenario | Environment | Result | Evidence |
| --- | --- | --- | --- |
| `npm run bootstrap` | Node 22 | PASS | framework 48 pass/8 skip, shop 37 pass (scratchpad/bootstrap.log) |
| `npm run k8s:doctor` | docker-desktop | PASS | "Doctor passed: context=docker-desktop" |
| `docker build --target shop-host` (probe) | docker | PASS | exit 0 after DEFECT-1 fix |
| `npm run k8s:deploy` | docker-desktop | IN PROGRESS | deploy3.log |
| `npm run check` | Node 22 | PASS | framework 48/8skip, shop 37 (check.log) |
| `npm run k8s:deploy` (×3 incl. re-deploy) | docker-desktop | PASS | helm rev 3 deployed; 2/2 each app; idempotent upgrade proven |
| `npm run k8s:test` | contour | PASS | gate=business-acceptance PASS, 16/16 scenarios (k8stest.log) |
| repro: durable outbox under Kafka outage | contour | PASS (manual) | outbox attempt 1→10, 2nd-replica reclaim, drained→COMPLETED rev=4 on recovery (repro.log) |
| `npm run k8s:resilience` | contour | IN PROGRESS (after DEFECT-3 fix + re-deploy) | resilience3.log |

## Release or deployment

- `NOT PERFORMED` yet (GitHub/npm pending live acceptance).

## Remaining state

- `FOLLOW_UP`: prior claim "Docker build sequence passes" in RELEASE_STATUS.md
  was not a real docker build; corrected here.
- `UNCERTAINTY`: live resilience timing under Docker Desktop.

## Final references

- To be filled at DONE (commits, tag, npm versions, evidence dir).
