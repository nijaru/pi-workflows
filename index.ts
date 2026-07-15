/**
 * pi-workflows: Script-as-plan orchestration for pi.
 *
 * Model writes a JS orchestration script. Runtime executes it in a sandboxed
 * VM with journal-based resume, model tier routing, and real cost tracking.
 *
 * Uses one fresh in-process Pi SDK leaf worker per workflow call and a small capability bridge for the workflow VM.
 */

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Component, Text } from "@earendil-works/pi-tui";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  closeSync,
  fstatSync,
  futimesSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  constants as fsConstants,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import vm from "node:vm";

// ── Types ──────────────────────────────────────────────────────────────────

interface WorkflowMeta {
  name: string;
  description: string;
  phases?: Array<{ title: string; model?: string }>;
  model?: string;
}

type WorkflowEffect = "read" | "write";

interface AgentOptions {
  label?: string;
  phase?: string;
  model?: string;
  tier?: "small" | "medium" | "big";
  taskType?: string;
  effect?: WorkflowEffect;
  isolation?: "worktree";
  output?: {
    schema: unknown;
    maxRetries?: number;
  };
}

interface StructuredOutputSpec {
  schema: unknown;
  maxRetries: number;
  instruction: string;
}

interface ExecutionEnvelope {
  origin?: {
    sessionId?: string;
    goalId?: string;
    branch?: string;
  };
  parentRunId?: string;
  workspaceIdentity?: string;
  onUsage?: (usage: { input: number; output: number; total: number; cost: number }) => void;
  onState?: (state: { runId: string; status: "completed" | "error" | "paused" | "cancelled" }) => void;
}

interface WorkflowRuntime {
  modelRegistry?: any;
  authStorage?: any;
  defaultModel?: any;
  agentDir?: string;
  onUpdate?: (update: AgentToolResult<unknown>) => void;
  executionEnvelope?: ExecutionEnvelope;
  workerBackend?: WorkerBackend;
}

interface WorkerRequest {
  prompt: string;
  label: string;
  cwd: string;
  model?: string;
  tools?: string[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
  runtime?: WorkflowRuntime;
}

interface WorkerResult {
  text: string;
  tokens: { input: number; output: number; total: number; cost: number };
  model?: string;
  stopReason?: string;
}

function validateTokenUsage(value: unknown, source: string): WorkerResult["tokens"] {
  if (!value || typeof value !== "object") throw new Error(`${source} returned invalid token usage`);
  const usage = value as Record<string, unknown>;
  const fields = ["input", "output", "total", "cost"] as const;
  for (const field of fields) {
    if (typeof usage[field] !== "number" || !Number.isFinite(usage[field]) || usage[field] < 0) {
      throw new Error(`${source} returned invalid ${field} token usage`);
    }
  }
  return {
    input: usage.input as number,
    output: usage.output as number,
    total: usage.total as number,
    cost: usage.cost as number,
  };
}

interface WorkerBackend {
  readonly id: string;
  readonly toolIdentity: string;
  readonly contextIdentity: string;
  run(request: WorkerRequest): Promise<WorkerResult>;
}

interface ExecuteWorkflowOptions {
  args?: unknown;
  cwd?: string;
  runId?: string;
  tokenBudget?: number | null;
  maxAgents?: number;
  signal?: AbortSignal;
  resumeJournal?: Map<number, JournalEntry>;
  runtime?: WorkflowRuntime;
  timeoutMs?: number;
  lock?: boolean;
}

interface WorkflowRunRecord {
  runId: string;
  meta: WorkflowMeta | null;
  status: string;
  fingerprint?: string;
  createdAt?: number;
}

const WORKFLOW_CONTROL_PREFIX = "__pi_workflow_control__:";

class WorkflowControlError extends Error {
  constructor(readonly code: "paused" | "aborted" | "cancelled", message: string) {
    super(message);
    this.name = "WorkflowControlError";
  }
}

function encodeWorkflowError(error: unknown): string {
  if (error instanceof WorkflowControlError) return `${WORKFLOW_CONTROL_PREFIX}${error.code}:${error.message}`;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && typeof (error as any).message === "string") return (error as any).message;
  return String(error);
}

function decodeWorkflowControl(error: unknown): WorkflowControlError | undefined {
  if (error instanceof WorkflowControlError) return error;
  const message = error instanceof Error
    ? error.message
    : (error && typeof error === "object" && typeof (error as any).message === "string" ? (error as any).message : String(error));
  if (!message.startsWith(WORKFLOW_CONTROL_PREFIX)) return undefined;
  const rest = message.slice(WORKFLOW_CONTROL_PREFIX.length);
  const split = rest.indexOf(":");
  if (split < 0) return undefined;
  const code = rest.slice(0, split);
  if (code !== "paused" && code !== "aborted" && code !== "cancelled") return undefined;
  return new WorkflowControlError(code, rest.slice(split + 1));
}

class WorkflowAgentError extends Error {
  constructor(readonly label: string, message: string) {
    super(`Agent "${label}" failed: ${message}`);
    this.name = "WorkflowAgentError";
  }
}

interface JournalEntry {
  index: number;
  hash: string;
  result: unknown;
  tokens: { input: number; output: number; total: number; cost: number };
  durationMs: number;
}

interface WorkflowRunResult {
  meta: WorkflowMeta;
  result: unknown;
  logs: string[];
  phases: string[];
  agentCount: number;
  durationMs: number;
  runId: string;
  tokenUsage: { input: number; output: number; total: number; cost: number };
}

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_AGENTS = 100;
const MAX_CONCURRENCY = 8;
const MAX_PARALLEL_ITEMS = 100;
const MAX_WORKFLOW_SCRIPT_BYTES = 512 * 1024;
const MAX_ARGS_BYTES = 1024 * 1024;
const MAX_META_NODES = 2048;
const MAX_PERSISTED_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_STATE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_AGENT_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_SCHEMA_BYTES = 64 * 1024;
const MAX_STRUCTURED_RETRIES = 2;
const MAX_LOG_ENTRIES = 1000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_WORKFLOW_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_REVIEWERS = 16;
const MAX_ROUNDS = 100;
const ESTIMATED_SYSTEM_TOKENS = 2048;
const SDK_WORKER_TOOLS = ["read", "bash", "edit", "write"] as const;
const SDK_READ_ONLY_WORKER_TOOLS = ["read", "grep", "find", "ls"] as const;
const SDK_WORKER_BACKEND_ID = "pi-sdk-inprocess-v1";
const SDK_WORKER_CONTEXT_IDENTITY = "fresh-inmemory-session";
const SDK_WORKER_LEAF_GUIDANCE = "You are a leaf worker inside a managed workflow. Complete the assigned task directly using only the tools listed as available. Do not assume unlisted extension tools such as web_search, MCP, or subagent are available. Do not spawn nested agents, workflows, Pi/Claude/Codex processes, or detached background work; return the result to the parent workflow.";
const WORKFLOW_DIR = ".pi/workflows";
const COMMANDS_DIR = ".pi/workflows/commands";
const ACTIVE_RUNS = new Set<string>();
const RUN_LOCK_TOKENS = new Map<string, string>();
const ACTIVE_RUN_CONTROLLERS = new Map<string, AbortController>();
const ACTIVE_RUN_DRAINS = new Map<string, Promise<unknown>>();
const ACTIVE_CANONICAL_WRITES = new Set<string>();
const WORKSPACE_MERGE_QUEUES = new Map<string, Promise<void>>();
const LOCK_STALE_MS = 24 * 60 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 30 * 1000;

function canonicalCwd(cwd: string): string {
  const absolute = resolve(cwd);
  try { return realpathSync(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return absolute;
  }
}

function runKey(cwd: string, runId: string): string { return `${canonicalCwd(cwd)}\0${runId}`; }

function workspaceLockKey(cwd: string): string {
  const canonical = canonicalCwd(cwd);
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: canonical,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1024 * 1024,
    }).trim();
    return canonicalCwd(root);
  } catch {
    return canonical;
  }
}

function workflowManagedGitPath(path: string, workflowCwd: string, repoRoot: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\"|\"$/g, "");
  if (/(^|\/)\.pi\/(?:workflows|worktrees)(?:\/|$)/.test(normalized)) return true;
  const absolute = resolve(repoRoot, normalized);
  for (const managedRoot of [
    join(workflowCwd, WORKFLOW_DIR),
    join(workflowCwd, ".pi/worktrees"),
    join(repoRoot, WORKFLOW_DIR),
  ]) {
    if (absolute === managedRoot || absolute.startsWith(`${managedRoot}${sep}`)) return true;
  }
  return false;
}

function filterWorkflowManagedGitStatus(status: string, workflowCwd: string, repoRoot: string): string {
  return status.split("\n").filter(line => {
    if (!line.trim()) return false;
    const paths = line.slice(3).trim().split(" -> ");
    return paths.some(path => !workflowManagedGitPath(path, workflowCwd, repoRoot));
  }).join("\n");
}

function workspaceIdentity(cwd: string): string {
  const canonical = canonicalCwd(cwd);
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: canonical, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024 });
    const root = git(["rev-parse", "--show-toplevel"]).trim();
    let branch = "detached";
    try { branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]).trim() || branch; } catch {}
    const head = git(["rev-parse", "HEAD"]).trim();
    const workspaceRoot = canonicalCwd(root);
    const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: MAX_STATE_FILE_BYTES,
    });
    const dirty = createHash("sha256").update(filterWorkflowManagedGitStatus(status, canonical, workspaceRoot)).digest("hex");
    return `git:${workspaceRoot}|${branch}|${head}|${dirty}`;
  } catch {
    return `path:${canonical}`;
  }
}

function linkAbortSignal(parent: AbortSignal | undefined, controller: AbortController): () => void {
  if (!parent) return () => {};
  const abort = () => controller.abort();
  if (parent.aborted) controller.abort();
  else parent.addEventListener("abort", abort, { once: true });
  return () => parent.removeEventListener("abort", abort);
}

function isProcessAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function claimRun(cwd: string, runId: string): void {
  const key = runKey(cwd, runId);
  if (ACTIVE_RUNS.has(key)) throw new Error(`Workflow run ${runId} is already active.`);
  const dir = getJournalDir(cwd, runId);
  ensurePrivateDir(dir, cwd);
  const lockPath = join(dir, "run.lock");
  assertNotSymlink(lockPath);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const token = randomUUID();
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeAll(fd, JSON.stringify({ pid: process.pid, token, startedAt: Date.now() }));
      } finally {
        closeSync(fd);
      }
      ACTIVE_RUNS.add(key);
      RUN_LOCK_TOKENS.set(key, token);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const lock = JSON.parse(readRegularFile(lockPath));
        const alive = isProcessAlive(lock.pid);
        if (!alive || (lock.pid == null && Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS)) {
          if (takeOverStaleLock(lockPath, typeof lock.token === "string" ? lock.token : undefined)) continue;
        }
      } catch {
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS && takeOverStaleLock(lockPath)) continue;
        } catch {}
      }
      throw new Error(`Workflow run ${runId} is already active.`);
    }
  }
  throw new Error(`Could not claim workflow run ${runId}.`);
}

function touchOwnedLock(lockPath: string, token: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const lock = JSON.parse(readFileSync(fd, "utf-8"));
    if (lock.token === token) {
      const now = new Date();
      futimesSync(fd, now, now);
    }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

function startRunHeartbeat(cwd: string, runId: string): () => void {
  const lockPath = join(getJournalDir(cwd, runId), "run.lock");
  const token = RUN_LOCK_TOKENS.get(runKey(cwd, runId));
  if (!token) return () => {};
  const heartbeat = () => {
    try { touchOwnedLock(lockPath, token); } catch {}
  };
  heartbeat();
  const timer = setInterval(heartbeat, LOCK_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

function releaseRun(cwd: string, runId: string): void {
  const key = runKey(cwd, runId);
  ACTIVE_RUNS.delete(key);
  const token = RUN_LOCK_TOKENS.get(key);
  RUN_LOCK_TOKENS.delete(key);
  if (!token) return;
  const lockPath = join(getJournalDir(cwd, runId), "run.lock");
  try {
    const current = JSON.parse(readRegularFile(lockPath));
    if (current.token === token) rmSync(lockPath, { force: true });
  } catch {}
}

function takeOverStaleLock(lockPath: string, expectedToken?: string): boolean {
  const stalePath = `${lockPath}.stale-${randomUUID()}`;
  try { renameSync(lockPath, stalePath); } catch { return false; }
  if (expectedToken !== undefined) {
    try {
      const moved = JSON.parse(readRegularFile(stalePath));
      if (moved.token !== expectedToken) {
        try { linkSync(stalePath, lockPath); rmSync(stalePath, { force: true }); } catch {}
        return false;
      }
    } catch {
      try { linkSync(stalePath, lockPath); rmSync(stalePath, { force: true }); } catch {}
      return false;
    }
  }
  try { rmSync(stalePath, { force: true }); return true; } catch { return false; }
}

function claimWorkspaceMutation(cwd: string, root = workspaceLockKey(cwd)): () => void {
  const dir = join(root, WORKFLOW_DIR);
  ensurePrivateDir(dir, root);
  const lockPath = join(dir, "workspace.lock");
  assertNotSymlink(lockPath);
  let token: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      token = randomUUID();
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeAll(fd, JSON.stringify({ pid: process.pid, token, startedAt: Date.now() }));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      let observedToken: string | undefined;
      try {
        const lock = JSON.parse(readRegularFile(lockPath));
        observedToken = typeof lock.token === "string" ? lock.token : undefined;
        stale = lock.pid == null
          ? Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS
          : !isProcessAlive(lock.pid);
      } catch {
        try { stale = Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS; } catch {}
      }
      if (!stale || !takeOverStaleLock(lockPath, observedToken)) throw new Error("Workspace checkout is busy; use worktree isolation");
    }
  }
  if (!token) throw new Error("Could not claim workspace mutation lock");

  const heartbeat = () => {
    try { touchOwnedLock(lockPath, token); } catch {}
  };
  heartbeat();
  const timer = setInterval(heartbeat, LOCK_HEARTBEAT_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    try {
      const current = JSON.parse(readRegularFile(lockPath));
      if (current.token === token) rmSync(lockPath, { force: true });
    } catch {}
  };
}

async function withWorkspaceMutationLock<T>(cwd: string, fn: () => Promise<T>, root = workspaceLockKey(cwd)): Promise<T> {
  const release = claimWorkspaceMutation(cwd, root);
  try { return await fn(); } finally { release(); }
}

function assertSafeRunId(runId: string): void {
  if (!/^run-[a-z0-9-]+$/.test(runId) || runId.length > 120) {
    throw new Error(`Invalid workflow run id: ${runId}`);
  }
}

function assertSafeCommandName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
    throw new Error("Workflow command names may contain only letters, numbers, '_' and '-'.");
  }
}

