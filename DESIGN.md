# pi-workflows

Model writes a JS orchestration script. Runtime executes it.

## Why

Script-as-plan is the SOTA pattern everyone converged on:
- Claude Code dynamic workflows (GA June 2026) — model writes JS, runtime executes
- Codex multi-agent (spawn_agent/wait_agent tools) — model orchestrates turn-by-turn
- RLM — model writes orchestration code, executes in loop
- Workflow-R1 — multi-turn script generation beats one-shot prompting

Pi's current agent loop is turn-by-turn. Workflows let the model express multi-step plans upfront, then the runtime executes them with proper journaling, cost tracking, and parallelism.

## How We Compare

| Feature | Claude Code | Codex | pi-workflows |
|---------|-------------|-------|--------------|
| Orchestration | Script-as-plan (JS runtime) | Tool calls (spawn/wait) | Script-as-plan |
| Max agents | 1,000 | N/A (session-scoped) | 1,000 |
| Concurrency | 16 (auto-scaled) | 16 default, 64 max | 16 |
| Journal resume | ✅ Within session | ❌ | ✅ JSONL |
| Model routing | User prose ("use smaller model") | `model` per spawn | ✅ Tiers + taskType |
| Worktree isolation | ❌ | ❌ | ✅ `isolation: "worktree"` |
| Per-phase budget | ❌ | ❌ | ✅ `phase('name', {budget})` |
| Approval gate | ✅ Show phases, Ctrl+G to edit | N/A | ✅ Via reference |
| Save as command | ✅ `/workflows save` | ❌ | ✅ Via reference |
| Bundled workflows | `/deep-research` | ❌ | Extensible |

## Core API

```js
// Run a task with an agent
const result = await agent("Search the codebase for auth patterns", {
  model: "small",        // or "medium", "big", or explicit provider/model
  label: "code-search",  // short label for status display
});

// Run tasks in parallel
const [a, b] = await parallel([
  () => agent("Analyze frontend code", { label: "frontend" }),
  () => agent("Analyze backend code", { label: "backend" }),
]);

// Sequential pipeline — each item flows through stages independently
const results = await pipeline(files,
  (file) => agent(`Read ${file}`, { label: "read" }),
  (summary, file) => agent(`Summarize ${file}: ${summary}`, { label: "summarize" }),
);
```

Three functions. Everything else is internal.

## Model Routing

| Tier | Maps to | Use for |
|------|---------|---------|
| `small` | flash model | Exploration, reading, searching |
| `medium` | primary model | Default for most tasks |
| `big` | pro model | Architecture, complex reasoning |

Each `agent()` call accepts:
- `tier`: "small", "medium", or "big" — maps to configured models via `~/.pi/workflows/model-tiers.json`
- `model`: Full `provider/id` string (e.g., "openrouter/deepseek/deepseek-v4-flash") — overrides tier
- `taskType`: Keyword classifier that maps to a tier automatically

Priority: explicit `model` > per-phase model > tier-based default.

### Task-Type Routing

agent() accepts a `taskType` parameter that routes to the appropriate model:

| Task Type | Description | Default Tier |
|-----------|-------------|--------------|
| `simple` | Text generation, summarization | small |
| `code` | Code generation, refactoring | medium |
| `reasoning` | Complex analysis, architecture | big |
| `search` | Codebase exploration | small |
| `review` | Code review, critique | big |
| `implement` | Feature implementation | medium |

```js
const result = await agent("Search for auth patterns", { taskType: "search" });
```

Classifier is keyword-based (no deps, fast). If no taskType or model specified, defaults to `medium`.

### Per-Phase Model Override

Phases can declare their own model in `meta.phases`:

```js
export const meta = {
  name: "audit",
  description: "Security audit",
  phases: [
    { title: "Scan", model: "small" },
    { title: "Analyze", model: "big" },
  ]
};
```

Agents inherit their phase's model unless they set one explicitly.

## Journal Resume

Every step writes to `.pi/workflows/<run-id>/journal.jsonl`:

```jsonl
{"index":0,"hash":"abc123","result":"...","tokens":{"input":1200,"output":400,"total":1600,"cost":0.003},"durationMs":2300}
{"index":1,"hash":"def456","result":"...","tokens":{"input":800,"output":300,"total":1100,"cost":0.002},"durationMs":1800}
```

