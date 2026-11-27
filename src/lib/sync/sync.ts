import {
  confirmSync,
  getPendingSync,
  markSyncFailure,
  type PendingSyncItem,
} from '../database/database';
import type { KavitaClient } from '../kavita/client';
import type { KavitaProgress } from '../kavita/types';

const flushing = new Map<string, Promise<void>>();

export interface FlushProgressOptions {
  signal?: AbortSignal;
  canContinue?: () => boolean | Promise<boolean>;
}

export function flushProgress(
  client: KavitaClient,
  serverId: string,
  options?: FlushProgressOptions,
): Promise<void> {
  const pending = flushing.get(serverId);
  if (pending) return pending;
  const current = run(client, serverId, options).finally(() => {
    if (flushing.get(serverId) === current) flushing.delete(serverId);
  });
  flushing.set(serverId, current);
  return current;
}

async function run(
  client: KavitaClient,
  serverId: string,
  options?: FlushProgressOptions,
): Promise<void> {
  const failures: unknown[] = [];
  const attempted = new Map<string, PendingSyncItem>();
  while (true) {
    if (options?.signal?.aborted) break;
    if (options?.canContinue) {
      const allowed = options.canContinue();
      if (!(typeof allowed === 'boolean' ? allowed : await allowed)) break;
    }
    const pending = (await getPendingSync(serverId)).filter((item) => {
      const previous = attempted.get(item.bookId);
      return previous?.revision !== item.revision || previous.updatedAt !== item.updatedAt;
    });
    if (pending.length === 0) break;
    for (const item of pending) {
      if (options?.signal?.aborted) break;
      if (options?.canContinue) {
        const allowed = options.canContinue();
        if (!(typeof allowed === 'boolean' ? allowed : await allowed)) break;
      }
      attempted.set(item.bookId, item);
      try {
        const payload = JSON.parse(item.payload) as KavitaProgress;
        if (options?.signal) {
          await client.saveProgress(payload, options.signal);
        } else {
          await client.saveProgress(payload);
        }
        await confirmSync(item.bookId, new Date().toISOString(), item.revision, item.updatedAt);
      } catch (error) {
        if (options?.signal?.aborted) break;
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
