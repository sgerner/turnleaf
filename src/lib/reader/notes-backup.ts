import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { parseAnnotations, type StoredAnnotation } from './annotations';
import { parseBookmarks, type StoredReaderLocation } from './bookmarks';

export const BOOKMARKS_PREFERENCE_PREFIX = 'readerBookmarks:';
export const ANNOTATIONS_PREFERENCE_PREFIX = 'readerAnnotations:';
export const NOTE_META_PREFERENCE_PREFIX = 'readerNoteMeta:';

export const READING_NOTE_PREFERENCE_PREFIXES = [
  BOOKMARKS_PREFERENCE_PREFIX,
  ANNOTATIONS_PREFERENCE_PREFIX,
  NOTE_META_PREFERENCE_PREFIX,
] as const;

export interface BookNoteMetadata {
  id: string;
  title: string;
  author: string | null;
  series: string | null;
}

export interface ReadingNotesBookBackup {
  bookId: string;
  title: string;
  author: string | null;
  series: string | null;
  bookmarks: StoredReaderLocation[];
  annotations: StoredAnnotation[];
}

export interface ReadingNotesBackup {
  format: 'turnleaf-reading-notes';
  version: 1;
  exportedAt: string;
  books: ReadingNotesBookBackup[];
}

export interface ExportDocumentResult {
  ok: boolean;
  message: string;
  fallbackText: string;
}

const MAX_BOOKMARKS = 100;
const MAX_ANNOTATIONS = 200;

export function bookmarksPreferenceKey(bookId: string): string {
  return `${BOOKMARKS_PREFERENCE_PREFIX}${bookId}`;
}

export function annotationsPreferenceKey(bookId: string): string {
  return `${ANNOTATIONS_PREFERENCE_PREFIX}${bookId}`;
}

export function noteMetaPreferenceKey(bookId: string): string {
  return `${NOTE_META_PREFERENCE_PREFIX}${bookId}`;
}

function isValidBookId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 240 &&
    !/[\0\r\n]/.test(value)
  );
}

function parseNoteMeta(raw: string | undefined): Omit<BookNoteMetadata, 'id'> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.title !== 'string' || !record.title.trim()) return null;
    return {
      title: record.title.trim(),
      author: typeof record.author === 'string' && record.author.trim() ? record.author : null,
      series: typeof record.series === 'string' && record.series.trim() ? record.series : null,
    };
  } catch {
    return null;
  }
}

function getPrefValue(
  preferences: ReadonlyMap<string, string> | Record<string, string>,
  key: string,
): string | undefined {
  if (preferences instanceof Map) {
    return (preferences as ReadonlyMap<string, string>).get(key);
  }
  const value = (preferences as Record<string, string>)[key];
  return typeof value === 'string' ? value : undefined;
}

function prefEntries(
  preferences: ReadonlyMap<string, string> | Record<string, string>,
): Iterable<[string, string]> {
  if (preferences instanceof Map) {
    return (preferences as ReadonlyMap<string, string>).entries();
  }
  return Object.entries(preferences).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
}

export function hasSavedNotesInPreferences(
  preferences: ReadonlyMap<string, string> | Record<string, string>,
  bookId: string,
): boolean {
  const bookmarks = parseBookmarks(
    getPrefValue(preferences, bookmarksPreferenceKey(bookId)) ?? null,
  );
  if (bookmarks.length > 0) return true;
  const annotations = parseAnnotations(
    getPrefValue(preferences, annotationsPreferenceKey(bookId)) ?? null,
  );
  return annotations.length > 0;
}

