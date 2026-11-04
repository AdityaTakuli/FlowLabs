// Excel number format codes ("#,##0.00", "0%", "m/d/yyyy", "[Red]-0.0;0.0", "@"…) applied to values.
import { DAYS, MONTHS, dateParts } from "./dates";
import { CellError, type Scalar } from "./values";

export interface Formatted {
  text: string;
  color?: string;
}

type Part =
  | { k: "lit"; v: string }
  | { k: "digit"; v: "0" | "#" | "?" }
  | { k: "dot" }
  | { k: "comma" }
  | { k: "pct" }
  | { k: "exp"; v: string } // E+ E- e+ e-
  | { k: "slash" }
  | { k: "text" } // @
  | { k: "general" }
  | { k: "date"; v: string } // y, m, d, h, s runs, AM/PM, A/P, [h] etc.
  | { k: "space" }; // _x: the width of x

interface Section {
  parts: Part[];
  color?: string;
  cond?: { op: string; n: number };
  kind: "number" | "date" | "text" | "general";
}

const COLORS: Record<string, string> = {
  black: "#000000", blue: "#0000FF", cyan: "#00FFFF", green: "#00FF00", magenta: "#FF00FF", red: "#FF0000", white: "#FFFFFF", yellow: "#FFFF00",
};
const PALETTE = ["#000000", "#FFFFFF", "#FF0000", "#00FF00", "#0000FF", "#FFFF00", "#FF00FF", "#00FFFF", "#800000", "#008000", "#000080", "#808000", "#800080", "#008080", "#C0C0C0", "#808080"];

const cache = new Map<string, Section[]>();

