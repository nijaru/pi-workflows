# pi-workflows

> **Archived and no longer maintained.** A separate workflow engine did not earn its place in daily use; Pi's native execution and delegation (plus `pi-subagents`) cover the need. The code stays available for reference, including the plan compiler and worktree-effect ideas.

Durable, explicit workflow orchestration for Pi. A workflow script **builds a plan first**; Pi then executes that plan through bounded agent lanes.

```bash
pi install git:github.com/nijaru/pi-workflows
```

## Why this exists

Pi's AgentHarness is the right runtime for one durable agent conversation. `pi-workflows` is the control plane above it:

- compiles a JavaScript plan into a validated dependency graph;
- schedules independent agents with bounded concurrency;
- persists run and node state for explicit resume;
- accounts for attempts, tokens, and cost;
- passes structured outputs across dependency edges;
- owns worktree commits and serialized merges.

The extension deliberately does not implement a team mailbox, cloud execution, or a second conversational runtime. Agent execution is behind a backend boundary: the current backend uses Pi's SDK, and a Pi 2 `AgentHarness` backend can be injected when that API is stable.

## Plan syntax

The metadata export must be first, after optional comments:

```js
export const meta = {
  name: "endpoint-audit",
  description: "Audit route handlers and summarize findings"
};

const files = ["src/routes/users.ts", "src/routes/admin.ts"];
const audits = parallel(files.map(file => agent({
  id: `audit:${file}`,
  label: file,
  prompt: `Audit ${file} for missing authentication checks. Return JSON.`,
  effect: "read",
  output: {
    schema: {
      type: "object",
      required: ["file", "findings"]
    }
  }
})));

const summary = agent({
  id: "summary",
  prompt: "Combine the audit results into a prioritized report.",
  needs: audits,
  effect: "read"
});

return summary;
```

`agent()` and `task()` are aliases. Every task requires a stable `id`; execution does not begin while the plan is being compiled. `parallel([...])` documents fan-out. `pipeline([[...], [...]])` adds dependencies from earlier stages to later stages. A dependent task receives predecessor outputs as JSON in its prompt. `meta` accepts `name`, `description`, and an optional default `model` (`provider/id`).

Plans are trusted code running in a restricted VM. They have no direct filesystem, shell, process, network, or dynamic-code-generation access. `Date.now()` and `Math.random()` are unavailable (including aliased access — the VM exposes a `Math` without `random` and a `Date` without `now`). Use OS or container isolation for hostile code.

## Runtime model

```text
workflow tool
    │
    ├── plan compiler ──> immutable WorkflowPlan
    │
    ├── RunStore ───────> run/node state, events, outputs, usage
    │
    ├── scheduler ──────> ready queue, dependencies, budgets, cancellation
    │
    ├── execution backend
    │     ├── pi-sdk (current default)
    │     └── Pi 2 AgentHarness (injected adapter)
    │
    └── workspace effects ──> worktrees, commits, serialized merges
```

The ownership boundary is intentional:

| Concern | Owner |
|---|---|
| Dependency graph and node state | Workflow scheduler/store |
| Transcript, provider calls, tool checkpoints | Pi AgentHarness or SDK backend |
| Token/cost aggregation and output schemas | Workflow scheduler |
| Git worktrees and merge recovery | Workspace effect manager |
| UI and commands | Pi extension entrypoint |

A workflow run is at-least-once around external effects. Write tasks should be idempotent. Concurrent writes to the canonical checkout require `isolation: "worktree"`. Interrupted worktree merges are reconciled on resume: a pending merge is completed (or abandoned on conflict), orphaned worktrees are removed, and already-landed merges are not duplicated.

## Commands and tools

The extension registers `workflow` and `workflow_status` tools plus:

```text
/workflows list
/workflows save <name>
/workflows run <name>
/workflows pause <run-id>
/workflows cancel <run-id>
/workflows resume <run-id>
/workflows clean [days]
```

Runs are stored under `.pi/workflows/<run-id>/`:

- `state.json` — authoritative run and node snapshot;
- `events.jsonl` — status history for inspection;
- `outputs/` — validated node outputs;
- `lease.json` — coordinator lease.

The `workflow` tool accepts `script`, `args` (JSON values exposed to the plan), `background` (default `true`; `false` blocks until completion), `dryRun` (validate the plan without executing), `resume` (default `false`; opt in to attach to a paused or orphaned run of the same plan), `runId`, `tokenBudget`, `maxAgents` (1–100), and `timeoutMs` (per node, 1–30 min).

Resume is explicit: pass `resume: true` or a `runId`, or use `/workflows resume <run-id>`. Resume requires the same plan and execution policy — the policy is frozen at run creation, so a changed session model or omitted options cannot silently alter a resumed run. A stale coordinator lease is recoverable; running nodes are retried at the workflow boundary. Pi 2 integration can later attach and drive open harness operations instead of retrying them.

## Development

```bash
bun install --frozen-lockfile
bun test
bun x tsc --noEmit
```

The project has no backwards-compatibility promise for the pre-plan API. The public contract is the plan compiler, scheduler, backend interface, and Pi tools described above.

MIT License.
