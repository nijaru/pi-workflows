import { describe, test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeWorkflow, getRunStatus, parseScript, enrichSyntaxError, suggestSyntaxFix, validateSyntax } from "./index";

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

    test("does not evaluate meta expressions", () => {
      delete (globalThis as any).__workflowMetaProbe;
      expect(() => parseScript(`export const meta = { name: (globalThis.__workflowMetaProbe = true), description: "t" };`)).toThrow("Invalid meta object");
      expect((globalThis as any).__workflowMetaProbe).toBeUndefined();
    });

    test("requires meta to be the first statement", () => {
      expect(() => parseScript(`const ignored = true;\nexport const meta = { name: "t", description: "t" };`)).toThrow("Script must start");
      expect(parseScript(`// workflow header\n/* more context */\nexport const meta = { name: "t", description: "t" };`).meta.name).toBe("t");
    });

    test("does not reject deterministic calls inside prompt strings or regex literals", () => {
      expect(() => parseScript(`
export const meta = { name: "t", description: "t" };
const pattern = /Date\\.now\\(\\)/;
await agent("Do not call Date.now() or Math.random()", { label: "test" });
`)).not.toThrow();
      expect(() => parseScript(`
export const meta = { name: "t", description: "t" };
const value = 1 / Date.now();
`)).toThrow("deterministic");
    });
  });

  describe("runtime safety and persistence", () => {
    test("rejects sandbox escape attempts", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      try {
        const script = `export const meta = { name: "sandbox", description: "test" };\nawait globalThis.constructor?.constructor("return process")();`;
        await expect(executeWorkflow(script, { cwd, runId: "run-sandbox", timeoutMs: 1000 })).rejects.toThrow("Code generation from strings disallowed");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("pause markers stop execution and path traversal is rejected", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      try {
        const runDir = join(cwd, ".pi", "workflows", "run-paused");
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, "paused"), "now");
        const script = `export const meta = { name: "paused", description: "test" };\nawait agent("never runs");`;
        await expect(executeWorkflow(script, { cwd, runId: "run-paused" })).rejects.toThrow("Workflow paused");
        expect(getRunStatus(cwd, "../outside")).toBeNull();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("status reports terminal markers with precedence", () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      try {
        const runDir = join(cwd, ".pi", "workflows", "run-status");
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, "meta.json"), JSON.stringify({ name: "status", description: "test", createdAt: 1 }));
        writeFileSync(join(runDir, "error.log"), "failed");
        writeFileSync(join(runDir, "complete.log"), "{}");
        expect(getRunStatus(cwd, "run-status")).toMatchObject({ status: "completed" });
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("reports dead coordinators as orphaned", () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      try {
        const runDir = join(cwd, ".pi", "workflows", "run-orphaned");
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, "meta.json"), JSON.stringify({ name: "orphaned", description: "test", createdAt: 1 }));
        writeFileSync(join(runDir, "run.lock"), JSON.stringify({ pid: 99999999, token: "dead" }));
        expect(getRunStatus(cwd, "run-orphaned")).toMatchObject({ status: "orphaned" });
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("does not double-count usage after a journaled call reports a terminal event", () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      try {
        const runDir = join(cwd, ".pi", "workflows", "run-usage");
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, "meta.json"), JSON.stringify({ name: "usage", description: "test", createdAt: 1 }));
        const usage = { input: 3, output: 7, total: 10, cost: 0.25 };
        writeFileSync(join(runDir, "journal.jsonl"), JSON.stringify({ index: 0, hash: "h", result: "ok", tokens: usage, durationMs: 1 }) + "\n");
        writeFileSync(join(runDir, "events.jsonl"), [
          JSON.stringify({ type: "started", index: 0, label: "a" }),
          JSON.stringify({ type: "failed", index: 0, label: "a", usage }),
          JSON.stringify({ type: "cached", index: 0, label: "a" }),
        ].join("\n") + "\n");
        expect(getRunStatus(cwd, "run-usage")).toMatchObject({ tokenUsage: usage, progress: { running: 0, completed: 0, failed: 0, cached: 1 } });
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("uses the internal worker backend and fingerprints its identity", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      const calls: Array<{ label: string; maxOutputTokens?: number; tools?: string[] }> = [];
      const usage: Array<{ total: number }> = [];
      const states: Array<{ runId: string; status: string }> = [];
      try {
        const runtime = {
          workerBackend: {
            id: "test-worker",
            toolIdentity: "read",
            contextIdentity: "test-context",
            run: async (request: { label: string; maxOutputTokens?: number; tools?: string[] }) => {
              calls.push({ label: request.label, maxOutputTokens: request.maxOutputTokens, tools: request.tools });
              return { text: `done:${request.label}`, tokens: { input: 1, output: 2, total: 3, cost: 0 } };
            },
          },
          executionEnvelope: {
            onUsage: (value: { total: number }) => usage.push({ total: value.total }),
            onState: (value: { runId: string; status: string }) => states.push(value),
          },
        } as any;
        const script = `export const meta = { name: "backend", description: "test" };\nreturn await agent("do it", { label: "leaf", effect: "read" });`;
        const result = await executeWorkflow(script, { cwd, runId: "run-backend", runtime, tokenBudget: 20000 });
        expect(result.result).toBe("done:leaf");
        expect(calls).toEqual([{ label: "leaf", maxOutputTokens: 8192, tools: ["read", "grep", "find", "ls"] }]);
        expect(usage).toEqual([{ total: 3 }]);
        expect(states).toEqual([{ runId: "run-backend", status: "completed" }]);
        expect(getRunStatus(cwd, "run-backend")).toMatchObject({ status: "completed" });
        const meta = JSON.parse(readFileSync(join(cwd, ".pi", "workflows", "run-backend", "meta.json"), "utf8"));
        expect(meta.executionPolicy.workerBackend).toBe("test-worker");
        expect(meta.executionPolicy.workspaceIdentity).toMatch(/^path:/);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("validates structured output and retries only read effects", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      const prompts: string[] = [];
      try {
        const runtime = {
          workerBackend: {
            id: "structured-worker",
            toolIdentity: "read",
            contextIdentity: "test-context",
            run: async (request: { prompt: string }) => {
              prompts.push(request.prompt);
              return { text: prompts.length === 1 ? "not-json" : '{"ok":true}', tokens: { input: 1, output: 1, total: 2, cost: 0 } };
            },
          },
        } as any;
        const script = `export const meta = { name: "structured", description: "test" };\nreturn await agent("inspect", { label: "structured", effect: "read", output: { schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } } });`;
        const result = await executeWorkflow(script, { cwd, runId: "run-structured", runtime, tokenBudget: 20000 });
        expect(result.result).toEqual({ ok: true });
        expect(prompts).toHaveLength(2);
        expect(prompts[1]).toContain("Previous response failed validation");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("does not retry invalid structured output for write effects", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      let calls = 0;
      try {
        const runtime = {
          workerBackend: {
            id: "write-worker",
            toolIdentity: "write",
            contextIdentity: "test-context",
            run: async () => {
              calls++;
              return { text: "not-json", tokens: { input: 1, output: 1, total: 2, cost: 0 } };
            },
          },
        } as any;
        const script = `export const meta = { name: "write-structured", description: "test" };\nreturn await agent("write", { label: "write", output: { schema: { type: "object" } } });`;
        await expect(executeWorkflow(script, { cwd, runId: "run-write-structured", runtime, tokenBudget: 20000 })).rejects.toThrow("Structured output validation failed");
        expect(calls).toBe(1);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("enforces additionalProperties false without declared properties", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      try {
        const runtime = {
          workerBackend: {
            id: "schema-worker",
            toolIdentity: "read",
            contextIdentity: "test-context",
            run: async () => ({ text: '{"unexpected":true}', tokens: { input: 1, output: 1, total: 2, cost: 0 } }),
          },
        } as any;
        const script = `export const meta = { name: "schema-properties", description: "test" };\nreturn await agent("inspect", { effect: "read", output: { schema: { type: "object", additionalProperties: false }, maxRetries: 0 } });`;
        await expect(executeWorkflow(script, { cwd, runId: "run-schema-properties", runtime, tokenBudget: 20000 })).rejects.toThrow("Structured output validation failed");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("rejects concurrent canonical writes", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      try {
        const runtime = {
          workerBackend: {
            id: "slow-worker",
            toolIdentity: "write",
            contextIdentity: "test-context",
            run: async () => {
              await new Promise(resolve => setTimeout(resolve, 20));
              return { text: "done", tokens: { input: 1, output: 1, total: 2, cost: 0 } };
            },
          },
        } as any;
        const script = `export const meta = { name: "parallel-writes", description: "test" };\nawait parallel([() => agent("a"), () => agent("b")]);`;
        await expect(executeWorkflow(script, { cwd, runId: "run-parallel-writes", runtime })).rejects.toThrow("Parallel write agents require isolation");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("rejects canonical writes from concurrent workflow runs", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      let release!: () => void;
      let markStarted!: () => void;
      const started = new Promise<void>(resolve => { markStarted = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      try {
        const runtime = {
          workerBackend: {
            id: "cross-run-write-worker",
            toolIdentity: "write",
            contextIdentity: "test-context",
            run: async () => {
              markStarted();
              await gate;
              return { text: "done", tokens: { input: 1, output: 1, total: 2, cost: 0 } };
            },
          },
        } as any;
        const script = `export const meta = { name: "cross-run-writes", description: "test" };\nreturn await agent("write");`;
        const first = executeWorkflow(script, { cwd, runId: "run-cross-one", runtime });
        await started;
        await expect(executeWorkflow(script, { cwd, runId: "run-cross-two", runtime })).rejects.toThrow("Parallel write agents require isolation");
        release();
        await first;
      } finally {
        release();
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("worktree merges ignore workflow state files in an unignored repository", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
        execFileSync("git", ["config", "user.name", "pi-workflows-test"], { cwd });
        writeFileSync(join(cwd, "base.txt"), "base\n");
        execFileSync("git", ["add", "base.txt"], { cwd });
        execFileSync("git", ["commit", "-qm", "init"], { cwd });
        const workspace = join(cwd, "subdir");
        mkdirSync(workspace);
        writeFileSync(join(workspace, "placeholder.txt"), "placeholder\n");
        execFileSync("git", ["add", "subdir/placeholder.txt"], { cwd });
        execFileSync("git", ["commit", "-qm", "workspace"], { cwd });
        mkdirSync(join(cwd, "other/.pi/workflows"), { recursive: true });
        mkdirSync(join(cwd, "other/.pi/worktrees"), { recursive: true });
        writeFileSync(join(cwd, "other/.pi/workflows/other.lock"), "workflow state\n");
        const runtime = {
          workerBackend: {
            id: "git-worktree-worker",
            toolIdentity: "write",
            contextIdentity: "test-context",
            run: async (request: { cwd: string }) => {
              writeFileSync(join(request.cwd, "created.txt"), "created\n");
              return { text: "done", tokens: { input: 1, output: 1, total: 2, cost: 0 } };
            },
          },
        } as any;
        const script = `export const meta = { name: "git-worktree", description: "test" };\nreturn await agent("write", { isolation: "worktree" });`;
        await executeWorkflow(script, { cwd: workspace, runId: "run-git-worktree", runtime });
        expect(readFileSync(join(workspace, "created.txt"), "utf8")).toBe("created\n");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("direct execution records completion and hides host globals", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      try {
        const script = `export const meta = { name: "direct", description: "test" };\nif (typeof process !== "undefined" || typeof SharedArrayBuffer !== "undefined" || typeof Atomics !== "undefined") throw new Error("host global leaked");\nreturn { ok: true };`;
        const result = await executeWorkflow(script, { cwd, runId: "run-direct", timeoutMs: 1000 });
        expect(result.result).toEqual({ ok: true });
        expect(getRunStatus(cwd, "run-direct")).toMatchObject({ status: "completed", result: { result: { ok: true } } });
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
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
      // Prelude = 3 lines, async wrapper = 1 line → body line 3 is V8 line 7.
      const err = new SyntaxError("missing ) after argument list");
      err.stack = `SyntaxError: missing ) after argument list\n    at test.js:7:50`;
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

  describe("suggestSyntaxFix", () => {
    test("detects unbalanced parentheses", () => {
      const body = `const x = agent("test", { label: "test" }`;
      const tip = suggestSyntaxFix("missing ) after argument list", body);
      expect(tip).toContain("Unbalanced parentheses");
      expect(tip).toContain("1 opening vs 0 closing");
    });

    test("detects odd backtick count", () => {
      const body = "const x = `template literal without close";
      const tip = suggestSyntaxFix("missing ) after argument list", body);
      expect(tip).toContain("Odd number of backticks");
    });

    test("detects unbalanced braces on unexpected end of input", () => {
      const body = "const x = { a: 1, b: 2";
      const tip = suggestSyntaxFix("Unexpected end of input", body);
      expect(tip).toContain("Unbalanced braces");
    });

    test("returns empty string when no heuristic matches", () => {
      const tip = suggestSyntaxFix("some other error", "const x = 1;");
      expect(tip).toBe("");
    });

    test("returns empty string for balanced code", () => {
      const body = 'const x = agent(`test`, { label: "x" });';
      const tip = suggestSyntaxFix("missing ) after argument list", body);
      const hasParensTip = tip.includes("Unbalanced parentheses");
      const hasBacktickTip = tip.includes("backtick");
      expect(hasParensTip || tip === "").toBe(true);
      expect(hasBacktickTip).toBe(false);
    });
  });

  describe("validateSyntax", () => {
    test("returns null for valid script body", () => {
      const body = 'await agent("do work", { label: "worker" });';
      expect(validateSyntax(body, "test")).toBeNull();
    });

    test("catches missing close paren (eagerly, unlike vm.Script)", () => {
      const body = 'const x = agent("test"';
      const err = validateSyntax(body, "test");
      expect(err).not.toBeNull();
      expect(err instanceof SyntaxError).toBe(true);
    });

    test("catches unterminated template literal", () => {
      const body = "const x = agent(`unterminated prompt";
      const err = validateSyntax(body, "test");
      expect(err).not.toBeNull();
    });

    test("catches unbalanced braces", () => {
      const body = 'const x = { a: 1, b: [1, 2';
      const err = validateSyntax(body, "test");
      expect(err).not.toBeNull();
    });
  });
});
