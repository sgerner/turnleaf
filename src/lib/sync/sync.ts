import {
  confirmSync,
  getBooks,
  getPendingSync,
  getReadingState,
  getSyncGeneration,
  markSyncFailure,
  type PendingSyncItem,
} from '../database/database';
import type { KavitaClient } from '../kavita/client';
import type { KavitaProgress } from '../kavita/types';
import { bodyContentSteps, parseKavitaXPath } from '../reader/kavita-xpath';

const flushing = new Map<string, { generation: number; promise: Promise<void> }>();

export function flushProgress(client: KavitaClient, serverId: string): Promise<void> {
  const generation = getSyncGeneration();
  const existing = flushing.get(serverId);
  if (existing && existing.generation === generation) return existing.promise;
  const promise = run(client, serverId, generation).finally(() => {
    if (flushing.get(serverId)?.promise === promise) flushing.delete(serverId);
  });
  flushing.set(serverId, { generation, promise });
  return promise;
}

function isNonZeroChapterZeroProgress(
  payload: KavitaProgress,
  percentage: number | undefined,
): boolean {
  if (typeof percentage === 'number' && Number.isFinite(percentage) && percentage > 0) return true;
  const scrollId = payload.bookScrollId?.trim();
  if (!scrollId) return false;
  const target = parseKavitaXPath(scrollId, 0);
  if (!target) return scrollId.toLowerCase() !== '//body';
  return (
    target.contentXPath.startsWith('id(') ||
    Boolean(bodyContentSteps(target.contentXPath)?.some((step) => step.index > 1))
  );
}

async function saveProgressWithBootstrap(
  client: KavitaClient,
  serverId: string,
  bookId: string,
  payload: KavitaProgress,
): Promise<void> {
  if (payload.pageNum === 0) {
    const readingState = await getReadingState(bookId);
    if (isNonZeroChapterZeroProgress(payload, readingState?.percentage)) {
      const books = await getBooks(serverId, { includeDescription: false }).catch(() => []);
      const bookPages = books.find((book) => book.id === bookId)?.pages;
      // Never bootstrap single-spine EPUBs (pages === 1) with pageNum = 1,
      // which Kavita treats as explicit book completion (pageNum >= pages).
      if (bookPages === undefined || bookPages > 1) {
        const needsBootstrap =
          typeof client.getProgress === 'function'
            ? await client
                .getProgress(payload.chapterId)
                .then((remote) => remote.pageNum <= 0 && !remote.bookScrollId?.trim())
            : !readingState?.serverUpdatedAt;
        if (needsBootstrap) {
          await client.saveProgress({
            libraryId: payload.libraryId,
            seriesId: payload.seriesId,
            volumeId: payload.volumeId,
            chapterId: payload.chapterId,
            pageNum: 1,
            bookScrollId: null,
          });
        }
      }
    }
  }
  await client.saveProgress(payload);
}

async function run(client: KavitaClient, serverId: string, generation: number): Promise<void> {
  const failures: unknown[] = [];
  const attempted = new Map<string, PendingSyncItem>();

  while (getSyncGeneration() === generation) {
    const pending = (await getPendingSync(serverId)).filter((item) => {
      const previous = attempted.get(item.bookId);
      return !previous || previous.revision !== item.revision;
    });
    if (pending.length === 0 || getSyncGeneration() !== generation) break;

    for (const item of pending) {
      if (getSyncGeneration() !== generation) break;
      attempted.set(item.bookId, item);
      try {
        await saveProgressWithBootstrap(
          client,
          serverId,
          item.bookId,
          JSON.parse(item.payload) as KavitaProgress,
        );
        await confirmSync(
          item.bookId,
          new Date().toISOString(),
          item.revision,
          item.updatedAt,
          generation,
        );
      } catch (error) {
        await markSyncFailure(
          item.bookId,
          error instanceof Error ? error.message : String(error),
          item.revision,
          item.updatedAt,
          generation,
        );
        failures.push(error);
      }
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} reading progress item${failures.length === 1 ? '' : 's'} failed to sync.`,
    );
  }
}
