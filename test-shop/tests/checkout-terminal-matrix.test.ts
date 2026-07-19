import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  compileFlow,
  type OperationCompletion,
  type ProcessState,
} from '@processengine/conductor';
import { evolve, failure, success } from '@processengine/conductor/testing';
import { describe, expect, it } from 'vitest';

const definition = JSON.parse(readFileSync(
  fileURLToPath(new URL('../flows/shop.checkout.v1.json', import.meta.url)),
  'utf8',
));
const flow = compileFlow(definition);

const reserved = { resultCode: 'RESERVED', checkoutId: 'checkout-matrix', reservationId: 'reservation-1' };
const authorized = { resultCode: 'AUTHORIZED', checkoutId: 'checkout-matrix', authorizationId: 'authorization-1' };
const declined = { resultCode: 'DECLINED', checkoutId: 'checkout-matrix' };
const confirmed = { resultCode: 'CONFIRMED', checkoutId: 'checkout-matrix' };
const confirmFailed = { resultCode: 'CONFIRM_FAILED', checkoutId: 'checkout-matrix' };
const released = { resultCode: 'RELEASED', checkoutId: 'checkout-matrix' };
const cancelled = { resultCode: 'CANCELLED', checkoutId: 'checkout-matrix' };

const error = (code: string) => ({ code, message: code, details: null });
const ok = (response: unknown) => success(response as never);
const failed = (code: string) => failure(error(code));

type TerminalCase = {
  readonly name: string;
  readonly end: string;
  readonly outcome: string;
  readonly completions: readonly OperationCompletion[];
  readonly terminal: OperationCompletion;
};

const cases: readonly TerminalCase[] = [
  {
    name: 'approved', end: 'approved', outcome: 'APPROVED',
    completions: [ok(reserved), ok(authorized), ok(confirmed)], terminal: ok(confirmed),
  },
  ...[
    ['out-of-stock', 'OUT_OF_STOCK', 'OUT_OF_STOCK'],
    ['warehouse-unavailable', 'WAREHOUSE_UNAVAILABLE', 'WAREHOUSE_UNAVAILABLE'],
    ['warehouse-handler-failed', 'WAREHOUSE_HANDLER_FAILED', 'HANDLER_FAILED'],
    ['warehouse-timeout', 'WAREHOUSE_TIMEOUT', 'PROCESSENGINE_COMPLETION_TIMEOUT'],
    ['warehouse-dispatch-failed', 'WAREHOUSE_DISPATCH_FAILED', 'PROCESSENGINE_DISPATCH_FAILED'],
  ].map(([end, outcome, code]) => ({
    name: end!, end: end!, outcome: outcome!, completions: [failed(code!)], terminal: failed(code!),
  })),
  {
    name: 'payment-declined', end: 'payment-declined', outcome: 'PAYMENT_DECLINED',
    completions: [ok(reserved), ok(declined), ok(released)], terminal: ok(declined),
  },
  {
    name: 'decline-compensation-failed', end: 'decline-compensation-failed', outcome: 'COMPENSATION_FAILED',
    completions: [ok(reserved), ok(declined), failed('COMPENSATION_FAILED')], terminal: failed('COMPENSATION_FAILED'),
  },
  {
    name: 'payment-error-compensated', end: 'payment-error-compensated', outcome: 'PAYMENT_ERROR_COMPENSATED',
    completions: [ok(reserved), failed('PAYMENT_UNAVAILABLE'), ok(released)], terminal: failed('PAYMENT_UNAVAILABLE'),
  },
  {
    name: 'payment-error-compensation-failed', end: 'payment-error-compensation-failed', outcome: 'COMPENSATION_FAILED',
    completions: [ok(reserved), failed('PAYMENT_UNAVAILABLE'), failed('COMPENSATION_FAILED')], terminal: failed('COMPENSATION_FAILED'),
  },
  {
    name: 'payment-confirm-failed', end: 'payment-confirm-failed', outcome: 'PAYMENT_CONFIRM_FAILED',
    completions: [ok(reserved), ok(authorized), ok(confirmFailed), ok(cancelled), ok(released)], terminal: ok(confirmFailed),
  },
  {
    name: 'confirm-failure-compensation-failed', end: 'confirm-failure-compensation-failed', outcome: 'COMPENSATION_FAILED',
    completions: [ok(reserved), ok(authorized), ok(confirmFailed), ok(cancelled), failed('COMPENSATION_FAILED')],
    terminal: failed('COMPENSATION_FAILED'),
  },
  {
    name: 'confirm-failure-payment-compensation-failed', end: 'confirm-failure-payment-compensation-failed',
    outcome: 'PAYMENT_COMPENSATION_FAILED',
    completions: [ok(reserved), ok(authorized), ok(confirmFailed), failed('PAYMENT_CANCEL_UNAVAILABLE')],
    terminal: failed('PAYMENT_CANCEL_UNAVAILABLE'),
  },
  {
    name: 'payment-confirm-error-compensated', end: 'payment-confirm-error-compensated',
    outcome: 'PAYMENT_CONFIRM_ERROR_COMPENSATED',
    completions: [ok(reserved), ok(authorized), failed('PAYMENT_CONFIRM_UNAVAILABLE'), ok(cancelled), ok(released)],
    terminal: failed('PAYMENT_CONFIRM_UNAVAILABLE'),
  },
  {
    name: 'confirm-error-compensation-failed', end: 'confirm-error-compensation-failed', outcome: 'COMPENSATION_FAILED',
    completions: [ok(reserved), ok(authorized), failed('PAYMENT_CONFIRM_UNAVAILABLE'), ok(cancelled), failed('COMPENSATION_FAILED')],
    terminal: failed('COMPENSATION_FAILED'),
  },
  {
    name: 'confirm-error-payment-compensation-failed', end: 'confirm-error-payment-compensation-failed',
    outcome: 'PAYMENT_COMPENSATION_FAILED',
    completions: [ok(reserved), ok(authorized), failed('PAYMENT_CONFIRM_UNAVAILABLE'), failed('PAYMENT_CANCEL_UNAVAILABLE')],
    terminal: failed('PAYMENT_CANCEL_UNAVAILABLE'),
  },
];

