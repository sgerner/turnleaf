import type { BookRecord } from '../database/database';

export type BookLabelTarget = Pick<
  BookRecord,
  | 'id'
  | 'title'
  | 'author'
  | 'series'
  | 'pages'
  | 'pagesRead'
  | 'downloadPath'
  | 'downloadOutdated'
  | 'remoteAvailable'
>;

export type BookMetadataTarget = Pick<BookRecord, 'title' | 'author' | 'series'>;

export interface BookStatusOptions {
  downloadingBookId?: string | null;
  downloadPercent?: number | null;
}

export interface OpenBookLabelOptions extends BookStatusOptions {
  includeProgress?: boolean;
}

function progressPercent(book: Pick<BookRecord, 'pages' | 'pagesRead'>): number {
  return book.pages > 0 ? Math.min(100, (book.pagesRead / book.pages) * 100) : 0;
}

function metadataParts(book: BookMetadataTarget): string[] {
  const parts: string[] = [];
  const author = book.author?.trim();
  if (author) parts.push(`by ${author}`);

  const series = book.series?.trim();
  const title = book.title.trim();
  if (series && series.toLowerCase() !== title.toLowerCase()) {
    parts.push(series);
  }
  return parts;
}

function statusParts(book: BookLabelTarget, options: BookStatusOptions): string[] {
  const parts: string[] = [];
  if (book.remoteAvailable === false) {
    parts.push('removed from server');
  } else if (book.downloadPath && book.downloadOutdated) {
    parts.push('update available');
  }
  if (options.downloadingBookId === book.id) {
    parts.push(downloadProgressValueText(options.downloadPercent).toLowerCase());
  }
  return parts;
}

export function downloadProgressLabel(book: BookMetadataTarget): string {
  return [`Download progress for ${book.title}`, ...metadataParts(book)].join(', ');
}

export function downloadProgressValueText(downloadPercent: number | null | undefined): string {
  if (downloadPercent == null) return 'Download in progress';
  const clamped = Math.max(0, Math.min(100, Math.round(downloadPercent)));
  return `${clamped}% downloaded`;
}

export function openBookLabel(
  book: BookLabelTarget,
  options: OpenBookLabelOptions | boolean = {},
): string {
  const resolved: OpenBookLabelOptions =
    typeof options === 'boolean' ? { includeProgress: options } : options;
  const includeProgress = resolved.includeProgress ?? true;
  const parts = [`Open ${book.title}`, ...metadataParts(book)];

  if (book.downloadPath) {
    parts.push('downloaded for offline reading');
  }
  parts.push(...statusParts(book, resolved));

  const progress = progressPercent(book);
  if (includeProgress && progress > 0) {
    parts.push(`${Math.round(progress)}% complete`);
  }

  return parts.join(', ');
}

export function bookActionsLabel(book: BookLabelTarget, options: BookStatusOptions = {}): string {
  return [
    `Book actions for ${book.title}`,
    ...metadataParts(book),
    ...statusParts(book, options),
  ].join(', ');
}
