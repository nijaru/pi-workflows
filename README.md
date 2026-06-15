# pi-workflows

Script-as-plan orchestration for pi. Model writes JS, runtime executes.

## Installation

```bash
bun install
```

## Usage

The extension registers a `workflow` tool that accepts a JavaScript workflow script:

```javascript
// Workflow script format
export const meta = {
  name: "my_workflow",
  description: "What this workflow does",
  phases: [{ title: "Phase 1" }, { title: "Phase 2" }]
};

// Available globals: agent(), parallel(), pipeline(), log(), phase(), args, budget
const result = await agent("Search the codebase for auth patterns", {
  label: "code-search",
  tier: "small"  // or "medium", "big"
});

const [a, b] = await parallel([
  () => agent("Analyze frontend", { label: "frontend" }),
  () => agent("Analyze backend", { label: "backend" }),
]);
```

## Core API

### `agent(prompt, options)`
Run a task with an agent. Options:
- `label`: Short label for status display
- `model`: Explicit model override (`provider/modelId`)
- `tier`: Model tier (`small`, `medium`, `big`)
- `taskType`: Task classifier (`simple`, `code`, `reasoning`, `search`, `review`, `implement`)
- `phase`: Assign to a workflow phase
- `budget`: Per-agent token budget

### `parallel(thunks)`
Run an array of functions concurrently:
```javascript
const [a, b] = await parallel([
  () => agent("Task 1", { label: "t1" }),
  () => agent("Task 2", { label: "t2" }),
]);
```

### `pipeline(items, ...stages)`
Sequential processing pipeline:
```javascript
const results = await pipeline(files,
  (file) => agent(`Read ${file}`, { label: "read" }),
  (content) => agent(`Summarize: ${content}`, { label: "summarize" }),
);
```

## Model Tiers

| Tier | Use for |
|------|---------|
| `small` | Exploration, reading, searching |
| `medium` | Default, code generation |
| `big` | Architecture, complex reasoning |

## Testing

```bash
bun test
```

## Architecture

- Single extension entry: `extensions/pi-workflows/index.ts`
- Journal persistence: `.pi/workflows/<run-id>/journal.jsonl`
- Deterministic resume via SHA-256 call hashing
- VM sandbox with determinism guards (no Math.random/Date.now)

## Design

See [DESIGN.md](DESIGN.md) for the full API design and implementation notes.
