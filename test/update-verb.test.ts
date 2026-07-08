// Tests for the uniform UPDATE-instruction+NOTIFY verb (story st-7a7b0654) — the shared-core
// `updateWork` facade + the LEAF (subtask) tier end-to-end (tasks.updateTask). The verb FUSES
// the two halves that already existed but were never wired together: editTask rewrote task.md in
// place (passive `task.updated` only — the worker was never told), and nudgeTask steered a live
// pane (but never changed the instruction). updateTask AMENDS the brief AND delivers it based on
// WHERE the worker is: STEER a live agent, RE-SURFACE a parked item to its owner, or amend-only
// when it is ready-but-not-live.
//
// In-process: no real claude/herdr/git. A fake harness backend (setRunner) records every `send`
// so we assert the live-steer path pokes the pane and the parked/ready paths do NOT; the /proc
// liveness probe is injected (setCmdlineLister) so claudeAlive is deterministic; task.md is seeded
// on disk with writeTaskMd (no createTask, which would need a live git repo). The db/config
// singletons are SHARED across test files, so we use distinct ids and assert only on our own rows.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, SendInput } from "../src/harness.ts";

let DATA_DIR: string;
let REPO_ROOT: string;
const WS = "update-verb-ws";

let dbMod: typeof import("../src/db.ts");
let tasksMod: typeof import("../src/tasks.ts");
let taskmdMod: typeof import("../src/taskmd.ts");
let harnessMod: typeof import("../src/harness.ts");
let liveMod: typeof import("../src/liveness.ts");
let eventsMod: typeof import("../src/events.ts");
let workApiMod: typeof import("../src/work-api.ts");
let channelMod: typeof import("../src/channel.ts");
let originalRunner: AgentRunner;

let sends: Array<[string, SendInput]> = [];

function makeFakeRunner(): AgentRunner {
  const noop = async () => undefined as never;
  return new Proxy({} as AgentRunner, {
    get(_t, prop) {
      if (prop === "send") {
        return async (name: string, input: SendInput) => {
          sends.push([name, input]);
        };
      }
      return noop;
    },
  });
}

/** Seed a LEAF task: a DB row + an on-disk task.md. `extra` sets additional columns. */
function seedLeaf(
  id: string,
  status: string,
  extra: { has_agent?: number; session_id?: string; parent_id?: string } = {},
): void {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, has_agent, session_id, parent_id, work_kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'leaf', ?)`,
    )
    .run(
      id,
      WS,
      status,
      extra.has_agent ?? 0,
      extra.session_id ?? null,
      extra.parent_id ?? null,
      dbMod.nowIso(),
    );
  taskmdMod.writeTaskMd(
    REPO_ROOT,
    { id, created: dbMod.nowIso(), status: status as any, context: [], kind: "task" },
    "original brief",
  );
}

/** Seed a STORY NODE (work_kind='node') so a member leaf routes its feedback to the leader. */
function seedNode(id: string, status = "open"): void {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, work_kind, brief, created_at)
       VALUES (?, ?, ?, 'node', ?, ?)`,
    )
    .run(id, WS, status, "story brief", dbMod.nowIso());
}

function rowOf(id: string) {
  return tasksMod.getTask(id)!;
}

/** Run an async thunk and return the HttpError status it throws (or 0 if it didn't throw). */
async function statusOf(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-update-verb-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-update-verb-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  taskmdMod = await import("../src/taskmd.ts");
  harnessMod = await import("../src/harness.ts");
  liveMod = await import("../src/liveness.ts");
  eventsMod = await import("../src/events.ts");
  workApiMod = await import("../src/work-api.ts");
  channelMod = await import("../src/channel.ts");

  originalRunner = harnessMod.getRunner();
  harnessMod.setRunner(makeFakeRunner());

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(WS, REPO_ROOT, "update-verb", dbMod.nowIso());
});

afterEach(() => {
  sends = [];
  liveMod.setCmdlineLister(null);
});