export function bookIdsWithSavedNotes(
  preferences: ReadonlyMap<string, string> | Record<string, string>,
): Set<string> {
  const candidateIds = new Set<string>();
  for (const [key] of prefEntries(preferences)) {
    if (key.startsWith(BOOKMARKS_PREFERENCE_PREFIX)) {
      const id = key.slice(BOOKMARKS_PREFERENCE_PREFIX.length);
      if (id) candidateIds.add(id);
    } else if (key.startsWith(ANNOTATIONS_PREFERENCE_PREFIX)) {
      const id = key.slice(ANNOTATIONS_PREFERENCE_PREFIX.length);
      if (id) candidateIds.add(id);
    }
  }
  const retained = new Set<string>();
  for (const id of candidateIds) {
    if (hasSavedNotesInPreferences(preferences, id)) {
      retained.add(id);
    }
  }
  return retained;
}

export function collectLibraryReadingNotes(
  preferences: ReadonlyMap<string, string> | Record<string, string>,
  knownBooks: readonly BookNoteMetadata[],
): ReadingNotesBookBackup[] {
  const metadataById = new Map<string, BookNoteMetadata>();
  for (const book of knownBooks) {
    metadataById.set(book.id, book);
  }

  const ids = bookIdsWithSavedNotes(preferences);
  const items: ReadingNotesBookBackup[] = [];
  for (const bookId of ids) {
    const bookmarks = parseBookmarks(
      getPrefValue(preferences, bookmarksPreferenceKey(bookId)) ?? null,
    );
    const annotations = parseAnnotations(
      getPrefValue(preferences, annotationsPreferenceKey(bookId)) ?? null,
    );
    if (bookmarks.length === 0 && annotations.length === 0) continue;
    const known = metadataById.get(bookId);
    const savedMeta = parseNoteMeta(getPrefValue(preferences, noteMetaPreferenceKey(bookId)));
    items.push({
      bookId,
      title: known?.title || savedMeta?.title || bookId,
      author: known?.author ?? savedMeta?.author ?? null,
      series: known?.series ?? savedMeta?.series ?? null,
      bookmarks,
      annotations,
    });
  }

  return items.sort((a, b) => a.title.localeCompare(b.title) || a.bookId.localeCompare(b.bookId));
}

export function bookReadingNotesMarkdown(
  title: string,
  bookmarks: readonly StoredReaderLocation[],
  annotations: readonly StoredAnnotation[],
  metadata?: { author?: string | null; series?: string | null },
): string {
  const lines = [`# Reading notes for ${title}`, ''];
  if (metadata?.author) lines.push(`Author: ${metadata.author}`);
  if (metadata?.series) lines.push(`Series: ${metadata.series}`);
  if (metadata?.author || metadata?.series) lines.push('');

  if (bookmarks.length > 0) {
    lines.push('## Bookmarks', '');
    for (const bookmark of bookmarks) {
      const percent = Math.round(Math.max(0, Math.min(1, bookmark.percentage)) * 100);
      const label = bookmark.label.replaceAll('\n', ' ').trim() || `${percent}%`;
      lines.push(`- **${label}** (${percent}% · ${bookmark.savedAt}) — \`${bookmark.cfi}\``);
    }
    lines.push('');
  }

  if (annotations.length > 0) {
    lines.push('## Highlights and notes', '');
    for (const annotation of annotations) {
      lines.push(
        `### ${annotation.createdAt}`,
        '',
        `> ${annotation.excerpt.replaceAll('\n', ' ')}`,
        '',
      );
      if (annotation.note) lines.push(annotation.note, '');
    }
  }

  if (bookmarks.length === 0 && annotations.length === 0) {
    lines.push('No saved bookmarks or highlights.', '');
  }

  return `${lines.join('\n').trim()}\n`;
}

