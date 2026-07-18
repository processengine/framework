# Release Report — ProcessEngine 0.1.0

- **Date**: 2026-07-18
- **License**: Apache-2.0 (applied to all three published packages)
- **Milestone**: PE-M1 (see `scam/work-records/PE-M1.md`)

## 1. GitHub

- Repository: `https://github.com/processengine/framework`
- Branch: `main`
- Commit SHA: _(filled at push)_
- Annotated tag: `v0.1.0` — **pushed only after all three npm packages published**
- Verification: local `main` HEAD == remote `main` HEAD _(filled at push)_

### Included in the repo
Framework sources (`processengine/`), `test-shop/` consumer, tests, Helm chart,
Dockerfiles, lock-files, PostgreSQL migrations, documentation, SCAM context +
work record + reports, production-readiness plan + P0/P1 task files.

### Deliberately excluded
`node_modules`, `dist`, reproducible tarballs (`.packages/`, `.framework/`,
`*.tgz`), `.npm-cache`, `.artifacts` evidence, secrets, kubeconfig, npm tokens,
raw logs — via `.gitignore`.

## 2. npm packages

Registry: `https://registry.npmjs.org` · scope `@processengine` · access public.
Published in dependency order:

| Order | Package | Version | Registry URL | Status |
| --- | --- | --- | --- | --- |
| 1 | `@processengine/conductor` | 0.1.0 | https://www.npmjs.com/package/@processengine/conductor | _(filled)_ |
| 2 | `@processengine/transport-kafka` | 0.1.0 | https://www.npmjs.com/package/@processengine/transport-kafka | _(filled)_ |
| 3 | `@processengine/storage-postgres` | 0.1.0 | https://www.npmjs.com/package/@processengine/storage-postgres | _(filled)_ |

`test-shop` is a demonstration consumer and is **not** published.

### Pre-publish verification
- version + internal-dependency consistency (all `0.1.0`; peer `^0.1.0`);
- Apache-2.0 license present in every tarball;
- `npm pack` tarball contents reviewed (dist + schema + README + LICENSE only);
- clean temporary consumer install of the tarballs + public-import smoke;
- conformance/unit/integration tests green;
- no source secrets / test credentials / stray files in tarballs.

### Post-publish verification
- each package re-installed from the registry into a clean temp project;
- `test-shop` repointed from local tarballs to published versions; build +
  public-import smoke + key checkout acceptance re-run.

## 3. Kubernetes contour

Left running on `docker-desktop` (namespace `processengine-test-shop`). See
`docs/reports/K8S_ACCEPTANCE_REPORT.md`.

## 4. Fixes shipped in this release

- DEFECT-1: Dockerfile build-stage ownership (`npm ci` EACCES).
- DEFECT-2: Helm `FLOW_FILES` YAML flow-mapping comma quoting.
- DEFECT-3: flaky resilience outbox oracle (`waitForOutboxAttempt`).
- Licensing: UNLICENSED → Apache-2.0 across packages + repo `LICENSE`.

## 5. Remaining limitations

See `docs/production-readiness/PLAN.md` (single-broker/single-PG stand, PLAINTEXT
transport, no observability yet, etc.) — none block the 0.1.0 developer preview;
all are tracked as P0/P1 SCAM tasks.
