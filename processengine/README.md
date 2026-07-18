# ProcessEngine

ProcessEngine is a framework for durable domain business processes. The
monorepo publishes three independent npm packages:

| Package | Responsibility |
| --- | --- |
| `@processengine/conductor` | Flow3 DSL, canonical state, durable runtime and technology-neutral SPI |
| `@processengine/transport-kafka` | Apache Kafka transport and operation-worker integration |
| `@processengine/storage-postgres` | PostgreSQL state, inbox, outbox, leases and migrations |

The host application composes the packages. Flow definitions contain process
control logic; operations own domain logic and data processing; state stores
execution facts; the runtime provides durable execution.

```ts
import {
  StaticArtifactRegistry,
  StaticOperationCatalog,
  createConductor
} from '@processengine/conductor';
import { createKafkaTransport } from '@processengine/transport-kafka';
import { createPostgresStorage } from '@processengine/storage-postgres';
import checkoutDefinition from './flows/shop.checkout.json' with { type: 'json' };

const storage = createPostgresStorage({
  connectionString: process.env.DATABASE_URL!,
  migrationMode: 'apply'
});

const transport = createKafkaTransport({
  clientId: 'shop-host',
  brokers: ['kafka:9092']
});

const operations = new StaticOperationCatalog([
  {
    operation: 'warehouse.reserve',
    destination: 'shop.warehouse.commands',
    completionSource: 'shop-warehouse',
    policy: {
      id: 'shop-default',
      version: '1',
      completionTimeoutMs: 15_000,
      dispatch: { maxAttempts: 20, retryDelayMs: 500 }
    }
  },
  {
    operation: 'payment.authorize',
    destination: 'shop.payment.commands',
    completionSource: 'shop-payment',
    policy: {
      id: 'shop-default',
      version: '1',
      completionTimeoutMs: 15_000,
      dispatch: { maxAttempts: 20, retryDelayMs: 500 }
    }
  }
]);
const artifacts = new StaticArtifactRegistry([checkoutDefinition], { operations });

const conductor = createConductor({
  source: 'shop-host',
  completionDestination: 'shop.operation.completions',
  artifacts,
  operations,
  storage,
  transport
});

await conductor.start();
```

## Development

The package manifests and lockfile are the source of truth for supported
runtimes and dependency versions.

```bash
npm ci
npm run check
npm run pack:all
npm run check:packages
```

`npm run pack:all` writes consumer-installable tarballs to `.packages/`.

The external `test-shop` repository in the distribution bundle consumes only
these packed public packages and supplies the Docker Desktop Kubernetes
acceptance and resilience contour.

## Package boundary rules

- Connector packages import only public exports of `@processengine/conductor`.
- Connector packages are independently publishable and use conductor as a peer dependency.
- Cross-package source imports are forbidden.
- Memory implementations and conformance helpers live under
  `@processengine/conductor/testing`.
- Technology configuration stays in its connector; the host application is
  the explicit composition root for the selected connectors and domain code.

See `docs/PROCESSENGINE_CANON.md` for the normative design.
