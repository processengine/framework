# ProcessEngine — Production Readiness Plan

Goal: **what must be done so that an external team can safely use the
ProcessEngine libraries (`@processengine/conductor`, `@processengine/transport-kafka`,
`@processengine/storage-postgres`) to build commercial enterprise services.**

Baseline for this plan: release `0.1.0`, verified on Docker Desktop Kubernetes
(see `docs/reports/K8S_ACCEPTANCE_REPORT.md`). The core correctness model
(Flow3 DSL, durable state, at-least-once + idempotent = logical exactly-once,
leases/fencing/outbox/inbox) is implemented and passes deterministic + live
business + resilience gates. The gaps below are about **contracts, operability,
security and third-party developer experience**, not core correctness.

## How to read this plan

Each task carries: problem/risk · affected module · concrete deliverable ·
boundaries · acceptance criteria · required tests · dependencies · priority
(P0/P1/P2) · size (S/M/L/XL) · blocks-stable-release? · docs to create/update.

P0/P1 tasks have frozen, self-contained SCAM task files under `scam/tasks/` so a
future agent can pick exactly one and execute it without re-researching the repo.

Priorities: **P0** = blocks a safe stable 1.0 for third parties. **P1** = needed
for commercial production use but can trail an early adopter RC. **P2** =
maturity/scale improvements.

---

## Milestone 0 — Development foundation (PE-M3, in progress)

Before the production-readiness directions below, one foundation milestone makes
the next development cycle honest and reproducible. Its ordering — which supersedes
the older M1…M6 sequencing where they overlap — is:

1. **Dual local/registry consumption contour** so local framework changes really
   reach test-shop and Kubernetes, while a registry mode proves the published
   release. *(done — `check:local`/`check:registry`, mode-aware deploys, source
   manifests, tarball-derived image tags.)*
2. **CI and preserved evidence** — fast PR gate, live PG/Kafka conformance, kind
   k8s smoke, nightly full business/resilience. *(workflows added; real run
   pending branch push.)*
3. **Curated public API** (supersedes/implements **PR1.1**, **PR1.2**) and the
   **honest operation schema profile** (informs **PR2.1**). *(done — curated
   surfaces, API reports + drift gate, `SEMVER_POLICY.md`, bounded schema profile
   that rejects unsupported keywords.)*
4. **Product documentation and a tested quick start**, delivered together with the
   contracts (feeds **PR17.1**).
5. **Release automation / supply-chain foundation** (advances **PR14.1**,
   **PR16.1**) — provenance publish, package metadata, governance docs. *(metadata,
   `SECURITY.md`/`CONTRIBUTING.md`/`CODE_OF_CONDUCT.md`, ADR-002, provenance in the
   release workflow — done; no publish performed.)*
6. **Then** the security, observability, HA, performance and third-party developer
   experience directions below.

This milestone does **not** make ProcessEngine production-ready and does not make
the `test-shop` Helm chart a production chart — it is a reference/developer chart.

---

## Direction 1 — Public API stability & semver policy

**Problem/risk**: `conductor/src/index.ts` re-exports `export *` from 11 internal
modules; there is no curated public surface, no `@internal` marking, no semver or
deprecation policy. Any internal refactor is a silent breaking change for
consumers. **Module**: all three packages, primarily `conductor`.

- **PR1.1 (P0, M)** — Curated public entrypoint + API report.
  - Deliverable: explicit named re-exports for the supported surface; everything
    else moved behind `/internal` or marked `@internal`; an API snapshot tool
    (e.g. API Extractor) with a checked-in `api.md` and a CI gate that fails on
    unreviewed surface change.
  - Boundaries: no behavior change; no renames beyond hiding internals.
  - Acceptance: `api.md` exists; removing/adding an exported symbol fails CI;
    consumer smoke imports only documented symbols.
  - Tests: API-report diff gate; public-import smoke (extend existing
    `package-smoke.mjs`).
  - Deps: none. Blocks stable: **yes**. Docs: `docs/api/` + SEMVER.md.
