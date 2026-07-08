// POST-MERGE VERIFY GATE runner. After a task fast-forwards into the default
// branch, butchr runs the repo's own `./scripts/ci` in the repo root to confirm the
// new tip is GREEN; a RED result triggers an auto-revert of the merge (see
// tasks.approveTask + git.resetHard). This module is the single place that actually
// shells out the gate, so it can be mocked in tests via setVerifyRunner — the
// revert-on-red decision is then exercised without spawning a real scripts/ci.
//
// The post-merge re-gate sets BUTCHR_BASE_REF="HEAD" so scripts/ci's changelog diff is
// EMPTY → exempt: the re-gate is purely build+test (the changelog was already enforced
// at review). A repo with no scripts/ci is un-gated (skipped → ok).
import { config } from "./config.ts";
import { runScriptsCi } from "./gate.ts";

export type VerifyResult = {
  /** true → the default-branch tip builds and tests pass (merge stands). */
  ok: boolean;
  /** Combined stdout+stderr of the gate command (the failure output on RED). */
  output: string;
  /** true when the gate was skipped (no scripts/ci) — treated as OK. */
  skipped?: boolean;
};

/**
 * The actual gate executor; overridable for tests. `dir` is the repo root — the gate
 * is the repo's own `./scripts/ci` (butchr carries no gate configuration).
 */
export type VerifyRunner = (dir: string) => Promise<VerifyResult>;

/**
 * Default runner: run the repo's `./scripts/ci` in the repo root via the shared gate
 * runner (src/gate.ts), bounded by `config.verifyTimeoutMs` (a timeout is treated as
 * RED with a verify-specific message). No scripts/ci present → the gate is OFF
 * (skipped → ok). BUTCHR_BASE_REF="HEAD" makes scripts/ci's changelog diff empty →
 * exempt, so the re-gate is purely build+test.
 */
const defaultRunner: VerifyRunner = async (dir) => {
  const gate = await runScriptsCi(dir, {
    env: { BUTCHR_BASE_REF: "HEAD" },
    timeoutMs: config.verifyTimeoutMs,
  });
  if (gate.skipped) return { ok: true, output: "", skipped: true };
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

/**
 * Run the post-merge verify gate against the default-branch worktree at `dir` — the
 * repo's own `./scripts/ci` (butchr carries no gate configuration; a repo with no
 * script is un-gated).
 */
export function verifyDefaultBranch(dir: string): Promise<VerifyResult> {
  return runner(dir);
}
