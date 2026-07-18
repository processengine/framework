import { describe, expect, it, vi } from 'vitest';
import { superviseKafkaHandler } from '../src/handler-supervisor.js';

describe('Kafka handler supervision', () => {
  it('retries the same unacknowledged record after an ordinary or TypeError failure', async () => {
    let calls = 0;
    const errors: unknown[] = [];
    const heartbeat = vi.fn(async () => undefined);
    await superviseKafkaHandler({
      isActive: () => true,
      heartbeat,
      retryDelayMs: 1,
      wait: async () => undefined,
      context: { topic: 'completions', partition: 1, offset: '42' },
      onError: (error) => { errors.push(error); },
      handle: async () => {
        calls += 1;
        if (calls === 1) throw new TypeError('database temporarily unavailable');
      },
    });
    expect(calls).toBe(2);
    expect(errors).toHaveLength(1);
    expect(heartbeat).toHaveBeenCalledOnce();
  });

  it('does not acknowledge a failed record when the subscription is stopping', async () => {
    let active = true;
    const failure = new Error('still unavailable');
    await expect(superviseKafkaHandler({
      isActive: () => active,
      heartbeat: async () => undefined,
      retryDelayMs: 1,
      wait: async () => { active = false; },
      context: { topic: 'commands', partition: 0, offset: '7' },
      handle: async () => { throw failure; },
    })).rejects.toBe(failure);
  });

  it('heartbeats while a long-running domain handler owns the record', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const heartbeat = vi.fn(async () => undefined);
      const supervised = superviseKafkaHandler({
        isActive: () => true,
        heartbeat,
        heartbeatIntervalMs: 100,
        retryDelayMs: 1,
        context: { topic: 'commands', partition: 2, offset: '9' },
        handle: () => new Promise<void>((resolve) => { release = resolve; }),
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(heartbeat).toHaveBeenCalledOnce();
      release();
      await supervised;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps heartbeating throughout a retry delay longer than one heartbeat interval', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const heartbeat = vi.fn(async () => undefined);
      const supervised = superviseKafkaHandler({
        isActive: () => true,
        heartbeat,
        heartbeatIntervalMs: 100,
        retryDelayMs: 350,
        context: { topic: 'completions', partition: 0, offset: '11' },
        handle: async () => {
          calls += 1;
          if (calls === 1) throw new Error('temporarily unavailable');
        },
      });

      await vi.advanceTimersByTimeAsync(350);
      await supervised;

      expect(calls).toBe(2);
      expect(heartbeat).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
