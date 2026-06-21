// F1 (story st-2a4aa7dc) — every herdr CLI shell-out is now BOUNDED by a timeout
// (config.herdrTimeoutMs / herdrStartTimeoutMs threaded into exec.run). An
// alive-but-WEDGED herdr (a reply that never comes) used to hang the caller — and
// thus the dispatcher tick / supervise loops — FOREVER. Now a hung call is killed at
// the bound and resolves as run() code 124 / ok:false, which the soft/degrading
// herdr helpers map to their default (null/""/[]/false) WITHOUT hanging or throwing.
//
// We repoint config.herdrBin at a stub (same technique as herdr-dry.test.ts) that
// SLEEPS past the timeout when a sentinel file is present, and responds instantly
// otherwise — so one stub covers both the timed-out and the normal-latency case. We
// also lower config.herdrTimeoutMs to 1s for the duration (herdr.ts reads it at CALL
// time, so a runtime mutation takes effect immediately — unlike the import-time env
// var, which a sibling test importing config first would have already frozen) so the
// test is fast while still proving the bound fires well before the stub's 5s sleep.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let SLOW_FILE: string;
let herdrMod: typeof import("../src/herdr.ts");
let cfg: typeof import("../src/config.ts").config;
let originalBin: string;
let originalTimeout: number;

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-herdr-timeout-"));
  SLOW_FILE = join(DATA_DIR, "slow.sentinel");
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  cfg = (await import("../src/config.ts")).config;
  herdrMod = await import("../src/herdr.ts");

  // Lower the SHORT bound to its 1s floor for the duration; restored in afterAll.
  // herdr.ts reads config.herdrTimeoutMs at call time, so this takes effect at once.
  originalTimeout = cfg.herdrTimeoutMs;
  cfg.herdrTimeoutMs = 1000;

  // When the SLOW sentinel exists the stub waits 5s before replying (longer than the
  // 1s bound) — so the run is killed at the timeout and resolves ok:false. Otherwise
  // it answers immediately with a valid envelope for the readers under test.
  const stub = join(DATA_DIR, "fake-herdr.js");
  writeFileSync(
    stub,
    `#!/usr/bin/env bun
import { existsSync } from "node:fs";
const argv = process.argv.slice(2);
function respond() {
  if (argv[0] === "agent" && argv[1] === "read") {
    process.stdout.write(JSON.stringify({ result: { read: { text: "live output" } } }));
  } else if (argv[0] === "pane" && argv[1] === "list") {
    process.stdout.write(JSON.stringify({ result: { panes: [
      { pane_id: "p1", terminal_id: "t1", tab_id: "tab1", workspace_id: "w1" },
    ] } }));
  } else if (argv[1] === "get") {
    process.stdout.write(JSON.stringify({ result: { agent: { tab_id: "tab-X" } } }));
  } else {
    process.stdout.write("{}");
  }
}
if (existsSync(${JSON.stringify(SLOW_FILE)})) {
  setTimeout(respond, 5000); // hang past the bound; killed before this fires
} else {
  respond();
}
`,
  );
  chmodSync(stub, 0o755);

  originalBin = cfg.herdrBin;
  cfg.herdrBin = stub;
});

afterAll(() => {
  cfg.herdrBin = originalBin;
  cfg.herdrTimeoutMs = originalTimeout;
  rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(SLOW_FILE, { force: true });
});

describe("F1 — config knobs are bounded + floor-clamped", () => {
  test("a SHORT and a LONGER (start) herdr timeout class both exist and are >= the 1s floor", () => {
    // The SHORT bound is mutated to 1000 for this suite; the LONG/start class keeps
    // its default and must be at least as large (and both above the 1s floor).
    expect(cfg.herdrTimeoutMs).toBeGreaterThanOrEqual(1000);
    expect(cfg.herdrStartTimeoutMs).toBeGreaterThanOrEqual(cfg.herdrTimeoutMs);
    expect(originalTimeout).toBeGreaterThanOrEqual(1000); // the real default is clamped too
  });
});

describe("F1 — a hung herdr returns the soft default and does NOT hang or throw", () => {
  test("agentRead → \"\" (not the stub's eventual text) and returns before the 5s sleep", async () => {
    writeFileSync(SLOW_FILE, "1");
    const t0 = Date.now();
    const out = await herdrMod.agentRead("a");
    const elapsed = Date.now() - t0;
    expect(out).toBe("");
    expect(elapsed).toBeLessThan(4000); // bounded by the ~1s timeout, not the 5s sleep
  });

  test("paneList → [] on a hung herdr", async () => {
    writeFileSync(SLOW_FILE, "1");
    const t0 = Date.now();
    const panes = await herdrMod.paneList();
    expect(panes).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  test("agentExists → false on a hung herdr (existsByGet's res.ok read of a 124 timeout)", async () => {
    writeFileSync(SLOW_FILE, "1");
    const t0 = Date.now();
    expect(await herdrMod.agentExists("a")).toBe(false);
    expect(Date.now() - t0).toBeLessThan(4000);
  });
});

describe("F1 — a normal-latency herdr call is UNAFFECTED by the bound", () => {
  test("agentRead returns the live text when herdr replies promptly", async () => {
    // No SLOW sentinel → the stub answers instantly, well within the bound.
    expect(await herdrMod.agentRead("a")).toBe("live output");
  });

  test("paneList returns the live panes when herdr replies promptly", async () => {
    const panes = await herdrMod.paneList();
    expect(panes).toEqual([
      { paneId: "p1", terminalId: "t1", tabId: "tab1", workspaceId: "w1" },
    ]);
  });

  test("agentExists returns true when the entity is present", async () => {
    expect(await herdrMod.agentExists("a")).toBe(true);
  });
});
