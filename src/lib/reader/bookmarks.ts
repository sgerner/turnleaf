export interface StoredReaderLocation {
  id: string;
  cfi: string;
  href: string;
  percentage: number;
  label: string;
  savedAt: string;
  updatedAt?: string;
  remoteId?: number | null;
  xpath?: string | null;
  pageNumber?: number;
  excerpt?: string;
  remoteTitle?: string | null;
  remotePageNumber?: number | null;
  syncState?: 'synced' | 'pending_create' | 'pending_update' | 'pending_delete';
}

export const MAX_BOOKMARKS = 100;
const MAX_HISTORY = 12;

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
  current: Omit<StoredReaderLocation, 'id' | 'savedAt' | 'label'> & { label?: string },
  savedAt = new Date().toISOString(),
): StoredReaderLocation {
  const label = current.label?.trim() || locationLabel(current.percentage, current.href);
  return {
    ...current,
    id: `${current.cfi}|${current.href}`,
    label,
    savedAt,
  };
}

export function findMatchingBookmark(
  bookmarks: readonly StoredReaderLocation[],
  current: { cfi: string; href: string; xpath?: string | null | undefined },
): StoredReaderLocation | null {
  const id = `${current.cfi}|${current.href}`;
  return (
    bookmarks.find(
      (bookmark) =>
        bookmark.id === id ||
        (Boolean(current.cfi) && bookmark.cfi === current.cfi) ||
        (Boolean(current.xpath) && bookmark.xpath === current.xpath),
    ) ?? null
  );
}

export function toggleBookmark(
  bookmarks: readonly StoredReaderLocation[],
  current: Omit<StoredReaderLocation, 'id' | 'savedAt' | 'label'> & { label?: string },
  savedAt = new Date().toISOString(),
): StoredReaderLocation[] {
  const match = findMatchingBookmark(bookmarks, current);
  if (match) return bookmarks.filter((bookmark) => bookmark.id !== match.id);
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
