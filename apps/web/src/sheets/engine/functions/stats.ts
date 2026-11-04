// Statistical functions: counts, averages, spread, ranks, percentiles, regression and distributions.
import {
  bool, checkNum, criteria, define, ERRORS, flatten, isError, isMissing, isRange, Matrix, num, numbers, nums, optNum, readRange, toMatrix,
  type Args, type Context, type Scalar, type Value,
} from "../evaluate";
import { tidy } from "../values";
import { combin, ifsMask, IFS_ARGS, PAIR_ARGS, factorial } from "./math";

const fromRefs = (args: Args, ctx: Context) => numbers(args, ctx);

// numbers where text and TRUE/FALSE in references count (AVERAGEA, MAXA…)
function numbersA(args: Args, ctx: Context): number[] | Scalar {
  return numbers(args, ctx, { text: "zero", bools: "count" }) as number[] | Scalar;
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
function sumSquares(xs: number[]): number {
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0);
}

const agg = (name: string, fn: (xs: number[]) => number | Scalar, a = false) =>
  define(name, "a", 1, 255, (args, ctx) => {
    const xs = a ? numbersA(args, ctx) : fromRefs(args, ctx);
    if (!Array.isArray(xs)) return xs as Scalar;
    const r = fn(xs);
    return typeof r === "number" ? checkNum(tidy(r)) : r;
  });

agg("AVERAGE", (xs) => (xs.length ? mean(xs) : ERRORS["#DIV/0!"]));
agg("AVERAGEA", (xs) => (xs.length ? mean(xs) : ERRORS["#DIV/0!"]), true);
agg("MAX", (xs) => (xs.length ? Math.max(...xs) : 0));
agg("MAXA", (xs) => (xs.length ? Math.max(...xs) : 0), true);
agg("MIN", (xs) => (xs.length ? Math.min(...xs) : 0));
agg("MINA", (xs) => (xs.length ? Math.min(...xs) : 0), true);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
agg("MEDIAN", (xs) => (xs.length ? median(xs) : ERRORS["#NUM!"]));
const variance = (sample: boolean) => (xs: number[]) => (xs.length < (sample ? 2 : 1) ? ERRORS["#DIV/0!"] : sumSquares(xs) / (xs.length - (sample ? 1 : 0)));
for (const [names, sample, a] of [
  [["VAR.S", "VAR"], true, false], [["VAR.P", "VARP"], false, false], [["VARA"], true, true], [["VARPA"], false, true],
] as const) for (const name of names) agg(name, variance(sample), a);
for (const [names, sample, a] of [
  [["STDEV.S", "STDEV"], true, false], [["STDEV.P", "STDEVP"], false, false], [["STDEVA"], true, true], [["STDEVPA"], false, true],
] as const)
  for (const name of names)
    agg(name, (xs) => {
      const v = variance(sample)(xs);
      return typeof v === "number" ? Math.sqrt(v) : v;
    }, a);
agg("DEVSQ", (xs) => (xs.length ? sumSquares(xs) : ERRORS["#NUM!"]));
agg("AVEDEV", (xs) => {
  if (!xs.length) return ERRORS["#NUM!"];
  const m = mean(xs);
  return xs.reduce((s, x) => s + Math.abs(x - m), 0) / xs.length;
});
agg("GEOMEAN", (xs) => (!xs.length || xs.some((x) => x <= 0) ? ERRORS["#NUM!"] : Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length)));
agg("HARMEAN", (xs) => (!xs.length || xs.some((x) => x <= 0) ? ERRORS["#NUM!"] : xs.length / xs.reduce((s, x) => s + 1 / x, 0)));
agg("KURT", (xs) => {
  const n = xs.length;
  if (n < 4) return ERRORS["#DIV/0!"];
  const m = mean(xs);
  const s = Math.sqrt(sumSquares(xs) / (n - 1));
  if (s === 0) return ERRORS["#DIV/0!"];
  const k = xs.reduce((t, x) => t + ((x - m) / s) ** 4, 0);
  return ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * k - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
});
agg("SKEW", (xs) => {
  const n = xs.length;
  if (n < 3) return ERRORS["#DIV/0!"];
  const m = mean(xs);
  const s = Math.sqrt(sumSquares(xs) / (n - 1));
  if (s === 0) return ERRORS["#DIV/0!"];
  return (n / ((n - 1) * (n - 2))) * xs.reduce((t, x) => t + ((x - m) / s) ** 3, 0);
});
agg("SKEW.P", (xs) => {
  const n = xs.length;
  if (n < 1) return ERRORS["#DIV/0!"];
  const m = mean(xs);
  const s = Math.sqrt(sumSquares(xs) / n);
  if (s === 0) return ERRORS["#DIV/0!"];
  return xs.reduce((t, x) => t + ((x - m) / s) ** 3, 0) / n;
});
for (const name of ["MODE.SNGL", "MODE"])
  agg(name, (xs) => {
    const counts = new Map<number, number>();
    let best: number | null = null;
    let bestCount = 1;
    for (const x of xs) {
      const c = (counts.get(x) ?? 0) + 1;
      counts.set(x, c);
      if (c > bestCount) {
        best = x;
        bestCount = c;
      }
    }
    return best === null ? ERRORS["#N/A"] : best;
  });
