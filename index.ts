/**
 * pi-workflows — durable plan compilation and execution for Pi.
 *
 * The extension owns workflow graphs, budgets, leases, and workspace effects.
 * Pi's AgentHarness owns one child conversation's transcript and operation
 * recovery. The current SDK backend remains available until that API is stable.
 */
import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileWorkflow, parseScript, PlanError, type JsonValue, type WorkflowPlan } from "./plan";
import { executePlan, workflowPlanHash, type RunOptions } from "./scheduler";
import { RunStore, leaseAlive, validateRunId, type RunState } from "./store";
import type { ExecutionBackend, RuntimeContext } from "./executor";

export { compileWorkflow, parseScript, PlanError } from "./plan";
export { RunStore } from "./store";
export { executePlan, workflowPlanHash, RunControlError } from "./scheduler";
export type { WorkflowMeta, WorkflowPlan, WorkflowNode, AgentTaskSpec, JsonValue } from "./plan";
export { createHarnessBackend } from "./executor";
export type { ExecutionBackend, ExecutionContext, ExecutionHandle, ExecutionResult, RuntimeContext, HarnessBackendAdapter } from "./executor";

const MAX_AGENTS = 100;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const COMMANDS_DIR = ".pi/workflows/commands";
const ACTIVE = new Map<string, { controller: AbortController; promise: Promise<unknown> }>();

function cwdOf(ctx: ExtensionContext): string { return resolve(ctx.cwd ?? process.cwd()); }
function runKey(cwd: string, runId: string): string { return `${resolve(cwd)}\0${runId}`; }
function ok(text: string, details?: unknown): AgentToolResult<unknown> { return { content: [{ type: "text", text }], details } as AgentToolResult<unknown>; }
function normalizeScript(script: string): string { const match = script.trim().match(/^```(?:js|javascript|ts|typescript)?\s*\n([\s\S]*?)\n```$/i); return (match?.[1] ?? script).trim(); }
function parseLimit(value: unknown, name: string, max: number): number | undefined { if (value === undefined) return undefined; if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > max) throw new Error(`${name} must be an integer from 1 to ${max}`); return Number(value); }
function planPolicy(params: any, ctx: ExtensionContext, backendId: string): Record<string, JsonValue> { return { tokenBudget: params.tokenBudget ?? null, maxAgents: params.maxAgents ?? null, timeoutMs: params.timeoutMs ?? null, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null, backend: backendId }; }

async function executeWorkflow(script: string, options: { cwd?: string; runId?: string; args?: unknown; runtime?: RuntimeContext; tokenBudget?: number; maxAgents?: number; timeoutMs?: number; signal?: AbortSignal; onUpdate?: (message: string) => void; originSessionId?: string } = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const plan = compileWorkflow(script, options.args ?? null, Math.min(options.timeoutMs ?? 30_000, MAX_TIMEOUT_MS));
  const runId = options.runId ?? `run-${randomUUID()}`;
  validateRunId(runId);
  const backendId = options.runtime?.harnessBackend?.id ?? "pi-sdk";
  const planHash = workflowPlanHash(plan, planPolicy(options, { model: options.runtime?.defaultModel } as any, backendId), options.args ?? null);
  return executePlan({ cwd, runId, args: options.args as JsonValue ?? null, plan, planHash, runtime: options.runtime, tokenBudget: options.tokenBudget, maxAgents: options.maxAgents, timeoutMs: options.timeoutMs, signal: options.signal, onUpdate: options.onUpdate, originSessionId: options.originSessionId });
}

function readRun(cwd: string, runId: string): RunState | undefined { try { return new RunStore(cwd, runId).load(); } catch { return undefined; } }

function statusFor(cwd: string, runId: string): Record<string, unknown> | null {
  try { validateRunId(runId); } catch { return null; }
  const state = readRun(cwd, runId); if (!state) return null;
  const nodes = Object.values(state.nodes);
  const progress = Object.fromEntries(["pending", "ready", "running", "succeeded", "failed", "cancelled", "blocked"].map(status => [status, nodes.filter(node => node.status === status).length]));
  const leasePath = join(new RunStore(cwd, runId).directory, "lease.json");
  return { runId, status: state.status === "running" && !leaseAlive(leasePath) ? "orphaned" : state.status, meta: state.meta, planHash: state.planHash, createdAt: state.createdAt, updatedAt: state.updatedAt, progress, usage: state.usage, result: state.result, error: state.error, nodes: nodes.map(node => ({ id: node.spec.id, label: node.spec.label, status: node.status, attempts: node.attempts, error: node.error, operationId: node.operationId })) };
}

