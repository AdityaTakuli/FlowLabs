// Where rows and columns are on screen: running totals of their sizes (hidden ones are 0 wide),
// and the reverse, from a pixel to a row or column.
import { MAX_COLS, MAX_ROWS } from "../engine/address";
import { DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT, type Sheet } from "../engine/workbook";

export const HEADER_W = 48;
export const HEADER_H = 24;

export class Axis {
  private starts: Float64Array;
  constructor(
    readonly count: number,
    readonly size: (i: number) => number,
    readonly extent: number,
  ) {
    const n = Math.min(count, extent);
    this.starts = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) this.starts[i + 1] = this.starts[i]! + size(i);
  }
  /** Where index i starts (from the first row or column). */
  start(i: number): number {
    if (i <= 0) return 0;
    if (i < this.starts.length) return this.starts[i]!;
    const last = this.starts.length - 1;
    let pos = this.starts[last]!;
    for (let k = last; k < i; k++) pos += this.size(k);
    return pos;
  }
  end(i: number): number {
    return this.start(i) + this.size(i);
  }
  /** The index at a position. */
  at(pos: number): number {
    if (pos <= 0) return 0;
    let lo = 0;
    let hi = this.starts.length - 1;
    if (pos >= this.starts[hi]!) {
      let i = hi;
      let p = this.starts[hi]!;
      while (i < this.count - 1 && p + this.size(i) <= pos) {
        p += this.size(i);
        i++;
      }
      return i;
    }
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    // skip hidden (zero-size) entries
    while (lo < this.count - 1 && this.size(lo) === 0) lo++;
    return Math.min(lo, this.count - 1);
  }
  total(): number {
    return this.starts[this.starts.length - 1]!;
  }
}

export interface Layout {
  rows: Axis;
  cols: Axis;
  /** Rows and columns frozen at the top and left. */
  freezeRows: number;
  freezeCols: number;
  frozenH: number;
  frozenW: number;
}

export function makeLayout(sheet: Sheet, rowExtent: number, colExtent: number, zoom: number): Layout {
  const rowSize = (i: number) => (sheet.hiddenRows.has(i) || sheet.filterHidden.has(i) ? 0 : (sheet.rowHeights.get(i) ?? DEFAULT_ROW_HEIGHT) * zoom);
  const colSize = (i: number) => (sheet.hiddenCols.has(i) ? 0 : (sheet.colWidths.get(i) ?? DEFAULT_COL_WIDTH) * zoom);
  const rows = new Axis(MAX_ROWS, rowSize, Math.min(MAX_ROWS, rowExtent));
  const cols = new Axis(MAX_COLS, colSize, Math.min(MAX_COLS, colExtent));
  return {
    rows,
    cols,
    freezeRows: sheet.freezeRows,
    freezeCols: sheet.freezeCols,
    frozenH: rows.start(sheet.freezeRows),
    frozenW: cols.start(sheet.freezeCols),
  };
}

/** A cell's rectangle on the canvas, given the scroll position (null when it is scrolled out of view). */
export function cellRect(layout: Layout, row: number, col: number, scrollX: number, scrollY: number, rowSpan = 1, colSpan = 1, zoomHeader = 1) {
  const hw = HEADER_W * zoomHeader;
  const hh = HEADER_H * zoomHeader;
  const x0 = layout.cols.start(col);
  const y0 = layout.rows.start(row);
  const x = col < layout.freezeCols ? hw + x0 : hw + layout.frozenW + (x0 - layout.frozenW) - scrollX;
  const y = row < layout.freezeRows ? hh + y0 : hh + layout.frozenH + (y0 - layout.frozenH) - scrollY;
  return { x, y, w: layout.cols.start(col + colSpan) - x0, h: layout.rows.start(row + rowSpan) - y0 };
}

/** The cell under a point on the canvas. */
export function hit(layout: Layout, x: number, y: number, scrollX: number, scrollY: number, zoomHeader = 1): { row: number; col: number; inHeaderRow: boolean; inHeaderCol: boolean } {
  const hw = HEADER_W * zoomHeader;
  const hh = HEADER_H * zoomHeader;
  const px = x - hw;
  const py = y - hh;
  const sx = px < layout.frozenW ? px : px + scrollX;
  const sy = py < layout.frozenH ? py : py + scrollY;
  return { row: layout.rows.at(Math.max(0, sy)), col: layout.cols.at(Math.max(0, sx)), inHeaderRow: y < hh, inHeaderCol: x < hw };
}
