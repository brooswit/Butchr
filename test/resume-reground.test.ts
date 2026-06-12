// Tests for the RESUME RE-GROUNDING handshake — keeping a paused task's resumed
// agent grounded in the CURRENT task.md when the world changed while it waited.
//
// A resume re-enters the SAME `claude --resume` session, which still holds the prompt
// + context the agent saw when it was last grounded. The broadened `raise` tool lets an
// operator EDIT a paused task's prompt/context (or create siblings) while it sits in
// needs_info / in_review. Without re-grounding, the resumed agent would keep working
// from the STALE snapshot in its session. butchr fingerprints the prompt+context it
// grounds an agent in (markRunning → tasks.grounding_fp) and, on resume, compares it to
// the CURRENT task.md; on a mismatch the dispatcher prepends the updated definition
// (taskmd.renderRegroundBlock) ahead of the focused answer/rework message.
//
// What this exercises:
//   1. taskmd.groundingFingerprint — stable for identical prompt+context, changes when
//      either the prompt or the context list changes, ignores review notes.
//   2. taskmd.renderRegroundBlock — carries the CURRENT prompt + context paths framed as
//      superseding the session snapshot.
//   3. taskmd.renderAnswerPrompt / renderReworkPrompt — prepend the re-ground block when
//      supplied, and are BYTE-IDENTICAL to the old output when it is empty (no behavior
//      change for an unedited task).
//   4. END TO END: dispatch a fresh task (real path, fake agent backend) so its prompt+
//      context fingerprint is recorded; park it in needs_info; EDIT its prompt+context;
//      answer it; re-dispatch — and assert the resumed agent's rendered prompt reflects
//      the edits (the core regression this work hardens against).
//
// Env is set before a dynamic import so config/db read our temp paths.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner } from "../src/harness.ts";

let DATA_DIR: string;
let REPO_ROOT: string;
let PROMPTS_DIR: string;
const DIR_ID = "reground-dir";