- **PR1.2 (P0, S)** — SEMVER & support policy doc (`SEMVER.md`): what is public,
  breaking-change rules, deprecation window, LTS intent. Blocks stable: **yes**.

## Direction 2 — DSL evolution & process-artifact compatibility

**Problem/risk**: Flow3 artifacts are pinned by `{id,version,digest}` (good), but
there is no documented forward/backward compatibility contract for grammar
changes and no migration story for in-flight processes when the grammar evolves.
The grammar is versioned by package semver + the flow schema `$id`; the canon
forbids a `dsl`/`dslVersion`/`schemaVersion` field inside the business flow.

- **PR2.1 (P0, M)** — DSL compatibility contract: define which grammar changes are
  additive vs breaking; version via package semver + flow schema `$id` + golden
  fixtures (no version field in the flow); add a compiler compatibility matrix.
  - Acceptance: an older flow compiled by the current engine yields an equivalent
    normalized digest, or the change is declared breaking; any protocol negotiation
    (if ever needed) lives in artifact-registry metadata, not the flow.
  - Tests: compiler golden compatibility fixtures. Blocks stable: **yes**.
  - Docs: `docs/dsl/COMPATIBILITY.md`; the schema profile and its versioning are
    already documented in `processengine/docs/OPERATION_SCHEMA_PROFILE.md`.
- **PR2.2 (P1, M)** — Artifact registry SPI guidance for versioned publication and
  pinning across rolling deploys (the test-shop proves the pattern; promote it to
  documented contract). Blocks stable: no.

## Direction 3 — Conformance kit for third-party transport/storage SPI

**Problem/risk**: `runProcessStorageConformance` / `runMessageTransportConformance`
exist (`@processengine/conductor/testing`) — strong foundation — but they are not
packaged, documented, or versioned as a **standalone conformance product**, and
coverage completeness vs the canon invariants is not attested.

- **PR3.1 (P0, M)** — Promote conformance suites to a documented, stable public API
  with a coverage matrix mapping each canon §3–§5 invariant to a conformance
  assertion; gaps filled (fencing, lease reclaim, outbox drain, inbox dedup).
  - Acceptance: a trivial in-memory adapter passes; a deliberately broken adapter
    fails on the specific invariant; matrix has no `UNCOVERED` rows.
  - Tests: the suites themselves + a "mutation" adapter proving each check bites.
  - Deps: PR1.1. Blocks stable: **yes**. Docs: `docs/spi/CONFORMANCE.md`.

## Direction 4 — Connector authoring contract & guide

**Problem/risk**: The SPI interfaces (`ProcessStorage`, `MessageTransport`,
`ArtifactRegistry`, `OperationCatalog`) are defined but there is no written
contract describing required semantics (atomicity boundaries, redelivery duties,
ack-before-timeout, ordering assumptions) that a connector author must honor.

- **PR4.1 (P1, L)** — SPI contract reference + "write your own connector" guide,
  each requirement cross-linked to a conformance assertion (PR3.1).
  - Acceptance: an external developer can implement a new storage/transport using
    only public docs + conformance kit (validated by building a second reference
    adapter, e.g. SQLite/NATS, in an example repo).
  - Blocks stable: no (but P1). Docs: `docs/spi/CONNECTORS.md`.

## Direction 5 — PostgreSQL migrations, upgrade/rollback & backup/restore

**Problem/risk**: `storage-postgres` migrations are forward-only (single version 1),
checksum-validated but with **no rollback path, no backup/restore runbook**, and
the migrations Job has no explicit DB-readiness wait (observed transient
`ECONNREFUSED` retry during deploy — FOLLOW-UP-1).

