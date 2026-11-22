export interface CoverLoadItem<K = number> {
  seriesId: number;
  chapterId?: number;
  key?: K;
}

export interface SharedCoverLoader<T, K = number> {
  load: (key: K) => Promise<T>;
  waitForIdle: () => Promise<void>;
  cancel: () => void;
  retain: (keys: ReadonlySet<K>) => void;
}

export interface CoverLoaderOptions<T, K = number> {
  signal: AbortSignal;
  concurrency?: number;
  hasCover?: (key: K) => boolean;
  load: (key: K, signal: AbortSignal) => Promise<T>;
  onLoaded: (key: K, cover: T) => void;
  dispose?: (cover: T) => void;
}

/**
 * Share physical cover requests across refresh generations. A view can be
 * cancelled and replaced while a native transfer is still running; keeping
 * that transfer alive lets the replacement view consume its result instead of
 * starting a second transfer for the same cover key.
 */
export function createSharedCoverLoader<T, K = number>(
  load: (key: K, signal: AbortSignal) => Promise<T>,
  concurrency = 6,
): SharedCoverLoader<T, K> {
  type Request = {
    controller: AbortController;
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  };
  const requests = new Map<K, Request>();
  const pending: Array<{ key: K; request: Request }> = [];
  const maxConcurrency = Math.max(1, Math.floor(Number.isFinite(concurrency) ? concurrency : 1));
  let active = 0;

  function finish(key: K, request: Request): void {
    if (requests.get(key) === request) requests.delete(key);
    active = Math.max(0, active - 1);
    pump();
  }

  function pump(): void {
    while (active < maxConcurrency && pending.length > 0) {
      const next = pending.shift();
      if (!next) return;
      const { key, request } = next;
      if (request.controller.signal.aborted) {
        request.reject(new DOMException('Aborted', 'AbortError'));
        if (requests.get(key) === request) requests.delete(key);
        continue;
      }
      active += 1;
      void Promise.resolve()
        .then(() => {
          if (request.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
          return load(key, request.controller.signal);
        })
        .then(request.resolve, request.reject)
        .finally(() => finish(key, request));
    }
  }

  return {
    load(key) {
      const existing = requests.get(key);
      if (existing) return existing.promise;
      const controller = new AbortController();
      let resolve!: Request['resolve'];
      let reject!: Request['reject'];
      const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
      });
      const request = { controller, promise, resolve, reject };
      requests.set(key, request);
      pending.push({ key, request });
      pump();
      return promise;
    },
    async waitForIdle() {
      await Promise.allSettled([...requests.values()].map(({ promise }) => promise));
    },
    cancel() {
      const queuedRequests = new Set(pending.map(({ request }) => request));
      for (const [key, request] of requests) {
        const { controller, reject } = request;
        controller.abort();
        reject(new DOMException('Aborted', 'AbortError'));
        if (queuedRequests.has(request) && requests.get(key) === request) {
          requests.delete(key);
        }
      }
      pending.length = 0;
    },
    retain(keys) {
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const queued = pending[index];
        if (!queued || keys.has(queued.key)) continue;
        queued.request.controller.abort();
        queued.request.reject(new DOMException('Aborted', 'AbortError'));
        if (requests.get(queued.key) === queued.request) requests.delete(queued.key);
        pending.splice(index, 1);
      }
    },
  };
}

/**
 * Keep offscreen decoded cover URLs bounded so per-book chapter covers cannot
 * grow unbounded across large virtualized libraries.
 */
export function evictOffscreenCovers<K, V>(
  covers: Map<K, V>,
  visibleKeys: ReadonlySet<K>,
  offscreenLimit: number,
  dispose?: (cover: V, key: K) => void,
): void {
  const safeLimit = Math.max(0, Math.floor(Number.isFinite(offscreenLimit) ? offscreenLimit : 0));
  const offscreen = [...covers.keys()].filter((key) => !visibleKeys.has(key));
  const evictCount = Math.max(0, offscreen.length - safeLimit);
  for (const key of offscreen.slice(0, evictCount)) {
    const cover = covers.get(key);
    if (cover !== undefined) dispose?.(cover, key);
    covers.delete(key);
  }
}

/**
 * Load a set of covers with a small worker pool.
 *
 * The caller owns the signal and can cancel the whole batch when its view is
 * torn down or replaced. Individual failures are ignored because covers are
 * decorative and should not prevent the library metadata from rendering.
 */
export async function loadCoversWithConcurrency<T, K = number>(
  items: readonly CoverLoadItem<K>[],
  { signal, concurrency = 6, hasCover, load, onLoaded, dispose }: CoverLoaderOptions<T, K>,
): Promise<void> {
  const keys = [
    ...new Set(
      items
        .map((item) => (item.key !== undefined ? item.key : (item.seriesId as unknown as K)))
        .filter((key) => !hasCover?.(key)),
    ),
  ];
  if (signal.aborted || keys.length === 0) return;

  const requestedConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
  const workerCount = Math.min(Math.max(1, requestedConcurrency), keys.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (!signal.aborted) {
      if (nextIndex >= keys.length) return;
      const key = keys[nextIndex++]!;

      try {
        const cover = await load(key, signal);
        if (!signal.aborted) onLoaded(key, cover);
        else dispose?.(cover);
      } catch {
        if (signal.aborted) return;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