define("MODE.MULT", "a", 1, 255, (args, ctx) => {
  const xs = fromRefs(args, ctx);
  if (isError(xs)) return xs;
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  const most = Math.max(...counts.values());
  if (most < 2) return ERRORS["#N/A"];
  const out = [...counts.entries()].filter(([, c]) => c === most).map(([x]) => [x]);
  return Matrix.of(out);
});

// counting
define("COUNT", "a", 1, 255, (args, ctx) => {
  let n = 0;
  for (const arg of args) {
    if (isMissing(arg)) continue;
    if (isRange(arg) || arg instanceof Matrix) {
      for (const v of flatten([arg], ctx)) if (typeof v === "number") n++;
    } else {
      const v = arg as Scalar;
      if (typeof v === "number" || typeof v === "boolean") n++;
      else if (typeof v === "string" && !isError(num(v))) n++;
    }
  }
  return n;
});
define("COUNTA", "a", 1, 255, (args, ctx) => {
  let n = 0;
  for (const arg of args) {
    if (isMissing(arg)) continue;
    if (isRange(arg) || arg instanceof Matrix) {
      for (const v of flatten([arg], ctx)) if (v !== null) n++;
    } else n++;
  }
  return n;
});
define("COUNTBLANK", "a", 1, 1, ([range], ctx) => {
  if (!isRange(range)) return ERRORS["#VALUE!"];
  const m = readRange(range, ctx, false);
  return m.data.filter((v) => v === null || v === "").length;
});
define("COUNTIF", "av", 2, 2, ([range, crit], ctx) => {
  const m = toMatrix(range!, ctx);
  const test = criteria(crit as Scalar);
  let n = 0;
  for (const v of m.data) if (test(v)) n++;
  // whole columns: the empty cells past the used area count for "" and "="
  if (isRange(range) && test(null)) {
    const full = (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);
    n += full - m.data.length;
  }
  return n;
});
define("COUNTIFS", PAIR_ARGS, 2, 254, (pairs, ctx) => {
  if (pairs.length % 2) return ERRORS["#VALUE!"];
  const found = ifsMask(null, pairs, ctx);
  if (!found) return ERRORS["#VALUE!"];
  return found.mask.filter(Boolean).length;
});
define("AVERAGEIF", "ava", 2, 3, ([range, crit, avg], ctx) => {
  const where = toMatrix(range!, ctx);
  const values = avg === undefined || isMissing(avg) ? where : isRange(avg) ? readRange({ ...avg, r2: avg.r1 + where.rows - 1, c2: avg.c1 + where.cols - 1 }, ctx, false) : toMatrix(avg, ctx);
  const test = criteria(crit as Scalar);
  let total = 0;
  let n = 0;
  for (let i = 0; i < where.data.length; i++) {
    if (!test(where.data[i] ?? null)) continue;
    const v = values.data[i];
    if (isError(v)) return v;
    if (typeof v === "number") {
      total += v;
      n++;
    }
  }
  return n ? tidy(total / n) : ERRORS["#DIV/0!"];
});
const ifsAgg = (name: string, fn: (xs: number[]) => Scalar) =>
  define(name, IFS_ARGS, 3, 255, ([values, ...pairs], ctx) => {
    if (pairs.length % 2) return ERRORS["#VALUE!"];
    const found = ifsMask(values!, pairs, ctx);
    if (!found) return ERRORS["#VALUE!"];
    const xs: number[] = [];
    for (let i = 0; i < found.mask.length; i++) {
      if (!found.mask[i]) continue;
      const v = found.values!.data[i];
      if (isError(v)) return v;
      if (typeof v === "number") xs.push(v);
    }
    return fn(xs);
  });
ifsAgg("AVERAGEIFS", (xs) => (xs.length ? tidy(mean(xs)) : ERRORS["#DIV/0!"]));
ifsAgg("MAXIFS", (xs) => (xs.length ? Math.max(...xs) : 0));
ifsAgg("MINIFS", (xs) => (xs.length ? Math.min(...xs) : 0));

// order statistics
define("LARGE", "av", 2, 2, ([data, k], ctx) => {
  const xs = fromRefs([data!], ctx);
  if (isError(xs)) return xs;
  const n = num(k as Scalar);
  if (isError(n)) return n;
  const i = Math.ceil(n);
  if (i < 1 || i > xs.length) return ERRORS["#NUM!"];
  return [...xs].sort((a, b) => b - a)[i - 1]!;
});
define("SMALL", "av", 2, 2, ([data, k], ctx) => {
  const xs = fromRefs([data!], ctx);
  if (isError(xs)) return xs;
  const n = num(k as Scalar);
  if (isError(n)) return n;
  const i = Math.ceil(n);
  if (i < 1 || i > xs.length) return ERRORS["#NUM!"];
  return [...xs].sort((a, b) => a - b)[i - 1]!;
});
const rank = (avg: boolean) => ([x, ref, order]: Args, ctx: Context): Value => {
  const n = num(x as Scalar);
  if (isError(n)) return n;
  const xs = fromRefs([ref!], ctx);
  if (isError(xs)) return xs;
  const asc = order !== undefined && !isMissing(order) && order !== null && order !== 0 && order !== false;
  const equal = xs.filter((v) => v === n).length;
  if (!equal) return ERRORS["#N/A"];
  const better = xs.filter((v) => (asc ? v < n : v > n)).length;
  return avg ? better + (equal + 1) / 2 : better + 1;
};
define("RANK", "vav", 2, 3, rank(false));
define("RANK.EQ", "vav", 2, 3, rank(false));
define("RANK.AVG", "vav", 2, 3, rank(true));

