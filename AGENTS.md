# pi-workflows

## Architecture

- `index.ts` is the Pi extension boundary: tools, commands, and session lifecycle.
- `plan.ts` synchronously compiles restricted JavaScript into a serializable DAG.
- `scheduler.ts` owns dependencies, concurrency, budgets, control markers, retries, and terminal results.
- `store.ts` owns durable run/node state, events, outputs, usage, and coordinator leases.
- `executor.ts` owns the execution port and the current Pi SDK backend. Keep Pi 2 `AgentHarness` integration behind `createHarnessBackend()` until its public API stabilizes.
- `workspace.ts` owns Git worktrees, commits, serialized cherry-pick merges, and pending-merge recovery.

The workflow store is authoritative for graph state. Pi SDK or AgentHarness sessions are authoritative for provider, transcript, and tool-operation state. Do not copy provider checkpoints into workflow state.

## Plan contract

- Plans start with `export const meta = { name, description }`.
- Tasks are created synchronously with `agent({ id, prompt, ... })` or `task(...)`; every task needs a stable ID.
- `parallel([...])` expresses fan-out and `pipeline([[...], [...]])` adds stage dependencies.
- Dependency outputs are passed as JSON in downstream prompts.
- Plan code has no filesystem, shell, process, network, or dynamic-code-generation capability.
- Write tasks are at-least-once effects. Use `isolation: "worktree"` for concurrent writes and make effects idempotent.

## Persistence and control

- Run data lives under `.pi/workflows/<run-id>/` and is disposable runtime state, not source.
- Resume requires the same plan and execution-policy hash. Running nodes are retried at the workflow boundary until a concrete AgentHarness adapter can reattach operations.
- Pause and cancellation use durable marker files; explicit resume removes only the pause marker.
- Coordinator leases prevent duplicate execution and may be taken over when the recorded process is dead.
- Preserve `pending-merge.json` until a committed worktree merge is reconciled.

## Development

```bash
bun install --frozen-lockfile
bun test
bun x tsc --noEmit
git diff --check
```

Before completing behavior changes, run the full test and type-check commands and inspect the diff. Keep tests focused on plan validation, scheduler fault paths, persistence, control markers, and backend seams.

## Boundaries

- This is an unreleased breaking redesign; do not add compatibility shims for the removed pre-plan API or legacy journal format.
- Do not add a mailbox/team protocol, nested workflow runner, cloud scheduler, or wholesale extension loading into child sessions without a new requirement.
- The Pi SDK backend is the current implementation. The Pi 2 backend is an injected seam, not an installed dependency.
- A restricted VM is not an OS sandbox. Hostile workflow code requires process or container isolation.

## Commands

- `/workflows list` — show saved workflows and recent runs
- `/workflows save <name>` — save the most recent workflow call
- `/workflows run <name>` — run a saved workflow
- `/workflows pause <runId>` — request a durable pause
- `/workflows cancel <runId>` — request durable cancellation
- `/workflows resume <runId>` — explicitly resume a paused or orphaned run
- `/workflows clean [days]` — remove old completed, failed, or cancelled runs
