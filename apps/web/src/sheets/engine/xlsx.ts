// Excel files: .xlsx (Office Open XML, ECMA-376) read and written from scratch, and CSV.
import { type Area, cellName, colIndex, key, keyCol, keyRow, parseArea } from "./address";
import { parseDate } from "./dates";
import { XLSX_BUILTIN, isDateFormat } from "./format";
import { plainName, shiftFormula, tokenize } from "./parser";
import { CellError, parseNumber } from "./values";
import { escapeXml, kid, kids, parseXml, textOf, unzip, zip, type XmlNode } from "./zip";
import type { BorderEdge, CellJSON, Conditional, SheetJSON, Style, TableDef, Validation, Workbook, WorkbookJSON } from "./workbook";
import { uid } from "./features";

const PX_PER_CHAR = 7;
const colPx = (chars: number) => Math.round(chars * PX_PER_CHAR + 5);
const colChars = (px: number) => Math.max(0, (px - 5) / PX_PER_CHAR);

// Excel's 56 legacy indexed colours
const INDEXED = [
  "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF", "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
  "800000", "008000", "000080", "808000", "800080", "008080", "C0C0C0", "808080", "9999FF", "993366", "FFFFCC", "CCFFFF", "660066", "FF8080", "0066CC", "CCCCFF",
  "000080", "FF00FF", "FFFF00", "00FFFF", "800080", "800000", "008080", "0000FF", "00CCFF", "CCFFFF", "CCFFCC", "FFFF99", "99CCFF", "FF99CC", "CC99FF", "FFCC99",
  "3366FF", "33CCCC", "99CC00", "FFCC00", "FF9900", "FF6600", "666699", "969696", "003366", "339966", "003300", "333300", "993300", "993366", "333399", "333333",
];
const THEME_DEFAULT = ["FFFFFF", "000000", "E7E6E6", "44546A", "4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47", "0563C1", "954F72"];

/** Functions Excel stores with a prefix (added in Excel 2010 and later). */
const PREFIXED = new Set(("AGGREGATE BETA.DIST BETA.INV BINOM.DIST BINOM.INV CEILING.MATH CEILING.PRECISE CHISQ.DIST CHISQ.DIST.RT CHISQ.INV CHISQ.INV.RT CHISQ.TEST CONFIDENCE.NORM CONFIDENCE.T " +
  "COVARIANCE.P COVARIANCE.S ERF.PRECISE ERFC.PRECISE EXPON.DIST F.DIST F.DIST.RT F.INV F.INV.RT FLOOR.MATH FLOOR.PRECISE GAMMA.DIST GAMMA.INV GAMMALN.PRECISE HYPGEOM.DIST LOGNORM.DIST LOGNORM.INV " +
  "MODE.MULT MODE.SNGL NEGBINOM.DIST NETWORKDAYS.INTL NORM.DIST NORM.INV NORM.S.DIST NORM.S.INV PERCENTILE.EXC PERCENTILE.INC PERCENTRANK.EXC PERCENTRANK.INC POISSON.DIST QUARTILE.EXC QUARTILE.INC " +
  "RANK.AVG RANK.EQ STDEV.P STDEV.S T.DIST T.DIST.2T T.DIST.RT T.INV T.INV.2T T.TEST VAR.P VAR.S WEIBULL.DIST WORKDAY.INTL Z.TEST ACOT ACOTH ARABIC BASE COMBINA COT COTH CSC CSCH DAYS DECIMAL " +
  "FORMULATEXT GAMMA GAUSS IFNA ISFORMULA ISOWEEKNUM MUNIT NUMBERVALUE PDURATION PERMUTATIONA PHI RRI SEC SECH SHEET SHEETS SKEW.P UNICHAR UNICODE XOR ENCODEURL CONCAT IFS MAXIFS MINIFS SWITCH TEXTJOIN " +
  "FORECAST.LINEAR XLOOKUP XMATCH SORTBY UNIQUE SEQUENCE RANDARRAY LET LAMBDA MAP REDUCE SCAN BYROW BYCOL MAKEARRAY ISOMITTED TEXTBEFORE TEXTAFTER TEXTSPLIT VSTACK HSTACK TOCOL TOROW WRAPROWS " +
  "WRAPCOLS TAKE DROP CHOOSEROWS CHOOSECOLS EXPAND VALUETOTEXT ARRAYTOTEXT GROUPBY REGEXTEST REGEXEXTRACT REGEXREPLACE").split(" "));
const WORKSHEET_PREFIXED = new Set(["FILTER", "SORT"]);

function forFile(f: string): string {
  return tokenize(f)
    .map((t) => {
      if (t.type !== "func") return t.text;
      const name = plainName(t.text);
      if (WORKSHEET_PREFIXED.has(name)) return "_xlfn._xlws." + name;
      if (PREFIXED.has(name)) return "_xlfn." + name;
      return t.text;
    })
    .join("");
}

const decoder = new TextDecoder();
const read = (files: Map<string, Uint8Array>, path: string) => {
  const f = files.get(path.replace(/^\//, ""));
  return f ? decoder.decode(f) : null;
};
function resolve(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const p of target.split("/")) {
    if (p === "..") parts.pop();
    else if (p !== ".") parts.push(p);
  }
  return parts.join("/");
}
function rels(files: Map<string, Uint8Array>, path: string): Map<string, { target: string; type: string }> {
  const dir = path.split("/").slice(0, -1).join("/");
  const name = path.split("/").pop()!;
  const xml = read(files, `${dir}/_rels/${name}.rels`);
  const out = new Map<string, { target: string; type: string }>();
  if (!xml) return out;
  for (const r of kids(parseXml(xml), "Relationship")) out.set(r.attrs.Id ?? r.attrs.id ?? "", { target: resolve(path, r.attrs.Target ?? ""), type: r.attrs.Type ?? "" });
  return out;
}

// ----------------------------------------------------------------------------------- reading

function tinted(hex: string, tint: number): string {
  if (!tint) return hex;
  const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  // to HSL, change lightness, back
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === rgb[0] ? (rgb[1]! - rgb[2]!) / d + (rgb[1]! < rgb[2]! ? 6 : 0) : max === rgb[1] ? (rgb[2]! - rgb[0]!) / d + 2 : (rgb[0]! - rgb[1]!) / d + 4;
    h /= 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255).toString(16).padStart(2, "0");
  };
  return `${f(0)}${f(8)}${f(4)}`.toUpperCase();
}

