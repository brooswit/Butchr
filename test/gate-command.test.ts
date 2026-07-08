// Tests for the SOLE GATE — the repo's own executable `./scripts/ci` (butchr carries
// ZERO gate configuration) — via gate.runScriptsCi, how tasks.triggerCi threads the
// resolved merge base into the CI runner as BUTCHR_BASE_REF, and the CROSS-PROJECT
// DASHBOARD aggregation.
//
// Pure / in-process: no real claude/herdr/bun is spawned. BUTCHR_HERDR_BIN points at
// `true` so herdr probes are no-ops, and the CI runner is faked (setCiRunner) for the
// threading test so we capture the base ref without shelling out. runScriptsCi tests
// DO spawn a trivial `scripts/ci` script in a temp dir (that is the unit under test).
// Workspace + task rows are inserted directly (no registerWorkspace, which would need a
// live herdr).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
// Distinct ids — the db/config singletons are shared across test files.
const DIR_A = "gate-dir-a";
const DIR_B = "gate-dir-b";

let dirsMod: typeof import("../src/workspaces.ts");
let tasksMod: typeof import("../src/tasks.ts");
let gateMod: typeof import("../src/gate.ts");
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
  gateMod = await import("../src/gate.ts");

  const ins = (id: string) =>
    dbMod.db
      .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, join(REPO_ROOT, id), id, dbMod.nowIso());
  ins(DIR_A);
  ins(DIR_B);
});

afterAll(() => {
  tasksMod.setCiRunner();
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

/** Seed a bare task row in a workspace with a given status (+ optional idle flag + optional live-agent marker). */
function seedTask(id: string, dir: string, status: string, idle = 0, hasAgent = 0) {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, idle, has_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, dir, status, idle, hasAgent, dbMod.nowIso());
}

/** Create a fresh temp dir; if `script` is given, write it as an (optionally executable) `scripts/ci`. */
function mkCwd(opts: { script?: string; exec?: boolean } = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), "butchr-ci-cwd-"));
  if (opts.script !== undefined) {
    mkdirSync(join(cwd, "scripts"), { recursive: true });
    const p = join(cwd, "scripts", "ci");
    writeFileSync(p, opts.script);
    if (opts.exec !== false) chmodSync(p, 0o755);
  }
  return cwd;
}