function percentileInc(xs: number[], k: number): Scalar {
  if (!xs.length || k < 0 || k > 1) return ERRORS["#NUM!"];
  const s = [...xs].sort((a, b) => a - b);
  const pos = k * (s.length - 1);
  const lo = Math.floor(pos);
  const frac = pos - lo;
  return tidy(s[lo]! + (lo + 1 < s.length ? frac * (s[lo + 1]! - s[lo]!) : 0));
}
function percentileExc(xs: number[], k: number): Scalar {
  const n = xs.length;
  if (!n || k <= 0 || k >= 1) return ERRORS["#NUM!"];
  const pos = k * (n + 1) - 1;
  if (pos < 0 || pos > n - 1) return ERRORS["#NUM!"];
  const s = [...xs].sort((a, b) => a - b);
  const lo = Math.floor(pos);
  const frac = pos - lo;
  return tidy(s[lo]! + (lo + 1 < n ? frac * (s[lo + 1]! - s[lo]!) : 0));
}
const withK = (name: string, fn: (xs: number[], k: number) => Scalar) =>
  define(name, "av", 2, 2, ([data, k], ctx) => {
    const xs = fromRefs([data!], ctx);
    if (isError(xs)) return xs;
    const n = num(k as Scalar);
    if (isError(n)) return n;
    return fn(xs, n);
  });
withK("PERCENTILE", percentileInc);
withK("PERCENTILE.INC", percentileInc);
withK("PERCENTILE.EXC", percentileExc);
withK("QUARTILE", (xs, q) => (q < 0 || q > 4 ? ERRORS["#NUM!"] : percentileInc(xs, Math.floor(q) / 4)));
withK("QUARTILE.INC", (xs, q) => (q < 0 || q > 4 ? ERRORS["#NUM!"] : percentileInc(xs, Math.floor(q) / 4)));
withK("QUARTILE.EXC", (xs, q) => (q <= 0 || q >= 4 ? ERRORS["#NUM!"] : percentileExc(xs, Math.floor(q) / 4)));
const percentRank = (exclusive: boolean) => ([data, x, sig]: Args, ctx: Context): Value => {
  const xs = fromRefs([data!], ctx);
  if (isError(xs)) return xs;
  const v = num(x as Scalar);
  if (isError(v)) return v;
  const digits = optNum(sig as Scalar, 3);
  if (isError(digits)) return digits;
  if (digits < 1 || !xs.length) return ERRORS["#NUM!"];
  const s = [...xs].sort((a, b) => a - b);
  if (v < s[0]! || v > s[s.length - 1]!) return ERRORS["#N/A"];
  const n = s.length;
  const position = (value: number) => {
    const below = s.filter((y) => y < value).length;
    return exclusive ? (below + 1) / (n + 1) : n === 1 ? 1 : below / (n - 1);
  };
  let r: number;
  const exact = s.indexOf(v);
  if (exact >= 0) r = position(v);
  else {
    const hi = s.findIndex((y) => y > v);
    const lo = s[hi - 1]!;
    const up = s[hi]!;
    const pl = position(lo);
    const pu = position(up);
    r = pl + ((v - lo) / (up - lo)) * (pu - pl);
  }
  const f = 10 ** Math.floor(digits);
  return Math.floor(Number((r * f).toPrecision(12))) / f;
};
define("PERCENTRANK", "avv", 2, 3, percentRank(false));
define("PERCENTRANK.INC", "avv", 2, 3, percentRank(false));
define("PERCENTRANK.EXC", "avv", 2, 3, percentRank(true));
define("TRIMMEAN", "av", 2, 2, ([data, p], ctx) => {
  const xs = fromRefs([data!], ctx);
  if (isError(xs)) return xs;
  const share = num(p as Scalar);
  if (isError(share)) return share;
  if (share < 0 || share >= 1 || !xs.length) return ERRORS["#NUM!"];
  const cut = Math.floor((xs.length * share) / 2);
  const s = [...xs].sort((a, b) => a - b).slice(cut, xs.length - cut);
  return tidy(mean(s));
});
define("FREQUENCY", "a", 2, 2, ([data, bins], ctx) => {
  const xs = fromRefs([data!], ctx);
  if (isError(xs)) return xs;
  const bs = fromRefs([bins!], ctx);
  if (isError(bs)) return bs;
  const order = bs.map((b, i) => ({ b, i })).sort((a, b) => a.b - b.b);
  const counts = new Array<number>(bs.length + 1).fill(0);
  for (const x of xs) {
    const slot = order.find((o) => x <= o.b);
    counts[slot ? slot.i : bs.length]!++;
  }
  return new Matrix(counts.length, 1, counts);
});
define("STANDARDIZE", "v", 3, 3, (args) => {
  const v = nums(args as Scalar[]);
  if (isError(v)) return v;
  const [x, m, s] = v as [number, number, number];
  return s <= 0 ? ERRORS["#NUM!"] : (x - m) / s;
});

