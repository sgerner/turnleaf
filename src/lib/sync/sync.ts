import {
  confirmAnnotationSync,
  confirmBookmarkSync,
  confirmSync,
  getBookAnnotations,
  getBookBookmarks,
  getBooks,
  getPendingAnnotationSync,
  getPendingBookmarkSync,
  getPendingSync,
  getServerAnnotations,
  markAnnotationSyncFailure,
  markBookmarkSyncFailure,
  markSyncFailure,
  reconcileBookAnnotations,
  reconcileBookBookmarks,
  reconcileSeriesAnnotations,
  type BookAnnotationsGroup,
  type BookRecord,
  type PendingAnnotationSyncItem,
  type PendingBookmarkSyncItem,
  type PendingSyncItem,
} from '../database/database';
import { KavitaError, type KavitaClient } from '../kavita/client';
import type { KavitaProgress } from '../kavita/types';
import type { StoredAnnotation } from '../reader/annotations';
import type { StoredReaderLocation } from '../reader/bookmarks';

const flushing = new Map<string, Promise<void>>();

export function flushProgress(client: KavitaClient, serverId: string): Promise<void> {
  const pending = flushing.get(serverId);
  if (pending) return pending;
  const current = run(client, serverId).finally(() => {
    if (flushing.get(serverId) === current) flushing.delete(serverId);
  });
  flushing.set(serverId, current);
  return current;
}

function isNotFoundOrAbsentError(error: unknown): error is KavitaError {
  return error instanceof KavitaError && (error.status === 404 || error.status === 400);
}

async function syncPendingAnnotation(
  client: KavitaClient,
  item: PendingAnnotationSyncItem,
): Promise<void> {
  if (item.syncState === 'pending_delete') {
    if (item.remoteId !== null) {
      try {
        await client.deleteAnnotation(item.remoteId);
      } catch (error) {
        if (!isNotFoundOrAbsentError(error)) throw error;
        const remaining = await client.getAnnotations(item.chapterId);
        if (remaining.some((remote) => remote.id === item.remoteId)) throw error;
      }
    }
    await confirmAnnotationSync({
      id: item.id,
      bookId: item.bookId,
      expectedState: 'pending_delete',
      expectedRevision: item.syncRevision,
    });
    return;
  }

  if (item.syncState === 'pending_update' && item.remoteId !== null) {
    try {
      const updated = await client.updateAnnotation({
        id: item.remoteId,
        libraryId: item.libraryId,
        seriesId: item.seriesId,
        volumeId: item.volumeId,
        chapterId: item.chapterId,
        xPath: item.xpath,
        endingXPath: item.endingXPath ?? item.xpath,
        selectedText: item.excerpt,
        note: item.note,
        context: item.context,
        chapterTitle: item.chapterTitle,
        pageNumber: item.pageNumber,
        selectedSlotIndex: item.slotIndex,
        containsSpoiler: item.containsSpoiler,
      });
      await confirmAnnotationSync({
        id: item.id,
        bookId: item.bookId,
        expectedState: 'pending_update',
        expectedRevision: item.syncRevision,
        remote: updated,
      });
      return;
    } catch (error) {
      if (!isNotFoundOrAbsentError(error)) throw error;
      const remoteList = await client.getAnnotations(item.chapterId);
      if (remoteList.some((remote) => remote.id === item.remoteId)) throw error;
      // Annotation was deleted remotely; fall through to re-create so local edits aren't lost.
    }
  }

  const created = await client.createAnnotation({
    libraryId: item.libraryId,
    seriesId: item.seriesId,
    volumeId: item.volumeId,
    chapterId: item.chapterId,
    xPath: item.xpath,
    endingXPath: item.endingXPath ?? item.xpath,
    selectedText: item.excerpt,
    note: item.note,
    context: item.context,
    chapterTitle: item.chapterTitle,
    pageNumber: item.pageNumber,
    selectedSlotIndex: item.slotIndex,
    containsSpoiler: item.containsSpoiler,
  });
  const confirmation = await confirmAnnotationSync({
    id: item.id,
    bookId: item.bookId,
    expectedState: item.syncState,
    expectedRevision: item.syncRevision,
    remote: created,
  });
  if (confirmation.deletedDuringCreate && created.id > 0) {
    try {
      await client.deleteAnnotation(created.id);
    } catch {
      // Best-effort orphan cleanup; next reconciliation will stay clean locally.
    }
  }
}

