// Logical functions (IF, IFS, SWITCH, LET, LAMBDA and its helpers) and information functions.
import {
  bool, broadcast, define, ERRORS, evaluate, flatten, invoke, isError, isLambda, isMatrix, isMissing, isRange, Matrix, MISSING, num, toMatrix, toScalar, type Context, type Node, type Scalar, type Scope, type Value,
} from "../evaluate";
import { ERROR_NUMBERS, CellError } from "../values";
import { colName } from "../address";

const isBlock = (v: Value) => isMatrix(v) || (isRange(v) && !(v.r1 === v.r2 && v.c1 === v.c2));
const ev = (n: Node | null | undefined, ctx: Context, scope: Scope): Value => (n ? evaluate(n, ctx, scope) : MISSING);

define("IF", "l", 1, 3, (_a, ctx, nodes, scope) => {
  const cond = ev(nodes[0], ctx, scope);
  const yes = nodes.length > 1;
  const no = nodes.length > 2;
  const pick = (c: Scalar, a: () => Value, b: () => Value): Value => {
    if (isError(c)) return c;
    const t = bool(c);
    if (isError(t)) return t;
    return t ? (yes ? a() : true) : no ? b() : false;
  };
  const missingAsZero = (v: Value) => (isMissing(v) ? 0 : v);
  if (isBlock(cond)) {
    const a = yes ? missingAsZero(ev(nodes[1], ctx, scope)) : true;
    const b = no ? missingAsZero(ev(nodes[2], ctx, scope)) : false;
    return broadcast([toMatrix(cond, ctx), toMatrix(a, ctx), toMatrix(b, ctx)], ([c, x, y]) => {
      if (isError(c!)) return c!;
      const t = bool(c!);
      if (isError(t)) return t;
      return t ? x! : y!;
    });
  }
  return pick(toScalar(cond, ctx), () => missingAsZero(ev(nodes[1], ctx, scope)), () => missingAsZero(ev(nodes[2], ctx, scope)));
});
define("IFS", "l", 2, 254, (_a, ctx, nodes, scope) => {
  if (nodes.length % 2) return ERRORS["#N/A"];
  for (let i = 0; i < nodes.length; i += 2) {
    const c = toScalar(ev(nodes[i], ctx, scope), ctx);
    if (isError(c)) return c;
    const t = bool(c);
    if (isError(t)) return t;
    if (t) return ev(nodes[i + 1], ctx, scope);
  }
  return ERRORS["#N/A"];
});
const onError = (only: string | null) => (_a: unknown, ctx: Context, nodes: (Node | null)[], scope: Scope): Value => {
  const v = ev(nodes[0], ctx, scope);
  const fallback = () => {
    const f = ev(nodes[1], ctx, scope);
    return isMissing(f) ? 0 : f;
  };
  const caught = (x: Scalar) => isError(x) && (only === null || x.code === only);
  if (isBlock(v)) {
    const m = toMatrix(v, ctx);
    if (!m.data.some(caught)) return m;
    const f = toMatrix(fallback(), ctx);
    return broadcast([m, f], ([x, y]) => (caught(x!) ? y! : x!));
  }
  const s = toScalar(v, ctx);
  return caught(s) ? fallback() : isMissing(s) ? 0 : v;
};
define("IFERROR", "l", 2, 2, onError(null));
define("IFNA", "l", 2, 2, onError("#N/A"));
define("SWITCH", "l", 3, 254, (_a, ctx, nodes, scope) => {
  const target = toScalar(ev(nodes[0], ctx, scope), ctx);
  if (isError(target)) return target;
  const rest = nodes.slice(1);
  for (let i = 0; i + 1 < rest.length; i += 2) {
    const v = toScalar(ev(rest[i], ctx, scope), ctx);
    if (isError(v)) return v;
    const same = typeof v === typeof target && (typeof v === "string" ? v.toLowerCase() === (target as string).toLowerCase() : v === target);
    if (same) return ev(rest[i + 1], ctx, scope);
  }
  return rest.length % 2 ? ev(rest[rest.length - 1], ctx, scope) : ERRORS["#N/A"];
});
define("CHOOSE", "vl", 2, 255, ([index], ctx, nodes, scope) => {
  const n = num(index as Scalar);
  if (isError(n)) return n;
  const i = Math.floor(n);
  if (i < 1 || i >= nodes.length) return ERRORS["#VALUE!"];
  const v = ev(nodes[i], ctx, scope);
  return isMissing(v) ? 0 : v;
});
const logical = (name: string, fn: (vals: boolean[]) => boolean) =>
  define(name, "a", 1, 255, (args, ctx) => {
    const vals: boolean[] = [];
    for (const arg of args) {
      if (isMissing(arg)) continue;
      if (isRange(arg) || isMatrix(arg)) {
        for (const v of flatten([arg], ctx)) {
          if (isError(v)) return v;
          if (typeof v === "boolean") vals.push(v);
          else if (typeof v === "number") vals.push(v !== 0);
        }
      } else {
        const b = bool(arg as Scalar);
        if (isError(b)) return b;
        vals.push(b);
      }
    }
    if (!vals.length) return ERRORS["#VALUE!"];
    return fn(vals);
  });
