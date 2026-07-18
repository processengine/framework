# Release status — 0.1.0

Date: 2026-07-18

Status: **SOURCE PUBLISHED — NPM PUBLICATION PENDING**

## Accepted build

- runtime commit: `6956299de7da03d8074530f0856339e0915c8146`;
- application content tag: `sha-d3eb3338ca20f71f`;
- three public packages: `@processengine/conductor`,
  `@processengine/transport-kafka`, `@processengine/storage-postgres`, all
  version 0.1.0;
- test-shop consumes staged package tarballs and runs host, warehouse and
  payment against Kafka KRaft and PostgreSQL.

## Verified gates

- `npm run check`: exit 0; framework 57 passed / 8 live skipped, test-shop
  42 passed;
- clean package install and public-import smoke: PASS;
- Compose business acceptance: 16/16 PASS; Compose stopped afterward;
- Kubernetes deploy/image identity: PASS; all six Ready app pods matched
  `sha-d3eb3338ca20f71f`;
- Kubernetes business acceptance: 16/16 PASS;
- Kubernetes resilience: 8/8 PASS, including actual Kafka/PostgreSQL
  scale-to-zero outages, host/worker crash recovery, host-only artifact
  activation and full three-Deployment rollout;
- live PostgreSQL SPI: 6/6 PASS;
- live Kafka SPI: 2/2 PASS.

Evidence directories:

- `test-shop/.artifacts/k8s/2026-07-18T19-22-15.3NZ-local-gates-pass/`;
- `test-shop/.artifacts/k8s/2026-07-18T19-11-45.201Z-deploy-pass/`;
- `test-shop/.artifacts/k8s/2026-07-18T19-15-23.099Z-business-pass/`;
- `test-shop/.artifacts/k8s/2026-07-18T19-19-07.805Z-resilience-pass/`;
- `test-shop/.artifacts/k8s/2026-07-18T19-19-52.3NZ-live-conformance-pass/`.

The host's Node 20.19.0 emitted engine warnings because packages declare Node
>=22. Application containers and the live SPI pod ran Node 22.13.0.

## Semantics verified

Physical delivery remains at-least-once. Stable request IDs, fenced leases,
transactional domain ledgers and first-completion-wins processing produced one
domain effect per operation under duplicate delivery and crash/outage recovery.

Flow activation changes only shop-host. Existing v1 processes remain pinned to
the immutable v1 artifact; new processes use active v2 and return APPROVED_V2.
A separate full-contour rollout replaces all six app pods while an unfinished
v1 process survives.

## License and publication

Current package manifests, generated lock metadata and tarballs declare
Apache-2.0 and include LICENSE; no current package metadata contains
`UNLICENSED`. Owner confirmation of that licensing decision has not yet been
recorded and will be requested immediately before npm publication.

GitHub `main` was published to
`https://github.com/processengine/framework`; the initial accepted
source-and-reports push was independently verified at
`8968afb41a7303c86a8f2a734561f2cb82ed7fb4`. npm publication, registry
reinstall verification and annotated tag `v0.1.0` have not yet been performed
and are not claimed here. Kubernetes is left running on `docker-desktop`;
Compose is stopped.
