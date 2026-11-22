import {
  confirmSync,
  getPendingSync,
  getReadingState,
  markSyncFailure,
  type PendingSyncItem,
} from '../database/database';
import type { KavitaClient } from '../kavita/client';
import type { KavitaProgress } from '../kavita/types';
import { bodyContentSteps, parseKavitaXPath } from '../reader/kavita-xpath';

const flushing = new Map<string, Promise<void>>();

export function flushProgress(client: KavitaClient, serverId: string): Promise<void> {
  const pending = flushing.get(serverId);
  if (pending) return pending;
  const current = run(client, serverId).finally(() => {
    if (flushing.get(serverId) === current) flushing.delete(serverId);
  });
  flushing.set(serverId, current);
  return current;
}

function isNonZeroChapterZeroProgress(
  payload: KavitaProgress,
  percentage: number | undefined,
): boolean {
  if (typeof percentage === 'number' && Number.isFinite(percentage) && percentage > 0) {
    return true;
  }
  const scrollId = payload.bookScrollId?.trim();
  if (!scrollId) return false;
  const target = parseKavitaXPath(scrollId, 0);
  if (!target) return scrollId.toLowerCase() !== '//body';
  if (target.contentXPath.startsWith('id(')) return true;
  const steps = bodyContentSteps(target.contentXPath);
  return Boolean(steps?.some((step) => step.index > 1));
}

function isUnstartedRemoteProgress(remote: KavitaProgress): boolean {
  return remote.pageNum <= 0 && !remote.bookScrollId?.trim();
}

async function saveProgressWithBootstrap(
  client: KavitaClient,
  bookId: string,
  payload: KavitaProgress,
): Promise<void> {
  if (payload.pageNum === 0) {
    const readingState = await getReadingState(bookId);
    if (isNonZeroChapterZeroProgress(payload, readingState?.percentage)) {
      const needsBootstrap =
        typeof client.getProgress === 'function'
          ? isUnstartedRemoteProgress(await client.getProgress(payload.chapterId))
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
  await client.saveProgress(payload);
}

async function run(client: KavitaClient, serverId: string): Promise<void> {
  const failures: unknown[] = [];
  const attempted = new Map<string, PendingSyncItem>();
  while (true) {
    const pending = (await getPendingSync(serverId)).filter((item) => {
      const previous = attempted.get(item.bookId);
      return previous?.revision !== item.revision || previous.updatedAt !== item.updatedAt;
    });
    if (pending.length === 0) break;
    for (const item of pending) {
      attempted.set(item.bookId, item);
      try {
        await saveProgressWithBootstrap(
          client,
          item.bookId,
          JSON.parse(item.payload) as KavitaProgress,
        );
        await confirmSync(item.bookId, new Date().toISOString(), item.revision, item.updatedAt);
      } catch (error) {
        await markSyncFailure(
          item.bookId,
          error instanceof Error ? error.message : 'Sync failed',
          item.revision,
          item.updatedAt,
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
