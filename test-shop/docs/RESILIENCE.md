# Kubernetes resilience gate

`npm run k8s:resilience` executes destructive fault injection only after proving:

- current context is exactly `docker-desktop`;
- namespace is exactly `processengine-test-shop`;
- the namespace has both `processengine.io/owner=test-shop` and `processengine.io/environment=docker-desktop`;
- exactly two replicas of each application and the required stateful dependencies are ready.

The test uses `kubectl proxy` rather than a pod-bound port-forward, so deletion and rollout of the serving host do not invalidate the test channel.

## Executable scenarios

1. Traffic is observed from both actual `shop-host` pod identities through the Kubernetes Service.
2. The host that initiated a process is force-deleted while payment is pending; another host completes the same durable process.
3. Kafka is stopped after a dispatch is durable and has a failed publication attempt; the identified host that initiated the process is force-deleted; after Kafka recovery the same outbox record drains and the process completes once. The test does not mislabel the opaque lease-worker UUID as a pod identity.
4. A payment worker exits after committing its domain effect and response. A durable control row proves Kafka redelivers the command to a distinct service-instance UUID; the shared outbox then completes the process without duplicating authorization.
5. A distributed PostgreSQL-backed barrier holds an unfinished v1 authorization while a real Helm activation replaces both pods of all three applications (the shared ConfigMap checksum intentionally rolls all of them). Only after every old pod identity is gone is the barrier released. The unchanged image contains both immutable JSON artifacts; the old process remains pinned to v1/`APPROVED`, completed state is byte-for-byte unchanged, and a new process demonstrates the observable v2 outcome `APPROVED_V2`. The active version is restored in `finally`.
6. A completion is replayed after terminal state; revision, outcome, results, and domain ledgers remain unchanged.
7. Kafka is scaled to zero. The gate proves a durable failed outbox attempt, restores Kafka, then proves all three stable dispatch rows are `PUBLISHED` and domain effects are singular.
8. PostgreSQL is scaled to zero after a durable control row proves the delayed payment handler entered. It remains down for 20 seconds—longer than the handler's 15-second delay—so the in-flight transaction crosses the outage. PostgreSQL is restored without restarting applications; the process resumes from the same persisted revision and completes with exact ledgers.

The business gate separately covers same/new message-id duplicates, conflicting replies, foreign-source replies, unknown request IDs, malformed replies, late success after timeout, and duplicate commands. Focused conductor tests cover deterministic dispatch exhaustion and unknown switch routes because inducing them by corrupting a live contour would test the fixture more than the kernel.

## Interpretation

The demo readiness endpoints are intentionally shallow process-readiness signals. Once startup succeeds, they do not claim deep Kafka/PostgreSQL availability. Outage recovery is proven by persisted process/outbox/ledger assertions, not by readiness status.

Passing this gate demonstrates single-node dependency restart recovery and stateless application failover. It does not demonstrate HA Kafka, HA PostgreSQL, zone loss, backup restore, TLS rotation, or production capacity.
