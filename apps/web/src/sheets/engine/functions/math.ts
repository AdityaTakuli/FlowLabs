// Math and trigonometry functions.
import {
  checkNum, criteria, define, ERRORS, flatten, FUNCTIONS, isError, isMatrix, isMissing, isRange, Matrix, num, numbers, nums, optNum, readRange, toMatrix,
  type Args, type Context, type Scalar, type Value,
} from "../evaluate";
import { tidy } from "../values";

/** Round half away from zero, to d decimal places (negative d: tens, hundreds…). */
export function round(n: number, d: number): number {
  d = Math.trunc(d);
  if (d >= 0) {
    if (d > 15) return n;
    const f = 10 ** d;
    return (Math.sign(n) * Math.round(Number((Math.abs(n) * f).toPrecision(15)))) / f;
  }
  const f = 10 ** -d;
  return Math.sign(n) * Math.round(Number((Math.abs(n) / f).toPrecision(15))) * f;
}

function roundDir(n: number, d: number, up: boolean): number {
  d = Math.trunc(d);
  const f = 10 ** Math.abs(d);
  const scaled = d >= 0 ? Number((Math.abs(n) * f).toPrecision(15)) : Number((Math.abs(n) / f).toPrecision(15));
  const r = up ? Math.ceil(scaled) : Math.floor(scaled);
  return Math.sign(n) * (d >= 0 ? r / f : r * f);
}

const one = (name: string, fn: (x: number) => number | Scalar) =>
  define(name, "v", 1, 1, ([a]) => {
    const x = num(a as Scalar);
    if (isError(x)) return x;
    const r = fn(x);
    return typeof r === "number" ? checkNum(r) : r;
  });

const two = (name: string, min: number, fn: (x: number, y: number | null) => number | Scalar) =>
  define(name, "v", min, 2, ([a, b]) => {
    const x = num(a as Scalar);
    if (isError(x)) return x;
    let y: number | null = null;
    if (b !== undefined && !isMissing(b)) {
      const n = num(b as Scalar);
      if (isError(n)) return n;
      y = n;
    }
    const r = fn(x, y);
    return typeof r === "number" ? checkNum(r) : r;
  });

define("SUM", "a", 1, 255, (args, ctx) => {
  const ns = numbers(args, ctx);
  return isError(ns) ? ns : tidy(ns.reduce((s, n) => s + n, 0));
});
define("PRODUCT", "a", 1, 255, (args, ctx) => {
  const ns = numbers(args, ctx);
  return isError(ns) ? ns : ns.length ? checkNum(ns.reduce((s, n) => s * n, 1)) : 0;
});
define("SUMSQ", "a", 1, 255, (args, ctx) => {
  const ns = numbers(args, ctx);
  return isError(ns) ? ns : ns.reduce((s, n) => s + n * n, 0);
});
define("SUMPRODUCT", "a", 1, 255, (args, ctx) => {
  const blocks = args.map((a) => toMatrix(a, ctx));
  const { rows, cols } = blocks[0]!;
  if (blocks.some((b) => b.rows !== rows || b.cols !== cols)) return ERRORS["#VALUE!"];
  let total = 0;
  for (let i = 0; i < rows * cols; i++) {
    let p = 1;
    for (const b of blocks) {
      const v = b.data[i] ?? null;
      if (isError(v)) return v;
      p *= typeof v === "number" ? v : 0;
    }
    total += p;
  }
  return tidy(total);
});
for (const [name, fn] of [
  ["SUMX2MY2", (x: number, y: number) => x * x - y * y],
  ["SUMX2PY2", (x: number, y: number) => x * x + y * y],
  ["SUMXMY2", (x: number, y: number) => (x - y) ** 2],
] as const) {
  define(name, "a", 2, 2, ([a, b], ctx) => {
    const x = toMatrix(a!, ctx);
    const y = toMatrix(b!, ctx);
    if (x.data.length !== y.data.length) return ERRORS["#N/A"];
    let total = 0;
    for (let i = 0; i < x.data.length; i++) {
      const p = x.data[i];
      const q = y.data[i];
      if (isError(p)) return p;
      if (isError(q)) return q;
      if (typeof p === "number" && typeof q === "number") total += fn(p, q);
    }
    return total;
  });
}