// pairs of numbers (regression, correlation): pairs where either side is not a number are skipped
function pairs(a: Value, b: Value, ctx: Context): [number[], number[]] | Scalar {
  const x = toMatrix(a, ctx);
  const y = toMatrix(b, ctx);
  if (x.data.length !== y.data.length) return ERRORS["#N/A"];
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < x.data.length; i++) {
    const p = x.data[i];
    const q = y.data[i];
    if (isError(p)) return p;
    if (isError(q)) return q;
    if (typeof p === "number" && typeof q === "number") {
      xs.push(p);
      ys.push(q);
    }
  }
  return [xs, ys];
}
const pair = (name: string, fn: (ys: number[], xs: number[]) => Scalar, swap = false) =>
  define(name, "a", 2, 2, ([a, b], ctx) => {
    const p = pairs(a!, b!, ctx);
    if (!Array.isArray(p)) return p;
    return swap ? fn(p[1], p[0]) : fn(p[0], p[1]);
  });
function covariance(xs: number[], ys: number[], sample: boolean): Scalar {
  const n = xs.length;
  if (n < (sample ? 2 : 1)) return ERRORS["#DIV/0!"];
  const mx = mean(xs);
  const my = mean(ys);
  return xs.reduce((s, x, i) => s + (x - mx) * (ys[i]! - my), 0) / (n - (sample ? 1 : 0));
}
function correlation(xs: number[], ys: number[]): Scalar {
  if (xs.length < 2) return ERRORS["#DIV/0!"];
  const sx = Math.sqrt(sumSquares(xs));
  const sy = Math.sqrt(sumSquares(ys));
  if (sx === 0 || sy === 0) return ERRORS["#DIV/0!"];
  const mx = mean(xs);
  const my = mean(ys);
  return xs.reduce((s, x, i) => s + (x - mx) * (ys[i]! - my), 0) / (sx * sy);
}
pair("CORREL", correlation);
pair("PEARSON", correlation);
pair("RSQ", (a, b) => {
  const r = correlation(a, b);
  return typeof r === "number" ? r * r : r;
});
pair("COVAR", (a, b) => covariance(a, b, false));
pair("COVARIANCE.P", (a, b) => covariance(a, b, false));
pair("COVARIANCE.S", (a, b) => covariance(a, b, true));
function slope(ys: number[], xs: number[]): Scalar {
  if (xs.length < 1) return ERRORS["#DIV/0!"];
  const sxx = sumSquares(xs);
  if (sxx === 0) return ERRORS["#DIV/0!"];
  const mx = mean(xs);
  const my = mean(ys);
  return xs.reduce((s, x, i) => s + (x - mx) * (ys[i]! - my), 0) / sxx;
}
pair("SLOPE", slope);
pair("INTERCEPT", (ys, xs) => {
  const b = slope(ys, xs);
  return typeof b === "number" ? mean(ys) - b * mean(xs) : b;
});
pair("STEYX", (ys, xs) => {
  const n = xs.length;
  if (n < 3) return ERRORS["#DIV/0!"];
  const b = slope(ys, xs);
  if (typeof b !== "number") return b;
  const a = mean(ys) - b * mean(xs);
  const sse = xs.reduce((s, x, i) => s + (ys[i]! - (a + b * x)) ** 2, 0);
  return Math.sqrt(sse / (n - 2));
});
for (const name of ["FORECAST", "FORECAST.LINEAR"])
  define(name, "vaa", 3, 3, ([x, ky, kx], ctx) => {
    const v = num(x as Scalar);
    if (isError(v)) return v;
    const p = pairs(ky!, kx!, ctx);
    if (!Array.isArray(p)) return p;
    const b = slope(p[0], p[1]);
    if (typeof b !== "number") return b;
    return tidy(mean(p[0]) - b * mean(p[1]) + b * v);
  });

/** Least squares for LINEST/TREND/GROWTH: y = b + m·x, one x column. */
function fit(ys: number[], xs: number[]): { m: number; b: number } | null {
  const b = slope(ys, xs);
  if (typeof b !== "number") return null;
  return { m: b, b: mean(ys) - b * mean(xs) };
}
define("TREND", "a", 1, 4, ([ky, kx, nx], ctx) => {
  const y = toMatrix(ky!, ctx);
  const ys = y.data.filter((v): v is number => typeof v === "number");
  const xs = kx === undefined || isMissing(kx) ? ys.map((_, i) => i + 1) : (toMatrix(kx, ctx).data.filter((v) => typeof v === "number") as number[]);
  const line = fit(ys, xs);
  if (!line) return ERRORS["#VALUE!"];
  const targets = nx === undefined || isMissing(nx) ? new Matrix(xs.length, 1, xs) : toMatrix(nx, ctx);
  return targets.map((v) => (typeof v === "number" ? tidy(line.b + line.m * v) : ERRORS["#VALUE!"]));
});
define("GROWTH", "a", 1, 4, ([ky, kx, nx], ctx) => {
  const ys = toMatrix(ky!, ctx).data.filter((v): v is number => typeof v === "number");
  if (ys.some((v) => v <= 0)) return ERRORS["#NUM!"];
  const xs = kx === undefined || isMissing(kx) ? ys.map((_, i) => i + 1) : (toMatrix(kx, ctx).data.filter((v) => typeof v === "number") as number[]);
  const line = fit(ys.map(Math.log), xs);
  if (!line) return ERRORS["#VALUE!"];
  const targets = nx === undefined || isMissing(nx) ? new Matrix(xs.length, 1, xs) : toMatrix(nx, ctx);
  return targets.map((v) => (typeof v === "number" ? Math.exp(line.b + line.m * v) : ERRORS["#VALUE!"]));
});
define("LINEST", "a", 1, 4, ([ky, kx, c], ctx) => {
  const ys = toMatrix(ky!, ctx).data.filter((v): v is number => typeof v === "number");
  const xs = kx === undefined || isMissing(kx) ? ys.map((_, i) => i + 1) : (toMatrix(kx, ctx).data.filter((v) => typeof v === "number") as number[]);
  const withConst = c === undefined || isMissing(c) ? true : bool(c as Scalar) !== false;
  if (!withConst) {
    const m = xs.reduce((s, x, i) => s + x * ys[i]!, 0) / xs.reduce((s, x) => s + x * x, 0);
    return Matrix.of([[m, 0]]);
  }
  const line = fit(ys, xs);
  return line ? Matrix.of([[tidy(line.m), tidy(line.b)]]) : ERRORS["#VALUE!"];
});

