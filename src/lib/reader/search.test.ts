import { describe, expect, it } from 'vitest';
import {
  clipReaderSearchExcerpt,
  normalizeReaderSearchQuery,
  splitReaderSearchExcerpt,
} from './search';

describe('reader search helpers', () => {
  it('normalizes whitespace around a query', () => {
    expect(normalizeReaderSearchQuery('  quiet   river\npath  ')).toBe('quiet river path');
  });

  it('keeps short excerpts and clips long excerpts around the middle', () => {
    expect(clipReaderSearchExcerpt('  A short result  ')).toBe('A short result');
    expect(clipReaderSearchExcerpt('abcdefghijklmnopqrstuvwxyz', 10)).toBe('…ijklmnop…');
  });

  it('centers long excerpts around matches at paragraph start, middle, and end offsets', () => {
    const query = 'Lantern';
    const filler = 'x'.repeat(500);

    for (const offset of [0, 12, 75, 145, 250, 355, 425, 485, 493]) {
      const paragraph = `${filler.slice(0, offset)}${query}${filler.slice(offset + query.length)}`;
      const clipped = clipReaderSearchExcerpt(paragraph, 180, 'lantern');
      expect(clipped.length).toBeLessThanOrEqual(180);
      expect(clipped.toLowerCase()).toContain('lantern');
    }

    const startExcerpt = clipReaderSearchExcerpt(`Lantern ${'a'.repeat(492)}`, 180, 'lantern');
    expect(startExcerpt.startsWith('Lantern ')).toBe(true);
    expect(startExcerpt.endsWith('…')).toBe(true);

    const endExcerpt = clipReaderSearchExcerpt(`${'a'.repeat(492)} Lantern`, 180, 'lantern');
    expect(endExcerpt.startsWith('…')).toBe(true);
    expect(endExcerpt.endsWith(' Lantern')).toBe(true);
  });

  it('treats regex special characters literally when centering and splitting excerpts', () => {
    const paragraph = `${'intro '.repeat(45)}See footnote [1.2] (a+b?) at the margin.${' outro'.repeat(45)}`;
    const clipped = clipReaderSearchExcerpt(paragraph, 80, '[1.2] (a+b?)');
    expect(clipped).toContain('[1.2] (a+b?)');

    expect(splitReaderSearchExcerpt(clipped, '[1.2] (A+B?)')).toEqual([
      expect.objectContaining({ match: false }),
      { text: '[1.2] (a+b?)', match: true },
      expect.objectContaining({ match: false }),
    ]);
  });

  it('splits excerpts into plain and case-preserving matched segments without HTML injection', () => {
    expect(
      splitReaderSearchExcerpt(
        'Quiet RIVER meets another river beside <script>alert(1)</script>.',
        '  river ',
      ),
    ).toEqual([
      { text: 'Quiet ', match: false },
      { text: 'RIVER', match: true },
      { text: ' meets another ', match: false },
      { text: 'river', match: true },
      { text: ' beside <script>alert(1)</script>.', match: false },
    ]);

    expect(splitReaderSearchExcerpt('Unmatched sentence.', '')).toEqual([
      { text: 'Unmatched sentence.', match: false },
    ]);
    expect(splitReaderSearchExcerpt('', 'river')).toEqual([]);
  });
});
