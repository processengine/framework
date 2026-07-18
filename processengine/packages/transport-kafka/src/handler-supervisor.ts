export interface KafkaHandlerRetryContext {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
  readonly attempt: number;
}

export async function superviseKafkaHandler(input: {
  readonly isActive: () => boolean;
  readonly handle: () => Promise<void>;
  readonly heartbeat: () => Promise<void>;
  readonly heartbeatIntervalMs?: number;
  readonly retryDelayMs: number;
  readonly context: Omit<KafkaHandlerRetryContext, 'attempt'>;
  readonly onError?: (error: unknown, context: KafkaHandlerRetryContext) => void | Promise<void>;
  readonly wait?: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  let attempt = 0;
  let lastError: unknown;
  const wait = input.wait ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  while (input.isActive()) {
    try {
      await handleWithHeartbeat(input, wait);
      return;
    } catch (error) {
      lastError = error;
      attempt += 1;
      try { await input.onError?.(error, { ...input.context, attempt }); }
      catch { /* Diagnostics cannot change acknowledgement semantics. */ }
      if (!input.isActive()) throw error;
      await input.heartbeat();
      await waitForRetry(input, wait);
    }
  }
  throw lastError ?? new Error('Kafka handler subscription stopped before acknowledgement');
}

async function waitForRetry(
  input: Parameters<typeof superviseKafkaHandler>[0],
  wait: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? 3_000;
  let remainingMs = input.retryDelayMs;
  while (remainingMs > 0 && input.isActive()) {
    const delayMs = Math.min(remainingMs, heartbeatIntervalMs);
    await wait(delayMs);
    remainingMs -= delayMs;
    if (remainingMs > 0 && input.isActive()) await input.heartbeat();
  }
}

async function handleWithHeartbeat(
  input: Parameters<typeof superviseKafkaHandler>[0],
  wait: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const execution = input.handle();
  let settled = false;
  const observed = execution.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  while (!settled) {
    await Promise.race([observed, wait(input.heartbeatIntervalMs ?? 3_000)]);
    if (!settled && input.isActive()) await input.heartbeat();
  }
  await execution;
}