afterAll(() => {
  harnessMod.setRunner(originalRunner);
  liveMod.setCmdlineLister(null);
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

describe("updateTask — (a) amend persists", () => {
  test("the task.md `## Prompt` is rewritten and an `### Amendment` audit entry is appended", async () => {
    seedLeaf("u-amend", "inactive");
    await tasksMod.updateTask("u-amend", "the revised, authoritative brief");
    const doc = taskmdMod.readTaskMd(REPO_ROOT, "u-amend");
    expect(doc.prompt).toBe("the revised, authoritative brief");
    // The append-only audit trail records WHAT changed, alongside the in-place body swap.
    expect(doc.raw).toContain("## Amendments");
    expect(doc.raw).toContain("### Amendment");
    expect(doc.raw).toContain("the revised, authoritative brief");
    // The view reflects the amended brief too.
    expect(tasksMod.taskView("u-amend")!.prompt).toBe("the revised, authoritative brief");
  });
});

describe("updateTask — (b) LIVE leaf is STEERED, not restarted", () => {
  test("a live agent is poked with the new brief; session + status preserved, no requeue", async () => {
    seedLeaf("u-live", "in_progress", { has_agent: 1, session_id: "sess-u-live" });
    // The /proc probe finds a live claude carrying this session id → claudeAlive == true.
    liveMod.setCmdlineLister(() => [["claude", "--session-id", "sess-u-live"]]);

    await tasksMod.updateTask("u-live", "fold in the new edge case");

    // Exactly one steer send, carrying the update signal + the new brief.
    expect(sends.length).toBe(1);
    const [name, input] = sends[0]!;
    expect(name).toBe("u-live");
    expect(input.enter).toBe(true);
    expect(input.text).toContain("UPDATED");
    expect(input.text).toContain("fold in the new edge case");
    expect(input.text).toContain("task.md"); // told to re-read its task.md
    // NOT restarted / requeued: status + agent + session are all preserved.
    const row = rowOf("u-live");
    expect(row.status).toBe("in_progress");
    expect(row.has_agent).toBe(1);
    expect(row.session_id).toBe("sess-u-live");
    // A within-state audit event was recorded (in_progress→in_progress), like nudgeTask.
    const evs = dbMod.listTaskEvents("u-live");
    expect(
      evs.some((e) => e.from_status === "in_progress" && e.to_status === "in_progress"),
    ).toBe(true);
    // The amendment still landed.
    expect(taskmdMod.readTaskMd(REPO_ROOT, "u-live").prompt).toBe("fold in the new edge case");
  });
});

describe("updateTask — (c) dead-shell live leaf is RECOVERED, not poked", () => {
  test("a live in_progress task whose claude is dead routes to requeueForResume, not a send", async () => {
    seedLeaf("u-dead", "in_progress", { has_agent: 1, session_id: "sess-u-dead" });
    // The probe RAN (processes present) but NONE carry the session id → provably dead shell.
    liveMod.setCmdlineLister(() => [["claude", "--session-id", "some-other-session"]]);

    await tasksMod.updateTask("u-dead", "revised brief while the shell is dead");

    // No pane poke — the husk is torn down + re-dispatched instead.
    expect(sends).toEqual([]);
    const row = rowOf("u-dead");
    expect(row.status).toBe("inactive"); // requeued as READY for a fresh dispatch/resume
    expect(row.has_agent).toBe(0);
    // The amendment still landed (the agent re-grounds on the fresh task.md when it relaunches).
    expect(taskmdMod.readTaskMd(REPO_ROOT, "u-dead").prompt).toBe(
      "revised brief while the shell is dead",
    );
  });
});

describe("updateTask — (d) PARKED leaf re-surfaces to its owner", () => {
  test("an in_review subtask publishes a `task.instruction_updated` the LEADER bridge emits", async () => {
    seedNode("u-story");
    seedLeaf("u-parked", "in_review", { parent_id: "u-story" });

    // Capture the one-shot re-surface event updateTask publishes.
    const captured: any[] = [];
    const unsub = eventsMod.subscribe((e) => {
      if (e.type === "task.instruction_updated") captured.push(e);
    });
    try {
      await tasksMod.updateTask("u-parked", "please also cover the empty-input case");
    } finally {
      unsub();
    }

    // A parked item is NOT poked (no live agent) — it is re-surfaced instead.
    expect(sends).toEqual([]);
    expect(captured.length).toBe(1);
    const ev = captured[0];
    expect(ev.detail).toBe("please also cover the empty-input case");
    expect((ev.task as any).id).toBe("u-parked");
    // Sanity: the carried TaskView routes to the leader (story member → responder 'story').
    expect((ev.task as any).story_id).toBe("u-story");
    expect((ev.task as any).pending_responder).toBe("story");

    // The STORY-leader bridge (scopeStory === the node) OWNS it and emits the notification…
    const leaderBridge = new channelMod.AttentionBridge(WS, false, "u-story");
    const note = leaderBridge.consume(ev);
    expect(note).not.toBeNull();
    expect(note!.meta.state).toBe("instruction_updated");
    expect(note!.meta.task_id).toBe("u-parked");
    expect(note!.meta.story_id).toBe("u-story");
    expect(note!.content).toContain("re-read task.md");
    expect(note!.content).toContain("please also cover the empty-input case");

    // …while the WORKSPACE/CTO bridge NEVER sees a story member's item.
    const ctoBridge = new channelMod.AttentionBridge(WS);
    expect(ctoBridge.consume(ev)).toBeNull();
  });
});

describe("updateTask — (e) READY-but-not-live is amend-only", () => {
  test("an inactive task is amended with NO steer and NO re-surface event", async () => {
    seedLeaf("u-ready", "inactive");
    const captured: any[] = [];
    const unsub = eventsMod.subscribe((e) => {
      if (e.type === "task.instruction_updated") captured.push(e);
    });
    try {
      await tasksMod.updateTask("u-ready", "brief the dispatcher will pick up");
    } finally {
      unsub();
    }
    expect(sends).toEqual([]); // no steer — nothing is live
    expect(captured).toEqual([]); // no re-surface — it is not parked in feedback
    expect(rowOf("u-ready").status).toBe("inactive"); // untouched
    // The amendment landed; the agent reads the fresh task.md when it dispatches.
    expect(taskmdMod.readTaskMd(REPO_ROOT, "u-ready").prompt).toBe(
      "brief the dispatcher will pick up",
    );
  });
});

describe("updateTask — (f) guards + validation", () => {
  test("404 when the task is gone", async () => {
    expect(await statusOf(() => tasksMod.updateTask("nope", "x"))).toBe(404);
  });

  test("400 on a blank/missing brief", async () => {
    seedLeaf("u-blank", "inactive");
    expect(await statusOf(() => tasksMod.updateTask("u-blank", "   "))).toBe(400);
    expect(await statusOf(() => tasksMod.updateTask("u-blank", undefined))).toBe(400);
  });

  test("409 on a terminal (merged) task — a correction is a fresh directive/story", async () => {
    seedLeaf("u-merged", "merged");
    expect(await statusOf(() => tasksMod.updateTask("u-merged", "x"))).toBe(409);
  });

  test("409 on an aborted task", async () => {
    seedLeaf("u-aborted", "aborted");
    expect(await statusOf(() => tasksMod.updateTask("u-aborted", "x"))).toBe(409);
  });

  test("409 on a rolling_back task (mid-rollback pipeline, not an operator's to refine)", async () => {
    seedLeaf("u-rolling", "rolling_back");
    expect(await statusOf(() => tasksMod.updateTask("u-rolling", "x"))).toBe(409);
  });
});

describe("updateWork facade — kind routing", () => {
  test("a LEAF routes through to updateTask (amend persists)", async () => {
    seedLeaf("u-facade", "inactive");
    await workApiMod.updateWork("u-facade", "amended via the work facade");
    expect(taskmdMod.readTaskMd(REPO_ROOT, "u-facade").prompt).toBe("amended via the work facade");
  });

  test("a NODE is a 409 seam (the story/directive tiers land in S2/S3)", async () => {
    seedNode("u-node");
    expect(await statusOf(() => workApiMod.updateWork("u-node", "x"))).toBe(409);
  });
});
