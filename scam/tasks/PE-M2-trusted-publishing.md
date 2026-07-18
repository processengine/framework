# Task Contract: PE-M2 — npm trusted publishing

## Outcome

All three public `@processengine/*` packages trust the repository workflow
`.github/workflows/publish-npm.yml` and are published from GitHub-hosted Actions
through npm OIDC, without a long-lived npm token. After the trust configuration
is verified, the repository secret `NPM_TOKEN` and the project npm granular
access token are removed.

## Scope

### In

- `.github/workflows/publish-npm.yml`;
- release preflight and its focused tests under `processengine/scripts` and
  `processengine/test`;
- exact GitHub repository metadata in the three publishable package manifests;
- the current release runbook, an authentication-strategy ADR, SCAM context,
  work record, and living release status;
- npm trusted-publisher configuration for `@processengine/conductor`,
  `@processengine/transport-kafka`, and `@processengine/storage-postgres`;
- removal of `NPM_TOKEN` from GitHub Actions and revocation of the project npm
  token only after all three trusted-publisher configurations are verified.

### Out

- publishing a new package version, changing package versions, or creating a
  release tag;
- npm staged publishing or GitHub environment approval;
- changelog generation, an SBOM/scanning implementation, and a broad CI matrix;
- application, Compose, Kubernetes, and runtime changes.

## Allowed paths

- `.github/workflows/publish-npm.yml`;
- `processengine/package.json`, `processengine/package-lock.json`;
- `processengine/packages/*/package.json`;
- `processengine/scripts/release-preflight.mjs`;
- `processengine/scripts/package-smoke.mjs`;
- `processengine/test/release-publishing.test.ts`;
- `docs/dev/RELEASE.md`;
- `docs/decisions/ADR-001-npm-trusted-publishing.md`;
- `docs/reports/RELEASE_REPORT.md`;
- `RELEASE_STATUS.md`;
- `scam/PROJECT_CONTEXT.md`;
- `scam/tasks/PE-M2-trusted-publishing.md`;
- `scam/work-records/PE-M2.md`.

## Acceptance — frozen

- [ ] `.github/workflows/publish-npm.yml` runs only for SemVer release tags,
      uses a GitHub-hosted runner with Node 24 and npm >=11.5.1, grants only
      `contents: read` and `id-token: write`, and contains no npm-token secret
      reference or package cache configuration.
- [ ] Before the first publish, the workflow verifies that the tag is a strict
      `vX.Y.Z`, all three package versions match it, the tagged commit belongs
      to `origin/main`, all package repository URLs match
      `https://github.com/processengine/framework.git`, and none of the target
      package versions already exists in npm.
- [ ] The workflow runs the deterministic and package-smoke gates, publishes
      conductor → transport-kafka → storage-postgres with public access, waits
      for registry visibility, then performs exact-version clean install and
      ESM import smoke checks.
- [ ] Focused release-contract tests and `npm run check` pass in the required
      Node >=22 environment.
- [ ] `npm trust list` shows `processengine/framework` and
      `publish-npm.yml`, with direct publishing allowed, for all three packages.
- [ ] Only after the preceding trust-list check passes, GitHub Actions no longer
      has `NPM_TOKEN` and the npm project granular access token is revoked.
- [ ] The runbook, ADR, living context/status, and Work Record describe the
      verified final state without recording credentials or transient 2FA URLs.

## Owning gate

The owning gate is the focused release-contract test plus an authenticated
`npm trust list` check for all three packages. A real OIDC publish is deliberately
`NOT_RUN` because creating and publishing a new version is out of scope; the
first future release remains the end-to-end publication proof.

## External action constraints

- The workflow must be present on GitHub before npm can trust its filename, so
  repository changes may be committed and pushed to `main` before npm-side
  configuration.
- npm 2FA is completed interactively by the user; no OTP, token, or browser
  authentication URL is written to repository files or requested in chat.
- Existing npm trust state is inspected before replacement. Token deletion and
  revocation are sequenced after positive verification of all three publishers.

## Risks and assumptions

- **Implementation choice:** direct OIDC publishing is used to replace the
  existing direct token-based path; staged publishing is not inferred from the
  request.
- npm account 2FA can pause the external configuration after repository work is
  ready.
- Static and authenticated configuration checks cannot prove the complete OIDC
  exchange until the next legitimate version is released.

## Contract amendment — 2026-07-19

`processengine/scripts/package-smoke.mjs` was added to the allowed paths after
the initial RED contract test. Inspection confirmed that it hard-coded the
`0.1.0` tarball names, so the required package-smoke gate could not pass for any
future version. The outcome, scope intent, and frozen acceptance are unchanged;
the permitted correction is limited to deriving tarball names from manifests.