one("ABS", Math.abs);
two("ROUND", 2, (x, d) => round(x, d ?? 0));
two("ROUNDUP", 2, (x, d) => roundDir(x, d ?? 0, true));
two("ROUNDDOWN", 2, (x, d) => roundDir(x, d ?? 0, false));
two("TRUNC", 1, (x, d) => roundDir(x, d ?? 0, false));
one("INT", Math.floor);
one("SIGN", Math.sign);
one("SQRT", (x) => (x < 0 ? ERRORS["#NUM!"] : Math.sqrt(x)));
one("SQRTPI", (x) => (x < 0 ? ERRORS["#NUM!"] : Math.sqrt(x * Math.PI)));
one("EXP", Math.exp);
one("LN", (x) => (x <= 0 ? ERRORS["#NUM!"] : Math.log(x)));
one("LOG10", (x) => (x <= 0 ? ERRORS["#NUM!"] : Math.log10(x)));
two("LOG", 1, (x, b) => {
  const base = b ?? 10;
  if (x <= 0 || base <= 0) return ERRORS["#NUM!"];
  if (base === 1) return ERRORS["#DIV/0!"];
  return Math.log(x) / Math.log(base);
});
two("POWER", 2, (x, y) => {
  if (x === 0 && y! === 0) return ERRORS["#NUM!"];
  if (x === 0 && y! < 0) return ERRORS["#DIV/0!"];
  const r = x ** y!;
  return Number.isNaN(r) ? ERRORS["#NUM!"] : r;
});
two("MOD", 2, (x, d) => {
  if (d === 0) return ERRORS["#DIV/0!"];
  return tidy(x - d! * Math.floor(x / d!));
});
two("QUOTIENT", 2, (x, d) => (d === 0 ? ERRORS["#DIV/0!"] : Math.trunc(x / d!)));
define("PI", "v", 0, 0, () => Math.PI);
one("DEGREES", (x) => (x * 180) / Math.PI);
one("RADIANS", (x) => (x * Math.PI) / 180);
one("SIN", Math.sin);
one("COS", Math.cos);
one("TAN", Math.tan);
one("ASIN", (x) => (Math.abs(x) > 1 ? ERRORS["#NUM!"] : Math.asin(x)));
one("ACOS", (x) => (Math.abs(x) > 1 ? ERRORS["#NUM!"] : Math.acos(x)));
one("ATAN", Math.atan);
two("ATAN2", 2, (x, y) => (x === 0 && y === 0 ? ERRORS["#DIV/0!"] : Math.atan2(y!, x)));
one("SINH", Math.sinh);
one("COSH", Math.cosh);
one("TANH", Math.tanh);
one("ASINH", Math.asinh);
one("ACOSH", (x) => (x < 1 ? ERRORS["#NUM!"] : Math.acosh(x)));
one("ATANH", (x) => (Math.abs(x) >= 1 ? ERRORS["#NUM!"] : Math.atanh(x)));
one("COT", (x) => (x === 0 ? ERRORS["#DIV/0!"] : 1 / Math.tan(x)));
one("CSC", (x) => (x === 0 ? ERRORS["#DIV/0!"] : 1 / Math.sin(x)));
one("SEC", (x) => 1 / Math.cos(x));
one("COTH", (x) => (x === 0 ? ERRORS["#DIV/0!"] : 1 / Math.tanh(x)));
one("CSCH", (x) => (x === 0 ? ERRORS["#DIV/0!"] : 1 / Math.sinh(x)));
one("SECH", (x) => 1 / Math.cosh(x));
one("ACOT", (x) => Math.PI / 2 - Math.atan(x));
one("ACOTH", (x) => (Math.abs(x) <= 1 ? ERRORS["#NUM!"] : 0.5 * Math.log((x + 1) / (x - 1))));