- **PR5.1 (P0, M)** — Migration lifecycle: documented forward-only policy with
  expand/contract guidance, an idempotent re-runnable migrator, and a readiness
  gate (init-container or retry-with-backoff wait) so migrations don't error-loop.
  - Acceptance: repeated migrate is a no-op; migrate against not-ready DB waits
    then succeeds without a failed pod; checksum drift is rejected.
  - Tests: live PG migration idempotency + drift test (extend `migrations.test.ts`
    + live conformance). Blocks stable: **yes**. Docs: `docs/ops/MIGRATIONS.md`.
- **PR5.2 (P1, M)** — Backup/restore + PITR runbook and a restore drill test.
  Blocks stable: no. Docs: `docs/ops/BACKUP_RESTORE.md`.

## Direction 6 — Kafka delivery semantics, partitioning & capacity planning

**Problem/risk**: The stand runs a single-broker KRaft node, `replication-factor=1`,
3 partitions. Delivery/ordering guarantees under multi-partition, multi-broker,
consumer-rebalance and partition-key choice are not documented; capacity planning
guidance is absent.

- **PR6.0 (P1, M) — measurable follow-up, do not optimize without a baseline**:
  the Kafka transport deliberately keeps **one active `producer.send()` per
  transport instance** so an unknown delivery result is handled correctly. This is
  a safety trade-off with an unmeasured throughput ceiling, not a claimed scaling
  property. Before changing it, establish throughput/latency baselines and a
  backpressure contract, and add a test that pins the current delivery semantics.
  Blocks stable: no. Docs: `docs/ops/KAFKA.md`, cross-link Direction 13.

- **PR6.1 (P0, M)** — Document and test partitioning/ordering contract: which key
  guarantees per-process ordering, behavior under rebalance, min ISR / RF
  requirements for durability. **Module**: `transport-kafka`.
  - Acceptance: a multi-partition live test shows per-`requestId` correlation and
    no duplicate domain effect under rebalance. Blocks stable: **yes**.
  - Tests: extend `kafka.live.test.ts` to multi-partition + rebalance.
- **PR6.2 (P1, M)** — Capacity & tuning guide (throughput, lag, retention,
  producer acks=all). Blocks stable: no. Docs: `docs/ops/KAFKA.md`.

## Direction 7 — HA, leases, fencing, outbox/inbox & recovery guarantees

**Problem/risk**: These are implemented and pass resilience gates on a
**single-node** cluster; multi-node HA (anti-affinity, PDB tuning, quorum broker,
Postgres replication/failover) and formal recovery guarantees are not documented
or tested at scale.

- **PR7.1 (P1, L)** — HA reference topology (multi-broker RF≥3, Postgres primary +
  standby, pod anti-affinity, tuned PDBs) with a documented recovery guarantee
  table (RPO/RTO per failure class).
  - Acceptance: broker loss and Postgres failover drills keep effects
    exactly-once-logical and processes resumable. Blocks stable: no (P1).
  - Tests: chaos drills (see PR12). Docs: `docs/ops/HA.md`.

## Direction 8 — Kafka/PostgreSQL security: TLS, SASL, credentials & rotation

**Problem/risk**: Broker is **PLAINTEXT**, no SASL, no mTLS; `DATABASE_URL` is a
static k8s Secret with no rotation. Unacceptable for enterprise/commercial data.

- **PR8.1 (P0, L)** — TLS/mTLS + SASL support and documented config surface in
  `transport-kafka` and `storage-postgres`; secret injection via files/CSI, not
  env where avoidable; credential rotation runbook.
  - Acceptance: contour runs against a TLS+SASL Kafka and TLS Postgres; a rotation
    changes credentials with zero dropped messages/effects.
  - Tests: live secure-broker conformance. Blocks stable: **yes**.
  - Docs: `docs/security/TRANSPORT_TLS_SASL.md`.

## Direction 9 — Kubernetes RBAC, NetworkPolicy, Pod Security & secret management

**Problem/risk**: Chart has no NetworkPolicy, no explicit ServiceAccount/RBAC
minimization, Pod Security context not attested against `restricted`, secrets are
plain k8s Secrets.

