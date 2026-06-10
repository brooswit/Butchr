// Tests for the two ROBUSTNESS fixes:
//
//   (a) renderAgentPrompt no longer INLINES context-file bodies — it lists their
//       PATHS so the rendered prompt stays small (a large prompt blows the
//       MAX_ARG_STRLEN argv limit when launched as `claude ... -- "$(cat ...)"`,
//       failing exec with E2BIG so the agent never starts). The agent reads the
//       files itself with its tools.
//
//   (b) An agent that exits ALMOST IMMEDIATELY with an exec-failure code (126/127)
//       and NO output never actually launched. dispatcher.isExecFailure factors
//       out that decision, and the watcher routes such a launch through the
//       dispatch retry/backoff path (markDispatchFailure) instead of masquerading
//       it as an empty `review`.
//
// These are pure / in-process: no real claude or herdr is spawned. As in the other
// test files, BUTCHR_HERDR_BIN points at `true` so every herdr probe is a no-op.
// Env is set before a dynamic import so config/db read our temp paths.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "execfail-dir";

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let dispatchMod: typeof import("../src/dispatcher.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-execfail-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-execfail-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  process.env.BUTCHR_MAX_DISPATCH_ATTEMPTS = "3";

  dbMod = await import("../src/db.ts");
  taskmdMod = await import("../src/taskmd.ts");
  tasksMod = await import("../src/tasks.ts");
  dispatchMod = await import("../src/dispatcher.ts");

  dbMod.db
    .query(
      `INSERT INTO directories (id, path, label, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(DIR_ID, REPO_ROOT, "test", dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

function dbRow(id: string) {
  return dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
}

// --- Fix (a): renderAgentPrompt lists paths, never inlines bodies --------------

describe("renderAgentPrompt does not inline context-file bodies", () => {
  test("the rendered prompt lists context PATHS but not their contents", () => {
    // A context file whose body contains an easily-recognized sentinel. If the
    // renderer inlined it, the sentinel would appear in the output.
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    const bodyMarker = "SENTINEL_CONTEXT_FILE_BODY_SHOULD_NOT_BE_INLINED";
    writeFileSync(join(REPO_ROOT, "context-a.md"), `# A\n\n${bodyMarker}\n`, "utf8");
    writeFileSync(join(REPO_ROOT, "src-notes.txt"), `${bodyMarker} again\n`, "utf8");

    const doc = {
      meta: {
        id: "render-a",
        created: dbMod.nowIso(),
        status: "queued" as const,
        context: ["context-a.md", "src-notes.txt"],
      },
      prompt: "Do the thing.",
      reviewNotes: "",
      raw: "",
    };

    const rendered = taskmdMod.renderAgentPrompt(REPO_ROOT, doc);

    // The PATHS are present so the agent knows what to read...
    expect(rendered).toContain("context-a.md");
    expect(rendered).toContain("src-notes.txt");
    // ...but the file BODIES are NOT inlined.
    expect(rendered).not.toContain(bodyMarker);
    // The original task prompt is still there.
    expect(rendered).toContain("Do the thing.");
  });

  test("an empty context list adds no context-files section", () => {
    const doc = {
      meta: {
        id: "render-empty",
        created: dbMod.nowIso(),
        status: "queued" as const,
        context: [],
      },
      prompt: "Just the prompt.",
      reviewNotes: "",
      raw: "",
    };
    const rendered = taskmdMod.renderAgentPrompt(REPO_ROOT, doc);
    expect(rendered).not.toContain("# Context files");
    expect(rendered).toContain("Just the prompt.");
  });
});

// --- Fix (b): isExecFailure decision + the failure routing ---------------------

describe("isExecFailure (the launch-failure decision)", () => {
  test("126/127 with no output are exec failures", () => {
    expect(dispatchMod.isExecFailure("126", false)).toBe(true);
    expect(dispatchMod.isExecFailure("127", false)).toBe(true);
    // Tolerates surrounding whitespace/newline from the `.done` file.
    expect(dispatchMod.isExecFailure(" 126\n", false)).toBe(true);
  });

  test("a clean exit (0) or any other code is NOT an exec failure", () => {
    expect(dispatchMod.isExecFailure("0", false)).toBe(false);
    expect(dispatchMod.isExecFailure("1", false)).toBe(false); // ran then errored
    expect(dispatchMod.isExecFailure("", false)).toBe(false); // blank/missing
  });

  test("ANY captured output means the agent started → not an exec failure", () => {
    // 126/127 WITH output isn't a launch failure (the agent ran and produced
    // something), so it should not be diverted to the dispatch-failure path.
    expect(dispatchMod.isExecFailure("126", true)).toBe(false);
    expect(dispatchMod.isExecFailure("127", true)).toBe(false);
  });
});

describe("an immediate exec failure routes to the dispatch-failure path, not review", () => {
  test("markDispatchFailure on a running task re-queues with backoff (never review)", async () => {
    // Plant a task as if it had just been markRunning'd (the state the watcher
    // sees when the agent exec-fails immediately): running, with a pane/tab and a
    // session id, attempts reset to 0.
    const id = "execfail-route";
    const created = dbMod.nowIso();
    dbMod.db
      .query(
        `INSERT INTO tasks (id, directory_id, status, session_id, herdr_pane_id, herdr_tab_id, started_at, dispatch_attempts, created_at)
         VALUES (?, ?, 'running', 'sess-x', 'pane-1', 'tab-1', ?, 0, ?)`,
      )
      .run(id, DIR_ID, created, created);
    taskmdMod.writeTaskMd(
      REPO_ROOT,
      { id, created, status: "running", context: [] },
      "Implement something.",
    );
    taskmdMod.updateTaskMdStatus(REPO_ROOT, id, "running");

    // This is exactly the call the watcher makes when isExecFailure trips.
    await tasksMod.markDispatchFailure(
      id,
      "agent failed to launch (exit code 126, no output)",
    );

    const row = dbRow(id);
    // Under the attempt cap → re-queued with a future backoff, NOT moved to review.
    expect(row.status).toBe("queued");
    expect(row.status).not.toBe("review");
    expect(row.dispatch_attempts).toBe(1);
    expect(row.next_dispatch_at).toBeTruthy();
    expect(row.last_dispatch_error).toContain("failed to launch");
    // The herdr pane/tab were torn down by markDispatchFailure.
    expect(row.herdr_pane_id).toBeNull();
    expect(row.herdr_tab_id).toBeNull();
  });
});
