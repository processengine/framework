import { describe, expect, it } from 'vitest';
import {
  operationCommandEnvelope,
  type MessageEnvelope,
  type MessageTransport,
  type OperationCompletion,
} from '@processengine/conductor';
import { createKafkaOperationWorker, operationSuccess } from '../src/worker.js';

class TestTransport implements MessageTransport {
  readonly published: MessageEnvelope[] = [];
  private handler: ((message: MessageEnvelope) => Promise<void>) | undefined;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async publish(message: MessageEnvelope): Promise<void> { this.published.push(message); }
  async subscribe(options: {
    readonly destination: string;
    readonly consumerGroup: string;
    readonly handler: (message: MessageEnvelope) => Promise<void>;
  }): Promise<() => Promise<void>> {
    this.handler = options.handler;
    return async () => { this.handler = undefined; };
  }

  async deliver(message: MessageEnvelope): Promise<void> {
    if (!this.handler) throw new Error('No subscriber');
    await this.handler(message);
  }
}

describe('KafkaOperationWorker duplicate delivery contract', () => {
  it('preserves stable requestId so a service ledger can dedupe a repeated command', async () => {
    const transport = new TestTransport();
    const ledger = new Map<string, OperationCompletion>();
    let domainSideEffects = 0;
    const worker = createKafkaOperationWorker({
      source: 'shop-payment',
      destination: 'shop.payment.operations',
      consumerGroup: 'shop-payment',
      transport,
      now: () => new Date('2026-07-18T10:00:01.000Z'),
      handlers: {
        'payment.authorize': (_input, context) => {
          const previous = ledger.get(context.requestId);
          if (previous) return previous;
          domainSideEffects += 1;
          const completion = operationSuccess({ status: 'APPROVED', authorizationId: 'auth-1' });
          ledger.set(context.requestId, completion);
          return completion;
        },
      },
    });
    await worker.start();
    const command = operationCommandEnvelope({
      source: 'shop-host',
      destination: 'shop.payment.operations',
      responseDestination: 'shop.operation.completions',
      occurredAt: '2026-07-18T10:00:00.000Z',
      payload: {
        requestId: 'checkout-1:authorize-payment',
        instanceId: 'checkout-1',
        stepId: 'authorize-payment',
        operation: 'payment.authorize',
        input: { amount: 1200, currency: 'EUR' },
      },
    });

    await transport.deliver(command);
    await transport.deliver(command);

    expect(domainSideEffects).toBe(1);
    expect(transport.published).toHaveLength(2);
    expect(transport.published[0]).toEqual(transport.published[1]);
    expect(transport.published[0]?.messageId).toBe('checkout-1:authorize-payment:completion');
    await worker.stop();
  });
});