Resume uses longest-unchanged-prefix: replay cached results while the script prefix is intact. Once a call's hash changes (script edit), that call and everything after runs live.

## Cost Budgets

Hard cost cap per workflow run:

```js
const result = await agent("Do expensive analysis", {
  budget: 0.50,  // stop if cost exceeds $0.50
});
```

Budget tracking uses real token counts. When budget is hit, the call fails with a budget-exceeded error.

**Per-phase sub-budgets:**

```js
phase("Deep analysis", { budget: 10000 });  // 10k tokens for this phase
try {
  await agent("...", { label: "analysis" });
} catch (e) {
  // Phase budget exceeded, continue to next phase
}
```

## Worktree Isolation

For parallel tasks that modify files:

```js
const [a, b] = await parallel([
  () => agent("Refactor auth module", { isolation: "worktree" }),
  () => agent("Update API routes", { isolation: "worktree" }),
]);
```

Each worktree agent gets its own git worktree. Results applied back sequentially. Opt-in, not default.

## Quality Helpers

Built-in patterns for common workflows:

```js
// Adversarial verification
const { real } = await verify("The API handles all edge cases", { reviewers: 3 });

// Judge panel - score candidates
const best = await judgePanel([candidate1, candidate2], { rubric: "correctness and readability" });

// Loop until no new items
const findings = await loopUntilDry({
  round: (i) => agent(`Find issue #${i + 1}`, { label: "search" }),
});

// Completeness check
const { missing } = await completenessCheck(args, results);
```

## Harness Patterns

### Planner/Generator/Evaluator

```js
const plan = await agent("Create a plan for adding auth", { model: "big", label: "planner" });
const impl = await agent(`Implement: ${plan}`, { model: "medium", label: "generator" });
const review = await agent(`Review: ${impl}`, { model: "big", label: "evaluator" });
```

### Sprint Contracts

```js
const tasks = await agent("Break this into 3-5 tasks", { model: "big", label: "planner" });
for (const task of parseTasks(tasks)) {
  const result = await agent(`Implement: ${task.description}`, { label: `impl-${task.id}` });
  const verified = await agent(`Verify: ${result}`, { model: "medium", label: `verify-${task.id}` });
}
```

### Adversarial Evaluation

```js
const work = await agent("Implement the feature", { label: "builder" });
const critique = await agent("Find bugs in this code", { model: "big", label: "critic" });
```

## Background Execution

Workflows run in background by default:

```js
const result = await agent("Long running task", { background: true });
```

TUI panel shows: workflow status, current step, token usage, cost.

## Save as Command

```
/workflows save refactor-auth "Refactor auth module using the auth patterns guide"
```

Saved workflows become slash commands. Model generates a fresh script each time.

## Determinism

Workflow scripts run in a sandboxed VM with:
- `Math.random()` disabled (breaks resume)
- `Date.now()` / `new Date()` disabled (breaks resume)
- Deterministic call ordering via lexical `callSeq`

Pass timestamps or random seeds via `args` if needed.

## Implementation

### Architecture

```
extensions/pi-workflows/
├── index.ts          # Extension entry, registers tool
└── modules.d.ts      # Ambient type declarations

Dependencies:
└── @quintinshaw/pi-dynamic-workflows  # Runtime engine
```

### Extension Entry Point

The extension:
1. Loads `@quintinshaw/pi-dynamic-workflows` at runtime
2. Creates a `WorkflowTool` with `createWorkflowTool()`
3. Registers TUI components (task panel, result delivery)
4. Activates the tool on session start

### Runtime Engine

The reference implementation (`@quintinshaw/pi-dynamic-workflows`) provides:
- `WorkflowAgent` — creates agent sessions, handles model resolution
- `runWorkflow()` — VM sandbox, journal, concurrency limiter
- `WorkflowManager` — background runs, pause/resume
- `createWorkflowStorage()` — saved workflows
- TUI integration — progress panel, /workflows command

Our extension delegates to these rather than reimplementing them.

### What We Add

| Feature | Status |
|---------|--------|
| Tier routing (small/medium/big) | ✅ Via reference |
| Task-type classifier | ✅ Via reference |
| Worktree isolation | ✅ Via reference |
| Per-phase budget | ✅ Via reference |
| Quality helpers (verify, judgePanel, etc.) | ✅ Via reference |
| Journal resume | ✅ Via reference |
| TUI integration | ✅ Via reference |
