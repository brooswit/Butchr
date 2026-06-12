// Unit tests for the PURE living-docs helpers (src/changelog.ts) behind butchr's two
// OPT-IN merge/review gates: the version-bump transform applied at merge
// (git.bumpVersionFile) and the changelog-update gate evaluated at review
// (tasks.triggerCi). No fs / git — just values in, verdict out — so the rules are
// pinned independently of the merge/CI wiring (see test/finalize-changelog.test.ts +
// test/ci-gate.test.ts). butchr no longer WRITES the changelog, so there is no
// entry-insertion transform to test here anymore.
import { describe, expect, test } from "bun:test";
import {
  bumpPatchVersion,
  checkChangelogUpdated,
  isDocsOnlyDiff,
} from "../src/changelog.ts";

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

describe("checkChangelogUpdated (the opt-in changelog gate)", () => {
  test("a code change that touched the changelog passes", () => {
    const v = checkChangelogUpdated(["src/app.ts", "CHANGELOG.md"], "CHANGELOG.md");
    expect(v.ok).toBe(true);
    expect(v.reason).toContain("CHANGELOG.md");
  });

  test("a code change that did NOT touch the changelog fails", () => {
    const v = checkChangelogUpdated(["src/app.ts"], "CHANGELOG.md");
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("must add a changelog entry");
  });

  test("a docs-only diff is exempt (no changelog entry required)", () => {
    expect(checkChangelogUpdated(["README.md", "docs/x.png"], "CHANGELOG.md").ok).toBe(true);
    // A changelog-only edit is itself docs-only → exempt (no infinite requirement).
    expect(checkChangelogUpdated(["CHANGELOG.md"], "CHANGELOG.md").ok).toBe(true);
  });

  test("an empty diff is exempt", () => {
    expect(checkChangelogUpdated([], "CHANGELOG.md").ok).toBe(true);
  });

  test("a blank configured path disables the gate (always ok)", () => {
    expect(checkChangelogUpdated(["src/app.ts"], "").ok).toBe(true);
    expect(checkChangelogUpdated(["src/app.ts"], "   ").ok).toBe(true);
  });

  test("honors a non-default changelog location and normalizes paths", () => {
    // A configured nested path: a code change must touch THAT file.
    expect(checkChangelogUpdated(["src/app.ts"], "docs/CHANGES.md").ok).toBe(false);
    expect(checkChangelogUpdated(["src/app.ts", "docs/CHANGES.md"], "docs/CHANGES.md").ok).toBe(true);
    // A leading "./" on the configured path still matches a bare diff path.
    expect(checkChangelogUpdated(["src/app.ts", "CHANGELOG.md"], "./CHANGELOG.md").ok).toBe(true);
  });
});
