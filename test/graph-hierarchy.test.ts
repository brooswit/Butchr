// Story st-f4858e23 ask #2 (subtask brave-stag-1af8): the GRAPH view now shows the
// story→subtask HIERARCHY explicitly — an ALWAYS-drawn labeled story container (incl. the empty
// case) plus dashed no-arrow child-of connectors distinct from the solid blocked_by edges.
//
// public/app.js is a classic browser script (touches `document` at module load, no exports), so
// we can't import it. We extract the PURE, DOM-free `graph-membership` helper block fenced with
// `<test-extract:graph-membership>` and eval it in isolation — the same approach as
// test/graph-rollup-completion.test.ts and test/state-meta-fallback.test.ts.
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

const harness = `
${extract("graph-membership")}
return { graphChildOf, storyMemberIds, storySubtaskTotal };
`;
const { graphChildOf, storyMemberIds, storySubtaskTotal } = new Function(harness)() as {
  graphChildOf: (w: any) => string | undefined;
  storyMemberIds: (storyId: string, ids: Iterable<string>, byId: Map<string, any>) => string[];
  storySubtaskTotal: (counts: any) => number;
};

// ---------- graphChildOf: canonical membership rule (parent_id wins over story_id) ----------

test("graphChildOf prefers parent_id over story_id", () => {
  expect(graphChildOf({ parent_id: "st-A", story_id: "st-B" })).toBe("st-A");
  expect(graphChildOf({ story_id: "st-B" })).toBe("st-B"); // no parent_id → falls back
  expect(graphChildOf({})).toBeFalsy(); // a story node carries neither
  expect(graphChildOf(null)).toBeFalsy();
});

// ---------- storyMemberIds: VISIBLE child leaves only, filtered to the rendered node set ----------

function mkById(items: any[]) {
  return new Map(items.map((w) => [w.id, w]));
}

test("storyMemberIds returns only LEAF children owned by the story (not the story itself)", () => {
  const items = [
    { id: "st-1", work_kind: "node", status: "open" },
    { id: "t-a", work_kind: "leaf", parent_id: "st-1", status: "in_progress" },
    { id: "t-b", work_kind: "leaf", story_id: "st-1", status: "inactive" }, // via story_id
    { id: "t-c", work_kind: "leaf", parent_id: "st-2", status: "inactive" }, // other story
    { id: "st-2", work_kind: "node", status: "open" },
  ];
  const byId = mkById(items);
  const ids = new Set(items.map((w) => w.id));
  expect(storyMemberIds("st-1", ids, byId).sort()).toEqual(["t-a", "t-b"]);
  expect(storyMemberIds("st-2", ids, byId)).toEqual(["t-c"]);
  // never includes the story node itself
  expect(storyMemberIds("st-1", ids, byId)).not.toContain("st-1");
});

test("storyMemberIds excludes children hidden by the depth/generations slider (no dangling edge)", () => {
  // t-b is owned by st-1 but NOT in the rendered node set → must be excluded so no child-of edge
  // is synthesized for a hidden endpoint.
  const items = [
    { id: "st-1", work_kind: "node", status: "open" },
    { id: "t-a", work_kind: "leaf", parent_id: "st-1", status: "in_progress" },
    { id: "t-b", work_kind: "leaf", parent_id: "st-1", status: "merged" },
  ];
  const byId = mkById(items);
  const visible = new Set(["st-1", "t-a"]); // t-b filtered out by the slider
  expect(storyMemberIds("st-1", visible, byId)).toEqual(["t-a"]);
});

test("storyMemberIds returns [] for a story with no visible children (container still drawn by caller)", () => {
  const items = [{ id: "st-1", work_kind: "node", status: "open" }];
  const byId = mkById(items);
  expect(storyMemberIds("st-1", new Set(["st-1"]), byId)).toEqual([]);
});

// ---------- storySubtaskTotal: HONEST empty state (zero total, not zero-visible) ----------

test("storySubtaskTotal is zero ONLY for a genuinely childless story", () => {
  expect(storySubtaskTotal(undefined)).toBe(0);
  expect(storySubtaskTotal({})).toBe(0);
  expect(storySubtaskTotal({ idle: 2 })).toBe(0); // idle is a pseudo-bucket, not a real subtask
});

test("storySubtaskTotal counts real subtasks even when all are finished or none are visible", () => {
  // A decomposed story whose children are all merged: total>0, so NOT 'no subtasks yet'.
  expect(storySubtaskTotal({ merged: 3 })).toBe(3);
  // Mixed rollup — idle excluded, every other status counted.
  expect(storySubtaskTotal({ in_progress: 1, inactive: 2, merged: 1, idle: 5 })).toBe(4);
});
