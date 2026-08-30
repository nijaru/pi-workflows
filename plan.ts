import vm from "node:vm";

export const MAX_SCRIPT_BYTES = 512 * 1024;
export const MAX_PLAN_NODES = 1000;
export const MAX_PROMPT_BYTES = 64 * 1024;
export const MAX_ARGS_BYTES = 256 * 1024;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type WorkflowEffect = "read" | "write";
export type Isolation = "worktree";

export interface WorkflowMeta {
  name: string;
  description: string;
  model?: string;
  phases?: Array<{ title: string; model?: string }>;
}

export interface OutputSpec {
  schema: JsonValue;
  maxRetries?: number;
}

export interface AgentTaskSpec {
  id: string;
  prompt: string;
  needs: string[];
  label: string;
  phase?: string;
  model?: string;
  effect: WorkflowEffect;
  isolation?: Isolation;
  output?: OutputSpec;
}

export interface WorkflowNode extends AgentTaskSpec {
  order: number;
}

export interface WorkflowPlan {
  meta: WorkflowMeta;
  script: string;
  body: string;
  nodes: WorkflowNode[];
  resultIds: string[];
  phases: string[];
}

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

class TaskRef {
  readonly __workflowTask = true;
  constructor(readonly id: string) {}
}

type AnyTaskRef = TaskRef;

function isTaskRef(value: unknown): value is AnyTaskRef {
  return !!value && typeof value === "object" && (value as any).__workflowTask === true && typeof (value as any).id === "string";
}

function toJson(value: unknown, path = "value", depth = 0): JsonValue {
  if (depth > 12) throw new PlanError(`${path} is too deeply nested`);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, i) => toJson(item, `${path}[${i}]`, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = Object.create(null);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) result[key] = toJson(child, `${path}.${key}`, depth + 1);
    return result;
  }
  throw new PlanError(`${path} must contain only JSON values`);
}

function parseOutput(value: unknown): OutputSpec | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || !("schema" in value)) throw new PlanError("output must be { schema, maxRetries? }");
  const maxRetries = (value as any).maxRetries;
  if (maxRetries !== undefined && (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 2)) {
    throw new PlanError("output.maxRetries must be an integer from 0 to 2");
  }
  return { schema: toJson((value as any).schema, "output.schema"), ...(maxRetries === undefined ? {} : { maxRetries }) };
}

interface TaskOptions {
  id: string;
  prompt: string;
  needs?: unknown;
  label?: string;
  phase?: string;
  model?: string;
  effect?: WorkflowEffect;
  isolation?: Isolation;
  output?: unknown;
}