export function factorial(n: number): number {
  if (n < 0) return NaN;
  n = Math.floor(n);
  if (n > 170) return Infinity;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}
one("FACT", (x) => (x < 0 ? ERRORS["#NUM!"] : factorial(x)));
one("FACTDOUBLE", (x) => {
  if (x < -1) return ERRORS["#NUM!"];
  let r = 1;
  for (let i = Math.floor(x); i > 1; i -= 2) r *= i;
  return r;
});
export function combin(n: number, k: number): number {
  n = Math.floor(n);
  k = Math.floor(k);
  if (k < 0 || n < 0 || k > n) return NaN;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}
two("COMBIN", 2, (n, k) => (n < 0 || k! < 0 || k! > n ? ERRORS["#NUM!"] : combin(n, k!)));
two("COMBINA", 2, (n, k) => (n < 0 || k! < 0 ? ERRORS["#NUM!"] : combin(n + k! - 1, k!)));
two("PERMUT", 2, (n, k) => {
  n = Math.floor(n);
  const kk = Math.floor(k!);
  if (n < 0 || kk < 0 || kk > n) return ERRORS["#NUM!"];
  let r = 1;
  for (let i = 0; i < kk; i++) r *= n - i;
  return r;
});
two("PERMUTATIONA", 2, (n, k) => (n < 0 || k! < 0 ? ERRORS["#NUM!"] : Math.floor(n) ** Math.floor(k!)));

const gcd2 = (a: number, b: number): number => (b === 0 ? a : gcd2(b, a % b));
define("GCD", "a", 1, 255, (args, ctx) => {
  const ns = numbers(args, ctx);
  if (isError(ns)) return ns;
  if (ns.some((n) => n < 0)) return ERRORS["#NUM!"];
  return ns.map(Math.floor).reduce((a, b) => gcd2(a, b), 0);
});
define("LCM", "a", 1, 255, (args, ctx) => {
  const ns = numbers(args, ctx);
  if (isError(ns)) return ns;
  if (ns.some((n) => n < 0)) return ERRORS["#NUM!"];
  return ns.map(Math.floor).reduce((a, b) => (a === 0 || b === 0 ? 0 : (a * b) / gcd2(a, b)), 1);
});
one("EVEN", (x) => {
  const r = Math.ceil(Math.abs(x) / 2) * 2;
  return Math.sign(x) * r;
});
one("ODD", (x) => {
  let r = Math.ceil(Math.abs(x));
  if (r % 2 === 0) r += 1;
  return x < 0 ? -r : r;
});
two("MROUND", 2, (x, m) => {
  if (m === 0) return 0;
  if (Math.sign(x) * Math.sign(m!) < 0) return ERRORS["#NUM!"];
  return tidy(round(x / m!, 0) * m!);
});
two("CEILING", 2, (x, s) => {
  const sig = s!;
  if (sig === 0) return 0;
  if (x > 0 && sig < 0) return ERRORS["#NUM!"];
  if (x < 0 && sig < 0) return -tidy(Math.ceil(Number((-x / -sig).toPrecision(15))) * -sig);
  return tidy(Math.ceil(Number((x / sig).toPrecision(15))) * sig);
});
two("FLOOR", 2, (x, s) => {
  const sig = s!;
  if (sig === 0) return x === 0 ? 0 : ERRORS["#DIV/0!"];
  if (x > 0 && sig < 0) return ERRORS["#NUM!"];
  if (x < 0 && sig < 0) return -tidy(Math.floor(Number((-x / -sig).toPrecision(15))) * -sig);
  return tidy(Math.floor(Number((x / sig).toPrecision(15))) * sig);
});
define("CEILING.MATH", "v", 1, 3, ([a, b, c]) => {
  const v = nums([a as Scalar, isMissing(b) || b === undefined ? 1 : (b as Scalar), isMissing(c) || c === undefined ? 0 : (c as Scalar)]);
  if (isError(v)) return v;
  const [x, s0, mode] = v as [number, number, number];
  const s = Math.abs(s0) || 0;
  if (s === 0) return 0;
  if (x < 0 && mode !== 0) return -tidy(Math.ceil(Number((-x / s).toPrecision(15))) * s);
  return tidy(Math.ceil(Number((x / s).toPrecision(15))) * s);
});
define("FLOOR.MATH", "v", 1, 3, ([a, b, c]) => {
  const v = nums([a as Scalar, isMissing(b) || b === undefined ? 1 : (b as Scalar), isMissing(c) || c === undefined ? 0 : (c as Scalar)]);
  if (isError(v)) return v;
  const [x, s0, mode] = v as [number, number, number];
  const s = Math.abs(s0) || 0;
  if (s === 0) return 0;
  if (x < 0 && mode !== 0) return -tidy(Math.floor(Number((-x / s).toPrecision(15))) * s);
  return tidy(Math.floor(Number((x / s).toPrecision(15))) * s);
});
for (const name of ["CEILING.PRECISE", "ISO.CEILING"])
  two(name, 1, (x, s) => {
    const sig = Math.abs(s ?? 1);
    return sig === 0 ? 0 : tidy(Math.ceil(Number((x / sig).toPrecision(15))) * sig);
  });