export function serializeReadingNotesBackup(
  books: readonly ReadingNotesBookBackup[],
  exportedAt = new Date().toISOString(),
): string {
  const payload: ReadingNotesBackup = {
    format: 'turnleaf-reading-notes',
    version: 1,
    exportedAt,
    books: [...books],
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function readingNotesBackupMarkdown(
  books: readonly ReadingNotesBookBackup[],
  exportedAt = new Date().toISOString(),
): string {
  const lines = ['# Turnleaf Reading Notes', '', `Exported: ${exportedAt}`, ''];
  if (books.length === 0) {
    lines.push('No saved bookmarks or highlights.', '');
    return `${lines.join('\n').trim()}\n`;
  }

  for (const book of books) {
    lines.push(`## ${book.title}`, '');
    if (book.author) lines.push(`Author: ${book.author}`);
    if (book.series) lines.push(`Series: ${book.series}`);
    if (book.author || book.series) lines.push('');

    if (book.bookmarks.length > 0) {
      lines.push('### Bookmarks', '');
      for (const bookmark of book.bookmarks) {
        const percent = Math.round(Math.max(0, Math.min(1, bookmark.percentage)) * 100);
        const label = bookmark.label.replaceAll('\n', ' ').trim() || `${percent}%`;
        lines.push(`- **${label}** (${percent}% · ${bookmark.savedAt}) — \`${bookmark.cfi}\``);
      }
      lines.push('');
    }

    if (book.annotations.length > 0) {
      lines.push('### Highlights and notes', '');
      for (const annotation of book.annotations) {
        lines.push(
          `#### ${annotation.createdAt}`,
          '',
          `> ${annotation.excerpt.replaceAll('\n', ' ')}`,
          '',
        );
        if (annotation.note) lines.push(annotation.note, '');
      }
    }
  }

  return `${lines.join('\n').trim()}\n`;
}

export function parseReadingNotesBackup(raw: string): ReadingNotesBackup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('The backup file is not valid JSON.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The backup file does not contain a Turnleaf notes backup object.');
  }

  const root = parsed as Record<string, unknown>;
  if (root.format !== 'turnleaf-reading-notes' || root.version !== 1) {
    throw new Error('Unsupported backup format. Select a Turnleaf reading notes JSON backup.');
  }
  if (!Array.isArray(root.books)) {
    throw new Error('The backup file is missing its books list.');
  }

  const byId = new Map<string, ReadingNotesBookBackup>();
  for (const item of root.books) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('The backup file contains an invalid book entry.');
    }
    const entry = item as Record<string, unknown>;
    if (!isValidBookId(entry.bookId)) {
      throw new Error('The backup file contains an invalid book identifier.');
    }
    const bookId = entry.bookId.trim();
    if (entry.bookmarks !== undefined && !Array.isArray(entry.bookmarks)) {
      throw new Error(`Bookmarks for "${bookId}" must be a JSON array.`);
    }
    if (entry.annotations !== undefined && !Array.isArray(entry.annotations)) {
      throw new Error(`Annotations for "${bookId}" must be a JSON array.`);
    }

    const bookmarks = parseBookmarks(JSON.stringify(entry.bookmarks ?? []));
    const annotations = parseAnnotations(JSON.stringify(entry.annotations ?? []));
    if (bookmarks.length === 0 && annotations.length === 0) continue;

    const title =
      typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : bookId;
    const author =
      typeof entry.author === 'string' && entry.author.trim() ? entry.author.trim() : null;
    const series =
      typeof entry.series === 'string' && entry.series.trim() ? entry.series.trim() : null;

    const existing = byId.get(bookId);
    if (existing) {
      byId.set(bookId, {
        bookId,
        title: existing.title !== bookId ? existing.title : title,
        author: existing.author ?? author,
        series: existing.series ?? series,
        bookmarks: mergeBookmarks(existing.bookmarks, bookmarks),
        annotations: mergeAnnotations(existing.annotations, annotations),
      });
    } else {
      byId.set(bookId, {
        bookId,
        title,
        author,
        series,
        bookmarks,
        annotations,
      });
    }
  }

  return {
    format: 'turnleaf-reading-notes',
    version: 1,
    exportedAt:
      typeof root.exportedAt === 'string' && root.exportedAt.trim()
        ? root.exportedAt
        : new Date().toISOString(),
    books: [...byId.values()],
  };
}

