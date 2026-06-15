# pi-workflows

Script-as-plan orchestration for pi. Model writes JS, runtime executes.

## Architecture

- Single extension: `index.ts` (~990 lines)
- Journal: `.pi/workflows/<run-id>/journal.jsonl`
- Three core functions: agent(), parallel(), pipeline()
- Quality helpers: verify(), judgePanel(), loopUntilDry(), completenessCheck()
- Model tier routing (small/medium/big) with task-type classifier
- Worktree isolation with conflict-safe merge-back
- Phase budgets with per-phase token caps

## Stack

- TypeScript, Bun
- Pi extension API (`@earendil-works/pi-coding-agent`)
- Pi TUI (`@earendil-works/pi-tui`)
- Pi AI types (`@earendil-works/pi-ai`)
- `@sinclair/typebox` for parameter schemas

## Testing

```bash
bun test
```

## Key Patterns

- Script-as-plan: model writes JS, runtime executes in VM sandbox
- Journal resume: SHA-256 call hashing, crash-safe event log
- Task-type routing: keyword classifier, no deps
- Worktrees: git isolation for parallel edits with cherry-pick merge
- Adversarial evaluation: different agents for execution vs review
