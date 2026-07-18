import { describe, expect, it } from 'vitest';
import {
  parseAuthorizePaymentInput,
  parseReleaseStockInput,
  parseReserveStockInput,
} from '@test-shop/contracts';

describe('domain operation contracts', () => {
  it('accepts the values transferred between checkout operations', () => {
    const reservation = parseReserveStockInput({
      checkoutId: 'checkout-1',
      customerId: 'customer-1',
      items: [{ sku: 'SKU-1', quantity: 2 }],
      paymentToken: 'tok-ok',
    });
    expect(reservation.items).toEqual([{ sku: 'SKU-1', quantity: 2 }]);

    expect(parseAuthorizePaymentInput({
      checkoutId: 'checkout-1',
      reservationId: 'reservation-1',
      paymentToken: 'tok-ok',
      amount: { minor: 2000, currency: 'USD' },
    }).amount.minor).toBe(2000);

    expect(parseReleaseStockInput({
      checkoutId: 'checkout-1',
      reservationId: 'reservation-1',
      paymentToken: 'tok-ok',
      amount: { minor: 2000, currency: 'USD' },
      resultCode: 'RESERVED',
    }).reservationId).toBe('reservation-1');
  });

  it('rejects a lossy or non-positive operation payload', () => {
    expect(() => parseAuthorizePaymentInput({
      checkoutId: 'checkout-1',
      reservationId: 'reservation-1',
      paymentToken: 'tok-ok',
      amount: { minor: 0, currency: 'USD' },
    })).toThrow(/amount\.minor/u);
  });
});