logical("AND", (v) => v.every(Boolean));
logical("OR", (v) => v.some(Boolean));
logical("XOR", (v) => v.filter(Boolean).length % 2 === 1);
define("NOT", "v", 1, 1, ([a]) => {
  const b = bool(a as Scalar);
  return isError(b) ? b : !b;
});
define("TRUE", "v", 0, 0, () => true);
define("FALSE", "v", 0, 0, () => false);

// LET, LAMBDA and the functions that take a LAMBDA
define("LET", "l", 3, 253, (_a, ctx, nodes, scope) => {
  if (nodes.length % 2 === 0) return ERRORS["#VALUE!"];
  const inner = new Map(scope ?? []);
  for (let i = 0; i + 1 < nodes.length; i += 2) {
    const n = nodes[i];
    if (!n || n.t !== "name") return ERRORS["#NAME?"];
    inner.set(n.name.toUpperCase(), ev(nodes[i + 1], ctx, inner));
  }
  return ev(nodes[nodes.length - 1], ctx, inner);
});
define("LAMBDA", "l", 1, 254, (_a, _ctx, nodes, scope) => {
  const params: string[] = [];
  for (const n of nodes.slice(0, -1)) {
    if (!n || n.t !== "name") return ERRORS["#VALUE!"];
    params.push(n.name.toUpperCase().replace(/^_XLPM\./, ""));
  }
  return { kind: "lambda", params, body: nodes[nodes.length - 1], scope: new Map(scope ?? []) };
});
define("ISOMITTED", "a", 1, 1, ([a]) => isMissing(a));
const lambdaArg = (v: Value | undefined) => (v && isLambda(v) ? v : null);
define("MAP", "a", 2, 254, (args, ctx) => {
  const fn = lambdaArg(args[args.length - 1]);
  if (!fn) return ERRORS["#VALUE!"];
  const blocks = args.slice(0, -1).map((a) => toMatrix(a, ctx));
  return broadcast(blocks, (vals) => toScalar(invoke(fn, [], ctx, null, vals), ctx));
});
define("REDUCE", "a", 3, 3, ([init, arr, f], ctx) => {
  const fn = lambdaArg(f);
  if (!fn) return ERRORS["#VALUE!"];
  let acc: Value = isMissing(init) ? 0 : init!;
  for (const v of toMatrix(arr!, ctx).data) acc = invoke(fn, [], ctx, null, [acc, v]);
  return acc;
});
define("SCAN", "a", 3, 3, ([init, arr, f], ctx) => {
  const fn = lambdaArg(f);
  if (!fn) return ERRORS["#VALUE!"];
  let acc: Value = isMissing(init) ? 0 : init!;
  const m = toMatrix(arr!, ctx);
  return m.map((v) => {
    acc = invoke(fn, [], ctx, null, [acc, v]);
    return toScalar(acc, ctx);
  });
});
define("BYROW", "a", 2, 2, ([arr, f], ctx) => {
  const fn = lambdaArg(f);
  if (!fn) return ERRORS["#VALUE!"];
  const m = toMatrix(arr!, ctx);
  const out: Scalar[] = [];
  for (let r = 0; r < m.rows; r++) out.push(toScalar(invoke(fn, [], ctx, null, [new Matrix(1, m.cols, m.row(r))]), ctx));
  return new Matrix(m.rows, 1, out);
});
define("BYCOL", "a", 2, 2, ([arr, f], ctx) => {
  const fn = lambdaArg(f);
  if (!fn) return ERRORS["#VALUE!"];
  const m = toMatrix(arr!, ctx);
  const out: Scalar[] = [];
  for (let c = 0; c < m.cols; c++) out.push(toScalar(invoke(fn, [], ctx, null, [new Matrix(m.rows, 1, m.col(c))]), ctx));
  return new Matrix(1, m.cols, out);
});
define("MAKEARRAY", "vva", 3, 3, ([r, c, f], ctx) => {
  const fn = lambdaArg(f);
  if (!fn) return ERRORS["#VALUE!"];
  const rows = num(r as Scalar);
  const cols = num(c as Scalar);
  if (isError(rows)) return rows;
  if (isError(cols)) return cols;
  if (rows < 1 || cols < 1) return ERRORS["#VALUE!"];
  const data: Scalar[] = [];
  for (let i = 1; i <= Math.floor(rows); i++) for (let j = 1; j <= Math.floor(cols); j++) data.push(toScalar(invoke(fn, [], ctx, null, [i, j]), ctx));
  return new Matrix(Math.floor(rows), Math.floor(cols), data);
});

// ----------------------------------------------------------------------------- information

