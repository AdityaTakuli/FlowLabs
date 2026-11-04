// The spreadsheet engine against the answers Excel gives.
import { describe, expect, it } from "vitest";
import { autofill, copyArea, paste, parseTsv } from "./fill";
import { formatValue, changeDecimals } from "./format";
import { parse, shiftFormula } from "./parser";
import { dateParts, dateSerial, parseDate } from "./dates";
import { Matrix, CellError } from "./values";
import { Workbook } from "./workbook";

function book(cells: Record<string, string> = {}) {
  const wb = new Workbook();
  const sheet = wb.sheets[0]!;
  wb.transact("set", () => {
    for (const [addr, text] of Object.entries(cells)) {
      const m = /^([A-Z]+)(\d+)$/.exec(addr)!;
      const col = [...m[1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      wb.setInput(sheet, Number(m[2]) - 1, col, text);
    }
  });
  const at = (addr: string) => {
    const m = /^([A-Z]+)(\d+)$/.exec(addr)!;
    const col = [...m[1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    return wb.value(sheet, Number(m[2]) - 1, col);
  };
  const calc = (f: string) => {
    const v = wb.evaluateFormula(sheet, f, 50, 50);
    return v instanceof Matrix ? v.toRows() : v instanceof CellError ? v.code : v;
  };
  return { wb, sheet, at, calc };
}

describe("parser", () => {
  it("reads precedence the way Excel does", () => {
    const { calc } = book();
    expect(calc("-2^2")).toBe(4);
    expect(calc("2^3^2")).toBe(64);
    expect(calc("1+2*3")).toBe(7);
    expect(calc("10%*50")).toBe(5);
    expect(calc('"a"&1+2')).toBe("a3");
    expect(calc("1=1")).toBe(true);
    expect(calc('"A"="a"')).toBe(true);
    expect(calc("0.1+0.2=0.3")).toBe(true);
  });
  it("tells LOG10( from the cell LOG10", () => {
    expect(parse("LOG10(100)").t).toBe("call");
    expect(parse("LOG10").t).toBe("ref");
  });
  it("moves relative references when copied", () => {
    expect(shiftFormula("A1+$B$2+B$3+$C4", 2, 1)).toBe("B3+$B$2+C$3+$C6");
    expect(shiftFormula("SUM(A1:A3)", -1, 0)).toBe("SUM(#REF!)");
    expect(shiftFormula("'My sheet'!A1*2", 1, 0)).toBe("'My sheet'!A2*2");
  });
  it("refuses broken formulas", () => {
    expect(() => parse("SUM(1,2")).toThrow();
    expect(() => parse("1+")).toThrow();
    expect(() => parse('"abc')).toThrow();
  });
});

describe("calculation", () => {
  it("follows references and recalculates dependents", () => {
    const { wb, sheet, at } = book({ A1: "2", A2: "=A1*10", A3: "=A2+A1" });
    expect(at("A3")).toBe(22);
    wb.transact("edit", () => wb.setInput(sheet, 0, 0, "5"));
    expect(at("A2")).toBe(50);
    expect(at("A3")).toBe(55);
  });
  it("handles long chains without running out of stack", () => {
    const wb = new Workbook();
    const sheet = wb.sheets[0]!;
    wb.transact("fill", () => {
      wb.setInput(sheet, 0, 0, "1");
      for (let r = 1; r < 20000; r++) wb.setInput(sheet, r, 0, `=A${r}+1`);
    });
    expect(wb.value(sheet, 19999, 0)).toBe(20000);
    wb.transact("edit", () => wb.setInput(sheet, 0, 0, "10"));
    expect(wb.value(sheet, 19999, 0)).toBe(20009);
  });
  it("shows 0 for circular references and lists them", () => {
    const { wb, at } = book({ A1: "=B1+1", B1: "=A1+1" });
    expect(at("A1")).toBe(0);
    expect(wb.circular.length).toBeGreaterThan(0);
  });
  it("spills arrays and blocks with #SPILL!", () => {
    const { wb, sheet, at } = book({ A1: "=SEQUENCE(3)", C1: "=SUM(A1:A3)" });
    expect([at("A1"), at("A2"), at("A3")]).toEqual([1, 2, 3]);
    expect(at("C1")).toBe(6);
    wb.transact("block", () => wb.setInput(sheet, 1, 0, "x"));
    expect((at("A1") as CellError).code).toBe("#SPILL!");
    wb.transact("unblock", () => wb.setInput(sheet, 1, 0, ""));
    expect(at("A2")).toBe(2);
    expect(at("C1")).toBe(6);
  });
  it("broadcasts operators over ranges", () => {
    const { at } = book({ A1: "1", A2: "2", A3: "3", B1: "=A1:A3*10" });
    expect([at("B1"), at("B2"), at("B3")]).toEqual([10, 20, 30]);
  });
  it("undoes and redoes", () => {
    const { wb, sheet, at } = book({ A1: "1", B1: "=A1*2" });
    wb.transact("edit", () => wb.setInput(sheet, 0, 0, "7"));
    expect(at("B1")).toBe(14);
    wb.undo();
    expect(at("A1")).toBe(1);
    expect(at("B1")).toBe(2);
    wb.redo();
    expect(at("B1")).toBe(14);
  });
  it("moves references when rows are inserted and deleted", () => {
    const { wb, sheet, at } = book({ A1: "1", A2: "2", A3: "3", B1: "=SUM(A1:A3)", C1: "=A3" });
    wb.transact("insert", () => wb.shift(sheet, "rows", 1, 2));
    expect(wb.editText(sheet, 0, 1)).toBe("=SUM(A1:A5)");
    expect(wb.editText(sheet, 0, 2)).toBe("=A5");
    expect(at("B1")).toBe(6);
    wb.transact("delete", () => wb.shift(sheet, "rows", 4, -1));
    expect(wb.editText(sheet, 0, 2)).toBe("=#REF!");
    expect(wb.editText(sheet, 0, 1)).toBe("=SUM(A1:A4)");
    wb.undo();
    expect(wb.editText(sheet, 0, 2)).toBe("=A5");
  });
  it("renames sheets inside formulas", () => {
    const { wb, sheet } = book();
    const other = wb.transact("add", () => wb.addSheet("Data"));
    wb.transact("v", () => wb.setInput(other, 0, 0, "41"));
    wb.transact("f", () => wb.setInput(sheet, 0, 0, "=Data!A1+1"));
    expect(wb.value(sheet, 0, 0)).toBe(42);
    wb.transact("rename", () => wb.renameSheet(other, "My data"));
    expect(wb.editText(sheet, 0, 0)).toBe("='My data'!A1+1");
    expect(wb.value(sheet, 0, 0)).toBe(42);
  });
  it("reads typed input like Excel", () => {
    const { wb, sheet, at } = book({ A1: "1,234.5", A2: "12%", A3: "$5", A4: "1/2/2024", A5: "'007", A6: "TRUE", A7: "10:30" });
    expect(at("A1")).toBe(1234.5);
    expect(at("A2")).toBe(0.12);
    expect(at("A3")).toBe(5);
    expect(at("A4")).toBe(45293);
    expect(at("A5")).toBe("007");
    expect(at("A6")).toBe(true);
    expect(at("A7")).toBeCloseTo(0.4375);
    expect(wb.display(sheet, 3, 0).text).toBe("1/2/2024");
    expect(wb.display(sheet, 1, 0).text).toBe("12%");
    expect(wb.display(sheet, 2, 0).text).toBe("$5");
    expect(wb.editText(sheet, 4, 0)).toBe("'007");
  });
  it("supports LET and LAMBDA", () => {
    const { calc } = book();
    expect(calc("LET(x, 2, y, x*3, x+y)")).toBe(8);
    expect(calc("LAMBDA(a, b, a*b)(6, 7)")).toBe(42);
    expect(calc("MAP({1,2,3}, LAMBDA(x, x*x))")).toEqual([[1, 4, 9]]);
    expect(calc("REDUCE(0, {1,2,3,4}, LAMBDA(a, x, a+x))")).toBe(10);
    expect(calc("BYROW({1,2;3,4}, LAMBDA(r, SUM(r)))")).toEqual([[3], [7]]);
  });
  it("saves and loads", () => {
    const { wb } = book({ A1: "5", B1: "=A1*2", C1: "hello" });
    const copy = Workbook.fromJSON(JSON.parse(JSON.stringify(wb.toJSON())));
    expect(copy.value(copy.sheets[0]!, 0, 1)).toBe(10);
    expect(copy.value(copy.sheets[0]!, 0, 2)).toBe("hello");
  });
});

describe("functions", () => {
  const data = { A1: "3", A2: "1", A3: "4", A4: "1", A5: "5", A6: "text", A7: "TRUE", B1: "a", B2: "b", B3: "a", B4: "c", B5: "a" };
  it("aggregates", () => {
    const { calc } = book(data);
    expect(calc("SUM(A1:A7)")).toBe(14);
    expect(calc("SUM(1,TRUE,\"2\")")).toBe(4);
    expect(calc("AVERAGE(A1:A7)")).toBe(2.8);
    expect(calc("COUNT(A1:A7)")).toBe(5);
    expect(calc("COUNTA(A1:A7)")).toBe(7);
    expect(calc("MAX(A1:A5)")).toBe(5);
    expect(calc("MEDIAN(A1:A5)")).toBe(3);
    expect(calc("MODE.SNGL(A1:A5)")).toBe(1);
    expect(calc("STDEV.S(A1:A5)")).toBeCloseTo(1.7888543820, 9);
    expect(calc("VAR.P(A1:A5)")).toBeCloseTo(2.56, 9);
    expect(calc("PRODUCT(A1:A5)")).toBe(60);
    expect(calc("SUMPRODUCT({1,2,3},{4,5,6})")).toBe(32);
    expect(calc("LARGE(A1:A5,2)")).toBe(4);
    expect(calc("SMALL(A1:A5,2)")).toBe(1);
    expect(calc("RANK.EQ(4,A1:A5)")).toBe(2);
    expect(calc("RANK.AVG(1,A1:A5,1)")).toBe(1.5);
    expect(calc("PERCENTILE.INC(A1:A5,0.25)")).toBe(1);
    expect(calc("QUARTILE.INC(A1:A5,3)")).toBe(4);
    expect(calc("PERCENTRANK.INC(A1:A5,3)")).toBe(0.5);
  });
  it("counts and sums with criteria", () => {
    const { calc } = book(data);
    expect(calc('COUNTIF(B1:B5,"a")')).toBe(3);
    expect(calc('COUNTIF(A1:A5,">2")')).toBe(3);
    expect(calc('COUNTIF(B1:B5,"<>a")')).toBe(2);
    expect(calc('COUNTIF(B1:B5,"?")')).toBe(5);
    expect(calc('SUMIF(B1:B5,"a",A1:A5)')).toBe(12);
    expect(calc('SUMIFS(A1:A5,B1:B5,"a",A1:A5,">3")')).toBe(9);
    expect(calc('AVERAGEIF(B1:B5,"a",A1:A5)')).toBe(4);
    expect(calc('COUNTIFS(B1:B5,"a",A1:A5,"<5")')).toBe(2);
    expect(calc('MAXIFS(A1:A5,B1:B5,"a")')).toBe(5);
    expect(calc("COUNTBLANK(C1:C3)")).toBe(3);
    expect(calc('COUNTIF(B1:B5,{"a","c"})')).toEqual([[3, 1]]);
  });
  it("does math", () => {
    const { calc } = book();
    expect(calc("ROUND(2.5,0)")).toBe(3);
    expect(calc("ROUND(-2.5,0)")).toBe(-3);
    expect(calc("ROUND(1234.567,-2)")).toBe(1200);
    expect(calc("ROUND(1.005,2)")).toBe(1.01);
    expect(calc("ROUNDUP(3.2,0)")).toBe(4);
    expect(calc("ROUNDDOWN(-3.7,0)")).toBe(-3);
    expect(calc("MOD(-3,2)")).toBe(1);
    expect(calc("MOD(3,-2)")).toBe(-1);
    expect(calc("INT(-3.5)")).toBe(-4);
    expect(calc("TRUNC(-3.5)")).toBe(-3);
    expect(calc("CEILING(2.5,1)")).toBe(3);
    expect(calc("FLOOR(-2.5,-2)")).toBe(-2);
    expect(calc("CEILING.MATH(-2.5)")).toBe(-2);
    expect(calc("MROUND(10,3)")).toBe(9);
    expect(calc("POWER(2,10)")).toBe(1024);
    expect(calc("1/0")).toBe("#DIV/0!");
    expect(calc("SQRT(-1)")).toBe("#NUM!");
    expect(calc("FACT(5)")).toBe(120);
    expect(calc("COMBIN(5,2)")).toBe(10);
    expect(calc("GCD(12,18)")).toBe(6);
    expect(calc("LCM(4,6)")).toBe(12);
    expect(calc("DEC2BIN(10)")).toBe("1010");
    expect(calc("HEX2DEC(\"FF\")")).toBe(255);
    expect(calc("DEC2HEX(-1)")).toBe("FFFFFFFFFF");
    expect(calc("ROMAN(1999)")).toBe("MCMXCIX");
    expect(calc("ARABIC(\"MCMXCIX\")")).toBe(1999);
    expect(calc("MMULT({1,2;3,4},{5;6})")).toEqual([[17], [39]]);
    expect(calc("MDETERM({1,2;3,4})")).toBe(-2);
    expect(calc("SEQUENCE(2,3,10,5)")).toEqual([[10, 15, 20], [25, 30, 35]]);
    expect(calc("SUBTOTAL(9,{1,2,3})")).toBe(6);
  });
  it("handles text", () => {
    const { calc } = book();
    expect(calc('LEFT("Hello",2)')).toBe("He");
    expect(calc('RIGHT("Hello",3)')).toBe("llo");
    expect(calc('MID("Hello",2,3)')).toBe("ell");
    expect(calc('LEN("Hello")')).toBe(5);
    expect(calc('UPPER("abc")')).toBe("ABC");
    expect(calc('PROPER("hello wORLD o\'neil")')).toBe("Hello World O'neil");
    expect(calc('TRIM("  a   b  ")')).toBe("a b");
    expect(calc('SUBSTITUTE("a-b-c","-","+")')).toBe("a+b+c");
    expect(calc('SUBSTITUTE("a-b-c","-","+",2)')).toBe("a-b+c");
    expect(calc('REPLACE("abcdef",2,3,"X")')).toBe("aXef");
    expect(calc('FIND("b","abcb")')).toBe(2);
    expect(calc('FIND("B","abcb")')).toBe("#VALUE!");
    expect(calc('SEARCH("B*","aabcb")')).toBe(3);
    expect(calc('TEXTJOIN(", ",TRUE,"a","","b")')).toBe("a, b");
    expect(calc('CONCAT("a",1,TRUE)')).toBe("a1TRUE");
    expect(calc('TEXT(1234.567,"#,##0.00")')).toBe("1,234.57");
    expect(calc('TEXT(0.256,"0.0%")')).toBe("25.6%");
    expect(calc('TEXT(45293,"dddd, mmmm d, yyyy")')).toBe("Tuesday, January 2, 2024");
    expect(calc('TEXT(0.75,"h:mm AM/PM")')).toBe("6:00 PM");
    expect(calc('VALUE("1,234")')).toBe(1234);
    expect(calc('TEXTBEFORE("a.b.c",".",-1)')).toBe("a.b");
    expect(calc('TEXTAFTER("a.b.c",".")')).toBe("b.c");
    expect(calc('TEXTSPLIT("a,b;c,d",",",";")')).toEqual([["a", "b"], ["c", "d"]]);
    expect(calc('FIXED(1234.567,1)')).toBe("1,234.6");
    expect(calc('DOLLAR(-1234.5)')).toBe("($1,234.50)");
    expect(calc('CHAR(65)&CODE("a")')).toBe("A97");
    expect(calc('EXACT("a","A")')).toBe(false);
    expect(calc('REPT("ab",3)')).toBe("ababab");
    expect(calc('REGEXEXTRACT("order 1234 shipped","\\d+")')).toBe("1234");
    expect(calc('1/3&""')).toBe("0.333333333333333");
  });
  it("looks things up", () => {
    const { calc } = book({ A1: "1", A2: "2", A3: "3", B1: "one", B2: "two", B3: "three", D1: "Apple", D2: "Banana", E1: "10", E2: "20" });
    expect(calc("VLOOKUP(2,A1:B3,2,FALSE)")).toBe("two");
    expect(calc("VLOOKUP(2.5,A1:B3,2,TRUE)")).toBe("two");
    expect(calc("VLOOKUP(9,A1:B3,2,FALSE)")).toBe("#N/A");
    expect(calc('VLOOKUP("ban*",D1:E2,2,FALSE)')).toBe(20);
    expect(calc("HLOOKUP(2,{1,2,3;\"a\",\"b\",\"c\"},2,FALSE)")).toBe("b");
    expect(calc("INDEX(B1:B3,3)")).toBe("three");
    expect(calc("INDEX(A1:B3,2,2)")).toBe("two");
    expect(calc('MATCH("three",B1:B3,0)')).toBe(3);
    expect(calc("MATCH(2.5,A1:A3,1)")).toBe(2);
    expect(calc('XLOOKUP("two",B1:B3,A1:A3)')).toBe(2);
    expect(calc('XLOOKUP("nine",B1:B3,A1:A3,"none")')).toBe("none");
    expect(calc("XLOOKUP(2.5,A1:A3,B1:B3,,1)")).toBe("three");
    expect(calc("XLOOKUP(2.5,A1:A3,B1:B3,,-1)")).toBe("two");
    expect(calc("XMATCH(3,A1:A3)")).toBe(3);
    expect(calc('XLOOKUP("three",B:B,A:A)')).toBe(3);
    expect(calc('INDEX(A:A,MATCH("two",B:B,0))')).toBe(2);
    expect(calc("SUM(A1:INDEX(A1:A3,2))")).toBe(3);
    expect(calc("SUM(OFFSET(A1,1,0,2,1))")).toBe(5);
    expect(calc('INDIRECT("B"&2)')).toBe("two");
    expect(calc("ADDRESS(3,2)")).toBe("$B$3");
    expect(calc("ROWS(A1:B3)*COLUMNS(A1:B3)")).toBe(6);
    expect(calc("CHOOSE(2,\"x\",\"y\",\"z\")")).toBe("y");
  });
  it("makes dynamic arrays", () => {
    const { calc } = book({ A1: "3", A2: "1", A3: "2", A4: "1", B1: "c", B2: "a", B3: "b", B4: "a" });
    expect(calc("SORT(A1:A4)")).toEqual([[1], [1], [2], [3]]);
    expect(calc("SORT(A1:A4,1,-1)")).toEqual([[3], [2], [1], [1]]);
    expect(calc("UNIQUE(A1:A4)")).toEqual([[3], [1], [2]]);
    expect(calc("UNIQUE(A1:A4,FALSE,TRUE)")).toEqual([[3], [2]]);
    expect(calc("FILTER(B1:B4,A1:A4>1)")).toEqual([["c"], ["b"]]);
    expect(calc("FILTER(B1:B4,A1:A4>5,\"none\")")).toBe("none");
    expect(calc("SORTBY(B1:B3,A1:A3)")).toEqual([["a"], ["b"], ["c"]]);
    expect(calc("TRANSPOSE({1,2,3})")).toEqual([[1], [2], [3]]);
    expect(calc("VSTACK({1,2},{3})")).toEqual([[1, 2], [3, "#N/A"].map((v) => (v === "#N/A" ? expect.anything() : v))]);
    expect(calc("TAKE({1,2,3,4},1,-2)")).toEqual([[3, 4]]);
    expect(calc("DROP({1;2;3},1)")).toEqual([[2], [3]]);
    expect(calc("TOCOL({1,2;3,4})")).toEqual([[1], [2], [3], [4]]);
    expect(calc("WRAPROWS({1,2,3,4},2)")).toEqual([[1, 2], [3, 4]]);
    expect(calc("CHOOSECOLS({1,2,3},3,1)")).toEqual([[3, 1]]);
  });
  it("does logic and information", () => {
    const { calc } = book({ A1: "5" });
    expect(calc('IF(A1>3,"big","small")')).toBe("big");
    expect(calc("IF(A1>9,1)")).toBe(false);
    expect(calc('IFS(A1>9,"a",A1>3,"b")')).toBe("b");
    expect(calc('IFERROR(1/0,"oops")')).toBe("oops");
    expect(calc('IFNA(NA(),"none")')).toBe("none");
    expect(calc('SWITCH(A1,1,"one",5,"five","other")')).toBe("five");
    expect(calc("AND(TRUE,A1>1)")).toBe(true);
    expect(calc("OR(FALSE,A1>9)")).toBe(false);
    expect(calc("XOR(TRUE,TRUE)")).toBe(false);
    expect(calc("ISBLANK(B1)")).toBe(true);
    expect(calc("ISNUMBER(A1)")).toBe(true);
    expect(calc("ISERROR(1/0)")).toBe(true);
    expect(calc("ERROR.TYPE(1/0)")).toBe(2);
    expect(calc("TYPE(\"a\")")).toBe(2);
    expect(calc("ISEVEN(4)")).toBe(true);
    expect(calc("N(TRUE)")).toBe(1);
    expect(calc("IF({1,0},\"y\",\"n\")")).toEqual([["y", "n"]]);
  });
  it("works with dates", () => {
    const { calc } = book();
    expect(calc("DATE(2024,1,2)")).toBe(45293);
    expect(calc("DATE(2024,14,1)")).toBe(calc("DATE(2025,2,1)"));
    expect(calc("YEAR(45293)")).toBe(2024);
    expect(calc("MONTH(45293)")).toBe(1);
    expect(calc("DAY(45293)")).toBe(2);
    expect(calc("WEEKDAY(45293)")).toBe(3);
    expect(calc("WEEKDAY(45293,2)")).toBe(2);
    expect(calc("EDATE(DATE(2024,1,31),1)")).toBe(calc("DATE(2024,2,29)"));
    expect(calc("EOMONTH(DATE(2024,1,15),0)")).toBe(calc("DATE(2024,1,31)"));
    expect(calc('DATEDIF("1/15/2020","3/10/2024","Y")')).toBe(4);
    expect(calc('DATEDIF("1/15/2020","3/10/2024","YM")')).toBe(1);
    expect(calc('DATEDIF("1/15/2020","3/10/2024","MD")')).toBe(24);
    expect(calc("NETWORKDAYS(DATE(2024,1,1),DATE(2024,1,31))")).toBe(23);
    expect(calc("WORKDAY(DATE(2024,1,5),1)")).toBe(calc("DATE(2024,1,8)"));
    expect(calc("DAYS360(DATE(2024,1,30),DATE(2024,2,28))")).toBe(28);
    expect(calc("ISOWEEKNUM(DATE(2024,1,1))")).toBe(1);
    expect(calc("WEEKNUM(DATE(2024,3,15))")).toBe(11);
    expect(calc("TIME(18,30,0)")).toBeCloseTo(0.7708333333);
    expect(calc("HOUR(0.7708333333)")).toBe(18);
    expect(calc('DATEVALUE("2024-03-15")')).toBe(45366);
    expect(calc("YEARFRAC(DATE(2024,1,1),DATE(2024,7,1))")).toBe(0.5);
  });
  it("does finance", () => {
    const { calc } = book();
    expect(calc("PMT(0.05/12,360,200000)")).toBeCloseTo(-1073.6432, 3);
    expect(calc("FV(0.06/12,10,-200,-500,1)")).toBeCloseTo(2581.4034, 3);
    expect(calc("PV(0.08/12,240,500)")).toBeCloseTo(-59777.1458, 3);
    expect(calc("NPER(0.01,-100,-1000,10000,1)")).toBeCloseTo(59.6738657, 5);
    expect(calc("RATE(48,-200,8000)")).toBeCloseTo(0.0077014, 6);
    expect(calc("IPMT(0.1/12,1,36,8000)")).toBeCloseTo(-66.6667, 3);
    expect(calc("PPMT(0.1/12,1,24,2000)")).toBeCloseTo(-75.6231, 3);
    expect(calc("NPV(0.1,-10000,3000,4200,6800)")).toBeCloseTo(1188.4434, 3);
    expect(calc("IRR({-70000,12000,15000,18000,21000,26000})")).toBeCloseTo(0.0866309, 6);
    expect(calc("SLN(30000,7500,10)")).toBe(2250);
    expect(calc("SYD(30000,7500,10,1)")).toBeCloseTo(4090.909, 2);
    expect(calc("DDB(2400,300,10,1)")).toBe(480);
    expect(calc("EFFECT(0.0525,4)")).toBeCloseTo(0.0535427, 6);
  });
  it("computes distributions", () => {
    const { calc } = book();
    expect(calc("NORM.S.DIST(1,TRUE)")).toBeCloseTo(0.8413447461, 9);
    expect(calc("NORM.DIST(42,40,1.5,TRUE)")).toBeCloseTo(0.9087887802, 9);
    expect(calc("NORM.INV(0.908789,40,1.5)")).toBeCloseTo(42.000002, 5);
    expect(calc("NORM.S.INV(0.975)")).toBeCloseTo(1.959963985, 8);
    expect(calc("T.DIST(1.96,60,TRUE)")).toBeCloseTo(0.9726775351, 9);
    expect(calc("T.INV.2T(0.05,10)")).toBeCloseTo(2.228138852, 6);
    expect(calc("CHISQ.DIST.RT(18.307,10)")).toBeCloseTo(0.0500006, 6);
    expect(calc("BINOM.DIST(6,10,0.5,FALSE)")).toBeCloseTo(0.205078125, 9);
    expect(calc("POISSON.DIST(2,5,TRUE)")).toBeCloseTo(0.1246520, 6);
    expect(calc("EXPON.DIST(0.2,10,TRUE)")).toBeCloseTo(0.8646647, 6);
    expect(calc("F.DIST.RT(15.2069,6,4)")).toBeCloseTo(0.01, 4);
    expect(calc("GAMMA(5)")).toBe(24);
    expect(calc("CORREL({3,2,4,5,6},{9,7,12,15,17})")).toBeCloseTo(0.997054486, 8);
    expect(calc("SLOPE({2,3,9,1,8,7,5},{6,5,11,7,5,4,4})")).toBeCloseTo(0.305555556, 8);
    expect(calc("FORECAST.LINEAR(30,{6,7,9,15,21},{20,28,31,38,40})")).toBeCloseTo(10.60725308, 7);
  });
});

describe("formats", () => {
  const f = (v: number | string, code: string) => formatValue(v, code).text;
  it("formats numbers", () => {
    expect(f(1234.567, "#,##0.00")).toBe("1,234.57");
    expect(f(-1234.567, "#,##0.00")).toBe("-1,234.57");
    expect(f(0.5, "0%")).toBe("50%");
    expect(f(5, "000")).toBe("005");
    expect(f(1234567, "#,##0,")).toBe("1,235");
    expect(f(1234567, '0.0,,"M"')).toBe("1.2M");
    expect(f(12345.678, "0.00E+00")).toBe("1.23E+04");
    expect(f(-5, "0;(0)")).toBe("(5)");
    expect(f(0, '0;-0;"zero"')).toBe("zero");
    expect(f(-5, "[Red]0;[Blue]-0")).toBe("-5");
    expect(f(1.5, "# ?/?")).toBe("1 1/2");
    expect(f(0.333, "?/?")).toBe("1/3");
    expect(f(5551234567, "(000) 000-0000")).toBe("(555) 123-4567");
    expect(f(1234.5, '"$"#,##0.00')).toBe("$1,234.50");
    expect(f(3.14159, "0.##")).toBe("3.14");
    expect(f(3, "0.##")).toBe("3.");
    expect(f("abc", '0;0;0;"Text: "@')).toBe("Text: abc");
    expect(formatValue(-5, "[Red]0;[Red]-0").color).toBe("#FF0000");
  });
  it("formats dates and times", () => {
    expect(f(45293, "m/d/yyyy")).toBe("1/2/2024");
    expect(f(45293, "yyyy-mm-dd")).toBe("2024-01-02");
    expect(f(45293, "d-mmm-yy")).toBe("2-Jan-24");
    expect(f(45293.75, "h:mm AM/PM")).toBe("6:00 PM");
    expect(f(45293.5, "hh:mm:ss")).toBe("12:00:00");
    expect(f(1.25, "[h]:mm")).toBe("30:00");
    expect(f(0.000694444, "mm:ss")).toBe("01:00");
    expect(f(45293, "mmmm")).toBe("January");
    expect(f(45293, "ddd")).toBe("Tue");
  });
  it("shows General like Excel", () => {
    expect(f(1 / 3, "General")).toBe("0.333333333");
    expect(f(123456789012, "General")).toBe("1.23457E+11");
    expect(f(0.1 + 0.2, "General")).toBe("0.3");
    expect(f(1e-10, "General")).toBe("1E-10");
  });
  it("changes decimals", () => {
    expect(changeDecimals("0.00", 1, true)).toBe("0.000");
    expect(changeDecimals("#,##0.00", 1, false)).toBe("#,##0.0");
    expect(changeDecimals("General", 1.5, true)).toBe("0.00");
  });
});

describe("dates", () => {
  it("has Excel's 1900 leap year", () => {
    expect(dateSerial(1900, 1, 1)).toBe(1);
    expect(dateSerial(1900, 2, 28)).toBe(59);
    expect(dateSerial(1900, 3, 1)).toBe(61);
    expect(dateParts(60)).toMatchObject({ year: 1900, month: 2, day: 29 });
    expect(parseDate("Jan 5, 2024")).toBe(45296);
    expect(parseDate("2024-01-05 12:00")).toBe(45296.5);
  });
});

describe("fill and paste", () => {
  it("continues series", () => {
    const { wb, sheet, at } = book({ A1: "1", A2: "3", B1: "Mon", C1: "Item 1", D1: "=A1*2", E1: "Jan" });
    autofill(wb, sheet, { r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 4, c2: 0 });
    expect([at("A3"), at("A4"), at("A5")]).toEqual([5, 7, 9]);
    autofill(wb, sheet, { r1: 0, c1: 1, r2: 0, c2: 5 }, { r1: 0, c1: 1, r2: 2, c2: 5 });
    expect([at("B2"), at("B3")]).toEqual(["Tue", "Wed"]);
    expect(at("C3")).toBe("Item 3");
    expect(wb.editText(sheet, 2, 3)).toBe("=A3*2");
    expect(at("E2")).toBe("Feb");
  });
  it("copies formulas relative to where they land", () => {
    const { wb, sheet, at } = book({ A1: "1", A2: "2", B1: "=A1*10" });
    const { clip } = copyArea(wb, sheet, { r1: 0, c1: 1, r2: 0, c2: 1 });
    paste(wb, sheet, { r1: 1, c1: 1, r2: 1, c2: 1 }, clip);
    expect(wb.editText(sheet, 1, 1)).toBe("=A2*10");
    expect(at("B2")).toBe(20);
    paste(wb, sheet, { r1: 4, c1: 4, r2: 4, c2: 4 }, parseTsv("1\t2\n=E5+F5\t'x"));
    expect(at("E6")).toBe(3);
    expect(at("F6")).toBe("x");
  });
});