function createWorkflowTool() {
  return {
    name: "workflow",
    label: "Workflow",
    description: "Compile and execute a durable JavaScript workflow plan with bounded Pi agents.",
    promptSnippet: "Run a durable workflow plan with task(), agent(), parallel(), and pipeline().",
    promptGuidelines: [
      "Start with export const meta = { name, description }.",
      "Build tasks synchronously with agent({ id, prompt, needs?, effect?, isolation?, output? }). Do not await tasks.",
      "Use parallel(taskRefs) for fan-out and pipeline([[stage1], [stage2]]) for dependency stages.",
      "Every task needs a stable id. Dependencies receive their predecessors' JSON outputs in the prompt.",
      "The plan is compiled before execution; direct filesystem, shell, process, and dynamic code generation are unavailable.",
      "Use isolation: \"worktree\" for concurrent writes. External effects are at-least-once around process failure.",
    ],
    parameters: Type.Object({
      script: Type.String({ description: "JavaScript workflow plan" }),
      args: Type.Optional(Type.Unknown({ description: "JSON values exposed as args" })),
      background: Type.Optional(Type.Boolean({ default: true })),
      tokenBudget: Type.Optional(Type.Integer({ minimum: 1 })),
      maxAgents: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_AGENTS })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_MS })),
      runId: Type.Optional(Type.String()),
      resume: Type.Optional(Type.Boolean({ default: true })),
      dryRun: Type.Optional(Type.Boolean({ default: false })),
    }),
    renderCall(args: any, theme: Theme, context?: any) {
      const name = (() => { try { return compileWorkflow(args.script, null, 1000).meta.name; } catch { return "workflow"; } })();
      const text = `${theme.fg("toolTitle", theme.bold("workflow "))}${theme.fg("accent", name)}${theme.fg("dim", args.background === false ? " (blocking)" : " (background)")}`;
      if (context?.lastComponent) { context.lastComponent.setText(text); return context.lastComponent; }
      return new Text(text, 0, 0);
    },
    renderResult(result: any, opts: any, theme: Theme, context?: any) {
      const text = result.content?.[0]?.text ?? "";
      return new Text(theme.fg(context?.isError ? "error" : "text", `${context?.isError ? "✗" : "✓"} ${text}`), 0, 0);
    },
    async execute(_id: string, params: any, signal: AbortSignal | undefined, onUpdate: ((update: AgentToolResult<unknown>) => void) | undefined, ctx: ExtensionContext) {
      const script = normalizeScript(params.script);
      const maxAgents = parseLimit(params.maxAgents, "maxAgents", MAX_AGENTS);
      const timeoutMs = parseLimit(params.timeoutMs, "timeoutMs", MAX_TIMEOUT_MS);
      const plan = compileWorkflow(script, params.args ?? null, Math.min(timeoutMs ?? 30_000, MAX_TIMEOUT_MS));
      if (params.dryRun) return ok(`Plan "${plan.meta.name}" is valid: ${plan.nodes.length} agent(s), ${plan.resultIds.length} result(s).`, { plan });
      const cwd = cwdOf(ctx);
      const runtime: RuntimeContext = {
        modelRuntime: (ctx as any).modelRuntime,
        modelRegistry: ctx.modelRegistry,
        authStorage: (ctx.modelRegistry as any)?.authStorage,
        defaultModel: ctx.model,
        thinkingLevel: (ctx as any).thinkingLevel,
        agentDir: join(process.env.HOME ?? ".", ".pi", "agent"),
        harnessBackend: (ctx as any).workflowHarnessBackend as ExecutionBackend | undefined,
      };
      const policy = planPolicy({ tokenBudget: params.tokenBudget, maxAgents, timeoutMs }, ctx, runtime.harnessBackend?.id ?? "pi-sdk");
      const planHash = workflowPlanHash(plan, policy, params.args ?? null);
      let runId = params.runId as string | undefined;
      let resuming = false;
      if (runId) {
        const existing = readRun(cwd, runId);
        if (!existing) throw new Error(`Workflow run ${runId} not found`);
        if (existing.planHash !== planHash) throw new Error("Workflow plan or execution policy changed; refusing to resume");
        if (existing.status === "completed") throw new Error(`Workflow run ${runId} is already completed`);
        resuming = true;
      } else if (params.resume !== false) {
        const candidate = RunStore.list(cwd).reverse().find(state => state.meta.name === plan.meta.name && state.planHash === planHash && ["paused", "orphaned", "running"].includes(state.status));
        if (candidate) { runId = candidate.runId; resuming = true; }
      }
      runId ??= `run-${randomUUID()}`;
      const key = runKey(cwd, runId);
      const controller = new AbortController();
      const removeAbort = linkAbort(signal, controller);
      const runOptions: RunOptions = { cwd, runId, args: (params.args ?? null) as JsonValue, plan, planHash, runtime, tokenBudget: params.tokenBudget, maxAgents, timeoutMs, signal: controller.signal, resume: resuming, originSessionId: ctx.sessionManager.getSessionId(), onUpdate: message => onUpdate?.(ok(message, { runId })) };
      const promise = executePlan(runOptions).finally(() => { removeAbort(); ACTIVE.delete(key); });
      ACTIVE.set(key, { controller, promise });
      if (params.background !== false) {
        void promise.then(result => ctx.ui.notify(`Workflow "${plan.meta.name}" completed (${Object.keys(result.outputs).length} agent(s)).`, "info")).catch(error => ctx.ui.notify(`Workflow "${plan.meta.name}" ${error instanceof Error ? error.message : String(error)}`, "error"));
        return ok(`Workflow "${plan.meta.name}" started${resuming ? " (resumed)" : ""}.`, { runId, background: true, resumed: resuming, planHash });
      }
      try { const result = await promise; return ok(`Workflow "${plan.meta.name}" completed (${Object.keys(result.outputs).length} agent(s)).`, result); }
      catch (error) { throw error; }
    },
  };
}