two("FLOOR.PRECISE", 1, (x, s) => {
  const sig = Math.abs(s ?? 1);
  return sig === 0 ? 0 : tidy(Math.floor(Number((x / sig).toPrecision(15))) * sig);
});

define("RAND", "v", 0, 0, (_a, ctx) => ctx.random(), true);
define("RANDBETWEEN", "v", 2, 2, ([a, b], ctx) => {
  const v = nums([a as Scalar, b as Scalar]);
  if (isError(v)) return v;
  const lo = Math.ceil(v[0]!);
  const hi = Math.floor(v[1]!);
  if (lo > hi) return ERRORS["#NUM!"];
  return lo + Math.floor(ctx.random() * (hi - lo + 1));
}, true);
define("RANDARRAY", "v", 0, 5, ([r, c, lo, hi, whole], ctx) => {
  const rows = optNum(r as Scalar, 1);
  const cols = optNum(c as Scalar, 1);
  const min = optNum(lo as Scalar, 0);
  const max = optNum(hi as Scalar, 1);
  if (isError(rows) || isError(cols) || isError(min) || isError(max)) return ERRORS["#VALUE!"];
  const integer = whole !== undefined && !isMissing(whole) && whole !== null && whole !== false && whole !== 0;
  if (rows < 1 || cols < 1 || min > max) return ERRORS["#VALUE!"];
  const data: Scalar[] = [];
  for (let i = 0; i < Math.floor(rows) * Math.floor(cols); i++)
    data.push(integer ? Math.ceil(min) + Math.floor(ctx.random() * (Math.floor(max) - Math.ceil(min) + 1)) : min + ctx.random() * (max - min));
  return new Matrix(Math.floor(rows), Math.floor(cols), data);
}, true);
define("SEQUENCE", "v", 1, 4, ([r, c, s, st]) => {
  const rows = optNum(r as Scalar, 1);
  const cols = optNum(c as Scalar, 1);
  const start = optNum(s as Scalar, 1);
  const step = optNum(st as Scalar, 1);
  for (const x of [rows, cols, start, step]) if (isError(x)) return x;
  const R = Math.floor(rows as number);
  const C = Math.floor(cols as number);
  if (R < 1 || C < 1) return ERRORS["#CALC!"];
  if (R * C > 1_048_576 * 4) return ERRORS["#NUM!"];
  const data: Scalar[] = new Array(R * C);
  for (let i = 0; i < R * C; i++) data[i] = tidy((start as number) + i * (step as number));
  return new Matrix(R, C, data);
});