let dbMod: typeof import("../src/db.ts");
let tasksMod: typeof import("../src/tasks.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let dispatchMod: typeof import("../src/dispatcher.ts");
let harnessMod: typeof import("../src/harness.ts");
let originalRunner: AgentRunner;

function g(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** Parse a task.md text body for the assertions (pure-helper convenience). */
function doc(opts: { prompt: string; context?: string[]; notes?: string }) {
  const lines = [
    "---",
    "id: t",
    "created: 2026-01-01T00:00:00.000Z",
    "status: in_progress",
    opts.context && opts.context.length
      ? "context:\n" + opts.context.map((c) => `  - ${c}`).join("\n")
      : "context: []",
    "---",
    "",
    "## Prompt",
    "",
    opts.prompt,
    "",
    "## Review Notes",
    "",
  ];
  if (opts.notes) lines.push(`### Rejection — 2026-01-01T00:00:00.000Z`, opts.notes, "");
  return taskmdMod.parseTaskMd(lines.join("\n"));
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-reground-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-reground-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  // Real throwaway repo so git.createWorktree / prepareBranchForDispatch work.
  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  g(["config", "user.email", "t@t.t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(join(REPO_ROOT, ".gitignore"), ".butchr/\n");
  writeFileSync(join(REPO_ROOT, "README.md"), "base\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  taskmdMod = await import("../src/taskmd.ts");
  dispatchMod = await import("../src/dispatcher.ts");
  harnessMod = await import("../src/harness.ts");
  originalRunner = harnessMod.getRunner();

  // bun shares the config/db singletons across test files; make sure dispatch()'s
  // output subdirs exist for this run (a sibling file's afterAll may have rm'd them).
  const cfgDataDir = (await import("../src/config.ts")).config.dataDir;
  PROMPTS_DIR = join(cfgDataDir, "prompts");
  for (const sub of ["prompts", "runs", "mcp"]) {
    mkdirSync(join(cfgDataDir, sub), { recursive: true });
  }

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR_ID, REPO_ROOT, "test", dbMod.nowIso());
});

afterAll(() => {
  harnessMod.setRunner(originalRunner);
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

const dbRow = (id: string) =>
  dbMod.db.query<any, [string]>(`SELECT * FROM tasks WHERE id=?`).get(id)!;
const dirRow = () =>
  dbMod.db.query<any, [string]>(`SELECT * FROM workspaces WHERE id=?`).get(DIR_ID)!;

/** A fake agent backend that resolves a live pane and stays alive (watcher loops). */
function fakeRunner(): AgentRunner {
  return {
    async isUp() {
      return true;
    },
    async workspaceCreate() {
      return { workspaceId: "ws-1", rootPaneId: "root-1" };
    },
    async workspaceExists() {
      return false;
    },
    async workspaceClose() {},
    async tabCreate() {
      return { tabId: "tab-1", rootPaneId: "rp-1" };
    },
    async tabClose() {},
    async agentTabId() {
      return undefined;
    },
    async agentStart() {
      return { paneId: "pane-raw", terminalId: "term-1" };
    },
    async agentExists() {
      return true;
    },
    async agentPaneId() {
      return undefined;
    },
    async agentTerminalId() {
      return "term-1";
    },
    async paneTerminalId() {
      return "rootterm-1";
    },
    async paneList() {
      return [];
    },
    async resolveAgentPane() {
      return "pane-final";
    },
    async reconcilePane() {
      return { paneId: "pane-final", drifted: false };
    },
    isAgentNameTaken() {
      return false;
    },
    async agentRead() {
      return "";
    },
    async send() {},
    async paneClose() {},
    async teardownTask() {},
    async agentDeregister() {},
    async runHeadless() {
      return { ok: true, code: 0, stdout: "", stderr: "", timedOut: false };
    },
  };
}

describe("groundingFingerprint", () => {
  test("is stable for identical prompt + context and ignores review notes", () => {
    const a = taskmdMod.groundingFingerprint(doc({ prompt: "Do X", context: ["a.ts"] }));
    const b = taskmdMod.groundingFingerprint(doc({ prompt: "Do X", context: ["a.ts"] }));
    // Same prompt+context but ADDED review notes — the fingerprint must not move (notes
    // already flow into the rework prompt; they don't mean the task was re-grounded).
    const c = taskmdMod.groundingFingerprint(
      doc({ prompt: "Do X", context: ["a.ts"], notes: "fix the edge case" }),
    );
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  test("changes when the prompt changes", () => {
    const before = taskmdMod.groundingFingerprint(doc({ prompt: "Do X" }));
    const after = taskmdMod.groundingFingerprint(doc({ prompt: "Do Y instead" }));
    expect(after).not.toBe(before);
  });

  test("changes when the context list changes", () => {
    const before = taskmdMod.groundingFingerprint(doc({ prompt: "Do X", context: ["a.ts"] }));
    const after = taskmdMod.groundingFingerprint(
      doc({ prompt: "Do X", context: ["a.ts", "b.ts"] }),
    );
    expect(after).not.toBe(before);
  });
});

describe("renderRegroundBlock", () => {
  test("carries the CURRENT prompt + context, framed as superseding the session", () => {
    const block = taskmdMod.renderRegroundBlock(
      doc({ prompt: "The REVISED instructions.", context: ["src/new.ts"] }),
    );
    expect(block).toContain("updated while you were paused");
    expect(block).toContain("SUPERSEDES");
    expect(block).toContain("The REVISED instructions.");
    expect(block).toContain("src/new.ts");
  });
});

describe("renderAnswerPrompt / renderReworkPrompt re-grounding", () => {
  test("answer prompt prepends the re-ground block but is unchanged without one", () => {
    const plain = taskmdMod.renderAnswerPrompt("use SQLite");
    // No re-ground arg, and an empty/whitespace re-ground arg, are byte-identical to the
    // historical output — an unedited task resumes EXACTLY as before.
    expect(taskmdMod.renderAnswerPrompt("use SQLite", "")).toBe(plain);
    expect(taskmdMod.renderAnswerPrompt("use SQLite", "   ")).toBe(plain);

    const block = taskmdMod.renderRegroundBlock(doc({ prompt: "NEW PROMPT BODY" }));
    const grounded = taskmdMod.renderAnswerPrompt("use SQLite", block);
    expect(grounded).toContain("NEW PROMPT BODY");
    expect(grounded).toContain("use SQLite");
    // The re-ground block leads the focused answer so the agent re-grounds first.
    expect(grounded.indexOf("NEW PROMPT BODY")).toBeLessThan(grounded.indexOf("use SQLite"));
  });

  test("rework prompt prepends the re-ground block but is unchanged without one", () => {
    const d = doc({ prompt: "p", notes: "address the failing test" });
    const plain = taskmdMod.renderReworkPrompt(REPO_ROOT, d);
    expect(taskmdMod.renderReworkPrompt(REPO_ROOT, d, "")).toBe(plain);

    const block = taskmdMod.renderRegroundBlock(doc({ prompt: "NEW PROMPT BODY" }));
    const grounded = taskmdMod.renderReworkPrompt(REPO_ROOT, d, block);
    expect(grounded).toContain("NEW PROMPT BODY");
    expect(grounded).toContain("address the failing test");
    expect(grounded.indexOf("NEW PROMPT BODY")).toBeLessThan(
      grounded.indexOf("address the failing test"),
    );
  });
});

describe("END TO END: edits during needs_info reach the resumed agent", () => {
  test("editing prompt+context while paused re-grounds the answer-resume prompt", async () => {
    harnessMod.setRunner(fakeRunner());

    // 1. Fresh task → first dispatch records its prompt+context fingerprint.
    const view = await tasksMod.createTask(
      DIR_ID,
      "ORIGINAL: build the widget.",
      ["src/original.ts"],
    );
    expect(dbRow(view.id).status).toBe("in_progress");
    await dispatchMod.dispatch(dirRow(), dbRow(view.id));
    const id = view.id;

    const grounded = dbRow(id);
    expect(grounded.grounding_fp).toBeTruthy(); // the launch recorded what it grounded
    expect(typeof grounded.session_id).toBe("string");
    // The fresh launch's prompt is the FULL agent prompt (no re-ground header).
    const firstPrompt = readFileSync(join(PROMPTS_DIR, `${id}.md`), "utf8");
    expect(firstPrompt).toContain("ORIGINAL: build the widget.");
    expect(firstPrompt).not.toContain("updated while you were paused");

    // Stop the watcher the fresh dispatch spawned.
    dispatchMod.signalAbort(id);

    // 2. Agent asks → parks in needs_info (the pause).
    expect(tasksMod.markNeedsInfoFromAgent(id, "Which storage?")).toBe("ok");
    expect(dbRow(id).status).toBe("needs_info");

    // 3. The operator EDITS the task's prompt AND context while it waits — exactly the
    // world-changing case the broadened `raise` tool enables. We rewrite task.md the way
    // an edit would, keeping the front matter + status.
    taskmdMod.writeTaskMd(
      REPO_ROOT,
      {
        id,
        created: grounded.created_at,
        status: "needs_info" as any,
        context: ["src/revised.ts", "src/extra.ts"],
      },
      "REVISED: build the widget with pagination.",
    );
    taskmdMod.updateTaskMdStatus(REPO_ROOT, id, "needs_info" as any);

    // 4. Answer it → re-queued in_progress for the --resume relaunch.
    await tasksMod.answerTask(id, "Use the on-disk store.");
    expect(dbRow(id).status).toBe("in_progress");

    // 5. Re-dispatch (the resume). The stored fingerprint no longer matches the edited
    // task.md, so the rendered prompt must RE-GROUND the agent in the current task.
    await dispatchMod.dispatch(dirRow(), dbRow(id));
    const resumePrompt = readFileSync(join(PROMPTS_DIR, `${id}.md`), "utf8");

    // The answer is still delivered...
    expect(resumePrompt).toContain("Use the on-disk store.");
    // ...AND the resumed agent is re-grounded in the EDITED prompt + context, not the
    // stale snapshot its session holds.
    expect(resumePrompt).toContain("updated while you were paused");
    expect(resumePrompt).toContain("REVISED: build the widget with pagination.");
    expect(resumePrompt).toContain("src/revised.ts");
    expect(resumePrompt).toContain("src/extra.ts");
    expect(resumePrompt).not.toContain("ORIGINAL: build the widget.");

    // The resume re-recorded the fingerprint, so a SECOND resume with no further edits
    // would NOT re-ground.
    expect(dbRow(id).grounding_fp).toBe(
      taskmdMod.groundingFingerprint(taskmdMod.readTaskMd(REPO_ROOT, id)),
    );

    dispatchMod.signalAbort(id);
    // Let the aborted watchers unwind before teardown.
    await new Promise((r) => setTimeout(r, 1300));
  });
});
