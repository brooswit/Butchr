// Tests for PER-TASK MODEL selection + token/cost tracking.
//
// Covers:
//   - config.agentCmd/resumeCmd carry the {{MODEL_FLAG}} placeholder.
//   - dispatcher.resolveLaunchCommand threads a requested model into `--model <m>`
//     and leaves no flag (nor a leftover placeholder) when unset.
//   - tasks.validateModel accepts aliases / full ids and rejects junk.
//   - createTask persists the requested model to the DB row AND task.md front matter
//     (round-tripping through readTaskMd), and rejects an invalid model.
//   - usage.parseTranscriptUsage sums per-turn tokens, dedupes repeated turns by id,
//     captures the model, and is null on an empty transcript; usage.mungeCwd matches
//     Claude Code's cwd→folder munging.
//   - tasks.captureSessionUsage reads a session transcript (located via
//     CLAUDE_CONFIG_DIR) and persists the token totals + actual model onto the row.
//
// In-process: no real claude/herdr. BUTCHR_HERDR_BIN=true makes herdr probes no-ops;
// a throwaway git repo backs createTask's worktree + task.md.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
let CLAUDE_DIR: string;
const DIR_ID = "model-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let dispatchMod: typeof import("../src/dispatcher.ts");
let usageMod: typeof import("../src/usage.ts");
let cfgMod: typeof import("../src/config.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-model-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-model-repo-"));
  CLAUDE_DIR = mkdtempSync(join(tmpdir(), "butchr-model-claude-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  // Point the usage reader at a throwaway "~/.claude" so the test never touches the
  // real one (usage.projectsRoot honors CLAUDE_CONFIG_DIR).
  process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR;

  const g = (args: string[]) =>
    execFileSync("git", ["-C", REPO_ROOT, ...args], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  g(["commit", "--allow-empty", "-q", "-m", "init"]);

  dbMod = await import("../src/db.ts");
  taskmdMod = await import("../src/taskmd.ts");
  tasksMod = await import("../src/tasks.ts");
  dispatchMod = await import("../src/dispatcher.ts");
  usageMod = await import("../src/usage.ts");
  cfgMod = await import("../src/config.ts");

  dbMod.db
    .query(`INSERT INTO directories (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR_ID, REPO_ROOT, "test", dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
  rmSync(CLAUDE_DIR, { recursive: true, force: true });
});

function row(id: string) {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}

describe("config templates", () => {
  test("agentCmd and resumeCmd carry the {{MODEL_FLAG}} placeholder", () => {
    expect(cfgMod.config.agentCmd).toContain("{{MODEL_FLAG}}");
    expect(cfgMod.config.resumeCmd).toContain("{{MODEL_FLAG}}");
  });
});

describe("dispatcher.resolveLaunchCommand — model threading", () => {
  const PF = "/data/prompts/t.md";
  const MC = "/data/mcp/t.json";

  test("a requested model becomes --model <model> in the launch command", () => {
    const r = dispatchMod.resolveLaunchCommand(
      { started_at: null, session_id: null, model: "opus" } as any,
      PF,
      MC,
    );
    expect(r.agentCmd).toContain("--model opus");
    expect(r.agentCmd).not.toContain("{{MODEL_FLAG}}");
  });

  test("the model threads through the RESUME command too", () => {
    const r = dispatchMod.resolveLaunchCommand(
      { started_at: "2026-01-01T00:00:00.000Z", session_id: "abc-123", model: "claude-opus-4-8" } as any,
      PF,
      MC,
    );
    expect(r.isResume).toBe(true);
    expect(r.agentCmd).toContain("--resume abc-123");
    expect(r.agentCmd).toContain("--model claude-opus-4-8");
  });

  test("an unset model threads NO --model flag and leaves no placeholder", () => {
    for (const model of [null, undefined, "", "   "]) {
      const r = dispatchMod.resolveLaunchCommand(
        { started_at: null, session_id: null, model } as any,
        PF,
        MC,
      );
      expect(r.agentCmd).not.toContain("--model");
      expect(r.agentCmd).not.toContain("{{MODEL_FLAG}}");
    }
  });
});

describe("tasks.validateModel", () => {
  test("accepts aliases and full ids; normalizes blank to null", () => {
    expect(tasksMod.validateModel("opus")).toBe("opus");
    expect(tasksMod.validateModel("  sonnet ")).toBe("sonnet");
    expect(tasksMod.validateModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(tasksMod.validateModel(null)).toBeNull();
    expect(tasksMod.validateModel(undefined)).toBeNull();
    expect(tasksMod.validateModel("")).toBeNull();
    expect(tasksMod.validateModel("   ")).toBeNull();
  });

  test("rejects junk / shell-metachar input", () => {
    for (const bad of ["opus; rm -rf /", "a b", "$(whoami)", "model`x`", "../x"]) {
      expect(() => tasksMod.validateModel(bad)).toThrow();
    }
  });
});

describe("createTask — per-task model persistence", () => {
  test("stores the requested model on the row AND in task.md front matter", async () => {
    const view = await tasksMod.createTask(DIR_ID, "use opus", [], [], "task", "opus");
    expect((view as any).model).toBe("opus");
    expect(row(view.id).model).toBe("opus");
    expect(taskmdMod.readTaskMd(REPO_ROOT, view.id).meta.model).toBe("opus");
  });

  test("an unset model leaves model NULL (no front-matter line)", async () => {
    const view = await tasksMod.createTask(DIR_ID, "default model", [], []);
    expect((view as any).model).toBeNull();
    expect(row(view.id).model).toBeNull();
    expect(taskmdMod.readTaskMd(REPO_ROOT, view.id).meta.model).toBeNull();
  });

  test("an invalid model is rejected and creates no task", async () => {
    const before = dbMod.db.query<{ c: number }, []>(`SELECT COUNT(*) c FROM tasks`).get()!.c;
    await expect(tasksMod.createTask(DIR_ID, "bad", [], [], "task", "no good!")).rejects.toThrow();
    const after = dbMod.db.query<{ c: number }, []>(`SELECT COUNT(*) c FROM tasks`).get()!.c;
    expect(after).toBe(before);
  });
});

describe("usage.parseTranscriptUsage / mungeCwd", () => {
  function line(obj: any): string {
    return JSON.stringify(obj);
  }
  function assistant(id: string, model: string, u: Partial<Record<string, number>>): string {
    return line({ type: "assistant", message: { id, model, usage: u } });
  }

  test("sums per-turn tokens across assistant turns and captures the last model", () => {
    const text = [
      line({ type: "summary" }),
      assistant("m1", "claude-opus-4-8", {
        input_tokens: 100, output_tokens: 10,
        cache_read_input_tokens: 5, cache_creation_input_tokens: 2,
      }),
      line({ type: "user", message: { role: "user" } }),
      assistant("m2", "claude-sonnet-4-6", {
        input_tokens: 200, output_tokens: 20,
        cache_read_input_tokens: 7, cache_creation_input_tokens: 3,
      }),
    ].join("\n");
    const u = usageMod.parseTranscriptUsage(text)!;
    expect(u.inputTokens).toBe(300);
    expect(u.outputTokens).toBe(30);
    expect(u.cacheReadTokens).toBe(12);
    expect(u.cacheCreationTokens).toBe(5);
    expect(u.model).toBe("claude-sonnet-4-6"); // last assistant model
  });

  test("dedupes a repeated assistant turn (same id counted once)", () => {
    const t = assistant("dup", "claude-opus-4-8", { input_tokens: 50, output_tokens: 5 });
    const u = usageMod.parseTranscriptUsage([t, t, t].join("\n"))!;
    expect(u.inputTokens).toBe(50);
    expect(u.outputTokens).toBe(5);
  });

  test("tolerates blank/garbage lines and returns null with no assistant turns", () => {
    expect(usageMod.parseTranscriptUsage("")).toBeNull();
    expect(usageMod.parseTranscriptUsage("\n{not json}\n")).toBeNull();
    expect(
      usageMod.parseTranscriptUsage(line({ type: "user", message: { role: "user" } })),
    ).toBeNull();
  });

  test("mungeCwd replaces every non-alphanumeric char with '-'", () => {
    expect(usageMod.mungeCwd("/home/u/Code/x.y")).toBe("-home-u-Code-x-y");
  });
});

describe("tasks.captureSessionUsage — end to end", () => {
  test("reads the session transcript and persists token totals + actual model", async () => {
    const view = await tasksMod.createTask(DIR_ID, "track usage", [], [], "task", "opus");
    const id = view.id;
    const sessionId = "11111111-2222-3333-4444-555555555555";
    // Simulate the dispatcher having launched the agent: set a session id.
    dbMod.db.query(`UPDATE tasks SET session_id=? WHERE id=?`).run(sessionId, id);

    // Write a transcript where Claude Code would put it: under CLAUDE_CONFIG_DIR/
    // projects/<munged worktree cwd>/<session>.jsonl.
    const worktree = join(REPO_ROOT, id);
    const projDir = join(CLAUDE_DIR, "projects", usageMod.mungeCwd(worktree));
    mkdirSync(projDir, { recursive: true });
    const transcript = [
      JSON.stringify({
        type: "assistant",
        message: {
          id: "a1", model: "claude-opus-4-8",
          usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 25 },
        },
      }),
    ].join("\n");
    writeFileSync(join(projDir, `${sessionId}.jsonl`), transcript, "utf8");

    tasksMod.captureSessionUsage(id);

    const r = row(id);
    expect(r.usage_input_tokens).toBe(1000);
    expect(r.usage_output_tokens).toBe(200);
    expect(r.usage_cache_read_tokens).toBe(50);
    expect(r.usage_cache_creation_tokens).toBe(25);
    expect(r.model_used).toBe("claude-opus-4-8");
    // Cost is intentionally not fabricated.
    expect(r.cost_usd).toBeNull();
  });

  test("is a no-op when the task has no session id (columns stay null)", async () => {
    const view = await tasksMod.createTask(DIR_ID, "no session", [], []);
    tasksMod.captureSessionUsage(view.id);
    const r = row(view.id);
    expect(r.usage_input_tokens).toBeNull();
    expect(r.model_used).toBeNull();
  });
});
