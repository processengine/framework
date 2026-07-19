# Project Context — ProcessEngine + test-shop contour

Last verified: `2026-07-19`

## Purpose and current goal

- **Purpose**: ProcessEngine is a framework for durable, deterministic execution
  of long-running domain business processes. The canonical model is
  `processengine/docs/PROCESSENGINE_CANON.md`.
- **Completed milestone (PE-M1)**: `scam/TASK.md`.
- **Completed task (PE-M2)**: npm publication migrated to GitHub Actions trusted
  publishing. Contract: `scam/tasks/PE-M2-trusted-publishing.md`.
- **Active milestone (PE-M3)**: post-0.1.0 development foundation. Contract:
  `scam/tasks/PE-M3-post-0.1-foundation.md`. Status: `SPLIT/IN_PROGRESS`.
  - Slices 1–5 and 7 (dual local/registry contour, CI workflows, curated public
    API + honest schema profile, package/supply-chain/governance, roadmap) are
    implemented on branch `feat/post-0.1-foundation` and pass the deterministic
    and package gates.
  - **Not done**: Slice 6 (documentation rewrite), a real GitHub Actions run, and
    the full live Docker Desktop Kubernetes business/resilience acceptance.
- **Active sub-task (PE-M3-STABILIZE)**: closed the six confirmed foundation-slice
  blockers. Handoff: `scam/handoffs/PE-M3-stabilization.md`. Status: `DONE`.
- **Acceptance state**: the released `0.1.0` (GitHub `main`, three npm packages,
  tag `v0.1.0`) remains published and verified. PE-M3 work is unpushed and
  unpublished.

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

`test-shop` consumes the framework only through published package boundaries, in
two explicit modes: `registry` (exact published `0.1.0` from the committed
manifest/lockfile) and `local` (framework tarballs built from the current worktree
and staged under the ignored `.work/local-consumer/`). It never imports
neighbouring framework source.

## Accepted baseline

- Framework packages: version `0.1.0`.
- Runtime-accepted source commit:
  `6956299de7da03d8074530f0856339e0915c8146`.
- Exact application image content tag: `sha-d3eb3338ca20f71f`.
- Published tarball integrities match the release artifacts and the registry
  URLs/integrities pinned by the consumer lockfile.
- Baseline inventory: `scam/WORKSPACE_BASELINE.json`.

## Standard commands

Consumption mode is explicit; an unmoded deploy fails with a hint.

| Purpose | Command | Required environment |
| --- | --- | --- |
| bootstrap | `npm run bootstrap` | Node >=22 |
| deterministic gate (local worktree) | `npm run check:local` | Node >=22 |
| deterministic gate (published 0.1.0) | `npm run check:registry` | Node >=22 |
| pack framework | `npm run pack` | Node >=22 |
| API report / drift check | `npm --prefix processengine run api:check` | Node >=22 |
| k8s doctor | `npm run k8s:doctor` | docker-desktop k8s |
| k8s deploy (local build) | `npm run k8s:deploy:local` | docker-desktop k8s |
| k8s deploy (published) | `npm run k8s:deploy:registry` | docker-desktop k8s |
| k8s business test | `npm run k8s:test` | deployed contour |
| k8s resilience | `npm run k8s:resilience` | deployed contour |
| view state | `kubectl get all -n processengine-test-shop` | docker-desktop |

## Active decisions and contracts

- Delivery semantics are **at-least-once + idempotent processing**, producing a
  logical exactly-once domain effect; physical exactly-once is not claimed.
- This milestone keeps Apache Kafka KRaft, the canonical DSL/state model, and
  package boundaries intact.
- Package manifests, lockfiles, and registry metadata carry `Apache-2.0`. The
  user directly confirmed the license-owner decision before publication.
- npm publication authentication follows
  `docs/decisions/ADR-001-npm-trusted-publishing.md`: GitHub-hosted Actions OIDC,
  direct publish permission, and package-level denial of traditional tokens.

## Verified state

- Framework deterministic gate after PE-M2: `64` passed, `8` live tests skipped.
- Test-shop deterministic gate: `42` passed.
- Compose business acceptance: `16/16` passed.
- Kubernetes business acceptance: `16/16` passed.
- Kubernetes resilience: `8/8` passed, including real Kafka StatefulSet and
  PostgreSQL StatefulSet outages.
- Live PostgreSQL SPI: `6/6` passed; live Kafka SPI: `2/2` passed.
- Anonymous registry install/import: passed in Node 22.
- Registry-backed Helm revision 34 and repeated business gate: `16/16` passed.
- npm trusted-publisher readback: `3/3` packages match
  `processengine/framework` and `publish-npm.yml` with direct publish allowed.
- Package publishing access disallows traditional tokens for `3/3` packages;
  GitHub Actions has no `NPM_TOKEN`, npm token inventory was verified empty, and
  the former local registry credential was removed.
- Kubernetes remains running in namespace `processengine-test-shop`; Compose is
  stopped with volumes retained.

Primary evidence directories:

- `test-shop/.artifacts/k8s/2026-07-18T19-22-15.3NZ-local-gates-pass/`
- `test-shop/.artifacts/k8s/2026-07-18T19-11-45.201Z-deploy-pass/`
- `test-shop/.artifacts/k8s/2026-07-18T19-15-23.099Z-business-pass/`
- `test-shop/.artifacts/k8s/2026-07-18T19-19-07.805Z-resilience-pass/`
- `test-shop/.artifacts/k8s/2026-07-18T19-19-52.3NZ-live-conformance-pass/`
- `test-shop/.artifacts/k8s/2026-07-18T20-55-36.992Z-deploy-pass/`
- `test-shop/.artifacts/k8s/2026-07-18T20-59-27.257Z-business-pass/`

## Known constraints

- The default host shell uses Node `20.19`; package engines require Node >=22.
  PE-M2 gates used Node `22.23.1`, and the publication workflow uses Node 24.
- A real trusted OIDC publish is not yet observed because PE-M2 intentionally
  did not change versions or create a tag. The next legitimate release is the
  end-to-end OIDC/provenance proof.

## PE-M3 verified state (branch `feat/post-0.1-foundation`)

- `npm run check:local` exit 0; `npm run check:registry` exit 0.
- Framework gate: `108` passed, `8` live tests skipped.
- Test-shop deterministic gate: `51` passed, in **both** local and registry modes.
- Package smoke: runtime import, external-TypeScript-consumer compile of every
  documented entrypoint, and internal-import rejection all pass.
- API drift gate covers all published entrypoints (root + `testing`/`worker`/
  `migrations`).
- `actionlint` passes for all workflow YAML.
- **CI is NOT PASS**: the new GitHub Actions workflows (`.github/workflows/ci.yml`,
  `nightly.yml`) have only been validated locally; **no real Actions run has been
  observed**. The kind Kubernetes smoke is `NOT RUN`.
- Live Docker Desktop Kubernetes business/resilience acceptance for PE-M3 is
  `NOT RUN`; the released `0.1.0` k8s evidence below predates PE-M3.

## Current and completed work

- Active Task Contract: `scam/tasks/PE-M3-post-0.1-foundation.md` (SPLIT/IN_PROGRESS).
- Active handoff: `scam/handoffs/PE-M3-stabilization.md`.
- Completed Task Contract: `scam/tasks/PE-M2-trusted-publishing.md`;
  work record: `scam/work-records/PE-M2.md`.
- Completed Task Contract: `scam/TASK.md`; work record: `scam/work-records/PE-M1.md`.
- Release commit/tag target: `417e1d731f33de02ebd3225e9dd72f5fdff7357e`.