function finiteNonNegative(value: number | undefined, name: string): number | undefined {
  if (value == null) return undefined;
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite non-negative number`);
  return value;
}

// ── Model Tier Routing ─────────────────────────────────────────────────────

const TASK_TYPE_TIERS: Record<string, "small" | "medium" | "big"> = {
  simple: "small",
  search: "small",
  code: "medium",
  implement: "medium",
  reasoning: "big",
  review: "big",
};

/**
 * Default tier-to-model mapping. Reads from ~/.pi/workflows/model-tiers.json
 * if it exists, otherwise uses sensible defaults based on common model patterns.
 */
function loadTierConfig(): Record<string, string> | null {
  const configPath = join(process.env.HOME ?? "~", ".pi", "workflows", "model-tiers.json");
  try {
    if (!existsSync(configPath)) return null;
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const config: Record<string, string> = {};
    for (const tier of ["small", "medium", "big"]) {
      if (typeof parsed[tier] === "string" && parsed[tier].trim()) config[tier] = parsed[tier];
    }
    return Object.keys(config).length > 0 ? config : null;
  } catch {}
  return null;
}

const TIER_MODELS = loadTierConfig();

function classifyTask(prompt: string): "small" | "medium" | "big" {
  const lower = prompt.toLowerCase();
  if (/\b(search|find|scan|list|explore)\b/.test(lower)) return "small";
  if (/\b(review|critique|evaluate|audit)\b/.test(lower)) return "big";
  if (/\b(analyze|reason|architect|design|plan)\b/.test(lower)) return "big";
  return "medium";
}

function resolveTier(opts: AgentOptions, prompt: string): "small" | "medium" | "big" {
  if (opts.tier) return opts.tier;
  if (opts.model) return "medium"; // explicit model, tier doesn't apply
  if (opts.taskType) {
    const tier = Object.hasOwn(TASK_TYPE_TIERS, opts.taskType) ? TASK_TYPE_TIERS[opts.taskType] : undefined;
    if (tier) return tier;
  }
  return classifyTask(prompt);
}

/**
 * Resolve the effective model spec for an agent call.
 * Priority: explicit opts.model > per-phase model > tier-based default.
 */
function resolveModel(
  opts: AgentOptions,
  assignedPhase: string | undefined,
  meta: WorkflowMeta,
  prompt: string,
): string | undefined {
  // Explicit model on the agent call wins
  if (opts.model) return opts.model;

  // Per-phase model from meta.phases
  if (assignedPhase && meta.phases) {
    const phaseDef = meta.phases.find(p => p.title === assignedPhase);
    if (phaseDef?.model) return phaseDef.model;
  }

  // Workflow-wide explicit model
  if (meta.model) return meta.model;

  // Tier-based default (requires model-tiers.json config)
  if (!TIER_MODELS) return undefined; // use pi's default model
  const tier = resolveTier(opts, prompt);
  return TIER_MODELS[tier];
}

// ── Structured output ──────────────────────────────────────────────────────

function assertJsonData(value: unknown, depth = 0, seen = new Set<object>()): void {
  if (depth > 32) throw new Error("structured output schema is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("structured output schema must be JSON data");
    return;
  }
  if (typeof value !== "object") throw new Error("structured output schema must be JSON data");
  if (seen.has(value)) throw new Error("structured output schema must not be circular");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonData(item, depth + 1, seen);
  } else {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof key !== "string") throw new Error("structured output schema has an invalid key");
      assertJsonData(item, depth + 1, seen);
    }
  }
  seen.delete(value);
}

function validateSchemaDefinition(schema: unknown, depth = 0): void {
  if (depth > 16) throw new Error("structured output schema is too deeply nested");
  if (schema === true || schema === false) return;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("structured output schema must be a JSON Schema object or boolean");
  }
  const value = schema as Record<string, unknown>;
  if (value.type !== undefined) {
    const types = Array.isArray(value.type) ? value.type : [value.type];
    if (types.some(type => typeof type !== "string" || !["object", "array", "string", "number", "integer", "boolean", "null"].includes(type))) {
      throw new Error("structured output schema has an unsupported type");
    }
  }
  if (value.properties !== undefined) {
    if (!value.properties || typeof value.properties !== "object" || Array.isArray(value.properties)) {
      throw new Error("structured output schema properties must be an object");
    }
    for (const property of Object.values(value.properties as Record<string, unknown>)) validateSchemaDefinition(property, depth + 1);
  }
  if (value.items !== undefined) validateSchemaDefinition(value.items, depth + 1);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (value[key] !== undefined) {
      if (!Array.isArray(value[key]) || value[key].length === 0) throw new Error(`structured output schema ${key} must be a non-empty array`);
      for (const member of value[key]) validateSchemaDefinition(member, depth + 1);
    }
  }
  if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some(key => typeof key !== "string"))) {
    throw new Error("structured output schema required must be an array of strings");
  }
  if (value.enum !== undefined && !Array.isArray(value.enum)) throw new Error("structured output schema enum must be an array");
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean") {
    throw new Error("structured output schema additionalProperties must be a boolean");
  }
  for (const key of ["minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum"]) {
    if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key] as number))) {
      throw new Error(`structured output schema ${key} must be a finite number`);
    }
  }
}

function normalizeStructuredOutput(opts: AgentOptions, effect: WorkflowEffect): StructuredOutputSpec | undefined {
  if (opts.output === undefined) return undefined;
  if (!opts.output || typeof opts.output !== "object" || Array.isArray(opts.output)) {
    throw new Error("agent output must be { schema, maxRetries? }");
  }
  const schema = opts.output.schema;
  assertJsonData(schema);
  const encoded = JSON.stringify(schema);
  if (!encoded || Buffer.byteLength(encoded, "utf8") > MAX_OUTPUT_SCHEMA_BYTES) {
    throw new Error(`structured output schema exceeds ${MAX_OUTPUT_SCHEMA_BYTES} bytes`);
  }
  validateSchemaDefinition(schema);
  const requestedRetries = opts.output.maxRetries ?? (effect === "read" ? MAX_STRUCTURED_RETRIES : 0);
  if (!Number.isInteger(requestedRetries) || requestedRetries < 0 || requestedRetries > MAX_STRUCTURED_RETRIES) {
    throw new Error(`output.maxRetries must be an integer between 0 and ${MAX_STRUCTURED_RETRIES}`);
  }
  if (effect !== "read" && requestedRetries > 0) {
    throw new Error('structured output retries require effect: "read"; side-effectful agents are never retried');
  }
  return {
    schema,
    maxRetries: requestedRetries,
    instruction: `Return only a JSON value matching this JSON Schema. Do not use Markdown fences or add commentary.\nSchema: ${encoded}`,
  };
}

function parseStructuredOutput(text: string): { value?: unknown; error?: string } {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return { value: JSON.parse(candidate) };
  } catch (error) {
    return { error: `response was not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
}

function schemaTypeMatches(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function validateStructuredValue(value: unknown, schema: unknown, path = "output", depth = 0): string | undefined {
  if (depth > 32) return `${path} is too deeply nested`;
  if (schema === true) return undefined;
  if (schema === false) return `${path} is not allowed by the schema`;
  if (!schema || typeof schema !== "object") return `${path} has an invalid schema`;
  const definition = schema as Record<string, unknown>;
  if (Array.isArray(definition.anyOf)) {
    if (!definition.anyOf.some(member => !validateStructuredValue(value, member, path, depth + 1))) return undefined;
    return `${path} does not match any allowed schema`;
  }
  if (Array.isArray(definition.oneOf)) {
    const matches = definition.oneOf.filter(member => !validateStructuredValue(value, member, path, depth + 1)).length;
    if (matches === 1) return undefined;
    return `${path} must match exactly one schema (matched ${matches})`;
  }
  if (Array.isArray(definition.allOf)) {
    for (const member of definition.allOf) {
      const error = validateStructuredValue(value, member, path, depth + 1);
      if (error) return error;
    }
  }
  if (definition.enum !== undefined && Array.isArray(definition.enum) && !definition.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) {
    return `${path} must be one of the schema enum values`;
  }
  if (definition.type !== undefined) {
    const types = Array.isArray(definition.type) ? definition.type : [definition.type];
    if (!types.some(type => typeof type === "string" && schemaTypeMatches(value, type))) return `${path} has the wrong type`;
  }
  if (typeof value === "string") {
    if (typeof definition.minLength === "number" && value.length < definition.minLength) return `${path} is shorter than minLength`;
    if (typeof definition.maxLength === "number" && value.length > definition.maxLength) return `${path} is longer than maxLength`;
  }
  if (typeof value === "number") {
    if (typeof definition.minimum === "number" && value < definition.minimum) return `${path} is below minimum`;
    if (typeof definition.maximum === "number" && value > definition.maximum) return `${path} is above maximum`;
  }
  if (Array.isArray(value)) {
    if (typeof definition.minItems === "number" && value.length < definition.minItems) return `${path} has too few items`;
    if (typeof definition.maxItems === "number" && value.length > definition.maxItems) return `${path} has too many items`;
    if (definition.items !== undefined) {
      for (let i = 0; i < value.length; i++) {
        const error = validateStructuredValue(value[i], definition.items, `${path}[${i}]`, depth + 1);
        if (error) return error;
      }
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (Array.isArray(definition.required)) {
      for (const key of definition.required) if (typeof key === "string" && !Object.hasOwn(object, key)) return `${path}.${key} is required`;
    }
    if (definition.properties && typeof definition.properties === "object" && !Array.isArray(definition.properties)) {
      for (const [key, propertySchema] of Object.entries(definition.properties as Record<string, unknown>)) {
        if (Object.hasOwn(object, key)) {
          const error = validateStructuredValue(object[key], propertySchema, `${path}.${key}`, depth + 1);
          if (error) return error;
        }
      }
    }
    if (definition.additionalProperties === false) {
      const allowed = definition.properties && typeof definition.properties === "object" && !Array.isArray(definition.properties)
        ? new Set(Object.keys(definition.properties as Record<string, unknown>))
        : new Set<string>();
      const extra = Object.keys(object).find(key => !allowed.has(key));
      if (extra) return `${path}.${extra} is not allowed`;
    }
  }
  return undefined;
}

// ── Determinism ────────────────────────────────────────────────────────────

function hashCall(prompt: string, opts: AgentOptions, phase?: string): string {
  return createHash("sha256")
    .update(JSON.stringify({
      prompt,
      model: opts.model ?? null,
      tier: opts.tier ?? null,
      taskType: opts.taskType ?? null,
      phase: phase ?? null,
      label: opts.label ?? null,
      effect: opts.effect ?? "write",
      isolation: opts.isolation ?? null,
      output: opts.output ? { schema: opts.output.schema, maxRetries: opts.output.maxRetries ?? null } : null,
    }))
    .digest("hex");
}

const DETERMINISM_PRELUDE = [
  '"use strict";',
  'Math.random = () => { throw new Error("Math.random() unavailable in workflow"); };',
  'const _ND = (() => { const RealDate = Date; const ND = function(...a) { if (!a.length) throw new Error("new Date() without args is non-deterministic. Use new Date(\'2024-01-01\') or Date.UTC() instead."); return new RealDate(...a); }; ND.UTC = RealDate.UTC; ND.parse = RealDate.parse; ND.now = () => { throw new Error("Date.now() unavailable in workflow"); }; ND.prototype = RealDate.prototype; Object.defineProperty(RealDate.prototype, "constructor", { value: ND, writable: true, configurable: true }); return ND; })(); globalThis.Date = _ND;',
].join("\n");

// Lines before the body starts: prelude lines + 1 for `(async () => {`
const WRAPPER_OFFSET = DETERMINISM_PRELUDE.split("\n").length + 1;

// ── Journal Persistence ────────────────────────────────────────────────────

function assertNoSymlinkPath(path: string, stopAt?: string): void {
  let current = resolve(path);
  const stop = stopAt ? resolve(stopAt) : undefined;
  const components: string[] = [];
  while (true) {
    components.push(current);
    if (current === stop || current === resolve(current, "..")) break;
    current = resolve(current, "..");
  }
  for (const component of components) {
    if (component === stop) continue;
    try {
      if (lstatSync(component).isSymbolicLink()) throw new Error(`Refusing symlinked workflow path: ${component}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function assertNotSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symlinked workflow file: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function isRegularFile(path: string): boolean {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

function readRegularFile(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Workflow state file is missing or not regular: ${path}`);
    if (stat.size > MAX_STATE_FILE_BYTES) throw new Error(`Workflow state file is too large: ${path}`);
    return readFileSync(fd, "utf-8");
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

function writeAll(fd: number, content: string): void {
  const buffer = Buffer.from(content, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error("Could not write workflow state");
    offset += written;
  }
}

function getJournalDir(cwd: string, runId: string): string {
  assertSafeRunId(runId);
  const root = canonicalCwd(cwd);
  const dir = join(root, WORKFLOW_DIR, runId);
  assertNoSymlinkPath(dir, root);
  return dir;
}

function ensurePrivateDir(dir: string, stopAt?: string): void {
  assertNoSymlinkPath(dir, stopAt);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch {}
}

function appendRunLine(cwd: string, runId: string, file: string, value: unknown): void {
  const dir = getJournalDir(cwd, runId);
  ensurePrivateDir(dir, cwd);
  const path = join(dir, file);
  assertNotSymlink(path);
  const line = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(line, "utf8") > MAX_PERSISTED_RECORD_BYTES) throw new Error(`${file} record is too large`);
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
  try {
    if (fstatSync(fd).size + Buffer.byteLength(line, "utf8") > MAX_STATE_FILE_BYTES) {
      throw new Error(`${file} exceeds the workflow state file limit`);
    }
    writeAll(fd, line);
  } finally { closeSync(fd); }
  try { chmodSync(path, 0o600); } catch {}
}

function writeJournalEntry(cwd: string, runId: string, entry: JournalEntry): void {
  // O_APPEND avoids read/modify/write races between parallel agent completions.
  appendRunLine(cwd, runId, "journal.jsonl", entry);
}

function writeRunEvent(cwd: string, runId: string, event: Record<string, unknown>): void {
  appendRunLine(cwd, runId, "events.jsonl", { timestamp: Date.now(), ...event });
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${randomUUID()}`;
  assertNotSymlink(path);
  assertNotSymlink(tmp);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    writeAll(fd, content);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    try { rmSync(tmp, { force: true }); } catch {}
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const content = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(content, "utf8") > MAX_PERSISTED_RECORD_BYTES) throw new Error("workflow persisted result is too large");
  writeAtomic(path, content);
}

function writeTextAtomic(path: string, content: string): void {
  writeAtomic(path, content);
}

function writeRunJson(cwd: string, runId: string, file: string, value: unknown): void {
  const dir = getJournalDir(cwd, runId);
  ensurePrivateDir(dir, cwd);
  writeJsonAtomic(join(dir, file), value);
}

function removeRunMarker(cwd: string, runId: string, marker: string): void {
  try { rmSync(join(getJournalDir(cwd, runId), marker), { force: true }); } catch {}
}

function readJournal(cwd: string, runId: string): Map<number, JournalEntry> {
  const journal = new Map<number, JournalEntry>();
  const path = join(getJournalDir(cwd, runId), "journal.jsonl");
  try {
    if (!isRegularFile(path)) return journal;
    for (const line of readRegularFile(path).split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as JournalEntry;
        journal.set(entry.index, entry);
      } catch {}
    }
  } catch {}
  return journal;
}

// ── Concurrency Limiter ───────────────────────────────────────────────────

async function withWorkspaceMergeLock<T>(cwd: string, fn: () => Promise<T>, key = workspaceLockKey(cwd)): Promise<T> {
  const previous = WORKSPACE_MERGE_QUEUES.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  WORKSPACE_MERGE_QUEUES.set(key, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (WORKSPACE_MERGE_QUEUES.get(key) === current) WORKSPACE_MERGE_QUEUES.delete(key);
  }
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => { active--; queue.shift()?.(); };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>(r => queue.push(r));
    active++;
    try { return await fn(); } finally { next(); }
  };
}

// ── Script Parser ──────────────────────────────────────────────────────────

function parseScriptSafe(script: string): WorkflowMeta | null {
  try {
    return parseScript(script).meta;
  } catch {
    return null;
  }
}

function stripJavaScriptLiterals(source: string): string {
  let out = "";
  let state: "code" | "single" | "double" | "template" | "line" | "block" = "code";
  let escaped = false;
  // A slash can start a regular-expression literal only where an expression may
  // begin. This small lexical distinction avoids treating /Date.now()/ as an
  // actual call while still catching `1 / Date.now()`.
  let regexAllowed = true;
  const regexAfterWord = new Set(["await", "case", "delete", "else", "in", "instanceof", "of", "return", "throw", "typeof", "void", "yield"]);
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === "line") {
      out += ch === "\n" ? "\n" : " ";
      if (ch === "\n") state = "code";
      continue;
    }
    if (state === "block") {
      out += ch === "\n" ? "\n" : " ";
      if (ch === "*" && next === "/") { out += " "; i++; state = "code"; }
      continue;
    }
    if (state === "single" || state === "double" || state === "template") {
      out += ch === "\n" ? "\n" : "_";
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if ((state === "single" && ch === "'") || (state === "double" && ch === '"') || (state === "template" && ch === "`")) {
        state = "code";
        regexAllowed = false;
      }
      continue;
    }
    if (ch === "/" && next === "/") { out += "  "; i++; state = "line"; continue; }
    if (ch === "/" && next === "*") { out += "  "; i++; state = "block"; continue; }
    if (ch === "/" && regexAllowed) {
      let end = i + 1;
      let inClass = false;
      let regexEscaped = false;
      let closed = false;
      for (; end < source.length; end++) {
        const regexChar = source[end];
        if (regexChar === "\n" || regexChar === "\r") break;
        if (regexEscaped) { regexEscaped = false; continue; }
        if (regexChar === "\\") { regexEscaped = true; continue; }
        if (regexChar === "[") { inClass = true; continue; }
        if (regexChar === "]") { inClass = false; continue; }
        if (regexChar === "/" && !inClass) {
          end++;
          while (/[A-Za-z]/.test(source[end] ?? "")) end++;
          closed = true;
          break;
        }
      }
      if (closed) {
        out += source.slice(i, end).replace(/[^\r\n]/g, "_");
        i = end - 1;
        regexAllowed = false;
        continue;
      }
      // An unterminated slash is left for the real JavaScript parser to report.
      out += ch;
      regexAllowed = true;
      continue;
    }
    if (ch === "'") { out += " "; state = "single"; regexAllowed = false; continue; }
    if (ch === '"') { out += " "; state = "double"; regexAllowed = false; continue; }
    if (ch === "`") { out += " "; state = "template"; regexAllowed = false; continue; }
    if (/[A-Za-z_$]/.test(ch)) {
      const word = source.slice(i).match(/^[A-Za-z_$][\\w$]*/)?.[0] ?? ch;
      out += word;
      i += word.length - 1;
      regexAllowed = regexAfterWord.has(word);
      continue;
    }
    out += ch;
    if (/\\d/.test(ch)) regexAllowed = false;
    else if (")]}".includes(ch) || ch === ".") regexAllowed = false;
    else regexAllowed = "([{,:;=!?&|+-*%^~<>".includes(ch);
  }
  return out;
}

class LiteralParser {
  private index = 0;
  private nodes = 0;
  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.value();
    this.ws();
    if (this.index !== this.source.length) throw new Error("unexpected token after meta object");
    return value;
  }

  private ws(): void {
    while (this.index < this.source.length && /\s/.test(this.source[this.index]!)) this.index++;
  }

  private value(): unknown {
    if (++this.nodes > MAX_META_NODES) throw new Error("meta object is too deeply nested");
    this.ws();
    const ch = this.source[this.index];
    if (ch === "{") return this.object();
    if (ch === "[") return this.array();
    if (ch === '"' || ch === "'") return this.string();
    if (this.source.startsWith("true", this.index)) { this.index += 4; return true; }
    if (this.source.startsWith("false", this.index)) { this.index += 5; return false; }
    if (this.source.startsWith("null", this.index)) { this.index += 4; return null; }
    const number = this.source.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) { this.index += number[0].length; return Number(number[0]); }
    throw new Error(`unsupported meta value at ${this.index + 1}`);
  }

  private key(): string {
    this.ws();
    const ch = this.source[this.index];
    if (ch === '"' || ch === "'") return this.string();
    const match = this.source.slice(this.index).match(/^[A-Za-z_$][\w$]*/);
    if (!match) throw new Error(`invalid meta key at ${this.index + 1}`);
    this.index += match[0].length;
    return match[0];
  }

  private object(): Record<string, unknown> {
    const result: Record<string, unknown> = Object.create(null);
    this.index++;
    this.ws();
    if (this.source[this.index] === "}") { this.index++; return result; }
    while (true) {
      const name = this.key();
      this.ws();
      if (this.source[this.index] !== ":") throw new Error(`expected ':' after ${name}`);
      this.index++;
      result[name] = this.value();
      this.ws();
      if (this.source[this.index] === "}") { this.index++; return result; }
      if (this.source[this.index] !== ",") throw new Error("expected ',' in meta object");
      this.index++;
      this.ws();
      if (this.source[this.index] === "}") { this.index++; return result; }
    }
  }

  private array(): unknown[] {
    const result: unknown[] = [];
    this.index++;
    this.ws();
    if (this.source[this.index] === "]") { this.index++; return result; }
    while (true) {
      result.push(this.value());
      this.ws();
      if (this.source[this.index] === "]") { this.index++; return result; }
      if (this.source[this.index] !== ",") throw new Error("expected ',' in meta array");
      this.index++;
      this.ws();
      if (this.source[this.index] === "]") { this.index++; return result; }
    }
  }

  private string(): string {
    const quote = this.source[this.index++];
    let result = "";
    let escaped = false;
    while (this.index < this.source.length) {
      const ch = this.source[this.index++];
      if (escaped) {
        const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"' };
        if (ch === "u") {
          const hex = this.source.slice(this.index, this.index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("invalid unicode escape in meta");
          result += String.fromCharCode(parseInt(hex, 16));
          this.index += 4;
        } else {
          result += escapes[ch] ?? ch;
        }
        escaped = false;
        continue;
      }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === quote) return result;
      if (ch === "\n" || ch === "\r") throw new Error("unterminated string in meta");
      result += ch;
    }
    throw new Error("unterminated string in meta");
  }
}

