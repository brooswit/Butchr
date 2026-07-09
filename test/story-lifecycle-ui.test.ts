// Story st-f4858e23 (ask #4, SECONDARY): a story container shouldn't just read "OPEN". The
// dashboard derives a working/parked/stalled lifecycle — PURELY front-end, from data every
// StoryView already carries (the per-status `counts` rollup + leader{running,desired} + status),
// with NO new backend field. This guards the derivation rule + the own-children progress rollup.
//
// The PURE derivations live in public/views/swimlanes-logic.ts — the DOM-free leaf of the RFC
// Phase 2 horizontal split — and they are UNCHANGED by the Phase 4c React migration, so the
// assertions below are character-for-character what they were. That is the point of the split: a
// view can be rewritten in another paradigm and its logic tests never move.
//
// What DID move is the node emitter. `storyLifecycleChip(story)` returned a DOM node built by
// `el()` and was asserted under `withDom()`, the zero-dependency stub. It is now the React component
// `<StoryLifecycleChip story={…} />` in public/views/swimlanes.tsx, so its half of this file runs
// through @testing-library/react against a real (happy-dom) DOM. The assertions are the same three
// properties — class, text, title — plus the null case; only the way the node is obtained changed.
//
// (This test used to scrape a `<test-extract:story-lifecycle-ui>` sentinel block out of the classic
// public/app.js script and eval it with `new Function`, stubbing esc/isCompleteStatus/
// storySubtaskTotal along the way. That harness is long gone. Do not reintroduce a sentinel.)
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, test } from "bun:test";
import { storyLifecycle, storyProgress } from "../public/views/swimlanes-logic.js";
import { StoryLifecycleChip } from "../public/views/swimlanes.tsx";

afterEach(cleanup);

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
// Queries come from `render()`, NEVER from `screen` — see test/test-setup.ts for why `screen` is
// permanently poisoned under bun's module ordering.
test("StoryLifecycleChip renders per-state class, glyph and title", () => {
  const { container } = render(createElement(StoryLifecycleChip, { story: story({ counts: { in_progress: 1 } }) }));
  const working = container.querySelector("span")!;
  expect(working.className).toBe("chip lc-working");
  expect(working.textContent).toBe("▶ working");
  expect(working.getAttribute("title")).toBe("story lifecycle — working");
});

test("StoryLifecycleChip renders the stalled state", () => {
  const s = story({ counts: { blocked: 1 }, leader: { desired: true, running: false } });
  const { container } = render(createElement(StoryLifecycleChip, { story: s }));
  const stalled = container.querySelector("span")!;
  expect(stalled.className).toBe("chip lc-stalled");
  expect(stalled.textContent).toBe("⚠ stalled");
});

test("StoryLifecycleChip renders NOTHING for a story with no lifecycle", () => {
  const s = story({ status: "done", counts: { in_progress: 1 } });
  const { container } = render(createElement(StoryLifecycleChip, { story: s }));
  // A null-returning component contributes no nodes at all — the old emitter's `null` return.
  expect(container.innerHTML).toBe("");
});
