import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileWorkflow, parseScript, PlanError } from "./plan";
import { executePlan } from "./scheduler";
import { parseOutput, type ExecutionBackend, type ExecutionHandle, type ExecutionResult } from "./executor";
import { RunStore, emptyUsage, type JsonValue } from "./store";

function tempDir(): string { return mkdtempSync(join(tmpdir(), "pi-workflows-") ); }

/** Fresh Git repository with one commit, for worktree/merge recovery tests. */
function gitRepo(): string {
  const cwd = tempDir();
  execFileSync("git", ["init", "-q"], { cwd });
  for (const [key, value] of [["user.email", "t@t"], ["user.name", "t"]]) execFileSync("git", ["config", key, value], { cwd });
  writeFileSync(join(cwd, "base.txt"), "base\n");
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
}
function fakeBackend(responses: Record<string, string> = {}): ExecutionBackend {
  return {
    id: "fake",
    toolIdentity: "fake",
    contextIdentity: "test",
    start(spec, _prompt, _context): ExecutionHandle {
      const result: ExecutionResult = { text: responses[spec.id] ?? JSON.stringify({ id: spec.id, ok: true }), usage: { input: 1, output: 2, total: 3, cost: 0 } };
      return { id: spec.id, nodeId: spec.id, backendId: "fake", promise: Promise.resolve(result), abort: async () => undefined };
    },
  };
}

