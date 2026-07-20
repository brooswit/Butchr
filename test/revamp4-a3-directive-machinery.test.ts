// RFC Q1 — Phase A3: CEO DIRECTIVE MACHINERY (RE-DO of aborted zippy-puma-66bb). The CORRECTED
// delegation model: the CEO DIRECTS a repo's CTO (createDirective → a `directive`-status leaf under
// the repo node); that CTO either ACCEPT&DECOMPOSEs it into stories (acceptDirective → `accepted`) or
// PUSHES BACK via the EXISTING escalate verb. ADDITIVE + INERT — nothing calls createDirective yet
// (B1 flips the initiative surfaces onto it).
//
// This suite pins:
//   A. STATUS SEMANTICS — directive = feedback / awaits-CTO / in ATTENTION_STATES / not terminal;
//      accepted = idle / terminal / NOT an attention state.
//   B. createDirective — a `directive` leaf parented UNDER the repo node, carrying the brief (task.md
//      prompt + summary) + the shared initiative_id; NO worktree; routes to the repo's CTO via the
//      existing structural responder; surfaces on the attention feed + the CTO channel.
//   C. createDirective validation — 400 blank brief/repo, 404 gone repo, 409 non-repo id.
//   D. acceptDirective — creates 1+ stories under the repo (each stamped the directive's
//      initiative_id, reparented onto the repo node), transitions directive → accepted; validate-all-
//      first + atomic CAS-claim is race-safe (a second accept 409s, no double-create).
//   E. PUSH-BACK — the existing escalate verb (escalateTask) applies to a directive (it is
//      isAwaitingFeedback); no new escalate code.
//
// Pure / in-process: rows are created via the real service functions + the db singleton (no live
// herdr/claude — BUTCHR_HERDR_BIN=true makes the best-effort leader launch a harmless no-op). The
// db/config singletons are SHARED across test files, so we use a DEDICATED dir + distinct ids.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
const DIRA = "dir-a3-a"; // the repo directives land under
let PROJ: string; // a project node anchored to DIRA (so the repo bubbles repo → cto → project → ceo)

let dbMod: typeof import("../src/db.ts");
let tasksMod: typeof import("../src/tasks.ts");
let workMod: typeof import("../src/work.ts");
let workspacesMod: typeof import("../src/workspaces.ts");
let storiesMod: typeof import("../src/stories.ts");
let channelMod: typeof import("../src/channel.ts");

