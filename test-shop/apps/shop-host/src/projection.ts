import type { JsonValue } from '@test-shop/contracts';

interface ProcessViewInput {
  readonly instanceId: string;
  readonly lifecycle: string;
  readonly revision: number;
  readonly currentStep: string;
  readonly pending: { readonly operation?: string } | null;
  readonly outcome: string | null;
  readonly response: JsonValue;
  readonly error: unknown;
  readonly fault: unknown;
}

export function projectCheckout(process: ProcessViewInput) {
  return {
    checkoutId: process.instanceId,
    processId: process.instanceId,
    processStatus: process.lifecycle,
    status: process.lifecycle === 'COMPLETED' ? process.outcome : process.lifecycle,
    outcome: process.outcome,
    response: process.response,
    error: process.error,
    fault: process.fault,
    currentStep: process.currentStep,
    pendingOperation: process.pending?.operation ?? null,
    revision: process.revision,
  };
}

