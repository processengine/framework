import { createServer, type ServerResponse } from 'node:http';
import { loadConfig } from './config.js';
import { createWarehouseService } from './runtime.js';
import { findReservation, resetWarehouseFixtures } from './warehouse.js';

const config = loadConfig();
const service = createWarehouseService(config);
let startupError: string | undefined;

const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method === 'GET' && path === '/health/live') return send(response, 200, { status: 'UP' });
    if (request.method === 'GET' && path === '/health/ready') {
      return send(response, service.ready ? 200 : 503, {
        status: service.ready ? 'READY' : 'NOT_READY',
        ...(startupError ? { error: startupError } : {}),
      });
    }
    const reservationMatch = /^\/debug\/reservations\/([^/]+)$/u.exec(path);
    if (request.method === 'GET' && config.debugApi && reservationMatch?.[1] !== undefined) {
      const checkoutId = decodeURIComponent(reservationMatch[1]);
      const reservation = await findReservation(service.pool, checkoutId);
      return reservation === undefined ? send(response, 404, { code: 'NOT_FOUND' }) : send(response, 200, reservation);
    }
    const statsMatch = /^\/debug\/operations\/([^/]+)$/u.exec(path);
    if (request.method === 'GET' && config.debugApi && statsMatch?.[1] !== undefined) {
      return send(response, 200, await service.stats(decodeURIComponent(statsMatch[1])));
    }
    const replayCommandMatch = /^\/debug\/commands\/([^/]+)\/replay$/u.exec(path);
    if (request.method === 'POST' && config.debugApi && replayCommandMatch?.[1] !== undefined) {
      const count = await service.replayCommands(decodeURIComponent(replayCommandMatch[1]));
      return send(response, 202, { status: 'REPLAYED', count });
    }
    if (request.method === 'POST' && config.debugApi && path === '/debug/fixtures/reset') {
      await resetWarehouseFixtures(service.pool);
      return send(response, 200, { status: 'RESET' });
    }
    return send(response, 404, { code: 'NOT_FOUND' });
  } catch (error) {
    return send(response, 500, { code: 'INTERNAL_ERROR', message: message(error) });
  }
});

await new Promise<void>((resolve) => server.listen(config.port, '0.0.0.0', resolve));
await startWithRetry();

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await service.stop();
};
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());

async function startWithRetry(): Promise<void> {
  const deadline = Date.now() + config.startupTimeoutMs;
  while (Date.now() < deadline) {
    try {
      await service.start();
      startupError = undefined;
      return;
    } catch (error) {
      startupError = message(error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`shop-warehouse startup timed out: ${startupError ?? 'unknown error'}`);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function message(error: unknown): string { return error instanceof Error ? error.message : 'Unknown error'; }
