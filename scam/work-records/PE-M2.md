# Work Record: PE-M2 — npm trusted publishing

Date: `2026-07-19`
Status: `DONE`

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
- Pushed the workflow to GitHub `main` in commit
  `39bbbb4b526bb537af1bddb7698fbdaf7335c073`; GitHub registered workflow ID
  `315937882` under the exact filename `publish-npm.yml`.
- Created and read back one GitHub trusted-publisher relationship for each
  package with repository `processengine/framework`, workflow
  `publish-npm.yml`, and direct-publish permission.
- Set every package to `mfa=publish`; npm CLI 11.18 maps that setting to
  `publish_requires_tfa=true` and `automation_token_overrides_tfa=false`.
- Deleted the GitHub Actions secret, revoked the only npm project token, and
  removed its local npm user-config entry.

## Verification

| Gate | Result | Evidence |
| --- | --- | --- |
| Focused contract RED | EXPECTED FAIL | Vitest could not resolve the not-yet-created `scripts/release-preflight.mjs`. |
| Focused contract GREEN | PASS: 7/7 | `npm exec -- vitest run test/release-publishing.test.ts`, Node `22.23.1`. |
| Package tarball smoke | PASS | `npm run check:packages`, Node `22.23.1`; three `0.1.0` tarballs installed and public imports passed. |
| YAML parse | PASS | Ruby YAML parser loaded `.github/workflows/publish-npm.yml` and found `jobs`. |
| Full deterministic gate | PASS: 64 passed, 8 live skipped | `npm run check`, Node `22.23.1`; exit 0. |
| GitHub workflow registration | PASS | `gh workflow view publish-npm.yml --repo processengine/framework`; workflow ID `315937882`, zero runs before any new tag. |
| npm trust creation/readback | PASS: 3/3 | Authenticated `npm trust list` returned type `github`, repository `processengine/framework`, file `publish-npm.yml`, and registry permission `createPackage` for every package. |
| Package token denial | PASS: 3/3 | `npm access set mfa=publish <package>` completed for all three packages. |
| GitHub credential removal | PASS | Actions secret list no longer contains `NPM_TOKEN`. |
| npm credential removal | PASS | Inventory contained only `Codex-PE`; revoke returned `Removed 1 token`, subsequent authenticated inventory was `[]`, and the local registry auth entry was deleted. |
| Real OIDC publish | NOT_RUN | New version publication is outside PE-M2 scope. |

## External actions completed

1. The repository workflow was pushed and independently resolved through the
   GitHub Actions API.
2. The user completed npm web 2FA in the external browser for the package
   settings operations; no OTP or transient authentication URL was stored.
3. All three trust relationships were created and read back before credential
   removal.
4. All package publishing-access settings were changed to disallow traditional
   publish tokens.
5. The GitHub secret and the only npm project token were removed; local npm user
   configuration no longer contains the registry credential.

## Observations and residual risk

- An initial token-revoke attempt used the display-redacted `key` field and
  returned `Unknown token id`; registry state did not change. Retrying with the
  generated non-secret CLI ID succeeded, and inventory then returned zero.
- No version, tag, package, runtime, Compose, or Kubernetes state changed.
- The first future legitimate version remains the only end-to-end proof of the
  OIDC exchange and automatic provenance path. Until then, the static workflow
  contract and authenticated npm readback are the available evidence.
- Final documentation was isolated in a temporary `main` worktree because the
  primary worktree had unrelated, uncommitted PE-M3 changes. Those changes were
  not staged, edited, or included in PE-M2.
