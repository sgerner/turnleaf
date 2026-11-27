import {
  confirmSync,
  getPendingSync,
  markSyncFailure,
  type PendingSyncItem,
} from '../database/database';
import type { KavitaClient } from '../kavita/client';
import type { KavitaProgress } from '../kavita/types';

export interface FlushProgressOptions {
  signal?: AbortSignal | undefined;
  canUpload?: ((signal?: AbortSignal) => Promise<boolean> | boolean) | undefined;
}

const flushing = new Map<string, Promise<void>>();

export function flushProgress(
  client: KavitaClient,
  serverId: string,
  options: FlushProgressOptions = {},
): Promise<void> {
  const pending = flushing.get(serverId);
  if (pending) return pending;
  const current = run(client, serverId, options).finally(() => {
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

function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
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

async function run(
  client: KavitaClient,
  serverId: string,
  options: FlushProgressOptions,
): Promise<void> {
  const { signal, canUpload } = options;
  const failures: unknown[] = [];
  const attempted = new Map<string, PendingSyncItem>();
  cancelled: while (!signal?.aborted) {
    const pending = (await getPendingSync(serverId)).filter((item) => {
      const previous = attempted.get(item.bookId);
      return previous?.revision !== item.revision || previous.updatedAt !== item.updatedAt;
    });
    if (pending.length === 0) break;
    for (const item of pending) {
      if (signal?.aborted) break cancelled;
      if (canUpload && !(await canUpload(signal))) break cancelled;
      if (signal?.aborted) break cancelled;
      attempted.set(item.bookId, item);
      try {
        const progress = JSON.parse(item.payload) as KavitaProgress;
        if (signal) {
          await waitForAbort(client.saveProgress(progress, signal), signal);
        } else {
          await client.saveProgress(progress);
        }
        await confirmSync(item.bookId, new Date().toISOString(), item.revision, item.updatedAt);
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          break cancelled;
        }
        if (canUpload && !(await canUpload(signal))) {
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
