import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { compileWorkflow } from "./plan";
import { executePlan } from "./scheduler";
import { sdkBackend } from "./executor";
import { RunStore } from "./store";

/**
 * Integration coverage for the default execution backend. The scheduler and
 * store tests run against a fake backend; these tests drive the real SDK path
 * (ModelRuntime + createAgentSession) with a scripted faux provider, so an SDK
 * drift in runSdk() fails here instead of only in production.
 */

const WORKER_MODEL = "pi-faux-readonly/worker";

async function fauxBackend(responses: string[]): Promise<{ backend: typeof sdkBackend; runtime: any }> {
  const faux = fauxProvider({
    provider: "pi-faux-readonly",
    models: [{ id: "worker", name: "Worker", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
  });
  faux.setResponses(responses.map(text => fauxAssistantMessage(text)));
  const modelRuntime = await ModelRuntime.create({ modelsPath: null });
  modelRuntime.registerNativeProvider(faux.provider);
  return { backend: sdkBackend, runtime: { modelRuntime, defaultModel: modelRuntime.getModel("pi-faux-readonly", "worker"), agentDir: join(tmpdir(), `pi-wf-agent-${process.pid}`) } };
}

function gitRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-sdk-"));
  execFileSync("git", ["init", "-q"], { cwd });
  for (const [key, value] of [["user.email", "t@t"], ["user.name", "t"]]) execFileSync("git", ["config", key, value], { cwd });
  writeFileSync(join(cwd, "base.txt"), "base\n");
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
}

const base = (body: string) => `export const meta = { name: "sdk", description: "SDK backend test" };\n${body}`;

describe("pi-sdk execution backend", () => {
  test("runs a node through a real SDK session and parses fenced structured output", async () => {
    const cwd = gitRepo();
    try {
      const { backend, runtime } = await fauxBackend(['```json\n{"ok": true, "value": 42}\n```']);
      const plan = compileWorkflow(base(`return agent({ id: "x", prompt: "reply with JSON", effect: "read", output: { schema: { type: "object", required: ["ok"] } } });`));
      const result = await executePlan({ cwd, runId: "run-sdk", args: null, plan, planHash: "hash", backend, runtime, maxAgents: 1 });
      expect(result.status).toBe("completed");
      // Fence-stripped structured output, not raw text.
      expect(result.outputs.x).toEqual({ ok: true, value: 42 });
      const state = new RunStore(cwd, "run-sdk").load();
      expect(state.nodes.x?.usage.total ?? 0).toBeGreaterThan(0);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }, 30_000);

  test("schema violation fails the node instead of fabricating success", async () => {
    const cwd = gitRepo();
    try {
      const { backend, runtime } = await fauxBackend(['{"wrong": true}']);
      const plan = compileWorkflow(base(`return agent({ id: "x", prompt: "reply with JSON", effect: "read", output: { schema: { type: "object", required: ["ok"] } } });`));
      await expect(executePlan({ cwd, runId: "run-sdk-bad", args: null, plan, planHash: "hash", backend, runtime, maxAgents: 1 })).rejects.toThrow("missing required property");
      const state = new RunStore(cwd, "run-sdk-bad").load();
      expect(state.nodes.x?.status).toBe("failed");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }, 30_000);

  test("abort cancels the in-flight SDK session and marks the node cancelled", async () => {
    const cwd = gitRepo();
    try {
      // A response factory that hangs until we release it: the provider call
      // stays in flight and abort() must surface control:"cancelled".
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const faux = fauxProvider({
        provider: "pi-faux-hang",
        models: [{ id: "worker", name: "Worker", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
      });
      faux.setResponses([() => gate.then(() => fauxAssistantMessage("too late"))]);
      const modelRuntime = await ModelRuntime.create({ modelsPath: null });
      modelRuntime.registerNativeProvider(faux.provider);
      const runtime = { modelRuntime, defaultModel: modelRuntime.getModel("pi-faux-hang", "worker"), agentDir: join(tmpdir(), `pi-wf-agent2-${process.pid}`) };
      const plan = compileWorkflow(base(`return agent({ id: "x", prompt: "hang", effect: "read" });`));
      const controller = new AbortController();
      const promise = executePlan({ cwd, runId: "run-sdk-cancel", args: null, plan, planHash: "hash", backend: sdkBackend, runtime, maxAgents: 1, signal: controller.signal });
      // Wait until the node is in flight, then cancel.
      const deadline = Date.now() + 15_000;
      while (new RunStore(cwd, "run-sdk-cancel").load().nodes.x?.status !== "running" && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
      controller.abort();
      release();
      await expect(promise).rejects.toThrow("cancelled");
      const state = new RunStore(cwd, "run-sdk-cancel").load();
      expect(state.nodes.x?.status).toBe("cancelled");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }, 30_000);
});
