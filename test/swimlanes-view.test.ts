// public/views/swimlanes.tsx — the Pipeline, rendered. RFC §11 names this view the top residual
// VISUAL risk of the LaunchPad migration, and no test can catch a visual regression. What a test CAN
// catch is a STRUCTURAL one: the classes that carry the 14-colour status palette and the emphasis
// layer, the left→right order the pure helper computes, the lane's empty states, the ungrouped
// catch-all, and the leader-terminal control's enabled/disabled gate.
//
// Until Phase 4c the view had NO DOM coverage at all — `renderSwimlanes` built nodes with `el()` and
// nothing rendered it. Only its five pure helpers were tested (test/swimlane-order.test.ts,
// test/story-lifecycle-ui.test.ts, test/swimlane-leader-terminal-btn.test.ts), and those still pass
// against the same unchanged module. This file is the half that became testable when the view became
// a component.
//
// A `<Link>` needs a router, so every render is wrapped in a `MemoryRouter`. `RouterProvider` (the
// react-aria one, in App.tsx) is NOT needed here: it only teaches LaunchPad's own Link/Breadcrumbs to
// navigate, and the steps use react-router's Link directly.
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, expect, test } from "bun:test";
import { applyStateMeta } from "../public/core/state-meta.js";
import { Swimlanes } from "../public/views/swimlanes.tsx";

afterEach(cleanup);

// `TERMINAL_STATUSES` is an `export let` that starts EMPTY — `isHistoryItem` reads it, so without
// this every "merged" leaf would count as ACTIVE work and the done-pile assertions below would pass
// for the wrong reason (or rather, fail confusingly). `applyStateMeta(null)` installs
// DEFAULT_STATE_META, which is what the real app falls back to when `/api/state-meta` is down. Same
// call the vanilla boot made before painting a single chip.
beforeAll(() => applyStateMeta(null));

type Item = Record<string, unknown>;
const node = (id: string, o: Item = {}): Item => ({ id, work_kind: "node", status: "open", counts: {}, leader: {}, ...o });
// Membership is `parent_id` (graphChildOf: parent_id wins over story_id) — NOT some `child_of` field.
// The rule lives in core/work-graph.ts and the views never re-derive it.
const leaf = (id: string, o: Item = {}): Item => ({ id, work_kind: "leaf", status: "inactive", parent_id: "s1", ...o });

// Queries come from `render()`, NEVER from `screen` — see test/test-setup.ts.
const mount = (work: Item[]) =>
  render(createElement(MemoryRouter, null, createElement(Swimlanes, { work: work as never })));

test("an empty work list paints the empty-state, not a lane container", () => {
  const { container } = mount([]);
  expect(container.querySelector(".empty")!.textContent).toBe("No active work to show.");
  expect(container.querySelector(".swim-lanes")).toBeNull();
  // The caption and legend always paint — they explain the view even when it has nothing to show.
  expect(container.querySelector(".swim-caption")).not.toBeNull();
  expect(container.querySelectorAll(".swim-legend span").length).toBe(5);
});

test("a story becomes a lane: kind badge, clamped title, id, status chip, progress", () => {
  const { container } = mount([
    node("s1", { brief: "Ship the thing\nand then some more prose", counts: { merged: 1, in_progress: 1 } }),
    leaf("a", { status: "merged" }),
    leaf("b", { status: "in_progress" }),
  ]);

  const lane = container.querySelector(".swim-lane")!;
  // The kind badge is the SHARED KindBadge — `kindVisual("node")`, not hand-rolled markup.
  expect(lane.querySelector(".swim-kind .kind-badge")).not.toBeNull();
  // laneTitle takes the brief's FIRST non-empty line; the full brief goes in the tooltip.
  const title = lane.querySelector(".swim-title")!;
  expect(title.textContent).toBe("Ship the thing");
  expect(title.getAttribute("title")).toBe("Ship the thing\nand then some more prose");
  expect(lane.querySelector(".swim-laneid")!.textContent).toBe("s1");

  // The lane header's status pill prints the RAW status, keyed on the status class (CTO decision 7 —
  // 14 colours, never collapsed onto LaunchPad's 8-variant `Tag`).
  const hdChip = lane.querySelector(".swim-meta > .chip")!;
  expect(hdChip.className).toBe("chip open");

  // storyProgress: 1 done of 2 real subtasks (idle is not in counts here).
  expect(lane.querySelector<HTMLElement>(".swim-track i")!.style.width).toBe("50%");
  expect(lane.querySelector(".swim-prog-txt")!.textContent).toBe("1 / 2 done");
});

