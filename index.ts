/**
 * pi-workflows: Script-as-plan orchestration for pi.
 *
 * Model writes a JS orchestration script. Runtime executes it in a sandboxed
 * VM with journal-based resume, model tier routing, and real cost tracking.
 *
 * Uses pi's SDK directly for agent execution — no external dependencies.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Component, Text } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

// ── Types ──────────────────────────────────────────────────────────────────

interface WorkflowMeta {
  name: string;
  description: string;
  phases?: Array<{ title: string; model?: string }>;
  model?: string;
}

interface AgentOptions {
  label?: string;
  phase?: string;
  model?: string;
  tier?: "small" | "medium" | "big";
  taskType?: string;
  isolation?: "worktree";
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

const MAX_AGENTS = 1000;
const MAX_CONCURRENCY = 16;
const WORKFLOW_DIR = ".pi/workflows";
const COMMANDS_DIR = ".pi/workflows/commands";

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
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, "utf-8"));
    }
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
    const tier = TASK_TYPE_TIERS[opts.taskType];
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

  // Tier-based default (requires model-tiers.json config)
  if (!TIER_MODELS) return undefined; // use pi's default model
  const tier = resolveTier(opts, prompt);
  return TIER_MODELS[tier];
}

// ── Determinism ────────────────────────────────────────────────────────────

function hashCall(prompt: string, opts: AgentOptions, phase?: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ prompt, model: opts.model ?? null, tier: opts.tier ?? null, taskType: opts.taskType ?? null, phase: phase ?? null }))
    .digest("hex");
}

const DETERMINISM_PRELUDE = [
  '"use strict";',
  'Math.random = () => { throw new Error("Math.random() unavailable in workflow"); };',
  'const _D = Date;',
  'const _ND = function(...a) { if (!a.length) throw new Error("new Date() without args is non-deterministic. Use new Date(\"2024-01-01\") or Date.UTC() instead."); return new _D(...a); };',
  '_ND.UTC = _D.UTC; _ND.parse = _D.parse; _ND.now = () => { throw new Error("Date.now() unavailable in workflow"); };',
  '_ND.prototype = _D.prototype; globalThis.Date = _ND;',
].join("\n");

// ── Journal Persistence ────────────────────────────────────────────────────

function getJournalDir(cwd: string, runId: string): string {
  return join(cwd, WORKFLOW_DIR, runId);
}

function writeJournalEntry(cwd: string, runId: string, entry: JournalEntry): void {
  try {
    const dir = getJournalDir(cwd, runId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "journal.jsonl");
    const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
    writeFileSync(path, existing + JSON.stringify(entry) + "\n");
  } catch {
    // Best-effort persistence
  }
}

function readJournal(cwd: string, runId: string): Map<number, JournalEntry> {
  const journal = new Map<number, JournalEntry>();
  const path = join(getJournalDir(cwd, runId), "journal.jsonl");
  try {
    if (!existsSync(path)) return journal;
    for (const line of readFileSync(path, "utf-8").split("\n")) {
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

function parseScript(script: string): { meta: WorkflowMeta; body: string } {
  if (/\bDate\.now\b|\bMath\.random\b|\bnew Date\s*\(\s*\)/.test(script)) {
    throw new Error("Workflow scripts must be deterministic (no Date.now()/Math.random()/new Date()). Explicit dates like new Date(\"2024-01-01\") are allowed.");
  }

  // Find the start of the meta object
  const metaStart = script.match(/export\s+const\s+meta\s*=\s*\{/);
  if (metaStart?.index == null) throw new Error("Script must start with: export const meta = { name, description }");

  // Find the matching closing brace by tracking depth
  const startIdx = script.indexOf('{', metaStart.index + metaStart[0].length - 1);
  let depth = 0;
  let endIdx = -1;
  for (let i = startIdx; i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}') {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }
  if (endIdx === -1) throw new Error("Unmatched braces in meta object");

  const metaStr = script.slice(startIdx, endIdx + 1);
  const metaEnd = endIdx + 1;
  // Skip optional semicolon after meta
  const afterMeta = script[metaEnd] === ';' ? metaEnd + 1 : metaEnd;

  let meta: WorkflowMeta;
  try { meta = new Function(`return (${metaStr})`)(); } catch { throw new Error("meta must be a literal object"); }
  if (!meta?.name?.trim()) throw new Error("meta.name must be a non-empty string");
  if (!meta?.description?.trim()) throw new Error("meta.description must be a non-empty string");

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

/**
 * Create an isolated agent session and run a prompt.
 * Returns the assistant's text and real token usage from pi's session stats.
 */
