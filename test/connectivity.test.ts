// Tests for the connectivity state machine (src/connectivity.ts).
//
// PURE / in-process only: no real network. We drive ConnectivityMonitor.record(ok,
// nowMs) directly with a synthetic clock and stubbed probe results, exercising the
// debounced down-detect, fire-once-on-restore, the no-fire cases (steady up/down and
// the down-transition), and the outage-duration capture.
import { describe, expect, test } from "bun:test";
import { ConnectivityMonitor } from "../src/connectivity.ts";

describe("connectivity: debounced DOWN detection", () => {
  test("stays UP until N consecutive failures, then declares DOWN (no event either way)", () => {
    const m = new ConnectivityMonitor(3);
    expect(m.isUp).toBe(true);

    // Two failures: still UP (debounce not satisfied), nothing fires.
    expect(m.record(false, 1000)).toBeNull();
    expect(m.isUp).toBe(true);
    expect(m.consecutiveFailures).toBe(1);
    expect(m.record(false, 2000)).toBeNull();
    expect(m.isUp).toBe(true);
    expect(m.consecutiveFailures).toBe(2);

    // Third consecutive failure flips DOWN — but a down-transition NEVER fires.
    expect(m.record(false, 3000)).toBeNull();
    expect(m.isUp).toBe(false);
  });

  test("a single isolated failure between successes never declares DOWN", () => {
    const m = new ConnectivityMonitor(3);
    expect(m.record(true, 1000)).toBeNull();
    expect(m.record(false, 2000)).toBeNull(); // one blip
    expect(m.consecutiveFailures).toBe(1);
    expect(m.record(true, 3000)).toBeNull(); // recovers — counter resets, no outage
    expect(m.consecutiveFailures).toBe(0);
    expect(m.isUp).toBe(true);

    // Another lone failure, again cleared — still never down, so still never fires.
    expect(m.record(false, 4000)).toBeNull();
    expect(m.record(true, 5000)).toBeNull();
    expect(m.isUp).toBe(true);
  });

  test("failuresToDown is clamped to at least 1 (a non-positive config can't break it)", () => {
    const m = new ConnectivityMonitor(0);
    expect(m.record(false, 1000)).toBeNull(); // 1 failure declares DOWN
    expect(m.isUp).toBe(false);
    const ev = m.record(true, 2000);
    expect(ev).not.toBeNull();
  });
});

describe("connectivity: fire-once on RESTORE (DOWN→UP)", () => {
  test("fires exactly once on recovery, then stays silent on steady-up", () => {
    const m = new ConnectivityMonitor(2);
    m.record(false, 1000);
    m.record(false, 2000); // DOWN declared
    expect(m.isUp).toBe(false);

    const ev = m.record(true, 5000); // DOWN → UP
    expect(ev).not.toBeNull();
    expect(m.isUp).toBe(true);
    expect(typeof ev!.restoredAt).toBe("string");
    expect(new Date(ev!.restoredAt).getTime()).toBe(5000);

    // Subsequent successes are steady-up — no re-fire.
    expect(m.record(true, 6000)).toBeNull();
    expect(m.record(true, 7000)).toBeNull();
  });

  test("a re-outage after recovery fires again on the next restore", () => {
    const m = new ConnectivityMonitor(1);
    m.record(false, 1000); // DOWN
    expect(m.record(true, 2000)).not.toBeNull(); // restore #1
    expect(m.record(true, 3000)).toBeNull(); // steady up
    m.record(false, 4000); // DOWN again
    expect(m.record(true, 9000)).not.toBeNull(); // restore #2
  });
});

describe("connectivity: NO fire on steady-up / steady-down", () => {
  test("steady-up from the start never fires", () => {
    const m = new ConnectivityMonitor(3);
    for (let t = 1000; t <= 5000; t += 1000) {
      expect(m.record(true, t)).toBeNull();
    }
    expect(m.isUp).toBe(true);
  });

  test("steady-down (repeated failures while already down) never fires", () => {
    const m = new ConnectivityMonitor(2);
    m.record(false, 1000);
    m.record(false, 2000); // DOWN
    expect(m.record(false, 3000)).toBeNull();
    expect(m.record(false, 4000)).toBeNull();
    expect(m.isUp).toBe(false);
  });
});

describe("connectivity: outage DURATION capture", () => {
  test("downMs is measured from the FIRST failed probe of the outage, not the DOWN declaration", () => {
    const m = new ConnectivityMonitor(3);
    m.record(false, 1000); // first failure of the streak — outage starts here
    m.record(false, 2000);
    m.record(false, 3000); // DOWN declared at t=3000
    m.record(false, 8000); // still down
    const ev = m.record(true, 10000); // restored at t=10000
    expect(ev).not.toBeNull();
    // 10000 - 1000 = 9000ms (honest outage length from the first failure).
    expect(ev!.downMs).toBe(9000);
  });

  test("downMs is never negative", () => {
    const m = new ConnectivityMonitor(1);
    m.record(false, 5000); // DOWN at t=5000
    const ev = m.record(true, 5000); // recovered same tick
    expect(ev!.downMs).toBe(0);
  });
});