test("a childless story shows 'no subtasks yet'; an all-finished one shows the softer note", () => {
  const childless = mount([node("s1")]);
  expect(childless.container.querySelector(".swim-empty-txt")!.textContent).toBe(
    "No subtasks yet — parked until the leader decomposes it.",
  );
  expect(childless.container.querySelector(".swim-empty .chip.lc-parked")!.textContent).toBe("⏸ parked");
  cleanup();

  // `counts` says there ARE subtasks, but every member is history — so the lane has no ACTIVE steps.
  const finished = mount([node("s1", { counts: { merged: 2 } }), leaf("a", { status: "merged" }), leaf("b", { status: "merged" })]);
  expect(finished.container.querySelector(".swim-empty-txt")!.textContent).toBe(
    "No active subtasks — all work is finished or waiting.",
  );
  // …and they are still reachable, behind the collapsed done pile.
  expect(finished.container.querySelector(".swim-done-row")!.textContent).toBe("▸ 2 done");
});

test("steps run left → right in blocked_by order, joined by exactly one arrow each", () => {
  // c ← b ← a, fed scrambled. orderLaneLeaves must straighten it out in the DOM.
  const { container } = mount([
    node("s1", { counts: { inactive: 3 } }),
    leaf("c", { blocked_by: ["b"] }),
    leaf("a"),
    leaf("b", { blocked_by: ["a"] }),
  ]);
  const ids = [...container.querySelectorAll(".swim-pipe .swim-sid")].map((n) => n.textContent);
  expect(ids).toEqual(["a", "b", "c"]);
  // n steps ⇒ n-1 connectors, and they are aria-hidden decoration.
  expect(container.querySelectorAll(".swim-conn").length).toBe(2);
  expect(container.querySelector(".swim-conn")!.getAttribute("aria-hidden")).toBe("true");
});

test("a step is an anchor to its task, carries the emphasis class, and lights only when it needs you", () => {
  const { container } = mount([
    node("s1", { counts: { in_progress: 1, needs_info: 1, blocked: 1 } }),
    leaf("run", { status: "in_progress" }),
    leaf("ask", { status: "needs_info" }),
    leaf("wait", { status: "blocked" }),
  ]);
  const step = (id: string) => [...container.querySelectorAll<HTMLElement>(".swim-step")].find((s) => s.textContent!.includes(id))!;

  // Under a hash router a react-router <Link to="/task/x"> is exactly the vanilla's <a href="#/task/x">.
  // MemoryRouter has no hash, so assert the path — the element is what matters: a real, focusable <a>.
  expect(step("run").tagName).toBe("A");
  expect(step("run").getAttribute("href")).toBe("/task/run");
  expect(step("run").getAttribute("aria-label")).toBe("subtask run — in_progress");

  // swimEmphasis: attention lit, in-flight accented, not-yet-its-turn dimmed. Exactly one is loud.
  expect(step("run").className).toBe("swim-step is-active");
  expect(step("ask").className).toBe("swim-step is-attn");
  expect(step("wait").className).toBe("swim-step is-blocked");

  // Only the ATTENTION step gets the "needs you" flag; only the live agent gets the pulsing dot.
  expect(container.querySelectorAll(".swim-needs").length).toBe(1);
  expect(step("ask").querySelector(".swim-needs")!.textContent).toBe("needs you");
  expect(container.querySelectorAll(".swim-dot").length).toBe(1);
  expect(step("run").querySelector(".swim-dot")).not.toBeNull();

  // The pill keeps its real .chip.<status> colour class — the one shared status vocabulary.
  expect(step("run").querySelector(".chip")!.className).toBe("chip in_progress");
});

test("a blocker in ANOTHER lane surfaces as a badge rather than being silently dropped", () => {
  const { container } = mount([
    node("s1", { counts: { inactive: 1 } }),
    node("s2", { counts: { inactive: 1 } }),
    leaf("a", { blocked_by: ["z"] }),
    leaf("z", { parent_id: "s2" }),
  ]);
  const xdep = container.querySelector(".swim-xdep")!;
  expect(xdep.textContent).toBe("⤴ blocked by z");
  expect(xdep.getAttribute("title")).toBe("blocked by work in another lane");
  // An IN-lane blocker is drawn as the arrow, never as a badge.
  expect(container.querySelectorAll(".swim-xdep").length).toBe(1);
});

