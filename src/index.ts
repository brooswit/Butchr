// butchr entry point. Starts the dispatcher loop and the HTTP server, and wires
// up clean shutdown. Run with `bun run src/index.ts` (see package.json scripts).
import { recoverRunningTasks } from "./db.ts";
import { startDispatcher, stopDispatcher } from "./dispatcher.ts";
import { initFileLogging } from "./log.ts";
import { startServer } from "./server.ts";
import { recoverFinalizingTasks } from "./tasks.ts";
import { isUp } from "./herdr.ts";

async function main(): Promise<void> {
  // Install the persistent log sink before anything else so all startup output
  // is captured to the log file too.
  initFileLogging();
  console.log("[butchr] starting…");

  const recovered = recoverRunningTasks();
  if (recovered > 0) {
    console.log(`[butchr] re-queued ${recovered} task(s) left running from a prior run`);
  }

  // Complete any task left mid-finalize (the branch already merged to main).
  const finalized = await recoverFinalizingTasks();
  if (finalized > 0) {
    console.log(`[butchr] finalized ${finalized} task(s) left finalizing from a prior run`);
  }

  if (!(await isUp())) {
    console.warn(
      "[butchr] warning: herdr server not reachable. Start it with `herdr server` " +
        "(or launch the herdr TUI). Dispatch will resume automatically once it's up.",
    );
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
