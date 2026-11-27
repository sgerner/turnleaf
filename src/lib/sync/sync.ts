import {
  confirmSync,
  getPendingSync,
  markSyncFailure,
  type PendingSyncItem,
} from '../database/database';
import type { KavitaClient } from '../kavita/client';
import type { KavitaProgress } from '../kavita/types';

const flushing = new Map<string, Promise<void>>();

export function flushProgress(
  client: KavitaClient,
  serverId: string,
  canSync: () => boolean | Promise<boolean> = () => true,
  signal?: AbortSignal,
): Promise<void> {
  const pending = flushing.get(serverId);
  if (pending) return pending;
  const current = run(client, serverId, canSync, signal).finally(() => {
    if (flushing.get(serverId) === current) flushing.delete(serverId);
  });
  flushing.set(serverId, current);
  return current;
}

function checkCanSync(
  canSync: () => boolean | Promise<boolean>,
  signal?: AbortSignal,
): boolean | Promise<boolean> {
  if (signal?.aborted) return false;
  const allowed = canSync();
  if (allowed instanceof Promise) {
    return allowed.then((value) => value && !signal?.aborted);
  }
  return allowed;
}

function finishWithFailures(failures: unknown[]): void {
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} reading progress item${failures.length === 1 ? '' : 's'} failed to sync.`,
    );
  }
}

async function run(
  client: KavitaClient,
  serverId: string,
  canSync: () => boolean | Promise<boolean>,
  signal?: AbortSignal,
): Promise<void> {
  const failures: unknown[] = [];
  const attempted = new Map<string, PendingSyncItem>();
  while (true) {
    const allowedBeforeRead = checkCanSync(canSync, signal);
    if (allowedBeforeRead instanceof Promise ? !(await allowedBeforeRead) : !allowedBeforeRead) {
      break;
    }
    const pending = (await getPendingSync(serverId)).filter((item) => {
      const previous = attempted.get(item.bookId);
      return previous?.revision !== item.revision || previous.updatedAt !== item.updatedAt;
    });
    if (pending.length === 0) break;
    for (const item of pending) {
      const allowedBeforeSend = checkCanSync(canSync, signal);
      if (allowedBeforeSend instanceof Promise ? !(await allowedBeforeSend) : !allowedBeforeSend) {
        return finishWithFailures(failures);
      }
      attempted.set(item.bookId, item);
      try {
        const payload = JSON.parse(item.payload) as KavitaProgress;
        await (signal ? client.saveProgress(payload, signal) : client.saveProgress(payload));
      } catch (error) {
        const allowedAfterError = checkCanSync(canSync, signal);
        if (
          allowedAfterError instanceof Promise ? !(await allowedAfterError) : !allowedAfterError
        ) {
          return finishWithFailures(failures);
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
      if (signal?.aborted) return finishWithFailures(failures);
      await confirmSync(item.bookId, new Date().toISOString(), item.revision, item.updatedAt);
    }
  }
  finishWithFailures(failures);
}
