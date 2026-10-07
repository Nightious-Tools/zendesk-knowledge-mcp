/** Sliding-window per-key rate limiter. Waits (never drops) so callers stay under Zendesk limits. */
export class RateLimiter {
  private windows = new Map<string, number[]>();
  constructor(
    private limits: Record<string, number>,
    private windowMs = 60_000,
    private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async acquire(key: string): Promise<void> {
    const limit = this.limits[key];
    if (!limit) return;
    for (;;) {
      const t = this.now();
      const w = (this.windows.get(key) ?? []).filter((x) => t - x < this.windowMs);
      if (w.length < limit) { w.push(t); this.windows.set(key, w); return; }
      const wait = this.windowMs - (t - w[0]) + 5;
      await this.sleep(wait);
    }
  }
}
