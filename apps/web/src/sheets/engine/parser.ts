// Formulas: text to tokens to a syntax tree. Tokens keep their exact text, so a formula can be
// rewritten (copied, filled, rows inserted) by changing only its references.
import { colIndex, colName, MAX_COLS, MAX_ROWS } from "./address";
import { ERROR_CODES, type ErrorCode, type Scalar, ERRORS } from "./values";

export type TokenType = "num" | "str" | "bool" | "err" | "ref" | "func" | "name" | "op" | "(" | ")" | "," | ";" | "{" | "}" | "space" | "bad" | "struct";

export interface RefParts {
  sheet: string | null; // as written, unquoted
  kind: "cell" | "area" | "cols" | "rows";
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  // which parts have a $
  ar1: boolean;
  ac1: boolean;
  ar2: boolean;
  ac2: boolean;
}

export interface Token {
  type: TokenType;
  text: string;
  ref?: RefParts;
  /** Structured references: Table1[Sales] → table "Table1", spec "[Sales]". */
  table?: string | null;
  spec?: string;
}

const SHEET = String.raw`(?:'((?:[^']|'')+)'|([A-Za-z_À-￿][\w.À-￿]*))!`;
const CELL = String.raw`(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})`;
const REF_RE = new RegExp(
  String.raw`^(?:${SHEET})?(?:${CELL}(?::${CELL})?|(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})|(\$?)(\d{1,7}):(\$?)(\d{1,7}))(?![\w.(À-￿])`,
);
const NUM_RE = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/;
const NAME_RE = /^[A-Za-z_\\À-￿][\w.\\À-￿]*/;

function readRef(m: RegExpExecArray): RefParts | null {
  const sheet = m[1] !== undefined ? m[1].replace(/''/g, "'") : (m[2] ?? null);
  if (m[4] !== undefined) {
    const c1 = colIndex(m[4]);
    const r1 = Number(m[6]) - 1;
    const second = m[8] !== undefined;
    const c2 = second ? colIndex(m[8]!) : c1;
    const r2 = second ? Number(m[10]) - 1 : r1;
    if (c1 < 0 || c1 >= MAX_COLS || c2 < 0 || c2 >= MAX_COLS || r1 < 0 || r1 >= MAX_ROWS || r2 < 0 || r2 >= MAX_ROWS) return null;
    return { sheet, kind: second ? "area" : "cell", r1, c1, r2, c2, ac1: m[3] === "$", ar1: m[5] === "$", ac2: second ? m[7] === "$" : m[3] === "$", ar2: second ? m[9] === "$" : m[5] === "$" };
  }
  if (m[12] !== undefined) {
    const c1 = colIndex(m[12]);
    const c2 = colIndex(m[14]!);
    if (c1 < 0 || c1 >= MAX_COLS || c2 < 0 || c2 >= MAX_COLS) return null;
    return { sheet, kind: "cols", r1: 0, c1, r2: MAX_ROWS - 1, c2, ac1: m[11] === "$", ac2: m[13] === "$", ar1: true, ar2: true };
  }
  const r1 = Number(m[16]) - 1;
  const r2 = Number(m[18]) - 1;
  if (r1 < 0 || r1 >= MAX_ROWS || r2 < 0 || r2 >= MAX_ROWS) return null;
  return { sheet, kind: "rows", r1, c1: 0, r2, c2: MAX_COLS - 1, ar1: m[15] === "$", ar2: m[17] === "$", ac1: true, ac2: true };
}

