import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compileFlow,
  StaticOperationCatalog,
  type JsonValue,
  type OperationBinding,
} from '@processengine/conductor';
import { okStep, errorStep, runCheckout } from '../tests/support/checkout-runtime.js';
import { parseCheckoutInput } from '../apps/shop-host/src/app.js';

const root = fileURLToPath(new URL('..', import.meta.url));

async function loadCatalog(): Promise<StaticOperationCatalog> {
  const bindings = await readJson(`${root}/config/operations.json`) as readonly OperationBinding[];
  return new StaticOperationCatalog(bindings);
}

async function compiledFixture() {
  const [definition, catalog] = await Promise.all([
    readJson(`${root}/flows/shop.checkout.v1.json`),
    loadCatalog(),
  ]);
  return compileFlow(definition, { operations: catalog });
}

describe('shop.checkout artifact contract', () => {
  it('compiles only through the packed public conductor API', async () => {
    const flow = await compiledFixture();
    expect(flow.definition.id).toBe('shop.checkout');
    expect(new Set(Object.values(flow.definition.steps).map((step) => step.type)))
      .toEqual(new Set(['operation', 'switch', 'end']));
    expect(flow.digest).toMatch(/^sha256:/u);
  });

  it('executes the approved route and passes whole persisted responses', async () => {
    const catalog = await loadCatalog();
    const checkout = checkoutInput('checkout-success');
    const reservation = {
      resultCode: 'RESERVED', checkoutId: 'checkout-success', customerId: 'customer-1',
      reservationId: 'reservation-1', paymentToken: 'tok-ok',
      items: [{ sku: 'SKU-1', quantity: 1 }], amount: { minor: 1299, currency: 'EUR' },
    } satisfies JsonValue;
    const authorization = { ...reservation, resultCode: 'AUTHORIZED', authorizationId: 'authorization-1' } satisfies JsonValue;
    const confirmation = {
      resultCode: 'CONFIRMED', checkoutId: 'checkout-success', reservationId: 'reservation-1',
      authorizationId: 'authorization-1', paymentToken: 'tok-ok',
    } satisfies JsonValue;

    const { state, dispatched } = await runCheckout({
      catalog, instanceId: 'checkout-success', input: checkout,
      steps: [okStep(reservation), okStep(authorization), okStep(confirmation)],
    });

    expect(dispatched).toEqual([
      { operation: 'warehouse.reserve', input: checkout },
      { operation: 'payment.authorize', input: reservation },
      { operation: 'payment.confirm', input: authorization },
    ]);
    expect(state).toMatchObject({ lifecycle: 'COMPLETED', outcome: 'APPROVED', response: confirmation, error: null });
  });

  it('cancels the authorization before releasing stock and keeps the original failure as terminal data', async () => {
    const catalog = await loadCatalog();
    const checkout = checkoutInput('checkout-compensated');
    const reservation = {
      resultCode: 'RESERVED', checkoutId: 'checkout-compensated', customerId: 'customer-1',
      reservationId: 'reservation-2', paymentToken: 'tok-confirm-fail',
      items: [{ sku: 'SKU-1', quantity: 1 }], amount: { minor: 1299, currency: 'EUR' },
    } satisfies JsonValue;
    const authorization = { ...reservation, resultCode: 'AUTHORIZED', authorizationId: 'authorization-2' } satisfies JsonValue;
    const confirmationFailure = {
      resultCode: 'CONFIRM_FAILED', checkoutId: 'checkout-compensated', reservationId: 'reservation-2',
      authorizationId: 'authorization-2', paymentToken: 'tok-confirm-fail',
    } satisfies JsonValue;
    const cancellation = {
      resultCode: 'CANCELLED', checkoutId: 'checkout-compensated', reservationId: 'reservation-2',
      authorizationId: 'authorization-2', paymentToken: 'tok-confirm-fail',
    } satisfies JsonValue;
    const release = {
      resultCode: 'RELEASED', checkoutId: 'checkout-compensated', reservationId: 'reservation-2', status: 'RELEASED',
    } satisfies JsonValue;

    const { state, dispatched } = await runCheckout({
      catalog, instanceId: 'checkout-compensated', input: checkout,
      steps: [okStep(reservation), okStep(authorization), okStep(confirmationFailure), okStep(cancellation), okStep(release)],
    });

    expect(dispatched).toEqual([
      { operation: 'warehouse.reserve', input: checkout },
      { operation: 'payment.authorize', input: reservation },
      { operation: 'payment.confirm', input: authorization },
      { operation: 'payment.cancel', input: authorization },
      { operation: 'warehouse.release', input: reservation },
    ]);
    expect(state).toMatchObject({
      lifecycle: 'COMPLETED', outcome: 'PAYMENT_CONFIRM_FAILED', response: confirmationFailure, error: null,
    });
    expect(Object.keys(state.results)).toEqual([
      'reserve-stock', 'authorize-payment', 'confirm-payment',
      'cancel-after-confirm-failure', 'release-after-confirm-failure',
    ]);
  });

  it('preserves a technical operation error after successful compensation', async () => {
    const catalog = await loadCatalog();
    const checkout = checkoutInput('checkout-error');
    const reservation = {
      resultCode: 'RESERVED', checkoutId: 'checkout-error', customerId: 'customer-1',
      reservationId: 'reservation-3', paymentToken: 'tok-payment-error',
      items: [{ sku: 'SKU-1', quantity: 1 }], amount: { minor: 1299, currency: 'EUR' },
    } satisfies JsonValue;
    const unavailable = { code: 'PAYMENT_UNAVAILABLE', message: 'Unavailable', details: null };
    const release = {
      resultCode: 'RELEASED', checkoutId: 'checkout-error', reservationId: 'reservation-3', status: 'RELEASED',
    } satisfies JsonValue;

    const { state, dispatched } = await runCheckout({
      catalog, instanceId: 'checkout-error', input: checkout,
      steps: [okStep(reservation), errorStep(unavailable), okStep(release)],
    });

    expect(dispatched).toEqual([
      { operation: 'warehouse.reserve', input: checkout },
      { operation: 'payment.authorize', input: reservation },
      { operation: 'warehouse.release', input: reservation },
    ]);
    expect(state).toMatchObject({
      lifecycle: 'COMPLETED', outcome: 'PAYMENT_ERROR_COMPENSATED', response: null, error: unavailable,
    });
  });
});

