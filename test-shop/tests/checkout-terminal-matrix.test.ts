import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { JsonValue, OperationError } from '@processengine/conductor';
import {
  DISPATCH_FAILED_ERROR,
  TIMEOUT_ERROR,
  checkoutCatalog,
  dispatchFailedStep,
  errorStep,
  okStep,
  runCheckout,
  timeoutStep,
  type CheckoutStep,
} from './support/checkout-runtime.js';

const definition = JSON.parse(readFileSync(
  fileURLToPath(new URL('../flows/shop.checkout.v1.json', import.meta.url)),
  'utf8',
)) as { readonly steps: Record<string, { readonly type: string }> };

const reserved = { resultCode: 'RESERVED', checkoutId: 'checkout-matrix', reservationId: 'reservation-1' };
const authorized = { resultCode: 'AUTHORIZED', checkoutId: 'checkout-matrix', authorizationId: 'authorization-1' };
const declined = { resultCode: 'DECLINED', checkoutId: 'checkout-matrix' };
const confirmed = { resultCode: 'CONFIRMED', checkoutId: 'checkout-matrix' };
const confirmFailed = { resultCode: 'CONFIRM_FAILED', checkoutId: 'checkout-matrix' };
const released = { resultCode: 'RELEASED', checkoutId: 'checkout-matrix' };
const cancelled = { resultCode: 'CANCELLED', checkoutId: 'checkout-matrix' };

const err = (code: string): OperationError => ({ code, message: code, details: null });
const errStep = (code: string): CheckoutStep => errorStep(err(code));

type Terminal = { readonly response: JsonValue } | { readonly error: OperationError };

interface TerminalCase {
  readonly name: string;
  readonly end: string;
  readonly outcome: string;
  readonly steps: readonly CheckoutStep[];
  readonly terminal: Terminal;
}

