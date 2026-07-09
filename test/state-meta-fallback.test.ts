// F2 regression (story st-c656c44e): a transient /api/state-meta fetch failure must NOT
// collapse the client's status tables to empty. With empty ACTIVE_STATUSES / TERMINAL_STATUSES
// the Pipeline view can't tell active work from finished (a finished subtask wouldn't collapse
// into its lane's done pile), so the fallback must always yield the server's non-empty sets.
//
// The state-meta helpers live in public/core/state-meta.ts, which is DOM-free at module load, so we
// IMPORT it directly and assert on the real exports. This also guards the client DEFAULT_STATE_META
// against drifting from the server's canonical sets in src/db.ts (STATE_META / ALL_STATUSES /
// isTerminal).
//
// >>> PHASE 4d MOVED THE CHIP HALF OFF `dom-stub.ts` AND ONTO `@testing-library/react`. <<<
// `taskChips()` returned a DocumentFragment and ran inside `withDom()`. It is `<TaskChips/>` now, so
// the live-binding guard below renders it into a real happy-dom DOM. What is asserted is unchanged.
import "./dom-register.ts"; // must precede every React import — installs `document`
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { registerDom, unregisterDom } from "./dom-env.ts";
import { ALL_STATUSES, STATE_META, isTerminal } from "../src/db.ts";
import { DEFAULT_STATE_META, statusSetsFrom } from "../public/core/state-meta.js";
// STATIC, top-level import — ON PURPOSE, AND IT IS THE WHOLE POINT OF THE LAST TEST IN THIS FILE.
// It evaluates components/chips.tsx BEFORE any test body runs applyStateMeta, exactly as main.tsx
// does (it pulls the component graph in at load, then awaits ensureStateMeta at boot). A lazy
// `await import()` inside the test would evaluate chips.tsx AFTER the tables were populated, and a
// `const {AGENT_TYPE} = ...` snapshot regression in chips.tsx would sail straight through.
import { TaskChips } from "../public/components/chips.tsx";

beforeAll(registerDom);
afterEach(cleanup);
// Not optional: `test/vanilla-views-dom-free.test.ts` asserts `globalThis.document` is undefined, and
// `bun test` runs every file in one process.
afterAll(unregisterDom);

// The cases that stand in for a FAILED / empty /api/state-meta response. loadStateMeta()
// passes DEFAULT_STATE_META on the catch path; statusSetsFrom also falls back internally
// when handed null / {} / an empty allStatuses, so all of these must yield the same non-empty
// defaults.
const FAILED_META_CASES: Array<[string, any]> = [
  ["null (no body)", null],
  ["undefined", undefined],
  ["empty object", {}],
  ["empty allStatuses", { allStatuses: [], terminalStatuses: [] }],
  ["the DEFAULT_STATE_META passed on the catch path", DEFAULT_STATE_META],
];

for (const [label, meta] of FAILED_META_CASES) {
  test(`failed state-meta (${label}) falls back to NON-EMPTY status sets`, () => {
    const sets = statusSetsFrom(meta);
    expect(sets.ALL_STATUSES.length).toBeGreaterThan(0);
    expect(sets.ACTIVE_STATUSES.length).toBeGreaterThan(0);
    expect(sets.TERMINAL_STATUSES.length).toBeGreaterThan(0);
    expect(sets.FILTER_STATUSES.length).toBeGreaterThan(0);
    // in_progress is a known ACTIVE status — it must survive the fallback.
    expect(sets.ACTIVE_STATUSES).toContain("in_progress");
    expect(sets.TERMINAL_STATUSES).not.toContain("in_progress");
    // merged is terminal — it must NOT leak into the active set.
    expect(sets.TERMINAL_STATUSES).toContain("merged");
    expect(sets.ACTIVE_STATUSES).not.toContain("merged");
  });
}

