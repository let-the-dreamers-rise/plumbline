import { describe, expect, it } from "vitest";
import { describeShape } from "./probe.js";

describe("describeShape", () => {
  const sample = {
    email: "ash@example.com",
    invoices: [{ id: "inv_123", amount: "4.98", hours: 2, paid: true }],
  };
  const out = describeShape(sample).join("\n");

  it("masks identity strings", () => {
    expect(out).not.toContain("ash@example.com");
    expect(out).not.toContain("inv_123");
    expect(out).toContain("<string len 15>");
  });
  it("shows price-like values", () => {
    expect(out).toContain('amount: "4.98"');
    expect(out).toContain("hours: 2");
    expect(out).toContain("paid: <boolean>");
  });
  it("summarizes arrays by their first item", () => {
    expect(out).toContain("invoices: [1 items]");
    expect(describeShape([])).toEqual(["[0 items]"]);
  });
  it("stops at max depth", () => {
    expect(describeShape({ a: { b: 1 } }, "", 0, 0).join("\n")).toContain("...");
  });
});
