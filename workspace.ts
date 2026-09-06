import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { AgentTaskSpec } from "./plan";
import { RunStore, type NodeRecord, type RunState } from "./store";

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
      await publishWorktreeCommit(root, store, spec, path, commit);
      removeWorktree(root, path);
    },
    fail: () => { if (!gitStatus(path)) removeWorktree(root, path); },
  };
}

/** Publish a worktree commit into the canonical checkout under the merge lock. */
async function publishWorktreeCommit(root: string, store: RunStore, spec: AgentTaskSpec, path: string, commit: string): Promise<void> {
  await withWorkspaceLock(root, async () => {
    if (gitStatus(root)) throw new Error(`Cannot merge workflow worktree: canonical checkout is dirty`);
    // The marker makes the crash window (write → cherry-pick → rm) recoverable.
    store.writePendingMerge({ nodeId: spec.id, path, commit });
    try { execFileSync("git", ["cherry-pick", commit], { cwd: root, stdio: "ignore" }); }
    catch (error) { throw new Error(`Workflow worktree merge conflict for ${spec.id}; preserved at ${path}: ${error instanceof Error ? error.message : String(error)}`); }
    store.clearPendingMerge();
  });
}

/**
 * Complete or clear every interrupted worktree effect recorded for this run
 * before the scheduler resumes. Each step is idempotent so a crash during
 * recovery itself converges on the next call.
 */
export async function reconcileRunWorkspaces(cwd: string, store: RunStore, state: RunState): Promise<void> {
  const root = gitRoot(resolve(cwd));
  if (!root) return;
  await withWorkspaceLock(root, async () => {
    // 1. Merge markers written before an interrupted cherry-pick.
    const pending = readPendingMerge(store);
    if (pending) {
      if (!commitApplied(root, pending.commit)) {
        try {
          if (gitStatus(root) && !cherryPickInProgress(root)) throw new Error(`Pending workflow merge for ${pending.nodeId} blocked by a dirty canonical checkout`);
          execFileSync("git", ["cherry-pick", pending.commit], { cwd: root, stdio: "ignore" });
          store.clearPendingMerge();
        } catch (error) {
          // A conflicted pick is abandoned (conflicts stay in the worktree); a blocked pick is retried on the next resume.
          if (cherryPickInProgress(root)) { abortCherryPick(root); store.clearPendingMerge(); }
          else throw error;
        }
      } else store.clearPendingMerge();
    }
    // 2. Orphaned worktrees from nodes whose process died mid-run: adopt and
    //    reset them so the retried node starts from the recorded base.
    for (const node of Object.values(state.nodes)) {
      if (!node.worktreePath || !existsSync(node.worktreePath)) continue;
      if (node.status !== "running" && node.status !== "ready") continue;
      if (gitStatus(node.worktreePath)) throw new Error(`Orphaned workflow worktree ${node.worktreePath} has uncommitted changes; inspect it before resuming`);
      execFileSync("git", ["worktree", "remove", node.worktreePath, "--force"], { cwd: root, stdio: "ignore" });
    }
    // 3. Worktrees left behind after their merge already succeeded.
    for (const entry of readdirWorktrees(root)) {
      if (entry.startsWith(`${store.runId}-`)) {
        const path = join(root, ".pi", "worktrees", entry);
        if (!gitStatus(path)) removeWorktree(root, path);
      }
    }
  });
}

function readPendingMerge(store: RunStore) { try { return store.readPendingMerge(); } catch { return undefined; } }

/** `git cherry` patch-equivalence: true when HEAD already contains the commit's change. */
function commitApplied(root: string, commit: string): boolean {
  try {
    // "-" marks commits patch-equivalent to something in HEAD. An unborn HEAD
    // cannot contain the merge, and the error is folded to "not applied".
    const out = execFileSync("git", ["cherry", "HEAD", commit], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out.startsWith("-");
  } catch { return false; }
}

function cherryPickInProgress(root: string): boolean { return existsSync(join(root, ".git", "CHERRY_PICK_HEAD")) || existsSync(join(root, ".git", "sequencer")); }

function abortCherryPick(root: string): void { try { execFileSync("git", ["cherry-pick", "--abort"], { cwd: root, stdio: "ignore" }); } catch {} }

function readdirWorktrees(root: string): string[] { try { return readdirSync(join(root, ".pi", "worktrees")); } catch { return []; } }

function gitRoot(cwd: string): string | undefined { try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return undefined; } }
function gitStatus(cwd: string): string {
  // Workflow-managed .pi/ directories (worktrees, run stores) are runtime
  // state; they must not make the canonical checkout look dirty.
  try {
    return execFileSync("git", ["status", "--porcelain", "--untracked-files=all", ":!.pi"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    try { return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { return ""; }
  }
}
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
