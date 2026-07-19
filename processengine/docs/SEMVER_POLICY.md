# Versioning and deprecation policy

The three framework packages — `@processengine/conductor`,
`@processengine/transport-kafka`, `@processengine/storage-postgres` — follow
[Semantic Versioning](https://semver.org). While the line is `0.x` it is a
developer preview: minor versions may contain curated breaking changes, always
documented in the changelog and the API reports.

## Positioning

`@processengine/conductor` is the **Node.js/TypeScript core** of ProcessEngine: the
Flow3 process model, deterministic execution semantics, the durable orchestration
runtime, and the storage/transport SPI. It is **not** a "technology-neutral core":
the runtime is specifically Node.js/TypeScript. What is technology-replaceable is
only the *implementation behind the `MessageTransport` and `ProcessStorage` SPI* —
supplied by explicit connector packages — not the runtime itself.

## Public entrypoints

The public surface of each package is exactly the entrypoints declared in its
`package.json` `exports`. Each has a defined purpose and SemVer status. Anything
reachable only through a deep path (e.g. `@processengine/conductor/dist/kernel.js`)
is **not** public and may change in any release. The committed API reports under
`processengine/api-reports/` are the source of truth; CI fails if any entrypoint's
surface changes without an updated, reviewed report.

| Entrypoint | Kind | Purpose | SemVer status |
| --- | --- | --- | --- |
| `@processengine/conductor` | TypeScript | Host/compiler/protocol/SPI API: composition & runtime (`Conductor`, `createConductor`), `compileFlow`, artifact/operation registries, documented errors, wire protocol, SPI interfaces, and canonical process/completion/error/schema types. **No internal transition kernel.** | Stable public API, SemVer-tracked |
| `@processengine/conductor/testing` | TypeScript | Testing/conformance API: in-memory storage/transport, `createMemoryConductor`, `ManualClock`, conformance suites, and the kernel simulation primitives (`evolve`, `success`, `failure`, `TransitionResult`). For tests, not production hosts. | Stable public API, SemVer-tracked |
| `@processengine/conductor/schema/flow.schema.json` | JSON artifact | The published Flow3 JSON Schema. A shipped artifact, **not** a TypeScript API; covered by package-content/smoke checks, not the TS API report. | Versioned via the schema `$id` |
| `@processengine/transport-kafka` | TypeScript | Apache Kafka transport SPI adapter (`createKafkaTransport`, `KafkaTransport`, config). | Stable public API, SemVer-tracked |
| `@processengine/transport-kafka/worker` | TypeScript | Operation-worker API for Kafka command consumers (`createKafkaOperationWorker`, handler contract). | Stable public API, SemVer-tracked |
| `@processengine/storage-postgres` | TypeScript | PostgreSQL storage adapter (`createPostgresStorage`, `PostgresStorage`). | Stable public API, SemVer-tracked |
| `@processengine/storage-postgres/migrations` | TypeScript | Migration API for a standalone migration job (`postgresMigrations`, `runPostgresMigrations`). | Stable public API, SemVer-tracked |

The internal transition kernel (`evolve` and friends), low-level JSON helpers, and
the schema-compatibility implementation are **not** part of any root API; the
kernel simulation helpers are reachable only through the explicit `/testing`
subpath.

## What counts as breaking

- Removing or renaming a public export.
- Changing a public type in a way that rejects previously valid callers.
- A flow/compiler change that makes a previously compiling flow fail, or that
  changes its normalized digest.

Such changes require a minor bump while on `0.x`, and a major bump from `1.0`.

## The curated surface change is a `0.2.0`

Curating the previously `export *` root of `@processengine/conductor` removes
incidental exports that were never intended as root contract — internal JSON/schema
helpers, and the transition kernel (`evolve`, `success`, `failure`,
`TransitionResult`) which now lives only under `@processengine/conductor/testing`.
Because removing already-published `0.1.0` root exports is breaking, this is
prepared as part of the next minor, **`0.2.0`** — not a patch. No version bump or
publish is performed as part of this preparation.

## Deprecation

A public export slated for removal is first marked `@deprecated` in its TSDoc with
the replacement and the earliest version in which it may be removed. Deprecations
are listed in the changelog. A deprecated export is not removed before the next
minor (0.x) or major (>=1.0) boundary.