function colorOf(node: XmlNode | undefined, theme: string[], skipAuto = false): string | undefined {
  if (!node) return undefined;
  const a = node.attrs;
  let hex: string | undefined;
  if (a.rgb) hex = a.rgb.length === 8 ? a.rgb.slice(2) : a.rgb;
  else if (a.theme !== undefined) {
    const i = Number(a.theme);
    if (skipAuto && i === 1 && !a.tint) return undefined;
    hex = theme[i];
  } else if (a.indexed !== undefined) {
    const i = Number(a.indexed);
    if (i === 64 || i === 65) return undefined; // system colours: automatic
    hex = INDEXED[i];
  } else return undefined;
  if (!hex) return undefined;
  return "#" + tinted(hex, Number(a.tint ?? 0)).toLowerCase();
}

const BORDER_STYLES: Record<string, BorderEdge["style"]> = { thin: "thin", hair: "thin", medium: "medium", thick: "thick", dashed: "dashed", mediumDashed: "dashed", dotted: "dotted", double: "double", dashDot: "dashed", mediumDashDot: "dashed", dashDotDot: "dotted", slantDashDot: "dashed" };

function readStyles(xml: string | null, theme: string[]): { styles: Style[]; dxfs: Partial<Style>[] } {
  if (!xml) return { styles: [{}], dxfs: [] };
  const root = parseXml(xml);
  const formats = new Map<number, string>(Object.entries(XLSX_BUILTIN).map(([k, v]) => [Number(k), v]));
  for (const f of kids(kid(root, "numFmts"), "numFmt")) formats.set(Number(f.attrs.numFmtId), f.attrs.formatCode ?? "General");
  const fontOf = (f: XmlNode | undefined): Partial<Style> => {
    if (!f) return {};
    const st: Partial<Style> = {};
    if (kid(f, "b") && kid(f, "b")!.attrs.val !== "0") st.bold = true;
    if (kid(f, "i") && kid(f, "i")!.attrs.val !== "0") st.italic = true;
    if (kid(f, "u") && kid(f, "u")!.attrs.val !== "none") st.underline = true;
    if (kid(f, "strike") && kid(f, "strike")!.attrs.val !== "0") st.strike = true;
    const sz = Number(kid(f, "sz")?.attrs.val ?? 11);
    if (sz && sz !== 11) st.size = sz;
    const color = colorOf(kid(f, "color"), theme, true);
    if (color && color !== "#000000") st.color = color;
    const name = kid(f, "name")?.attrs.val;
    if (name && !/^(Calibri|Aptos|Aptos Narrow|Arial)$/i.test(name)) st.font = name;
    return st;
  };
  const fillOf = (f: XmlNode | undefined): Partial<Style> => {
    const p = kid(f, "patternFill");
    if (!p || !p.attrs.patternType || p.attrs.patternType === "none") {
      // dxf fills often leave out patternType
      const bg = colorOf(kid(p, "bgColor"), theme) ?? colorOf(kid(p, "fgColor"), theme);
      return bg && p ? { fill: bg } : {};
    }
    const c = colorOf(kid(p, "fgColor"), theme) ?? colorOf(kid(p, "bgColor"), theme);
    return c ? { fill: c } : {};
  };
  const borderOf = (b: XmlNode | undefined): Partial<Style> => {
    const st: Partial<Style> = {};
    for (const side of ["left", "right", "top", "bottom"] as const) {
      const e = kid(b, side);
      const s = e?.attrs.style;
      if (!s || s === "none") continue;
      st[side] = { style: BORDER_STYLES[s] ?? "thin", color: colorOf(kid(e, "color"), theme, true) };
    }
    return st;
  };
  const fonts = kids(kid(root, "fonts"), "font").map(fontOf);
  const fills = kids(kid(root, "fills"), "fill").map(fillOf);
  const borders = kids(kid(root, "borders"), "border").map(borderOf);
  const styles = kids(kid(root, "cellXfs"), "xf").map((xf) => {
    const a = xf.attrs;
    const st: Style = { ...(fonts[Number(a.fontId ?? 0)] ?? {}), ...(fills[Number(a.fillId ?? 0)] ?? {}), ...(borders[Number(a.borderId ?? 0)] ?? {}) };
    const fmt = formats.get(Number(a.numFmtId ?? 0)) ?? "General";
    if (fmt !== "General") st.format = fmt;
    const al = kid(xf, "alignment");
    if (al) {
      const h = al.attrs.horizontal;
      if (h === "left" || h === "center" || h === "right" || h === "justify") st.h = h;
      if (h === "centerContinuous") st.h = "center";
      const v = al.attrs.vertical;
      if (v === "top" || v === "center") st.v = v === "center" ? "middle" : "top";
      if (al.attrs.wrapText === "1" || al.attrs.wrapText === "true") st.wrap = true;
      if (al.attrs.indent) st.indent = Number(al.attrs.indent);
    }
    if (a.quotePrefix === "1") st.quote = true;
    return st;
  });
  const dxfs = kids(kid(root, "dxfs"), "dxf").map((d) => {
    const st: Partial<Style> = { ...fontOf(kid(d, "font")), ...fillOf(kid(d, "fill")), ...borderOf(kid(d, "border")) };
    const nf = kid(d, "numFmt");
    if (nf?.attrs.formatCode) st.format = nf.attrs.formatCode;
    // dxf font colours are explicit even when black
    const fc = colorOf(kid(kid(d, "font"), "color"), theme);
    if (fc) st.color = fc;
    delete st.size;
    return st;
  });
  return { styles: styles.length ? styles : [{}], dxfs };
}

function readTheme(xml: string | null): string[] {
  if (!xml) return THEME_DEFAULT;
  const root = parseXml(xml);
  const scheme = kid(kid(root, "themeElements"), "clrScheme");
  if (!scheme) return THEME_DEFAULT;
  const get = (name: string, fallback: string) => {
    const n = kid(scheme, name);
    const c = n?.children[0];
    return c?.attrs.lastClr ?? c?.attrs.val ?? fallback;
  };
  // the order Excel numbers theme colours: lt1, dk1, lt2, dk2, accent1-6, hlink, folHlink
  return [get("lt1", "FFFFFF"), get("dk1", "000000"), get("lt2", "E7E6E6"), get("dk2", "44546A"), ...[1, 2, 3, 4, 5, 6].map((i) => get(`accent${i}`, THEME_DEFAULT[3 + i]!)), get("hlink", "0563C1"), get("folHlink", "954F72")];
}

