export interface VirtualWindow {
  firstRow: number;
  lastRow: number;
  startIndex: number;
  endIndex: number;
  totalRows: number;
  totalHeight: number;
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
