import { describe, expect, it } from "vitest";
import { actionArea, readsOnly } from "./AiPanel";

describe("the AI panel", () => {
  it("runs only queries that read", () => {
    expect(readsOnly("select * from data")).toBe(true);
    expect(readsOnly("  -- top plans\nWITH t AS (select 1) SELECT * FROM t")).toBe(true);
    expect(readsOnly("select 'drop table x' as words")).toBe(true); // words in strings are not statements
    expect(readsOnly("delete from data")).toBe(false);
    expect(readsOnly("select 1; drop table data")).toBe(false);
    expect(readsOnly("with gone as (delete from t returning *) select * from gone")).toBe(false);
    expect(readsOnly("create table x as select 1")).toBe(false);
    expect(readsOnly("update t set a = 1")).toBe(false);
  });

  it("names the cells an answer writes", () => {
    expect(actionArea({ type: "cells", sheet: "", start: "B2", values: [["1"]] })).toBe("B2");
    expect(actionArea({ type: "cells", sheet: "", start: "Y9", values: [["a", "b", "c"], ["d"]] })).toBe("Y9:AA10");
  });
});
