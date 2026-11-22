import {
  confirmSync,
  getPendingSync,
  markSyncFailure,
  type PendingSyncItem,
} from '../database/database';
import type { KavitaClient } from '../kavita/client';
import type { KavitaProgress } from '../kavita/types';

interface ActiveFlush {
  client: KavitaClient;
  controller: AbortController;
  promise: Promise<void>;
}

interface UnconfirmedUpload {
  revision: number;
  updatedAt: string;
  payload: string;
  serverUpdatedAt: string;
}

const flushing = new Map<string, ActiveFlush>();
const unconfirmedUploads = new Map<string, UnconfirmedUpload>();

function unconfirmedKeyFor(serverId: string, bookId: string): string {
  return `${serverId}\0${bookId}`;
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {});
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export function cancelProgressFlush(serverId?: string): void {
  if (serverId !== undefined) {
    flushing.get(serverId)?.controller.abort();
    return;
  }
  for (const active of flushing.values()) {
    active.controller.abort();
  }
}

export function flushProgress(
  client: KavitaClient,
  serverId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  const existing = flushing.get(serverId);
  if (existing && existing.client === client && !existing.controller.signal.aborted) {
    if (signal) {
      const onAbort = () => existing.controller.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      void existing.promise.finally(() => signal.removeEventListener('abort', onAbort));
    }
    return existing.promise;
  }
  existing?.controller.abort();
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  signal?.addEventListener('abort', onCallerAbort, { once: true });

  const entry: ActiveFlush = {
    client,
    controller,
    promise: Promise.resolve(),
  };
  const current = (async () => {
    if (existing) {
      await existing.promise.catch(() => {});
    }
    if (controller.signal.aborted) return;
    await run(client, serverId, controller.signal);
  })().finally(() => {
    signal?.removeEventListener('abort', onCallerAbort);
    if (flushing.get(serverId) === entry) flushing.delete(serverId);
  });
  entry.promise = current;
  flushing.set(serverId, entry);
  return current;
}

async function run(client: KavitaClient, serverId: string, signal: AbortSignal): Promise<void> {
  const failures = new Map<string, unknown>();
  const attempted = new Map<string, PendingSyncItem>();
  while (!signal.aborted) {
    const pending = (await getPendingSync(serverId)).filter((item) => {
      const previous = attempted.get(item.bookId);
      return previous?.revision !== item.revision || previous.updatedAt !== item.updatedAt;
    });
    if (signal.aborted || pending.length === 0) break;
    for (const item of pending) {
      if (signal.aborted) break;
      attempted.set(item.bookId, item);
      const unconfirmedKey = unconfirmedKeyFor(serverId, item.bookId);
      const cached = unconfirmedUploads.get(unconfirmedKey);
      const hasMatchingUpload =
        cached !== undefined &&
        cached.revision === item.revision &&
        cached.updatedAt === item.updatedAt &&
        cached.payload === item.payload;
      if (cached && !hasMatchingUpload) {
        unconfirmedUploads.delete(unconfirmedKey);
      }

      let serverUpdatedAt = hasMatchingUpload ? cached.serverUpdatedAt : undefined;
      if (!serverUpdatedAt) {
        try {
          const payload = JSON.parse(item.payload) as KavitaProgress;
          await awaitWithAbort(client.saveProgress(payload, signal), signal);
          if (signal.aborted) break;
          serverUpdatedAt = new Date().toISOString();
          unconfirmedUploads.set(unconfirmedKey, {
            revision: item.revision,
            updatedAt: item.updatedAt,
            payload: item.payload,
            serverUpdatedAt,
          });
        } catch (uploadError) {
          if (signal.aborted) break;
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
      }

      try {
        await confirmSync(item.bookId, serverUpdatedAt, item.revision, item.updatedAt);
        unconfirmedUploads.delete(unconfirmedKey);
        failures.delete(item.bookId);
      } catch (confirmError) {
        failures.set(item.bookId, confirmError);
      }
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
