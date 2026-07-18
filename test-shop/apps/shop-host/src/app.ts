import Fastify, { type FastifyInstance } from 'fastify';
import type { JsonValue } from '@test-shop/contracts';
import { createShopConductor, type ShopConductor } from '@test-shop/host-adapter';
import type { ShopHostConfig } from './config.js';
import { projectCheckout } from './projection.js';

export interface CheckoutApplication {
  readonly server: FastifyInstance;
  readonly runtime: ShopConductor;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createCheckoutApplication(config: ShopHostConfig): Promise<CheckoutApplication> {
  const hostIdentity = globalThis.process.env.HOSTNAME ?? `pid-${globalThis.process.pid}`;
  const runtime = await createShopConductor({
    source: 'test-shop.shop-host',
    completionDestination: config.completionTopic,
    completionConsumerGroup: config.completionConsumerGroup,
    flowFiles: config.flowFiles,
    operationsFile: config.operationsFile,
    databaseUrl: config.databaseUrl,
    databaseSchema: config.databaseSchema,
    kafkaClientId: config.kafkaClientId,
    kafkaBrokers: config.kafkaBrokers,
    activeFlowVersion: config.activeFlowVersion,
  });
  const server = Fastify({ logger: true });
  let ready = false;
  let startupError: string | undefined;

  server.get('/health/live', async () => ({ status: 'UP' }));
  server.get('/health/ready', async (_request, reply) => {
    if (!ready) return reply.code(503).send({ status: 'DOWN', ...(startupError ? { error: startupError } : {}) });
    return { status: 'UP' };
  });

  server.post('/api/checkouts', async (request, reply) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/u.test(key)) {
      return reply.code(400).send({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    }
    const input = parseCheckoutInput(key, request.body);
    if (!input) return reply.code(400).send({ code: 'CHECKOUT_INVALID' });
    const result = await runtime.startCheckout({ idempotencyKey: key, input });
    if (result.kind === 'IDEMPOTENCY_CONFLICT') {
      return reply.code(409).send({ code: 'IDEMPOTENCY_CONFLICT', processId: result.instanceId });
    }
    return reply.code(result.kind === 'STARTED' ? 202 : 200).send({
      ...projectCheckout(result.process),
      servedBy: hostIdentity,
    });
  });

  server.get<{ Params: { checkoutId: string } }>('/api/checkouts/:checkoutId', async (request, reply) => {
    const state = await runtime.getCheckout(request.params.checkoutId);
    if (!state) return reply.code(404).send({ code: 'CHECKOUT_NOT_FOUND', servedBy: hostIdentity });
    return { ...projectCheckout(state), servedBy: hostIdentity };
  });

  if (config.debugApi) {
    server.get<{ Params: { processId: string } }>('/debug/processes/:processId', async (request, reply) => {
      const state = await runtime.getCheckout(request.params.processId);
      return state
        ? { process: state, servedBy: hostIdentity }
        : reply.code(404).send({ code: 'PROCESS_NOT_FOUND' });
    });
  }

  return {
    server,
    runtime,
    async start() {
      await server.listen({ port: config.port, host: config.host });
      const deadline = Date.now() + config.startupTimeoutMs;
      while (Date.now() < deadline) {
        try {
          await runtime.start();
          ready = true;
          startupError = undefined;
          return;
        } catch (error) {
          startupError = error instanceof Error ? error.message : 'Unknown startup error';
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      throw new Error(`shop-host startup timed out: ${startupError ?? 'unknown error'}`);
    },
    async stop() {
      ready = false;
      await server.close();
      await runtime.stop();
    },
  };
}

export function parseCheckoutInput(checkoutId: string, value: unknown): JsonValue | undefined {
  if (!record(value) || !boundedText(value.customerId, 100) || !Array.isArray(value.items)
    || value.items.length === 0 || value.items.length > 100 || !boundedText(value.paymentToken, 200)) return undefined;
  const items = value.items.map((item) => {
    if (!record(item) || !boundedText(item.sku, 100) || !Number.isSafeInteger(item.quantity)
      || (item.quantity as number) <= 0 || (item.quantity as number) > 10_000) return undefined;
    return { sku: item.sku, quantity: item.quantity as number };
  });
  if (items.some((item) => item === undefined)) return undefined;
  return { checkoutId, customerId: value.customerId, items: items as JsonValue, paymentToken: value.paymentToken };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && value.trim() === value;
}