- **PR9.1 (P1, M)** — Harden Helm chart: default-deny NetworkPolicies, least-priv
  ServiceAccounts, `restricted` PodSecurity (runAsNonRoot, seccomp, no privilege
  escalation, read-only rootfs where possible), external-secrets guidance.
  - Acceptance: chart passes `kubescape`/`polaris` at a defined threshold; contour
    still green. Blocks stable: no (P1). Docs: `docs/security/KUBERNETES.md`.

## Direction 10 — Observability: structured logs, metrics, tracing, OpenTelemetry

**Problem/risk**: No structured logging schema, no metrics, no tracing/OTel in the
core packages. Operators cannot see dispatch attempts, lease reclaims, completion
latencies, or outbox depth.

- **PR10.1 (P0, L)** — OpenTelemetry instrumentation hooks in `conductor` (spans
  for start/dispatch/completion/transition; metrics for outbox depth, dispatch
  attempts, completion timeouts, lease reclaims) + structured log contract; no
  hard OTel dependency (pluggable exporter).
  - Acceptance: a consumer wiring an OTLP exporter sees process/operation spans and
    the documented metric set; zero-config default is a no-op.
  - Tests: metric/span emission unit tests. Blocks stable: **yes**.
  - Docs: `docs/observability/OTEL.md`, `docs/observability/METRICS.md`.

## Direction 11 — Health/readiness & diagnostic APIs

**Problem/risk**: Apps expose `/health/live`; a documented, package-level
readiness/health contract (storage reachable, transport connected, consumer lag)
and a process-introspection diagnostic API are not standardized.

- **PR11.1 (P1, M)** — Health/readiness contract in `conductor` + host-adapter
  guidance; a read-only process/operation/outbox inspection API.
  - Acceptance: readiness flips on storage/transport loss and recovers.
  - Tests: readiness transition tests. Blocks stable: no. Docs: `docs/ops/HEALTH.md`.

## Direction 12 — Performance, load, soak & chaos testing

**Problem/risk**: No throughput/latency baselines, no soak (memory/leak) or chaos
coverage beyond the functional resilience script.

- **PR12.1 (P1, L)** — Load + soak + chaos harness with published baselines
  (p50/p99 completion latency, sustained throughput, 24h soak, broker/DB chaos).
  - Acceptance: baselines recorded and regressions gated in CI (nightly).
  - Blocks stable: no (P1). Docs: `docs/perf/BASELINES.md`.

## Direction 13 — Resource limits, backpressure & graceful degradation

**Problem/risk**: No documented resource requests/limits tuning, no backpressure
strategy when outbox/consumer lag grows, no graceful-degradation contract.

- **PR13.1 (P1, M)** — Backpressure & bounded-concurrency controls in the worker;
  documented limits/requests; graceful shutdown drain contract.
  - Acceptance: under overload, dispatch is bounded and lag is shed predictably,
    no OOM. Tests: overload unit/integration. Blocks stable: no. Docs: `docs/ops/LIMITS.md`.

## Direction 14 — Supply-chain security, dependency scanning, SBOM & signing

**Problem/risk**: No SBOM, no dependency/vuln scanning, no package signing or
provenance on the published tarballs.

- **PR14.1 (P0, M)** — SBOM (CycloneDX) per package, `npm audit`/OSV gate in CI,
  Sigstore/npm provenance on publish, pinned & reviewed transitive deps.
  - Acceptance: published packages carry provenance; CI blocks on high-sev vulns.
  - Blocks stable: **yes**. Docs: `docs/security/SUPPLY_CHAIN.md`.

## Direction 15 — CI matrix by Node, Kafka & PostgreSQL

**Problem/risk**: No CI. Compatibility across Node (22/LTS), Kafka (3.x/4.x) and
PostgreSQL (14–17) is unverified.

