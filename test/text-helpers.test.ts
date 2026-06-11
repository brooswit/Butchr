// Edge-case coverage for the shared one-line text helpers (src/text.ts): the
// whitespace collapser and the clip-with-ellipsis function. These are pure,
// dependency-free string transforms, so the tests just import and call them —
// no env/db/herdr setup needed.
import { describe, expect, test } from "bun:test";
import { clipLine, collapseWs } from "../src/text.ts";

describe("collapseWs", () => {
  test("collapses every run of whitespace to a single space", () => {
    expect(collapseWs("a   b\t\tc\n\nd")).toBe("a b c d");
  });

  test("trims leading and trailing whitespace", () => {
    expect(collapseWs("  \t hi there \n ")).toBe("hi there");
  });

  test("a whitespace-only string collapses to empty", () => {
    expect(collapseWs("   \t\n  ")).toBe("");
  });

  test("an empty string stays empty", () => {
    expect(collapseWs("")).toBe("");
  });

  test("mixed newlines/tabs/spaces between words become single spaces", () => {
    expect(collapseWs("one \n\t two\r\nthree")).toBe("one two three");
  });
});

describe("clipLine — length relative to max", () => {
  test("returns the string unchanged when shorter than max", () => {
    expect(clipLine("hello", 10)).toBe("hello");
  });

  test("returns the string unchanged when exactly equal to max", () => {
    expect(clipLine("hello", 5)).toBe("hello");
  });

  test("truncates with an ellipsis when longer than max", () => {
    // 5 chars cap on a 9-char string → 4 kept chars + "…" = 5 chars total.
    expect(clipLine("abcdefghi", 5)).toBe("abcd…");
    expect(clipLine("abcdefghi", 5)).toHaveLength(5);
  });

  test("collapses whitespace before measuring/clipping", () => {
    // "a   b   c" collapses to "a b c" (5 chars), which fits a cap of 5 unchanged.
    expect(clipLine("a   b   c", 5)).toBe("a b c");
  });
});

describe("clipLine — tiny / non-positive max guard", () => {
  test("max === 2 keeps one char then the ellipsis", () => {
    expect(clipLine("abcdef", 2)).toBe("a…");
    expect(clipLine("abcdef", 2)).toHaveLength(2);
  });

  test("max === 1 yields just the ellipsis when truncating", () => {
    expect(clipLine("abcdef", 1)).toBe("…");
  });

  test("max === 1 returns a single-char string unchanged (no truncation)", () => {
    expect(clipLine("a", 1)).toBe("a");
  });

  test("max === 0 returns '' (a zero-width cap can hold nothing)", () => {
    expect(clipLine("abcdef", 0)).toBe("");
    expect(clipLine("", 0)).toBe("");
  });

  test("negative max returns '' rather than slicing off characters", () => {
    // The old `slice(0, max - 1)` with a negative end dropped chars off the end;
    // the guard makes any non-positive cap return "" deterministically.
    expect(clipLine("abcdef", -3)).toBe("");
    expect(clipLine("abcdef", -1)).toBe("");
  });
});

describe("clipLine — code-point awareness at the cut boundary", () => {
  test("an emoji straddling the cut is dropped whole — no lone-surrogate '�'", () => {
    // "ab😀cd": Array.from counts the emoji as ONE code point (it is a surrogate
    // PAIR in UTF-16). Clipping to 3 keeps "ab" + "…"; the emoji must not be split
    // into a lone surrogate that renders as the replacement char "�".
    const out = clipLine("ab😀cd", 3);
    expect(out).toBe("ab…");
    expect(out).not.toContain("�");
    // No unpaired surrogate code unit leaked into the output.
    for (const unit of out) {
      const cp = unit.codePointAt(0)!;
      expect(cp >= 0xd800 && cp <= 0xdfff).toBe(false);
    }
  });

  test("an all-emoji string is measured in code points, not UTF-16 units", () => {
    // Three emoji = 3 code points (6 UTF-16 units). A cap of 3 must keep all three
    // unchanged (not see length 6 and truncate).
    expect(clipLine("😀😁😂", 3)).toBe("😀😁😂");
    // A cap of 2 keeps one emoji whole + the ellipsis.
    expect(clipLine("😀😁😂", 2)).toBe("😀…");
  });
});
