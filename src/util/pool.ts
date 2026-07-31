/**
 * Bounded-concurrency promise pool with no external deps.
 *
 * Runs `worker` over `items` with at most `limit` in flight at once. Results are
 * returned in input order regardless of completion order. If any worker throws,
 * no further items are started (workers already in flight are allowed to finish,
 * their results discarded) and the pool rejects with that error.
 */
export async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let hasFailure = false;
  let failureError: unknown;

  async function runLane(): Promise<void> {
    for (;;) {
      if (hasFailure) return;
      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex += 1;
      try {
        results[index] = await worker(items[index]!, index);
      } catch (error) {
        if (!hasFailure) { hasFailure = true; failureError = error; }
        return;
      }
    }
  }

  const laneCount = Math.max(0, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: laneCount }, () => runLane()));

  if (hasFailure) throw failureError;
  return results;
}
