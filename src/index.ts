// butchr entry point. Starts the dispatcher loop and the HTTP server, and wires
// up clean shutdown. Run with `bun run src/index.ts` (see package.json scripts).
import { snapshotOnShutdown, startBackupLoop, stopBackupLoop } from "./backup.ts";
import { reconcileCtoAgents, startCtoSupervisor, stopCtoSupervisor } from "./cto-agent.ts";
import { reconcileRunningTasks, startDispatcher, stopDispatcher } from "./dispatcher.ts";
import { initFileLogging } from "./log.ts";
import { reapDeadRunningAgents, reapOrphans, reapStuckGates } from "./reaper.ts";
import { startServer } from "./server.ts";
import { recoverFinalizingTasks, recoverStuckGates } from "./tasks.ts";
import { isUp } from "./herdr.ts";

async function main(): Promise<void> {
  // Install the persistent log sink before anything else so all startup output
  // is captured to the log file too.
  initFileLogging();
  console.log("[butchr] starting…");

  const herdrUp = await isUp();
  if (!herdrUp) {
    console.warn(
      "[butchr] warning: herdr server not reachable. Start it with `herdr server` " +
        "(or launch the herdr TUI). Dispatch will resume automatically once it's up.",
    );
  }

  // Re-adopt the agents launched before this restart instead of orphaning them.
  // LIVENESS-AWARE (see src/liveness.ts): an agent whose `claude` process is genuinely
  // alive gets its watcher re-attached; one KILLED by a power loss / herdr restart
  // (its pane fell back to a bare login shell) is AUTO-RESUMED via `claude --resume`
  // with no operator action; one that ended on its own is rescued to review.
  const { adopted, rescued, resumed } = await reconcileRunningTasks(herdrUp);
  if (adopted > 0) {
    console.log(`[butchr] re-adopted ${adopted} running agent(s) from a prior run`);
  }
  if (resumed > 0) {
    console.log(`[butchr] auto-resumed ${resumed} agent(s) killed by a host/herdr restart`);
  }
  if (rescued > 0) {
    console.log(`[butchr] rescued ${rescued} task(s) whose agent ended while butchr was offline`);
  }

  // Complete any task left mid-finalize (the branch already merged to main).
  const finalized = await recoverFinalizingTasks();
  if (finalized > 0) {
    console.log(`[butchr] finalized ${finalized} task(s) left finalizing from a prior run`);
  }

  // GATE RECOVERY (sibling of the agent auto-resume above): the CI build/test gate and
  // the conformance reviewer run fire-and-forget in butchr's OWN process, so a restart
  // killed any in-flight gate and left its task stuck `ci_status='running'` /
  // `conformance_status='checking'` forever — unmergeable until requeued by hand. On a
  // fresh boot every in-flight gate is provably stale (the subprocess can't survive a
  // restart), so re-trigger them all. Runs BEFORE the dispatcher starts; bounded +
  // force-settled past the cap so it can't loop. See tasks.recoverStuckGates.
  const gates = await recoverStuckGates();
  if (gates.ci > 0 || gates.conformance > 0 || gates.settled > 0) {
    console.log(
      `[butchr] recovered stuck gates from a prior run: re-triggered ${gates.ci} CI + ` +
        `${gates.conformance} conformance, force-settled ${gates.settled}`,
    );
  }

  // Reap leaked worktrees/branches + herdr husks from tasks that reached a
  // terminal state (or vanished) but whose filesystem/herdr artifacts survived a
  // restart. Runs AFTER reconcile + finalize so re-adopted running tasks and
  // just-finalized ones aren't mistaken for orphans.
  const { worktrees: reapedWt, husks: reapedHusks } = await reapOrphans(herdrUp);
  if (reapedWt > 0 || reapedHusks > 0) {
    console.log(
      `[butchr] reaped ${reapedWt} orphaned worktree(s), ${reapedHusks} herdr husk(s) on startup`,
    );
  }

  // AUTO-RESUME BACKSTOP: a safety-net sweep for any in_progress-with-pane task whose
  // claude isn't actually alive that reconcile somehow didn't handle (a clean boot
  // leaves nothing here — reconcile already auto-resumed the dead ones). See
  // reaper.reapDeadRunningAgents.
  await reapDeadRunningAgents(herdrUp);

  // GATE-RECOVERY BACKSTOP: a safety-net re-run of the stuck-gate sweep for any in-flight
  // gate the primary recovery above somehow didn't re-trigger. On a clean boot the primary
  // already re-triggered them (they're now live in-process), so this finds nothing —
  // mirroring reapDeadRunningAgents. See reaper.reapStuckGates.
  await reapStuckGates();

  // Managed CTO agents — ONE PER REGISTERED WORKSPACE (each default OFF unless that
  // workspace opts in via cto_enabled, or the global BUTCHR_CTO_AGENT default).
  // Reconcile every enabled workspace's desired state ONCE (adopt a live pane that
  // survived this restart, or (re)launch it RESUMING its session), then start the
  // supervisor that relaunches them on death.
  const cto = await reconcileCtoAgents(herdrUp);
  if (cto.adopted > 0 || cto.launched > 0) {
    console.log(`[butchr] CTO agents: ${cto.adopted} adopted, ${cto.launched} launched`);
  }
  startCtoSupervisor();

  startDispatcher();
  startServer();
  // Periodic, SQLite-safe snapshots of the source-of-truth db (see src/backup.ts)
  // so a crash/power loss mid-write can be rolled back to the last good copy.
  startBackupLoop();

  // Clean shutdown: stop the loops, then capture one final snapshot so the very
  // latest state survives even a deliberate restart. Async so the snapshot
  // completes before we exit; best-effort (snapshotOnShutdown never throws).
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; // ignore a second signal mid-shutdown
    shuttingDown = true;
    console.log("\n[butchr] shutting down…");
    stopDispatcher();
    // Stop SUPERVISING the per-workspace CTO agents, but leave their panes alive —
    // like workspace agents, the next boot re-adopts and resumes each (session
    // continuity). The reaper tracks the CTO agents separately and never orphans them.
    stopCtoSupervisor();
    stopBackupLoop();
    await snapshotOnShutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Crash supervision: if anything escapes to the top level, don't limp along in
  // a half-broken state — log it and exit non-zero so the supervisor (see
  // scripts/supervise.sh) relaunches a fresh, healthy process. On boot we
  // re-queue running tasks and finalize finalizing ones, so a restart resumes
  // cleanly rather than orphaning work.
  process.on("uncaughtException", (err) => {
    console.error("[butchr] uncaught exception:", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[butchr] unhandled rejection:", reason);
    process.exit(1);
  });
}

main().catch((e) => {
  console.error("[butchr] fatal:", e);
  process.exit(1);
});