async function deleteRemoteBookmarkIdempotent(
  client: KavitaClient,
  chapterId: number,
  pageNumber: number,
  title: string,
): Promise<void> {
  try {
    await client.deletePersonalToc(chapterId, pageNumber, title);
  } catch (error) {
    if (!isNotFoundOrAbsentError(error)) throw error;
    const remaining = await client.getPersonalToc(chapterId);
    const stillPresent = remaining.some(
      (entry) => entry.pageNumber === pageNumber && entry.title.trim() === title.trim(),
    );
    if (stillPresent) throw error;
  }
}

async function createRemoteBookmarkIdempotent(
  client: KavitaClient,
  item: PendingBookmarkSyncItem,
): Promise<number | null> {
  try {
    await client.createPersonalToc({
      libraryId: item.libraryId,
      seriesId: item.seriesId,
      volumeId: item.volumeId,
      chapterId: item.chapterId,
      pageNumber: item.pageNumber,
      title: item.label,
      bookScrollId: item.xpath,
      selectedText: item.excerpt || null,
    });
    return item.remoteId;
  } catch (error) {
    if (!(error instanceof KavitaError) || error.status !== 400) throw error;
    const existing = await client.getPersonalToc(item.chapterId);
    const match = existing.find(
      (entry) => entry.pageNumber === item.pageNumber && entry.title.trim() === item.label.trim(),
    );
    if (!match) throw error;
    return match.id;
  }
}

async function syncPendingBookmark(
  client: KavitaClient,
  item: PendingBookmarkSyncItem,
): Promise<void> {
  if (item.syncState === 'pending_delete') {
    const targetTitle = item.remoteTitle ?? item.label;
    const targetPage = item.remotePageNumber ?? item.pageNumber;
    await deleteRemoteBookmarkIdempotent(client, item.chapterId, targetPage, targetTitle);
    await confirmBookmarkSync({
      id: item.id,
      bookId: item.bookId,
      expectedState: 'pending_delete',
      expectedRevision: item.syncRevision,
    });
    return;
  }

  if (item.syncState === 'pending_update' && item.remoteTitle !== null) {
    const oldPage = item.remotePageNumber ?? item.pageNumber;
    await deleteRemoteBookmarkIdempotent(client, item.chapterId, oldPage, item.remoteTitle);
  }

  const remoteId = await createRemoteBookmarkIdempotent(client, item);
  const confirmation = await confirmBookmarkSync({
    id: item.id,
    bookId: item.bookId,
    expectedState: item.syncState,
    expectedRevision: item.syncRevision,
    syncedTitle: item.label,
    syncedPageNumber: item.pageNumber,
    remoteId,
  });
  if (confirmation.deletedDuringSync) {
    try {
      await deleteRemoteBookmarkIdempotent(client, item.chapterId, item.pageNumber, item.label);
    } catch {
      // Best-effort cleanup if deleted locally during flight.
    }
  }
}