// DRIFT GUARD: the client's hand-kept DEFAULT_STATE_META must mirror the server's canonical
// sets exactly, so the fallback behaves identically to a healthy /api/state-meta load.
test("client DEFAULT_STATE_META mirrors the server's canonical status sets (src/db.ts)", () => {
  expect(DEFAULT_STATE_META.allStatuses).toEqual([...ALL_STATUSES]);
  expect([...DEFAULT_STATE_META.terminalStatuses].sort()).toEqual(
    ALL_STATUSES.filter(isTerminal).sort(),
  );
  for (const s of ALL_STATUSES) {
    const def = (DEFAULT_STATE_META.stateMeta as Record<string, any>)[s] || {};
    expect(def.kind).toBe(STATE_META[s].kind);
    expect(def.agentType ?? undefined).toBe(STATE_META[s].agentType ?? undefined);
  }
});

// Two properties in one test, because they share MODULE state (the `export let` tables) and
// splitting them would make the assertions order-dependent:
//
//  (1) core/state-meta.ts is importable OUTSIDE a browser — DOM-free at load, so its tables
//      start empty. That is what made the old `new Function` harness deletable, and what the
//      rest of the P2 module split depends on. Add a top-level `document` touch here (or in
//      core/api.ts beneath it) and the import at the top of this file throws, failing every test
//      in it loudly.
//
//      >>> THIS FILE NOW REGISTERS A DOM, SO READ (1) CAREFULLY. <<< It no longer proves that
//      state-meta loads with NO `document` present — `dom-register.ts` installed one before any of
//      these imports evaluated. What it still proves is that the TABLES START EMPTY, i.e. that
//      nothing in this import graph populates them at load. The DOM-free-at-load property itself is
//      owned by `test/vanilla-views-dom-free.test.ts`, which asserts `globalThis.document ===
//      undefined` and is why the `afterAll(unregisterDom)` above is mandatory.
//
//  (2) applyStateMeta's REASSIGNMENT propagates to importers via the ES live binding. This is
//      what lets a component import the tables as named bindings; if it broke, every status chip
//      would silently render empty.
test("core/state-meta.ts starts with empty tables, and applyStateMeta propagates to importers", async () => {
  const m = await import("../public/core/state-meta.js");

  // (1) pre-load state: the tables exist but are empty, and no fetch has succeeded.
  expect(m.stateMetaLoaded).toBe(false);
  expect(m.ALL_STATUSES).toEqual([]);
  expect(m.STATE_KIND).toEqual({});

  // (2) reassign, then re-read the SAME imported bindings.
  m.applyStateMeta(DEFAULT_STATE_META);
  expect(m.ALL_STATUSES).toEqual([...ALL_STATUSES]);
  expect(m.ACTIVE_STATUSES).toContain("in_progress");
  expect(m.TERMINAL_STATUSES).toContain("merged");
  expect(m.STATE_KIND.in_progress).toBe("agent");
  expect(m.AGENT_TYPE.in_progress).toBe("workspace-agent");
  // stateKind() reads the live table, plus the synthetic needs_user_input override.
  expect(m.stateKind("in_progress")).toBe("agent");
  expect(m.stateKind("needs_user_input")).toBe("feedback");

  // (3) the live binding must reach a REAL importer, not just this test. components/chips.tsx
  //     (imported statically at the top of this file, so it evaluated BEFORE the reassignment
  //     above) reads AGENT_TYPE / stateKind at RENDER time. A regression to
  //     `const {AGENT_TYPE} = ...` there would snapshot the empty pre-load table and silently
  //     drop the agent-type text from every status chip.
  //
  //     The state-kind chip is the LAST element of what TaskChips renders for these inputs; its
  //     class carries the kind and its `title` carries the agent-type / awaited-artifact text that
  //     AGENT_TYPE feeds.
  const stateKindChip = (t: object) => {
    const { container } = render(createElement(TaskChips, { task: t as never, kind: true }));
    return container.children[container.children.length - 1];
  };

  const running = stateKindChip({ work_kind: "leaf", status: "in_progress" });
  expect(running.className).toContain("state-kind-agent");
  expect(running.getAttribute("title")).toContain("workspace-agent is running");
  cleanup();

  // A feedback state names the awaited artifact instead of an agent type.
  const review = stateKindChip({ work_kind: "leaf", status: "in_review" });
  expect(review.className).toContain("state-kind-feedback");
  expect(review.textContent).toContain("diff review");
});
