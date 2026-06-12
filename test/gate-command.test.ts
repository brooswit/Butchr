// Tests for the PER-WORKSPACE BUILD/TEST GATE COMMAND and the CROSS-PROJECT
// DASHBOARD aggregation (see db.ts `workspaces.gate_cmd`, workspaces.{
// workspaceGateCmd, updateWorkspaceGateCmd, dashboard}, and how triggerCi threads
// the resolved command into the CI runner).
//
// Pure / in-process: no real claude/herdr/bun is spawned. BUTCHR_HERDR_BIN points at
// `true` so herdr probes are no-ops, and the CI runner is faked (setCiRunner) so we
// capture the gate command threaded in without shelling out. Workspace + task rows
// are inserted directly (no registerWorkspace, which would need a live herdr).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
// Distinct ids — the db/config singletons are shared across test files.
const DIR_A = "gate-dir-a";
const DIR_B = "gate-dir-b";

let dirsMod: typeof import("../src/workspaces.ts");
let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let configMod: typeof import("../src/config.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-gate-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-gate-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  configMod = await import("../src/config.ts");
  dirsMod = await import("../src/workspaces.ts");
  tasksMod = await import("../src/tasks.ts");

  const ins = (id: string) =>
    dbMod.db
      .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, join(REPO_ROOT, id), id, dbMod.nowIso());
  ins(DIR_A);
  ins(DIR_B);
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

/** Seed a bare task row in a workspace with a given status (+ optional idle flag + optional pane id). */
function seedTask(id: string, dir: string, status: string, idle = 0, paneId: string | null = null) {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, idle, herdr_pane_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, dir, status, idle, paneId, dbMod.nowIso());
}

describe("workspaceGateCmd resolution", () => {
  test("falls back to the default (config.verifyCmd) when gate_cmd is NULL", () => {
    // No override set on DIR_A → the global default command.
    expect(dirsMod.workspaceGateCmd(DIR_A)).toBe(configMod.config.verifyCmd);
  });

  test("an unknown workspace id falls back to the default", () => {
    expect(dirsMod.workspaceGateCmd("does-not-exist")).toBe(configMod.config.verifyCmd);
  });

  test("returns the workspace's own command once set", () => {
    dirsMod.updateWorkspaceGateCmd(DIR_A, "make build && make test");
    expect(dirsMod.workspaceGateCmd(DIR_A)).toBe("make build && make test");
    // Persisted on the row.
    const row = dbMod.db
      .query<{ gate_cmd: string | null }, [string]>(`SELECT gate_cmd FROM workspaces WHERE id=?`)
      .get(DIR_A)!;
    expect(row.gate_cmd).toBe("make build && make test");
  });

  test("an empty-string override DISABLES the gate (used verbatim, not defaulted)", () => {
    dirsMod.updateWorkspaceGateCmd(DIR_A, "");
    expect(dirsMod.workspaceGateCmd(DIR_A)).toBe("");
  });

  test("clearing the override (null) reverts to the default", () => {
    dirsMod.updateWorkspaceGateCmd(DIR_A, "x");
    expect(dirsMod.workspaceGateCmd(DIR_A)).toBe("x");
    dirsMod.updateWorkspaceGateCmd(DIR_A, null);
    expect(dirsMod.workspaceGateCmd(DIR_A)).toBe(configMod.config.verifyCmd);
    const row = dbMod.db
      .query<{ gate_cmd: string | null }, [string]>(`SELECT gate_cmd FROM workspaces WHERE id=?`)
      .get(DIR_A)!;
    expect(row.gate_cmd).toBeNull();
  });

  test("updateWorkspaceGateCmd 404s on an unknown workspace", () => {
    expect(() => dirsMod.updateWorkspaceGateCmd("nope", "cmd")).toThrow(/workspace not found/);
  });

  test("a non-string gate_cmd is rejected (400)", () => {
    expect(() => dirsMod.updateWorkspaceGateCmd(DIR_A, 42)).toThrow(/must be a string/);
  });
});

