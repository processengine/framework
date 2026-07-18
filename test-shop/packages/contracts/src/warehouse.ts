import { isRecord, requiredPositiveInteger, requiredString, type JsonObject, type JsonValue } from './json.js';

export interface CheckoutItem extends JsonObject {
  readonly sku: string;
  readonly quantity: number;
}

export interface Money {
  readonly minor: number;
  readonly currency: string;
}

export interface ReserveStockInput {
  readonly checkoutId: string;
  readonly customerId: string;
  readonly paymentToken: string;
  readonly items: readonly CheckoutItem[];
}

export interface ReserveStockResult extends ReserveStockInput {
  readonly resultCode: 'RESERVED';
  readonly reservationId: string;
  readonly amount: Money;
}

export interface ReleaseStockInput {
  readonly checkoutId: string;
  readonly reservationId: string;
  readonly paymentToken: string;
}

export function parseReserveStockInput(value: JsonValue): ReserveStockInput {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length === 0) {
    throw new TypeError('warehouse.reserve input must contain a non-empty items array');
  }
  return {
    checkoutId: requiredString(value.checkoutId, 'checkoutId'),
    customerId: requiredString(value.customerId, 'customerId'),
    paymentToken: requiredString(value.paymentToken, 'paymentToken'),
    items: value.items.map((item, index) => {
      if (!isRecord(item)) throw new TypeError(`items[${index}] must be an object`);
      return {
        sku: requiredString(item.sku, `items[${index}].sku`),
        quantity: requiredPositiveInteger(item.quantity, `items[${index}].quantity`),
      };
    }),
  };
}

export function parseReleaseStockInput(value: JsonValue): ReleaseStockInput {
  if (!isRecord(value)) throw new TypeError('warehouse.release input must be an object');
  return {
    checkoutId: requiredString(value.checkoutId, 'checkoutId'),
    reservationId: requiredString(value.reservationId, 'reservationId'),
    paymentToken: requiredString(value.paymentToken, 'paymentToken'),
  };
}
