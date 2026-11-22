import type { BookRecord } from '../database/database';

export type LibrarySortOrder = 'title' | 'author' | 'recent';

export function isBookDisplayable(book: BookRecord): boolean {
  return book.remoteAvailable !== false || Boolean(book.downloadPath);
}

export function normalizeLibrarySearch(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function buildBookIndexById(books: readonly BookRecord[]): Map<string, number> {
  const indexById = new Map<string, number>();
  for (let index = 0; index < books.length; index += 1) {
    indexById.set(books[index]!.id, index);
  }
  return indexById;
}

export function buildDisplayableIndices(books: readonly BookRecord[]): number[] {
  const indices: number[] = [];
  for (let index = 0; index < books.length; index += 1) {
    if (isBookDisplayable(books[index]!)) indices.push(index);
  }
  return indices;
}

export function collectDisplayableAuthors(
  books: readonly BookRecord[],
  displayableIndices: readonly number[],
): string[] {
  const unique = new Set<string>();
  for (const index of displayableIndices) {
    const author = books[index]?.author;
    if (author) unique.add(author);
  }
  return [...unique].sort((a, b) => a.localeCompare(b));
}

export function collectDisplayableSeries(
  books: readonly BookRecord[],
  displayableIndices: readonly number[],
): string[] {
  const unique = new Set<string>();
  for (const index of displayableIndices) {
    const series = books[index]?.series;
    if (series) unique.add(series);
  }
  return [...unique].sort((a, b) => a.localeCompare(b));
}

export function buildSearchableTextById(
  books: readonly BookRecord[],
  displayableIndices: readonly number[],
): Map<string, string> {
  const entries = new Map<string, string>();
  for (const index of displayableIndices) {
    const book = books[index]!;
    entries.set(
      book.id,
      normalizeLibrarySearch(`${book.title} ${book.author ?? ''} ${book.series ?? ''}`),
    );
  }
  return entries;
}

export function sortDisplayableIndices(
  books: readonly BookRecord[],
  displayableIndices: readonly number[],
  sortOrder: LibrarySortOrder,
): number[] {
  return [...displayableIndices].sort((leftIndex, rightIndex) =>
    compareCatalogBooks(books[leftIndex]!, books[rightIndex]!, sortOrder),
  );
}

export function areBookRecordsEqual(left: BookRecord, right: BookRecord): boolean {
  return (
    left === right ||
    (left.id === right.id &&
      left.serverId === right.serverId &&
      left.libraryId === right.libraryId &&
      left.seriesId === right.seriesId &&
      left.volumeId === right.volumeId &&
      left.chapterId === right.chapterId &&
      left.title === right.title &&
      left.author === right.author &&
      left.series === right.series &&
      left.descriptionHtml === right.descriptionHtml &&
      left.format === right.format &&
      left.pages === right.pages &&
      left.pagesRead === right.pagesRead &&
      left.createdAt === right.createdAt &&
      left.lastReadAt === right.lastReadAt &&
      left.downloadPath === right.downloadPath &&
      left.downloadStatus === right.downloadStatus &&
      left.fileSize === right.fileSize &&
      (left.remoteAvailable !== false) === (right.remoteAvailable !== false))
  );
}

export function areBookListsEqual(
  left: readonly BookRecord[],
  right: readonly BookRecord[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!areBookRecordsEqual(left[index]!, right[index]!)) return false;
  }
  return true;
}

export function haveSameBookIdsByIndex(
  left: readonly BookRecord[],
  right: readonly BookRecord[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]!.id !== right[index]!.id) return false;
  }
  return true;
}

export function haveSameBookStructure(left: BookRecord, right: BookRecord): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.author === right.author &&
    left.series === right.series &&
    isBookDisplayable(left) === isBookDisplayable(right)
  );
}

export function haveSameCatalogStructure(
  left: readonly BookRecord[],
  right: readonly BookRecord[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!haveSameBookStructure(left[index]!, right[index]!)) return false;
  }
  return true;
}

export function haveSameRecentSortKeys(
  left: readonly BookRecord[],
  right: readonly BookRecord[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (isBookDisplayable(b) && a.lastReadAt !== b.lastReadAt) return false;
  }
  return true;
}

export function compareCatalogBooks(
  a: BookRecord,
  b: BookRecord,
  sortOrder: LibrarySortOrder,
): number {
  if (sortOrder === 'recent') {
    return (b.lastReadAt ?? '').localeCompare(a.lastReadAt ?? '') || a.title.localeCompare(b.title);
  }
  if (sortOrder === 'author') {
    return (
      (a.author ?? '').localeCompare(b.author ?? '') ||
      a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id)
    );
  }
  return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

export function replaceBookAtIndex(
  books: readonly BookRecord[],
  index: number,
  next: BookRecord,
): BookRecord[] {
  const updated = books.slice();
  updated[index] = next;
  return updated;
}
