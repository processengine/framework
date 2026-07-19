# Work Record: PE-M3-STABILIZE-CORRECTIVE

Branch `feat/post-0.1-foundation`. Corrective slice after the independent review
of `PE-M3-STABILIZE`. Baseline reconfirmed; `origin/main` already integrated at
merge commit `bfd6683` (no force-push, no history rewrite).

## Blocker 1 — signature-level API snapshot (`ebd5815`)

`scripts/api-report.mjs` recorded only `{name, kind}`, so a changed parameter,
return type, interface field, optionality, generic, or union slipped past the
gate. Replaced with `@microsoft/api-extractor` (dev-only), producing a
deterministic report from each built `.d.ts` entrypoint for all six TypeScript
entrypoints (conductor + `/testing`, transport-kafka + `/worker`, storage-postgres
+ `/migrations`). Reports carry full declarations, e.g.
`compileFlow(value: unknown, options?: CompileFlowOptions): CompiledProcessDefinition`.
`test/api-report.test.ts` pins signature-level detail and proves the kernel is
absent from the root report and present in `/testing`. Demonstrated: mutating one
parameter type in a report makes `api:check` exit 1. The JSON schema export stays
in the package smoke / content checks, not the TS API report. Package smoke still
installs real tarballs, compiles an external TypeScript consumer of every
entrypoint, and rejects deep internal imports.

## Blocker 2 — kernel out of root; test-shop via public runtime (`5021827`)

Removed `evolve`, `success`, `failure`, and `TransitionResult` from
`@processengine/conductor`; they live only in `@processengine/conductor/testing`.
This is a deliberate `0.2.0` breaking change (no bump/publish here).

test-shop no longer imports kernel primitives. A new mode-stable harness,
`test-shop/tests/support/checkout-runtime.ts`, drives the shipped checkout flow
through the public runtime only — `startProcess`, worker `tick`, `handleCompletion`
via the public completion contract, `getProcess` — using API present in both
published `0.1.0` and the local build. The two internal failure classes use real
mechanics: completion timeout via `ManualClock` advance, dispatch failure via a
`MemoryMessageTransport` that refuses to publish (`maxAttempts: 1`). Full terminal
matrix (16 end steps) and compensation coverage are preserved; timeout and
dispatch-failed now assert the real runtime error objects. The same test-shop
source passes against local tarballs and published `0.1.0`.

Capability note: `createMemoryConductor` alone cannot inject a failing transport,
so the dispatch-failure case constructs a `Conductor` with a controlled transport
— all public API, no kernel exposure.

## Blocker 3 — single entrypoint map (`8f9a96b`)

`SEMVER_POLICY.md` now lists every published entrypoint with purpose and SemVer
status, states the conductor root is the Node.js/TypeScript core, and scopes
neutrality to the `MessageTransport`/`ProcessStorage` SPI boundary — not a
"technology-neutral core". The conductor package README carries the same
positioning. Removed the contradiction where the policy called the kernel internal
while the root exported it.

## Blocker 4 — safe, verifiable review bundle (`6aec5bc`, `7d0a9fb`)

`review:bundle` refuses to run on a dirty worktree, produces a `git bundle`
carrying both `origin/main` and the branch HEAD, and includes evidence
(branch/HEAD/base, merge-base, decorated `git log origin/main..HEAD`,
`git diff --stat origin/main...HEAD`, `git status --short`, `git diff --check`),
a net diff, a `git am`-applicable patch series, a source snapshot, and a
`SHA256SUMS` manifest. It excludes `.npm-cache`, `.work`, `.artifacts`,
`.packages`, `node_modules`, `dist`, `.git`, `.npmrc`, `.env`, and any stray
`.zip` at top level and nested, and never re-includes a prior bundle. The
include/exclude policy and required evidence files are exported and pinned by
`processengine/test/review-bundle.test.ts`. Verified: `git bundle list-heads`
shows both refs; `sha256sum -c SHA256SUMS` is OK; ~0.9 MB.

## Gates (real exit codes)

| Command | Result |
| --- | --- |
| `npm run check:local` | PASS (exit 0) |
| `npm run check:registry` | PASS (exit 0) |
| framework `npm run check` | PASS — 116 passed, 8 live skipped |
| test-shop deterministic gate (both modes) | PASS — 51/51 each |
| `npm --prefix processengine run api:check` | PASS — 6 reports up to date |
| `npm --prefix processengine run check:packages` | PASS |
| `git diff --check` | PASS (clean) |
| `git status --short` | empty |
| static: kernel in root/test-shop | none |
| static: "technology-neutral ProcessEngine core" | none |
| Real GitHub Actions / kind smoke / live Docker Desktop k8s | NOT RUN |

## Remaining risk / notes

- The only `failure` symbol left in test-shop is `@test-shop/service-kit`'s own
  domain helper, unrelated to the conductor kernel.
- Curating the conductor root (kernel removal) is a `0.2.0` breaking change; a
  future task that wants `evolve`/`success`/`failure` off `/testing` too would need
  to re-express the kernel simulation differently.

## Status

`PE-M3-STABILIZE-CORRECTIVE`: `DONE`. `PE-M3` remains `SPLIT/IN_PROGRESS`.
HEAD `ebd5815`; docs commit follows.
