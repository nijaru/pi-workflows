# pi-workflows

Durable, inspectable multi-agent orchestration for Pi. A workflow is a small JavaScript plan that calls Pi agents sequentially, in parallel, or through pipeline stages.

```bash
pi install git:github.com/nijaru/pi-workflows
```

## Positioning

Pi-workflows is an orchestration kernel, not a replacement for Codex Desktop or Claude Code. Codex and Claude provide a broader product surface—desktop review panes, cloud tasks, connectors, memories, MCP/plugin ecosystems, and scheduling. Pi already owns the terminal, tools, skills, and model configuration. This extension focuses on the part Pi does not provide by itself:

- durable cross-session run state and resumable checkpoints;
- bounded fan-out with real Pi token/cost accounting;
- resumable per-call journals and fingerprints;
- explicit pause, resume, cancellation, and status inspection;
- provider-neutral child sessions using the active Pi registry.

It deliberately does **not** try to reproduce desktop review UX, browser/computer use, cloud execution, or a shared agent-team mailbox.

**Closest product analogue:** this is Pi's local counterpart to Claude Code Dynamic Workflows: the model writes a JavaScript orchestration plan, the runtime executes it in the background, intermediate results stay in the run, and the plan can be saved and resumed. Claude still has the richer workflow UX, nested workflow composition, and larger scale (up to 16 concurrent / 1,000 total agents). Codex Desktop has a different center of gravity—parallel threads, worktrees, cloud tasks, and review—while Codex CLI is primarily a scriptable agent runner; no public Codex JavaScript workflow primitive is assumed here.

**Pi package composition:** `pi-subagents` is the small-grain worker dispatcher (named Markdown agents, fresh subprocesses, tool/model restrictions, single/parallel/chain). `pi-workflows` is the durable program-level orchestration layer (dynamic JavaScript, pipelines, journals, budgets, resume, status). `pi-goal` is the outer completion policy (session-scoped objective, repeated turns, evidence gate, USD/turn limits). They form a useful architecture—`pi-goal → pi-workflows → pi-subagents`—but are not directly wired today: workflows currently call Pi SDK sessions, while `pi-subagents` launches named child processes. Keep them separate; goal decides *when done*, workflow decides *what graph runs*, and subagents provide *who performs a focused task*. An optional subagent-backed workflow adapter would add process isolation, but should be a deliberate backend choice rather than a merged API.

## Quick start

Ask Pi:

```text
Use a workflow to audit every API endpoint under src/routes/ for missing auth checks.
```

Or provide a script directly:

```js
export const meta = {
  name: "endpoint-audit",
  description: "Audit route handlers for missing authentication",
  phases: [{ title: "audit" }]
};

const files = ["src/routes/users.ts", "src/routes/admin.ts"];
const findings = await parallel(
  files.map(file => () => agent(`Audit ${file} for missing auth checks`, { label: file, effect: "read" }))
);
return findings;
```

Workflows run in the background by default. The tool returns a `runId`; use `workflow_status` with that ID for progress and results.

## Runtime contract

| Feature | Behavior |
|---------|----------|
| Agents | `agent(prompt, opts)` fails the workflow on agent failure; failures are never silently returned as success. |
| Structured outputs | Pass `output: { schema, maxRetries? }` for provider-neutral JSON Schema validation. Read-only calls retry validation failures at most twice by default; write calls never retry automatically. The parsed JSON value is returned and journaled. |
| Effects | Agent calls default to `effect: "write"`; concurrent canonical writes (within or across runs) require `isolation: "worktree"`. `effect: "read"` uses the built-in read-only tool allowlist for safe fan-out. |
| Parallelism | `parallel()` and `pipeline()` drain all siblings before propagating a failure. Maximum 8 active child sessions and 100 calls/items. |
| Budgets | `tokenBudget` is an admission/output allowance with conservative reservations and post-call reconciliation. Provider input/system tokens can vary, so it is a safety ceiling, not an exact billing quote. |
| Resume | Results are reused only when script, args, execution policy, active model identity, and tier configuration match. Resume is at-least-once around external side effects. |
| State | Checkpoints live under `.pi/workflows/<runId>/` with restrictive permissions, atomic metadata/results and marker files, append-only journals, and a filesystem lock. Background execution itself lives in the Pi process; restart requires explicit resume. |
| Failure states | Runs are `completed`, `error`, `paused`, `cancelled`, `orphaned`, or `running`; status includes per-agent progress and token usage. An orphaned run had a dead coordinator and can be explicitly resumed. |
| Isolation | `isolation: "worktree"` fails closed, preserves the caller's subdirectory, ignores workflow-managed `.pi` state when checking for user changes, and refuses dirty-main merges or conflicts. A Git worktree is not an OS security boundary. |
| Sandbox | Workflow code runs in a null-prototype VM with string/wasm code generation disabled and host capabilities bridged through JSON-safe values. Treat workflows as trusted plans; use OS/container isolation for hostile code. |
| Limits | Scripts are capped at 512 KiB, synchronous VM segments at 30 minutes, and quality helpers at bounded reviewer/round counts. |

