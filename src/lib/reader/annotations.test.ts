import { describe, expect, it } from 'vitest';
import {
  MAX_ANNOTATIONS,
  addAnnotation,
  annotationsMarkdown,
  libraryAnnotationsMarkdown,
  parseAnnotations,
  removeAnnotation,
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

  it('exports notes without exposing HTML markup', () => {
    const annotations = addAnnotation([], 'epubcfi(/6/2)', 'A quote', 'A note', '2026');
    expect(annotationsMarkdown('Book', annotations)).toContain('# Notes for Book');
    expect(annotationsMarkdown('Book', annotations)).toContain('> A quote');
  });

  it('exports library-wide highlights and notes grouped by book', () => {
    const first = addAnnotation([], 'epubcfi(/6/2)', 'First quote', 'First note', '2026');
    const second = addAnnotation([], 'epubcfi(/6/4)', 'Second quote', '', '2026');
    const markdown = libraryAnnotationsMarkdown([
      { title: 'Book Alpha', author: 'Author A', annotations: first },
      { title: 'Book Beta', author: null, annotations: second },
    ]);
    expect(markdown).toContain('# Highlights and notes');
    expect(markdown).toContain('## Book Alpha — Author A');
    expect(markdown).toContain('> First quote');
    expect(markdown).toContain('First note');
    expect(markdown).toContain('## Book Beta');
    expect(markdown).toContain('> Second quote');
  });
});
