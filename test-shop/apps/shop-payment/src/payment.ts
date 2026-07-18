import { randomUUID } from 'node:crypto';
import {
  DEMO_FIXTURES,
  OPERATIONS,
  parseAuthorizePaymentInput,
  parseCancelPaymentInput,
  parseConfirmPaymentInput,
  type JsonValue,
} from '@test-shop/contracts';
import {
  deferOperationCompletion,
  failure,
  noResponse,
  publishOperationCompletion,
  result,
  type MessageEnvelope,
  type OperationHandler,
  type OperationPublishDecision,
} from '@test-shop/service-kit';
import type { Pool, PoolClient } from 'pg';

export interface PaymentRow {
  readonly authorization_id: string;
  readonly checkout_id: string;
  readonly reservation_id: string;
  readonly status: 'AUTHORIZED' | 'DECLINED' | 'CONFIRMED' | 'CONFIRM_FAILED' | 'CANCELLED';
  readonly amount_minor: number;
  readonly currency: string;
  readonly payment_token: string;
  readonly authorize_effects: number;
  readonly confirm_effects: number;
  readonly cancel_effects: number;
}

export interface PaymentTestControl {
  readonly checkout_id: string;
  readonly released: boolean;
  readonly deliveries: number;
  readonly worker_ids: string[];
  readonly duplicate_publications: number;
  readonly duplicate_message_ids: string[];
  readonly last_entered_at: string | null;
}