function parseMetaLiteral(metaStr: string): WorkflowMeta {
  const raw = new LiteralParser(metaStr).parse();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("meta must be a literal object");
  const value = raw as Record<string, unknown>;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim()) throw new Error("meta.description must be a non-empty string");
  if (value.model !== undefined && typeof value.model !== "string") throw new Error("meta.model must be a string");
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof (phase as any).title !== "string" || !(phase as any).title.trim()) {
        throw new Error("each phase must have a non-empty title");
      }
      if ((phase as any).model !== undefined && typeof (phase as any).model !== "string") {
        throw new Error("phase.model must be a string");
      }
    }
  }
  return value as unknown as WorkflowMeta;
}

function parseScript(script: string): { meta: WorkflowMeta; body: string } {
  if (Buffer.byteLength(script, "utf8") > MAX_WORKFLOW_SCRIPT_BYTES) {
    throw new Error(`Workflow script is too large (maximum ${MAX_WORKFLOW_SCRIPT_BYTES} bytes)`);
  }
  const code = stripJavaScriptLiterals(script);
  if (/\bDate\.now\b|\bMath\.random\b|\bnew Date\s*\(\s*\)/.test(code)) {
    throw new Error("Workflow scripts must be deterministic (no Date.now()/Math.random()/new Date()). Explicit dates like new Date(\"2024-01-01\") are allowed.");
  }

  // Find the meta object without evaluating user-controlled code. Leading comments
  // are trivia; the export itself must still be the first statement.
  const leadingTrivia = script.match(/^(?:\s|\/\/[^\r\n]*(?:\r\n|\r|\n|$)|\/\*[\s\S]*?\*\/)*/);
  const metaOffset = leadingTrivia?.[0].length ?? 0;
  const metaStart = script.slice(metaOffset).match(/^export\s+const\s+meta\s*=\s*\{/);
  if (metaStart?.index == null) throw new Error("Script must start with: export const meta = { name, description }");

  const startIdx = script.indexOf("{", metaOffset + metaStart[0].length - 1);
  let depth = 0;
  let endIdx = -1;
  let quote: string | undefined;
  let escaped = false;
  for (let i = startIdx; i < script.length; i++) {
    const ch = script[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) { endIdx = i; break; }
  }
  if (endIdx === -1) throw new Error("Unmatched braces in meta object");

  const metaEnd = endIdx + 1;
  const afterMeta = script[metaEnd] === ";" ? metaEnd + 1 : metaEnd;
  let meta: WorkflowMeta;
  try { meta = parseMetaLiteral(script.slice(startIdx, metaEnd)); }
  catch (error) { throw new Error(`Invalid meta object: ${error instanceof Error ? error.message : String(error)}`); }
  return { meta, body: script.slice(afterMeta) };
}

// ── Agent Execution via Pi SDK ─────────────────────────────────────────────

/**
 * Extract the last assistant text from session messages.
 * Iterates backwards to find the most recent response.
 */
function extractAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const text = msg.content
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("");
    if (text.trim()) return text;
  }
  return "";
}

function getAssistantFailure(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason === "error" || msg.stopReason === "aborted") {
      return msg.errorMessage || `assistant stopped with ${msg.stopReason}`;
    }
  }
  return undefined;
}

/**
 * Create an isolated agent session and run a prompt.
 * Returns the assistant's text and real token usage from pi's session stats.
 */
// Lazy-load pi SDK singletons (created once, reused across all agent calls in a workflow)
let _sdk: { createAgentSession: any; createCodingTools: any; DefaultResourceLoader: any; AuthStorage: any; ModelRegistry: any; SessionManager: any; SettingsManager: any } | undefined;
async function loadSdk() {
  if (!_sdk) {
    // @ts-ignore — runtime import from pi's core SDK
    _sdk = await import("@earendil-works/pi-coding-agent");
  }
  return _sdk;
}

// Auth + registry created once per process
let _auth: any;
let _registry: any;
function getAuthAndRegistry() {
  if (!_auth) {
    const sdk = _sdk!;
    const agentDir = join(process.env.HOME ?? "~", ".pi", "agent");
    _auth = sdk.AuthStorage.create(join(agentDir, "auth.json"));
    _registry = sdk.ModelRegistry.create(_auth, join(agentDir, "models.json"));
  }
  return { auth: _auth, registry: _registry };
}

async function runSdkWorker(
  options: WorkerRequest,
): Promise<WorkerResult> {
  const { prompt } = options;
  const sdk = await loadSdk();
  const fallback = getAuthAndRegistry();
  const registry = options.runtime?.modelRegistry ?? fallback.registry;
  const authStorage = options.runtime?.authStorage ?? registry.authStorage ?? fallback.auth;
  const agentDir = options.runtime?.agentDir ?? join(process.env.HOME ?? "~", ".pi", "agent");

  // Resolve model from the parent registry. An explicit unknown model is an error,
  // never a silent fallback to the user's default model.
  let model: any | undefined = options.runtime?.defaultModel;
  if (options.model) {
    const slash = options.model.indexOf("/");
    if (slash <= 0) throw new Error(`Model must use provider/id form: ${options.model}`);
    model = registry.find(options.model.slice(0, slash), options.model.slice(slash + 1));
    if (!model) throw new Error(`Model not found in the active Pi registry: ${options.model}`);
  }
  if (model && options.maxOutputTokens && Number.isFinite(model.maxTokens)) {
    model = { ...model, maxTokens: Math.max(1, Math.min(model.maxTokens, options.maxOutputTokens)) };
  }

  if (options.signal?.aborted) throw new WorkflowControlError("aborted", "Workflow aborted");

  let session: any;
  try {
    const settingsManager = sdk.SettingsManager.create(options.cwd, agentDir);
    // Leaf workers keep Pi's skills/context and active registry, but do not rediscover
    // extension factories. Loading the host extension set once per worker would repeat
    // arbitrary initialization and could recursively register workflow tooling.
    let resourceLoader: any;
    if (typeof sdk.DefaultResourceLoader === "function") {
      // Older Pi hosts may not export this loader; retain SDK compatibility there.
      resourceLoader = new sdk.DefaultResourceLoader({
        cwd: options.cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        appendSystemPrompt: [SDK_WORKER_LEAF_GUIDANCE],
      });
      await resourceLoader.reload();
    }
    ({ session } = await sdk.createAgentSession({
      cwd: options.cwd,
      agentDir,
      authStorage,
      modelRegistry: registry,
      sessionManager: sdk.SessionManager.inMemory(),
      settingsManager,
      ...(resourceLoader ? { resourceLoader } : {}),
      customTools: sdk.createCodingTools(options.cwd),
      tools: options.tools ? [...options.tools] : [...SDK_WORKER_TOOLS],
      model,
    }));
  } catch (error) {
    if (options.signal?.aborted) throw new WorkflowControlError("aborted", "Workflow aborted");
    throw error;
  }

  let removeAbortListener: (() => void) | undefined;
  const onAbort = () => session.abort();
  if (options.signal) {
    if (options.signal.aborted) session.abort();
    else {
      options.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
    }
  }

  try {
    await session.prompt(`Task: ${options.label}\n\n${prompt}`);
    const failure = getAssistantFailure(session.messages);
    if (failure) {
      if (options.signal?.aborted || failure.includes("aborted")) {
        throw new WorkflowControlError("aborted", "Workflow aborted");
      }
      throw new Error(failure);
    }

    const text = extractAssistantText(session.messages);
    if (Buffer.byteLength(text, "utf8") > MAX_AGENT_RESULT_BYTES) throw new Error(`agent output exceeds ${MAX_AGENT_RESULT_BYTES} bytes`);
    const stats = session.getSessionStats();
    const cost = Number.isFinite(stats.cost) ? stats.cost : 0;
    const finalAssistant = [...session.messages].reverse().find((message: any) => message?.role === "assistant") as any;
    return {
      text: text || `[${options.label}: no text output]`,
      tokens: {
        input: stats.tokens.input,
        output: stats.tokens.output,
        total: stats.tokens.total,
        cost,
      },
      model: finalAssistant?.model,
      stopReason: finalAssistant?.stopReason,
    };
  } catch (error) {
    if (options.signal?.aborted) throw new WorkflowControlError("aborted", "Workflow aborted");
    throw error;
  } finally {
    removeAbortListener?.();
    session.dispose();
  }
}

const SDK_WORKER_BACKEND: WorkerBackend = {
  id: SDK_WORKER_BACKEND_ID,
  toolIdentity: `write:${SDK_WORKER_TOOLS.join(",")};read:${SDK_READ_ONLY_WORKER_TOOLS.join(",")}`,
  contextIdentity: SDK_WORKER_CONTEXT_IDENTITY,
  run: runSdkWorker,
};