describe('checkout HTTP input boundary', () => {
  it('accepts a bounded checkout and derives checkoutId from the idempotency key', () => {
    expect(parseCheckoutInput('checkout-http', {
      customerId: 'customer-1', items: [{ sku: 'SKU-1', quantity: 2 }], paymentToken: 'tok-ok',
    })).toEqual({
      checkoutId: 'checkout-http', customerId: 'customer-1',
      items: [{ sku: 'SKU-1', quantity: 2 }], paymentToken: 'tok-ok',
    });
  });

  it('rejects empty items, invalid quantities and blank identifiers', () => {
    expect(parseCheckoutInput('checkout-http', { customerId: 'c', items: [], paymentToken: 't' })).toBeUndefined();
    expect(parseCheckoutInput('checkout-http', {
      customerId: 'c', items: [{ sku: 'SKU-1', quantity: 0 }], paymentToken: 't',
    })).toBeUndefined();
    expect(parseCheckoutInput('checkout-http', {
      customerId: ' ', items: [{ sku: 'SKU-1', quantity: 1 }], paymentToken: 't',
    })).toBeUndefined();
  });
});

function checkoutInput(checkoutId: string): JsonValue {
  return {
    checkoutId, customerId: 'customer-1', items: [{ sku: 'SKU-1', quantity: 1 }], paymentToken: 'tok-ok',
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
