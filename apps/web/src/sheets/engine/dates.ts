// Dates as Excel keeps them: a serial number of days since 1900-01-00, with Excel's (and Lotus's)
// pretend 29 February 1900 at serial 60, and the time of day as the fraction.

const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(1899, 11, 30); // serial 0 for dates after the fake leap day

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** DATE(year, month, day) with Excel's rules: years 0-1899 add 1900, months and days overflow. */
export function dateSerial(year: number, month: number, day: number): number | null {
  year = Math.trunc(year);
  month = Math.trunc(month);
  day = Math.trunc(day);
  if (year < 0 || year > 9999) return null;
  if (year < 1900) year += 1900;
  const ms = Date.UTC(year, month - 1, 1) + (day - 1) * DAY_MS;
  return fromUtc(ms);
}

/** A UTC time (ms) as a serial. */
export function fromUtc(ms: number): number | null {
  let serial = (ms - EPOCH) / DAY_MS;
  if (serial < 61) serial -= 1; // before 1 March 1900 the fake leap day is not yet counted
  if (serial < 0 || serial >= 2_958_466) return serial === -1 ? 0 : null; // 0 is "1900-01-00"
  return serial;
}

export interface DateParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
  weekday: number; // 0 = Sunday
}

export function dateParts(serial: number): DateParts {
  const whole = Math.floor(serial);
  let fraction = serial - whole;
  // round the time to the millisecond, as Excel does when it shows it
  let msOfDay = Math.round(fraction * DAY_MS);
  let days = whole;
  if (msOfDay >= DAY_MS) {
    msOfDay -= DAY_MS;
    days += 1;
  }
  fraction = msOfDay;
  const hour = Math.floor(fraction / 3_600_000);
  const minute = Math.floor((fraction % 3_600_000) / 60_000);
  const second = Math.floor((fraction % 60_000) / 1000);
  const ms = fraction % 1000;
  if (days === 60) return { year: 1900, month: 2, day: 29, hour, minute, second, ms, weekday: 3 };
  if (days === 0) return { year: 1900, month: 1, day: 0, hour, minute, second, ms, weekday: 6 };
  const utc = new Date(EPOCH + (days < 60 ? days + 1 : days) * DAY_MS);
  // Excel's weekday for serial 1 (1900-01-01) is Sunday, as if 1900 were a leap year
  const weekday = days < 60 ? (days + 6) % 7 : utc.getUTCDay();
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate(), hour, minute, second, ms, weekday };
}

export function timeSerial(hour: number, minute: number, second: number): number {
  const total = Math.trunc(hour) * 3600 + Math.trunc(minute) * 60 + Math.trunc(second);
  return (((total % 86400) + 86400) % 86400) / 86400;
}

export function todaySerial(now = new Date()): number {
  return fromUtc(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))!;
}

export function nowSerial(now = new Date()): number {
  return todaySerial(now) + (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000) / 86400;
}

const MONTH_WORD = new RegExp(`^(${MONTHS.map((m) => m.slice(0, 3)).join("|")})[a-z]*\\.?$`, "i");

function monthOf(word: string): number | null {
  const m = MONTH_WORD.exec(word);
  return m ? MONTHS.findIndex((x) => x.slice(0, 3).toLowerCase() === m[1]!.toLowerCase()) + 1 : null;
}

function twoDigitYear(y: number, written: string): number {
  if (written.length > 2) return y;
  return y < 30 ? 2000 + y : 1900 + y; // Excel's default cutoff
}

/** A time of day ("10:30", "10:30:15.5", "9 PM", "9:05 am") as a fraction of a day; null otherwise. */
export function parseTime(text: string): number | null {
  const m = /^(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}(?:\.\d+)?))?\s*(am|pm|a|p)?$/i.exec(text.trim());
  if (!m || (m[2] === undefined && !m[4])) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const second = Number(m[3] ?? 0);
  if (m[4]) {
    if (hour < 1 || hour > 12) return null;
    const pm = m[4].toLowerCase().startsWith("p");
    hour = (hour % 12) + (pm ? 12 : 0);
  }
  if (minute > 59 || second >= 60) return null;
  if (hour > 9999) return null;
  return (hour * 3600 + minute * 60 + second) / 86400;
}

/** Text Excel reads as a date (US order, as en-US Excel does), with an optional time; null otherwise. */
export function parseDate(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const time = parseTime(t);
  if (time !== null) return time;
  // date, then an optional time after a space or T
  const split = /^(.*?)(?:[ T]+(\d{1,2}(?::\d{1,2}){1,2}(?:\.\d+)?(?:\s*(?:am|pm|a|p))?|\d{1,2}\s*(?:am|pm)))?$/i.exec(t);
  if (!split) return null;
  const datePart = split[1]!.trim().replace(/,/g, " ").replace(/\s+/g, " ");
  const timePart = split[2] ? parseTime(split[2]) : 0;
  if (timePart === null) return null;
  let m: RegExpExecArray | null;
  let serial: number | null = null;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(datePart))) serial = valid(Number(m[1]), Number(m[2]), Number(m[3]));
  else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(datePart))) serial = valid(twoDigitYear(Number(m[3]), m[3]!), Number(m[1]), Number(m[2]));
  else if ((m = /^(\d{1,2})[-/](\d{1,2})$/.exec(datePart))) serial = valid(new Date().getFullYear(), Number(m[1]), Number(m[2]));
  else if ((m = /^(\d{1,2})[- ]([A-Za-z]+\.?)[- ](\d{2}|\d{4})$/.exec(datePart))) {
    const month = monthOf(m[2]!);
    serial = month ? valid(twoDigitYear(Number(m[3]), m[3]!), month, Number(m[1])) : null;
  } else if ((m = /^([A-Za-z]+\.?)[- ](\d{1,2})[- ](\d{2}|\d{4})$/.exec(datePart))) {
    const month = monthOf(m[1]!);
    serial = month ? valid(twoDigitYear(Number(m[3]), m[3]!), month, Number(m[2])) : null;
  } else if ((m = /^(\d{1,2})[- ]([A-Za-z]+\.?)$/.exec(datePart))) {
    const month = monthOf(m[2]!);
    serial = month ? valid(new Date().getFullYear(), month, Number(m[1])) : null;
  } else if ((m = /^([A-Za-z]+\.?)[- ](\d{4})$/.exec(datePart))) {
    const month = monthOf(m[1]!);
    serial = month ? valid(Number(m[2]), month, 1) : null;
  }
  return serial === null ? null : serial + timePart;
}

function valid(year: number, month: number, day: number): number | null {
  if (month < 1 || month > 12 || day < 1 || year < 1900 || year > 9999) return null;
  if (year === 1900 && month === 2 && day === 29) return 60;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > days) return null;
  return dateSerial(year, month, day);
}

export function daysInMonth(year: number, month: number): number {
  if (year === 1900 && month === 2) return 29;
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
