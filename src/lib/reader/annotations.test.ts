import { describe, expect, it } from 'vitest';
import {
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
    expect(removeAnnotation(updated, added[0]!.id)).toEqual([]);
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

  it('exports notes without exposing HTML markup', () => {
    const annotations = addAnnotation([], 'epubcfi(/6/2)', 'A quote', 'A note', '2026');
    expect(annotationsMarkdown('Book', annotations)).toContain('# Notes for Book');
    expect(annotationsMarkdown('Book', annotations)).toContain('> A quote');
  });
});
