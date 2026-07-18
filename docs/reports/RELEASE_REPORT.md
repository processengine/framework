# Release Report — ProcessEngine 0.1.0

- **Date**: 2026-07-18
- **Milestone**: PE-M1
- **Runtime-accepted commit**: `6956299de7da03d8074530f0856339e0915c8146`
- **Runtime image tag**: `sha-d3eb3338ca20f71f`
- **Package metadata license**: Apache-2.0
- **Release state**: local acceptance PASS; GitHub/npm publication pending

## 1. Acceptance summary

| Gate | Status | Evidence |
| --- | --- | --- |
| deterministic/package smoke | PASS, exit 0 | `test-shop/.artifacts/k8s/2026-07-18T19-22-15.3NZ-local-gates-pass/` |
| Compose business 16/16 | PASS, exit 0 | same directory, `compose-test.log` |
| Kubernetes deploy/image identity | PASS, exit 0 | `test-shop/.artifacts/k8s/2026-07-18T19-11-45.201Z-deploy-pass/` |
| Kubernetes business 16/16 | PASS, exit 0 | `test-shop/.artifacts/k8s/2026-07-18T19-15-23.099Z-business-pass/` |
| Kubernetes resilience 8/8 | PASS, exit 0 | `test-shop/.artifacts/k8s/2026-07-18T19-19-07.805Z-resilience-pass/` |
| PostgreSQL/Kafka live SPI | PASS, exits 0; 6/6 and 2/2 | `test-shop/.artifacts/k8s/2026-07-18T19-19-52.3NZ-live-conformance-pass/` |

Full runtime detail is in `docs/reports/K8S_ACCEPTANCE_REPORT.md`.

## 2. GitHub

- Target: `https://github.com/processengine/framework`
- Target branch: `main`
- Status: **PENDING** — the accepted implementation and evidence-backed reports
  are committed locally first; no GitHub push is claimed yet.
- Annotated tag `v0.1.0`: **NOT CREATED**. It may be created only after all
  three npm packages publish and pass registry-install verification.

The repository excludes `node_modules`, `dist`, generated tarballs/caches,
`.artifacts`, `.claude`, `.env`, `.npmrc`, kubeconfig, tokens and Kubernetes
Secret values.

## 3. npm packages

Target registry: `https://registry.npmjs.org`, public access. Required order:

| Order | Package | Version | Current status |
| --- | --- | --- | --- |
| 1 | `@processengine/conductor` | 0.1.0 | READY; NOT PUBLISHED |
| 2 | `@processengine/transport-kafka` | 0.1.0 | READY; NOT PUBLISHED |
| 3 | `@processengine/storage-postgres` | 0.1.0 | READY; NOT PUBLISHED |

`test-shop` is not an npm publication target.

Pre-publication checks completed:

- versions and dependency ranges are internally consistent;
- current manifests and lockfiles contain Apache-2.0 rather than `UNLICENSED`;
- all three tarballs contain LICENSE and only intended package files;
- clean tarball install/public-import smoke passed;
- deterministic, live SPI and contour gates passed.

Owner confirmation of the Apache-2.0 licensing decision has not yet been
recorded in this task. Per the recovery instruction, that confirmation is
requested only immediately before `npm publish`. Registry auth/scope/version
availability and any 2FA prompt are also publication-time gates. No version bump
will be inferred if 0.1.0 is unavailable.

Post-publication registry install, conversion of test-shop from local tarballs,
key live checkout, and `v0.1.0` tagging remain **NOT PERFORMED**.

## 4. Fixes included

- DEFECT-1/2: Docker WORKDIR ownership and Helm `FLOW_FILES` rendering.
- DEFECT-3: truthful actual-outage oracle and durable-outbox acceptance.
- DEFECT-4: asynchronous completion gate, host-only flow activation and
  separate full-contour rollout scenario.
- DEFECT-5: bounded single-flight Kafka publication with explicit unknown
  delivery semantics and late-result handling.
- DEFECT-6: PostgreSQL idle-pool error handling, bounded connect attempts and
  fenced service-outbox claim recovery.
- TEST-1: live Kafka consumer-group readiness race removed.
- Package metadata and lockfiles normalized to Apache-2.0.

## 5. Remaining boundary

The accepted contour is a developer reference deployment, not a production HA
claim. Production work remains tracked in `docs/production-readiness/PLAN.md`
and the existing `scam/tasks/PR*.md` files.
