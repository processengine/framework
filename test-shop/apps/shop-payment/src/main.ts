import { createServer, type ServerResponse } from 'node:http';
import { loadConfig } from './config.js';
import {
  armPaymentControl,
  findPayment,
  findPaymentControl,
  releasePaymentControl,
  resetPaymentFixtures,
} from './payment.js';
import { createPaymentService } from './runtime.js';

const config = loadConfig();
const service = createPaymentService(config);
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
    const paymentMatch = /^\/debug\/payments\/([^/]+)$/u.exec(path);
    if (request.method === 'GET' && config.debugApi && paymentMatch?.[1] !== undefined) {
      const payment = await findPayment(service.pool, decodeURIComponent(paymentMatch[1]));
      return payment === undefined ? send(response, 404, { code: 'NOT_FOUND' }) : send(response, 200, payment);
    }
    const statsMatch = /^\/debug\/operations\/([^/]+)$/u.exec(path);
    if (request.method === 'GET' && config.debugApi && statsMatch?.[1] !== undefined) {
      return send(response, 200, await service.stats(decodeURIComponent(statsMatch[1])));
    }
    const controlMatch = /^\/debug\/controls\/([^/]+)$/u.exec(path);
    if (request.method === 'GET' && config.debugApi && controlMatch?.[1] !== undefined) {
      const control = await findPaymentControl(service.pool, decodeURIComponent(controlMatch[1]));
      return control === undefined ? send(response, 404, { code: 'NOT_FOUND' }) : send(response, 200, control);
    }
    const armMatch = /^\/debug\/controls\/([^/]+)\/arm$/u.exec(path);
    if (request.method === 'POST' && config.debugApi && armMatch?.[1] !== undefined) {
      await armPaymentControl(service.pool, decodeURIComponent(armMatch[1]));
      return send(response, 200, { status: 'ARMED' });
    }
    const releaseMatch = /^\/debug\/controls\/([^/]+)\/release$/u.exec(path);
    if (request.method === 'POST' && config.debugApi && releaseMatch?.[1] !== undefined) {
      const released = await releasePaymentControl(service.pool, decodeURIComponent(releaseMatch[1]));
      return released ? send(response, 200, { status: 'RELEASED' }) : send(response, 404, { code: 'NOT_FOUND' });
    }
    const replayMatch = /^\/debug\/completions\/([^/]+)\/replay$/u.exec(path);
    if (request.method === 'POST' && config.debugApi && replayMatch?.[1] !== undefined) {
      const count = await service.replayResponses(decodeURIComponent(replayMatch[1]));
      return send(response, 202, { status: 'REPLAYED', count });
    }
    const injectMatch = /^\/debug\/completions\/([^/]+)\/(new-message-id|conflict|foreign-source|foreign-request-id|malformed|late-success)$/u.exec(path);
    if (request.method === 'POST' && config.debugApi && injectMatch?.[1] !== undefined && injectMatch[2] !== undefined) {
      const messageId = await service.injectCompletion(
        decodeURIComponent(injectMatch[1]),
        injectMatch[2] as 'new-message-id' | 'conflict' | 'foreign-source' | 'foreign-request-id' | 'malformed' | 'late-success',
      );
      return send(response, 202, { status: 'INJECTED', mode: injectMatch[2], messageId });
    }
    const replayCommandMatch = /^\/debug\/commands\/([^/]+)\/replay$/u.exec(path);
    if (request.method === 'POST' && config.debugApi && replayCommandMatch?.[1] !== undefined) {
      const count = await service.replayCommands(decodeURIComponent(replayCommandMatch[1]));
      return send(response, 202, { status: 'REPLAYED', count });
    }
    if (request.method === 'POST' && config.debugApi && path === '/debug/fixtures/reset') {
      await resetPaymentFixtures(service.pool);
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
  throw new Error(`shop-payment startup timed out: ${startupError ?? 'unknown error'}`);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function message(error: unknown): string { return error instanceof Error ? error.message : 'Unknown error'; }
