// F2 regression (story st-c656c44e): a transient /api/state-meta fetch failure must NOT
// collapse the client's status tables to empty. With empty ACTIVE_STATUSES / TERMINAL_STATUSES
// the Pipeline view can't tell active work from finished (a finished subtask wouldn't collapse
// into its lane's done pile), so the fallback must always yield the server's non-empty sets.
//
// The state-meta helpers now live in public/core/state-meta.js, which is DOM-free at module
// load, so we IMPORT it directly and assert on the real exports. (This test used to scrape a
// `<test-extract:state-meta>` sentinel block out of the classic public/app.js script and eval
// it with `new Function`; that harness is gone along with the sentinel.) This also guards the
// client DEFAULT_STATE_META against drifting from the server's canonical sets in src/db.ts
// (STATE_META / ALL_STATUSES / isTerminal).
import { expect, test } from "bun:test";
import { ALL_STATUSES, STATE_META, isTerminal } from "../src/db.ts";
import { DEFAULT_STATE_META, statusSetsFrom } from "../public/core/state-meta.js";

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
//  (1) core/state-meta.js is importable OUTSIDE a browser — DOM-free at load, so its tables
//      start empty. That is what makes the old `new Function` harness deletable, and what the
//      rest of the P2 module split depends on. Add a top-level `document` touch here (or in
//      core/api.js / core/dom.js beneath it) and the import at the top of this file throws,
//      failing every test in it loudly.
//  (2) applyStateMeta's REASSIGNMENT propagates to importers via the ES live binding. This is
//      what lets app.js import the tables as named bindings; if it broke, every status chip
//      would silently render empty.
test("core/state-meta.js loads DOM-free, and applyStateMeta propagates to importers", async () => {
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
});
