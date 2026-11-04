// Financial functions: loans and annuities, cash-flow returns, depreciation and rates.
import { define, ERRORS, isError, isMissing, num, numbers, nums, optNum, toMatrix, type Context, type Scalar, type Value } from "../evaluate";

const opt = (v: Value | undefined, d: number): number | Scalar => (v === undefined || isMissing(v) || v === null ? d : num(v as Scalar));

function fvOf(rate: number, nper: number, pmt: number, pv: number, type: number): number {
  if (rate === 0) return -(pv + pmt * nper);
  const f = (1 + rate) ** nper;
  return -(pv * f + (pmt * (1 + rate * type) * (f - 1)) / rate);
}
function pmtOf(rate: number, nper: number, pv: number, fv: number, type: number): number {
  if (rate === 0) return -(pv + fv) / nper;
  const f = (1 + rate) ** nper;
  return (-(pv * f + fv) * rate) / ((1 + rate * type) * (f - 1));
}
function pvOf(rate: number, nper: number, pmt: number, fv: number, type: number): number {
  if (rate === 0) return -(fv + pmt * nper);
  const f = (1 + rate) ** nper;
  return -(fv + (pmt * (1 + rate * type) * (f - 1)) / rate) / f;
}
function ipmtOf(rate: number, per: number, nper: number, pv: number, fv: number, type: number): number {
  const pmt = pmtOf(rate, nper, pv, fv, type);
  if (per === 1 && type === 1) return 0;
  const balance = fvOf(rate, per - 1, pmt, pv, type);
  const interest = balance * rate;
  return type === 1 ? interest / (1 + rate) : interest;
}

const finance = (name: string, required: number, optional: number[], fn: (v: number[]) => number | Scalar) =>
  define(name, "v", required, required + optional.length, (args) => {
    const v: number[] = [];
    for (let i = 0; i < required + optional.length; i++) {
      const n = i < required ? num(args[i] as Scalar) : opt(args[i], optional[i - required]!);
      if (isError(n)) return n;
      v.push(n as number);
    }
    const r = fn(v);
    return typeof r === "number" ? (Number.isFinite(r) ? r : ERRORS["#NUM!"]) : r;
  });

finance("PMT", 3, [0, 0], ([rate, nper, pv, fv, type]) => (nper === 0 ? ERRORS["#NUM!"] : pmtOf(rate!, nper!, pv!, fv!, type ? 1 : 0)));
finance("FV", 3, [0, 0], ([rate, nper, pmt, pv, type]) => fvOf(rate!, nper!, pmt!, pv!, type ? 1 : 0));
finance("PV", 3, [0, 0], ([rate, nper, pmt, fv, type]) => pvOf(rate!, nper!, pmt!, fv!, type ? 1 : 0));
finance("NPER", 3, [0, 0], ([rate, pmt, pv, fv, type]) => {
  const t = type ? 1 : 0;
  if (rate === 0) return pmt === 0 ? ERRORS["#NUM!"] : -(pv! + fv!) / pmt!;
  const a = pmt! * (1 + rate! * t) - fv! * rate!;
  const b = pv! * rate! + pmt! * (1 + rate! * t);
  if (a / b <= 0) return ERRORS["#NUM!"];
  return Math.log(a / b) / Math.log(1 + rate!);
});
finance("IPMT", 4, [0, 0], ([rate, per, nper, pv, fv, type]) => (per! < 1 || per! > nper! ? ERRORS["#NUM!"] : ipmtOf(rate!, per!, nper!, pv!, fv!, type ? 1 : 0)));
finance("PPMT", 4, [0, 0], ([rate, per, nper, pv, fv, type]) => {
  if (per! < 1 || per! > nper!) return ERRORS["#NUM!"];
  const t = type ? 1 : 0;
  return pmtOf(rate!, nper!, pv!, fv!, t) - ipmtOf(rate!, per!, nper!, pv!, fv!, t);
});
finance("ISPMT", 4, [], ([rate, per, nper, pv]) => (nper === 0 ? ERRORS["#DIV/0!"] : pv! * rate! * (per! / nper! - 1)));
finance("CUMIPMT", 6, [], ([rate, nper, pv, start, end, type]) => {
  if (rate! <= 0 || nper! <= 0 || pv! <= 0 || start! < 1 || end! < start! || end! > nper! || (type !== 0 && type !== 1)) return ERRORS["#NUM!"];
  let s = 0;
  for (let p = Math.ceil(start!); p <= Math.floor(end!); p++) s += ipmtOf(rate!, p, nper!, pv!, 0, type!);
  return s;
});
finance("CUMPRINC", 6, [], ([rate, nper, pv, start, end, type]) => {
  if (rate! <= 0 || nper! <= 0 || pv! <= 0 || start! < 1 || end! < start! || end! > nper! || (type !== 0 && type !== 1)) return ERRORS["#NUM!"];
  const pmt = pmtOf(rate!, nper!, pv!, 0, type!);
  let s = 0;
  for (let p = Math.ceil(start!); p <= Math.floor(end!); p++) s += pmt - ipmtOf(rate!, p, nper!, pv!, 0, type!);
  return s;
});

