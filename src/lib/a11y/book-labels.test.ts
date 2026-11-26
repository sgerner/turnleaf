import { describe, expect, it } from 'vitest';
import {
  bookActionsLabel,
  downloadProgressLabel,
  downloadProgressValueText,
  openBookLabel,
  type BookLabelTarget,
} from './book-labels';

function makeBook(overrides: Partial<BookLabelTarget> = {}): BookLabelTarget {
  return {
    id: 'primary:10:100',
    title: 'Vol 3',
    author: 'George Rawlinson',
    series: 'The Seven Great Monarchies',
    pages: 200,
    pagesRead: 0,
    downloadPath: null,
    remoteAvailable: true,
    ...overrides,
  };
}

describe('book accessibility labels', () => {
  it('starts labels with the visible control action and disambiguates by author and distinct series', () => {
    const book = makeBook();

    expect(openBookLabel(book)).toBe('Open Vol 3, by George Rawlinson, The Seven Great Monarchies');
    expect(bookActionsLabel(book)).toBe(
      'Book actions for Vol 3, by George Rawlinson, The Seven Great Monarchies',
    );
    expect(downloadProgressLabel(book)).toBe(
      'Download progress for Vol 3, by George Rawlinson, The Seven Great Monarchies',
    );
  });

  it('suppresses duplicate series names that match the book title', () => {
    const exactMatch = makeBook({
      title: 'Foundation',
      author: 'Isaac Asimov',
      series: 'Foundation',
    });
    const caseAndWhitespaceMatch = makeBook({
      title: 'Foundation',
      author: 'Isaac Asimov',
      series: '  foundation  ',
    });

    expect(openBookLabel(exactMatch)).toBe('Open Foundation, by Isaac Asimov');
    expect(bookActionsLabel(exactMatch)).toBe('Book actions for Foundation, by Isaac Asimov');
    expect(downloadProgressLabel(caseAndWhitespaceMatch)).toBe(
      'Download progress for Foundation, by Isaac Asimov',
    );
  });

  it('omits null or blank authors cleanly while preserving offline and reading progress text', () => {
    const nullAuthor = makeBook({
      title: 'Turnleaf CI EPUB',
      author: null,
      series: null,
      downloadPath: 'books/primary-1-1.epub',
      pages: 2,
      pagesRead: 1,
    });
    const blankAuthorWithSeries = makeBook({
      title: 'Book One',
      author: '   ',
      series: 'Archive Collection',
    });

    expect(openBookLabel(nullAuthor)).toBe(
      'Open Turnleaf CI EPUB, downloaded for offline reading, 50% complete',
    );
    expect(openBookLabel(nullAuthor, false)).toBe(
      'Open Turnleaf CI EPUB, downloaded for offline reading',
    );
    expect(openBookLabel(nullAuthor, { includeProgress: false })).toBe(
      'Open Turnleaf CI EPUB, downloaded for offline reading',
    );
    expect(openBookLabel(blankAuthorWithSeries)).toBe('Open Book One, Archive Collection');
    expect(bookActionsLabel(blankAuthorWithSeries)).toBe(
      'Book actions for Book One, Archive Collection',
    );
  });

  it('exposes server removal status on open and book actions labels', () => {
    const removedBook = makeBook({
      title: 'Seascraper',
      author: 'Benjamin Wood',
      series: null,
      downloadPath: 'books/seascraper.epub',
      pages: 100,
      pagesRead: 40,
      remoteAvailable: false,
    });

    expect(openBookLabel(removedBook)).toBe(
      'Open Seascraper, by Benjamin Wood, downloaded for offline reading, removed from server, 40% complete',
    );
    expect(bookActionsLabel(removedBook)).toBe(
      'Book actions for Seascraper, by Benjamin Wood, removed from server',
    );
  });

  it('exposes outdated download status on open and book actions labels when still available on server', () => {
    const outdatedBook = makeBook({
      title: 'Expanded Edition',
      author: 'Ursula K. Le Guin',
      series: 'Hainish Cycle',
      downloadPath: 'books/expanded.epub',
      downloadOutdated: true,
      pages: 25,
      pagesRead: 4,
      remoteAvailable: true,
    });

    expect(openBookLabel(outdatedBook)).toBe(
      'Open Expanded Edition, by Ursula K. Le Guin, Hainish Cycle, downloaded for offline reading, update available, 16% complete',
    );
    expect(bookActionsLabel(outdatedBook)).toBe(
      'Book actions for Expanded Edition, by Ursula K. Le Guin, Hainish Cycle, update available',
    );
  });

  it('exposes indeterminate and percentage download progress states', () => {
    const book = makeBook({
      id: 'primary:7:7',
      title: 'Seascraper',
      author: 'Benjamin Wood',
      series: null,
    });

    expect(downloadProgressValueText(null)).toBe('Download in progress');
    expect(downloadProgressValueText(undefined)).toBe('Download in progress');
    expect(downloadProgressValueText(0)).toBe('0% downloaded');
    expect(downloadProgressValueText(64)).toBe('64% downloaded');

    expect(openBookLabel(book, { downloadingBookId: 'primary:7:7', downloadPercent: null })).toBe(
      'Open Seascraper, by Benjamin Wood, download in progress',
    );
    expect(openBookLabel(book, { downloadingBookId: 'primary:7:7', downloadPercent: 64 })).toBe(
      'Open Seascraper, by Benjamin Wood, 64% downloaded',
    );
    expect(
      bookActionsLabel(book, { downloadingBookId: 'primary:7:7', downloadPercent: null }),
    ).toBe('Book actions for Seascraper, by Benjamin Wood, download in progress');
    expect(bookActionsLabel(book, { downloadingBookId: 'primary:7:7', downloadPercent: 64 })).toBe(
      'Book actions for Seascraper, by Benjamin Wood, 64% downloaded',
    );
    expect(openBookLabel(book, { downloadingBookId: 'other:1:1', downloadPercent: 64 })).toBe(
      'Open Seascraper, by Benjamin Wood',
    );
  });
});
