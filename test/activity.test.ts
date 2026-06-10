// Tests for the LIVE ACTIVITY PULSE extraction (src/transcript.ts): turning a
// Claude Code session JSONL into the single "what is the agent doing right now"
// line the webapp shows on a running task's card.
//
// Covers:
//   - the latest tool call is surfaced as "<tool> <target>" (name + primary arg);
//   - tool_results and user prose are SKIPPED so the last meaningful AGENT action
//     wins (a result is a response, not an action);
//   - the most recent assistant prose step is used when it's the latest meaningful
//     item, and thinking is a neutral fallback;
//   - an empty / all-noise transcript yields nulls;
//   - readSessionActivity reads only the TAIL of an on-disk transcript (located via
//     CLAUDE_CONFIG_DIR, like usage/transcript) yet still returns the latest action.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTranscriptActivity, readSessionActivity } from "../src/transcript.ts";
import { mungeCwd } from "../src/usage.ts";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

const asst = (id: string, ts: string | null, content: unknown) =>
  line({ type: "assistant", uuid: "u-" + id, timestamp: ts, message: { id, role: "assistant", content } });
const user = (uuid: string, ts: string | null, content: unknown) =>
  line({ type: "user", uuid, timestamp: ts, message: { role: "user", content } });

describe("parseTranscriptActivity", () => {
  test("surfaces the latest tool call as name + target", () => {
    const text = [
      user("u1", "2026-06-10T00:00:00.000Z", "do the thing"),
      asst("m1", "2026-06-10T00:00:01.000Z", [
        { type: "thinking", thinking: "let me look" },
        { type: "tool_use", name: "Read", input: { file_path: "/a/b.ts" } },
      ]),
    ].join("\n");
    expect(parseTranscriptActivity(text)).toEqual({
      lastAction: "Read /a/b.ts",
      lastAt: "2026-06-10T00:00:01.000Z",
    });
  });

  test("skips tool_result + user prose to find the last AGENT action", () => {
    const text = [
      asst("m1", "2026-06-10T00:00:01.000Z", [
        { type: "tool_use", name: "Bash", input: { command: "bun test", timeout: null } },
      ]),
      // a tool_result frame (a response) and trailing user prose must NOT win
      user("u2", "2026-06-10T00:00:02.000Z", [{ type: "tool_result", content: "42 pass" }]),
      user("u3", "2026-06-10T00:00:03.000Z", "looks good"),
    ].join("\n");
    expect(parseTranscriptActivity(text)).toEqual({
      lastAction: "Bash bun test",
      lastAt: "2026-06-10T00:00:01.000Z",
    });
  });

  test("uses the most recent assistant prose step when it's the latest", () => {
    const text = [
      asst("m1", "2026-06-10T00:00:01.000Z", [{ type: "tool_use", name: "Read", input: { file_path: "/x.ts" } }]),
      asst("m2", "2026-06-10T00:00:02.000Z", [{ type: "text", text: "All set — submitting for review." }]),
    ].join("\n");
    expect(parseTranscriptActivity(text)).toEqual({
      lastAction: "All set — submitting for review.",
      lastAt: "2026-06-10T00:00:02.000Z",
    });
  });

  test("falls back to thinking when that's the only meaningful step", () => {
    const text = asst("m1", "2026-06-10T00:00:01.000Z", [{ type: "thinking", thinking: "weighing options" }]);
    expect(parseTranscriptActivity(text)).toEqual({
      lastAction: "thinking…",
      lastAt: "2026-06-10T00:00:01.000Z",
    });
  });

  test("returns nulls for an empty / all-noise transcript", () => {
    expect(parseTranscriptActivity("")).toEqual({ lastAction: null, lastAt: null });
    expect(parseTranscriptActivity("\n{garbage}\n")).toEqual({ lastAction: null, lastAt: null });
    expect(parseTranscriptActivity(line({ type: "mode", mode: "default" }))).toEqual({
      lastAction: null,
      lastAt: null,
    });
    // A transcript whose only frames are tool_results (no agent action) → nulls.
    expect(
      parseTranscriptActivity(user("u1", null, [{ type: "tool_result", content: "output" }])),
    ).toEqual({ lastAction: null, lastAt: null });
  });
});

describe("readSessionActivity (tail of an on-disk transcript)", () => {
  let CLAUDE_DIR: string;
  const CWD = "/home/u/Code/proj";
  const SESSION = "sess-activity-1";
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;

  beforeAll(() => {
    CLAUDE_DIR = mkdtempSync(join(tmpdir(), "butchr-activity-"));
    process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR;
    const dir = join(CLAUDE_DIR, "projects", mungeCwd(CWD));
    mkdirSync(dir, { recursive: true });

    // Build a transcript LARGER than the tail window so the read genuinely starts
    // mid-file: a long run of early tool calls, then the latest action at the end.
    // Extraction must still report the final action (and tolerate the partial first
    // line the tail slice begins on).
    const lines: string[] = [];
    for (let i = 0; i < 4000; i++) {
      lines.push(asst("m" + i, "2026-06-10T00:00:00.000Z", [
        { type: "tool_use", name: "Read", input: { file_path: `/repo/early-file-${i}.ts` } },
      ]));
    }
    lines.push(asst("final", "2026-06-10T01:23:45.000Z", [
      { type: "tool_use", name: "Edit", input: { file_path: "/repo/final.ts" } },
    ]));
    writeFileSync(join(dir, `${SESSION}.jsonl`), lines.join("\n"));
  });

  afterAll(() => {
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfig;
    rmSync(CLAUDE_DIR, { recursive: true, force: true });
  });

  test("locates the transcript and returns the latest action from its tail", () => {
    expect(readSessionActivity(CWD, SESSION)).toEqual({
      lastAction: "Edit /repo/final.ts",
      lastAt: "2026-06-10T01:23:45.000Z",
    });
  });

  test("empty session id / missing transcript → nulls", () => {
    expect(readSessionActivity(CWD, "")).toEqual({ lastAction: null, lastAt: null });
    expect(readSessionActivity(CWD, "no-such-session")).toEqual({ lastAction: null, lastAt: null });
  });
});
