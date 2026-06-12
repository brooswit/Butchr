// Tests for STALE herdr pane tracking (the renumber bug). herdr pane ids are
// POSITIONAL: when a sibling tab/pane closes, herdr RENUMBERS the survivors, so the
// `herdr_pane_id` butchr cached at launch silently goes stale and can point at a
// DIFFERENT task's (often dead) shell. butchr must resolve a task's CURRENT pane by
// its AGENT NAME (= the task id) at USE-TIME and repair the stored id when it drifts —
// otherwise the auto-nudge, idle surfacing, terminal-attach, and teardown all aim at
// the wrong pane.
//
// Two layers are covered:
//   1. herdr.reconcilePane (the REAL herdr-backed resolver) against a recording stub
//      that models a renumber: `agent get` reports the agent's stable terminal id and
//      `pane list` reports its CURRENT positional pane id — different from the stale
//      one butchr stored — so reconcilePane resolves the live pane and flags drift.
//   2. dispatcher.currentPaneRepairing + maybeNudgeStalledAgent against a FAKE harness
//      (via setRunner): a stalled task whose stored pane id is STALE has it repaired
//      to the resolved current pane, and the nudge is sent BY NAME (so it lands on the
//      live pane, never the renumbered-away shell).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, SendInput } from "../src/harness.ts";

// The agent's CURRENT pane (what `herdr agent list`/`pane list` report now) vs. the
// STALE id butchr cached at launch (a sibling tab closed → herdr renumbered).
const CURRENT_PANE = "w653d4428991b51-7";
const STALE_PANE = "w653d4428991b51-8";

let DATA_DIR: string;
const DIR_ID = "pane-renumber-dir";

let dbMod: typeof import("../src/db.ts");
let dispatchMod: typeof import("../src/dispatcher.ts");
let herdrMod: typeof import("../src/herdr.ts");
let harnessApi: typeof import("../src/harness.ts");
let cfg: typeof import("../src/config.ts").config;
let originalRunner: AgentRunner;
let originalBin: string;

// Records the `send` calls the nudge makes; every other fake method no-ops.
let sends: Array<[string, SendInput]> = [];

// A FAKE backend (for the dispatcher layer): `reconcilePane` reports the live pane by
// name and whether the caller's stored id drifted; `send` is recorded.
function makeFakeRunner(): AgentRunner {
  const noop = async () => undefined as never;
  return new Proxy({} as AgentRunner, {
    get(_t, prop) {
      if (prop === "send") {
        return async (name: string, input: SendInput) => {
          sends.push([name, input]);
        };
      }
      if (prop === "reconcilePane") {
        return async (_name: string, stored?: string | null) => ({
          paneId: CURRENT_PANE,
          drifted: !!stored && stored !== CURRENT_PANE,
        });
      }
      return noop;
    },
  });
}

