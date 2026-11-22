import { saveLocalProgress, type BookRecord } from '../database/database';
import type { ReaderLocation } from '../reader/session';

export type LocalProgressWriter = (book: BookRecord, location: ReaderLocation) => Promise<void>;

interface BufferedProgressEntry {
  book: BookRecord;
  location: ReaderLocation;
  version: number;
  lastError?: unknown;
}

export interface LocalProgressBuffer {
  queue: (book: BookRecord, location: ReaderLocation) => Promise<void>;
  flush: () => Promise<void>;
  clear: (bookId?: string) => void;
  hasPending: (bookId: string) => boolean;
}

function defaultWriteLocalProgress(book: BookRecord, location: ReaderLocation): Promise<void> {
  return saveLocalProgress(
    book,
    location.cfi,
    location.xpath,
    location.percentage,
    location.spineIndex,
  );
}

export function createLocalProgressBuffer(
  write: LocalProgressWriter = defaultWriteLocalProgress,
): LocalProgressBuffer {
  const pending = new Map<string, BufferedProgressEntry>();
  let nextVersion = 0;
  let activeDrain: Promise<void> | null = null;

  async function drain(): Promise<void> {
    const attempted = new Map<string, number>();
    while (true) {
      const candidates = [...pending.values()].filter(
        (entry) => attempted.get(entry.book.id) !== entry.version,
      );
      if (candidates.length === 0) break;

      for (const candidate of candidates) {
        const current = pending.get(candidate.book.id);
        if (!current || attempted.get(current.book.id) === current.version) continue;
        attempted.set(current.book.id, current.version);
        try {
          await write(current.book, current.location);
          if (pending.get(current.book.id)?.version === current.version) {
            pending.delete(current.book.id);
          }
        } catch (error) {
          const latest = pending.get(current.book.id);
          if (latest?.version === current.version) {
            latest.lastError = error;
          }
        }
      }
    }

    const failures: unknown[] = [];
    for (const entry of pending.values()) {
      if (entry.lastError !== undefined) {
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

    clear(bookId?: string): void {
      if (bookId === undefined) {
        pending.clear();
        return;
      }
      pending.delete(bookId);
    },

    hasPending(bookId: string): boolean {
      return pending.has(bookId);
    },
  };
}