function createWorkflowStatusTool() {
  return {
    name: "workflow_status",
    label: "Workflow Status",
    description: "Inspect a durable workflow run and its agent graph.",
    promptSnippet: "Inspect workflow node progress, usage, and errors.",
    promptGuidelines: ["Pass the runId returned by workflow()."],
    parameters: Type.Object({ runId: Type.Optional(Type.String()), workflow: Type.Optional(Type.String()) }),
    renderCall(args: any, theme: Theme) { return new Text(`${theme.fg("toolTitle", theme.bold("workflow_status "))}${theme.fg("accent", args.runId ?? args.workflow ?? "latest")}`, 0, 0); },
    renderResult(result: any, opts: any, theme: Theme, context?: any) { return new Text(theme.fg(context?.isError ? "error" : "text", `${context?.isError ? "✗" : "✓"} ${result.content?.[0]?.text ?? ""}`), 0, 0); },
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const cwd = cwdOf(ctx);
      const runId = params.runId ?? RunStore.list(cwd).reverse().find(state => !params.workflow || state.meta.name === params.workflow)?.runId;
      if (!runId) throw new Error("No workflow runs found");
      const status = statusFor(cwd, runId); if (!status) throw new Error(`Workflow run ${runId} not found`);
      const progress = status.progress as Record<string, number>;
      return ok(`Workflow: ${(status.meta as any)?.name ?? runId}\nStatus: ${status.status}\nAgents: ${Object.values(progress).reduce((sum, n) => sum + n, 0)}\nProgress: ${Object.entries(progress).map(([key, value]) => `${key} ${value}`).join(", ")}`, status);
    },
  };
}

function savedWorkflows(cwd: string): Array<{ name: string; path: string }> { const dir = join(cwd, COMMANDS_DIR); if (!existsSync(dir)) return []; return readdirSync(dir).filter(name => name.endsWith(".js")).map(name => ({ name: name.slice(0, -3), path: join(dir, name) })); }
function linkAbort(parent: AbortSignal | undefined, controller: AbortController): () => void { if (!parent) return () => {}; const abort = () => controller.abort(); if (parent.aborted) controller.abort(); else parent.addEventListener("abort", abort, { once: true }); return () => parent.removeEventListener("abort", abort); }

