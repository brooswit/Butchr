// AGENT-PROCESS LIVENESS — the GROUND TRUTH for "is the task's claude actually
// running right now," distinct from "does herdr still have a pane/agent named after
// this task." The two diverge exactly in the failure this module exists to fix: when
// the host loses power / is re-logged-in, herdr restarts and EVERY agent's `claude`
// process is killed, but herdr RESTORES the pane as a bare login shell and keeps the
// agent NAME registered. So `harness.agentExists(taskId)` stays TRUE while claude is
// dead — and the idle-nudge then types "continue" into a dead shell forever.
//
// The reliable signal is the OS process itself. butchr launches the agent as
//   bash -lc "… script … -c 'claude … --session-id <uuid> …'"
// so the live `claude` process carries the session UUID as a DISTINCT argv token
// (`--session-id <uuid>` / `--resume <uuid>` are space-separated, so `<uuid>` is its
// own element of claude's argv). We scan /proc for a process whose argv contains that
// exact token. Why this beats the alternatives across a herdr/host restart:
//   - herdr's pane/agent-name SURVIVES the restart (that's the bug), so it can't tell
//     live from dead.
//   - the run-log mtime can't tell idle-but-alive from dead (a quiet working agent and
//     a dead shell both stop writing).
//   - the killed claude is GONE from /proc → no token match → dead; a genuinely-alive
//     (even quiet/idle) claude still has its process → token match → alive, so we never
//     false-resume a working agent.
//
// Matching is on a WHOLE argv element (exact token), never a loose substring, so an
// unrelated process that merely mentions the uuid inside a longer string can't
// false-positive. The /proc read is totally fault-tolerant: a pid can vanish mid-scan,
// so every per-pid read swallows its error and moves on (an unreadable pid is simply
// "not this one"). The cost is bounded by only ever probing at startup, in the reaper
// backstop, and at nudge-time when an agent has already gone quiet — never per tick on
// a busy agent.
import { readdirSync, readFileSync } from "node:fs";

/**
 * A live-process argv lister: returns each running process's argv as a string[]
 * (already split out of /proc's NUL-delimited `cmdline`). Injectable so tests can
 * drive `claudeAlive` deterministically without real processes. The default reads
 * `/proc` (Linux — butchr's deploy target).
 */
export type CmdlineLister = () => string[][];

/** Default lister: read every `/proc/<pid>/cmdline`, fully fault-tolerant. */
function readProcCmdlines(): string[][] {
  let pids: string[];
  try {
    pids = readdirSync("/proc");
  } catch {
    return []; // no /proc (non-Linux / sandboxed) — caller treats as "can't prove alive"
  }
  const out: string[][] = [];
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue; // skip non-pid entries (cpuinfo, self, …)
    let raw: string;
    try {
      raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue; // pid vanished mid-read / not permitted — never throw, just skip
    }
    if (!raw) continue; // kernel threads have an empty cmdline
    // cmdline is NUL-separated argv with a trailing NUL; drop empty splits.
    out.push(raw.split("\0").filter((a) => a.length > 0));
  }
  return out;
}

let lister: CmdlineLister = readProcCmdlines;

/** Swap the process lister (tests). Pass null/omit to restore the /proc default. */
export function setCmdlineLister(fn: CmdlineLister | null): void {
  lister = fn ?? readProcCmdlines;
}

/**
 * Is a live `claude` process running for this session id RIGHT NOW? True iff some
 * running process has the session id as a DISTINCT argv token (claude's own argv,
 * where `--session-id <uuid>` / `--resume <uuid>` put the uuid in its own element).
 * A blank/missing session id is never alive (nothing to key on). Never throws.
 */
export function claudeAlive(sessionId: string | null | undefined): boolean {
  const sid = sessionId?.trim();
  if (!sid) return false;
  for (const argv of lister()) {
    if (argv.includes(sid)) return true;
  }
  return false;
}