export async function migratePayment(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS payment;
    CREATE TABLE IF NOT EXISTS payment.authorizations (
      authorization_id uuid PRIMARY KEY,
      checkout_id text UNIQUE NOT NULL,
      reservation_id text NOT NULL,
      status text NOT NULL CHECK (status IN ('AUTHORIZED','DECLINED','CONFIRMED','CONFIRM_FAILED','CANCELLED')),
      amount_minor integer NOT NULL,
      currency text NOT NULL,
      payment_token text NOT NULL,
      authorize_effects integer NOT NULL DEFAULT 1,
      confirm_effects integer NOT NULL DEFAULT 0,
      cancel_effects integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      confirmed_at timestamptz
    );
    ALTER TABLE payment.authorizations
      ADD COLUMN IF NOT EXISTS cancel_effects integer NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS payment.test_controls (
      checkout_id text PRIMARY KEY,
      released boolean NOT NULL DEFAULT false,
      deliveries integer NOT NULL DEFAULT 0,
      worker_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
      duplicate_publications integer NOT NULL DEFAULT 0,
      duplicate_message_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
      last_entered_at timestamptz
    );
    ALTER TABLE payment.test_controls
      ADD COLUMN IF NOT EXISTS duplicate_publications integer NOT NULL DEFAULT 0;
    ALTER TABLE payment.test_controls
      ADD COLUMN IF NOT EXISTS duplicate_message_ids text[] NOT NULL DEFAULT ARRAY[]::text[];
  `);
}

export function paymentHandlers(options: {
  readonly demoFaults: boolean;
}): Readonly<Record<string, OperationHandler>> {
  return {
    [OPERATIONS.authorizePayment]: async ({ command, db }) => authorize(
      db,
      command.input as JsonValue,
      options.demoFaults,
    ),
    [OPERATIONS.confirmPayment]: async ({ command, db }) => confirm(db, command.input as JsonValue, options.demoFaults),
    [OPERATIONS.cancelPayment]: async ({ command, db }) => cancel(db, command.input as JsonValue, options.demoFaults),
  };
}

export async function findPayment(pool: Pool, checkoutId: string): Promise<PaymentRow | undefined> {
  const found = await pool.query<PaymentRow>(`
    SELECT authorization_id, checkout_id, reservation_id, status, amount_minor,
           currency, payment_token, authorize_effects, confirm_effects, cancel_effects
    FROM payment.authorizations WHERE checkout_id = $1
  `, [checkoutId]);
  return found.rows[0];
}

export async function resetPaymentFixtures(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM payment.authorizations; DELETE FROM payment.test_controls');
}

export async function armPaymentControl(pool: Pool, checkoutId: string): Promise<void> {
  await pool.query(`
    INSERT INTO payment.test_controls
      (checkout_id, released, deliveries, worker_ids, duplicate_publications, duplicate_message_ids, last_entered_at)
    VALUES ($1, false, 0, ARRAY[]::text[], 0, ARRAY[]::text[], NULL)
    ON CONFLICT (checkout_id) DO UPDATE
      SET released = false,
          deliveries = 0,
          worker_ids = ARRAY[]::text[],
          duplicate_publications = 0,
          duplicate_message_ids = ARRAY[]::text[],
          last_entered_at = NULL
  `, [checkoutId]);
}

export async function releasePaymentControl(pool: Pool, checkoutId: string): Promise<boolean> {
  const released = await pool.query(`
    UPDATE payment.test_controls SET released = true WHERE checkout_id = $1 RETURNING checkout_id
  `, [checkoutId]);
  return released.rowCount === 1;
}

export async function markPaymentDelivery(pool: Pool, checkoutId: string, workerId: string): Promise<void> {
  await pool.query(`
    UPDATE payment.test_controls
    SET deliveries = deliveries + 1,
        worker_ids = CASE WHEN $2 = ANY(worker_ids) THEN worker_ids ELSE array_append(worker_ids, $2) END,
        last_entered_at = clock_timestamp()
    WHERE checkout_id = $1
  `, [checkoutId, workerId]);
}

export async function markDuplicatePublication(pool: Pool, checkoutId: string, messageId: string): Promise<void> {
  const updated = await pool.query(`
    UPDATE payment.test_controls
    SET duplicate_publications = duplicate_publications + 1,
        duplicate_message_ids = CASE
          WHEN $2 = ANY(duplicate_message_ids) THEN duplicate_message_ids
          ELSE array_append(duplicate_message_ids, $2)
        END
    WHERE checkout_id = $1
    RETURNING checkout_id
  `, [checkoutId, messageId]);
  if (updated.rowCount !== 1) throw new Error(`Payment duplicate-publication control ${checkoutId} was not armed`);
}

export async function findPaymentControl(pool: Pool, checkoutId: string): Promise<PaymentTestControl | undefined> {
  const found = await pool.query<PaymentTestControl>(`
    SELECT checkout_id, released, deliveries, worker_ids,
           duplicate_publications, duplicate_message_ids, last_entered_at
    FROM payment.test_controls WHERE checkout_id = $1
  `, [checkoutId]);
  return found.rows[0];
}

export async function paymentCompletionPublishDecision(
  pool: Pool,
  envelope: MessageEnvelope,
  options: { readonly demoFaults: boolean; readonly delayedResponseMs: number },
): Promise<OperationPublishDecision> {
  if (!options.demoFaults) return publishOperationCompletion();
  const response = completionResponse(envelope);
  if (response === undefined) return publishOperationCompletion();
  const checkoutId = typeof response.checkoutId === 'string' ? response.checkoutId : undefined;
  const paymentToken = typeof response.paymentToken === 'string' ? response.paymentToken : undefined;
  if (checkoutId === undefined || paymentToken === undefined) return publishOperationCompletion();
  if (paymentToken !== DEMO_FIXTURES.paymentUpgradeBarrier
    && paymentToken !== DEMO_FIXTURES.paymentDelayed) return publishOperationCompletion();

  const control = await findPaymentControl(pool, checkoutId);
  if (control === undefined) throw new Error(`Payment completion control ${checkoutId} was not armed`);
  if (paymentToken === DEMO_FIXTURES.paymentUpgradeBarrier) {
    return control.released ? publishOperationCompletion() : deferOperationCompletion(250);
  }
  const enteredAt = control.last_entered_at === null ? Number.NaN : new Date(control.last_entered_at).getTime();
  if (!Number.isFinite(enteredAt)) throw new Error(`Payment completion control ${checkoutId} has no entry timestamp`);
  const remainingMs = enteredAt + options.delayedResponseMs - Date.now();
  return remainingMs > 0
    ? deferOperationCompletion(Math.max(1, Math.ceil(remainingMs)))
    : publishOperationCompletion();
}

async function authorize(db: PoolClient, raw: JsonValue, demoFaults: boolean) {
  const input = parseAuthorizePaymentInput(raw);
  if (demoFaults && (
    input.paymentToken === DEMO_FIXTURES.paymentError
    || input.paymentToken === DEMO_FIXTURES.paymentErrorStockCompensationFailure
  )) {
    return failure({
      code: 'PAYMENT_UNAVAILABLE',
      message: 'The payment provider is unavailable',
      details: null,
    });
  }
  if (demoFaults && input.paymentToken === DEMO_FIXTURES.paymentNoResponse) return noResponse();
  const previous = await db.query<PaymentRow>(`
    SELECT authorization_id, checkout_id, reservation_id, status, amount_minor,
           currency, payment_token, authorize_effects, confirm_effects, cancel_effects
    FROM payment.authorizations WHERE checkout_id = $1 FOR UPDATE
  `, [input.checkoutId]);
  const existing = previous.rows[0];
  if (existing !== undefined) return result(authorizationResult(existing));

  const authorizationId = randomUUID();
  const declined = demoFaults && (
    input.paymentToken === DEMO_FIXTURES.paymentDeclined
    || input.paymentToken === DEMO_FIXTURES.compensationFailure
  );
  const status = declined ? 'DECLINED' : 'AUTHORIZED';
  const inserted: PaymentRow = {
    authorization_id: authorizationId,
    checkout_id: input.checkoutId,
    reservation_id: input.reservationId,
    status,
    amount_minor: input.amount.minor,
    currency: input.amount.currency,
    payment_token: input.paymentToken,
    authorize_effects: 1,
    confirm_effects: 0,
    cancel_effects: 0,
  };
  await db.query(`
    INSERT INTO payment.authorizations
      (authorization_id, checkout_id, reservation_id, status, amount_minor, currency, payment_token)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, [authorizationId, input.checkoutId, input.reservationId, status, input.amount.minor, input.amount.currency, input.paymentToken]);
  return result(authorizationResult(inserted));
}

