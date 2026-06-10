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
import { config } from "./config.ts";
import { run } from "./exec.ts";

/** Outcome of one gate command: green-ness, combined output, timeout flag. */
export type GateResult = {
  /** true → the command exited 0 (this gate command is GREEN). */
  ok: boolean;
  /** Combined, trimmed stdout+stderr — the diagnostic tail the badge / revert shows. */
  output: string;
  /** true when the run was killed by its timeout bound (always RED). */
  timedOut: boolean;
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
  opts: { cwd: string; timeoutMs?: number },
): Promise<GateResult> {
  const timeoutMs = Math.max(1, opts.timeoutMs ?? config.verifyTimeoutMs);
  const res = await run(cmd, { cwd: opts.cwd, timeoutMs });
  const output = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
  return { ok: res.ok, output, timedOut: res.timedOut === true };
}
