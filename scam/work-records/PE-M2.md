# Work Record: PE-M2 — npm trusted publishing

Date: `2026-07-19`
Status: `IN_PROGRESS`

## Task Contract

See `scam/tasks/PE-M2-trusted-publishing.md`. The outcome is an OIDC-bound npm
publisher for the three public packages and removal of the former token path
after authenticated trust readback.

## Confirmed starting state

- The repository had no `.github/workflows` directory.
- All three packages were public at version `0.1.0` and lacked `repository`
  metadata.
- GitHub Actions contained the secret `NPM_TOKEN`; the npm account had one
  project granular publication token.
- Unauthenticated `npm trust list` attempts reached npm's 2FA challenge and did
  not change trusted-publisher state.
- `processengine/scripts/package-smoke.mjs` named `0.1.0` tarballs directly,
  making its gate unusable for the next version.

## Implementation

- Added a tag-driven GitHub-hosted workflow with minimal OIDC permissions,
  Node 24, npm 11.18.0, no npm credential, ordered publication, and post-publish
  clean registry smoke.
- Added a release preflight for strict tag/version/repository consistency and
  anonymous registry collision detection.
- Added exact repository metadata to each package.
- Made the existing tarball smoke derive filenames from current manifests. This
  required the documented Task Contract allowed-path amendment; frozen
  acceptance did not change.
- Added the canonical release runbook and ADR-001.

## Verification to date

| Gate | Result | Evidence |
| --- | --- | --- |
| Focused contract RED | EXPECTED FAIL | Vitest could not resolve the not-yet-created `scripts/release-preflight.mjs`. |
| Focused contract GREEN | PASS: 7/7 | `npm exec -- vitest run test/release-publishing.test.ts`, Node `22.23.1`. |
| Package tarball smoke | PASS | `npm run check:packages`, Node `22.23.1`; three `0.1.0` tarballs installed and public imports passed. |
| YAML parse | PASS | Ruby YAML parser loaded `.github/workflows/publish-npm.yml` and found `jobs`. |
| Full deterministic gate | PASS: 64 passed, 8 live skipped | `npm run check`, Node `22.23.1`; exit 0. |
| npm trust readback | PENDING | Requires interactive npm 2FA after the workflow is on GitHub. |
| Real OIDC publish | NOT_RUN | New version publication is outside PE-M2 scope. |

## External actions pending

1. commit and push the repository workflow to `main`;
2. complete npm 2FA and inspect/configure/read back all three trust relationships;
3. set package publishing access to disallow traditional tokens;
4. delete GitHub `NPM_TOKEN` and revoke the project npm token;
5. record exact, non-secret verification evidence and close the contract.