The VM is intentionally a small capability surface: `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `cwd`, `budget`, `verify`, `judgePanel`, `loopUntilDry`, and `completenessCheck`. The built-in worker backend uses one fresh Pi SDK session per call. Child sessions reuse Pi's auth, model registry, skills, and context discovery, but deliberately do not load extension factories again; this prevents unrelated extension initialization and recursive workflow registration in every leaf. Parent extension hooks (including permission gates) are therefore not automatically inherited by child sessions. Workers are instructed to remain leaf workers; read-effect workers cannot spawn processes, while write-effect workers retain `bash` and could manually launch an arbitrary nested `pi`/agent process. Such nested processes are outside workflow budgets, journals, cancellation, and merge attribution, so nested orchestration should be expressed at the workflow level instead. `agent()` accepts `effect: "read" | "write"` and `output: { schema, maxRetries? }`; read calls receive `read`, `grep`, `find`, and `ls`, while write calls receive the full coding tool set. Output schemas are provider-neutral JSON Schema subsets and parsed values cross the VM bridge as JSON data. Direct filesystem, shell, process, `require`, `Bun`, `Deno`, and dynamic code generation are unavailable inside the workflow realm.

## Commands

| Command | Description |
|---------|-------------|
| `/workflows list` | List saved workflows and recent runs. |
| `/workflows save <name>` | Save the most recent workflow tool call as a project command. Names are restricted to safe identifiers. |
| `/workflows run <name>` | Run a saved workflow in the background. |
| `/workflows pause <runId>` | Pause at the next workflow/agent boundary. |
| `/workflows resume <runId>` | Resume a paused or failed run using its persisted script, args, and policy. |
| `/workflows clean [days]` | Remove old completed, failed, or cancelled runs; paused/running/orphaned runs are preserved. |

Tools:

- `workflow`: execute or dry-run a script;
- `workflow_status`: inspect a run by ID or find the latest run by workflow name.

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `background` | `true` | Detach execution; set `false` to wait for completion. |
| `tokenBudget` | unlimited | Conservative token admission/output budget. |
| `maxAgents` | `100` | Maximum child calls for a run. |
| `runId` | generated | Explicit run to resume. |
| `timeoutMs` | 30 minutes | Best-effort timeout for synchronous VM segments; it does not replace provider/session cancellation. |
| `resume` | `true` | Reuse the newest matching incomplete run. |
| `forceResume` | `false` | With an explicit `runId`, retry `error`/`cancelled` runs; automatic matching may adopt orphaned runs. |
| `dryRun` | `false` | Parse and validate without executing child agents. |

## Model routing

Child sessions use the parent Pi model registry, auth storage, working directory, skills, context files, and current model. Extension factories are intentionally excluded from child discovery—not merely for startup cost, but to prevent repeated initialization, provider/tool hooks, UI/background work, and recursive orchestration in every leaf. The active worker tool allowlist is explicit; unlisted extension tools such as `web_search`, MCP, and `subagent` are unavailable. Use workflow effects, worktree isolation, and OS/container policy when a protection must apply to worker writes. Per-call `model`, phase models, workflow `meta.model`, and optional `~/.pi/workflows/model-tiers.json` routing are supported. Explicit models must use `provider/id` and must exist in the active registry.

Web research is useful for some workflows, but `pi-web-access` is not loaded wholesale into workers. Its tools can make additional provider/LLM calls, use network and credentials, open a curator, start background fetches, clone repositories, and write PDFs/results outside the workflow journal. For now, research in the parent session and pass bounded results to leaf workers. A future curated research capability would need explicit read-only effects, network/byte/time limits, cancellation, and usage accounting; silently inheriting the extension would not provide those guarantees.

## Design boundary

Codex CLI/Desktop and Claude Code expose agent handles, richer live event streams, worktree handoffs, teams/dependencies, hooks, MCP, and cloud/scheduled execution. Those are useful future integrations, but adding them all here would make the extension over-engineered. This package persists checkpoints; it is not a daemon or crash-proof job supervisor. The ideal Pi feature is a reliable local job runner with stable IDs, observable task state, safe resume semantics, and a small composable API—not another full coding-agent product.

## Development

```bash
bun install --frozen-lockfile
bun test
bun x tsc --noEmit
```

MIT License.
