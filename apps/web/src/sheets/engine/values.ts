// Cell values, errors and the coercions Excel applies between them.

export type ErrorCode = "#NULL!" | "#DIV/0!" | "#VALUE!" | "#REF!" | "#NAME?" | "#NUM!" | "#N/A" | "#SPILL!" | "#CALC!" | "#GETTING_DATA";

export class CellError {
  constructor(
    readonly code: ErrorCode,
    readonly detail?: string,
  ) {}
  toString(): string {
    return this.code;
  }
}

export const ERRORS: Record<ErrorCode, CellError> = {
  "#NULL!": new CellError("#NULL!"),
  "#DIV/0!": new CellError("#DIV/0!"),
  "#VALUE!": new CellError("#VALUE!"),
  "#REF!": new CellError("#REF!"),
  "#NAME?": new CellError("#NAME?"),
  "#NUM!": new CellError("#NUM!"),
  "#N/A": new CellError("#N/A"),
  "#SPILL!": new CellError("#SPILL!"),
  "#CALC!": new CellError("#CALC!"),
  "#GETTING_DATA": new CellError("#GETTING_DATA"),
};
export const ERROR_CODES = Object.keys(ERRORS) as ErrorCode[];
/** ERROR.TYPE numbers. */
export const ERROR_NUMBERS: Partial<Record<ErrorCode, number>> = {
  "#NULL!": 1, "#DIV/0!": 2, "#VALUE!": 3, "#REF!": 4, "#NAME?": 5, "#NUM!": 6, "#N/A": 7, "#GETTING_DATA": 8, "#SPILL!": 9, "#CALC!": 14,
};

/** A value a cell can hold. null is an empty cell. */
export type Scalar = number | string | boolean | CellError | null;

/** A 2-D block of values: a range read into memory, an array constant or an array result. */
export class Matrix {
  constructor(
    readonly rows: number,
    readonly cols: number,
    readonly data: Scalar[],
  ) {}
  static of(rows: Scalar[][]): Matrix {
    const cols = Math.max(1, ...rows.map((r) => r.length));
    const data: Scalar[] = [];
    for (const row of rows) for (let c = 0; c < cols; c++) data.push(c < row.length ? row[c]! : ERRORS["#N/A"]);
    return new Matrix(rows.length, cols, data);
  }
  static filled(rows: number, cols: number, value: Scalar): Matrix {
    return new Matrix(rows, cols, new Array<Scalar>(rows * cols).fill(value));
  }
  get(r: number, c: number): Scalar {
    return this.data[r * this.cols + c] ?? null;
  }
  row(r: number): Scalar[] {
    return this.data.slice(r * this.cols, (r + 1) * this.cols);
  }
  col(c: number): Scalar[] {
    const out: Scalar[] = [];
    for (let r = 0; r < this.rows; r++) out.push(this.get(r, c));
    return out;
  }
  toRows(): Scalar[][] {
    const out: Scalar[][] = [];
    for (let r = 0; r < this.rows; r++) out.push(this.row(r));
    return out;
  }
  map(fn: (value: Scalar, r: number, c: number) => Scalar): Matrix {
    const data = new Array<Scalar>(this.data.length);
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) data[r * this.cols + c] = fn(this.data[r * this.cols + c] ?? null, r, c);
    return new Matrix(this.rows, this.cols, data);
  }
  transpose(): Matrix {
    const data = new Array<Scalar>(this.data.length);
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) data[c * this.rows + r] = this.data[r * this.cols + c] ?? null;
    return new Matrix(this.cols, this.rows, data);
  }
}

/** What evaluating an expression gives: a value, a block, or a reference still to be read. */
export type Value = Scalar | Matrix | RangeValue | LambdaValue;

/** A reference: the evaluator reads it only when a function needs values. */
export interface RangeValue {
  kind: "range";
  sheet: number; // sheet index
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  /** For union references (A1:B2,D4): more areas. */
  more?: RangeValue[];
}

export interface LambdaValue {
  kind: "lambda";
  params: string[];
  body: unknown; // a parser Node
  scope: Map<string, Value>;
}

export const isError = (v: unknown): v is CellError => v instanceof CellError;
export const isMatrix = (v: unknown): v is Matrix => v instanceof Matrix;
export const isRange = (v: unknown): v is RangeValue => typeof v === "object" && v !== null && (v as RangeValue).kind === "range";
export const isLambda = (v: unknown): v is LambdaValue => typeof v === "object" && v !== null && (v as LambdaValue).kind === "lambda";

/** Text Excel reads as a number in arithmetic: "12", "1,200", "12%", "$5", "1e3", " 3 ", dates and times. */
export function parseNumber(text: string, dateParser?: (t: string) => number | null): number | null {
  let t = text.trim();
  if (!t) return null;
  let negative = false;
  if (t.startsWith("(") && t.endsWith(")")) {
    negative = true;
    t = t.slice(1, -1).trim();
  }
  let percent = false;
  if (t.endsWith("%")) {
    percent = true;
    t = t.slice(0, -1).trim();
  }
  let sign = 1;
  if (t.startsWith("-")) {
    sign = -1;
    t = t.slice(1).trim();
  } else if (t.startsWith("+")) t = t.slice(1).trim();
  t = t.replace(/^[$€£¥₹]\s*/, "");
  if (t.startsWith("-")) {
    sign = -sign;
    t = t.slice(1).trim();
  }
  if (/^(\d{1,3}(,\d{3})+|\d+)?(\.\d*)?([eE][+-]?\d+)?$/.test(t) && /\d/.test(t)) {
    let n = Number(t.replace(/,/g, ""));
    if (!Number.isFinite(n)) return null;
    if (percent) n /= 100;
    return (negative ? -1 : 1) * sign * n;
  }
  if (!percent && !negative && sign === 1 && dateParser) return dateParser(text.trim());
  return null;
}

export function typeRank(v: Scalar): number {
  // Excel sorts and compares: numbers < text < logical < errors; empty first
  if (v === null) return 0;
  if (typeof v === "number") return 1;
  if (typeof v === "string") return 2;
  if (typeof v === "boolean") return 3;
  return 4;
}

/** Excel's comparison: case-insensitive text, numbers before text before TRUE/FALSE. */
export function compareValues(a: Scalar, b: Scalar): number {
  if (a === null && typeof b === "number") a = 0;
  if (b === null && typeof a === "number") b = 0;
  if (a === null && typeof b === "string") a = "";
  if (b === null && typeof a === "string") b = "";
  if (a === null && typeof b === "boolean") a = false;
  if (b === null && typeof a === "boolean") b = false;
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "string" && typeof b === "string") {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x === y ? 0 : x < y ? -1 : 1;
  }
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  return 0;
}

/** Numbers with the float noise Excel hides (0.1+0.2 shows and compares as 0.3). */
export function tidy(n: number): number {
  if (!Number.isFinite(n) || Number.isInteger(n)) return n;
  return Number(n.toPrecision(15));
}
