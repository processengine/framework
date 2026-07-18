import { describe, expect, it } from 'vitest';
import { parseCheckoutInput } from '../apps/shop-host/src/app.js';
import { projectCheckout } from '../apps/shop-host/src/projection.js';

describe('shop-host HTTP boundary', () => {
  it('uses the idempotency key as the canonical checkout identity', () => {
    expect(parseCheckoutInput('checkout-42', {
      checkoutId: 'ignored-body-identity',
      customerId: 'customer-7',
      items: [{ sku: 'SKU-1', quantity: 2 }],
      paymentToken: 'tok-ok',
    })).toEqual({
      checkoutId: 'checkout-42',
      customerId: 'customer-7',
      items: [{ sku: 'SKU-1', quantity: 2 }],
      paymentToken: 'tok-ok',
    });
  });

  it.each([
    [{ customerId: '', items: [{ sku: 'SKU-1', quantity: 1 }], paymentToken: 'tok-ok' }],
    [{ customerId: 'customer', items: [], paymentToken: 'tok-ok' }],
    [{ customerId: 'customer', items: [{ sku: 'SKU-1', quantity: 0 }], paymentToken: 'tok-ok' }],
    [{ customerId: ' customer ', items: [{ sku: 'SKU-1', quantity: 1 }], paymentToken: 'tok-ok' }],
  ])('rejects malformed checkout input %#', (input) => {
    expect(parseCheckoutInput('checkout-invalid', input)).toBeUndefined();
  });

  it('projects the canonical ProcessEngine state without inventing domain state', () => {
    expect(projectCheckout({
      instanceId: 'checkout-42',
      lifecycle: 'COMPLETED',
      revision: 9,
      currentStep: 'approved',
      pending: null,
      outcome: 'APPROVED',
      response: { resultCode: 'CONFIRMED' },
      error: null,
      fault: null,
    })).toMatchObject({
      checkoutId: 'checkout-42',
      processId: 'checkout-42',
      processStatus: 'COMPLETED',
      status: 'APPROVED',
      outcome: 'APPROVED',
      revision: 9,
    });
  });
});
