import { join } from "node:path";
import type { AgentTaskSpec, JsonValue, OutputSpec } from "./plan";
import { PlanError } from "./plan";
import type { Usage } from "./store";

export interface ExecutionContext {
  cwd: string;
  model?: string;
  thinkingLevel?: string;
  signal: AbortSignal;
  maxOutputTokens?: number;
  effect: "read" | "write";
  onUpdate?: (message: string) => void;
  runtime?: RuntimeContext;
}

export interface ExecutionResult {
  text: string;
  usage: Usage;
  model?: string;
  stopReason?: string;
  hadToolActivity?: boolean;
  hadToolError?: boolean;
}

export interface ExecutionHandle { id: string; nodeId: string; backendId: string; operationId?: string; promise: Promise<ExecutionResult>; abort(): Promise<void>; }

export interface ExecutionBackend {
  readonly id: string;
  readonly toolIdentity: string;
  readonly contextIdentity: string;
  start(spec: AgentTaskSpec, prompt: string, context: ExecutionContext): ExecutionHandle;
}

export interface RuntimeContext {
  modelRuntime?: any;
  modelRegistry?: any;
  authStorage?: any;
  defaultModel?: any;
  agentDir?: string;
  thinkingLevel?: string;
  /** Optional Pi 2 adapter. It is intentionally injected instead of imported from dev APIs. */
  harnessBackend?: ExecutionBackend;
}

const READ_TOOLS = ["read", "grep", "find", "ls"];
const WRITE_TOOLS = ["bash", "read", "write", "edit"];
const MAX_RESULT_BYTES = 128 * 1024;

export interface HarnessBackendAdapter {
  readonly id: string;
  readonly toolIdentity: string;
  readonly contextIdentity: string;
  start(spec: AgentTaskSpec, prompt: string, context: ExecutionContext): ExecutionHandle;
}

/** Adapt Pi 2 AgentHarness without coupling this package to its dev-only API. */
export function createHarnessBackend(adapter: HarnessBackendAdapter): ExecutionBackend {
  return { id: adapter.id, toolIdentity: adapter.toolIdentity, contextIdentity: adapter.contextIdentity, start: adapter.start.bind(adapter) };
}

export function selectBackend(runtime?: RuntimeContext): ExecutionBackend {
  return runtime?.harnessBackend ?? sdkBackend;
}

export function parseOutput(result: ExecutionResult, spec: OutputSpec | undefined): { value?: JsonValue; error?: string } {
  if (!spec) return {};
  let value: unknown;
  try { value = JSON.parse(result.text); } catch { return { error: "agent output is not valid JSON" }; }
  const error = validateJsonSchema(value, spec.schema);
  return error ? { error } : { value: value as JsonValue };
}

export function validateJsonSchema(value: unknown, schema: unknown, path = "output"): string | undefined {
  if (!schema || typeof schema !== "object") return `${path}: schema must be an object`;
  const s = schema as any;
  if (s.type) {
    const valid = s.type === "object" ? !!value && typeof value === "object" && !Array.isArray(value)
      : s.type === "array" ? Array.isArray(value)
      : s.type === "string" ? typeof value === "string"
      : s.type === "number" ? typeof value === "number" && Number.isFinite(value)
      : s.type === "integer" ? Number.isInteger(value)
      : s.type === "boolean" ? typeof value === "boolean"
      : s.type === "null" ? value === null : true;
    if (!valid) return `${path}: expected ${s.type}`;
  }
  if (Array.isArray(s.required) && s.required.some((key: unknown) => typeof key !== "string" || !value || typeof value !== "object" || !(key in (value as any)))) return `${path}: missing required property`;
  if (s.properties && value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(s.properties)) { const error = validateJsonSchema((value as any)[key], child, `${path}.${key}`); if (error) return error; }
  }
  if (s.items && Array.isArray(value)) for (let i = 0; i < value.length; i++) { const error = validateJsonSchema(value[i], s.items, `${path}[${i}]`); if (error) return error; }
  if (Array.isArray(s.enum) && !s.enum.some((item: unknown) => JSON.stringify(item) === JSON.stringify(value))) return `${path}: value is not in enum`;
  return undefined;
}

const sdkBackend: ExecutionBackend = {
  id: "pi-sdk",
  toolIdentity: `read:${READ_TOOLS.join(",")};write:${WRITE_TOOLS.join(",")}`,
  contextIdentity: "fresh-session-no-extensions",
  start(spec, prompt, context) {
    const controller = new AbortController();
    const unlink = linkSignals(context.signal, controller);
    const id = `${spec.id}:${Date.now()}`;
    const promise = runSdk(spec, prompt, { ...context, signal: controller.signal }).finally(unlink);
    return { id, nodeId: spec.id, backendId: "pi-sdk", promise, abort: async () => { controller.abort(); } };
  },
};

