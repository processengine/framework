# Operations

## Images and deployment identity

`scripts/images.mjs` hashes the source bundle and produces one shared tag such as `sha-0123456789abcdef` for three multi-stage Docker targets. Helm receives the exact repositories and tag. Image pull policy is `IfNotPresent`, suitable for Docker Desktop's local image store.

The Helm chart creates:

- three ClusterIP services and three Deployments;
- two replicas for each application and a PDB for `shop-host`;
- single-node Kafka KRaft and PostgreSQL StatefulSets;
- persistent claims in `values.docker-desktop.yaml`;
- idempotent, content-named migration and topic Jobs;
- ConfigMap, demo Secret, probes, resource bounds, and restricted container security contexts.

Migration and topic creation are normal Jobs rather than lifecycle hooks. This avoids a first-install deadlock in which hook Jobs wait for StatefulSets that Helm has not installed yet.

## Evidence

Every deploy/test/resilience failure path—including preflight, image build, lint, workload checks, and Helm tests—attempts to write a timestamped directory under `.artifacts/k8s/`. A successful gate writes the same evidence. It includes tool versions, exact image tags, Helm status/values/manifest, workload inventory, events, pod descriptions, recent logs, and bounded PostgreSQL snapshots of processes, outboxes, operations, and domain/service ledgers; acceptance output is stored with the relevant gate.

Evidence is local and ignored by source control. `npm run k8s:collect` creates an additional snapshot without mutating workloads.

## Safety and cleanup

All Kubernetes commands pass `--context docker-desktop`; namespace mutations are fenced by ownership labels. The scripts do not operate on the current namespace implicitly and do not accept arbitrary context/namespace flags.

`npm run k8s:down` collects evidence, uninstalls only release `test-shop`, and deletes only namespace `processengine-test-shop`. This also removes its PVC-backed test data. Compose cleanup leaves named volumes intact by default.

## Troubleshooting order

1. Run `npm run check` to separate source/package failures from infrastructure failures.
2. Run `npm run k8s:collect` before manual intervention.
3. Inspect the newest `.artifacts/k8s/*/events.txt`, then failed Job and application logs.
4. Re-run `npm run k8s:deploy`; migrations and topic creation are idempotent.
5. Use `npm run k8s:down` only when the owned test data may be discarded.
