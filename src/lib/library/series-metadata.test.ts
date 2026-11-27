// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import type { BookRecord } from '../database/database';
import { issue51VolumeDetail } from '../kavita/fixtures/issue-51-volume-detail';
import { mapSeriesToBooks } from '../kavita/mapper';
import type { KavitaSeries } from '../kavita/types';
import {
  bookSequenceNumber,
  findNextSeriesBook,
  formatFileSize,
  formatSeriesLabel,
  sanitizeSynopsisToPlainText,
  selectContinueBook,
  sortLibraryBooks,
  usableSequenceNumber,
} from './series-metadata';

function makeBook(overrides: Partial<BookRecord> & Pick<BookRecord, 'id' | 'title'>): BookRecord {
  return {
    serverId: 'server',
    libraryId: 1,
    seriesId: 100,
    volumeId: 10,
    chapterId: 10,
    author: 'Author Name',
    series: 'Example Series',
    descriptionHtml: null,
    format: 'epub',
    pages: 100,
    pagesRead: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastReadAt: null,
    downloadPath: null,
    downloadStatus: 'none',
    fileSize: 1048576,
    remoteAvailable: true,
    ...overrides,
  };
}

describe('usableSequenceNumber and bookSequenceNumber', () => {
  it('accepts zero, integers, and decimals while rejecting Kavita sentinels', () => {
    expect(usableSequenceNumber(0)).toBe(0);
    expect(usableSequenceNumber(1.5)).toBe(1.5);
    expect(usableSequenceNumber(12)).toBe(12);
    expect(usableSequenceNumber(-100_000)).toBeNull();
    expect(usableSequenceNumber(-1)).toBeNull();
    expect(usableSequenceNumber(100_000)).toBeNull();
    expect(usableSequenceNumber(Number.NaN)).toBeNull();
    expect(usableSequenceNumber(null)).toBeNull();
  });

  it('prefers volumeNumber, then minNumber, then sortOrder', () => {
    expect(
      bookSequenceNumber(
        makeBook({ id: '1', title: 'Book', volumeNumber: 4, minNumber: 2, sortOrder: 1 }),
      ),
    ).toBe(4);
    expect(
      bookSequenceNumber(
        makeBook({ id: '2', title: 'Book', volumeNumber: null, minNumber: 2.5, sortOrder: 9 }),
      ),
    ).toBe(2.5);
    expect(
      bookSequenceNumber(
        makeBook({ id: '3', title: 'Book', volumeNumber: null, minNumber: null, sortOrder: 3 }),
      ),
    ).toBe(3);
  });
});

