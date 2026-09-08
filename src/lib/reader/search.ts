export interface ReaderSearchResult {
  cfi: string;
  excerpt: string;
  href: string;
  spineIndex: number;
}

export function normalizeReaderSearchQuery(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function clipReaderSearchExcerpt(value: string, limit = 180): string {
  const excerpt = value.replace(/\s+/g, ' ').trim();
  if (excerpt.length <= limit) return excerpt;
  const start = Math.max(0, Math.floor((excerpt.length - limit) / 2));
  return `…${excerpt.slice(start, start + Math.max(0, limit - 2))}…`;
}
