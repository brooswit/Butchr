// Regression test for butchr's REJECT -> RESUME path.
//
// Covers ONLY the pure / in-process logic — a butchr task agent's sandbox has no
// live claude or herdr, so nothing here spawns a real agent or talks to a real
// herdr. We neutralize the one herdr call on the reject path
// (herdr.teardownTask -> `herdr agent get`) by pointing BUTCHR_HERDR_BIN at the
// `true` binary: it exits 0 with empty stdout, so agentTabId() resolves to
// undefined and teardownTask becomes a no-op. The actual `claude --resume`
// re-entry is verified separately by the operator (it needs a live stack).
//
// What this exercises:
//   1. tasks.rejectTask — note validation, in_review -> in_progress transition, note
//      persistence, and (critically) that the existing session_id is PRESERVED
//      so the dispatcher will `--resume` rather than start fresh.
//   2. taskmd.renderReworkPrompt — the focused rework prompt the resumed agent
//      reads, including the reviewer's note text.
//   3. The resume command selection + placeholder substitution from
//      dispatcher.dispatch's isResume branch: session_id set -> config.resumeCmd
//      (`--resume {{SESSION_ID}}`) substituted with the EXISTING id; session_id
//      null -> config.agentCmd (`--session-id <fresh uuid>`).
//
// Env is set before a dynamic import so config/db read our temp paths.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_ID = "test-dir";

// Modules loaded dynamically after env is set (see beforeAll).
let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let dispatchMod: typeof import("../src/dispatcher.ts");
let cfg: typeof import("../src/config.ts").config;

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-repo-"));

  // Set BEFORE importing so config.ts reads these at module-eval time.
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = ""; // no file logging during tests
  // `true` exits 0 with empty stdout: every herdr probe resolves to "not found",
  // so teardownTask et al. become harmless no-ops without a real herdr.
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  taskmdMod = await import("../src/taskmd.ts");
  cfg = (await import("../src/config.ts")).config;
  tasksMod = await import("../src/tasks.ts");
  dispatchMod = await import("../src/dispatcher.ts");

  // One registered workspace; every task lives under it.
  dbMod.db
    .query(
      `INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(DIR_ID, REPO_ROOT, "test", dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

/**
 * Seed a task: a DB row plus its on-disk task.md (the source of truth the
 * reject path reads/writes). Returns the task id.
 */
function seedTask(opts: {
  id: string;
  status: string;
  sessionId?: string | null;
}): string {
  const created = dbMod.nowIso();
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, session_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(opts.id, DIR_ID, opts.status, opts.sessionId ?? null, created);
  // task.md is authoritative for prompt + status; write a minimal one.
  taskmdMod.writeTaskMd(
    REPO_ROOT,
    { id: opts.id, created, status: opts.status as any, context: [] },
    `Implement feature for ${opts.id}.`,
  );
  // Front matter starts "in_progress"; align it with the seeded DB status.
  taskmdMod.updateTaskMdStatus(REPO_ROOT, opts.id, opts.status as any);
  return opts.id;
}

function dbRow(id: string) {
  return dbMod.db
    .query<any, [string]>(`SELECT * FROM tasks WHERE id=?`)
    .get(id)!;
}

describe("rejectTask", () => {
  test("in_review -> in_progress, persists note, PRESERVES session_id", async () => {
    const SESSION = "sess-preserve-1111-2222-3333";
    const id = seedTask({ id: "rej-ok", status: "in_review", sessionId: SESSION });
    const note = "Please fix the off-by-one in the loop bound.";

    const view = await tasksMod.rejectTask(id, note);

    // Returned view + DB row both flipped to in_progress (re-queued for --resume).
    expect(view.status).toBe("in_progress");
    const row = dbRow(id);
    expect(row.status).toBe("in_progress");

    // The note is persisted on the row for the resumed agent / UI.
    expect(row.review_note).toBe(note);

    // The whole point of resume: the existing session id is untouched, so the
    // dispatcher will `--resume` the same Claude session (not start fresh).
    expect(row.session_id).toBe(SESSION);

    // task.md records the rejection note and the in_progress status.
    const md = readFileSync(taskmdMod.taskMdPath(REPO_ROOT, id), "utf8");
    expect(md).toContain(note);
    expect(md).toContain("status: in_progress");
    expect(md).toContain("### Rejection");
  });

  test("note flows into renderReworkPrompt for the resumed agent", async () => {
    const id = seedTask({
      id: "rej-prompt",
      status: "in_review",
      sessionId: "sess-prompt-abcd",
    });
    const note = "Rename `foo` to `bar` and add a unit test.";
    await tasksMod.rejectTask(id, note);

    // The resumed agent reads the rework prompt rendered from the updated task.md.
    const doc = taskmdMod.readTaskMd(REPO_ROOT, id);
    const prompt = taskmdMod.renderReworkPrompt(REPO_ROOT, doc);
    expect(prompt).toContain(note);
    expect(prompt).toContain("request_review");
  });

  test("empty / whitespace note is rejected with HttpError 400", async () => {
    const id = seedTask({
      id: "rej-empty",
      status: "in_review",
      sessionId: "sess-empty",
    });

    for (const bad of ["", "   ", "\n\t "]) {
      let err: any;
      try {
        await tasksMod.rejectTask(id, bad);
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(err.status).toBe(400);
    }
    // Task untouched — still in_review, session id intact.
    const row = dbRow(id);
    expect(row.status).toBe("in_review");
    expect(row.session_id).toBe("sess-empty");
  });

  test("rejecting a task not in a feedback state errors with 409", async () => {
    for (const status of ["in_progress", "merged", "aborted"]) {
      const id = seedTask({
        id: `rej-bad-${status}`,
        status,
        sessionId: "sess-x",
      });
      let err: any;
      try {
        await tasksMod.rejectTask(id, "some note");
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(err.status).toBe(409);
      // Unchanged.
      expect(dbRow(id).status).toBe(status);
    }
  });

  test("rejecting a nonexistent task errors with 404", async () => {
    let err: any;
    try {
      await tasksMod.rejectTask("no-such-task", "note");
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.status).toBe(404);
  });
});

describe("renderReworkPrompt", () => {
  test("includes the review notes verbatim and the review protocol", () => {
    const notes = "Address the failing edge case when the list is empty.";
    const doc = taskmdMod.parseTaskMd(
      [
        "---",
        "id: rw-1",
        "created: 2026-01-01T00:00:00.000Z",
        "status: in_progress",
        "context: []",
        "---",
        "",
        "## Prompt",
        "",
        "Do the thing.",
        "",
        "## Review Notes",
        "",
        `### Rejection — 2026-01-01T00:00:00.000Z`,
        notes,
        "",
      ].join("\n"),
    );
    const prompt = taskmdMod.renderReworkPrompt(REPO_ROOT, doc);
    expect(prompt).toContain("Changes requested");
    expect(prompt).toContain(notes);
    // Focused rework prompt must point the agent back at request_review.
    expect(prompt).toContain("request_review");
  });

  test("falls back to a generic instruction when no notes are recorded", () => {
    const doc = taskmdMod.parseTaskMd(
      [
        "---",
        "id: rw-2",
        "created: 2026-01-01T00:00:00.000Z",
        "status: in_progress",
        "context: []",
        "---",
        "",
        "## Prompt",
        "",
        "Do the thing.",
        "",
      ].join("\n"),
    );
    const prompt = taskmdMod.renderReworkPrompt(REPO_ROOT, doc);
    expect(prompt).toContain("Changes were requested");
    expect(prompt).toContain("request_review");
  });
});

