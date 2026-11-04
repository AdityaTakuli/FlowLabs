// Evaluating a formula's tree: operators, references, names, LET/LAMBDA, and calling functions,
// with Excel's coercions and dynamic-array broadcasting.
import { parseDate } from "./dates";
import type { Node, RefParts } from "./parser";
import { CellError, compareValues, ERRORS, isError, isLambda, isMatrix, isRange, Matrix, parseNumber, tidy, type LambdaValue, type RangeValue, type Scalar, type Value } from "./values";

/** What a formula can ask of its workbook. */
export interface Context {
  /** The sheet (its uid) and cell the formula is in. */
  sheet: number;
  row: number;
  col: number;
  /** A cell's value, calculating it first when it is out of date. */
  value(sheet: number, row: number, col: number): Scalar;
  /** The rows and columns in use on a sheet, so whole-column references stop there. */
  bounds(sheet: number): { rows: number; cols: number };
  sheetByName(name: string): number | null;
  sheetName(sheet: number): string;
  sheetIndex(sheet: number): number;
  sheetCount(): number;
  /** A defined name's tree, or undefined. */
  name(name: string, sheet: number): Node | undefined;
  /** A structured reference (Table1[Sales]) as a range, or null when it names nothing. */
  structured?(table: string | null, spec: string): RangeValue | null;
  /** 0 visible, 1 hidden by a filter, 2 hidden by hand (SUBTOTAL and AGGREGATE skip them). */
  hidden?(sheet: number, row: number): 0 | 1 | 2;
  /** The formula text in a cell, or null. */
  formula(sheet: number, row: number, col: number): string | null;
  /** NOW() and RAND() for this calculation. */
  now(): number;
  random(): number;
}

export type Args = Value[];
export interface FnDef {
  min: number;
  max: number;
  /** How each argument arrives: "v" a single value (the function is repeated over arrays),
   * "a" as written (a range stays a reference), "l" not evaluated (IF, LET). The last letter repeats. */
  args: string;
  fn: (args: Args, ctx: Context, nodes: (Node | null)[], scope: Scope) => Value;
  volatile?: boolean;
}

export type Scope = Map<string, Value> | null;

export const FUNCTIONS: Record<string, FnDef> = {};

export function define(name: string, args: string, min: number, max: number, fn: FnDef["fn"], volatile = false) {
  FUNCTIONS[name] = { args, min, max, fn, volatile };
}

/** A missing argument (IF(A1,,2)). */
export const MISSING = Symbol("missing") as unknown as Scalar;
export const isMissing = (v: unknown): boolean => v === (MISSING as unknown) || v === undefined;

// ---------------------------------------------------------------------------------- references

export function refToRange(ref: RefParts, ctx: Context): RangeValue | CellError {
  let sheet = ctx.sheet;
  if (ref.sheet !== null) {
    const found = ctx.sheetByName(ref.sheet);
    if (found === null) return ERRORS["#REF!"];
    sheet = found;
  }
  return { kind: "range", sheet, r1: Math.min(ref.r1, ref.r2), c1: Math.min(ref.c1, ref.c2), r2: Math.max(ref.r1, ref.r2), c2: Math.max(ref.c1, ref.c2) };
}

/** A range clipped to the part of the sheet in use (A:A reads only the used rows). */
export function clip(range: RangeValue, ctx: Context): RangeValue {
  const { rows, cols } = ctx.bounds(range.sheet);
  return { ...range, r2: Math.min(range.r2, Math.max(range.r1, rows - 1)), c2: Math.min(range.c2, Math.max(range.c1, cols - 1)) };
}

export function rangeSize(range: RangeValue): { rows: number; cols: number } {
  return { rows: range.r2 - range.r1 + 1, cols: range.c2 - range.c1 + 1 };
}

/** A range's values as a block (the full shape, empty cells as null). */
export function readRange(range: RangeValue, ctx: Context, clipToUse = true): Matrix {
  const area = clipToUse ? clip(range, ctx) : range;
  const rows = area.r2 - area.r1 + 1;
  const cols = area.c2 - area.c1 + 1;
  const data = new Array<Scalar>(rows * cols);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) data[r * cols + c] = ctx.value(area.sheet, area.r1 + r, area.c1 + c);
  return new Matrix(rows, cols, data);
}

/** Any value as a block: a scalar is 1×1. */
export function toMatrix(v: Value, ctx: Context): Matrix {
  if (isMatrix(v)) return v;
  if (isRange(v)) {
    if (v.more) return ERRORS["#VALUE!"] as unknown as Matrix;
    return readRange(v, ctx);
  }
  if (isLambda(v)) return Matrix.filled(1, 1, ERRORS["#CALC!"]);
  return new Matrix(1, 1, [v]);
}

