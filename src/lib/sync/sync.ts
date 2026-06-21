import { confirmSync, getPendingSync, markSyncFailure } from '../database/database';
import type { KavitaClient } from '../kavita/client';
import type { KavitaProgress } from '../kavita/types';

let flushing: Promise<void> | null = null;

export function flushProgress(client: KavitaClient): Promise<void> {
  if (flushing) return flushing;
  flushing = run(client).finally(() => (flushing = null));
  return flushing;
}

async function run(client: KavitaClient): Promise<void> {
  for (const item of await getPendingSync()) {
    try {
      await client.saveProgress(JSON.parse(item.payload) as KavitaProgress);
      await confirmSync(item.bookId, new Date().toISOString());
    } catch (error) {
      await markSyncFailure(item.bookId, error instanceof Error ? error.message : 'Sync failed');
      throw error;
    }
  }
}
