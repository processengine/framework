# Project Context — ProcessEngine + test-shop contour

Last verified: `2026-07-18`

## Purpose and current goal

- **Purpose**: ProcessEngine is a framework for durable, deterministic execution
  of long-running domain business processes. It separates process control logic
  and execution guarantees from domain service logic. See canonical model in
  `processengine/docs/PROCESSENGINE_CANON.md`.
- **Current milestone (PE-M1)**: bring the milestone to a *verified* local Docker
  Desktop Kubernetes contour, publish sources (GitHub) and the three framework
  npm packages, and produce a production-readiness plan. Contract: `scam/TASK.md`.
- **Observable result**: real contour running on `docker-desktop` with all
  deterministic/business/resilience gates PASS or honestly FAIL/BLOCKED, plus
  published artifacts and reports.

## System map and ownership

| Component | Responsibility | Contract owner | Repository/path |
| --- | --- | --- | --- |
| `@processengine/conductor` | Canonical model, Flow3 compiler, durable conductor runtime, SPI ports | yes | `processengine/packages/conductor` |
| `@processengine/transport-kafka` | Apache Kafka transport connector + operation worker | yes (transport SPI) | `processengine/packages/transport-kafka` |
| `@processengine/storage-postgres` | Durable PostgreSQL storage adapter + migrations | yes (storage SPI) | `processengine/packages/storage-postgres` |
| `test-shop` contracts/host-adapter/service-kit | Demo consumer glue over public package APIs | no (consumer) | `test-shop/packages/*` |
| `shop-host` | Checkout host: starts processes, HTTP API | no | `test-shop/apps/shop-host` |
| `shop-warehouse` | Reservation domain service (worker) | no | `test-shop/apps/shop-warehouse` |
| `shop-payment` | Payment domain service (worker) | no | `test-shop/apps/shop-payment` |
| Infra | Kafka 4.3.1 KRaft, PostgreSQL 16.8, Helm chart | no | `test-shop/deploy/helm/test-shop` |

`test-shop` consumes the framework only through packed `.tgz` artifacts staged in
`test-shop/.framework/` — never through neighbouring source paths.

## Current compatible baseline

- Framework + all three packages: version `0.1.0`.
- Tarballs staged (matching bytes) in `processengine/.packages/` and
  `test-shop/.framework/`: conductor 45391B, storage-postgres 16008B,
  transport-kafka 13230B (pre-license-change bytes; re-packed after Apache-2.0).
- Full baseline snapshot: `scam/WORKSPACE_BASELINE.json`.

## Standard commands

| Purpose | Command | Required environment |
| --- | --- | --- |
| bootstrap | `npm run bootstrap` | Node ≥22 |
| deterministic gate | `npm run check` | Node ≥22 |
| pack framework | `npm run pack` | Node ≥22 |
| k8s doctor | `npm run k8s:doctor` | docker-desktop k8s |
| k8s deploy | `npm run k8s:deploy` | docker-desktop k8s |
| k8s business test | `npm run k8s:test` | deployed contour |
| k8s resilience | `npm run k8s:resilience` | deployed contour |
| k8s collect evidence | `npm run k8s:collect` | deployed contour |
| view state | `kubectl get all -n processengine-test-shop` | docker-desktop |

## Active decisions and contracts

- Delivery is **at-least-once + idempotent processing** → logical exactly-once
  effect. Never labelled physical exactly-once. (canon §2.9)
- Fixed architecture (this milestone): Apache Kafka KRaft only; test-shop uses
  packed npm artifacts; DSL/state model frozen absent a proven defect.
- License: **Apache-2.0** applied to all three published packages (was UNLICENSED).

## Current state

- Confirmed: framework `check` 48 passed / 8 skipped (live suites); test-shop
  `check` 37 passed. (`npm run bootstrap`, 2026-07-18, exit 0.)
- In progress: Docker Desktop Kubernetes deploy + live acceptance + resilience.
- Not yet done: npm/GitHub publication, reports, production-readiness plan.

## Known constraints and risks

- `CONSTRAINT`: local host Node is 20.19.0; Node 22.23.1 provided via nvm. Project
  `engines`/lockfiles unchanged.
- `RISK`: `@processengine` npm scope and `v0.1.0` availability/auth unknown until
  checked → may BLOCK publication.
- `UNCERTAINTY`: live resilience timing under Docker Desktop.

## Active task and next milestone

- Task Contract: `scam/TASK.md`.
- Next single result: green Docker Desktop Kubernetes deploy with ≥2 ready
  replicas per app and passing probes.

## Recent work records

- `PE-M1` → `scam/work-records/PE-M1.md` (created before DONE).