export function mergeBookmarks(
  existing: readonly StoredReaderLocation[],
  incoming: readonly StoredReaderLocation[],
): StoredReaderLocation[] {
  const merged = new Map<string, StoredReaderLocation>();
  for (const item of incoming) merged.set(item.id, item);
  for (const item of existing) {
    if (!merged.has(item.id)) merged.set(item.id, item);
  }
  return [...merged.values()]
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
    .slice(0, MAX_BOOKMARKS);
}

export function mergeAnnotations(
  existing: readonly StoredAnnotation[],
  incoming: readonly StoredAnnotation[],
): StoredAnnotation[] {
  const byCfi = new Map<string, StoredAnnotation>();
  for (const item of existing) byCfi.set(item.cfi, item);
  for (const item of incoming) byCfi.set(item.cfi, item);
  return [...byCfi.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-MAX_ANNOTATIONS);
}

export function buildRestorePreferencesUpdate(
  backup: ReadingNotesBackup,
  existingPreferences: ReadonlyMap<string, string> | Record<string, string>,
): { updates: Map<string, string>; restoredBookCount: number } {
  const updates = new Map<string, string>();
  let restoredBookCount = 0;

  for (const book of backup.books) {
    const currentBookmarks = parseBookmarks(
      getPrefValue(existingPreferences, bookmarksPreferenceKey(book.bookId)) ?? null,
    );
    const currentAnnotations = parseAnnotations(
      getPrefValue(existingPreferences, annotationsPreferenceKey(book.bookId)) ?? null,
    );
    const nextBookmarks = mergeBookmarks(currentBookmarks, book.bookmarks);
    const nextAnnotations = mergeAnnotations(currentAnnotations, book.annotations);
    if (nextBookmarks.length === 0 && nextAnnotations.length === 0) continue;

    restoredBookCount += 1;
    if (nextBookmarks.length > 0) {
      updates.set(bookmarksPreferenceKey(book.bookId), JSON.stringify(nextBookmarks));
    }
    if (nextAnnotations.length > 0) {
      updates.set(annotationsPreferenceKey(book.bookId), JSON.stringify(nextAnnotations));
    }
    if (book.title && book.title !== book.bookId) {
      updates.set(
        noteMetaPreferenceKey(book.bookId),
        JSON.stringify({
          title: book.title,
          author: book.author,
          series: book.series,
        }),
      );
    }
  }

  return { updates, restoredBookCount };
}

export function safeExportSlug(title: string): string {
  return title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'book';
}

export async function copyTextWithExecFallback(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to execCommand fallback below.
  }

  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    return false;
  }

  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  try {
    field.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

export async function exportTextDocument(options: {
  filename: string;
  content: string;
  mimeType: string;
  copy?: boolean;
  copiedLabel?: string;
}): Promise<ExportDocumentResult> {
  const {
    filename,
    content,
    mimeType,
    copy = false,
    copiedLabel = 'Copied to clipboard.',
  } = options;

  if (copy) {
    const copied = await copyTextWithExecFallback(content);
    if (copied) {
      return { ok: true, message: copiedLabel, fallbackText: '' };
    }
    return {
      ok: false,
      message: 'Clipboard is unavailable. Select and copy the text from the field below.',
      fallbackText: content,
    };
  }

  try {
    if (Capacitor.isNativePlatform()) {
      await Filesystem.writeFile({
        path: filename,
        data: content,
        directory: Directory.Documents,
        encoding: Encoding.UTF8,
      });
      return {
        ok: true,
        message: `Saved to Documents as ${filename}.`,
        fallbackText: '',
      };
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return {
      ok: true,
      message: `Downloaded ${filename}.`,
      fallbackText: '',
    };
  } catch {
    const copied = await copyTextWithExecFallback(content);
    return {
      ok: false,
      message: copied
        ? 'Could not write to Documents; copied to clipboard instead. You can also copy from the field below.'
        : 'Could not write to Documents. Copy the exported text from the field below.',
      fallbackText: content,
    };
  }
}