/** One value: a 1×1 range or block gives its value, a bigger one its top-left (callers lift first). */
export function toScalar(v: Value, ctx: Context): Scalar {
  if (isRange(v)) {
    if (v.more) return ERRORS["#VALUE!"];
    if (v.r1 === v.r2 && v.c1 === v.c2) return ctx.value(v.sheet, v.r1, v.c1);
    // implicit intersection with the formula's own row or column
    if (v.c1 === v.c2 && ctx.sheet === v.sheet && ctx.row >= v.r1 && ctx.row <= v.r2) return ctx.value(v.sheet, ctx.row, v.c1);
    if (v.r1 === v.r2 && ctx.sheet === v.sheet && ctx.col >= v.c1 && ctx.col <= v.c2) return ctx.value(v.sheet, v.r1, ctx.col);
    return ERRORS["#VALUE!"];
  }
  if (isMatrix(v)) return v.get(0, 0);
  if (isLambda(v)) return ERRORS["#CALC!"];
  return v;
}

// ---------------------------------------------------------------------------------- coercions

export function num(v: Scalar): number | CellError {
  if (typeof v === "number") return v;
  if (v === null || isMissing(v)) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isError(v)) return v;
  const n = parseNumber(v, parseDate);
  return n === null ? ERRORS["#VALUE!"] : n;
}

export function str(v: Scalar): string | CellError {
  if (v === null || isMissing(v)) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (isError(v)) return v;
  return numberText(v);
}

