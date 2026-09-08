import { describe, expect, it } from 'vitest';
import { createSharedCoverLoader, loadCoversWithConcurrency } from './cover-loader';

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

describe('createSharedCoverLoader', () => {
  it('shares a request and caps physical work across refresh generations', async () => {
    const pending: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    const shared = createSharedCoverLoader<number>(async (seriesId) => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => pending.push(resolve));
      active -= 1;
      return seriesId;
    }, 2);

    const first = shared.load(1);
    const replacement = shared.load(1);
    const second = shared.load(2);
    const queued = shared.load(3);

    expect(replacement).toBe(first);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
    expect(maximumActive).toBe(2);

    pending.shift()?.();
    pending.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(3);
    pending.shift()?.();

    await expect(Promise.all([first, replacement, second, queued])).resolves.toEqual([1, 1, 2, 3]);
    expect(maximumActive).toBe(2);
  });

  it('cancels active and queued requests', async () => {
    let aborted = false;
    const shared = createSharedCoverLoader<number>(async (_seriesId, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        });
      });
      throw new DOMException('Aborted', 'AbortError');
    }, 1);
    const active = shared.load(1);
    const queued = shared.load(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    shared.cancel();

    await expect(active).rejects.toMatchObject({ name: 'AbortError' });
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted).toBe(true);
  });
});
