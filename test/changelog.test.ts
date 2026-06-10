// Unit tests for the PURE living-docs transforms (src/changelog.ts) that butchr
// applies at merge time (see git.finalizeLivingDocs). No fs / git — just string in,
// string out — so the entry-shape + idempotency + version-bump rules are pinned
// independently of the merge wiring exercised in test/finalize-changelog.test.ts.
import { describe, expect, test } from "bun:test";
import {
  bumpPatchVersion,
  insertUnreleasedEntry,
  isDocsOnlyDiff,
  summaryLine,
  taskMarker,
} from "../src/changelog.ts";

const WITH_CHANGED = `# Changelog

## [Unreleased]

### Added
- Older feature.

### Changed
- Existing change.

## [0.1.0] - 2026-01-01
- init
`;

const NO_CHANGED = `# Changelog

## [Unreleased]

### Added
- Older feature.

## [0.1.0] - 2026-01-01
- init
`;

describe("insertUnreleasedEntry", () => {
  test("inserts the bullet as the first item of an existing ### Changed group", () => {
    const out = insertUnreleasedEntry(WITH_CHANGED, "Do a thing", "task-1")!;
    const lines = out.split("\n");
    const ci = lines.findIndex((l) => l === "### Changed");
    expect(lines[ci + 1]).toBe("- Do a thing (task task-1)");
    // The pre-existing bullet is preserved right below the new one.
    expect(lines[ci + 2]).toBe("- Existing change.");
    // The Added group is untouched.
    expect(out).toContain("- Older feature.");
  });

  test("creates a ### Changed group under [Unreleased] when none exists", () => {
    const out = insertUnreleasedEntry(NO_CHANGED, "Fresh change", "task-2")!;
    const unreleased = out.slice(
      out.indexOf("## [Unreleased]"),
      out.indexOf("## [0.1.0]"),
    );
    expect(unreleased).toContain("### Changed");
    expect(unreleased).toContain("- Fresh change (task task-2)");
    // The new group sits above the existing Added group.
    expect(unreleased.indexOf("### Changed")).toBeLessThan(unreleased.indexOf("### Added"));
  });

  test("is idempotent — a second insert for the same task id is a no-op (null)", () => {
    const once = insertUnreleasedEntry(WITH_CHANGED, "Do a thing", "task-1")!;
    expect(insertUnreleasedEntry(once, "Do a thing again", "task-1")).toBeNull();
    // A different task still inserts.
    expect(insertUnreleasedEntry(once, "Another", "task-9")).not.toBeNull();
  });

  test("returns null when there is no [Unreleased] section to append to", () => {
    expect(insertUnreleasedEntry("# Changelog\n\n## [0.1.0]\n- x\n", "x", "task-3")).toBeNull();
  });

  test("falls back to a generic line for an empty/whitespace summary", () => {
    expect(summaryLine("", "task-4")).toBe("Changes from task task-4");
    expect(summaryLine("  \n ", "task-4")).toBe("Changes from task task-4");
    expect(summaryLine("multi\nline  text", "task-4")).toBe("multi line text");
  });

  test("marker shape", () => {
    expect(taskMarker("abc")).toBe("(task abc)");
  });
});

describe("bumpPatchVersion", () => {
  test("increments only the patch component, preserving formatting", () => {
    const pkg = `{\n  "name": "demo",\n  "version": "0.3.7"\n}\n`;
    const r = bumpPatchVersion(pkg)!;
    expect(r.from).toBe("0.3.7");
    expect(r.to).toBe("0.3.8");
    expect(r.text).toBe(`{\n  "name": "demo",\n  "version": "0.3.8"\n}\n`);
  });

  test("returns null when there is no version field", () => {
    expect(bumpPatchVersion(`{ "name": "demo" }`)).toBeNull();
  });
});

describe("isDocsOnlyDiff", () => {
  test("true only when every path is docs (.md/.mdx/.txt or docs/) and there is ≥1", () => {
    expect(isDocsOnlyDiff(["README.md", "docs/x.png", "NOTES.txt"])).toBe(true);
    expect(isDocsOnlyDiff(["README.md", "src/app.ts"])).toBe(false);
    expect(isDocsOnlyDiff([])).toBe(false);
    expect(isDocsOnlyDiff(["src/index.ts"])).toBe(false);
  });
});
