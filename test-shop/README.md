# ProcessEngine test shop

`test-shop` is an external domain host built from the three public framework packages:

- `@processengine/conductor` — ProcessEngine kernel, Flow3 compiler and host runtime;
- `@processengine/transport-kafka` — Kafka transport adapter;
- `@processengine/storage-postgres` — PostgreSQL persistence adapter.

It deliberately does not import framework source files and does not define a
preset package. Its root manifest and lockfile pin the three public registry
packages at `0.1.0`, including their registry URLs and integrity digests.

The contour contains exactly three applications: `shop-host`, `shop-warehouse`, and `shop-payment`. `shop-host` is the composition root; the other two are deliberately ordinary, idempotent domain services communicating only through operation messages.

## Repository layout

```text
apps/
  shop-host/                 HTTP host and ProcessEngine composition root
  shop-warehouse/            idempotent warehouse operation worker
  shop-payment/              idempotent payment operation worker
packages/
  contracts/                 domain message validation
  host-adapter/              the only ProcessEngine composition boundary
  service-kit/               demo worker inbox/outbox implementation
flows/shop.checkout*.json   explicit immutable Flow3 v1 and v2 artifacts
config/operations.json       deployment-owned operation routing and policy
deploy/compose.yaml          local single-host business contour
deploy/helm/test-shop/       Docker Desktop Kubernetes contour
scripts/                     repeatable build, acceptance and evidence gates
```

## Published framework gate

Install and verify the consumer against the public npm registry:

```bash
cd test-shop
npm ci
npm run check
```

`npm run check` compiles every workspace through public package exports, type-checks it, compiles the Flow3 artifact against the operation catalog, and runs the deterministic kernel/domain contract tests. It needs neither Docker nor live infrastructure.

## Docker Compose business gate

```bash
npm run compose:doctor
npm run compose:up
npm run compose:test
npm run compose:down
```

Host ports are assigned dynamically, so the contour does not assume that `3000`, `8081`, `8082`, or PostgreSQL's port are free on the workstation. Named PostgreSQL and Kafka volumes survive `compose:down`; acceptance resets only its demo domain fixtures.

## Docker Desktop Kubernetes gate

The scripts intentionally accept only the exact `docker-desktop` context and the owned `processengine-test-shop` namespace. Deployment builds content-addressed local images before Helm installation. `npm run k8s:doctor` is a pre-build tool/context/cluster check and therefore does not require those images to exist yet.

```bash
npm run k8s:deploy
npm run k8s:test
npm run k8s:resilience
npm run k8s:collect
npm run k8s:down
```

`k8s:down` is intentionally destructive within that one owned namespace: it uninstalls the release and deletes the namespace, including its test PVCs. Evidence is collected first.

See [architecture](docs/ARCHITECTURE.md), [acceptance contract](docs/ACCEPTANCE.md), [resilience gate](docs/RESILIENCE.md), [operations](docs/OPERATIONS.md), and the [definition of done](DOD.md).

## Scope

This is an executable reference contour, not a production platform chart. Kafka and PostgreSQL are single-node fixtures; credentials are demo values; traffic is plaintext; there is no backup, restore, autoscaling, observability backend, or multi-zone topology. Those concerns remain deployment-owned adapters and infrastructure.
