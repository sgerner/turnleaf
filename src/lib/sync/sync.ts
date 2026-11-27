import {
  confirmSync,
  getPendingSync,
  markSyncFailure,
  type PendingSyncItem,
} from '../database/database';
import { KavitaError, type KavitaClient } from '../kavita/client';
import type { KavitaProgress } from '../kavita/types';

const flushing = new Map<string, Promise<void>>();

function canClientSend(client: KavitaClient): boolean {
  return typeof client.canSendRequests !== 'function' || client.canSendRequests();
}

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

async function run(client: KavitaClient, serverId: string, signal?: AbortSignal): Promise<void> {
  const failures: unknown[] = [];
  const attempted = new Map<string, PendingSyncItem>();
  while (true) {
    if (signal?.aborted || !canClientSend(client)) break;
    const pending = (await getPendingSync(serverId)).filter((item) => {
      const previous = attempted.get(item.bookId);
      return previous?.revision !== item.revision || previous.updatedAt !== item.updatedAt;
    });
    if (pending.length === 0 || signal?.aborted || !canClientSend(client)) break;
    let stopFlush = false;
    for (const item of pending) {
      if (signal?.aborted || !canClientSend(client)) {
        stopFlush = true;
        break;
      }
      attempted.set(item.bookId, item);
      try {
        const payload = JSON.parse(item.payload) as KavitaProgress;
        await client.saveProgress(payload);
        await confirmSync(item.bookId, new Date().toISOString(), item.revision, item.updatedAt);
      } catch (error) {
        const stoppedBeforeDispatch =
          signal?.aborted === true ||
          (error instanceof DOMException && error.name === 'AbortError') ||
          (error instanceof KavitaError &&
            error.kind === 'network' &&
            error.message === 'Kavita could not be reached while offline.') ||
          (error instanceof KavitaError &&
            error.kind === 'authentication' &&
            error.status === undefined &&
            !canClientSend(client));
        if (stoppedBeforeDispatch) {
          stopFlush = true;
          break;
        }
        await markSyncFailure(
          item.bookId,
          error instanceof Error ? error.message : 'Sync failed',
          item.revision,
          item.updatedAt,
        );
        failures.push(error);
        if (
          error instanceof KavitaError &&
          (error.kind === 'authentication' || error.kind === 'network')
        ) {
          stopFlush = true;
          break;
        }
      }
    }
    if (stopFlush) break;
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} reading progress item${failures.length === 1 ? '' : 's'} failed to sync.`,
    );
  }
}
