# npm release runbook

## Publication identity

The three public packages are published by the GitHub Actions workflow
`.github/workflows/publish-npm.yml` from the public repository
`processengine/framework`:

1. `@processengine/conductor`;
2. `@processengine/transport-kafka`;
3. `@processengine/storage-postgres`.

npm authenticates the workflow through its GitHub Actions OIDC identity. The
workflow must not receive `NPM_TOKEN` or `NODE_AUTH_TOKEN`. Its only repository
permissions are `contents: read` and `id-token: write`. npm generates provenance
automatically for these public packages when the trusted workflow publishes
them.

The trusted-publisher fields are case-sensitive and exact:

| Field | Value |
| --- | --- |
| organization/user | `processengine` |
| repository | `framework` |
| workflow filename | `publish-npm.yml` |
| GitHub environment | omitted |
| permission | direct `npm publish` allowed |

Each package has its own npm trust relationship with those values.

Current verified state (2026-07-19): all three relationships match this table,
all three packages disallow traditional publish tokens, GitHub Actions has no
`NPM_TOKEN`, and npm project-token inventory is empty. No OIDC release has run
yet because the migration did not create a new version or tag.

## One-time trusted-publisher configuration

Prerequisites are Node >=22.14, npm >=11.15 for the `npm trust` management
command, account-level 2FA, write access to each existing package, and the
workflow already present in the default branch.

Inspect existing state before changing it:

```sh
npm trust list @processengine/conductor
npm trust list @processengine/transport-kafka
npm trust list @processengine/storage-postgres
```

Configure or correct each relationship:

```sh
npm trust github @processengine/conductor --repo processengine/framework --file publish-npm.yml --allow-publish --yes
npm trust github @processengine/transport-kafka --repo processengine/framework --file publish-npm.yml --allow-publish --yes
npm trust github @processengine/storage-postgres --repo processengine/framework --file publish-npm.yml --allow-publish --yes
```

Repeat the three `npm trust list` commands and verify the repository, workflow
filename, and direct-publish permission. Only after all three checks pass:

1. set each package's npm **Publishing access** to **Require two-factor
   authentication and disallow tokens**;
2. delete the repository Actions secret `NPM_TOKEN`;
3. revoke the no-longer-needed project granular access token.

Do not record OTPs, credentials, npm browser-authentication URLs, or token IDs in
the repository or issue tracker.

## Prepare a release

1. Choose one new stable version. Set that exact version in the root framework
   manifest and all three package manifests; keep dependency and peer-dependency
   ranges consistent.
2. Refresh `processengine/package-lock.json` and run from `processengine` with
   Node >=22:

   ```sh
   npm ci
   npm run check
   npm run check:packages
   ```

3. Commit and push the complete release source to `main`. Confirm the remote
   commit before tagging.
4. Create and push an annotated strict SemVer tag matching the manifests, for
   example `v0.2.0`.

The workflow independently checks that the tag is a strict `vX.Y.Z`, its commit
is on `origin/main`, all versions and repository metadata match, and no target
version already exists. It then repeats the gates, publishes in dependency
order, waits up to 60 seconds for registry visibility, and installs/imports all
three exact versions in a clean temporary project.

## Verify a completed release

- the GitHub Actions run is successful;
- `npm view <package>@<version> version repository dist.integrity` succeeds for
  every package;
- the package pages show provenance from `processengine/framework`;
- a clean anonymous install/import succeeds;
- `npm trust list <package>` still reports `publish-npm.yml` for all packages;
- GitHub Actions has no `NPM_TOKEN` secret and npm has no obsolete project
  publication token.

## Failure handling

- `ENEEDAUTH`: verify exact trusted repository/workflow spelling,
  `id-token: write`, GitHub-hosted runner use, and the npm/Node minimum versions.
- Preflight reports an existing version: never overwrite or unpublish it; choose
  a new version and tag.
- A later package fails after an earlier one published: do not reuse the version.
  Correct the fault, version all packages together again, and issue a new tag.
- Registry smoke times out: confirm package visibility manually. Do not rerun a
  tag whose package versions already exist.
- To suspend releases, disable the workflow or revoke the npm trust
  relationships. Reintroducing a long-lived write token is a separate security
  decision, not a routine recovery step.
