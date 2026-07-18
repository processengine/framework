# ADR-001: Publish npm packages through a GitHub Actions trusted publisher

- **Status:** Accepted
- **Date:** 2026-07-19
- **Scope:** npm authentication and release automation for the three public
  `@processengine/*` packages

## Context

Release `0.1.0` was published with a granular npm access token and the same
credential was stored as the repository Actions secret `NPM_TOKEN`. The user
requested that this project migrate to npm trusted publishers instead of a
token. npm trusted publishing binds an existing package to a specific CI
workflow and exchanges GitHub's OIDC identity for a short-lived publication
credential.

The repository is public and the packages are public, so a trusted GitHub
Actions publish also receives npm provenance automatically. npm requires the
repository URL in package metadata to match the source repository.

## Decision

- One repository workflow, `.github/workflows/publish-npm.yml`, owns publication
  for all three packages. Each package independently trusts the exact repository
  `processengine/framework` and filename `publish-npm.yml`.
- The workflow runs on GitHub-hosted Ubuntu with Node 24 and npm 11.18.0. It has
  `contents: read` and `id-token: write`, does not use a package cache, and does
  not reference npm credentials.
- The workflow publishes a strict stable SemVer tag only after source, version,
  repository, registry-availability, deterministic, and package-smoke checks.
  It publishes conductor, Kafka transport, and PostgreSQL storage in that order,
  then verifies exact versions through a clean registry consumer.
- Direct `npm publish` permission is enabled. This is an implementation choice
  matching the existing direct-release behavior; the user requested the OIDC
  migration but did not separately select direct versus staged publishing.
- After all three trusted relationships are authenticated and read back, each
  package disallows traditional publication tokens. The GitHub secret is then
  deleted and the former project granular token revoked.

## Consequences

- There is no reusable write credential in GitHub Actions, and each publication
  credential is short-lived and limited to the trusted workflow.
- Workflow filename, repository identity, runner type, Node/npm minimums, and
  OIDC permission become part of the release contract.
- A real end-to-end OIDC exchange can only be verified by publishing a new
  legitimate version. Configuration readback and static tests reduce but do not
  eliminate that first-release risk.
- Direct tag publication has no manual approval step. Moving to npm staged
  publishing would require a new workflow/operating decision and explicit 2FA
  approval for each staged release.
- Package-level token denial intentionally prevents granular access tokens,
  including bypass-2FA tokens, from publishing these packages; trusted OIDC
  publication remains allowed.

## Alternatives considered

- Keep and rotate the granular token: not selected because it does not satisfy
  the requested tokenless publication model.
- Stage every publication for manual 2FA approval: stronger proof of presence,
  but not selected in this migration because it changes the release operating
  model beyond replacing its authentication mechanism.

