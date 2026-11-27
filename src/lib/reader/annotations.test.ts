import { describe, expect, it } from 'vitest';
import {
  MAX_ANNOTATIONS,
  addAnnotation,
  annotationsMarkdown,
  parseAnnotations,
  removeAnnotation,
  repairAnnotations,
  updateAnnotation,
} from './annotations';

describe('reader annotations', () => {
  it('ignores malformed stored values', () => {
    expect(parseAnnotations('{"bad":true}')).toEqual([]);
    expect(parseAnnotations('[{"id":"ok"}]')).toEqual([]);
  });

  it('loads all valid stored annotations without truncating at MAX_ANNOTATIONS', () => {
    const stored = Array.from({ length: MAX_ANNOTATIONS + 5 }, (_, index) => ({
      id: `2026:epubcfi(/6/${index + 1})`,
      cfi: `epubcfi(/6/${index + 1})`,
      excerpt: `Excerpt ${index + 1}`,
      note: `Note ${index + 1}`,
      createdAt: '2026-01-01T00:00:00.000Z',
    }));

    const parsed = parseAnnotations(JSON.stringify(stored));
    expect(parsed).toHaveLength(MAX_ANNOTATIONS + 5);
    expect(parsed[0]?.note).toBe('Note 1');
    expect(parsed.at(-1)?.note).toBe(`Note ${MAX_ANNOTATIONS + 5}`);
  });

  it('adds, updates, and removes a local annotation by CFI', () => {
    const added = addAnnotation(
      [],
      'epubcfi(/6/2)',
      'A highlighted sentence',
      'First note',
      '2026',
    );
    expect(added).toHaveLength(1);
    const updated = updateAnnotation(added, added[0]!.id, 'Updated note');
    expect(updated[0]?.note).toBe('Updated note');
    const cleared = updateAnnotation(updated, added[0]!.id, '   ');
    expect(cleared[0]?.note).toBe('');
    expect(removeAnnotation(cleared, added[0]!.id)).toEqual([]);
  });

  it('preserves existing notes on empty duplicate CFI highlights and caps non-empty updates', () => {
    const initial = addAnnotation(
      [],
      'epubcfi(/6/2)',
      'A highlighted sentence',
      'Saved note',
      '2026',
    );
    const rehighlightedEmpty = addAnnotation(
      initial,
      'epubcfi(/6/2)',
      'A highlighted sentence',
      '',
    );
    expect(rehighlightedEmpty).toHaveLength(1);
    expect(rehighlightedEmpty[0]?.note).toBe('Saved note');

    const rehighlightedWhitespace = addAnnotation(
      rehighlightedEmpty,
      'epubcfi(/6/2)',
      'A highlighted sentence',
      '   ',
    );
    expect(rehighlightedWhitespace[0]?.note).toBe('Saved note');

    const longNote = `  ${'x'.repeat(2100)}  `;
    const rehighlightedWithNote = addAnnotation(
      rehighlightedWhitespace,
      'epubcfi(/6/2)',
      'A highlighted sentence',
      longNote,
    );
    expect(rehighlightedWithNote).toHaveLength(1);
    expect(rehighlightedWithNote[0]?.note).toHaveLength(2000);
    expect(rehighlightedWithNote[0]?.note).toBe('x'.repeat(2000));
  });

  it('blocks new CFIs at MAX_ANNOTATIONS without evicting saved entries while allowing updates', () => {
    let list = Array.from({ length: MAX_ANNOTATIONS }, (_, index) => ({
      id: `2026:epubcfi(/6/${index + 1})`,
      cfi: `epubcfi(/6/${index + 1})`,
      excerpt: `Quote ${index + 1}`,
      note: `Note ${index + 1}`,
      createdAt: '2026',
    }));

    const blocked = addAnnotation(
      list,
      'epubcfi(/6/999)',
      'Overflow quote',
      'Overflow note',
      '2026',
    );
    expect(blocked).toBe(list);
    expect(blocked).toHaveLength(MAX_ANNOTATIONS);
    expect(blocked[0]?.cfi).toBe('epubcfi(/6/1)');
    expect(blocked[0]?.note).toBe('Note 1');

    const existingUpdated = addAnnotation(
      list,
      'epubcfi(/6/1)',
      'Quote 1',
      'Refined note 1',
      '2026',
    );
    expect(existingUpdated).toHaveLength(MAX_ANNOTATIONS);
    expect(existingUpdated[0]?.note).toBe('Refined note 1');

    list = removeAnnotation(existingUpdated, existingUpdated[0]!.id);
    const afterDelete = addAnnotation(
      list,
      'epubcfi(/6/999)',
      'New quote after delete',
      'New note',
      '2026',
    );
    expect(afterDelete).toHaveLength(MAX_ANNOTATIONS);
    expect(afterDelete.at(-1)?.cfi).toBe('epubcfi(/6/999)');
  });

  it('preserves legacy annotations while storing optional href and text context for new highlights', () => {
    const legacyRaw = JSON.stringify([
      {
        id: 'legacy-1',
        cfi: 'epubcfi(/6/2!/4/2,/1:0,/1:12)',
        excerpt: 'Legacy highlight',
        note: 'Saved before edition update',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const parsedLegacy = parseAnnotations(legacyRaw);
    expect(parsedLegacy).toEqual([
      {
        id: 'legacy-1',
        cfi: 'epubcfi(/6/2!/4/2,/1:0,/1:12)',
        excerpt: 'Legacy highlight',
        note: 'Saved before edition update',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const withContext = addAnnotation(
      parsedLegacy,
      'epubcfi(/6/4!/4/6,/1:4,/1:18)',
      'Repeated phrase',
      'Second occurrence',
      '2026-02-01T00:00:00.000Z',
      {
        href: 'chapter-2.xhtml',
        prefix: 'Before the second ',
        suffix: ' appears in chapter two.',
      },
    );
    expect(withContext[0]).toEqual(parsedLegacy[0]);
    expect(withContext[1]).toMatchObject({
      cfi: 'epubcfi(/6/4!/4/6,/1:4,/1:18)',
      excerpt: 'Repeated phrase',
      note: 'Second occurrence',
      href: 'chapter-2.xhtml',
      prefix: 'Before the second',
      suffix: 'appears in chapter two.',
    });

    const roundTripped = parseAnnotations(JSON.stringify(withContext));
    expect(roundTripped).toEqual(withContext);
  });

  it('repairs CFIs in place without deleting unanchored highlights or modifying notes', () => {
    const initial = [
      ...addAnnotation(
        [],
        'epubcfi(/6/2!/4/2,/1:0,/1:11)',
        'Deleted line',
        'Keep this note safe',
        '2026-01-01T00:00:00.000Z',
        { href: 'chapter-1.xhtml' },
      ),
      ...addAnnotation(
        [],
        'epubcfi(/6/2!/4/4,/1:0,/1:12)',
        'Shifted line',
        'Shifted note',
        '2026-01-02T00:00:00.000Z',
        { href: 'chapter-1.xhtml' },
      ),
    ];

    const repaired = repairAnnotations(initial, [
      {
        id: initial[1]!.id,
        cfi: 'epubcfi(/6/2!/4/6,/1:0,/1:12)',
        href: 'chapter-1.xhtml',
      },
    ]);

    expect(repaired).toHaveLength(2);
    expect(repaired[0]).toEqual(initial[0]);
    expect(repaired[1]).toEqual({
      ...initial[1]!,
      cfi: 'epubcfi(/6/2!/4/6,/1:0,/1:12)',
      href: 'chapter-1.xhtml',
    });

    const markdown = annotationsMarkdown('Revised Book', repaired);
    expect(markdown).toContain('> Deleted line');
    expect(markdown).toContain('Keep this note safe');
    expect(markdown).toContain('> Shifted line');
    expect(markdown).toContain('Shifted note');
  });

  it('prevents repairAnnotations from overwriting a stale highlight onto another annotation CFI in the same chapter while allowing cross-chapter spine shifts', () => {
    const first = addAnnotation(
      [],
      'epubcfi(/6/2!/4/2,/1:0,/1:19)',
      'Remember the signal',
      'First note on deleted paragraph',
      '2026-01-01T00:00:00.000Z',
      { href: 'chapter-1.xhtml', prefix: 'Opening scene: ' },
    )[0]!;
    const second = addAnnotation(
      [],
      'epubcfi(/6/2!/4/6,/1:0,/1:19)',
      'Remember the signal',
      'Second note on surviving paragraph',
      '2026-01-02T00:00:00.000Z',
      { href: 'chapter-1.xhtml', prefix: 'Closing scene: ' },
    )[0]!;
    const chapterTwo = addAnnotation(
      [],
      'epubcfi(/6/4!/4/2,/1:0,/1:14)',
      'Chapter 2 line',
      'Chapter 2 note',
      '2026-01-03T00:00:00.000Z',
      { href: 'chapter-2.xhtml' },
    )[0]!;

    // Colliding onto `second.cfi` in the same chapter must be rejected without touching notes or metadata
    const inputList = [first, second];
    const rejectedCollision = repairAnnotations(inputList, [
      { id: first.id, cfi: second.cfi, href: 'chapter-1.xhtml' },
    ]);
    expect(rejectedCollision).toBe(inputList);
    expect(rejectedCollision).toEqual([first, second]);
    expect(rejectedCollision[0]?.note).toBe('First note on deleted paragraph');
    expect(rejectedCollision[1]?.note).toBe('Second note on surviving paragraph');

    // Frontmatter spine shift: chapter-1 moves from /6/2 to /6/4 while chapter-2 (href: chapter-2.xhtml)
    // has not been visited yet and still holds stale `/6/4!/4/2...` with a different href.
    const chapterOneShifted = addAnnotation(
      [],
      'epubcfi(/6/2!/4/2,/1:0,/1:14)',
      'Chapter 1 line',
      'Chapter 1 note',
      '2026-01-01T00:00:00.000Z',
      { href: 'chapter-1.xhtml' },
    )[0]!;
    const allowedSpineShift = repairAnnotations(
      [chapterOneShifted, chapterTwo],
      [
        {
          id: chapterOneShifted.id,
          cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:14)',
          href: 'chapter-1.xhtml',
        },
      ],
    );
    expect(allowedSpineShift[0]?.cfi).toBe('epubcfi(/6/4!/4/2,/1:0,/1:14)');
    expect(allowedSpineShift[0]?.note).toBe('Chapter 1 note');
    expect(allowedSpineShift[1]).toEqual(chapterTwo);
  });

  it('exports notes without exposing HTML markup', () => {
    const annotations = addAnnotation([], 'epubcfi(/6/2)', 'A quote', 'A note', '2026');
    expect(annotationsMarkdown('Book', annotations)).toContain('# Notes for Book');
    expect(annotationsMarkdown('Book', annotations)).toContain('> A quote');
  });
});
