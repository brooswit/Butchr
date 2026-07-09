// F3 + F4 regression (story st-c656c44e): two LOW client-side cleanups in public/app.js.
//
// F3: the cross-type progress bars (graph node sub-bar in drawGraphSvg, dependentRollup) counted
// ONLY status === "merged" as complete. But a dependent that is a STORY (a graph NODE) lands at
// status "done", NOT "merged" — so it sat in the subtree total but never in the merged numerator,
// UNDER-reporting "N/M merged" for any subtree gating a story. The fix routes both bars through a
// single completion predicate (isCompleteStatus) covering done | merged | rolled_back.
//
// F4: WORK_TREE_EXPANDED (Set) and activityCache (Map) only ever added ids; work leaving the list
// kept its entry forever → unbounded growth over a long session. pruneWorkCaches drops ids no
// longer in the current work set.
//
// Both helpers live in public/core/work-graph.js, which is DOM-free at module load, so we import
// them directly and assert on the real exports. They used to be fenced by `<test-extract:...>`
// sentinels and eval'd out of the classic public/app.js script with `new Function`, because that
// script could not be imported. That harness is gone — do not reintroduce a sentinel. Same
// approach as test/state-meta-fallback.test.ts.
import { expect, test } from "bun:test";
import { isCompleteStatus, pruneWorkCaches } from "../public/core/work-graph.js";

// ---------- F3: cross-type completion predicate ----------

test("isCompleteStatus treats a STORY's `done` as complete (not just `merged`)", () => {
  expect(isCompleteStatus("done")).toBe(true); // a completed STORY node
  expect(isCompleteStatus("merged")).toBe(true); // a completed LEAF task
  expect(isCompleteStatus("rolled_back")).toBe(true); // a successful rollback
  // in-flight / dead statuses are NOT complete
  expect(isCompleteStatus("in_progress")).toBe(false);
  expect(isCompleteStatus("in_review")).toBe(false);
  expect(isCompleteStatus("failed")).toBe(false);
  expect(isCompleteStatus("aborted")).toBe(false);
  expect(isCompleteStatus("open")).toBe(false);
});

// ---------- F4: cache prune bound ----------

test("pruneWorkCaches drops expanded + activity ids no longer in the live work set", () => {
  const expanded = new Set<string>(["st-live", "st-gone"]);
  const activity = new Map<string, any>([
    ["t-live", { lastAction: "edit" }],
    ["t-gone", { lastAction: "read" }],
  ]);
  const liveIds = new Set<string>(["st-live", "t-live"]);

  pruneWorkCaches(liveIds, expanded, activity);

  expect([...expanded]).toEqual(["st-live"]);
  expect([...activity.keys()]).toEqual(["t-live"]);
  // present ids are untouched (value preserved)
  expect(activity.get("t-live")).toEqual({ lastAction: "edit" });
});

test("pruneWorkCaches on an empty live set clears everything (work all left the list)", () => {
  const expanded = new Set<string>(["a", "b"]);
  const activity = new Map<string, any>([["a", 1], ["b", 2]]);
  pruneWorkCaches(new Set(), expanded, activity);
  expect(expanded.size).toBe(0);
  expect(activity.size).toBe(0);
});
