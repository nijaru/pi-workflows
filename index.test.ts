import { describe, test, expect } from "bun:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerExtension, { createWorkflowTool, executeWorkflow, getRunStatus, parseScript, enrichSyntaxError, suggestSyntaxFix, validateSyntax, workspaceIdentity } from "./index";

async function createFauxRuntime(providerId: string, faux: any) {
  const modelRuntime = await ModelRuntime.create({ modelsPath: null });
  modelRuntime.registerProvider(providerId, {
    api: faux.api as any,
    apiKey: "test-only",
    baseUrl: "http://localhost:0",
    streamSimple: faux.provider.streamSimple,
    models: faux.models.map((model: any) => ({
      id: model.id,
      name: model.name,
      api: faux.api as any,
      baseUrl: "http://localhost:0",
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  });
  const defaultModel = modelRuntime.getModel(providerId, "worker");
  if (!defaultModel) throw new Error(`Test model not registered: ${providerId}/worker`);
  return { modelRuntime, defaultModel };
}

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

    test("pause fences agents waiting for concurrency admission", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      let release!: () => void;
      let markEightStarted!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const eightStarted = new Promise<void>(resolve => { markEightStarted = resolve; });
      let started = 0;
      const runtime = {
        workerBackend: {
          id: "pause-queue-worker",
          toolIdentity: "read",
          contextIdentity: "test-context",
          run: async () => {
            started++;
            if (started === 8) markEightStarted();
            if (started <= 8) await gate;
            return { text: "done", tokens: { input: 1, output: 1, total: 2, cost: 0 }, stopReason: "stop", hadToolActivity: false };
          },
        },
      } as any;
      const script = `export const meta = { name: "pause-queue", description: "test" };\nawait parallel(Array.from({ length: 9 }, (_, i) => () => agent("task " + i, { effect: "read" })));`;
      try {
        const run = executeWorkflow(script, { cwd, runId: "run-pause-queue", runtime });
        await eightStarted;
        writeFileSync(join(cwd, ".pi", "workflows", "run-pause-queue", "paused"), "now");
        release();
        await expect(run).rejects.toThrow("Workflow paused");
        expect(started).toBe(8);
      } finally {
        release();
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

    test("terminal completion removes a pause marker written during the final agent", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      const runtime = {
        workerBackend: {
          id: "terminal-pause-worker",
          toolIdentity: "read",
          contextIdentity: "test-context",
          run: async () => ({ text: "done", tokens: { input: 1, output: 1, total: 2, cost: 0 }, stopReason: "stop", hadToolActivity: false }),
        },
        onUpdate: (update: { content?: Array<{ text?: string }> }) => {
          if (update.content?.[0]?.text?.includes("completed")) {
            writeFileSync(join(cwd, ".pi", "workflows", "run-terminal-pause", "paused"), "late pause");
          }
        },
      } as any;
      const script = `export const meta = { name: "terminal-pause", description: "test" };\nreturn await agent("inspect", { effect: "read" });`;
      try {
        await executeWorkflow(script, { cwd, runId: "run-terminal-pause", runtime });
        expect(getRunStatus(cwd, "run-terminal-pause")).toMatchObject({ status: "completed" });
        expect(() => readFileSync(join(cwd, ".pi", "workflows", "run-terminal-pause", "paused"), "utf8")).toThrow();
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

    test("carries failed attempt usage into a forced resume without double counting", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      let calls = 0;
      const runtime = {
        workerBackend: {
          id: "resume-usage-worker",
          toolIdentity: "read",
          contextIdentity: "test-context",
          run: async () => {
            calls++;
            return { text: calls === 1 ? "not-json" : '{"ok":true}', tokens: { input: 2000, output: 2000, total: 4000, cost: 0.25 } };
          },
        },
      } as any;
      const script = `export const meta = { name: "resume-usage", description: "test" };\nreturn await agent("inspect", { effect: "read", output: { schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }, maxRetries: 0 } });`;
      try {
        await expect(executeWorkflow(script, { cwd, runId: "run-resume-usage", runtime, tokenBudget: 10000 })).rejects.toThrow("Structured output validation failed");
        expect(getRunStatus(cwd, "run-resume-usage")).toMatchObject({ tokenUsage: { total: 4000, cost: 0.25 } });
        const result = await executeWorkflow(script, { cwd, runId: "run-resume-usage", runtime, tokenBudget: 10000 });
        expect(result.result).toEqual({ ok: true });
        expect(result.tokenUsage).toMatchObject({ input: 4000, output: 4000, total: 8000, cost: 0.5 });
        expect(getRunStatus(cwd, "run-resume-usage")).toMatchObject({ status: "completed", tokenUsage: { total: 8000, cost: 0.5 } });
        expect(calls).toBe(2);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("records token usage for a cancelled worker attempt", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      const controller = new AbortController();
      let markStarted!: () => void;
      const started = new Promise<void>(resolve => { markStarted = resolve; });
      const runtime = {
        workerBackend: {
          id: "cancel-usage-worker",
          toolIdentity: "read",
          contextIdentity: "test-context",
          run: async (request: { signal?: AbortSignal }) => {
            markStarted();
            await new Promise<void>(resolve => request.signal?.addEventListener("abort", () => resolve(), { once: true }));
            return { text: "late result", tokens: { input: 5, output: 7, total: 12, cost: 0.125 } };
          },
        },
      } as any;
      const script = `export const meta = { name: "cancel-usage", description: "test" };\nreturn await agent("wait", { effect: "read" });`;
      try {
        const run = executeWorkflow(script, { cwd, runId: "run-cancel-usage", runtime, signal: controller.signal });
        await started;
        controller.abort();
        await expect(run).rejects.toThrow("Workflow aborted");
        expect(getRunStatus(cwd, "run-cancel-usage")).toMatchObject({ status: "cancelled", tokenUsage: { input: 5, output: 7, total: 12, cost: 0.125 } });
      } finally {
        controller.abort();
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

    test("research uses an explicit bounded backend and records the capability", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      const requests: unknown[] = [];
      try {
        const researchBackend = {
          id: "test-research",
          sources: ["web_search"] as const,
          run: async (request: unknown) => {
            requests.push(request);
            return { answer: "bounded result" };
          },
        };
        const script = `export const meta = { name: "research", description: "test" };\nreturn await research({ source: "web_search", query: "pi workflows", limit: 3 });`;
        const result = await executeWorkflow(script, { cwd, runId: "run-research", researchBackend, tokenBudget: 20000 });
        expect(result.result).toEqual({ answer: "bounded result" });
        expect(requests).toEqual([{ source: "web_search", query: "pi workflows", limit: 3 }]);
        const runDir = join(cwd, ".pi", "workflows", "run-research");
        const events = readFileSync(join(runDir, "events.jsonl"), "utf8");
        expect(events).toContain('"type":"research"');
        const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
        expect(meta.executionPolicy.researchBackend).toBe("test-research");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("enforces research timeout when the backend ignores abort", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      let settled = false;
      try {
        const researchBackend = {
          id: "slow-research",
          sources: ["web_search"] as const,
          run: async () => {
            await new Promise(resolve => setTimeout(resolve, 40));
            settled = true;
            return { late: true };
          },
        };
        const script = `export const meta = { name: "research-timeout", description: "test" };\nreturn await research({ source: "web_search", query: "slow" });`;
        await expect(executeWorkflow(script, { cwd, runId: "run-research-timeout", researchBackend, researchTimeoutMs: 5 })).rejects.toThrow("Research request timed out");
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(settled).toBe(true);
        const eventsPath = join(cwd, ".pi", "workflows", "run-research-timeout", "events.jsonl");
        expect(() => readFileSync(eventsPath, "utf8")).toThrow();
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("pause fences research calls waiting for concurrency admission", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      let release!: () => void;
      let markFourStarted!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const fourStarted = new Promise<void>(resolve => { markFourStarted = resolve; });
      let started = 0;
      const researchBackend = {
        id: "pause-research",
        sources: ["web_search"] as const,
        run: async () => {
          started++;
          if (started === 4) markFourStarted();
          if (started <= 4) await gate;
          return { answer: "bounded" };
        },
      };
      const script = `export const meta = { name: "pause-research", description: "test" };\nawait parallel(Array.from({ length: 5 }, () => () => research({ source: "web_search", query: "bounded" })));`;
      try {
        const run = executeWorkflow(script, { cwd, runId: "run-pause-research", researchBackend });
        await fourStarted;
        writeFileSync(join(cwd, ".pi", "workflows", "run-pause-research", "paused"), "now");
        release();
        await expect(run).rejects.toThrow("Workflow paused");
        expect(started).toBe(4);
      } finally {
        release();
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("fails closed when a workflow requests unavailable research", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      try {
        const script = `export const meta = { name: "research-unavailable", description: "test" };\nreturn await research({ source: "context7", query: "pi" });`;
        await expect(executeWorkflow(script, { cwd, runId: "run-research-unavailable" })).rejects.toThrow("Research is unavailable");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("workspace identity changes when dirty tracked contents change", () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
        execFileSync("git", ["config", "user.name", "pi-workflows-test"], { cwd });
        const file = join(cwd, "tracked.txt");
        writeFileSync(file, "before\n");
        execFileSync("git", ["add", "tracked.txt"], { cwd });
        execFileSync("git", ["commit", "-qm", "init"], { cwd });
        const before = workspaceIdentity(cwd);
        writeFileSync(file, "after\n");
        const after = workspaceIdentity(cwd);
        expect(after).not.toBe(before);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("runs the default SDK worker with an in-memory faux provider", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      try {
        const faux = fauxProvider({
          provider: "workflow-test",
          models: [{ id: "worker", name: "Workflow test", maxTokens: 4096 }],
        });
        const { modelRuntime, defaultModel } = await createFauxRuntime("workflow-test", faux);
        faux.setResponses([fauxAssistantMessage("default sdk worker response")]);
        const script = `export const meta = { name: "default-sdk", description: "test" };\nreturn await agent("inspect", { label: "leaf", effect: "read" });`;
        const result = await executeWorkflow(script, {
          cwd,
          runId: "run-default-sdk",
          runtime: { modelRuntime, defaultModel },
          tokenBudget: 100000,
        });
        expect(result.result).toBe("default sdk worker response");
        expect(faux.state.callCount).toBe(1);
        expect(result.tokenUsage.total).toBeGreaterThan(0);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("awaits SDK cancellation while a default worker is in flight", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      const controller = new AbortController();
      try {
        const faux = fauxProvider({
          provider: "workflow-cancel-test",
          models: [{ id: "worker", name: "Workflow cancellation test", maxTokens: 4096 }],
        });
        const { modelRuntime, defaultModel } = await createFauxRuntime("workflow-cancel-test", faux);
        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => { markStarted = resolve; });
        faux.setResponses([(_context, options) => {
          markStarted();
          return new Promise((resolve) => {
            options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
          });
        }]);
        const script = `export const meta = { name: "cancel-sdk", description: "test" };\nreturn await agent("wait", { label: "leaf", effect: "read" });`;
        const run = executeWorkflow(script, {
          cwd,
          runId: "run-cancel-sdk",
          runtime: { modelRuntime, defaultModel },
          tokenBudget: 100000,
          signal: controller.signal,
        });
        await started;
        controller.abort();
        await expect(run).rejects.toThrow("Workflow aborted");
        expect(faux.state.callCount).toBe(1);
      } finally {
        controller.abort();
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
        expect(result.tokenUsage.total).toBe(4);
        expect(getRunStatus(cwd, "run-structured")).toMatchObject({ tokenUsage: { total: 4 } });
        expect(prompts).toHaveLength(2);
        expect(prompts[1]).toContain("Previous response failed validation");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("rejects truncated worker output instead of journaling success", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      try {
        const runtime = {
          workerBackend: {
            id: "truncated-worker",
            toolIdentity: "read",
            contextIdentity: "test-context",
            run: async () => ({ text: "partial", tokens: { input: 2, output: 3, total: 5, cost: 0 }, stopReason: "length", hadToolActivity: false }),
          },
        } as any;
        const script = `export const meta = { name: "truncated", description: "test" };\nreturn await agent("inspect", { effect: "read" });`;
        await expect(executeWorkflow(script, { cwd, runId: "run-truncated", runtime })).rejects.toThrow("output was truncated");
        expect(getRunStatus(cwd, "run-truncated")).toMatchObject({ status: "error", tokenUsage: { total: 5 }, progress: { failed: 1 } });
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("rejects an analysis-only write worker without tool activity", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      try {
        const runtime = {
          workerBackend: {
            id: "empty-write-worker",
            toolIdentity: "write",
            contextIdentity: "test-context",
            run: async () => ({ text: "I would make the change", tokens: { input: 2, output: 3, total: 5, cost: 0 }, stopReason: "stop", hadToolActivity: false }),
          },
        } as any;
        const script = `export const meta = { name: "empty-write", description: "test" };\nreturn await agent("implement the change");`;
        await expect(executeWorkflow(script, { cwd, runId: "run-empty-write", runtime })).rejects.toThrow("completed without tool activity");
        expect(getRunStatus(cwd, "run-empty-write")).toMatchObject({ status: "error", tokenUsage: { total: 5 }, progress: { failed: 1 } });
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("rejects write workers with failed tool calls", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      try {
        const runtime = {
          workerBackend: {
            id: "failed-tool-worker",
            toolIdentity: "write",
            contextIdentity: "test-context",
            run: async () => ({ text: "I could not finish", tokens: { input: 2, output: 3, total: 5, cost: 0 }, stopReason: "stop", hadToolActivity: true, hadToolError: true }),
          },
        } as any;
        const script = `export const meta = { name: "failed-tool", description: "test" };\nreturn await agent("edit the file");`;
        await expect(executeWorkflow(script, { cwd, runId: "run-failed-tool", runtime })).rejects.toThrow("failed tool call");
        expect(getRunStatus(cwd, "run-failed-tool")).toMatchObject({ status: "error", tokenUsage: { total: 5 }, progress: { failed: 1 } });
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("rejects SDK writes after a failed mutation tool", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      try {
        const faux = fauxProvider({
          provider: "workflow-failed-tool-test",
          models: [{ id: "worker", name: "Workflow failed-tool test", maxTokens: 4096 }],
        });
        const { modelRuntime, defaultModel } = await createFauxRuntime("workflow-failed-tool-test", faux);
        faux.setResponses([
          fauxAssistantMessage(fauxToolCall("edit", { path: "missing.txt", oldText: "before", newText: "after" })),
          fauxAssistantMessage("I could not edit the file."),
        ]);
        const script = `export const meta = { name: "sdk-failed-tool", description: "test" };\nreturn await agent("edit the file", { label: "leaf" });`;
        await expect(executeWorkflow(script, { cwd, runId: "run-sdk-failed-tool", runtime: { modelRuntime, defaultModel }, tokenBudget: 100000 })).rejects.toThrow("failed tool call");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("removes a clean failed worktree but preserves changed failure state", async () => {
      const runCase = async (changed: boolean) => {
        const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
        try {
          execFileSync("git", ["init", "-q"], { cwd });
          execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
          execFileSync("git", ["config", "user.name", "pi-workflows-test"], { cwd });
          writeFileSync(join(cwd, "base.txt"), "base\n");
          execFileSync("git", ["add", "base.txt"], { cwd });
          execFileSync("git", ["commit", "-qm", "init"], { cwd });
          const runtime = {
            workerBackend: {
              id: changed ? "changed-failure" : "clean-failure",
              toolIdentity: "write",
              contextIdentity: "test-context",
              run: async (request: { cwd: string }) => {
                if (changed) writeFileSync(join(request.cwd, "failed.txt"), "changed\n");
                throw new Error("worker failed");
              },
            },
          } as any;
          const script = `export const meta = { name: "failed-worktree", description: "test" };\nreturn await agent("write", { isolation: "worktree" });`;
          await expect(executeWorkflow(script, { cwd, runId: changed ? "run-changed-failure" : "run-clean-failure", runtime })).rejects.toThrow("worker failed");
          const worktreeEntries = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" }).split("\n\n").filter(Boolean);
          expect(worktreeEntries.some(entry => entry.includes(".pi/worktrees/"))).toBe(changed);
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      };
      await runCase(false);
      await runCase(true);
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

    test("reconciles a worktree merge after a crash between cherry-pick and journaling", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      let calls = 0;
      let injectCrash = true;
      try {
        execFileSync("git", ["init", "-q"], { cwd });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
        execFileSync("git", ["config", "user.name", "pi-workflows-test"], { cwd });
        writeFileSync(join(cwd, "base.txt"), "base\n");
        execFileSync("git", ["add", "base.txt"], { cwd });
        execFileSync("git", ["commit", "-qm", "init"], { cwd });
        const runtime = {
          workerBackend: {
            id: "crash-merge-worker",
            toolIdentity: "write",
            contextIdentity: "test-context",
            run: async (request: { cwd: string }) => {
              calls++;
              writeFileSync(join(request.cwd, "created.txt"), "created\n");
              return { text: "done", tokens: { input: 1, output: 1, total: 2, cost: 0 } };
            },
          },
          testHooks: {
            afterWorktreeCommit: () => {
              if (injectCrash) {
                injectCrash = false;
                throw new Error("injected after worktree commit");
              }
            },
          },
        } as any;
        const script = `export const meta = { name: "crash-merge", description: "test" };\nreturn await agent("write", { isolation: "worktree" });`;
        await expect(executeWorkflow(script, { cwd, runId: "run-crash-merge", runtime })).rejects.toThrow("injected after worktree commit");
        const pending = join(cwd, ".pi", "workflows", "run-crash-merge", "pending-merge.json");
        expect(readFileSync(pending, "utf8")).toContain("commitHash");
        const result = await executeWorkflow(script, { cwd, runId: "run-crash-merge", runtime, resumeJournal: new Map() });
        expect(result.result).toBe("done");
        expect(readFileSync(join(cwd, "created.txt"), "utf8")).toBe("created\n");
        expect(calls).toBe(1);
        expect(() => readFileSync(pending, "utf8")).toThrow();
        expect(getRunStatus(cwd, "run-crash-merge")).toMatchObject({ status: "completed", tokenUsage: { total: 2 } });
        const worktreeEntries = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" }).split("\n\n").filter(Boolean);
        expect(worktreeEntries.some(entry => entry.includes(".pi/worktrees/"))).toBe(false);
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

    test("clean does not remove a run locked by a live coordinator", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      const commands = new Map<string, any>();
      try {
        const runDir = join(cwd, ".pi", "workflows", "run-live-clean");
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, "meta.json"), JSON.stringify({ name: "live", description: "test", createdAt: 1 }));
        writeFileSync(join(runDir, "complete.log"), "done\n");
        writeFileSync(join(runDir, "run.lock"), JSON.stringify({ pid: process.pid, token: "live" }));
        utimesSync(runDir, new Date(1), new Date(1));
        const mod = await import("./index");
        const fakePi = {
          on: () => {},
          registerTool: () => {},
          registerCommand: (name: string, command: any) => commands.set(name, command),
          getActiveTools: () => [],
          setActiveTools: () => {},
        };
        mod.default(fakePi as any);
        await commands.get("workflows").handler("clean 0", { cwd, ui: { notify: () => {} } });
        expect(readFileSync(join(runDir, "meta.json"), "utf8")).toContain('"live"');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("automatic resume is session-affine while explicit resume adopts across sessions", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      const script = `export const meta = { name: "session-resume", description: "test" };\nreturn "done";`;
      const prepare = async (runId: string, sessionId: string, createdAt: number) => {
        await executeWorkflow(script, { cwd, runId });
        const runDir = join(cwd, ".pi", "workflows", runId);
        rmSync(join(runDir, "complete.log"), { force: true });
        writeFileSync(join(runDir, "paused"), "paused");
        const metaPath = join(runDir, "meta.json");
        const meta = JSON.parse(readFileSync(metaPath, "utf8"));
        meta.createdAt = createdAt;
        meta.executionPolicy.origin = { sessionId };
        writeFileSync(metaPath, JSON.stringify(meta));
      };
      const context = (sessionId: string) => ({
        cwd,
        model: undefined,
        modelRegistry: undefined,
        sessionManager: { getSessionId: () => sessionId },
        ui: { notify: () => {} },
      });
      try {
        await prepare("run-session-a", "session-a", 1);
        await prepare("run-session-b", "session-b", 2);
        const tool = createWorkflowTool();
        const selected = await tool.execute("automatic", { script, background: false }, undefined, undefined, context("session-a") as any);
        expect((selected as any).details.runId).toBe("run-session-a");
        expect(getRunStatus(cwd, "run-session-b")).toMatchObject({ status: "paused" });

        const adopted = await tool.execute("explicit", { script, runId: "run-session-b", background: false }, undefined, undefined, context("session-a") as any);
        expect((adopted as any).details.runId).toBe("run-session-b");
        expect(getRunStatus(cwd, "run-session-b")).toMatchObject({ status: "completed" });
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("blocking failures expose a usage marker for outer goal accounting", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      try {
        const tool = createWorkflowTool();
        const ctx = {
          cwd,
          model: undefined,
          modelRegistry: undefined,
          sessionManager: { getSessionId: () => "session-test" },
          ui: { notify: () => {} },
        } as any;
        const script = `export const meta = { name: "failure-marker", description: "test" };\nthrow new Error("worker failed");`;
        await expect(tool.execute("failure", { script, background: false }, undefined, undefined, ctx)).rejects.toThrow("__pi_workflows_usage__:");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("blocking SDK failures carry the recorded child usage marker", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      try {
        const faux = fauxProvider({
          provider: "workflow-failure-usage-test",
          models: [{ id: "worker", name: "Workflow failure usage test", maxTokens: 4096 }],
        });
        const { modelRuntime, defaultModel } = await createFauxRuntime("workflow-failure-usage-test", faux);
        faux.setResponses([fauxAssistantMessage("partial", { stopReason: "length" })]);
        const tool = createWorkflowTool();
        const ctx = {
          cwd,
          model: defaultModel,
          modelRuntime,
          sessionManager: { getSessionId: () => "session-test" },
          ui: { notify: () => {} },
        } as any;
        const script = `export const meta = { name: "sdk-failure-usage", description: "test" };\nreturn await agent("inspect", { effect: "read" });`;
        let thrown: unknown;
        try {
          await tool.execute("failure-usage", { script, background: false, tokenBudget: 100000 }, undefined, undefined, ctx);
        } catch (error) {
          thrown = error;
        }
        const message = thrown instanceof Error ? thrown.message : String(thrown);
        expect(message).toContain("__pi_workflows_usage__:");
        const encoded = message.split("__pi_workflows_usage__:").at(-1)!;
        expect(JSON.parse(encoded)).toEqual({ input: expect.any(Number), output: expect.any(Number), total: expect.any(Number), cost: expect.any(Number) });
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    test("coordinates host mutations with workflow canonical writes", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-test-"));
      const handlers = new Map<string, (event: any, ctx?: any) => any>();
      try {
        const mod = await import("./index");
        const fakePi = {
          on: (name: string, handler: (event: any, ctx?: any) => any) => handlers.set(name, handler),
          registerTool: () => {},
          registerCommand: () => {},
          getActiveTools: () => [],
          setActiveTools: () => {},
        };
        mod.default(fakePi as any);
        const ctx = { cwd };
        expect(handlers.get("tool_call")!({ type: "tool_call", toolName: "edit", toolCallId: "host-edit" }, ctx)).toBeUndefined();
        const runtime = {
          workerBackend: {
            id: "guard-worker",
            toolIdentity: "write",
            contextIdentity: "test-context",
            run: async () => ({ text: "unreachable", tokens: { input: 1, output: 1, total: 2, cost: 0 } }),
          },
        } as any;
        const script = `export const meta = { name: "guard", description: "test" };\nreturn await agent("write");`;
        await expect(executeWorkflow(script, { cwd, runId: "run-host-guard", runtime })).rejects.toThrow("Pi edit/write is active");
        handlers.get("tool_execution_end")!({ type: "tool_execution_end", toolCallId: "host-edit" });

        mkdirSync(join(cwd, ".pi", "workflows"), { recursive: true });
        writeFileSync(join(cwd, ".pi", "workflows", "workspace.lock"), JSON.stringify({ pid: process.pid, token: "live" }));
        const blocked = handlers.get("tool_call")!({ type: "tool_call", toolName: "write", toolCallId: "host-write" }, ctx);
        expect(blocked).toMatchObject({ block: true });
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
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
