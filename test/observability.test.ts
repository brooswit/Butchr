// Tests for the read-only CTO OBSERVABILITY bundle: the cross-workspace task list
// (tasks.allTasksView), the global stats rollup (tasks.statsRollup), the attention feed
// (tasks.attentionList + the pure attentionReason categorizer), the structured gates
// block (tasks.gatesView) + the pure all-green predicate (tasks.gatesGreen), the
// allowlist membership rule (tasks.fileAllowed), the merge-readiness snapshot
// (tasks.taskReadiness, git-backed), and the last-boot migration outcome
// (db.getLastMigrationOutcome).
//
// Pure functions are exercised with synthetic rows; the DB-backed rollups with directly
// inserted workspace/task rows (no live herdr — BUTCHR_HERDR_BIN → `true`); taskReadiness
// against a real git repo + worktree like the other merge tests.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string; // a real git repo, backs WS_GIT (taskReadiness)

// Synthetic (non-git) workspaces for the pure / DB-backed rollups.
const WS_PLAIN = "obs-ws-plain"; // no changelog gate, not release_mode
const WS_CLOG = "obs-ws-clog"; // changelog gate on (changelog_path set)
const WS_REL = "obs-ws-rel"; // release_mode + changelog gate (strict)
const WS_GIT = "obs-ws-git"; // real repo

let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let configMod: typeof import("../src/config.ts");

