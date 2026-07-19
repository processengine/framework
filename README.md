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
npm run k8s:deploy:registry   # or k8s:deploy:local to run your worktree
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

## Two consumption modes

The contour consumes the framework in two explicit, non-overlapping modes:

- **local** — packs the three framework packages from the current worktree,
  stages an isolated consumer under `.work/local-consumer/`, installs exactly
  those tarballs, and builds images whose content tag is derived from the tarball
  bytes. This proves the code in your tree right now. It never rewrites the
  committed `test-shop` manifests or lockfile.
- **registry** — installs the exact published `@processengine/*` versions from
  the committed manifest and lockfile. This is the external-consumer / release
  gate: it proves the bytes on npm.

Every deploy prints its mode and writes a machine-readable `source-manifest.json`
(mode, git commit, package versions, tarball integrities, image content tag). A
deploy without a mode fails with a hint to choose one.

### Daily local loop

```bash
# change framework code under processengine/…, then:
npm run check:local            # deterministic gate against your local tarballs
npm run k8s:deploy:local       # deploy the local build (upgrade-safe)
npm run k8s:test               # business acceptance against the running contour
```

### Release-verification loop

```bash
npm run check:registry         # deterministic gate against published 0.1.0
npm run k8s:deploy:registry    # deploy the exact published packages
npm run k8s:test               # business acceptance as an external consumer sees it
```

See `DOD.md` for the milestone gates and `test-shop/docs/OPERATIONS.md` for
failure recovery and diagnostics.
