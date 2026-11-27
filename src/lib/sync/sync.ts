import {
  confirmSync,
  getPendingSync,
  markSyncFailure,
  type PendingSyncItem,
} from '../database/database';
import { KavitaError, type KavitaClient } from '../kavita/client';
import type { KavitaProgress } from '../kavita/types';
import {
  clearUnconfirmedUploads,
  deleteUnconfirmedUpload,
  getUnconfirmedUpload,
  recordUnconfirmedUpload,
  UNCONFIRMED_SYNC_DIRECTORY,
  UNCONFIRMED_SYNC_FILE_PATH,
  UNCONFIRMED_SYNC_STORAGE_KEY,
} from './unconfirmed-uploads';

export {
  clearUnconfirmedUploads,
  UNCONFIRMED_SYNC_DIRECTORY,
  UNCONFIRMED_SYNC_FILE_PATH,
  UNCONFIRMED_SYNC_STORAGE_KEY,
};

interface ActiveFlush {
  client: KavitaClient;
  controller: AbortController;
  outcome: Promise<void>;
  settlement: Promise<void>;
  subscribers: Set<symbol>;
}

const flushing = new Map<string, ActiveFlush>();

function attachCaller(entry: ActiveFlush, signal?: AbortSignal): Promise<void> {
  const subscriber = Symbol('flush-caller');
  entry.subscribers.add(subscriber);
  if (!signal) {
    return entry.outcome.finally(() => {
      entry.subscribers.delete(subscriber);
    });
  }
  if (signal.aborted) {
    entry.subscribers.delete(subscriber);
    if (entry.subscribers.size === 0) entry.controller.abort();
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      entry.subscribers.delete(subscriber);
      // Caller-local cancellation: only abort the shared transport controller
      // when no other caller is still awaiting this flush.
      if (entry.subscribers.size === 0) {
        entry.controller.abort();
      }
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    entry.outcome.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        entry.subscribers.delete(subscriber);
        if (!settled) {
          settled = true;
          resolve();
        }
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        entry.subscribers.delete(subscriber);
        if (!settled) {
          settled = true;
          reject(error);
        }
      },
    );
  });
}

/**
 * Explicitly cancel the shared progress flush for `serverId` (or all servers),
 * such as on network disconnect, credential replacement, or Library teardown.
 */
export function cancelProgressFlush(serverId?: string): void {
  if (serverId !== undefined) {
    flushing.get(serverId)?.controller.abort();
    return;
  }
  for (const active of flushing.values()) {
    active.controller.abort();
  }
}

/**
 * Flush queued reading progress for `serverId`.
 *
 * Cancellation and recovery policy:
 * - Passing `signal` provides caller-local cancellation: aborting `signal`
 *   resolves that caller's returned promise immediately, and only aborts the
 *   underlying flush if no other callers remain subscribed to the shared run.
 * - `cancelProgressFlush` or supplying a new `KavitaClient` instance explicitly
 *   aborts the shared run, while keeping replacement uploads serialized behind
 *   the real transport settlement of any in-flight request.
 * - Server-accepted uploads are journaled to app-private storage before SQLite
 *   confirmation so a retry after `SQLITE_BUSY` or an app restart confirms
 *   locally without sending a duplicate `saveProgress` POST.
 */
export function flushProgress(
  client: KavitaClient,
  serverId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  const existing = flushing.get(serverId);
  if (existing && existing.client === client && !existing.controller.signal.aborted) {
    return attachCaller(existing, signal);
  }
  existing?.controller.abort();
  const controller = new AbortController();
  const subscribers = new Set<symbol>();

  const entry: ActiveFlush = {
    client,
    controller,
    outcome: Promise.resolve(),
    settlement: Promise.resolve(),
    subscribers,
  };
  const outcome = (async () => {
    if (existing) {
      await existing.settlement;
    }
    if (controller.signal.aborted) return;
    await run(client, serverId, controller.signal);
  })();
  const settlement = outcome.then(
    () => undefined,
    () => undefined,
  );
  void settlement.finally(() => {
    if (flushing.get(serverId) === entry) flushing.delete(serverId);
  });
  entry.outcome = outcome;
  entry.settlement = settlement;
  flushing.set(serverId, entry);
  return attachCaller(entry, signal);
}

async function run(client: KavitaClient, serverId: string, signal: AbortSignal): Promise<void> {
  const failures = new Map<string, unknown>();
  const attempted = new Map<string, PendingSyncItem>();
  let stoppedByTransport = false;
  while (!signal.aborted && !stoppedByTransport) {
    const pending = (await getPendingSync(serverId)).filter((item) => {
      const previous = attempted.get(item.bookId);
      return previous?.revision !== item.revision || previous.updatedAt !== item.updatedAt;
    });
    if (signal.aborted || pending.length === 0) break;
    for (const item of pending) {
      if (signal.aborted) break;
      const cachedOrPromise = getUnconfirmedUpload(serverId, item.bookId);
      const cached = cachedOrPromise instanceof Promise ? await cachedOrPromise : cachedOrPromise;
      const hasMatchingUpload =
        cached !== undefined &&
        cached.revision === item.revision &&
        cached.updatedAt === item.updatedAt &&
        cached.payload === item.payload;
      if (cached && !hasMatchingUpload) {
        await deleteUnconfirmedUpload(serverId, item.bookId);
      }

      let serverUpdatedAt = hasMatchingUpload ? cached.serverUpdatedAt : undefined;
      if (!serverUpdatedAt) {
        if (signal.aborted) break;
        attempted.set(item.bookId, item);
        try {
          const payload = JSON.parse(item.payload) as KavitaProgress;
          await client.saveProgress(payload, signal);
          // Even if `signal` aborted while a non-cancellable native POST was in
          // flight, resolving here means Kavita accepted the write: persist and
          // confirm this item before exiting on the next loop check.
          serverUpdatedAt = new Date().toISOString();
          await recordUnconfirmedUpload(serverId, item.bookId, {
            revision: item.revision,
            updatedAt: item.updatedAt,
            payload: item.payload,
            serverUpdatedAt,
          });
        } catch (uploadError) {
          if (signal.aborted) break;
          if (uploadError instanceof KavitaError && uploadError.transportDenied) {
            stoppedByTransport = true;
            break;
          }
          try {
            await markSyncFailure(
              item.bookId,
              uploadError instanceof Error ? uploadError.message : 'Sync failed',
              item.revision,
              item.updatedAt,
            );
          } catch {
            // Keep syncing remaining books even if SQLite cannot record this failure yet.
          }
          failures.set(item.bookId, uploadError);
          continue;
        }
      } else {
        attempted.set(item.bookId, item);
      }

      try {
        await confirmSync(item.bookId, serverUpdatedAt, item.revision, item.updatedAt);
        await deleteUnconfirmedUpload(serverId, item.bookId);
        failures.delete(item.bookId);
      } catch (confirmError) {
        failures.set(item.bookId, confirmError);
      }
      if (signal.aborted) break;
    }
  }
  if (signal.aborted) return;
  if (failures.size > 0) {
    const errors = [...failures.values()];
    throw new AggregateError(
      errors,
      `${errors.length} reading progress item${errors.length === 1 ? '' : 's'} failed to sync.`,
    );
  }
}