/** Newton's method, with a bisection fallback, for RATE/IRR/XIRR. */
function solve(f: (x: number) => number, guess: number): number | null {
  let x = guess;
  for (let i = 0; i < 100; i++) {
    const y = f(x);
    if (Math.abs(y) < 1e-10) return x;
    const h = Math.max(1e-7, Math.abs(x) * 1e-7);
    const d = (f(x + h) - y) / h;
    if (!Number.isFinite(d) || d === 0) break;
    const next = x - y / d;
    if (!Number.isFinite(next)) break;
    if (Math.abs(next - x) < 1e-12) return next;
    x = next <= -1 ? (x - 1) / 2 : next;
  }
  // bisection between -0.9999 and a growing upper bound
  let lo = -0.9999;
  let hi = 1;
  while (f(lo) * f(hi) > 0 && hi < 1e6) hi *= 2;
  if (f(lo) * f(hi) > 0) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    if (f(lo) * f(mid) <= 0) hi = mid;
    else lo = mid;
    if (hi - lo < 1e-14) break;
  }
  return (lo + hi) / 2;
}

define("RATE", "v", 3, 6, (args) => {
  const v = nums([args[0], args[1], args[2]] as Scalar[]);
  if (isError(v)) return v;
  const fv = opt(args[3], 0);
  const type = opt(args[4], 0);
  const guess = opt(args[5], 0.1);
  if (isError(fv) || isError(type) || isError(guess)) return ERRORS["#VALUE!"];
  const [nper, pmt, pv] = v as [number, number, number];
  const t = type ? 1 : 0;
  const r = solve((rate) => (rate === 0 ? pv + pmt * nper + (fv as number) : pv * (1 + rate) ** nper + (pmt * (1 + rate * t) * ((1 + rate) ** nper - 1)) / rate + (fv as number)), guess as number);
  return r === null ? ERRORS["#NUM!"] : r;
});
define("NPV", "va", 2, 255, ([r, ...flows], ctx) => {
  const rate = num(r as Scalar);
  if (isError(rate)) return rate;
  const xs = numbers(flows, ctx);
  if (isError(xs)) return xs;
  return xs.reduce((s, x, i) => s + x / (1 + rate) ** (i + 1), 0);
});
define("IRR", "av", 1, 2, ([flows, g], ctx) => {
  const xs = numbers([flows!], ctx);
  if (isError(xs)) return xs;
  if (!xs.some((x) => x > 0) || !xs.some((x) => x < 0)) return ERRORS["#NUM!"];
  const guess = opt(g, 0.1);
  if (isError(guess)) return guess;
  const r = solve((rate) => xs.reduce((s, x, i) => s + x / (1 + rate) ** i, 0), guess as number);
  return r === null ? ERRORS["#NUM!"] : r;
});
define("MIRR", "avv", 3, 3, ([flows, f, rr], ctx) => {
  const xs = numbers([flows!], ctx);
  if (isError(xs)) return xs;
  const finance = num(f as Scalar);
  const reinvest = num(rr as Scalar);
  if (isError(finance)) return finance;
  if (isError(reinvest)) return reinvest;
  const n = xs.length;
  const pos = xs.reduce((s, x, i) => (x > 0 ? s + x * (1 + reinvest) ** (n - 1 - i) : s), 0);
  const neg = xs.reduce((s, x, i) => (x < 0 ? s + x / (1 + finance) ** i : s), 0);
  if (pos === 0 || neg === 0) return ERRORS["#DIV/0!"];
  return (-pos / neg) ** (1 / (n - 1)) - 1;
});
function xflows(values: Value, dates: Value, ctx: Context): { xs: number[]; ds: number[] } | Scalar {
  const xs = toMatrix(values, ctx).data;
  const ds = toMatrix(dates, ctx).data;
  if (xs.length !== ds.length) return ERRORS["#NUM!"];
  const out = { xs: [] as number[], ds: [] as number[] };
  for (let i = 0; i < xs.length; i++) {
    const x = num(xs[i] ?? null);
    const d = num(ds[i] ?? null);
    if (isError(x)) return x;
    if (isError(d)) return d;
    out.xs.push(x);
    out.ds.push(Math.floor(d));
  }
  if (out.ds.some((d) => d < out.ds[0]!)) return ERRORS["#NUM!"];
  return out;
}
define("XNPV", "vaa", 3, 3, ([r, values, dates], ctx) => {
  const rate = num(r as Scalar);
  if (isError(rate)) return rate;
  const f = xflows(values!, dates!, ctx);
  if (!f || typeof f !== "object" || !("xs" in f)) return f as Scalar;
  return f.xs.reduce((s, x, i) => s + x / (1 + rate) ** ((f.ds[i]! - f.ds[0]!) / 365), 0);
});
define("XIRR", "aav", 2, 3, ([values, dates, g], ctx) => {
  const f = xflows(values!, dates!, ctx);
  if (!f || typeof f !== "object" || !("xs" in f)) return f as Scalar;
  if (!f.xs.some((x) => x > 0) || !f.xs.some((x) => x < 0)) return ERRORS["#NUM!"];
  const guess = opt(g, 0.1);
  if (isError(guess)) return guess;
  const r = solve((rate) => f.xs.reduce((s, x, i) => s + x / (1 + rate) ** ((f.ds[i]! - f.ds[0]!) / 365), 0), guess as number);
  return r === null ? ERRORS["#NUM!"] : r;
});
finance("EFFECT", 2, [], ([r, n]) => (r! <= 0 || n! < 1 ? ERRORS["#NUM!"] : (1 + r! / Math.floor(n!)) ** Math.floor(n!) - 1));
finance("NOMINAL", 2, [], ([r, n]) => (r! <= 0 || n! < 1 ? ERRORS["#NUM!"] : Math.floor(n!) * ((1 + r!) ** (1 / Math.floor(n!)) - 1)));
finance("RRI", 3, [], ([n, pv, fv]) => (n! <= 0 || pv === 0 ? ERRORS["#NUM!"] : (fv! / pv!) ** (1 / n!) - 1));
finance("PDURATION", 3, [], ([r, pv, fv]) => (r! <= 0 || pv! <= 0 || fv! <= 0 ? ERRORS["#NUM!"] : (Math.log(fv!) - Math.log(pv!)) / Math.log(1 + r!)));
finance("SLN", 3, [], ([cost, salvage, life]) => (life === 0 ? ERRORS["#DIV/0!"] : (cost! - salvage!) / life!));
finance("SYD", 4, [], ([cost, salvage, life, per]) => (life! <= 0 || per! <= 0 || per! > life! ? ERRORS["#NUM!"] : ((cost! - salvage!) * (life! - per! + 1) * 2) / (life! * (life! + 1))));
finance("DDB", 4, [2], ([cost, salvage, life, per, factor]) => {
  if (cost! < 0 || salvage! < 0 || life! <= 0 || per! <= 0 || per! > life! || factor! <= 0) return ERRORS["#NUM!"];
  let value = cost!;
  let dep = 0;
  for (let p = 1; p <= Math.ceil(per!); p++) {
    dep = Math.min(value * (factor! / life!), Math.max(0, value - salvage!));
    value -= dep;
  }
  return dep;
});
finance("DB", 4, [12], ([cost, salvage, life, per, month]) => {
  if (cost! < 0 || salvage! < 0 || life! <= 0 || per! <= 0 || month! < 1 || month! > 12 || per! > life! + 1) return ERRORS["#NUM!"];
  const rate = Math.round((1 - (salvage! / cost!) ** (1 / life!)) * 1000) / 1000;
  let total = 0;
  let dep = (cost! * rate * month!) / 12;
  if (Math.floor(per!) === 1) return dep;
  total = dep;
  for (let p = 2; p <= Math.floor(per!); p++) {
    dep = p === Math.floor(life!) + 1 ? ((cost! - total) * rate * (12 - month!)) / 12 : (cost! - total) * rate;
    total += dep;
  }
  return dep;
});
finance("VDB", 5, [2, 0], ([cost, salvage, life, start, end, factor, noSwitch]) => {
  if (cost! < 0 || salvage! < 0 || life! <= 0 || start! < 0 || end! < start! || end! > life!) return ERRORS["#NUM!"];
  let value = cost!;
  let total = 0;
  for (let p = 0; p < Math.ceil(end!); p++) {
    const ddb = value * (factor! / life!);
    const sl = (value - salvage!) / (life! - p);
    let dep = noSwitch || ddb > sl ? ddb : sl;
    dep = Math.min(dep, Math.max(0, value - salvage!));
    const portion = Math.min(p + 1, end!) - Math.max(p, start!);
    if (portion > 0) total += dep * portion;
    value -= dep;
  }
  return total;
});
finance("DOLLARDE", 2, [], ([d, f]) => {
  if (f! < 0) return ERRORS["#NUM!"];
  if (Math.floor(f!) === 0) return ERRORS["#DIV/0!"];
  const whole = Math.trunc(d!);
  const frac = Math.abs(d! - whole);
  const digits = Math.ceil(Math.log10(Math.floor(f!)));
  return Math.sign(d!) * (Math.abs(whole) + (frac * 10 ** digits) / Math.floor(f!));
});
finance("DOLLARFR", 2, [], ([d, f]) => {
  if (f! < 0) return ERRORS["#NUM!"];
  if (Math.floor(f!) === 0) return ERRORS["#DIV/0!"];
  const whole = Math.trunc(d!);
  const frac = Math.abs(d! - whole);
  const digits = Math.ceil(Math.log10(Math.floor(f!)));
  return Math.sign(d!) * (Math.abs(whole) + (frac * Math.floor(f!)) / 10 ** digits);
});
define("FVSCHEDULE", "va", 2, 2, ([p, rates], ctx) => {
  const principal = num(p as Scalar);
  if (isError(principal)) return principal;
  const rs = numbers([rates!], ctx);
  if (isError(rs)) return rs;
  return rs.reduce((s, r) => s * (1 + r), principal);
});
// simple bond and bill functions
define("TBILLPRICE", "v", 3, 3, (args) => {
  const v = nums(args as Scalar[]);
  if (isError(v)) return v;
  const [s, m, disc] = v as [number, number, number];
  const days = Math.floor(m) - Math.floor(s);
  if (days <= 0 || days > 366 || disc <= 0) return ERRORS["#NUM!"];
  return 100 * (1 - (disc * days) / 360);
});
define("TBILLYIELD", "v", 3, 3, (args) => {
  const v = nums(args as Scalar[]);
  if (isError(v)) return v;
  const [s, m, price] = v as [number, number, number];
  const days = Math.floor(m) - Math.floor(s);
  if (days <= 0 || days > 366 || price <= 0) return ERRORS["#NUM!"];
  return ((100 - price) / price) * (360 / days);
});
define("TBILLEQ", "v", 3, 3, (args) => {
  const v = nums(args as Scalar[]);
  if (isError(v)) return v;
  const [s, m, disc] = v as [number, number, number];
  const days = Math.floor(m) - Math.floor(s);
  if (days <= 0 || days > 366 || disc <= 0) return ERRORS["#NUM!"];
  return (365 * disc) / (360 - disc * days);
});
define("DISC", "v", 4, 5, (args) => {
  const v = nums(args.slice(0, 4) as Scalar[]);
  if (isError(v)) return v;
  const [s, m, pr, red] = v as [number, number, number, number];
  const basis = optNum(args[4] as Scalar, 0);
  if (isError(basis)) return basis;
  const days = Math.floor(m) - Math.floor(s);
  if (days <= 0 || pr <= 0 || red <= 0) return ERRORS["#NUM!"];
  const year = basis === 1 || basis === 3 ? 365 : 360;
  return ((red - pr) / red) * (year / days);
});