function g(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-obs-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-obs-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  writeFileSync(join(REPO_ROOT, "README.md"), "base\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);

  dbMod = await import("../src/db.ts");
  tasksMod = await import("../src/tasks.ts");
  configMod = await import("../src/config.ts");

  // Deterministic gate config: empty global changelog path so a workspace with no
  // override resolves to OFF; a known auto-merge allowlist for the readiness test.
  configMod.config.changelogPath = "";
  configMod.config.autoMergeAllowlist = ["docs/", "*.md"];

  const insWs = (id: string, opts: { path?: string; changelog?: string | null; release?: number } = {}) =>
    dbMod.db
      .query(
        `INSERT INTO workspaces (id, path, label, changelog_path, release_mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.path ?? join(REPO_ROOT, id),
        id,
        opts.changelog ?? null,
        opts.release ?? 0,
        dbMod.nowIso(),
      );
  insWs(WS_PLAIN);
  insWs(WS_CLOG, { changelog: "CHANGELOG.md" });
  insWs(WS_REL, { changelog: "CHANGELOG.md", release: 1 });
  insWs(WS_GIT, { path: REPO_ROOT });
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

/** Insert a task row directly (no worktree) with the fields the rollups read. */
let seq = 0;
function insTask(
  workspaceId: string,
  status: string,
  o: {
    id?: string;
    plan_preview?: boolean;
    version_bump?: string;
    idle?: boolean;
    pane?: boolean;
    question?: string;
    summary?: string;
    last_dispatch_error?: string;
  } = {},
): string {
  const id = o.id ?? `obs-${workspaceId}-${status}-${seq}`;
  // Strictly increasing created_at so ordering is deterministic across same-ms inserts.
  const created = new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
  seq++;
  dbMod.db
    .query(
      `INSERT INTO tasks
         (id, workspace_id, status, blocked_by, kind, tags, priority, plan_preview,
          version_bump, idle, herdr_pane_id, has_agent, question, summary, last_dispatch_error, created_at)
       VALUES (?, ?, ?, '[]', 'task', '[]', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      workspaceId,
      status,
      o.plan_preview ? 1 : 0,
      o.version_bump ?? "patch",
      o.idle ? 1 : 0,
      o.pane ? "pane-x" : null,
      // has_agent mirrors the old pane-as-liveness (attentionList's idle gate keys on it).
      o.pane ? 1 : 0,
      o.question ?? null,
      o.summary ?? null,
      o.last_dispatch_error ?? null,
      created,
    );
  return id;
}

/** A synthetic partial row for the pure predicates (cast through the row type). */
function row(fields: Record<string, unknown>) {
  return fields as import("../src/db.ts").TaskRow;
}

// ---------------------------------------------------------------------------
describe("gatesGreen (pure all-gates-green predicate)", () => {
  test("ci 'pass'/null is green; 'fail'/'running' is red", () => {
    expect(tasksMod.gatesGreen(row({ ci_status: "pass", conformance_status: null }), true)).toBe(true);
    expect(tasksMod.gatesGreen(row({ ci_status: null, conformance_status: null }), true)).toBe(true);
    expect(tasksMod.gatesGreen(row({ ci_status: "fail", conformance_status: null }), true)).toBe(false);
    expect(tasksMod.gatesGreen(row({ ci_status: "running", conformance_status: null }), true)).toBe(false);
  });

  test("conformance 'concern' and 'checking' are NOT green; only 'pass'/null is", () => {
    expect(tasksMod.gatesGreen(row({ ci_status: "pass", conformance_status: "pass" }), true)).toBe(true);
    expect(tasksMod.gatesGreen(row({ ci_status: "pass", conformance_status: null }), true)).toBe(true);
    // The clarity note: a conformance 'concern' must read false.
    expect(tasksMod.gatesGreen(row({ ci_status: "pass", conformance_status: "concern" }), true)).toBe(false);
    expect(tasksMod.gatesGreen(row({ ci_status: "pass", conformance_status: "checking" }), true)).toBe(false);
  });

  test("a failing changelog check sinks an otherwise-green task", () => {
    expect(tasksMod.gatesGreen(row({ ci_status: "pass", conformance_status: "pass" }), false)).toBe(false);
  });
});

describe("attentionReason (pure categorizer)", () => {
  test("maps each attention state to its reason", () => {
    expect(tasksMod.attentionReason(row({ status: "failed" }), false)).toBe("failed");
    expect(tasksMod.attentionReason(row({ status: "spec_review" }), false)).toBe("spec-approval");
    expect(tasksMod.attentionReason(row({ status: "needs_info", plan_preview: 1 }), false)).toBe("plan-approval");
    expect(tasksMod.attentionReason(row({ status: "needs_info", plan_preview: 0 }), false)).toBe("answer-question");
    expect(tasksMod.attentionReason(row({ status: "in_review", version_bump: "patch" }), false)).toBe("diff-review");
  });

  test("major-confirm only when release_mode AND version_bump major", () => {
    // release_mode major → awaiting the human double-confirm, not plain diff-review.
    expect(tasksMod.attentionReason(row({ status: "in_review", version_bump: "major" }), true)).toBe("major-confirm");
    // major bump but NOT release_mode → still ordinary diff-review.
    expect(tasksMod.attentionReason(row({ status: "in_review", version_bump: "major" }), false)).toBe("diff-review");
    // release_mode but a patch bump → ordinary diff-review.
    expect(tasksMod.attentionReason(row({ status: "in_review", version_bump: "patch" }), true)).toBe("diff-review");
  });

  test("a live idle build agent is idle-handling; a busy one is not attention-worthy", () => {
    expect(tasksMod.attentionReason(row({ status: "in_progress", idle: 1 }), false)).toBe("idle-handling");
    expect(tasksMod.attentionReason(row({ status: "in_progress", idle: 0 }), false)).toBeNull();
  });

  test("non-attention states map to null", () => {
    for (const s of ["inactive", "blocked", "merged", "aborted", "rolling_back", "rolled_back"]) {
      expect(tasksMod.attentionReason(row({ status: s }), false)).toBeNull();
    }
  });
});

describe("fileAllowed (auto-merge allowlist membership)", () => {
  const allow = ["docs/", "test/", "*.md"];
  test("prefix dirs, top-level globs, and plain paths", () => {
    expect(tasksMod.fileAllowed("docs/guide.md", allow)).toBe(true);
    expect(tasksMod.fileAllowed("README.md", allow)).toBe(true); // top-level *.md
    expect(tasksMod.fileAllowed("src/app.ts", allow)).toBe(false);
    expect(tasksMod.fileAllowed("src/deep/x.md", allow)).toBe(false); // *.md is top-level only
  });
});

// ---------------------------------------------------------------------------
describe("gatesView (structured gates block, config-derived changelog)", () => {
  test("changelog status reflects the workspace gate configuration", () => {
    const ci = { ci_status: "pass", ci_summary: "ok", ci_tip: "abc" };
    const conf = { conformance_status: "pass", conformance_summary: "", conformance_tip: "abc" };
    const off = tasksMod.gatesView(row({ workspace_id: WS_PLAIN, ...ci, ...conf }));
    expect(off.changelog.status).toBe("off");
    // ci/conformance mirror the row columns.
    expect(off.ci.status).toBe("pass");
    expect(off.conformance.status).toBe("pass");

    expect(tasksMod.gatesView(row({ workspace_id: WS_CLOG, ...ci, ...conf })).changelog.status).toBe("on");
    expect(tasksMod.gatesView(row({ workspace_id: WS_REL, ...ci, ...conf })).changelog.status).toBe("strict");
  });
});

describe("statsRollup (global counts across workspaces)", () => {
  test("totals fold per-status, idle is peeled out and not double-counted", () => {
    insTask(WS_PLAIN, "merged");
    insTask(WS_PLAIN, "in_review");
    insTask(WS_CLOG, "in_progress", { idle: true, pane: true }); // becomes an idle pseudo-bucket

    const s = tasksMod.statsRollup();
    expect(s.workspaces).toBeGreaterThanOrEqual(4);
    expect(s.totals.merged).toBeGreaterThanOrEqual(1);
    expect(s.totals.in_review).toBeGreaterThanOrEqual(1);
    expect(s.totals.idle).toBeGreaterThanOrEqual(1);
    // The idle row is counted under `idle`, peeled OUT of in_progress, and NOT added to
    // totalTasks (it isn't a distinct status) — so totalTasks == sum of real status buckets.
    const realSum = Object.entries(s.totals)
      .filter(([k]) => k !== "idle")
      .reduce((n, [, v]) => n + v, 0);
    expect(s.totalTasks).toBe(realSum);
  });
});

describe("allTasksView (cross-workspace list)", () => {
  test("lists across workspaces, newest-first, and filters by workspace + status", () => {
    const a = insTask(WS_PLAIN, "inactive");
    const b = insTask(WS_CLOG, "in_review");

    const all = tasksMod.allTasksView();
    const ids = all.map((t) => t.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    // Newest-first: created_at is descending.
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1]!.created_at >= all[i]!.created_at).toBe(true);
    }
    // Each row carries the structured gates block.
    expect(all[0]!.gates).toBeDefined();

    // workspace filter.
    expect(tasksMod.allTasksView({ workspace: WS_CLOG }).every((t) => t.workspace_id === WS_CLOG)).toBe(true);
    expect(tasksMod.allTasksView({ workspace: "does-not-exist" })).toEqual([]);
    // status filter.
    expect(tasksMod.allTasksView({ status: "in_review" }).every((t) => t.status === "in_review")).toBe(true);
  });
});