// Lazy-load pi SDK singletons (created once, reused across all agent calls in a workflow)
let _sdk: { createAgentSession: any; createCodingTools: any; AuthStorage: any; ModelRegistry: any; SessionManager: any; SettingsManager: any } | undefined;
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

async function runAgent(
  prompt: string,
  options: {
    label: string;
    model?: string;
    cwd: string;
    signal?: AbortSignal;
  },
): Promise<{ text: string; tokens: { input: number; output: number; total: number; cost: number } }> {
  const sdk = await loadSdk();
  const { registry } = getAuthAndRegistry();
  const agentDir = join(process.env.HOME ?? "~", ".pi", "agent");

  // Resolve model from spec (provider/id format)
  let model: any | undefined;
  if (options.model) {
    const slash = options.model.indexOf("/");
    if (slash > 0) {
      model = registry.find(options.model.slice(0, slash), options.model.slice(slash + 1));
    }
    if (!model) {
      model = registry.getAvailable().find((m: any) => m.id === options.model);
    }
  }

  // Create isolated session with coding tools
  const { session } = await sdk.createAgentSession({
    cwd: options.cwd,
    agentDir,
    sessionManager: sdk.SessionManager.inMemory(),
    settingsManager: sdk.SettingsManager.create(options.cwd, agentDir),
    customTools: sdk.createCodingTools(options.cwd),
    model,
  });

  // Wire up abort signal
  let removeAbortListener: (() => void) | undefined;
  if (options.signal) {
    const onAbort = () => session.abort();
    options.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
  }

  try {
    await session.prompt(`Task: ${options.label}\n\n${prompt}`);

    const text = extractAssistantText(session.messages);
    const stats = session.getSessionStats();

    return {
      text: text || `[${options.label}: no text output]`,
      tokens: {
        input: stats.tokens.input,
        output: stats.tokens.output,
        total: stats.tokens.total,
        cost: stats.cost,
      },
    };
  } finally {
    removeAbortListener?.();
    session.dispose();
  }
}

// ── Workflow Runtime ───────────────────────────────────────────────────────

