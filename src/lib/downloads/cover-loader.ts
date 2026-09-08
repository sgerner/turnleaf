export interface CoverLoadItem {
  seriesId: number;
}

export interface CoverLoaderOptions<T> {
  signal: AbortSignal;
  concurrency?: number;
  hasCover?: (seriesId: number) => boolean;
  load: (seriesId: number, signal: AbortSignal) => Promise<T>;
  onLoaded: (seriesId: number, cover: T) => void;
}

/**
 * Load a set of series covers with a small worker pool.
 *
 * The caller owns the signal and can cancel the whole batch when its view is
 * torn down or replaced. Individual failures are ignored because covers are
 * decorative and should not prevent the library metadata from rendering.
 */
export async function loadCoversWithConcurrency<T>(
  items: readonly CoverLoadItem[],
  { signal, concurrency = 6, hasCover, load, onLoaded }: CoverLoaderOptions<T>,
): Promise<void> {
  const seriesIds = [
    ...new Set(items.map((item) => item.seriesId).filter((seriesId) => !hasCover?.(seriesId))),
  ];
  if (signal.aborted || seriesIds.length === 0) return;

  const requestedConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
  const workerCount = Math.min(Math.max(1, requestedConcurrency), seriesIds.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (!signal.aborted) {
      if (nextIndex >= seriesIds.length) return;
      const seriesId = seriesIds[nextIndex++]!;

      try {
        const cover = await load(seriesId, signal);
        if (!signal.aborted) onLoaded(seriesId, cover);
      } catch {
        if (signal.aborted) return;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
