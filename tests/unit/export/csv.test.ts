import { describe, expect, it } from "vitest";
import { csvCell, csvText } from "@/domain/export/csv";

const BOM = String.fromCharCode(0xfeff);
const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);

describe("csvCell", () => {
  it("neutralises cells that would run as formulas", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("+1+1")).toBe("'+1+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@cmd")).toBe("'@cmd");
  });

  it("neutralises formulas after leading whitespace and control characters", () => {
    expect(csvCell("  +1+1")).toBe("'  +1+1");
    expect(csvCell(`${TAB}=1`)).toBe(`'${TAB}=1`);
    expect(csvCell(`${NUL}=1`)).toBe(`'${NUL}=1`);
  });

  it("leaves ordinary text alone", () => {
    expect(csvCell("Coral Bay Academy")).toBe("Coral Bay Academy");
    expect(csvCell("a-b")).toBe("a-b");
  });

  it("passes numbers through untouched when marked numeric", () => {
    expect(csvCell(-3, true)).toBe("-3");
    expect(csvCell(12.5, true)).toBe("12.5");
  });

  it("quotes text with commas, quotes or line breaks", () => {
    expect(csvCell("Bay, Coral")).toBe('"Bay, Coral"');
    expect(csvCell('Say "hi"')).toBe('"Say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
  });

  it("renders null and undefined as empty", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
});

describe("csvText", () => {
  it("starts with a BOM, uses CRLF and ends with a line break", () => {
    const out = csvText(["text", "number"], [["=SUM(A1)", 12]]);
    expect(out.startsWith(BOM)).toBe(true);
    expect(out).toBe(`${BOM}text,number\r\n'=SUM(A1),12\r\n`);
  });

  it("keeps negative numbers numeric but guards negative-looking text", () => {
    const out = csvText(["a", "b"], [[-2, "-2"]]);
    expect(out).toContain("-2,'-2");
  });

  it("leaves missing values blank", () => {
    expect(csvText(["a", "b", "c"], [[null, undefined, "x"]])).toBe(`${BOM}a,b,c\r\n,,x\r\n`);
  });

  it("does not treat NaN or Infinity as numeric", () => {
    expect(csvText(["a"], [[Number.NaN]])).toBe(`${BOM}a\r\nNaN\r\n`);
  });
});
