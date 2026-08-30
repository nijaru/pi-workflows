import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, closeSync, unlinkSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { WorkflowMeta, WorkflowNode, WorkflowPlan, JsonValue } from "./plan";

export type RunStatus = "running" | "completed" | "failed" | "paused" | "cancelled" | "orphaned";
export type NodeStatus = "pending" | "ready" | "running" | "succeeded" | "failed" | "cancelled" | "blocked";

export interface Usage {
  input: number;
  output: number;
  total: number;
  cost: number;
}

export interface NodeRecord {
  spec: WorkflowNode;
  status: NodeStatus;
  attempts: number;
  output?: JsonValue;
  outputText?: string;
  usage: Usage;
  error?: string;
  operationId?: string;
  worktreePath?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface RunState {
  schemaVersion: 1;
  runId: string;
  meta: WorkflowMeta;
  script: string;
  args: JsonValue;
  planHash: string;
  createdAt: number;
  updatedAt: number;
  status: RunStatus;
  nodes: Record<string, NodeRecord>;
  resultIds: string[];
  result?: JsonValue;
  error?: string;
  usage: Usage;
  originSessionId?: string;
  backendId?: string;
}

export interface RunEvent {
  seq: number;
  at: number;
  type: string;
  nodeId?: string;
  data?: JsonValue;
}

export const WORKFLOW_ROOT = ".pi/workflows";

export function emptyUsage(): Usage { return { input: 0, output: 0, total: 0, cost: 0 }; }
export function addUsage(target: Usage, value: Partial<Usage> | undefined): void {
  if (!value) return;
  for (const key of ["input", "output", "total", "cost"] as const) target[key] += Number.isFinite(value[key]) ? Number(value[key]) : 0;
}

export function validateRunId(runId: string): void {
  if (!/^run-[a-z0-9-]{1,120}$/.test(runId)) throw new Error(`Invalid workflow run id: ${runId}`);
}

export function runDirectory(cwd: string, runId: string): string {
  validateRunId(runId);
  return join(resolve(cwd), WORKFLOW_ROOT, runId);
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch {}
}

function atomicWrite(path: string, content: string): void {
  ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
}

export class RunStore {
  readonly directory: string;
  private nextEvent = 0;
  constructor(readonly cwd: string, readonly runId: string) {
    this.directory = runDirectory(cwd, runId);
  }

  exists(): boolean { return existsSync(join(this.directory, "state.json")); }

  create(plan: WorkflowPlan, args: unknown, options: { planHash: string; originSessionId?: string; backendId?: string }): RunState {
    if (this.exists()) throw new Error(`Workflow run ${this.runId} already exists`);
    const nodes: Record<string, NodeRecord> = Object.create(null);
    for (const spec of plan.nodes) nodes[spec.id] = { spec, status: spec.needs.length ? "pending" : "ready", attempts: 0, usage: emptyUsage() };
    const now = Date.now();
    const state: RunState = {
      schemaVersion: 1,
      runId: this.runId,
      meta: plan.meta,
      script: plan.script,
      args: args as JsonValue,
      planHash: options.planHash,
      createdAt: now,
      updatedAt: now,
      status: "running",
      nodes,
      resultIds: plan.resultIds,
      usage: emptyUsage(),
      ...(options.originSessionId ? { originSessionId: options.originSessionId } : {}),
      ...(options.backendId ? { backendId: options.backendId } : {}),
    };
    ensurePrivateDirectory(this.directory);
    atomicWrite(join(this.directory, "state.json"), JSON.stringify(state, null, 2));
    this.append({ type: "run_created", data: { planHash: options.planHash } as any });
    return state;
  }

  load(): RunState {
    if (!this.exists()) throw new Error(`Workflow run ${this.runId} not found`);
    const state = JSON.parse(readFileSync(join(this.directory, "state.json"), "utf8")) as RunState;
    if (state.schemaVersion !== 1 || state.runId !== this.runId || !state.nodes) throw new Error(`Invalid workflow state for ${this.runId}`);
    this.nextEvent = this.readEvents().reduce((max, event) => Math.max(max, event.seq), -1) + 1;
    return state;
  }

  save(state: RunState): void {
    state.updatedAt = Date.now();
    atomicWrite(join(this.directory, "state.json"), JSON.stringify(state, null, 2));
  }

  append(event: Omit<RunEvent, "seq" | "at">): RunEvent {
    ensurePrivateDirectory(this.directory);
    const full = { seq: this.nextEvent++, at: Date.now(), ...event };
    appendFileSync(join(this.directory, "events.jsonl"), `${JSON.stringify(full)}\n`, { mode: 0o600 });
    return full;
  }

  readEvents(): RunEvent[] {
    const path = join(this.directory, "events.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as RunEvent]; } catch { return []; } });
  }

  writeOutput(nodeId: string, value: JsonValue): void { atomicWrite(join(this.directory, "outputs", `${safeName(nodeId)}.json`), JSON.stringify(value)); }
  readOutput(nodeId: string): JsonValue | undefined {
    const path = join(this.directory, "outputs", `${safeName(nodeId)}.json`);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as JsonValue;
  }

  static list(cwd: string): RunState[] {
    const root = join(resolve(cwd), WORKFLOW_ROOT);
    if (!existsSync(root)) return [];
    return readdirSync(root).filter(name => name.startsWith("run-")).flatMap(runId => {
      try { return [new RunStore(cwd, runId).load()]; } catch { return []; }
    }).sort((a, b) => a.createdAt - b.createdAt);
  }
}

function safeName(value: string): string { return value.replace(/[^A-Za-z0-9._:-]/g, "_"); }

export class RunLease {
  readonly path: string;
  private fd?: number;
  constructor(readonly store: RunStore) { this.path = join(store.directory, "lease.json"); }
  acquire(): void {
    mkdirSync(this.store.directory, { recursive: true, mode: 0o700 });
    try {
      this.fd = openSync(this.path, "wx", 0o600);
      writeFileSync(this.fd, JSON.stringify({ pid: process.pid, token: randomUUID(), at: Date.now() }));
    } catch (error) {
      if (leaseAlive(this.path)) throw new Error(`Workflow run ${this.store.runId} is already active`);
      try { unlinkSync(this.path); } catch {}
      try {
        this.fd = openSync(this.path, "wx", 0o600);
        writeFileSync(this.fd, JSON.stringify({ pid: process.pid, token: randomUUID(), at: Date.now() }));
      } catch (retryError) {
        throw new Error(`Workflow run ${this.store.runId} is already active: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
      }
    }
  }
  release(): void {
    if (this.fd !== undefined) { try { closeSync(this.fd); } catch {} this.fd = undefined; }
    try { unlinkSync(this.path); } catch {}
  }
}

export function leaseAlive(path: string): boolean {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    if (!Number.isInteger(value.pid) || Number(value.pid) <= 0) return false;
    process.kill(Number(value.pid), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}