describe("runScriptsCi (the sole gate)", () => {
  test("ABSENT scripts/ci → gate OFF (skipped → ok, no output)", async () => {
    const cwd = mkCwd(); // no scripts/ci
    const r = await gateMod.runScriptsCi(cwd);
    expect(r.skipped).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.output).toBe("");
    expect(r.timedOut).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("present + exit 0 → GREEN (ok, not skipped)", async () => {
    const cwd = mkCwd({ script: "#!/usr/bin/env bash\nexit 0\n" });
    const r = await gateMod.runScriptsCi(cwd);
    expect(r.ok).toBe(true);
    expect(r.skipped).toBeFalsy();
    rmSync(cwd, { recursive: true, force: true });
  });

  test("present + non-zero exit → RED (not ok, not skipped)", async () => {
    const cwd = mkCwd({ script: "#!/usr/bin/env bash\necho boom >&2\nexit 1\n" });
    const r = await gateMod.runScriptsCi(cwd);
    expect(r.ok).toBe(false);
    expect(r.skipped).toBeFalsy();
    expect(r.output).toContain("boom");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("present but NON-EXECUTABLE → RED (spawn fails, no special-case)", async () => {
    const cwd = mkCwd({ script: "#!/usr/bin/env bash\nexit 0\n", exec: false });
    const r = await gateMod.runScriptsCi(cwd);
    expect(r.ok).toBe(false);
    expect(r.skipped).toBeFalsy();
    rmSync(cwd, { recursive: true, force: true });
  });

  test("honors the env option — BUTCHR_BASE_REF is present in the child env", async () => {
    const cwd = mkCwd({
      script: '#!/usr/bin/env bash\necho "base=$BUTCHR_BASE_REF"\nexit 0\n',
    });
    const r = await gateMod.runScriptsCi(cwd, { env: { BUTCHR_BASE_REF: "some-ref-42" } });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("base=some-ref-42");
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("gate_cmd config is GONE end-to-end", () => {
  test("workspaceGateCmd / updateWorkspaceGateCmd no longer exist", () => {
    expect((dirsMod as any).workspaceGateCmd).toBeUndefined();
    expect((dirsMod as any).updateWorkspaceGateCmd).toBeUndefined();
  });

  test("the dashboard view no longer exposes gate_cmd / effective_gate_cmd", () => {
    const c = dirsMod.dashboard().workspaces.find((x) => x.id === DIR_A)!;
    expect(c).toBeTruthy();
    expect((c as any).gate_cmd).toBeUndefined();
    expect((c as any).effective_gate_cmd).toBeUndefined();
  });

  test("config.verifyCmd is removed (only verifyTimeoutMs remains)", () => {
    expect((configMod.config as any).verifyCmd).toBeUndefined();
    expect(typeof configMod.config.verifyTimeoutMs).toBe("number");
  });
});

describe("triggerCi drives the CI runner (base threading is exercised end-to-end in ci-gate.test.ts)", () => {
  test("invokes the active runner for a review task with a worktree", async () => {
    const id = "gate-ci-invoked";
    seedTask(id, DIR_B, "in_review");
    mkdirSync(join(REPO_ROOT, DIR_B, id), { recursive: true }); // worktree so CI runs

    let called = 0;
    tasksMod.setCiRunner(async () => {
      called++;
      return { status: "pass", label: "gate passed", detail: "" };
    });
    await tasksMod.triggerCi(id);
    expect(called).toBe(1);
    expect(dbMod.db.query<{ ci_status: string }, [string]>(`SELECT ci_status FROM tasks WHERE id=?`).get(id)!.ci_status).toBe("pass");
    tasksMod.setCiRunner();
  });
});

describe("dashboard aggregation", () => {
  // A fresh workspace so the bucket math is isolated from rows seeded above.
  const DIR_C = "gate-dash-c";
  beforeAll(() => {
    dbMod.db
      .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
      .run(DIR_C, join(REPO_ROOT, DIR_C), "Dash C", dbMod.nowIso());
    seedTask("dc-q", DIR_C, "inactive");             // ready (no agent) → inactive bucket
    seedTask("dc-b", DIR_C, "blocked");              // blocked bucket
    seedTask("dc-r", DIR_C, "in_progress", 0, 1);    // live agent (non-idle) → in_progress
    seedTask("dc-i", DIR_C, "in_progress", 1, 1);    // idle (in_progress + live agent + idle flag)
    seedTask("dc-rb", DIR_C, "rolling_back");        // rolling_back bucket (mechanical revert merge)
    seedTask("dc-rev", DIR_C, "in_review");          // review/feedback bucket
    seedTask("dc-failed", DIR_C, "failed");          // terminal execution failure → failed bucket
    seedTask("dc-merged", DIR_C, "merged");          // terminal — not counted in any bucket
    seedTask("dc-abort", DIR_C, "aborted");          // terminal
  });

  test("folds per-status counts into active / review / failed / needs-attention", () => {
    const d = dirsMod.dashboard();
    const c = d.workspaces.find((x) => x.id === DIR_C)!;
    expect(c).toBeTruthy();
    // active = inactive(dc-q) + in_progress(dc-r) + idle(dc-i) + blocked(dc-b) + rolling_back(dc-rb) = 5
    expect(c.active).toBe(5);
    // review = in_review(dc-rev) = 1
    expect(c.review).toBe(1);
    // failed = failed(dc-failed) = 1 (terminal execution failures, surfaced for a human)
    expect(c.failed).toBe(1);
    // needs-attention = review + failed
    expect(c.needsAttention).toBe(2);
    // Terminal merged/failed/aborted land in counts but merged/aborted aren't active buckets.
    expect(c.counts.merged).toBe(1);
    expect(c.counts.aborted).toBe(1);
    expect(c.counts.failed).toBe(1);
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