async function confirm(db: PoolClient, raw: JsonValue, demoFaults: boolean) {
  const input = parseConfirmPaymentInput(raw);
  if (demoFaults && (
    input.paymentToken === DEMO_FIXTURES.paymentConfirmError
    || input.paymentToken === DEMO_FIXTURES.confirmErrorStockCompensationFailure
    || input.paymentToken === DEMO_FIXTURES.confirmErrorPaymentCompensationFailure
  )) {
    return failure({
      code: 'PAYMENT_CONFIRM_UNAVAILABLE',
      message: 'The payment confirmation endpoint is unavailable',
      details: null,
    });
  }
  const selected = await db.query<PaymentRow>(`
    SELECT authorization_id, checkout_id, reservation_id, status, amount_minor,
           currency, payment_token, authorize_effects, confirm_effects, cancel_effects
    FROM payment.authorizations
    WHERE authorization_id = $1 AND checkout_id = $2 FOR UPDATE
  `, [input.authorizationId, input.checkoutId]);
  const payment = selected.rows[0];
  if (payment === undefined) {
    return failure({ code: 'AUTHORIZATION_NOT_FOUND', message: 'Authorization not found', details: null });
  }
  if (payment.status === 'CONFIRMED' || payment.status === 'CONFIRM_FAILED') {
    return result(confirmResult(payment));
  }
  if (payment.status !== 'AUTHORIZED') {
    return failure({ code: 'AUTHORIZATION_NOT_CONFIRMABLE', message: 'Authorization is not confirmable', details: null });
  }
  const failed = demoFaults && (
    input.paymentToken === DEMO_FIXTURES.paymentConfirmFailure
    || input.paymentToken === DEMO_FIXTURES.paymentCancelError
    || input.paymentToken === DEMO_FIXTURES.confirmFailureStockCompensationFailure
  );
  const status = failed ? 'CONFIRM_FAILED' : 'CONFIRMED';
  await db.query(`
    UPDATE payment.authorizations
    SET status = $2, confirm_effects = confirm_effects + 1, confirmed_at = clock_timestamp()
    WHERE authorization_id = $1
  `, [payment.authorization_id, status]);
  return result({
    resultCode: failed ? 'CONFIRM_FAILED' : 'CONFIRMED',
    checkoutId: payment.checkout_id,
    reservationId: payment.reservation_id,
    authorizationId: payment.authorization_id,
    paymentToken: payment.payment_token,
  });
}

async function cancel(db: PoolClient, raw: JsonValue, demoFaults: boolean) {
  const input = parseCancelPaymentInput(raw);
  if (demoFaults && (
    input.paymentToken === DEMO_FIXTURES.paymentCancelError
    || input.paymentToken === DEMO_FIXTURES.confirmErrorPaymentCompensationFailure
  )) {
    return failure({ code: 'PAYMENT_CANCEL_UNAVAILABLE', message: 'Authorization cancellation failed', details: null });
  }
  const selected = await db.query<PaymentRow>(`
    SELECT authorization_id, checkout_id, reservation_id, status, amount_minor,
           currency, payment_token, authorize_effects, confirm_effects, cancel_effects
    FROM payment.authorizations WHERE authorization_id = $1 AND checkout_id = $2 FOR UPDATE
  `, [input.authorizationId, input.checkoutId]);
  const payment = selected.rows[0];
  if (!payment) return failure({ code: 'AUTHORIZATION_NOT_FOUND', message: 'Authorization not found', details: null });
  if (payment.status !== 'CANCELLED') {
    if (payment.status === 'CONFIRMED') {
      return failure({ code: 'PAYMENT_ALREADY_CONFIRMED', message: 'Confirmed payment cannot be cancelled', details: null });
    }
    await db.query(`UPDATE payment.authorizations SET status='CANCELLED', cancel_effects=cancel_effects+1 WHERE authorization_id=$1`, [payment.authorization_id]);
  }
  return result({ resultCode: 'CANCELLED', checkoutId: payment.checkout_id, reservationId: payment.reservation_id,
    authorizationId: payment.authorization_id, paymentToken: payment.payment_token });
}

function authorizationResult(row: PaymentRow): JsonValue {
  return {
    resultCode: row.status === 'DECLINED' ? 'DECLINED' : 'AUTHORIZED',
    checkoutId: row.checkout_id,
    reservationId: row.reservation_id,
    authorizationId: row.authorization_id,
    paymentToken: row.payment_token,
    amount: { minor: row.amount_minor, currency: row.currency },
  };
}

function confirmResult(row: PaymentRow): JsonValue {
  return {
    resultCode: row.status,
    checkoutId: row.checkout_id,
    reservationId: row.reservation_id,
    authorizationId: row.authorization_id,
    paymentToken: row.payment_token,
  };
}

function completionResponse(envelope: MessageEnvelope): Record<string, unknown> | undefined {
  const payload = envelope.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const response = (payload as Record<string, unknown>).response;
  return response !== null && typeof response === 'object' && !Array.isArray(response)
    ? response as Record<string, unknown>
    : undefined;
}
