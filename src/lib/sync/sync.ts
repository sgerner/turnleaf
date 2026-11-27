import {
  confirmSync,
  getPendingSync,
  markSyncFailure,
  type PendingSyncItem,
} from '../database/database';
import { KavitaError, OFFLINE_NETWORK_MESSAGE, type KavitaClient } from '../kavita/client';
import type { KavitaProgress } from '../kavita/types';

interface ActiveFlush {
  promise: Promise<void>;
  signal: AbortSignal | undefined;
}

const flushing = new Map<string, ActiveFlush>();

function isOfflineStop(error: unknown, signal?: AbortSignal): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (!(error instanceof KavitaError) || error.kind !== 'network') return false;
  return Boolean(signal?.aborted) || error.message === OFFLINE_NETWORK_MESSAGE;
}

export function flushProgress(
  client: KavitaClient,
  serverId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  const existing = flushing.get(serverId);
  if (existing) {
    if (existing.signal?.aborted) {
      return existing.promise.then(
        () => flushProgress(client, serverId, signal),
        () => flushProgress(client, serverId, signal),
      );
    }
    return existing.promise;
  }
  const active: ActiveFlush = { promise: Promise.resolve(), signal };
  const current = run(client, serverId, signal).finally(() => {
    if (flushing.get(serverId) === active) flushing.delete(serverId);
  });
  active.promise = current;
  flushing.set(serverId, active);
  return current;
}

async function run(client: KavitaClient, serverId: string, signal?: AbortSignal): Promise<void> {
  const failures: unknown[] = [];
  const attempted = new Map<string, PendingSyncItem>();
  outer: while (!signal?.aborted) {
    const pending = (await getPendingSync(serverId)).filter((item) => {
      const previous = attempted.get(item.bookId);
      return previous?.revision !== item.revision || previous.updatedAt !== item.updatedAt;
    });
    if (signal?.aborted || pending.length === 0) break;
    for (const item of pending) {
      if (signal?.aborted) break outer;
      attempted.set(item.bookId, item);
      try {
        await client.saveProgress(JSON.parse(item.payload) as KavitaProgress);
        await confirmSync(item.bookId, new Date().toISOString(), item.revision, item.updatedAt);
      } catch (error) {
        if (isOfflineStop(error, signal)) break outer;
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
