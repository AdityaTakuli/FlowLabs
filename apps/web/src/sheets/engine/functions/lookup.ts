// Lookup, reference and dynamic-array functions.
import { colName, MAX_COLS, MAX_ROWS, parseArea } from "../address";
import {
  bool, define, ERRORS, hasWildcard, invoke, isError, isMissing, isRange, Matrix, num, optBool, optNum, str, toMatrix, toScalar, wildcard,
  type Args, type LambdaValue, type Context, type RangeValue, type Scalar, type Value,
} from "../evaluate";
import { compareValues, tidy } from "../values";

const opt = (v: Value | undefined) => (v === undefined || isMissing(v) ? null : v);

function sameValue(a: Scalar, b: Scalar, wild: boolean): boolean {
  if (typeof a === "string" && typeof b === "string") {
    if (wild && hasWildcard(a)) return wildcard(a).test(b);
    return a.toLowerCase() === b.toLowerCase();
  }
  if (typeof a === "number" && typeof b === "number") return tidy(a) === tidy(b);
  return a === b;
}

/** Index of the last value <= target among values of the same type, for sorted data (approximate match). */
function approxIndex(values: Scalar[], target: Scalar, descending = false): number {
  // binary search, as Excel does, over values of target's type
  let lo = 0;
  let hi = values.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    let m = mid;
    // step over values of another type
    while (m >= lo && (values[m] === null || typeof values[m] !== typeof target)) m--;
    if (m < lo) {
      lo = mid + 1;
      continue;
    }
    const c = compareValues(values[m]!, target);
    if (descending ? c >= 0 : c <= 0) {
      found = m;
      if (c === 0 && !descending) {
        // the last of equal values
        let k = m;
        while (k + 1 < values.length && compareValues(values[k + 1]!, target) === 0) k++;
        return k;
      }
      lo = mid + 1;
    } else hi = m - 1;
  }
  return found;
}

function exactIndex(values: Scalar[], target: Scalar, fromEnd = false): number {
  if (fromEnd) {
    for (let i = values.length - 1; i >= 0; i--) if (sameValue(target, values[i] ?? null, true)) return i;
    return -1;
  }
  for (let i = 0; i < values.length; i++) if (sameValue(target, values[i] ?? null, true)) return i;
  return -1;
}

/** A part of a range or block, as a reference when it is one. */
function part(source: Value, ctx: Context, r1: number, c1: number, r2: number, c2: number): Value {
  if (isRange(source)) return { kind: "range", sheet: source.sheet, r1: source.r1 + r1, c1: source.c1 + c1, r2: source.r1 + r2, c2: source.c1 + c2 };
  const m = toMatrix(source, ctx);
  if (r1 === r2 && c1 === c2) return m.get(r1, c1);
  const rows: Scalar[][] = [];
  for (let r = r1; r <= r2; r++) rows.push(m.row(r).slice(c1, c2 + 1));
  return Matrix.of(rows);
}

const lookupV = (vertical: boolean) => ([target, table, index, approx]: Args, ctx: Context): Value => {
  if (isError(target)) return target as Scalar;
  const m = toMatrix(table!, ctx);
  const i = num(index as Scalar);
  if (isError(i)) return i;
  const k = Math.floor(i);
  if (k < 1) return ERRORS["#VALUE!"];
  if (k > (vertical ? m.cols : m.rows)) return ERRORS["#REF!"];
  const sorted = opt(approx) === null ? true : bool(approx as Scalar);
  if (isError(sorted)) return sorted;
  const keys = vertical ? m.col(0) : m.row(0);
  const at = sorted ? approxIndex(keys, target as Scalar) : exactIndex(keys, target as Scalar);
  if (at < 0) return ERRORS["#N/A"];
  const v = vertical ? m.get(at, k - 1) : m.get(k - 1, at);
  return v === null ? 0 : v;
};
define("VLOOKUP", "vavv", 3, 4, lookupV(true));
define("HLOOKUP", "vavv", 3, 4, lookupV(false));

