// A1 addresses: column letters, cell and range text, and the sheet limits Excel has.

export const MAX_ROWS = 1_048_576;
export const MAX_COLS = 16_384;

/** 0 → A, 25 → Z, 26 → AA. */
export function colName(col: number): string {
  let name = "";
  let n = col + 1;
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** A → 0, AA → 26; -1 when not letters. */
export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) return -1;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

export interface CellAddress {
  row: number;
  col: number;
}

export interface Area {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export function cellName(row: number, col: number): string {
  return `${colName(col)}${row + 1}`;
}

export function areaName(area: Area): string {
  const { r1, c1, r2, c2 } = normal(area);
  if (r1 === 0 && r2 === MAX_ROWS - 1) return `${colName(c1)}:${colName(c2)}`;
  if (c1 === 0 && c2 === MAX_COLS - 1) return `${r1 + 1}:${r2 + 1}`;
  if (r1 === r2 && c1 === c2) return cellName(r1, c1);
  return `${cellName(r1, c1)}:${cellName(r2, c2)}`;
}

export function normal(area: Area): Area {
  return { r1: Math.min(area.r1, area.r2), c1: Math.min(area.c1, area.c2), r2: Math.max(area.r1, area.r2), c2: Math.max(area.c1, area.c2) };
}

export function contains(area: Area, row: number, col: number): boolean {
  return row >= area.r1 && row <= area.r2 && col >= area.c1 && col <= area.c2;
}

export function intersects(a: Area, b: Area): boolean {
  return a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2;
}

/** "B3" or "B3:D9" (or "B:B", "3:3"), optionally with $ signs, to an area. null when not an address. */
export function parseArea(text: string): Area | null {
  const t = text.trim().replace(/\$/g, "").toUpperCase();
  let m = /^([A-Z]{1,3})(\d{1,7})(?::([A-Z]{1,3})(\d{1,7}))?$/.exec(t);
  if (m) {
    const r1 = Number(m[2]) - 1;
    const c1 = colIndex(m[1]!);
    const r2 = m[4] ? Number(m[4]) - 1 : r1;
    const c2 = m[3] ? colIndex(m[3]) : c1;
    if ([r1, r2].some((r) => r < 0 || r >= MAX_ROWS) || [c1, c2].some((c) => c < 0 || c >= MAX_COLS)) return null;
    return normal({ r1, c1, r2, c2 });
  }
  m = /^([A-Z]{1,3}):([A-Z]{1,3})$/.exec(t);
  if (m) {
    const c1 = colIndex(m[1]!);
    const c2 = colIndex(m[2]!);
    if (c1 < 0 || c2 < 0 || c1 >= MAX_COLS || c2 >= MAX_COLS) return null;
    return normal({ r1: 0, c1, r2: MAX_ROWS - 1, c2 });
  }
  m = /^(\d{1,7}):(\d{1,7})$/.exec(t);
  if (m) {
    const r1 = Number(m[1]) - 1;
    const r2 = Number(m[2]) - 1;
    if (r1 < 0 || r2 < 0 || r1 >= MAX_ROWS || r2 >= MAX_ROWS) return null;
    return normal({ r1, c1: 0, r2, c2: MAX_COLS - 1 });
  }
  return null;
}

/** A sheet name as a formula writes it: quoted when it needs to be. */
export function quoteSheet(name: string): string {
  if (/^[A-Za-z_À-￿][\w.À-￿]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) && !/^(R\d*C\d*|TRUE|FALSE)$/i.test(name)) return name;
  return `'${name.replace(/'/g, "''")}'`;
}

/** A cell's key in a sheet's map. */
export const key = (row: number, col: number): number => row * MAX_COLS + col;
export const keyRow = (k: number): number => Math.floor(k / MAX_COLS);
export const keyCol = (k: number): number => k % MAX_COLS;
