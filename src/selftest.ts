// SELF-TEST / smoke harness: drive a throwaway PROBE task through butchr's FULL
// lifecycle against the RUNNING server and report pass/fail per stage. After a
// restart / recovery / deploy this is the one command that confirms the whole
// pipeline — dispatch → herdr → the agent run → the CI gate → review → (optional)
// merge — actually works end-to-end, catching breakage immediately instead of on
// the next real task.
//
// This is almost entirely a REST CLIENT: it adds no server logic and maps onto
// existing routes. It drives the REAL operator path over the UNIFIED `/api/work`
// surface: the operator creates a top-level NODE (POST /api/workspaces/:id/work) and the
// probe runs as a child LEAF (POST /api/work/:id/work) — standalone workspace leaf creation
// is rejected, so the smoke test exercises the same surface the operator uses. The ONE
// exception is the `--merge` cleanup: a merged probe
// can no longer be undone via a server route (the mechanical /rollback endpoint was
// retired — deliberate rollback is now a normal task), so the harness reverts its
// OWN throwaway merge directly in the sandbox repo. Everything time-, IO-, or
// git-bound — the HTTP client, the clock, the sleep, and that revert — is INJECTED
// so the orchestration logic is unit-testable with no real server, waits, or git.
import { basename } from "node:path";

/**
 * Default `revertMerge`: undo a merged probe's commits by reverting the recorded
 * range directly in the sandbox repo, leaving the tree CLEAN (a conflicting revert
 * is aborted, then surfaced). Only ever runs against the throwaway selftest probe
 * in the sandbox workspace. Injected (so tests stub it out); never touches a real
 * project's history because the probe only ever lands in the sandbox.
 */
