import type { KavitaAnnotation, KavitaPersonalTocItem } from '../kavita/types';
import {
  parseAnnotations,
  type StoredAnnotation,
  type StudySyncState,
} from '../reader/annotations';
import {
  parseBookmarks,
  parseLocationHistory,
  type StoredReaderLocation,
} from '../reader/bookmarks';

export interface StoredAnnotationRecord {
  id: string;
  bookId: string;
  remoteId: number | null;
  cfi: string;
  xpath: string;
  endingXPath: string | null;
  pageNumber: number;
  slotIndex: number;
  containsSpoiler: boolean;
  context: string | null;
  chapterTitle: string | null;
  excerpt: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  remoteUpdatedAt: string | null;
  syncState: StudySyncState;
  syncRevision: number;
  attemptCount: number;
  lastAttemptAt: string | null;
  lastError: string | null;
}

export interface StoredBookmarkRecord {
  id: string;
  bookId: string;
  remoteId: number | null;
  cfi: string;
  xpath: string | null;
  href: string;
  percentage: number;
  pageNumber: number;
  label: string;
  excerpt: string;
  remoteTitle: string | null;
  remotePageNumber: number | null;
  savedAt: string;
  updatedAt: string;
  syncState: StudySyncState;
  syncRevision: number;
  attemptCount: number;
  lastAttemptAt: string | null;
  lastError: string | null;
}

export function cfiFallbackLocator(cfi: string): { pageNumber: number; xpath: string } {
  const match = cfi.trim().match(/^epubcfi\(\/\d+\/(\d+)(?:\[[^\]]*\])?!/i);
  const spineStep = match?.[1] ? Number(match[1]) : NaN;
  const pageNumber =
    Number.isInteger(spineStep) && spineStep >= 2 ? Math.max(0, Math.floor(spineStep / 2) - 1) : 0;
  return {
    pageNumber,
    xpath: `//body/DocFragment[${pageNumber + 1}]/body`,
  };
}

export function isLegacyStudyPreferenceKey(key: string): boolean {
  return (
    key.startsWith('readerAnnotations:') ||
    key.startsWith('readerBookmarks:') ||
    key.startsWith('readerHistory:')
  );
}