// SUMIF and friends
/** SUMIF's sum range takes the shape of its criteria range, from its own top-left cell. */
function sameShape(range: Value, ctx: Context, like: Matrix): Matrix {
  if (isRange(range)) return readRange({ ...range, r2: range.r1 + like.rows - 1, c2: range.c1 + like.cols - 1 }, ctx, false);
  return toMatrix(range, ctx);
}

define("SUMIF", "ava", 2, 3, ([range, crit, sum], ctx) => {
  const where = toMatrix(range!, ctx);
  const test = criteria(crit as Scalar);
  const values = sum === undefined || isMissing(sum) ? where : sameShape(sum, ctx, where);
  let total = 0;
  for (let i = 0; i < where.data.length; i++) {
    if (!test(where.data[i] ?? null)) continue;
    const v = values.data[i];
    if (isError(v)) return v;
    if (typeof v === "number") total += v;
  }
  return tidy(total);
});

/** Rows that pass every (range, criterion) pair; null when the ranges differ in size. */
/** SUMIFS(sum, range, criterion, range, criterion…): ranges as written, criteria as values, so an
 * array of criteria gives one answer per criterion. */
export const IFS_ARGS = "a" + "av".repeat(127);
/** COUNTIFS(range, criterion, …). */
export const PAIR_ARGS = "av".repeat(128);

/** Ranges that must be the same size, read to the same shape: whole columns stop at the last row
 * any of them uses. null when their sizes differ. */
export function readAligned(values: Value[], ctx: Context): Matrix[] | null {
  const dims = values.map((v) => (isRange(v) ? { rows: v.r2 - v.r1 + 1, cols: v.c2 - v.c1 + 1 } : toMatrix(v, ctx)));
  const { rows, cols } = dims[0]!;
  if (dims.some((d) => d.rows !== rows || d.cols !== cols)) return null;
  let useRows = 0;
  let useCols = 0;
  for (const v of values) {
    if (!isRange(v)) {
      useRows = rows;
      useCols = cols;
      break;
    }
    const b = ctx.bounds(v.sheet);
    useRows = Math.max(useRows, Math.min(rows, b.rows - v.r1));
    useCols = Math.max(useCols, Math.min(cols, b.cols - v.c1));
  }
  useRows = Math.max(1, useRows);
  useCols = Math.max(1, useCols);
  return values.map((v) => (isRange(v) ? readRange({ ...v, r2: v.r1 + useRows - 1, c2: v.c1 + useCols - 1 }, ctx, false) : toMatrix(v, ctx)));
}

/** Which cells pass every (range, criterion) pair, with the blocks read; null when sizes differ. */
export function ifsMask(first: Value | null, pairs: Args, ctx: Context): { mask: boolean[]; values: Matrix | null } | null {
  const ranges = [...(first ? [first] : []), ...pairs.filter((_, i) => i % 2 === 0)];
  const blocks = readAligned(ranges, ctx);
  if (!blocks) return null;
  const values = first ? blocks.shift()! : null;
  const mask = new Array<boolean>(blocks[0]?.data.length ?? 0).fill(true);
  blocks.forEach((block, k) => {
    const test = criteria(pairs[k * 2 + 1] as Scalar);
    for (let i = 0; i < block.data.length; i++) if (mask[i] && !test(block.data[i] ?? null)) mask[i] = false;
  });
  return { mask, values };
}

define("SUMIFS", IFS_ARGS, 3, 255, ([sum, ...pairs], ctx) => {
  if (pairs.length % 2) return ERRORS["#VALUE!"];
  const found = ifsMask(sum!, pairs, ctx);
  if (!found) return ERRORS["#VALUE!"];
  const { mask, values } = found;
  let total = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const v = values!.data[i];
    if (isError(v)) return v;
    if (typeof v === "number") total += v;
  }
  return tidy(total);
});

