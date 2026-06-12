// DRY-cleanup coverage for the herdr CLI wrapper (src/herdr.ts):
//
//  H1 — the three single-handle readers (agentTabId/agentPaneId/agentTerminalId)
//       and agentDeregister now derive every handle from ONE `agent get` envelope
//       via the private `agentInfo` round-trip, instead of each re-fetching the
//       same payload. We assert the field-probes still pick the right slice AND
//       that agentDeregister issues exactly ONE `agent get` (was two).
//  H3 — agentExists/workspaceExists share `existsByGet`, which keeps the `res.ok`
//       guard. The regression this fixes: a herdr that exits NON-ZERO with EMPTY
//       stdout must read as ABSENT (the old workspaceExists dropped the `res.ok`
//       guard and wrongly returned true).
//
// Both layers run against a COUNTING herdr stub repointed via config.herdrBin (the
// same technique as pane-renumber.test.ts), with a sentinel file recording every
// invocation so we can count `agent get` round-trips and force a non-zero exit.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let CALLS_FILE: string;
let FAIL_FILE: string;
let herdrMod: typeof import("../src/herdr.ts");
let cfg: typeof import("../src/config.ts").config;
let originalBin: string;

// Every stub invocation appends its argv (one JSON line) to CALLS_FILE; reset
// between tests. When the FAIL_FILE sentinel exists the stub exits 1 with empty
// stdout (the crashed/unreachable-herdr case the `res.ok` guard must catch).
function callsSince(): string[][] {
  let raw = "";
  try {
    raw = readFileSync(CALLS_FILE, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[]);
}

function agentGetCount(): number {
  return callsSince().filter((a) => a[0] === "agent" && a[1] === "get").length;
}

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-herdr-dry-"));
  CALLS_FILE = join(DATA_DIR, "calls.log");
  FAIL_FILE = join(DATA_DIR, "fail.sentinel");
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  cfg = (await import("../src/config.ts")).config;
  herdrMod = await import("../src/herdr.ts");

  // A stub that records every call and answers `agent get` / `<noun> get` with an
  // envelope carrying all three handles in one payload. When the FAIL_FILE sentinel
  // exists it exits 1 with empty stdout (no `"error"` field) — the guard regression
  // case (a crashed/unreachable herdr).
  const stub = join(DATA_DIR, "fake-herdr.js");
  writeFileSync(
    stub,
    `#!/usr/bin/env bun
import { appendFileSync, existsSync } from "node:fs";
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(CALLS_FILE)}, JSON.stringify(argv) + "\\n");
if (existsSync(${JSON.stringify(FAIL_FILE)})) { process.exit(1); }
const ok = (result) => process.stdout.write(JSON.stringify({ result }));
if (argv[1] === "get") {
  // One envelope with every handle the field-probes read.
  ok({ agent: { tab_id: "tab-X", terminal_id: "term-X" }, pane: { pane_id: "pane-X" } });
} else {
  process.stdout.write("{}");
}
`,
  );
  chmodSync(stub, 0o755);

  originalBin = cfg.herdrBin;
  cfg.herdrBin = stub;
});

afterAll(() => {
  cfg.herdrBin = originalBin;
  rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(CALLS_FILE, { force: true });
  rmSync(FAIL_FILE, { force: true });
});

describe("H1 — agentInfo backs the three single-handle readers (one round-trip each)", () => {
  test("agentTabId / agentPaneId / agentTerminalId pick the right slice of one envelope", async () => {
    expect(await herdrMod.agentTabId("a")).toBe("tab-X");
    expect(await herdrMod.agentPaneId("a")).toBe("pane-X");
    expect(await herdrMod.agentTerminalId("a")).toBe("term-X");
    // Each reader is exactly one `agent get`.
    expect(agentGetCount()).toBe(3);
  });

  test("a blank name short-circuits without shelling out", async () => {
    expect(await herdrMod.agentTabId("")).toBeUndefined();
    expect(await herdrMod.agentPaneId("")).toBeUndefined();
    expect(await herdrMod.agentTerminalId("")).toBeUndefined();
    expect(callsSince().length).toBe(0);
  });
});

describe("H1 — agentDeregister resolves tab+pane from ONE `agent get` (was two)", () => {
  test("issues a single `agent get`, then rename --clear + pane/tab close", async () => {
    await herdrMod.agentDeregister("a");
    // Exactly one round-trip for the lookup (previously agentTabId + agentPaneId = two).
    expect(agentGetCount()).toBe(1);
    const calls = callsSince();
    // The resolved handles drive the cleanup.
    expect(calls).toContainEqual(["agent", "rename", "a", "--clear"]);
    expect(calls).toContainEqual(["pane", "close", "pane-X"]);
    expect(calls).toContainEqual(["tab", "close", "tab-X"]);
  });
});

describe("H3 — existsByGet keeps the res.ok guard", () => {
  test("present entity → true for both nouns", async () => {
    expect(await herdrMod.agentExists("a")).toBe(true);
    expect(await herdrMod.workspaceExists("w")).toBe(true);
  });

  test("non-zero exit with EMPTY stdout → ABSENT (the workspaceExists guard fix)", async () => {
    writeFileSync(FAIL_FILE, "1");
    expect(await herdrMod.agentExists("a")).toBe(false);
    // Regression: the old workspaceExists dropped `res.ok &&`, so this returned true.
    expect(await herdrMod.workspaceExists("w")).toBe(false);
  });

  test("blank id short-circuits without shelling out", async () => {
    expect(await herdrMod.agentExists("")).toBe(false);
    expect(await herdrMod.workspaceExists("")).toBe(false);
    expect(callsSince().length).toBe(0);
  });
});
