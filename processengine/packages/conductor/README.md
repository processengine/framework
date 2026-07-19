# @processengine/conductor

`@processengine/conductor` is the Node.js/TypeScript core of ProcessEngine. It
defines the Flow3 process model, deterministic execution semantics, the durable
orchestration runtime, and the storage and transport SPI used by host
applications. The core is independent of a particular broker or database; those
capabilities are supplied by explicit connector packages — the neutrality is at
the `MessageTransport`/`ProcessStorage` boundary, not the runtime itself.

The public root API is the host/compiler/protocol/SPI surface. The pure
state-transition kernel is internal; memory implementations, conformance helpers
and the kernel simulation primitives are available from
`@processengine/conductor/testing`. See `docs/SEMVER_POLICY.md` for the full
entrypoint map.

## Ownership boundaries

- A flow definition owns process control logic.
- An operation owns domain logic and data processing.
- Process state stores immutable input, accepted completions and execution
  position.
- `Conductor` owns durable dispatch, correlation, timeout and recovery.
- Storage and transport implementations own technology-specific mechanics but
  preserve the exported SPI semantics.

The runtime never maps or aggregates business payloads. Every consuming step
references one complete `response` or `error` of one guaranteed earlier
operation.

## Flow3

```json
{
  "id": "shop.checkout",
  "version": "1.0.0",
  "start": "validate",
  "steps": {
    "validate": {
      "type": "operation",
      "operation": "payment.validate",
      "next": "route-validation",
      "onError": "route-error"
    },
    "route-validation": {
      "type": "switch",
      "input": { "step": "validate", "resultType": "response" },
      "key": "resultCode",
      "routes": {
        "VALID": "valid",
        "INVALID": "invalid"
      }
    },
    "route-error": {
      "type": "switch",
      "input": { "step": "validate", "resultType": "error" },
      "key": "code",
      "routes": {
        "PAYMENT_REJECTED": "rejected",
        "PROCESSENGINE_COMPLETION_TIMEOUT": "unavailable",
        "PROCESSENGINE_DISPATCH_FAILED": "unavailable"
      }
    },
    "valid": { "type": "end", "outcome": "VALID" },
    "invalid": {
      "type": "end",
      "outcome": "INVALID",
      "input": { "step": "validate", "resultType": "response" }
    },
    "rejected": {
      "type": "end",
      "outcome": "REJECTED",
      "input": { "step": "validate", "resultType": "error" }
    },
    "unavailable": {
      "type": "end",
      "outcome": "UNAVAILABLE",
      "input": { "step": "validate", "resultType": "error" }
    }
  }
}
```

```ts
import {
  compileFlow,
  createConductor,
  StaticArtifactRegistry,
  StaticOperationCatalog
} from '@processengine/conductor';

const operations = new StaticOperationCatalog([
  {
    operation: 'payment.validate',
    destination: 'payment.commands',
    completionSource: 'payment-service',
    policy: {
      id: 'standard',
      version: '1',
      completionTimeoutMs: 10_000,
      dispatch: { maxAttempts: 5, retryDelayMs: 250 }
    }
  }
]);

const compiled = compileFlow(definition, { operations });
const artifacts = new StaticArtifactRegistry([compiled]);
const conductor = createConductor({
  source: 'checkout-host',
  completionDestination: 'checkout.completions',
  artifacts,
  operations,
  storage,
  transport
});
```

## Canonical completion

```ts
type OperationCompletion =
  | { status: 'SUCCESS'; response: JsonValue; error: null }
  | { status: 'ERROR'; response: null; error: OperationError };

type OperationError = {
  code: string;
  message: string;
  details: JsonValue | null;
};
```

Retry counters, policy identifiers, transport headers and correlation metadata
are not stored in completion payloads. They remain in operation/outbox records.

## Durability contract

`ProcessStorage` atomically persists:

1. a new process state and its first outbox command;
2. an accepted completion, revised process state and optional next command;
3. inbox deduplication and operation resolution.

Outbox and timeout claims carry monotonic fencing versions. A worker whose lease
was reclaimed cannot publish a state transition using a stale claim. Message
delivery is at-least-once; operation integrations must deduplicate side effects
by the stable `requestId`, which is `${instanceId}:${stepId}` for the acyclic v1
model.

Each `Conductor` runs its local tick as a single flight. Cross-instance safety
comes from storage leases and fencing. `worker.outboxLeaseMs` must be longer than
the transport connector's maximum bounded `publish()` call; the core default is
60 seconds. A reclaimed lease is a new dispatch attempt and retains the same
message and request identifiers.

`start()` may be retried on the same runtime after transient adapter startup or
subscription failure. A successfully initialized storage adapter remains open
between those attempts, while a started transport is rolled back before the
next attempt. `stop()` is the explicit, terminal ownership boundary: it closes
all initialized adapters, and that `Conductor` instance cannot be started again.

An operation binding also declares `completionSource`. A completion is accepted
only when its envelope destination is the conductor's configured completion
destination, its partition key is the process instance, and its source exactly
matches the source persisted with the dispatched operation. This correlation is
an identity check, not transport authentication; production transports must
still enforce producer authorization.

The completion timeout starts only after command publication is durably
recorded. A newly created operation is `PENDING` with `deadlineAt: null`;
`markOutboxPublished` atomically changes it to `PUBLISHED` and sets the deadline
to `publishedAt + completionTimeoutMs`. Broker outages therefore consume only
the dispatch retry policy and cannot masquerade as completion timeouts.

## Testing connectors

```ts
import {
  runMessageTransportConformance,
  runProcessStorageConformance
} from '@processengine/conductor/testing';

await runProcessStorageConformance(() => createYourStorage());
await runMessageTransportConformance(() => createYourTransport());
```

The storage suite checks idempotent creation, atomic completion plus
`nextDispatch`, inbox duplicates, competing completions, leases and fencing for
timeouts and dispatch failure. The transport suite checks competing consumers
inside one group, fan-out across groups, negative-acknowledgement redelivery,
ordering after retry, idempotent unsubscribe/stop and rejection after stop. For
a real broker, pass an existing disposable destination and an optional group
settling delay through `MessageTransportConformanceOptions`.

The JSON Schema is exported as
`@processengine/conductor/schema/flow.schema.json`.
