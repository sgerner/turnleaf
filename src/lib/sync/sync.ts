import {
  confirmSync,
  getPendingSync,
  markSyncFailure,
  type PendingSyncItem,
} from '../database/database';
import type { KavitaClient } from '../kavita/client';
import type { KavitaProgress } from '../kavita/types';

const flushing = new Map<string, Promise<void>>();

export function flushProgress(
  client: KavitaClient,
  serverId: string,
  canSync: () => boolean | Promise<boolean> = () => true,
  signal?: AbortSignal,
): Promise<void> {
  const pending = flushing.get(serverId);
  if (pending) return pending;
  const current = run(client, serverId, canSync, signal).finally(() => {
    if (flushing.get(serverId) === current) flushing.delete(serverId);
  });
  flushing.set(serverId, current);
  return current;
}

async function isSyncInterrupted(
  canSync: () => boolean | Promise<boolean>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return true;
  const allowed = await canSync();
  return !allowed || Boolean(signal?.aborted);
}

async function run(
  client: KavitaClient,
  serverId: string,
  canSync: () => boolean | Promise<boolean>,
  signal?: AbortSignal,
): Promise<void> {
  const failures: unknown[] = [];
  const attempted = new Map<string, PendingSyncItem>();
  while (true) {
    if (await isSyncInterrupted(canSync, signal)) break;
    const pending = (await getPendingSync(serverId)).filter((item) => {
      const previous = attempted.get(item.bookId);
      return previous?.revision !== item.revision || previous.updatedAt !== item.updatedAt;
    });
    if (pending.length === 0 || (await isSyncInterrupted(canSync, signal))) break;
    for (const item of pending) {
      if (await isSyncInterrupted(canSync, signal)) break;
      attempted.set(item.bookId, item);
      try {
        const payload = JSON.parse(item.payload) as KavitaProgress;
        await (signal ? client.saveProgress(payload, signal) : client.saveProgress(payload));
      } catch (error) {
        if (await isSyncInterrupted(canSync, signal)) break;
        await markSyncFailure(
          item.bookId,
          error instanceof Error ? error.message : 'Sync failed',
          item.revision,
          item.updatedAt,
        );
        failures.push(error);
        continue;
      }
      if (signal?.aborted) break;
      await confirmSync(item.bookId, new Date().toISOString(), item.revision, item.updatedAt);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} reading progress item${failures.length === 1 ? '' : 's'} failed to sync.`,
    );
  }
}
