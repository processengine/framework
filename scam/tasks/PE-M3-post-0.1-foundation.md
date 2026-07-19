# Task Contract: PE-M3 — Post-0.1.0 development foundation

## Outcome

The next development cycle for ProcessEngine is honest and reproducible:

- Local framework changes really reach `test-shop` and Kubernetes through an
  explicit `local` consumption mode, while an explicit `registry` mode proves the
  published `0.1.0` release. Committed manifests/lockfiles stay clean.
- CI exists (`.github/workflows`) with a fast PR gate and heavier live/resilience
  gates; workflows are lint-clean and runnable.
- The public API surface of each published package is curated (no uncontrolled
  `export *`), snapshotted, and CI-checked.
- Operation schema compatibility is an honest, documented, bounded profile: the
  compiler rejects unsupported keywords instead of silently ignoring them.
- Package metadata, supply-chain foundation, and licensing docs are fit for an
  external consumer.
- Public documentation reads as product documentation for a Node.js framework,
  with an English normative canon and a linked Russian translation.
- The roadmap and SCAM task files reflect the actual ordering and decisions.

This is **not** "make ProcessEngine production-ready". TLS/SASL, HA Kafka/Postgres,
observability, load tests, and the rest of the production-readiness plan remain
later milestones.

## Scope

### In scope

- `processengine/**` framework source, package manifests, build/pack/API tooling.
- `test-shop/**` consumer, images, Compose and Kubernetes deploy scripts.
- Root `scripts/**`, root `package.json`, `.github/workflows/**`.
- `docs/**`, `scam/**`, root `*.md`, package/test-shop READMEs, canon + terminology.

### Out of scope (frozen)

- Redesign of DSL, state model, or the fixed canon §2 principles.
- New DSL step types, `dsl`/`dslVersion` fields, JSONPath, data mapping, query
  language, multi-result aggregation.
- Substituting Apache Kafka with Redpanda or any Kafka-compatible broker anywhere.
- Preset packages; changing the three-package monorepo boundary.
- Full JSON Schema inclusion proof; runtime domain-payload processing.
- New npm publish, version bump, or new tag in this task.
- Production-readiness implementation itself (TLS/SASL, HA, observability, perf).
- `engines`/lockfile/package-manager changes made only to fit the local toolchain.

## Allowed changes

| Repository/component | Paths | Permission |
| --- | --- | --- |
| framework | `processengine/**` | read/write |
| consumer | `test-shop/**` | read/write |
| orchestration | `scripts/**`, root `package.json`, `.github/**` | read/write |
| docs/reports | `docs/**`, `scam/**`, root `*.md` | read/write |

## Sources to read

- `PROCESSENGINE_NEXT_MILESTONE_PROMPT.md` (frozen acceptance for this task).
- `processengine/docs/PROCESSENGINE_CANON.md`, root `DOD.md`.
- Existing `scripts/*.mjs`, `test-shop/scripts/*.mjs`, Dockerfile, Helm chart.
- `processengine/packages/*/src` public entrypoints and consumers.
- SCAM `METHOD.md` / `DOCUMENTATION.md`; `docs/production-readiness/PLAN.md`.

## Acceptance — frozen (defined by the milestone prompt)

Per-slice acceptance is defined verbatim by `PROCESSENGINE_NEXT_MILESTONE_PROMPT.md`
sections "Acceptance Slice 1..7" and "Полный acceptance milestone". Summarized:

- [ ] S1: `check:local` installs framework only from freshly built tarballs and
      passes the full deterministic test-shop gate; `check:registry` clean-installs
      exact public `0.1.0` and passes; `git status --short` clean after both;
      automated test proves local manifest/image tag depends on tarball digests;
      `k8s:deploy:local` deploys local packages, `k8s:deploy:registry` registry;
      README documents daily local loop and release-verification loop.
- [ ] S2: workflow YAML passes actionlint; fast workflow runs in PR; live PG/Kafka
      jobs use existing conformance suites; kind k8s smoke uses Apache Kafka + Helm;
      full scheduled/manual workflow stores evidence even on FAIL; owner-only setup
      items marked HUMAN ACTION REQUIRED, not claimed done.
- [ ] S3: only explicit named exports in public entrypoints; test-shop uses only
      documented public API; connectors do not import conductor source/internal
      paths; clean external TS consumer compiles from published exports; API reports
      saved and CI-checked; negative test proves an internal helper is not importable.
- [ ] S4: documented exact schema profile; unsupported keywords always rejected with
      localized error; positive/negative compatibility tests incl. former false
      positives (`maxLength`, `additionalProperties`); switch enum coverage still
      fully checked; no `dsl`/`dslVersion`/JSONPath/data-mapping; existing
      flow/compiler/runtime tests stay green.
- [ ] S5: `npm pack --dry-run` shows correct metadata/LICENSE/intended files only;
      repo/issues/homepage present; license metadata consistent (Apache-2.0 for 0.x);
      release workflow cannot publish with non-green gates and supports provenance;
      no new publish/tag performed.
- [ ] S6: new dev understands product/Node requirement/packages from root README and
      can reach running a process; conductor README states Node.js/TypeScript first;
      all quick-start snippets compile in CI; Kafka worker example uses
      `context.requestId`; root/workspace/package/test-shop READMEs have distinct
      roles; English canon + Russian translation consistent and linked;
      link/command/terminology/package-content checks pass.
- [ ] S7: `docs/production-readiness/PLAN.md` + SCAM task files reflect actual order;
      no `dslVersion` compatibility assumption; 1.0 license not described as chosen;
      developer chart not called production-ready; Kafka single-active-publish
      recorded as measurable follow-up.
- [ ] Milestone: full acceptance command list executed with real exit codes; local
      Kubernetes runs current local tarballs, not published `0.1.0`; CI actually
      runs; schema checker rejects unsupported constraints; worktree not polluted.

## Owning gate

`acceptance` — Docker Desktop Kubernetes business + resilience gates in `local`
mode plus a `registry`-mode business gate, on top of the deterministic and package
gates. CI real-run is a separate gate reachable only after branch push.

## External actions

- Allowed by prompt after acceptance: push branch `feat/post-0.1-foundation`,
  create a **draft** PR — only if GitHub access and authority are confirmed.
- Require separate user confirmation: merge to `main`, npm publish, new tag,
  version bump, branch-protection / trusted-publishing / release-asset owner setup,
  any destructive Docker/Kubernetes cleanup beyond safe upgrade.

## Constraints, assumptions and risks

- `CONSTRAINT`: host shell Node is `20.19`; package `engines` require `>=22`. Use
  the installed Node `22.23.1` (nvm) / Node 22 container. Do not change manifests.
- `ASSUMPTION`: Docker Desktop Kubernetes namespace `processengine-test-shop` is
  the pre-existing owned long-lived contour; deploys must be upgrade-safe, no PVC
  or namespace destruction.
- `RISK`: real GitHub Actions runs require a push; YAML/scripts/containers are
  validated locally and CI is only claimed PASS after a real run.
- `RISK`: full English canon translation must not drift from the Russian normative
  invariants (three step types, `input`, `response`/`error`, no `route`, top-level
  `switch.key`, technical-policy/domain-logic separation).

## Stop conditions

- A required change would violate a canon §2 principle → stop, record the concrete
  contradiction with evidence; do not bypass with hidden magic.
- Any gate needs weakening to pass → stop, record FAIL.
- Auth/access becomes interactive or unavailable for a required external action →
  record BLOCKED, ask the user.
