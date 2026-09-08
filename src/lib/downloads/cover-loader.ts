export interface CoverLoadItem {
  seriesId: number;
}

export interface SharedCoverLoader<T> {
  load: (seriesId: number) => Promise<T>;
  waitForIdle: () => Promise<void>;
  cancel: () => void;
}

export interface CoverLoaderOptions<T> {
  signal: AbortSignal;
  concurrency?: number;
  hasCover?: (seriesId: number) => boolean;
  load: (seriesId: number, signal: AbortSignal) => Promise<T>;
  onLoaded: (seriesId: number, cover: T) => void;
  dispose?: (cover: T) => void;
}

/**
 * Share physical cover requests across refresh generations. A view can be
 * cancelled and replaced while a native transfer is still running; keeping
 * that transfer alive lets the replacement view consume its result instead of
 * starting a second transfer for the same series.
 */
export function createSharedCoverLoader<T>(
  load: (seriesId: number, signal: AbortSignal) => Promise<T>,
  concurrency = 6,
): SharedCoverLoader<T> {
  type Request = {
    controller: AbortController;
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  };
  const requests = new Map<number, Request>();
  const pending: Array<{ seriesId: number; request: Request }> = [];
  const maxConcurrency = Math.max(1, Math.floor(Number.isFinite(concurrency) ? concurrency : 1));
  let active = 0;

  function finish(seriesId: number, request: Request): void {
    if (requests.get(seriesId) === request) requests.delete(seriesId);
    active = Math.max(0, active - 1);
    pump();
  }

  function pump(): void {
    while (active < maxConcurrency && pending.length > 0) {
      const next = pending.shift();
      if (!next) return;
      const { seriesId, request } = next;
      if (request.controller.signal.aborted) {
        request.reject(new DOMException('Aborted', 'AbortError'));
        if (requests.get(seriesId) === request) requests.delete(seriesId);
        continue;
      }
      active += 1;
      void Promise.resolve()
        .then(() => {
          if (request.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
          return load(seriesId, request.controller.signal);
        })
        .then(request.resolve, request.reject)
        .finally(() => finish(seriesId, request));
    }
  }

  return {
    load(seriesId) {
      const existing = requests.get(seriesId);
      if (existing) return existing.promise;
      const controller = new AbortController();
      let resolve!: Request['resolve'];
      let reject!: Request['reject'];
      const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
      });
      const request = { controller, promise, resolve, reject };
      requests.set(seriesId, request);
      pending.push({ seriesId, request });
      pump();
      return promise;
    },
    async waitForIdle() {
      await Promise.allSettled([...requests.values()].map(({ promise }) => promise));
    },
    cancel() {
      for (const { controller, reject } of requests.values()) {
        controller.abort();
        reject(new DOMException('Aborted', 'AbortError'));
      }
      pending.length = 0;
    },
  };
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
  { signal, concurrency = 6, hasCover, load, onLoaded, dispose }: CoverLoaderOptions<T>,
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
        else dispose?.(cover);
      } catch {
        if (signal.aborted) return;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
