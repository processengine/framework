# Project Context — ProcessEngine + test-shop contour

Last verified: `2026-07-18`

## Purpose and current goal

- **Purpose**: ProcessEngine is a framework for durable, deterministic execution
  of long-running domain business processes. The canonical model is
  `processengine/docs/PROCESSENGINE_CANON.md`.
- **Current milestone (PE-M1)**: publish the three accepted framework packages,
  verify a registry-based consumer, and create tag `v0.1.0`. Contract:
  `scam/TASK.md`.
- **Acceptance state**: all local deterministic, package, Compose, Kubernetes,
  resilience, and live SPI gates pass. GitHub `main` is published; npm is
  pending.

## System map and ownership

| Component | Responsibility | Contract owner | Repository/path |
| --- | --- | --- | --- |
| `@processengine/conductor` | Canonical model, Flow3 compiler, durable conductor runtime, SPI ports | yes | `processengine/packages/conductor` |
| `@processengine/transport-kafka` | Apache Kafka transport connector + operation worker | yes (transport SPI) | `processengine/packages/transport-kafka` |
| `@processengine/storage-postgres` | Durable PostgreSQL storage adapter + migrations | yes (storage SPI) | `processengine/packages/storage-postgres` |
| `test-shop` contracts/host-adapter/service-kit | Demo consumer glue over public package APIs | no (consumer) | `test-shop/packages/*` |
| `shop-host` | Checkout host: starts processes, HTTP API | no | `test-shop/apps/shop-host` |
| `shop-warehouse` | Reservation domain service | no | `test-shop/apps/shop-warehouse` |
| `shop-payment` | Payment domain service | no | `test-shop/apps/shop-payment` |
| Infra | Kafka 4.3.1 KRaft, PostgreSQL 16.8, Helm chart | no | `test-shop/deploy/helm/test-shop` |

`test-shop` consumes the framework through packed `.tgz` artifacts staged in
`test-shop/.framework/`; it does not import neighbouring framework source.

## Accepted baseline

- Framework packages: version `0.1.0`.
- Runtime-accepted source commit:
  `6956299de7da03d8074530f0856339e0915c8146`.
- Exact application image content tag: `sha-d3eb3338ca20f71f`.
- Tarballs were regenerated, staged in both package locations, and verified by
  package and consumer smoke tests.
- Baseline inventory: `scam/WORKSPACE_BASELINE.json`.

## Standard commands

| Purpose | Command | Required environment |
| --- | --- | --- |
| bootstrap | `npm run bootstrap` | Node >=22 |
| deterministic gate | `npm run check` | Node >=22 |
| pack framework | `npm run pack` | Node >=22 |
| k8s doctor | `npm run k8s:doctor` | docker-desktop k8s |
| k8s deploy | `npm run k8s:deploy` | docker-desktop k8s |
| k8s business test | `npm run k8s:test` | deployed contour |
| k8s resilience | `npm run k8s:resilience` | deployed contour |
| k8s collect evidence | `npm run k8s:collect` | deployed contour |
| view state | `kubectl get all -n processengine-test-shop` | docker-desktop |

## Active decisions and contracts

- Delivery semantics are **at-least-once + idempotent processing**, producing a
  logical exactly-once domain effect; physical exactly-once is not claimed.
- This milestone keeps Apache Kafka KRaft, the canonical DSL/state model, and
  package boundaries intact.
- Package manifests and lockfiles currently carry `Apache-2.0`. Confirmation of
  the license-owner decision is still required immediately before npm publish.

## Verified state

- Framework deterministic gate: `57` passed, `8` live tests skipped.
- Test-shop deterministic gate: `42` passed.
- Compose business acceptance: `16/16` passed.
- Kubernetes business acceptance: `16/16` passed.
- Kubernetes resilience: `8/8` passed, including real Kafka StatefulSet and
  PostgreSQL StatefulSet outages.
- Live PostgreSQL SPI: `6/6` passed; live Kafka SPI: `2/2` passed.
- Kubernetes remains running in namespace `processengine-test-shop`; Compose is
  stopped with volumes retained.

Primary evidence directories:

- `test-shop/.artifacts/k8s/2026-07-18T19-22-15.3NZ-local-gates-pass/`
- `test-shop/.artifacts/k8s/2026-07-18T19-11-45.201Z-deploy-pass/`
- `test-shop/.artifacts/k8s/2026-07-18T19-15-23.099Z-business-pass/`
- `test-shop/.artifacts/k8s/2026-07-18T19-19-07.805Z-resilience-pass/`
- `test-shop/.artifacts/k8s/2026-07-18T19-19-52.3NZ-live-conformance-pass/`

## Known constraints and publication risks

- The host shell uses Node `20.19`; package engines require Node >=22. App and
  live conformance execution used Node `22.13.0` containers. The host's
  `EBADENGINE` warning did not change manifests or lockfiles.
- npm authentication, ownership of the `@processengine` scope, and availability
  of version `0.1.0` remain external publication gates until checked.
- If registry publication succeeds, `test-shop` must be switched to registry
  versions and re-smoked before tag `v0.1.0` is created.

## Active task and next result

- Task Contract: `scam/TASK.md`.
- Work record: `scam/work-records/PE-M1.md`.
- Next result: npm authentication/scope/version preflight. npm publish itself
  waits for the recorded license-owner confirmation.
