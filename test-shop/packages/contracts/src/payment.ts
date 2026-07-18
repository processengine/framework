import { isRecord, requiredPositiveInteger, requiredString, type JsonValue } from './json.js';

export interface AuthorizePaymentInput {
  readonly checkoutId: string;
  readonly reservationId: string;
  readonly paymentToken: string;
  readonly amount: { readonly minor: number; readonly currency: string };
}

export interface AuthorizePaymentResult extends AuthorizePaymentInput {
  readonly resultCode: 'AUTHORIZED' | 'DECLINED';
  readonly authorizationId: string;
}

export interface ConfirmPaymentInput extends AuthorizePaymentResult {}
export interface CancelPaymentInput extends AuthorizePaymentResult {}

export function parseAuthorizePaymentInput(value: JsonValue): AuthorizePaymentInput {
  if (!isRecord(value) || !isRecord(value.amount)) {
    throw new TypeError('payment.authorize input and amount must be objects');
  }
  return {
    checkoutId: requiredString(value.checkoutId, 'checkoutId'),
    reservationId: requiredString(value.reservationId, 'reservationId'),
    paymentToken: requiredString(value.paymentToken, 'paymentToken'),
    amount: {
      minor: requiredPositiveInteger(value.amount.minor, 'amount.minor'),
      currency: requiredString(value.amount.currency, 'amount.currency'),
    },
  };
}

export function parseConfirmPaymentInput(value: JsonValue): ConfirmPaymentInput {
  const input = parseAuthorizePaymentInput(value);
  if (!isRecord(value)) throw new TypeError('payment.confirm input must be an object');
  const resultCode = requiredString(value.resultCode, 'resultCode');
  if (resultCode !== 'AUTHORIZED' && resultCode !== 'DECLINED') {
    throw new TypeError('payment.confirm resultCode must be AUTHORIZED or DECLINED');
  }
  return {
    ...input,
    resultCode,
    authorizationId: requiredString(value.authorizationId, 'authorizationId'),
  };
}

export const parseCancelPaymentInput = parseConfirmPaymentInput;
