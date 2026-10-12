/** Bounded execution with one replaceable pending value per key and no same-key overlap. */
export function createKeyedTaskQueue<T>(
  concurrency: number,
  run: (value: T) => Promise<void>,
  onError: (error: unknown) => void,
) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("concurrency must be positive");
  const pending = new Map<string, T>();
  const active = new Set<string>();
  const waiters = new Set<() => void>();
  function drain(): void {
    while (active.size < concurrency) {
      let next: string | undefined;
      for (const key of pending.keys()) { if (!active.has(key)) { next = key; break; } }
      if (next === undefined) break;
      const value = pending.get(next)!;
      pending.delete(next);
      active.add(next);
      void Promise.resolve().then(() => run(value)).catch(onError).finally(() => {
        active.delete(next);
        drain();
      });
    }
    if (!active.size && !pending.size) {
      for (const resolve of waiters) resolve();
      waiters.clear();
    }
  }
  return {
    enqueue(key: string, value: T): void { pending.set(key, value); drain(); },
    idle(): Promise<void> {
      if (!active.size && !pending.size) return Promise.resolve();
      return new Promise((resolve) => waiters.add(resolve));
    },
  };
}
