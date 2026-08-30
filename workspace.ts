import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { AgentTaskSpec } from "./plan";
import type { RunStore } from "./store";

const workspaceLocks = new Map<string, Promise<void>>();

export interface WorkspaceHandle { cwd: string; path?: string; finish(): Promise<void>; fail(): void; }

export async function prepareWorkspace(workspace: string, store: RunStore, spec: AgentTaskSpec): Promise<WorkspaceHandle> {
  const root = gitRoot(workspace);
  if (!spec.isolation) return { cwd: workspace, finish: async () => undefined, fail: () => undefined };
  if (!root) throw new Error(`Agent ${spec.id} requests worktree isolation outside a Git repository`);
  const worktrees = join(root, ".pi", "worktrees");
  mkdirSync(worktrees, { recursive: true, mode: 0o700 });
  const path = join(worktrees, `${store.runId}-${safe(spec.id)}`);
  if (existsSync(path)) throw new Error(`Workflow worktree already exists: ${path}`);
  execFileSync("git", ["worktree", "add", "--detach", path], { cwd: root, stdio: "ignore" });
  const relativeCwd = relative(root, workspace);
  const childCwd = relativeCwd && relativeCwd !== "." ? join(path, relativeCwd) : path;
  return {
    cwd: childCwd,
    path,
    finish: async () => {
      const status = gitStatus(path);
      if (!status) { removeWorktree(root, path); return; }
      execFileSync("git", ["add", "-A"], { cwd: path, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", `workflow ${spec.id}`, "--no-verify"], { cwd: path, stdio: "ignore" });
      const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
      await withWorkspaceLock(root, async () => {
        if (gitStatus(root)) throw new Error("Cannot merge workflow worktree: canonical checkout is dirty");
        const marker = join(store.directory, "pending-merge.json");
        writeFileSync(marker, JSON.stringify({ nodeId: spec.id, path, commit }), { mode: 0o600 });
        try { execFileSync("git", ["cherry-pick", commit], { cwd: root, stdio: "ignore" }); }
        catch (error) { throw new Error(`Workflow worktree merge conflict for ${spec.id}; preserved at ${path}: ${error instanceof Error ? error.message : String(error)}`); }
        rmSync(marker, { force: true });
      });
      removeWorktree(root, path);
    },
    fail: () => { if (!gitStatus(path)) removeWorktree(root, path); },
  };
}

function gitRoot(cwd: string): string | undefined { try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return undefined; } }
function gitStatus(cwd: string): string { try { return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, encoding: "utf8" }).trim(); } catch { return ""; } }
function removeWorktree(root: string, path: string): void { try { execFileSync("git", ["worktree", "remove", path, "--force"], { cwd: root, stdio: "ignore" }); } catch { try { rmSync(path, { recursive: true, force: true }); } catch {} } }
function safe(id: string): string { return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100); }

async function withWorkspaceLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = workspaceLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => current);
  workspaceLocks.set(key, queued);
  await previous;
  try { return await fn(); } finally { release(); if (workspaceLocks.get(key) === queued) workspaceLocks.delete(key); }
}
