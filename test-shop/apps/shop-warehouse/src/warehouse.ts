import { randomUUID } from 'node:crypto';
import {
  DEMO_FIXTURES,
  OPERATIONS,
  parseReleaseStockInput,
  parseReserveStockInput,
  type CheckoutItem,
  type JsonValue,
} from '@test-shop/contracts';
import { failure, result, type OperationHandler } from '@test-shop/service-kit';
import type { Pool, PoolClient } from 'pg';

interface InventoryRow {
  readonly sku: string;
  readonly available: number;
  readonly unit_price_minor: number;
  readonly currency: string;
}

export interface ReservationRow {
  readonly reservation_id: string;
  readonly checkout_id: string;
  readonly status: 'ACTIVE' | 'RELEASED';
  readonly items: CheckoutItem[];
  readonly amount_minor: number;
  readonly currency: string;
  readonly payment_token: string;
  readonly reserve_effects: number;
  readonly release_effects: number;
}

export async function migrateWarehouse(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS warehouse;
    CREATE TABLE IF NOT EXISTS warehouse.inventory (
      sku text PRIMARY KEY,
      available integer NOT NULL CHECK (available >= 0),
      unit_price_minor integer NOT NULL CHECK (unit_price_minor > 0),
      currency text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS warehouse.reservations (
      reservation_id uuid PRIMARY KEY,
      checkout_id text UNIQUE NOT NULL,
      status text NOT NULL CHECK (status IN ('ACTIVE', 'RELEASED')),
      items jsonb NOT NULL,
      amount_minor integer NOT NULL,
      currency text NOT NULL,
      payment_token text NOT NULL,
      reserve_effects integer NOT NULL DEFAULT 1,
      release_effects integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      released_at timestamptz
    );
    INSERT INTO warehouse.inventory (sku, available, unit_price_minor, currency)
    VALUES
      ('SKU-1', 1000, 1299, 'EUR'),
      ('OUT-OF-STOCK', 0, 999, 'EUR'),
      ('WAREHOUSE-ERROR', 1000, 500, 'EUR')
      ,('WAREHOUSE-THROW', 1000, 500, 'EUR')
    ON CONFLICT (sku) DO NOTHING;
  `);
}

export function warehouseHandlers(demoFaults: boolean): Readonly<Record<string, OperationHandler>> {
  return {
    [OPERATIONS.reserveStock]: async ({ command, db }) => reserve(db, command.input as JsonValue, demoFaults),
    [OPERATIONS.releaseStock]: async ({ command, db }) => release(db, command.input as JsonValue, demoFaults),
  };
}

export async function findReservation(pool: Pool, checkoutId: string): Promise<ReservationRow | undefined> {
  const found = await pool.query<ReservationRow>(`
    SELECT reservation_id, checkout_id, status, items, amount_minor, currency,
           payment_token, reserve_effects, release_effects
    FROM warehouse.reservations WHERE checkout_id = $1
  `, [checkoutId]);
  return found.rows[0];
}

export async function resetWarehouseFixtures(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM warehouse.reservations');
    await client.query(`
      UPDATE warehouse.inventory SET available = CASE sku
        WHEN 'SKU-1' THEN 1000
        WHEN 'OUT-OF-STOCK' THEN 0
        WHEN 'WAREHOUSE-ERROR' THEN 1000
        ELSE available END
      WHERE sku IN ('SKU-1', 'OUT-OF-STOCK', 'WAREHOUSE-ERROR', 'WAREHOUSE-THROW')
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function reserve(db: PoolClient, raw: JsonValue, demoFaults: boolean) {
  const input = parseReserveStockInput(raw);
  if (demoFaults && input.items.some((item) => item.sku === DEMO_FIXTURES.warehouseThrowSku)) {
    throw new Error('warehouse handler crash fixture');
  }
  if (demoFaults && input.items.some((item) => item.sku === DEMO_FIXTURES.warehouseErrorSku)) {
    return failure({
      code: 'WAREHOUSE_UNAVAILABLE',
      message: 'The warehouse fixture is unavailable',
      details: null,
    });
  }
  const previous = await db.query<ReservationRow>(`
    SELECT reservation_id, checkout_id, status, items, amount_minor, currency,
           payment_token, reserve_effects, release_effects
    FROM warehouse.reservations WHERE checkout_id = $1 FOR UPDATE
  `, [input.checkoutId]);
  const existing = previous.rows[0];
  if (existing !== undefined) return result(reservationResult(existing));

  const items = aggregateItems(input.items);
  const inventory = await db.query<InventoryRow>(`
    SELECT sku, available, unit_price_minor, currency
    FROM warehouse.inventory WHERE sku = ANY($1::text[]) ORDER BY sku FOR UPDATE
  `, [items.map((item) => item.sku)]);
  const bySku = new Map(inventory.rows.map((row) => [row.sku, row]));
  const unavailable = items.find((item) => {
    const row = bySku.get(item.sku);
    return row === undefined || row.available < item.quantity;
  });
  if (unavailable !== undefined) {
    return failure({
      code: 'OUT_OF_STOCK',
      message: `Not enough stock for ${unavailable.sku}`,
      details: { sku: unavailable.sku },
    });
  }

  const currencies = new Set(inventory.rows.map((row) => row.currency));
  if (currencies.size !== 1) throw new Error('A reservation cannot mix currencies');
  let amountMinor = 0;
  for (const item of items) {
    const row = bySku.get(item.sku);
    if (row === undefined) throw new Error(`Inventory row ${item.sku} disappeared`);
    amountMinor += row.unit_price_minor * item.quantity;
    await db.query('UPDATE warehouse.inventory SET available = available - $2 WHERE sku = $1', [item.sku, item.quantity]);
  }

  const reservationId = randomUUID();
  const currency = inventory.rows[0]?.currency ?? 'EUR';
  await db.query(`
    INSERT INTO warehouse.reservations
      (reservation_id, checkout_id, status, items, amount_minor, currency, payment_token)
    VALUES ($1, $2, 'ACTIVE', $3::jsonb, $4, $5, $6)
  `, [reservationId, input.checkoutId, JSON.stringify(items), amountMinor, currency, input.paymentToken]);
  return result({
    resultCode: 'RESERVED',
    checkoutId: input.checkoutId,
    customerId: input.customerId,
    items,
    paymentToken: input.paymentToken,
    reservationId,
    amount: { minor: amountMinor, currency },
  });
}

async function release(db: PoolClient, raw: JsonValue, demoFaults: boolean) {
  const input = parseReleaseStockInput(raw);
  const releaseFailureTokens: readonly string[] = [
    DEMO_FIXTURES.compensationFailure,
    DEMO_FIXTURES.paymentErrorStockCompensationFailure,
    DEMO_FIXTURES.confirmFailureStockCompensationFailure,
    DEMO_FIXTURES.confirmErrorStockCompensationFailure,
  ];
  if (demoFaults && releaseFailureTokens.includes(input.paymentToken)) {
    return failure({
      code: 'COMPENSATION_FAILED',
      message: 'The stock reservation could not be released',
      details: null,
    });
  }
  const found = await db.query<ReservationRow>(`
    SELECT reservation_id, checkout_id, status, items, amount_minor, currency,
           payment_token, reserve_effects, release_effects
    FROM warehouse.reservations
    WHERE reservation_id = $1 AND checkout_id = $2 FOR UPDATE
  `, [input.reservationId, input.checkoutId]);
  const reservation = found.rows[0];
  if (reservation === undefined) {
    return failure({ code: 'RESERVATION_NOT_FOUND', message: 'Reservation not found', details: null });
  }
  if (reservation.status === 'ACTIVE') {
    for (const item of reservation.items) {
      await db.query('UPDATE warehouse.inventory SET available = available + $2 WHERE sku = $1', [item.sku, item.quantity]);
    }
    await db.query(`
      UPDATE warehouse.reservations
      SET status = 'RELEASED', released_at = clock_timestamp(), release_effects = release_effects + 1
      WHERE reservation_id = $1
    `, [reservation.reservation_id]);
  }
  return result({
    resultCode: 'RELEASED',
    checkoutId: reservation.checkout_id,
    reservationId: reservation.reservation_id,
    status: 'RELEASED',
  });
}

function aggregateItems(items: readonly CheckoutItem[]): CheckoutItem[] {
  const quantities = new Map<string, number>();
  for (const item of items) quantities.set(item.sku, (quantities.get(item.sku) ?? 0) + item.quantity);
  return [...quantities.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sku, quantity]) => ({ sku, quantity }));
}

function reservationResult(row: ReservationRow): JsonValue {
  return {
    resultCode: 'RESERVED',
    checkoutId: row.checkout_id,
    customerId: 'restored-from-ledger',
    items: row.items,
    paymentToken: row.payment_token,
    reservationId: row.reservation_id,
    amount: { minor: row.amount_minor, currency: row.currency },
  };
}