- **PR15.1 (P0, M)** — GitHub Actions matrix: build+check on Node 22/24; live
  storage suite across PG 14/15/16/17; live transport suite across Kafka 3.7/4.x;
  Docker Desktop-equivalent kind cluster for k8s smoke.
  - Acceptance: matrix green on `main`; PRs gated. Blocks stable: **yes**.
  - Docs: `docs/dev/CI.md`.

## Direction 16 — Release automation & npm provenance

**Problem/risk**: Release is manual (this milestone did it by hand). No automated,
reproducible, provenance-attested release.

- **PR16.1 (P1, M)** — Release workflow: version bump, changelog, tag, ordered
  publish with `--provenance`, post-publish clean-install verification.
  - Acceptance: a tagged commit publishes all three packages reproducibly.
  - Deps: PR14.1, PR15.1. Blocks stable: no. Docs: `docs/dev/RELEASE.md`.

## Direction 17 — API reference, tutorial & production deployment guide

**Problem/risk**: README-level docs only; no generated API reference, no
end-to-end tutorial, no production deployment guide.

- **PR17.1 (P1, L)** — Generated API reference (from PR1.1), a "first process in 20
  minutes" tutorial, and a production deployment guide (HA, security, observability
  cross-links). Blocks stable: no (P1). Docs: `docs/` site.

## Direction 18 — Example: building your own domain host service

**Problem/risk**: `test-shop` is the only worked example and lives in this repo;
external teams need a minimal, standalone template.

- **PR18.1 (P1, M)** — A minimal standalone `examples/host-service` consuming only
  published packages + public APIs, with its own README and tests.
  - Acceptance: `npx`-able/clonable template builds and runs one process against a
    local Kafka+PG. Blocks stable: no. Docs: `examples/README.md`.

## Direction 19 — Operational runbooks & incident response

**Problem/risk**: No runbooks for stuck processes, poison messages, outbox
backlog, lease storms, broker/DB outage, or version-pinning incidents.

- **PR19.1 (P1, M)** — Runbook set + incident-response playbook keyed to the metrics
  from PR10.1. Blocks stable: no. Docs: `docs/ops/runbooks/`.

## Direction 20 — Licensing, security policy, contribution policy & support model

**Problem/risk**: Packages were `UNLICENSED` (fixed to **Apache-2.0** for the `0.x`
line in this milestone). The **`1.0` license is deliberately not yet chosen** — it
may be MIT, Apache-2.0, or dual-licensed by the rights holder (see
`docs/decisions/ADR-002-licensing.md`). Production-readiness tasks must require
consistency with *the chosen project license*, not a perpetual Apache-2.0 mandate.

- **PR20.1 (P0, S)** — Governance docs. *(Largely satisfied: `LICENSE` (Apache-2.0)
  at repo root + per package, `SECURITY.md`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, and the support/versioning statement in
  `processengine/docs/SEMVER_POLICY.md` are in place.)*
  - Acceptance: all files present; license consistent across packages for the
    current `0.x` line; the `1.0` license decision is recorded as open, not chosen.
  - Blocks stable: **yes** (largely satisfied for `0.x`).

---

## Milestones

| Milestone | Theme | Tasks | Exit criterion |
| --- | --- | --- | --- |
| **M1 — Correctness & frozen contracts** | Lock the public surface | PR1.1, PR1.2, PR2.1, PR3.1, PR20.1 | Public API + DSL + SPI contracts frozen and CI-gated |
| **M2 — Operable & secure** | Make it safe to run | PR5.1, PR8.1, PR9.1, PR10.1, PR14.1, PR15.1 | Secure transport/storage, observability, supply-chain + CI matrix green |
| **M3 — Performance & endurance** | Prove it scales | PR6.1, PR7.1, PR12.1, PR13.1, PR5.2, PR6.2 | Published baselines + HA drills + backpressure |
| **M4 — Third-party developer experience** | External adoption | PR4.1, PR11.1, PR17.1, PR18.1, PR19.1 | An external team ships a service using only public docs/packages |
| **M5 — Release candidate** | Harden the pipeline | PR16.1, PR2.2, remaining P1 | Automated provenance release; RC published |
| **M6 — Stable 1.0** | Commit to stability | All "blocks stable = yes" done | Semver-committed 1.0 with support model |

