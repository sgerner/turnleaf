import {
  confirmSync,
  getDatabaseEpoch,
  getPendingSync,
  markSyncFailure,
  type PendingSyncItem,
} from '../database/database';
import type { KavitaClient } from '../kavita/client';
import type { KavitaProgress } from '../kavita/types';

const flushing = new Map<string, { epoch: number; promise: Promise<void> }>();

export function flushProgress(client: KavitaClient, serverId: string): Promise<void> {
  const startEpoch = getDatabaseEpoch();
  const pending = flushing.get(serverId);
  if (pending && pending.epoch === startEpoch) return pending.promise;
  const promise = run(client, serverId, startEpoch).finally(() => {
    if (flushing.get(serverId)?.promise === promise) flushing.delete(serverId);
  });
  flushing.set(serverId, { epoch: startEpoch, promise });
  return promise;
}

async function run(client: KavitaClient, serverId: string, startEpoch: number): Promise<void> {
  const failures: unknown[] = [];
  const attempted = new Map<string, PendingSyncItem>();
  while (getDatabaseEpoch() === startEpoch) {
    const pending = (await getPendingSync(serverId)).filter((item) => {
      const previous = attempted.get(item.bookId);
      return previous?.revision !== item.revision || previous.updatedAt !== item.updatedAt;
    });
    if (pending.length === 0 || getDatabaseEpoch() !== startEpoch) break;
    for (const item of pending) {
      if (getDatabaseEpoch() !== startEpoch) break;
      attempted.set(item.bookId, item);
      try {
        const progress = JSON.parse(item.payload) as KavitaProgress;
        await client.saveProgress(progress);
        if (getDatabaseEpoch() !== startEpoch) break;
        await confirmSync(item.bookId, new Date().toISOString(), item.revision, item.updatedAt, {
          pageNum: progress.pageNum,
          bookScrollId: progress.bookScrollId ?? null,
        });
      } catch (error) {
        if (getDatabaseEpoch() !== startEpoch) break;
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