// The done pile's expanded flag was module state (`SWIM_DONE_EXPANDED`) so it survived the wholesale
// re-render the vanilla did on every SSE event. It is component state now; React keeps it across a
// refresh because the lane is keyed by story id. What must not regress is the toggle itself, and its
// keyboard contract — the reason this stayed a `div[role=button]` rather than a LaunchPad Disclosure.
test("the done pile is collapsed by default and toggles open, by click and by keyboard", () => {
  const { container } = mount([
    node("s1", { counts: { merged: 2, inactive: 1 } }),
    leaf("live"),
    leaf("old1", { status: "merged" }),
    leaf("old2", { status: "merged" }),
  ]);
  const row = container.querySelector(".swim-done-row")!;
  expect(row.getAttribute("role")).toBe("button");
  expect(row.getAttribute("tabindex")).toBe("0");
  expect(row.getAttribute("aria-expanded")).toBe("false");
  expect(row.textContent).toBe("▸ 2 done");
  // Collapsed: the finished steps are not in the DOM, and the ACTIVE pipe is untouched.
  expect(container.querySelector(".swim-done-pipe")).toBeNull();
  expect(container.querySelectorAll(".swim-pipe .swim-sid").length).toBe(1);

  fireEvent.click(row);
  expect(row.getAttribute("aria-expanded")).toBe("true");
  expect(row.textContent).toBe("▾ 2 done");
  const donePipe = container.querySelector(".swim-done-pipe")!;
  expect([...donePipe.querySelectorAll(".swim-sid")].map((n) => n.textContent)).toEqual(["old1", "old2"]);

  // Enter and Space both toggle — the contract the hand-rolled row spells out and Disclosure would
  // have supplied. Space is the one a `div` gets wrong for free.
  fireEvent.keyDown(row, { key: "Enter" });
  expect(row.getAttribute("aria-expanded")).toBe("false");
  fireEvent.keyDown(row, { key: " " });
  expect(row.getAttribute("aria-expanded")).toBe("true");
});

test("active leaves with no owning story in the list land in the ungrouped lane, never dropped", () => {
  const { container } = mount([node("s1", { counts: { inactive: 1 } }), leaf("mine"), leaf("orphan", { parent_id: "gone" })]);
  const lanes = [...container.querySelectorAll(".swim-lane")];
  expect(lanes.length).toBe(2);

  const ungrouped = container.querySelector(".swim-lane-ungrouped")!;
  expect(ungrouped.querySelector(".swim-title")!.textContent).toBe("Ungrouped work");
  expect(ungrouped.querySelector(".swim-laneid")!.textContent).toBe("no owning story");
  expect([...ungrouped.querySelectorAll(".swim-sid")].map((n) => n.textContent)).toEqual(["orphan"]);
  // Its badge is the shared KindBadge hitting kindVisual's unmapped-kind fallback.
  expect(ungrouped.querySelector(".swim-kind .kind-badge")!.className).toBe("kind-badge kind-unknown");
  // A HISTORY orphan is not active work and does not conjure a lane.
  cleanup();
  const done = mount([node("s1", { counts: { inactive: 1 } }), leaf("mine"), leaf("old", { parent_id: "gone", status: "merged" })]);
  expect(done.container.querySelector(".swim-lane-ungrouped")).toBeNull();
});

// leaderTerminalBtnState is pure and unit-tested in test/swimlane-leader-terminal-btn.test.ts. What
// this asserts is that the lane header actually WIRES it — the control the abandoned Phase-4 branch
// dropped from this view entirely. It stays VISIBLE but disabled when there is no live pane, because
// a ⚠ stalled lane is exactly when an operator most wants to attach and a vanished button hides the
// diagnosis. The honest hint sits on the wrapper: LaunchPad's Button takes no `title`.
test("the lane's leader-terminal button is enabled only for a LIVE leader, and always says why", () => {
  const { container } = mount([node("s1", { leader: { running: true } })]);
  const host = container.querySelector(".swim-leader-btn")!;
  expect(host.querySelector("button")!.textContent).toBe("⌗ Open Leader terminal");
  expect(host.querySelector("button")!.hasAttribute("disabled")).toBe(false);
  expect(host.getAttribute("title")).toBe("Attach a terminal to the live leader agent");
  cleanup();

  // Desired but down, carrying a stale lastError — shown as EVIDENCE, never as a verdict of "crashed".
  const stalled = mount([node("s1", { leader: { desired: true, running: false, lastError: "boom" } })]);
  const sHost = stalled.container.querySelector(".swim-leader-btn")!;
  expect(sHost.querySelector("button")!.hasAttribute("disabled")).toBe(true);
  expect(sHost.getAttribute("title")).toContain("last error: boom");
  cleanup();

  const off = mount([node("s1")]);
  const oHost = off.container.querySelector(".swim-leader-btn")!;
  expect(oHost.querySelector("button")!.hasAttribute("disabled")).toBe(true);
  expect(oHost.getAttribute("title")).toBe("Leader agent isn't running — torn down or never launched");
});

// A story that is merging/done already carries a descriptive status chip, so no lifecycle chip is
// added beside it — and a HISTORY story is not a lane at all.
test("history stories are not lanes; a non-open story gets no lifecycle chip", () => {
  const { container } = mount([node("s1", { status: "merging", counts: { in_progress: 1 } }), leaf("a", { status: "in_progress" })]);
  expect(container.querySelectorAll(".swim-lane").length).toBe(1);
  expect(container.querySelector(".swim-meta .chip.lc-working")).toBeNull();
  cleanup();

  const gone = mount([node("s1", { status: "done" }), node("s2")]);
  expect(gone.container.querySelectorAll(".swim-lane").length).toBe(1);
  expect(gone.container.querySelector(".swim-laneid")!.textContent).toBe("s2");
});
