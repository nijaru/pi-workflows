# Review: pi-workflows Round 3

## Build & Tests

```
bun test v1.3.14 (0d9b296a)
  5 pass, 0 fail, 12 expect() calls
  Ran 5 tests across 1 file. [91.00ms]
```

Tests pass. Coverage is minimal — only `parseScript` and exports are tested. No tests for resume, agent execution, tool registration, or error paths.

## Findings

### P0 — Worktree merge conflict silently loses all changes

`extensions/pi-workflows/index.ts:486-492`

After `git cherry-pick --abort`, the working tree is reverted to its pre-cherry-pick state. `git checkout --theirs .` operates on the index/working tree, but there are no conflicted files after abort — it updates 0 paths. The `git add -A` stages nothing. The worktree changes are silently lost.

Verified with a real git test:
```
$ git cherry-pick <hash> --no-edit   # CONFLICT
$ git cherry-pick --abort            # clean state, no conflicts remain
$ git checkout --theirs .            # "Updated 0 paths from the index"
```

**Fix:** Replace the entire conflict handler with a single command that auto-resolves:
```typescript
try {
  execSync(`git cherry-pick ${commitHash} --no-edit -X theirs`, { cwd, stdio: "ignore" });
} catch (cherryPickErr) {
  // Only abort if -X theirs also fails (e.g., delete/modify conflicts)
  try {
    execSync(`git cherry-pick --abort`, { cwd, stdio: "ignore" });
    execSync(`git merge --no-edit -X theirs ${commitHash}`, { cwd, stdio: "ignore" });
  } catch {}
  log(`worktree merge for "${label}": merged with conflict resolution`);
}
```

### P1 — `execute()` doesn't accept framework abort signal

`extensions/pi-workflows/index.ts:746`

Pi's `ToolDefinition.execute` signature is:
```typescript
execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult>
```

The workflow tool only accepts `(id, params)` — `signal` is silently dropped. Blocking workflows (`background: false`) cannot be cancelled by the framework. `executeWorkflow` already supports `signal` in its options but never receives it.

**Fix:**
```typescript
async execute(_id: string, params: { ... }, signal?: AbortSignal) {
  // ...
  executeWorkflow(script, { ..., signal })
}
```

### P1 — `agentCount` not incremented for cached/resume agents

`extensions/pi-workflows/index.ts:428-433`

Resume check returns at line 433 *before* `shared.agentCount++` at line 436. The completion message says "0 agent(s)" for fully-resumed workflows.

Existing run data confirms: `complete.log` shows `agentCount: 0` with 2 journal entries and non-zero `tokenUsage`.

**Fix:** Increment before the resume check, or track separately:
```typescript
const callIndex = state.callSeq++;
shared.agentCount++;  // moved before resume check
const callHash = hashCall(prompt, { ...opts, model: model ?? opts.model }, assignedPhase);
const cached = options.resumeJournal?.get(callIndex);
if (cached?.hash === callHash && callIndex < state.firstMiss) {
  // ... replay from cache
  return cached.result as string;
}
```

### P2 — `renderResult` ignores `context.isError`, always shows success

`extensions/pi-workflows/index.ts:732-743`

Pi's `ToolDefinition.renderResult` passes a 4th `context` parameter with `context.isError` for error detection. pi-workflows only accepts 3 params `(r, _, theme)` and always renders `theme.fg("success", "✓ ")`. Errors from `parseScript` or workflow failures display as successes in the TUI.

Built-in pi tools (read, write) use `context.isError` to switch rendering:
```typescript
// pi's write tool
renderResult(result, _options, theme, context) {
  const output = formatWriteResult({ ...result, isError: context.isError }, theme);
}
```

**Fix:** Accept and use the context parameter:
```typescript
renderResult(r: AgentToolResult<any>, options: ToolRenderResultOptions, theme: Theme, context: ToolRenderContext) {
  const prefix = context.isError ? theme.fg("error", "✗ ") : theme.fg("success", "✓ ");
  // ...
}
```

### P2 — `renderCall` missing `context` parameter (component reuse)

`extensions/pi-workflows/index.ts:720-729`

