export type * from './json.js';
export * from './payment.js';
export * from './warehouse.js';

export const OPERATIONS = {
  reserveStock: 'warehouse.reserve',
  releaseStock: 'warehouse.release',
  authorizePayment: 'payment.authorize',
  confirmPayment: 'payment.confirm',
  cancelPayment: 'payment.cancel',
} as const;

export const DEMO_FIXTURES = {
  availableSku: 'SKU-1',
  outOfStockSku: 'OUT-OF-STOCK',
  warehouseErrorSku: 'WAREHOUSE-ERROR',
  warehouseThrowSku: 'WAREHOUSE-THROW',
  paymentSuccess: 'tok-ok',
  paymentDeclined: 'tok-declined',
  paymentError: 'tok-payment-error',
  paymentNoResponse: 'tok-no-response',
  paymentDelayed: 'tok-delayed',
  paymentCrashAfterCommit: 'tok-crash-after-commit',
  paymentDuplicateCompletion: 'tok-duplicate-completion',
  paymentUpgradeBarrier: 'tok-upgrade-barrier',
  paymentConfirmFailure: 'tok-confirm-fail',
  paymentConfirmError: 'tok-confirm-error',
  paymentCancelError: 'tok-cancel-error',
  compensationFailure: 'tok-compensation-fail',
  paymentErrorStockCompensationFailure: 'tok-payment-error-stock-compensation-fail',
  confirmFailureStockCompensationFailure: 'tok-confirm-fail-stock-compensation-fail',
  confirmErrorStockCompensationFailure: 'tok-confirm-error-stock-compensation-fail',
  confirmErrorPaymentCompensationFailure: 'tok-confirm-error-payment-compensation-fail',
} as const;