const test = (name: string, fn: (v: Scalar) => boolean) => define(name, "v", 1, 1, ([v]) => fn(v as Scalar));
test("ISBLANK", (v) => v === null);
test("ISNUMBER", (v) => typeof v === "number");
test("ISTEXT", (v) => typeof v === "string");
test("ISNONTEXT", (v) => typeof v !== "string");
test("ISLOGICAL", (v) => typeof v === "boolean");
test("ISERROR", (v) => isError(v));
test("ISERR", (v) => isError(v) && v.code !== "#N/A");
test("ISNA", (v) => isError(v) && v.code === "#N/A");
define("ISEVEN", "v", 1, 1, ([v]) => {
  const n = num(v as Scalar);
  return isError(n) ? n : Math.floor(Math.abs(n)) % 2 === 0;
});
define("ISODD", "v", 1, 1, ([v]) => {
  const n = num(v as Scalar);
  return isError(n) ? n : Math.floor(Math.abs(n)) % 2 === 1;
});
define("ISREF", "a", 1, 1, ([v]) => isRange(v));
define("ISFORMULA", "a", 1, 1, ([v], ctx) => (isRange(v) ? ctx.formula(v.sheet, v.r1, v.c1) !== null : ERRORS["#VALUE!"]));
define("FORMULATEXT", "a", 1, 1, ([v], ctx) => {
  if (!isRange(v)) return ERRORS["#VALUE!"];
  const f = ctx.formula(v.sheet, v.r1, v.c1);
  return f === null ? ERRORS["#N/A"] : "=" + f;
});
define("TYPE", "a", 1, 1, ([v], ctx) => {
  if (isLambda(v!)) return 128;
  if (isMatrix(v) || (isRange(v) && isBlock(v))) return 64;
  const s = toScalar(v!, ctx);
  if (typeof s === "number" || s === null) return 1;
  if (typeof s === "string") return 2;
  if (typeof s === "boolean") return 4;
  return 16;
});
define("ERROR.TYPE", "v", 1, 1, ([v]) => (isError(v) ? (ERROR_NUMBERS[(v as CellError).code] ?? ERRORS["#N/A"]) : ERRORS["#N/A"]));
define("NA", "v", 0, 0, () => ERRORS["#N/A"]);
define("N", "a", 1, 1, ([v], ctx) => {
  const s = toScalar(v!, ctx);
  if (typeof s === "number") return s;
  if (typeof s === "boolean") return s ? 1 : 0;
  if (isError(s)) return s;
  return 0;
});
define("T", "a", 1, 1, ([v], ctx) => {
  const s = toScalar(v!, ctx);
  if (typeof s === "string") return s;
  if (isError(s)) return s;
  return "";
});
define("ROW", "a", 0, 1, ([ref], ctx) => {
  if (ref === undefined || isMissing(ref)) return ctx.row + 1;
  if (!isRange(ref)) return ERRORS["#VALUE!"];
  if (ref.r1 === ref.r2) return ref.r1 + 1;
  return new Matrix(ref.r2 - ref.r1 + 1, 1, Array.from({ length: ref.r2 - ref.r1 + 1 }, (_, i) => ref.r1 + i + 1));
});
define("COLUMN", "a", 0, 1, ([ref], ctx) => {
  if (ref === undefined || isMissing(ref)) return ctx.col + 1;
  if (!isRange(ref)) return ERRORS["#VALUE!"];
  if (ref.c1 === ref.c2) return ref.c1 + 1;
  return new Matrix(1, ref.c2 - ref.c1 + 1, Array.from({ length: ref.c2 - ref.c1 + 1 }, (_, i) => ref.c1 + i + 1));
});
define("ROWS", "a", 1, 1, ([v], ctx) => (isRange(v) ? v.r2 - v.r1 + 1 : toMatrix(v!, ctx).rows));
define("COLUMNS", "a", 1, 1, ([v], ctx) => (isRange(v) ? v.c2 - v.c1 + 1 : toMatrix(v!, ctx).cols));
define("SHEET", "a", 0, 1, ([v], ctx) => {
  if (v === undefined || isMissing(v)) return ctx.sheetIndex(ctx.sheet) + 1;
  if (isRange(v)) return ctx.sheetIndex(v.sheet) + 1;
  if (typeof v === "string") {
    const s = ctx.sheetByName(v);
    return s === null ? ERRORS["#N/A"] : ctx.sheetIndex(s) + 1;
  }
  return ERRORS["#VALUE!"];
});
define("SHEETS", "a", 0, 1, ([v], ctx) => (v === undefined || isMissing(v) ? ctx.sheetCount() : 1));
define("CELL", "va", 1, 2, ([info, ref], ctx) => {
  const what = String(info ?? "").toLowerCase();
  const r = ref === undefined || isMissing(ref) ? { kind: "range" as const, sheet: ctx.sheet, r1: ctx.row, c1: ctx.col, r2: ctx.row, c2: ctx.col } : ref;
  if (!isRange(r)) return ERRORS["#VALUE!"];
  const v = ctx.value(r.sheet, r.r1, r.c1);
  switch (what) {
    case "address": return "$" + colName(r.c1) + "$" + (r.r1 + 1);
    case "row": return r.r1 + 1;
    case "col": return r.c1 + 1;
    case "contents": return v;
    case "type": return v === null ? "b" : typeof v === "string" ? "l" : "v";
    case "filename": return ctx.sheetName(r.sheet);
    case "sheetname": return ctx.sheetName(r.sheet);
    default: return ERRORS["#VALUE!"];
  }
}, true);