describe("dispatcher.resolveLaunchCommand", () => {
  // Exercises the REAL exported function that dispatch() calls — not a replica —
  // so the resume-vs-fresh rules + placeholder substitution can't silently drift.
  const PF = "/data/prompts/t.md";
  const MC = "/data/mcp/t.json";
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  test("config templates have the expected shapes", () => {
    expect(cfg.resumeCmd).toContain("--resume");
    expect(cfg.resumeCmd).toContain("{{SESSION_ID}}");
    expect(cfg.agentCmd).toContain("--session-id");
    expect(cfg.agentCmd).toContain("{{SESSION_ID}}");
  });

  test("rework (started_at + session_id) -> resumeCmd with the EXISTING id", () => {
    const EXISTING = "11111111-2222-3333-4444-555555555555";
    const r = dispatchMod.resolveLaunchCommand(
      { started_at: "2026-01-01T00:00:00.000Z", session_id: EXISTING } as any,
      PF,
      MC,
    );

    expect(r.isResume).toBe(true);
    expect(r.lostContext).toBe(false);
    // Existing session id reused — NOT regenerated.
    expect(r.sessionId).toBe(EXISTING);
    expect(r.agentCmd).toContain(`--resume ${EXISTING}`);
    expect(r.agentCmd).not.toContain("--session-id");
    // Placeholders fully substituted.
    expect(r.agentCmd).not.toContain("{{");
    expect(r.agentCmd).toContain(PF);
    expect(r.agentCmd).toContain(MC);
  });

  test("session_id is trimmed before being used as the --resume id", () => {
    const r = dispatchMod.resolveLaunchCommand(
      { started_at: "2026-01-01T00:00:00.000Z", session_id: "  abc-123  " } as any,
      PF,
      MC,
    );
    expect(r.isResume).toBe(true);
    expect(r.sessionId).toBe("abc-123");
    expect(r.agentCmd).toContain("--resume abc-123");
  });

  test("fresh task (no started_at, no session_id) -> agentCmd with a FRESH uuid", () => {
    const r = dispatchMod.resolveLaunchCommand(
      { started_at: null, session_id: null } as any,
      PF,
      MC,
    );

    expect(r.isResume).toBe(false);
    expect(r.lostContext).toBe(false);
    expect(r.sessionId).toMatch(UUID_RE);
    expect(r.agentCmd).toContain(`--session-id ${r.sessionId}`);
    expect(r.agentCmd).not.toContain("--resume");
    expect(r.agentCmd).not.toContain("{{");
    expect(r.agentCmd).toContain(PF);
  });

  test("inconsistent rework (started_at set, no session_id) -> fresh fallback + lostContext", () => {
    for (const bad of [null, "", "   "]) {
      const r = dispatchMod.resolveLaunchCommand(
        { started_at: "2026-01-01T00:00:00.000Z", session_id: bad } as any,
        PF,
        MC,
      );
      // Nothing to --resume into → fall back to a FRESH session, flagged so
      // dispatch() can log the lost in-session context.
      expect(r.isResume).toBe(false);
      expect(r.lostContext).toBe(true);
      expect(r.sessionId).toMatch(UUID_RE);
      expect(r.agentCmd).toContain(`--session-id ${r.sessionId}`);
      expect(r.agentCmd).not.toContain("--resume");
      expect(r.agentCmd).not.toContain("{{");
    }
  });
});