const base = (body: string) => `export const meta = { name: "test", description: "Test workflow" };\n${body}`;

  test("meta accepts only name, description, and model", () => {
    expect(() => compileWorkflow(`export const meta = { name: "x", description: "y", phases: [{ title: "one" }] };\nreturn agent({ id: "x", prompt: "x", effect: "read" });`)).toThrow("meta.phases is not supported");
    expect(() => compileWorkflow(`export const meta = { name: "x", description: "y", model: "p/m" };\nreturn agent({ id: "x", prompt: "x", effect: "read" });`)).not.toThrow();
  });

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
    expect(parseScript(`// header\nexport const meta = { name: "x", description: "y", model: "p/m" };\n`).meta.name).toBe("x");
    expect(() => parseScript(base("Date.now();"))).toThrow("deterministic");
    expect(() => parseScript(base("Math.random();"))).toThrow("deterministic");
    expect(() => parseScript(base("new Date();"))).toThrow("deterministic");
    expect(() => parseScript(`const x = true;\nexport const meta = { name: "x", description: "y" };`)).toThrow("start");
  });

  test("determinism scan separates regex literals from division and VM guards aliased access", () => {
    // A regex literal containing forbidden text is not a call; it must compile.
    expect(() => compileWorkflow(base(`const re = /Date.now()/;\nreturn agent({ id: "x", prompt: "x", effect: "read" });`))).not.toThrow();
    // Division-shaped bypass is caught in live code.
    expect(() => compileWorkflow(base(`const t = 1 /Date.now()/ 1;\nreturn agent({ id: "x", prompt: "x", effect: "read" });`))).toThrow("deterministic");
    // Division is not stripped; the call is still caught in live code.
    expect(() => compileWorkflow(base(`const v = Date.now() / 2;\nreturn agent({ id: "x", prompt: "x", effect: "read" });`))).toThrow("deterministic");
    // Comment mentions do not reject a plan.
    expect(() => compileWorkflow(base(`/* a * Date.now() mention */\nreturn agent({ id: "x", prompt: "x", effect: "read" });`))).not.toThrow();
    // Plain division is fine.
    expect(() => compileWorkflow(base(`const t = 1 / 2 / 3;\nreturn agent({ id: "x", prompt: "x", effect: "read" });`))).not.toThrow();
    // Aliased entropy access is blocked at the VM boundary (Math.random is absent), not by the scan.
    expect(() => compileWorkflow(base(`const r = Math["random"]();\nreturn agent({ id: "x", prompt: "x", effect: "read" });`))).toThrow("not a function");
    expect(() => compileWorkflow(base(`const { random } = Math; random();\nreturn agent({ id: "x", prompt: "x", effect: "read" });`))).toThrow("not a function");
  });
  test("parseOutput unwraps fenced JSON before validating", () => {
    const spec = { schema: { type: "object", required: ["ok"] } } as any;
    expect(parseOutput({ text: '```json\n{"ok": true}\n```', usage: emptyUsage() }, spec)).toEqual({ value: { ok: true } });
    expect(parseOutput({ text: '```\n{"ok": true}\n```', usage: emptyUsage() }, spec)).toEqual({ value: { ok: true } });
    expect(parseOutput({ text: '{"ok": true}', usage: emptyUsage() }, spec)).toEqual({ value: { ok: true } });
    expect(parseOutput({ text: '```json\n{"bad": 1}\n```', usage: emptyUsage() }, spec).error).toBe("output: missing required property");
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

describe("worktree and merge recovery", () => {
  const script = base(`return agent({ id: "w1", prompt: "p", effect: "write", isolation: "worktree" });`);

  /** Worktree committed and dangling at the moment of the simulated crash. */
  function crashedWorktree(cwd: string, runId: string) {
    const store = new RunStore(cwd, runId);
    const state = store.create(compileWorkflow(script), null, { planHash: "hash" });
    const path = join(cwd, ".pi", "worktrees", `${runId}-w1`);
    execFileSync("git", ["worktree", "add", "--detach", path], { cwd, stdio: "ignore" });
    writeFileSync(join(path, "change.txt"), "from worktree\n");
    execFileSync("git", ["add", "-A"], { cwd: path });
    execFileSync("git", ["commit", "-qm", "workflow w1"], { cwd: path, stdio: "ignore" });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
    const node = state.nodes["w1"]!;
    node.status = "running";
    node.worktreePath = path;
    store.save(state);
    return { store, path, commit };
  }

  test("resume completes a merge interrupted after the marker was written", async () => {
    const cwd = gitRepo();
    try {
      const plan = compileWorkflow(script);
      const { store, path, commit } = crashedWorktree(cwd, "run-merge-marker");
      store.writePendingMerge({ nodeId: "w1", path, commit });
      const result = await executePlan({ cwd, runId: "run-merge-marker", args: null, plan, planHash: "hash", backend: fakeBackend(), resume: true });
      expect(result.status).toBe("completed");
      expect(existsSync(join(store.directory, "pending-merge.json"))).toBe(false);
      expect(existsSync(path)).toBe(false);
      const log = execFileSync("git", ["log", "--format=%s"], { cwd, encoding: "utf8" }).trim().split("\n");
      expect(log).toContain("workflow w1");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("resume removes an orphaned worktree and reruns the node", async () => {
    const cwd = gitRepo();
    try {
      const plan = compileWorkflow(script);
      const { path } = crashedWorktree(cwd, "run-orphan");
      const result = await executePlan({ cwd, runId: "run-orphan", args: null, plan, planHash: "hash", backend: fakeBackend(), resume: true });
      expect(result.status).toBe("completed");
      expect(existsSync(path)).toBe(false);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("resume does not duplicate a merge that already landed", async () => {
    const cwd = gitRepo();
    try {
      const plan = compileWorkflow(script);
      const { store, path, commit } = crashedWorktree(cwd, "run-merge-done");
      execFileSync("git", ["cherry-pick", commit], { cwd, stdio: "ignore" });
      store.writePendingMerge({ nodeId: "w1", path, commit });
      const result = await executePlan({ cwd, runId: "run-merge-done", args: null, plan, planHash: "hash", backend: fakeBackend(), resume: true });
      expect(result.status).toBe("completed");
      const count = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd, encoding: "utf8" }).trim();
      expect(count).toBe("2"); // init + the single picked change; re-run wrote nothing
      expect(existsSync(join(store.directory, "pending-merge.json"))).toBe(false);
      expect(existsSync(path)).toBe(false);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("resume refutes a corrupted pending-merge marker without losing state", async () => {
    const cwd = gitRepo();
    try {
      const plan = compileWorkflow(script);
      const { store, path } = crashedWorktree(cwd, "run-merge-bad");
      writeFileSync(join(store.directory, "pending-merge.json"), "not json", { mode: 0o600 });
      const result = await executePlan({ cwd, runId: "run-merge-bad", args: null, plan, planHash: "hash", backend: fakeBackend(), resume: true });
      expect(result.status).toBe("completed");
      expect(existsSync(path)).toBe(false);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});

describe("execution policy durability", () => {
  test("resume reuses the policy frozen at creation, not the resuming call options", async () => {
    const cwd = gitRepo();
    try {
      const plan = compileWorkflow(base(`return agent({ id: "x", prompt: "x", effect: "read" });`));
      const store = new RunStore(cwd, "run-policy");
      const state = store.create(plan, null, { planHash: "hash", policy: { tokenBudget: 5, maxAgents: 2, timeoutMs: null, model: null, backend: "fake" } as any });
      state.nodes["x"]!.status = "running"; // crash with a node in flight
      store.save(state);
      // Resume passes different limits; the persisted policy must win and the
      // token budget (5) must gate the retry path.
      const result = await executePlan({ cwd, runId: "run-policy", args: null, plan, planHash: "hash", backend: fakeBackend(), resume: true, tokenBudget: 1_000_000, maxAgents: 8 });
      expect(result.status).toBe("completed");
      expect(new RunStore(cwd, "run-policy").load().policy).toEqual({ tokenBudget: 5, maxAgents: 2, timeoutMs: null, model: null, backend: "fake" });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});

describe("durable control and budgets", () => {
  test("cancel marker fails the run durably without running nodes", async () => {
    const cwd = tempDir();
    try {
      const plan = compileWorkflow(base(`return agent({ id: "x", prompt: "x", effect: "read" });`));
      const store = new RunStore(cwd, "run-cancel");
      store.create(plan, null, { planHash: "hash" });
      writeFileSync(join(store.directory, "cancelled"), "cancel", { mode: 0o600 });
      await expect(executePlan({ cwd, runId: "run-cancel", args: null, plan, planHash: "hash", backend: fakeBackend() })).rejects.toThrow("cancelled");
      expect(new RunStore(cwd, "run-cancel").load().status).toBe("cancelled");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("token budget stops the run before starting more agents", async () => {
    const cwd = tempDir();
    try {
      const plan = compileWorkflow(base(`const a = agent({ id: "a", prompt: "a", effect: "read" });\nconst b = agent({ id: "b", prompt: "b", effect: "read" });\nreturn parallel([a, b]);`));
      // Each fake node reports total: 3. With maxAgents=1 the first node lands
      // (3 tokens) and the budget of 2 must block the second before it starts.
      await expect(executePlan({ cwd, runId: "run-budget", args: null, plan, planHash: "hash", backend: fakeBackend(), tokenBudget: 2, maxAgents: 1 })).rejects.toThrow("token budget exhausted");
      const state = new RunStore(cwd, "run-budget").load();
      expect(state.status).toBe("failed");
      expect(Object.values(state.nodes).filter(node => node.status === "succeeded").length).toBe(1);
      expect(Object.values(state.nodes).find(node => node.spec.id === "b")!.attempts).toBe(0);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("dependency cycles are rejected at compile time", () => {
    // needs edges come from task references, so a cycle requires forged refs:
    // pipeline with a self-referencing stage is the realistic shape.
    expect(() => compileWorkflow(base(`const a = agent({ id: "a", prompt: "a", effect: "read" });\nconst b = agent({ id: "b", prompt: "b", effect: "read", needs: [a] });\npipeline([[b], [a]]);\nreturn b;`))).toThrow("cycle");
  });

  test("a dead coordinator lease is recoverable, a live one is not", async () => {
    const cwd = tempDir();
    try {
      const plan = compileWorkflow(base(`return agent({ id: "x", prompt: "x", effect: "read" });`));
      const store = new RunStore(cwd, "run-lease");
      store.create(plan, null, { planHash: "hash" });
      // A lease from a dead PID is stale and must not block a new coordinator.
      writeFileSync(join(store.directory, "lease.json"), JSON.stringify({ pid: 999_999, token: "t", at: Date.now() }), { mode: 0o600 });
      const result = await executePlan({ cwd, runId: "run-lease", args: null, plan, planHash: "hash", backend: fakeBackend() });
      expect(result.status).toBe("completed");
      // A lease held by this live process blocks a second coordinator.
      const fd = openSync(join(store.directory, "lease.json"), "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token: "t", at: Date.now() }));
      closeSync(fd);
      await expect(executePlan({ cwd, runId: "run-lease", args: null, plan, planHash: "hash", backend: fakeBackend() })).rejects.toThrow("already active");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
