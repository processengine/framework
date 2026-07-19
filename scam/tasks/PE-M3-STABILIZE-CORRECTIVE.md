# Task Contract: PE-M3-STABILIZE-CORRECTIVE

Corrective task raised by the independent review of the `PE-M3-STABILIZE`
checkpoint. Four confirmed blockers; a small corrective slice, not a rework. The
previously accepted stabilization fixes are kept.

## Outcome

1. The API drift gate tracks the full public TypeScript contract of every npm
   entrypoint — signatures, types, interface fields and optionality.
2. The internal transition kernel is not part of the conductor root API; the
   test-shop contour runs in `local` and `registry` modes through a stable public
   facade.
3. Documentation, `package.json` exports, and API reports describe the same public
   surface.
4. The review bundle lets an independent agent verify the exact git diff and
   evidence, and contains no caches, stale artifacts, or local junk.
5. All deterministic local/registry gates pass; unrun external checks stay `NOT RUN`.

## Scope

### In scope

- `processengine/scripts/**`, `processengine/api-reports/**`.
- `processengine/packages/*/src/**` and related focused tests.
- Manifests/lockfiles only for the dev-tooling API snapshot (API Extractor).
- test-shop tests that used kernel simulation.
- `processengine/docs/SEMVER_POLICY.md` and directly related docs.
- Root review-bundle tooling.
- SCAM Task Contract, Project Context, Work Record/handoff.

### Out of scope (frozen)

- Slice 6 (full documentation rewrite), live Kubernetes acceptance, publish,
  version bump, tag, push, PR, merge.
- Changes to DSL, state model, schema profile, Kafka/Postgres runtime, or the
  previously accepted resilience mechanisms.
- Toolchain audit; `engines`/package-manager/lockfile changes for local environment.

## Acceptance — frozen (from the corrective prompt)

- [x] API reports capture full TypeScript signatures for all six entrypoints.
- [x] A regression test proves drift on a signature change without a rename.
- [x] `evolve`, `success`, `failure`, and the internal transition result are absent
      from the conductor root.
- [x] test-shop imports no kernel primitives and keeps terminal/compensation
      coverage through the public testing/runtime facade.
- [x] `check:local` and `check:registry` pass on one test-shop source.
- [x] The SemVer policy matches the real package exports.
- [x] The review bundle contains no caches/artifacts/old archives and lets a
      reviewer independently reconstruct the git diff and verify HEAD.
- [x] All deterministic gates exit 0.
- [x] Project Context and handoff carry only confirmed statuses.
- [x] No push, PR, merge, publish, version bump, or tag.

## Blockers → commits

| Blocker | Fix | Commit |
| --- | --- | --- |
| B1 kernel in root API + straddling test-shop | kernel out of root (→ `/testing`); test-shop driven by public `createMemoryConductor` runtime harness | `5021827` |
| B3 SemVer/positioning contradiction | single entrypoint map; drop "technology-neutral core" | `8f9a96b` |
| B4 review bundle safety/verifiability | fail on dirty tree; bundle `origin/main`+HEAD; evidence + SHA-256; policy test | `6aec5bc`, `7d0a9fb` |
| B1 name-only API snapshot | API Extractor signature-level reports for all six entrypoints; drift regression | `ebd5815` |

## Verification

`check:local` exit 0; `check:registry` exit 0 (one test-shop source, both modes);
framework 116 passed / 8 skipped; test-shop 51/51 each mode; `api:check` clean for
six reports (drift demonstrated by mutating one parameter type); `check:packages`
external TypeScript consumer + internal-import rejection pass; `git diff --check`
clean; `git status --short` empty. Real GitHub Actions, kind smoke, and live
Docker Desktop Kubernetes acceptance: `NOT RUN`.

## External actions

Local commits on `feat/post-0.1-foundation` only. No push/PR/publish/tag. No
namespace/PVC changes.

## Status

`PE-M3-STABILIZE-CORRECTIVE`: `DONE`. `PE-M3` remains `SPLIT/IN_PROGRESS` (Slice 6,
real CI/kind, and live acceptance are separate later tasks).
