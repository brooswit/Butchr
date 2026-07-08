// DIRECTIVE tier of the uniform UPDATE-instruction+NOTIFY verb (story st-7a7b0654 S3, RFC Q1
// directive machinery). A CEO DIRECTIVE is a repo-parented LEAF (`status='directive'`, a feedback
// state that NEVER runs an agent), so `updateWork`/`updateTask` reach it via the leaf path. Because
// createDirective stores the brief in BOTH the task.md `## Prompt` AND the `summary` column (the raw
// attention feed / CTO hook reads `summary`), the amend must rewrite BOTH so the two stay in
// lockstep — otherwise the re-surfaced directive would carry a stale hook.
//
// This suite pins:
//   (a) AMEND — updateWork on a directive rewrites task.md `## Prompt` AND the `summary` column and
//       appends the `### Amendment` audit note.
//   (b) RE-SURFACE — the amended directive re-surfaces to the repo's CTO (a `task.instruction_updated`
//       the CTO bridge emits with the NEW text); a story-scoped bridge never owns it.
//   (c) TERMINAL GUARD — an `accepted` directive (CTO already decomposed it) → 409.
//
// In-process, mirroring test/revamp4-a3-directive-machinery.test.ts: rows come from the real service
// functions + the db singleton (no live herdr/claude — BUTCHR_HERDR_BIN=true makes the best-effort
// leader launch a harmless no-op). The db/config singletons are SHARED across test files, so we use a
// DEDICATED dir + distinct ids.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_PATH: string;
const DIRD = "dir-upd-directive"; // the repo directives land under
let PROJ: string; // a project above the repo so a directive bubbles repo → cto → project → ceo

let dbMod: typeof import("../src/db.ts");
let tasksMod: typeof import("../src/tasks.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let workspacesMod: typeof import("../src/workspaces.ts");
let storiesMod: typeof import("../src/stories.ts");
let workApiMod: typeof import("../src/work-api.ts");
let eventsMod: typeof import("../src/events.ts");
let channelMod: typeof import("../src/channel.ts");

/** Run an async thunk and return the HttpError status it throws (or 0 if it did not throw). */
async function statusOf(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-upd-directive-"));
  REPO_PATH = join(DATA_DIR, "repoD");
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  delete process.env.BUTCHR_UNIFIED_WORK; // unified routing ON (default)

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  taskmdMod = await import("../src/taskmd.ts");
  workspacesMod = await import("../src/workspaces.ts");
  storiesMod = await import("../src/stories.ts");
  workApiMod = await import("../src/work-api.ts");
  eventsMod = await import("../src/events.ts");
  channelMod = await import("../src/channel.ts");

  // A registered repo, then materialize its repo node (the boot pass ran before this row existed).
  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIRD, REPO_PATH, DIRD, dbMod.nowIso());
  dbMod.migrateMaterializeRepoNodes();

  // A project above the repo so a directive bubbles repo → {cto} → project → {ceo} → {user}.
  PROJ = workspacesMod.createProject(DIRD).id;
  workspacesMod.registerRepoUnderProject(PROJ, DIRD);
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("update verb — DIRECTIVE tier (a) amend persists to BOTH task.md and summary", () => {
  test("rewrites task.md `## Prompt` AND the `summary` column + appends an `### Amendment` note", async () => {
    const d = storiesMod.createDirective(DIRD, "extract the session reader into a library");
    // Sanity: createDirective seeded both surfaces with the original brief.
    expect(tasksMod.getTask(d.id)!.summary).toBe("extract the session reader into a library");

    await workApiMod.updateWork(d.id, "extract BOTH the reader AND the harness, in that order");

    // task.md `## Prompt` carries the revised brief...
    const doc = taskmdMod.readTaskMd(REPO_PATH, d.id);
    expect(doc.prompt).toBe("extract BOTH the reader AND the harness, in that order");
    // ...the append-only audit trail records the amendment...
    expect(doc.raw).toContain("## Amendments");
    expect(doc.raw).toContain("### Amendment");
    expect(doc.raw).toContain("extract BOTH the reader AND the harness, in that order");
    // ...AND the `summary` column is kept in lockstep (the raw attention feed / CTO hook reads it).
    expect(tasksMod.getTask(d.id)!.summary).toBe(
      "extract BOTH the reader AND the harness, in that order",
    );
    // Still an OPEN directive — an amend is within-state, no transition.
    expect(tasksMod.getTask(d.id)!.status).toBe("directive");
    // The attention hook now reflects the new text (attentionDetail → row.summary for a directive).
    const item = tasksMod.attentionList().find((i) => i.id === d.id);
    expect(item!.reason).toBe("directive-triage");
    expect(item!.detail).toContain("extract BOTH the reader AND the harness, in that order");
  });
});

describe("update verb — DIRECTIVE tier (b) re-surfaces to the repo CTO with the new text", () => {
  test("publishes a `task.instruction_updated` the CTO bridge emits; a story bridge never owns it", async () => {
    const d = storiesMod.createDirective(DIRD, "publish the extracted libraries");

    const captured: any[] = [];
    const unsub = eventsMod.subscribe((e) => {
      if (e.type === "task.instruction_updated") captured.push(e);
    });
    try {
      await workApiMod.updateWork(d.id, "publish the libs to the internal registry first");
    } finally {
      unsub();
    }

    // Exactly one re-surface event, carrying the NEW brief as its detail.
    expect(captured.length).toBe(1);
    const ev = captured[0];
    expect(ev.detail).toBe("publish the libs to the internal registry first");
    expect((ev.task as any).id).toBe(d.id);
    // A repo-parented directive is CTO-owned: story_id null, responder 'cto'.
    expect((ev.task as any).story_id).toBeNull();
    expect((ev.task as any).pending_responder).toBe("cto");

    // The WORKSPACE/CTO bridge OWNS it and emits the notification with the amended text…
    const ctoBridge = new channelMod.AttentionBridge();
    const note = ctoBridge.consume(ev);
    expect(note).not.toBeNull();
    expect(note!.meta.state).toBe("instruction_updated");
    expect(note!.meta.task_id).toBe(d.id);
    expect(note!.content).toContain("re-read task.md");
    expect(note!.content).toContain("publish the libs to the internal registry first");

    // …while a STORY-scoped bridge NEVER owns a repo-parented (non-story) item.
    const storyBridge = new channelMod.AttentionBridge(DIRD, false, "some-story");
    expect(storyBridge.consume(ev)).toBeNull();
  });
});

describe("update verb — DIRECTIVE tier (c) an ACCEPTED directive is terminal → 409", () => {
  test("once the CTO accepted&decomposed it, a correction is a fresh directive, not an amend", async () => {
    const d = storiesMod.createDirective(DIRD, "tear out the harness");
    storiesMod.acceptDirective(d.id, [{ brief: "build the harness lib" }]);
    expect(tasksMod.getTask(d.id)!.status).toBe("accepted"); // terminal

    expect(await statusOf(() => workApiMod.updateWork(d.id, "actually, keep the harness inline"))).toBe(
      409,
    );
  });
});