/** A number as text, the way Excel turns it into text (=1/3&"" is 0.333333333333333). */
export function numberText(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n);
  const p = Number(n.toPrecision(15));
  if (Math.abs(p) >= 1e21 || (Math.abs(p) < 1e-9 && p !== 0)) {
    const [m, e] = p.toExponential().split("e");
    const exp = Number(e);
    return `${m!.toUpperCase()}E${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  return String(p);
}

export function bool(v: Scalar): boolean | CellError {
  if (typeof v === "boolean") return v;
  if (v === null || isMissing(v)) return false;
  if (typeof v === "number") return v !== 0;
  if (isError(v)) return v;
  const up = v.toUpperCase();
  if (up === "TRUE") return true;
  if (up === "FALSE") return false;
  return ERRORS["#VALUE!"];
}

export const isNum = (v: unknown): v is number => typeof v === "number";
export const isStr = (v: unknown): v is string => typeof v === "string";

/** Numbers to aggregate (SUM, AVERAGE…): references and arrays give only their numbers; values typed
 * as arguments count when they read as numbers. Errors stop it. */
export function numbers(args: Args, ctx: Context, opts: { text?: "skip" | "zero"; bools?: "skip" | "count" } = {}): number[] | CellError {
  const out: number[] = [];
  for (const arg of args) {
    if (isMissing(arg)) continue;
    if (isRange(arg) || isMatrix(arg)) {
      const blocks = isRange(arg) && arg.more ? [arg, ...arg.more] : [arg];
      for (const block of blocks) {
        const m = isRange(block) ? readRange(block, ctx) : (block as Matrix);
        for (const v of m.data) {
          if (typeof v === "number") out.push(v);
          else if (isError(v)) return v;
          else if (typeof v === "boolean" && opts.bools === "count") out.push(v ? 1 : 0);
          else if (typeof v === "string" && opts.text === "zero") out.push(0);
        }
      }
      continue;
    }
    if (isLambda(arg)) return ERRORS["#VALUE!"];
    const v = arg as Scalar;
    if (v === null) continue;
    if (isError(v)) return v;
    const n = num(v);
    if (isError(n)) return n;
    out.push(n);
  }
  return out;
}

/** Every value in the arguments, flattened (for COUNTA, TEXTJOIN…). */
export function flatten(args: Args, ctx: Context): Scalar[] {
  const out: Scalar[] = [];
  for (const arg of args) {
    if (isMissing(arg)) continue;
    if (isRange(arg)) for (const block of arg.more ? [arg, ...arg.more] : [arg]) out.push(...readRange(block, ctx).data);
    else if (isMatrix(arg)) out.push(...arg.data);
    else if (!isLambda(arg)) out.push(arg as Scalar);
  }
  return out;
}

// ----------------------------------------------------------------------------- broadcasting

/** Apply fn over one or more blocks the way Excel's dynamic arrays do: 1×N and N×1 stretch. */
export function broadcast(blocks: Matrix[], fn: (values: Scalar[]) => Scalar): Matrix {
  const rows = Math.max(...blocks.map((b) => b.rows));
  const cols = Math.max(...blocks.map((b) => b.cols));
  const data = new Array<Scalar>(rows * cols);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const values = blocks.map((b) => {
        const rr = b.rows === 1 ? 0 : r;
        const cc = b.cols === 1 ? 0 : c;
        return rr < b.rows && cc < b.cols ? b.get(rr, cc) : ERRORS["#N/A"];
      });
      data[r * cols + c] = fn(values);
    }
  return new Matrix(rows, cols, data);
}

const isBlock = (v: Value) => isMatrix(v) || (isRange(v) && !(v.r1 === v.r2 && v.c1 === v.c2));

// -------------------------------------------------------------------------------- operators

function arith(op: string, a: Scalar, b: Scalar): Scalar {
  const x = num(a);
  if (isError(x)) return x;
  const y = num(b);
  if (isError(y)) return y;
  let r: number;
  switch (op) {
    case "+": r = x + y; break;
    case "-": r = x - y; break;
    case "*": r = x * y; break;
    case "/":
      if (y === 0) return ERRORS["#DIV/0!"];
      r = x / y;
      break;
    default: // ^
      if (x === 0 && y === 0) return ERRORS["#NUM!"];
      if (x === 0 && y < 0) return ERRORS["#DIV/0!"];
      r = x ** y;
      if (Number.isNaN(r)) return ERRORS["#NUM!"];
  }
  if (!Number.isFinite(r)) return ERRORS["#NUM!"];
  return op === "+" || op === "-" ? tidy(r) : r;
}

function compare(op: string, a: Scalar, b: Scalar): Scalar {
  if (isError(a)) return a;
  if (isError(b)) return b;
  const c = compareValues(typeof a === "number" ? tidy(a) : a, typeof b === "number" ? tidy(b) : b);
  switch (op) {
    case "=": return c === 0;
    case "<>": return c !== 0;
    case "<": return c < 0;
    case ">": return c > 0;
    case "<=": return c <= 0;
    default: return c >= 0;
  }
}

function binaryScalar(op: string, a: Scalar, b: Scalar): Scalar {
  if (op === "&") {
    const x = str(a);
    if (isError(x)) return x;
    const y = str(b);
    if (isError(y)) return y;
    return x + y;
  }
  if (op === "=" || op === "<>" || op === "<" || op === ">" || op === "<=" || op === ">=") return compare(op, a, b);
  return arith(op, a, b);
}

function rangeOp(a: Value, b: Value): Value {
  if (!isRange(a) || !isRange(b)) return ERRORS["#VALUE!"];
  if (a.sheet !== b.sheet) return ERRORS["#VALUE!"];
  return { kind: "range", sheet: a.sheet, r1: Math.min(a.r1, b.r1), c1: Math.min(a.c1, b.c1), r2: Math.max(a.r2, b.r2), c2: Math.max(a.c2, b.c2) };
}

function intersect(a: Value, b: Value): Value {
  if (!isRange(a) || !isRange(b) || a.sheet !== b.sheet) return ERRORS["#VALUE!"];
  const r1 = Math.max(a.r1, b.r1);
  const c1 = Math.max(a.c1, b.c1);
  const r2 = Math.min(a.r2, b.r2);
  const c2 = Math.min(a.c2, b.c2);
  if (r1 > r2 || c1 > c2) return ERRORS["#NULL!"];
  return { kind: "range", sheet: a.sheet, r1, c1, r2, c2 };
}

// ---------------------------------------------------------------------------------- evaluate

export function evaluate(node: Node, ctx: Context, scope: Scope = null): Value {
  switch (node.t) {
    case "num": return node.v;
    case "str": return node.v;
    case "bool": return node.v;
    case "err": return ERRORS[node.v] ?? new CellError(node.v);
    case "arr": return Matrix.of(node.rows);
    case "ref": return refToRange(node.ref, ctx);
    case "struct": return ctx.structured?.(node.table, node.spec) ?? ERRORS["#REF!"];
    case "name": {
      const upper = node.name.toUpperCase();
      if (scope?.has(upper)) return scope.get(upper)!;
      const tree = ctx.name(node.name, ctx.sheet);
      if (tree) return evaluate(tree, ctx, null);
      // a function named without brackets is a function value: GROUPBY(A:A, B:B, SUM)
      const fn = FUNCTIONS[upper.replace(/^_XLFN\./, "")];
      if (fn) return { kind: "lambda", params: ["_ETA"], body: { t: "call", name: upper.replace(/^_XLFN\./, ""), args: [{ t: "name", name: "_ETA" }] }, scope: new Map() };
      return new CellError("#NAME?", node.name);
    }
    case "un": {
      const x = evaluate(node.x, ctx, scope);
      const f = (v: Scalar): Scalar => {
        const n = num(v);
        return isError(n) ? n : node.op === "-" ? -n : n;
      };
      if (isBlock(x)) return toMatrix(x, ctx).map(f);
      return f(toScalar(x, ctx));
    }
    case "pct": {
      const x = evaluate(node.x, ctx, scope);
      const f = (v: Scalar): Scalar => {
        const n = num(v);
        return isError(n) ? n : n / 100;
      };
      if (isBlock(x)) return toMatrix(x, ctx).map(f);
      return f(toScalar(x, ctx));
    }
    case "bin": {
      if (node.op === ":") return rangeOp(evaluate(node.a, ctx, scope), evaluate(node.b, ctx, scope));
      if (node.op === " ") return intersect(evaluate(node.a, ctx, scope), evaluate(node.b, ctx, scope));
      const a = evaluate(node.a, ctx, scope);
      const b = evaluate(node.b, ctx, scope);
      if (isBlock(a) || isBlock(b)) return broadcast([toMatrix(a, ctx), toMatrix(b, ctx)], ([x, y]) => binaryScalar(node.op, x!, y!));
      return binaryScalar(node.op, toScalar(a, ctx), toScalar(b, ctx));
    }
    case "union": {
      const items = node.items.map((n) => evaluate(n, ctx, scope));
      if (!items.every(isRange)) return ERRORS["#VALUE!"];
      const [first, ...rest] = items as RangeValue[];
      return { ...first!, more: rest };
    }
    case "call": {
      const local = scope?.get(node.name);
      if (local && isLambda(local)) return invoke(local, node.args, ctx, scope);
      const def = FUNCTIONS[node.name];
      if (!def) {
        // a defined name holding a LAMBDA: =MyFunction(1, 2)
        const tree = ctx.name(node.name, ctx.sheet);
        if (tree) {
          const fn = evaluate(tree, ctx, null);
          if (isLambda(fn)) return invoke(fn, node.args, ctx, scope);
        }
        return new CellError("#NAME?", node.name);
      }
      return call(def, node.args, ctx, scope);
    }
    case "invoke": {
      const fn = evaluate(node.fn, ctx, scope);
      if (!isLambda(fn)) return isError(fn) ? fn : ERRORS["#VALUE!"];
      return invoke(fn, node.args, ctx, scope);
    }
  }
}

export function invoke(fn: LambdaValue, argNodes: (Node | null)[], ctx: Context, scope: Scope, values?: Value[]): Value {
  const args = values ?? argNodes.map((n) => (n ? evaluate(n, ctx, scope) : MISSING));
  if (args.length > fn.params.length) return ERRORS["#VALUE!"];
  const inner = new Map(fn.scope);
  fn.params.forEach((p, i) => inner.set(p, i < args.length ? args[i]! : MISSING));
  return evaluate(fn.body as Node, ctx, inner);
}

export function call(def: FnDef, nodes: (Node | null)[], ctx: Context, scope: Scope): Value {
  if (nodes.length < def.min || nodes.length > def.max) return new CellError("#VALUE!", "wrong number of arguments");
  const letters = def.args;
  const kindOf = (i: number) => letters[Math.min(i, letters.length - 1)]!;
  const args: Value[] = nodes.map((n, i) => {
    if (kindOf(i) === "l") return MISSING;
    return n ? evaluate(n, ctx, scope) : MISSING;
  });
  // repeat the function over arrays given where it takes single values
  const lifted = args.map((a, i) => kindOf(i) === "v" && isBlock(a));
  if (lifted.some(Boolean)) {
    const blocks = args.map((a, i) => (lifted[i] ? toMatrix(a, ctx) : null));
    const shapes = blocks.filter((b): b is Matrix => b !== null);
    const rows = Math.max(...shapes.map((b) => b.rows));
    const cols = Math.max(...shapes.map((b) => b.cols));
    const data = new Array<Scalar>(rows * cols);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const one = args.map((a, i) => {
          const b = blocks[i];
          if (!b) return kindOf(i) === "v" ? toScalar(a, ctx) : a;
          const rr = b.rows === 1 ? 0 : r;
          const cc = b.cols === 1 ? 0 : c;
          return rr < b.rows && cc < b.cols ? b.get(rr, cc) : ERRORS["#N/A"];
        });
        const out = def.fn(one, ctx, nodes, scope);
        data[r * cols + c] = isMatrix(out) || isRange(out) ? toScalar(out, ctx) : (out as Scalar);
      }
    return new Matrix(rows, cols, data);
  }
  const ready = args.map((a, i) => (kindOf(i) === "v" ? toScalar(a, ctx) : a));
  return def.fn(ready, ctx, nodes, scope);
}

/** The value a cell shows from a result: a block spills, so this is its top-left. */
export function resultScalar(v: Value, ctx: Context): Scalar {
  if (isLambda(v)) return ERRORS["#CALC!"];
  if (isRange(v) || isMatrix(v)) return toScalar(isRange(v) ? readRange(v, ctx, false) : v, ctx);
  if (isMissing(v)) return 0;
  return v;
}

// -------------------------------------------------------------------------------- criteria

/** COUNTIF-style criteria: 5, ">=5", "<>apple", "a*", "=". */
export function criteria(c: Scalar): (v: Scalar) => boolean {
  if (typeof c === "number") return (v) => (typeof v === "number" ? tidy(v) === tidy(c) : typeof v === "string" && parseNumber(v, parseDate) === c);
  if (typeof c === "boolean") return (v) => v === c;
  if (isError(c)) return (v) => isError(v) && v.code === c.code;
  if (c === null) return (v) => v === null || v === "";
  const m = /^(<=|>=|<>|=|<|>)?([\s\S]*)$/.exec(c)!;
  const op = m[1] ?? "=";
  const operand = m[2]!;
  const asNumber = operand.trim() === "" ? null : parseNumber(operand, parseDate);
  const upperOp = operand.toUpperCase();
  if (asNumber !== null) {
    return (v) => {
      const n = typeof v === "number" ? v : null;
      if (n === null) return op === "<>";
      const x = tidy(n);
      switch (op) {
        case "=": return x === asNumber;
        case "<>": return x !== asNumber;
        case "<": return x < asNumber;
        case ">": return x > asNumber;
        case "<=": return x <= asNumber;
        default: return x >= asNumber;
      }
    };
  }
  if (upperOp === "TRUE" || upperOp === "FALSE") {
    const want = upperOp === "TRUE";
    return (v) => (op === "<>" ? v !== want : op === "=" ? v === want : false);
  }
  const errorCode = Object.keys(ERRORS).find((e) => e === upperOp);
  if (errorCode) return (v) => (op === "<>" ? !(isError(v) && v.code === errorCode) : isError(v) && v.code === errorCode);
  if (operand === "") {
    if (op === "=") return (v) => v === null || v === "";
    if (op === "<>") return (v) => !(v === null || v === "");
  }
  if (op === "=" || op === "<>") {
    const re = wildcard(operand);
    return (v) => {
      const hit = typeof v === "string" ? re.test(v) : false;
      return op === "=" ? hit : !hit;
    };
  }
  return (v) => {
    if (typeof v !== "string") return false;
    const c2 = compareValues(v, operand);
    return op === "<" ? c2 < 0 : op === ">" ? c2 > 0 : op === "<=" ? c2 <= 0 : c2 >= 0;
  };
}

/** Excel wildcards: * any run, ? one character, ~ escapes; whole text, case-insensitive. */
export function wildcard(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "~" && i + 1 < pattern.length && "*?~".includes(pattern[i + 1]!)) {
      re += "\\" + pattern[++i];
    } else if (ch === "*") re += "[\\s\\S]*";
    else if (ch === "?") re += "[\\s\\S]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

export const hasWildcard = (s: string) => /(^|[^~])[*?]/.test(s);

// --------------------------------------------------------------------------------- helpers for functions

export function errorIn(values: Scalar[]): CellError | null {
  for (const v of values) if (isError(v)) return v;
  return null;
}

/** Arguments as numbers, or the first error. */
export function nums(values: Scalar[]): number[] | CellError {
  const out: number[] = [];
  for (const v of values) {
    const n = num(v);
    if (isError(n)) return n;
    out.push(n);
  }
  return out;
}

export function optNum(v: Scalar, fallback: number): number | CellError {
  return v === null || isMissing(v) ? fallback : num(v);
}

export function optBool(v: Scalar, fallback: boolean): boolean | CellError {
  return v === null || isMissing(v) ? fallback : bool(v);
}

export function checkNum(n: number): number | CellError {
  return Number.isFinite(n) ? n : ERRORS["#NUM!"];
}

export { ERRORS, Matrix, isError, isMatrix, isRange, isLambda };
export type { Scalar, Value, RangeValue, LambdaValue };
export type { Node } from "./parser";
