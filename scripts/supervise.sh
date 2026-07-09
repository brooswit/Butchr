#!/usr/bin/env bash
# butchr supervisor — keeps the server up and restarts it if it crashes.
#
# Local, dependency-free crash supervision: run butchr under this script and it
# relaunches the server whenever it exits non-zero (a crash), backing off a bit
# between restarts. A clean exit (code 0 — e.g. SIGINT/SIGTERM, which butchr
# traps and exits 0) stops the supervisor too, so Ctrl-C still quits for good.
#
# Safe to auto-restart because butchr re-queues any tasks left `running` and
# finalizes any left `finalizing` on boot (see src/index.ts), so a crashed
# server picks its state back up instead of orphaning work.
#
# Usage:
#   scripts/supervise.sh                 # supervise `bun run src/index.ts`
#   BUTCHR_RESTART_DELAY=5 scripts/supervise.sh
#
# Env knobs:
#   BUTCHR_RESTART_DELAY    seconds to wait before a restart      (default 2)
#   BUTCHR_MAX_RESTARTS     give up after this many crashes in    (default 10)
#                           BUTCHR_CRASH_WINDOW seconds; 0 = never give up
#   BUTCHR_CRASH_WINDOW     crash-loop window in seconds          (default 60)
#
# All other BUTCHR_* env vars are passed straight through to the server.
set -u

# Resolve the project root from this script's location, so it works from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

RESTART_DELAY="${BUTCHR_RESTART_DELAY:-2}"
MAX_RESTARTS="${BUTCHR_MAX_RESTARTS:-10}"
CRASH_WINDOW="${BUTCHR_CRASH_WINDOW:-60}"

child_pid=""

# Forward termination signals to the child and stop supervising. We send the
# signal, wait for the child to exit cleanly, then exit ourselves.
forward_signal() {
  local sig="$1"
  if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill -"$sig" "$child_pid" 2>/dev/null
    wait "$child_pid" 2>/dev/null
  fi
  echo "[supervisor] received SIG$sig — stopping butchr." >&2
  exit 0
}
trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT

# Crash-loop guard: track how many times we restarted within CRASH_WINDOW.
restart_count=0
window_start=$SECONDS

# The webapp is a build artifact (dist/, gitignored), so build it before the first start — once,
# not per restart: a crash loop must not re-bundle 10 times, and the sources cannot have changed
# between two restarts of the same supervisor.
echo "[supervisor] building the webapp (dist/)…" >&2
if ! bun run build:fe >&2; then
  echo "[supervisor] build:fe FAILED — the dashboard would 404. Refusing to start." >&2
  exit 1
fi

echo "[supervisor] starting butchr (restart delay ${RESTART_DELAY}s)…" >&2
while true; do
  bun run src/index.ts &
  child_pid=$!
  wait "$child_pid"
  code=$?
  child_pid=""

  if [[ $code -eq 0 ]]; then
    echo "[supervisor] butchr exited cleanly (code 0) — done." >&2
    exit 0
  fi

  echo "[supervisor] butchr crashed (exit code ${code})." >&2

  # Reset the crash counter once the window has elapsed without a give-up.
  if (( SECONDS - window_start > CRASH_WINDOW )); then
    restart_count=0
    window_start=$SECONDS
  fi
  restart_count=$((restart_count + 1))

  if (( MAX_RESTARTS > 0 && restart_count >= MAX_RESTARTS )); then
    echo "[supervisor] ${restart_count} crashes within ${CRASH_WINDOW}s — likely a crash loop. Giving up." >&2
    exit 1
  fi

  echo "[supervisor] restarting in ${RESTART_DELAY}s (restart ${restart_count})…" >&2
  sleep "$RESTART_DELAY"
done
