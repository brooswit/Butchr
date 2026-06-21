// butchr entry point. Starts the dispatcher loop and the HTTP server, and wires
// up clean shutdown. Run with `bun run src/index.ts` (see package.json scripts).
import { snapshotOnShutdown, startBackupLoop, stopBackupLoop } from "./backup.ts";
import { config } from "./config.ts";
import { startConnectivityMonitor, stopConnectivityMonitor } from "./connectivity.ts";
import { reconcileCtoAgents, startCtoSupervisor, stopCtoSupervisor } from "./cto-agent.ts";
import {
  reconcileStoryAgents,
  startStoryAgentSupervisor,
  stopStoryAgentSupervisor,
} from "./story-agent.ts";
import {
  isUnifiedWorkspaceEnabled,
  reconcileWorkspaceAgents,
  startWorkspaceAgentSupervisor,
  stopWorkspaceAgentSupervisor,
} from "./workspace-agent.ts";
import { reconcileRunningTasks, startDispatcher, stopDispatcher } from "./dispatcher.ts";
import * as git from "./git.ts";
import { initFileLogging } from "./log.ts";
import { reapDeadRunningAgents, reapOrphans, reapStuckGates } from "./reaper.ts";
import { startServer } from "./server.ts";
import { recoverMergingStories } from "./stories.ts";
import { recoverMergedTasks, recoverRollingBackTasks, recoverStuckGates } from "./tasks.ts";
import { isUp } from "./herdr.ts";
import { listWorkspaces, pruneTempWorkspaces } from "./workspaces.ts";

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

  // HOUSEKEEPING — runs FIRST (before any reconcile/recovery): drop stale workspace
  // registrations whose path lives under the OS temp dir (leftovers from selftest /
  // integration runs whose tmp dirs are long gone). Pruning EARLY — before
  // reconcileRunningTasks and reconcileCtoAgents — means butchr doesn't waste work
  // re-adopting agents or launching CTO sessions for workspaces it's about to delete.
  // unregisterWorkspace cascades to tasks + tears down panes/worktrees/CTO agent; real
  // (/home/...) workspaces are never touched. Best-effort per workspace (never aborts boot).
  const prunedTmp = await pruneTempWorkspaces();
  if (prunedTmp > 0) {
    console.log(`[butchr] pruned ${prunedTmp} stale temp workspace(s)`);
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

  // Re-drive any ROLLBACK task left mid-merge in `rolling_back` (butchr stopped while
  // its mechanical revert merge was in flight) so it lands or bounces rather than
  // stranding. Ordinary in_review tasks need no recovery (the operator re-approves).
  const rolledBack = await recoverRollingBackTasks();
  if (rolledBack > 0) {
    console.log(`[butchr] re-drove ${rolledBack} rollback task(s) left rolling_back from a prior run`);
  }

  // Re-drive any ISOLATED story left mid-merge in `merging` (butchr stopped while its
  // story→main land was in flight) so it lands (`done`) or bounces (`merge_blocked`) rather
  // than stranding — the story-level sibling of the rollback recovery above (CONTRIBUTING
  // §11.7, Phase E). Inert when no story is isolated/merging.
  const mergedStories = await recoverMergingStories();
  if (mergedStories > 0) {
    console.log(`[butchr] re-drove ${mergedStories} story(ies) left merging from a prior run`);
  }

  // Re-drive any ORDINARY task left `in_review` whose merge already LANDED before a crash
  // struck finalizeMerge's verify+teardown gap (its code + version bump are on the target
  // branch, but the DB `merged` write never happened). The in_review sibling of the
  // rollback/story recovery above: reconcile the DB (merged + release dependents) WITHOUT
  // re-merging or re-bumping (which would cut a duplicate release). Inert when none stranded.
  const recoveredMerged = await recoverMergedTasks();
  if (recoveredMerged > 0) {
    console.log(
      `[butchr] reconciled ${recoveredMerged} task(s) whose merge landed before a prior crash`,
    );
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
  // restart. Runs AFTER reconcile + rollback-recovery so re-adopted running tasks and
  // just-landed ones aren't mistaken for orphans.
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

  // POWER-LOSS RESILIENCE across EVERY managed repo: (re)apply durable-write config
  // (so a future crash can't leave a truncated loose object — also covers repos
  // registered before this existed) and self-heal any dangling/corrupt loose objects
  // a prior power loss already left. The heal removes ONLY objects PROVABLY
  // unreachable from a ref; reachable corruption is surfaced (logged loud) but never
  // auto-deleted. Best-effort per repo — a heal failure never blocks boot.
  await hardenManagedRepos();

  // BIND THE HTTP SERVER EARLY — BEFORE any operator-agent (CTO/leader) reconcile below.
  // Bun.serve binds the port synchronously, and the health/liveness endpoints come up with
  // it. The operator-agent boot reconcile (reconcileWorkspaceAgents, or the legacy
  // reconcileCtoAgents/reconcileStoryAgents) can adopt panes that are still parked at a
  // startup prompt; its per-pane auto-confirm is now fire-and-forget (src/workspace-agent.ts)
  // so it can no longer block, but we ALSO bind first so agent supervision can NEVER gate the
  // port bind under the systemd start timeout (the 0.9.136 crash-loop root cause). All
  // prerequisites already ran above: initFileLogging() (top of main), the db (initialized at
  // import, already used by reconcileRunningTasks), and every housekeeping/recovery step
  // (prune, reconcile, rollback, gate-recovery, reap, harden). Only the agent
  // reconcile/supervisor + dispatcher run AFTER the bind.
  startServer();

  // MANAGED OPERATOR AGENTS (CTO + story leaders). At the step-6b cutover these two
  // parallel supervisors are GENERALIZED into ONE unified-workspace supervisor
  // (src/workspace-agent.ts) over the `workspace` table — gated by
  // config.unifiedWorkspaceEnabled (DEFAULT ON as of 6b). We run EXACTLY ONE path so no
  // agent is double-supervised: when the gate is ON the unified supervisor is the sole
  // authority (it re-adopts every migrated cto/leader workspace row BY NAME — Story D
  // identity — so the live CTO + this story's leader survive the restart unorphaned); when
  // OFF the legacy per-kind cto + story supervisors run, byte-unchanged. (The old
  // reconcile/supervise entry points ALSO self-gate to a no-op when the flag is ON, a
  // belt-and-suspenders guard atop this skip.)
  if (isUnifiedWorkspaceEnabled()) {
    const ws = await reconcileWorkspaceAgents(herdrUp);
    if (ws.adopted > 0 || ws.launched > 0) {
      console.log(`[butchr] workspace agents: ${ws.adopted} adopted, ${ws.launched} launched`);
    }
    startWorkspaceAgentSupervisor();
  } else {
    // LEGACY PATH (gate OFF): the two parallel per-kind supervisors.
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

    // Managed STORY-LEADER agents — ONE PER OPEN STORY (Phase 3 of the STORIES epic). Same
    // boot pattern as the CTO agents: reconcile every open story's leader to its desired
    // state ONCE (adopt a surviving pane, or (re)launch RESUMING its session), then start the
    // supervisor that relaunches them on death.
    const stories = await reconcileStoryAgents(herdrUp);
    if (stories.adopted > 0 || stories.launched > 0) {
      console.log(`[butchr] story leaders: ${stories.adopted} adopted, ${stories.launched} launched`);
    }
    startStoryAgentSupervisor();
  }

  startDispatcher();
  // Periodic, SQLite-safe snapshots of the source-of-truth db (see src/backup.ts)
  // so a crash/power loss mid-write can be rolled back to the last good copy.
  startBackupLoop();
  // CONNECTIVITY MONITOR (EVENT-ONLY). Probes the model API for the life of the
  // process (independent of any workspace) and, on a debounced DOWN→UP transition,
  // BROADCASTS a `connectivity.restored` event to the CTO channel + worker channels.
  // It takes NO recovery action itself — each recipient decides what to do.
  startConnectivityMonitor();

  // Clean shutdown: stop the loops, then capture one final snapshot so the very
  // latest state survives even a deliberate restart. Async so the snapshot
  // completes before we exit; best-effort (snapshotOnShutdown never throws).
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; // ignore a second signal mid-shutdown
    shuttingDown = true;
    console.log("\n[butchr] shutting down…");
    stopDispatcher();
    // Stop SUPERVISING the managed operator agents, but leave their panes alive — the next
    // boot re-adopts and resumes each (session continuity), and the reaper tracks them
    // separately and never orphans them. We stop ALL THREE supervisor loops unconditionally
    // (each is idempotent — a no-op when its timer was never started), so whichever path boot
    // took (the unified supervisor when config.unifiedWorkspaceEnabled is ON, else the legacy
    // per-kind cto + story supervisors) is cleanly torn down.
    stopWorkspaceAgentSupervisor();
    stopCtoSupervisor();
    stopStoryAgentSupervisor();
    stopBackupLoop();
    stopConnectivityMonitor();
    await snapshotOnShutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Crash supervision: if anything escapes to the top level, don't limp along in
  // a half-broken state — log it and exit non-zero so the supervisor (see
  // scripts/supervise.sh) relaunches a fresh, healthy process. On boot we
  // re-adopt running tasks and re-drive rolling_back ones, so a restart resumes
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

/**
 * Boot-time power-loss hardening for every registered repo: set durable-write config
 * (config.gitFsync) and, when config.gitHealOnBoot is on, self-heal dangling/corrupt
 * loose objects. Iterates here (index owns workspace iteration) so git.ts stays
 * DB-free. Each repo is independent and wrapped so one failure can't abort boot; the
 * heal NEVER deletes a reachable object — reachable corruption is logged at error
 * level for an operator to repair by hand.
 */
async function hardenManagedRepos(): Promise<void> {
  let removedTotal = 0;
  let reposCleaned = 0;
  let reposSurfaced = 0;
  for (const ws of listWorkspaces()) {
    try {
      await git.setGitDurability(ws.path); // self-gated by config.gitFsync
      if (!config.gitHealOnBoot) continue;
      const rep = await git.healLooseObjects(ws.path);
      if (rep.removed.length > 0) {
        removedTotal += rep.removed.length;
        reposCleaned++;
        console.log(
          `[butchr] git-heal ${ws.path}: removed ${rep.removed.length} unreachable ` +
            `corrupt loose object(s) [${rep.removed.join(", ")}] (${rep.note})`,
        );
      }
      if (rep.skipped || rep.reachableCorrupt.length > 0) {
        reposSurfaced++;
        console.error(
          `[butchr] git-heal ${ws.path}: REACHABLE corruption — left UNTOUCHED for ` +
            `manual repair (run \`git -C ${ws.path} fsck\`): ` +
            `[${rep.reachableCorrupt.join(", ")}] (${rep.note})`,
        );
      }
    } catch (e) {
      console.error(`[butchr] git-heal ${ws.path} failed:`, (e as Error).message);
    }
  }
  if (removedTotal > 0 || reposSurfaced > 0) {
    console.log(
      `[butchr] git-heal: removed ${removedTotal} corrupt loose object(s) across ` +
        `${reposCleaned} repo(s); ${reposSurfaced} repo(s) with reachable corruption surfaced`,
    );
  }
}

main().catch((e) => {
  console.error("[butchr] fatal:", e);
  process.exit(1);
});
