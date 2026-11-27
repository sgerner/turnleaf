import {
  confirmSync,
  getPendingSync,
  markSyncFailure,
  type PendingSyncItem,
} from '../database/database';
import { KavitaError, KavitaOfflineError, type KavitaClient } from '../kavita/client';
import type { KavitaProgress } from '../kavita/types';

export interface FlushProgressOptions {
  signal?: AbortSignal | undefined;
  queueSignal?: AbortSignal | undefined;
  canContinue?: (() => boolean | Promise<boolean>) | undefined;
}

const flushing = new Map<string, Promise<void>>();

function canClientSend(client: KavitaClient): boolean {
  return typeof client.canSendRequests !== 'function' || client.canSendRequests();
}

function normalizeOptions(
  signalOrOptions?: AbortSignal | FlushProgressOptions,
): FlushProgressOptions {
  if (!signalOrOptions) return {};
  if ('aborted' in signalOrOptions) return { signal: signalOrOptions };
  return signalOrOptions;
}

export function flushProgress(
  client: KavitaClient,
  serverId: string,
  signalOrOptions?: AbortSignal | FlushProgressOptions,
): Promise<void> {
  const pending = flushing.get(serverId);
  if (pending) return pending;
  const options = normalizeOptions(signalOrOptions);
  const current = run(client, serverId, options).finally(() => {
    if (flushing.get(serverId) === current) flushing.delete(serverId);
  });
  flushing.set(serverId, current);
  return current;
}

function shouldStopQueue(
  client: KavitaClient,
  options: FlushProgressOptions,
): boolean | Promise<boolean> {
  if (options.signal?.aborted || options.queueSignal?.aborted || !canClientSend(client)) {
    return true;
  }
  if (!options.canContinue) return false;
  const allowed = options.canContinue();
  if (typeof allowed === 'boolean') {
    if (!allowed) return true;
    return Boolean(
      options.signal?.aborted || options.queueSignal?.aborted || !canClientSend(client),
    );
  }
  return allowed.then((ok) => {
    if (!ok) return true;
    return Boolean(
      options.signal?.aborted || options.queueSignal?.aborted || !canClientSend(client),
    );
  });
}

async function run(
  client: KavitaClient,
  serverId: string,
  options: FlushProgressOptions,
): Promise<void> {
  const { signal } = options;
  const failures: unknown[] = [];
  const attempted = new Map<string, PendingSyncItem>();
  while (true) {
    const initialStop = shouldStopQueue(client, options);
    if (typeof initialStop === 'boolean' ? initialStop : await initialStop) break;
    const pending = (await getPendingSync(serverId)).filter((item) => {
      const previous = attempted.get(item.bookId);
      return previous?.revision !== item.revision || previous.updatedAt !== item.updatedAt;
    });
    if (pending.length === 0) break;
    const postReadStop = shouldStopQueue(client, options);
    if (typeof postReadStop === 'boolean' ? postReadStop : await postReadStop) break;
    let stopFlush = false;
    for (const item of pending) {
      const itemStop = shouldStopQueue(client, options);
      if (typeof itemStop === 'boolean' ? itemStop : await itemStop) {
        stopFlush = true;
        break;
      }
      attempted.set(item.bookId, item);
      try {
        const payload = JSON.parse(item.payload) as KavitaProgress;
        await (signal ? client.saveProgress(payload, signal) : client.saveProgress(payload));
        await confirmSync(item.bookId, new Date().toISOString(), item.revision, item.updatedAt);
      } catch (error) {
        const abortedBeforeDispatch =
          signal?.aborted === true ||
          error instanceof KavitaOfflineError ||
          (error instanceof DOMException && error.name === 'AbortError') ||
          (error instanceof KavitaError &&
            error.kind === 'authentication' &&
            error.status === undefined &&
            !canClientSend(client));
        if (abortedBeforeDispatch) {
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
        if (error instanceof KavitaError && error.kind === 'authentication') {
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
