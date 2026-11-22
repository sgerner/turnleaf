export interface VirtualWindow {
  firstRow: number;
  lastRow: number;
  startIndex: number;
  endIndex: number;
  totalRows: number;
  totalHeight: number;
}

/**
 * Minimum Grid card width in rem units so the top-left `.badge-icon`
 * (`left-2` + `w-7` = `2.25rem`) and top-right `[data-book-actions]` button
 * (`right-3` + `w-11` = `3.5rem`) keep at least `0.75rem` of horizontal
 * separation when root text size scales up to 200%.
 */
const MIN_GRID_CARD_REM = 6.5;

export function columnsForLibraryWidth(
  width: number,
  viewMode: 'grid' | 'list',
  remPx = 16,
  gapPx = 16,
): number {
  if (viewMode === 'list') return 1;
  const safeWidth = Math.max(0, Number.isFinite(width) ? width : 0);
  const safeRem = Number.isFinite(remPx) && remPx > 0 ? remPx : 16;
  const safeGap = Math.max(0, Number.isFinite(gapPx) ? gapPx : 0);

  let desired = 2;
  if (safeWidth >= 1024) desired = 5;
  else if (safeWidth >= 768) desired = 4;
  else if (safeWidth >= 640) desired = 3;

  const minCardWidth = safeRem * MIN_GRID_CARD_REM;
  const maxFitting = Math.max(1, Math.floor((safeWidth + safeGap) / (minCardWidth + safeGap)));
  return Math.max(1, Math.min(desired, maxFitting));
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
