export interface SyncQueueItem<T> {
  bookId: string;
  payload: T;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

export function coalesceSyncItem<T>(
  current: SyncQueueItem<T> | null,
  bookId: string,
  payload: T,
  now: string,
): SyncQueueItem<T> {
  return {
    bookId,
    payload,
    attemptCount: current?.attemptCount ?? 0,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
}