function splitSections(code: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let bracket = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === "\\" && !quoted) {
      current += ch + (code[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "[") bracket = true;
    else if (!quoted && ch === "]") bracket = false;
    if (ch === ";" && !quoted && !bracket) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out;
}

function parseSection(text: string): Section {
  const parts: Part[] = [];
  const section: Section = { parts, kind: "number" };
  let i = 0;
  const lower = text.toLowerCase();
  while (i < text.length) {
    const ch = text[i]!;
    const lc = lower[i]!;
    if (ch === '"') {
      const end = text.indexOf('"', i + 1);
      const v = end < 0 ? text.slice(i + 1) : text.slice(i + 1, end);
      parts.push({ k: "lit", v });
      i = end < 0 ? text.length : end + 1;
    } else if (ch === "\\") {
      parts.push({ k: "lit", v: text[i + 1] ?? "" });
      i += 2;
    } else if (ch === "_") {
      parts.push({ k: "space" });
      i += 2;
    } else if (ch === "*") {
      i += 2; // fill with a character: the grid does not repeat it
    } else if (ch === "[") {
      const end = text.indexOf("]", i);
      const inner = end < 0 ? text.slice(i + 1) : text.slice(i + 1, end);
      i = end < 0 ? text.length : end + 1;
      const low = inner.toLowerCase();
      if (COLORS[low]) section.color = COLORS[low];
      else if (/^color\s*\d+$/.test(low)) section.color = PALETTE[(Number(low.replace(/\D/g, "")) - 1) % PALETTE.length];
      else if (/^(<=|>=|<>|<|>|=)\s*-?[\d.]+$/.test(inner.trim())) {
        const m = /^(<=|>=|<>|<|>|=)\s*(-?[\d.]+)$/.exec(inner.trim())!;
        section.cond = { op: m[1]!, n: Number(m[2]) };
      } else if (/^(h+|m+|s+)$/.test(low)) parts.push({ k: "date", v: `[${low}]` });
      else if (inner.startsWith("$")) {
        const symbol = inner.slice(1).split("-")[0] ?? "";
        if (symbol) parts.push({ k: "lit", v: symbol });
      }
    } else if (lower.startsWith("general", i)) {
      parts.push({ k: "general" });
      i += 7;
    } else if (lower.startsWith("am/pm", i)) {
      parts.push({ k: "date", v: "AM/PM" });
      i += 5;
    } else if (lower.startsWith("a/p", i)) {
      parts.push({ k: "date", v: text.slice(i, i + 3) });
      i += 3;
    } else if ("ymdhse".includes(lc) && !(lc === "e" && /[+-]/.test(text[i + 1] ?? ""))) {
      let j = i;
      while (j < text.length && lower[j] === lc) j++;
      parts.push({ k: "date", v: lower.slice(i, j) });
      i = j;
    } else if ((lc === "e") && /[+-]/.test(text[i + 1] ?? "")) {
      parts.push({ k: "exp", v: text.slice(i, i + 2) });
      i += 2;
    } else if (ch === "0" || ch === "#" || ch === "?") {
      parts.push({ k: "digit", v: ch });
      i++;
    } else if (ch === ".") {
      // .0 .00 right after seconds are fractions of a second
      const prev = [...parts].reverse().find((p) => p.k !== "lit");
      if (prev?.k === "date" && prev.v.startsWith("s")) {
        let j = i + 1;
        while (text[j] === "0") j++;
        parts.push({ k: "date", v: "." + "0".repeat(j - i - 1) });
        i = j;
      } else {
        parts.push({ k: "dot" });
        i++;
      }
    } else if (ch === ",") {
      parts.push({ k: "comma" });
      i++;
    } else if (ch === "%") {
      parts.push({ k: "pct" });
      i++;
    } else if (ch === "/") {
      parts.push({ k: "slash" });
      i++;
    } else if (ch === "@") {
      parts.push({ k: "text" });
      i++;
    } else {
      parts.push({ k: "lit", v: ch });
      i++;
    }
  }
  if (parts.some((p) => p.k === "date")) section.kind = "date";
  else if (parts.some((p) => p.k === "general")) section.kind = "general";
  else if (parts.some((p) => p.k === "text") && !parts.some((p) => p.k === "digit")) section.kind = "text";
  // a fraction format without date parts keeps "/" as fraction bar; elsewhere it is a literal
  if (section.kind !== "number") for (let p = 0; p < parts.length; p++) if (parts[p]!.k === "slash") parts[p] = { k: "lit", v: "/" };
  return section;
}

function sections(code: string): Section[] {
  let found = cache.get(code);
  if (!found) {
    found = splitSections(code).map(parseSection);
    if (cache.size > 2000) cache.clear();
    cache.set(code, found);
  }
  return found;
}

export function isDateFormat(code: string): boolean {
  return sections(code)[0]?.kind === "date";
}

export function isTextFormat(code: string): boolean {
  return code.trim() === "@";
}

// ------------------------------------------------------------------------------------- General

/** How General shows a number: up to 11 characters, switching to E notation when needed. */
export function formatGeneral(n: number, width = 11): string {
  if (!Number.isFinite(n)) return "#NUM!";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (Number.isInteger(n) && abs < 1e11) return String(n);
  if (abs >= 1e-9 && abs < 1e11) {
    const intDigits = abs >= 1 ? Math.floor(Math.log10(abs)) + 1 : 1;
    const room = width - intDigits - 1 - (n < 0 ? 1 : 0);
    const decimals = Math.max(0, Math.min(room, 15 - intDigits));
    let s = n.toFixed(decimals);
    if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
    if (s !== "0" && s !== "-0") return s;
  }
  for (let d = 5; d >= 0; d--) {
    const [mantissa, exp] = n.toExponential(d).split("e");
    const m = mantissa!.includes(".") ? mantissa!.replace(/0+$/, "").replace(/\.$/, "") : mantissa!;
    const e = Number(exp);
    const s = `${m}E${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
    if (s.length <= width || d === 0) return s;
  }
  return String(n);
}

// ------------------------------------------------------------------------------------- numbers

function groupThousands(digits: string, sep = ","): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

/** Round like Excel: half away from zero, on the decimal digits shown. */
export function roundHalfAway(n: number, digits: number): number {
  if (!Number.isFinite(n)) return n;
  const factor = 10 ** digits;
  const shifted = Math.abs(n) * factor;
  const rounded = Math.round(Number(shifted.toPrecision(15)));
  return (Math.sign(n) * rounded) / factor;
}

function formatFraction(n: number, parts: Part[]): string {
  const slash = parts.findIndex((p) => p.k === "slash");
  const before = parts.slice(0, slash);
  const after = parts.slice(slash + 1);
  const denominatorDigits = after.filter((p) => p.k === "digit");
  const fixed = Number(after.filter((p) => p.k === "lit" && /\d/.test(p.v)).map((p) => (p as { v: string }).v).join(""));
  // "# ?/?" has a whole-number part; "?/?" puts everything in the fraction
  const digitsBefore = before.filter((p) => p.k === "digit");
  const spaceAt = before.map((p) => p.k === "lit" && p.v === " ").lastIndexOf(true);
  const hasWhole = spaceAt > 0 && digitsBefore.length > 0 && before.slice(0, spaceAt).some((p) => p.k === "digit");
  const negative = n < 0;
  let value = Math.abs(n);
  let whole = 0;
  if (hasWhole) {
    whole = Math.floor(value);
    value -= whole;
  }
  let num = 0;
  let den = 1;
  if (fixed) {
    den = fixed;
    num = Math.round(value * den);
  } else {
    const maxDen = 10 ** Math.max(1, denominatorDigits.length) - 1;
    let best = Infinity;
    for (let d = 1; d <= maxDen; d++) {
      const nn = Math.round(value * d);
      const err = Math.abs(value - nn / d);
      if (err < best - 1e-12) {
        best = err;
        num = nn;
        den = d;
      }
      if (err === 0) break;
    }
  }
  if (hasWhole && num === den) {
    whole += 1;
    num = 0;
  }
  const sign = negative ? "-" : "";
  const width = denominatorDigits.length || String(den).length;
  if (hasWhole) {
    if (num === 0) return `${sign}${whole}`.padEnd(String(whole).length + sign.length + 2 + width * 2, " ");
    return `${sign}${whole ? whole + " " : ""}${String(num).padStart(width, " ")}/${String(den).padEnd(width, " ")}`;
  }
  return `${sign}${num}/${String(den).padEnd(width, " ")}`;
}

function formatNumberSection(n: number, section: Section, keepSign: boolean): string {
  const parts = section.parts;
  if (parts.some((p) => p.k === "slash") && parts.some((p) => p.k === "digit")) {
    const literalBefore = parts.slice(0, parts.findIndex((p) => p.k === "digit" || p.k === "slash")).map((p) => (p.k === "lit" ? p.v : "")).join("");
    return literalBefore + formatFraction(keepSign ? n : Math.abs(n), parts.slice(parts.findIndex((p) => p.k === "digit" || p.k === "slash")));
  }
  let value = keepSign ? n : Math.abs(n);
  const pct = parts.filter((p) => p.k === "pct").length;
  value *= 100 ** pct;
  // commas right after the last digit placeholder scale by 1000 each
  const lastDigit = parts.map((p) => p.k === "digit").lastIndexOf(true);
  const dotAt = parts.findIndex((p) => p.k === "dot");
  let scale = 0;
  for (let i = lastDigit + 1; i < parts.length && parts[i]!.k === "comma"; i++) scale++;
  if (dotAt >= 0) for (let i = dotAt - 1; i >= 0 && parts[i]!.k === "comma"; i--) scale++;
  value /= 1000 ** scale;
  const expAt = parts.findIndex((p) => p.k === "exp");
  const mantissaParts = expAt >= 0 ? parts.slice(0, expAt) : parts;
  const expParts = expAt >= 0 ? parts.slice(expAt + 1) : [];
  const intEnd = mantissaParts.findIndex((p) => p.k === "dot");
  const intParts = intEnd >= 0 ? mantissaParts.slice(0, intEnd) : mantissaParts;
  const decParts = intEnd >= 0 ? mantissaParts.slice(intEnd + 1) : [];
  const intDigits = intParts.filter((p) => p.k === "digit").length;
  const decDigits = decParts.filter((p) => p.k === "digit").length;
  const firstIntDigit = intParts.findIndex((p) => p.k === "digit");
  const lastIntDigit = intParts.map((p) => p.k === "digit").lastIndexOf(true);
  const thousands = intParts.some((p, i) => p.k === "comma" && i > firstIntDigit && i < lastIntDigit) || (firstIntDigit >= 0 && intParts.slice(firstIntDigit, lastIntDigit + 1).some((p) => p.k === "comma"));

  let exponent = 0;
  if (expAt >= 0) {
    if (value !== 0) {
      const step = Math.max(1, intDigits); // "##0.0E+0" moves the exponent in steps of 3
      exponent = Math.floor(Math.log10(Math.abs(value)));
      if (intDigits > 1 && intParts.some((p) => p.k === "digit" && p.v === "#")) exponent = Math.floor(exponent / step) * step;
      else exponent -= Math.max(0, intDigits - 1);
      value /= 10 ** exponent;
      const rounded = roundHalfAway(value, decDigits);
      if (Math.abs(rounded) >= 10 ** Math.max(1, intDigits)) {
        value /= 10;
        exponent += 1;
      }
    }
  }
  const negative = value < 0;
  const rounded = roundHalfAway(Math.abs(value), decDigits);
  const fixed = rounded.toFixed(decDigits);
  let [intStr, decStr = ""] = fixed.split(".");
  if (intStr === "0") intStr = "";
  // integer placeholders, filled from the right
  const intOut: string[] = [];
  let digits = intStr!;
  const slots = intParts.map((p, i) => ({ p, i })).filter(({ p }) => p.k === "digit");
  const pieces: string[] = new Array(intParts.length).fill("");
  for (let s = slots.length - 1; s >= 0; s--) {
    const { p, i } = slots[s]!;
    const kind = (p as { v: string }).v;
    if (digits.length) {
      const take = s === 0 ? digits : digits.slice(-1);
      digits = s === 0 ? "" : digits.slice(0, -1);
      pieces[i] = take;
    } else pieces[i] = kind === "0" ? "0" : kind === "?" ? " " : "";
  }
  if (slots.length === 0 && digits) pieces.push(digits);
  intParts.forEach((p, i) => {
    if (p.k === "lit") pieces[i] = p.v;
    else if (p.k === "space") pieces[i] = " ";
    else if (p.k === "pct") pieces[i] = "%";
    else if (p.k === "text") pieces[i] = "";
  });
  let intText = "";
  if (thousands && firstIntDigit >= 0) {
    const before = pieces.slice(0, firstIntDigit).join("");
    const inside = intParts.slice(firstIntDigit, lastIntDigit + 1).map((p, k) => (p.k === "digit" ? pieces[firstIntDigit + k] : p.k === "comma" ? "" : pieces[firstIntDigit + k])).join("");
    const after = pieces.slice(lastIntDigit + 1).join("");
    const lead = /^\s+/.exec(inside)?.[0] ?? "";
    intText = before + lead + groupThousands(inside.slice(lead.length)) + after;
  } else intText = pieces.join("");
  intOut.push(intText);
  // decimals, filled from the left
  let decText = "";
  if (intEnd >= 0) {
    const decSlots = decParts.filter((p) => p.k === "digit");
    let trimmed = decStr;
    // trailing # drop zeros, ? become spaces
    const chars = trimmed.split("");
    for (let d = decSlots.length - 1; d >= 0; d--) {
      const kind = (decSlots[d] as { v: string }).v;
      if (chars[d] === "0" && kind !== "0") chars[d] = kind === "?" ? " " : "";
      else break;
    }
    trimmed = chars.join("");
    let di = 0;
    let decPieces = "";
    for (const p of decParts) {
      if (p.k === "digit") decPieces += chars[di++] ?? "";
      else if (p.k === "lit") decPieces += p.v;
      else if (p.k === "space") decPieces += " ";
      else if (p.k === "pct") decPieces += "%";
    }
    const showDot = true;
    decText = (showDot ? "." : "") + decPieces;
  }
  let expText = "";
  if (expAt >= 0) {
    const sign = (parts[expAt] as { v: string }).v;
    const expDigits = expParts.filter((p) => p.k === "digit").length || 1;
    const e = Math.abs(exponent);
    expText = `${sign[0]}${exponent < 0 ? "-" : sign[1] === "+" ? "+" : ""}${String(e).padStart(expDigits, "0")}` + expParts.filter((p) => p.k === "lit").map((p) => (p as { v: string }).v).join("");
  }
  const body = intOut.join("") + decText + expText;
  const isZero = rounded === 0 && !/[1-9]/.test(body);
  return (negative && !isZero ? "-" : "") + body;
}

// --------------------------------------------------------------------------------------- dates

function formatDateSection(serial: number, section: Section): string {
  const parts = section.parts;
  const ampm = parts.some((p) => p.k === "date" && (p.v === "AM/PM" || p.v.toLowerCase() === "a/p"));
  const fractionDigits = Math.max(0, ...parts.filter((p) => p.k === "date" && p.v.startsWith(".")).map((p) => (p as { v: string }).v.length - 1));
  // round to what is shown: whole seconds, or the fraction digits shown
  const unit = 86400 * 10 ** fractionDigits;
  const rounded = Math.round(serial * unit) / unit;
  const d = dateParts(rounded);
  const totalSeconds = rounded * 86400;
  // which "m" runs are minutes: after an hour, or before a second
  const minuteAt = new Set<number>();
  parts.forEach((p, i) => {
    if (p.k !== "date" || !p.v.startsWith("m") || p.v.length > 2) return;
    const prev = parts.slice(0, i).reverse().find((q) => q.k === "date");
    const next = parts.slice(i + 1).find((q) => q.k === "date");
    if ((prev && (prev.v.startsWith("h") || prev.v.startsWith("[h"))) || (next && (next.v.startsWith("s") || next.v.startsWith("[s")))) minuteAt.add(i);
  });
  let out = "";
  parts.forEach((p, i) => {
    if (p.k === "lit") out += p.v;
    else if (p.k === "space") out += " ";
    else if (p.k === "general") out += formatGeneral(serial);
    else if (p.k === "digit") out += p.v === "0" ? "0" : "";
    else if (p.k === "dot") out += ".";
    else if (p.k === "comma") out += ",";
    else if (p.k === "pct") out += "%";
    else if (p.k === "slash") out += "/";
    else if (p.k === "text") out += "";
    else if (p.k === "date") {
      const v = p.v;
      if (v === "AM/PM") out += d.hour < 12 ? "AM" : "PM";
      else if (v.toLowerCase() === "a/p") out += d.hour < 12 ? (v[0] === "a" ? "a" : "A") : v[0] === "a" ? "p" : "P";
      else if (v.startsWith("[h")) out += String(Math.floor(totalSeconds / 3600)).padStart(v.length - 2, "0");
      else if (v.startsWith("[m")) out += String(Math.floor(totalSeconds / 60)).padStart(v.length - 2, "0");
      else if (v.startsWith("[s")) out += String(Math.floor(totalSeconds)).padStart(v.length - 2, "0");
      else if (v.startsWith(".")) out += "." + String(Math.round(d.ms * 10 ** (v.length - 1) / 1000)).padStart(v.length - 1, "0").slice(0, v.length - 1);
      else if (v[0] === "y" || v[0] === "e") out += v.length <= 2 && v[0] === "y" ? String(d.year % 100).padStart(2, "0") : String(d.year);
      else if (v[0] === "m" && minuteAt.has(i)) out += v.length === 1 ? String(d.minute) : String(d.minute).padStart(2, "0");
      else if (v[0] === "m") out += v.length === 1 ? String(d.month) : v.length === 2 ? String(d.month).padStart(2, "0") : v.length === 3 ? MONTHS[d.month - 1]!.slice(0, 3) : v.length === 5 ? MONTHS[d.month - 1]![0]! : MONTHS[d.month - 1]!;
      else if (v[0] === "d") out += v.length === 1 ? String(d.day) : v.length === 2 ? String(d.day).padStart(2, "0") : v.length === 3 ? DAYS[d.weekday]!.slice(0, 3) : DAYS[d.weekday]!;
      else if (v[0] === "h") {
        const hour = ampm ? (d.hour % 12 === 0 ? 12 : d.hour % 12) : d.hour;
        out += v.length === 1 ? String(hour) : String(hour).padStart(2, "0");
      } else if (v[0] === "s") out += v.length === 1 ? String(d.second) : String(d.second).padStart(2, "0");
    }
  });
  return out;
}

// ------------------------------------------------------------------------------------- choosing

function matches(cond: { op: string; n: number }, n: number): boolean {
  switch (cond.op) {
    case "<": return n < cond.n;
    case ">": return n > cond.n;
    case "<=": return n <= cond.n;
    case ">=": return n >= cond.n;
    case "=": return n === cond.n;
    default: return n !== cond.n;
  }
}

function textSection(text: string, section: Section): string {
  return section.parts.map((p) => (p.k === "text" ? text : p.k === "lit" ? p.v : p.k === "space" ? " " : "")).join("");
}

/** A value shown with a format code. */
export function formatValue(value: Scalar, code = "General"): Formatted {
  if (value === null) return { text: "" };
  if (value instanceof CellError) return { text: value.code };
  if (typeof value === "boolean") return { text: value ? "TRUE" : "FALSE" };
  const all = sections(code || "General");
  if (typeof value === "string") {
    const text = all[3] ?? all.find((s) => s.kind === "text");
    if (text) return { text: textSection(value, text), color: text.color };
    return { text: value };
  }
  if (!Number.isFinite(value)) return { text: "#NUM!" };
  let section: Section;
  let keepSign = false;
  const numeric = all.slice(0, 3).filter((s) => s.kind !== "text");
  if (numeric.some((s) => s.cond)) {
    const first = numeric[0]!;
    const second = numeric[1];
    const cond1 = first.cond ?? { op: ">=", n: 0 };
    if (matches(cond1, value)) section = first;
    else if (second && (second.cond ? matches(second.cond, value) : true)) section = second;
    else section = numeric[2] ?? second ?? first;
    keepSign = true; // a section chosen by a condition shows the value with its sign
  } else if (numeric.length >= 3 && value === 0) section = numeric[2]!;
  else if (numeric.length >= 2 && value < 0) section = numeric[1]!;
  else {
    section = numeric[0] ?? { parts: [{ k: "general" }], kind: "general" };
    keepSign = true;
  }
  if (section.kind === "general") {
    const body = formatGeneral(keepSign ? value : Math.abs(value));
    const text = section.parts.map((p) => (p.k === "general" ? body : p.k === "lit" ? p.v : p.k === "space" ? " " : "")).join("");
    return { text, color: section.color };
  }
  if (section.kind === "date") {
    if (value < 0 || value >= 2_958_466) return { text: "#".repeat(8), color: section.color };
    return { text: formatDateSection(value, section), color: section.color };
  }
  if (section.kind === "text") return { text: textSection(formatGeneral(value), section), color: section.color };
  return { text: formatNumberSection(value, section, keepSign), color: section.color };
}

// --------------------------------------------------------------------------- toolbar helpers

export const BUILTIN_FORMATS: { id: string; label: string; code: string }[] = [
  { id: "general", label: "General", code: "General" },
  { id: "number", label: "Number", code: "#,##0.00" },
  { id: "currency", label: "Currency", code: '"$"#,##0.00' },
  { id: "accounting", label: "Accounting", code: '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)' },
  { id: "short-date", label: "Short date", code: "m/d/yyyy" },
  { id: "long-date", label: "Long date", code: "dddd, mmmm d, yyyy" },
  { id: "time", label: "Time", code: "h:mm:ss AM/PM" },
  { id: "percent", label: "Percentage", code: "0.00%" },
  { id: "fraction", label: "Fraction", code: "# ?/?" },
  { id: "scientific", label: "Scientific", code: "0.00E+00" },
  { id: "text", label: "Text", code: "@" },
];

/** Excel's built-in format ids, as .xlsx files refer to them. */
export const XLSX_BUILTIN: Record<number, string> = {
  0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??",
  14: "m/d/yyyy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "m/d/yyyy h:mm",
  37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)", 45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0", 48: "##0.0E+0", 49: "@",
};

/** The format with one more (or one fewer) decimal place, for the toolbar buttons. */
export function changeDecimals(code: string, value: Scalar, more: boolean): string {
  let base = code;
  if (!code || code === "General") {
    if (typeof value !== "number") return more ? "0.0" : "0";
    const text = formatGeneral(value);
    const decimals = text.includes(".") && !text.includes("E") ? text.split(".")[1]!.length : 0;
    base = decimals ? `0.${"0".repeat(decimals)}` : "0";
  }
  return splitSections(base)
    .map((section) => {
      if (/[ymdhs]/i.test(section.replace(/"[^"]*"|\[[^\]]*\]/g, ""))) return section;
      const m = /([0#?])(\.([0#?]*))?(?![^"]*")/.exec(section);
      if (!m) return section;
      // the last run of digit placeholders before any E, %, or text
      const re = /([0#?,]*[0#?])(\.([0#?]+))?/g;
      let last: RegExpExecArray | null = null;
      let found: RegExpExecArray | null;
      while ((found = re.exec(section))) {
        last = found;
        if (/[eE][+-]/.test(section.slice(found.index + found[0].length, found.index + found[0].length + 2))) break;
      }
      if (!last) return section;
      const decimals = last[3] ?? "";
      const nextDecimals = more ? decimals + "0" : decimals.slice(0, -1);
      const replacement = last[1] + (nextDecimals ? "." + nextDecimals : "");
      return section.slice(0, last.index) + replacement + section.slice(last.index + last[0].length);
    })
    .join(";");
}
