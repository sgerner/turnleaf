import { describe, expect, it } from 'vitest';
import {
  parseBookmarks,
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
