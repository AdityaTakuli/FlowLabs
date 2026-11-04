// .xlsx and CSV: what other apps write reads in, and what FlowLabs writes reads back the same.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { key } from "./address";
import { applyFilter, createTable, toggleFilter, uid } from "./features";
import { csvWorkbook, parseCsv, readXlsx, writeCsv, writeXlsx } from "./xlsx";
import { Workbook } from "./workbook";

const fixture = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

describe("reading .xlsx", () => {
  it("reads a workbook made by openpyxl", async () => {
    const wb = Workbook.fromJSON(await readXlsx(fixture("openpyxl.xlsx")));
    expect(wb.sheets.map((s) => s.name)).toEqual(["Sales", "Lookup", "T"]);
    const [sales, lookup, t] = wb.sheets as [never, never, never];
    expect(wb.value(sales, 1, 3)).toBe(15);
    expect(wb.value(sales, 5, 3)).toBe(15 + 9 + 21);
    expect(wb.display(sales, 1, 4).text).toBe("2024-01-02");
    expect(wb.display(sales, 1, 2).text).toBe("$1.50");
    expect(wb.style(wb.sheets[0]!.cells.get(key(0, 0))!.s)).toMatchObject({ bold: true, color: "#ff0000", size: 14 });
    expect(wb.style(wb.sheets[0]!.cells.get(key(0, 1))!.s).fill).toBe("#ffff00");
    expect(wb.style(wb.sheets[0]!.cells.get(key(0, 2))!.s).bottom).toMatchObject({ style: "thick", color: "#0000ff" });
    expect(wb.style(wb.sheets[0]!.cells.get(key(0, 3))!.s)).toMatchObject({ h: "center", wrap: true });
    expect(wb.sheets[0]!.merges).toEqual([{ r1: 7, c1: 0, r2: 7, c2: 2 }]);
    expect(wb.sheets[0]!.freezeRows).toBe(1);
    expect(wb.sheets[0]!.freezeCols).toBe(1);
    expect(wb.sheets[0]!.colWidths.get(0)).toBe(145);
    expect(wb.sheets[0]!.rowHeights.get(0)).toBe(40);
    expect(wb.sheets[0]!.validations[0]).toMatchObject({ kind: "list", source: "Yes,No" });
    expect(wb.sheets[0]!.conditionals.map((c) => c.kind)).toEqual(["cell", "scale"]);
    expect(wb.value(lookup, 0, 0)).toBe(9);
    expect(wb.value(lookup, 1, 0)).toBe(7);
    expect(wb.value(lookup, 2, 0)).toBe("Tuesday");
    expect(wb.evaluateFormula(wb.sheets[1]!, "SUM(Units)")).toBe(21);
    expect(wb.sheets[2]!.tables[0]).toMatchObject({ name: "Scores", area: { r1: 0, c1: 0, r2: 2, c2: 1 } });
    expect(wb.value(t, 0, 3)).toBe(8);
  });
  it("reads a workbook made by LibreOffice", async () => {
    const wb = Workbook.fromJSON(await readXlsx(fixture("libreoffice.xlsx")));
    const s = wb.sheets[0]!;
    expect(wb.value(s, 0, 0)).toBe("a");
    expect(wb.value(s, 1, 1)).toBe(2);
    expect([wb.value(s, 1, 2), wb.value(s, 3, 2)]).toEqual([3, 11]);
  });
});

