// butchr entry point. Starts the dispatcher loop and the HTTP server, and wires
// up clean shutdown. Run with `bun run src/index.ts` (see package.json scripts).
import { snapshotOnShutdown, startBackupLoop, stopBackupLoop } from "./backup.ts";
import { reconcileCtoAgent, startCtoSupervisor, stopCtoSupervisor } from "./cto-agent.ts";
import { reconcileRunningTasks, startDispatcher, stopDispatcher } from "./dispatcher.ts";
import { initFileLogging } from "./log.ts";
import { reapOrphans } from "./reaper.ts";
import { startServer } from "./server.ts";
import { recoverFinalizingTasks } from "./tasks.ts";
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

  // Re-adopt the agents launched before this restart instead of orphaning them:
  // live agents get their watcher re-attached; dead ones are rescued to review.
  // (Replaces the old blind re-queue, which collided on `agent_name_taken`.)
  const { adopted, rescued } = await reconcileRunningTasks(herdrUp);
  if (adopted > 0) {
    console.log(`[butchr] re-adopted ${adopted} running agent(s) from a prior run`);
  }
  if (rescued > 0) {
    console.log(`[butchr] rescued ${rescued} task(s) whose agent died while butchr was offline`);
  }

  // Complete any task left mid-finalize (the branch already merged to main).
  const finalized = await recoverFinalizingTasks();
  if (finalized > 0) {
    console.log(`[butchr] finalized ${finalized} task(s) left finalizing from a prior run`);
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

  // Managed CTO agent (default OFF — gated behind BUTCHR_CTO_AGENT). Reconcile its
  // desired state ONCE (adopt a live pane that survived this restart, or (re)launch
  // it RESUMING its session), then start the supervisor that relaunches it on death.
  // No-op unless enabled.
  const ctoAction = await reconcileCtoAgent(herdrUp);
  if (ctoAction.action === "adopted" || ctoAction.action === "launched") {
    console.log(`[butchr] CTO agent ${ctoAction.action}`);
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
    // Stop SUPERVISING the CTO agent, but leave its pane alive — like workspace
    // agents, the next boot re-adopts and resumes it (session continuity). The reaper
    // tracks the CTO separately and never orphans its pane.
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
