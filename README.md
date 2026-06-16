# pi-workflows

Parallel agent orchestration for pi. Ask for a workflow, get multiple agents working together with real cost tracking and cross-session resume.

"Run 50 review agents in parallel" beats re-prompting one agent 50 times. Workflows formalize the loop — persistent state, hard budget caps, automatic resume — so long-running tasks don't need babysitting.

## Quick Start

```bash
pi install git:github.com/nijaru/pi-workflows
```

Then ask pi:

```
Use a workflow to audit every API endpoint under src/routes/ for missing auth checks
```

Workflows run in the background. Your session stays free. Re-running a workflow resumes from where it left off.

## Features

| Feature | Description |
|---------|-------------|
| Parallel agents | Run multiple agents concurrently with configurable limits |
| Token budgets | Hard caps per run and per phase — never exceed a cost ceiling |
| Cross-session resume | Incomplete runs pick up where they left off |
| In-session pause/resume | Pause a running workflow, resume later with cached results preserved |
| Model tier routing | Route simple tasks to cheap models, complex ones to capable ones |
| Real cost tracking | Token counts and costs from pi's session stats, not estimates |
| Adversarial verification | Built-in `verify()` and `judgePanel()` for quality checks |
| Dry run | Preview and validate a workflow without executing |

## Commands

User commands — type these in the pi TUI:

| Command | Description |
|---------|-------------|
| `/workflows list` | Show recent runs and saved commands |
| `/workflows save <name>` | Save the last workflow as a reusable command |
| `/workflows pause <runId>` | Pause a running workflow (resume by running again) |

## Parameters

Agent parameters — the model sets these automatically:

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

## License

MIT
