// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeMocks = vi.hoisted(() => ({
  isNative: false,
  writeFile: vi.fn(async () => ({ uri: 'file:///Documents/export.json' })),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => nativeMocks.isNative,
  },
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: {
    Documents: 'DOCUMENTS',
    Data: 'DATA',
  },
  Encoding: {
    UTF8: 'utf8',
  },
  Filesystem: {
    writeFile: nativeMocks.writeFile,
  },
}));

import {
  annotationsPreferenceKey,
  bookIdsWithSavedNotes,
  bookmarksPreferenceKey,
  bookReadingNotesMarkdown,
  buildRestorePreferencesUpdate,
  collectLibraryReadingNotes,
  exportTextDocument,
  noteMetaPreferenceKey,
  parseReadingNotesBackup,
  readingNotesBackupMarkdown,
  serializeReadingNotesBackup,
} from './notes-backup';

const sampleBookmark = {
  id: 'epubcfi(/6/2!/4/2)|ch1.xhtml',
  cfi: 'epubcfi(/6/2!/4/2)',
  href: 'ch1.xhtml',
  percentage: 0.35,
  label: 'Opening scene',
  savedAt: '2026-03-01T10:00:00.000Z',
};

const sampleAnnotation = {
  id: 'ann-1',
  cfi: 'epubcfi(/6/4!/4/8)',
  excerpt: 'Fear is the mind-killer.',
  note: 'Litany against fear',
  createdAt: '2026-03-02T12:00:00.000Z',
};

beforeEach(() => {
  nativeMocks.isNative = false;
  nativeMocks.writeFile.mockReset();
  nativeMocks.writeFile.mockResolvedValue({ uri: 'file:///Documents/export.json' });
});

describe('reading notes backup and restore helpers', () => {
  it('collects non-empty book notes and ignores empty arrays', () => {
    const prefs = new Map<string, string>([
      [bookmarksPreferenceKey('primary:1:10'), JSON.stringify([sampleBookmark])],
      [annotationsPreferenceKey('primary:1:10'), JSON.stringify([sampleAnnotation])],
      [bookmarksPreferenceKey('primary:1:11'), '[]'],
      [annotationsPreferenceKey('primary:1:11'), '[]'],
      [
        bookmarksPreferenceKey('primary:2:20'),
        JSON.stringify([
          {
            ...sampleBookmark,
            id: 'epubcfi(/6/8)|ch2.xhtml',
            cfi: 'epubcfi(/6/8)',
            href: 'ch2.xhtml',
          },
        ]),
      ],
      [
        noteMetaPreferenceKey('primary:2:20'),
        JSON.stringify({ title: 'Saved Title', author: 'Saved Author', series: 'Saved Series' }),
      ],
    ]);

    expect([...bookIdsWithSavedNotes(prefs)]).toEqual(['primary:1:10', 'primary:2:20']);

    const collected = collectLibraryReadingNotes(prefs, [
      { id: 'primary:1:10', title: 'Dune', author: 'Frank Herbert', series: 'Dune Chronicles' },
    ]);

    expect(collected).toHaveLength(2);
    expect(collected[0]).toMatchObject({
      bookId: 'primary:1:10',
      title: 'Dune',
      author: 'Frank Herbert',
      bookmarks: [sampleBookmark],
      annotations: [sampleAnnotation],
    });
    expect(collected[1]).toMatchObject({
      bookId: 'primary:2:20',
      title: 'Saved Title',
      author: 'Saved Author',
      series: 'Saved Series',
    });
  });

  it('serializes, parses, and merges JSON backups non-destructively', () => {
    const json = serializeReadingNotesBackup(
      [
        {
          bookId: 'primary:1:10',
          title: 'Dune',
          author: 'Frank Herbert',
          series: null,
          bookmarks: [sampleBookmark],
          annotations: [sampleAnnotation],
        },
      ],
      '2026-03-03T00:00:00.000Z',
    );

    const parsed = parseReadingNotesBackup(json);
    expect(parsed.books).toHaveLength(1);

    const existing = new Map<string, string>([
      [
        bookmarksPreferenceKey('primary:1:10'),
        JSON.stringify([
          {
            id: 'epubcfi(/6/6!/4/2)|ch2.xhtml',
            cfi: 'epubcfi(/6/6!/4/2)',
            href: 'ch2.xhtml',
            percentage: 0.75,
            label: 'Existing bookmark',
            savedAt: '2026-03-04T00:00:00.000Z',
          },
        ]),
      ],
    ]);

    const { updates, restoredBookCount } = buildRestorePreferencesUpdate(parsed, existing);
    expect(restoredBookCount).toBe(1);
    const mergedBookmarks = JSON.parse(updates.get(bookmarksPreferenceKey('primary:1:10')) ?? '[]');
    expect(mergedBookmarks).toHaveLength(2);
    expect(JSON.parse(updates.get(annotationsPreferenceKey('primary:1:10')) ?? '[]')).toEqual([
      sampleAnnotation,
    ]);
  });

  it('rejects malformed or unsupported backup payloads', () => {
    expect(() => parseReadingNotesBackup('{truncated')).toThrow('not valid JSON');
    expect(() => parseReadingNotesBackup('[]')).toThrow('Turnleaf notes backup object');
    expect(() => parseReadingNotesBackup('{"format":"other","version":1,"books":[]}')).toThrow(
      'Unsupported backup format',
    );
  });

  it('renders readable Markdown for single books and full libraries', () => {
    const single = bookReadingNotesMarkdown('Dune', [sampleBookmark], [sampleAnnotation], {
      author: 'Frank Herbert',
    });
    expect(single).toContain('# Reading notes for Dune');
    expect(single).toContain('## Bookmarks');
    expect(single).toContain('## Highlights and notes');
    expect(single).toContain('Litany against fear');

    const libraryMd = readingNotesBackupMarkdown(
      [
        {
          bookId: 'primary:1:10',
          title: 'Dune',
          author: 'Frank Herbert',
          series: 'Dune Chronicles',
          bookmarks: [sampleBookmark],
          annotations: [sampleAnnotation],
        },
      ],
      '2026-03-05T00:00:00.000Z',
    );
    expect(libraryMd).toContain('# Turnleaf Reading Notes');
    expect(libraryMd).toContain('## Dune');
  });

  it('falls back to clipboard and readonly text when Directory.Documents writes fail', async () => {
    nativeMocks.isNative = true;
    nativeMocks.writeFile.mockRejectedValueOnce(new Error('EACCES: Documents denied'));
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const result = await exportTextDocument({
      filename: 'notes.md',
      content: '# Notes\n',
      mimeType: 'text/markdown',
    });

    expect(result.ok).toBe(false);
    expect(writeText).toHaveBeenCalledWith('# Notes\n');
    expect(result.fallbackText).toBe('# Notes\n');
    expect(result.message).toContain('copied to clipboard instead');
  });
});
