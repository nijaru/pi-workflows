# pi-workflows

Script-as-plan orchestration for pi. The model writes a JavaScript orchestration script; the runtime executes it with journal-based resume, model tier routing, and real cost tracking.

Use for tasks that need more agents than one conversation can coordinate — codebase audits, migrations, research across many sources, adversarial reviews.

## Installation

```bash
pi install git:github.com/nijaru/pi-workflows
```

## Usage

The extension registers a `workflow` tool. The model writes the script automatically when you ask for a workflow:

```
Use a workflow to audit every API endpoint under src/routes/ for missing auth checks
```

Workflows run in the background. Your session stays free. Re-running the same workflow resumes from where it left off.

The generated script looks like this:

```javascript
export const meta = { name: "api-auth-audit", description: "Check all endpoints for auth" };

phase("scan");
const endpoints = await agent("List all API route files under src/routes/");

phase("review", { budget: 50000 });
const results = await parallel(
  endpoints.map(ep => () => agent(`Audit ${ep} for missing auth middleware`))
);

const report = await agent(`Summarize findings: ${JSON.stringify(results)}`);
return report;
```

The model writes this. You don't need to know the syntax.

## Commands

| Command | Description |
|---------|-------------|
| `/workflows list` | Show recent runs and saved commands |
| `/workflows save <name>` | Save the last workflow as a reusable command |
| `/workflows pause <runId>` | Pause a running workflow (resume by running again) |

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `tokenBudget` | unlimited | Hard token cap for the run |
| `maxAgents` | 1000 | Maximum agent calls allowed |
| `dryRun` | false | Validate and preview without executing |
| `resume` | true | Resume from last incomplete run of same name |
| `forceResume` | false | Retry a run that previously errored |

## Model Tiers

By default, all workflow agents use your configured pi model. To route different tasks to different models, create `~/.pi/workflows/model-tiers.json`:

```json
{
  "small": "openrouter/deepseek/deepseek-v4-flash",
  "medium": "openrouter/xiaomi/mimo-v2.5-pro",
  "big": "parasail/parasail-kimi-k27-code"
}
```

The model can also specify a full `provider/modelId` per agent call to override tiers.

## File Structure

```
.pi/workflows/<run-id>/
├── meta.json       # workflow name, script, phases
├── journal.jsonl   # agent results with hashes for resume
└── complete.log    # marks run as finished (deleted = resumable)
```

## License

MIT
