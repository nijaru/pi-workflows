# pi-workflows

Script-as-plan orchestration for pi. Model writes a JS script, runtime executes it with journal-based resume, model tier routing, and real cost tracking.

## Installation

```bash
pi install git:github.com/nijaru/pi-workflows
```

## Usage

The extension registers a `workflow` tool. The model writes a JavaScript orchestration script; the runtime handles agent execution, parallelism, and resume.

```javascript
export const meta = {
  name: "code-review",
  description: "Review code from multiple angles",
  phases: [
    { title: "Scan", model: "small" },
    { title: "Review", model: "big" },
  ]
};

const [frontend, backend] = await parallel([
  () => agent("Review frontend auth", { label: "frontend" }),
  () => agent("Review backend auth", { label: "backend" }),
]);

const summary = await agent(`Synthesize findings: ${frontend}\n${backend}`, { label: "synth" });
```

## API

### `agent(prompt, options)`

Run a task with an agent. Options:
- `label` — short label for status display
- `model` — explicit model (`provider/modelId`)
- `tier` — `small`, `medium`, `big` (maps to configured models)
- `taskType` — `simple`, `code`, `reasoning`, `search`, `review`, `implement`
- `phase` — assign to a workflow phase
- `isolation` — `"worktree"` for git-isolated execution

### `parallel(thunks)`

Run array of functions concurrently. Returns results in order.

### `pipeline(items, ...stages)`

Each item flows through stages sequentially. Stage receives `(previousResult, originalItem, index)`.

### `phase(title, { budget? })`

Start a new phase. Optional `budget` caps token spend for that phase.

### `verify(claim, { reviewers? })`

Adversarial verification. Multiple agents evaluate a claim independently, vote on validity.

### `judgePanel(options)`

Tournament-style judging. Agents compare candidates pairwise using a rubric.

### `loopUntilDry(thunk, { maxRounds? })`

Run agent in a loop until it returns `null`. Each round gets previous results.

### `completenessCheck(args, results)`

Adversarial review of whether results satisfy the original task.

### `log(message)`

Record a message in the workflow journal.

### Globals

- `args` — JSON input passed at invocation time
- `budget` — token budget for the current run

## Model Tiers

Configure tier-to-model mapping in `~/.pi/workflows/model-tiers.json`:

```json
{
  "small": "openrouter/deepseek/deepseek-v4-flash",
  "medium": "openrouter/xiaomi/mimo-v2.5-pro",
  "big": "parasail/parasail-kimi-k27-code"
}
```

If not configured, uses built-in defaults.

## Resume

Workflows resume automatically. Each agent call is hashed; completed calls replay from the journal. Re-running the same workflow script skips already-completed steps.

## Commands

- `/workflows list` — show saved commands and recent runs
- `/workflows save <name>` — save the last workflow script as `/<name>`

## Testing

```bash
bun test
```

## License

MIT
