// Tests for the PER-DIRECTORY BUILD/TEST GATE COMMAND and the CROSS-PROJECT
// DASHBOARD aggregation (see db.ts `directories.gate_cmd`, directories.{
// directoryGateCmd, updateDirectoryGateCmd, dashboard}, and how triggerCi threads
// the resolved command into the CI runner).
//
// Pure / in-process: no real claude/herdr/bun is spawned. BUTCHR_HERDR_BIN points at
// `true` so herdr probes are no-ops, and the CI runner is faked (setCiRunner) so we
// capture the gate command threaded in without shelling out. Directory + task rows
// are inserted directly (no registerDirectory, which would need a live herdr).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
// Distinct ids — the db/config singletons are shared across test files.
const DIR_A = "gate-dir-a";
const DIR_B = "gate-dir-b";

let dirsMod: typeof import("../src/directories.ts");
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
  dirsMod = await import("../src/directories.ts");
  tasksMod = await import("../src/tasks.ts");

  const ins = (id: string) =>
    dbMod.db
      .query(`INSERT INTO directories (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, join(REPO_ROOT, id), id, dbMod.nowIso());
  ins(DIR_A);
  ins(DIR_B);
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

/** Seed a bare task row in a directory with a given status (+ optional idle flag). */
function seedTask(id: string, dir: string, status: string, idle = 0) {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, directory_id, status, idle, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, dir, status, idle, dbMod.nowIso());
}

describe("directoryGateCmd resolution", () => {
  test("falls back to the default (config.verifyCmd) when gate_cmd is NULL", () => {
    // No override set on DIR_A → the global default command.
    expect(dirsMod.directoryGateCmd(DIR_A)).toBe(configMod.config.verifyCmd);
  });

  test("an unknown directory id falls back to the default", () => {
    expect(dirsMod.directoryGateCmd("does-not-exist")).toBe(configMod.config.verifyCmd);
  });

  test("returns the directory's own command once set", () => {
    dirsMod.updateDirectoryGateCmd(DIR_A, "make build && make test");
    expect(dirsMod.directoryGateCmd(DIR_A)).toBe("make build && make test");
    // Persisted on the row.
    const row = dbMod.db
      .query<{ gate_cmd: string | null }, [string]>(`SELECT gate_cmd FROM directories WHERE id=?`)
      .get(DIR_A)!;
    expect(row.gate_cmd).toBe("make build && make test");
  });

  test("an empty-string override DISABLES the gate (used verbatim, not defaulted)", () => {
    dirsMod.updateDirectoryGateCmd(DIR_A, "");
    expect(dirsMod.directoryGateCmd(DIR_A)).toBe("");
  });

  test("clearing the override (null) reverts to the default", () => {
    dirsMod.updateDirectoryGateCmd(DIR_A, "x");
    expect(dirsMod.directoryGateCmd(DIR_A)).toBe("x");
    dirsMod.updateDirectoryGateCmd(DIR_A, null);
    expect(dirsMod.directoryGateCmd(DIR_A)).toBe(configMod.config.verifyCmd);
    const row = dbMod.db
      .query<{ gate_cmd: string | null }, [string]>(`SELECT gate_cmd FROM directories WHERE id=?`)
      .get(DIR_A)!;
    expect(row.gate_cmd).toBeNull();
  });

  test("updateDirectoryGateCmd 404s on an unknown directory", () => {
    expect(() => dirsMod.updateDirectoryGateCmd("nope", "cmd")).toThrow(/directory not found/);
  });

  test("a non-string gate_cmd is rejected (400)", () => {
    expect(() => dirsMod.updateDirectoryGateCmd(DIR_A, 42)).toThrow(/must be a string/);
  });
});

describe("triggerCi threads the resolved gate command into the runner", () => {
  test("passes the directory's own gate command to the CI runner", async () => {
    dirsMod.updateDirectoryGateCmd(DIR_B, "npm run ci");
    const id = "gate-ci-own";
    seedTask(id, DIR_B, "review");
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
    dirsMod.updateDirectoryGateCmd(DIR_B, null); // clear → default
    const id = "gate-ci-default";
    seedTask(id, DIR_B, "review");
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
  // A fresh directory so the bucket math is isolated from rows seeded above.
  const DIR_C = "gate-dash-c";
  beforeAll(() => {
    dbMod.db
      .query(`INSERT INTO directories (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
      .run(DIR_C, join(REPO_ROOT, DIR_C), "Dash C", dbMod.nowIso());
    seedTask("dc-q", DIR_C, "queued");
    seedTask("dc-b", DIR_C, "blocked");
    seedTask("dc-r", DIR_C, "running");
    seedTask("dc-i", DIR_C, "running", 1); // idle (running + idle flag)
    seedTask("dc-f", DIR_C, "finalizing");
    seedTask("dc-rev", DIR_C, "review");
    seedTask("dc-fail", DIR_C, "failed");
    seedTask("dc-merged", DIR_C, "merged"); // terminal — not counted in any bucket
    seedTask("dc-abort", DIR_C, "aborted"); // terminal
  });

  test("folds per-status counts into active / review / failed / needs-attention", () => {
    const d = dirsMod.dashboard();
    const c = d.directories.find((x) => x.id === DIR_C)!;
    expect(c).toBeTruthy();
    // active = queued + blocked + running(non-idle) + idle + finalizing = 5
    expect(c.active).toBe(5);
    expect(c.review).toBe(1);
    expect(c.failed).toBe(1);
    // needs-attention = review + failed (the operator pull-signal)
    expect(c.needsAttention).toBe(2);
    // Terminal merged/aborted land in counts but not the buckets.
    expect(c.counts.merged).toBe(1);
    expect(c.counts.aborted).toBe(1);
    // The effective gate command is surfaced for the dashboard's gate display.
    expect(c.effective_gate_cmd).toBe(configMod.config.verifyCmd);
    expect(c.gate_cmd).toBeNull();
  });

  test("totals roll up across every registered directory", () => {
    const d = dirsMod.dashboard();
    expect(d.totals.directories).toBe(d.directories.length);
    // Totals are the sum of each directory's bucket.
    const sum = (k: "active" | "review" | "failed" | "needsAttention") =>
      d.directories.reduce((acc, x) => acc + (x as any)[k], 0);
    expect(d.totals.active).toBe(sum("active"));
    expect(d.totals.review).toBe(sum("review"));
    expect(d.totals.failed).toBe(sum("failed"));
    expect(d.totals.needsAttention).toBe(sum("needsAttention"));
  });
});