Same issue: `renderCall(args, theme)` is missing the 3rd `context` parameter. Without `context.lastComponent`, a new `Text` is created on every call. Pi's built-in tools reuse the previous component for efficient re-rendering.

### P2 — `require("node:fs").readdirSync` in ESM module

`extensions/pi-workflows/index.ts:842, 855, 881`

`readdirSync` is called via `require("node:fs")` three times. The module already imports from `"node:fs"` but omits `readdirSync`. Works in Bun, would fail in Node.js ESM.

**Fix:** Add `readdirSync` to the existing import:
```typescript
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
```

### P2 — `err` helper is dead code

`extensions/pi-workflows/index.ts:677`

```typescript
const err = (text: string) => ok(text, {});
```

Never called. If it were used, it would return the same shape as `ok` — no `isError: true` flag. Pi's framework determines error status from whether `execute()` throws, not from the return value. The helper is misleading.

### P2 — `parseScript` errors unhandled in `execute()`

`extensions/pi-workflows/index.ts:748`

`const { meta } = parseScript(script)` can throw on invalid scripts. The error propagates as an unhandled exception. Per pi's `AgentTool` contract ("throw on failure"), this is correct behavior. But having the `ok`/`err` helpers suggests intent to handle errors gracefully. Either catch and format, or remove the helpers and document the throw-on-failure contract.

### P2 — Resume permanently skips runs with `error.log`

`extensions/pi-workflows/index.ts:756`

`r.status !== "error"` means transient failures (network timeout, model rate limit) permanently block resume for that run. No way to retry without `resume: false` or manual `error.log` deletion. Consider checking error age or providing a `--force-resume` option.

### P2 — `runAgent` recreates AuthStorage/ModelRegistry per call

`extensions/pi-workflows/index.ts:287-295`

Every `agent()` call creates new `AuthStorage.create()` and `ModelRegistry.create()` instances. These likely read from disk each time. For workflows with many agent calls, this adds unnecessary I/O. Should be created once per workflow execution and passed through.

### P3 — Unused code

- `VERIFY_SCHEMA` (line 563) — declared, never used
- `saveCommand` function (line 867) — defined, never called; `/workflows save` is a stub
- `journalPath` variable (line 885) — declared, never read

### P3 — `/workflows` command handler untyped

`extensions/pi-workflows/index.ts:922`

`handler: async (args, ctx)` — neither `args` nor `ctx` have type annotations. Should match pi's `registerCommand` handler type.

### P3 — Background workflow errors invisible to user

When a background workflow fails, the error is written to `error.log` and `console.error`. No TUI notification. User must run `/workflows` or check the filesystem to discover failures.

## Previously Reported Issues — Status

| Issue | Status |
|-------|--------|
| Round 1: Tier routing dead code | ✓ Fixed |
| Round 1: Per-phase model | ✓ Fixed |
| Round 1: Worktree merge-back | ⚠ P0 remains — conflict handler is a no-op |
| Round 1: Pipeline semantics | ✓ Fixed |
| Round 2: Cherry-pick conflict handling | ⚠ P0 — same issue, handler still broken |
| Round 2: Background error logging | ✓ Fixed (writes error.log + console.error) |
| Round 2: Resume hash missing phase | ✓ Fixed — `hashCall` includes `phase` |
| Round 2: Silent catches | ⚠ P2 — some silent catches remain intentional (journal), worktree catch masks data loss |
| Round 2: Proper pi SDK types | ✓ Partially — `Type.Object` used, `Text` imported, but `execute`/`renderResult` signatures don't match SDK |

## Summary

**Don't ship** until P0 worktree conflict handler is fixed — it silently loses agent file changes on any merge conflict. The fix is a one-line replacement (`-X theirs` flag on cherry-pick). P1 abort signal gap means blocking workflows can't be cancelled, which matters for user experience. The `agentCount` bug is cosmetic but misleading.

Recommended fix order:
1. Worktree conflict handler (P0 — data loss)
2. Wire `signal` into `execute()` (P1 — uncancellable)
3. Increment `agentCount` before resume check (P1 — misleading metrics)
4. Add `readdirSync` to import, fix render signatures (P2)