function execute(testCase: TerminalCase): ProcessState {
  let transition = evolve(flow, undefined, {
    type: 'START',
    instanceId: `matrix-${testCase.name}`,
    input: { checkoutId: 'checkout-matrix' },
    at: '2026-01-01T00:00:00.000Z',
  });
  for (const [index, completion] of testCase.completions.entries()) {
    if (transition.action.type !== 'DISPATCH_OPERATION') {
      throw new Error(`${testCase.name}: completion ${index} has no pending operation`);
    }
    transition = evolve(flow, transition.state, {
      type: 'OPERATION_COMPLETED',
      requestId: transition.action.requestId,
      completion,
      at: `2026-01-01T00:00:${String(index + 1).padStart(2, '0')}.000Z`,
    });
  }
  return transition.state;
}

describe('checkout terminal transition matrix', () => {
  it('contains a deterministic scenario for every end step in the shipped flow', () => {
    const endSteps = Object.entries(definition.steps)
      .filter(([, step]) => (step as { type: string }).type === 'end')
      .map(([stepId]) => stepId)
      .sort();
    expect(cases.map((testCase) => testCase.end).sort()).toEqual(endSteps);
  });

  it.each(cases)('$name reaches $end and projects the exact referenced result', (testCase) => {
    const state = execute(testCase);
    expect(state.lifecycle).toBe('COMPLETED');
    expect(state.currentStep).toBe(testCase.end);
    expect(state.outcome).toBe(testCase.outcome);
    if (testCase.terminal.status === 'SUCCESS') {
      expect(state.response).toEqual(testCase.terminal.response);
      expect(state.error).toBeNull();
    } else {
      expect(state.response).toBeNull();
      expect(state.error).toEqual(testCase.terminal.error);
    }
  });
});
