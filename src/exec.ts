// Thin wrapper around Bun.spawn for shelling out to git / herdr, plus the small
// pure helpers shared by the agent-launch path (the dispatcher + the managed CTO
// agent both build a `script`-wrapped claude command the same way).
import { config } from "./config.ts";

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

/** Resolve after `ms` milliseconds. The shared poll/backoff delay used across the
 *  herdr resolver and the dispatcher watcher loop (formerly re-defined in each). */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Read a child process's `stdout`/`stderr` stream into a string while BOUNDING the
 * captured bytes, retaining the TAIL. Both subprocess capture paths (exec.run and
 * herdr.runHeadless) use this instead of `new Response(stream).text()` so a runaway
 * command that prints gigabytes before its wall-clock timeout fires can't buffer
 * unboundedly and OOM the butchr process.
 *
 * It streams the chunks and keeps only the LAST `maxBytes` bytes — the END is what
 * ciTail and the conformance-verdict parser both want — discarding from the FRONT as
 * new data arrives, so peak memory stays ~`maxBytes` (plus one chunk) regardless of
 * total output. When anything was dropped, a short `[...truncated N bytes...]\n`
 * marker is prepended so the truncation is visible.
 *
 * INVARIANT: a SUB-CAP stream (total <= maxBytes) is decoded EXACTLY as
 * `new Response(stream).text()` would (UTF-8, no marker) — so normal runs are
 * byte-for-byte unchanged. `maxBytes <= 0` means UNBOUNDED (the historical read),
 * and a null/absent stream yields "". Exported for unit tests.
 */
export async function readBoundedTail(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
): Promise<string> {
  if (!stream) return "";
  // Non-positive cap → unbounded: behaviorally identical to the historical read.
  if (!(maxBytes > 0)) return new Response(stream).text();

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0; // bytes currently retained across `chunks`
  let dropped = 0; // bytes discarded from the FRONT
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      chunks.push(value);
      total += value.length;
      // Trim from the FRONT so we retain only the last `maxBytes` bytes.
      while (total > maxBytes && chunks.length > 0) {
        const first = chunks[0];
        const over = total - maxBytes;
        if (first.length <= over) {
          chunks.shift();
          total -= first.length;
          dropped += first.length;
        } else {
          // Partial trim of the front chunk lands us exactly at `maxBytes`.
          chunks[0] = first.subarray(over);
          total -= over;
          dropped += over;
          break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Decode as one UTF-8 stream across chunk boundaries (stream:true), matching how
  // Response.text() would decode the concatenation. A front-trim can clip the first
  // chunk mid-codepoint; the decoder emits a replacement char there, which is
  // acceptable for a truncated capture.
  const decoder = new TextDecoder();
  let text = "";
  for (const c of chunks) text += decoder.decode(c, { stream: true });
  text += decoder.decode();
  return dropped > 0 ? `[...truncated ${dropped} bytes...]\n${text}` : text;
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
  /**
   * Optional per-stream byte cap on the captured stdout/stderr (the TAIL is kept;
   * see readBoundedTail). Defaults to `config.maxSubprocOutputBytes`. <=0 →
   * unbounded. Mainly an override seam for tests; normal callers omit it.
   */
  maxOutputBytes?: number;
  /**
   * Optional environment overlay merged ON TOP of the current `process.env` for the
   * spawned child (e.g. `BUTCHR_BASE_REF` for the scripts/ci gate). Omitted → the
   * child inherits the parent env unchanged (Bun's default), so existing callers are
   * byte-for-byte unaffected.
   */
  env?: Record<string, string>;
};

/**
 * Marker appended to `stderr` when a run is killed by its `timeoutMs` bound, so a
 * caller can distinguish a timeout-kill from an ordinary non-zero exit by string
 * (in addition to the structured `timedOut` flag). Exit code on timeout is 124,
 * matching GNU `timeout(1)`.
 */
export const TIMEOUT_MARKER = "[exec] timed out";

/**
 * Grace (ms) between the timeout SIGTERM and the SIGKILL escalation. A child that
 * traps/ignores SIGTERM can otherwise hang PAST its timeoutMs, defeating the bound;
 * after this grace we send SIGKILL (uncatchable). Mirrors herdr.runHeadless.
 */
export const KILL_GRACE_MS = 2000;

export async function run(
  cmd: string[],
  opts: ExecOpts = {},
): Promise<ExecResult> {
  // A SPAWN FAILURE (e.g. the binary is missing, or `./scripts/ci` exists but is
  // NON-EXECUTABLE → EACCES) is reported as a non-zero result rather than thrown, so a
  // gate treats it as RED (a loud misconfig signal) — fulfilling runGate's documented
  // "a spawn failure comes back as ok:false" contract. Only the spawn itself is guarded;
  // once the child is live, the collect/await path below is unchanged.
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      // Overlay the caller's env on top of the inherited process.env (undefined → the
      // parent env unchanged, Bun's default), so a gate can pass e.g. BUTCHR_BASE_REF.
      env: opts.env ? { ...process.env, ...opts.env } : undefined,
    });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    return { code: 127, stdout: "", stderr: `[exec] spawn failed: ${msg}`, ok: false };
  }

  // Optional bound: a positive timeoutMs arms a kill-timer so a hung subprocess
  // can't wait forever. With no timeout the timer is never created, so the
  // collect/await path below is byte-for-byte the historical behavior.
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill(); // SIGTERM first — let the child clean up
      } catch {
        /* already gone */
      }
      // SIGKILL escalation: a child that traps/ignores SIGTERM would otherwise hang
      // past timeoutMs (defeating the bound). After a short grace, force-kill it.
      killTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS);
    }, opts.timeoutMs);
  }

  // Bound the captured output (TAIL retained) so a runaway child can't OOM butchr.
  // For sub-cap output this is byte-for-byte the historical `Response(...).text()`.
  const cap =
    opts.maxOutputBytes !== undefined
      ? opts.maxOutputBytes
      : config.maxSubprocOutputBytes;
  const [stdout, stderr, code] = await Promise.all([
    readBoundedTail(proc.stdout, cap),
    readBoundedTail(proc.stderr, cap),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);

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