define("LOOKUP", "vaa", 2, 3, ([target, look, result], ctx) => {
  const m = toMatrix(look!, ctx);
  let keys: Scalar[];
  let values: Scalar[];
  if (opt(result) === null) {
    const byRow = m.cols > m.rows;
    keys = byRow ? m.row(0) : m.col(0);
    values = byRow ? m.row(m.rows - 1) : m.col(m.cols - 1);
  } else {
    keys = m.data;
    values = toMatrix(result!, ctx).data;
  }
  const at = approxIndex(keys, target as Scalar);
  if (at < 0) return ERRORS["#N/A"];
  return values[at] ?? ERRORS["#N/A"];
});

define("MATCH", "vav", 2, 3, ([target, look, type], ctx) => {
  if (isError(target)) return target as Scalar;
  const m = toMatrix(look!, ctx);
  if (m.rows > 1 && m.cols > 1) return ERRORS["#N/A"];
  const t = optNum(type as Scalar, 1);
  if (isError(t)) return t;
  const values = m.data;
  let at: number;
  if (t === 0) at = exactIndex(values, target as Scalar);
  else if (t > 0) at = approxIndex(values, target as Scalar);
  else {
    // descending: the smallest value >= target
    at = -1;
    for (let i = 0; i < values.length; i++) {
      const v = values[i]!;
      if (v === null || typeof v !== typeof target) continue;
      if (compareValues(v, target as Scalar) >= 0) at = i;
      else break;
    }
  }
  return at < 0 ? ERRORS["#N/A"] : at + 1;
});

/** XLOOKUP/XMATCH: exact (0), next smaller (-1), next larger (1), wildcard (2); first-to-last (1),
 * last-to-first (-1), binary ascending (2), binary descending (-2). */
function xfind(values: Scalar[], target: Scalar, mode: number, search: number): number {
  if (mode === 2 || mode === 0) {
    const wild = mode === 2;
    const order = search === -1 || search === -2 ? [...values.keys()].reverse() : [...values.keys()];
    for (const i of order) {
      const v = values[i] ?? null;
      if (wild ? sameValue(target, v, true) : typeof target === "string" && typeof v === "string" ? target.toLowerCase() === v.toLowerCase() : sameValue(target, v, false)) return i;
    }
    return -1;
  }
  let best = -1;
  const order = search === -1 ? [...values.keys()].reverse() : [...values.keys()];
  for (const i of order) {
    const v = values[i] ?? null;
    if (v === null || typeof v !== typeof target) continue;
    const c = compareValues(v, target);
    if (c === 0) return i;
    if (mode === -1 && c < 0 && (best < 0 || compareValues(v, values[best]!) > 0)) best = i;
    if (mode === 1 && c > 0 && (best < 0 || compareValues(v, values[best]!) < 0)) best = i;
  }
  return best;
}

define("XLOOKUP", "vaaavv", 3, 6, ([target, look, ret, missing, mode, search], ctx) => {
  const m = toMatrix(look!, ctx);
  // sizes as written (A:A is a million rows), so whole columns match whole columns
  const size = isRange(look) ? { rows: look.r2 - look.r1 + 1, cols: look.c2 - look.c1 + 1 } : m;
  if (size.rows > 1 && size.cols > 1) return ERRORS["#VALUE!"];
  const vertical = size.cols === 1 && size.rows >= 1;
  const md = optNum(mode as Scalar, 0);
  const sr = optNum(search as Scalar, 1);
  if (isError(md)) return md;
  if (isError(sr)) return sr;
  const results = isRange(ret) ? { rows: ret.r2 - ret.r1 + 1, cols: ret.c2 - ret.c1 + 1 } : toMatrix(ret!, ctx);
  const at = xfind(m.data, target as Scalar, md, sr);
  if (at < 0) return opt(missing) === null ? ERRORS["#N/A"] : missing!;
  if (vertical && size.rows > 1) {
    if (results.rows !== size.rows) return ERRORS["#VALUE!"];
    return part(ret!, ctx, at, 0, at, results.cols - 1);
  }
  if (results.cols !== size.cols && !(size.rows === 1 && size.cols === 1)) return ERRORS["#VALUE!"];
  return part(ret!, ctx, 0, at, results.rows - 1, at);
});
define("XMATCH", "vavv", 2, 4, ([target, look, mode, search], ctx) => {
  const m = toMatrix(look!, ctx);
  if (m.rows > 1 && m.cols > 1) return ERRORS["#VALUE!"];
  const md = optNum(mode as Scalar, 0);
  const sr = optNum(search as Scalar, 1);
  if (isError(md)) return md;
  if (isError(sr)) return sr;
  const at = xfind(m.data, target as Scalar, md, sr);
  return at < 0 ? ERRORS["#N/A"] : at + 1;
});

