// Story st-9199c4ab (subtask calm-lemur-a588): the "Pipeline" tab renders per-story swimlanes; a
// lane lays its subtasks left → right by longest blocked_by chain WITHIN the lane. orderLaneLeaves
// is the PURE helper that computes that order (ties broken by original index for a stable layout).
//
// public/app.js is a classic browser script (touches `document` at module load, no exports), so we
// can't import it. We extract the DOM-free `swimlane-order` fence and eval it in isolation — the
// same approach as test/story-lifecycle-ui.test.ts. The block's one dependency, graphLevels, has
// moved to public/core/work-graph.js: we IMPORT the real function and inject it into the eval'd
// harness, so this test exercises the same graphLevels the app does. Once the swimlane view moves
// to public/views/, this fence goes with it and the eval disappears entirely.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { graphLevels } from "../public/core/work-graph.js";

const ROOT = join(import.meta.dir, "..");
const APP = readFileSync(join(ROOT, "public", "app.js"), "utf8");

function extract(name: string): string {
  const m = APP.match(new RegExp(`// <test-extract:${name}>[^\\n]*\\n([\\s\\S]*?)// </test-extract:${name}>`));
  if (!m) throw new Error(`missing test-extract sentinel block: ${name}`);
  return m[1];
}

const harness = `
${extract("swimlane-order")}
return { orderLaneLeaves, swimEmphasis, laneTitle };
`;
const { orderLaneLeaves, swimEmphasis, laneTitle } = new Function("graphLevels", harness)(graphLevels) as {
  orderLaneLeaves: (memberIds: string[], byId: Map<string, any>) => string[];
  swimEmphasis: (st: string) => string;
  laneTitle: (brief: string | null | undefined, id: string, max?: number) => string;
};

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
