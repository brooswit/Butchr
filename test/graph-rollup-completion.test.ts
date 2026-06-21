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
// public/app.js is a classic browser script (touches `document` at module load, no exports), so we
// can't import it. We extract the PURE, DOM-free helper blocks fenced with `<test-extract:...>`
// sentinels and eval them in isolation — the same approach as test/state-meta-fallback.test.ts.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const APP = readFileSync(join(ROOT, "public", "app.js"), "utf8");

/** Pull the source fenced by `// <test-extract:name>` ... `// </test-extract:name>`. The opening
 *  sentinel may share its `//` line with prose, so capture from the NEXT line. */
function extract(name: string): string {
  const m = APP.match(new RegExp(`// <test-extract:${name}>[^\\n]*\\n([\\s\\S]*?)// </test-extract:${name}>`));
  if (!m) throw new Error(`missing test-extract sentinel block: ${name}`);
  return m[1];
}

const harness = `
${extract("complete-status")}
${extract("prune-caches")}
return { COMPLETE_STATUSES, isCompleteStatus, countComplete, pruneWorkCaches };
`;
const { isCompleteStatus, countComplete, pruneWorkCaches } = new Function(harness)() as {
  COMPLETE_STATUSES: Set<string>;
  isCompleteStatus: (status: string) => boolean;
  countComplete: (ids: Iterable<string>, byId: Map<string, any>) => number;
  pruneWorkCaches: (liveIds: Set<string>, expanded: Set<string>, activity: Map<string, any>) => void;
};

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

test("gated-subtree count INCLUDES a `done` story — a {done story, merged leaf} subtree reads 2/2", () => {
  // The exact pre-fix bug: one done STORY + one merged LEAF.
  const byId = new Map<string, any>([
    ["st-1", { id: "st-1", work_kind: "node", status: "done" }],
    ["t-1", { id: "t-1", work_kind: "leaf", status: "merged" }],
  ]);
  const subIds = ["st-1", "t-1"];
  // pre-fix (merged-only) reported 1/2; the fix must report 2/2.
  expect(countComplete(subIds, byId)).toBe(2);
});

test("countComplete excludes in-flight/dead and tolerates unknown ids", () => {
  const byId = new Map<string, any>([
    ["st-1", { id: "st-1", work_kind: "node", status: "done" }],
    ["t-1", { id: "t-1", work_kind: "leaf", status: "in_progress" }],
    ["t-2", { id: "t-2", work_kind: "leaf", status: "failed" }],
    ["t-3", { id: "t-3", work_kind: "leaf", status: "merged" }],
  ]);
  // 2 complete (st-1 done, t-3 merged); t-1 in_progress + t-2 failed excluded; "ghost" missing.
  expect(countComplete(["st-1", "t-1", "t-2", "t-3", "ghost"], byId)).toBe(2);
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
