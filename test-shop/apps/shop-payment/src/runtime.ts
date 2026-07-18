import { createOperationService } from '@test-shop/service-kit';
import { DEMO_FIXTURES, OPERATIONS, parseAuthorizePaymentInput, type JsonValue } from '@test-shop/contracts';
import type { PaymentConfig } from './config.js';
import { markDuplicatePublication, markPaymentDelivery, migratePayment, paymentHandlers } from './payment.js';

export function createPaymentService(config: PaymentConfig) {
  const service = createOperationService({
    serviceName: 'shop-payment',
    source: 'test-shop.shop-payment',
    databaseUrl: config.databaseUrl,
    databaseSchema: 'payment_service',
    kafka: {
      brokers: config.brokers,
      clientId: config.clientId,
      commandTopic: config.commandTopic,
      consumerGroup: config.consumerGroup,
    },
    handlers: paymentHandlers({ demoFaults: config.demoFaults, delayedResponseMs: config.delayedResponseMs }),
    migrateDomain: migratePayment,
    outboxPollMs: config.outboxPollMs,
    beforeAccept: async ({ command, serviceInstanceId, pool }) => {
      if (!config.demoFaults || command.operation !== OPERATIONS.authorizePayment) return;
      const input = parseAuthorizePaymentInput(command.input as JsonValue);
      await markPaymentDelivery(pool, input.checkoutId, serviceInstanceId);
    },
    afterCommit: async ({ command, created }) => {
      if (!created || !config.demoFaults || command.operation !== OPERATIONS.authorizePayment) return;
      const input = parseAuthorizePaymentInput(command.input as JsonValue);
      if (input.paymentToken === DEMO_FIXTURES.paymentCrashAfterCommit) globalThis.process.exit(73);
      if (input.paymentToken === DEMO_FIXTURES.paymentDuplicateCompletion) {
        // A deliberately faulty service-side publication. It uses the same
        // operation requestId but a fresh messageId; the original stored
        // completion remains in the durable outbox and is relayed normally.
        // This proves request-level first-completion-wins semantics rather
        // than relying only on broker/message-id deduplication.
        const messageId = await service.injectCompletion(command.instanceId, 'new-message-id');
        // The control row is updated only after Kafka acknowledges the direct
        // publication, making the acceptance oracle evidence of a real second
        // completion rather than evidence that the fixture branch was entered.
        await markDuplicatePublication(service.pool, input.checkoutId, messageId);
      }
    },
  });
  return service;
}
