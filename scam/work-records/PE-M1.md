# Work Record: PE-M1 — Local Kubernetes contour to verified release 0.1.0

Date: `2026-07-18`
Status: `SOURCE PUBLISHED — NPM PUBLICATION PENDING`

## Task Contract

See `scam/TASK.md`. The local contour and all executable acceptance gates are
complete. GitHub `main` is published; npm publication and the release tag are
not yet complete.

## Starting baseline

See `scam/WORKSPACE_BASELINE.json`. The framework packages started at `0.1.0`,
`test-shop` consumed staged `.tgz` files, and the workspace was not a git
repository. A recoverable checkpoint was created before changes.

## Confirmed defects and corrections

| ID | Confirmed behavior | Correction |
| --- | --- | --- |
| DEFECT-1 | Docker build ran `npm ci` as `node` in a root-owned work directory and failed with `EACCES`. | Made the copied build tree node-owned before dependency installation. |
| DEFECT-2 | An unquoted comma-separated Helm environment value produced an invalid flow mapping. | Rendered the value as valid quoted YAML. |
| DEFECT-3 | The resilience script did not consistently forward scenario filters and its outage oracle inferred retries from an outbox attempt counter. | Forwarded filters, used real StatefulSet stop/restore observations, and asserted durable recovery without treating an attempt count as proof. |
| DEFECT-4 | A payment handler awaited publication of its own completion; flow activation also changed a shared ConfigMap and restarted unrelated workers. | Committed the domain effect immediately, deferred selected completion publications through the service outbox, scoped active-flow configuration to the host, and split host-only artifact activation from full-contour rolling replacement. The operation timeout remains `60000ms`; pod grace remains `20s`. |
| DEFECT-5 | A caller-side Kafka timeout could return while an unbounded raw send continued; parallel callers could create ambiguous retry outcomes. | Added one bounded single-flight publication path, explicit attempted/unknown outcome errors, envelope coalescing, late-result handling, and stop-time caller cancellation. |
| DEFECT-6 | PostgreSQL pool errors could be unhandled, connection attempts could outlive the acceptance deadline, and fenced service-outbox claims waited for lease expiry after recovery. | Added a pool error handler, a public bounded connection timeout, and an in-memory recovery queue that reschedules known fenced claims after the database returns. |
| TEST-1 | The live Kafka roundtrip published immediately after starting an unawaited subscription, racing group assignment. | Awaited subscription, allowed group assignment to settle, and unsubscribed explicitly. |

## Public contract impact

The changes are additive:

- Kafka exposes bounded-publication outcome errors and publication timeout
  configuration.
- PostgreSQL storage exposes `connectionTimeoutMs` and `onPoolError` options.
- Service-kit exposes the corresponding connection timeout and a publication
  decision hook used by the demo service outbox.

The canonical DSL and process state model were not changed.

## Verification

Runtime-accepted source commit:
`6956299de7da03d8074530f0856339e0915c8146`; exact image tag:
`sha-d3eb3338ca20f71f`.

| Gate | Result | Evidence |
| --- | --- | --- |
| Framework deterministic/package | PASS: 57 passed, 8 live skipped | `test-shop/.artifacts/k8s/2026-07-18T19-22-15.3NZ-local-gates-pass/` |
| Test-shop deterministic | PASS: 42 passed | same local-gates directory |
| Compose business | PASS: 16/16 | same local-gates directory |
| Helm deploy and exact workload images | PASS: revision 31, all app replicas Ready | `test-shop/.artifacts/k8s/2026-07-18T19-11-45.201Z-deploy-pass/` |
| Kubernetes business | PASS: 16/16 | `test-shop/.artifacts/k8s/2026-07-18T19-15-23.099Z-business-pass/` |
| Kubernetes resilience | PASS: 8/8 | `test-shop/.artifacts/k8s/2026-07-18T19-19-07.805Z-resilience-pass/` |
| Live PostgreSQL SPI | PASS: 6/6 | `test-shop/.artifacts/k8s/2026-07-18T19-19-52.3NZ-live-conformance-pass/` |
| Live Kafka SPI | PASS: 2/2 | same live-conformance directory |

The PostgreSQL recovery fix was additionally isolated by a focused successful
run in `test-shop/.artifacts/k8s/2026-07-18T19-08-07.550Z-resilience-pass/`.

## Resilience observations

- Host and worker failures completed through other instances without duplicate
  domain effects.
- Artifact activation replaced only both host pods; warehouse and payment pods
  stayed unchanged. The separate full-contour scenario replaced all six app
  pods.
- Kafka and PostgreSQL outages scaled their owning StatefulSets to zero,
  observed no remaining pods, restored them, and completed the original process.
- During the 20-second PostgreSQL outage, all application restart counters
  remained zero.
- v1 instances stayed pinned while newly started work used v2.

## Release/deployment state

- Kubernetes context `docker-desktop`, namespace `processengine-test-shop`, and
  Helm release `test-shop` remain running.
- Compose is stopped; its volumes were retained.
- GitHub `main` was published and read back at
  `8968afb41a7303c86a8f2a734561f2cb82ed7fb4` for the initial accepted
  source-and-reports commit.
- npm publication, registry-consumer verification, and annotated tag `v0.1.0`
  have not yet been performed.
- Package metadata is `Apache-2.0`; confirmation of the license-owner decision
  is pending immediately before npm publish.

## Remaining publication sequence

1. Check npm authentication, scope ownership, and `0.1.0` availability.
2. Obtain the required license-owner confirmation and publish all three packages.
3. Clean-install the registry packages, repoint and re-smoke `test-shop`.
4. Create and push annotated tag `v0.1.0` only after registry verification.