export function compileWorkflow(script: string, args: unknown = null, timeoutMs = 30_000): WorkflowPlan {
  const normalized = stripFence(script.trim());
  const { meta, body } = parseScript(normalized);
  if (Buffer.byteLength(JSON.stringify(args ?? null), "utf8") > MAX_ARGS_BYTES) throw new PlanError(`Workflow args exceed ${MAX_ARGS_BYTES} bytes`);
  const nodes = new Map<string, WorkflowNode>();
  const phases: string[] = [];
  let order = 0;

  const task = (options: TaskOptions): TaskRef => {
    if (!options || typeof options !== "object") throw new PlanError("agent() expects an options object");
    const id = options.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9._:/-]{1,160}$/.test(id)) throw new PlanError("agent.id must be a stable identifier (letters, numbers, . _ : / -)");
    if (nodes.has(id)) throw new PlanError(`Duplicate agent id: ${id}`);
    if (typeof options.prompt !== "string" || !options.prompt.trim()) throw new PlanError(`agent ${id} requires a non-empty prompt`);
    if (Buffer.byteLength(options.prompt, "utf8") > MAX_PROMPT_BYTES) throw new PlanError(`agent ${id} prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
    const needs = normalizeRefs(options.needs, `agent ${id}.needs`);
    const effect = options.effect ?? "write";
    if (effect !== "read" && effect !== "write") throw new PlanError(`agent ${id}.effect must be read or write`);
    if (options.isolation !== undefined && options.isolation !== "worktree") throw new PlanError(`agent ${id}.isolation must be worktree`);
    if (options.model !== undefined && (typeof options.model !== "string" || !options.model.includes("/"))) throw new PlanError(`agent ${id}.model must use provider/id form`);
    const output = parseOutput(options.output);
    if (effect === "write" && output?.maxRetries && output.maxRetries > 0) throw new PlanError(`write agent ${id} cannot retry structured output after side effects`);
    nodes.set(id, {
      id,
      prompt: options.prompt,
      needs,
      label: options.label ?? id,
      phase: options.phase,
      model: options.model,
      effect,
      isolation: options.isolation,
      output,
      order: order++,
    });
    if (nodes.size > MAX_PLAN_NODES) throw new PlanError(`Workflow exceeds ${MAX_PLAN_NODES} agents`);
    return new TaskRef(id);
  };

  const refs = (value: unknown, path: string): TaskRef[] => {
    if (!Array.isArray(value)) throw new PlanError(`${path} expects an array of task references`);
    return value.map((item, i) => {
      if (!isTaskRef(item)) throw new PlanError(`${path}[${i}] is not a task reference`);
      return item;
    });
  };

  const parallel = (value: unknown): TaskRef[] => refs(value, "parallel()" );
  const pipeline = (stages: unknown): TaskRef[] => {
    if (!Array.isArray(stages) || stages.length === 0) throw new PlanError("pipeline() expects non-empty arrays of task references");
    const normalizedStages = stages.map((stage, i) => refs(stage, `pipeline stage ${i}`));
    for (let i = 1; i < normalizedStages.length; i++) {
      const previous = normalizedStages.slice(0, i).flat().map(ref => ref.id);
      for (const ref of normalizedStages[i]!) {
        const node = nodes.get(ref.id);
        if (!node) throw new PlanError(`pipeline references unknown task ${ref.id}`);
        node.needs = [...new Set([...node.needs, ...previous])];
      }
    }
    return normalizedStages.flat();
  };

  const context = vm.createContext(Object.assign(Object.create(null), {
    args: toJson(args ?? null, "args"),
    budget: Object.freeze({}),
    agent: task,
    task,
    parallel,
    pipeline,
    phase: (title: unknown) => {
      if (typeof title !== "string" || !title.trim()) throw new PlanError("phase() requires a title");
      phases.push(title);
      return title;
    },
    log: (_message: unknown) => undefined,
    globalThis: undefined,
  }), { codeGeneration: { strings: false, wasm: false } });
  (context as any).globalThis = context;
  Object.defineProperty(context, "Date", { value: class extends Date {
    constructor(...values: any[]) {
      if (values.length === 0) throw new PlanError("Workflow scripts must use an explicit Date value");
      super(...values as [any]);
    }
    static now(): never { throw new PlanError("Workflow scripts cannot call Date.now()"); }
  }, writable: false });
  const source = `(() => {\n${body}\n})()`;
  let returned: unknown;
  try {
    returned = new vm.Script(source, { filename: `${meta.name}.workflow.js` }).runInContext(context, { timeout: timeoutMs });
  } catch (error) {
    throw enrichPlanError(error);
  }
  if (returned && typeof (returned as any).then === "function") {
    throw new PlanError("Workflow plan construction must be synchronous; use task references without awaiting execution");
  }
  const resultIds = collectRefs(returned);
  validatePlan(nodes);
  const leafIds = [...nodes.values()].filter(node => ![...nodes.values()].some(other => other.needs.includes(node.id))).map(node => node.id);
  return { meta, script: normalized, body, nodes: [...nodes.values()].sort((a, b) => a.order - b.order), resultIds: resultIds.length ? resultIds : leafIds, phases: [...new Set([...phases, ...(meta.phases?.map(p => p.title) ?? [])])] };
}

function normalizeRefs(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new PlanError(`${path} expects an array`);
  return value.map((item, i) => {
    if (!isTaskRef(item)) throw new PlanError(`${path}[${i}] is not a task reference`);
    return item.id;
  });
}

function collectRefs(value: unknown, out: string[] = []): string[] {
  if (isTaskRef(value)) out.push(value.id);
  else if (Array.isArray(value)) for (const item of value) collectRefs(item, out);
  else if (value && typeof value === "object") for (const child of Object.values(value)) collectRefs(child, out);
  return [...new Set(out)];
}

function validatePlan(nodes: Map<string, WorkflowNode>): void {
  for (const node of nodes.values()) {
    for (const dep of node.needs) if (!nodes.has(dep)) throw new PlanError(`Agent ${node.id} depends on unknown agent ${dep}`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new PlanError(`Workflow dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of nodes.get(id)!.needs) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of nodes.keys()) visit(id);
}

function stripFence(script: string): string {
  const match = script.match(/^```(?:js|javascript|ts|typescript)?\s*\n([\s\S]*?)\n```$/i);
  return match?.[1]?.trim() ?? script;
}

