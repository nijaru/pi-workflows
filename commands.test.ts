import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerExtension from "./index";
import { compileWorkflow } from "./plan";
import { RunStore } from "./store";

/**
 * Command-handler coverage for /workflows. registerExtension is driven with a
 * stub ExtensionAPI so pause/cancel/save/clean run against real RunStore data
 * without a live Pi session.
 */

type CommandHandler = (raw: string, ctx: any) => Promise<void>;

function harness(cwd: string, entries: any[] = []) {
  const commands = new Map<string, CommandHandler>();
  const notifications: string[] = [];
  const pi: any = {
    registerTool: () => undefined,
    registerCommand: (name: string, options: { handler: CommandHandler }) => commands.set(name, options.handler),
    on: () => undefined,
    getActiveTools: () => [],
    setActiveTools: () => undefined,
  };
  registerExtension(pi);
  const ctx = {
    cwd,
    signal: new AbortController().signal,
    sessionManager: { getSessionId: () => "test-session", getEntries: () => entries },
    ui: { notify: (message: string) => notifications.push(message) },
  };
  return { run: async (raw: string) => { const handler = commands.get("workflows")!; if (!handler) throw new Error("command not registered"); await handler(raw, ctx); }, notifications };
}

const SCRIPT = `export const meta = { name: "cmd", description: "command test" };\nreturn agent({ id: "x", prompt: "p", effect: "read" });`;

describe("/workflows commands", () => {
  test("pause and cancel write durable markers for known runs", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-wf-cmd-"));
    try {
      const store = new RunStore(cwd, "run-cmd-1");
      store.create(compileWorkflow(SCRIPT), null, { planHash: "hash" });
      const { run, notifications } = harness(cwd);
      await run("pause run-cmd-1");
      expect(existsSync(join(store.directory, "paused"))).toBe(true);
      await run("cancel run-cmd-1");
      expect(existsSync(join(store.directory, "cancelled"))).toBe(true);
      expect(notifications.some(n => n.includes("Pause requested"))).toBe(true);
      expect(notifications.some(n => n.includes("Cancellation requested"))).toBe(true);
      // Unknown and malformed run IDs are refused without touching disk.
      await expect(run("pause run-nope")).rejects.toThrow("not found");
      await expect(run("cancel ../escape")).rejects.toThrow("Invalid workflow run id");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("save persists the latest workflow tool call from the session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-wf-save-"));
    try {
      const entries = [
        { message: { content: [{ type: "toolCall", name: "workflow", arguments: { script: SCRIPT } }] } },
      ];
      const { run } = harness(cwd, entries);
      await run("save audit");
      const saved = readFileSync(join(cwd, ".pi/workflows/commands/audit.js"), "utf8");
      expect(saved).toBe(SCRIPT);
      await expect(run("save bad name!")).rejects.toThrow("single token");
      const empty = harness(cwd, []);
      await expect(empty.run("save nope")).rejects.toThrow("No workflow call found");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test("clean removes finished and orphaned run directories but never active ones", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-wf-clean-"));
    try {
      const plan = compileWorkflow(SCRIPT);
      for (const runId of ["run-done", "run-live"]) {
        const store = new RunStore(cwd, runId);
        const state = store.create(plan, null, { planHash: "hash" });
        if (runId === "run-done") { state.status = "completed"; store.save(state); }
      }
      mkdirSync(join(cwd, ".pi/workflows/run-orphan")); // no state.json
      const { run } = harness(cwd);
      await run("clean 0");
      expect(existsSync(join(cwd, ".pi/workflows/run-done"))).toBe(false);
      expect(existsSync(join(cwd, ".pi/workflows/run-orphan"))).toBe(false);
      expect(existsSync(join(cwd, ".pi/workflows/run-live"))).toBe(true);
      await expect(run("clean 99999")).rejects.toThrow("0 to 3650");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
