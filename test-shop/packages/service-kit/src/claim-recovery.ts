export interface RecoverableClaim {
  readonly messageId: string;
  readonly owner: string;
  readonly claimVersion: number;
}

interface PendingClaim extends RecoverableClaim {
  readonly retryAfterMs: number;
}

export class ClaimRecoveryQueue {
  private readonly pending = new Map<string, PendingClaim>();

  get size(): number { return this.pending.size; }

  track(claims: readonly RecoverableClaim[], retryAfterMs = 1_000): void {
    for (const claim of claims) this.pending.set(claim.messageId, { ...claim, retryAfterMs });
  }

  retryAfter(messageId: string, retryAfterMs: number): void {
    const claim = this.pending.get(messageId);
    if (claim !== undefined) this.pending.set(messageId, { ...claim, retryAfterMs });
  }

  complete(messageId: string): void {
    this.pending.delete(messageId);
  }

  async flush(
    reschedule: (claim: RecoverableClaim, retryAfterMs: number) => Promise<void>,
  ): Promise<void> {
    for (const claim of this.pending.values()) {
      const { retryAfterMs, ...recoverable } = claim;
      await reschedule(recoverable, retryAfterMs);
      this.pending.delete(claim.messageId);
    }
  }
}
