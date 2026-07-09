// Story st-9199c4ab (subtask calm-lemur-a588): the "Pipeline" tab renders per-story swimlanes; a
// lane lays its subtasks left → right by longest blocked_by chain WITHIN the lane. orderLaneLeaves
// is the PURE helper that computes that order (ties broken by original index for a stable layout).
//
// The swimlanes view now lives in public/views/swimlanes.js, which is DOM-free at module load, so
// we IMPORT it directly and assert on the real exports — as does graphLevels, its one dependency,
// from public/core/work-graph.js. (This test used to scrape a `<test-extract:swimlane-order>`
// sentinel block out of the classic public/app.js script and eval it with `new Function`; that
// harness is gone along with the sentinel.) Do not reintroduce a sentinel here.
import { expect, test } from "bun:test";
import { laneTitle, orderLaneLeaves, swimEmphasis } from "../public/views/swimlanes-logic.js";

const mk = (items: Array<{ id: string; blocked_by?: string[] }>) =>
  new Map(items.map((w) => [w.id, w]));

// ---------- orderLaneLeaves: topological, left → right, stable ----------

test("orders a linear blocked_by chain regardless of input order", () => {
  // c depends on b depends on a; feed them scrambled — output must be a, b, c.
  const byId = mk([
    { id: "c", blocked_by: ["b"] },
    { id: "a", blocked_by: [] },
    { id: "b", blocked_by: ["a"] },
  ]);
  expect(orderLaneLeaves(["c", "a", "b"], byId)).toEqual(["a", "b", "c"]);
});

test("ties (same chain depth) fall back to original index — stable", () => {
  // a and b are both roots (level 0); they keep their given order.
  const byId = mk([{ id: "a" }, { id: "b" }, { id: "c", blocked_by: ["a"] }]);
  expect(orderLaneLeaves(["a", "b", "c"], byId)).toEqual(["a", "b", "c"]);
  expect(orderLaneLeaves(["b", "a", "c"], byId)).toEqual(["b", "a", "c"]);
});

test("ignores blockers OUTSIDE the lane (cross-story deps don't reorder)", () => {
  // b's blocker "foreign" isn't a member — b stays a root, so order is insertion order.
  const byId = mk([
    { id: "a" },
    { id: "b", blocked_by: ["foreign"] },
  ]);
  expect(orderLaneLeaves(["a", "b"], byId)).toEqual(["a", "b"]);
});

test("a member missing from byId is tolerated (no throw)", () => {
  const byId = mk([{ id: "a", blocked_by: ["ghost"] }]);
  expect(orderLaneLeaves(["a", "ghost"], byId)).toEqual(expect.arrayContaining(["a", "ghost"]));
});

test("empty lane yields empty order", () => {
  expect(orderLaneLeaves([], mk([]))).toEqual([]);
});

// ---------- swimEmphasis: exactly one attention bucket per status ----------

test("swimEmphasis maps statuses to the intended emphasis bucket", () => {
  expect(swimEmphasis("needs_info")).toBe("attn");
  expect(swimEmphasis("needs_user_input")).toBe("attn");
  expect(swimEmphasis("in_progress")).toBe("active");
  expect(swimEmphasis("idle")).toBe("active");
  expect(swimEmphasis("blocked")).toBe("blocked");
  expect(swimEmphasis("inactive")).toBe("blocked");
  expect(swimEmphasis("merge_blocked")).toBe("blocked");
  expect(swimEmphasis("merged")).toBe("done");
  expect(swimEmphasis("in_review")).toBe("done");
  expect(swimEmphasis("aborted")).toBe("done");
});

// ---------- laneTitle: compact one-line title from a multi-thousand-char brief ----------

test("laneTitle takes the first non-empty line and clamps it with an ellipsis", () => {
  const brief = "Redesign the Graph tab into per-story pipeline swimlanes so the linear-chain data reads cleanly\n\nMore detail on the next line that should never appear.";
  const t = laneTitle(brief, "st-x", 70);
  expect(t.length).toBeLessThanOrEqual(71); // 70 chars + ellipsis
  expect(t.endsWith("…")).toBe(true);
  expect(t).not.toContain("\n");
  expect(t.startsWith("Redesign the Graph tab")).toBe(true);
});

test("laneTitle leaves a short first line untouched (no ellipsis)", () => {
  expect(laneTitle("Idle agents never silent\n\nbody...", "st-y")).toBe("Idle agents never silent");
});

test("laneTitle falls back to the id when the brief is empty/blank/missing", () => {
  expect(laneTitle("", "st-z")).toBe("st-z");
  expect(laneTitle(null, "st-z")).toBe("st-z");
  expect(laneTitle("   \n  \n", "st-z")).toBe("st-z");
});

test("laneTitle skips leading blank lines to the first real line", () => {
  expect(laneTitle("\n\n  Phase C — retire launchers  \nmore", "st-w")).toBe("Phase C — retire launchers");
});
