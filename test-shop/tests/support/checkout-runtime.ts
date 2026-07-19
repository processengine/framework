// A mode-stable test harness that drives the shipped checkout flow through the
// public conductor runtime — no kernel/transition imports. It uses only API that
// exists in both the published 0.1.0 and the local build:
//   - Conductor + StaticArtifactRegistry + StaticOperationCatalog + compileFlow
//     + responseEnvelope + parseOperationCommand (public root);
//   - MemoryMessageTransport + createMemoryStorage + ManualClock (/testing).
//
// It starts a process, ticks the worker to publish each operation command, feeds
// operation completions through the public completion contract, and drives the
// two internal failure classes with real runtime mechanics: a completion timeout
// via ManualClock advance, and a dispatch failure via a transport that refuses to
// publish a chosen operation (with maxAttempts=1).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Conductor,
  StaticArtifactRegistry,
  StaticOperationCatalog,
  compileFlow,
  parseOperationCommand,
  responseEnvelope,
  type JsonValue,
  type MessageEnvelope,
  type OperationBinding,
  type OperationError,
  type ProcessState,
} from '@processengine/conductor';
import { ManualClock, MemoryMessageTransport, createMemoryStorage } from '@processengine/conductor/testing';

const definition = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../flows/shop.checkout.v1.json', import.meta.url)),
  'utf8',
)) as { readonly id: string; readonly version: string };

const SOURCE = 'test-shop-host';
const COMPLETION_DESTINATION = 'test-shop.completions';
const CHECKOUT_OPERATIONS = [
  'warehouse.reserve', 'payment.authorize', 'payment.confirm', 'payment.cancel', 'warehouse.release',
] as const;

export const CHECKOUT_TIMEOUT_MS = 1_000;

// The runtime injects exactly these on timeout / dispatch failure (core-errors).
export const TIMEOUT_ERROR: OperationError = {
  code: 'PROCESSENGINE_COMPLETION_TIMEOUT', message: 'Operation did not complete before its deadline', details: null,
};
export const DISPATCH_FAILED_ERROR: OperationError = {
  code: 'PROCESSENGINE_DISPATCH_FAILED', message: 'Operation command could not be published', details: null,
};

export function checkoutCatalog(): StaticOperationCatalog {
  const bindings: OperationBinding[] = CHECKOUT_OPERATIONS.map((operation) => ({
    operation,
    destination: `test-shop.commands.${operation}`,
    completionSource: `test-shop.${operation}`,
    policy: {
      id: 'checkout-test', version: '1',
      completionTimeoutMs: CHECKOUT_TIMEOUT_MS,
      dispatch: { maxAttempts: 1, retryDelayMs: 0 },
    },
  }));
  return new StaticOperationCatalog(bindings);
}

export type CheckoutStep =
  | { readonly kind: 'response'; readonly value: JsonValue }
  | { readonly kind: 'error'; readonly value: OperationError }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'dispatchFailed' };

export const okStep = (value: JsonValue): CheckoutStep => ({ kind: 'response', value });
export const errorStep = (value: OperationError): CheckoutStep => ({ kind: 'error', value });
export const timeoutStep: CheckoutStep = { kind: 'timeout' };
export const dispatchFailedStep: CheckoutStep = { kind: 'dispatchFailed' };

class ControlledTransport extends MemoryMessageTransport {
  readonly failOperations = new Set<string>();
  override async publish(message: MessageEnvelope): Promise<void> {
    let operation: string | undefined;
    try { operation = parseOperationCommand(message).operation; } catch { operation = undefined; }
    if (operation && this.failOperations.has(operation)) throw new Error(`publish refused for ${operation}`);
    return super.publish(message);
  }
}

export interface CheckoutRun {
  readonly state: ProcessState;
  readonly dispatched: readonly { readonly operation: string; readonly input: JsonValue }[];
}

export async function runCheckout(options: {
  readonly catalog: StaticOperationCatalog;
  readonly instanceId: string;
  readonly input: JsonValue;
  readonly steps: readonly CheckoutStep[];
}): Promise<CheckoutRun> {
  const clock = new ManualClock();
  const transport = new ControlledTransport();
  const storage = createMemoryStorage();
  const artifacts = new StaticArtifactRegistry([compileFlow(definition, { operations: options.catalog })]);
  const conductor = new Conductor({
    source: SOURCE, completionDestination: COMPLETION_DESTINATION,
    artifacts, operations: options.catalog, storage, transport, clock,
    worker: { pollIntervalMs: 3_600_000, outboxLeaseMs: 60_000 },
  });

  const dispatched: { operation: string; input: JsonValue }[] = [];
  await conductor.start();
  try {
    await conductor.startProcess({
      namespace: 'test-shop.checkout', idempotencyKey: options.instanceId, instanceId: options.instanceId,
      flow: { id: definition.id, version: definition.version }, input: options.input,
    });

    let cursor = 0;
    for (const step of options.steps) {
      const pending = (await conductor.getProcess(options.instanceId))?.pending;
      if (!pending) throw new Error(`No pending operation before ${step.kind} step`);

      if (step.kind === 'dispatchFailed') {
        transport.failOperations.add(pending.operation);
        await conductor.tick();
        transport.failOperations.delete(pending.operation);
        continue;
      }

      await conductor.tick(); // publish the pending operation command
      dispatched.push(commandFor(transport, cursor, pending.requestId));
      cursor = transport.published.length;

      if (step.kind === 'timeout') {
        clock.advance(CHECKOUT_TIMEOUT_MS + 1_000);
        await conductor.tick(); // the deadline has passed: resolve the timeout
        continue;
      }

      const completionSource = options.catalog.get(pending.operation)!.completionSource;
      const completion = step.kind === 'error'
        ? { requestId: pending.requestId, error: step.value }
        : { requestId: pending.requestId, response: step.value };
      const outcome = await conductor.handleCompletion(responseEnvelope({
        source: completionSource, destination: COMPLETION_DESTINATION,
        instanceId: options.instanceId, occurredAt: clock.now().toISOString(), completion,
      }));
      if (outcome !== 'COMMITTED') throw new Error(`Completion for ${pending.operation} was ${outcome}, expected COMMITTED`);
    }

    const state = await conductor.getProcess(options.instanceId);
    if (!state) throw new Error('Process record disappeared');
    return { state, dispatched };
  } finally {
    await conductor.stop();
  }
}

function commandFor(transport: ControlledTransport, from: number, requestId: string): { operation: string; input: JsonValue } {
  for (let index = from; index < transport.published.length; index += 1) {
    try {
      const command = parseOperationCommand(transport.published[index]!);
      if (command.requestId === requestId) return { operation: command.operation, input: command.input };
    } catch { /* not an operation command */ }
  }
  throw new Error(`No published command for ${requestId}`);
}