define("INDEX", "avvv", 2, 4, ([source, r, c, area], ctx) => {
  let src = source!;
  if (isRange(src) && src.more) {
    const n = optNum(area as Scalar, 1);
    if (isError(n)) return n;
    const all = [{ ...src, more: undefined }, ...src.more];
    const pick = all[Math.floor(n) - 1];
    if (!pick) return ERRORS["#REF!"];
    src = pick;
  }
  const size = isRange(src) ? { rows: src.r2 - src.r1 + 1, cols: src.c2 - src.c1 + 1 } : toMatrix(src, ctx);
  let row = optNum(r as Scalar, 0);
  let col = optNum(c as Scalar, 0);
  if (isError(row)) return row;
  if (isError(col)) return col;
  row = Math.floor(row);
  col = Math.floor(col);
  // a single row or column takes one index for either
  if (opt(c) === null && size.rows === 1 && size.cols > 1) {
    col = row;
    row = 0;
  }
  if (row < 0 || col < 0 || row > size.rows || col > size.cols) return ERRORS["#REF!"];
  const r1 = row === 0 ? 0 : row - 1;
  const r2 = row === 0 ? size.rows - 1 : row - 1;
  const c1 = col === 0 ? 0 : col - 1;
  const c2 = col === 0 ? size.cols - 1 : col - 1;
  return part(src, ctx, r1, c1, r2, c2);
});

define("OFFSET", "avvvv", 3, 5, ([ref, rows, cols, h, w]) => {
  if (!isRange(ref)) return ERRORS["#VALUE!"];
  const dr = num(rows as Scalar);
  const dc = num(cols as Scalar);
  if (isError(dr)) return dr;
  if (isError(dc)) return dc;
  const height = optNum(h as Scalar, ref.r2 - ref.r1 + 1);
  const width = optNum(w as Scalar, ref.c2 - ref.c1 + 1);
  if (isError(height)) return height;
  if (isError(width)) return width;
  if (height === 0 || width === 0) return ERRORS["#REF!"];
  const r1 = ref.r1 + Math.floor(dr);
  const c1 = ref.c1 + Math.floor(dc);
  const r2 = r1 + Math.floor(height) + (height > 0 ? -1 : 1);
  const c2 = c1 + Math.floor(width) + (width > 0 ? -1 : 1);
  const lo = { r: Math.min(r1, r2), c: Math.min(c1, c2) };
  const hi = { r: Math.max(r1, r2), c: Math.max(c1, c2) };
  if (lo.r < 0 || lo.c < 0 || hi.r >= MAX_ROWS || hi.c >= MAX_COLS) return ERRORS["#REF!"];
  return { kind: "range", sheet: ref.sheet, r1: lo.r, c1: lo.c, r2: hi.r, c2: hi.c };
}, true);

