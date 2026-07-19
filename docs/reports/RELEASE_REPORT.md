# Release Report — ProcessEngine 0.1.0

- **Date**: 2026-07-18
- **Milestone**: PE-M1
- **Runtime-accepted commit**: `6956299de7da03d8074530f0856339e0915c8146`
- **Runtime image tag**: `sha-d3eb3338ca20f71f`
- **Package metadata license**: Apache-2.0
- **Release state**: **COMPLETE**

## 1. Acceptance summary

| Gate | Status | Evidence |
| --- | --- | --- |
| deterministic/package smoke | PASS, exit 0 | `test-shop/.artifacts/k8s/2026-07-18T19-22-15.3NZ-local-gates-pass/` |
| Compose business 16/16 | PASS, exit 0 | same directory, `compose-test.log` |
| Kubernetes deploy/image identity | PASS, exit 0 | `test-shop/.artifacts/k8s/2026-07-18T19-11-45.201Z-deploy-pass/` |
| Kubernetes business 16/16 | PASS, exit 0 | `test-shop/.artifacts/k8s/2026-07-18T19-15-23.099Z-business-pass/` |
| Kubernetes resilience 8/8 | PASS, exit 0 | `test-shop/.artifacts/k8s/2026-07-18T19-19-07.805Z-resilience-pass/` |
| PostgreSQL/Kafka live SPI | PASS, exits 0; 6/6 and 2/2 | `test-shop/.artifacts/k8s/2026-07-18T19-19-52.3NZ-live-conformance-pass/` |
| anonymous npm install/import | PASS in clean Node 22 container | public npm registry |
| registry-backed deploy/image identity | PASS, Helm revision 34 | `test-shop/.artifacts/k8s/2026-07-18T20-55-36.992Z-deploy-pass/` |
| registry-backed Kubernetes business 16/16 | PASS, exit 0 | `test-shop/.artifacts/k8s/2026-07-18T20-59-27.257Z-business-pass/` |

Full runtime detail is in `docs/reports/K8S_ACCEPTANCE_REPORT.md`.

## 2. GitHub

- Target: `https://github.com/processengine/framework`
- Target branch: `main`
- Status: **PASS** — `main` was pushed and independently read back from GitHub.
- Initial accepted source-and-reports commit:
  `8968afb41a7303c86a8f2a734561f2cb82ed7fb4`; local `main`, `ls-remote`, and
  the GitHub commits API returned the same SHA after publication.
- Release commit:
  `417e1d731f33de02ebd3225e9dd72f5fdff7357e`; local `main`, remote `main`,
  and the GitHub commits API agreed before tagging.
- Annotated tag `v0.1.0`: **PUBLISHED**; its local and dereferenced remote
  targets both equal the release commit above.

The repository excludes `node_modules`, `dist`, generated tarballs/caches,
`.artifacts`, `.claude`, `.env`, `.npmrc`, kubeconfig, tokens and Kubernetes
Secret values.

## 3. npm packages

Target registry: `https://registry.npmjs.org`, public access. Required order:

| Order | Package | Version | Current status |
| --- | --- | --- | --- |
| 1 | `@processengine/conductor` | 0.1.0 | PUBLISHED; PUBLIC READ VERIFIED |
| 2 | `@processengine/transport-kafka` | 0.1.0 | PUBLISHED; PUBLIC READ VERIFIED |
| 3 | `@processengine/storage-postgres` | 0.1.0 | PUBLISHED; PUBLIC READ VERIFIED |

`test-shop` is not an npm publication target.

Publication verification completed:

- versions and dependency ranges are internally consistent;
- current manifests and lockfiles contain Apache-2.0 rather than `UNLICENSED`;
- all three tarballs contain LICENSE and only intended package files;
- anonymous clean registry install/public-import smoke passed in Node 22;
- deterministic, live SPI and contour gates passed.
- registry metadata reports `0.1.0`, `Apache-2.0`, and the same SHA-512
  integrity values recorded by the release tarballs and consumer lockfile;
- `test-shop` now pins registry version `0.1.0` for all three packages and has
  no `.framework` dependency or staging step;
- registry-backed image `sha-d923f6427af27545` passed Helm revision 34 and the
  repeated Kubernetes business gate `16/16`.

The user directly confirmed the Apache-2.0 license-owner decision in this task
immediately before publication. The npm account had owner access to the
`@processengine` scope. The user-provided project publication token was stored
as the GitHub Actions secret `NPM_TOKEN` and used without writing it into the
workspace.

Post-release note (2026-07-19): the preceding paragraph records how `0.1.0` was
originally published. PE-M2 subsequently configured `publish-npm.yml` as the
trusted GitHub Actions publisher for all three packages, set package publishing
access to disallow traditional tokens, deleted the GitHub secret, revoked the
only project npm token, verified empty token inventory, and removed the local
credential. No package or tag was changed by that migration.

Post-publication deploy evidence:

- `test-shop/.artifacts/k8s/2026-07-18T20-55-36.992Z-deploy-pass/`;
- `test-shop/.artifacts/k8s/2026-07-18T20-59-27.257Z-business-pass/`.

The npm packages, registry consumer, GitHub source, and annotated release tag
are all published and verified.

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