async function executeWorkflow(
  script: string,
  options: {
    args?: unknown;
    cwd?: string;
    runId?: string;
    tokenBudget?: number | null;
    maxAgents?: number;
    signal?: AbortSignal;
    resumeJournal?: Map<number, JournalEntry>;
  } = {},
): Promise<WorkflowRunResult> {
  const started = Date.now();
  const { meta, body } = parseScript(script);
  const cwd = options.cwd ?? process.cwd();
  const runId = options.runId ?? `run-${started.toString(36)}`;
  const maxAgents = options.maxAgents ?? MAX_AGENTS;
  const tokenBudget = options.tokenBudget ?? null;

  const state = {
    logs: [] as string[],
    phases: meta.phases?.[0]?.title ? [meta.phases[0].title] : [] as string[],
    currentPhase: meta.phases?.[0]?.title as string | undefined,
    callSeq: 0,
    firstMiss: Number.POSITIVE_INFINITY,
  };

  const shared = {
    limiter: createLimiter(MAX_CONCURRENCY),
    agentCount: 0,
    spent: 0,
    tokenUsage: { input: 0, output: 0, total: 0, cost: 0 },
  };

  // Per-phase sub-budgets: phase title -> { budget, startSpent }
  const phaseBudgets = new Map<string, { budget: number; startSpent: number; warned: boolean }>();

  const log = (msg: string) => state.logs.push(msg);
  const phase = (title: string, opts?: { budget?: number }) => {
    state.currentPhase = title;
    if (!state.phases.includes(title)) state.phases.push(title);
    if (typeof opts?.budget === "number" && opts.budget > 0) {
      phaseBudgets.set(title, { budget: opts.budget, startSpent: shared.spent, warned: false });
    }
  };

  const budget = Object.freeze({
    total: tokenBudget,
    spent: () => shared.spent,
    remaining: () => tokenBudget == null ? Infinity : Math.max(0, tokenBudget - shared.spent),
  });

  const throwIfAborted = () => {
    if (options.signal?.aborted) throw new Error("Workflow aborted");
  };

  const throwIfPaused = () => {
    const pauseFile = join(cwd, WORKFLOW_DIR, runId, "paused");
    if (existsSync(pauseFile)) throw new Error("Workflow paused");
  };

  // ── agent() — the core primitive ──────────────────────────────────

  const agent = async (prompt: string, opts: AgentOptions = {}): Promise<string | null> => {
    throwIfAborted();
    throwIfPaused();
    if (shared.agentCount >= maxAgents) throw new Error(`Agent limit exceeded (${maxAgents})`);
    if (budget.total !== null && budget.remaining() <= 0) throw new Error("Token budget exhausted");

    const assignedPhase = opts.phase ?? state.currentPhase;

    // Per-phase sub-budget check
    if (assignedPhase) {
      const pb = phaseBudgets.get(assignedPhase);
      if (pb) {
        const phaseSpent = shared.spent - pb.startSpent;
        if (phaseSpent >= pb.budget) {
          throw new Error(`Phase "${assignedPhase}" budget exhausted (${pb.budget})`);
        }
        if (!pb.warned && phaseSpent >= pb.budget * 0.8) {
          pb.warned = true;
          log(`Phase "${assignedPhase}" at ${Math.round((phaseSpent / pb.budget) * 100)}% of budget`);
        }
      }
    }
    const model = resolveModel(opts, assignedPhase, meta, prompt);
    const label = opts.label?.trim() || `${assignedPhase ?? "agent"} ${state.callSeq + 1}`;

    // Resume check
    const callIndex = state.callSeq++;
    shared.agentCount++; // Count all agents including cached
    const callHash = hashCall(prompt, { ...opts, model: model ?? opts.model }, assignedPhase);
    const cached = options.resumeJournal?.get(callIndex);
    if (cached?.hash === callHash && callIndex < state.firstMiss) {
      shared.tokenUsage.input += cached.tokens.input;
      shared.tokenUsage.output += cached.tokens.output;
      shared.tokenUsage.total += cached.tokens.total;
      shared.tokenUsage.cost += cached.tokens.cost;
      shared.spent += cached.tokens.total;
      return cached.result as string;
    }
    if (!cached || cached.hash !== callHash) {
      state.firstMiss = Math.min(state.firstMiss, callIndex);
    }
    return shared.limiter(async () => {
      const agentStart = Date.now();

      // Optional worktree isolation
      let worktreePath: string | undefined;
      if (opts.isolation === "worktree") {
        worktreePath = join(cwd, `.pi/worktrees`, `${runId}-${callIndex}`);
        try {
          execSync(`git worktree add "${worktreePath}" --detach 2>/dev/null`, { cwd, stdio: "ignore" });
        } catch {
          // If worktree creation fails, fall back to main cwd
          worktreePath = undefined;
        }
      }

      const agentCwd = worktreePath ?? cwd;

      try {
        throwIfAborted();
        const { text, tokens } = await runAgent(prompt, { label, model, cwd: agentCwd, signal: options.signal });
        throwIfAborted();

        shared.tokenUsage.input += tokens.input;
        shared.tokenUsage.output += tokens.output;
        shared.tokenUsage.total += tokens.total;
        shared.tokenUsage.cost += tokens.cost;
        shared.spent += tokens.total;

        // If using worktree, commit changes and merge back
        if (worktreePath) {
          try {
            // Check if there are changes to commit
            const status = execSync(`git status --porcelain`, { cwd: worktreePath, encoding: "utf-8" }).trim();
            if (status) {
              execSync(`git add -A && git commit -m "workflow ${label}" --no-verify`, { cwd: worktreePath, stdio: "ignore" });
              const commitHash = execSync(`git rev-parse HEAD`, { cwd: worktreePath, encoding: "utf-8" }).trim();
              try {
                execSync(`git cherry-pick ${commitHash} --no-edit`, { cwd, stdio: "ignore" });
              } catch (cherryPickErr) {
                // Conflict: try cherry-pick with auto-resolve strategy
                try {
                  execSync(`git cherry-pick --abort`, { cwd, stdio: "ignore" });
                  execSync(`git cherry-pick ${commitHash} --no-edit -X theirs`, { cwd, stdio: "ignore" });
                  log(`worktree merge for "${label}": merged with conflict resolution`);
                } catch {
                  // If -X theirs also fails, try merge strategy
                  try {
                    execSync(`git cherry-pick --abort 2>/dev/null`, { cwd, stdio: "ignore" });
                    execSync(`git merge --no-edit -X theirs ${commitHash}`, { cwd, stdio: "ignore" });
                    log(`worktree merge for "${label}": merged via git merge`);
                  } catch {}
                }
              }
            }
          } catch (err) {
            log(`worktree merge for "${label}" failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        writeJournalEntry(cwd, runId, {
          index: callIndex,
          hash: callHash,
          result: text,
          tokens,
          durationMs: Date.now() - agentStart,
        });

        return text;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        log(`agent "${label}" failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      } finally {
        // Clean up worktree
        if (worktreePath) {
          try {
            execSync(`git worktree remove "${worktreePath}" --force 2>/dev/null`, { cwd, stdio: "ignore" });
          } catch {}
        }
      }
    });
  };

  // ── parallel() ────────────────────────────────────────────────────

  const parallel = async (thunks: Array<() => Promise<unknown>>): Promise<unknown[]> => {
    throwIfAborted();
    if (!Array.isArray(thunks) || thunks.some(t => typeof t !== "function")) {
      throw new TypeError("parallel() expects an array of functions");
    }
    return Promise.all(thunks.map(async (thunk, i) => {
      try { return await thunk(); }
      catch (error) {
        if (options.signal?.aborted) throw error;
        log(`parallel[${i}] failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    }));
  };

  // ── pipeline() ────────────────────────────────────────────────────

  const pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ): Promise<unknown[]> => {
    throwIfAborted();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array");
    return Promise.all(items.map(async (item, i) => {
      let value = item;
      for (const stage of stages) {
        try {
          throwIfAborted();
          value = await stage(value, item, i);
          throwIfAborted();
        } catch (error) {
          if (options.signal?.aborted) throw error;
          log(`pipeline[${i}] failed: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }
      }
      return value;
    }));
  };

  // ── Quality helpers ─────────────────────────────────────────────────

  const verify = async (item: unknown, opts?: { reviewers?: number; threshold?: number }) => {
    const reviewers = Math.max(1, opts?.reviewers ?? 2);
    const threshold = opts?.threshold ?? 0.5;
    const claim = typeof item === "string" ? item : JSON.stringify(item);
    const votes = (await parallel(
      Array.from({ length: reviewers }, (_, i) => () =>
        agent(`Adversarially review whether this is REAL/correct. Try to refute it. Reply with JSON: {"real": bool, "reason": str}.

${claim}`, { label: `verify ${i + 1}` })
      )
    )).filter(Boolean) as string[];
    // Parse votes (best-effort)
    const parsed = votes.map(v => { try { return JSON.parse(v); } catch { return { real: false }; } });
    const realCount = parsed.filter((v: any) => v?.real).length;
    return { real: parsed.length > 0 && realCount / parsed.length >= threshold, votes: parsed };
  };

  const judgePanel = async (attempts: unknown[], opts?: { judges?: number; rubric?: string }) => {
    const judges = Math.max(1, opts?.judges ?? 3);
    const rubric = opts?.rubric ?? "overall quality and correctness";
    const scored = await parallel(
      (Array.isArray(attempts) ? attempts : []).map((att, idx) => async () => {
        const text = typeof att === "string" ? att : JSON.stringify(att);
        const scores = (await parallel(
          Array.from({ length: judges }, (_, j) => () =>
            agent(`Score this candidate 0-1 on: ${rubric}. Reply with JSON: {"score": number}.

Candidate:
${text}`, { label: `judge ${idx + 1}.${j + 1}` })
          )
        )).filter(Boolean) as string[];
        const parsed = scores.map(s => { try { return JSON.parse(s); } catch { return { score: 0 }; } });
        const avg = parsed.reduce((s, v: any) => s + (Number(v?.score) || 0), 0) / (parsed.length || 1);
        return { index: idx, attempt: att, score: avg };
      })
    );
    const results = (scored as any[]).filter(Boolean);
    return results.reduce((best, cur) => (!best || cur.score > best.score) ? cur : best, null);
  };

  const loopUntilDry = async (opts: { round: (i: number) => Promise<unknown[]> | unknown[]; key?: (item: unknown) => string; consecutiveEmpty?: number; maxRounds?: number }) => {
    const key = opts.key ?? ((x: unknown) => JSON.stringify(x));
    const consecutiveEmpty = Math.max(1, opts.consecutiveEmpty ?? 2);
    const maxRounds = opts.maxRounds ?? 50;
    const seen = new Set<string>();
    const all: unknown[] = [];
    let dry = 0;
    for (let r = 0; r < maxRounds && dry < consecutiveEmpty; r++) {
      const items = (await opts.round(r)) ?? [];
      const fresh = (Array.isArray(items) ? items : []).filter(x => x != null && !seen.has(key(x)));
      if (!fresh.length) { dry++; continue; }
      dry = 0;
      for (const x of fresh) { seen.add(key(x)); all.push(x); }
    }
    return all;
  };

  const completenessCheck = async (taskArgs: unknown, results: unknown) =>
    agent(`Given the task and results so far, list what is still MISSING. Be specific.

Task:
${JSON.stringify(taskArgs)}

Results:
${JSON.stringify(results).slice(0, 4000)}`, { label: "completeness critic" });

  // ── Execute in VM ──────────────────────────────────────────────────

  const context = vm.createContext({
    agent,
    parallel,
    pipeline,
    log,
    phase,
    verify,
    judgePanel,
    loopUntilDry,
    completenessCheck,
    args: options.args,
    cwd,
    budget,
  });

  const wrapped = `${DETERMINISM_PRELUDE}\n(async () => {\n${body}\n})()`;
  const result = await new vm.Script(wrapped, { filename: `${meta.name}.js` }).runInContext(context);

  return {
    meta,
    result,
    logs: state.logs,
    phases: state.phases,
    agentCount: shared.agentCount,
    durationMs: Date.now() - started,
    runId,
    tokenUsage: shared.tokenUsage,
  };
}

// ── Workflow Tool ──────────────────────────────────────────────────────────

// ── Tool Result Helpers ────────────────────────────────────────────────────

const ok = (text: string, details: unknown = {}) => ({
  content: [{ type: "text" as const, text }],
  details,
});

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
    description: "Hard token budget cap for the run.",
  })),
  maxAgents: Type.Optional(Type.Number({
    description: "Maximum agents allowed (default: 1000).",
  })),
  resume: Type.Optional(Type.Boolean({
    description: "Resume from last incomplete run of same workflow name (default: true).",
  })),
  forceResume: Type.Optional(Type.Boolean({
    description: "Allow resuming a run that previously errored (default: false).",
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
      "Scripts have no direct filesystem or shell access. All side effects go through agent() calls.",
      "Date.now(), Math.random(), and new Date() without args are blocked. Explicit dates like new Date(\"2024-01-01\") and Date.UTC() are allowed.",
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

    async execute(_id: string, params: { script: string; args?: unknown; background?: boolean; tokenBudget?: number; maxAgents?: number; resume?: boolean; forceResume?: boolean; dryRun?: boolean }, signal?: AbortSignal, _onUpdate?: unknown, ctx?: ExtensionContext) {
      let script = params.script.trim();
      const fence = script.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
      if (fence?.[1]) script = fence[1].trim();

      const { meta } = parseScript(script);

      // Dry run: return metadata without executing
      if (params.dryRun) {
        return ok(
          `Workflow "${meta.name}": ${meta.description}${meta.phases ? `, ${meta.phases.length} phase(s)` : ""}. ` +
          `Script is valid and ready to run.` +
          (params.tokenBudget ? ` Budget: ${params.tokenBudget} tokens.` : "") +
          (params.maxAgents ? ` Max agents: ${params.maxAgents}.` : ""),
          { dryRun: true, meta, scriptLength: script.length },
        );
      }

      const cwd = process.cwd();
      const shouldResume = params.resume !== false; // default true
      
      // Find existing run to resume (match by workflow name)
      let runId: string | undefined;
      let resumeJournal: Map<number, JournalEntry> | undefined;
      
      const shouldForceResume = params.forceResume === true;
      if (shouldResume) {
        const runs = listWorkflowRuns(cwd);
        for (const r of runs) {
          if (r.meta?.name === meta.name && (shouldForceResume || r.status !== "error")) {
            const journal = readJournal(cwd, r.runId);
            if (journal.size > 0) {
              // Check if this run is incomplete (no completion marker)
              const hasCompletion = existsSync(join(cwd, WORKFLOW_DIR, r.runId, "complete.log"));
              if (!hasCompletion) {
                runId = r.runId;
                resumeJournal = journal;
                break;
              }
            }
          }
        }
      }
      
      if (!runId) {
        runId = `run-${Date.now().toString(36)}`; // monotonic counter not needed — runId is persistence-only, not execution context
      }

      // Write meta file for resume detection
      const metaDir = join(cwd, WORKFLOW_DIR, runId);
      try {
        mkdirSync(metaDir, { recursive: true });
        writeFileSync(join(metaDir, "meta.json"), JSON.stringify({ name: meta.name, description: meta.description, phases: meta.phases, script }));
      } catch {}

      if (params.background !== false) {
        executeWorkflow(script, {
          args: params.args,
          runId,
          tokenBudget: params.tokenBudget,
          maxAgents: params.maxAgents,
          resumeJournal,
          signal,
        }).then((result) => {
          // Mark completion
          const dir = join(cwd, WORKFLOW_DIR, runId!);
          try {
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "complete.log"), JSON.stringify(result, null, 2));
          } catch {}
        }).catch((err) => {
          const error = err instanceof Error ? err.message : String(err);
          const isPaused = error === "Workflow paused";
          const isAborted = signal?.aborted || error === "Workflow aborted";
          const dir = join(cwd, WORKFLOW_DIR, runId!);
          try {
            mkdirSync(dir, { recursive: true });
            if (isPaused) {
              // Journal is preserved on disk — resume with same runId
              if (ctx) ctx.ui.notify(`Workflow "${meta.name}" paused. Resume by running again (runId: ${runId}).`, "info");
            } else if (isAborted) {
              // Deliberate cancellation — not an error
              if (ctx) ctx.ui.notify(`Workflow "${meta.name}" cancelled.`, "info");
            } else {
              writeFileSync(join(dir, "error.log"), `[${new Date().toISOString()}] ${error}\n`);
              if (ctx) ctx.ui.notify(`Workflow "${meta.name}" failed: ${error}`, "error");
            }
          } catch {}
        });

        const resumedMsg = resumeJournal ? ` (resumed from ${resumeJournal.size} cached)` : "";
        return ok(`Workflow "${meta.name}" started in background (run: ${runId})${resumedMsg}.`, { runId, background: true, resumed: !!resumeJournal });
      }

      const result = await executeWorkflow(script, {
        args: params.args,
        runId,
        tokenBudget: params.tokenBudget,
        maxAgents: params.maxAgents,
        resumeJournal,
        signal,
      });

      // Mark completion
      try {
        const dir = join(cwd, WORKFLOW_DIR, runId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "complete.log"), JSON.stringify(result, null, 2));
      } catch {}

      const resumedMsg = resumeJournal ? ` (resumed from ${resumeJournal.size} cached)` : "";
      return ok(`Workflow "${meta.name}" completed: ${result.agentCount} agent(s), ${result.durationMs}ms${resumedMsg}`, result);
    },
  };
}

