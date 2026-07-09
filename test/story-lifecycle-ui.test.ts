// Story st-f4858e23 (ask #4, SECONDARY): a story container shouldn't just read "OPEN". The
// dashboard derives a working/parked/stalled lifecycle — PURELY front-end, from data every
// StoryView already carries (the per-status `counts` rollup + leader{running,desired} + status),
// with NO new backend field. This guards the derivation rule + the own-children progress rollup.
//
// The PURE derivations live in public/views/swimlanes-logic.js — the DOM-free leaf of the RFC
// Phase 2 horizontal split — and the node emitter that renders them in public/views/swimlanes.js
// (the Pipeline view owns it), which is DOM-free at module load. We IMPORT both directly and assert
// on the real exports. (This test used to scrape a `<test-extract:story-lifecycle-ui>` sentinel
// block out of the classic public/app.js script and eval it with `new Function` — stubbing
// esc/isCompleteStatus/storySubtaskTotal along the way; that harness is gone along with the
// sentinel, so the real leaves run here.) Do not reintroduce a sentinel here.
//
// storyLifecycleChip now returns a NODE (or null), so its assertions run inside withDom() — the
// zero-dependency DOM stub. It has no innerHTML, by design: assert on STRUCTURE (className /
// getAttribute / textContent), never on serialized markup. storyLifecycle and storyProgress are
// PURE and need no DOM at all.
import { expect, test } from "bun:test";
import { storyLifecycle, storyProgress } from "../public/views/swimlanes-logic.js";
import { storyLifecycleChip } from "../public/views/swimlanes.js";
import { withDom } from "./dom-stub";

const story = (o: any = {}) => ({ work_kind: "node", status: "open", counts: {}, leader: {}, ...o });

// ── Scoping: only OPEN node-kind stories get a lifecycle; everything else returns null ──
test("null for non-open status (their status chip already describes them)", () => {
  for (const status of ["merging", "merge_blocked", "done", "aborted"]) {
    expect(storyLifecycle(story({ status, counts: { in_progress: 2 } }))).toBeNull();
  }
});
test("null for a non-node work item and for missing input", () => {
  expect(storyLifecycle(story({ work_kind: "leaf", counts: { in_progress: 1 } }))).toBeNull();
  expect(storyLifecycle(null)).toBeNull();
});

// ── The 4-way derivation rule ──
test("moving > 0 ⇒ working, regardless of leader state", () => {
  expect(storyLifecycle(story({ counts: { in_progress: 1 }, leader: {} }))?.key).toBe("working");
  expect(storyLifecycle(story({ counts: { in_review: 1 }, leader: { desired: true, running: false } }))?.key).toBe("working");
});
test("remaining work + leader DESIRED but DOWN ⇒ stalled (⚠, nothing moving it)", () => {
  const lc = storyLifecycle(story({ counts: { blocked: 2 }, leader: { desired: true, running: false } }));
  expect(lc?.key).toBe("stalled");
  expect(lc?.glyph).toBe("⚠");
});
test("remaining work + leader UP (idle/blocked, nothing moving) ⇒ working", () => {
  expect(storyLifecycle(story({ counts: { idle: 1 }, leader: { desired: true, running: true } }))?.key).toBe("working");
  expect(storyLifecycle(story({ counts: { blocked: 1 }, leader: { running: true } }))?.key).toBe("working");
});
test("no children ⇒ parked (robust to empty counts)", () => {
  expect(storyLifecycle(story({ counts: {}, leader: {} }))?.key).toBe("parked");
  expect(storyLifecycle(story({ counts: { merged: 3, done: 1 }, leader: { running: true } }))?.key).toBe("parked"); // all finished, still open
});
test("remaining work but NO leader ever desired ⇒ parked, not stalled", () => {
  expect(storyLifecycle(story({ counts: { blocked: 1 }, leader: { desired: false, running: false } }))?.key).toBe("parked");
});

// ── Own-children progress (done over TRUE total; idle pseudo-bucket dropped) ──
test("storyProgress: complete over total, idle excluded from total", () => {
  expect(storyProgress({ merged: 2, in_progress: 1, idle: 5 })).toEqual({ done: 2, total: 3 });
  expect(storyProgress({ done: 1, rolled_back: 1, blocked: 1 })).toEqual({ done: 2, total: 3 });
  expect(storyProgress({})).toEqual({ done: 0, total: 0 });
});

// ── The lane-header chip: null when there's no lifecycle, otherwise a quiet outlined pill ──
test("storyLifecycleChip renders per-state class + is null for non-open", () => {
  withDom(() => {
    const working = storyLifecycleChip(story({ counts: { in_progress: 1 } }))!;
    expect(working.className).toBe("chip lc-working");
    expect(working.textContent).toBe("▶ working");
    expect(working.getAttribute("title")).toBe("story lifecycle — working");

    const stalled = storyLifecycleChip(story({ counts: { blocked: 1 }, leader: { desired: true, running: false } }))!;
    expect(stalled.className).toBe("chip lc-stalled");
    expect(stalled.textContent).toBe("⚠ stalled");

    expect(storyLifecycleChip(story({ status: "done", counts: { in_progress: 1 } }))).toBeNull();
  });
});
