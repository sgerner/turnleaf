import { saveLocalProgress, type BookRecord } from '../database/database';
import type { ReaderLocation } from '../reader/session';

export interface LocalProgressWriteContext {
  readonly signal: AbortSignal;
  isCurrent: () => boolean;
}

export type LocalProgressWriter = (
  book: BookRecord,
  location: ReaderLocation,
  context: LocalProgressWriteContext,
) => Promise<void>;

interface BufferedProgressEntry {
  book: BookRecord;
  location: ReaderLocation;
  version: number;
  lastError?: unknown;
}

export interface LocalProgressBuffer {
  queue: (book: BookRecord, location: ReaderLocation) => Promise<void>;
  flush: () => Promise<void>;
  clear: (bookId?: string) => Promise<void>;
  runAuthoritative: <T>(bookId: string | undefined, action: () => Promise<T>) => Promise<T>;
  hasPending: (bookId?: string) => boolean;
}

function defaultWriteLocalProgress(
  book: BookRecord,
  location: ReaderLocation,
  context: LocalProgressWriteContext,
): Promise<void> {
  if (!context.isCurrent()) return Promise.resolve();
  return saveLocalProgress(
    book,
    location.cfi,
    location.xpath,
    location.percentage,
    location.spineIndex,
    { shouldCommit: context.isCurrent },
  );
}

export function createLocalProgressBuffer(
  write: LocalProgressWriter = defaultWriteLocalProgress,
): LocalProgressBuffer {
  const pending = new Map<string, BufferedProgressEntry>();
  const clearedVersions = new Map<string, number>();
  let clearedAllVersion = 0;
  let nextVersion = 0;
  let activeDrain: Promise<void> | null = null;
  let inFlight: { bookId: string; version: number; controller: AbortController } | null = null;
  let exclusiveQueue: Promise<void> = Promise.resolve();

  function isInvalidated(bookId: string, version: number): boolean {
    return version <= clearedAllVersion || version <= (clearedVersions.get(bookId) ?? 0);
  }

  function invalidateSync(bookId?: string): void {
    const cutoff = nextVersion;
    if (bookId === undefined) {
      clearedAllVersion = cutoff;
      clearedVersions.clear();
      pending.clear();
      if (inFlight && inFlight.version <= cutoff) {
        inFlight.controller.abort();
      }
      return;
    }
    clearedVersions.set(bookId, cutoff);
    pending.delete(bookId);
    if (inFlight && inFlight.bookId === bookId && inFlight.version <= cutoff) {
      inFlight.controller.abort();
    }
  }

  function enqueueExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = exclusiveQueue.then(operation, operation);
    exclusiveQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function drain(): Promise<void> {
    const attempted = new Map<string, number>();
    while (true) {
      const candidates = [...pending.values()].filter(
        (entry) =>
          !isInvalidated(entry.book.id, entry.version) &&
          attempted.get(entry.book.id) !== entry.version,
      );
      if (candidates.length === 0) break;

      for (const candidate of candidates) {
        const queued = pending.get(candidate.book.id);
        if (
          !queued ||
          isInvalidated(queued.book.id, queued.version) ||
          attempted.get(queued.book.id) === queued.version
        ) {
          continue;
        }
        await enqueueExclusive(async () => {
          const current = pending.get(candidate.book.id);
          if (
            !current ||
            isInvalidated(current.book.id, current.version) ||
            attempted.get(current.book.id) === current.version
          ) {
            return;
          }
          attempted.set(current.book.id, current.version);
          const controller = new AbortController();
          const { version } = current;
          const bookId = current.book.id;
          const context: LocalProgressWriteContext = {
            signal: controller.signal,
            isCurrent: () => !isInvalidated(bookId, version) && !controller.signal.aborted,
          };
          inFlight = { bookId, version, controller };
          try {
            await write(current.book, current.location, context);
            if (!isInvalidated(bookId, version) && pending.get(bookId)?.version === version) {
              pending.delete(bookId);
            }
          } catch (error) {
            const latest = pending.get(bookId);
            if (!isInvalidated(bookId, version) && latest?.version === version) {
              latest.lastError = error;
            }
          } finally {
            if (inFlight?.controller === controller) {
              inFlight = null;
            }
          }
        });
      }
    }

    const failures: unknown[] = [];
    for (const entry of pending.values()) {
      if (!isInvalidated(entry.book.id, entry.version) && entry.lastError !== undefined) {
        failures.push(entry.lastError);
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `${failures.length} local reading positions could not be saved.`,
      );
    }
  }

  function startDrain(): Promise<void> {
    if (activeDrain) return activeDrain;
    if (pending.size === 0) return Promise.resolve();
    const current = drain().finally(() => {
      if (activeDrain === current) activeDrain = null;
    });
    activeDrain = current;
    return current;
  }

  return {
    queue(book: BookRecord, location: ReaderLocation): Promise<void> {
      pending.set(book.id, {
        book,
        location,
        version: ++nextVersion,
      });
      return startDrain();
    },

    flush(): Promise<void> {
      return startDrain();
    },

    clear(bookId?: string): Promise<void> {
      invalidateSync(bookId);
      return enqueueExclusive(async () => {});
    },

    runAuthoritative<T>(bookId: string | undefined, action: () => Promise<T>): Promise<T> {
      const savedPending = bookId !== undefined ? pending.get(bookId) : undefined;
      invalidateSync(bookId);
      return enqueueExclusive(async () => {
        invalidateSync(bookId);
        try {
          return await action();
        } catch (error) {
          if (bookId !== undefined && savedPending && !pending.has(bookId)) {
            pending.set(bookId, {
              book: savedPending.book,
              location: savedPending.location,
              version: ++nextVersion,
              lastError: savedPending.lastError ?? error,
            });
          }
          throw error;
        }
      });
    },

    hasPending(bookId?: string): boolean {
      if (bookId !== undefined) return pending.has(bookId);
      return pending.size > 0 || activeDrain !== null || inFlight !== null;
    },
  };
}
