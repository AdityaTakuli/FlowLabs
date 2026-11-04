// Date and time functions, on Excel's serial numbers.
import { dateParts, dateSerial, daysInMonth, nowSerial, parseDate, parseTime, timeSerial, todaySerial } from "../dates";
import { define, ERRORS, flatten, isError, isMissing, num, nums, optNum, str, type Args, type Context, type Scalar, type Value } from "../evaluate";

function serialOf(v: Scalar): number | Scalar {
  if (typeof v === "string") {
    const d = parseDate(v);
    return d === null ? ERRORS["#VALUE!"] : d;
  }
  const n = num(v);
  if (isError(n)) return n;
  if (n < 0 || n >= 2_958_466) return ERRORS["#NUM!"];
  return n;
}
const onDate = (name: string, fn: (serial: number) => Scalar) =>
  define(name, "v", 1, 1, ([v]) => {
    const s = serialOf(v as Scalar);
    return typeof s === "number" ? fn(s) : s;
  });

define("DATE", "v", 3, 3, (args) => {
  const v = nums(args as Scalar[]);
  if (isError(v)) return v;
  const s = dateSerial(v[0]!, v[1]!, v[2]!);
  return s === null ? ERRORS["#NUM!"] : s;
});
define("TIME", "v", 3, 3, (args) => {
  const v = nums(args as Scalar[]);
  if (isError(v)) return v;
  const total = Math.trunc(v[0]!) * 3600 + Math.trunc(v[1]!) * 60 + Math.trunc(v[2]!);
  if (total < 0) return ERRORS["#NUM!"];
  return timeSerial(v[0]!, v[1]!, v[2]!);
});
define("DATEVALUE", "v", 1, 1, ([v]) => {
  const s = str(v as Scalar);
  if (isError(s)) return s;
  const d = parseDate(s);
  return d === null ? ERRORS["#VALUE!"] : Math.floor(d);
});
define("TIMEVALUE", "v", 1, 1, ([v]) => {
  const s = str(v as Scalar);
  if (isError(s)) return s;
  const t = parseTime(s) ?? parseDate(s);
  return t === null ? ERRORS["#VALUE!"] : t - Math.floor(t);
});
define("TODAY", "v", 0, 0, (_a, ctx) => Math.floor(ctx.now()), true);
define("NOW", "v", 0, 0, (_a, ctx) => ctx.now(), true);
onDate("YEAR", (s) => dateParts(s).year);
onDate("MONTH", (s) => dateParts(s).month);
onDate("DAY", (s) => dateParts(s).day);
onDate("HOUR", (s) => dateParts(s).hour);
onDate("MINUTE", (s) => dateParts(s).minute);
onDate("SECOND", (s) => dateParts(s).second);
define("WEEKDAY", "v", 1, 2, ([v, t]) => {
  const s = serialOf(v as Scalar);
  if (typeof s !== "number") return s;
  const type = optNum(t as Scalar, 1);
  if (isError(type)) return type;
  const w = dateParts(s).weekday; // 0 = Sunday
  switch (Math.floor(type)) {
    case 1: case 17: return w + 1;
    case 2: case 11: return ((w + 6) % 7) + 1;
    case 3: return (w + 6) % 7;
    case 12: return ((w + 5) % 7) + 1;
    case 13: return ((w + 4) % 7) + 1;
    case 14: return ((w + 3) % 7) + 1;
    case 15: return ((w + 2) % 7) + 1;
    case 16: return ((w + 1) % 7) + 1;
    default: return ERRORS["#NUM!"];
  }
});
function isoWeek(serial: number): number {
  const d = dateParts(serial);
  const date = new Date(Date.UTC(d.year, d.month - 1, d.day));
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((date.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}
onDate("ISOWEEKNUM", isoWeek);
define("WEEKNUM", "v", 1, 2, ([v, t]) => {
  const s = serialOf(v as Scalar);
  if (typeof s !== "number") return s;
  const type = optNum(t as Scalar, 1);
  if (isError(type)) return type;
  if (type === 21) return isoWeek(s);
  const start: Record<number, number> = { 1: 0, 2: 1, 11: 1, 12: 2, 13: 3, 14: 4, 15: 5, 16: 6, 17: 0 };
  const first = start[Math.floor(type)];
  if (first === undefined) return ERRORS["#NUM!"];
  const d = dateParts(s);
  const jan1 = dateSerial(d.year, 1, 1)!;
  const jan1Weekday = dateParts(jan1).weekday;
  const offset = (jan1Weekday - first + 7) % 7;
  return Math.floor((Math.floor(s) - jan1 + offset) / 7) + 1;
});
define("EDATE", "v", 2, 2, ([v, m]) => {
  const s = serialOf(v as Scalar);
  if (typeof s !== "number") return s;
  const months = num(m as Scalar);
  if (isError(months)) return months;
  const d = dateParts(s);
  const target = d.month - 1 + Math.trunc(months);
  const year = d.year + Math.floor(target / 12);
  const month = (((target % 12) + 12) % 12) + 1;
  const r = dateSerial(year, month, Math.min(d.day, daysInMonth(year, month)));
  return r === null ? ERRORS["#NUM!"] : r;
});
define("EOMONTH", "v", 2, 2, ([v, m]) => {
  const s = serialOf(v as Scalar);
  if (typeof s !== "number") return s;
  const months = num(m as Scalar);
  if (isError(months)) return months;
  const d = dateParts(s);
  const target = d.month - 1 + Math.trunc(months);
  const year = d.year + Math.floor(target / 12);
  const month = (((target % 12) + 12) % 12) + 1;
  const r = dateSerial(year, month, daysInMonth(year, month));
  return r === null ? ERRORS["#NUM!"] : r;
});
define("DAYS", "v", 2, 2, ([e, s]) => {
  const a = serialOf(e as Scalar);
  const b = serialOf(s as Scalar);
  if (typeof a !== "number") return a;
  if (typeof b !== "number") return b;
  return Math.floor(a) - Math.floor(b);
});
define("DATEDIF", "v", 3, 3, ([s, e, u]) => {
  const a = serialOf(s as Scalar);
  const b = serialOf(e as Scalar);
  if (typeof a !== "number") return a;
  if (typeof b !== "number") return b;
  if (a > b) return ERRORS["#NUM!"];
  const unit = String(u ?? "").toUpperCase();
  const x = dateParts(a);
  const y = dateParts(b);
  let months = (y.year - x.year) * 12 + (y.month - x.month);
  if (y.day < x.day) months--;
  switch (unit) {
    case "D": return Math.floor(b) - Math.floor(a);
    case "M": return months;
    case "Y": return Math.floor(months / 12);
    case "YM": return months % 12;
    case "MD": {
      let days = y.day - x.day;
      if (days < 0) {
        const pm = y.month === 1 ? 12 : y.month - 1;
        const py = y.month === 1 ? y.year - 1 : y.year;
        days += daysInMonth(py, pm);
      }
      return days;
    }
    case "YD": {
      let start = dateSerial(y.year, x.month, x.day)!;
      if (start > Math.floor(b)) start = dateSerial(y.year - 1, x.month, x.day)!;
      return Math.floor(b) - start;
    }
    default: return ERRORS["#NUM!"];
  }
});
define("DAYS360", "v", 2, 3, ([s, e, m]) => {
  const a = serialOf(s as Scalar);
  const b = serialOf(e as Scalar);
  if (typeof a !== "number") return a;
  if (typeof b !== "number") return b;
  const european = m !== undefined && !isMissing(m) && m !== null && m !== false && m !== 0;
  const x = dateParts(a);
  const y = dateParts(b);
  let d1 = x.day;
  let d2 = y.day;
  if (european) {
    if (d1 === 31) d1 = 30;
    if (d2 === 31) d2 = 30;
  } else {
    const lastFeb = (p: typeof x) => p.month === 2 && p.day === daysInMonth(p.year, 2);
    if (lastFeb(x)) d1 = 30;
    if (d1 === 31) d1 = 30;
    if (d2 === 31 && d1 >= 30) d2 = 30;
  }
  return (y.year - x.year) * 360 + (y.month - x.month) * 30 + (d2 - d1);
});
define("YEARFRAC", "v", 2, 3, ([s, e, b]) => {
  let a = serialOf(s as Scalar);
  let c = serialOf(e as Scalar);
  if (typeof a !== "number") return a;
  if (typeof c !== "number") return c;
  const basis = optNum(b as Scalar, 0);
  if (isError(basis)) return basis;
  a = Math.floor(a);
  c = Math.floor(c);
  if (a > c) [a, c] = [c, a];
  const x = dateParts(a);
  const y = dateParts(c);
  switch (Math.floor(basis)) {
    case 0: {
      let d1 = x.day;
      let d2 = y.day;
      if (d1 === 31) d1 = 30;
      if (d2 === 31 && d1 >= 30) d2 = 30;
      if (x.month === 2 && d1 === daysInMonth(x.year, 2)) {
        d1 = 30;
        if (y.month === 2 && d2 === daysInMonth(y.year, 2)) d2 = 30;
      }
      return ((y.year - x.year) * 360 + (y.month - x.month) * 30 + (d2 - d1)) / 360;
    }
    case 1: {
      const leap = (yr: number) => (yr % 4 === 0 && yr % 100 !== 0) || yr % 400 === 0;
      if (x.year === y.year) return (c - a) / (leap(x.year) ? 366 : 365);
      const oneYearLater = dateSerial(x.year + 1, x.month, x.day)!;
      if (c <= oneYearLater) {
        const feb29 = (yr: number) => leap(yr) && dateSerial(yr, 2, 29)! >= a && dateSerial(yr, 2, 29)! <= c;
        return (c - a) / (feb29(x.year) || feb29(y.year) ? 366 : 365);
      }
      let days = 0;
      for (let yr = x.year; yr <= y.year; yr++) days += leap(yr) ? 366 : 365;
      return (c - a) / (days / (y.year - x.year + 1));
    }
    case 2: return (c - a) / 360;
    case 3: return (c - a) / 365;
    case 4: {
      const d1 = Math.min(x.day, 30);
      const d2 = Math.min(y.day, 30);
      return ((y.year - x.year) * 360 + (y.month - x.month) * 30 + (d2 - d1)) / 360;
    }
    default: return ERRORS["#NUM!"];
  }
});

// working days
function weekendMask(w: Scalar | undefined): boolean[] | Scalar {
  // index 0 = Monday … 6 = Sunday
  if (w === undefined || isMissing(w) || w === null) return [false, false, false, false, false, true, true];
  if (typeof w === "string") {
    if (!/^[01]{7}$/.test(w) || w === "1111111") return ERRORS["#VALUE!"];
    return [...w].map((c) => c === "1");
  }
  const codes: Record<number, number[]> = { 1: [5, 6], 2: [6, 0], 3: [0, 1], 4: [1, 2], 5: [2, 3], 6: [3, 4], 7: [4, 5], 11: [6], 12: [0], 13: [1], 14: [2], 15: [3], 16: [4], 17: [5] };
  const days = codes[Number(w)];
  if (!days) return ERRORS["#NUM!"];
  const mask = new Array(7).fill(false);
  for (const d of days) mask[d] = true;
  return mask;
}
function holidaySet(h: Value | undefined, ctx: Context): Set<number> | Scalar {
  const out = new Set<number>();
  if (h === undefined || isMissing(h)) return out;
  for (const v of flatten([h], ctx)) {
    if (v === null) continue;
    const s = serialOf(v);
    if (typeof s !== "number") return s;
    out.add(Math.floor(s));
  }
  return out;
}
const isWorkday = (serial: number, mask: boolean[], holidays: Set<number>) => !mask[(dateParts(serial).weekday + 6) % 7] && !holidays.has(serial);

function networkdays(args: Args, ctx: Context, intl: boolean): Value {
  const a = serialOf(args[0] as Scalar);
  const b = serialOf(args[1] as Scalar);
  if (typeof a !== "number") return a;
  if (typeof b !== "number") return b;
  const mask = weekendMask(intl ? (args[2] as Scalar) : undefined);
  if (!Array.isArray(mask)) return mask;
  const holidays = holidaySet(intl ? args[3] : args[2], ctx);
  if (!(holidays instanceof Set)) return holidays;
  const lo = Math.floor(Math.min(a, b));
  const hi = Math.floor(Math.max(a, b));
  let n = 0;
  for (let d = lo; d <= hi; d++) if (isWorkday(d, mask, holidays)) n++;
  return a > b ? -n : n;
}
define("NETWORKDAYS", "vva", 2, 3, (args, ctx) => networkdays(args, ctx, false));
define("NETWORKDAYS.INTL", "vvva", 2, 4, (args, ctx) => networkdays(args, ctx, true));
function workday(args: Args, ctx: Context, intl: boolean): Value {
  const start = serialOf(args[0] as Scalar);
  if (typeof start !== "number") return start;
  const days = num(args[1] as Scalar);
  if (isError(days)) return days;
  const mask = weekendMask(intl ? (args[2] as Scalar) : undefined);
  if (!Array.isArray(mask)) return mask;
  const holidays = holidaySet(intl ? args[3] : args[2], ctx);
  if (!(holidays instanceof Set)) return holidays;
  let d = Math.floor(start);
  let left = Math.trunc(days);
  const step = left >= 0 ? 1 : -1;
  while (left !== 0) {
    d += step;
    if (d < 1 || d > 2_958_465) return ERRORS["#NUM!"];
    if (isWorkday(d, mask, holidays)) left -= step;
  }
  return d;
}
define("WORKDAY", "vva", 2, 3, (args, ctx) => workday(args, ctx, false));
define("WORKDAY.INTL", "vvva", 2, 4, (args, ctx) => workday(args, ctx, true));

export { todaySerial, nowSerial };
