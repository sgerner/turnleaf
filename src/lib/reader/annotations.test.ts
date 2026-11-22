import { describe, expect, it } from 'vitest';
import {
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
