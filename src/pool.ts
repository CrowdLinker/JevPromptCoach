/**
 * Bounded-concurrency runner for API batches. A batch that throws is dropped
 * rather than retried: a backfill missing one slice is still worth having, and
 * the SDK has already retried the transient failures underneath.
 */
export async function runPool<T extends object, R>(
  batches: T[],
  concurrency: number,
  run: (batch: T) => Promise<R[]>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const workers = Math.max(1, Math.min(concurrency, batches.length || 1));
  const results: R[] = [];
  let next = 0;
  let done = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const batch = batches[next++];
      if (batch === undefined) return;
      try {
        results.push(...(await run(batch)));
      } catch {
        // Fail open: this slice is simply missing.
      }
      done += 1;
      onProgress?.(done, batches.length);
    }
  }

  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
