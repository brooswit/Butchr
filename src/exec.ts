// Thin wrapper around Bun.spawn for shelling out to git / herdr.
export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
  ok: boolean;
  /**
   * true when the run was killed by its `timeoutMs` bound (in which case `code`
   * is forced non-zero and `stderr` carries TIMEOUT_MARKER). Absent otherwise.
   */
  timedOut?: boolean;
};

export type ExecOpts = {
  cwd?: string;
  /**
   * Optional wall-clock bound in milliseconds. When > 0, the process is killed on
   * expiry and the run resolves with a non-zero `code`, `timedOut: true`, and
   * TIMEOUT_MARKER appended to `stderr`. Omitted/0/negative → no bound (the
   * historical behavior), so existing callers are unaffected.
   */
  timeoutMs?: number;
};

/**
 * Marker appended to `stderr` when a run is killed by its `timeoutMs` bound, so a
 * caller can distinguish a timeout-kill from an ordinary non-zero exit by string
 * (in addition to the structured `timedOut` flag). Exit code on timeout is 124,
 * matching GNU `timeout(1)`.
 */
export const TIMEOUT_MARKER = "[exec] timed out";

export async function run(
  cmd: string[],
  opts: ExecOpts = {},
): Promise<ExecResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Optional bound: a positive timeoutMs arms a kill-timer so a hung subprocess
  // can't wait forever. With no timeout the timer is never created, so the
  // collect/await path below is byte-for-byte the historical behavior.
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }, opts.timeoutMs);
  }

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);

  if (timedOut) {
    const marker = `${TIMEOUT_MARKER} after ${opts.timeoutMs}ms`;
    return {
      code: 124,
      stdout,
      stderr: stderr ? `${stderr}\n${marker}` : marker,
      ok: false,
      timedOut: true,
    };
  }
  return { code, stdout, stderr, ok: code === 0 };
}

/** Like run(), but throws on non-zero exit with a useful message. */
export async function runOrThrow(
  cmd: string[],
  opts: ExecOpts = {},
): Promise<ExecResult> {
  const res = await run(cmd, opts);
  if (!res.ok) {
    throw new Error(
      `command failed (${res.code}): ${cmd.join(" ")}\n${res.stderr || res.stdout}`,
    );
  }
  return res;
}
