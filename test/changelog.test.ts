// Unit tests for the PURE living-docs helpers (src/changelog.ts) behind butchr's
// merge/review gates: the version-bump transform applied at merge
// (git.bumpVersionFile), the release-mode changelog STAMP (promoteUnreleased), and the
// changelog-update gate evaluated at review (tasks.triggerCi). No fs / git — just values
// in, verdict/text out — so the rules are pinned independently of the merge/CI wiring
// (see test/finalize-changelog.test.ts + test/ci-gate.test.ts).
import { describe, expect, test } from "bun:test";
import {
  bumpVersion,
  checkChangelogUpdated,
  isDocsOnlyDiff,
  promoteUnreleased,
} from "../src/changelog.ts";

describe("bumpVersion", () => {
  test("patch increments only the patch component, preserving formatting", () => {
    const pkg = `{\n  "name": "demo",\n  "version": "0.3.7"\n}\n`;
    const r = bumpVersion(pkg, "patch")!;
    expect(r.from).toBe("0.3.7");
    expect(r.to).toBe("0.3.8");
    expect(r.text).toBe(`{\n  "name": "demo",\n  "version": "0.3.8"\n}\n`);
  });

  test("patch is the default level", () => {
    const r = bumpVersion(`{ "version": "1.2.3" }`)!;
    expect(r.to).toBe("1.2.4");
  });

  test("minor increments minor and ZEROES the patch", () => {
    const r = bumpVersion(`{ "version": "0.3.7" }`, "minor")!;
    expect(r.from).toBe("0.3.7");
    expect(r.to).toBe("0.4.0");
  });

  test("major increments major and ZEROES minor + patch", () => {
    const r = bumpVersion(`{ "version": "0.3.7" }`, "major")!;
    expect(r.from).toBe("0.3.7");
    expect(r.to).toBe("1.0.0");
  });

  test("returns null when there is no version field", () => {
    expect(bumpVersion(`{ "name": "demo" }`, "minor")).toBeNull();
  });
});

describe("promoteUnreleased (the release-mode changelog stamp)", () => {
  const base = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "### Added",
    "- a new thing",
    "",
    "## [0.9.0] - 2026-01-01",
    "",
    "### Added",
    "- the old thing",
    "",
  ].join("\n");

  test("moves the Unreleased body into a versioned section, leaving a fresh empty Unreleased above", () => {
    const out = promoteUnreleased(base, "0.9.1", "2026-06-12");
    // Fresh empty [Unreleased] heading is still present and now has NO body before the
    // new versioned heading.
    expect(out).toContain("## [Unreleased]\n\n## [0.9.1] - 2026-06-12");
    // The relocated body sits under the new versioned heading.
    expect(out).toContain("## [0.9.1] - 2026-06-12\n\n### Added\n- a new thing");
    // The pre-existing 0.9.0 section is untouched.
    expect(out).toContain("## [0.9.0] - 2026-01-01\n\n### Added\n- the old thing");
    // Exactly one [Unreleased] heading remains.
    expect(out.match(/^## \[Unreleased\]/gm)!.length).toBe(1);
  });

  test("TWO sequential merges produce two distinct clean version sections with a fresh empty [Unreleased] between (cascade ended)", () => {
    // First merge: author a body under [Unreleased], then stamp it.
    const afterFirst = promoteUnreleased(base, "0.9.1", "2026-06-12");
    // The next task authors a NEW body under the fresh empty [Unreleased].
    const reauthored = afterFirst.replace(
      "## [Unreleased]\n",
      "## [Unreleased]\n\n### Fixed\n- a follow-up fix\n",
    );
    // Second merge stamps again.
    const afterSecond = promoteUnreleased(reauthored, "0.9.2", "2026-06-13");

    // Two distinct, clean versioned sections now exist, each owning its own heading.
    expect(afterSecond).toContain("## [0.9.2] - 2026-06-13\n\n### Fixed\n- a follow-up fix");
    expect(afterSecond).toContain("## [0.9.1] - 2026-06-12\n\n### Added\n- a new thing");
    expect(afterSecond).toContain("## [0.9.0] - 2026-01-01");
    // Still exactly ONE [Unreleased] heading — the cascade does not accumulate.
    expect(afterSecond.match(/^## \[Unreleased\]/gm)!.length).toBe(1);
    // The two stamped versions are separate headings (order: newest Unreleased-adjacent).
    const idx2 = afterSecond.indexOf("## [0.9.2]");
    const idx1 = afterSecond.indexOf("## [0.9.1]");
    const idx0 = afterSecond.indexOf("## [0.9.0]");
    expect(idx2).toBeGreaterThan(-1);
    expect(idx2).toBeLessThan(idx1);
    expect(idx1).toBeLessThan(idx0);
  });

  test("with NO [Unreleased] heading, inserts the versioned section above the first existing section", () => {
    const noUnreleased = [
      "# Changelog",
      "",
      "## [0.9.0] - 2026-01-01",
      "",
      "- the old thing",
      "",
    ].join("\n");
    const out = promoteUnreleased(noUnreleased, "0.9.1", "2026-06-12");
    expect(out).toContain("## [0.9.1] - 2026-06-12");
    // It is placed ABOVE the pre-existing 0.9.0 section, and no [Unreleased] is invented.
    expect(out.indexOf("## [0.9.1]")).toBeLessThan(out.indexOf("## [0.9.0]"));
    expect(out).not.toContain("[Unreleased]");
  });

  test("leaves a trailing [Unreleased]: link-reference footer untouched", () => {
    const withFooter = base + "\n[Unreleased]: https://example.com/compare\n";
    const out = promoteUnreleased(withFooter, "0.9.1", "2026-06-12");
    expect(out).toContain("[Unreleased]: https://example.com/compare");
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

  describe("strict mode (release_mode)", () => {
    test("drops the docs-only exemption — a docs-only diff that didn't touch the changelog FAILS", () => {
      const v = checkChangelogUpdated(["README.md"], "CHANGELOG.md", { strict: true });
      expect(v.ok).toBe(false);
      expect(v.reason).toContain("must add a changelog entry");
    });

    test("a docs-only diff that DID touch the changelog still passes", () => {
      expect(
        checkChangelogUpdated(["README.md", "CHANGELOG.md"], "CHANGELOG.md", { strict: true }).ok,
      ).toBe(true);
      // A changelog-only edit satisfies strict too (it touched the file).
      expect(checkChangelogUpdated(["CHANGELOG.md"], "CHANGELOG.md", { strict: true }).ok).toBe(true);
    });

    test("an empty diff stays exempt even in strict mode (nothing to record)", () => {
      expect(checkChangelogUpdated([], "CHANGELOG.md", { strict: true }).ok).toBe(true);
    });

    test("a code change still requires the changelog (same as non-strict)", () => {
      expect(checkChangelogUpdated(["src/app.ts"], "CHANGELOG.md", { strict: true }).ok).toBe(false);
      expect(
        checkChangelogUpdated(["src/app.ts", "CHANGELOG.md"], "CHANGELOG.md", { strict: true }).ok,
      ).toBe(true);
    });
  });
});
