# pi-workflows

Script-as-plan orchestration for pi. Model writes JS, runtime executes in a sandboxed VM.

## Architecture

- Single extension: `index.ts` (~1330 lines)
- Journal: `.pi/workflows/<run-id>/journal.jsonl`
- Three core functions: agent(), parallel(), pipeline()
- Quality helpers: verify(), judgePanel(), loopUntilDry(), completenessCheck()
- Model tier routing (small/medium/big) with task-type classifier
- Worktree isolation with conflict-safe merge-back
- Phase budgets with per-phase token caps
- Background by default, blocking with `background: false`
- `dryRun` parameter for preview without execution (validates syntax)
- In-session pause/resume via pause marker file
- `workflow_status` tool for checking background run progress
- `/workflows clean` command to prune old run directories
- Syntax errors enriched with line:column context and code snippet

## Stack

- TypeScript, Bun
- Pi extension API (`@earendil-works/pi-coding-agent`)
- Pi TUI (`@earendil-works/pi-tui`)
- Pi AI types (`@earendil-works/pi-ai`)
- `@sinclair/typebox` for parameter schemas

## Testing

```bash
bun test
```

## SDK Usage

Agent execution uses pi's core SDK directly:

```typescript
const sdk = await import("@earendil-works/pi-coding-agent");
const auth = sdk.AuthStorage.create(join(agentDir, "auth.json"));
const registry = sdk.ModelRegistry.create(auth, join(agentDir, "models.json"));

const { session } = await sdk.createAgentSession({
  cwd, agentDir,
  sessionManager: sdk.SessionManager.inMemory(),
  settingsManager: sdk.SettingsManager.create(cwd, agentDir),
  customTools: sdk.createCodingTools(cwd),
  model, // resolved via ModelRegistry
});

await session.prompt(text);
const text = extractAssistantText(session.messages); // iterate backwards for last assistant msg
const stats = session.getSessionStats(); // { tokens: { input, output, total }, cost }
session.dispose();
```

- Auth + registry are singletons (created once per process via `loadSdk()` / `getAuthAndRegistry()`)
- `session.prompt()` returns void — extract response from `session.messages`
- `session.getSessionStats().cost` can be `undefined`/`NaN` for free models — default to `0`

## Sandbox Rules

The VM sandbox exposes only: `agent`, `parallel`, `pipeline`, `log`, `phase`, `verify`, `judgePanel`, `loopUntilDry`, `completenessCheck`, `args`, `cwd`, `budget`.

**Blocked:**
- `process` (except via host `process.cwd()`/`process.env`)
- `console` (use `log()` instead)
- `Math.random()` — throws
- `Date.now()` — throws
- `new Date()` with no args — throws
- `eval()` — not in scope

**Allowed:**
- `new Date("2024-01-01")`, `new Date(0)`, `Date.UTC()`, `Date.parse()`
- All standard JS except the above

## Key Gotchas

- **Abort handling:** Background catch checks `signal?.aborted || error === "Workflow aborted"` — abort is deliberate cancellation, not failure. No `error.log` written, notifies as info.
- **Cost reporting:** Default `stats.cost` to `0` for free models. Budget is token-based (unaffected).
- **Resume scanning:** `listWorkflowRuns()` scans by workflow name. Multiple incomplete runs for the same name is unlikely but possible — picks first match.
- **Worktree merge:** Cherry-pick with `-X theirs` fallback, then `git merge` fallback. Conflicts are logged, not fatal.
- **Determinism prelude:** `Date` constructor wrapper uses `new _D(...a)`, not `Reflect.construct`.

## Commands

| Command | Description |
|---------|-------------|
| `/workflows list` | Show recent runs and saved commands |
| `/workflows save <name>` | Save last workflow as reusable command |
| `/workflows pause <runId>` | Pause running workflow (resume by running again) |
| `/workflows clean [days]` | Remove completed/errored runs older than N days (default: 7) |

## Tool Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `script` | required | JS workflow script with `export const meta = { name, description }` |
| `args` | undefined | JSON value exposed as `args` global |
| `background` | true | Run in background (false to block) |
| `tokenBudget` | unlimited | Hard token cap |
| `maxAgents` | 1000 | Max agent calls |
| `resume` | true | Resume from last incomplete run of same name |
| `forceResume` | false | Retry a run that previously errored |
| `dryRun` | false | Validate and preview without executing |

## workflow_status Tool

Call after a background `workflow()` to check progress:

- Accepts `runId` (from workflow result) or `workflow` (name filter)
- Returns: status, agent count, token usage, error message, completion result
- Defaults to most recent run if neither parameter provided

## Key Patterns

- Script-as-plan: model writes JS, runtime executes in VM sandbox
- Journal resume: SHA-256 call hashing, crash-safe event log
- Task-type routing: keyword classifier, no deps
- Worktrees: git isolation for parallel edits with cherry-pick merge
- Adversarial evaluation: different agents for execution vs review
- Tier-based model routing: `~/.pi/workflows/model-tiers.json` config
