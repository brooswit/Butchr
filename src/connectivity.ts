// NETWORK CONNECTIVITY MONITOR (EVENT-ONLY).
//
// The recurring failure mode: when the host loses internet (laptop on battery, a
// network blip), the AGENTS' model-API calls die mid-work and sessions get
// killed/zombied. butchr ITSELF survives the outage — it's local; only the agents'
// model calls need the internet — so it is the right place to detect the outage and
// signal RECOVERY.
//
// This module periodically probes reachability of the model API endpoint (the thing
// agents actually need; configurable via config.connectivityUrl/_IntervalMs), tracks a
// DEBOUNCED up/down state machine, and fires EXACTLY ONCE on a DOWN→UP transition
// ("connectivity restored"), capturing how long it was down. It does NOT fire on
// steady-up or steady-down, and a single failed probe never false-triggers DOWN
// (N consecutive failures are required — config.connectivityFailuresToDown).
//
// STRICTLY EVENT-ONLY: on regain the runtime loop just publishes a
// `connectivity.restored` event (which fans out the SSE stream to the CTO channel +
// the worker connectivity channels). butchr takes NO recovery action — no requeue,
// resume, or abort; the existing liveness/auto-resume/gate-recovery layers are
// untouched. Each recipient (worker or CTO) decides what to do with the event.
//
// The state machine (ConnectivityMonitor) is PURE and clock-injected so it is fully
// unit-testable with the probe stubbed — no real network in tests.
import { config } from "./config.ts";
import { humanizeMs } from "./duration.ts";
import { publish } from "./events.ts";

/** A DOWN→UP recovery: when connectivity returned, and how long it had been down. */
export type RestoreEvent = { restoredAt: string; downMs: number };

/**
 * Pure, debounced up/down state machine. Feed it probe results via `record(ok, nowMs)`;
 * it returns a RestoreEvent EXACTLY on the DOWN→UP transition (once) and null otherwise.
 * Holds no clock or I/O of its own, so tests drive it deterministically.
 *
 * Debounce: it starts UP and only declares DOWN after `failuresToDown` CONSECUTIVE
 * failed probes — so one transient failure can't flip it down (and thus can't
 * false-fire a spurious "restored" on the next success). The outage duration is
 * measured from the FIRST failed probe of the streak (the honest start of the
 * outage), not from the later moment DOWN was declared.
 */
export class ConnectivityMonitor {
  private up = true;
  private failures = 0;
  // Epoch-ms of the first failed probe in the CURRENT failure streak (null while up
  // with no pending failures); becomes the outage start when DOWN is declared.
  private firstFailureMs: number | null = null;
  // Epoch-ms the outage is considered to have started (set when DOWN is declared).
  private downSinceMs: number | null = null;
  private readonly failuresToDown: number;

  constructor(failuresToDown: number) {
    // At least one failure must be required, else a single failed probe = instant DOWN
    // with no debounce at all (and a non-finite/<=0 config would break the comparison).
    this.failuresToDown = Math.max(1, Math.floor(failuresToDown) || 1);
  }

  /** Current state — true while connectivity is considered UP. */
  get isUp(): boolean {
    return this.up;
  }

  /** Consecutive failed probes since the last success (for diagnostics/tests). */
  get consecutiveFailures(): number {
    return this.failures;
  }

