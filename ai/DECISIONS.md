# Decisions

## Principles

1. **Standalone** — No external workflow dependencies. Use pi SDK directly.
2. **Minimal** — ~300-400 lines. Core runtime only, not a Claude Code clone.
3. **Deterministic** — VM sandbox, journal resume, no Date.now/Math.random.
4. **Real metrics** — Use `session.getSessionStats()` for token/cost, not estimates.

## Decision Log

### 2026-06-14: Use pi SDK directly, not QuintinShaw reference

**Context:** First implementation delegated to `@quintinshaw/pi-dynamic-workflows`. Second oscillated between "thin wrapper" and "standalone with stub executeAgent()". Both wrong.

**Decision:** Import from `@earendil-works/pi-coding-agent` only (pi's core SDK). Implement agent execution via `createAgentSession()`. Keep the workflow runtime (VM, journal, parallel/pipeline) in our code.

**Rationale:**
- pi SDK is always available when extensions run — it's pi itself
- QuintinShaw's package is a third-party dependency we don't control
- Our design specifies ~300-400 lines, not 6000+ (reference size)
- We only need: VM sandbox, journal, agent(), parallel(), pipeline()
- Reference has features we don't need: TUI panels, /workflows commands, effort modes, agent types, saved workflows

**What we use from pi SDK:**
- `createAgentSession(options)` — create isolated agent session
- `session.prompt(text)` — run prompt, wait for completion
- `session.messages` — extract assistant text from last message
- `session.getSessionStats()` — real token counts and cost
- `session.dispose()` — cleanup
- `AuthStorage`, `ModelRegistry` — resolve models by tier

### 2026-06-14: Model tier routing via pi's ModelRegistry

**Context:** Need to route `tier: "small"` to a flash model, `tier: "big"` to a pro model.

**Decision:** Use pi's `ModelRegistry` to find models. Accept explicit `model` as `provider/id` string. For tiers, we need a config file or mapping.

**Implementation:** 
- `model: "openrouter/deepseek/deepseek-v4-flash"` — explicit, pass to session
- `tier: "small"` — needs a mapping; for MVP, use the model string from the user's pi config or accept that tier routing requires configuration

### 2026-06-14: Result extraction from session.messages

**Context:** `session.prompt()` returns void. Need to get the assistant's text response.

**Decision:** After `session.prompt()` completes, iterate `session.messages` backwards to find the last assistant message, then extract text content from `content` array where `type === "text"`.

**Pattern (from reference):**
```typescript
function lastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const text = msg.content
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("");
    if (text.trim()) return text;
  }
  return "";
}
```
