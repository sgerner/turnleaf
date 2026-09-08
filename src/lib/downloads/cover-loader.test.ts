import { describe, expect, it } from 'vitest';
import { loadCoversWithConcurrency } from './cover-loader';

describe('loadCoversWithConcurrency', () => {
  it('deduplicates series and limits active loads', async () => {
    const controller = new AbortController();
    const loaded: number[] = [];
    let active = 0;
    let maximumActive = 0;

    await loadCoversWithConcurrency(
      [{ seriesId: 1 }, { seriesId: 1 }, { seriesId: 2 }, { seriesId: 3 }],
      {
        signal: controller.signal,
        concurrency: 2,
        load: async (seriesId) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 0));
          active -= 1;
          return seriesId;
        },
        onLoaded: (seriesId) => loaded.push(seriesId),
      },
    );

    expect(maximumActive).toBe(2);
    expect(loaded.sort()).toEqual([1, 2, 3]);
  });

  it('does not publish a cover that completes after cancellation', async () => {
    const controller = new AbortController();
    const loaded: number[] = [];
    const disposed: number[] = [];
    let resolveCover: ((seriesId: number) => void) | undefined;
    const pendingCover = new Promise<number>((resolve) => {
      resolveCover = resolve;
    });

    const loading = loadCoversWithConcurrency([{ seriesId: 7 }], {
      signal: controller.signal,
      load: async () => pendingCover,
      onLoaded: (seriesId) => loaded.push(seriesId),
      dispose: (seriesId) => disposed.push(seriesId),
    });

    controller.abort();
    resolveCover?.(7);
    await loading;

    expect(loaded).toEqual([]);
    expect(disposed).toEqual([7]);
  });

  it('skips series that already have a cover', async () => {
    const controller = new AbortController();
    const requested: number[] = [];

    await loadCoversWithConcurrency([{ seriesId: 1 }, { seriesId: 2 }], {
      signal: controller.signal,
      hasCover: (seriesId) => seriesId === 1,
      load: async (seriesId) => {
        requested.push(seriesId);
        return seriesId;
      },
      onLoaded: () => {},
    });

    expect(requested).toEqual([2]);
  });
});