  /**
   * Record one probe result at clock `nowMs` (epoch ms). Returns a RestoreEvent on the
   * DOWN→UP transition (fires once), else null. Never fires on steady-up, steady-down,
   * or the UP→DOWN transition.
   */
  record(ok: boolean, nowMs: number): RestoreEvent | null {
    if (ok) {
      this.failures = 0;
      this.firstFailureMs = null;
      if (!this.up) {
        // DOWN → UP: connectivity RESTORED. Fire once, capturing the outage length.
        const downSince = this.downSinceMs ?? nowMs;
        const downMs = Math.max(0, nowMs - downSince);
        this.up = true;
        this.downSinceMs = null;
        return { restoredAt: new Date(nowMs).toISOString(), downMs };
      }
      return null; // steady-up
    }
    // Failed probe. Remember the start of this streak so the outage duration is honest.
    if (this.failures === 0) this.firstFailureMs = nowMs;
    this.failures += 1;
    if (this.up && this.failures >= this.failuresToDown) {
      // UP → DOWN: declare the outage (debounce satisfied). No event fires here.
      this.up = false;
      this.downSinceMs = this.firstFailureMs ?? nowMs;
    }
    return null; // never fire on a down-transition or steady-down
  }
}

/** A reachability probe: resolves true if the model API is reachable, false otherwise. */
export type ProbeFn = () => Promise<boolean>;

/**
 * Default probe: a HEAD to config.connectivityUrl with a timeout. ANY RESOLVED HTTP
 * response (even 401/403/405/5xx) proves the internet works → reachable. ONLY a
 * network error / DNS failure / timeout (the fetch rejecting) counts as a failed probe.
 */
async function defaultProbe(): Promise<boolean> {
  try {
    await fetch(config.connectivityUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(config.connectivityProbeTimeoutMs),
    });
    return true;
  } catch {
    return false;
  }
}

type MonitorOpts = {
  /** Override the reachability probe (tests stub this — no real network). */
  probe?: ProbeFn;
  /** Override the clock (epoch ms). */
  now?: () => number;
  /** Override what happens on restore (defaults to publishing the event). */
  onRestore?: (e: RestoreEvent) => void;
};

let timer: ReturnType<typeof setInterval> | null = null;

/** Publish the broadcast event + log it — the default restore action. */
function broadcastRestore(e: RestoreEvent): void {
  publish({ type: "connectivity.restored", restoredAt: e.restoredAt, downMs: e.downMs });
  console.log(
    `[butchr] network connectivity RESTORED (was down ~${humanizeMs(e.downMs)}) — ` +
      `broadcasting connectivity.restored to CTO + worker channels`,
  );
}

/**
 * Start the periodic connectivity probe loop (runs for the life of the process,
 * independent of any workspace). Self-gated by config.connectivityEnabled — a no-op
 * when monitoring is OFF. Idempotent: a second call while running is a no-op. The
 * probe/clock/onRestore seams are injectable for tests.
 */
export function startConnectivityMonitor(opts: MonitorOpts = {}): void {
  if (!config.connectivityEnabled) {
    console.log("[butchr] connectivity monitor disabled (BUTCHR_CONNECTIVITY=0)");
    return;
  }
  if (timer) return; // already running

  const monitor = new ConnectivityMonitor(config.connectivityFailuresToDown);
  const probe = opts.probe ?? defaultProbe;
  const now = opts.now ?? (() => Date.now());
  const onRestore = opts.onRestore ?? broadcastRestore;

  // Guard against a slow probe stacking on top of itself when an interval elapses
  // before the prior probe resolved.
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const ok = await probe();
      const wasUp = monitor.isUp;
      const ev = monitor.record(ok, now());
      if (ev) {
        onRestore(ev);
      } else if (wasUp && !monitor.isUp) {
        // Surface the outage onset too (observability only — recovery is the event).
        console.warn(
          "[butchr] network connectivity LOST (model API unreachable) — agents' " +
            "model calls may fail until it returns; will broadcast on recovery",
        );
      }
    } finally {
      inFlight = false;
    }
  };

  timer = setInterval(() => void tick(), config.connectivityIntervalMs);
  // Don't hold the process open solely for this background probe.
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  console.log(
    `[butchr] connectivity monitor: probing ${config.connectivityUrl} every ` +
      `${config.connectivityIntervalMs}ms (declare DOWN after ` +
      `${config.connectivityFailuresToDown} consecutive failures)`,
  );
}

/** Stop the connectivity probe loop (clean shutdown). */
export function stopConnectivityMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