describe("triggerCi threads the resolved gate command into the runner", () => {
  test("passes the workspace's own gate command to the CI runner", async () => {
    dirsMod.updateWorkspaceGateCmd(DIR_B, "npm run ci");
    const id = "gate-ci-own";
    seedTask(id, DIR_B, "in_review");
    mkdirSync(join(REPO_ROOT, DIR_B, id), { recursive: true }); // worktree so CI runs

    let seen: string | undefined;
    tasksMod.setCiRunner(async (_dir, _taskId, gateCmd) => {
      seen = gateCmd;
      return { status: "pass", label: "gate passed", detail: "" };
    });
    await tasksMod.triggerCi(id);
    expect(seen).toBe("npm run ci");
  });

  test("with no override, passes the default command to the CI runner", async () => {
    dirsMod.updateWorkspaceGateCmd(DIR_B, null); // clear → default
    const id = "gate-ci-default";
    seedTask(id, DIR_B, "in_review");
    mkdirSync(join(REPO_ROOT, DIR_B, id), { recursive: true });

    let seen: string | undefined;
    tasksMod.setCiRunner(async (_dir, _taskId, gateCmd) => {
      seen = gateCmd;
      return { status: "pass", label: "gate passed", detail: "" };
    });
    await tasksMod.triggerCi(id);
    expect(seen).toBe(configMod.config.verifyCmd);
  });
});

describe("dashboard aggregation", () => {
  // A fresh workspace so the bucket math is isolated from rows seeded above.
  const DIR_C = "gate-dash-c";
  beforeAll(() => {
    dbMod.db
      .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
      .run(DIR_C, join(REPO_ROOT, DIR_C), "Dash C", dbMod.nowIso());
    seedTask("dc-q", DIR_C, "in_progress");          // ready (no pane) → in_progress bucket
    seedTask("dc-b", DIR_C, "blocked");              // blocked bucket
    seedTask("dc-r", DIR_C, "in_progress", 0, "pane-dc-r"); // live agent (non-idle) → in_progress
    seedTask("dc-i", DIR_C, "in_progress", 1, "pane-dc-i"); // idle (in_progress + pane + idle flag)
    seedTask("dc-f", DIR_C, "finalizing");           // finalizing bucket
    seedTask("dc-rev", DIR_C, "in_review");          // review/feedback bucket
    seedTask("dc-merged", DIR_C, "merged");          // terminal — not counted in any bucket
    seedTask("dc-abort", DIR_C, "aborted");          // terminal
  });

  test("folds per-status counts into active / review / failed / needs-attention", () => {
    const d = dirsMod.dashboard();
    const c = d.workspaces.find((x) => x.id === DIR_C)!;
    expect(c).toBeTruthy();
    // active = in_progress(dc-q, dc-r) + idle(dc-i) + blocked(dc-b) + finalizing(dc-f) = 5
    expect(c.active).toBe(5);
    // review = in_review(dc-rev) = 1
    expect(c.review).toBe(1);
    // failed is always 0 in the canonical model (aborted is terminal, not a failure bucket)
    expect(c.failed).toBe(0);
    // needs-attention = review (no failed bucket in new model)
    expect(c.needsAttention).toBe(1);
    // Terminal merged/aborted land in counts but not the buckets.
    expect(c.counts.merged).toBe(1);
    expect(c.counts.aborted).toBe(1);
    // The effective gate command is surfaced for the dashboard's gate display.
    expect(c.effective_gate_cmd).toBe(configMod.config.verifyCmd);
    expect(c.gate_cmd).toBeNull();
  });

  test("totals roll up across every registered workspace", () => {
    const d = dirsMod.dashboard();
    expect(d.totals.workspaces).toBe(d.workspaces.length);
    // Totals are the sum of each workspace's bucket.
    const sum = (k: "active" | "review" | "failed" | "needsAttention") =>
      d.workspaces.reduce((acc, x) => acc + (x as any)[k], 0);
    expect(d.totals.active).toBe(sum("active"));
    expect(d.totals.review).toBe(sum("review"));
    expect(d.totals.failed).toBe(sum("failed"));
    expect(d.totals.needsAttention).toBe(sum("needsAttention"));
  });
});
