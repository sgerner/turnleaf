import { describe, expect, it } from 'vitest';
import { calculateVirtualWindow, columnsForLibraryWidth } from './library-virtualization';

describe('calculateVirtualWindow', () => {
  it('returns an empty window for an empty library', () => {
    expect(calculateVirtualWindow(0, 2, 300, 0, 600)).toEqual({
      firstRow: 0,
      lastRow: -1,
      startIndex: 0,
      endIndex: 0,
      totalRows: 0,
      totalHeight: 0,
    });
  });

  it('keeps the viewport and overscan within the available rows', () => {
    expect(calculateVirtualWindow(25, 4, 100, 500, 200, 1)).toEqual({
      firstRow: 4,
      lastRow: 6,
      startIndex: 16,
      endIndex: 25,
      totalRows: 7,
      totalHeight: 700,
    });
  });

  it('includes the final partial row without inventing items', () => {
    expect(calculateVirtualWindow(5, 3, 240, 0, 1, 0)).toMatchObject({
      firstRow: 0,
      lastRow: 0,
      startIndex: 0,
      endIndex: 3,
      totalRows: 2,
      totalHeight: 480,
    });
    expect(calculateVirtualWindow(5, 3, 240, 300, 1, 0)).toMatchObject({
      firstRow: 1,
      lastRow: 1,
      startIndex: 3,
      endIndex: 5,
    });
  });

  it('normalizes invalid dimensions and clamps negative scroll positions', () => {
    expect(calculateVirtualWindow(3.9, 0, Number.NaN, -20, 100, -2)).toEqual({
      firstRow: 0,
      lastRow: 2,
      startIndex: 0,
      endIndex: 3,
      totalRows: 3,
      totalHeight: 3,
    });
  });

  it('keeps a valid final row when scrolling past the end', () => {
    expect(calculateVirtualWindow(5, 2, 100, 50_000, 800, 2)).toEqual({
      firstRow: 0,
      lastRow: 2,
      startIndex: 0,
      endIndex: 5,
      totalRows: 3,
      totalHeight: 300,
    });
  });
});

describe('columnsForLibraryWidth', () => {
  it('always uses 1 column in list view', () => {
    expect(columnsForLibraryWidth(1200, 'list', 16)).toBe(1);
    expect(columnsForLibraryWidth(320, 'list', 32)).toBe(1);
  });

  it('preserves standard grid columns at 16px root font size', () => {
    expect(columnsForLibraryWidth(288, 'grid', 16)).toBe(2);
    expect(columnsForLibraryWidth(640, 'grid', 16)).toBe(3);
    expect(columnsForLibraryWidth(768, 'grid', 16)).toBe(4);
    expect(columnsForLibraryWidth(1024, 'grid', 16)).toBe(5);
  });

  it('reduces grid columns at 200% text size before card overlays overlap', () => {
    expect(columnsForLibraryWidth(288, 'grid', 32)).toBe(1);
    expect(columnsForLibraryWidth(380, 'grid', 32)).toBe(1);
    expect(columnsForLibraryWidth(520, 'grid', 32)).toBe(2);
    expect(columnsForLibraryWidth(720, 'grid', 32)).toBe(3);
    expect(columnsForLibraryWidth(976, 'grid', 32)).toBe(4);
  });
});