describe("writing .xlsx", () => {
  it("round-trips values, formulas, styles and features", async () => {
    const wb = new Workbook();
    const s = wb.sheets[0]!;
    wb.transact("fill", () => {
      wb.setInput(s, 0, 0, "Name");
      wb.setInput(s, 0, 1, "Amount");
      wb.setInput(s, 1, 0, "Ann");
      wb.setInput(s, 1, 1, "$1,234.50");
      wb.setInput(s, 2, 0, "Bob");
      wb.setInput(s, 2, 1, "12%");
      wb.setInput(s, 3, 1, "=SUM(B2:B3)");
      wb.setInput(s, 4, 1, "=XLOOKUP(\"Bob\",A2:A3,B2:B3)");
      wb.setInput(s, 5, 0, "=SORT(A2:A3,1,-1)");
      wb.setInput(s, 1, 2, "1/2/2024");
      wb.setInput(s, 2, 2, "TRUE");
      wb.setInput(s, 3, 2, "=1/0");
      wb.setStyle(s, { r1: 0, c1: 0, r2: 0, c2: 1 }, { bold: true, fill: "#ddebf7", bottom: { style: "thin" } });
      wb.merge(s, { r1: 8, c1: 0, r2: 8, c2: 2 });
      wb.setColWidth(s, [0], 150);
      wb.setSheetProp(s, "freezeRows", 1);
      wb.setSheetProp(s, "validations", [{ area: { r1: 1, c1: 3, r2: 20, c2: 3 }, kind: "list", source: "Low,High", allowBlank: true, dropdown: true }]);
      wb.setSheetProp(s, "conditionals", [{ id: uid(), area: { r1: 1, c1: 1, r2: 3, c2: 1 }, kind: "cell", op: ">", a: "100", style: { fill: "#ffc7ce" } }]);
      wb.defineName("Amounts", "Sheet1!$B$2:$B$3");
      const other = wb.addSheet("Two");
      wb.setInput(other, 0, 0, "=SUM(Amounts)");
    });
    const bytes = await writeXlsx(wb);
    const back = Workbook.fromJSON(await readXlsx(bytes));
    const b = back.sheets[0]!;
    expect(back.value(b, 1, 1)).toBe(1234.5);
    expect(back.display(b, 1, 1).text).toBe("$1,234.50");
    expect(back.display(b, 2, 1).text).toBe("12%");
    expect(back.editText(b, 3, 1)).toBe("=SUM(B2:B3)");
    expect(back.value(b, 4, 1)).toBe(0.12);
    expect([back.value(b, 5, 0), back.value(b, 6, 0)]).toEqual(["Bob", "Ann"]);
    expect(back.display(b, 1, 2).text).toBe("1/2/2024");
    expect(back.value(b, 2, 2)).toBe(true);
    expect(String(back.value(b, 3, 2))).toBe("#DIV/0!");
    expect(back.style(b.cells.get(key(0, 0))!.s)).toMatchObject({ bold: true, fill: "#ddebf7" });
    expect(b.merges).toEqual([{ r1: 8, c1: 0, r2: 8, c2: 2 }]);
    expect(b.colWidths.get(0)).toBe(150);
    expect(b.freezeRows).toBe(1);
    expect(b.validations[0]).toMatchObject({ kind: "list", source: "Low,High" });
    expect(b.conditionals[0]).toMatchObject({ kind: "cell", op: ">", a: "100", style: { fill: "#ffc7ce" } });
    expect(back.value(back.sheets[1]!, 0, 0)).toBeCloseTo(1234.62);
  });
  it("keeps tables and filters", async () => {
    const wb = new Workbook();
    const s = wb.sheets[0]!;
    wb.transact("fill", () => [["Item", "Qty"], ["a", "1"], ["b", "2"]].forEach((r, i) => r.forEach((v, j) => wb.setInput(s, i, j, v))));
    createTable(wb, s, { r1: 0, c1: 0, r2: 2, c2: 1 }, true);
    wb.transact("f", () => wb.setInput(s, 0, 3, "=SUM(Table1[Qty])"));
    const back = Workbook.fromJSON(await readXlsx(await writeXlsx(wb)));
    expect(back.sheets[0]!.tables[0]?.name).toBe("Table1");
    expect(back.value(back.sheets[0]!, 0, 3)).toBe(3);
    const f = new Workbook();
    const fs = f.sheets[0]!;
    f.transact("fill", () => [["x"], ["1"], ["2"]].forEach((r, i) => f.setInput(fs, i, 0, r[0]!)));
    toggleFilter(f, fs, { r1: 0, c1: 0, r2: 2, c2: 0 });
    applyFilter(f, fs);
    expect((await readXlsx(await writeXlsx(f))).sheets[0]!.filter?.area).toEqual({ r1: 0, c1: 0, r2: 2, c2: 0 });
  });
});

describe("CSV", () => {
  it("reads and writes", () => {
    expect(parseCsv('a,b\n"x, y",2\r\n"say ""hi""",3\n')).toEqual([["a", "b"], ["x, y", "2"], ['say "hi"', "3"]]);
    expect(parseCsv("a;b\n1;2")).toEqual([["a", "b"], ["1", "2"]]);
    const wb = Workbook.fromJSON(csvWorkbook("data", "name,amount,day\nAnn,1.5,2024-01-02\nBob,2,2024-01-03\n"));
    const s = wb.sheets[0]!;
    expect(wb.value(s, 1, 1)).toBe(1.5);
    expect(wb.display(s, 1, 2).text).toBe("2024-01-02");
    expect(writeCsv(wb)).toBe("name,amount,day\r\nAnn,1.5,2024-01-02\r\nBob,2,2024-01-03");
  });
});
