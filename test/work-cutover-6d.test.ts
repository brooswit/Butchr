// WORK + WORKSPACE UNIFICATION — STEP 6d CUTOVER (story st-540ba705): make `/api/work` the
// TRUE SUPERSET of the split `/api/tasks/*` + `/api/stories/*` surfaces, so nothing is stranded
// when those routes are deleted in the later 6e cutover. This proves the PARITY OPS added to
// src/work-api.ts in this step:
//
//   - LEAF read ops — diffWork / readinessWork / estimateWork / eventsWork — dispatch to the
//     task read ops and 409 on a NODE.
//   - LEAF action ops — specWork / planApproveWork / planRejectWork / versionBumpWork /
//     confirmMajorWork / abortWork / nudgeWork / requeueWork / reparentWork — dispatch to the
//     task ops and 409 on a NODE.
//   - NODE ops — deleteWork / resetWork — dispatch to the story ops and 409 on a LEAF.
//   - createWorkspaceRollback — the workspace-level ROLLBACK LEAF (the "Roll back" flow over the
//     unified surface), creating a real rollback task.
//   - assertWorkLeaf — the exported guard the server-local session/terminal routes share.
//
// In-process + isolated like work-api.test.ts: a private BUTCHR_DB (NEVER the live db) and
// BUTCHR_HERDR_BIN=`true` so every herdr probe (incl. the story-leader launch hook) is a no-op.
// No op here exercises a merge / re-gate path, so the CI / verify runners never fire — but we
// set the workspace gate_cmd="" anyway (the sanctioned belt-and-suspenders) so a stray gate
// could never run a real build against the test box.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
// Distinct id — the db/config singletons are shared across test files.
const WS = "work6d-ws";

let workApi: typeof import("../src/work-api.ts");
let storiesMod: typeof import("../src/stories.ts");
let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-work6d-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-work6d-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  const g = (args: string[]) =>
    execFileSync("git", ["-C", REPO_ROOT, ...args], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  g(["commit", "--allow-empty", "-q", "-m", "init"]);

  dbMod = await import("../src/db.ts");
  storiesMod = await import("../src/stories.ts");
  tasksMod = await import("../src/tasks.ts");
  workApi = await import("../src/work-api.ts");

  // WS lives at the git repo root (createTask makes worktrees there). gate_cmd="" so no gate
  // command could ever run during this test.
  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, gate_cmd, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(WS, REPO_ROOT, "main", "", dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

/** Capture the HttpError status thrown by a sync call, or undefined if it returns. */
function syncStatusOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { status?: number }).status;
  }
  return undefined;
}

/** Capture the HttpError status thrown by an async call, or undefined if it resolves. */
async function statusOf(fn: () => Promise<unknown>): Promise<number | undefined> {
  try {
    await fn();
  } catch (e) {
    return (e as { status?: number }).status;
  }
  return undefined;
}

describe("LEAF read ops dispatch to the task reads and 409 on a NODE", () => {
  test("eventsWork / estimateWork return real data for a leaf; both 409 on a node", async () => {
    const node = workApi.createWork(WS, "read-ops story");
    const leaf = await workApi.createWorkChild(node.id, { prompt: "read-ops leaf" });

    // eventsWork → the task's status-transition timeline (at least its creation event).
    const events = workApi.eventsWork(leaf.id);
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);

    // estimateWork → { single, chain } (a leaf with no blockers has a null chain).
    const est = workApi.estimateWork(leaf.id);
    expect(est).toHaveProperty("single");
    expect(est).toHaveProperty("chain");
    expect(est.chain).toBeNull();

    // Every leaf read op 409s on a NODE (the requireLeaf guard fires).
    expect(syncStatusOf(() => workApi.eventsWork(node.id))).toBe(409);
    expect(syncStatusOf(() => workApi.estimateWork(node.id))).toBe(409);
    expect(await statusOf(() => workApi.diffWork(node.id))).toBe(409);
    expect(await statusOf(() => workApi.readinessWork(node.id))).toBe(409);
  });
});

