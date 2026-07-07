// F2 regression (story st-c656c44e): a transient /api/state-meta fetch failure must NOT
// collapse the client's status tables to empty. With empty ACTIVE_STATUSES / TERMINAL_STATUSES
// the Pipeline view can't tell active work from finished (a finished subtask wouldn't collapse
// into its lane's done pile), so the fallback must always yield the server's non-empty sets.
//
// public/app.js is a classic browser script (touches `document` at module load, no exports),
// so we can't import it. Instead we extract the PURE, DOM-free state-meta helper block the fix
// deliberately fenced with a `<test-extract:...>` sentinel and eval it in isolation. This also
// guards the client DEFAULT_STATE_META against drifting from the server's canonical sets in
// src/db.ts (STATE_META / ALL_STATUSES / isTerminal).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_STATUSES, STATE_META, isTerminal } from "../src/db.ts";

const ROOT = join(import.meta.dir, "..");
const APP = readFileSync(join(ROOT, "public", "app.js"), "utf8");

/** Pull the source fenced by `// <test-extract:name>` ... `// </test-extract:name>`. The
 *  opening sentinel may share its `//` line with descriptive prose, so capture from the
 *  NEXT line to avoid pulling that bare (non-comment) tail into the eval'd source. */
function extract(name: string): string {
  const m = APP.match(new RegExp(`// <test-extract:${name}>[^\\n]*\\n([\\s\\S]*?)// </test-extract:${name}>`));
  if (!m) throw new Error(`missing test-extract sentinel block: ${name}`);
  return m[1];
}

// Eval the pure state-meta block and expose the helpers the tests need (no DOM / module state).
const harness = `
${extract("state-meta")}
return { DEFAULT_STATE_META, statusSetsFrom };
`;
const { DEFAULT_STATE_META, statusSetsFrom } = new Function(harness)() as {
  DEFAULT_STATE_META: any;
  statusSetsFrom: (meta: any) => {
    ALL_STATUSES: string[];
    TERMINAL_STATUSES: string[];
    ACTIVE_STATUSES: string[];
    FILTER_STATUSES: string[];
    STATE_KIND: Record<string, string>;
  };
};

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
    const def = DEFAULT_STATE_META.stateMeta[s] || {};
    expect(def.kind).toBe(STATE_META[s].kind);
    expect(def.agentType ?? undefined).toBe(STATE_META[s].agentType ?? undefined);
  }
});
