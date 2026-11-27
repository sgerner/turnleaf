import {
  confirmSync,
  getPendingSync,
  markSyncFailure,
  type PendingSyncItem,
} from '../database/database';
import { KavitaError, type KavitaClient } from '../kavita/client';
import type { KavitaProgress } from '../kavita/types';

interface ActiveFlush {
  promise: Promise<void>;
  signal: AbortSignal | undefined;
}

const flushing = new Map<string, ActiveFlush>();

function isTransportAbort(signal: AbortSignal | undefined, error: unknown): boolean {
  if (signal?.aborted) return true;
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  return (
    error instanceof KavitaError &&
    error.kind === 'network' &&
    error.message === 'Kavita could not be reached while offline.'
  );
}

export function flushProgress(
  client: KavitaClient,
  serverId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  const active = flushing.get(serverId);
  if (active) {
    if (active.signal?.aborted) {
      return active.promise.then(() => flushProgress(client, serverId, signal));
    }
    return active.promise;
  }
  const entry: ActiveFlush = { promise: Promise.resolve(), signal };
  entry.promise = run(client, serverId, signal).finally(() => {
    if (flushing.get(serverId) === entry) flushing.delete(serverId);
  });
  flushing.set(serverId, entry);
  return entry.promise;
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
        await client.saveProgress(JSON.parse(item.payload) as KavitaProgress);
        await confirmSync(item.bookId, new Date().toISOString(), item.revision, item.updatedAt);
      } catch (error) {
        if (isTransportAbort(signal, error)) {
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
