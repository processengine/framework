# Release status — 0.1.0

Date: 2026-07-18

## Included

- `processengine/`: framework monorepo with three independently packed public
  npm packages;
- `test-shop/`: standalone external consumer with `shop-host`,
  `shop-warehouse`, `shop-payment`, explicit flow v1/v2, Apache Kafka KRaft,
  PostgreSQL, Compose, Helm and Docker Desktop Kubernetes gates;
- current framework tarballs are staged in both `processengine/.packages/` and
  `test-shop/.framework/` with matching bytes.

## Verified in this environment

- framework build, strict typecheck and deterministic tests: **48 passed**;
- environment-gated real PostgreSQL/Kafka tests: **8 skipped** because those
  services are not available here;
- clean consumer installation and public package import smoke: **passed**;
- test-shop build, strict typecheck and deterministic tests after clean
  tarball installation: **37 passed**;
- every one of the 16 checkout `end` steps has a deterministic transition
  scenario and exact terminal-result assertion;
- all repository `.mjs` scripts pass Node syntax checking and all JSON files
  parse;
- the Docker build-stage sequence (`npm ci`, build, production prune and
  runtime public imports) passes in a clean temporary copy.

## Deliberate failure coverage

The executable contracts include duplicate commands; a service-originated
duplicate completion with the same `requestId` and a fresh `messageId`;
conflicting, foreign-source, unknown-request, malformed and late completions;
completion-versus-timeout races; dispatch exhaustion; lease reclaim/fencing;
host and worker crash recovery; compound payment and stock compensation
failures; Kafka/PostgreSQL outages; and v1-to-v2 rolling activation.

The duplicate-service fixture records its second publication only after Kafka
acknowledges it. Live acceptance then requires an unchanged process revision,
unchanged results and exactly one domain effect per operation request.

## Pending live verification

`docker`, `kubectl` and `helm` are absent from this build environment. No live
Docker Desktop or Kubernetes PASS is claimed. On the target workstation run:

```bash
npm run bootstrap
npm run k8s:doctor
npm run k8s:deploy
npm run k8s:test
npm run k8s:resilience
```

The milestone becomes verified only after those gates pass and evidence exists
under `test-shop/.artifacts/k8s/` as required by `DOD.md`.

## Publication decision

Package layout and `publishConfig` are ready for scoped public npm packages.
The source is intentionally `UNLICENSED`; select a license before publishing or
redistributing the packages.
