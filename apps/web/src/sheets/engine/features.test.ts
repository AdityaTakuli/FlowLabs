// Filters, sorting, validation, conditional formats, data tools, tables and PivotTables.
import { describe, expect, it } from "vitest";
import { applyFilter, buildPivot, checkValidation, conditionalLooks, createTable, flashFill, listItems, removeDuplicates, setColumnFilter, sortRange, textToColumns, toggleFilter, uid } from "./features";
import { key } from "./address";
import { Workbook, type PivotDef } from "./workbook";

const A = (addr: string) => {
  const m = /^([A-Z]+)(\d+)$/.exec(addr)!;
  return { row: Number(m[2]) - 1, col: [...m[1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 };
};

function book(rows: (string | number)[][]) {
  const wb = new Workbook();
  const sheet = wb.sheets[0]!;
  wb.transact("set", () => rows.forEach((r, i) => r.forEach((v, j) => wb.setInput(sheet, i, j, String(v)))));
  const at = (addr: string) => {
    const p = A(addr);
    return wb.value(sheet, p.row, p.col);
  };
  const set = (addr: string, text: string) => {
    const p = A(addr);
    wb.transact("set", () => wb.setInput(sheet, p.row, p.col, text));
  };
  return { wb, sheet, at, set };
}

const sales = [
  ["Region", "Rep", "Product", "Units", "Price"],
  ["East", "Ann", "Apples", 10, 1.5],
  ["West", "Bob", "Pears", 4, 2.25],
  ["East", "Cy", "Pears", 7, 2.25],
  ["North", "Ann", "Apples", 3, 1.5],
  ["West", "Dee", "Plums", 12, 3],
];

describe("filters", () => {
  it("hides rows that fail, and SUBTOTAL skips them", () => {
    const { wb, sheet, at, set } = book(sales);
    toggleFilter(wb, sheet, { r1: 0, c1: 0, r2: 5, c2: 4 });
    setColumnFilter(wb, sheet, 0, { values: ["East"] });
    expect([...sheet.filterHidden].sort()).toEqual([2, 4, 5]);
    set("G1", "=SUBTOTAL(9,D2:D6)");
    set("G2", "=SUM(D2:D6)");
    expect(at("G1")).toBe(17);
    expect(at("G2")).toBe(36);
    setColumnFilter(wb, sheet, 3, { cond: { op: ">", value: "5" } });
    expect([...sheet.filterHidden].sort()).toEqual([2, 4, 5]);
    setColumnFilter(wb, sheet, 0, null);
    expect([...sheet.filterHidden].sort()).toEqual([2, 4]);
    setColumnFilter(wb, sheet, 3, { top: { n: 2 } });
    expect([...sheet.filterHidden].sort()).toEqual([2, 3, 4]);
    wb.undo();
    applyFilter(wb, sheet);
    expect([...sheet.filterHidden].sort()).toEqual([2, 4]);
  });
});

describe("sorting", () => {
  it("sorts by several keys and keeps the header", () => {
    const { wb, sheet, at } = book(sales);
    sortRange(wb, sheet, { r1: 0, c1: 0, r2: 5, c2: 4 }, [{ col: 0, desc: false }, { col: 3, desc: true }], true);
    expect([at("A1"), at("A2"), at("D2"), at("A3"), at("D3"), at("A4"), at("A6")]).toEqual(["Region", "East", 10, "East", 7, "North", "West"]);
  });
  it("sorts by a custom order", () => {
    const { wb, sheet, at } = book([["Month"], ["Mar"], ["Jan"], ["Feb"]]);
    sortRange(wb, sheet, { r1: 0, c1: 0, r2: 3, c2: 0 }, [{ col: 0, desc: false, order: ["Jan", "Feb", "Mar"] }], true);
    expect([at("A2"), at("A3"), at("A4")]).toEqual(["Jan", "Feb", "Mar"]);
  });
});

describe("validation", () => {
  it("checks lists and numbers", () => {
    const { wb, sheet } = book([["Yes"], ["No"]]);
    wb.transact("rule", () => wb.setSheetProp(sheet, "validations", [
      { area: { r1: 0, c1: 2, r2: 9, c2: 2 }, kind: "list", source: "=$A$1:$A$2", allowBlank: true, dropdown: true },
      { area: { r1: 0, c1: 3, r2: 9, c2: 3 }, kind: "whole", op: "between", a: "1", b: "10", allowBlank: true, dropdown: false },
    ]));
    expect(listItems(wb, sheet, sheet.validations[0]!)).toEqual(["Yes", "No"]);
    expect(checkValidation(wb, sheet, 0, 2, "yes")).toBeNull();
    expect(checkValidation(wb, sheet, 0, 2, "Maybe")).toMatch(/Choose one of/);
    expect(checkValidation(wb, sheet, 0, 3, 5)).toBeNull();
    expect(checkValidation(wb, sheet, 0, 3, 11)).toMatch(/between 1 and 10/);
    expect(checkValidation(wb, sheet, 0, 3, 2.5)).toMatch(/whole number/);
  });
});

describe("conditional formats", () => {
  it("highlights, scales and bars", () => {
    const { wb, sheet } = book([[1], [5], [10], [5]]);
    wb.transact("rules", () => wb.setSheetProp(sheet, "conditionals", [
      { id: uid(), area: { r1: 0, c1: 0, r2: 3, c2: 0 }, kind: "cell", op: ">", a: "4", style: { fill: "#ffc7ce" } },
      { id: uid(), area: { r1: 0, c1: 0, r2: 3, c2: 0 }, kind: "duplicate", style: { bold: true } },
      { id: uid(), area: { r1: 0, c1: 0, r2: 3, c2: 0 }, kind: "bar" },
    ]));
    const looks = conditionalLooks(wb, sheet, { r1: 0, c1: 0, r2: 10, c2: 5 });
    expect(looks.get(key(0, 0))?.style?.fill).toBeUndefined();
    expect(looks.get(key(1, 0))?.style).toMatchObject({ fill: "#ffc7ce", bold: true });
    expect(looks.get(key(2, 0))?.bar?.fill).toBe(1);
    expect(looks.get(key(2, 0))?.style?.bold).toBeUndefined();
  });
  it("runs formula rules relative to each cell", () => {
    const { wb, sheet } = book([[1, "x"], [2, ""], [3, "x"]]);
    wb.transact("rule", () => wb.setSheetProp(sheet, "conditionals", [{ id: uid(), area: { r1: 0, c1: 0, r2: 2, c2: 1 }, kind: "formula", formula: '=$B1="x"', style: { fill: "#c6efce" } }]));
    const looks = conditionalLooks(wb, sheet, { r1: 0, c1: 0, r2: 5, c2: 5 });
    expect(looks.has(key(0, 0))).toBe(true);
    expect(looks.has(key(1, 0))).toBe(false);
    expect(looks.has(key(2, 1))).toBe(true);
  });
});

describe("data tools", () => {
  it("splits text into columns", () => {
    const { wb, sheet, at } = book([["Ann Lee, 34"], ['"Smith, Jo", 41']]);
    textToColumns(wb, sheet, { r1: 0, c1: 0, r2: 1, c2: 0 }, { delimiters: [","], consecutive: false, quote: '"' });
    expect([at("A1"), at("B1"), at("A2"), at("B2")]).toEqual(["Ann Lee", 34, "Smith, Jo", 41]);
  });
  it("removes duplicate rows", () => {
    const { wb, sheet, at } = book([["Name", "City"], ["Ann", "Pune"], ["ann", "Pune"], ["Bob", "Oslo"], ["Ann", "Oslo"]]);
    const r = removeDuplicates(wb, sheet, { r1: 0, c1: 0, r2: 4, c2: 1 }, [0, 1], true);
    expect(r).toEqual({ removed: 1, left: 3 });
    expect([at("A2"), at("A3"), at("A4"), at("A5")]).toEqual(["Ann", "Bob", "Ann", null]);
  });
  it("flash fills from examples", () => {
    const { wb, sheet, at } = book([["Ann Lee", "Lee, Ann"], ["Bob Stone", ""], ["Cy Young", ""]]);
    expect(flashFill(wb, sheet, 1, 1)).toBe(2);
    expect([at("B2"), at("B3")]).toEqual(["Stone, Bob", "Young, Cy"]);
    const b = book([["john smith", "J. SMITH"], ["ada lovelace", ""]]);
    flashFill(b.wb, b.sheet, 1, 1);
    expect(b.at("B2")).toBe("A. LOVELACE");
  });
});

describe("tables", () => {
  it("answers structured references and grows", () => {
    const { wb, sheet, at, set } = book(sales);
    const t = createTable(wb, sheet, { r1: 0, c1: 0, r2: 5, c2: 4 }, true);
    expect(t.name).toBe("Table1");
    set("H1", "=SUM(Table1[Units])");
    expect(at("H1")).toBe(36);
    set("F1", "Total");
    set("F2", "=[@Units]*[@Price]");
    expect(at("F2")).toBe(15);
    expect(at("F3")).toBe(9); // the formula filled the whole column
    expect(sheet.tables[0]!.area.c2).toBe(5);
    set("H2", "=ROWS(Table1[#All])");
    expect(at("H2")).toBe(6);
    set("A7", "South");
    expect(sheet.tables[0]!.area.r2).toBe(6);
    expect(at("H2")).toBe(7);
  });
});

describe("PivotTables", () => {
  it("summarizes by rows and columns", () => {
    const { wb, sheet, at } = book(sales);
    const p: PivotDef = { id: uid(), source: { sheet: sheet.uid, area: { r1: 0, c1: 0, r2: 5, c2: 4 } }, row: 0, col: 8, rows: [0], cols: [], values: [{ col: 3, fn: "sum" }], filters: [], totals: true };
    buildPivot(wb, sheet, p);
    expect([at("I1"), at("J1")]).toEqual(["Region", "Sum of Units"]);
    expect([at("I2"), at("J2"), at("I3"), at("J3"), at("I4"), at("J4")]).toEqual(["East", 17, "North", 3, "West", 16]);
    expect([at("I5"), at("J5")]).toEqual(["Grand Total", 36]);
    const q: PivotDef = { ...p, id: uid(), row: 10, col: 8, cols: [2], values: [{ col: 3, fn: "count" }] };
    buildPivot(wb, sheet, q);
    const at2 = (r: number, c: number) => wb.value(sheet, r, c);
    expect(at2(11, 8)).toBe("Region");
    expect([at2(11, 9), at2(11, 10), at2(11, 11), at2(11, 12)]).toEqual(["Apples", "Pears", "Plums", "Grand Total"]);
    expect([at2(12, 9), at2(12, 10), at2(12, 12)]).toEqual([1, 1, 2]);
  });
});
