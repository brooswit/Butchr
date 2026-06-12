// Tests for butchr's BRIEF → EXPAND flow (POST /api/expand-brief, see src/expand.ts):
// the webapp's low-effort new-task path that turns a one-line IDEA into a proper,
// repo-grounded task prompt via a headless read-only claude.
//
// NO real headless `claude` is spawned: setBriefExpander injects a fake expander, so
// these exercise the validation + parsing + plumbing (brief in → expanded prompt out)
// without ever shelling out — the same mocking pattern the conformance gate uses.
//
// What this covers:
//   1. expandBrief happy path — a brief + repo cwd flows through the runner and the
//      expanded prompt comes back.
//   2. validation — a blank/whitespace brief is rejected (400) before the runner runs.
//   3. error surfacing — a NULL verdict / a runner throw becomes a clean 502-style
//      error (best-effort runner, but the operator-facing call is NOT best-effort).
//   4. pure helpers — buildExpandPrompt embeds the brief + format markers, and
//      parseExpansion pulls the prompt out of the sentinel-wrapped (or bare) stdout.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let CWD: string;
let DATA_DIR: string;
let expandMod: typeof import("../src/expand.ts");

beforeAll(async () => {
  // expand.ts imports workspaces.ts → db.ts, whose singleton opens a DB at import.
  // Point it at a throwaway dir so the test never touches the operator's real db.
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-expand-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";

  // A real directory for the expander's cwd (the fake runner never reads it, but
  // expandBrief passes it straight through, so use a valid path).
  CWD = mkdtempSync(join(tmpdir(), "butchr-expand-cwd-"));
  expandMod = await import("../src/expand.ts");
});

afterAll(() => {
  rmSync(CWD, { recursive: true, force: true });
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("expandBrief", () => {
  test("a brief flows through the runner and the expanded prompt comes back", async () => {
    const seen: import("../src/expand.ts").BriefExpansionInput[] = [];
    expandMod.setBriefExpander(async (input) => {
      seen.push(input);
      return `Implement: ${input.brief}\n- read CONTRIBUTING.md\n- add a test`;
    });

    const out = await expandMod.expandBrief("add a dark-mode toggle", CWD);

    expect(out).toContain("add a dark-mode toggle");
    expect(out).toContain("add a test");
    // The runner saw the trimmed brief + the repo cwd it should ground itself in.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.brief).toBe("add a dark-mode toggle");
    expect(seen[0]!.cwd).toBe(CWD);
  });

  test("trims the brief before handing it to the runner", async () => {
    let got = "";
    expandMod.setBriefExpander(async (input) => {
      got = input.brief;
      return "ok";
    });

    await expandMod.expandBrief("   add logging   ", CWD);
    expect(got).toBe("add logging");
  });

  test("rejects a blank brief (400) before the runner runs", async () => {
    let called = 0;
    expandMod.setBriefExpander(async () => {
      called++;
      return "should not run";
    });

    await expect(expandMod.expandBrief("   ", CWD)).rejects.toThrow(/brief is required/);
    await expect(expandMod.expandBrief(undefined as unknown as string, CWD)).rejects.toThrow(
      /brief is required/,
    );
    expect(called).toBe(0);
  });

  test("a NULL result surfaces a clean error (not best-effort for the operator)", async () => {
    expandMod.setBriefExpander(async () => null);
    await expect(expandMod.expandBrief("do a thing", CWD)).rejects.toThrow(/couldn't expand/);
  });

  test("a runner THROW is mapped to the same clean error", async () => {
    expandMod.setBriefExpander(async () => {
      throw new Error("claude blew up");
    });
    await expect(expandMod.expandBrief("do a thing", CWD)).rejects.toThrow(/couldn't expand/);
  });
});

describe("pure helpers", () => {
  test("buildExpandPrompt embeds the brief + the output markers + repo-grounding", () => {
    const p = expandMod.buildExpandPrompt("add a widget");
    expect(p).toContain("add a widget");
    expect(p).toContain("CONTRIBUTING.md");
    expect(p).toContain("<<<TASK_PROMPT>>>");
    expect(p).toContain("<<<END_TASK_PROMPT>>>");
  });

  test("parseExpansion pulls the prompt from between the sentinel markers", () => {
    const out = [
      "Let me read the repo first…",
      "Okay, here is the prompt:",
      "<<<TASK_PROMPT>>>",
      "Add a dark-mode toggle to public/index.html and wire it in public/app.js.",
      "<<<END_TASK_PROMPT>>>",
      "(done)",
    ].join("\n");
    expect(expandMod.parseExpansion(out)).toBe(
      "Add a dark-mode toggle to public/index.html and wire it in public/app.js.",
    );
  });

  test("parseExpansion falls back to the whole trimmed stdout when markers are absent", () => {
    expect(expandMod.parseExpansion("  just a bare prompt  ")).toBe("just a bare prompt");
  });

  test("parseExpansion returns null on empty / whitespace-only output", () => {
    expect(expandMod.parseExpansion("")).toBeNull();
    expect(expandMod.parseExpansion("   \n  ")).toBeNull();
    expect(expandMod.parseExpansion("<<<TASK_PROMPT>>>\n\n<<<END_TASK_PROMPT>>>")).toBeNull();
  });
});