async function defaultRevertMerge(
  sandboxPath: string,
  fromSha: string,
  toSha: string,
): Promise<void> {
  const proc = Bun.spawn(
    ["git", "-C", sandboxPath, "revert", "--no-edit", `${fromSha}..${toSha}`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    const err = (await new Response(proc.stderr).text()).trim();
    // Leave the sandbox clean: abort any half-applied revert (a no-op if none).
    Bun.spawnSync(["git", "-C", sandboxPath, "revert", "--abort"]);
    throw new Error(`git revert ${fromSha}..${toSha} failed: ${err || `exit ${code}`}`);
  }
}

/** A single lifecycle checkpoint the probe passed (or failed) through, with timing. */
export type SelftestStage = {
  /** Stage name: resolve | create | dispatch | review | merge | cleanup. */
  name: string;
  ok: boolean;
  /** Wall-clock ms spent reaching this stage from the previous one. */
  ms: number;
  /** Human-readable detail (status seen, error message, …). */
  detail?: string;
};

export type SelftestResult = {
  ok: boolean;
  /** The probe task's id (null if creation never happened). */
  taskId: string | null;
  /** The throwaway STORY the probe subtask belongs to (null if creation never happened) —
   * deleted at cleanup (which also tears down its leader agent). */
  storyId: string | null;
  /** The sandbox workspace the probe ran in (null if it couldn't be resolved). */
  dir: { id: string; label: string; path: string } | null;
  stages: SelftestStage[];
  /** Set when the run failed: the first error that stopped it. */
  error?: string;
};

/** The injected HTTP client — same contract as bin/butchr's `api` (throws on non-2xx). */
export type SelftestApi = (method: string, path: string, body?: unknown) => Promise<any>;

export type SelftestOptions = {
  api: SelftestApi;
  /** Live progress sink (one line per stage). Defaults to a no-op. */
  log?: (msg: string) => void;
  /** Sleep between polls. Defaults to a real timer; injected as a no-op in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic clock in ms. Defaults to Date.now; injected/deterministic in tests. */
  now?: () => number;
  /**
   * Undo a merged probe's commits to keep the sandbox clean (the `--merge` path's
   * cleanup). Defaults to a local `git revert` of the recorded merge range
   * (defaultRevertMerge); stubbed in tests so no real git runs.
   */
  revertMerge?: (sandboxPath: string, fromSha: string, toSha: string) => Promise<void>;
  /**
   * Workspace selector: an explicit registered-workspace id or path. When unset,
   * the harness AUTO-FINDS the workspace labelled `sandbox` (or whose path basename
   * is `sandbox`) — the registered throwaway repo intended for exactly this.
   */
  dir?: string;
  /** Also approve the probe, confirm it merges, then roll the merge back. */
  merge?: boolean;
  /** Max wall-clock (ms) to wait for the probe to reach review (and, with --merge, to merge). */
  timeoutMs?: number;
  /** Poll interval (ms) while waiting on a status transition. */
  pollMs?: number;
  /**
   * Unique marker woven into the probe (its file names + prompt) so repeated or
   * concurrent self-tests never collide. Defaults to the current clock value.
   */
  marker?: string;
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min: generous room for a real agent run.
const DEFAULT_POLL_MS = 2000;

/** Statuses a probe may pass THROUGH on its way to review (non-terminal, expected). */
const TRANSIENT = new Set(["inactive", "in_progress", "blocked", "needs_info"]);

/**
 * Build the throwaway probe's agent prompt. It asks for the SMALLEST possible
 * self-contained change (a pure function + a passing test) so the run exercises the
 * pipeline rather than the agent: dispatch, herdr, the in-worktree CI gate, and
 * review. `marker` is sanitized into the file names so parallel/repeat probes don't
 * clobber each other. Exported for the unit test.
 */
export function buildProbePrompt(marker: string): string {
  const safe = marker.replace(/[^a-zA-Z0-9_]/g, "_");
  return [
    `This is an AUTOMATED butchr SELF-TEST probe (marker: ${marker}). It exists only`,
    `to verify the end-to-end task pipeline and is THROWAWAY — butchr will abort or`,
    `roll it back automatically. Keep the change MINIMAL and self-contained.`,
    ``,
    `Do exactly this, and nothing else:`,
    `  1. Add a new file \`selftest_${safe}.ts\` that exports a pure function`,
    `     \`selftestPing(): string\` returning the literal string "pong".`,
    `  2. Add \`selftest_${safe}.test.ts\` that imports it and asserts`,
    `     \`selftestPing() === "pong"\` using \`bun:test\`.`,
    ``,
    `Make sure \`bun test\` passes. Do NOT modify any other file. Then call the`,
    `\`request_review\` MCP tool and exit.`,
  ].join("\n");
}

/**
 * Resolve the sandbox workspace. With an explicit `dir` (id or path), match it;
 * otherwise auto-find the workspace labelled `sandbox` (case-insensitive) or whose
 * path basename is `sandbox`. Throws a helpful error (listing what's registered)
 * when nothing matches.
 */
export async function resolveSandbox(
  api: SelftestApi,
  dir?: string,
): Promise<{ id: string; label: string; path: string }> {
  const dirs: Array<{ id: string; label: string; path: string }> = await api(
    "GET",
    "/api/workspaces",
  );
  let target: { id: string; label: string; path: string } | undefined;
  const known =
    dirs.map((d) => `  ${d.id}  ${d.label}  ${d.path}`).join("\n") ||
    "  (no workspaces registered)";
  if (dir) {
    target = dirs.find((d) => d.id === dir) ?? dirs.find((d) => d.path === dir);
    if (!target) {
      throw new Error(`no registered workspace matches "${dir}". Known workspaces:\n${known}`);
    }
  } else {
    target =
      dirs.find((d) => (d.label ?? "").toLowerCase() === "sandbox") ??
      dirs.find((d) => basename(d.path ?? "") === "sandbox");
    if (!target) {
      throw new Error(
        `no 'sandbox' workspace is registered — pass --workspace <id|path> to choose one.\n` +
          `Known workspaces:\n${known}`,
      );
    }
  }
  return target;
}

/**
 * Run the full self-test. Always leaves the sandbox clean: on ANY exit path (pass,
 * fail, or timeout) the probe is torn down — a not-yet-merged probe is `abort`ed
 * (worktree + branch discarded) and a merged probe's commits are REVERTED directly
 * in the sandbox (its merge landed on the default branch; there is no longer a
 * server route to undo it, so the harness reverts its own throwaway merge). Returns
 * a structured result; never throws.
 */
export async function runSelftest(options: SelftestOptions): Promise<SelftestResult> {
  const api = options.api;
  const log = options.log ?? (() => {});
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());
  const revertMerge = options.revertMerge ?? defaultRevertMerge;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  const result: SelftestResult = { ok: true, taskId: null, storyId: null, dir: null, stages: [] };
  let last = now();
  const mark = (name: string, ok: boolean, detail?: string): void => {
    const t = now();
    const ms = t - last;
    last = t;
    const stage: SelftestStage = { name, ok, ms };
    if (detail !== undefined) stage.detail = detail;
    result.stages.push(stage);
    log(`  ${ok ? "✓" : "✗"} ${name.padEnd(8)} ${ms}ms${detail ? `  ${detail}` : ""}`);
    if (!ok) result.ok = false;
  };

  let merged = false;
  // The recorded merge range of a successfully-merged probe, captured for cleanup so
  // we can revert exactly the commits it landed on the sandbox's default branch.
  let mergedRange: { from: string; to: string } | null = null;

  try {
    // (1) Resolve the sandbox workspace.
    const dir = await resolveSandbox(api, options.dir);
    result.dir = dir;
    mark("resolve", true, `${dir.label} (${dir.id})`);

    // (2) Create a throwaway top-level NODE (Work), then its probe child LEAF — the real
    // operator path over the unified surface (operator → node → child leaf). Standalone
    // workspace leaf creation is rejected (children are decomposed under a node), so the probe
    // runs as a child leaf; it dispatches exactly like any task. Tagged so it's identifiable.
    const marker = options.marker ?? String(now());
    const story = await api("POST", `/api/workspaces/${encodeURIComponent(dir.id)}/work`, {
      brief: `butchr self-test probe story (marker: ${marker})`,
    });
    result.storyId = story.id;
    const prompt = buildProbePrompt(marker);
    const task = await api("POST", `/api/work/${encodeURIComponent(story.id)}/work`, {
      prompt,
      tags: ["selftest"],
    });
    result.taskId = task.id;
    mark("create", true, `${task.id} (${task.status}) in story ${story.id}`);

    // (3) Poll until the probe DISPATCHES (→ running) and then reaches REVIEW. A
    // status outside the expected transient set before review (failed/aborted/
    // merged/rejected) is a pipeline failure we surface immediately.
    const deadline = now() + timeoutMs;
    let sawRunning = false;
    let reachedReview: any = null;
    while (now() < deadline) {
      const t = await api("GET", `/api/work/${encodeURIComponent(task.id)}`);
      if (t.status === "in_progress" && !sawRunning) {
        sawRunning = true;
        mark("dispatch", true, "in_progress");
      }
      if (t.status === "in_review") {
        // Dispatch may have been so quick we polled straight past `in_progress`; the
        // probe is in review, so dispatch demonstrably happened — record it.
        if (!sawRunning) mark("dispatch", true, "observed via in_review");
        reachedReview = t;
        break;
      }
      if (!TRANSIENT.has(t.status)) {
        const why = t.last_dispatch_error || t.revert_reason || t.review_note || "(no detail)";
        throw new Error(`probe reached '${t.status}' before review: ${why}`);
      }
      await sleep(pollMs);
    }
    if (!reachedReview) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for the probe to reach review`);
    }
    mark("review", true, `ci=${reachedReview.ci_status ?? "-"}`);

    // (4) Optionally approve, then confirm the MECHANICAL MERGE → `merged`. Approving an
    // in_review task runs the mechanical merge directly (no finalize agent): rebase →
    // gate → merge. So we approve and then POLL for the terminal merged state (a conflict
    // bounces the probe back to `inactive`, and a post-merge-verify revert lands it in
    // `failed` — both are failures for the probe).
    if (options.merge) {
      const r = await api("POST", `/api/work/${encodeURIComponent(task.id)}/approve`, {});
      if (r && r.conflictSentBack) {
        throw new Error("approve hit a merge conflict (sent back to the agent)");
      }
      const mergeDeadline = now() + timeoutMs;
      let mergedTask: any = null;
      while (now() < mergeDeadline) {
        const t = await api("GET", `/api/work/${encodeURIComponent(task.id)}`);
        if (t.status === "merged") {
          mergedTask = t;
          break;
        }
        if (t.status === "failed" || t.status === "aborted") {
          const why = t.revert_reason || t.last_dispatch_error || "(no detail)";
          throw new Error(`probe ${t.status} during merge (post-merge verify or give-up): ${why}`);
        }
        // inactive/in_progress (a merge conflict bounced back), needs_info are expected
        // on the way; anything else is unexpected.
        if (!["inactive", "in_progress", "needs_info"].includes(t.status)) {
          throw new Error(`probe reached '${t.status}' during merge`);
        }
        await sleep(pollMs);
      }
      if (!mergedTask) {
        throw new Error(`timed out after ${timeoutMs}ms waiting for the probe to merge`);
      }
      merged = true;
      // Record the merge range so cleanup can revert exactly these commits.
      if (mergedTask.merge_base_sha && mergedTask.merged_sha) {
        mergedRange = { from: mergedTask.merge_base_sha, to: mergedTask.merged_sha };
      }
      mark("merge", true, "merged into default branch");
    }
  } catch (e) {
    result.error = (e as Error).message;
    result.ok = false;
  } finally {
    // (5) CLEANUP — always leave the sandbox clean, even on failure/timeout.
    if (result.taskId) {
      try {
        if (merged) {
          // The probe landed on the sandbox's default branch. There is no server
          // route to undo a merge (deliberate rollback is now a normal task), so
          // revert exactly the commits it contributed, directly in the sandbox.
          if (!mergedRange || !result.dir) {
            throw new Error("merged probe has no recorded merge range to revert");
          }
          await revertMerge(result.dir.path, mergedRange.from, mergedRange.to);
          mark("cleanup", true, "reverted");
        } else {
          await api("POST", `/api/work/${encodeURIComponent(result.taskId)}/abort`, {});
          mark("cleanup", true, "aborted");
        }
      } catch (e) {
        // Cleanup failure is itself a problem worth flagging (a leftover task/
        // worktree defeats the harness's "keeps the sandbox clean" guarantee).
        mark("cleanup", false, `FAILED: ${(e as Error).message}`);
      }
    }
    // Delete the throwaway NODE (best-effort): removes the node row + its managed LEADER
    // agent. Member leaves are only DETACHED (parent pointer cleared), so the child teardown
    // above stands. Runs even when the child was never created (node-only leftover). A deletion
    // failure is flagged — a leftover node/leader defeats the "clean sandbox" guarantee.
    if (result.storyId) {
      try {
        await api("DELETE", `/api/work/${encodeURIComponent(result.storyId)}`);
      } catch (e) {
        mark("cleanup", false, `story delete FAILED: ${(e as Error).message}`);
      }
    }
  }

  return result;
}
