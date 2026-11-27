import {
  confirmSync,
  getPendingSync,
  markSyncFailure,
  type PendingSyncItem,
} from '../database/database';
import { KavitaError, type KavitaClient } from '../kavita/client';
import type { KavitaProgress } from '../kavita/types';

const flushing = new Map<string, Promise<void>>();

export function flushProgress(
  client: KavitaClient,
  serverId: string,
  signal?: AbortSignal,
): Promise<void> {
  const pending = flushing.get(serverId);
  if (pending) return pending;
  const current = run(client, serverId, signal).finally(() => {
    if (flushing.get(serverId) === current) flushing.delete(serverId);
  });
  flushing.set(serverId, current);
  return current;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

async function run(client: KavitaClient, serverId: string, signal?: AbortSignal): Promise<void> {
  const failures: unknown[] = [];
  const attempted = new Map<string, PendingSyncItem>();
  cancelled: while (!signal?.aborted) {
    const pending = (await getPendingSync(serverId)).filter((item) => {
      const previous = attempted.get(item.bookId);
      return previous?.revision !== item.revision || previous.updatedAt !== item.updatedAt;
    });
    if (pending.length === 0 || signal?.aborted) break;
    for (const item of pending) {
      if (signal?.aborted) break cancelled;
      attempted.set(item.bookId, item);
      try {
        await client.saveProgress(JSON.parse(item.payload) as KavitaProgress);
        await confirmSync(item.bookId, new Date().toISOString(), item.revision, item.updatedAt);
      } catch (error) {
        if (
          signal?.aborted ||
          isAbortError(error) ||
          (error instanceof KavitaError && error.transportDenied)
        ) {
          break cancelled;
        }
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
