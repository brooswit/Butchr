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
let originalTimeout: number;

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
  //
  // DELIBERATELY a plain `#!/bin/sh` (dash) stub, NOT `#!/usr/bin/env bun`: a cold
  // `bun` interpreter spawn per shell-out could, under saturated full-suite CPU load,
  // exceed the herdr shell-out timeout (config.herdrTimeoutMs, default 5s) — run()
  // would then SIGKILL it, herdrSoft would map that to null (reader → undefined), and
  // the killed process might die before it appended its argv line, making
  // agentGetCount() nondeterministic. A /bin/sh stub has ~zero interpreter warmup, so
  // every invocation is fork+exec-fast even under load, removing that timing race
  // while exercising the exact same real shell-out round-trips.
  const stub = join(DATA_DIR, "fake-herdr.sh");
  writeFileSync(
    stub,
    `#!/bin/sh
# Record this invocation's argv as a JSON ARRAY line, byte-identical to
# JSON.stringify(process.argv.slice(2)) — e.g. ["agent","get","a"] — by wrapping each
# positional arg in double quotes (q) and comma-joining. Args here are simple bareword
# tokens (no quotes/backslashes/spaces), so no JSON escaping is needed.
q='"'
line='['
i=0
for a in "$@"; do
  if [ "$i" -ne 0 ]; then line="$line,"; fi
  line="$line$q$a$q"
  i=1
done
line="$line]"
printf '%s\\n' "$line" >> "${CALLS_FILE}"
# FAIL_FILE present → exit 1 with EMPTY stdout (crashed/unreachable herdr; the res.ok
# guard must read this as ABSENT).
if [ -e "${FAIL_FILE}" ]; then exit 1; fi
# The noun is argv[0], the verb argv[1] ('agent get' / '<noun> get'); in /bin/sh
# positional terms that verb is $2. One envelope with every handle the field-probes read.
if [ "$2" = "get" ]; then
  printf '%s' '{"result":{"agent":{"tab_id":"tab-X","terminal_id":"term-X"},"pane":{"pane_id":"pane-X"}}}'
else
  printf '%s' '{}'
fi
`,
  );
  chmodSync(stub, 0o755);

  originalBin = cfg.herdrBin;
  cfg.herdrBin = stub;
  // Belt-and-suspenders alongside the fast /bin/sh stub: raise the herdr shell-out
  // timeout well above any plausible spawn latency so a slow spawn under full-suite
  // CPU load can never trip it. Restored in afterAll with herdrBin.
  originalTimeout = cfg.herdrTimeoutMs;
  cfg.herdrTimeoutMs = 30000;
});

afterAll(() => {
  cfg.herdrBin = originalBin;
  cfg.herdrTimeoutMs = originalTimeout;
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

describe("teardownTask closes the LIVE tab BY NAME, ignoring its stored id params", () => {
  test("re-resolves the tab from the agent NAME and never touches the (stale) stored tab/pane args", async () => {
    // ADDRESSING = NAME ONLY: the stored tab/pane args are deliberately STALE. teardown
    // must NOT close them — it re-resolves the live tab from the NAME (`agent get`) and
    // closes THAT, so a renumbered/stale stored id can never close a sibling's tab.
    await herdrMod.teardownTask("tab-STALE", "a", "pane-STALE");
    const calls = callsSince();
    expect(agentGetCount()).toBe(1); // resolved the live tab by name
    expect(calls).toContainEqual(["tab", "close", "tab-X"]); // closed the NAME-resolved tab
    // The stale stored ids were never the target of a close.
    expect(calls).not.toContainEqual(["tab", "close", "tab-STALE"]);
    expect(calls).not.toContainEqual(["pane", "close", "pane-STALE"]);
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
