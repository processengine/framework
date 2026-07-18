# ProcessEngine local development contour

This bundle contains two deliberately separate consumers:

- `processengine/` — the framework monorepo with three independently
  publishable npm packages;
- `test-shop/` — an external e-commerce contour with `shop-host`,
  `shop-warehouse` and `shop-payment`.

The shop installs the exact public framework versions from the npm registry. A
successful contour therefore checks the same package boundary that an
independently deployed host service uses.

## First run

Prerequisites:

- Node.js 22 or newer and npm;
- Docker Desktop with Kubernetes enabled;
- `docker`, `kubectl` and `helm` on `PATH`;
- active Kubernetes context exactly `docker-desktop`.

```bash
npm run bootstrap
npm run k8s:doctor
npm run k8s:deploy
npm run k8s:test
npm run k8s:resilience
```

The deploy command builds content-tagged local images, installs Apache Kafka
in KRaft mode and PostgreSQL with persistent volumes, applies migrations and
topics, and installs two replicas of each application. Re-running deploy is an
upgrade, not a destructive reset.

Use `npm run k8s:collect` to write diagnostic evidence under
`test-shop/.artifacts/k8s/` and `npm run k8s:down`
to remove only the namespace owned by this contour. Persistent data survives
pod restarts and rolling upgrades; namespace deletion removes the contour PVCs.

## Daily development loop

```bash
# validate framework and the published consumer dependency boundary
npm run check

# validate and upgrade the running contour
npm run k8s:deploy
npm run k8s:test
```

See `DOD.md` for the milestone gates and `test-shop/docs/OPERATIONS.md` for
failure recovery and diagnostics.