// ── Workflow Commands ──────────────────────────────────────────────────────

function listSavedCommands(cwd: string): Array<{ name: string; path: string }> {
  const commands: Array<{ name: string; path: string }> = [];
  
  // Project commands
  const projectDir = join(cwd, COMMANDS_DIR);
  if (existsSync(projectDir)) {
    try {
      const files = readdirSync(projectDir);
      for (const f of files) {
        if (f.endsWith(".js")) {
          commands.push({ name: f.replace(".js", ""), path: join(projectDir, f) });
        }
      }
    } catch {}
  }
  
  // Personal commands
  const personalDir = join(process.env.HOME ?? "~", ".pi", "workflows", "commands");
  if (existsSync(personalDir)) {
    try {
      const files = readdirSync(personalDir);
      for (const f of files) {
        if (f.endsWith(".js")) {
          commands.push({ name: f.replace(".js", ""), path: join(personalDir, f) });
        }
      }
    } catch {}
  }
  
  return commands;
}

function listWorkflowRuns(cwd: string): Array<{ runId: string; meta: WorkflowMeta | null; status: string }> {
  const runs: Array<{ runId: string; meta: WorkflowMeta | null; status: string }> = [];
  const dir = join(cwd, WORKFLOW_DIR);
  if (!existsSync(dir)) return runs;
  
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry === "commands" || !entry.startsWith("run-")) continue;
      const metaPath = join(dir, entry, "meta.json");
      const errorPath = join(dir, entry, "error.log");
      const completePath = join(dir, entry, "complete.log");
      const hasError = existsSync(errorPath);
      const hasComplete = existsSync(completePath);
      const hasPaused = existsSync(join(dir, entry, "paused"));
      const hasMeta = existsSync(metaPath);
      
      // Read meta from meta.json
      let meta: WorkflowMeta | null = null;
      if (hasMeta) {
        try {
          const parsed = JSON.parse(readFileSync(metaPath, "utf-8"));
          meta = { name: parsed.name, description: parsed.description, phases: parsed.phases };
        } catch {}
      }
      
      runs.push({
        runId: entry,
        meta,
        status: hasError ? "error" : hasComplete ? "completed" : hasPaused ? "paused" : "running",
      });
    }
  } catch {}
  
  return runs;
}