/** Run `fn` and return the HttpError status it throws (or 0 if it does not throw). */
function statusOf(fn: () => unknown): number {
  try {
    fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-a3-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  delete process.env.BUTCHR_UNIFIED_WORK; // unified routing ON (default)

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  workMod = await import("../src/work.ts");
  workspacesMod = await import("../src/workspaces.ts");
  storiesMod = await import("../src/stories.ts");
  channelMod = await import("../src/channel.ts");

  // A registered repo (via the writable `workspaces` view → `directory` table), then materialize its
  // repo node (the boot pass at import time ran before this row existed).
  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIRA, join(DATA_DIR, "repoA"), DIRA, dbMod.nowIso());
  dbMod.migrateMaterializeRepoNodes();

  // A project node above the repo, then register the repo under it — so a directive/story bubbles
  // repo → {cto} → project → {ceo} → {user}.
  PROJ = workspacesMod.createProject().id;
  workspacesMod.registerRepoUnderProject(PROJ, DIRA);
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// --- A. Status semantics -----------------------------------------------------
describe("A3 — directive/accepted status semantics", () => {
  test("directive = feedback / awaits-CTO / attention state / NOT terminal", () => {
    expect(dbMod.STATE_META.directive).toEqual({ kind: "feedback" });
    expect(dbMod.isTerminal("directive")).toBe(false);
    expect([...dbMod.ATTENTION_STATES]).toContain("directive");
    // A directive row is AWAITING FEEDBACK — it bubbles up the responder chain.
    const row = { status: "directive", idle: 0, needs_user_input: 0 } as never;
    expect(tasksMod.isAwaitingFeedback(row)).toBe(true);
  });

  test("accepted = idle / terminal / NOT an attention state / not awaiting feedback", () => {
    expect(dbMod.STATE_META.accepted).toEqual({ kind: "idle" });
    expect(dbMod.isTerminal("accepted")).toBe(true);
    expect([...dbMod.ATTENTION_STATES]).not.toContain("accepted");
    const row = { status: "accepted", idle: 0, needs_user_input: 0 } as never;
    expect(tasksMod.isAwaitingFeedback(row)).toBe(false);
  });
});

// --- B. createDirective ------------------------------------------------------
describe("A3 — createDirective", () => {
  test("creates a `directive` leaf UNDER the repo node carrying the brief + initiative_id", () => {
    const d = storiesMod.createDirective(DIRA, "extract the session reader into a library", "ini-a3-1");
    expect(d.status).toBe("directive");
    expect(d.work_kind).toBe("leaf");
    expect(d.parent_id).toBe(DIRA); // parented UNDER the repo node
    expect(d.workspace_id).toBe(DIRA);
    expect(d.initiative_id).toBe("ini-a3-1");
    // The brief is mirrored onto the summary column for the raw-row attention feed...
    expect(d.summary).toBe("extract the session reader into a library");
    // ...and written to task.md as the prompt (what the CTO channel surfaces).
    const view = tasksMod.taskView(d.id)!;
    expect(view.prompt).toContain("extract the session reader into a library");
  });

  test("routes to the repo's CTO via the EXISTING structural responder (zero new routing)", () => {
    const d = storiesMod.createDirective(DIRA, "gut the consumer + depend on the lib");
    expect(workMod.resolveWorkResponder(d.id)).toEqual({ kind: "cto" });
    // Full ladder: repo → {cto} → project → {ceo} → {user} (the repo is registered under PROJ).
    expect(workMod.workResponderChain(d.id)).toEqual([
      { kind: "cto" },
      { kind: "ceo", project_id: PROJ },
      { kind: "user" },
    ]);
    expect(d.initiative_id).toBeNull(); // ungrouped single-repo directive
  });

  test("surfaces on the /api/attention pull feed as `directive-triage` (CTO responder)", () => {
    const d = storiesMod.createDirective(DIRA, "sequence libs before the consumer");
    const item = tasksMod.attentionList().find((i) => i.id === d.id);
    expect(item).toBeDefined();
    expect(item!.reason).toBe("directive-triage");
    expect(item!.status).toBe("directive");
    expect(item!.pending_responder).toBe("cto");
    expect(item!.story_id).toBeNull(); // a repo-parented top-level item is CTO-owned, not a story member
    expect(item!.detail).toContain("sequence libs before the consumer");
  });

  test("the CTO channel surfaces it with the `CEO directive` phrase + the brief, routed to the CTO", () => {
    const d = storiesMod.createDirective(DIRA, "publish the extracted libraries");
    const bridge = new channelMod.AttentionBridge();
    const note = bridge.consume({ type: "task.updated", task: tasksMod.taskView(d.id)! });
    expect(note).not.toBeNull();
    expect(note!.meta.state).toBe("directive");
    expect(note!.content).toContain("CEO directive");
    expect(note!.content).toContain("publish the extracted libraries");
    // A standalone (repo-parented) item carries neither story_id nor project_id in meta (CTO feed).
    expect(note!.meta.story_id).toBeUndefined();
    expect(note!.meta.project_id).toBeUndefined();
  });
});

// --- C. createDirective validation -------------------------------------------
describe("A3 — createDirective validation", () => {
  test("400 blank brief / blank repo id; 404 gone repo; 409 non-repo id", () => {
    expect(statusOf(() => storiesMod.createDirective(DIRA, "   "))).toBe(400);
    expect(statusOf(() => storiesMod.createDirective("", "hi"))).toBe(400);
    expect(statusOf(() => storiesMod.createDirective("dir-a3-nope", "hi"))).toBe(404);
    // A project id is a real node but not a `work_kind='repo'` node → 409.
    expect(statusOf(() => storiesMod.createDirective(PROJ, "hi"))).toBe(409);
  });
});

// --- D. acceptDirective ------------------------------------------------------
describe("A3 — acceptDirective (accept & decompose)", () => {
  test("creates stories under the repo (stamped initiative_id, reparented) + directive → accepted", () => {
    const d = storiesMod.createDirective(DIRA, "tear out the harness", "ini-a3-accept");
    const res = storiesMod.acceptDirective(d.id, [
      { brief: "build the harness lib" },
      { brief: "gut the consumer to depend on it" },
    ]);
    expect(res.directive_id).toBe(d.id);
    expect(res.initiative_id).toBe("ini-a3-accept");
    expect(res.stories.length).toBe(2);
    for (const s of res.stories) {
      const node = tasksMod.getTask(s.id)!;
      expect(node.work_kind).toBe("node"); // a real story node
      expect(node.status).toBe("open");
      expect(node.parent_id).toBe(DIRA); // reparented onto the repo node (bubbles to the CTO)
      expect(node.initiative_id).toBe("ini-a3-accept"); // inherited the directive's grouping key
      expect(node.workspace_id).toBe(DIRA);
    }
    // The directive itself is now DONE — terminal `accepted`, off the attention feed.
    expect(tasksMod.getTask(d.id)!.status).toBe("accepted");
    expect(tasksMod.attentionList().some((i) => i.id === d.id)).toBe(false);
  });

  test("an ungrouped directive yields stories with NO initiative_id", () => {
    const d = storiesMod.createDirective(DIRA, "one-off cleanup"); // no initiative_id
    const res = storiesMod.acceptDirective(d.id, [{ brief: "do the cleanup" }]);
    expect(res.initiative_id).toBeNull();
    expect(tasksMod.getTask(res.stories[0]!.id)!.initiative_id).toBeNull();
  });

  test("RACE-SAFE: a second accept 409s (the CAS-claim lost the race) — no double-create", () => {
    const d = storiesMod.createDirective(DIRA, "race me");
    storiesMod.acceptDirective(d.id, [{ brief: "first winner" }]);
    // The directive is now `accepted` — a second accept can't re-claim it.
    expect(statusOf(() => storiesMod.acceptDirective(d.id, [{ brief: "loser" }]))).toBe(409);
    // Exactly one story exists under this initiative-less directive's repo for "first winner".
    const winners = storiesMod
      .listStories(DIRA)
      .filter((s) => s.brief === "first winner");
    expect(winners.length).toBe(1);
  });

  test("400 empty/blank target set; validate-all-first leaves the directive UNCLAIMED on a bad brief", () => {
    const d = storiesMod.createDirective(DIRA, "validate me");
    expect(statusOf(() => storiesMod.acceptDirective(d.id, []))).toBe(400);
    expect(statusOf(() => storiesMod.acceptDirective(d.id, "nope"))).toBe(400);
    // A blank brief among the targets rejects the WHOLE accept BEFORE the CAS-claim — the directive
    // stays `directive` (no half-decompose, no leaked story).
    expect(
      statusOf(() => storiesMod.acceptDirective(d.id, [{ brief: "ok" }, { brief: "  " }])),
    ).toBe(400);
    expect(tasksMod.getTask(d.id)!.status).toBe("directive");
    expect(storiesMod.listStories(DIRA).some((s) => s.brief === "ok")).toBe(false);
  });

  test("404 a gone directive; 409 a non-directive work item", () => {
    expect(statusOf(() => storiesMod.acceptDirective("nope-nope", [{ brief: "x" }]))).toBe(404);
    // The repo node itself is not a directive-status leaf → 409.
    expect(statusOf(() => storiesMod.acceptDirective(DIRA, [{ brief: "x" }]))).toBe(409);
  });
});

// --- E. Push-back reuses the existing escalate verb --------------------------
describe("A3 — push-back reuses the existing escalate verb", () => {
  test("escalateTask applies to a directive (it is isAwaitingFeedback) — no new escalate code", () => {
    const d = storiesMod.createDirective(DIRA, "push me back");
    // The directive is escalatable via the EXISTING leaf escalate — it stays `directive`, but the
    // responder advances toward the user (escalated_to_user), exactly like any feedback item.
    const out = tasksMod.escalateTask(d.id);
    expect(out.status).toBe("directive");
    expect(tasksMod.getTask(d.id)!.escalated_to_user).toBe(1);
  });
});