export function migrateLegacyPreferenceEntries(
  entries: Iterable<[string, string]>,
  activeBookIds: ReadonlySet<string>,
): {
  annotations: StoredAnnotationRecord[];
  bookmarks: StoredBookmarkRecord[];
  history: Array<{ bookId: string; entry: StoredReaderLocation }>;
  keysToRemove: string[];
} {
  const annotations: StoredAnnotationRecord[] = [];
  const bookmarks: StoredBookmarkRecord[] = [];
  const history: Array<{ bookId: string; entry: StoredReaderLocation }> = [];
  const keysToRemove: string[] = [];

  for (const [key, raw] of entries) {
    if (!isLegacyStudyPreferenceKey(key)) continue;
    keysToRemove.push(key);
    const separator = key.indexOf(':');
    if (separator < 0) continue;
    const prefix = key.slice(0, separator);
    const bookId = key.slice(separator + 1);
    if (!activeBookIds.has(bookId)) continue;

    if (prefix === 'readerAnnotations') {
      for (const item of parseAnnotations(raw)) {
        const fallback = cfiFallbackLocator(item.cfi);
        const xpath = item.xpath?.trim() || fallback.xpath;
        annotations.push({
          id: `${bookId}:${item.id}`,
          bookId,
          remoteId: item.remoteId ?? null,
          cfi: item.cfi,
          xpath,
          endingXPath: item.endingXPath ?? xpath,
          pageNumber: item.pageNumber ?? fallback.pageNumber,
          slotIndex: item.slotIndex ?? 0,
          containsSpoiler: item.containsSpoiler ?? false,
          context: item.context ?? item.excerpt,
          chapterTitle: item.chapterTitle ?? null,
          excerpt: item.excerpt,
          note: item.note,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt ?? item.createdAt,
          remoteUpdatedAt: null,
          syncState: item.syncState ?? 'pending_create',
          syncRevision: 1,
          attemptCount: 0,
          lastAttemptAt: null,
          lastError: null,
        });
      }
    } else if (prefix === 'readerBookmarks') {
      const bookBookmarks: StoredBookmarkRecord[] = [];
      for (const item of parseBookmarks(raw)) {
        const fallback = cfiFallbackLocator(item.cfi);
        const pageNumber = item.pageNumber ?? fallback.pageNumber;
        const label = disambiguateBookmarkLabel(bookBookmarks, pageNumber, item.label);
        const record: StoredBookmarkRecord = {
          id: `${bookId}:${item.id}`,
          bookId,
          remoteId: item.remoteId ?? null,
          cfi: item.cfi,
          xpath: item.xpath ?? fallback.xpath,
          href: item.href,
          percentage: item.percentage,
          pageNumber,
          label,
          excerpt: item.excerpt ?? '',
          remoteTitle: item.remoteTitle ?? null,
          remotePageNumber: item.remotePageNumber ?? null,
          savedAt: item.savedAt,
          updatedAt: item.updatedAt ?? item.savedAt,
          syncState: item.syncState ?? 'pending_create',
          syncRevision: 1,
          attemptCount: 0,
          lastAttemptAt: null,
          lastError: null,
        };
        bookBookmarks.push(record);
        bookmarks.push(record);
      }
    } else if (prefix === 'readerHistory') {
      for (const entry of parseLocationHistory(raw)) {
        history.push({ bookId, entry });
      }
    }
  }

  return { annotations, bookmarks, history, keysToRemove };
}

export function disambiguateBookmarkLabel(
  existing: readonly StoredBookmarkRecord[],
  pageNumber: number,
  desiredLabel: string,
  excludeId?: string,
): string {
  const base = desiredLabel.trim().slice(0, 180) || 'Bookmark';
  const taken = new Set(
    existing
      .filter(
        (item) =>
          item.id !== excludeId &&
          item.syncState !== 'pending_delete' &&
          item.pageNumber === pageNumber,
      )
      .map((item) => item.label.trim().toLowerCase()),
  );
  if (!taken.has(base.toLowerCase())) return base;
  let suffix = 2;
  while (taken.has(`${base} (${suffix})`.toLowerCase())) {
    suffix += 1;
  }
  return `${base} (${suffix})`;
}

export function toStoredAnnotation(record: StoredAnnotationRecord): StoredAnnotation {
  return {
    id: record.id,
    cfi: record.cfi,
    excerpt: record.excerpt,
    note: record.note,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    remoteId: record.remoteId,
    xpath: record.xpath,
    endingXPath: record.endingXPath,
    pageNumber: record.pageNumber,
    context: record.context,
    chapterTitle: record.chapterTitle,
    slotIndex: record.slotIndex,
    containsSpoiler: record.containsSpoiler,
    syncState: record.syncState,
  };
}

export function toStoredBookmark(record: StoredBookmarkRecord): StoredReaderLocation {
  return {
    id: record.id,
    cfi: record.cfi,
    href: record.href,
    percentage: record.percentage,
    label: record.label,
    savedAt: record.savedAt,
    updatedAt: record.updatedAt,
    remoteId: record.remoteId,
    xpath: record.xpath,
    pageNumber: record.pageNumber,
    excerpt: record.excerpt,
    remoteTitle: record.remoteTitle,
    remotePageNumber: record.remotePageNumber,
    syncState: record.syncState,
  };
}

