// F2 regression (story st-c656c44e): a transient /api/state-meta fetch failure must NOT
// collapse the client's status tables to empty. With empty ACTIVE_STATUSES, boardLaneKey
// maps EVERY leaf to null → renderBoard sees total===0 → falsely shows "No active work in
// the pipeline." while the List view degrades oppositely (everything stays "active").
//
// public/app.js is a classic browser script (touches `document` at module load, no exports),
// so we can't import it. Instead we extract the two PURE, DOM-free helper blocks the fix
// deliberately fenced with `<test-extract:...>` sentinels and eval them in isolation. This
// also guards the client DEFAULT_STATE_META against drifting from the server's canonical
// sets in src/db.ts (STATE_META / ALL_STATUSES / isTerminal).
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

// Eval both pure blocks together and expose the helpers the tests need. boardLaneKeyFor
// takes activeStatuses explicitly, so no module-level ACTIVE_STATUSES / DOM is required.
const harness = `
${extract("state-meta")}
${extract("board")}
return { DEFAULT_STATE_META, statusSetsFrom, boardLaneKeyFor };
`;
const { DEFAULT_STATE_META, statusSetsFrom, boardLaneKeyFor } = new Function(harness)() as {
  DEFAULT_STATE_META: any;
  statusSetsFrom: (meta: any) => {
    ALL_STATUSES: string[];
    TERMINAL_STATUSES: string[];
    ACTIVE_STATUSES: string[];
    FILTER_STATUSES: string[];
    STATE_KIND: Record<string, string>;
  };
  boardLaneKeyFor: (w: any, byId: Map<string, any>, active: string[]) => string | null;
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
  });

  test(`failed state-meta (${label}): boardLaneKey still classifies an in_progress leaf into a real lane`, () => {
    const sets = statusSetsFrom(meta);
    const lane = boardLaneKeyFor(
      { id: "t1", work_kind: "leaf", status: "in_progress" },
      new Map(),
      sets.ACTIVE_STATUSES,
    );
    // The pre-fix bug: empty ACTIVE_STATUSES → null → board reads "No active work".
    expect(lane).not.toBeNull();
    expect(lane).toBe("in_progress");
  });
}

// A terminal leaf still drops out of the board even on the fallback path (no regression to
// the leaf-omission rule).
test("fallback path still omits a terminal (merged) leaf from the board", () => {
  const sets = statusSetsFrom(null);
  const lane = boardLaneKeyFor(
    { id: "t2", work_kind: "leaf", status: "merged" },
    new Map(),
    sets.ACTIVE_STATUSES,
  );
  expect(lane).toBeNull();
});

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