// ------------------------------------------------------------------------- special functions

const LANCZOS = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
export function gammaln(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - gammaln(1 - x);
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < 8; i++) a += LANCZOS[i]! / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
export function gamma(x: number): number {
  if (Number.isInteger(x) && x <= 0) return NaN;
  if (Number.isInteger(x) && x <= 171) return factorial(x - 1);
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x));
  return Math.exp(gammaln(x));
}
/** Regularized lower incomplete gamma P(a, x). */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 500; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - gammaln(a));
  }
  // continued fraction for Q
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - gammaln(a)) * h;
}
function betacf(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-300) d = 1e-300;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 500; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}
/** Regularized incomplete beta I_x(a, b). */
export function betaI(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}
export function erf(x: number): number {
  // high-precision erf from the incomplete gamma function
  const r = gammaP(0.5, x * x);
  return x < 0 ? -r : r;
}
const normCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
const normPdf = (z: number) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
/** Inverse of the standard normal CDF (Acklam), polished with one Newton step. */
export function normInv(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  let x: number;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  } else if (p <= 1 - lo) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const e = normCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}
/** Invert a CDF on [lo, hi] by bisection. */
function invert(cdf: (x: number) => number, p: number, lo: number, hi: number): number {
  while (cdf(hi) < p && hi < 1e10) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) < p) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-14 * Math.max(1, Math.abs(mid))) break;
  }
  return (lo + hi) / 2;
}

