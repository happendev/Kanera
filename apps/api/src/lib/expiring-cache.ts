/** Small process-local caches must release cold keys too, not just keys read after expiry. */
export class ExpiringCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly maxEntries: number, private readonly sweepIntervalMs = 60_000) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string, now = Date.now()): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      this.stopIfEmpty();
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, expiresAt: number, now = Date.now()): void {
    this.entries.delete(key);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      this.stopIfEmpty();
      return;
    }
    if (this.entries.size >= this.maxEntries) {
      this.sweep(now);
      // Expire cold entries first; at capacity evict the oldest write. A miss only costs a reload
      // (or an earlier ops alert), whereas retaining every historical key grows with process uptime.
      if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.set(key, { value, expiresAt });
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweep(Date.now()), this.sweepIntervalMs);
      this.sweepTimer.unref();
    }
  }

  clear(): void {
    this.entries.clear();
    this.stopIfEmpty();
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    this.stopIfEmpty();
  }

  private stopIfEmpty(): void {
    if (this.entries.size || !this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}
