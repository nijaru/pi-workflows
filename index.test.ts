import { describe, test, expect } from "bun:test";
import { parseScript } from "./index";

describe("pi-workflows", () => {
  describe("parseScript", () => {
    test("parses valid meta export", () => {
      const { meta, body } = parseScript(`
export const meta = { name: "test", description: "A test", phases: [{ title: "Phase 1" }] };
await agent("Do something", { label: "test" });
`);
      expect(meta.name).toBe("test");
      expect(meta.description).toBe("A test");
      expect(meta.phases).toHaveLength(1);
      expect(meta.phases?.[0]?.title).toBe("Phase 1");
      expect(body).toContain("await agent");
    });

    test("rejects missing meta", () => {
      expect(() => parseScript(`log("hi")`)).toThrow("meta");
    });

    test("rejects Date.now()", () => {
      expect(() => parseScript(`
export const meta = { name: "t", description: "t" };
Date.now();
`)).toThrow("deterministic");
    });

    test("rejects Math.random()", () => {
      expect(() => parseScript(`
export const meta = { name: "t", description: "t" };
Math.random();
`)).toThrow("deterministic");
    });

    test("rejects new Date() without args", () => {
      expect(() => parseScript(`
export const meta = { name: "t", description: "t" };
new Date();
`)).toThrow("deterministic");
    });

    test("allows explicit dates", () => {
      const { meta } = parseScript(`
export const meta = { name: "t", description: "t" };
const d = new Date("2024-01-01");
`);
      expect(meta.name).toBe("t");
    });
  });

  describe("extension module", () => {
    test("exports expected functions", async () => {
      const mod = await import("./index");
      expect(mod.default).toBeTypeOf("function");
      expect(mod.executeWorkflow).toBeTypeOf("function");
      expect(mod.parseScript).toBeTypeOf("function");
      expect(mod.createWorkflowTool).toBeTypeOf("function");
    });
  });
});
