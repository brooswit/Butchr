// POST-MERGE VERIFY GATE runner. After a task fast-forwards into the default
// branch, butchr runs the configured build/test command in the repo root to
// confirm the new tip is GREEN; a RED result triggers an auto-revert of the merge
// (see tasks.approveTask + git.resetHard). This module is the single place that
// actually shells out the gate command, so it can be mocked in tests via
// setVerifyRunner — the revert-on-red decision is then exercised without spawning
// a real `bun build` / `bun test`.
import { config } from "./config.ts";
import { runGate } from "./gate.ts";

export type VerifyResult = {
  /** true → the default-branch tip builds and tests pass (merge stands). */
  ok: boolean;
  /** Combined stdout+stderr of the gate command (the failure output on RED). */
  output: string;
  /** true when the gate was skipped (verifyCmd empty) — treated as OK. */
  skipped?: boolean;
};

/** The actual gate executor; overridable for tests. `dir` is the repo root. */
export type VerifyRunner = (dir: string) => Promise<VerifyResult>;

/**
 * Default runner: a thin layer over the shared gate runner (src/gate.ts) — run
 * `config.verifyCmd` via `bash -lc` in the repo root, bounded by
 * `config.verifyTimeoutMs` (a timeout is treated as RED with a verify-specific
 * message). An empty verifyCmd DISABLES the gate (skipped → ok); everything else is
 * the gate runner's spawn + timeout + combined-output, shared with the CI gate.
 */
const defaultRunner: VerifyRunner = async (dir) => {
  const cmd = config.verifyCmd.trim();
  if (!cmd) return { ok: true, output: "", skipped: true };

  const gate = await runGate(["bash", "-lc", cmd], {
    cwd: dir,
    timeoutMs: config.verifyTimeoutMs,
  });
  if (gate.timedOut) {
    return {
      ok: false,
      output:
        `verify gate timed out after ${config.verifyTimeoutMs}ms\n` +
        (gate.output || "(no output captured)"),
    };
  }
  return { ok: gate.ok, output: gate.output };
};

let runner: VerifyRunner = defaultRunner;

/** Override the verify runner (tests). Pass nothing to restore the default. */
export function setVerifyRunner(fn?: VerifyRunner): void {
  runner = fn ?? defaultRunner;
}

/** Run the post-merge verify gate against the default-branch worktree at `dir`. */
export function verifyDefaultBranch(dir: string): Promise<VerifyResult> {
  return runner(dir);
}
