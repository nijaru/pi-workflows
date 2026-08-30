import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileWorkflow, parseScript, PlanError } from "./plan";
import { executePlan } from "./scheduler";
import type { ExecutionBackend, ExecutionHandle, ExecutionResult } from "./executor";
import { RunStore } from "./store";

function tempDir(): string { return mkdtempSync(join(tmpdir(), "pi-workflows-") ); }
function fakeBackend(responses: Record<string, string> = {}): ExecutionBackend {
  return {
    id: "fake",
    toolIdentity: "fake",
    contextIdentity: "test",
    start(spec, _prompt, _context): ExecutionHandle {
      const result: ExecutionResult = { text: responses[spec.id] ?? JSON.stringify({ id: spec.id, ok: true }), usage: { input: 1, output: 2, total: 3, cost: 0 }, hadToolActivity: spec.effect === "write" };
      return { id: spec.id, nodeId: spec.id, backendId: "fake", promise: Promise.resolve(result), abort: async () => undefined };
    },
  };
}

const base = (body: string) => `export const meta = { name: "test", description: "Test workflow" };\n${body}`;

describe("workflow plan compiler", () => {
  test("builds a serializable graph without executing agents", () => {
    const plan = compileWorkflow(base(`const one = agent({ id: "one", prompt: "inspect", effect: "read" });\nconst two = agent({ id: "two", prompt: "summarize", needs: [one], effect: "read", output: { schema: { type: "object", required: ["ok"] } } });\nreturn two;`));
    expect(plan.nodes.map(node => node.id)).toEqual(["one", "two"]);
    expect(plan.nodes[1]?.needs).toEqual(["one"]);
    expect(plan.resultIds).toEqual(["two"]);
  });

  test("parallel and pipeline express dependencies", () => {
    const plan = compileWorkflow(base(`const a = agent({ id: "a", prompt: "a", effect: "read" });\nconst b = agent({ id: "b", prompt: "b", effect: "read" });\nconst c = agent({ id: "c", prompt: "c", effect: "read" });\nparallel([a, b]);\npipeline([[a, b], [c]]);\nreturn c;`));
    expect(plan.nodes.find(node => node.id === "c")?.needs).toEqual(["a", "b"]);
  });

  test("rejects duplicate IDs, missing dependencies, and cycles", () => {
    expect(() => compileWorkflow(base(`agent({ id: "x", prompt: "x" }); agent({ id: "x", prompt: "x" });`))).toThrow("Duplicate agent id");
    expect(() => compileWorkflow(base(`agent({ id: "x", prompt: "x", needs: [{ id: "missing" }] });`))).toThrow("not a task reference");
    expect(() => compileWorkflow(base(`const x = agent({ id: "x", prompt: "x", needs: ["missing"] }); return x;`))).toThrow("task reference");
  });

  test("parses literal metadata without evaluating it and blocks nondeterminism", () => {
    expect(parseScript(`// header\nexport const meta = { name: "x", description: "y", phases: [{ title: "one" }] };\n`).meta.name).toBe("x");
    expect(() => parseScript(base("Date.now();"))).toThrow("deterministic");
    expect(() => parseScript(base("Math.random();"))).toThrow("deterministic");
    expect(() => parseScript(base("new Date();"))).toThrow("deterministic");
    expect(() => parseScript(`const x = true;\nexport const meta = { name: "x", description: "y" };`)).toThrow("start");
  });
});

describe("durable scheduler", () => {
  test("runs fan-out and fan-in with dependency outputs", async () => {
    const cwd = tempDir();
    try {
      const plan = compileWorkflow(base(`const a = agent({ id: "a", prompt: "a", effect: "read", output: { schema: { type: "object", required: ["id"] } } });\nconst b = agent({ id: "b", prompt: "b", effect: "read", output: { schema: { type: "object", required: ["id"] } } });\nconst c = agent({ id: "c", prompt: "join", needs: [a, b], effect: "read" });\nreturn c;`));
      const result = await executePlan({ cwd, runId: "run-fan-in", args: null, plan, planHash: "hash", backend: fakeBackend({ a: '{"id":"a"}', b: '{"id":"b"}', c: "joined" }), maxAgents: 2 });
      expect(result.status).toBe("completed");
      expect(result.outputs.c).toBe("joined");
      const state = new RunStore(cwd, "run-fan-in").load();
      expect(Object.values(state.nodes).every(node => node.status === "succeeded")).toBe(true);
      expect(state.usage.total).toBe(9);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("retries invalid structured output and persists attempts", async () => {
    const cwd = tempDir(); let calls = 0;
    const backend = fakeBackend({ x: '{"bad":true}' });
    const retryBackend: ExecutionBackend = { ...backend, start(spec, prompt, context) { calls++; return calls === 1 ? backend.start(spec, prompt, context) : { id: spec.id, nodeId: spec.id, backendId: "fake", promise: Promise.resolve({ text: '{"ok":true}', usage: { input: 1, output: 1, total: 2, cost: 0 }, hadToolActivity: false }), abort: async () => undefined }; } };
    try {
      const plan = compileWorkflow(base(`return agent({ id: "x", prompt: "x", effect: "read", output: { schema: { type: "object", required: ["ok"] }, maxRetries: 1 } });`));
      const result = await executePlan({ cwd, runId: "run-retry", args: null, plan, planHash: "hash", backend: retryBackend });
      expect(result.status).toBe("completed"); expect(calls).toBe(2); expect(result.outputs.x).toEqual({ ok: true });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("pause is durable and explicit resume continues the run", async () => {
    const cwd = tempDir();
    try {
      const plan = compileWorkflow(base(`return agent({ id: "x", prompt: "x", effect: "read" });`));
      const store = new RunStore(cwd, "run-pause");
      store.create(plan, null, { planHash: "hash" });
      writeFileSync(join(store.directory, "paused"), "pause", { mode: 0o600 });
      await expect(executePlan({ cwd, runId: "run-pause", args: null, plan, planHash: "hash", backend: fakeBackend() })).rejects.toThrow("paused");
      expect(new RunStore(cwd, "run-pause").load().status).toBe("paused");
      const result = await executePlan({ cwd, runId: "run-pause", args: null, plan, planHash: "hash", resume: true, backend: fakeBackend() });
      expect(result.status).toBe("completed");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