/** The text of a formula (without its "="), as tokens. Never throws: unknown text becomes "bad". */
export function tokenize(formula: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const s = formula;
  while (i < s.length) {
    const ch = s[i]!;
    const rest = s.slice(i);
    if (/\s/.test(ch)) {
      const m = /^\s+/.exec(rest)!;
      tokens.push({ type: "space", text: m[0] });
      i += m[0].length;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === '"') {
          if (s[j + 1] === '"') j += 2;
          else break;
        } else j++;
      }
      tokens.push({ type: j < s.length ? "str" : "bad", text: s.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (ch === "[") {
      // a structured reference: [@Col], [[#Headers],[Col]], or Table1[Col] when a name comes first
      let depth = 0;
      let j = i;
      for (; j < s.length; j++) {
        if (s[j] === "'" ) {
          j++;
          continue;
        }
        if (s[j] === "[") depth++;
        else if (s[j] === "]" && --depth === 0) break;
      }
      const spec = s.slice(i, j + 1);
      const prev = tokens[tokens.length - 1];
      if (prev && prev.type === "name") {
        tokens[tokens.length - 1] = { type: "struct", text: prev.text + spec, table: prev.text, spec };
      } else tokens.push({ type: "struct", text: spec, table: null, spec });
      i = j + 1;
      continue;
    }
    if (ch === "#") {
      const code = ERROR_CODES.find((c) => rest.toUpperCase().startsWith(c));
      if (code) {
        tokens.push({ type: "err", text: rest.slice(0, code.length) });
        i += code.length;
        continue;
      }
    }
    // a reference, unless it is really a function name (LOG10( ) or a longer name
    const refMatch = REF_RE.exec(rest);
    if (refMatch) {
      const ref = readRef(refMatch);
      if (ref) {
        tokens.push({ type: "ref", text: refMatch[0], ref });
        i += refMatch[0].length;
        continue;
      }
    }
    const num = NUM_RE.exec(rest);
    if (num && !(ch === "." && !/\d/.test(s[i + 1] ?? ""))) {
      tokens.push({ type: "num", text: num[0] });
      i += num[0].length;
      continue;
    }
    if (ch === "'") {
      // a quoted sheet name before something that is not a plain reference (an error, a name)
      const m = /^'((?:[^']|'')+)'!/.exec(rest);
      if (m) {
        tokens.push({ type: "bad", text: m[0] });
        i += m[0].length;
        continue;
      }
    }
    const name = NAME_RE.exec(rest);
    if (name) {
      let text = name[0];
      // Sheet1!Name (a defined name on a sheet) is read as one name
      if (s[i + text.length] === "!") {
        const after = NAME_RE.exec(s.slice(i + text.length + 1));
        if (after) text = text + "!" + after[0];
      }
      const upper = text.toUpperCase();
      let j = i + text.length;
      while (j < s.length && s[j] === " ") j++;
      if (s[j] === "(") tokens.push({ type: "func", text });
      else if (upper === "TRUE" || upper === "FALSE") tokens.push({ type: "bool", text });
      else tokens.push({ type: "name", text });
      i += text.length;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") {
      tokens.push({ type: "op", text: two });
      i += 2;
      continue;
    }
    if ("+-*/^&=<>%:".includes(ch)) {
      tokens.push({ type: "op", text: ch });
      i++;
      continue;
    }
    if ("(),;{}".includes(ch)) {
      tokens.push({ type: ch as TokenType, text: ch });
      i++;
      continue;
    }
    tokens.push({ type: "bad", text: ch });
    i++;
  }
  return tokens;
}

// ------------------------------------------------------------------------------------ syntax tree

export type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "err"; v: ErrorCode }
  | { t: "arr"; rows: Scalar[][] }
  | { t: "ref"; ref: RefParts }
  | { t: "struct"; table: string | null; spec: string }
  | { t: "name"; name: string }
  | { t: "un"; op: "-" | "+"; x: Node }
  | { t: "pct"; x: Node }
  | { t: "bin"; op: string; a: Node; b: Node }
  | { t: "call"; name: string; args: (Node | null)[] }
  | { t: "invoke"; fn: Node; args: (Node | null)[] }
  | { t: "union"; items: Node[] };

export class ParseError extends Error {}

