// Tests for the DISK-SIZING helper (src/disk.ts → dirSizeBytes). Pure / in-process:
// builds a real temp tree on disk and verifies the byte/entry accounting, the
// missing-path zero case, symlink handling (counted as the link, never followed),
// and the bounded-walk truncation cap.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirSizeBytes } from "../src/disk.ts";

let ROOT: string;

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), "butchr-disk-test-"));
  // ROOT/
  //   a.txt        (100 bytes)
  //   sub/
  //     b.txt      (50 bytes)
  //     c.bin      (25 bytes)
  writeFileSync(join(ROOT, "a.txt"), "x".repeat(100));
  mkdirSync(join(ROOT, "sub"));
  writeFileSync(join(ROOT, "sub", "b.txt"), "y".repeat(50));
  writeFileSync(join(ROOT, "sub", "c.bin"), "z".repeat(25));
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("dirSizeBytes", () => {
  test("sums file bytes recursively across nested dirs", () => {
    const r = dirSizeBytes(ROOT);
    expect(r.bytes).toBe(175); // 100 + 50 + 25
    expect(r.truncated).toBe(false);
    // Entries visited: ROOT, a.txt, sub, b.txt, c.bin = 5.
    expect(r.entries).toBe(5);
  });

  test("a single nested directory sizes to just its files", () => {
    const r = dirSizeBytes(join(ROOT, "sub"));
    expect(r.bytes).toBe(75); // 50 + 25
  });

  test("a missing path is zero, not an error", () => {
    const r = dirSizeBytes(join(ROOT, "does-not-exist"));
    expect(r).toEqual({ bytes: 0, entries: 0, truncated: false });
  });

  test("symlinks are counted as the link entry, never followed", () => {
    const linkDir = mkdtempSync(join(tmpdir(), "butchr-disk-link-"));
    try {
      // A symlink pointing at ROOT (a big tree). It must NOT be traversed: the size
      // of linkDir should reflect only the link entry itself, not ROOT's 175 bytes.
      symlinkSync(ROOT, join(linkDir, "loop"));
      const r = dirSizeBytes(linkDir);
      expect(r.bytes).toBeLessThan(175);
      // linkDir + the one symlink entry = 2 entries; the target is never walked.
      expect(r.entries).toBe(2);
    } finally {
      rmSync(linkDir, { recursive: true, force: true });
    }
  });

  test("the entry cap bounds the walk and flags truncation", () => {
    // Cap below the 5-entry tree → stops early with truncated=true and a partial size.
    const r = dirSizeBytes(ROOT, 2);
    expect(r.truncated).toBe(true);
    expect(r.entries).toBe(2);
    expect(r.bytes).toBeLessThanOrEqual(175);
  });
});
