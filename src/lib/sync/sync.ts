import { confirmSync, getPendingSync, markSyncFailure } from '../database/database';
import type { KavitaClient } from '../kavita/client';
import type { KavitaProgress } from '../kavita/types';

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

async function run(client: KavitaClient, serverId: string): Promise<void> {
  const failures: unknown[] = [];
  for (const item of await getPendingSync(serverId)) {
    try {
      await client.saveProgress(JSON.parse(item.payload) as KavitaProgress);
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
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} reading progress item${failures.length === 1 ? '' : 's'} failed to sync.`,
    );
  }
}
