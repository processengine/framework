# Release status — 0.1.0

Date: 2026-07-19

Status: **RELEASE COMPLETE; TRUSTED PUBLISHING CONFIGURED**

## Accepted builds

- resilience-accepted framework/runtime commit:
  `6956299de7da03d8074530f0856339e0915c8146`;
- resilience image content tag: `sha-d3eb3338ca20f71f`;
- registry-consumer commit:
  `c6d6fcab49f52184c0349a6b7f07bd1dcd144f27`;
- registry-backed image content tag: `sha-d923f6427af27545`;
- public packages: `@processengine/conductor`,
  `@processengine/transport-kafka`, and
  `@processengine/storage-postgres`, all version `0.1.0`.

`test-shop` now pins those three registry versions and their public tarball
integrities; it has no local `.framework` dependency or staging step.

## Verified gates

- `npm run check`: framework 57 passed / 8 live skipped; test-shop 42 passed;
- PE-M2 `npm run check`: framework 64 passed / 8 live skipped;
- clean public registry install and imports in Node 22: PASS;
- Compose business acceptance: 16/16 PASS; Compose stopped afterward;
- original Kubernetes business acceptance: 16/16 PASS;
- Kubernetes resilience: 8/8 PASS, including actual Kafka/PostgreSQL
  scale-to-zero outages;
- live PostgreSQL SPI: 6/6 PASS; live Kafka SPI: 2/2 PASS;
- post-publication Helm revision 34: all six app pods Ready on
  `sha-d923f6427af27545`;
- post-publication Kubernetes business acceptance: 16/16 PASS.

Primary evidence:

- `test-shop/.artifacts/k8s/2026-07-18T19-22-15.3NZ-local-gates-pass/`;
- `test-shop/.artifacts/k8s/2026-07-18T19-19-07.805Z-resilience-pass/`;
- `test-shop/.artifacts/k8s/2026-07-18T19-19-52.3NZ-live-conformance-pass/`;
- `test-shop/.artifacts/k8s/2026-07-18T20-55-36.992Z-deploy-pass/`;
- `test-shop/.artifacts/k8s/2026-07-18T20-59-27.257Z-business-pass/`.

## License and publication

The user directly confirmed the Apache-2.0 license-owner decision immediately
before publication. Registry metadata for all three packages reports version
`0.1.0` and license `Apache-2.0`; anonymous clean install and public imports
passed.

GitHub release commit `417e1d731f33de02ebd3225e9dd72f5fdff7357e`
was independently verified through local `main`, the remote branch ref, and the
GitHub commits API. Annotated tag `v0.1.0` was pushed and its dereferenced remote
target is the same release commit.

## Trusted publishing migration

On 2026-07-19, GitHub Actions workflow `publish-npm.yml` was registered on
`main` and configured as the npm trusted publisher for all three packages.
Authenticated `npm trust list` readback matched `processengine/framework`, the
workflow filename, and direct-publish permission for `3/3` packages.

Publishing access now requires 2FA and disallows traditional tokens for every
package. GitHub Actions no longer contains `NPM_TOKEN`; the only project npm
token was revoked, registry token inventory was verified empty, and the former
local npm credential was removed.

No package version or tag changed during this migration. The first future
release remains the end-to-end OIDC and automatic-provenance verification.
Kubernetes remains running on `docker-desktop`; Compose is stopped with volumes
retained.
