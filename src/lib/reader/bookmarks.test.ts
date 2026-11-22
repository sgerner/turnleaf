import { describe, expect, it } from 'vitest';
import {
  MAX_RETURN_STACK,
  parseBookmarks,
  parseReturnStack,
  popReturnLocation,
  pushReturnLocation,
  reconcileRestoredReturnStack,
  recordLocation,
  removeBookmark,
  renameBookmark,
  returnStackPreferenceKey,
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

  it('maintains a bounded 12-entry LIFO return stack and reconciles restored targets', () => {
    expect(returnStackPreferenceKey('book-1')).toBe('readerReturnStack:book-1');
    expect(parseReturnStack('invalid')).toEqual([]);
    expect(parseReturnStack(JSON.stringify([{ cfi: '', href: 'ch.xhtml' }]))).toEqual([]);

    let stack = pushReturnLocation([], { cfi: 'cfi-1', href: 'ch1.xhtml' });
    // Consecutive duplicate CFI is ignored
    stack = pushReturnLocation(stack, { cfi: 'cfi-1', href: 'ch1.xhtml' });
    expect(stack).toEqual([{ cfi: 'cfi-1', href: 'ch1.xhtml' }]);

    for (let i = 2; i <= 14; i += 1) {
      stack = pushReturnLocation(stack, { cfi: `cfi-${i}`, href: `ch${i}.xhtml` });
    }
    expect(stack).toHaveLength(MAX_RETURN_STACK);
    expect(stack[0]?.cfi).toBe('cfi-14');
    expect(stack.at(-1)?.cfi).toBe('cfi-3');

    const parsed = parseReturnStack(JSON.stringify(stack));
    expect(parsed).toEqual(stack);

    const popped = popReturnLocation(parsed);
    expect(popped.target).toEqual({ cfi: 'cfi-14', href: 'ch14.xhtml' });
    expect(popped.remaining).toHaveLength(MAX_RETURN_STACK - 1);

    // Reconciling at an unrelated excursion CFI keeps stack intact
    expect(reconcileRestoredReturnStack(popped.remaining, 'cfi-excursion')).toEqual(
      popped.remaining,
    );
    // Reconciling at the bottom origin CFI clears satisfied entries
    expect(reconcileRestoredReturnStack(popped.remaining, 'cfi-3')).toEqual([]);
    // Reconciling at an intermediate entry unwinds down through that entry
    expect(
      reconcileRestoredReturnStack(
        [
          { cfi: 'cfi-note-2', href: 'notes.xhtml' },
          { cfi: 'cfi-note-1', href: 'notes.xhtml' },
          { cfi: 'cfi-chapter', href: 'chapter.xhtml' },
        ],
        'cfi-note-1',
      ),
    ).toEqual([{ cfi: 'cfi-chapter', href: 'chapter.xhtml' }]);
  });
});