const tCdf = (t: number, df: number) => {
  const x = df / (df + t * t);
  const tail = 0.5 * betaI(x, df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
};
const chiCdf = (x: number, k: number) => gammaP(k / 2, x / 2);
const fCdf = (x: number, d1: number, d2: number) => (x <= 0 ? 0 : betaI((d1 * x) / (d1 * x + d2), d1 / 2, d2 / 2));

const dist = (name: string, count: number, fn: (v: number[], cumulative: boolean) => number | Scalar, hasCumulative = true) =>
  define(name, "v", count + (hasCumulative ? 1 : 0), count + (hasCumulative ? 1 : 0), (args) => {
    const v = nums(args.slice(0, count) as Scalar[]);
    if (isError(v)) return v;
    const cumulative = hasCumulative ? bool(args[count] as Scalar) : false;
    if (isError(cumulative)) return cumulative;
    const r = fn(v, cumulative as boolean);
    return typeof r === "number" ? checkNum(r) : r;
  });

dist("NORM.DIST", 3, ([x, m, s], cum) => (s! <= 0 ? ERRORS["#NUM!"] : cum ? normCdf((x! - m!) / s!) : normPdf((x! - m!) / s!) / s!));
dist("NORMDIST", 3, ([x, m, s], cum) => (s! <= 0 ? ERRORS["#NUM!"] : cum ? normCdf((x! - m!) / s!) : normPdf((x! - m!) / s!) / s!));
dist("NORM.S.DIST", 1, ([z], cum) => (cum ? normCdf(z!) : normPdf(z!)));
dist("NORMSDIST", 1, ([z]) => normCdf(z!), false);
for (const name of ["NORM.INV", "NORMINV"]) dist(name, 3, ([p, m, s]) => (p! <= 0 || p! >= 1 || s! <= 0 ? ERRORS["#NUM!"] : m! + s! * normInv(p!)), false);
for (const name of ["NORM.S.INV", "NORMSINV"]) dist(name, 1, ([p]) => (p! <= 0 || p! >= 1 ? ERRORS["#NUM!"] : normInv(p!)), false);
dist("PHI", 1, ([x]) => normPdf(x!), false);
dist("GAUSS", 1, ([x]) => normCdf(x!) - 0.5, false);
dist("LOGNORM.DIST", 3, ([x, m, s], cum) => (x! <= 0 || s! <= 0 ? ERRORS["#NUM!"] : cum ? normCdf((Math.log(x!) - m!) / s!) : normPdf((Math.log(x!) - m!) / s!) / (x! * s!)));
dist("LOGNORM.INV", 3, ([p, m, s]) => (p! <= 0 || p! >= 1 || s! <= 0 ? ERRORS["#NUM!"] : Math.exp(m! + s! * normInv(p!))), false);
dist("EXPON.DIST", 2, ([x, l], cum) => (x! < 0 || l! <= 0 ? ERRORS["#NUM!"] : cum ? 1 - Math.exp(-l! * x!) : l! * Math.exp(-l! * x!)));
dist("EXPONDIST", 2, ([x, l], cum) => (x! < 0 || l! <= 0 ? ERRORS["#NUM!"] : cum ? 1 - Math.exp(-l! * x!) : l! * Math.exp(-l! * x!)));
dist("POISSON.DIST", 2, ([x, m], cum) => {
  const k = Math.floor(x!);
  if (k < 0 || m! < 0) return ERRORS["#NUM!"];
  if (cum) return 1 - gammaP(k + 1, m!);
  return Math.exp(k * Math.log(m!) - m! - gammaln(k + 1));
});
dist("POISSON", 2, ([x, m], cum) => {
  const k = Math.floor(x!);
  if (k < 0 || m! < 0) return ERRORS["#NUM!"];
  return cum ? 1 - gammaP(k + 1, m!) : Math.exp(k * Math.log(m!) - m! - gammaln(k + 1));
});
for (const name of ["BINOM.DIST", "BINOMDIST"])
  dist(name, 3, ([x, n, p], cum) => {
    const k = Math.floor(x!);
    const trials = Math.floor(n!);
    if (k < 0 || k > trials || p! < 0 || p! > 1) return ERRORS["#NUM!"];
    const pmf = (i: number) => combin(trials, i) * p! ** i * (1 - p!) ** (trials - i);
    if (!cum) return pmf(k);
    let s = 0;
    for (let i = 0; i <= k; i++) s += pmf(i);
    return Math.min(1, s);
  });
dist("BINOM.INV", 3, ([n, p, alpha]) => {
  const trials = Math.floor(n!);
  if (trials < 0 || p! < 0 || p! > 1 || alpha! <= 0 || alpha! >= 1) return ERRORS["#NUM!"];
  let s = 0;
  for (let i = 0; i <= trials; i++) {
    s += combin(trials, i) * p! ** i * (1 - p!) ** (trials - i);
    if (s >= alpha! - 1e-12) return i;
  }
  return trials;
}, false);
dist("NEGBINOM.DIST", 3, ([f, s, p], cum) => {
  const k = Math.floor(f!);
  const r = Math.floor(s!);
  if (k < 0 || r < 1 || p! <= 0 || p! > 1) return ERRORS["#NUM!"];
  const pmf = (i: number) => combin(i + r - 1, r - 1) * p! ** r * (1 - p!) ** i;
  if (!cum) return pmf(k);
  let t = 0;
  for (let i = 0; i <= k; i++) t += pmf(i);
  return t;
});
dist("HYPGEOM.DIST", 4, ([x, n, K, N], cum) => {
  const k = Math.floor(x!);
  const draws = Math.floor(n!);
  const succ = Math.floor(K!);
  const pop = Math.floor(N!);
  if (k < 0 || draws > pop || succ > pop || k > draws || k > succ) return ERRORS["#NUM!"];
  const pmf = (i: number) => (combin(succ, i) * combin(pop - succ, draws - i)) / combin(pop, draws);
  if (!cum) return pmf(k);
  let t = 0;
  for (let i = 0; i <= k; i++) t += pmf(i);
  return t;
});
dist("T.DIST", 2, ([t, df], cum) => {
  if (df! < 1) return ERRORS["#NUM!"];
  const n = df!;
  return cum ? tCdf(t!, n) : Math.exp(gammaln((n + 1) / 2) - gammaln(n / 2)) / Math.sqrt(n * Math.PI) * (1 + (t! * t!) / n) ** (-(n + 1) / 2);
});
dist("T.DIST.2T", 2, ([t, df]) => (t! < 0 || df! < 1 ? ERRORS["#NUM!"] : 2 * (1 - tCdf(t!, Math.floor(df!)))), false);
dist("T.DIST.RT", 2, ([t, df]) => (df! < 1 ? ERRORS["#NUM!"] : 1 - tCdf(t!, Math.floor(df!))), false);
dist("TDIST", 3, ([t, df, tails]) => (t! < 0 || df! < 1 ? ERRORS["#NUM!"] : (tails === 1 ? 1 : 2) * (1 - tCdf(t!, Math.floor(df!)))), false);
dist("T.INV", 2, ([p, df]) => (p! <= 0 || p! >= 1 || df! < 1 ? ERRORS["#NUM!"] : p! < 0.5 ? -invert((t) => tCdf(t, df!), 1 - p!, 0, 10) : invert((t) => tCdf(t, df!), p!, 0, 10)), false);
for (const name of ["T.INV.2T", "TINV"]) dist(name, 2, ([p, df]) => (p! <= 0 || p! > 1 || df! < 1 ? ERRORS["#NUM!"] : invert((t) => tCdf(t, df!), 1 - p! / 2, 0, 10)), false);
dist("CHISQ.DIST", 2, ([x, k], cum) => {
  if (x! < 0 || k! < 1) return ERRORS["#NUM!"];
  const n = Math.floor(k!);
  return cum ? chiCdf(x!, n) : Math.exp((n / 2 - 1) * Math.log(x!) - x! / 2 - (n / 2) * Math.log(2) - gammaln(n / 2));
});
for (const name of ["CHISQ.DIST.RT", "CHIDIST"]) dist(name, 2, ([x, k]) => (x! < 0 || k! < 1 ? ERRORS["#NUM!"] : 1 - chiCdf(x!, Math.floor(k!))), false);
dist("CHISQ.INV", 2, ([p, k]) => (p! < 0 || p! > 1 || k! < 1 ? ERRORS["#NUM!"] : invert((x) => chiCdf(x, Math.floor(k!)), p!, 0, Math.max(10, k! * 4))), false);
for (const name of ["CHISQ.INV.RT", "CHIINV"]) dist(name, 2, ([p, k]) => (p! < 0 || p! > 1 || k! < 1 ? ERRORS["#NUM!"] : invert((x) => chiCdf(x, Math.floor(k!)), 1 - p!, 0, Math.max(10, k! * 4))), false);
dist("F.DIST", 3, ([x, a, b], cum) => {
  if (x! < 0 || a! < 1 || b! < 1) return ERRORS["#NUM!"];
  const d1 = Math.floor(a!);
  const d2 = Math.floor(b!);
  if (cum) return fCdf(x!, d1, d2);
  return Math.exp(0.5 * (d1 * Math.log(d1 * x!) + d2 * Math.log(d2) - (d1 + d2) * Math.log(d1 * x! + d2)) - Math.log(x!) - (gammaln(d1 / 2) + gammaln(d2 / 2) - gammaln((d1 + d2) / 2)));
});
for (const name of ["F.DIST.RT", "FDIST"]) dist(name, 3, ([x, a, b]) => (x! < 0 || a! < 1 || b! < 1 ? ERRORS["#NUM!"] : 1 - fCdf(x!, Math.floor(a!), Math.floor(b!))), false);
dist("F.INV", 3, ([p, a, b]) => (p! < 0 || p! > 1 ? ERRORS["#NUM!"] : invert((x) => fCdf(x, Math.floor(a!), Math.floor(b!)), p!, 0, 100)), false);
for (const name of ["F.INV.RT", "FINV"]) dist(name, 3, ([p, a, b]) => (p! < 0 || p! > 1 ? ERRORS["#NUM!"] : invert((x) => fCdf(x, Math.floor(a!), Math.floor(b!)), 1 - p!, 0, 100)), false);
dist("GAMMA.DIST", 3, ([x, a, b], cum) => {
  if (x! < 0 || a! <= 0 || b! <= 0) return ERRORS["#NUM!"];
  return cum ? gammaP(a!, x! / b!) : Math.exp((a! - 1) * Math.log(x!) - x! / b! - gammaln(a!) - a! * Math.log(b!));
});
dist("GAMMA.INV", 3, ([p, a, b]) => (p! < 0 || p! > 1 || a! <= 0 || b! <= 0 ? ERRORS["#NUM!"] : invert((x) => gammaP(a!, x / b!), p!, 0, a! * b! * 10)), false);
dist("GAMMA", 1, ([x]) => (x! <= 0 && Number.isInteger(x!) ? ERRORS["#NUM!"] : gamma(x!)), false);
for (const name of ["GAMMALN", "GAMMALN.PRECISE"]) dist(name, 1, ([x]) => (x! <= 0 ? ERRORS["#NUM!"] : gammaln(x!)), false);
define("BETA.DIST", "v", 4, 6, (args) => {
  const v = nums([args[0], args[1], args[2]] as Scalar[]);
  if (isError(v)) return v;
  const cum = bool(args[3] as Scalar);
  if (isError(cum)) return cum;
  const A = optNum(args[4] as Scalar, 0);
  const B = optNum(args[5] as Scalar, 1);
  if (isError(A) || isError(B)) return ERRORS["#VALUE!"];
  const [x, a, b] = v as [number, number, number];
  if (a <= 0 || b <= 0 || x < A || x > B || A === B) return ERRORS["#NUM!"];
  const t = (x - A) / (B - A);
  if (cum) return betaI(t, a, b);
  return Math.exp((a - 1) * Math.log(t) + (b - 1) * Math.log(1 - t) - (gammaln(a) + gammaln(b) - gammaln(a + b))) / (B - A);
});
define("BETA.INV", "v", 3, 5, (args) => {
  const v = nums([args[0], args[1], args[2]] as Scalar[]);
  if (isError(v)) return v;
  const A = optNum(args[3] as Scalar, 0);
  const B = optNum(args[4] as Scalar, 1);
  if (isError(A) || isError(B)) return ERRORS["#VALUE!"];
  const [p, a, b] = v as [number, number, number];
  if (p < 0 || p > 1 || a <= 0 || b <= 0) return ERRORS["#NUM!"];
  return A + (B - A) * invert((t) => betaI(t, a, b), p, 0, 1);
});
dist("WEIBULL.DIST", 3, ([x, a, b], cum) => (x! < 0 || a! <= 0 || b! <= 0 ? ERRORS["#NUM!"] : cum ? 1 - Math.exp(-((x! / b!) ** a!)) : (a! / b! ** a!) * x! ** (a! - 1) * Math.exp(-((x! / b!) ** a!))));
dist("CONFIDENCE.NORM", 3, ([alpha, s, n]) => (alpha! <= 0 || alpha! >= 1 || s! <= 0 || n! < 1 ? ERRORS["#NUM!"] : (normInv(1 - alpha! / 2) * s!) / Math.sqrt(Math.floor(n!))), false);
dist("CONFIDENCE", 3, ([alpha, s, n]) => (alpha! <= 0 || alpha! >= 1 || s! <= 0 || n! < 1 ? ERRORS["#NUM!"] : (normInv(1 - alpha! / 2) * s!) / Math.sqrt(Math.floor(n!))), false);
dist("CONFIDENCE.T", 3, ([alpha, s, n]) => (alpha! <= 0 || alpha! >= 1 || s! <= 0 || n! < 2 ? ERRORS["#NUM!"] : (invert((t) => tCdf(t, Math.floor(n!) - 1), 1 - alpha! / 2, 0, 10) * s!) / Math.sqrt(Math.floor(n!))), false);
dist("FISHER", 1, ([x]) => (Math.abs(x!) >= 1 ? ERRORS["#NUM!"] : 0.5 * Math.log((1 + x!) / (1 - x!))), false);
dist("FISHERINV", 1, ([y]) => Math.tanh(y!), false);
dist("ERF", 1, ([x]) => erf(x!), false);
dist("ERF.PRECISE", 1, ([x]) => erf(x!), false);
dist("ERFC", 1, ([x]) => 1 - erf(x!), false);
dist("ERFC.PRECISE", 1, ([x]) => 1 - erf(x!), false);

define("T.TEST", "aavv", 4, 4, ([a, b, tails, type], ctx) => {
  const t1 = num(tails as Scalar);
  const t2 = num(type as Scalar);
  if (isError(t1)) return t1;
  if (isError(t2)) return t2;
  let xs: number[];
  let ys: number[];
  if (Math.floor(t2) === 1) {
    const p = pairs(a!, b!, ctx);
    if (!Array.isArray(p)) return p;
    [xs, ys] = p;
    const d = xs.map((x, i) => x - ys[i]!);
    const n = d.length;
    const t = mean(d) / Math.sqrt(sumSquares(d) / (n - 1) / n);
    return (t1 === 1 ? 1 : 2) * (1 - tCdf(Math.abs(t), n - 1));
  }
  const x = numbers([a!], ctx);
  const y = numbers([b!], ctx);
  if (isError(x)) return x;
  if (isError(y)) return y;
  xs = x;
  ys = y;
  const n1 = xs.length;
  const n2 = ys.length;
  const v1 = sumSquares(xs) / (n1 - 1);
  const v2 = sumSquares(ys) / (n2 - 1);
  let t: number;
  let df: number;
  if (Math.floor(t2) === 2) {
    const sp = ((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2);
    t = (mean(xs) - mean(ys)) / Math.sqrt(sp * (1 / n1 + 1 / n2));
    df = n1 + n2 - 2;
  } else {
    t = (mean(xs) - mean(ys)) / Math.sqrt(v1 / n1 + v2 / n2);
    df = (v1 / n1 + v2 / n2) ** 2 / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1));
  }
  return (t1 === 1 ? 1 : 2) * (1 - tCdf(Math.abs(t), df));
});
define("Z.TEST", "avv", 2, 3, ([a, x, s], ctx) => {
  const xs = numbers([a!], ctx);
  if (isError(xs)) return xs;
  const v = num(x as Scalar);
  if (isError(v)) return v;
  const sigma = s === undefined || isMissing(s) ? Math.sqrt(sumSquares(xs) / (xs.length - 1)) : num(s as Scalar);
  if (isError(sigma)) return sigma;
  return 1 - normCdf((mean(xs) - v) / (sigma / Math.sqrt(xs.length)));
});
define("CHISQ.TEST", "a", 2, 2, ([a, b], ctx) => {
  const obs = toMatrix(a!, ctx);
  const exp = toMatrix(b!, ctx);
  if (obs.rows !== exp.rows || obs.cols !== exp.cols) return ERRORS["#N/A"];
  let chi = 0;
  for (let i = 0; i < obs.data.length; i++) {
    const o = obs.data[i];
    const e = exp.data[i];
    if (typeof o === "number" && typeof e === "number") chi += (o - e) ** 2 / e;
  }
  const df = obs.rows > 1 && obs.cols > 1 ? (obs.rows - 1) * (obs.cols - 1) : Math.max(obs.rows, obs.cols) - 1;
  return 1 - chiCdf(chi, df);
});
define("PROB", "aavv", 3, 4, ([xr, pr, lo, hi], ctx) => {
  const p = pairs(xr!, pr!, ctx);
  if (!Array.isArray(p)) return p;
  const low = num(lo as Scalar);
  if (isError(low)) return low;
  const high = hi === undefined || isMissing(hi) ? low : num(hi as Scalar);
  if (isError(high)) return high;
  return p[0].reduce((s, x, i) => (x >= low && x <= high ? s + p[1][i]! : s), 0);
});

export { readRange };
