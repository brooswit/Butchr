// SHARED BUILD+TEST GATE RUNNER. butchr gates code in two places that must agree
// on "what green means": the advisory CI gate (tasks.triggerCi, run in a task's
// worktree to badge the review panel) and the post-merge verify gate
// (verify.verifyDefaultBranch, run in the repo root to confirm main is green and
// auto-revert it if not). Both need the same primitive — spawn a build/test
// command in a given cwd, BOUND it with a kill-timer, and collect combined output —
// so it lives here once instead of being re-derived per gate (they had drifted: CI
// had retries but no timeout, verify had a timeout but no retry). The
// genuinely-different layers — CI's build-vs-test badge parsing + flaky retry,
// verify's skip-on-empty + revert decision — sit on top in tasks.ts / verify.ts.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { run } from "./exec.ts";

/** Outcome of one gate command: green-ness, combined output, timeout flag. */
export type GateResult = {
  /** true → the command exited 0 (this gate command is GREEN). */
  ok: boolean;
  /** Combined, trimmed stdout+stderr — the diagnostic tail the badge / revert shows. */
  output: string;
  /** true when the run was killed by its timeout bound (always RED). */
  timedOut: boolean;
  /** true when the gate was SKIPPED (no `scripts/ci` present) — treated as OK (gate OFF). */
  skipped?: boolean;
};

/**
 * Run one gate command in `cwd`, ALWAYS bounded by a wall-clock kill-timer:
 * `timeoutMs` defaults to `config.verifyTimeoutMs` (the single knob both gates
 * share) and is floored at 1ms so a misconfigured `0`/negative still bounds the run
 * rather than spawning unbounded. Never throws — a non-zero exit, a spawn failure,
 * or a timeout-kill all come back as `ok:false` with whatever output was captured;
 * a timeout additionally sets `timedOut`.
 */
export async function runGate(
  cmd: string[],
  opts: { cwd: string; timeoutMs?: number; env?: Record<string, string> },
): Promise<GateResult> {
  const timeoutMs = Math.max(1, opts.timeoutMs ?? config.verifyTimeoutMs);
  const res = await run(cmd, { cwd: opts.cwd, timeoutMs, env: opts.env });
  const output = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
  return { ok: res.ok, output, timedOut: res.timedOut === true };
}

/**
 * THE gate: run the repo's own `./scripts/ci` in `cwd` — the SINGLE convention butchr
 * gates on, with ZERO gate configuration. The repo owns what CI means (build + test +
 * changelog) inside that one executable script; butchr just execs the known path.
 *
 *  - If `<cwd>/scripts/ci` does NOT exist → the gate is OFF: return
 *    `{ ok:true, output:"", timedOut:false, skipped:true }` (a repo with no CI still
 *    works — mirrors the historical empty-command = no-gate default). NOT a hard fail.
 *  - If it exists → run it via the shared bounded gate runner (`runGate`), honoring
 *    `config.verifyTimeoutMs` (through `runGate`'s default) and any caller `timeoutMs`.
 *    `opts.env` is threaded to the child (both gates set `BUTCHR_BASE_REF` so scripts/ci's
 *    changelog diff matches butchr and GitHub). A PRESENT-but-NON-EXECUTABLE script is
 *    deliberately NOT special-cased: the spawn fails → `ok:false` → RED (a loud misconfig
 *    signal). The gate-liveness / settle / restart-recovery wrappers are UNCHANGED — they
 *    wrap the RUN, not the command string.
 */
export async function runScriptsCi(
  cwd: string,
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<GateResult> {
  if (!existsSync(join(cwd, "scripts/ci"))) {
    return { ok: true, output: "", timedOut: false, skipped: true };
  }
  return runGate(["./scripts/ci"], {
    cwd,
    timeoutMs: opts.timeoutMs,
    env: opts.env,
  });
}

// === IN-PROCESS GATE LIVENESS ==============================================
// Both review-time gates (the CI gate in tasks.ts, the spec-conformance gate in
// conformance.ts) run IN THIS butchr process and persist a mid-flight DB status
// ('running' / 'checking'). Each tracks which task ids it is actively running so the
// restart-recovery sweep (tasks.recoverStuckGates) can tell a genuinely-live gate from
// a stale DB status whose subprocess died with a previous butchr process: a mid-flight
// DB status with NO live entry here is PROVABLY stale (the in-process set is emptied by a
// restart). The set is marked synchronously BEFORE the mid-flight write and cleared in a
// finally. Both gates implemented this Set identically, so it lives here once.

/** A per-gate liveness tracker: the set of task ids whose gate is running in THIS process. */
export type GateLiveness = {
  /** Record that this task's gate is now running here (before the mid-flight DB write). */
  mark(id: string): void;
  /** Record that this task's gate is done here (in a finally). */
  clear(id: string): void;
  /** Is this task's gate running in THIS process right now? */
  isLive(id: string): boolean;
};

/** Build a fresh, independent gate-liveness tracker (one per gate). */
export function makeGateLiveness(): GateLiveness {
  const inFlight = new Set<string>();
  return {
    mark: (id) => void inFlight.add(id),
    clear: (id) => void inFlight.delete(id),
    isLive: (id) => inFlight.has(id),
  };
}

// === SHARED GATE SETTLE WRITE ==============================================
// Both gates settle their result with the SAME guarded write: persist the gate's
// columns, reset the restart-recovery streak (gate_recovery_attempts=0), and only while
// the task is STILL `in_review` — so a gate that finished after the task merged/aborted
// can't resurrect stale gate state onto it. recoverStuckGates' force-settle uses the same
// write with an extra "still stuck on the same value" equality guard. Centralized here so
// the in_review guard + recovery-streak reset can't drift between the gates.

/**
 * Settle a gate result onto a task. Writes `columns` (e.g. `{ci_status, ci_summary}`)
 * plus `gate_recovery_attempts=0`, guarded on the task still being `in_review` — and, if
 * `opts.require` is given, on each named column still holding the given value (the
 * force-settle "still stuck on the same value" guard). Returns whether a row changed
 * (false = the task moved/settled under us — the caller bails, exactly like the old
 * `if (res.changes === 0) return`). The caller emits on a true return (gate.ts stays
 * db-only to avoid an events/tasks import cycle).
 */
export function settleGate(
  id: string,
  columns: Record<string, string | null>,
  opts: { require?: Record<string, string> } = {},
): boolean {
  const assigns = Object.keys(columns).map((c) => `${c}=?`);
  assigns.push("gate_recovery_attempts=0");
  const params: (string | null)[] = [...Object.values(columns)];
  let where = "id=? AND status='in_review'";
  params.push(id);
  for (const [col, val] of Object.entries(opts.require ?? {})) {
    where += ` AND ${col}=?`;
    params.push(val);
  }
  const res = db.query(`UPDATE tasks SET ${assigns.join(", ")} WHERE ${where}`).run(...params);
  return res.changes > 0;
}