/** A reference written as text, as INDIRECT reads it (A1 or R1C1 style, with a sheet name). */
export function textToRange(text: string, ctx: Context, a1 = true): RangeValue | null {
  let t = text.trim();
  let sheet = ctx.sheet;
  const bang = t.lastIndexOf("!");
  if (bang > 0) {
    let name = t.slice(0, bang);
    if (name.startsWith("'") && name.endsWith("'")) name = name.slice(1, -1).replace(/''/g, "'");
    const found = ctx.sheetByName(name);
    if (found === null) return null;
    sheet = found;
    t = t.slice(bang + 1);
  }
  if (a1) {
    const area = parseArea(t);
    if (area) return { kind: "range", sheet, ...area };
    // a defined name that is a reference
    const tree = ctx.name(t, ctx.sheet);
    if (tree && tree.t === "ref") {
      const r = tree.ref;
      const s = r.sheet === null ? sheet : ctx.sheetByName(r.sheet);
      if (s === null) return null;
      return { kind: "range", sheet: s, r1: r.r1, c1: r.c1, r2: r.r2, c2: r.c2 };
    }
    return null;
  }
  const rc = (part: string): { r: number; c: number } | null => {
    const m = /^R(\[?-?\d*\]?)C(\[?-?\d*\]?)$/i.exec(part);
    if (!m) return null;
    const pick = (s: string, here: number) => (s === "" ? here : s.startsWith("[") ? here + Number(s.slice(1, -1)) : Number(s) - 1);
    return { r: pick(m[1]!, ctx.row), c: pick(m[2]!, ctx.col) };
  };
  const [a, b] = t.split(":");
  const p = rc(a!);
  const q = b ? rc(b) : p;
  if (!p || !q) return null;
  return { kind: "range", sheet, r1: Math.min(p.r, q.r), c1: Math.min(p.c, q.c), r2: Math.max(p.r, q.r), c2: Math.max(p.c, q.c) };
}
define("INDIRECT", "vv", 1, 2, ([text, style], ctx) => {
  const s = str(text as Scalar);
  if (isError(s)) return s;
  const a1 = optBool(style as Scalar, true);
  if (isError(a1)) return a1;
  return textToRange(s, ctx, a1) ?? ERRORS["#REF!"];
}, true);
define("ADDRESS", "v", 2, 5, ([r, c, abs, style, sheet]) => {
  const row = num(r as Scalar);
  const col = num(c as Scalar);
  if (isError(row)) return row;
  if (isError(col)) return col;
  if (row < 1 || col < 1 || row > MAX_ROWS || col > MAX_COLS) return ERRORS["#VALUE!"];
  const kind = optNum(abs as Scalar, 1);
  if (isError(kind)) return kind;
  const a1 = optBool(style as Scalar, true);
  if (isError(a1)) return a1;
  const absRow = kind === 1 || kind === 2;
  const absCol = kind === 1 || kind === 3;
  let address: string;
  if (a1) address = `${absCol ? "$" : ""}${colName(Math.floor(col) - 1)}${absRow ? "$" : ""}${Math.floor(row)}`;
  else address = `R${absRow ? Math.floor(row) : `[${Math.floor(row)}]`}C${absCol ? Math.floor(col) : `[${Math.floor(col)}]`}`;
  if (sheet === undefined || isMissing(sheet) || sheet === null) return address;
  const name = String(sheet);
  return `${/^[A-Za-z_][\w.]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`}!${address}`;
});
define("AREAS", "a", 1, 1, ([ref]) => (isRange(ref) ? 1 + (ref.more?.length ?? 0) : ERRORS["#VALUE!"]));
define("HYPERLINK", "v", 1, 2, ([link, label]) => (label === undefined || isMissing(label) ? (link as Scalar) : (label as Scalar)));

// ------------------------------------------------------------------------------ dynamic arrays

define("TRANSPOSE", "a", 1, 1, ([a], ctx) => toMatrix(a!, ctx).transpose());

define("FILTER", "aaa", 2, 3, ([a, inc, empty], ctx) => {
  const m = toMatrix(a!, ctx);
  const keep = toMatrix(inc!, ctx);
  const byRows = keep.cols === 1 && keep.rows === m.rows;
  const byCols = keep.rows === 1 && keep.cols === m.cols;
  if (!byRows && !byCols) return ERRORS["#VALUE!"];
  const flags: boolean[] = [];
  for (const v of keep.data) {
    if (isError(v)) return v;
    const b = typeof v === "string" ? ERRORS["#VALUE!"] : bool(v);
    if (isError(b)) return b;
    flags.push(b);
  }
  const rows: Scalar[][] = [];
  if (byRows && !(byCols && m.rows === 1)) {
    for (let r = 0; r < m.rows; r++) if (flags[r]) rows.push(m.row(r));
  } else {
    for (let r = 0; r < m.rows; r++) rows.push(m.row(r).filter((_, c) => flags[c]));
    if (rows[0]?.length === 0) rows.length = 0;
  }
  if (!rows.length) return opt(empty) === null ? ERRORS["#CALC!"] : empty!;
  return Matrix.of(rows);
});

function sortRows(rows: Scalar[][], keys: { values: Scalar[]; desc: boolean }[]): Scalar[][] {
  const order = rows.map((_, i) => i);
  order.sort((x, y) => {
    for (const k of keys) {
      const a = k.values[x] ?? null;
      const b = k.values[y] ?? null;
      // empty and errors last, as Excel sorts
      if (a === null && b !== null) return 1;
      if (b === null && a !== null) return -1;
      const c = compareValues(a, b);
      if (c) return k.desc ? -c : c;
    }
    return x - y;
  });
  return order.map((i) => rows[i]!);
}

define("SORT", "avvv", 1, 4, ([a, idx, ord, byCol], ctx) => {
  let m = toMatrix(a!, ctx);
  const cols = optBool(byCol as Scalar, false);
  if (isError(cols)) return cols;
  if (cols) m = m.transpose();
  const indices = idx === undefined || isMissing(idx) ? [1] : toMatrix(idx as Value, ctx).data.map((v) => num(v));
  const orders = ord === undefined || isMissing(ord) ? [1] : toMatrix(ord as Value, ctx).data.map((v) => num(v));
  if ([...indices, ...orders].some(isError)) return ERRORS["#VALUE!"];
  const rows = m.toRows();
  const keys = (indices as number[]).map((k, i) => {
    const col = Math.floor(k) - 1;
    return { values: rows.map((r) => r[col] ?? null), desc: ((orders as number[])[i] ?? (orders as number[])[0]) === -1, bad: col < 0 || col >= m.cols };
  });
  if (keys.some((k) => k.bad)) return ERRORS["#VALUE!"];
  const out = Matrix.of(sortRows(rows, keys));
  return cols ? out.transpose() : out;
});
define("SORTBY", "aav", 2, 255, ([a, ...pairs], ctx) => {
  const m = toMatrix(a!, ctx);
  const keys: { values: Scalar[]; desc: boolean }[] = [];
  let byCol = false;
  for (let i = 0; i < pairs.length; i += 2) {
    const by = toMatrix(pairs[i]!, ctx);
    const order = pairs[i + 1] === undefined || isMissing(pairs[i + 1]) ? 1 : num(toScalar(pairs[i + 1]!, ctx));
    if (isError(order)) return order;
    if (by.cols === 1 && by.rows === m.rows) keys.push({ values: by.data, desc: order === -1 });
    else if (by.rows === 1 && by.cols === m.cols) {
      byCol = true;
      keys.push({ values: by.data, desc: order === -1 });
    } else return ERRORS["#VALUE!"];
  }
  if (byCol) return Matrix.of(sortRows(m.transpose().toRows(), keys)).transpose();
  return Matrix.of(sortRows(m.toRows(), keys));
});
define("UNIQUE", "avv", 1, 3, ([a, byCol, once], ctx) => {
  let m = toMatrix(a!, ctx);
  const cols = optBool(byCol as Scalar, false);
  const exactlyOnce = optBool(once as Scalar, false);
  if (isError(cols)) return cols;
  if (isError(exactlyOnce)) return exactlyOnce;
  if (cols) m = m.transpose();
  const counts = new Map<string, { row: Scalar[]; n: number }>();
  for (const row of m.toRows()) {
    const k = JSON.stringify(row.map((v) => (typeof v === "string" ? "s" + v.toLowerCase() : isError(v) ? "e" + v.code : v)));
    const seen = counts.get(k);
    if (seen) seen.n++;
    else counts.set(k, { row, n: 1 });
  }
  const rows = [...counts.values()].filter((x) => !exactlyOnce || x.n === 1).map((x) => x.row);
  if (!rows.length) return ERRORS["#CALC!"];
  const out = Matrix.of(rows);
  return cols ? out.transpose() : out;
});
const stack = (vertical: boolean) => (args: Args, ctx: Context): Value => {
  const blocks = args.filter((a) => !isMissing(a)).map((a) => toMatrix(a, ctx));
  if (vertical) {
    const width = Math.max(...blocks.map((b) => b.cols));
    const rows: Scalar[][] = [];
    for (const b of blocks) for (const r of b.toRows()) rows.push([...r, ...new Array<Scalar>(width - r.length).fill(ERRORS["#N/A"])]);
    return Matrix.of(rows);
  }
  const height = Math.max(...blocks.map((b) => b.rows));
  const rows: Scalar[][] = Array.from({ length: height }, () => []);
  for (const b of blocks) for (let r = 0; r < height; r++) rows[r]!.push(...(r < b.rows ? b.row(r) : new Array<Scalar>(b.cols).fill(ERRORS["#N/A"])));
  return Matrix.of(rows);
};
define("VSTACK", "a", 1, 254, stack(true));
define("HSTACK", "a", 1, 254, stack(false));
const takeDrop = (take: boolean) => ([a, r, c]: Args, ctx: Context): Value => {
  const m = toMatrix(a!, ctx);
  const rows = optNum(r as Scalar, take ? m.rows : 0);
  const cols = optNum(c as Scalar, take ? m.cols : 0);
  if (isError(rows)) return rows;
  if (isError(cols)) return cols;
  const span = (n: number, size: number): [number, number] => {
    const k = Math.trunc(n);
    if (take) return k >= 0 ? [0, Math.min(k, size)] : [Math.max(0, size + k), size];
    return k >= 0 ? [Math.min(k, size), size] : [0, Math.max(0, size + k)];
  };
  const [r1, r2] = opt(r) === null ? [0, m.rows] : span(rows, m.rows);
  const [c1, c2] = opt(c) === null ? [0, m.cols] : span(cols, m.cols);
  if (r2 <= r1 || c2 <= c1) return ERRORS["#CALC!"];
  const out: Scalar[][] = [];
  for (let i = r1; i < r2; i++) out.push(m.row(i).slice(c1, c2));
  return Matrix.of(out);
};
define("TAKE", "avv", 1, 3, takeDrop(true));
define("DROP", "avv", 1, 3, takeDrop(false));
const choose = (rows: boolean) => ([a, ...picks]: Args, ctx: Context): Value => {
  const m = toMatrix(a!, ctx);
  const size = rows ? m.rows : m.cols;
  const indices: number[] = [];
  for (const p of picks) for (const v of toMatrix(p, ctx).data) {
    const n = num(v);
    if (isError(n)) return n;
    const k = Math.trunc(n);
    if (k === 0 || Math.abs(k) > size) return ERRORS["#VALUE!"];
    indices.push(k > 0 ? k - 1 : size + k);
  }
  if (rows) return Matrix.of(indices.map((i) => m.row(i)));
  return Matrix.of(m.toRows().map((r) => indices.map((i) => r[i]!)));
};
define("CHOOSEROWS", "a", 2, 255, choose(true));
define("CHOOSECOLS", "a", 2, 255, choose(false));
const toLine = (col: boolean) => ([a, ignore, byCol]: Args, ctx: Context): Value => {
  const m = toMatrix(a!, ctx);
  const skip = optNum(ignore as Scalar, 0);
  const scanCols = optBool(byCol as Scalar, false);
  if (isError(skip)) return skip;
  if (isError(scanCols)) return scanCols;
  const source = scanCols ? m.transpose() : m;
  const values = source.data.filter((v) => !((skip === 1 || skip === 3) && v === null) && !((skip === 2 || skip === 3) && isError(v)));
  if (!values.length) return ERRORS["#CALC!"];
  return col ? new Matrix(values.length, 1, values) : new Matrix(1, values.length, values);
};
define("TOCOL", "avv", 1, 3, toLine(true));
define("TOROW", "avv", 1, 3, toLine(false));
const wrap = (byRows: boolean) => ([a, n, pad]: Args, ctx: Context): Value => {
  const m = toMatrix(a!, ctx);
  if (m.rows > 1 && m.cols > 1) return ERRORS["#VALUE!"];
  const count = num(n as Scalar);
  if (isError(count)) return count;
  const k = Math.floor(count);
  if (k < 1) return ERRORS["#NUM!"];
  const fill = pad === undefined || isMissing(pad) ? ERRORS["#N/A"] : (pad as Scalar);
  const lines: Scalar[][] = [];
  for (let i = 0; i < m.data.length; i += k) {
    const line = m.data.slice(i, i + k);
    while (line.length < k) line.push(fill);
    lines.push(line);
  }
  const out = Matrix.of(lines);
  return byRows ? out : out.transpose();
};
define("WRAPROWS", "avv", 2, 3, wrap(true));
define("WRAPCOLS", "avv", 2, 3, wrap(false));
define("EXPAND", "avvv", 2, 4, ([a, r, c, pad], ctx) => {
  const m = toMatrix(a!, ctx);
  const rows = optNum(r as Scalar, m.rows);
  const cols = optNum(c as Scalar, m.cols);
  if (isError(rows)) return rows;
  if (isError(cols)) return cols;
  if (rows < m.rows || cols < m.cols) return ERRORS["#VALUE!"];
  const fill = pad === undefined || isMissing(pad) ? ERRORS["#N/A"] : (pad as Scalar);
  const out: Scalar[][] = [];
  for (let i = 0; i < Math.floor(rows); i++) {
    const base = i < m.rows ? m.row(i) : [];
    out.push([...base, ...new Array<Scalar>(Math.floor(cols) - base.length).fill(fill)]);
  }
  return Matrix.of(out);
});

/** GROUPBY(row_fields, values, function): one row per group with the function over its values. */
define("GROUPBY", "aaavvvv", 3, 7, ([fields, values, fn, header, totals, sortBy], ctx) => {
  const keys = toMatrix(fields!, ctx);
  const vals = toMatrix(values!, ctx);
  if (keys.rows !== vals.rows) return ERRORS["#VALUE!"];
  if (!fn || !(typeof fn === "object" && (fn as { kind?: string }).kind === "lambda")) return ERRORS["#VALUE!"];
  const groups = new Map<string, { key: Scalar[]; rows: number[] }>();
  for (let r = 0; r < keys.rows; r++) {
    const key = keys.row(r);
    const id = JSON.stringify(key.map((v) => (typeof v === "string" ? v.toLowerCase() : v)));
    const g = groups.get(id);
    if (g) g.rows.push(r);
    else groups.set(id, { key, rows: [r] });
  }
  const lambda = fn as LambdaValue;
  const apply = (rows: number[]): Scalar[] => {
    const out: Scalar[] = [];
    for (let c = 0; c < vals.cols; c++) {
      const column = new Matrix(rows.length, 1, rows.map((r) => vals.get(r, c)));
      const res = invokeLambda(lambda, [column], ctx);
      out.push(res);
    }
    return out;
  };
  let rows = [...groups.values()].map((g) => [...g.key, ...apply(g.rows)]);
  const sortIndex = optNum(sortBy as Scalar, 1);
  if (!isError(sortIndex) && sortIndex !== 0) {
    const k = Math.abs(Math.floor(sortIndex)) - 1;
    rows = sortRows(rows, [{ values: rows.map((r) => r[k] ?? null), desc: sortIndex < 0 }]);
  }
  const totalMode = optNum(totals as Scalar, 1);
  if (!isError(totalMode) && totalMode !== 0) rows.push(["Total", ...new Array<Scalar>(Math.max(0, keys.cols - 1)).fill(null), ...apply([...Array(vals.rows).keys()])]);
  void header;
  return Matrix.of(rows);
});
function invokeLambda(fn: LambdaValue, values: Value[], ctx: Context): Scalar {
  return toScalar(invoke(fn, [], ctx, null, values), ctx);
}