async function run(client: KavitaClient, serverId: string): Promise<void> {
  const failures: unknown[] = [];
  let progressFailureCount = 0;
  let studyFailureCount = 0;
  const attemptedProgress = new Map<string, PendingSyncItem>();
  const attemptedAnnotations = new Map<string, string>();
  const attemptedBookmarks = new Map<string, string>();

  while (true) {
    const [pendingProgress, pendingAnnotations, pendingBookmarks] = await Promise.all([
      getPendingSync(serverId),
      getPendingAnnotationSync(serverId),
      getPendingBookmarkSync(serverId),
    ]);

    const nextProgress = pendingProgress.filter((item) => {
      const previous = attemptedProgress.get(item.bookId);
      return previous?.revision !== item.revision || previous.updatedAt !== item.updatedAt;
    });
    const nextAnnotations = pendingAnnotations.filter((item) => {
      const key = `${item.syncState}:${item.syncRevision}:${item.updatedAt}`;
      return attemptedAnnotations.get(item.id) !== key;
    });
    const nextBookmarks = pendingBookmarks.filter((item) => {
      const key = `${item.syncState}:${item.syncRevision}:${item.updatedAt}`;
      return attemptedBookmarks.get(item.id) !== key;
    });

    if (nextProgress.length === 0 && nextAnnotations.length === 0 && nextBookmarks.length === 0) {
      break;
    }

    for (const item of nextProgress) {
      attemptedProgress.set(item.bookId, item);
      try {
        await client.saveProgress(JSON.parse(item.payload) as KavitaProgress);
        await confirmSync(item.bookId, new Date().toISOString(), item.revision, item.updatedAt);
      } catch (error) {
        await markSyncFailure(
          item.bookId,
          error instanceof Error ? error.message : 'Sync failed',
          item.revision,
          item.updatedAt,
        );
        progressFailureCount += 1;
        failures.push(error);
      }
    }

    for (const item of nextAnnotations) {
      attemptedAnnotations.set(item.id, `${item.syncState}:${item.syncRevision}:${item.updatedAt}`);
      try {
        await syncPendingAnnotation(client, item);
      } catch (error) {
        await markAnnotationSyncFailure(
          item.id,
          item.bookId,
          error instanceof Error ? error.message : 'Annotation sync failed',
          item.syncRevision,
        );
        studyFailureCount += 1;
        failures.push(error);
      }
    }

    for (const item of nextBookmarks) {
      attemptedBookmarks.set(item.id, `${item.syncState}:${item.syncRevision}:${item.updatedAt}`);
      try {
        await syncPendingBookmark(client, item);
      } catch (error) {
        await markBookmarkSyncFailure(
          item.id,
          item.bookId,
          error instanceof Error ? error.message : 'Bookmark sync failed',
          item.syncRevision,
        );
        studyFailureCount += 1;
        failures.push(error);
      }
    }
  }

  if (failures.length > 0) {
    const message =
      studyFailureCount === 0
        ? `${progressFailureCount} reading progress item${progressFailureCount === 1 ? '' : 's'} failed to sync.`
        : progressFailureCount === 0
          ? `${studyFailureCount} study item${studyFailureCount === 1 ? '' : 's'} failed to sync.`
          : `${failures.length} sync items failed to sync.`;
    throw new AggregateError(failures, message);
  }
}

export async function syncBookStudyData(
  client: KavitaClient,
  book: BookRecord,
  signal?: AbortSignal,
): Promise<{ annotations: StoredAnnotation[]; bookmarks: StoredReaderLocation[] }> {
  if (book.remoteAvailable === false) {
    const [annotations, bookmarks] = await Promise.all([
      getBookAnnotations(book.id),
      getBookBookmarks(book.id),
    ]);
    return { annotations, bookmarks };
  }

  try {
    await flushProgress(client, book.serverId);
  } catch {
    // Reconcile preserves still-pending local items if a flush item failed.
  }

  const [remoteAnnotations, remoteBookmarks] = await Promise.all([
    client.getAnnotations(book.chapterId, signal),
    client.getPersonalToc(book.chapterId, signal),
  ]);
  const [annotations, bookmarks] = await Promise.all([
    reconcileBookAnnotations(book.id, remoteAnnotations),
    reconcileBookBookmarks(book.id, remoteBookmarks),
  ]);
  return { annotations, bookmarks };
}

export async function syncLibraryAnnotations(
  client: KavitaClient,
  serverId: string,
  books?: readonly BookRecord[],
  signal?: AbortSignal,
): Promise<BookAnnotationsGroup[]> {
  try {
    await flushProgress(client, serverId);
  } catch {
    // Continue pulling remote annotations even if an unrelated queue item failed.
  }

  const catalog = books ?? (await getBooks(serverId, { includeDescription: false }));
  const seriesIds = [
    ...new Set(
      catalog
        .filter((book) => book.serverId === serverId && book.remoteAvailable !== false)
        .map((book) => book.seriesId),
    ),
  ];

  const concurrency = 4;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, seriesIds.length) }, async () => {
    while (cursor < seriesIds.length) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const index = cursor;
      cursor += 1;
      const seriesId = seriesIds[index]!;
      const remote = await client.getSeriesAnnotations(seriesId, signal);
      await reconcileSeriesAnnotations(serverId, seriesId, remote);
    }
  });
  await Promise.all(workers);

  return getServerAnnotations(serverId);
}