async function runSdk(spec: AgentTaskSpec, prompt: string, context: ExecutionContext): Promise<ExecutionResult> {
  const sdk: any = await import("@earendil-works/pi-coding-agent");
  if (context.signal.aborted) throw new ExecutionError("workflow cancelled", undefined, "cancelled");
  const runtime = context.runtime ?? {};
  const agentDir = runtime.agentDir ?? join(process.env.HOME ?? ".", ".pi", "agent");
  let modelRuntime = runtime.modelRuntime;
  let registry = runtime.modelRegistry;
  let authStorage = runtime.authStorage;
  if (!modelRuntime && !registry && typeof sdk.ModelRuntime?.create === "function") modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  if (!modelRuntime && !registry) { authStorage = sdk.AuthStorage.create(join(agentDir, "auth.json")); registry = sdk.ModelRegistry.create(authStorage, join(agentDir, "models.json")); }
  let model = runtime.defaultModel;
  if (context.model) {
    const slash = context.model.indexOf("/");
    if (slash <= 0) throw new ExecutionError(`model must use provider/id form: ${context.model}`);
    model = modelRuntime?.getModel?.(context.model.slice(0, slash), context.model.slice(slash + 1)) ?? registry?.find?.(context.model.slice(0, slash), context.model.slice(slash + 1));
    if (!model) throw new ExecutionError(`model not found: ${context.model}`);
  }
  if (!model) throw new ExecutionError("no active Pi model is configured");
  let session: any;
  try {
    const settingsManager = sdk.SettingsManager.create(context.cwd, agentDir);
    let resourceLoader: any;
    if (typeof sdk.DefaultResourceLoader === "function") {
      resourceLoader = new sdk.DefaultResourceLoader({ cwd: context.cwd, agentDir, settingsManager, noExtensions: true });
      await resourceLoader.reload();
    }
    const options: any = {
      cwd: context.cwd,
      agentDir,
      sessionManager: sdk.SessionManager.inMemory(),
      settingsManager,
      resourceLoader,
      customTools: sdk.createCodingTools(context.cwd),
      tools: spec.effect === "read" ? READ_TOOLS : WRITE_TOOLS,
      model,
      ...(context.thinkingLevel ? { thinkingLevel: context.thinkingLevel } : {}),
      ...(modelRuntime ? { modelRuntime } : { authStorage, modelRegistry: registry }),
    };
    ({ session } = await sdk.createAgentSession(options));
    const onAbort = () => { void session.abort().catch(() => {}); };
    context.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await session.prompt(`Task: ${spec.label}\n\n${prompt}`);
      if (context.signal.aborted) throw new ExecutionError("workflow cancelled", readUsage(session), "cancelled");
      const failure = lastFailure(session.messages);
      if (failure) throw new ExecutionError(failure, readUsage(session));
      const text = lastAssistantText(session.messages);
      if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) throw new ExecutionError(`agent output exceeds ${MAX_RESULT_BYTES} bytes`, readUsage(session));
      const stats = session.getSessionStats();
      const final = [...session.messages].reverse().find((message: any) => message?.role === "assistant");
      return { text, usage: normalizeUsage(stats), model: final?.model, stopReason: final?.stopReason, hadToolActivity: hasToolActivity(session.messages), hadToolError: hasToolError(session.messages) };
    } finally { context.signal.removeEventListener("abort", onAbort); }
  } catch (error) {
    if (context.signal.aborted) throw new ExecutionError("workflow cancelled", session ? readUsage(session) : undefined, "cancelled");
    if (error instanceof ExecutionError) throw error;
    throw new ExecutionError(error instanceof Error ? error.message : String(error), session ? readUsage(session) : undefined);
  } finally { try { session?.dispose(); } catch {} }
}

export class ExecutionError extends Error {
  constructor(message: string, readonly usage?: Usage, readonly control?: "cancelled" | "paused") { super(message); this.name = "ExecutionError"; }
}

function normalizeUsage(stats: any): Usage { const t = stats?.tokens ?? {}; return { input: number(t.input), output: number(t.output), total: number(t.total), cost: number(stats?.cost) }; }
function readUsage(session: any): Usage | undefined { try { return normalizeUsage(session.getSessionStats()); } catch { return undefined; } }
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
function lastAssistantText(messages: any[]): string { for (let i = messages.length - 1; i >= 0; i--) { const m = messages[i]; if (m?.role === "assistant" && Array.isArray(m.content)) return m.content.filter((p: any) => p?.type === "text").map((p: any) => p.text ?? "").join(""); } return ""; }
function lastFailure(messages: any[]): string | undefined { for (let i = messages.length - 1; i >= 0; i--) { const m = messages[i]; if (m?.role === "toolResult" && m.isError) return m.content?.map((p: any) => p.text ?? "").join("") || "tool execution failed"; } return undefined; }
function hasToolActivity(messages: any[]): boolean { return messages.some(m => m?.role === "assistant" && Array.isArray(m.content) && m.content.some((p: any) => p?.type === "toolCall")); }
function hasToolError(messages: any[]): boolean { return messages.some(m => m?.role === "toolResult" && m.isError); }
function linkSignals(parent: AbortSignal, child: AbortController): () => void { const abort = () => child.abort(); if (parent.aborted) child.abort(); else parent.addEventListener("abort", abort, { once: true }); return () => parent.removeEventListener("abort", abort); }
