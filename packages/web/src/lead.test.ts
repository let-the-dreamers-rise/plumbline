import { describe, expect, it } from "vitest";
import { bodyKind, leadRedirect, parseLead } from "./lead.js";

const NOW = 1_791_600_000;
const FORM = "application/x-www-form-urlencoded";

describe("bodyKind", () => {
  it("recognises JSON and form posts, with or without parameters", () => {
    expect(bodyKind("application/json")).toBe("json");
    expect(bodyKind("Application/JSON; charset=utf-8")).toBe("json");
    expect(bodyKind(FORM)).toBe("form");
    expect(bodyKind(`${FORM}; charset=UTF-8`)).toBe("form");
    expect(bodyKind("multipart/form-data; boundary=x")).toBeNull();
    expect(bodyKind(undefined)).toBeNull();
  });
});

describe("parseLead", () => {
  it("accepts the page script's JSON", () => {
    const raw = JSON.stringify({ email: " ops@fleet.io ", fleetGpus: 512, lender: "USD.AI", note: "Mumbai" });
    expect(parseLead(raw, "application/json", NOW)).toEqual({ ok: true, lead: { email: "ops@fleet.io", fleetGpus: 512, lender: "USD.AI", note: "Mumbai", at: NOW } });
  });

  it("accepts a no-JS urlencoded form post", () => {
    const raw = "email=ops%40fleet.io&fleetGpus=64&lender=GAIB&note=two+racks";
    expect(parseLead(raw, FORM, NOW)).toEqual({ ok: true, lead: { email: "ops@fleet.io", fleetGpus: 64, lender: "GAIB", note: "two racks", at: NOW } });
  });

  it("treats empty, negative, fractional and absurd fleet sizes sanely", () => {
    const fleet = (v: string) => {
      const r = parseLead(`email=a%40b.co&fleetGpus=${v}`, FORM, NOW);
      return r.ok ? r.lead.fleetGpus : null;
    };
    expect(fleet("")).toBe(0);
    expect(fleet("-3")).toBe(0);
    expect(fleet("abc")).toBe(0);
    expect(fleet("12.7")).toBe(12);
    expect(fleet("1e12")).toBe(10_000_000);
  });

  it("truncates long text fields and ignores non-string ones", () => {
    const r = parseLead(JSON.stringify({ email: "a@b.co", lender: "x".repeat(900), note: { nested: true } }), "application/json", NOW);
    expect(r.ok && r.lead.lender.length).toBe(500);
    expect(r.ok && r.lead.note).toBe("");
  });

  it("refuses a missing or malformed email", () => {
    for (const email of ["", "nobody", "a@b", "a b@c.io", `${"x".repeat(200)}@b.co`]) {
      expect(parseLead(JSON.stringify({ email }), "application/json", NOW)).toEqual({ ok: false, status: 400, error: "a valid email is needed" });
    }
    expect(parseLead("fleetGpus=4", FORM, NOW)).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses bodies that are not a JSON object, and unknown content types", () => {
    expect(parseLead("{not json", "application/json", NOW)).toEqual({ ok: false, status: 400, error: "body is not a JSON object" });
    expect(parseLead("null", "application/json", NOW)).toMatchObject({ ok: false, status: 400 });
    expect(parseLead('["a@b.co"]', "application/json", NOW)).toMatchObject({ ok: false, status: 400 });
    expect(parseLead("email=a%40b.co", "text/plain", NOW)).toEqual({ ok: false, status: 415, error: "send JSON or a form post" });
  });
});

describe("leadRedirect", () => {
  it("sends the visitor back to the page the form was on", () => {
    expect(leadRedirect("https://tessera.example/prove?x=1", "thanks")).toBe("/prove?lead=thanks#lead");
    expect(leadRedirect("https://tessera.example/", "error")).toBe("/?lead=error#lead");
  });

  it("never redirects off-site or to the API", () => {
    expect(leadRedirect(undefined, "thanks")).toBe("/?lead=thanks#lead");
    expect(leadRedirect("https://evil.example/phish", "thanks")).toBe("/phish?lead=thanks#lead");
    expect(leadRedirect("//evil.example/x", "thanks")).toBe("/x?lead=thanks#lead");
    expect(leadRedirect("https://tessera.example/api/lead", "thanks")).toBe("/?lead=thanks#lead");
    expect(leadRedirect("http://[bad", "thanks")).toBe("/?lead=thanks#lead");
  });
});
