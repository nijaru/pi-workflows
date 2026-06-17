import { describe, test, expect } from "bun:test";
import { parseScript, enrichSyntaxError } from "./index";

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
      expect(mod.createWorkflowStatusTool).toBeTypeOf("function");
      expect(mod.getRunStatus).toBeTypeOf("function");
      expect(mod.enrichSyntaxError).toBeTypeOf("function");
    });
  });

  describe("enrichSyntaxError", () => {
    test("maps V8 line number back to script body with context", () => {
      const body = `const x = 1;\nconst y = 2;\nconst result = agent("review", { task: "missing paren"\nconst z = 3;`;
      // Prelude = 6 lines, async wrapper = 1 line → body starts at V8 line 8
      // Error on body line 3 → V8 reports line 10 (6 + 1 + 3)
      const err = new SyntaxError("missing ) after argument list");
      err.stack = `SyntaxError: missing ) after argument list\n    at test.js:10:50`;
      const enriched = enrichSyntaxError(err, body, "test");
      expect(enriched.message).toContain("missing ) after argument list");
      expect(enriched.message).toContain("at test.js:3:50");
      expect(enriched.message).toContain(">>> 3:");
      expect(enriched.message).toContain("const result = agent");
    });

    test("returns original error if stack has no line info", () => {
      const err = new SyntaxError("bad syntax");
      err.stack = "SyntaxError: bad syntax";
      const enriched = enrichSyntaxError(err, "body", "test");
      expect(enriched.message).toBe("bad syntax");
    });
  });
});