function sqref(text: string | undefined): Area[] {
  return (text ?? "").split(/\s+/).map((a) => parseArea(a)).filter((a): a is Area => a !== null);
}

const CF_OPS: Record<string, string> = { greaterThan: ">", lessThan: "<", greaterThanOrEqual: ">=", lessThanOrEqual: "<=", equal: "=", notEqual: "<>", between: "between", notBetween: "notBetween" };
const DV_OPS: Record<string, Validation["op"]> = { between: "between", notBetween: "notBetween", equal: "=", notEqual: "<>", greaterThan: ">", lessThan: "<", greaterThanOrEqual: ">=", lessThanOrEqual: "<=" };

export async function readXlsx(bytes: Uint8Array): Promise<WorkbookJSON> {
  const files = await unzip(bytes);
  const workbookPath = (() => {
    const root = read(files, "_rels/.rels");
    if (root) for (const r of kids(parseXml(root), "Relationship")) if (/officeDocument$/.test(r.attrs.Type ?? "")) return r.attrs.Target!.replace(/^\//, "");
    return "xl/workbook.xml";
  })();
  const wbXml = read(files, workbookPath);
  if (!wbXml) throw new Error("This file has no workbook in it. Is it an .xlsx from Excel (not .xls or .xlsb)?");
  const wbRoot = parseXml(wbXml);
  const wbRels = rels(files, workbookPath);
  let themeXml: string | null = null;
  let stylesXml: string | null = null;
  let stringsXml: string | null = null;
  for (const r of wbRels.values()) {
    if (r.type.endsWith("/theme")) themeXml = read(files, r.target);
    if (r.type.endsWith("/styles")) stylesXml = read(files, r.target);
    if (r.type.endsWith("/sharedStrings")) stringsXml = read(files, r.target);
  }
  const theme = readTheme(themeXml);
  const { styles, dxfs } = readStyles(stylesXml, theme);
  const strings = stringsXml ? kids(parseXml(stringsXml), "si").map(textOf) : [];
  const dateStyle = styles.map((s) => Boolean(s.format && isDateFormat(s.format)));
  const sheets: SheetJSON[] = [];
  const sheetNodes = kids(kid(wbRoot, "sheets"), "sheet");
  const tables: TableDef[][] = [];
  for (const [index, node] of sheetNodes.entries()) {
    const rel = wbRels.get(node.attrs.id ?? "");
    const name = node.attrs.name ?? `Sheet${index + 1}`;
    const json: SheetJSON = { name, cells: [], hidden: node.attrs.state === "hidden" || node.attrs.state === "veryHidden" ? true : undefined };
    sheets.push(json);
    tables.push([]);
    if (!rel) continue;
    const xml = read(files, rel.target);
    if (!xml) continue;
    if (!rel.type.endsWith("/worksheet")) continue;
    const root = parseXml(xml);
    const sheetRels = rels(files, rel.target);
    // columns, rows, views
    const formatPr = kid(root, "sheetFormatPr");
    const defaultWidth = formatPr?.attrs.defaultColWidth ? colPx(Number(formatPr.attrs.defaultColWidth)) : null;
    const widths: [number, number][] = [];
    const hiddenCols: number[] = [];
    for (const col of kids(kid(root, "cols"), "col")) {
      const min = Number(col.attrs.min) - 1;
      const max = Math.min(Number(col.attrs.max) - 1, min + 2000);
      for (let c = min; c <= max; c++) {
        if (col.attrs.width && (col.attrs.customWidth === "1" || col.attrs.customWidth === "true" || true)) widths.push([c, colPx(Number(col.attrs.width))]);
        if (col.attrs.hidden === "1" || col.attrs.hidden === "true") hiddenCols.push(c);
      }
    }
    if (defaultWidth && defaultWidth !== 96) void defaultWidth;
    json.colWidths = widths;
    json.hiddenCols = hiddenCols;
    const view = kid(kid(root, "sheetViews"), "sheetView");
    if (view?.attrs.showGridLines === "0") json.showGrid = false;
    const pane = kid(view, "pane");
    if (pane && (pane.attrs.state === "frozen" || pane.attrs.state === "frozenSplit")) {
      json.freezeRows = Number(pane.attrs.ySplit ?? 0);
      json.freezeCols = Number(pane.attrs.xSplit ?? 0);
    }
    const heights: [number, number][] = [];
    const hiddenRows: number[] = [];
    const shared = new Map<string, { f: string; row: number; col: number }>();
    const arrays: Area[] = [];
    const cells: [number, number, CellJSON][] = [];
    for (const row of kids(kid(root, "sheetData"), "row")) {
      const r = Number(row.attrs.r) - 1;
      if (row.attrs.ht && (row.attrs.customHeight === "1" || row.attrs.customHeight === "true")) heights.push([r, Math.round((Number(row.attrs.ht) * 4) / 3)]);
      if (row.attrs.hidden === "1" || row.attrs.hidden === "true") hiddenRows.push(r);
      let nextCol = 0;
      for (const c of kids(row, "c")) {
        const ref = c.attrs.r;
        let col = nextCol;
        let rr = r;
        if (ref) {
          const m = /^([A-Z]+)(\d+)$/.exec(ref);
          if (m) {
            col = colIndex(m[1]!);
            rr = Number(m[2]) - 1;
          }
        }
        nextCol = col + 1;
        const cell: CellJSON = {};
        const s = Number(c.attrs.s ?? 0);
        if (s) cell.s = s;
        const t = c.attrs.t ?? "n";
        const v = kid(c, "v")?.text;
        const fNode = kid(c, "f");
        if (fNode) {
          let f = fNode.text;
          if (fNode.attrs.t === "array" && fNode.attrs.ref) {
            const area = parseArea(fNode.attrs.ref);
            if (area && (area.r1 !== area.r2 || area.c1 !== area.c2)) arrays.push(area);
          }
          if (fNode.attrs.t === "shared") {
            const si = fNode.attrs.si ?? "";
            if (f) shared.set(si, { f, row: rr, col });
            else {
              const master = shared.get(si);
              if (master) f = shiftFormula(master.f, rr - master.row, col - master.col);
            }
          }
          if (f) cell.f = f.replace(/_xlfn\._xlws\.|_xlfn\.|_xlws\.|_xlpm\./g, "");
        }
        if (cell.f === undefined) {
          if (t === "s") cell.v = strings[Number(v)] ?? "";
          else if (t === "inlineStr") cell.v = textOf(kid(c, "is"));
          else if (t === "str") cell.v = v ?? "";
          else if (t === "b") cell.v = v === "1";
          else if (t === "e") cell.v = { e: v ?? "#N/A" };
          else if (t === "d") {
            const d = parseDate(String(v).replace("T", " ").replace(/Z$/, ""));
            cell.v = d ?? v ?? null;
          } else if (v !== undefined && v !== "") cell.v = Number(v);
          if (cell.v === undefined && !cell.s) continue;
        }
        cells.push([rr, col, cell]);
      }
    }
    void dateStyle;
    // cells an array formula spills into are its results, not values of their own
    json.cells = arrays.length
      ? cells.filter(([r, c, cell]) => cell.f !== undefined || !arrays.some((a) => r >= a.r1 && r <= a.r2 && c >= a.c1 && c <= a.c2 && !(r === a.r1 && c === a.c1)))
      : cells;
    json.rowHeights = heights;
    json.hiddenRows = hiddenRows;
    json.merges = kids(kid(root, "mergeCells"), "mergeCell").flatMap((m) => sqref(m.attrs.ref));
    const filter = kid(root, "autoFilter");
    if (filter?.attrs.ref) {
      const area = parseArea(filter.attrs.ref);
      if (area) json.filter = { area, columns: {} };
    }
    // data validation
    const validations: Validation[] = [];
    for (const dv of kids(kid(root, "dataValidations"), "dataValidation")) {
      const kind = dv.attrs.type ?? "none";
      const f1 = kid(dv, "formula1")?.text ?? "";
      const f2 = kid(dv, "formula2")?.text;
      const map: Record<string, Validation["kind"]> = { list: "list", whole: "whole", decimal: "decimal", date: "date", time: "time", textLength: "length", custom: "custom" };
      if (!map[kind]) continue;
      const v: Validation = {
        area: sqref(dv.attrs.sqref)[0]!, kind: map[kind]!, allowBlank: dv.attrs.allowBlank === "1",
        // showDropDown="1" means the arrow is hidden (Excel's naming)
        dropdown: dv.attrs.showDropDown !== "1",
        op: DV_OPS[dv.attrs.operator ?? "between"] ?? "between",
        prompt: dv.attrs.prompt,
        error: dv.attrs.error || dv.attrs.errorStyle ? { style: (dv.attrs.errorStyle as "stop" | "warning" | "information") === "information" ? "info" : ((dv.attrs.errorStyle as "stop" | "warning") ?? "stop"), title: dv.attrs.errorTitle, message: dv.attrs.error } : undefined,
      };
      if (!v.area) continue;
      if (kind === "list") v.source = f1.startsWith('"') ? f1.slice(1, -1) : "=" + f1;
      else if (kind === "custom") v.source = "=" + f1;
      else {
        v.a = /^-?[\d.]+$/.test(f1) ? f1 : "=" + f1;
        if (f2 !== undefined) v.b = /^-?[\d.]+$/.test(f2) ? f2 : "=" + f2;
        if (kind === "date" || kind === "time") {
          v.a = v.a?.startsWith("=") ? v.a : v.a;
        }
      }
      for (const extra of sqref(dv.attrs.sqref).slice(1)) validations.push({ ...v, area: extra });
      validations.push(v);
    }
    json.validations = validations;
    // conditional formatting
    const conditionals: Conditional[] = [];
    for (const cf of kids(root, "conditionalFormatting")) {
      const areas = sqref(cf.attrs.sqref);
      const rules = kids(cf, "cfRule").sort((a, b) => Number(a.attrs.priority ?? 0) - Number(b.attrs.priority ?? 0));
      for (const rule of rules) {
        const style = rule.attrs.dxfId !== undefined ? dxfs[Number(rule.attrs.dxfId)] : undefined;
        const formulas = kids(rule, "formula").map((f) => f.text);
        const base = { style, stop: rule.attrs.stopIfTrue === "1" };
        let made: Omit<Conditional, "id" | "area"> | null = null;
        switch (rule.attrs.type) {
          case "cellIs": made = { ...base, kind: "cell", op: CF_OPS[rule.attrs.operator ?? "equal"] ?? "=", a: formulas[0] !== undefined ? (/^-?[\d.]+$/.test(formulas[0]) ? formulas[0] : "=" + formulas[0]) : undefined, b: formulas[1] !== undefined ? (/^-?[\d.]+$/.test(formulas[1]) ? formulas[1] : "=" + formulas[1]) : undefined }; break;
          case "expression": made = { ...base, kind: "formula", formula: "=" + (formulas[0] ?? "FALSE") }; break;
          case "containsText": made = { ...base, kind: "text", op: "contains", a: rule.attrs.text }; break;
          case "notContainsText": made = { ...base, kind: "text", op: "notContains", a: rule.attrs.text }; break;
          case "beginsWith": made = { ...base, kind: "text", op: "begins", a: rule.attrs.text }; break;
          case "endsWith": made = { ...base, kind: "text", op: "ends", a: rule.attrs.text }; break;
          case "top10": made = { ...base, kind: "top", n: Number(rule.attrs.rank ?? 10), percent: rule.attrs.percent === "1", bottom: rule.attrs.bottom === "1" }; break;
          case "aboveAverage": made = { ...base, kind: "average", above: rule.attrs.aboveAverage !== "0" }; break;
          case "duplicateValues": made = { ...base, kind: "duplicate" }; break;
          case "uniqueValues": made = { ...base, kind: "unique" }; break;
          case "containsBlanks": made = { ...base, kind: "blank" }; break;
          case "notContainsBlanks": made = { ...base, kind: "noblank" }; break;
          case "containsErrors": made = { ...base, kind: "error" }; break;
          case "timePeriod": made = { ...base, kind: "date", op: rule.attrs.timePeriod === "last7Days" ? "last7" : (rule.attrs.timePeriod ?? "today") }; break;
          case "colorScale": made = { kind: "scale", colors: kids(kid(rule, "colorScale"), "color").map((c) => colorOf(c, theme) ?? "#ffffff") }; break;
          case "dataBar": made = { kind: "bar", colors: [colorOf(kid(kid(rule, "dataBar"), "color"), theme) ?? "#638ec6"] }; break;
          case "iconSet": {
            const set = kid(rule, "iconSet")?.attrs.iconSet ?? "3TrafficLights1";
            made = { kind: "icons", icons: /Arrow/.test(set) ? "arrows" : /Flag/.test(set) ? "flags" : /Star/.test(set) ? "stars" : "traffic" };
            break;
          }
        }
        if (made) for (const area of areas) conditionals.push({ ...made, id: uid(), area } as Conditional);
      }
    }
    json.conditionals = conditionals;
    // tables and notes
    for (const part of kids(kid(root, "tableParts"), "tablePart")) {
      const t = sheetRels.get(part.attrs.id ?? "");
      const txml = t && read(files, t.target);
      if (!txml) continue;
      const tn = parseXml(txml);
      const area = parseArea(tn.attrs.ref ?? "");
      if (!area) continue;
      const styleName = kid(tn, "tableStyleInfo")?.attrs.name ?? "TableStyleMedium2";
      const n = Number(/(\d+)$/.exec(styleName)?.[1] ?? 2);
      const palette = ["blue", "orange", "grey", "plain", "blue", "green", "purple"];
      tables[index]!.push({ name: tn.attrs.displayName ?? tn.attrs.name ?? `Table${index + 1}`, area, style: palette[(n - 1) % palette.length] ?? "blue", banded: kid(tn, "tableStyleInfo")?.attrs.showRowStripes !== "0", totals: Number(tn.attrs.totalsRowCount ?? 0) > 0, header: tn.attrs.headerRowCount !== "0" });
      if (!json.filter && kid(tn, "autoFilter")) json.filter = { area, columns: {} };
    }
    for (const r of sheetRels.values()) {
      if (!r.type.endsWith("/comments")) continue;
      const cxml = read(files, r.target);
      if (!cxml) continue;
      for (const c of kids(kid(parseXml(cxml), "commentList"), "comment")) {
        const at = parseArea(c.attrs.ref ?? "");
        if (!at) continue;
        const note = textOf(kid(c, "text")).trim();
        const existing = cells.find(([rr, cc]) => rr === at.r1 && cc === at.c1);
        if (existing) existing[2].n = note;
        else cells.push([at.r1, at.c1, { n: note }]);
      }
    }
    json.tables = tables[index];
  }
  const names = kids(kid(wbRoot, "definedNames"), "definedName")
    .filter((n) => !(n.attrs.name ?? "").startsWith("_xlnm.") && n.attrs.hidden !== "1")
    .map((n) => ({ name: n.attrs.name!, formula: n.text.replace(/_xlfn\.|_xlpm\./g, ""), sheet: n.attrs.localSheetId !== undefined ? (sheets[Number(n.attrs.localSheetId)]?.name ?? null) : null }));
  return { format: "flowlabs-workbook", version: 1, sheets, styles, names };
}

// ----------------------------------------------------------------------------------- writing

const hex = (c: string | undefined) => (c ? "FF" + c.replace("#", "").toUpperCase().padEnd(6, "0").slice(0, 6) : undefined);

export async function writeXlsx(wb: Workbook): Promise<Uint8Array> {
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const sst = (s: string) => {
    let i = stringIndex.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      stringIndex.set(s, i);
    }
    return i;
  };
  // styles: one xf per style in use
  const fonts: string[] = ['<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>'];
  const fills: string[] = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders: string[] = ["<border><left/><right/><top/><bottom/><diagonal/></border>"];
  const numFmts: string[] = [];
  const formatIds = new Map<string, number>(Object.entries(XLSX_BUILTIN).map(([k, v]) => [v, Number(k)]));
  const xfs: string[] = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const xfFor = new Map<number, number>([[0, 0]]);
  const intern = (list: string[], xml: string) => {
    const i = list.indexOf(xml);
    if (i >= 0) return i;
    list.push(xml);
    return list.length - 1;
  };
  const edge = (side: string, e?: BorderEdge) =>
    e ? `<${side} style="${e.style === "double" ? "double" : e.style}">${e.color ? `<color rgb="${hex(e.color)}"/>` : '<color auto="1"/>'}</${side}>` : `<${side}/>`;
  const fontXml = (st: Partial<Style>) =>
    `<font>${st.bold ? "<b/>" : ""}${st.italic ? "<i/>" : ""}${st.strike ? "<strike/>" : ""}${st.underline ? "<u/>" : ""}<sz val="${st.size ?? 11}"/>${st.color ? `<color rgb="${hex(st.color)}"/>` : '<color theme="1"/>'}<name val="${escapeXml(st.font ?? "Calibri")}"/><family val="2"/></font>`;
  const styleXf = (id: number): number => {
    let found = xfFor.get(id);
    if (found !== undefined) return found;
    const st = wb.style(id);
    const fontId = intern(fonts, fontXml(st));
    const fillId = st.fill ? intern(fills, `<fill><patternFill patternType="solid"><fgColor rgb="${hex(st.fill)}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const borderId = st.top || st.bottom || st.left || st.right ? intern(borders, `<border>${edge("left", st.left)}${edge("right", st.right)}${edge("top", st.top)}${edge("bottom", st.bottom)}<diagonal/></border>`) : 0;
    let numFmtId = 0;
    if (st.format && st.format !== "General") {
      numFmtId = formatIds.get(st.format) ?? -1;
      if (numFmtId < 0) {
        numFmtId = 164 + numFmts.length;
        numFmts.push(`<numFmt numFmtId="${numFmtId}" formatCode="${escapeXml(st.format)}"/>`);
        formatIds.set(st.format, numFmtId);
      }
    }
    const align = st.h || st.v || st.wrap || st.indent ? `<alignment${st.h ? ` horizontal="${st.h}"` : ""}${st.v ? ` vertical="${st.v === "middle" ? "center" : st.v}"` : ""}${st.wrap ? ' wrapText="1"' : ""}${st.indent ? ` indent="${st.indent}"` : ""}/>` : "";
    xfs.push(`<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"${numFmtId ? ' applyNumberFormat="1"' : ""}${fontId ? ' applyFont="1"' : ""}${fillId ? ' applyFill="1"' : ""}${borderId ? ' applyBorder="1"' : ""}${align ? ' applyAlignment="1"' : ""}${st.quote ? ' quotePrefix="1"' : ""}>${align}</xf>`);
    found = xfs.length - 1;
    xfFor.set(id, found);
    return found;
  };
  const dxfs: string[] = [];
  const dxf = (st: Partial<Style> | undefined) => {
    if (!st) return undefined;
    const font = st.bold || st.italic || st.color || st.underline || st.strike ? `<font>${st.bold ? "<b/>" : ""}${st.italic ? "<i/>" : ""}${st.strike ? "<strike/>" : ""}${st.underline ? "<u/>" : ""}${st.color ? `<color rgb="${hex(st.color)}"/>` : ""}</font>` : "";
    const fill = st.fill ? `<fill><patternFill><bgColor rgb="${hex(st.fill)}"/></patternFill></fill>` : "";
    return intern(dxfs, `<dxf>${font}${fill}</dxf>`);
  };

  const sheetFiles: [string, string][] = [];
  const tableFiles: [string, string][] = [];
  const sheetRels: [string, string][] = [];
  let tableCount = 0;
  wb.sheets.forEach((sheet, index) => {
    const rows = new Map<number, string[]>();
    const sorted = [...sheet.cells.entries()].sort((a, b) => a[0] - b[0]);
    for (const [k, cell] of sorted) {
      const r = keyRow(k);
      const c = keyCol(k);
      const ref = cellName(r, c);
      const s = cell.s ? styleXf(cell.s) : 0;
      const sAttr = s ? ` s="${s}"` : "";
      let xml: string;
      if (cell.f !== undefined) {
        const v = cell.v;
        const spill = sheet.spills.get(k);
        const f = spill ? `<f t="array" ref="${cellName(spill.r1, spill.c1)}:${cellName(spill.r2, spill.c2)}">${escapeXml(forFile(cell.f))}</f>` : `<f>${escapeXml(forFile(cell.f))}</f>`;
        if (typeof v === "number") xml = `<c r="${ref}"${sAttr}>${f}<v>${v}</v></c>`;
        else if (typeof v === "boolean") xml = `<c r="${ref}"${sAttr} t="b">${f}<v>${v ? 1 : 0}</v></c>`;
        else if (v instanceof CellError) xml = `<c r="${ref}"${sAttr} t="e">${f}<v>${escapeXml(v.code)}</v></c>`;
        else xml = `<c r="${ref}"${sAttr} t="str">${f}<v>${escapeXml(String(v ?? ""))}</v></c>`;
      } else {
        const v = cell.v;
        if (v === null) xml = s ? `<c r="${ref}"${sAttr}/>` : "";
        else if (typeof v === "number") xml = `<c r="${ref}"${sAttr}><v>${Number.isFinite(v) ? v : 0}</v></c>`;
        else if (typeof v === "boolean") xml = `<c r="${ref}"${sAttr} t="b"><v>${v ? 1 : 0}</v></c>`;
        else if (v instanceof CellError) xml = `<c r="${ref}"${sAttr} t="e"><v>${escapeXml(v.code)}</v></c>`;
        else xml = `<c r="${ref}"${sAttr} t="s"><v>${sst(v)}</v></c>`;
      }
      if (!xml) continue;
      const list = rows.get(r) ?? [];
      list.push(xml);
      rows.set(r, list);
    }
    // spilled cells keep their values, so other apps see them
    for (const [anchor, area] of sheet.spills) {
      const a = sheet.cells.get(anchor);
      if (!a?.arr) continue;
      for (let r = area.r1; r <= area.r2; r++)
        for (let c = area.c1; c <= area.c2; c++) {
          if (r === area.r1 && c === area.c1) continue;
          const v = a.arr.get(r - area.r1, c - area.c1);
          const ref = cellName(r, c);
          const xml = typeof v === "number" ? `<c r="${ref}"><v>${v}</v></c>` : typeof v === "string" ? `<c r="${ref}" t="str"><v>${escapeXml(v)}</v></c>` : typeof v === "boolean" ? `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>` : "";
          if (!xml) continue;
          const list = rows.get(r) ?? [];
          list.push(xml);
          rows.set(r, list);
        }
    }
    const rowNumbers = new Set([...rows.keys(), ...sheet.rowHeights.keys(), ...sheet.hiddenRows, ...sheet.filterHidden]);
    const rowXml = [...rowNumbers].sort((a, b) => a - b).map((r) => {
      const cells = (rows.get(r) ?? []).sort((x, y) => colIndex(/r="([A-Z]+)/.exec(x)![1]!) - colIndex(/r="([A-Z]+)/.exec(y)![1]!));
      const h = sheet.rowHeights.get(r);
      const hidden = sheet.hiddenRows.has(r) || sheet.filterHidden.has(r);
      return `<row r="${r + 1}"${h !== undefined ? ` ht="${(h * 0.75).toFixed(2)}" customHeight="1"` : ""}${hidden ? ' hidden="1"' : ""}>${cells.join("")}</row>`;
    });
    const bounds = wb.bounds(sheet);
    const dimension = bounds.rows && bounds.cols ? `A1:${cellName(bounds.rows - 1, bounds.cols - 1)}` : "A1";
    const cols = new Set([...sheet.colWidths.keys(), ...sheet.hiddenCols]);
    const colXml = cols.size ? `<cols>${[...cols].sort((a, b) => a - b).map((c) => `<col min="${c + 1}" max="${c + 1}" width="${colChars(sheet.colWidths.get(c) ?? 96).toFixed(2)}" customWidth="1"${sheet.hiddenCols.has(c) ? ' hidden="1"' : ""}/>`).join("")}</cols>` : "";
    const freeze = sheet.freezeRows || sheet.freezeCols ? `<pane${sheet.freezeCols ? ` xSplit="${sheet.freezeCols}"` : ""}${sheet.freezeRows ? ` ySplit="${sheet.freezeRows}"` : ""} topLeftCell="${cellName(sheet.freezeRows, sheet.freezeCols)}" activePane="${sheet.freezeRows && sheet.freezeCols ? "bottomRight" : sheet.freezeRows ? "bottomLeft" : "topRight"}" state="frozen"/>` : "";
    const views = `<sheetViews><sheetView workbookViewId="0"${sheet.showGrid ? "" : ' showGridLines="0"'}${index === 0 ? ' tabSelected="1"' : ""}>${freeze}</sheetView></sheetViews>`;
    const merges = sheet.merges.length ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${cellName(m.r1, m.c1)}:${cellName(m.r2, m.c2)}"/>`).join("")}</mergeCells>` : "";
    const tableHere = sheet.tables;
    const filter = sheet.filter && !tableHere.some((t) => t.area.r1 === sheet.filter!.area.r1 && t.area.c1 === sheet.filter!.area.c1) ? `<autoFilter ref="${cellName(sheet.filter.area.r1, sheet.filter.area.c1)}:${cellName(sheet.filter.area.r2, sheet.filter.area.c2)}"/>` : "";
    let priority = 1;
    const cfXml = sheet.conditionals.map((rule) => {
      const ref = `${cellName(rule.area.r1, rule.area.c1)}:${cellName(Math.min(rule.area.r2, 1_048_575), rule.area.c2)}`;
      const d = dxf(rule.style);
      const dAttr = d !== undefined ? ` dxfId="${d}"` : "";
      const p = priority++;
      const formula = (s?: string) => (s === undefined ? "" : `<formula>${escapeXml(s.startsWith("=") ? s.slice(1) : /^-?[\d.]+$/.test(s) ? s : `"${s}"`)}</formula>`);
      const opName = Object.entries(CF_OPS).find(([, v]) => v === rule.op)?.[0] ?? "equal";
      const tl = cellName(rule.area.r1, rule.area.c1);
      let body: string;
      switch (rule.kind) {
        case "cell": body = `<cfRule type="cellIs"${dAttr} priority="${p}" operator="${opName}">${formula(rule.a)}${formula(rule.b)}</cfRule>`; break;
        case "formula": body = `<cfRule type="expression"${dAttr} priority="${p}">${formula(rule.formula)}</cfRule>`; break;
        case "text": {
          const t = escapeXml(rule.a ?? "");
          const type = rule.op === "begins" ? "beginsWith" : rule.op === "ends" ? "endsWith" : rule.op === "notContains" ? "notContainsText" : "containsText";
          const f = rule.op === "begins" ? `LEFT(${tl},LEN("${t}"))="${t}"` : rule.op === "ends" ? `RIGHT(${tl},LEN("${t}"))="${t}"` : rule.op === "notContains" ? `ISERROR(SEARCH("${t}",${tl}))` : `NOT(ISERROR(SEARCH("${t}",${tl})))`;
          body = `<cfRule type="${type}"${dAttr} priority="${p}" operator="${type === "containsText" ? "containsText" : type === "notContainsText" ? "notContains" : type}" text="${t}"><formula>${f}</formula></cfRule>`;
          break;
        }
        case "top": body = `<cfRule type="top10"${dAttr} priority="${p}" rank="${rule.n ?? 10}"${rule.percent ? ' percent="1"' : ""}${rule.bottom ? ' bottom="1"' : ""}/>`; break;
        case "average": body = `<cfRule type="aboveAverage"${dAttr} priority="${p}"${rule.above === false ? ' aboveAverage="0"' : ""}/>`; break;
        case "duplicate": body = `<cfRule type="duplicateValues"${dAttr} priority="${p}"/>`; break;
        case "unique": body = `<cfRule type="uniqueValues"${dAttr} priority="${p}"/>`; break;
        case "blank": body = `<cfRule type="containsBlanks"${dAttr} priority="${p}"><formula>LEN(TRIM(${tl}))=0</formula></cfRule>`; break;
        case "noblank": body = `<cfRule type="notContainsBlanks"${dAttr} priority="${p}"><formula>LEN(TRIM(${tl}))&gt;0</formula></cfRule>`; break;
        case "error": body = `<cfRule type="containsErrors"${dAttr} priority="${p}"><formula>ISERROR(${tl})</formula></cfRule>`; break;
        case "scale": {
          const colors = rule.colors ?? ["#f8696b", "#ffeb84", "#63be7b"];
          const cfvo = colors.length === 3 ? '<cfvo type="min"/><cfvo type="percentile" val="50"/><cfvo type="max"/>' : '<cfvo type="min"/><cfvo type="max"/>';
          body = `<cfRule type="colorScale" priority="${p}"><colorScale>${cfvo}${colors.map((c) => `<color rgb="${hex(c)}"/>`).join("")}</colorScale></cfRule>`;
          break;
        }
        case "bar": body = `<cfRule type="dataBar" priority="${p}"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="${hex(rule.colors?.[0] ?? "#638ec6")}"/></dataBar></cfRule>`; break;
        case "icons": body = `<cfRule type="iconSet" priority="${p}"><iconSet iconSet="${rule.icons === "arrows" ? "3Arrows" : rule.icons === "flags" ? "3Flags" : rule.icons === "stars" ? "3Stars" : "3TrafficLights1"}"><cfvo type="percent" val="0"/><cfvo type="percent" val="33"/><cfvo type="percent" val="67"/></iconSet></cfRule>`; break;
        default: body = "";
      }
      return body ? `<conditionalFormatting sqref="${ref}">${body}</conditionalFormatting>` : "";
    }).join("");
    const dvXml = sheet.validations.length
      ? `<dataValidations count="${sheet.validations.length}">${sheet.validations.map((v) => {
          const ref = `${cellName(v.area.r1, v.area.c1)}:${cellName(Math.min(v.area.r2, 1_048_575), v.area.c2)}`;
          const type = { list: "list", whole: "whole", decimal: "decimal", date: "date", time: "time", length: "textLength", custom: "custom", any: "none" }[v.kind];
          const op = Object.entries(DV_OPS).find(([, x]) => x === v.op)?.[0] ?? "between";
          const f = (s?: string) => (s === undefined ? undefined : s.startsWith("=") ? s.slice(1) : v.kind === "date" && parseDate(s) !== null ? String(parseDate(s)) : s);
          const f1 = v.kind === "list" ? (v.source?.startsWith("=") ? v.source.slice(1) : `"${v.source ?? ""}"`) : v.kind === "custom" ? (v.source ?? "").replace(/^=/, "") : f(v.a);
          const f2 = v.kind === "list" || v.kind === "custom" ? undefined : f(v.b);
          return `<dataValidation type="${type}"${v.kind !== "list" && v.kind !== "custom" ? ` operator="${op}"` : ""} allowBlank="${v.allowBlank ? 1 : 0}"${v.dropdown ? "" : ' showDropDown="1"'} showInputMessage="1" showErrorMessage="1"${v.error?.style && v.error.style !== "stop" ? ` errorStyle="${v.error.style === "info" ? "information" : "warning"}"` : ""}${v.error?.message ? ` error="${escapeXml(v.error.message)}"` : ""}${v.prompt ? ` prompt="${escapeXml(v.prompt)}"` : ""} sqref="${ref}">${f1 !== undefined ? `<formula1>${escapeXml(f1)}</formula1>` : ""}${f2 !== undefined ? `<formula2>${escapeXml(f2)}</formula2>` : ""}</dataValidation>`;
        }).join("")}</dataValidations>`
      : "";
    const relEntries: string[] = [];
    const tableParts = tableHere.map((t) => {
      tableCount++;
      const columns = [];
      for (let c = t.area.c1; c <= t.area.c2; c++) columns.push(`<tableColumn id="${c - t.area.c1 + 1}" name="${escapeXml(wb.display(sheet, t.area.r1, c).text || `Column${c - t.area.c1 + 1}`)}"/>`);
      const ref = `${cellName(t.area.r1, t.area.c1)}:${cellName(t.area.r2, t.area.c2)}`;
      const styleName = { blue: "TableStyleMedium2", orange: "TableStyleMedium3", grey: "TableStyleMedium1", plain: "TableStyleLight1", green: "TableStyleMedium7", purple: "TableStyleMedium5" }[t.style] ?? "TableStyleMedium2";
      tableFiles.push([`xl/tables/table${tableCount}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${tableCount}" name="${escapeXml(t.name)}" displayName="${escapeXml(t.name)}" ref="${ref}"${t.totals ? ' totalsRowCount="1"' : ""}><autoFilter ref="${ref}"/><tableColumns count="${columns.length}">${columns.join("")}</tableColumns><tableStyleInfo name="${styleName}" showFirstColumn="0" showLastColumn="0" showRowStripes="${t.banded ? 1 : 0}" showColumnStripes="0"/></table>`]);
      relEntries.push(`<Relationship Id="rIdT${tableCount}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table${tableCount}.xml"/>`);
      return `<tablePart r:id="rIdT${tableCount}"/>`;
    });
    const parts = tableParts.length ? `<tableParts count="${tableParts.length}">${tableParts.join("")}</tableParts>` : "";
    sheetFiles.push([
      `xl/worksheets/sheet${index + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="${dimension}"/>${views}<sheetFormatPr defaultRowHeight="18" defaultColWidth="${colChars(96).toFixed(2)}"/>${colXml}<sheetData>${rowXml.join("")}</sheetData>${filter}${merges}${cfXml}${dvXml}${parts}</worksheet>`,
    ]);
    if (relEntries.length) sheetRels.push([`xl/worksheets/_rels/sheet${index + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relEntries.join("")}</Relationships>`]);
  });

  const names = [...wb.names.values()].map((n) => {
    const local = n.sheet === null ? "" : ` localSheetId="${wb.sheets.findIndex((s) => s.uid === n.sheet)}"`;
    return `<definedName name="${escapeXml(n.name)}"${local}>${escapeXml(forFile(n.formula))}</definedName>`;
  });
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${wb.sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ""} r:id="rId${i + 1}"/>`).join("")}</sheets>${names.length ? `<definedNames>${names.join("")}</definedNames>` : ""}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
  const n = wb.sheets.length;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${wb.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.join("")}</numFmts>` : ""}<fonts count="${fonts.length}">${fonts.join("")}</fonts><fills count="${fills.length}">${fills.join("")}</fills><borders count="${borders.length}">${borders.join("")}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>${dxfs.length ? `<dxfs count="${dxfs.length}">${dxfs.join("")}</dxfs>` : '<dxfs count="0"/>'}</styleSheet>`;
  const sharedXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t${/^\s|\s$|\n/.test(s) ? ' xml:space="preserve"' : ""}>${escapeXml(s)}</t></si>`).join("")}</sst>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${wb.sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}${tableFiles.map(([p]) => `<Override PartName="/${p}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>FlowLabs</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>FlowLabs</Application></Properties>`;
  return zip([
    ["[Content_Types].xml", contentTypes],
    ["_rels/.rels", rootRels],
    ["docProps/core.xml", core],
    ["docProps/app.xml", app],
    ["xl/workbook.xml", workbookXml],
    ["xl/_rels/workbook.xml.rels", workbookRels],
    ["xl/styles.xml", stylesXml],
    ["xl/sharedStrings.xml", sharedXml],
    ...sheetFiles,
    ...sheetRels,
    ...tableFiles,
  ]);
}

// --------------------------------------------------------------------------------------- CSV

/** A sheet's used range as CSV, values as they show. */
export function writeCsv(wb: Workbook, sheetIndex = 0, separator = ","): string {
  const sheet = wb.sheets[sheetIndex]!;
  const { rows, cols } = wb.bounds(sheet);
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const fields: string[] = [];
    for (let c = 0; c < cols; c++) {
      const shown = wb.display(sheet, r, c);
      // numbers keep their full precision unless a format shows them otherwise
      let text = shown.text;
      const format = wb.style(sheet.cells.get(key(r, c))?.s).format;
      if (typeof shown.value === "number" && (!format || format === "General")) text = String(Number(shown.value.toPrecision(15)));
      fields.push(/[",\n\r]/.test(text) || text.includes(separator) ? `"${text.replace(/"/g, '""')}"` : text);
    }
    lines.push(fields.join(separator));
  }
  return lines.join("\r\n");
}

/** CSV (or tab- or semicolon-separated) text as rows of fields. */
export function parseCsv(text: string): string[][] {
  const sample = text.slice(0, 5000);
  const firstLine = sample.split(/\r?\n/)[0] ?? "";
  const counts = [",", ";", "\t", "|"].map((d) => ({ d, n: firstLine.split(d).length }));
  const sep = counts.sort((a, b) => b.n - a.n)[0]!.n > 1 ? counts[0]!.d : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const t = text.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (quoted) {
      if (ch === '"') {
        if (t[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && t[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Rows of text into a sheet, read as typed (numbers, dates, TRUE/FALSE, formulas stay text unless asked). */
export function csvSheet(name: string, rows: string[][]): SheetJSON {
  const cells: [number, number, CellJSON][] = [];
  rows.forEach((r, i) =>
    r.forEach((text, j) => {
      if (text === "") return;
      const n = parseNumber(text);
      if (n !== null) cells.push([i, j, { v: n }]);
      else if (/^(true|false)$/i.test(text)) cells.push([i, j, { v: text.toUpperCase() === "TRUE" }]);
      else {
        const d = /^\d{4}-\d{2}-\d{2}/.test(text) || /^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(text) ? parseDate(text) : null;
        cells.push([i, j, d !== null ? { v: d, s: 1 } : { v: text }]);
      }
    }),
  );
  return { name, cells, freezeRows: rows.length > 1 ? 1 : 0 };
}

export function csvWorkbook(name: string, text: string): WorkbookJSON {
  return { format: "flowlabs-workbook", version: 1, sheets: [csvSheet(name, parseCsv(text))], styles: [{}, { format: "yyyy-mm-dd" }], names: [] };
}

