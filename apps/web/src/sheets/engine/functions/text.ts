// Text functions.
import { parseDate } from "../dates";
import { formatValue } from "../format";
import {
  bool, define, ERRORS, flatten, isError, isMissing, Matrix, num, numberText, optBool, optNum, str, toMatrix, wildcard,
  type Args, type Context, type Scalar, type Value,
} from "../evaluate";
import { parseNumber } from "../values";
import { round } from "./math";

const text1 = (name: string, fn: (s: string) => Scalar) =>
  define(name, "v", 1, 1, ([a]) => {
    const s = str(a as Scalar);
    return isError(s) ? s : fn(s);
  });

text1("LEN", (s) => [...s].length);
text1("LENB", (s) => new TextEncoder().encode(s).length);
text1("LOWER", (s) => s.toLowerCase());
text1("UPPER", (s) => s.toUpperCase());
text1("PROPER", (s) => s.toLowerCase().replace(/(^|[^\p{L}'])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase()).replace(/(\p{L})'(\p{L})/gu, (_m, a: string, b: string) => a + "'" + b.toLowerCase()));
text1("TRIM", (s) => s.replace(/ +/g, " ").replace(/^ | $/g, ""));
text1("CLEAN", (s) => s.replace(/[\x00-\x1f]/g, ""));
text1("CODE", (s) => {
  if (!s) return ERRORS["#VALUE!"];
  const code = s.charCodeAt(0);
  const back = CP1252_FROM[code];
  return back ?? (code < 256 ? code : 63);
});
text1("UNICODE", (s) => (s ? s.codePointAt(0)! : ERRORS["#VALUE!"]));
text1("T", (s) => s);
text1("ENCODEURL", (s) => encodeURIComponent(s));

// CHAR follows Windows-1252, as Excel on Windows does
const CP1252: Record<number, number> = {
  128: 0x20ac, 130: 0x201a, 131: 0x0192, 132: 0x201e, 133: 0x2026, 134: 0x2020, 135: 0x2021, 136: 0x02c6, 137: 0x2030, 138: 0x0160, 139: 0x2039, 140: 0x0152, 142: 0x017d,
  145: 0x2018, 146: 0x2019, 147: 0x201c, 148: 0x201d, 149: 0x2022, 150: 0x2013, 151: 0x2014, 152: 0x02dc, 153: 0x2122, 154: 0x0161, 155: 0x203a, 156: 0x0153, 158: 0x017e, 159: 0x0178,
};
const CP1252_FROM: Record<number, number> = Object.fromEntries(Object.entries(CP1252).map(([k, v]) => [v, Number(k)]));
define("CHAR", "v", 1, 1, ([a]) => {
  const n = num(a as Scalar);
  if (isError(n)) return n;
  const c = Math.floor(n);
  if (c < 1 || c > 255) return ERRORS["#VALUE!"];
  return String.fromCharCode(CP1252[c] ?? c);
});
define("UNICHAR", "v", 1, 1, ([a]) => {
  const n = num(a as Scalar);
  if (isError(n)) return n;
  const c = Math.floor(n);
  if (c < 1 || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) return ERRORS["#VALUE!"];
  return String.fromCodePoint(c);
});

const sideText = (fromLeft: boolean) => ([a, n]: Args): Value => {
  const s = str(a as Scalar);
  if (isError(s)) return s;
  const count = optNum(n as Scalar, 1);
  if (isError(count)) return count;
  if (count < 0) return ERRORS["#VALUE!"];
  const chars = [...s];
  const k = Math.floor(count);
  return fromLeft ? chars.slice(0, k).join("") : k === 0 ? "" : chars.slice(-k).join("");
};
define("LEFT", "v", 1, 2, sideText(true));
define("LEFTB", "v", 1, 2, sideText(true));
define("RIGHT", "v", 1, 2, sideText(false));
define("RIGHTB", "v", 1, 2, sideText(false));
const mid = ([a, b, c]: Args): Value => {
  const s = str(a as Scalar);
  if (isError(s)) return s;
  const start = num(b as Scalar);
  const count = num(c as Scalar);
  if (isError(start)) return start;
  if (isError(count)) return count;
  if (start < 1 || count < 0) return ERRORS["#VALUE!"];
  return [...s].slice(Math.floor(start) - 1, Math.floor(start) - 1 + Math.floor(count)).join("");
};
define("MID", "v", 3, 3, mid);
define("MIDB", "v", 3, 3, mid);
define("REPT", "v", 2, 2, ([a, n]) => {
  const s = str(a as Scalar);
  if (isError(s)) return s;
  const times = num(n as Scalar);
  if (isError(times)) return times;
  if (times < 0 || s.length * times > 32767) return ERRORS["#VALUE!"];
  return s.repeat(Math.floor(times));
});
define("EXACT", "v", 2, 2, ([a, b]) => {
  const x = str(a as Scalar);
  const y = str(b as Scalar);
  if (isError(x)) return x;
  if (isError(y)) return y;
  return x === y;
});
define("CONCATENATE", "v", 1, 255, (args) => {
  let out = "";
  for (const a of args) {
    const s = str(a as Scalar);
    if (isError(s)) return s;
    out += s;
  }
  return out.length > 32767 ? ERRORS["#VALUE!"] : out;
});
define("CONCAT", "a", 1, 254, (args, ctx) => {
  let out = "";
  for (const v of flatten(args, ctx)) {
    const s = str(v);
    if (isError(s)) return s;
    out += s;
  }
  return out.length > 32767 ? ERRORS["#CALC!"] : out;
});
define("TEXTJOIN", "vva", 3, 255, ([d, skip, ...rest], ctx) => {
  const delims = toMatrix(d as Value, ctx).data.map((x) => str(x));
  if (delims.some(isError)) return delims.find(isError) as Scalar;
  const ignore = bool(skip as Scalar);
  if (isError(ignore)) return ignore;
  const parts: string[] = [];
  for (const v of flatten(rest, ctx)) {
    const s = str(v);
    if (isError(s)) return s;
    if (ignore && s === "") continue;
    parts.push(s);
  }
  let out = "";
  parts.forEach((p, i) => {
    out += (i ? (delims as string[])[(i - 1) % delims.length] : "") + p;
  });
  return out.length > 32767 ? ERRORS["#CALC!"] : out;
});
define("SUBSTITUTE", "v", 3, 4, ([a, b, c, d]) => {
  const s = str(a as Scalar);
  const old = str(b as Scalar);
  const next = str(c as Scalar);
  for (const x of [s, old, next]) if (isError(x)) return x;
  if (old === "") return s;
  if (d === undefined || isMissing(d)) return (s as string).split(old as string).join(next as string);
  const nth = num(d as Scalar);
  if (isError(nth)) return nth;
  if (nth < 1) return ERRORS["#VALUE!"];
  let at = -1;
  for (let i = 0; i < Math.floor(nth); i++) {
    at = (s as string).indexOf(old as string, at + 1);
    if (at < 0) return s;
  }
  return (s as string).slice(0, at) + next + (s as string).slice(at + (old as string).length);
});
define("REPLACE", "v", 4, 4, ([a, b, c, d]) => {
  const s = str(a as Scalar);
  if (isError(s)) return s;
  const start = num(b as Scalar);
  const count = num(c as Scalar);
  const next = str(d as Scalar);
  if (isError(start)) return start;
  if (isError(count)) return count;
  if (isError(next)) return next;
  if (start < 1 || count < 0) return ERRORS["#VALUE!"];
  const chars = [...s];
  chars.splice(Math.floor(start) - 1, Math.floor(count), next);
  return chars.join("");
});
define("REPLACEB", "v", 4, 4, ([a, b, c, d]) => {
  const s = String(a ?? "");
  const start = Number(b);
  const count = Number(c);
  return s.slice(0, start - 1) + String(d ?? "") + s.slice(start - 1 + count);
});
const finder = (caseless: boolean) => ([a, b, c]: Args): Value => {
  const find = str(a as Scalar);
  const within = str(b as Scalar);
  if (isError(find)) return find;
  if (isError(within)) return within;
  const start = optNum(c as Scalar, 1);
  if (isError(start)) return start;
  if (start < 1 || start > within.length + 1) return ERRORS["#VALUE!"];
  const from = Math.floor(start) - 1;
  if (!caseless) {
    const at = within.indexOf(find, from);
    return at < 0 ? ERRORS["#VALUE!"] : at + 1;
  }
  if (find === "") return start;
  const re = new RegExp(wildcard(find).source.slice(1, -1), "i");
  const m = re.exec(within.slice(from));
  return m ? from + m.index + 1 : ERRORS["#VALUE!"];
};
define("FIND", "v", 2, 3, finder(false));
define("FINDB", "v", 2, 3, finder(false));
define("SEARCH", "v", 2, 3, finder(true));
define("SEARCHB", "v", 2, 3, finder(true));

define("TEXT", "v", 2, 2, ([v, f]) => {
  const code = str(f as Scalar);
  if (isError(code)) return code;
  if (isError(v)) return v as Scalar;
  let value = v as Scalar;
  if (typeof value === "string") {
    const n = parseNumber(value, parseDate);
    if (n !== null) value = n;
  }
  return formatValue(value, code).text;
});
define("VALUE", "v", 1, 1, ([v]) => {
  if (typeof v === "number") return v;
  if (v === null) return 0;
  if (isError(v)) return v as Scalar;
  if (typeof v === "boolean") return ERRORS["#VALUE!"];
  const n = parseNumber(v as string, parseDate);
  return n === null ? ERRORS["#VALUE!"] : n;
});
define("NUMBERVALUE", "v", 1, 3, ([v, dec, grp]) => {
  const s = str(v as Scalar);
  if (isError(s)) return s;
  const d = dec === undefined || isMissing(dec) ? "." : String(dec)[0] ?? ".";
  const g = grp === undefined || isMissing(grp) ? "," : String(grp)[0] ?? ",";
  let t = s.replace(/\s/g, "");
  if (!t) return 0;
  t = t.split(g).join("");
  const parts = t.split(d);
  if (parts.length > 2) return ERRORS["#VALUE!"];
  t = parts.join(".");
  const n = parseNumber(t);
  return n === null ? ERRORS["#VALUE!"] : n;
});
define("FIXED", "v", 1, 3, ([v, d, nc]) => {
  const n = num(v as Scalar);
  if (isError(n)) return n;
  const digits = optNum(d as Scalar, 2);
  if (isError(digits)) return digits;
  const noCommas = optBool(nc as Scalar, false);
  if (isError(noCommas)) return noCommas;
  const r = round(n, digits);
  const fixed = Math.abs(r).toFixed(Math.max(0, Math.floor(digits)));
  const [i, f] = fixed.split(".");
  const body = (noCommas ? i! : i!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")) + (f ? "." + f : "");
  return (r < 0 ? "-" : "") + body;
});
define("DOLLAR", "v", 1, 2, ([v, d]) => {
  const n = num(v as Scalar);
  if (isError(n)) return n;
  const digits = optNum(d as Scalar, 2);
  if (isError(digits)) return digits;
  const r = round(n, digits);
  const fixed = Math.abs(r).toFixed(Math.max(0, Math.floor(digits)));
  const [i, f] = fixed.split(".");
  const body = "$" + i!.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f ? "." + f : "");
  return r < 0 ? `(${body})` : body;
});

function splitter(delims: Scalar[], caseless: boolean): RegExp | null {
  const parts = delims.filter((d) => d !== null && d !== "").map((d) => String(d).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!parts.length) return null;
  return new RegExp(parts.join("|"), caseless ? "gi" : "g");
}
const beforeAfter = (after: boolean) => ([t, d, n, mode, end, missing]: Args, ctx: Context): Value => {
  const s = str(t as Scalar);
  if (isError(s)) return s;
  const delims = toMatrix(d as Value, ctx).data;
  const nth = optNum(n as Scalar, 1);
  if (isError(nth)) return nth;
  const caseless = optNum(mode as Scalar, 0);
  if (isError(caseless)) return caseless;
  const matchEnd = optNum(end as Scalar, 0);
  if (isError(matchEnd)) return matchEnd;
  if (nth === 0 || Math.abs(nth) > s.length + 1) return ERRORS["#VALUE!"];
  const notFound = () => (missing === undefined || isMissing(missing) ? ERRORS["#N/A"] : (missing as Scalar));
  if (delims.every((x) => x === "" || x === null)) return after ? (nth > 0 ? s : "") : nth > 0 ? "" : s;
  const re = splitter(delims, caseless === 1);
  if (!re) return notFound();
  const hits: { at: number; len: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    hits.push({ at: m.index, len: m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  if (matchEnd) {
    if (nth > 0) hits.push({ at: s.length, len: 0 });
    else hits.unshift({ at: 0, len: 0 });
  }
  const pick = nth > 0 ? hits[Math.floor(nth) - 1] : hits[hits.length + Math.floor(nth)];
  if (!pick) return notFound();
  return after ? s.slice(pick.at + pick.len) : s.slice(0, pick.at);
};
define("TEXTBEFORE", "vavvvv", 2, 6, beforeAfter(false));
define("TEXTAFTER", "vavvvv", 2, 6, beforeAfter(true));
define("TEXTSPLIT", "vaavvv", 2, 6, ([t, cd, rd, ig, mode, pad], ctx) => {
  const s = str(t as Scalar);
  if (isError(s)) return s;
  const caseless = optNum(mode as Scalar, 0) === 1;
  const ignore = optBool(ig as Scalar, false);
  const colRe = cd === undefined || isMissing(cd) ? null : splitter(toMatrix(cd, ctx).data, caseless);
  const rowRe = rd === undefined || isMissing(rd) ? null : splitter(toMatrix(rd, ctx).data, caseless);
  const rows = (rowRe ? s.split(rowRe) : [s]).filter((r) => !(ignore === true && r === ""));
  const grid = rows.map((r) => (colRe ? r.split(colRe) : [r]).filter((c) => !(ignore === true && c === "")));
  const width = Math.max(1, ...grid.map((r) => r.length));
  const filler = pad === undefined || isMissing(pad) ? ERRORS["#N/A"] : (pad as Scalar);
  return Matrix.of(grid.map((r) => [...r, ...new Array<Scalar>(width - r.length).fill(filler)]));
});
define("VALUETOTEXT", "vv", 1, 2, ([v, f]) => {
  const strict = f === 1;
  if (typeof v === "string") return strict ? `"${v.replace(/"/g, '""')}"` : v;
  if (isError(v)) return (v as { code: string }).code;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v === null) return "";
  return numberText(v as number);
});
define("ARRAYTOTEXT", "av", 1, 2, ([a, f], ctx) => {
  const m = toMatrix(a!, ctx);
  const strict = f === 1;
  const show = (v: Scalar) => (typeof v === "string" ? (strict ? `"${v.replace(/"/g, '""')}"` : v) : v === null ? "" : isError(v) ? v.code : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : numberText(v));
  if (!strict) return m.data.map(show).join(", ");
  return "{" + m.toRows().map((r) => r.map(show).join(",")).join(";") + "}";
});

// regular expressions (Excel 2024)
function regex(pattern: Scalar, caseless: Scalar): RegExp | Scalar {
  const p = str(pattern);
  if (isError(p)) return p;
  try {
    return new RegExp(p, "g" + (caseless === 1 ? "i" : ""));
  } catch {
    return ERRORS["#VALUE!"];
  }
}
define("REGEXTEST", "v", 2, 3, ([t, p, c]) => {
  const s = str(t as Scalar);
  if (isError(s)) return s;
  const re = regex(p as Scalar, c as Scalar);
  if (!(re instanceof RegExp)) return re;
  return re.test(s);
});
define("REGEXEXTRACT", "v", 2, 4, ([t, p, mode, c]) => {
  const s = str(t as Scalar);
  if (isError(s)) return s;
  const re = regex(p as Scalar, c as Scalar);
  if (!(re instanceof RegExp)) return re;
  const how = optNum(mode as Scalar, 0);
  if (how === 1) {
    const all = [...s.matchAll(re)].map((m) => [m[0]]);
    return all.length ? Matrix.of(all) : ERRORS["#N/A"];
  }
  re.lastIndex = 0;
  const m = re.exec(s);
  if (!m) return ERRORS["#N/A"];
  if (how === 2) return m.length > 1 ? Matrix.of([m.slice(1).map((g) => g ?? "")]) : ERRORS["#N/A"];
  return m[0];
});
define("REGEXREPLACE", "v", 3, 5, ([t, p, r, n, c]) => {
  const s = str(t as Scalar);
  const rep = str(r as Scalar);
  if (isError(s)) return s;
  if (isError(rep)) return rep;
  const re = regex(p as Scalar, c as Scalar);
  if (!(re instanceof RegExp)) return re;
  const nth = optNum(n as Scalar, 0);
  if (isError(nth)) return nth;
  if (!nth) return s.replace(re, rep);
  const hits = [...s.matchAll(re)];
  const pick = nth > 0 ? hits[nth - 1] : hits[hits.length + nth];
  if (!pick) return s;
  return s.slice(0, pick.index) + pick[0].replace(new RegExp(re.source, re.flags.replace("g", "")), rep) + s.slice(pick.index! + pick[0].length);
});
