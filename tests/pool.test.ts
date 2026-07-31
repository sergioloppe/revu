import { describe, it, expect } from 'vitest';
import { runPool } from '../src/util/pool.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('runPool', () => {
  it('never runs more than `limit` tasks concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = [40, 5, 30, 5, 20, 5, 10, 5];
    await runPool(items, 2, async (ms) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(ms);
      inFlight -= 1;
      return ms;
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('returns results in input order regardless of completion order', async () => {
    const items = [30, 5, 20, 5, 10];
    const results = await runPool(items, 3, async (ms, index) => {
      await delay(ms);
      return `${index}:${ms}`;
    });
    expect(results).toEqual(['0:30', '1:5', '2:20', '3:5', '4:10']);
  });

  it('rejects with the worker error and stops starting new tasks after a failure', async () => {
    const started: number[] = [];
    const items = [0, 0, 0, 0, 0];
    const p = runPool(items, 1, async (_item, index) => {
      started.push(index);
      if (index === 1) throw new Error(`boom at ${index}`);
      await delay(5);
      return index;
    });
    await expect(p).rejects.toThrow('boom at 1');
    // limit=1 is strictly sequential: once index 1 throws, no later index should start.
    expect(started).toEqual([0, 1]);
  });

  it('resolves an empty array for no items', async () => {
    const results = await runPool([], 4, async () => 1);
    expect(results).toEqual([]);
  });
});