const BINARY: Record<string, number> = { "=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4, "^": 5, " ": 8, ":": 9 };

/** Function names as Excel stores them in files carry prefixes; the tree has the plain name. */
export function plainName(name: string): string {
  return name.toUpperCase().replace(/^(_XLFN\.|_XLWS\.|_XLPM\.)+/, "").replace(/^_XLFN\./, "");
}

export function parse(formula: string): Node {
  const all = tokenize(formula);
  // spaces matter only as the intersection operator: between two references or closing brackets
  const tokens: Token[] = [];
  for (let i = 0; i < all.length; i++) {
    const tok = all[i]!;
    if (tok.type !== "space") {
      tokens.push(tok);
      continue;
    }
    const before = tokens[tokens.length - 1];
    const after = all.slice(i + 1).find((t) => t.type !== "space");
    if (before && after && (before.type === "ref" || before.type === ")" || before.type === "name" || before.type === "struct") && (after.type === "ref" || after.type === "(" || after.type === "name" || after.type === "func" || after.type === "struct")) {
      tokens.push({ type: "op", text: " " });
    }
  }
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (type: TokenType) => {
    const tok = next();
    if (!tok || tok.type !== type) throw new ParseError(`expected ${type === ")" ? "a closing bracket" : `"${type}"`}`);
    return tok;
  };

  const primary = (): Node => {
    const tok = next();
    if (!tok) throw new ParseError("the formula ends too soon");
    switch (tok.type) {
      case "num":
        return { t: "num", v: Number(tok.text) };
      case "str":
        return { t: "str", v: tok.text.slice(1, -1).replace(/""/g, '"') };
      case "bool":
        return { t: "bool", v: tok.text.toUpperCase() === "TRUE" };
      case "err":
        return { t: "err", v: tok.text.toUpperCase() as ErrorCode };
      case "ref":
        return { t: "ref", ref: tok.ref! };
      case "name":
        return { t: "name", name: tok.text };
      case "struct":
        return { t: "struct", table: tok.table ?? null, spec: tok.spec ?? "" };
      case "func": {
        expect("(");
        const args = argList();
        return { t: "call", name: plainName(tok.text), args };
      }
      case "(": {
        const first = expression(0);
        if (peek()?.type === ",") {
          const items = [first];
          while (peek()?.type === ",") {
            next();
            items.push(expression(0));
          }
          expect(")");
          return { t: "union", items };
        }
        expect(")");
        return first;
      }
      case "{":
        return arrayConstant();
      case "op":
        if (tok.text === "-" || tok.text === "+") return { t: "un", op: tok.text, x: expression(6) };
        throw new ParseError(`"${tok.text}" cannot start a value`);
      default:
        throw new ParseError(tok.type === "bad" ? (tok.text.startsWith('"') ? "a text has no closing quote" : `"${tok.text}" is not understood`) : `"${tok.text}" is out of place`);
    }
  };

  const argList = (): (Node | null)[] => {
    const args: (Node | null)[] = [];
    if (peek()?.type === ")") {
      next();
      return args;
    }
    for (;;) {
      const tok = peek();
      if (tok?.type === "," || tok?.type === ")") args.push(null);
      else args.push(expression(0));
      const sep = next();
      if (!sep) throw new ParseError("a closing bracket is missing");
      if (sep.type === ")") return args;
      if (sep.type !== ",") throw new ParseError(`"${sep.text}" is out of place`);
    }
  };

  const arrayConstant = (): Node => {
    const rows: Scalar[][] = [[]];
    for (;;) {
      let tok = next();
      if (!tok) throw new ParseError("an array has no closing }");
      let sign = 1;
      if (tok.type === "op" && (tok.text === "-" || tok.text === "+")) {
        sign = tok.text === "-" ? -1 : 1;
        tok = next();
        if (!tok || tok.type !== "num") throw new ParseError("arrays hold numbers, text, TRUE/FALSE and errors");
      }
      let value: Scalar;
      if (tok.type === "num") value = sign * Number(tok.text);
      else if (tok.type === "str") value = tok.text.slice(1, -1).replace(/""/g, '"');
      else if (tok.type === "bool") value = tok.text.toUpperCase() === "TRUE";
      else if (tok.type === "err") value = ERRORS[tok.text.toUpperCase() as ErrorCode];
      else throw new ParseError("arrays hold numbers, text, TRUE/FALSE and errors");
      rows[rows.length - 1]!.push(value);
      const sep = next();
      if (!sep) throw new ParseError("an array has no closing }");
      if (sep.type === "}") break;
      if (sep.type === ";") rows.push([]);
      else if (sep.type !== ",") throw new ParseError("separate array values with , and rows with ;");
    }
    const width = rows[0]!.length;
    if (rows.some((r) => r.length !== width)) throw new ParseError("every row of an array needs the same number of values");
    return { t: "arr", rows };
  };

  const postfix = (node: Node): Node => {
    for (;;) {
      const tok = peek();
      if (tok?.type === "op" && tok.text === "%") {
        next();
        node = { t: "pct", x: node };
      } else if (tok?.type === "(" && (node.t === "call" || node.t === "invoke" || node.t === "name")) {
        // LAMBDA(x, x+1)(5), or a name bound to a LAMBDA
        next();
        node = { t: "invoke", fn: node, args: argList() };
      } else return node;
    }
  };

  const expression = (minPrec: number): Node => {
    let left = postfix(primary());
    for (;;) {
      const tok = peek();
      if (!tok || tok.type !== "op") return left;
      const prec = BINARY[tok.text];
      if (prec === undefined || prec <= minPrec) {
        if (prec === undefined) throw new ParseError(`"${tok.text}" is out of place`);
        return left;
      }
      next();
      // ^ is left-associative in Excel (2^3^2 = 64)
      const right = postfix(prec >= 8 ? primary() : expression(prec));
      left = { t: "bin", op: tok.text, a: left, b: right };
    }
  };

  if (!tokens.length) throw new ParseError("the formula is empty");
  const tree = expression(0);
  if (pos < tokens.length) {
    const tok = tokens[pos]!;
    throw new ParseError(tok.type === ")" ? "there is a closing bracket too many" : `"${tok.text}" is out of place`);
  }
  return tree;
}

// ------------------------------------------------------------------------------- rewriting refs

/** A reference's text from its parts. */
export function refText(ref: RefParts): string {
  const sheet = ref.sheet === null ? "" : `${/^[A-Za-z_À-￿][\w.À-￿]*$/.test(ref.sheet) && !/^[A-Za-z]{1,3}\d+$/.test(ref.sheet) ? ref.sheet : `'${ref.sheet.replace(/'/g, "''")}'`}!`;
  const d = (on: boolean) => (on ? "$" : "");
  if (ref.kind === "cols") return `${sheet}${d(ref.ac1)}${colName(ref.c1)}:${d(ref.ac2)}${colName(ref.c2)}`;
  if (ref.kind === "rows") return `${sheet}${d(ref.ar1)}${ref.r1 + 1}:${d(ref.ar2)}${ref.r2 + 1}`;
  const first = `${d(ref.ac1)}${colName(ref.c1)}${d(ref.ar1)}${ref.r1 + 1}`;
  if (ref.kind === "cell") return sheet + first;
  return `${sheet}${first}:${d(ref.ac2)}${colName(ref.c2)}${d(ref.ar2)}${ref.r2 + 1}`;
}

