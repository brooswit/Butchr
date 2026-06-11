// Tests for the harness SEND capability (src/herdr.ts `send`) — the control half
// of butchr's channel to a LIVE interactive agent (it otherwise only LAUNCHES +
// READS). We exercise the REAL herdr-backed `send` against a RECORDING herdr stub
// (a tiny executable repointed via `config.herdrBin`) so we can assert which herdr
// primitive each input form routes to, and that a dead/missing pane is a no-op.
//
// herdr.ts reads `config.herdrBin` at each call site (not cached at module load),
// so mutating it here repoints the bin for these tests; afterAll restores it. The
// stub answers `agent get <name>` with a pane id (or an error envelope when the
// DEAD flag-file exists, simulating a gone agent) and logs every other
// invocation's argv to a file so we can read back exactly what `send` shelled out.
//
// Both paths are BAKED INTO the stub as literals (and `dead` is toggled by a
// flag-FILE, not an env var) because `Bun.spawn` snapshots the environment at
// startup — runtime `process.env` mutations are NOT seen by the spawned stub.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let TMP: string;
let LOG: string;
let DEAD: string;
let cfg: typeof import("../src/config.ts").config;
let herdrMod: typeof import("../src/herdr.ts");
let originalBin: string;

beforeAll(async () => {
  TMP = mkdtempSync(join(tmpdir(), "butchr-send-"));
  LOG = join(TMP, "calls.log");
  DEAD = join(TMP, "dead.flag");
  const recorder = join(TMP, "fake-herdr.js");
  // The stub: resolve `agent get` to a pane (or error when the DEAD flag exists);
  // log everything else so the test can assert the exact herdr primitive invoked.
  writeFileSync(
    recorder,
    `#!/usr/bin/env bun
import { appendFileSync, existsSync } from "node:fs";
const LOG = ${JSON.stringify(LOG)};
const DEAD = ${JSON.stringify(DEAD)};
const argv = process.argv.slice(2);
if (argv[0] === "agent" && argv[1] === "get") {
  if (existsSync(DEAD)) {
    process.stdout.write(JSON.stringify({ error: { code: "agent_not_found" } }));
  } else {
    process.stdout.write(JSON.stringify({ result: { pane: { pane_id: ":7" } } }));
  }
} else {
  appendFileSync(LOG, JSON.stringify(argv) + "\\n");
  process.stdout.write("{}");
}
`,
  );
  chmodSync(recorder, 0o755);

  cfg = (await import("../src/config.ts")).config;
  herdrMod = await import("../src/herdr.ts");
  originalBin = cfg.herdrBin;
  cfg.herdrBin = recorder;
});

afterAll(() => {
  cfg.herdrBin = originalBin; // don't leak the stub into other files
  rmSync(TMP, { recursive: true, force: true });
});

/** The argv of each non-`agent get` herdr invocation `send` made, in order. */
function recordedCalls(): string[][] {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[]);
}
function reset(): void {
  writeFileSync(LOG, "");
  rmSync(DEAD, { force: true }); // agent is alive again
}
/** Make `agent get` start reporting the agent as gone (no pane resolves). */
function markDead(): void {
  writeFileSync(DEAD, "");
}

describe("herdrRunner.send routes inputs to the right herdr primitive", () => {
  test("literal text is written by NAME via `agent send`", async () => {
    reset();
    await herdrMod.herdrRunner.send("cto", { text: "just steering" });
    expect(recordedCalls()).toEqual([["agent", "send", "cto", "just steering"]]);
  });

  test("text + trailing Enter writes the text then submits with `pane send-keys Enter`", async () => {
    reset();
    await herdrMod.herdrRunner.send("cto", { text: "/compact", enter: true });
    expect(recordedCalls()).toEqual([
      ["agent", "send", "cto", "/compact"],
      ["pane", "send-keys", ":7", "Enter"],
    ]);
  });

  test("named keys are forwarded verbatim to `pane send-keys` on the resolved pane", async () => {
    reset();
    await herdrMod.herdrRunner.send("cto", { keys: ["C-c"] });
    expect(recordedCalls()).toEqual([["pane", "send-keys", ":7", "C-c"]]);
  });

  test("empty / no-op inputs shell out to nothing", async () => {
    reset();
    await herdrMod.herdrRunner.send("", { keys: ["C-c"] }); // no name
    await herdrMod.herdrRunner.send("cto", { keys: [] }); // no keys
    expect(recordedCalls()).toEqual([]);
  });
});

describe("herdrRunner.send is best-effort on a dead/missing pane", () => {
  test("a keys send to a gone agent is a no-op that never throws", async () => {
    reset();
    markDead(); // `agent get` now errors → no pane resolves
    await expect(
      herdrMod.herdrRunner.send("gone", { keys: ["C-c"] }),
    ).resolves.toBeUndefined();
    expect(recordedCalls()).toEqual([]); // send-keys was never attempted
  });

  test("text + Enter to a gone agent attempts the text best-effort, skips Enter, never throws", async () => {
    reset();
    markDead();
    await expect(
      herdrMod.herdrRunner.send("gone", { text: "/compact", enter: true }),
    ).resolves.toBeUndefined();
    // The literal text is attempted (swallowed by herdr); Enter needs a pane, which
    // never resolves, so it is skipped — no throw either way.
    expect(recordedCalls()).toEqual([["agent", "send", "gone", "/compact"]]);
  });
});