const cases: readonly TerminalCase[] = [
  { name: 'approved', end: 'approved', outcome: 'APPROVED',
    steps: [okStep(reserved), okStep(authorized), okStep(confirmed)], terminal: { response: confirmed } },
  { name: 'out-of-stock', end: 'out-of-stock', outcome: 'OUT_OF_STOCK',
    steps: [errStep('OUT_OF_STOCK')], terminal: { error: err('OUT_OF_STOCK') } },
  { name: 'warehouse-unavailable', end: 'warehouse-unavailable', outcome: 'WAREHOUSE_UNAVAILABLE',
    steps: [errStep('WAREHOUSE_UNAVAILABLE')], terminal: { error: err('WAREHOUSE_UNAVAILABLE') } },
  { name: 'warehouse-handler-failed', end: 'warehouse-handler-failed', outcome: 'WAREHOUSE_HANDLER_FAILED',
    steps: [errStep('HANDLER_FAILED')], terminal: { error: err('HANDLER_FAILED') } },
  { name: 'warehouse-timeout', end: 'warehouse-timeout', outcome: 'WAREHOUSE_TIMEOUT',
    steps: [timeoutStep], terminal: { error: TIMEOUT_ERROR } },
  { name: 'warehouse-dispatch-failed', end: 'warehouse-dispatch-failed', outcome: 'WAREHOUSE_DISPATCH_FAILED',
    steps: [dispatchFailedStep], terminal: { error: DISPATCH_FAILED_ERROR } },
  { name: 'payment-declined', end: 'payment-declined', outcome: 'PAYMENT_DECLINED',
    steps: [okStep(reserved), okStep(declined), okStep(released)], terminal: { response: declined } },
  { name: 'decline-compensation-failed', end: 'decline-compensation-failed', outcome: 'COMPENSATION_FAILED',
    steps: [okStep(reserved), okStep(declined), errStep('COMPENSATION_FAILED')], terminal: { error: err('COMPENSATION_FAILED') } },
  { name: 'payment-error-compensated', end: 'payment-error-compensated', outcome: 'PAYMENT_ERROR_COMPENSATED',
    steps: [okStep(reserved), errStep('PAYMENT_UNAVAILABLE'), okStep(released)], terminal: { error: err('PAYMENT_UNAVAILABLE') } },
  { name: 'payment-error-compensation-failed', end: 'payment-error-compensation-failed', outcome: 'COMPENSATION_FAILED',
    steps: [okStep(reserved), errStep('PAYMENT_UNAVAILABLE'), errStep('COMPENSATION_FAILED')], terminal: { error: err('COMPENSATION_FAILED') } },
  { name: 'payment-confirm-failed', end: 'payment-confirm-failed', outcome: 'PAYMENT_CONFIRM_FAILED',
    steps: [okStep(reserved), okStep(authorized), okStep(confirmFailed), okStep(cancelled), okStep(released)], terminal: { response: confirmFailed } },
  { name: 'confirm-failure-compensation-failed', end: 'confirm-failure-compensation-failed', outcome: 'COMPENSATION_FAILED',
    steps: [okStep(reserved), okStep(authorized), okStep(confirmFailed), okStep(cancelled), errStep('COMPENSATION_FAILED')], terminal: { error: err('COMPENSATION_FAILED') } },
  { name: 'confirm-failure-payment-compensation-failed', end: 'confirm-failure-payment-compensation-failed', outcome: 'PAYMENT_COMPENSATION_FAILED',
    steps: [okStep(reserved), okStep(authorized), okStep(confirmFailed), errStep('PAYMENT_CANCEL_UNAVAILABLE')], terminal: { error: err('PAYMENT_CANCEL_UNAVAILABLE') } },
  { name: 'payment-confirm-error-compensated', end: 'payment-confirm-error-compensated', outcome: 'PAYMENT_CONFIRM_ERROR_COMPENSATED',
    steps: [okStep(reserved), okStep(authorized), errStep('PAYMENT_CONFIRM_UNAVAILABLE'), okStep(cancelled), okStep(released)], terminal: { error: err('PAYMENT_CONFIRM_UNAVAILABLE') } },
  { name: 'confirm-error-compensation-failed', end: 'confirm-error-compensation-failed', outcome: 'COMPENSATION_FAILED',
    steps: [okStep(reserved), okStep(authorized), errStep('PAYMENT_CONFIRM_UNAVAILABLE'), okStep(cancelled), errStep('COMPENSATION_FAILED')], terminal: { error: err('COMPENSATION_FAILED') } },
  { name: 'confirm-error-payment-compensation-failed', end: 'confirm-error-payment-compensation-failed', outcome: 'PAYMENT_COMPENSATION_FAILED',
    steps: [okStep(reserved), okStep(authorized), errStep('PAYMENT_CONFIRM_UNAVAILABLE'), errStep('PAYMENT_CANCEL_UNAVAILABLE')], terminal: { error: err('PAYMENT_CANCEL_UNAVAILABLE') } },
];

describe('checkout terminal transition matrix', () => {
  it('contains a deterministic scenario for every end step in the shipped flow', () => {
    const endSteps = Object.entries(definition.steps)
      .filter(([, step]) => step.type === 'end')
      .map(([stepId]) => stepId)
      .sort();
    expect(cases.map((testCase) => testCase.end).sort()).toEqual(endSteps);
  });

  it.each(cases)('$name reaches $end and projects the exact referenced result through the runtime', async (testCase) => {
    const { state } = await runCheckout({
      catalog: checkoutCatalog(),
      instanceId: `matrix-${testCase.name}`,
      input: { checkoutId: 'checkout-matrix' },
      steps: testCase.steps,
    });
    expect(state.lifecycle).toBe('COMPLETED');
    expect(state.currentStep).toBe(testCase.end);
    expect(state.outcome).toBe(testCase.outcome);
    if ('response' in testCase.terminal) {
      expect(state.response).toEqual(testCase.terminal.response);
      expect(state.error).toBeNull();
    } else {
      expect(state.response).toBeNull();
      expect(state.error).toEqual(testCase.terminal.error);
    }
  });
});