/** Rewrite every reference; a function returning null turns that reference into #REF!. */
export function mapRefs(formula: string, fn: (ref: RefParts) => RefParts | null): string {
  return tokenize(formula)
    .map((tok) => {
      if (tok.type !== "ref") return tok.text;
      const next = fn(tok.ref!);
      if (!next) return (tok.ref!.sheet !== null ? `${tok.text.slice(0, tok.text.indexOf("!") + 1)}` : "") + "#REF!";
      return refText(next);
    })
    .join("");
}

/** The formula as it reads when copied d rows down and d columns right: relative parts move. */
export function shiftFormula(formula: string, dRow: number, dCol: number): string {
  return mapRefs(formula, (ref) => {
    const out = { ...ref };
    if (ref.kind !== "cols") {
      if (!ref.ar1) out.r1 += dRow;
      if (!ref.ar2) out.r2 += dRow;
    }
    if (ref.kind !== "rows") {
      if (!ref.ac1) out.c1 += dCol;
      if (!ref.ac2) out.c2 += dCol;
    }
    if (out.r1 < 0 || out.r2 < 0 || out.c1 < 0 || out.c2 < 0 || out.r1 >= MAX_ROWS || out.r2 >= MAX_ROWS || out.c1 >= MAX_COLS || out.c2 >= MAX_COLS) return null;
    return out;
  });
}

/** Names of the functions a formula calls (for checks and help). */
export function functionsIn(formula: string): string[] {
  return tokenize(formula).filter((t) => t.type === "func").map((t) => plainName(t.text));
}
