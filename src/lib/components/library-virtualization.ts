export type LibraryViewMode = 'grid' | 'list';

export const GRID_GAP_PX = 16;
export const GRID_ROW_GAP_PX = 32;

// Skeleton scales font sizes by --text-scaling (`scale`):
// - Title (`line-clamp-2 text-base leading-snug`): unitless 1.375 line-height -> 2 * 1.375rem * scale
// - Author (`truncate text-sm`): (0.875rem * scale) * ((1.25 / 0.875) * scale) -> 1.25rem * scale^2
// - Series (`truncate text-xs`): (0.75rem * scale) * ((1 / 0.75) * scale) -> 1rem * scale^2
const TITLE_TWO_LINES_REM = 2.75;
const TEXT_SM_LINE_REM = 1.25;
const TEXT_XS_LINE_REM = 1;
const GRID_META_SPACING_REM = 1.25;
const LIST_NON_TEXT_REM = 4.5;
const LIST_MIN_ROW_REM = 7.25;

export interface VirtualWindow {
  firstRow: number;
  lastRow: number;
  startIndex: number;
  endIndex: number;
  totalRows: number;
  totalHeight: number;
}

export function columnsForWidth(width: number, viewMode: LibraryViewMode = 'grid'): number {
  if (viewMode === 'list') return 1;
  if (width >= 1024) return 5;
  if (width >= 768) return 4;
  if (width >= 640) return 3;
  return 2;
}

export function rowHeightFor(
  width: number,
  columns: number,
  viewMode: LibraryViewMode = 'grid',
  rootFontPx = 16,
  textScaling = 1,
): number {
  const rem = Number.isFinite(rootFontPx) && rootFontPx > 0 ? rootFontPx : 16;
  const scale = Number.isFinite(textScaling) && textScaling > 0 ? textScaling : 1;
  const scaleSquared = scale * scale;

  if (viewMode === 'list') {
    const listRem = Math.max(
      LIST_MIN_ROW_REM,
      LIST_NON_TEXT_REM +
        TITLE_TWO_LINES_REM * scale +
        (TEXT_SM_LINE_REM + TEXT_XS_LINE_REM) * scaleSquared,
    );
    return Math.max(1, Math.ceil(rem * listRem));
  }

  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const safeColumns = Math.max(1, Math.floor(Number.isFinite(columns) ? columns : 1));
  const cardWidth = Math.max(0, (safeWidth - (safeColumns - 1) * GRID_GAP_PX) / safeColumns);
  const metaHeight =
    rem *
    (GRID_META_SPACING_REM +
      TITLE_TWO_LINES_REM * scale +
      (TEXT_SM_LINE_REM + TEXT_XS_LINE_REM) * scaleSquared);
  return Math.max(1, Math.ceil(cardWidth * 1.5 + metaHeight + GRID_ROW_GAP_PX));
}

export function resultsContainerHeight(
  totalHeight: number,
  viewMode: LibraryViewMode = 'grid',
): number {
  const height = Number.isFinite(totalHeight) ? Math.max(0, totalHeight) : 0;
  if (height === 0) return 0;
  return viewMode === 'grid' ? Math.max(0, height - GRID_ROW_GAP_PX) : height;
}

/**
 * Select the rows that can intersect the viewport, plus a small buffer so a
 * fast touch scroll does not reveal an empty row before the next frame.
 */
export function calculateVirtualWindow(
  itemCount: number,
  columnCount: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscanRows = 2,
): VirtualWindow {
  const count = Math.max(0, Math.floor(Number.isFinite(itemCount) ? itemCount : 0));
  const columns = Math.max(1, Math.floor(Number.isFinite(columnCount) ? columnCount : 1));
  const height = Math.max(1, Number.isFinite(rowHeight) ? rowHeight : 1);
  const overscan = Math.max(0, Math.floor(Number.isFinite(overscanRows) ? overscanRows : 0));
  const totalRows = Math.ceil(count / columns);

  if (totalRows === 0) {
    return {
      firstRow: 0,
      lastRow: -1,
      startIndex: 0,
      endIndex: 0,
      totalRows: 0,
      totalHeight: 0,
    };
  }

  const top = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  const viewport = Math.max(0, Number.isFinite(viewportHeight) ? viewportHeight : 0);
  const firstVisibleRow = Math.min(totalRows - 1, Math.floor(top / height));
  const lastVisibleRow = Math.min(
    totalRows - 1,
    Math.floor(Math.max(top, top + viewport - 1) / height),
  );
  const firstRow = Math.max(0, firstVisibleRow - overscan);
  const lastRow = Math.max(firstRow, Math.min(totalRows - 1, lastVisibleRow + overscan));

  return {
    firstRow,
    lastRow,
    startIndex: firstRow * columns,
    endIndex: Math.min(count, (lastRow + 1) * columns),
    totalRows,
    totalHeight: totalRows * height,
  };
}
