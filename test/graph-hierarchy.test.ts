// Story st-f4858e23 ask #2 (subtask brave-stag-1af8): the GRAPH view now shows the
// story→subtask HIERARCHY explicitly — an ALWAYS-drawn labeled story container (incl. the empty
// case) plus dashed no-arrow child-of connectors distinct from the solid blocked_by edges.
//
// These helpers live in public/core/work-graph.js, which is DOM-free at module load, so we
// import them directly and assert on the real exports. They used to be fenced by a
// `<test-extract:graph-membership>` sentinel and eval'd out of the classic public/app.js script
// with `new Function`, because that script could not be imported. That harness is gone — do not
// reintroduce a sentinel. Same approach as test/state-meta-fallback.test.ts.
import { expect, test } from "bun:test";
import { graphChildOf, storyMemberIds, storySubtaskTotal } from "../public/core/work-graph.js";

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