export default function registerExtension(pi: ExtensionAPI): void {
  const workflow = createWorkflowTool();
  const status = createWorkflowStatusTool();
  pi.registerTool(workflow);
  pi.registerTool(status);
  pi.registerCommand("workflows", { description: "Manage durable workflow plans and runs", handler: async (raw, ctx) => {
    const command = (raw ?? "").trim(); const [word, ...rest] = command.split(/\s+/); const cwd = cwdOf(ctx);
    if (!word || word === "list") { const runs = RunStore.list(cwd); ctx.ui.notify(["Saved workflows:", ...savedWorkflows(cwd).map(item => `  ${item.name}`), "", "Recent runs:", ...runs.slice(-10).map(run => `  ${run.meta.name} [${run.status}] (${run.runId})`)].join("\n"), "info"); return; }
    if (word === "pause") { const runId = rest[0]; if (!runId) throw new Error("Usage: /workflows pause <runId>"); validateRunId(runId); const run = readRun(cwd, runId); if (!run) throw new Error(`Workflow run ${runId} not found`); mkdirSync(new RunStore(cwd, runId).directory, { recursive: true, mode: 0o700 }); writeFileSync(join(new RunStore(cwd, runId).directory, "paused"), new Date().toISOString(), { mode: 0o600 }); ctx.ui.notify(`Pause requested for ${runId}.`, "info"); return; }
    if (word === "cancel") { const runId = rest[0]; if (!runId) throw new Error("Usage: /workflows cancel <runId>"); validateRunId(runId); const run = readRun(cwd, runId); if (!run) throw new Error(`Workflow run ${runId} not found`); const store = new RunStore(cwd, runId); mkdirSync(store.directory, { recursive: true, mode: 0o700 }); writeFileSync(join(store.directory, "cancelled"), new Date().toISOString(), { mode: 0o600 }); ACTIVE.get(runKey(cwd, runId))?.controller.abort(); ctx.ui.notify(`Cancellation requested for ${runId}.`, "info"); return; }
    if (word === "resume") { const runId = rest[0]; if (!runId) throw new Error("Usage: /workflows resume <runId>"); const run = readRun(cwd, runId); if (!run) throw new Error(`Workflow run ${runId} not found`); await workflow.execute("resume", { script: run.script, args: run.args, runId, background: true, resume: true }, ctx.signal, undefined, ctx); ctx.ui.notify(`Resume requested for ${runId}.`, "info"); return; }
    if (word === "save") { const name = rest[0]; if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("Workflow name must contain letters, numbers, _ or -"); const entries = ctx.sessionManager.getEntries(); const call = [...entries].reverse().flatMap((entry: any) => entry.message?.content ?? []).find((part: any) => part.type === "toolCall" && part.name === "workflow"); if (typeof call?.arguments?.script !== "string") throw new Error("No workflow call found to save"); const dir = join(cwd, COMMANDS_DIR); mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(join(dir, `${name}.js`), call.arguments.script, { mode: 0o600 }); ctx.ui.notify(`Saved workflow as ${name}.`, "info"); return; }
    if (word === "run") { const name = rest[0]; const saved = savedWorkflows(cwd).find(item => item.name === name); if (!saved) throw new Error(`Saved workflow ${name} not found`); await workflow.execute("saved", { script: readFileSync(saved.path, "utf8"), background: true }, ctx.signal, undefined, ctx); return; }
    if (word === "clean") { const before = Date.now() - (Number(rest[0] ?? 7) || 7) * 86400000; let count = 0; for (const run of RunStore.list(cwd)) if (run.updatedAt < before && ["completed", "failed", "cancelled"].includes(run.status)) { rmSync(new RunStore(cwd, run.runId).directory, { recursive: true, force: true }); count++; } ctx.ui.notify(`Cleaned ${count} workflow run(s).`, "info"); return; }
    ctx.ui.notify("Usage: /workflows [list|save <name>|run <name>|resume <runId>|pause <runId>|cancel <runId>|clean [days]]", "info");
  } });
  pi.on("session_start", () => { const active = pi.getActiveTools(); const needed = [workflow.name, status.name].filter(name => !active.includes(name)); if (needed.length) pi.setActiveTools([...active, ...needed]); });
  pi.on("session_shutdown", async () => { for (const active of ACTIVE.values()) active.controller.abort(); await Promise.allSettled([...ACTIVE.values()].map(item => item.promise)); });
}

export { createWorkflowTool, createWorkflowStatusTool, executeWorkflow, statusFor };