## P0 / P1 task index (frozen SCAM task files)

| Task | Priority | Size | Blocks stable | SCAM file |
| --- | --- | --- | --- | --- |
| PR1.1 Curated public API + report | P0 | M | yes | `scam/tasks/PR1.1-public-api-surface.md` |
| PR1.2 Semver & support policy | P0 | S | yes | `scam/tasks/PR1.2-semver-policy.md` |
| PR2.1 DSL compatibility contract | P0 | M | yes | `scam/tasks/PR2.1-dsl-compatibility.md` |
| PR3.1 Conformance kit productization | P0 | M | yes | `scam/tasks/PR3.1-conformance-kit.md` |
| PR5.1 Migration lifecycle + readiness | P0 | M | yes | `scam/tasks/PR5.1-migration-lifecycle.md` |
| PR6.1 Kafka partitioning/ordering contract | P0 | M | yes | `scam/tasks/PR6.1-kafka-partitioning.md` |
| PR8.1 Kafka/PG TLS+SASL + rotation | P0 | L | yes | `scam/tasks/PR8.1-transport-tls-sasl.md` |
| PR10.1 OpenTelemetry + metrics + logs | P0 | L | yes | `scam/tasks/PR10.1-observability-otel.md` |
| PR14.1 SBOM + scanning + provenance | P0 | M | yes | `scam/tasks/PR14.1-supply-chain.md` |
| PR15.1 CI matrix Node/Kafka/PG | P0 | M | yes | `scam/tasks/PR15.1-ci-matrix.md` |
| PR20.1 Governance & licensing docs | P0 | S | yes | `scam/tasks/PR20.1-governance-docs.md` |
| PR2.2 Versioned artifact registry guide | P1 | M | no | `scam/tasks/PR2.2-artifact-registry.md` |
| PR4.1 Connector authoring guide | P1 | L | no | `scam/tasks/PR4.1-connector-guide.md` |
| PR5.2 Backup/restore runbook | P1 | M | no | `scam/tasks/PR5.2-backup-restore.md` |
| PR6.2 Kafka capacity guide | P1 | M | no | `scam/tasks/PR6.2-kafka-capacity.md` |
| PR7.1 HA reference topology | P1 | L | no | `scam/tasks/PR7.1-ha-topology.md` |
| PR9.1 K8s hardening | P1 | M | no | `scam/tasks/PR9.1-k8s-hardening.md` |
| PR11.1 Health/diagnostic API | P1 | M | no | `scam/tasks/PR11.1-health-api.md` |
| PR12.1 Load/soak/chaos harness | P1 | L | no | `scam/tasks/PR12.1-perf-chaos.md` |
| PR13.1 Backpressure & limits | P1 | M | no | `scam/tasks/PR13.1-backpressure.md` |
| PR16.1 Release automation | P1 | M | no | `scam/tasks/PR16.1-release-automation.md` |
| PR17.1 API ref + tutorial + deploy guide | P1 | L | no | `scam/tasks/PR17.1-docs-site.md` |
| PR18.1 Standalone host example | P1 | M | no | `scam/tasks/PR18.1-example-host.md` |
| PR19.1 Runbooks + incident response | P1 | M | no | `scam/tasks/PR19.1-runbooks.md` |

## Recommended first three tasks

1. **PR1.1** — freeze the public API surface (everything downstream depends on a
   stable surface; cheapest to do before adoption).
2. **PR20.1** — governance/licensing docs (small, unblocks lawful external use;
   Apache-2.0 already applied).
3. **PR8.1** — transport TLS/SASL (largest security gap blocking any real data).
