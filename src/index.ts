// butchr entry point. Starts the dispatcher loop and the HTTP server, and wires
// up clean shutdown. Run with `bun run src/index.ts` (see package.json scripts).
import { reconcileRunningTasks, startDispatcher, stopDispatcher } from "./dispatcher.ts";
import { startServer } from "./server.ts";
import { recoverFinalizingTasks } from "./tasks.ts";
import { isUp } from "./herdr.ts";

async function main(): Promise<void> {
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

  startDispatcher();
  startServer();

  const shutdown = () => {
    console.log("\n[butchr] shutting down…");
    stopDispatcher();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[butchr] fatal:", e);
  process.exit(1);
});
