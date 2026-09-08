import { describe, expect, it } from 'vitest';
import { clipReaderSearchExcerpt, normalizeReaderSearchQuery } from './search';

describe('reader search helpers', () => {
  it('normalizes whitespace around a query', () => {
    expect(normalizeReaderSearchQuery('  quiet   river\npath  ')).toBe('quiet river path');
  });

  it('keeps short excerpts and clips long excerpts around the middle', () => {
    expect(clipReaderSearchExcerpt('  A short result  ')).toBe('A short result');
    expect(clipReaderSearchExcerpt('abcdefghijklmnopqrstuvwxyz', 10)).toBe('…ijklmnop…');
  });
});
