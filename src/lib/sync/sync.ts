import {
  confirmSync,
  getPendingSync,
  markSyncFailure,
  type PendingSyncItem,
} from '../database/database';
import { KavitaError, OFFLINE_KAVITA_MESSAGE, type KavitaClient } from '../kavita/client';
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

function isTransportStopped(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  return (
    error instanceof KavitaError &&
    error.kind === 'network' &&
    error.message === OFFLINE_KAVITA_MESSAGE
  );
}

async function run(client: KavitaClient, serverId: string, signal?: AbortSignal): Promise<void> {
  const failures: unknown[] = [];
  const attempted = new Map<string, PendingSyncItem>();
  let stopped = false;
  while (!stopped && !signal?.aborted) {
    const pending = (await getPendingSync(serverId)).filter((item) => {
      const previous = attempted.get(item.bookId);
      return previous?.revision !== item.revision || previous.updatedAt !== item.updatedAt;
    });
    if (pending.length === 0 || signal?.aborted) break;
    for (const item of pending) {
      if (signal?.aborted) {
        stopped = true;
        break;
      }
      attempted.set(item.bookId, item);
      try {
        const payload = JSON.parse(item.payload) as KavitaProgress;
        await client.saveProgress(payload);
      } catch (error) {
        if (isTransportStopped(error, signal)) {
          stopped = true;
          break;
        }
        await markSyncFailure(
          item.bookId,
          error instanceof Error ? error.message : 'Sync failed',
          item.revision,
          item.updatedAt,
        );
        failures.push(error);
        continue;
      }
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