describe('sortLibraryBooks', () => {
  it('orders non-monotonic Kavita IDs from issue #51 by volume sequence and natural title', () => {
    const series: KavitaSeries = {
      id: 82,
      name: 'The Seven Great Monarchies Of The Ancient Eastern World',
      libraryId: 1,
      format: 3,
      pages: 44,
      pagesRead: 0,
      created: '2026-09-05',
      latestReadDate: '0001-01-01T00:00:00',
      coverImage: 'cover.png',
    };
    const mapped = mapSeriesToBooks('primary', series, issue51VolumeDetail);
    expect(mapped.map((book) => book.chapterId)).toEqual([1406, 1407, 1409, 1408]);

    for (const mode of ['title', 'author', 'recent'] as const) {
      expect(sortLibraryBooks(mapped, mode).map((book) => book.title)).toEqual([
        'The Seven Great Monarchies Of The Ancient Eastern World, Vol 3',
        'The Seven Great Monarchies Of The Ancient Eastern World, Vol 5',
        'The Seven Great Monarchies Of The Ancient Eastern World, Vol 6',
        'The Seven Great Monarchies Of The Ancient Eastern World, Vol 7',
      ]);
    }
  });

  it('orders multi-digit volume titles naturally when sequence metadata is absent', () => {
    const books = [
      makeBook({ id: 'b10', chapterId: 10, title: 'Vol. 10', seriesId: 5 }),
      makeBook({ id: 'b2', chapterId: 11, title: 'Vol. 2', seriesId: 5 }),
      makeBook({ id: 'b1', chapterId: 12, title: 'Vol. 1', seriesId: 5 }),
    ];

    expect(sortLibraryBooks(books, 'title').map((book) => book.title)).toEqual([
      'Vol. 1',
      'Vol. 2',
      'Vol. 10',
    ]);
  });

  it('keeps unnumbered trilogy titles grouped and ordered by persisted sortOrder across modes', () => {
    const trilogy = [
      makeBook({
        id: 'lotr-3',
        seriesId: 42,
        chapterId: 301,
        series: 'The Lord of the Rings',
        author: 'J. R. R. Tolkien',
        title: 'The Return of the King',
        sortOrder: 3,
        lastReadAt: '2026-09-02T00:00:00.000Z',
      }),
      makeBook({
        id: 'lotr-1',
        seriesId: 42,
        chapterId: 303,
        series: 'The Lord of the Rings',
        author: 'J. R. R. Tolkien',
        title: 'The Fellowship of the Ring',
        sortOrder: 1,
        lastReadAt: '2026-09-02T00:00:00.000Z',
      }),
      makeBook({
        id: 'lotr-2',
        seriesId: 42,
        chapterId: 302,
        series: 'The Lord of the Rings',
        author: 'J. R. R. Tolkien',
        title: 'The Two Towers',
        sortOrder: 2,
        lastReadAt: '2026-09-02T00:00:00.000Z',
      }),
      makeBook({
        id: 'interloper',
        seriesId: 99,
        chapterId: 400,
        series: null,
        author: 'J. R. R. Tolkien',
        title: 'The Hobbit',
        sortOrder: null,
      }),
    ];

    expect(sortLibraryBooks(trilogy, 'title').map((book) => book.title)).toEqual([
      'The Hobbit',
      'The Fellowship of the Ring',
      'The Two Towers',
      'The Return of the King',
    ]);
    expect(sortLibraryBooks(trilogy, 'author').map((book) => book.title)).toEqual([
      'The Hobbit',
      'The Fellowship of the Ring',
      'The Two Towers',
      'The Return of the King',
    ]);
    expect(sortLibraryBooks(trilogy, 'recent').map((book) => book.title)).toEqual([
      'The Fellowship of the Ring',
      'The Two Towers',
      'The Return of the King',
      'The Hobbit',
    ]);
  });

  it('sorts specials without sequence numbers after numbered series volumes', () => {
    const books = [
      makeBook({ id: 'special', chapterId: 1, title: 'Bonus Side Story', volumeNumber: null }),
      makeBook({ id: 'vol-2', chapterId: 2, title: 'Book Two', volumeNumber: 2 }),
      makeBook({ id: 'vol-1', chapterId: 3, title: 'Book One', volumeNumber: 1 }),
    ];

    expect(sortLibraryBooks(books, 'title').map((book) => book.id)).toEqual([
      'vol-1',
      'vol-2',
      'special',
    ]);
  });
});

describe('formatSeriesLabel and formatFileSize', () => {
  it('formats series names with integer or fractional volume numbers and omits standalone labels', () => {
    expect(
      formatSeriesLabel(
        makeBook({ id: '1', title: 'Dune Messiah', series: 'Dune', volumeNumber: 2 }),
      ),
    ).toBe('Dune · Vol. 2');
    expect(
      formatSeriesLabel(makeBook({ id: '2', title: 'Novella', series: 'Expanse', minNumber: 1.5 })),
    ).toBe('Expanse · Vol. 1.5');
    expect(
      formatSeriesLabel(
        makeBook({ id: '3', title: 'Fellowship', series: 'Lord of the Rings', volumeNumber: null }),
      ),
    ).toBe('Lord of the Rings');
    expect(
      formatSeriesLabel(makeBook({ id: '4', title: 'Standalone', series: null, volumeNumber: 1 })),
    ).toBeNull();
  });

  it('formats human-readable byte sizes and returns null when unknown', () => {
    expect(formatFileSize(null)).toBeNull();
    expect(formatFileSize(0)).toBeNull();
    expect(formatFileSize(-50)).toBeNull();
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(2_621_440)).toBe('2.5 MB');
  });
});

