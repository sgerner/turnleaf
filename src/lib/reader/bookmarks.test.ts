import { describe, expect, it } from 'vitest';
import {
  MAX_BOOKMARKS,
  parseBookmarks,
  parseLocationHistory,
  recordLocation,
  removeBookmark,
  renameBookmark,
  toggleBookmark,
} from './bookmarks';

const location = { cfi: 'epubcfi(/6/2!/4/2)', href: 'chapter.xhtml', percentage: 0.25 };

describe('reader bookmarks and history', () => {
  it('toggles a CFI bookmark and preserves a custom name', () => {
    const added = toggleBookmark([], location, '2026-01-01T00:00:00.000Z');
    expect(added).toHaveLength(1);
    const renamed = renameBookmark(added, added[0]!.id, 'Chapter one');
    expect(renamed[0]?.label).toBe('Chapter one');
    expect(toggleBookmark(renamed, location)).toEqual([]);
  });

  it('stops evicting custom-named bookmarks at MAX_BOOKMARKS and keeps removal active', () => {
    let bookmarks = toggleBookmark(
      [],
      { cfi: 'epubcfi(/6/2!/4/1)', href: 'chapter-1.xhtml', percentage: 0.01 },
      '2026-01-01T00:00:00.000Z',
    );
    bookmarks = renameBookmark(bookmarks, bookmarks[0]!.id, 'Favorite opening scene');

    for (let index = 2; index <= MAX_BOOKMARKS; index += 1) {
      bookmarks = toggleBookmark(
        bookmarks,
        {
          cfi: `epubcfi(/6/2!/4/${index})`,
          href: `chapter-${index}.xhtml`,
          percentage: index / 200,
        },
        `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
      );
    }

    expect(bookmarks).toHaveLength(MAX_BOOKMARKS);
    expect(bookmarks.at(-1)?.label).toBe('Favorite opening scene');

    const overflowLocation = {
      cfi: 'epubcfi(/6/2!/4/999)',
      href: 'overflow.xhtml',
      percentage: 0.99,
    };
    const blocked = toggleBookmark(bookmarks, overflowLocation, '2026-01-02T00:00:00.000Z');
    expect(blocked).not.toBe(bookmarks);
    expect(blocked).toEqual(bookmarks);
    expect(blocked.at(-1)?.label).toBe('Favorite opening scene');

    const afterToggleRemove = toggleBookmark(bookmarks, {
      cfi: 'epubcfi(/6/2!/4/2)',
      href: 'chapter-2.xhtml',
      percentage: 0.01,
    });
    expect(afterToggleRemove).toHaveLength(MAX_BOOKMARKS - 1);
    expect(afterToggleRemove.at(-1)?.label).toBe('Favorite opening scene');

    const addedAfterFreeingSlot = toggleBookmark(
      afterToggleRemove,
      overflowLocation,
      '2026-01-02T00:00:00.000Z',
    );
    expect(addedAfterFreeingSlot).toHaveLength(MAX_BOOKMARKS);
    expect(addedAfterFreeingSlot[0]?.href).toBe('overflow.xhtml');
    expect(addedAfterFreeingSlot.at(-1)?.label).toBe('Favorite opening scene');
  });

  it('loads all valid stored bookmarks while keeping recent location history capped at 12', () => {
    const stored = Array.from({ length: MAX_BOOKMARKS + 4 }, (_, index) => ({
      id: `epubcfi(/6/${index + 1})|chapter.xhtml`,
      cfi: `epubcfi(/6/${index + 1})`,
      href: 'chapter.xhtml',
      percentage: 0.1,
      label: `Custom ${index + 1}`,
      savedAt: '2026-01-01T00:00:00.000Z',
    }));

    expect(parseBookmarks(JSON.stringify(stored))).toHaveLength(MAX_BOOKMARKS + 4);
    expect(parseLocationHistory(JSON.stringify(stored))).toHaveLength(12);
  });

  it('records newest locations first and removes a bookmark by id', () => {
    const first = recordLocation([], location, '2026-01-01T00:00:00.000Z');
    const second = recordLocation(
      first,
      { ...location, cfi: 'epubcfi(/6/4!/4/2)', percentage: 0.5 },
      '2026-01-02T00:00:00.000Z',
    );
    expect(second.map((item) => item.percentage)).toEqual([0.5, 0.25]);
    expect(removeBookmark(second, second[0]!.id)).toHaveLength(1);
  });

  it('ignores malformed persisted values', () => {
    expect(parseBookmarks('{"bad":true}')).toEqual([]);
    expect(parseBookmarks(JSON.stringify([{ ...location, id: 'x' }]))).toEqual([]);
  });
});
