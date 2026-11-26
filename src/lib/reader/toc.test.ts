import { describe, expect, it } from 'vitest';
import { calculateVirtualWindow } from '../components/library-virtualization';
import {
  TOC_OVERSCAN_ROWS,
  TOC_ROW_HEIGHT_PX,
  TOC_VIRTUALIZATION_THRESHOLD,
  createSpineHrefLookup,
  getRenderedTocIndices,
  indexToc,
  resolveDisplayHref,
  resolveTocHref,
  sectionLabelForHref,
  type TocItem,
} from './toc';

describe('TOC path resolution and indexing', () => {
  it('resolves subdirectory nav.xhtml links to OPF-relative spine keys while keeping fragments', () => {
    const spine = createSpineHrefLookup([
      'Text/prologue.xhtml',
      'Text/Part1/chapter-1.xhtml',
      'BackMatter/appendix.xhtml',
    ]);

    expect(resolveTocHref('prologue.xhtml', 'Text/nav.xhtml', spine)).toBe('Text/prologue.xhtml');
    expect(resolveTocHref('Part1/chapter-1.xhtml#scene-2', 'Text/nav.xhtml', spine)).toBe(
      'Text/Part1/chapter-1.xhtml#scene-2',
    );
    expect(resolveTocHref('../BackMatter/appendix.xhtml#notes', 'Text/nav.xhtml', spine)).toBe(
      'BackMatter/appendix.xhtml#notes',
    );
  });

  it('falls back to spine-matched raw hrefs when navPath is omitted or links are already OPF-relative', () => {
    const spine = createSpineHrefLookup(['Text/chapter-1.xhtml', 'Text/chapter-2.xhtml']);

    expect(resolveTocHref('Text/chapter-1.xhtml#top', '', spine)).toBe('Text/chapter-1.xhtml#top');
    expect(resolveTocHref('Text/chapter-2.xhtml#part-b', 'Text/nav.xhtml', spine)).toBe(
      'Text/chapter-2.xhtml#part-b',
    );
  });

  it('normalizes URL-encoded and unencoded paths to canonical spine hrefs', () => {
    const spine = createSpineHrefLookup(['Text/Chapter%201.xhtml', 'Text/Chapter 2, Part A.xhtml']);

    expect(resolveTocHref('Chapter 1.xhtml#intro', 'Text/nav.xhtml', spine)).toBe(
      'Text/Chapter%201.xhtml#intro',
    );
    expect(resolveTocHref('Chapter%202%2C%20Part%20A.xhtml#sec-1', 'Text/nav.xhtml', spine)).toBe(
      'Text/Chapter 2, Part A.xhtml#sec-1',
    );
    expect(resolveDisplayHref('Text/Chapter 1.xhtml#intro', 'Text/nav.xhtml', spine)).toBe(
      'Text/Chapter%201.xhtml#intro',
    );
  });

  it('preserves fragment-only links and resolves display fragments against the current section', () => {
    const separateNavSpine = createSpineHrefLookup(['Text/chapter-1.xhtml']);
    expect(resolveTocHref('#footnotes', 'Text/nav.xhtml', separateNavSpine)).toBe('#footnotes');
    expect(
      resolveDisplayHref('#footnotes', 'Text/nav.xhtml', separateNavSpine, 'Text/chapter-1.xhtml'),
    ).toBe('Text/chapter-1.xhtml#footnotes');

    const inlineNavSpine = createSpineHrefLookup(['Text/single-book.xhtml']);
    expect(resolveTocHref('#chapter-2', 'Text/single-book.xhtml', inlineNavSpine)).toBe(
      'Text/single-book.xhtml#chapter-2',
    );
  });

  it('flattens nested TOC items with depth and indexes first-match section labels with Section N fallback', () => {
    const toc: TocItem[] = [
      { label: 'Jump to notes', href: '#notes', children: [] },
      {
        label: 'Part I',
        href: 'Text/part-1.xhtml#part-1',
        children: [
          {
            label: 'Chapter 1',
            href: 'Text/part-1.xhtml#chapter-1',
            children: [
              {
                label: 'Scene 1.1',
                href: 'Text/part-1.xhtml#scene-1',
                children: [],
              },
            ],
          },
          {
            label: 'Chapter 2',
            href: 'Text/Chapter%202.xhtml',
            children: [],
          },
        ],
      },
      { label: '   ', href: 'Text/blank.xhtml', children: [] },
    ];

    const indexed = indexToc(toc);

    expect(indexed.items.map((item) => ({ label: item.label, depth: item.depth }))).toEqual([
      { label: 'Jump to notes', depth: 0 },
      { label: 'Part I', depth: 0 },
      { label: 'Chapter 1', depth: 1 },
      { label: 'Scene 1.1', depth: 2 },
      { label: 'Chapter 2', depth: 1 },
      { label: '   ', depth: 0 },
    ]);
    expect(indexed.firstRowBySectionHref.get('Text/part-1.xhtml')).toBe(1);
    expect(sectionLabelForHref(indexed.labels, 'Text/part-1.xhtml', 0)).toBe('Part I');
    expect(sectionLabelForHref(indexed.labels, 'Text/part-1.xhtml#chapter-1', 0)).toBe('Chapter 1');
    expect(sectionLabelForHref(indexed.labels, 'Text/part-1.xhtml#unknown', 0)).toBe('Part I');
    expect(sectionLabelForHref(indexed.labels, 'Text/Chapter 2.xhtml', 1)).toBe('Chapter 2');
    expect(sectionLabelForHref(indexed.labels, '#notes', 0)).toBe('Jump to notes');
    expect(sectionLabelForHref(indexed.labels, 'Text/unlisted.xhtml', 4)).toBe('Section 5');
    expect(sectionLabelForHref(indexed.labels, 'Text/blank.xhtml', 5)).toBe('Section 6');
    expect(sectionLabelForHref(indexed.labels, '', 0)).toBe('Section 1');
  });

  it('keeps boundary, focused, and visible rows sorted and deduplicated across 1,500 chapters', () => {
    const count = 1_500;
    expect(count).toBeGreaterThan(TOC_VIRTUALIZATION_THRESHOLD);

    const midWindow = calculateVirtualWindow(
      count,
      1,
      TOC_ROW_HEIGHT_PX,
      800 * TOC_ROW_HEIGHT_PX,
      384,
      TOC_OVERSCAN_ROWS,
    );
    const midIndices = getRenderedTocIndices(count, midWindow, 42);

    expect(midIndices[0]).toBe(0);
    expect(midIndices[1]).toBe(42);
    expect(midIndices.at(-1)).toBe(1_499);
    expect(midIndices).toContain(800);
    expect(midIndices.length).toBeLessThan(25);
    expect(midIndices).toEqual([...new Set(midIndices)].sort((a, b) => a - b));
  });
});