// ── Extension Entry Point ─────────────────────────────────────────────────

export default function registerExtension(pi: ExtensionAPI) {
  const tool = createWorkflowTool();
  pi.registerTool(tool);

  // Register /workflows command
  pi.registerCommand("workflows", {
    description: "List, manage, and save workflows",
    handler: async (args, ctx) => {
      const cmd = (args ?? "").trim().toLowerCase();
      const cwd = ctx.cwd ?? process.cwd();
      
      if (cmd === "list" || cmd === "ls" || cmd === "") {
        const runs = listWorkflowRuns(cwd);
        const commands = listSavedCommands(cwd);
        
        const parts: string[] = [];
        
        if (commands.length > 0) {
          parts.push("Saved commands:");
          for (const c of commands) {
            parts.push(`  /${c.name}`);
          }
          parts.push("");
        }
        
        if (runs.length > 0) {
          parts.push("Recent runs:");
          for (const r of runs.slice(-10)) {
            const name = r.meta?.name ?? r.runId;
            const status = r.status === "error" ? " ❌" : r.status === "completed" ? " ✓" : r.status === "paused" ? " ⏸" : " ⏳";
            parts.push(`  ${name}${status}`);
          }
        } else {
          parts.push("No workflow runs yet.");
        }
        
        ctx.ui.notify(parts.join("\n"), "info");
        return;
      }
      
      if (cmd.startsWith("save ")) {
        const name = cmd.slice(5).trim();
        if (!name) {
          ctx.ui.notify("Usage: /workflows save <name>", "error");
          return;
        }
        // Find the most recent workflow tool call in the session
        const entries = ctx.sessionManager.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i];
          if (entry.type === "message" && entry.message.role === "assistant" && Array.isArray(entry.message.content)) {
            const toolUse = (entry.message.content as any[]).find(
              (c: any) => c.type === "tool_use" && c.name === "workflow"
            );
            if (toolUse?.input?.script) {
              const saveDir = join(cwd, COMMANDS_DIR);
              mkdirSync(saveDir, { recursive: true });
              writeFileSync(join(saveDir, `${name}.js`), toolUse.input.script);
              ctx.ui.notify(`Saved workflow as /${name}`, "info");
              return;
            }
          }
        }
        ctx.ui.notify("No recent workflow found to save. Run a workflow first.", "error");
        return;
      }

      if (cmd.startsWith("pause ")) {
        const targetRunId = cmd.slice(6).trim();
        if (!targetRunId) {
          ctx.ui.notify("Usage: /workflows pause <runId>", "error");
          return;
        }
        const pauseFile = join(cwd, WORKFLOW_DIR, targetRunId, "paused");
        const metaFile = join(cwd, WORKFLOW_DIR, targetRunId, "meta.json");
        if (!existsSync(metaFile)) {
          ctx.ui.notify(`Run ${targetRunId} not found.`, "error");
          return;
        }
        try {
          mkdirSync(join(cwd, WORKFLOW_DIR, targetRunId), { recursive: true });
          writeFileSync(pauseFile, new Date().toISOString());
          ctx.ui.notify(`Pause signal sent to ${targetRunId}. The run will stop at the next agent call.`, "info");
        } catch (e) {
          ctx.ui.notify(`Failed to write pause signal: ${e instanceof Error ? e.message : String(e)}`, "error");
        }
        return;
      }

      ctx.ui.notify([
        "Usage: /workflows [list|save|pause]",
        "",
        "  list           List saved commands and recent runs",
        "  save <name>    Save the last workflow as a reusable command",
        "  pause <runId>  Pause a running workflow (resume with same runId)",
      ].join("\n"), "info");
    },
  });

  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    if (!active.includes(tool.name)) {
      pi.setActiveTools([...active, tool.name]);
    }
  });
}

// ── Exports ───────────────────────────────────────────────────────────────

export { executeWorkflow, parseScript, createWorkflowTool };
export type { WorkflowMeta, AgentOptions, WorkflowRunResult, JournalEntry };
