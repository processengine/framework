import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { MessageEnvelope } from '@test-shop/service-kit';
import { paymentCompletionPublishDecision } from '../apps/shop-payment/src/payment.js';

describe('payment completion outbox gate', () => {
  it('defers and releases the rolling-update completion without blocking the handler', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{
      checkout_id: 'checkout-1',
      released: false,
      deliveries: 1,
      worker_ids: ['payment-1'],
      duplicate_publications: 0,
      duplicate_message_ids: [],
      last_entered_at: new Date().toISOString(),
    }] }).mockResolvedValueOnce({ rows: [{
      checkout_id: 'checkout-1',
      released: true,
      deliveries: 1,
      worker_ids: ['payment-1'],
      duplicate_publications: 0,
      duplicate_message_ids: [],
      last_entered_at: new Date().toISOString(),
    }] });
    const pool = { query } as unknown as Pool;
    const message = completion('checkout-1', 'tok-upgrade-barrier');

    await expect(paymentCompletionPublishDecision(pool, message, {
      demoFaults: true,
      delayedResponseMs: 15_000,
    })).resolves.toEqual({ kind: 'defer', retryAfterMs: 250 });
    await expect(paymentCompletionPublishDecision(pool, message, {
      demoFaults: true,
      delayedResponseMs: 15_000,
    })).resolves.toEqual({ kind: 'publish' });
  });

  it('uses the durable delivery timestamp for a finite delayed completion', async () => {
    const futureEntry = new Date(Date.now() + 10_000).toISOString();
    const pastEntry = new Date(Date.now() - 20_000).toISOString();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [control(futureEntry)] })
      .mockResolvedValueOnce({ rows: [control(pastEntry)] });
    const pool = { query } as unknown as Pool;
    const message = completion('checkout-2', 'tok-delayed');

    const deferred = await paymentCompletionPublishDecision(pool, message, {
      demoFaults: true,
      delayedResponseMs: 15_000,
    });
    expect(deferred.kind).toBe('defer');
    if (deferred.kind === 'defer') expect(deferred.retryAfterMs).toBeGreaterThan(20_000);
    await expect(paymentCompletionPublishDecision(pool, message, {
      demoFaults: true,
      delayedResponseMs: 15_000,
    })).resolves.toEqual({ kind: 'publish' });
  });
});

function completion(checkoutId: string, paymentToken: string): MessageEnvelope {
  return {
    payload: { response: { checkoutId, paymentToken } },
  } as unknown as MessageEnvelope;
}

function control(lastEnteredAt: string) {
  return {
    checkout_id: 'checkout-2',
    released: false,
    deliveries: 1,
    worker_ids: ['payment-1'],
    duplicate_publications: 0,
    duplicate_message_ids: [],
    last_entered_at: lastEnteredAt,
  };
}
