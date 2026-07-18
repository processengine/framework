import { describe, expect, it, vi } from 'vitest';
import { ClaimRecoveryQueue } from '../packages/service-kit/src/claim-recovery.js';

describe('service outbox claim recovery', () => {
  it('retains only claims whose fenced reschedule has not succeeded', async () => {
    const recovery = new ClaimRecoveryQueue();
    recovery.track([
      { messageId: 'completion-1', owner: 'worker-a', claimVersion: 1 },
      { messageId: 'completion-2', owner: 'worker-a', claimVersion: 4 },
    ]);
    const unavailable = vi.fn(async (claim: { readonly messageId: string }) => {
      if (claim.messageId === 'completion-2') throw new Error('PostgreSQL unavailable');
    });

    await expect(recovery.flush(unavailable)).rejects.toThrow('PostgreSQL unavailable');
    expect(unavailable.mock.calls.map(([claim]) => claim.messageId)).toEqual(['completion-1', 'completion-2']);
    expect(recovery.size).toBe(1);

    const recovered = vi.fn(async () => undefined);
    await recovery.flush(recovered);
    expect(recovered).toHaveBeenCalledWith(
      { messageId: 'completion-2', owner: 'worker-a', claimVersion: 4 },
      1_000,
    );
    expect(recovery.size).toBe(0);
  });

  it('forgets completed claims and preserves an explicit retry delay', async () => {
    const recovery = new ClaimRecoveryQueue();
    recovery.track([
      { messageId: 'published', owner: 'worker-b', claimVersion: 2 },
      { messageId: 'deferred', owner: 'worker-b', claimVersion: 3 },
    ]);
    recovery.complete('published');
    recovery.retryAfter('deferred', 250);
    const reschedule = vi.fn(async () => undefined);

    await recovery.flush(reschedule);

    expect(reschedule).toHaveBeenCalledTimes(1);
    expect(reschedule).toHaveBeenCalledWith(
      { messageId: 'deferred', owner: 'worker-b', claimVersion: 3 },
      250,
    );
  });
});
