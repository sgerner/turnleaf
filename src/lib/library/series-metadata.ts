import type { BookRecord } from '../database/database';

/**
 * Kavita uses -100000 for loose-leaf/default entries and 100000 for specials.
 * Only finite non-negative numbers below the special sentinel represent real
 * reading sequence positions.
 */
export const KAVITA_SPECIAL_NUMBER_SENTINEL = 100_000;

export type LibrarySortOrder = 'title' | 'author' | 'recent';

export interface ContinueReadingSelection {
  book: BookRecord;
  reason: 'in-progress' | 'next-in-series';
}

const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

const STRIPPED_SYNOPSIS_SELECTOR = [
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'svg',
  'math',
  'canvas',
  'audio',
  'video',
  'source',
  'track',
  'head',
  'title',
  'meta',
  'link',
  'base',
  'form',
  'input',
  'button',
  'select',
  'textarea',
].join(',');

const BLOCK_SYNOPSIS_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tr',
  'ul',
]);

export function usableSequenceNumber(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value >= KAVITA_SPECIAL_NUMBER_SENTINEL) return null;
  return value;
}

export function compareNaturalText(a: string, b: string): number {
  const primary = naturalCollator.compare(a, b);
  if (primary !== 0) return primary;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareOptionalSequence(a: number | null, b: number | null): number {
  if (a !== null && b !== null) return a - b;
  if (a !== null) return -1;
  if (b !== null) return 1;
  return 0;
}

export function sameBookSeries(
  a: Pick<BookRecord, 'id' | 'serverId' | 'seriesId' | 'series'>,
  b: Pick<BookRecord, 'id' | 'serverId' | 'seriesId' | 'series'>,
): boolean {
  if (a.serverId !== b.serverId) return false;
  if (a.series && b.series) {
    return a.seriesId === b.seriesId || naturalCollator.compare(a.series, b.series) === 0;
  }
  if (!a.series && !b.series) {
    const expectedPrefix = `${a.serverId}:${a.seriesId}:`;
    return (
      a.seriesId === b.seriesId &&
      a.id.startsWith(expectedPrefix) &&
      b.id.startsWith(expectedPrefix)
    );
  }
  return a.seriesId === b.seriesId;
}

/**
 * Order two books within the same series using persisted Kavita sequence
 * metadata first and numeric title collation second.
 */
export function compareBooksInSeries(
  a: Pick<BookRecord, 'id' | 'title' | 'volumeNumber' | 'sortOrder' | 'minNumber'>,
  b: Pick<BookRecord, 'id' | 'title' | 'volumeNumber' | 'sortOrder' | 'minNumber'>,
): number {
  const aVolume = usableSequenceNumber(a.volumeNumber);
  const bVolume = usableSequenceNumber(b.volumeNumber);
  const aSort = usableSequenceNumber(a.sortOrder);
  const bSort = usableSequenceNumber(b.sortOrder);
  const aMin = usableSequenceNumber(a.minNumber);
  const bMin = usableSequenceNumber(b.minNumber);

  // Positive volume numbers order multi-volume series directly while keeping
  // specials (normalized to null) after numbered volumes.
  const aPositiveVol = aVolume !== null && aVolume > 0 ? aVolume : null;
  const bPositiveVol = bVolume !== null && bVolume > 0 ? bVolume : null;
  if (aPositiveVol !== null || bPositiveVol !== null) {
    const volumeDiff = compareOptionalSequence(aPositiveVol, bPositiveVol);
    if (volumeDiff !== 0) return volumeDiff;
  } else if (aVolume !== null || bVolume !== null) {
    const volumeDiff = compareOptionalSequence(aVolume, bVolume);
    if (volumeDiff !== 0) return volumeDiff;
  }

  const sortDiff = compareOptionalSequence(aSort, bSort);
  if (sortDiff !== 0) return sortDiff;

  const minDiff = compareOptionalSequence(aMin, bMin);
  if (minDiff !== 0) return minDiff;

  const titleDiff = compareNaturalText(a.title, b.title);
  if (titleDiff !== 0) return titleDiff;

  return compareNaturalText(a.id, b.id);
}

function seriesGroupLabel(book: Pick<BookRecord, 'series' | 'title'>): string {
  return book.series?.trim() || book.title;
}

export function sortLibraryBooks(
  books: readonly BookRecord[],
  sortOrder: LibrarySortOrder,
): BookRecord[] {
  return [...books].sort((a, b) => {
    if (sortOrder === 'recent') {
      const readDiff = (b.lastReadAt ?? '').localeCompare(a.lastReadAt ?? '');
      if (readDiff !== 0) return readDiff;
      if (sameBookSeries(a, b)) return compareBooksInSeries(a, b);
      return (
        compareNaturalText(seriesGroupLabel(a), seriesGroupLabel(b)) || compareBooksInSeries(a, b)
      );
    }

    if (sortOrder === 'author') {
      const authorDiff = compareNaturalText(a.author ?? '', b.author ?? '');
      if (authorDiff !== 0) return authorDiff;
    }

    if (sameBookSeries(a, b)) return compareBooksInSeries(a, b);

    const groupDiff = compareNaturalText(seriesGroupLabel(a), seriesGroupLabel(b));
    if (groupDiff !== 0) return groupDiff;

    return compareBooksInSeries(a, b);
  });
}

function formatSequenceDisplay(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

export function bookSequenceNumber(
  book: Pick<BookRecord, 'volumeNumber' | 'minNumber' | 'sortOrder'>,
): number | null {
  const volume = usableSequenceNumber(book.volumeNumber);
  if (volume !== null && volume > 0) return volume;
  const min = usableSequenceNumber(book.minNumber);
  if (min !== null && min > 0) return min;
  const sort = usableSequenceNumber(book.sortOrder);
  if (sort !== null && sort > 0) return sort;
  return null;
}

export function formatSeriesLabel(
  book: Pick<BookRecord, 'series' | 'volumeNumber' | 'minNumber' | 'sortOrder'>,
): string | null {
  const series = book.series?.trim();
  if (!series) return null;
  const number = bookSequenceNumber(book);
  return number !== null ? `${series} · Vol. ${formatSequenceDisplay(number)}` : series;
}

export function formatFileSize(bytes: number | null | undefined): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb < 10 ? Number(kb.toFixed(1)) : Math.round(kb)} KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${Number(mb.toFixed(1))} MB`;
  }
  const gb = mb / 1024;
  return `${Number(gb.toFixed(2))} GB`;
}

function stripUnsafeControlCharacters(value: string): string {
  let result = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (
      code === 0x09 ||
      code === 0x0a ||
      (code >= 0x20 && code !== 0x7f && (code < 0x80 || code > 0x9f))
    ) {
      result += char;
    }
  }
  return result;
}

function collectPlainText(node: Node, chunks: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    chunks.push(node.nodeValue ?? '');
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (tag === 'br') {
    chunks.push('\n');
    return;
  }
  if (tag === 'li') {
    chunks.push('\n• ');
    for (const child of element.childNodes) {
      collectPlainText(child, chunks);
    }
    return;
  }
  const isBlock = BLOCK_SYNOPSIS_TAGS.has(tag);
  if (isBlock) chunks.push('\n');
  for (const child of element.childNodes) {
    collectPlainText(child, chunks);
  }
  if (isBlock) chunks.push('\n');
}

/**
 * Convert stored Kavita HTML descriptions into safe plain text at the render
 * boundary. Parsing into an unattached DOMParser document keeps scripts inert
 * and prevents remote image/stylesheet fetches.
 */
export function sanitizeSynopsisToPlainText(descriptionHtml: string | null | undefined): string {
  if (!descriptionHtml || !descriptionHtml.trim()) return '';
  if (typeof DOMParser === 'undefined') return '';

  const parsed = new DOMParser().parseFromString(descriptionHtml, 'text/html');
  for (const forbidden of parsed.querySelectorAll(STRIPPED_SYNOPSIS_SELECTOR)) {
    forbidden.remove();
  }

  const chunks: string[] = [];
  if (parsed.body) {
    for (const child of parsed.body.childNodes) {
      collectPlainText(child, chunks);
    }
  }

  const raw = stripUnsafeControlCharacters(chunks.join('').replace(/\r\n?/g, '\n'));
  return raw
    .split('\n')
    .map((line) => line.replace(/[\t \u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function isBookCompleted(book: Pick<BookRecord, 'pages' | 'pagesRead'>): boolean {
  return book.pages > 0 && book.pagesRead >= book.pages;
}

export function isBookAccessible(
  book: Pick<BookRecord, 'downloadPath' | 'remoteAvailable'>,
  offline: boolean,
): boolean {
  if (offline) return Boolean(book.downloadPath);
  return Boolean(book.downloadPath) || book.remoteAvailable !== false;
}

export function findNextSeriesBook(
  books: readonly BookRecord[],
  current: BookRecord,
  options: { offline?: boolean; unreadOnly?: boolean } = {},
): BookRecord | null {
  const offline = options.offline === true;
  const unreadOnly = options.unreadOnly === true;

  const seriesPeers = books.filter((book) => sameBookSeries(book, current));
  if (seriesPeers.length <= 1) return null;

  const ordered = [...seriesPeers].sort(compareBooksInSeries);
  const currentIndex = ordered.findIndex((book) => book.id === current.id);
  if (currentIndex < 0) return null;

  for (let index = currentIndex + 1; index < ordered.length; index += 1) {
    const candidate = ordered[index];
    if (!candidate) continue;
    if (!isBookAccessible(candidate, offline)) continue;
    if (unreadOnly && isBookCompleted(candidate)) continue;
    return candidate;
  }
  return null;
}

/**
 * Select the highest-value book for Continue reading:
 * - Surfaces the most recently read in-progress book (including remote-only
 *   books when online so cross-device reading resumes in one tap).
 * - When the most recently touched book was completed, surfaces the next
 *   unread volume in that series if available.
 */
export function selectContinueBook(
  books: readonly BookRecord[],
  offline: boolean,
): ContinueReadingSelection | null {
  let latestCandidate: {
    selection: ContinueReadingSelection;
    timestamp: string;
    downloaded: boolean;
  } | null = null;
  let undatedInProgress: BookRecord | null = null;

  for (const book of books) {
    const inProgress = book.pages > 0 && book.pagesRead > 0 && book.pagesRead < book.pages;
    if (inProgress && isBookAccessible(book, offline)) {
      if (book.lastReadAt) {
        const candidate = {
          selection: { book, reason: 'in-progress' as const },
          timestamp: book.lastReadAt,
          downloaded: Boolean(book.downloadPath),
        };
        if (
          !latestCandidate ||
          candidate.timestamp.localeCompare(latestCandidate.timestamp) > 0 ||
          (candidate.timestamp === latestCandidate.timestamp &&
            candidate.downloaded &&
            !latestCandidate.downloaded)
        ) {
          latestCandidate = candidate;
        }
      } else if (
        !undatedInProgress ||
        (Boolean(book.downloadPath) && !undatedInProgress.downloadPath)
      ) {
        undatedInProgress = book;
      }
      continue;
    }

    if (isBookCompleted(book) && book.lastReadAt) {
      const nextUnread = findNextSeriesBook(books, book, { offline, unreadOnly: true });
      if (!nextUnread) continue;
      const candidate = {
        selection: { book: nextUnread, reason: 'next-in-series' as const },
        timestamp: book.lastReadAt,
        downloaded: Boolean(nextUnread.downloadPath),
      };
      if (
        !latestCandidate ||
        candidate.timestamp.localeCompare(latestCandidate.timestamp) > 0 ||
        (candidate.timestamp === latestCandidate.timestamp &&
          latestCandidate.selection.reason !== 'in-progress' &&
          candidate.downloaded &&
          !latestCandidate.downloaded)
      ) {
        latestCandidate = candidate;
      }
    }
  }

  if (latestCandidate) return latestCandidate.selection;
  if (undatedInProgress) return { book: undatedInProgress, reason: 'in-progress' };
  return null;
}
