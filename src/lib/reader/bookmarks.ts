export interface StoredReaderLocation {
  id: string;
  cfi: string;
  href: string;
  percentage: number;
  label: string;
  savedAt: string;
}

export const MAX_BOOKMARKS = 100;
const MAX_HISTORY = 12;

export const READER_PREFERENCE_PREFIXES = [
  'readerBookmarks:',
  'readerAnnotations:',
  'readerHistory:',
] as const;

export type ReaderPreferencePrefix = (typeof READER_PREFERENCE_PREFIXES)[number];

export function hasNonEmptyReaderPreferenceValue(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.trim() !== '' && value.trim() !== '[]';
}

function parseJsonArray(raw: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function mergeReaderPreferenceValue(
  prefix: ReaderPreferencePrefix,
  oldRaw: string | undefined,
  newRaw: string | undefined,
): string | undefined {
  if (oldRaw === undefined) return newRaw;
  if (newRaw === undefined) return oldRaw;
  if (!hasNonEmptyReaderPreferenceValue(oldRaw)) return newRaw;
  if (!hasNonEmptyReaderPreferenceValue(newRaw)) return oldRaw;
  const oldParsed = parseJsonArray(oldRaw);
  const newParsed = parseJsonArray(newRaw);
  if (!oldParsed && !newParsed) return newRaw;
  if (!oldParsed) return newRaw;
  if (!newParsed) return oldRaw;

  if (prefix === 'readerAnnotations:') {
    const merged = new Map<string, Record<string, unknown>>();
    const keyOf = (entry: unknown, index: number): string => {
      if (!entry || typeof entry !== 'object') return `idx:${index}`;
      const record = entry as Record<string, unknown>;
      if (typeof record.cfi === 'string' && record.cfi.trim()) return `cfi:${record.cfi.trim()}`;
      if (typeof record.id === 'string' && record.id) return `id:${record.id}`;
      return `json:${JSON.stringify(record)}`;
    };
    oldParsed.forEach((entry, index) => {
      if (entry && typeof entry === 'object') {
        merged.set(keyOf(entry, index), entry as Record<string, unknown>);
      }
    });
    newParsed.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return;
      const next = entry as Record<string, unknown>;
      const key = keyOf(entry, oldParsed.length + index);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, next);
        return;
      }
      const existingDate = typeof existing.createdAt === 'string' ? existing.createdAt : '';
      const nextDate = typeof next.createdAt === 'string' ? next.createdAt : '';
      const existingNote = typeof existing.note === 'string' ? existing.note.trim() : '';
      const nextNote = typeof next.note === 'string' ? next.note.trim() : '';
      if (nextDate >= existingDate || nextNote) {
        merged.set(key, nextNote ? next : { ...next, note: existingNote || next.note });
      }
    });
    return JSON.stringify([...merged.values()]);
  }

  const merged = new Map<string, Record<string, unknown>>();
  const keyOf = (entry: unknown, index: number): string => {
    if (!entry || typeof entry !== 'object') return `idx:${index}`;
    const record = entry as Record<string, unknown>;
    if (typeof record.id === 'string' && record.id) return record.id;
    return `${String(record.cfi ?? '')}|${String(record.href ?? '')}`;
  };
  for (const [index, entry] of [...newParsed, ...oldParsed].entries()) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const key = keyOf(entry, index);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, record);
      continue;
    }
    const existingSaved = typeof existing.savedAt === 'string' ? existing.savedAt : '';
    const nextSaved = typeof record.savedAt === 'string' ? record.savedAt : '';
    if (nextSaved > existingSaved) merged.set(key, record);
  }
  const values = [...merged.values()];
  if (prefix === 'readerHistory:') {
    values.sort((a, b) => {
      const savedA = typeof a.savedAt === 'string' ? a.savedAt : '';
      const savedB = typeof b.savedAt === 'string' ? b.savedAt : '';
      return savedB.localeCompare(savedA);
    });
    return JSON.stringify(values.slice(0, MAX_HISTORY));
  }
  return JSON.stringify(values);
}

function validLocation(value: unknown): value is StoredReaderLocation {
  if (!value || typeof value !== 'object') return false;
  const location = value as Partial<StoredReaderLocation>;
  return (
    typeof location.id === 'string' &&
    typeof location.cfi === 'string' &&
    typeof location.href === 'string' &&
    typeof location.percentage === 'number' &&
    Number.isFinite(location.percentage) &&
    typeof location.label === 'string' &&
    typeof location.savedAt === 'string'
  );
}

function parseLocations(value: string | null, limit?: number): StoredReaderLocation[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const locations = parsed.filter(validLocation);
    return limit === undefined ? locations : locations.slice(0, limit);
  } catch {
    return [];
  }
}

export function parseBookmarks(value: string | null): StoredReaderLocation[] {
  return parseLocations(value);
}

export function parseLocationHistory(value: string | null): StoredReaderLocation[] {
  return parseLocations(value, MAX_HISTORY);
}

function locationLabel(percentage: number, href: string): string {
  const percent = Math.round(Math.max(0, Math.min(1, percentage)) * 100);
  const chapter = href.split('#', 1)[0]?.split('/').pop() || 'current page';
  return `${percent}% · ${chapter}`;
}

function bookmarkLocation(
  current: Omit<StoredReaderLocation, 'id' | 'savedAt' | 'label'>,
  savedAt = new Date().toISOString(),
): StoredReaderLocation {
  return {
    ...current,
    id: `${current.cfi}|${current.href}`,
    label: locationLabel(current.percentage, current.href),
    savedAt,
  };
}

export function toggleBookmark(
  bookmarks: readonly StoredReaderLocation[],
  current: Omit<StoredReaderLocation, 'id' | 'savedAt' | 'label'>,
  savedAt = new Date().toISOString(),
): StoredReaderLocation[] {
  const id = `${current.cfi}|${current.href}`;
  const existing = bookmarks.findIndex((bookmark) => bookmark.id === id);
  if (existing >= 0) return bookmarks.filter((_, index) => index !== existing);
  if (bookmarks.length >= MAX_BOOKMARKS) return [...bookmarks];
  return [bookmarkLocation(current, savedAt), ...bookmarks];
}

export function renameBookmark(
  bookmarks: readonly StoredReaderLocation[],
  id: string,
  label: string,
): StoredReaderLocation[] {
  const trimmed = label.trim();
  if (!trimmed) return [...bookmarks];
  return bookmarks.map((bookmark) =>
    bookmark.id === id ? { ...bookmark, label: trimmed } : bookmark,
  );
}

export function removeBookmark(
  bookmarks: readonly StoredReaderLocation[],
  id: string,
): StoredReaderLocation[] {
  return bookmarks.filter((bookmark) => bookmark.id !== id);
}

export function recordLocation(
  history: readonly StoredReaderLocation[],
  current: Omit<StoredReaderLocation, 'id' | 'savedAt' | 'label'>,
  savedAt = new Date().toISOString(),
): StoredReaderLocation[] {
  const entry = bookmarkLocation(current, savedAt);
  return [entry, ...history.filter((item) => item.id !== entry.id)].slice(0, MAX_HISTORY);
}