describe("LEAF action ops dispatch to the task ops and 409 on a NODE", () => {
  test("specWork advances an `idea` leaf to spec_review; 409 on a node", async () => {
    const node = workApi.createWork(WS, "spec story");
    const idea = await workApi.createWorkChild(node.id, { prompt: "a brief", idea: true });
    expect(idea.status).toBe("idea");

    const after = await workApi.specWork(idea.id, "## Spec\nDo the thing precisely.");
    expect(after.status).toBe("spec_review");

    expect(await statusOf(() => workApi.specWork(node.id, "x"))).toBe(409);
  });

  test("versionBumpWork sets a leaf's declared bump; 409 on a node", async () => {
    const node = workApi.createWork(WS, "bump story");
    const leaf = await workApi.createWorkChild(node.id, { prompt: "bump leaf" });

    const after = workApi.versionBumpWork(leaf.id, "minor");
    expect(after.version_bump).toBe("minor");
    expect(tasksMod.taskView(leaf.id)!.version_bump).toBe("minor");

    expect(syncStatusOf(() => workApi.versionBumpWork(node.id, "minor"))).toBe(409);
  });

  test("reparentWork re-points / clears a leaf's parent; 409 on a node", async () => {
    const n1 = workApi.createWork(WS, "reparent src");
    const n2 = workApi.createWork(WS, "reparent dst");
    const leaf = await workApi.createWorkChild(n1.id, { prompt: "reparent leaf" });
    expect(leaf.story_id).toBe(n1.id);

    const moved = workApi.reparentWork(leaf.id, n2.id);
    expect(moved.story_id).toBe(n2.id);
    const cleared = workApi.reparentWork(leaf.id, null);
    expect(cleared.story_id).toBeNull();

    expect(syncStatusOf(() => workApi.reparentWork(n1.id, null))).toBe(409);
  });

  test("abortWork aborts a leaf; 409 on a node", async () => {
    const node = workApi.createWork(WS, "abort story");
    const leaf = await workApi.createWorkChild(node.id, { prompt: "abort leaf" });

    const aborted = await workApi.abortWork(leaf.id);
    expect(aborted.status).toBe("aborted");

    expect(await statusOf(() => workApi.abortWork(node.id))).toBe(409);
  });

  test("plan / confirm-major / nudge / requeue route to the leaf path and 409 on a node", async () => {
    const node = workApi.createWork(WS, "leaf-only verbs story");
    const leaf = await workApi.createWorkChild(node.id, { prompt: "leaf-only verbs leaf" });

    // On a fresh leaf each underlying op throws its OWN guard (the task is not at the plan
    // step / not a release-mode major / has no live agent / is not stuck) — i.e. the verb
    // demonstrably dispatched to the LEAF path rather than being swallowed by a node guard.
    expect(await statusOf(() => workApi.planApproveWork(leaf.id))).toBe(409);
    expect(await statusOf(() => workApi.planRejectWork(leaf.id, "redo"))).toBe(409);
    expect(await statusOf(() => workApi.confirmMajorWork(leaf.id))).toBe(409);
    expect(await statusOf(() => workApi.nudgeWork(leaf.id))).toBe(409);

    // On a NODE every one of them is stopped by the requireLeaf guard (also 409, but BEFORE
    // the task op) — proving the node never reaches a leaf op.
    expect(await statusOf(() => workApi.planApproveWork(node.id))).toBe(409);
    expect(await statusOf(() => workApi.planRejectWork(node.id, "redo"))).toBe(409);
    expect(await statusOf(() => workApi.confirmMajorWork(node.id))).toBe(409);
    expect(await statusOf(() => workApi.nudgeWork(node.id))).toBe(409);
    expect(await statusOf(() => workApi.requeueWork(node.id))).toBe(409);
  });
});

describe("NODE ops dispatch to the story ops and 409 on a LEAF", () => {
  test("resetWork resets a node; 409 on a leaf", async () => {
    const node = workApi.createWork(WS, "reset story");
    const leaf = await workApi.createWorkChild(node.id, { prompt: "reset leaf" });

    const r = await workApi.resetWork(node.id);
    expect(r.ok).toBe(true);

    expect(await statusOf(() => workApi.resetWork(leaf.id))).toBe(409);
  });

  test("deleteWork deletes a node (its leaves are detached, not deleted); 409 on a leaf", async () => {
    const node = workApi.createWork(WS, "delete story");
    const leaf = await workApi.createWorkChild(node.id, { prompt: "detach me" });

    workApi.deleteWork(node.id);
    expect(storiesMod.getStory(node.id)).toBeNull();
    // The member leaf survives — only its parent grouping is gone.
    expect(tasksMod.getTask(leaf.id)).not.toBeNull();

    expect(syncStatusOf(() => workApi.deleteWork(leaf.id))).toBe(409);
  });
});

describe("createWorkspaceRollback — the workspace-level ROLLBACK LEAF (Roll back flow)", () => {
  test("creates a real rollback task pinned to the workspace, no parent", async () => {
    const view = await workApi.createWorkspaceRollback(WS, { prompt: "revert the bad change" });
    expect(view.kind).toBe("rollback");
    expect(view.workspace_id).toBe(WS);
    expect(view.story_id).toBeNull();
    expect(view.status).toBe("inactive");
  });

  test("404s on an unknown workspace", async () => {
    expect(await statusOf(() => workApi.createWorkspaceRollback("no-ws", { prompt: "x" }))).toBe(404);
  });
});

describe("assertWorkLeaf — the shared guard for the server-local session/terminal routes", () => {
  test("returns the task row for a leaf, 409 on a node, 404 on an unknown id", async () => {
    const node = workApi.createWork(WS, "guard story");
    const leaf = await workApi.createWorkChild(node.id, { prompt: "guard leaf" });

    const row = workApi.assertWorkLeaf(leaf.id, "read output for");
    expect(row.id).toBe(leaf.id);

    expect(syncStatusOf(() => workApi.assertWorkLeaf(node.id, "read output for"))).toBe(409);
    expect(syncStatusOf(() => workApi.assertWorkLeaf("ghost", "read output for"))).toBe(404);
  });
});
