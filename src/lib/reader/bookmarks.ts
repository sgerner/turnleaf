export interface StoredReaderLocation {
  id: string;
  cfi: string;
  href: string;
  percentage: number;
  label: string;
  savedAt: string;
}

export interface StoredReturnLocation {
  cfi: string;
  href: string;
}

export const MAX_BOOKMARKS = 100;
const MAX_HISTORY = 12;
export const MAX_RETURN_STACK = 12;

export function returnStackPreferenceKey(bookId: string): string {
  return `readerReturnStack:${bookId}`;
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

function validReturnLocation(value: unknown): value is StoredReturnLocation {
  if (!value || typeof value !== 'object') return false;
  const location = value as Partial<StoredReturnLocation>;
  return (
    typeof location.cfi === 'string' &&
    location.cfi.trim().length > 0 &&
    typeof location.href === 'string'
  );
}

export function parseReturnStack(value: string | null): StoredReturnLocation[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(validReturnLocation)
      .map((entry) => ({ cfi: entry.cfi, href: entry.href }))
      .slice(0, MAX_RETURN_STACK);
  } catch {
    return [];
  }
}

export function pushReturnLocation(
  stack: readonly StoredReturnLocation[],
  origin: StoredReturnLocation,
): StoredReturnLocation[] {
  if (!origin.cfi.trim()) return [...stack].slice(0, MAX_RETURN_STACK);
  const entry: StoredReturnLocation = { cfi: origin.cfi, href: origin.href };
  if (stack[0]?.cfi === entry.cfi) {
    return [...stack].slice(0, MAX_RETURN_STACK);
  }
  return [entry, ...stack].slice(0, MAX_RETURN_STACK);
}

export function popReturnLocation(stack: readonly StoredReturnLocation[]): {
  target: StoredReturnLocation | null;
  remaining: StoredReturnLocation[];
} {
  if (stack.length === 0) return { target: null, remaining: [] };
  const [target, ...remaining] = stack;
  return { target: target ?? null, remaining };
}

export function reconcileRestoredReturnStack(
  stack: readonly StoredReturnLocation[],
  restoredCfi: string | null,
): StoredReturnLocation[] {
  if (!restoredCfi) return [...stack].slice(0, MAX_RETURN_STACK);
  const matchIndex = stack.findIndex((entry) => entry.cfi === restoredCfi);
  if (matchIndex < 0) return [...stack].slice(0, MAX_RETURN_STACK);
  return stack.slice(matchIndex + 1, matchIndex + 1 + MAX_RETURN_STACK);
}
