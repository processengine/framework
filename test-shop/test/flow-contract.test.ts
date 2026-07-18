import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compileFlow,
  evolve,
  failure,
  StaticOperationCatalog,
  success,
  type JsonValue,
  type OperationBinding,
  type OperationCompletion,
  type TransitionResult,
} from '@processengine/conductor';
import { parseCheckoutInput } from '../apps/shop-host/src/app.js';

const root = fileURLToPath(new URL('..', import.meta.url));

async function fixture() {
  const [definition, bindings] = await Promise.all([
    readJson(`${root}/flows/shop.checkout.v1.json`),
    readJson(`${root}/config/operations.json`) as Promise<readonly OperationBinding[]>,
  ]);
  const operations = new StaticOperationCatalog(bindings);
  return compileFlow(definition, { operations });
}

describe('shop.checkout artifact contract', () => {
  it('compiles only through the packed public conductor API', async () => {
    const flow = await fixture();
    expect(flow.definition.id).toBe('shop.checkout');
    expect(new Set(Object.values(flow.definition.steps).map((step) => step.type)))
      .toEqual(new Set(['operation', 'switch', 'end']));
    expect(flow.digest).toMatch(/^sha256:/u);
  });

  it('executes the approved route and passes whole persisted responses', async () => {
    const flow = await fixture();
    const checkout = checkoutInput('checkout-success');
    let transition = evolve(flow, undefined, {
      type: 'START', instanceId: 'checkout-success', input: checkout, at: at(0),
    });
    expectDispatch(transition, 'warehouse.reserve', checkout);

    const reservation = {
      resultCode: 'RESERVED', checkoutId: 'checkout-success', customerId: 'customer-1',
      reservationId: 'reservation-1', paymentToken: 'tok-ok',
      items: [{ sku: 'SKU-1', quantity: 1 }], amount: { minor: 1299, currency: 'EUR' },
    } satisfies JsonValue;
    transition = complete(flow, transition, success(reservation), 1);
    expectDispatch(transition, 'payment.authorize', reservation);

    const authorization = {
      ...reservation, resultCode: 'AUTHORIZED', authorizationId: 'authorization-1',
    } satisfies JsonValue;
    transition = complete(flow, transition, success(authorization), 2);
    expectDispatch(transition, 'payment.confirm', authorization);

    const confirmation = {
      resultCode: 'CONFIRMED', checkoutId: 'checkout-success', reservationId: 'reservation-1',
      authorizationId: 'authorization-1', paymentToken: 'tok-ok',
    } satisfies JsonValue;
    transition = complete(flow, transition, success(confirmation), 3);
    expect(transition.state).toMatchObject({
      lifecycle: 'COMPLETED', outcome: 'APPROVED', response: confirmation, error: null,
    });
  });

  it('cancels the authorization before releasing stock and keeps the original failure as terminal data', async () => {
    const flow = await fixture();
    const checkout = checkoutInput('checkout-compensated');
    let transition = evolve(flow, undefined, {
      type: 'START', instanceId: 'checkout-compensated', input: checkout, at: at(0),
    });
    const reservation = {
      resultCode: 'RESERVED', checkoutId: 'checkout-compensated', customerId: 'customer-1',
      reservationId: 'reservation-2', paymentToken: 'tok-confirm-fail',
      items: [{ sku: 'SKU-1', quantity: 1 }], amount: { minor: 1299, currency: 'EUR' },
    } satisfies JsonValue;
    transition = complete(flow, transition, success(reservation), 1);
    const authorization = {
      ...reservation, resultCode: 'AUTHORIZED', authorizationId: 'authorization-2',
    } satisfies JsonValue;
    transition = complete(flow, transition, success(authorization), 2);
    const confirmationFailure = {
      resultCode: 'CONFIRM_FAILED', checkoutId: 'checkout-compensated', reservationId: 'reservation-2',
      authorizationId: 'authorization-2', paymentToken: 'tok-confirm-fail',
    } satisfies JsonValue;
    transition = complete(flow, transition, success(confirmationFailure), 3);
    expectDispatch(transition, 'payment.cancel', authorization);

    transition = complete(flow, transition, success({
      resultCode: 'CANCELLED', checkoutId: 'checkout-compensated', reservationId: 'reservation-2',
      authorizationId: 'authorization-2', paymentToken: 'tok-confirm-fail',
    }), 4);
    expectDispatch(transition, 'warehouse.release', reservation);

    transition = complete(flow, transition, success({
      resultCode: 'RELEASED', checkoutId: 'checkout-compensated', reservationId: 'reservation-2', status: 'RELEASED',
    }), 5);
    expect(transition.state).toMatchObject({
      lifecycle: 'COMPLETED', outcome: 'PAYMENT_CONFIRM_FAILED',
      response: confirmationFailure, error: null,
    });
    expect(Object.keys(transition.state.results)).toEqual([
      'reserve-stock', 'authorize-payment', 'confirm-payment',
      'cancel-after-confirm-failure', 'release-after-confirm-failure',
    ]);
  });

  it('preserves a technical operation error after successful compensation', async () => {
    const flow = await fixture();
    let transition = evolve(flow, undefined, {
      type: 'START', instanceId: 'checkout-error', input: checkoutInput('checkout-error'), at: at(0),
    });
    const reservation = {
      resultCode: 'RESERVED', checkoutId: 'checkout-error', customerId: 'customer-1',
      reservationId: 'reservation-3', paymentToken: 'tok-payment-error',
      items: [{ sku: 'SKU-1', quantity: 1 }], amount: { minor: 1299, currency: 'EUR' },
    } satisfies JsonValue;
    transition = complete(flow, transition, success(reservation), 1);
    const unavailable = { code: 'PAYMENT_UNAVAILABLE', message: 'Unavailable', details: null };
    transition = complete(flow, transition, failure(unavailable), 2);
    expectDispatch(transition, 'warehouse.release', reservation);
    transition = complete(flow, transition, success({
      resultCode: 'RELEASED', checkoutId: 'checkout-error', reservationId: 'reservation-3', status: 'RELEASED',
    }), 3);
    expect(transition.state).toMatchObject({
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

function complete(
  flow: Awaited<ReturnType<typeof fixture>>,
  transition: TransitionResult,
  completion: OperationCompletion,
  second: number,
): TransitionResult {
  if (transition.action.type !== 'DISPATCH_OPERATION') throw new Error('Expected an operation dispatch');
  return evolve(flow, transition.state, {
    type: 'OPERATION_COMPLETED', requestId: transition.action.requestId, completion, at: at(second),
  });
}

function expectDispatch(transition: TransitionResult, operation: string, input: JsonValue): void {
  expect(transition.action).toMatchObject({ type: 'DISPATCH_OPERATION', operation, input });
}

function checkoutInput(checkoutId: string): JsonValue {
  return {
    checkoutId, customerId: 'customer-1', items: [{ sku: 'SKU-1', quantity: 1 }], paymentToken: 'tok-ok',
  };
}

function at(second: number): string {
  return `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
