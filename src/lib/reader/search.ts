export interface ReaderSearchExcerptSegment {
  text: string;
  match: boolean;
}

export interface ReaderSearchResult {
  cfi: string;
  excerpt: string;
  segments: ReaderSearchExcerptSegment[];
  href: string;
  spineIndex: number;
}

export interface ReaderSearchCursor {
  sectionIndex: number;
  matchIndex: number;
}

export interface ReaderSearchBatch {
  results: ReaderSearchResult[];
  scannedChapters: number;
  skippedChapters: number;
  totalChapters: number;
  nextCursor: ReaderSearchCursor | null;
}

function escapeSearchPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeReaderSearchQuery(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function clipReaderSearchExcerpt(value: string, limit = 180, query = ''): string {
  const excerpt = value.replace(/\s+/g, ' ').trim();
  if (limit <= 0) return '';
  if (excerpt.length <= limit) return excerpt;

  const normalizedQuery = normalizeReaderSearchQuery(query);
  const match = normalizedQuery
    ? new RegExp(escapeSearchPattern(normalizedQuery), 'i').exec(excerpt)
    : null;

  if (!match) {
    const start = Math.max(0, Math.floor((excerpt.length - limit) / 2));
    return `…${excerpt.slice(start, start + Math.max(0, limit - 2))}…`;
  }

  if (limit === 1) return '…';
  if (limit === 2) return `${excerpt.slice(match.index, match.index + 1)}…`;

  const matchStart = match.index;
  const matchLength = match[0].length;
  const matchEnd = matchStart + matchLength;
  const bodyLimit = limit - 2;
  const centeredStart = Math.min(
    matchStart,
    Math.floor(matchStart + (matchLength - bodyLimit) / 2),
  );

  if (centeredStart <= 0) {
    return `${excerpt.slice(0, limit - 1)}…`;
  }

  const tailStart = excerpt.length - (limit - 1);
  if (
    centeredStart + bodyLimit >= excerpt.length ||
    (matchEnd === excerpt.length && tailStart <= matchStart)
  ) {
    return `…${excerpt.slice(tailStart)}`;
  }

  return `…${excerpt.slice(centeredStart, centeredStart + bodyLimit)}…`;
}

export function splitReaderSearchExcerpt(
  excerpt: string,
  query: string,
): ReaderSearchExcerptSegment[] {
  if (!excerpt) return [];
  const normalizedQuery = normalizeReaderSearchQuery(query);
  if (!normalizedQuery) return [{ text: excerpt, match: false }];

  const pattern = new RegExp(escapeSearchPattern(normalizedQuery), 'gi');
  const segments: ReaderSearchExcerptSegment[] = [];
  let cursor = 0;

  for (const match of excerpt.matchAll(pattern)) {
    const start = match.index ?? 0;
    const matchedText = match[0];
    if (!matchedText) continue;
    if (start > cursor) {
      segments.push({ text: excerpt.slice(cursor, start), match: false });
    }
    segments.push({ text: matchedText, match: true });
    cursor = start + matchedText.length;
  }

  if (cursor < excerpt.length) {
    segments.push({ text: excerpt.slice(cursor), match: false });
  }

  return segments.length > 0 ? segments : [{ text: excerpt, match: false }];
}
