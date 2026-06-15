# pi-workflows

Model writes a JS orchestration script. Runtime executes it.

## Why

Script-as-plan is the SOTA pattern everyone converged on:
- Claude Code dynamic workflows (GA June 2026) — model writes JS, runtime executes
- RLM — model writes orchestration code, executes in loop
- Workflow-R1 — multi-turn script generation beats one-shot prompting

Pi's current agent loop is turn-by-turn. Workflows let the model express multi-step plans upfront, then the runtime executes them with proper journaling, cost tracking, and parallelism.

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

// Sequential pipeline — each step gets previous result
const final = await pipeline(files,
  (file) => agent(`Read and summarize ${file}`, { label: "read" }),
  (summaries) => agent(`Synthesize: ${summaries.join("\n")}`, { label: "synth" }),
);
```

Three functions. Everything else is internal.

## Model Routing

| Tier | Maps to | Use for |
|------|---------|---------|
| `small` | flash model | Exploration, reading, searching |
| `medium` | primary model | Default for most tasks |
| `big` | pro model | Architecture, complex reasoning |

Each `agent()` call accepts a `model` parameter. Default is `medium`.

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

## Journal Resume

Every step writes to `.pi/workflows/<run-id>/journal.jsonl`:

```jsonl
{"type":"start","id":"step-1","task":"Search codebase","model":"small","ts":1718300000}
{"type":"complete","id":"step-1","tokens":{"in":1200,"out":400},"cost":0.003,"duration":2300}
{"type":"start","id":"step-2","task":"Analyze patterns","model":"medium","ts":1718300002}
{"type":"fail","id":"step-2","error":"rate limit","ts":1718300005}
```

If the workflow crashes: read the journal, resume from the failed step. Model can retry, skip, or adjust.

agent() calls return results as values — the script holds them in variables. The journal is for crash resume only.

## Cost Budgets

Hard cost cap per workflow run:

```js
const result = await agent("Do expensive analysis", {
  budget: 0.50,  // stop if cost exceeds $0.50
});
```

Budget tracking uses real token counts. When budget is hit, the call fails with a budget-exceeded error.

**Budget-aware routing:** When budget is low, runtime can auto-downgrade tiers (big → medium → small).

## Worktree Isolation

For parallel tasks that modify files:

```js
const [a, b] = await parallel([
  () => agent("Refactor auth module", { worktree: true }),
  () => agent("Update API routes", { worktree: true }),
]);
```

Each worktree agent gets its own git worktree. Results applied back sequentially. Opt-in, not default.

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

## What This Doesn't Do

- No VM sandbox — model-generated code runs directly
- No AST validation — trust the model, validate at boundaries
- No subagent definitions — that's pi-subagents
- No optimization loops — that's pi-goal

## Implementation Notes

- ~300-400 lines of core logic
- Journal in `.pi/workflows/<run-id>/journal.jsonl`
- Cost tracking from pi's token counts
- Worktree support via git CLI
- TUI panel via pi's widget/panel system
- Model routing via pi's provider config