describe("attentionList (the pull feed)", () => {
  test("surfaces feedback/failed/idle tasks with categorized reasons, oldest-first", () => {
    insTask(WS_PLAIN, "spec_review", { id: "att-spec", summary: "spec ready" });
    insTask(WS_PLAIN, "needs_info", { id: "att-plan", plan_preview: true, question: "approve plan?" });
    insTask(WS_PLAIN, "needs_info", { id: "att-q", question: "which lib?" });
    insTask(WS_REL, "in_review", { id: "att-major", version_bump: "major" });
    insTask(WS_PLAIN, "failed", { id: "att-failed", last_dispatch_error: "boom" });
    insTask(WS_PLAIN, "in_progress", { id: "att-idle", idle: true, pane: true });
    // A non-attention task must NOT appear.
    insTask(WS_PLAIN, "inactive", { id: "att-quiet" });

    const items = tasksMod.attentionList();
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId["att-spec"]!.reason).toBe("spec-approval");
    expect(byId["att-plan"]!.reason).toBe("plan-approval");
    expect(byId["att-plan"]!.detail).toBe("approve plan?");
    expect(byId["att-q"]!.reason).toBe("answer-question");
    expect(byId["att-major"]!.reason).toBe("major-confirm");
    expect(byId["att-failed"]!.reason).toBe("failed");
    expect(byId["att-failed"]!.detail).toBe("boom");
    expect(byId["att-idle"]!.reason).toBe("idle-handling");
    expect(byId["att-quiet"]).toBeUndefined();

    // Each item carries a resolved responder for feedback states (default cto); the
    // terminal `failed` has none.
    expect(byId["att-spec"]!.pending_responder).toBe("cto");
    expect(byId["att-failed"]!.pending_responder).toBeNull();

    // Oldest-first ordering.
    for (let i = 1; i < items.length; i++) {
      expect((items[i - 1]!.since ?? "") <= (items[i]!.since ?? "")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
describe("taskReadiness (git-backed merge-readiness snapshot)", () => {
  test("a fresh branch is on tip; its changed files split by the auto-merge allowlist", async () => {
    const view = await tasksMod.createTask(WS_GIT, "Add files");
    const id = view.id;
    const wt = join(REPO_ROOT, id);
    writeFileSync(join(wt, "app.ts"), "export const x = 1;\n"); // outside allowlist
    writeFileSync(join(wt, "notes.md"), "notes\n"); // top-level *.md → allowed
    g(["add", "-A"], wt);
    g(["commit", "-q", "-m", "work"], wt);

    const r = await tasksMod.taskReadiness(id);
    expect(r.onTip).toBe(true);
    expect(r.behindBy).toBe(0);
    expect(r.changedFiles.sort()).toEqual(["app.ts", "notes.md"]);
    // Only the non-allowlisted file is reported outside the auto-merge set.
    expect(r.outsideAutoMergeAllowlist).toEqual(["app.ts"]);
    // No CI/conformance gate ran (columns null) and no changelog gate on WS_GIT → green.
    expect(r.gatesGreen).toBe(true);
  });

  test("advancing the base branch makes the task read behind / not on tip", async () => {
    const view = await tasksMod.createTask(WS_GIT, "Behind task");
    const id = view.id;
    const wt = join(REPO_ROOT, id);
    writeFileSync(join(wt, "feature.ts"), "export const y = 2;\n");
    g(["add", "-A"], wt);
    g(["commit", "-q", "-m", "feature"], wt);

    // Advance the default branch AFTER the worktree was cut from the old tip.
    writeFileSync(join(REPO_ROOT, "README.md"), "advanced\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "advance base"]);

    const r = await tasksMod.taskReadiness(id);
    expect(r.behindBy).toBe(1);
    expect(r.onTip).toBe(false);
  });

  test("404s on an unknown task", async () => {
    await expect(tasksMod.taskReadiness("nope-nope")).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
describe("migration outcome (db.getLastMigrationOutcome)", () => {
  test("the boot pass converged cleanly", () => {
    const m = dbMod.getLastMigrationOutcome();
    expect(m.ok).toBe(true);
    expect(m.ran).toBeGreaterThan(0);
    expect(m.error).toBeNull();
    expect(typeof m.at).toBe("string");
  });
});
