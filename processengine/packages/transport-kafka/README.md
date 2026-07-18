# `@processengine/transport-kafka`

Apache Kafka connector for `@processengine/conductor`.

The package supplies two independent surfaces:

- `createKafkaTransport()` implements the host-side transport SPI;
- `createKafkaOperationWorker()` exposes operation handlers to Kafka without
  exposing Flow3 DSL concepts to a domain service.

Defaults favor explicit infrastructure management: automatic topic creation is
disabled and new consumer groups begin at the current end of a topic. Invalid
records block consumption by default; applications may explicitly choose skip
or dead-letter behavior.

`connectionTimeoutMs`, `requestTimeoutMs`, KafkaJS `retry`, and
`publishTimeoutMs` bound transport work below a durable outbox lease. Defaults
are 5 seconds for connection, 10 seconds per request, two short retries, and 15
seconds for one caller's `publish()` wait. A host that increases those bounds
must also increase `worker.outboxLeaseMs`. The connector applies the finite
retry policy explicitly to its idempotent producer: KafkaJS otherwise retries
an idempotent producer effectively forever.

KafkaJS cannot cancel a `producer.send()` that has already started. A
`KafkaPublishTimeoutError` therefore reports `deliveryStatus: "unknown"` for an
in-flight send, or `"not-attempted"` when the message timed out waiting behind
another send. The transport keeps a single local send in flight. Repeated calls
with the same stable `messageId` and identical envelope join that send; after a
caller timeout, its late success is consumed by the next retry without issuing
another local send, while a late rejection permits a new attempt. Reusing an
active or late-success `messageId` with different content throws
`KafkaPublishIdentityConflictError`. Cross-attempt durability and retry timing
remain the Conductor outbox's responsibility, and delivery remains at-least-once.

```ts
const transport = createKafkaTransport({
  clientId: 'shop-host',
  brokers: ['kafka:9092'],
  invalidMessage: {
    strategy: 'dead-letter',
    deadLetterTopic: 'processengine.invalid-messages'
  }
});
```

Operation services return explicit canonical completions:

```ts
const worker = createKafkaOperationWorker({
  source: 'shop-warehouse',
  destination: 'shop.warehouse.operations',
  consumerGroup: 'shop-warehouse',
  transport,
  handlers: {
    'warehouse.reserve': async (input) => operationSuccess(await reserve(input))
  }
});
```

The connector provides at-least-once delivery. Operation handlers must make
side effects idempotent by stable `requestId`; `test-shop` demonstrates a
PostgreSQL operation ledger. A producer retry, consumer restart, or deliberately
duplicated service response can therefore repeat a command or completion.
Neither Kafka's idempotent producer nor this worker makes domain side effects
exactly-once.

The adapter validates the Kafka record against its ProcessEngine envelope before
delivery: record key, topic, `message-id`, `message-type`, and
`protocol-version` must all agree. Missing values, malformed JSON, and mismatches
are poison records. The default policy throws, so the partition does not silently
advance past an unknown record; `skip` and `dead-letter` are explicit opt-ins.

A record is acknowledged only after the application handler resolves. Handler
errors—including `TypeError` and transient storage failures—are supervised and
retried against the same offset with heartbeats and backoff, so KafkaJS cannot
silently leave a dead consumer after a non-retriable JavaScript error. The
backoff itself is heartbeat-aware even when configured longer than one heartbeat
interval. The default poison-message policy therefore blocks and visibly retries
its partition; operators must choose `skip` or `dead-letter` to advance it
intentionally.

## Verification

`npm test` runs deterministic unit tests without Kafka. They cover record/envelope
validation and the worker's stable-request-id behavior. In the duplicate-command
case the service ledger deduplicates the domain side effect, while the worker may
publish the same completion again; conductor storage must accept that completion
idempotently.

`npm run test:live` is a separate, environment-gated Kafka round-trip test. Set
`KAFKA_LIVE_BROKERS` to a comma-separated broker list; when it is absent the live
suite is skipped. The test creates uniquely named topics and removes them after
the run.
