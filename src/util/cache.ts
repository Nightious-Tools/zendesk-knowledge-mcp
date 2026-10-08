/**
 * Small in-memory TTL cache with LRU eviction.
 * Deliberately memory-only and short-lived: this server must never build a
 * persistent bulk copy of Zendesk documentation.
 */
export class TtlCache<V = unknown> {
  private map = new Map<string, { value: V; expires: number }>();
  constructor(private maxEntries = 500, private now: () => number = Date.now) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= this.now()) { this.map.delete(key); return undefined; }
    this.map.delete(key); // refresh LRU position
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    if (ttlMs <= 0) return;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void { this.map.delete(key); }
}