function seedTask(id: string, status: string, paneId: string | null): void {
  dbMod.db
    .query(
      `INSERT INTO tasks (id, workspace_id, status, herdr_pane_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, DIR_ID, status, paneId, dbMod.nowIso());
}

function storedPane(id: string): string | null {
  return (
    dbMod.db
      .query<{ herdr_pane_id: string | null }, [string]>(
        `SELECT herdr_pane_id FROM tasks WHERE id=?`,
      )
      .get(id)?.herdr_pane_id ?? null
  );
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-pane-renumber-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  process.env.BUTCHR_IDLE_MS = "1000";
  process.env.BUTCHR_IDLE_NUDGE_MS = "2000";
  process.env.BUTCHR_IDLE_NUDGE_MAX = "2";

  dbMod = await import("../src/db.ts");
  cfg = (await import("../src/config.ts")).config;
  dispatchMod = await import("../src/dispatcher.ts");
  herdrMod = await import("../src/herdr.ts");
  harnessApi = await import("../src/harness.ts");

  // A recording herdr stub that models a renumber: the agent's stable terminal id is
  // "T-live", and `pane list` reports it at the CURRENT pane while a dead sibling sits
  // at the STALE pane butchr cached. Repoints config.herdrBin for the REAL-resolver
  // layer; the fake-harness layer goes through setRunner and ignores it.
  const stub = join(DATA_DIR, "fake-herdr.js");
  writeFileSync(
    stub,
    `#!/usr/bin/env bun
const argv = process.argv.slice(2);
const ok = (result) => process.stdout.write(JSON.stringify({ result }));
if (argv[0] === "agent" && argv[1] === "get") {
  // The named agent: its STABLE terminal id (survives renumbering).
  ok({ agent: { terminal_id: "T-live" } });
} else if (argv[0] === "pane" && argv[1] === "list") {
  ok({ panes: [
    { pane_id: ${JSON.stringify(STALE_PANE)}, terminal_id: "T-dead", tab_id: "tab-dead", workspace_id: "ws" },
    { pane_id: ${JSON.stringify(CURRENT_PANE)}, terminal_id: "T-live", tab_id: "tab-live", workspace_id: "ws" },
  ] });
} else {
  process.stdout.write("{}");
}
`,
  );
  chmodSync(stub, 0o755);

  originalBin = cfg.herdrBin;
  cfg.herdrBin = stub;
  originalRunner = harnessApi.getRunner();
  harnessApi.setRunner(makeFakeRunner());

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR_ID, DATA_DIR, "test", dbMod.nowIso());
});

afterAll(() => {
  cfg.herdrBin = originalBin;
  harnessApi.setRunner(originalRunner);
  rmSync(DATA_DIR, { recursive: true, force: true });
});

function stalledQuietMs(): number {
  return cfg.idleMs + cfg.idleNudgeMs + 1;
}

describe("herdr.reconcilePane (the REAL name-based current-pane resolver)", () => {
  test("detects a renumber: resolves the live pane by name and flags the stored id as drifted", async () => {
    // butchr cached the STALE pane; herdr now has the agent at the CURRENT pane.
    const r = await herdrMod.reconcilePane("maroon-gypsum-3060", STALE_PANE);
    expect(r.paneId).toBe(CURRENT_PANE); // resolved by AGENT NAME, not the cached id
    expect(r.drifted).toBe(true);
  });

  test("no drift when the stored id already matches the live pane", async () => {
    const r = await herdrMod.reconcilePane("maroon-gypsum-3060", CURRENT_PANE);
    expect(r.paneId).toBe(CURRENT_PANE);
    expect(r.drifted).toBe(false);
  });

  test("no stored id given → resolves the live pane, never flags drift", async () => {
    const r = await herdrMod.reconcilePane("maroon-gypsum-3060");
    expect(r.paneId).toBe(CURRENT_PANE);
    expect(r.drifted).toBe(false); // nothing to repair toward
  });
});

describe("dispatcher.currentPaneRepairing (self-heal the stored pane id)", () => {
  test("repairs a drifted stored pane id to the current pane resolved by name", async () => {
    seedTask("drifted-task", "in_progress", STALE_PANE);
    const resolved = await dispatchMod.currentPaneRepairing("drifted-task");
    expect(resolved).toBe(CURRENT_PANE);
    expect(storedPane("drifted-task")).toBe(CURRENT_PANE); // DB reconverged
  });

  test("leaves a non-drifted stored pane id untouched", async () => {
    seedTask("steady-task", "in_progress", CURRENT_PANE);
    const resolved = await dispatchMod.currentPaneRepairing("steady-task");
    expect(resolved).toBe(CURRENT_PANE);
    expect(storedPane("steady-task")).toBe(CURRENT_PANE);
  });
});

describe("dispatcher.maybeNudgeStalledAgent on a task with a STALE pane id", () => {
  test("repairs the drifted pane id AND sends 'continue' by agent name", async () => {
    sends = [];
    seedTask("stalled-stale", "in_progress", STALE_PANE);
    const now = 5_000_000;
    const next = await dispatchMod.maybeNudgeStalledAgent(
      "stalled-stale",
      "in_progress",
      stalledQuietMs(),
      { nudgesSent: 0, lastNudgeAt: 0 },
      now,
    );
    // The stale stored id was self-healed to the CURRENT pane before nudging.
    expect(storedPane("stalled-stale")).toBe(CURRENT_PANE);
    // The nudge is addressed to the AGENT NAME — herdr routes it to the live pane,
    // never the renumbered-away shell the stale id pointed at.
    expect(sends).toEqual([["stalled-stale", { text: "continue", enter: true }]]);
    expect(next).toEqual({ nudgesSent: 1, lastNudgeAt: now });
  });
});
