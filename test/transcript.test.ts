// Tests for the AGENT TRANSCRIPT parser (src/transcript.ts): turning a Claude Code
// session JSONL into an ordered, role-labelled list of renderable items.
//
// Covers:
//   - user/assistant prose, assistant thinking, tool_use (name + brief args), and
//     tool_result (string OR block-array content) are all extracted, in order.
//   - internal frames (mode, attachment, file-history-snapshot, …) are skipped.
//   - long bodies are truncated to the cap with a `truncated` flag; brief args
//     collapse/clip and skip null values.
//   - repeated turns are deduped (assistant by message id, user by frame uuid).
//   - blank/garbage lines are tolerated; an empty/all-noise transcript → [].
//
// The parser is pure (no DB/herdr/config), so this imports it directly with no env
// setup — readSessionTranscript's disk path is exercised via findTranscript in
// model-usage.test.ts.
import { describe, expect, test } from "bun:test";
import { parseTranscript } from "../src/transcript.ts";

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

describe("parseTranscript", () => {
  test("extracts prose, thinking, tool calls + results in order, skipping noise", () => {
    const text = [
      line({ type: "mode", mode: "default" }), // internal frame → skipped
      line({ type: "attachment", attachment: {} }), // internal frame → skipped
      line({ type: "user", uuid: "u1", timestamp: "2026-06-10T00:00:00.000Z", message: { role: "user", content: "do the thing" } }),
      line({
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-06-10T00:00:01.000Z",
        message: {
          id: "m1",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me think" },
            { type: "text", text: "I'll read the file." },
            { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/x/y.ts" } },
          ],
        },
      }),
      line({
        type: "user",
        uuid: "u2",
        timestamp: "2026-06-10T00:00:02.000Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "1\tconst a = 1;" }] },
      }),
    ].join("\n");

    const items = parseTranscript(text);
    expect(items.map((i) => i.kind)).toEqual([
      "text", // user prose
      "thinking",
      "text", // assistant prose
      "tool_use",
      "tool_result",
    ]);

    expect(items[0]).toMatchObject({ role: "user", kind: "text", text: "do the thing", ts: "2026-06-10T00:00:00.000Z" });
    expect(items[1]).toMatchObject({ role: "assistant", kind: "thinking", text: "let me think" });
    expect(items[3]).toMatchObject({ role: "assistant", kind: "tool_use", tool: "Read", args: "file_path=/x/y.ts" });
    expect(items[4]).toMatchObject({ role: "user", kind: "tool_result", text: "1\tconst a = 1;" });
  });

  test("tool_result content as a block array flattens text blocks and marks others", () => {
    const text = line({
      type: "user",
      uuid: "u1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: [
              { type: "text", text: "first line" },
              { type: "image", source: {} },
            ],
          },
        ],
      },
    });
    const items = parseTranscript(text);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("tool_result");
    expect(items[0]!.text).toBe("first line\n[image]");
  });

  test("brief args collapse whitespace, clip long values, and skip null", () => {
    const longVal = "x".repeat(200);
    const text = line({
      type: "assistant",
      uuid: "a1",
      message: {
        id: "m1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "echo  hi\n  there", timeout: null, big: longVal, count: 3 },
          },
        ],
      },
    });
    const items = parseTranscript(text);
    const args = items[0]!.args!;
    expect(items[0]!.tool).toBe("Bash");
    expect(args).toContain("command=echo hi there"); // whitespace collapsed
    expect(args).toContain("count=3");
    expect(args).not.toContain("timeout"); // null value skipped
    expect(args).toContain("…"); // long value clipped
  });

  test("truncates a long body to the cap and flags it truncated", () => {
    const huge = "y".repeat(5000);
    const text = line({
      type: "user",
      uuid: "u1",
      message: { role: "user", content: [{ type: "tool_result", content: huge }] },
    });
    const items = parseTranscript(text);
    expect(items[0]!.truncated).toBe(true);
    expect(items[0]!.text!.length).toBe(2000); // RESULT_CAP
  });

  test("dedupes repeated turns: assistant by message id, user by frame uuid", () => {
    const asst = line({
      type: "assistant",
      uuid: "a1",
      message: { id: "dup", role: "assistant", content: [{ type: "text", text: "once" }] },
    });
    const usr = line({ type: "user", uuid: "dup-u", message: { role: "user", content: "hi" } });
    const items = parseTranscript([asst, asst, usr, usr].join("\n"));
    expect(items.map((i) => i.text)).toEqual(["once", "hi"]);
  });

  test("tolerates blank/garbage lines and returns [] for an all-noise transcript", () => {
    expect(parseTranscript("")).toEqual([]);
    expect(parseTranscript("\n{not json}\n")).toEqual([]);
    expect(parseTranscript(line({ type: "mode", mode: "x" }))).toEqual([]);
    // An assistant frame with only empty text blocks yields nothing.
    expect(
      parseTranscript(line({ type: "assistant", uuid: "a1", message: { id: "m1", content: [{ type: "text", text: "   " }] } })),
    ).toEqual([]);
  });
});