export function parseScript(script: string): { meta: WorkflowMeta; body: string } {
  if (Buffer.byteLength(script, "utf8") > MAX_SCRIPT_BYTES) throw new PlanError(`Workflow script exceeds ${MAX_SCRIPT_BYTES} bytes`);
  const leading = script.match(/^(?:\s|\/\/[^\r\n]*(?:\r\n|\r|\n|$)|\/\*[\s\S]*?\*\/)*/);
  const offset = leading?.[0].length ?? 0;
  const header = script.slice(offset).match(/^export\s+const\s+meta\s*=\s*\{/);
  if (!header) throw new PlanError("Script must start with export const meta = { name, description }");
  const start = offset + header[0].lastIndexOf("{");
  const end = findBalancedObject(script, start);
  let meta: WorkflowMeta;
  try { meta = validateMeta(new LiteralParser(script.slice(start, end + 1)).parse()); }
  catch (error) { throw new PlanError(`Invalid meta object: ${error instanceof Error ? error.message : String(error)}`); }
  const bodyStart = script[end + 1] === ";" ? end + 2 : end + 1;
  const body = script.slice(bodyStart);
  if (/\bDate\s*\.\s*now\s*\(|\bMath\s*\.\s*random\s*\(|\bnew\s+Date\s*\(\s*\)/.test(stripLiterals(body))) {
    throw new PlanError("Workflow scripts must be deterministic: Date.now(), Math.random(), and new Date() are unavailable");
  }
  return { meta, body };
}

function findBalancedObject(source: string, start: number): number {
  let depth = 0; let quote: string | undefined; let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i]!;
    if (quote) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === quote) quote = undefined; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  throw new PlanError("Unmatched braces in meta object");
}

function stripLiterals(source: string): string {
  return source.replace(/\/\/[^\r\n]*|\/\*[\s\S]*?\*|(['"`])(?:\\.|(?!\1)[^\\])*\1|\/[^/\n]+\/[gimsuy]*/g, match => match.includes("\n") ? match.replace(/[^\n]/g, " ") : " ".repeat(match.length));
}

function validateMeta(value: unknown): WorkflowMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("meta must be an object literal");
  const raw = value as any;
  if (typeof raw.name !== "string" || !raw.name.trim()) throw new Error("meta.name must be non-empty");
  if (typeof raw.description !== "string" || !raw.description.trim()) throw new Error("meta.description must be non-empty");
  if (raw.model !== undefined && typeof raw.model !== "string") throw new Error("meta.model must be a string");
  if (raw.phases !== undefined && (!Array.isArray(raw.phases) || raw.phases.some((p: any) => !p || typeof p.title !== "string" || !p.title.trim()))) throw new Error("meta.phases must contain titled phases");
  return { name: raw.name, description: raw.description, ...(raw.model ? { model: raw.model } : {}), ...(raw.phases ? { phases: raw.phases.map((p: any) => ({ title: p.title, ...(p.model ? { model: p.model } : {}) })) } : {}) };
}

class LiteralParser {
  private i = 0;
  constructor(private readonly s: string) {}
  parse(): unknown { const v = this.value(); this.ws(); if (this.i !== this.s.length) throw new Error("unexpected token"); return v; }
  private ws() { while (/\s/.test(this.s[this.i] ?? "")) this.i++; }
  private value(): unknown {
    this.ws(); const ch = this.s[this.i];
    if (ch === "{" ) return this.object(); if (ch === "[") return this.array(); if (ch === '"' || ch === "'") return this.string();
    for (const [word, value] of [["true", true], ["false", false], ["null", null]] as const) if (this.s.startsWith(word, this.i)) { this.i += word.length; return value; }
    const number = this.s.slice(this.i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/); if (number) { this.i += number[0].length; return Number(number[0]); }
    throw new Error(`unsupported value at ${this.i + 1}`);
  }
  private object(): Record<string, unknown> { const out: Record<string, unknown> = Object.create(null); this.i++; this.ws(); if (this.s[this.i] === "}") { this.i++; return out; } while (true) { this.ws(); const key = (this.s[this.i] === '"' || this.s[this.i] === "'") ? this.string() : this.s.slice(this.i).match(/^[A-Za-z_$][\w$]*/)?.[0]; if (!key) throw new Error("invalid object key"); this.i += (this.s[this.i - 1] === '"' || this.s[this.i - 1] === "'") ? 0 : String(key).length; this.ws(); if (this.s[this.i++] !== ":") throw new Error("expected ':'"); out[String(key)] = this.value(); this.ws(); if (this.s[this.i] === "}") { this.i++; return out; } if (this.s[this.i++] !== ",") throw new Error("expected ','"); } }
  private array(): unknown[] { const out: unknown[] = []; this.i++; this.ws(); if (this.s[this.i] === "]") { this.i++; return out; } while (true) { out.push(this.value()); this.ws(); if (this.s[this.i] === "]") { this.i++; return out; } if (this.s[this.i++] !== ",") throw new Error("expected ','"); } }
  private string(): string { const quote = this.s[this.i++]; let out = ""; let escaped = false; while (this.i < this.s.length) { const ch = this.s[this.i++]; if (escaped) { out += ch === "n" ? "\n" : ch === "r" ? "\r" : ch === "t" ? "\t" : ch; escaped = false; } else if (ch === "\\") escaped = true; else if (ch === quote) return out; else out += ch; } throw new Error("unterminated string"); }
}

function enrichPlanError(error: unknown): Error {
  if (error instanceof PlanError) return error;
  return new PlanError(error instanceof Error ? error.message : String(error));
}
