// Story st-f4858e23 (ask #1 + #3): the dashboard surfaces every work-item's TYPE
// (STORY/TASK) and every agent's KIND (CTO/leader/build) through ONE generic
// kind -> visual lookup (KIND_VISUAL) + a single kindBadge() emitter. This guards
// that the generic table maps the known kinds and — critically for forward-compat
// (REVAMP-4's repo/project, future agent perspectives) — falls back safely for an
// unmapped kind instead of throwing.
//
// The chip/badge cluster now lives in public/components/chips.js, which is DOM-free at
// module load (it imports only core/dom.js + core/state-meta.js, neither of which touches
// `document` at load), so we IMPORT it directly and assert on the real exports. (This test
// used to scrape a `<test-extract:kind-badge>` sentinel block out of the classic
// public/app.js script and eval it with `new Function`, injecting its own stand-in `esc`;
// that harness is gone along with the sentinel. Do not reintroduce one.)
//
// Everything asserted here is INDEPENDENT of the /api/state-meta tables (kindBadge keys off
// KIND_VISUAL alone), so this file deliberately does NOT call applyStateMeta — that would
// mutate module state shared across the whole `bun test` process and break
// test/state-meta-fallback.test.ts's pre-load assertions. The live-binding guard for
// taskChips -> AGENT_TYPE lives there instead, alongside the applyStateMeta call it needs.
import { expect, test } from "bun:test";
import { KIND_VISUAL, kindBadge, kindVisual, taskChips } from "../public/components/chips.js";

test("KIND_VISUAL maps the six known kinds (2 work-item + 4 agent)", () => {
  expect(Object.keys(KIND_VISUAL).sort()).toEqual(["build", "ceo", "cto", "leader", "leaf", "node"]);
  // node/leaf are the authoritative work_kind values; cto/ceo/leader/build the agent kinds.
  expect(KIND_VISUAL.node.label).toBe("STORY");
  expect(KIND_VISUAL.leaf.label).toBe("TASK");
  expect(KIND_VISUAL.cto.label).toBe("CTO");
  expect(KIND_VISUAL.ceo.label).toBe("CEO");
  expect(KIND_VISUAL.leader.label).toBe("LEADER");
  expect(KIND_VISUAL.build.label).toBe("BUILD");
  // Every entry carries the full visual triple.
  for (const v of Object.values(KIND_VISUAL)) {
    expect(typeof v.label).toBe("string");
    expect(typeof v.glyph).toBe("string");
    expect(typeof v.cls).toBe("string");
    expect(v.glyph.length).toBeGreaterThan(0);
  }
});

test("kindBadge renders the mapped label + cssClass for each known kind", () => {
  for (const [k, v] of Object.entries(KIND_VISUAL)) {
    const html = kindBadge(k);
    expect(html).toContain(`kind-${v.cls}`);
    expect(html).toContain(v.label);
    expect(html).toContain(v.glyph);
    expect(html.startsWith("<span")).toBe(true);
  }
});

test("kindVisual falls back to a generic neutral badge for an UNKNOWN kind", () => {
  // Forward-compat: an as-yet-unmapped kind (e.g. REVAMP-4's container kinds) must NOT
  // throw — it lands on a neutral badge whose label is the raw kind uppercased.
  const v = kindVisual("repo");
  expect(v.cls).toBe("unknown");
  expect(v.label).toBe("REPO");
  expect(v.glyph.length).toBeGreaterThan(0);

  const html = kindBadge("project");
  expect(html).toContain("kind-unknown");
  expect(html).toContain("PROJECT");
});

test("kindBadge never throws on empty / null / undefined kinds", () => {
  for (const k of ["", null as any, undefined as any]) {
    const html = kindBadge(k);
    expect(html).toContain("kind-unknown");
    expect(html.startsWith("<span")).toBe(true);
  }
});

test("a node routed through kindBadge renders STORY, not TASK", () => {
  // The taskChips() choke point renders BOTH finished tasks ('leaf') AND finished stories
  // ('node') via finishedList(), so its badge must follow the item's authoritative kind —
  // a 'node' must read STORY. (Mirrors what taskChips does: kindBadge(t.work_kind).)
  const nodeBadge = kindBadge("node");
  expect(nodeBadge).toContain("kind-node");
  expect(nodeBadge).toContain("STORY");
  expect(nodeBadge).not.toContain("TASK");
});

test("taskChips keys its type badge off the authoritative work_kind (regression guard)", () => {
  // Regression guard for the finished-story mislabel: taskChips must badge the item by its
  // work_kind, NOT a hardcoded 'leaf' (which would badge a finished STORY as '▪ TASK').
  // This used to be a source-level regex over app.js; now that chips.js is importable we
  // assert on the RENDERED OUTPUT, which is what actually mattered all along.
  const story = taskChips({ work_kind: "node", status: "done" });
  expect(story).toContain("kind-node");
  expect(story).toContain("STORY");
  expect(story).not.toContain("kind-leaf");

  const task = taskChips({ work_kind: "leaf", status: "merged" });
  expect(task).toContain("kind-leaf");
  expect(task).toContain("TASK");
  expect(task).not.toContain("kind-node");

  // An item with no work_kind lands on the neutral fallback rather than silently reading TASK.
  expect(taskChips({ status: "merged" })).toContain("kind-unknown");
});
