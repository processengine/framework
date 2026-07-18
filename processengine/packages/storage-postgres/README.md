# `@processengine/storage-postgres`

Durable PostgreSQL implementation of the storage SPI exported by
`@processengine/conductor`.

The adapter stores only conductor runtime records. It never loads a Flow3
definition and never interprets an operation `response` or `error`.

## Guarantees

- process state, an operation occurrence and its command outbox record are
  committed atomically;
- operation resolution, response inbox deduplication, the next process state
  and the next command outbox record are committed atomically;
- process revision is checked while the process row is locked;
- an operation must belong to the process being resolved;
- outbox and timeout claims use leases plus monotonically increasing fencing
  versions;
- every initial or reclaimed outbox claim increments the durable dispatch
  attempt while preserving message and request identifiers;
- response, timeout and dispatch-failure races converge on one terminal
  operation resolution;
- the expected response source (`completionSource`) is persisted with every
  operation occurrence;
- a completion deadline starts only after durable publication: while the
  operation is `PENDING`, `deadlineAt` is `null`; marking its outbox record
  `PUBLISHED` atomically marks the operation `PUBLISHED` and derives the
  deadline from the persisted `completionTimeoutMs` policy;
- timeout claims consider only `PUBLISHED` operations with a non-null deadline;
- published timestamps and all retry bookkeeping are durable;
- migrations are ordered, checksummed and serialized with a PostgreSQL advisory
  lock.

These guarantees provide at-least-once command publication. They do not make a
domain side effect exactly-once. An operation service must deduplicate the stable
`requestId` in the same transaction as its own domain change.

## Setup

```ts
import { createPostgresStorage, runPostgresMigrations } from '@processengine/storage-postgres';

const storage = createPostgresStorage({
  connectionString: process.env.DATABASE_URL!,
  schema: 'processengine',
  onPoolError: (error) => logger.error({ error }, 'idle PostgreSQL client failed')
});

await runPostgresMigrations(storage.connectionProvider());
await storage.initialize();
```

The adapter always registers a `pg.Pool` `error` listener. This is required for
idle connections that are terminated during a PostgreSQL restart or outage;
without a listener Node.js treats the event as unhandled and exits. The optional
`onPoolError` callback integrates those events with application logging. Its
default writes the error to `console.error`; operation calls still reject
normally while PostgreSQL is unavailable and can recover through the pool.

Applications that run with a least-privilege runtime role should execute
`runPostgresMigrations()` from a separate deployment job. Runtime startup does
not silently mutate the database schema. `migrationMode: 'apply'` is available
for local or single-owner deployments; the default is `validate`.

## Storage contract assumptions

- `instanceId`, `requestId` and `messageId` are stable non-empty identities;
- every operation binding has a stable non-empty `completionSource` naming the
  response source accepted by the conductor;
- every persisted operation occurrence has exactly one command outbox record;
- a committed `nextState` belongs to the same instance and has revision
  `expectedRevision + 1`;
- `TIMED_OUT` commits carry the timeout claim returned by
  `claimExpiredOperations()`;
- `DISPATCH_FAILED` commits carry the outbox claim returned by `claimOutbox()`;
- conductor timestamps are valid ISO timestamps from a sufficiently coherent
  clock; lease versions, not wall-clock ordering alone, provide fencing;
- operation services use `requestId` as their domain-idempotency key.

A response may win the narrow publish-before-mark race. For that reason an
operation can still be resolved while `PENDING`; the same transaction cancels
its unpublished outbox record. This does not start or require a completion
deadline.

The adapter deliberately treats process state and message envelopes as opaque
JSON. Referential checks cover runtime ownership and revision; business payload
validation remains the conductor/operation contract's responsibility.

## Migration API

The `@processengine/storage-postgres/migrations` export provides:

- `postgresMigrations(schema)` for an inspectable immutable plan;
- `runPostgresMigrations(provider, { schema })` to apply pending migrations;
- `inspectPostgresMigrations(provider, { schema })` to check compatibility;
- `assertPostgresSchemaName()` for the identifier rule used by the adapter.

Applied migration names and SHA-256 checksums are recorded in
`schema_migrations`. A changed or unknown applied migration is rejected.
Future migrations must use expand/contract changes so old and new hosts can run
together during a rolling deployment.

## Health

`storage.checkHealth()` verifies a database round trip and reports the installed
and packaged schema versions. It fails if migrations are missing or incompatible.

## Optional live conformance test

Unit tests do not require PostgreSQL. To run the live storage contour against a
disposable database:

```bash
PROCESSENGINE_POSTGRES_URL=postgres://postgres:postgres@localhost:5432/processengine \
  npm run test:live --workspace @processengine/storage-postgres
```

Use a dedicated database: the live test creates and drops its own uniquely named
schema.
