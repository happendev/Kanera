/** Keep slots busy without allowing a failed delivery to leave unawaited work in a scheduler. */
export async function forEachConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  deliver: (item: T) => Promise<unknown>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("concurrency must be positive");
  let next = 0;
  const errors: unknown[] = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        await deliver(item);
      } catch (error) {
        errors.push(error);
      }
    }
  }));
  // Wait for every claimed row before rejecting: single-flight schedulers otherwise start the
  // next sweep while work from the previous one still holds leases/connections.
  if (errors.length) throw new AggregateError(errors, "concurrent deliveries failed");
}