describe('sanitizeSynopsisToPlainText', () => {
  it('strips scripts, styles, remote media, and markup into safe plain text without network activity', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const hostile = [
      '<style>body { background: url("https://evil.example/leak.css"); }</style>',
      '<script>window.__pwned = true; fetch("https://evil.example/pwn");</script>',
      '<p>First <strong>paragraph</strong> with <em>emphasis</em>.</p>',
      '<img src="https://evil.example/tracker.png" onerror="alert(1)" alt="ignored">',
      '<svg onload="alert(2)"><text>svg text</text></svg>',
      '<iframe src="https://evil.example/frame"></iframe>',
      '<ul><li>Item one</li><li>Item two</li></ul>',
    ].join('');

    const sanitized = sanitizeSynopsisToPlainText(hostile);
    expect(sanitized).toBe('First paragraph with emphasis.\n\n• Item one\n• Item two');
    expect(sanitized).not.toContain('<');
    expect(sanitized).not.toContain('evil.example');
    expect(sanitized).not.toContain('svg text');
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

describe('findNextSeriesBook and selectContinueBook', () => {
  const vol1 = makeBook({
    id: 'vol-1',
    seriesId: 10,
    chapterId: 101,
    title: 'Volume One',
    volumeNumber: 1,
    pages: 100,
    pagesRead: 100,
    lastReadAt: '2026-09-10T10:00:00.000Z',
    downloadPath: 'books/vol-1.epub',
  });
  const vol2 = makeBook({
    id: 'vol-2',
    seriesId: 10,
    chapterId: 102,
    title: 'Volume Two',
    volumeNumber: 2,
    pages: 120,
    pagesRead: 0,
    lastReadAt: null,
    downloadPath: null,
    remoteAvailable: true,
  });
  const vol3 = makeBook({
    id: 'vol-3',
    seriesId: 10,
    chapterId: 103,
    title: 'Volume Three',
    volumeNumber: 3,
    pages: 130,
    pagesRead: 0,
    lastReadAt: null,
    downloadPath: 'books/vol-3.epub',
    remoteAvailable: true,
  });

  it('finds the next unread accessible volume in sequence', () => {
    expect(
      findNextSeriesBook([vol3, vol1, vol2], vol1, { offline: false, unreadOnly: true })?.id,
    ).toBe('vol-2');
    expect(
      findNextSeriesBook([vol3, vol1, vol2], vol1, { offline: true, unreadOnly: true })?.id,
    ).toBe('vol-3');
  });

  it('surfaces remote in-progress books when online and hides remote-only books when offline', () => {
    const remoteInProgress = makeBook({
      id: 'remote-active',
      seriesId: 20,
      chapterId: 201,
      title: 'Remote Active',
      pages: 200,
      pagesRead: 45,
      lastReadAt: '2026-09-11T12:00:00.000Z',
      downloadPath: null,
      remoteAvailable: true,
    });

    expect(selectContinueBook([vol1, vol2, remoteInProgress], false)).toEqual({
      book: remoteInProgress,
      reason: 'in-progress',
    });
    expect(selectContinueBook([remoteInProgress], true)).toBeNull();
  });

  it('surfaces the next unread volume in Continue reading after completing the previous volume', () => {
    expect(selectContinueBook([vol1, vol2, vol3], false)).toEqual({
      book: vol2,
      reason: 'next-in-series',
    });
    expect(selectContinueBook([vol1, vol2, vol3], true)).toEqual({
      book: vol3,
      reason: 'next-in-series',
    });
  });

  it('keeps distinct Kavita series with identical names isolated in continuation and sorting', () => {
    const authorAVol1 = makeBook({
      id: 'server:10:101',
      seriesId: 10,
      chapterId: 101,
      author: 'Ursula K. Le Guin',
      series: 'Collected Stories',
      title: 'Volume One',
      volumeNumber: 1,
      pages: 100,
      pagesRead: 100,
      lastReadAt: '2026-09-12T10:00:00.000Z',
      downloadPath: 'books/a-vol-1.epub',
    });
    const authorBVol2 = makeBook({
      id: 'server:20:202',
      seriesId: 20,
      chapterId: 202,
      author: 'Ted Chiang',
      series: 'Collected Stories',
      title: 'Volume Two',
      volumeNumber: 2,
      pages: 150,
      pagesRead: 0,
      lastReadAt: null,
      downloadPath: 'books/b-vol-2.epub',
    });

    expect(
      findNextSeriesBook([authorAVol1, authorBVol2], authorAVol1, { offline: false }),
    ).toBeNull();
    expect(selectContinueBook([authorAVol1, authorBVol2], false)).toBeNull();
  });

  it('reports in-progress reason when the next unread volume after a completed book already has partial progress', () => {
    const reMarkedVol1 = { ...vol1, lastReadAt: '2026-09-15T10:00:00.000Z' };
    const startedVol2 = {
      ...vol2,
      pagesRead: 30,
      lastReadAt: '2026-09-14T10:00:00.000Z',
      downloadPath: 'books/vol-2.epub',
    };

    expect(selectContinueBook([reMarkedVol1, startedVol2, vol3], false)).toEqual({
      book: startedVol2,
      reason: 'in-progress',
    });
  });
});