function selectWorkerBackend(runtime?: WorkflowRuntime): WorkerBackend {
  return runtime?.workerBackend ?? SDK_WORKER_BACKEND;
}

// ── Workflow Runtime ───────────────────────────────────────────────────────

/**
 * Heuristically suggest a likely cause for common V8 syntax errors.
 * Returns an empty string if no heuristic matches.
 */
function suggestSyntaxFix(message: string, body: string): string {
  const tips: string[] = [];
  if (/missing \) after argument list/i.test(message)) {
    const openParens = (body.match(/\(/g) || []).length;
    const closeParens = (body.match(/\)/g) || []).length;
    if (openParens > closeParens) {
      tips.push(`Unbalanced parentheses: ${openParens} opening vs ${closeParens} closing. Check agent() and parallel() calls for missing closing ")"`);
    }
    const backtickCount = (body.match(/`/g) || []).length;
    if (backtickCount % 2 !== 0) {
      tips.push(`Odd number of backticks (${backtickCount}): a template literal is missing its closing backtick`);
    }
  }
  if (/unexpected end of input/i.test(message)) {
    const openBraces = (body.match(/\{/g) || []).length;
    const closeBraces = (body.match(/\}/g) || []).length;
    if (openBraces > closeBraces) {
      tips.push(`Unbalanced braces: ${openBraces} opening vs ${closeBraces} closing. Check for missing "}"`);
    }
    const openBrackets = (body.match(/\[/g) || []).length;
    const closeBrackets = (body.match(/\]/g) || []).length;
    if (openBrackets > closeBrackets) {
      tips.push(`Unbalanced brackets: ${openBrackets} opening vs ${closeBrackets} closing. Check for missing "]"`);
    }
  }
  return tips.length > 0 ? `\n\n  Likely cause: ${tips.join("; ")}` : "";
}

/**
 * Eagerly validate script syntax. Returns null if valid, or an enriched SyntaxError.
 *
 * Bun's `node:vm.Script` DEFERS parsing — `new vm.Script(brokenCode)` succeeds and
 * the SyntaxError only surfaces at `runInContext()` time. We use `new Function()`
 * instead, which eagerly parses on both Node and Bun, so syntax errors are caught
 * before backgrounding rather than failing asynchronously.
 */
function validateSyntax(body: string, metaName: string): SyntaxError | null {
  const wrapped = `${DETERMINISM_PRELUDE}\n(async () => {\n${body}\n})()`;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(wrapped);
    return null;
  } catch (err) {
    if (err instanceof SyntaxError) {
      return enrichSyntaxError(err, body, metaName);
    }
    // Non-SyntaxError from Function constructor — wrap as a generic error
    const synthetic = new SyntaxError(err instanceof Error ? err.message : String(err));
    return enrichSyntaxError(synthetic, body, metaName);
  }
}

/**
 * Enrich a vm.Script SyntaxError with line:column context from the original script body.
 * V8 errors include `filename:line:col` in the stack trace — we offset by the prelude
 * lines to map back to the user's script.
 */
function enrichSyntaxError(err: SyntaxError, body: string, filename = "workflow"): SyntaxError {
  const originalMessage = err.message;
  const lines = body.split("\n");
  const lineMatch = err.stack?.match(/:(\d+):(\d+)/);
  let enriched = originalMessage;
  if (lineMatch) {
    const rawLine = parseInt(lineMatch[1], 10);
    const col = parseInt(lineMatch[2], 10);
    const scriptLine = rawLine - WRAPPER_OFFSET - 1; // 0-indexed into body
    if (scriptLine >= 0 && scriptLine < lines.length) {
      const start = Math.max(0, scriptLine - 2);
      const end = Math.min(lines.length, scriptLine + 3);
      const context = [] as string[];
      for (let i = start; i < end; i++) {
        const marker = i === scriptLine ? ">>>" : "   ";
        context.push(`  ${marker} ${i + 1}: ${lines[i]}`);
        if (i === scriptLine) {
          context.push(`         ${" ".repeat(col)}^`);
        }
      }
      enriched = `${enriched}\n\n  at ${filename}.js:${scriptLine + 1}:${col}\n\n${context.join("\n")}`;
    }
  }
  enriched += suggestSyntaxFix(originalMessage, body);
  err.message = enriched;
  return err;
}

async function executeWorkflowCore(
  script: string,
  options: ExecuteWorkflowOptions = {},
): Promise<WorkflowRunResult> {
  const started = Date.now();
  const { meta, body } = parseScript(script);
  const cwd = canonicalCwd(options.cwd ?? process.cwd());
  const runId = options.runId ?? `run-${randomUUID()}`;
  assertSafeRunId(runId);
  const workspaceKey = workspaceLockKey(cwd);
  const maxAgents = Math.floor(options.maxAgents ?? MAX_AGENTS);
  if (!Number.isFinite(maxAgents) || maxAgents < 1 || maxAgents > MAX_AGENTS) {
    throw new Error(`maxAgents must be an integer between 1 and ${MAX_AGENTS}`);
  }
  const tokenBudget = options.tokenBudget == null ? null : finiteNonNegative(options.tokenBudget, "tokenBudget")!;
  const timeoutInput = options.timeoutMs == null ? MAX_WORKFLOW_TIMEOUT_MS : finiteNonNegative(options.timeoutMs, "timeoutMs")!;
  if (timeoutInput <= 0) throw new Error("timeoutMs must be greater than zero");
  const timeoutMs = Math.min(MAX_WORKFLOW_TIMEOUT_MS, Math.max(1, Math.floor(timeoutInput)));

  const state = {
    logs: [] as string[],
    phases: meta.phases?.[0]?.title ? [meta.phases[0].title] : [] as string[],
    currentPhase: meta.phases?.[0]?.title as string | undefined,
    callSeq: 0,
    firstMiss: Number.POSITIVE_INFINITY,
  };

  const shared = {
    limiter: createLimiter(MAX_CONCURRENCY),
    mergeLimiter: createLimiter(1),
    agentCount: 0,
    spent: 0,
    reserved: 0,
    phaseUsage: new Map<string, number>(),
    phaseReserved: new Map<string, number>(),
    tokenUsage: { input: 0, output: 0, total: 0, cost: 0 },
    activeCanonicalWrites: 0,
  };

  // Per-phase sub-budgets: phase title -> consumed usage and reservation.
  const phaseBudgets = new Map<string, { budget: number; warned: boolean }>();

  let logBytes = 0;
  const log = (msg: string) => {
    if (typeof msg !== "string") throw new TypeError("log() expects a string");
    const text = msg;
    const bytes = Buffer.byteLength(text, "utf8");
    if (state.logs.length >= MAX_LOG_ENTRIES || logBytes + bytes > MAX_LOG_BYTES) throw new Error("workflow log limit exceeded");
    state.logs.push(text);
    logBytes += bytes;
  };
  const phase = (title: string, opts?: { budget?: number }) => {
    if (typeof title !== "string" || !title.trim()) throw new Error("phase() requires a non-empty title");
    state.currentPhase = title;
    if (!state.phases.includes(title)) state.phases.push(title);
    if (opts?.budget !== undefined) {
      const phaseBudget = finiteNonNegative(opts.budget, `phase ${title} budget`)!;
      if (phaseBudget <= 0) throw new Error(`Phase "${title}" budget must be greater than zero`);
      // Re-entering a phase must not reset an already-consumed budget.
      if (!phaseBudgets.has(title)) phaseBudgets.set(title, { budget: phaseBudget, warned: false });
    }
  };

  const budget = Object.freeze({
    total: tokenBudget,
    spent: () => shared.spent,
    remaining: () => tokenBudget == null ? Infinity : Math.max(0, tokenBudget - shared.spent),
  });

  const throwIfAborted = () => {
    if (options.signal?.aborted) throw new WorkflowControlError("aborted", "Workflow aborted");
  };

  const throwIfPaused = () => {
    if (isRegularFile(join(getJournalDir(cwd, runId), "paused"))) {
      throw new WorkflowControlError("paused", "Workflow paused");
    }
  };

  const update = (text: string) => {
    try { options.runtime?.onUpdate?.({ content: [{ type: "text", text }], details: { runId } }); } catch {}
  };

  const reserveBudget = (estimatedInput: number, assignedPhase?: string): number => {
    const remaining = tokenBudget == null ? Infinity : tokenBudget - shared.spent - shared.reserved;
    if (remaining <= 0) throw new Error("Token budget exhausted");
    if (estimatedInput >= remaining) throw new Error("Token budget is smaller than the agent prompt");
    const pb = assignedPhase ? phaseBudgets.get(assignedPhase) : undefined;
    const phaseRemaining = pb ? pb.budget - (shared.phaseUsage.get(assignedPhase!) ?? 0) - (shared.phaseReserved.get(assignedPhase!) ?? 0) : Infinity;
    if (phaseRemaining <= estimatedInput) throw new Error(`Phase "${assignedPhase}" budget is smaller than the agent prompt`);
    // Reserve a bounded output allowance before starting. The SDK's model maxTokens
    // is lowered to this allowance; actual usage is reconciled on completion.
    const reservation = Math.max(1, Math.min(8192, remaining - estimatedInput, phaseRemaining - estimatedInput));
    if (tokenBudget != null) shared.reserved += reservation;
    if (pb && assignedPhase) shared.phaseReserved.set(assignedPhase, (shared.phaseReserved.get(assignedPhase) ?? 0) + reservation);
    return tokenBudget == null && !pb ? 0 : reservation;
  };

  // ── agent() — the core primitive ──────────────────────────────────

  const agent = async (prompt: string, opts: AgentOptions = {}): Promise<unknown> => {
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("agent() requires a non-empty prompt");
    if (Buffer.byteLength(prompt, "utf8") > MAX_WORKFLOW_SCRIPT_BYTES) throw new Error("agent() prompt is too large");
    throwIfAborted();
    throwIfPaused();
    if (shared.agentCount >= maxAgents) throw new Error(`Agent limit exceeded (${maxAgents})`);

    const assignedPhase = opts.phase ?? state.currentPhase;
    const pb = assignedPhase ? phaseBudgets.get(assignedPhase) : undefined;
    if (pb) {
      const phaseSpent = shared.phaseUsage.get(assignedPhase!) ?? 0;
      if (phaseSpent >= pb.budget) throw new Error(`Phase "${assignedPhase}" budget exhausted (${pb.budget})`);
      if (!pb.warned && phaseSpent >= pb.budget * 0.8) {
        pb.warned = true;
        log(`Phase "${assignedPhase}" at ${Math.round((phaseSpent / pb.budget) * 100)}% of budget`);
      }
    }
    if (opts.isolation !== undefined && opts.isolation !== "worktree") {
      throw new Error('agent isolation must be "worktree" when provided');
    }
    if (opts.tier !== undefined && opts.tier !== "small" && opts.tier !== "medium" && opts.tier !== "big") {
      throw new Error('agent tier must be "small", "medium", or "big" when provided');
    }
    const model = resolveModel(opts, assignedPhase, meta, prompt);
    const effect = opts.effect ?? "write";
    if (effect !== "read" && effect !== "write") throw new Error(`agent effect must be "read" or "write"`);
    const structuredOutput = normalizeStructuredOutput(opts, effect);
    const label = opts.label?.trim() || `${assignedPhase ?? "agent"} ${state.callSeq + 1}`;
    if (Buffer.byteLength(label, "utf8") > 256) throw new Error("agent label is too large");
    const callIndex = state.callSeq++;
    shared.agentCount++;
    const callHash = hashCall(prompt, { ...opts, model: model ?? opts.model }, assignedPhase);
    const cached = options.resumeJournal?.get(callIndex);

    if (cached?.hash === callHash && callIndex < state.firstMiss) {
      const cachedUsage = validateTokenUsage(cached.tokens, `cached agent ${callIndex}`);
      const cachedTokens = cachedUsage.total;
      if (tokenBudget != null && shared.spent + cachedTokens > tokenBudget) {
        throw new Error("Cached workflow results exceed the requested token budget");
      }
      shared.tokenUsage.input += cachedUsage.input;
      shared.tokenUsage.output += cachedUsage.output;
      shared.tokenUsage.total += cachedTokens;
      shared.tokenUsage.cost += cachedUsage.cost;
      shared.spent += cachedTokens;
      notifyExecutionUsage(options.runtime, cachedUsage);
      if (assignedPhase) shared.phaseUsage.set(assignedPhase, (shared.phaseUsage.get(assignedPhase) ?? 0) + cachedTokens);
      const cachedPhaseBudget = assignedPhase ? phaseBudgets.get(assignedPhase) : undefined;
      if (cachedPhaseBudget && (shared.phaseUsage.get(assignedPhase!) ?? 0) > cachedPhaseBudget.budget) throw new Error(`Cached results exceed phase "${assignedPhase}" budget`);
      writeRunEvent(cwd, runId, { type: "cached", index: callIndex, label, phase: assignedPhase, tokens: cachedTokens });
      update(`workflow ${runId}: resumed agent ${label}`);
      return cached.result;
    }
    state.firstMiss = Math.min(state.firstMiss, callIndex);
    const attempts = structuredOutput ? structuredOutput.maxRetries + 1 : 1;
    const workerPrompt = structuredOutput ? `${prompt}\n\n${structuredOutput.instruction}` : prompt;
    const reservation = reserveBudget((Math.ceil((workerPrompt.length + label.length) / 4) + ESTIMATED_SYSTEM_TOKENS) * attempts, assignedPhase);

    return shared.limiter(async () => {
      const agentStart = Date.now();
      let worktreePath: string | undefined;
      let preserveWorktree = false;
      let canonicalWrite = false;
      let releaseWorkspaceMutation = () => {};
      const canonicalWriteKey = workspaceKey;
      let callUsage = { input: 0, output: 0, total: 0, cost: 0 };
      const worktreeName = `${runId}-${callIndex}-${randomUUID().slice(0, 8)}`;
      try {
        throwIfAborted();
        if (effect === "write" && !opts.isolation) {
          if (shared.activeCanonicalWrites > 0 || ACTIVE_CANONICAL_WRITES.has(canonicalWriteKey)) {
            throw new Error(`Parallel write agents require isolation: "worktree"`);
          }
          releaseWorkspaceMutation = claimWorkspaceMutation(cwd, workspaceKey);
          shared.activeCanonicalWrites++;
          ACTIVE_CANONICAL_WRITES.add(canonicalWriteKey);
          canonicalWrite = true;
        }
        if (opts.isolation === "worktree") {
          worktreePath = join(cwd, ".pi/worktrees", worktreeName);
          const worktreesDir = join(cwd, ".pi/worktrees");
          assertNoSymlinkPath(worktreesDir, cwd);
          mkdirSync(worktreesDir, { recursive: true, mode: 0o700 });
          try { chmodSync(worktreesDir, 0o700); } catch {}
          assertNoSymlinkPath(worktreePath, cwd);
          // Fail closed: isolation must never silently degrade to the main checkout.
          execFileSync("git", ["worktree", "add", "--detach", worktreePath], { cwd, stdio: "ignore" });
          try { chmodSync(worktreePath, 0o700); } catch {}
        }
        let agentCwd = cwd;
        if (worktreePath) {
          const relativeCwd = relative(workspaceKey, cwd);
          if (isAbsolute(relativeCwd) || relativeCwd === ".." || relativeCwd.startsWith(`..${sep}`)) {
            throw new Error("workflow cwd is outside the Git worktree root");
          }
          agentCwd = join(worktreePath, relativeCwd);
        }
        writeRunEvent(cwd, runId, { type: "started", index: callIndex, label, phase: assignedPhase, effect, isolation: !!worktreePath });
        update(`workflow ${runId}: running ${label}`);
        const worker = selectWorkerBackend(options.runtime);
        const maxOutputTokens = reservation > 0 ? Math.max(1, Math.floor(reservation / attempts)) : undefined;
        let resultValue: unknown;
        let completed = false;
        let lastStructuredError = "structured output did not match the requested schema";
        for (let attempt = 0; attempt < attempts; attempt++) {
          throwIfAborted();
          const retryPrompt = attempt === 0 ? workerPrompt : `${workerPrompt}\n\nPrevious response failed validation: ${lastStructuredError}. Return a corrected JSON value only.`;
          const workerResult = await worker.run({
            prompt: retryPrompt,
            label,
            model,
            cwd: agentCwd,
            signal: options.signal,
            runtime: options.runtime,
            maxOutputTokens,
            tools: effect === "read" ? [...SDK_READ_ONLY_WORKER_TOOLS] : [...SDK_WORKER_TOOLS],
          });
          if (Buffer.byteLength(workerResult.text, "utf8") > MAX_AGENT_RESULT_BYTES) throw new Error(`agent output exceeds ${MAX_AGENT_RESULT_BYTES} bytes`);
          throwIfAborted();

          const tokens = validateTokenUsage(workerResult.tokens, `worker ${label}`);
          callUsage = {
            input: callUsage.input + tokens.input,
            output: callUsage.output + tokens.output,
            total: callUsage.total + tokens.total,
            cost: callUsage.cost + tokens.cost,
          };
          shared.tokenUsage.input += tokens.input;
          shared.tokenUsage.output += tokens.output;
          shared.tokenUsage.total += tokens.total;
          shared.tokenUsage.cost += tokens.cost;
          shared.spent += tokens.total;
          notifyExecutionUsage(options.runtime, tokens);
          if (assignedPhase) shared.phaseUsage.set(assignedPhase, (shared.phaseUsage.get(assignedPhase) ?? 0) + tokens.total);
          if (tokenBudget != null && shared.spent > tokenBudget) throw new Error(`Token budget exceeded (${shared.spent}/${tokenBudget})`);
          if (pb && (shared.phaseUsage.get(assignedPhase!) ?? 0) > pb.budget) throw new Error(`Phase "${assignedPhase}" budget exceeded (${pb.budget})`);

          if (!structuredOutput) {
            resultValue = workerResult.text;
            completed = true;
            break;
          }
          const parsed = parseStructuredOutput(workerResult.text);
          const validationError = parsed.error ?? validateStructuredValue(parsed.value, structuredOutput.schema);
          if (!validationError) {
            resultValue = parsed.value;
            completed = true;
            break;
          }
          lastStructuredError = validationError;
          if (attempt + 1 < attempts) {
            writeRunEvent(cwd, runId, { type: "retry", index: callIndex, label, phase: assignedPhase, attempt: attempt + 1, error: validationError });
          }
        }
        if (!completed) throw new Error(`Structured output validation failed: ${lastStructuredError}`);

        if (worktreePath) {
          await withWorkspaceMergeLock(cwd, () => withWorkspaceMutationLock(cwd, () => shared.mergeLimiter(async () => {
            const status = execFileSync("git", ["status", "--porcelain"], { cwd: worktreePath, encoding: "utf-8" }).trim();
            if (!status) return;
            execFileSync("git", ["add", "-A"], { cwd: worktreePath, stdio: "ignore" });
            execFileSync("git", ["commit", "-m", `workflow ${label}`, "--no-verify"], { cwd: worktreePath, stdio: "ignore" });
            const commitHash = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf-8" }).trim();
            const mainStatus = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: workspaceKey, encoding: "utf-8" });
            if (filterWorkflowManagedGitStatus(mainStatus, cwd, workspaceKey)) {
              preserveWorktree = true;
              throw new Error("main checkout has uncommitted changes; worktree merge refused");
            }
            try {
              execFileSync("git", ["cherry-pick", commitHash, "--no-edit"], { cwd, stdio: "ignore" });
            } catch (error) {
              try { execFileSync("git", ["cherry-pick", "--abort"], { cwd, stdio: "ignore" }); } catch {}
              preserveWorktree = true;
              throw new Error(`worktree merge conflict for "${label}"; preserved at ${worktreePath}`);
            }
          }), workspaceKey), workspaceKey);
        }

        writeJournalEntry(cwd, runId, {
          index: callIndex,
          hash: callHash,
          result: resultValue,
          tokens: callUsage,
          durationMs: Date.now() - agentStart,
        });
        writeRunEvent(cwd, runId, { type: "completed", index: callIndex, label, phase: assignedPhase, usage: callUsage, durationMs: Date.now() - agentStart });
        update(`workflow ${runId}: completed ${label}`);
        return resultValue;
      } catch (error) {
        if (worktreePath) preserveWorktree = true;
        const control = decodeWorkflowControl(error);
        const message = error instanceof Error ? error.message : String(error);
        writeRunEvent(cwd, runId, { type: control ? "cancelled" : "failed", index: callIndex, label, phase: assignedPhase, error: message, usage: callUsage, durationMs: Date.now() - agentStart });
        if (control) throw control;
        log(`agent "${label}" failed: ${message}`);
        throw new WorkflowAgentError(label, message);
      } finally {
        shared.reserved = Math.max(0, shared.reserved - reservation);
        if (assignedPhase) shared.phaseReserved.set(assignedPhase, Math.max(0, (shared.phaseReserved.get(assignedPhase) ?? 0) - reservation));
        if (canonicalWrite) {
          shared.activeCanonicalWrites = Math.max(0, shared.activeCanonicalWrites - 1);
          ACTIVE_CANONICAL_WRITES.delete(canonicalWriteKey);
          releaseWorkspaceMutation();
        }
        if (worktreePath && !preserveWorktree) {
          try { execFileSync("git", ["worktree", "remove", worktreePath, "--force"], { cwd, stdio: "ignore" }); } catch {}
        }
      }
    });
  };

  // ── parallel() ────────────────────────────────────────────────────
  // Assigned after the VM context exists; invoking VM callbacks through
  // runInContext keeps synchronous callback loops under the VM timeout.
  let invokeWorkflowFunction = (fn: (...args: any[]) => unknown, args: unknown[]) => fn(...args);

  const parallel = async (thunks: Array<() => Promise<unknown>>): Promise<unknown[]> => {
    throwIfAborted();
    if (!Array.isArray(thunks) || thunks.some(t => typeof t !== "function")) {
      throw new TypeError("parallel() expects an array of functions");
    }
    if (thunks.length > MAX_PARALLEL_ITEMS || thunks.length > maxAgents) {
      throw new Error(`parallel() accepts at most ${Math.min(MAX_PARALLEL_ITEMS, maxAgents)} items`);
    }
    // Fail-fast is intentional, but drain siblings before terminalizing so they
    // cannot keep spending, writing journals, or merging worktrees afterward.
    const settled = await Promise.allSettled(thunks.map(thunk => Promise.resolve().then(() => invokeWorkflowFunction(thunk, []))));
    const failure = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    if (failure) throw failure.reason;
    return settled.map(entry => (entry as PromiseFulfilledResult<unknown>).value);
  };

  // ── pipeline() ────────────────────────────────────────────────────

  const pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ): Promise<unknown[]> => {
    throwIfAborted();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array");
    if (items.length > MAX_PARALLEL_ITEMS) throw new Error(`pipeline() accepts at most ${MAX_PARALLEL_ITEMS} items`);
    if (stages.some(stage => typeof stage !== "function")) throw new TypeError("pipeline() stages must be functions");
    const settled = await Promise.allSettled(items.map(async (item, i) => {
      let value = item;
      for (const stage of stages) {
        throwIfAborted();
        throwIfPaused();
        value = await invokeWorkflowFunction(stage, [value, item, i]);
        throwIfAborted();
      }
      return value;
    }));
    const failure = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    if (failure) throw failure.reason;
    return settled.map(entry => (entry as PromiseFulfilledResult<unknown>).value);
  };

  // ── Quality helpers ─────────────────────────────────────────────────

  const verify = async (item: unknown, opts?: { reviewers?: number; threshold?: number }) => {
    const reviewerCount = opts?.reviewers ?? 2;
    const thresholdValue = opts?.threshold ?? 0.5;
    if (!Number.isFinite(reviewerCount) || reviewerCount < 1) throw new Error("verify reviewers must be a finite number greater than zero");
    if (!Number.isFinite(thresholdValue)) throw new Error("verify threshold must be finite");
    const reviewers = Math.min(MAX_REVIEWERS, Math.max(1, Math.floor(reviewerCount)));
    const threshold = Math.min(1, Math.max(0, thresholdValue));
    const claim = typeof item === "string" ? item : JSON.stringify(item);
    const votes = (await parallel(
      Array.from({ length: reviewers }, (_, i) => () =>
        agent(`Adversarially review whether this is REAL/correct. Try to refute it.

${claim}`, {
          label: `verify ${i + 1}`,
          effect: "read",
          output: {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["real", "reason"],
              properties: { real: { type: "boolean" }, reason: { type: "string" } },
            },
          },
        })
      )
    )).filter(Boolean) as Array<{ real: boolean; reason: string }>;
    const parsed = votes;
    const realCount = parsed.filter((v: any) => v?.real).length;
    return { real: parsed.length > 0 && realCount / parsed.length >= threshold, votes: parsed };
  };

  const judgePanel = async (attempts: unknown[], opts?: { judges?: number; rubric?: string }) => {
    if (!Array.isArray(attempts)) throw new TypeError("judgePanel() expects an array");
    if (attempts.length > MAX_PARALLEL_ITEMS) throw new Error(`judgePanel() accepts at most ${MAX_PARALLEL_ITEMS} candidates`);
    const judgeCount = opts?.judges ?? 3;
    if (!Number.isFinite(judgeCount) || judgeCount < 1) throw new Error("judgePanel judges must be a finite number greater than zero");
    const judges = Math.min(MAX_REVIEWERS, Math.max(1, Math.floor(judgeCount)));
    const rubric = opts?.rubric ?? "overall quality and correctness";
    const scored = await parallel(
      (Array.isArray(attempts) ? attempts : []).map((att, idx) => async () => {
        const text = typeof att === "string" ? att : JSON.stringify(att);
        const scores = (await parallel(
          Array.from({ length: judges }, (_, j) => () =>
            agent(`Score this candidate 0-1 on: ${rubric}.

Candidate:
${text}`, {
              label: `judge ${idx + 1}.${j + 1}`,
              effect: "read",
              output: { schema: { type: "object", additionalProperties: false, required: ["score"], properties: { score: { type: "number", minimum: 0, maximum: 1 } } } },
            })
          )
        )).filter(Boolean) as Array<{ score: number }>;
        const parsed = scores;
        const avg = parsed.reduce((s, v) => s + v.score, 0) / (parsed.length || 1);
        return { index: idx, attempt: att, score: avg };
      })
    );
    const results = (scored as any[]).filter(Boolean);
    return results.reduce((best, cur) => (!best || cur.score > best.score) ? cur : best, null);
  };

  const loopUntilDry = async (opts: { round: (i: number) => Promise<unknown[]> | unknown[]; key?: (item: unknown) => string; consecutiveEmpty?: number; maxRounds?: number }) => {
    if (!opts || typeof opts.round !== "function") throw new TypeError("loopUntilDry() requires a round function");
    const keyFn = opts.key;
    const consecutiveEmptyValue = opts.consecutiveEmpty ?? 2;
    const maxRoundsValue = opts.maxRounds ?? 50;
    if (!Number.isFinite(consecutiveEmptyValue) || consecutiveEmptyValue < 1) throw new Error("loopUntilDry consecutiveEmpty must be finite and greater than zero");
    if (!Number.isFinite(maxRoundsValue) || maxRoundsValue < 1) throw new Error("loopUntilDry maxRounds must be finite and greater than zero");
    const consecutiveEmpty = Math.max(1, Math.floor(consecutiveEmptyValue));
    const maxRounds = Math.min(MAX_ROUNDS, Math.max(1, Math.floor(maxRoundsValue)));
    const seen = new Set<string>();
    const all: unknown[] = [];
    let dry = 0;
    const keyOf = (value: unknown): string => {
      if (!keyFn) return JSON.stringify(value);
      const key = invokeWorkflowFunction(keyFn, [value]);
      if (typeof key !== "string") throw new TypeError("loopUntilDry key must return a string");
      return key;
    };
    for (let r = 0; r < maxRounds && dry < consecutiveEmpty; r++) {
      throwIfAborted();
      throwIfPaused();
      const rawItems = await invokeWorkflowFunction(opts.round, [r]);
      const items = rawItems == null ? [] : cloneFromContext(rawItems);
      const fresh: Array<{ item: unknown; key: string }> = [];
      for (const item of Array.isArray(items) ? items : []) {
        if (item == null) continue;
        const key = keyOf(item);
        if (!seen.has(key)) fresh.push({ item, key });
      }
      throwIfAborted();
      if (!fresh.length) { dry++; continue; }
      dry = 0;
      for (const entry of fresh) { seen.add(entry.key); all.push(entry.item); }
    }
    return all;
  };

  const completenessCheck = async (taskArgs: unknown, results: unknown) =>
    agent(`Given the task and results so far, list what is still MISSING. Be specific.

Task:
${JSON.stringify(taskArgs)}

Results:
${JSON.stringify(results).slice(0, 4000)}`, { label: "completeness critic", effect: "read" });

  // ── Execute in VM ──────────────────────────────────────────────────
  // The context has a null prototype and code generation disabled. Host
  // capabilities are wrapped so neither their constructors nor their native
  // Promises/objects cross into the workflow realm.
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  const assertBridgeValue = (value: unknown, seen = new Set<object>(), depth = 0): void => {
    if (depth > 32) throw new Error("workflow bridge value is too deeply nested");
    if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      throw new Error("workflow bridge values must be JSON-safe");
    }
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("workflow bridge values must contain finite numbers");
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) throw new Error("workflow bridge values must not be circular");
    seen.add(value);
    const tag = Object.prototype.toString.call(value);
    if (tag !== "[object Object]" && tag !== "[object Array]") throw new Error("workflow bridge values must be plain JSON data");
    if (Array.isArray(value)) for (const item of value) assertBridgeValue(item, seen, depth + 1);
    else for (const item of Object.values(value as Record<string, unknown>)) assertBridgeValue(item, seen, depth + 1);
    seen.delete(value);
  };
  const cloneIntoContext = (value: unknown): unknown => {
    assertBridgeValue(value);
    const encoded = JSON.stringify(value);
    if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_PERSISTED_RECORD_BYTES) throw new Error("workflow bridge value is too large");
    return vm.runInContext(`JSON.parse(${JSON.stringify(encoded)})`, context);
  };
  const cloneFromContext = (value: unknown): unknown => {
    (context as any).__bridgeOut = value;
    try {
      const encoded = vm.runInContext("JSON.stringify(__bridgeOut)", context, { timeout: timeoutMs });
      if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > MAX_PERSISTED_RECORD_BYTES) throw new Error("workflow bridge value is too large");
      return JSON.parse(encoded);
    } finally {
      delete (context as any).__bridgeOut;
    }
  };
  const deferred = () => vm.runInContext(`(() => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; })()`, context) as any;
  const safeCapability = (fn: (...args: any[]) => unknown) => {
    const exposed = (...args: any[]) => {
      const pending = deferred();
      const reject = (error: unknown) => {
        const message = encodeWorkflowError(error);
        try {
          pending.reject(vm.runInContext(`new Error(${JSON.stringify(message)})`, context));
        } catch {
          pending.reject(vm.runInContext("new Error('workflow capability failed')", context));
        }
      };
      Promise.resolve().then(() => fn(...args)).then(
        value => {
          try { pending.resolve(cloneIntoContext(value)); }
          catch (error) { reject(error); }
        },
        reject,
      );
      return pending.promise;
    };
    Object.setPrototypeOf(exposed, null);
    return exposed;
  };
  const safeSyncCapability = (fn: (...args: any[]) => unknown) => {
    const exposed = (...args: any[]) => fn(...args);
    Object.setPrototypeOf(exposed, null);
    return exposed;
  };
  invokeWorkflowFunction = (fn, args) => {
    (context as any).__invokeFn = fn;
    (context as any).__invokeArgs = cloneIntoContext(args);
    try {
      return vm.runInContext("__invokeFn(...__invokeArgs)", context, { timeout: timeoutMs });
    } finally {
      delete (context as any).__invokeFn;
      delete (context as any).__invokeArgs;
    }
  };
  Object.assign(context, {
    __agent: safeCapability(agent),
    __parallel: safeCapability(parallel),
    __pipeline: safeCapability(pipeline),
    __verify: safeCapability(verify),
    __judgePanel: safeCapability(judgePanel),
    __loopUntilDry: safeCapability(loopUntilDry),
    __completenessCheck: safeCapability(completenessCheck),
    __log: safeSyncCapability(log),
    __phase: safeSyncCapability(phase),
    __budgetSpent: safeSyncCapability(() => shared.spent),
    __budgetRemaining: safeSyncCapability(() => tokenBudget == null ? Infinity : Math.max(0, tokenBudget - shared.spent)),
    // Be explicit about host globals that differ between Node and Bun.
    process: undefined,
    require: undefined,
    Buffer: undefined,
    Bun: undefined,
    Deno: undefined,
    ShadowRealm: undefined,
    WebAssembly: undefined,
    SharedArrayBuffer: undefined,
    Atomics: undefined,
    eval: undefined,
    Function: undefined,
    cwd,
  });
  const argsJson = JSON.stringify(options.args ?? null);
  if (Buffer.byteLength(argsJson, "utf8") > MAX_ARGS_BYTES) throw new Error(`Workflow args are too large (maximum ${MAX_ARGS_BYTES} bytes)`);
  const wrapped = `${DETERMINISM_PRELUDE}\nconst args = JSON.parse(${JSON.stringify(argsJson)});\nconst agent = __agent; const parallel = __parallel; const pipeline = __pipeline; const log = __log; const phase = __phase; const verify = __verify; const judgePanel = __judgePanel; const loopUntilDry = __loopUntilDry; const completenessCheck = __completenessCheck; const budget = Object.freeze({ total: ${tokenBudget == null ? "null" : tokenBudget}, spent: __budgetSpent, remaining: __budgetRemaining });\n(async () => {\n${body}\n})()`;
  let compiled: vm.Script;
  try {
    compiled = new vm.Script(wrapped, { filename: `${meta.name}.js` });
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw enrichSyntaxError(err, body, meta.name);
    }
    throw err;
  }
  let result: unknown;
  try {
    result = await compiled.runInContext(context, { timeout: timeoutMs });
  } catch (err) {
    // Bun may defer vm.Script parsing until execution. Only actual SyntaxErrors
    // are enriched; runtime errors such as "missing file" must remain runtime errors.
    if (err instanceof SyntaxError) throw enrichSyntaxError(err, body, meta.name);
    const control = decodeWorkflowControl(err);
    if (control) throw control;
    throw err;
  }

  const finalResult = result === undefined ? undefined : cloneFromContext(result);
  return {
    meta,
    result: finalResult,
    logs: state.logs,
    phases: state.phases,
    agentCount: shared.agentCount,
    durationMs: Date.now() - started,
    runId,
    tokenUsage: shared.tokenUsage,
  };
}

/**
 * Execute a workflow with a persistent run lock for direct SDK callers.
 * The extension tool claims the lock before mutating metadata/markers and
 * passes lock:false to avoid a double claim.
 */
async function executeWorkflow(script: string, options: ExecuteWorkflowOptions = {}): Promise<WorkflowRunResult> {
  const cwd = canonicalCwd(options.cwd ?? process.cwd());
  const runId = options.runId ?? `run-${randomUUID()}`;
  assertSafeRunId(runId);
  const ownsLock = options.lock !== false;
  if (ownsLock) claimRun(cwd, runId);
  const stopHeartbeat = ownsLock ? startRunHeartbeat(cwd, runId) : () => {};
  try {
    if (ownsLock) {
      const { meta } = parseScript(script);
      const metaPath = join(getJournalDir(cwd, runId), "meta.json");
      const priorMeta = isRegularFile(metaPath) ? JSON.parse(readRegularFile(metaPath)) : undefined;
      const modelIdentity = meta.model ?? (options.runtime?.defaultModel ? `${options.runtime.defaultModel.provider}/${options.runtime.defaultModel.id}` : null);
      const workerBackend = selectWorkerBackend(options.runtime);
      writeRunJson(cwd, runId, "meta.json", {
        schemaVersion: 2,
        name: meta.name,
        description: meta.description,
        phases: meta.phases,
        script,
        args: options.args,
        fingerprint: workflowFingerprint(script, options.args, {
          tokenBudget: options.tokenBudget ?? undefined,
          maxAgents: options.maxAgents,
          timeoutMs: options.timeoutMs,
          modelIdentity,
          workerBackend: workerBackend.id,
          workerTools: workerBackend.toolIdentity,
          workerContext: workerBackend.contextIdentity,
          workspaceIdentity: options.runtime?.executionEnvelope?.workspaceIdentity ?? workspaceIdentity(cwd),
        }),
        executionPolicy: {
          tokenBudget: options.tokenBudget ?? null,
          maxAgents: options.maxAgents ?? null,
          timeoutMs: options.timeoutMs ?? null,
          modelIdentity,
          workerBackend: workerBackend.id,
          workerTools: workerBackend.toolIdentity,
          workerContext: workerBackend.contextIdentity,
          workspaceIdentity: options.runtime?.executionEnvelope?.workspaceIdentity ?? workspaceIdentity(cwd),
          origin: options.runtime?.executionEnvelope?.origin,
          parentRunId: options.runtime?.executionEnvelope?.parentRunId,
        },
        createdAt: priorMeta?.createdAt ?? Date.now(),
      });
    }
    const result = await executeWorkflowCore(script, { ...options, cwd, runId, lock: false });
    if (ownsLock) {
      markRunComplete(cwd, runId, result);
      notifyExecutionState(options.runtime, runId, "completed");
    }
    return result;
  } catch (error) {
    if (ownsLock) {
      try {
        const status = markRunFailure(cwd, runId, error);
        notifyExecutionState(options.runtime, runId, status);
      } catch {}
    }
    throw error;
  } finally {
    stopHeartbeat();
    if (ownsLock) releaseRun(cwd, runId);
  }
}

// ── Workflow Tool ──────────────────────────────────────────────────────────

// ── Tool Result Helpers ────────────────────────────────────────────────────

const ok = (text: string, details: unknown = {}) => ({
  content: [{ type: "text" as const, text }],
  details,
});

function stableSerialize(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error("workflow args are too deeply nested");
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableSerialize(item, depth + 1)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(record[key], depth + 1)}`).join(",")}}`;
}

function workflowFingerprint(script: string, args: unknown, options: {
  tokenBudget?: number;
  maxAgents?: number;
  timeoutMs?: number;
  modelIdentity?: string | null;
  workerBackend?: string;
  workerTools?: string;
  workerContext?: string;
  workspaceIdentity?: string;
}): string {
  return createHash("sha256").update(stableSerialize({
    script,
    args,
    tokenBudget: options.tokenBudget ?? null,
    maxAgents: options.maxAgents ?? null,
    timeoutMs: options.timeoutMs ?? null,
    modelIdentity: options.modelIdentity ?? null,
    workerBackend: options.workerBackend ?? SDK_WORKER_BACKEND_ID,
    workerTools: options.workerTools ?? SDK_WORKER_BACKEND.toolIdentity,
    workerContext: options.workerContext ?? SDK_WORKER_CONTEXT_IDENTITY,
    workspaceIdentity: options.workspaceIdentity ?? null,
    tierConfig: TIER_MODELS,
  })).digest("hex");
}

function clearRunMarkers(cwd: string, runId: string): void {
  for (const marker of ["error.log", "complete.log", "cancelled", "paused"]) removeRunMarker(cwd, runId, marker);
}

function markRunComplete(cwd: string, runId: string, result: WorkflowRunResult): void {
  removeRunMarker(cwd, runId, "error.log");
  removeRunMarker(cwd, runId, "cancelled");
  removeRunMarker(cwd, runId, "paused");
  writeRunJson(cwd, runId, "complete.log", result);
}

function notifyExecutionUsage(runtime: WorkflowRuntime | undefined, usage: { input: number; output: number; total: number; cost: number }): void {
  try { runtime?.executionEnvelope?.onUsage?.(usage); } catch {}
}

function notifyExecutionState(runtime: WorkflowRuntime | undefined, runId: string, status: "completed" | "error" | "paused" | "cancelled"): void {
  try { runtime?.executionEnvelope?.onState?.({ runId, status }); } catch {}
}

function markRunFailure(cwd: string, runId: string, error: unknown): "paused" | "cancelled" | "error" {
  const control = decodeWorkflowControl(error)?.code;
  if (control === "paused") {
    writeRunJson(cwd, runId, "paused", new Date().toISOString());
    return "paused";
  }
  if (control === "aborted" || control === "cancelled") {
    removeRunMarker(cwd, runId, "error.log");
    const cancelled = join(getJournalDir(cwd, runId), "cancelled");
    writeTextAtomic(cancelled, new Date().toISOString());
    return "cancelled";
  }
  removeRunMarker(cwd, runId, "complete.log");
  const errorPath = join(getJournalDir(cwd, runId), "error.log");
  const message = error instanceof Error ? error.message : String(error);
  writeTextAtomic(errorPath, `[${new Date().toISOString()}] ${message.slice(0, 8192)}\n`);
  return "error";
}

// ── Tool Schemas ────────────────────────────────────────────────────────────

const WorkflowParams = Type.Object({
  script: Type.String({
    description: "Raw JavaScript workflow script. First statement: export const meta = { name, description }",
  }),
  args: Type.Optional(Type.Any({
    description: "Optional JSON value exposed as `args` global.",
  })),
  background: Type.Optional(Type.Boolean({
    description: "Run in background (default: true). Set false to block for result.",
  })),
  tokenBudget: Type.Optional(Type.Number({
    description: "Conservative token admission/output budget for the run.",
  })),
  maxAgents: Type.Optional(Type.Number({
    description: `Maximum agents allowed (default: ${MAX_AGENTS}, maximum: ${MAX_AGENTS}).`,
  })),
  runId: Type.Optional(Type.String({
    description: "Optional existing run id to resume explicitly.",
  })),
  timeoutMs: Type.Optional(Type.Number({
    description: `Maximum synchronous workflow execution time in milliseconds (maximum: ${MAX_WORKFLOW_TIMEOUT_MS}).`,
  })),
  resume: Type.Optional(Type.Boolean({
    description: "Resume from last incomplete run of same workflow name (default: true).",
  })),
  forceResume: Type.Optional(Type.Boolean({
    description: "With runId, retry error/cancelled runs; automatic matching may adopt orphaned runs (default: false).",
  })),
  dryRun: Type.Optional(Type.Boolean({
    description: "Parse and validate the script without executing. Returns metadata only.",
  })),
});

function createWorkflowTool() {
  return {
    name: "workflow",
    label: "Workflow",
    description: "Execute a deterministic JavaScript workflow that orchestrates multiple subagents with agent(), parallel(), pipeline().",
    promptSnippet: "Run a deterministic JavaScript workflow with agent(), parallel(), pipeline() orchestration.",
    promptGuidelines: [
      "Use workflow when the user explicitly asks for a workflow, workflows, fan-out, or multi-agent orchestration.",
      "script must start with: export const meta = { name, description, phases? }",
      "Globals: agent(prompt, opts), parallel(fns), pipeline(items, ...stages), phase(title, {budget}), log(msg), args, budget, verify(), judgePanel(), loopUntilDry(), completenessCheck()",
      "agent() options include effect: \"read\" or \"write\" (write is the conservative default); parallel writes to the canonical checkout require isolation: \"worktree\".",
      "For machine-readable results use output: { schema: <JSON Schema>, maxRetries?: 0..2 }; read-only calls may retry validation, side-effectful writes never retry automatically.",
      "Scripts have no direct filesystem or shell access. All side effects go through agent() calls.",
      "Date.now(), Math.random(), and new Date() without args are blocked. Explicit dates like new Date(\"2024-01-01\") and Date.UTC() are allowed.",
      "Workflow code is trusted-plan code, not an OS security boundary; use a container or separate process for hostile scripts.",
      "timeoutMs bounds synchronous VM segments; use abort/pause for provider work.",
      "CRITICAL: The script is compiled as a JS module body. Ensure every agent(), parallel(), and function call has balanced parentheses and braces. The most common failure is 'missing ) after argument list' from unbalanced parens in long agent() calls with multiline template literals.",
      "Template literals (backticks) in agent() prompts must be closed. Count the backticks — if odd, one is missing. If the prompt contains backticks, escape them as \\` or use a regular string.",
      "Example: `export const meta = { name: \"review\", description: \"Review files\" }; const files = [\"a.ts\", \"b.ts\"]; await parallel(files.map(f => () => agent(\`Review ${f}\`, { label: f })));`",
    ],

    parameters: WorkflowParams,

    renderCall(args: { script: string; background?: boolean }, theme: Theme, context?: { lastComponent?: Component; invalidate?: () => void; args?: unknown; state?: Record<string, unknown>; toolCallId?: string; cwd?: string; executionStarted?: boolean; argsComplete?: boolean; isPartial?: boolean; expanded?: boolean; showImages?: boolean; isError?: boolean }) {
      const existing = context?.lastComponent as Text | undefined;
      const meta = parseScriptSafe(args.script);
      const label = meta?.name ?? "workflow";
      const content =
        theme.fg("toolTitle", theme.bold("workflow ")) +
        theme.fg("accent", label.slice(0, 40)) +
        (args.background !== false ? theme.fg("dim", " (background)") : theme.fg("dim", " (blocking)"));
      if (existing) { existing.setText(content); return existing; }
      return new Text(content, 0, 0);
    },

    renderResult(
      r: { content: Array<{ type: string; text?: string }>; details?: unknown },
      opts: { expanded?: boolean; isPartial?: boolean },
      theme: Theme,
      context?: { isError?: boolean; lastComponent?: Component; invalidate?: () => void; args?: unknown; state?: Record<string, unknown>; toolCallId?: string; cwd?: string; executionStarted?: boolean; argsComplete?: boolean; isPartial?: boolean; expanded?: boolean; showImages?: boolean },
    ) {
      const text = r.content[0]?.type === "text" ? (r.content[0] as { text?: string }).text ?? "" : "";
      const details = r.details as Record<string, unknown> | undefined;

      if (opts.isPartial) {
        return new Text(theme.fg("warning", "⏳ ") + theme.fg("text", text || "Working..."), 0, 0);
      }

      const prefix = context?.isError ? theme.fg("error", "✗ ") : theme.fg("success", "✓ ");
      if (details?.background && !context?.isError) {
        let out = theme.fg("success", "▶ ") + theme.fg("text", text) + theme.fg("dim", ` [run: ${details.runId}]`);
        if (opts.expanded && details.resumed) {
          out += theme.fg("dim", " (resumed)");
        }
        return new Text(out, 0, 0);
      }
      return new Text(prefix + theme.fg("text", text), 0, 0);
    },

    async execute(
      _id: string,
      params: { script: string; args?: unknown; background?: boolean; tokenBudget?: number; maxAgents?: number; runId?: string; timeoutMs?: number; resume?: boolean; forceResume?: boolean; dryRun?: boolean },
      signal: AbortSignal | undefined,
      onUpdate: ((update: AgentToolResult<unknown>) => void) | undefined,
      ctx: ExtensionContext,
    ) {
      let script = params.script.trim();
      const fence = script.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
      if (fence?.[1]) script = fence[1].trim();

      const { meta, body } = parseScript(script);
      const syntaxErr = validateSyntax(body, meta.name);
      if (syntaxErr) throw syntaxErr;
      if (signal?.aborted) throw new WorkflowControlError("aborted", "Workflow aborted");

      const tokenBudget = params.tokenBudget == null ? undefined : finiteNonNegative(params.tokenBudget, "tokenBudget");
      const maxAgents = params.maxAgents == null ? undefined : Math.floor(params.maxAgents);
      if (maxAgents !== undefined && (!Number.isFinite(maxAgents) || maxAgents < 1 || maxAgents > MAX_AGENTS)) {
        throw new Error(`maxAgents must be an integer between 1 and ${MAX_AGENTS}`);
      }
      const timeoutMs = params.timeoutMs == null ? undefined : finiteNonNegative(params.timeoutMs, "timeoutMs");
      if (timeoutMs !== undefined && timeoutMs <= 0) throw new Error("timeoutMs must be greater than zero");

      if (params.dryRun) {
        return ok(
          `Workflow "${meta.name}": ${meta.description}${meta.phases ? `, ${meta.phases.length} phase(s)` : ""}. Script is valid and ready to run.` +
          (tokenBudget !== undefined ? ` Budget: ${tokenBudget} tokens.` : "") +
          (maxAgents !== undefined ? ` Max agents: ${maxAgents}.` : ""),
          { dryRun: true, meta, scriptLength: script.length },
        );
      }

      const cwd = canonicalCwd(ctx.cwd ?? process.cwd());
      const notify = (message: string, level: "info" | "error") => { try { ctx.ui.notify(message, level); } catch {} };
      const shouldResume = params.resume !== false;
      const shouldForceResume = params.forceResume === true;
      const modelIdentity = meta.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null);
      const runtimeEnvelope: ExecutionEnvelope = {
        origin: { sessionId: ctx.sessionManager.getSessionId() },
        workspaceIdentity: workspaceIdentity(cwd),
      };
      const argsBytes = Buffer.byteLength(JSON.stringify(params.args ?? null), "utf8");
      if (argsBytes > MAX_ARGS_BYTES) throw new Error(`Workflow args are too large (maximum ${MAX_ARGS_BYTES} bytes)`);
      const fingerprint = workflowFingerprint(script, params.args, {
        tokenBudget,
        maxAgents,
        timeoutMs,
        modelIdentity,
        workerBackend: SDK_WORKER_BACKEND.id,
        workerTools: SDK_WORKER_BACKEND.toolIdentity,
        workerContext: SDK_WORKER_BACKEND.contextIdentity,
        workspaceIdentity: runtimeEnvelope.workspaceIdentity,
      });
      let runId = params.runId;
      let resumeJournal: Map<number, JournalEntry> | undefined;
      let resuming = false;

      if (runId) {
        assertSafeRunId(runId);
        const existing = getRunStatus(cwd, runId);
        if (!existing) throw new Error(`Run ${runId} not found.`);
        const existingMetaPath = join(getJournalDir(cwd, runId), "meta.json");
        const existingMeta = JSON.parse(readRegularFile(existingMetaPath));
        if (existingMeta.fingerprint) {
          if (existingMeta.fingerprint !== fingerprint) throw new Error("Run fingerprint does not match this script, arguments, or execution policy.");
        } else if (existingMeta.script !== script) {
          throw new Error("Legacy run has no fingerprint and its script does not match.");
        }
        if (existing.status === "completed") throw new Error(`Run ${runId} is already completed.`);
        if ((existing.status === "error" || existing.status === "cancelled") && !shouldForceResume) throw new Error(`Run ${runId} is ${existing.status}; set forceResume=true to retry it.`);
        resumeJournal = readJournal(cwd, runId);
        resuming = true;
      } else if (shouldResume) {
        const runs = listWorkflowRuns(cwd)
          .filter(r => r.fingerprint === fingerprint && r.status !== "completed" && r.status !== "cancelled" && (shouldForceResume || (r.status !== "error" && r.status !== "orphaned")))
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        const candidate = runs[0];
        if (candidate) {
          runId = candidate.runId;
          resumeJournal = readJournal(cwd, runId);
          resuming = true;
        }
      }

      runId ??= `run-${randomUUID()}`;
      assertSafeRunId(runId);
      const runDir = getJournalDir(cwd, runId);
      ensurePrivateDir(runDir, cwd);
      const priorMetaPath = join(runDir, "meta.json");
      const priorMeta = isRegularFile(priorMetaPath) ? JSON.parse(readRegularFile(priorMetaPath)) : undefined;
      claimRun(cwd, runId);
      const stopHeartbeat = startRunHeartbeat(cwd, runId);
      const runController = new AbortController();
      const unlinkSignal = linkAbortSignal(signal, runController);
      const activeRunKey = runKey(cwd, runId);
      ACTIVE_RUN_CONTROLLERS.set(activeRunKey, runController);
      const unregisterActiveRun = () => {
        unlinkSignal();
        stopHeartbeat();
        ACTIVE_RUN_CONTROLLERS.delete(activeRunKey);
        ACTIVE_RUN_DRAINS.delete(activeRunKey);
      };
      if (resuming) {
        removeRunMarker(cwd, runId, "paused");
        if (shouldForceResume) {
          removeRunMarker(cwd, runId, "error.log");
          removeRunMarker(cwd, runId, "cancelled");
        }
      } else {
        clearRunMarkers(cwd, runId);
      }
      try {
        writeRunJson(cwd, runId, "meta.json", {
        schemaVersion: 2,
        name: meta.name,
        description: meta.description,
        phases: meta.phases,
        script,
        args: params.args,
        fingerprint,
        executionPolicy: {
          tokenBudget: tokenBudget ?? null,
          maxAgents: maxAgents ?? null,
          timeoutMs: timeoutMs ?? null,
          modelIdentity,
          workerBackend: SDK_WORKER_BACKEND.id,
          workerTools: SDK_WORKER_BACKEND.toolIdentity,
          workerContext: SDK_WORKER_BACKEND.contextIdentity,
          workspaceIdentity: runtimeEnvelope.workspaceIdentity,
          origin: runtimeEnvelope.origin,
          parentRunId: runtimeEnvelope.parentRunId,
        },
          createdAt: priorMeta?.createdAt ?? Date.now(),
        });
      } catch (error) {
        unregisterActiveRun();
        releaseRun(cwd, runId);
        throw error;
      }

      const runtime: WorkflowRuntime = {
        modelRegistry: ctx.modelRegistry,
        authStorage: ctx.modelRegistry?.authStorage,
        defaultModel: ctx.model,
        agentDir: join(process.env.HOME ?? "~", ".pi", "agent"),
        onUpdate,
        executionEnvelope: runtimeEnvelope,
      };
      const executeOptions = { args: params.args, runId, tokenBudget, maxAgents, resumeJournal, signal: runController.signal, runtime, timeoutMs, lock: false };
      const resumedMsg = resuming ? ` (resumed from ${resumeJournal?.size ?? 0} cached)` : "";

      if (params.background !== false) {
        const runPromise = executeWorkflow(script, executeOptions).then(result => {
          markRunComplete(cwd, runId!, result);
          notifyExecutionState(runtime, runId!, "completed");
          notify(`Workflow "${meta.name}" completed (${result.agentCount} agent(s)).`, "info");
        }).catch(error => {
          const status = markRunFailure(cwd, runId!, error);
          notifyExecutionState(runtime, runId!, status);
          if (status === "paused") notify(`Workflow "${meta.name}" paused. Resume with runId ${runId}.`, "info");
          else if (status === "cancelled") notify(`Workflow "${meta.name}" cancelled.`, "info");
          else notify(`Workflow "${meta.name}" failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }).finally(() => {
          unregisterActiveRun();
          releaseRun(cwd, runId!);
        });
        ACTIVE_RUN_DRAINS.set(activeRunKey, runPromise);
        return ok(`Workflow "${meta.name}" started in background (run: ${runId})${resumedMsg}.`, { runId, background: true, resumed: resuming });
      }

      try {
        const result = await executeWorkflow(script, executeOptions);
        markRunComplete(cwd, runId, result);
        notifyExecutionState(runtime, runId, "completed");
        return ok(`Workflow "${meta.name}" completed: ${result.agentCount} agent(s), ${result.durationMs}ms${resumedMsg}`, result);
      } catch (error) {
        const status = markRunFailure(cwd, runId, error);
        notifyExecutionState(runtime, runId, status);
        throw error;
      } finally {
        unregisterActiveRun();
        releaseRun(cwd, runId);
      }
    },
  };
}

// ── Workflow Status Tool ──────────────────────────────────────────────────

function getRunStatus(cwd: string, runId: string): Record<string, unknown> | null {
  try { assertSafeRunId(runId); } catch { return null; }
  let dir: string;
  try { dir = getJournalDir(cwd, runId); } catch { return null; }
  if (!existsSync(dir)) return null;

  const metaPath = join(dir, "meta.json");
  const errorPath = join(dir, "error.log");
  const completePath = join(dir, "complete.log");
  const cancelledPath = join(dir, "cancelled");
  const pausedPath = join(dir, "paused");
  const lockPath = join(dir, "run.lock");
  const journalPath = join(dir, "journal.jsonl");
  const eventsPath = join(dir, "events.jsonl");

  const hasComplete = isRegularFile(completePath);
  const hasError = isRegularFile(errorPath);
  const hasCancelled = isRegularFile(cancelledPath);
  const hasPaused = isRegularFile(pausedPath);
  let orphaned = false;
  if (!hasComplete && !hasError && !hasCancelled && !hasPaused && isRegularFile(lockPath)) {
    try {
      const lock = JSON.parse(readRegularFile(lockPath));
      orphaned = !isProcessAlive(lock.pid);
    } catch {
      orphaned = false;
    }
  }
  const status = hasComplete ? "completed" : hasError ? "error" : hasCancelled ? "cancelled" : hasPaused ? "paused" : orphaned ? "orphaned" : "running";

  let meta: WorkflowMeta | null = null;
  let fingerprint: string | undefined;
  let executionPolicy: Record<string, unknown> | undefined;
  let createdAt: number | undefined;
  let agentCount = 0;
  let tokenUsage = { input: 0, output: 0, total: 0, cost: 0 };
  let error: string | undefined;
  let result: unknown;
  const progress = { running: 0, completed: 0, failed: 0, cached: 0 };
  let latestTask: Record<string, unknown> | undefined;
  const journalIndices = new Set<number>();

  try {
    if (isRegularFile(metaPath)) {
      const parsed = JSON.parse(readRegularFile(metaPath));
      meta = { name: parsed.name, description: parsed.description, phases: parsed.phases, model: parsed.model };
      fingerprint = typeof parsed.fingerprint === "string" ? parsed.fingerprint : undefined;
      executionPolicy = parsed.executionPolicy && typeof parsed.executionPolicy === "object" ? parsed.executionPolicy : undefined;
      createdAt = typeof parsed.createdAt === "number" ? parsed.createdAt : undefined;
    }
  } catch {}

  try {
    if (isRegularFile(journalPath)) {
      const lines = readRegularFile(journalPath).split("\n").filter(l => l.trim());
      agentCount = lines.length;
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (Number.isInteger(entry.index)) journalIndices.add(entry.index);
          if (entry.tokens) {
            tokenUsage.input += Number.isFinite(entry.tokens.input) && entry.tokens.input >= 0 ? entry.tokens.input : 0;
            tokenUsage.output += Number.isFinite(entry.tokens.output) && entry.tokens.output >= 0 ? entry.tokens.output : 0;
            tokenUsage.total += Number.isFinite(entry.tokens.total) && entry.tokens.total >= 0 ? entry.tokens.total : 0;
            tokenUsage.cost += Number.isFinite(entry.tokens.cost) && entry.tokens.cost >= 0 ? entry.tokens.cost : 0;
          }
        } catch {}
      }
    }
  } catch {}

  try {
    if (isRegularFile(eventsPath)) {
      const lines = readRegularFile(eventsPath).split("\n").filter(l => l.trim());
      const seen = new Set<number>();
      const taskStates = new Map<number, "running" | "completed" | "failed" | "cancelled" | "cached">();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          const validIndex = Number.isInteger(event.index);
          if (validIndex) seen.add(event.index);
          if (["started", "completed", "failed", "cancelled", "retry", "cached"].includes(event.type)) {
            latestTask = { index: event.index, label: event.label, type: event.type, phase: event.phase, attempt: event.attempt };
          }
          if (validIndex) {
            if (event.type === "started" || event.type === "retry") taskStates.set(event.index, "running");
            else if (event.type === "completed") taskStates.set(event.index, "completed");
            else if (event.type === "failed") taskStates.set(event.index, "failed");
            else if (event.type === "cancelled") taskStates.set(event.index, "cancelled");
            else if (event.type === "cached") taskStates.set(event.index, "cached");
          }
          if ((event.type === "failed" || event.type === "cancelled") && event.usage && !journalIndices.has(event.index)) {
            tokenUsage.input += Number.isFinite(event.usage.input) && event.usage.input >= 0 ? event.usage.input : 0;
            tokenUsage.output += Number.isFinite(event.usage.output) && event.usage.output >= 0 ? event.usage.output : 0;
            tokenUsage.total += Number.isFinite(event.usage.total) && event.usage.total >= 0 ? event.usage.total : 0;
            tokenUsage.cost += Number.isFinite(event.usage.cost) && event.usage.cost >= 0 ? event.usage.cost : 0;
          }
        } catch {}
      }
      for (const state of taskStates.values()) {
        if (state === "running") progress.running++;
        else if (state === "completed") progress.completed++;
        else if (state === "failed") progress.failed++;
        else if (state === "cached") progress.cached++;
      }
      agentCount = Math.max(agentCount, seen.size);
    }
  } catch {}

  try { if (hasError) error = readRegularFile(errorPath).trim(); } catch {}
  try { if (hasComplete) result = JSON.parse(readRegularFile(completePath)); } catch {}

  return {
    runId,
    status,
    meta,
    ...(fingerprint ? { fingerprint } : {}),
    ...(executionPolicy ? { executionPolicy } : {}),
    ...(createdAt ? { createdAt } : {}),
    agentCount,
    progress,
    ...(latestTask ? { latestTask } : {}),
    tokenUsage,
    ...(error ? { error } : {}),
    ...(result ? { result } : {}),
  };
}

function createWorkflowStatusTool() {
  return {
    name: "workflow_status",
    label: "Workflow Status",
    description: "Check the status of a workflow run — progress, token usage, errors, and results.",
    promptSnippet: "Check workflow status after background execution.",
    promptGuidelines: [
      "Call workflow_status after a workflow() returns 'started in background' to check if it completed.",
      "Pass the runId from the workflow() result, or omit to check the most recent run.",
    ],

    parameters: Type.Object({
      runId: Type.Optional(Type.String({
        description: "Run ID from the workflow() result. Omit to check the most recent run.",
      })),
      workflow: Type.Optional(Type.String({
        description: "Find the most recent run for this workflow name (alternative to runId).",
      })),
    }),

    renderCall(args: { runId?: string; workflow?: string }, theme: Theme, context?: { lastComponent?: Component; invalidate?: () => void; args?: unknown; state?: Record<string, unknown>; toolCallId?: string; cwd?: string; executionStarted?: boolean; argsComplete?: boolean; isPartial?: boolean; expanded?: boolean; showImages?: boolean; isError?: boolean }) {
      const existing = context?.lastComponent as Text | undefined;
      const label = args.runId ?? args.workflow ?? "latest";
      const content = theme.fg("toolTitle", theme.bold("workflow_status ")) + theme.fg("accent", label.slice(0, 40));
      if (existing) { existing.setText(content); return existing; }
      return new Text(content, 0, 0);
    },

    renderResult(
      r: { content: Array<{ type: string; text?: string }>; details?: unknown },
      opts: { expanded?: boolean; isPartial?: boolean },
      theme: Theme,
      context?: { isError?: boolean; lastComponent?: Component; invalidate?: () => void; args?: unknown; state?: Record<string, unknown>; toolCallId?: string; cwd?: string; executionStarted?: boolean; argsComplete?: boolean; isPartial?: boolean; expanded?: boolean; showImages?: boolean },
    ) {
      const text = r.content[0]?.type === "text" ? (r.content[0] as { text?: string }).text ?? "" : "";
      const prefix = context?.isError ? theme.fg("error", "✗ ") : theme.fg("success", "✓ ");
      return new Text(prefix + theme.fg("text", text), 0, 0);
    },

    async execute(_id: string, params: { runId?: string; workflow?: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const cwd = canonicalCwd(ctx.cwd ?? process.cwd());

      // Find the target run
      let targetRunId: string | undefined;

      if (params.runId) {
        targetRunId = params.runId;
      } else {
        // Find most recent run (optionally filtered by workflow name)
        const runs = listWorkflowRuns(cwd);
        const filtered = params.workflow
          ? runs.filter(r => r.meta?.name === params.workflow)
          : runs;
        if (filtered.length > 0) {
          targetRunId = filtered[filtered.length - 1].runId;
        }
      }

      if (!targetRunId) {
        throw new Error("No workflow runs found.");
      }

      const status = getRunStatus(cwd, targetRunId);
      if (!status) {
        throw new Error(`Run ${targetRunId} not found.`);
      }

      // Format output
      const parts: string[] = [];
      const meta = status.meta as WorkflowMeta | null;
      parts.push(`Workflow: ${meta?.name ?? targetRunId}`);
      if (meta?.description) parts.push(`Description: ${meta.description}`);
      parts.push(`Status: ${status.status}`);
      parts.push(`Agents: ${status.agentCount}`);
      const progress = status.progress as { running: number; completed: number; failed: number; cached: number } | undefined;
      if (progress) parts.push(`Progress: ${progress.running} running, ${progress.completed} completed, ${progress.failed} failed, ${progress.cached} cached`);

      const tokens = status.tokenUsage as { total: number; cost: number };
      if (tokens.total > 0) {
        parts.push(`Tokens: ${tokens.total.toLocaleString()} ($${tokens.cost.toFixed(4)})`);
      }

      if (status.error) {
        parts.push(`Error: ${status.error}`);
      }

      if (status.result !== undefined) {
        const result = status.result as WorkflowRunResult;
        if (result.durationMs) parts.push(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
        if (result.phases?.length) parts.push(`Phases: ${result.phases.join(", ")}`);
      }

      return ok(parts.join("\n"), status);
    },
  };
}

// ── Workflow Commands ──────────────────────────────────────────────────────

function listSavedCommands(cwd: string): Array<{ name: string; path: string }> {
  cwd = canonicalCwd(cwd);
  const commands: Array<{ name: string; path: string }> = [];
  
  // Project commands
  const projectDir = join(cwd, COMMANDS_DIR);
  if (existsSync(projectDir)) {
    try {
      assertNoSymlinkPath(projectDir, cwd);
      const files = readdirSync(projectDir);
      for (const f of files) {
        if (!f.endsWith(".js")) continue;
        try { if (!lstatSync(join(projectDir, f)).isFile()) continue; } catch { continue; }
        commands.push({ name: f.replace(/\.js$/, ""), path: join(projectDir, f) });
      }
    } catch {}
  }
  
  // Personal commands
  const personalDir = join(process.env.HOME ?? "~", ".pi", "workflows", "commands");
  if (existsSync(personalDir)) {
    try {
      assertNoSymlinkPath(personalDir);
      const files = readdirSync(personalDir);
      for (const f of files) {
        if (!f.endsWith(".js")) continue;
        try { if (!lstatSync(join(personalDir, f)).isFile()) continue; } catch { continue; }
        commands.push({ name: f.replace(/\.js$/, ""), path: join(personalDir, f) });
      }
    } catch {}
  }
  
  return commands;
}

function listWorkflowRuns(cwd: string): WorkflowRunRecord[] {
  cwd = canonicalCwd(cwd);
  const runs: WorkflowRunRecord[] = [];
  const dir = join(cwd, WORKFLOW_DIR);
  if (!existsSync(dir)) return runs;

  try {
    assertNoSymlinkPath(dir, cwd);
    for (const entry of readdirSync(dir)) {
      if (entry === "commands" || !entry.startsWith("run-")) continue;
      try { assertSafeRunId(entry); } catch { continue; }
      const metaPath = join(dir, entry, "meta.json");
      if (!isRegularFile(metaPath)) continue;
      let parsed: any;
      try { parsed = JSON.parse(readRegularFile(metaPath)); } catch { continue; }
      const status = getRunStatus(cwd, entry)?.status as string | undefined;
      runs.push({
        runId: entry,
        meta: parsed.name && parsed.description ? { name: parsed.name, description: parsed.description, phases: parsed.phases, model: parsed.model } : null,
        status: status ?? "running",
        fingerprint: typeof parsed.fingerprint === "string" ? parsed.fingerprint : undefined,
        createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : undefined,
      });
    }
  } catch {}

  return runs.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

// ── Extension Entry Point ─────────────────────────────────────────────────

export default function registerExtension(pi: ExtensionAPI) {
  const tool = createWorkflowTool();
  const statusTool = createWorkflowStatusTool();
  pi.registerTool(tool);
  pi.registerTool(statusTool);

  // Register /workflows command
  pi.registerCommand("workflows", {
    description: "List, manage, and save workflows",
    handler: async (args, ctx) => {
      const rawCommand = (args ?? "").trim();
      const commandWord = rawCommand.split(/\s+/, 1)[0] ?? "";
      const cmd = commandWord.toLowerCase() + rawCommand.slice(commandWord.length);
      const cwd = canonicalCwd(ctx.cwd ?? process.cwd());
      
      if (cmd === "list" || cmd === "ls" || cmd === "") {
        const runs = listWorkflowRuns(cwd);
        const commands = listSavedCommands(cwd);
        
        const parts: string[] = [];
        
        if (commands.length > 0) {
          parts.push("Saved commands:");
          parts.push("  Use /workflows run <name> to execute one.");
          for (const c of commands) {
            parts.push(`  ${c.name}`);
          }
          parts.push("");
        }
        
        if (runs.length > 0) {
          parts.push("Recent runs:");
          for (const r of runs.slice(-10)) {
            const name = r.meta?.name ?? r.runId;
            const status = r.status === "error" ? " ❌" : r.status === "completed" ? " ✓" : r.status === "paused" ? " ⏸" : r.status === "cancelled" ? " ⏹" : r.status === "orphaned" ? " ⚠" : " ⏳";
            parts.push(`  ${name}${status}`);
          }
        } else {
          parts.push("No workflow runs yet.");
        }
        
        ctx.ui.notify(parts.join("\n"), "info");
        return;
      }
      
      if (cmd === "save" || cmd.startsWith("save ")) {
        const name = cmd.slice(5).trim();
        try { assertSafeCommandName(name); } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          return;
        }
        const entries = ctx.sessionManager.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i];
          if (entry.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
          const toolCall = (entry.message.content as any[]).find((c: any) => c.type === "toolCall" && c.name === "workflow");
          const script = toolCall?.arguments?.script;
          if (typeof script !== "string") continue;
          const saveDir = join(cwd, COMMANDS_DIR);
          ensurePrivateDir(saveDir, cwd);
          const savePath = resolve(saveDir, `${name}.js`);
          if (!savePath.startsWith(`${resolve(saveDir)}${sep}`)) {
            ctx.ui.notify("Invalid workflow command path.", "error");
            return;
          }
          try {
            if (lstatSync(savePath).isSymbolicLink()) throw new Error("Refusing to overwrite a symbolic link.");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
              return;
            }
          }
          writeTextAtomic(savePath, script);
          ctx.ui.notify(`Saved workflow as /workflows run ${name}`, "info");
          return;
        }
        ctx.ui.notify("No recent workflow found to save. Run a workflow first.", "error");
        return;
      }

      if (cmd === "run" || cmd.startsWith("run ")) {
        const name = cmd.slice(4).trim();
        try { assertSafeCommandName(name); } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          return;
        }
        const saved = listSavedCommands(cwd).find(command => command.name === name);
        if (!saved) { ctx.ui.notify(`Saved workflow ${name} not found.`, "error"); return; }
        const result = await tool.execute("saved", { script: readRegularFile(saved.path), background: true }, ctx.signal, undefined, ctx);
        const runId = (result as any)?.details?.runId;
        ctx.ui.notify(runId ? `Started ${name} (run: ${runId}).` : `Started ${name}.`, "info");
        return;
      }

      if (cmd === "resume" || cmd.startsWith("resume ")) {
        const targetRunId = cmd.slice(7).trim();
        try { assertSafeRunId(targetRunId); } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          return;
        }
        const run = getRunStatus(cwd, targetRunId);
        const runMetaPath = join(getJournalDir(cwd, targetRunId), "meta.json");
        if (!run || !isRegularFile(runMetaPath)) { ctx.ui.notify(`Run ${targetRunId} not found.`, "error"); return; }
        const runMeta = JSON.parse(readRegularFile(runMetaPath));
        const policy = runMeta.executionPolicy ?? {};
        const result = await tool.execute("resume", {
          script: runMeta.script,
          args: runMeta.args,
          runId: targetRunId,
          background: true,
          forceResume: true,
          tokenBudget: policy.tokenBudget ?? undefined,
          maxAgents: policy.maxAgents ?? undefined,
          timeoutMs: policy.timeoutMs ?? undefined,
        }, ctx.signal, undefined, ctx);
        ctx.ui.notify((result as any)?.details?.runId ? `Resumed ${targetRunId}.` : `Resume requested for ${targetRunId}.`, "info");
        return;
      }

      if (cmd === "clean" || cmd.startsWith("clean ")) {
        const arg = cmd.slice(5).trim();
        const parsed = parseInt(arg, 10);
        const maxAgeDays = Number.isFinite(parsed) && parsed >= 0 ? parsed : 7;
        const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
        const runs = listWorkflowRuns(cwd);
        let cleaned = 0;
        for (const r of runs) {
          if (r.status === "running" || r.status === "paused" || r.status === "orphaned") continue; // preserve active and resumable runs
          try {
            const dir = join(cwd, WORKFLOW_DIR, r.runId);
            assertNoSymlinkPath(dir, cwd);
            const metaPath = join(dir, "meta.json");
            if (isRegularFile(metaPath)) {
              const stat = statSync(metaPath);
              if (stat.mtimeMs < cutoff) {
                rmSync(dir, { recursive: true, force: true });
                cleaned++;
              }
            }
          } catch {}
        }
        ctx.ui.notify(`Cleaned ${cleaned} run(s) older than ${maxAgeDays} day(s).`, "info");
        return;
      }

      if (cmd === "pause" || cmd.startsWith("pause ")) {
        const targetRunId = cmd.slice(6).trim();
        if (!targetRunId) {
          ctx.ui.notify("Usage: /workflows pause <runId>", "error");
          return;
        }
        try { assertSafeRunId(targetRunId); } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          return;
        }
        const pauseFile = join(getJournalDir(cwd, targetRunId), "paused");
        const metaFile = join(getJournalDir(cwd, targetRunId), "meta.json");
        if (!isRegularFile(metaFile)) {
          ctx.ui.notify(`Run ${targetRunId} not found.`, "error");
          return;
        }
        const currentStatus = getRunStatus(cwd, targetRunId)?.status;
        if (currentStatus === "completed" || currentStatus === "error" || currentStatus === "cancelled") {
          ctx.ui.notify(`Run ${targetRunId} is already ${currentStatus}.`, "error");
          return;
        }
        try {
          ensurePrivateDir(getJournalDir(cwd, targetRunId), cwd);
          writeTextAtomic(pauseFile, new Date().toISOString());
          ctx.ui.notify(`Pause signal sent to ${targetRunId}. The run will stop at the next agent call.`, "info");
        } catch (e) {
          ctx.ui.notify(`Failed to write pause signal: ${e instanceof Error ? e.message : String(e)}`, "error");
        }
        return;
      }

      ctx.ui.notify([
        "Usage: /workflows [list|save|run|resume|pause|clean]",
        "",
        "  list             List saved commands and recent runs",
        "  save <name>      Save the last workflow as a reusable command",
        "  run <name>       Execute a saved workflow in the background",
        "  resume <runId>   Resume a paused or failed workflow",
        "  pause <runId>    Pause a running workflow",
        "  clean [days]     Remove completed/failed/cancelled runs older than the given age (default: 7)",
      ].join("\n"), "info");
    },
  });

  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    const toAdd = [tool.name, statusTool.name].filter(n => !active.includes(n));
    if (toAdd.length) {
      pi.setActiveTools([...active, ...toAdd]);
    }
  });

  pi.on("session_shutdown", async () => {
    for (const controller of ACTIVE_RUN_CONTROLLERS.values()) controller.abort();
    await Promise.allSettled([...ACTIVE_RUN_DRAINS.values()]);
  });
}

// ── Exports ───────────────────────────────────────────────────────────────

export { executeWorkflow, parseScript, createWorkflowTool, createWorkflowStatusTool, enrichSyntaxError, suggestSyntaxFix, validateSyntax, getRunStatus };
export type { WorkflowMeta, AgentOptions, WorkflowRunResult, JournalEntry };
