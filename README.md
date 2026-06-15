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

## Commands

| Command | Description |
|---------|-------------|
| `/workflows list` | Show recent workflow runs |

## File Structure

```
.pi/workflows/<run-id>/
├── meta.json       # workflow name, script, phases
├── journal.jsonl   # agent results with hashes for resume
└── complete.log    # marks run as finished (deleted = resumable)
```

## License

MIT