export function reconcileAnnotationRecords(
  bookId: string,
  local: readonly StoredAnnotationRecord[],
  remote: readonly KavitaAnnotation[],
  now = new Date().toISOString(),
): StoredAnnotationRecord[] {
  const remoteById = new Map(remote.map((item) => [item.id, item]));
  const matchedRemoteIds = new Set<number>();
  const next: StoredAnnotationRecord[] = [];

  for (const record of local) {
    if (record.syncState === 'pending_delete') {
      if (record.remoteId !== null && remoteById.has(record.remoteId)) {
        matchedRemoteIds.add(record.remoteId);
        next.push(record);
      }
      continue;
    }

    if (record.syncState === 'pending_update') {
      if (record.remoteId !== null && remoteById.has(record.remoteId)) {
        matchedRemoteIds.add(record.remoteId);
        next.push(record);
      } else {
        next.push({
          ...record,
          remoteId: null,
          syncState: 'pending_create',
        });
      }
      continue;
    }

    if (record.syncState === 'pending_create') {
      const match = remote.find(
        (candidate) =>
          !matchedRemoteIds.has(candidate.id) &&
          candidate.xPath === record.xpath &&
          candidate.selectedText.trim() === record.excerpt.trim(),
      );
      if (match) {
        matchedRemoteIds.add(match.id);
        const sameNote = record.note.trim() === match.commentPlainText.trim();
        next.push({
          ...record,
          remoteId: match.id,
          remoteUpdatedAt: match.lastModifiedUtc || null,
          syncState: sameNote ? 'synced' : 'pending_update',
        });
      } else {
        next.push(record);
      }
      continue;
    }

    if (record.remoteId !== null) {
      const remoteItem = remoteById.get(record.remoteId);
      if (!remoteItem) continue;
      matchedRemoteIds.add(remoteItem.id);
      const sameAnchor =
        record.xpath === remoteItem.xPath &&
        (record.endingXPath ?? record.xpath) === (remoteItem.endingXPath ?? remoteItem.xPath) &&
        record.excerpt.trim() === remoteItem.selectedText.trim();
      next.push({
        ...record,
        cfi: sameAnchor ? record.cfi : '',
        xpath: remoteItem.xPath,
        endingXPath: remoteItem.endingXPath ?? remoteItem.xPath,
        pageNumber: remoteItem.pageNumber,
        slotIndex: remoteItem.selectedSlotIndex,
        containsSpoiler: remoteItem.containsSpoiler,
        context: remoteItem.context,
        chapterTitle: remoteItem.chapterTitle,
        excerpt: remoteItem.selectedText.trim().slice(0, 500) || record.excerpt,
        note: remoteItem.commentPlainText.slice(0, 2000),
        updatedAt: remoteItem.lastModifiedUtc || remoteItem.createdUtc || record.updatedAt,
        remoteUpdatedAt: remoteItem.lastModifiedUtc || null,
        syncState: 'synced',
        lastError: null,
      });
    } else {
      next.push(record);
    }
  }

  for (const remoteItem of remote) {
    if (matchedRemoteIds.has(remoteItem.id)) continue;
    const excerpt = remoteItem.selectedText.trim().slice(0, 500);
    if (!excerpt) continue;
    next.push({
      id: `kavita-ann:${bookId}:${remoteItem.id}`,
      bookId,
      remoteId: remoteItem.id,
      cfi: '',
      xpath: remoteItem.xPath,
      endingXPath: remoteItem.endingXPath ?? remoteItem.xPath,
      pageNumber: remoteItem.pageNumber,
      slotIndex: remoteItem.selectedSlotIndex,
      containsSpoiler: remoteItem.containsSpoiler,
      context: remoteItem.context,
      chapterTitle: remoteItem.chapterTitle,
      excerpt,
      note: remoteItem.commentPlainText.slice(0, 2000),
      createdAt: remoteItem.createdUtc || now,
      updatedAt: remoteItem.lastModifiedUtc || remoteItem.createdUtc || now,
      remoteUpdatedAt: remoteItem.lastModifiedUtc || null,
      syncState: 'synced',
      syncRevision: 0,
      attemptCount: 0,
      lastAttemptAt: null,
      lastError: null,
    });
  }

  return next.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export function reconcileBookmarkRecords(
  bookId: string,
  local: readonly StoredBookmarkRecord[],
  remote: readonly KavitaPersonalTocItem[],
  now = new Date().toISOString(),
): StoredBookmarkRecord[] {
  const matchedRemoteIds = new Set<number>();
  const next: StoredBookmarkRecord[] = [];

  const findMatch = (record: StoredBookmarkRecord): KavitaPersonalTocItem | undefined =>
    remote.find((candidate) => {
      if (matchedRemoteIds.has(candidate.id)) return false;
      if (record.remoteId !== null && candidate.id === record.remoteId) return true;
      if (
        record.remoteTitle !== null &&
        candidate.pageNumber === (record.remotePageNumber ?? record.pageNumber) &&
        candidate.title.trim() === record.remoteTitle.trim()
      ) {
        return true;
      }
      if (
        record.syncState === 'pending_create' &&
        candidate.pageNumber === record.pageNumber &&
        candidate.title.trim() === record.label.trim()
      ) {
        return true;
      }
      return false;
    });

  for (const record of local) {
    const match = findMatch(record);
    if (record.syncState === 'pending_delete') {
      if (match) {
        matchedRemoteIds.add(match.id);
        next.push({
          ...record,
          remoteId: match.id,
          remoteTitle: match.title,
          remotePageNumber: match.pageNumber,
        });
      }
      continue;
    }

    if (record.syncState === 'pending_update') {
      if (match) {
        matchedRemoteIds.add(match.id);
        next.push({
          ...record,
          remoteId: match.id,
          remoteTitle: match.title,
          remotePageNumber: match.pageNumber,
        });
      } else {
        next.push({
          ...record,
          remoteId: null,
          remoteTitle: null,
          remotePageNumber: null,
          syncState: 'pending_create',
        });
      }
      continue;
    }

    if (record.syncState === 'pending_create') {
      if (match) {
        matchedRemoteIds.add(match.id);
        next.push({
          ...record,
          remoteId: match.id,
          xpath: record.xpath ?? match.bookScrollId,
          remoteTitle: match.title,
          remotePageNumber: match.pageNumber,
          syncState: 'synced',
          lastError: null,
        });
      } else {
        next.push(record);
      }
      continue;
    }

    if (!match) {
      if (record.remoteTitle === null && record.remoteId === null) {
        next.push(record);
      }
      continue;
    }

    matchedRemoteIds.add(match.id);
    const sameAnchor =
      (record.xpath ?? null) === (match.bookScrollId ?? null) &&
      record.pageNumber === match.pageNumber;
    next.push({
      ...record,
      remoteId: match.id,
      cfi: sameAnchor ? record.cfi : '',
      xpath: match.bookScrollId ?? record.xpath,
      pageNumber: match.pageNumber,
      label: match.title,
      excerpt: match.selectedText ?? record.excerpt,
      remoteTitle: match.title,
      remotePageNumber: match.pageNumber,
      syncState: 'synced',
      lastError: null,
    });
  }

  for (const remoteItem of remote) {
    if (matchedRemoteIds.has(remoteItem.id)) continue;
    next.push({
      id: `kavita-ptoc:${bookId}:${remoteItem.id}`,
      bookId,
      remoteId: remoteItem.id,
      cfi: '',
      xpath: remoteItem.bookScrollId,
      href: '',
      percentage: 0,
      pageNumber: remoteItem.pageNumber,
      label: remoteItem.title,
      excerpt: remoteItem.selectedText ?? '',
      remoteTitle: remoteItem.title,
      remotePageNumber: remoteItem.pageNumber,
      savedAt: now,
      updatedAt: now,
      syncState: 'synced',
      syncRevision: 0,
      attemptCount: 0,
      lastAttemptAt: null,
      lastError: null,
    });
  }

  return next.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.id.localeCompare(b.id));
}
