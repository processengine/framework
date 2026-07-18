# Business acceptance contract

`node scripts/acceptance.mjs` is a black-box oracle over the three service APIs. Compose and Kubernetes wrappers discover local endpoints and invoke the same script.

Every scenario asserts all three layers:

- projected terminal process status and outcome, plus exact equality between the
  end step's declared result reference, persisted terminal payload, and API projection;
- persisted domain state (`reservation` and `authorization` rows);
- exact operation ledger cardinality and effect counters.

Readiness alone never passes a business scenario.

## Automated branches

| Scenario | Expected terminal outcome | Durable domain invariant |
|---|---|---|
| success | `APPROVED` | active reservation, confirmed payment, each effect once |
| service duplicate completion | `APPROVED` | a durable control row records the broker-acknowledged fresh message id, the stored outbox completion is also published, and process/effects remain singular |
| out of stock | `OUT_OF_STOCK` | no reservation or payment |
| warehouse returned error | `WAREHOUSE_UNAVAILABLE` | no reservation or payment |
| warehouse handler threw | `WAREHOUSE_HANDLER_FAILED` | sanitized `HANDLER_FAILED`, no domain effect |
| payment declined | `PAYMENT_DECLINED` | reservation released once, declined payment recorded once |
| payment operation error | `PAYMENT_ERROR_COMPENSATED` | reservation released once, no payment row |
| payment error + stock compensation failure | `COMPENSATION_FAILED` | active reservation is retained for manual recovery; no payment row |
| payment timeout | `PAYMENT_ERROR_COMPENSATED` | reservation released once; a later valid success is ignored |
| confirmation returned failure | `PAYMENT_CONFIRM_FAILED` | authorization cancelled once, then stock released once |
| confirmation failure + stock compensation failure | `COMPENSATION_FAILED` | payment cancelled once; active reservation retained for recovery |
| confirmation operation error | `PAYMENT_CONFIRM_ERROR_COMPENSATED` | authorization cancelled once, then stock released once |
| confirmation error + stock compensation failure | `COMPENSATION_FAILED` | payment cancelled once; active reservation retained for recovery |
| confirmation error + payment compensation failure | `PAYMENT_COMPENSATION_FAILED` | authorization and reservation remain active for recovery |
| payment compensation failed | `PAYMENT_COMPENSATION_FAILED` | reservation stays active for manual handling |
| stock compensation failed | `COMPENSATION_FAILED` | reservation remains active; failure is visible |

The gate also starts the same checkout concurrently, validates missing/invalid idempotency keys and conflicting reuse, replays exact commands, and injects completion variants:

- same completion with the same message id;
- same request id with a new message id;
- conflicting `SUCCESS → ERROR` completion;
- completion after the process already advanced;
- valid completion after timeout and terminal compensation;
- completion from a foreign source;
- completion with an unknown request id;
- malformed payload.

After injection it compares raw persisted revision, outcome, and step results, then repeats domain ledger assertions.

## Running one branch

Against already running endpoints:

```bash
node scripts/acceptance.mjs \
  --base-url http://127.0.0.1:3000 \
  --warehouse-url http://127.0.0.1:8081 \
  --payment-url http://127.0.0.1:8082 \
  --scenario confirm-error
```

Fault tokens and debug endpoints exist only when `DEMO_FAULTS_ENABLED` and `DEBUG_API_ENABLED` are enabled. They are acceptance fixtures and not part of the domain API.
