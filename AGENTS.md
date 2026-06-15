# pi-workflows

Script-as-plan orchestration for pi. Model writes JS, runtime executes.

## Design

See DESIGN.md for the full API design and implementation notes.

## Architecture

- Single extension, ~300-400 lines
- Entry: `extensions/pi-workflows/index.ts`
- Journal: `.pi/workflows/<run-id>/journal.jsonl`
- Three functions: agent(), parallel(), pipeline()
- Task-type routing (small/medium/big)
- Worktree isolation for parallel file edits
- Cost budgets with budget-aware routing

## Stack

- TypeScript, Bun
- Pi extension API (`@earendil-works/pi-coding-agent`)
- Pi TUI (`@earendil-works/pi-tui`)
- Pi AI types (`@earendil-works/pi-ai`)

## Testing

```bash
bun test
```

## Key Patterns

- Script-as-plan: model writes JS, runtime executes
- Journal resume: crash-safe event log
- Task-type routing: keyword classifier, no deps
- Worktrees: git isolation for parallel edits
- Adversarial evaluation: different model for review
