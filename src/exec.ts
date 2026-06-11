// Thin wrapper around Bun.spawn for shelling out to git / herdr, plus the small
// pure helpers shared by the agent-launch path (the dispatcher + the managed CTO
// agent both build a `script`-wrapped claude command the same way).

/** Shell-escape a string for safe interpolation inside a single-quoted context. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * The `--model <model>` flag for a launch command, or "" when no model is set so
 * claude keeps its current default. The value is trimmed here; an unset/blank model
 * yields an empty flag. (The model was validated at task creation and ends up
 * single-quote escaped when the whole agentCmd is wrapped for `script -c`.)
 */
export function modelFlag(model?: string): string {
  const m = model?.trim();
  return m ? `--model ${m}` : "";
}

/**
 * Wrap a fully-substituted agent command under `script` for a PTY (so the agent's
 * interactive UI renders + input works in the herdr pane) while logging the
 * typescript to `logFile`. `-q` quiet, `-f` flush after each write (live log), `-e`
 * exit with the child's code. SHELL=/bin/bash forces `-c` to use bash (the user's
 * login shell may be fish, which can't parse the `$(cat ...)` in agentCmd).
 *
 * When `doneFile` is given (the dispatcher's task watcher path), the child's exit
 * code is written to it on exit so the watcher can catch an agent that ended WITHOUT
 * submitting; the managed CTO agent has no such watcher and omits it. Returns the
 * `bash -lc` argv to hand to the runtime.
 */
export function buildScriptArgv(opts: {
  agentCmd: string;
  logFile: string;
  doneFile?: string;
}): string[] {
  let wrapped = `SHELL=/bin/bash script -qfe --log-out ${shellQuote(opts.logFile)} -c ${shellQuote(opts.agentCmd)}`;
  if (opts.doneFile) wrapped += `; echo "$?" > ${shellQuote(opts.doneFile)}`;
  return ["bash", "-lc", wrapped];
}

// Control sequences that survive a raw terminal typescript / herdr's `--format text`
// read: ANSI/CSI escapes, charset selects, lone control chars. Strip them before
// showing captured agent output to a human so it renders as readable plain text.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

/** Strip ANSI escapes + bare control chars from terminal output. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

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
