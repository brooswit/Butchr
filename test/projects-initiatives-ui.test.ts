// Story st-04869886 (S4): the project DETAIL view's Initiatives panel + the overview card's
// initiative rollup. This guards the pure, DOM-free derivation helpers:
//   - initiativeHeading:        a cross-repo InitiativeView carries no top-level brief, so the
//                               panel heading is derived from the first child's brief (clamped),
//                               falling back to the initiative id so a row never renders blank.
//   - initiativeRollup:         the per-initiative progress-bar fraction, LOCKED to the server's
//                               done predicate (rollupInitiatives in src/stories.ts) — a child is
//                               done ONLY when status==='done' (strictly, not merged), so the bar
//                               hits 100% exactly when the server's `done` boolean is true.
//   - projectInitiativeRollup:  the overview "X/Y initiatives done" count, using the server's
//                               authoritative `done` boolean on each initiative.
//
// public/app.js is a classic browser script (touches `document` at module load, no exports), so we
// extract the DOM-free helper block fenced with `// <test-extract:initiative-rollup>` sentinels and
// eval it in isolation — the same approach as test/projects-detail-ui.test.ts.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const APP = readFileSync(join(ROOT, "public", "app.js"), "utf8");

function extract(name: string): string {
  const m = APP.match(new RegExp(`// <test-extract:${name}>[^\\n]*\\n([\\s\\S]*?)// </test-extract:${name}>`));
  if (!m) throw new Error(`missing test-extract sentinel block: ${name}`);
  return m[1];
}

const { initiativeHeading, initiativeRollup, projectInitiativeRollup } = new Function(`
${extract("initiative-rollup")}
return { initiativeHeading, initiativeRollup, projectInitiativeRollup };
`)() as {
  initiativeHeading: (init: any) => string;
  initiativeRollup: (init: any) => { done: number; total: number; pct: number };
  projectInitiativeRollup: (inits: any) => { done: number; total: number; pct: number };
};

// ---- initiativeHeading -----------------------------------------------------
test("initiativeHeading: first child's brief, first line, clamped to 80 chars", () => {
  expect(initiativeHeading({
    initiative_id: "in-1",
    children: [{ brief: "One-tap checkout token exchange" }, { brief: "other" }],
  })).toBe("One-tap checkout token exchange");
  // multi-line → first line only
  expect(initiativeHeading({ initiative_id: "in-1", children: [{ brief: "Line one\nLine two" }] }))
    .toBe("Line one");
  // long → clamped to 77 chars + an ellipsis (78 total), so it never exceeds ~80
  const long = "x".repeat(120);
  const h = initiativeHeading({ initiative_id: "in-1", children: [{ brief: long }] });
  expect(h.length).toBe(78);
  expect(h.endsWith("…")).toBe(true);
});

test("initiativeHeading: skips blank-brief children, then falls back to the initiative id", () => {
  // first non-blank child wins
  expect(initiativeHeading({ initiative_id: "in-1", children: [{ brief: "  " }, { brief: "real brief" }] }))
    .toBe("real brief");
  // no child has a brief → id fallback
  expect(initiativeHeading({ initiative_id: "in-abc123", children: [{ brief: null }, {}] }))
    .toBe("Initiative in-abc123");
  // no children + no id → dash placeholder, never blank/throwing
  expect(initiativeHeading({ children: [] })).toBe("Initiative —");
  expect(initiativeHeading(null)).toBe("Initiative —");
});

// ---- initiativeRollup (LOCKED to status==='done') --------------------------
test("initiativeRollup: counts a child done ONLY when status==='done' (not merged)", () => {
  const init = {
    children: [
      { status: "done" },
      { status: "merged" },       // landed-but-not-'done' → NOT counted
      { status: "in_progress" },
    ],
  };
  expect(initiativeRollup(init)).toEqual({ done: 1, total: 3, pct: 33 });
});

test("initiativeRollup: all children done → pct 100 (matches server's done boolean)", () => {
  expect(initiativeRollup({ children: [{ status: "done" }, { status: "done" }] }))
    .toEqual({ done: 2, total: 2, pct: 100 });
});

test("initiativeRollup: empty / missing children → 0/0, pct 0 (no divide-by-zero)", () => {
  expect(initiativeRollup({ children: [] })).toEqual({ done: 0, total: 0, pct: 0 });
  expect(initiativeRollup({})).toEqual({ done: 0, total: 0, pct: 0 });
  expect(initiativeRollup(null)).toEqual({ done: 0, total: 0, pct: 0 });
});

// ---- projectInitiativeRollup (overview X/Y done) --------------------------
test("projectInitiativeRollup: counts DONE initiatives via the server's `done` boolean", () => {
  const inits = [{ done: true }, { done: false }, { done: true }, { done: false }];
  expect(projectInitiativeRollup(inits)).toEqual({ done: 2, total: 4, pct: 50 });
});

test("projectInitiativeRollup: empty / non-array → 0/0, pct 0", () => {
  expect(projectInitiativeRollup([])).toEqual({ done: 0, total: 0, pct: 0 });
  expect(projectInitiativeRollup(undefined)).toEqual({ done: 0, total: 0, pct: 0 });
});
