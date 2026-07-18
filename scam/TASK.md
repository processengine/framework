# Task Contract: PE-M1 — Local Kubernetes contour to verified release 0.1.0

## Outcome

The packaged ProcessEngine framework and the `test-shop` consumer run as a real,
long-lived contour on Docker Desktop Kubernetes (Apache Kafka KRaft + PostgreSQL
with PVC, ≥2 replicas of each application). All deterministic, business
acceptance and resilience gates either PASS with observed evidence or are
honestly recorded as FAIL/BLOCKED. Sources + docs are published to GitHub `main`;
the three framework packages are published to npm under `@processengine` at
`0.1.0`; a Kubernetes acceptance report, a release report and a production
readiness plan (with executable SCAM task files for every P0/P1) exist. The
contour is left running.

## Scope

### In scope

- Environment verification and Docker Desktop Kubernetes deployment via the
  existing `npm run bootstrap | k8s:doctor | k8s:deploy` scripts.
- Full test execution: `npm run check`, `k8s:test`, `k8s:resilience`, and any
  live PG/Kafka suites against the deployed contour.
- Defect fixes strictly required for deployment, acceptance or safe publication.
- GitHub publication and npm publication of the three framework packages.
- Apache-2.0 license application to all published packages.
- Production readiness PLAN.md + P0/P1 SCAM task files.
- SCAM context/record/report documents.

### Out of scope

- Redesign of DSL, state model or the fixed architecture (canon §2 principles).
- Substituting Kafka with any other broker outside unit tests.
- Implementing the production readiness roadmap itself (only the plan).
- Publishing `test-shop` to npm (it is a demo consumer).
- `engines`/lockfile/package-manager changes made only to fit local toolchain.

## Allowed changes

| Repository/component | Paths | Permission |
| --- | --- | --- |
| framework | `processengine/**` | read/write |
| consumer | `test-shop/**` | read/write |
| orchestration | `scripts/**`, root `package.json` | read/write |
| docs/reports | `docs/**`, `scam/**`, root `*.md` | read/write |

## Sources to read

- This prompt (frozen acceptance).
- `processengine/docs/PROCESSENGINE_CANON.md`, root `DOD.md`, `test-shop/DOD.md`.
- `RELEASE_STATUS.md`, existing `scripts/*.mjs`, Helm chart, flows v1/v2.
- SCAM `METHOD.md` / `DOCUMENTATION.md`.

## Acceptance — frozen (defined by the task prompt)

- [x] Contour deployed on `docker-desktop`: namespace, Kafka KRaft, Postgres+PVC,
      migrations applied, topics created, ≥2 ready replicas per app, probes green,
      no CrashLoop/unexpected Pending, checkout accepted, data survives pod restart,
      re-deploy is a safe upgrade.
- [x] `npm run check` PASS (deterministic).
- [x] `npm run k8s:test` business scenarios PASS (all 16 terminal states, exact
      terminal payloads, duplicate/idempotency/anomaly matrix, flow v1→v2).
- [x] `npm run k8s:resilience` PASS (multi-host, pod-kill continuation, lease/
      fencing, outbox/inbox, Kafka/PG outage recovery, rolling v1→v2, data durability).
- [x] Evidence collected under `test-shop/.artifacts/k8s/**`; reports written.
- [x] GitHub `main` push == local commit; sources/docs/helm/migrations included,
      no secrets/node_modules/dist.
- [x] Three packages published to npm `@processengine@0.1.0`, verified by clean
      install; `test-shop` repointed to published versions and re-smoked.
- [ ] Annotated tag `v0.1.0` pushed only after npm publish succeeds.
- [x] `docs/production-readiness/PLAN.md` + P0/P1 SCAM task files exist.
- [x] Evidence: the local acceptance commands complete with exit code 0.

## Owning gate

`acceptance` (Docker Desktop Kubernetes business + resilience gates).

## External actions

Allowed by prompt: GitHub push to `main`, npm publish of the three packages,
annotated tag push after publish.

Require separate user confirmation: interactive `gh auth login` / npm login /
2FA-OTP (never paste tokens into chat or files); any version bump if `0.1.0`
already exists on the registry; any destructive Docker/Kubernetes cleanup beyond
this project's own namespace/resources/images/volumes.

## Assumptions and risks

- `CONSTRAINT`: host Node is 20.19; Node 22.13.0 containers were used for app
  and live SPI execution. Project `engines`/lockfiles remain unchanged.
- `RESOLVED`: the user directly confirmed Apache-2.0; npm scope ownership,
  version availability, publication, and anonymous registry install passed.

## Verified acceptance evidence

- Runtime source commit: `6956299de7da03d8074530f0856339e0915c8146`.
- Image content tag: `sha-d3eb3338ca20f71f`.
- Deterministic/package/Compose:
  `test-shop/.artifacts/k8s/2026-07-18T19-22-15.3NZ-local-gates-pass/`.
- Kubernetes deploy/business/resilience:
  `2026-07-18T19-11-45.201Z-deploy-pass`,
  `2026-07-18T19-15-23.099Z-business-pass`, and
  `2026-07-18T19-19-07.805Z-resilience-pass` under
  `test-shop/.artifacts/k8s/`.
- Live PostgreSQL/Kafka SPI:
  `test-shop/.artifacts/k8s/2026-07-18T19-19-52.3NZ-live-conformance-pass/`.

## Publication state

Local acceptance, GitHub source publication, npm publication, registry install,
and registry-backed Kubernetes business verification are complete. The initial
accepted source-and-reports push was independently verified at
`8968afb41a7303c86a8f2a734561f2cb82ed7fb4`. Only tag `v0.1.0` remains
unchecked until it is created, pushed, and read back.

## Stop conditions

- npm scope/name unavailable or auth interactive → record BLOCKED, ask user.
- Any gate needs weakening to pass → stop, record FAIL.
- A defect implies DSL/state redesign → record as separate contradiction, do not
  silently redesign.