define("SUBTOTAL", "va", 2, 255, ([fn, ...refs], ctx) => {
  const code = num(fn as Scalar);
  if (isError(code)) return code;
  const kind = Math.floor(code) % 100;
  const skipHidden = Math.floor(code) > 100;
  // values from SUBTOTAL and AGGREGATE cells inside the ranges are left out (no double counting);
  // rows a filter hides are left out always, rows hidden by hand for 101-111
  const kept: Scalar[] = [];
  for (const ref of refs) {
    if (isRange(ref)) {
      const m = readRange(ref, ctx);
      for (let r = 0; r < m.rows; r++) {
        const h = ctx.hidden?.(ref.sheet, ref.r1 + r) ?? 0;
        if (h === 1 || (h === 2 && skipHidden)) continue;
        for (let c = 0; c < m.cols; c++) {
          const f = ctx.formula(ref.sheet, ref.r1 + r, ref.c1 + c);
          if (f && /\b(SUBTOTAL|AGGREGATE)\s*\(/i.test(f)) continue;
          kept.push(m.get(r, c));
        }
      }
    } else kept.push(...flatten([ref], ctx));
  }
  const block = new Matrix(1, kept.length || 1, kept.length ? kept : [null]);
  const name = SUBTOTAL_NAMES[kind];
  if (!name) return ERRORS["#VALUE!"];
  return callByName(name, [block], ctx);
});
const SUBTOTAL_NAMES: Record<number, string> = { 1: "AVERAGE", 2: "COUNT", 3: "COUNTA", 4: "MAX", 5: "MIN", 6: "PRODUCT", 7: "STDEV.S", 8: "STDEV.P", 9: "SUM", 10: "VAR.S", 11: "VAR.P" };
const AGGREGATE_NAMES: Record<number, string> = { ...SUBTOTAL_NAMES, 12: "MEDIAN", 13: "MODE.SNGL", 14: "LARGE", 15: "SMALL", 16: "PERCENTILE.INC", 17: "QUARTILE.INC", 18: "PERCENTILE.EXC", 19: "QUARTILE.EXC" };

define("AGGREGATE", "vva", 3, 255, ([fn, opt, ...refs], ctx) => {
  const code = num(fn as Scalar);
  const option = num(opt as Scalar);
  if (isError(code)) return code;
  if (isError(option)) return option;
  const name = AGGREGATE_NAMES[Math.floor(code)];
  if (!name) return ERRORS["#VALUE!"];
  const skipErrors = [2, 3, 6, 7].includes(Math.floor(option));
  const skipSubtotals = [0, 1, 2, 3].includes(Math.floor(option));
  const values: Scalar[] = [];
  const takesK = Math.floor(code) >= 14;
  const dataArgs = takesK ? refs.slice(0, 1) : refs;
  for (const ref of dataArgs) {
    if (isRange(ref)) {
      const m = readRange(ref, ctx);
      for (let r = 0; r < m.rows; r++)
        for (let c = 0; c < m.cols; c++) {
          const v = m.get(r, c);
          if (skipErrors && isError(v)) continue;
          if (skipSubtotals) {
            const f = ctx.formula(ref.sheet, ref.r1 + r, ref.c1 + c);
            if (f && /\b(SUBTOTAL|AGGREGATE)\s*\(/i.test(f)) continue;
          }
          values.push(v);
        }
    } else for (const v of flatten([ref], ctx)) if (!(skipErrors && isError(v))) values.push(v);
  }
  const block = new Matrix(1, values.length || 1, values.length ? values : [null]);
  return callByName(name, takesK ? [block, refs[1] ?? null] : [block], ctx);
});

export function callByName(name: string, args: Args, ctx: Context): Value {
  const def = FUNCTIONS[name]!;
  const ready = args.map((a, i) => {
    const kind = def.args[Math.min(i, def.args.length - 1)];
    return kind === "v" && (isMatrix(a) || isRange(a)) ? toMatrix(a, ctx).get(0, 0) : a;
  });
  return def.fn(ready, ctx, [], null);
}

// number bases
define("BASE", "v", 2, 3, ([n, radix, len]) => {
  const v = nums([n as Scalar, radix as Scalar]);
  if (isError(v)) return v;
  const [x, r] = v as [number, number];
  if (x < 0 || x >= 2 ** 53 || r < 2 || r > 36) return ERRORS["#NUM!"];
  const width = optNum(len as Scalar, 0);
  if (isError(width)) return width;
  return Math.floor(x).toString(Math.floor(r)).toUpperCase().padStart(Math.floor(width), "0");
});
define("DECIMAL", "v", 2, 2, ([text, radix]) => {
  const r = num(radix as Scalar);
  if (isError(r)) return r;
  const t = String(text ?? "").trim();
  if (r < 2 || r > 36 || !t) return ERRORS["#NUM!"];
  const n = parseInt(t, Math.floor(r));
  if (Number.isNaN(n) || [...t.toLowerCase()].some((ch) => parseInt(ch, Math.floor(r)).toString() === "NaN")) return ERRORS["#NUM!"];
  return n;
});
const toBase = (radix: number, width: number) => (x: number, places: number | null): Scalar => {
  const limit = radix ** width / 2;
  if (x < -limit || x >= limit || !Number.isFinite(x)) return ERRORS["#NUM!"];
  const n = Math.trunc(x);
  const text = n < 0 ? (radix ** width + n).toString(radix).toUpperCase() : n.toString(radix).toUpperCase();
  if (places !== null) {
    if (n < 0) return text;
    if (places < text.length || places > width) return ERRORS["#NUM!"];
    return text.padStart(Math.floor(places), "0");
  }
  return text;
};
const fromBase = (radix: number, width: number) => (text: Scalar): Scalar => {
  const t = String(text ?? "").trim().toUpperCase();
  if (t.length > width || !t || [...t].some((ch) => Number.isNaN(parseInt(ch, radix)))) return ERRORS["#NUM!"];
  let n = parseInt(t, radix);
  if (t.length === width && parseInt(t[0]!, radix) >= radix / 2) n -= radix ** width;
  return n;
};
const BASES = { BIN: [2, 10], OCT: [8, 10], HEX: [16, 10] } as const;
for (const [from, [radix, width]] of Object.entries(BASES)) {
  define(`${from}2DEC`, "v", 1, 1, ([t]) => fromBase(radix, width)(typeof t === "number" ? String(t) : (t as Scalar)));
  two(`DEC2${from}`, 1, (x, p) => toBase(radix, width)(x, p));
  for (const [to, [radix2, width2]] of Object.entries(BASES)) {
    if (to === from) continue;
    define(`${from}2${to}`, "v", 1, 2, ([t, p]) => {
      const n = fromBase(radix, width)(typeof t === "number" ? String(t) : (t as Scalar));
      if (isError(n)) return n;
      const places = p === undefined || isMissing(p) ? null : num(p as Scalar);
      if (isError(places)) return places;
      return toBase(radix2, width2)(n as number, places);
    });
  }
}

const ROMAN: [number, string][] = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
two("ROMAN", 1, (x) => {
  let n = Math.floor(x);
  if (n < 0 || n > 3999) return ERRORS["#VALUE!"];
  let out = "";
  for (const [v, s] of ROMAN) while (n >= v) {
    out += s;
    n -= v;
  }
  return out;
});
define("ARABIC", "v", 1, 1, ([t]) => {
  const s = String(t ?? "").trim().toUpperCase();
  if (!/^-?[MDCLXVI]*$/.test(s)) return ERRORS["#VALUE!"];
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const val: Record<string, number> = { M: 1000, D: 500, C: 100, L: 50, X: 10, V: 5, I: 1 };
  let total = 0;
  for (let i = 0; i < body.length; i++) {
    const v = val[body[i]!]!;
    const next = val[body[i + 1] ?? ""] ?? 0;
    total += v < next ? -v : v;
  }
  return neg ? -total : total;
});

// matrices
define("MMULT", "a", 2, 2, ([a, b], ctx) => {
  const x = toMatrix(a!, ctx);
  const y = toMatrix(b!, ctx);
  if (x.cols !== y.rows) return ERRORS["#VALUE!"];
  if ([...x.data, ...y.data].some((v) => typeof v !== "number")) return ERRORS["#VALUE!"];
  const data: Scalar[] = [];
  for (let r = 0; r < x.rows; r++)
    for (let c = 0; c < y.cols; c++) {
      let s = 0;
      for (let k = 0; k < x.cols; k++) s += (x.get(r, k) as number) * (y.get(k, c) as number);
      data.push(tidy(s));
    }
  return new Matrix(x.rows, y.cols, data);
});
function square(v: Value, ctx: Context): number[][] | null {
  const m = toMatrix(v, ctx);
  if (m.rows !== m.cols || m.data.some((x) => typeof x !== "number")) return null;
  return m.toRows() as number[][];
}
define("MDETERM", "a", 1, 1, ([a], ctx) => {
  const m = square(a!, ctx);
  if (!m) return ERRORS["#VALUE!"];
  const n = m.length;
  const w = m.map((r) => [...r]);
  let det = 1;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(w[r]![i]!) > Math.abs(w[p]![i]!)) p = r;
    if (w[p]![i] === 0) return 0;
    if (p !== i) {
      [w[p], w[i]] = [w[i]!, w[p]!];
      det = -det;
    }
    det *= w[i]![i]!;
    for (let r = i + 1; r < n; r++) {
      const f = w[r]![i]! / w[i]![i]!;
      for (let c = i; c < n; c++) w[r]![c]! -= f * w[i]![c]!;
    }
  }
  return tidy(det);
});
define("MINVERSE", "a", 1, 1, ([a], ctx) => {
  const m = square(a!, ctx);
  if (!m) return ERRORS["#VALUE!"];
  const n = m.length;
  const w = m.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(w[r]![i]!) > Math.abs(w[p]![i]!)) p = r;
    if (Math.abs(w[p]![i]!) < 1e-15) return ERRORS["#NUM!"];
    [w[p], w[i]] = [w[i]!, w[p]!];
    const d = w[i]![i]!;
    for (let c = 0; c < 2 * n; c++) w[i]![c]! /= d;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = w[r]![i]!;
      for (let c = 0; c < 2 * n; c++) w[r]![c]! -= f * w[i]![c]!;
    }
  }
  return Matrix.of(w.map((r) => r.slice(n).map(tidy)));
});
define("MUNIT", "v", 1, 1, ([a]) => {
  const n = num(a as Scalar);
  if (isError(n)) return n;
  if (n < 1) return ERRORS["#VALUE!"];
  const size = Math.floor(n);
  return new Matrix(size, size, Array.from({ length: size * size }, (_, i) => (Math.floor(i / size) === i % size ? 1 : 0)));
});

define("SERIESSUM", "vvva", 4, 4, ([x, n, m, coeffs], ctx) => {
  const v = nums([x as Scalar, n as Scalar, m as Scalar]);
  if (isError(v)) return v;
  const cs = numbers([coeffs!], ctx);
  if (isError(cs)) return cs;
  return cs.reduce((s, c, i) => s + c * v[0]! ** (v[1]! + i * v[2]!), 0);
});
define("MULTINOMIAL", "a", 1, 255, (args, ctx) => {
  const ns = numbers(args, ctx);
  if (isError(ns)) return ns;
  if (ns.some((n) => n < 0)) return ERRORS["#NUM!"];
  const total = ns.reduce((s, n) => s + Math.floor(n), 0);
  return Math.round(ns.reduce((r, n) => r / factorial(n), factorial(total)));
});
