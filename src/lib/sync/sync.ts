import {
  confirmSync,
  getPendingSync,
  markSyncFailure,
  type PendingSyncItem,
} from '../database/database';
import type { KavitaClient } from '../kavita/client';
import type { KavitaProgress } from '../kavita/types';

const flushing = new Map<string, Promise<void>>();

export type SyncAvailabilityCheck = () => boolean | Promise<boolean>;

export function flushProgress(
  client: KavitaClient,
  serverId: string,
  canSync?: SyncAvailabilityCheck,
): Promise<void> {
  const pending = flushing.get(serverId);
  if (pending) return pending;
  const current = run(client, serverId, canSync).finally(() => {
    if (flushing.get(serverId) === current) flushing.delete(serverId);
  });
  flushing.set(serverId, current);
  return current;
}

async function run(
  client: KavitaClient,
  serverId: string,
  canSync?: SyncAvailabilityCheck,
): Promise<void> {
  const failures: unknown[] = [];
  const attempted = new Map<string, PendingSyncItem>();
  while (true) {
    if (canSync) {
      const allowed = canSync();
      if (allowed instanceof Promise ? !(await allowed) : !allowed) break;
    }
    const pending = (await getPendingSync(serverId)).filter((item) => {
      const previous = attempted.get(item.bookId);
      return previous?.revision !== item.revision || previous.updatedAt !== item.updatedAt;
    });
    if (pending.length === 0) break;
    for (const item of pending) {
      if (canSync) {
        const allowed = canSync();
        if (allowed instanceof Promise ? !(await allowed) : !allowed) {
          throwIfFailed(failures);
          return;
        }
      }
      attempted.set(item.bookId, item);
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
  }
  throwIfFailed(failures);
}

function throwIfFailed(failures: unknown[]): void {
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} reading progress item${failures.length === 1 ? '' : 's'} failed to sync.`,
    );
  }
}
