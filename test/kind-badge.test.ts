// Story st-f4858e23 (ask #1 + #3): the dashboard surfaces every work-item's TYPE (STORY/TASK) and
// every agent's KIND (CTO/leader/build) through ONE generic kind -> visual lookup (KIND_VISUAL) + a
// single badge component. This guards that the generic table maps the known kinds and — critically
// for forward-compat (REVAMP-4's repo/project, future agent perspectives) — falls back safely for an
// unmapped kind instead of throwing.
//
// The kind -> visual TABLE and its lookup live in the DOM-free leaf public/components/chips-logic.ts;
// the RENDERERS live in public/components/chips.tsx. Both are imported directly and asserted on the
// real exports.
//
// >>> PHASE 4d MOVED THIS OFF `dom-stub.ts` AND ONTO `@testing-library/react`. <<<
// `kindBadge()`/`taskChips()` were node emitters returning an HTMLElement / DocumentFragment, called
// inside `withDom()` — a hand-rolled, zero-dependency `document` stub. They are `<KindBadge/>` and
// `<TaskChips/>` now, so this renders them into a real happy-dom DOM. The assertions did not change
// shape: they were already about STRUCTURE (className / title / textContent), which is what they
// were reaching for when they were substring-matching HTML two rewrites ago. The vanilla `chips.js`
// still ships until Phase 4e; nothing here covers it any more, and that is deliberate.
//
// Everything asserted here is INDEPENDENT of the /api/state-meta tables (the kind badge keys off
// KIND_VISUAL alone), so this file deliberately does NOT call applyStateMeta — that would mutate
// module state shared across the whole `bun test` process and break test/state-meta-fallback.test.ts's
// pre-load assertions. The live-binding guard for TaskChips -> AGENT_TYPE lives there instead,
// alongside the applyStateMeta call it needs.
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, test } from "bun:test";
import { KindBadge, TaskChips } from "../public/components/chips.tsx";
import { KIND_VISUAL, kindVisual } from "../public/components/chips-logic.js";

afterEach(cleanup);

// Queries come from `render()`, NEVER from `screen` — see test/test-setup.ts.
/** The single `<span class="kind-badge …">` a `<KindBadge/>` renders. */
const badge = (kind: unknown) => render(createElement(KindBadge, { kind: kind as never })).container.children[0];
/** `<TaskChips/>` renders a fragment; its FIRST element is always the kind badge. */
const badgeOf = (t: object, props: object = {}) =>
  render(createElement(TaskChips, { task: t as never, ...props })).container.children[0];

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

test("KindBadge renders the mapped label + cssClass for each known kind", () => {
  for (const [k, v] of Object.entries(KIND_VISUAL)) {
    const node = badge(k);
    expect(node.tagName).toBe("SPAN");
    expect(node.className).toContain(`kind-${v.cls}`);
    expect(node.className).toContain("kind-badge");
    expect(node.getAttribute("title")).toBe(v.label);
    expect(node.textContent).toContain(v.label);
    expect(node.textContent).toContain(v.glyph);
    cleanup();
  }
});

test("kindVisual falls back to a generic neutral badge for an UNKNOWN kind", () => {
  // Forward-compat: an as-yet-unmapped kind (e.g. REVAMP-4's container kinds) must NOT throw — it
  // lands on a neutral badge whose label is the raw kind uppercased.
  const v = kindVisual("repo");
  expect(v.cls).toBe("unknown");
  expect(v.label).toBe("REPO");
  expect(v.glyph.length).toBeGreaterThan(0);

  const node = badge("project");
  expect(node.className).toContain("kind-unknown");
  expect(node.textContent).toContain("PROJECT");
});

test("KindBadge never throws on empty / null / undefined kinds", () => {
  for (const k of ["", null, undefined]) {
    const node = badge(k);
    expect(node.tagName).toBe("SPAN");
    expect(node.className).toContain("kind-unknown");
    cleanup();
  }
});

test("a node routed through KindBadge renders STORY, not TASK", () => {
  // TaskChips renders BOTH finished tasks ('leaf') AND finished stories ('node'), so its badge must
  // follow the item's authoritative kind — a 'node' must read STORY.
  const nodeBadge = badge("node");
  expect(nodeBadge.className).toContain("kind-node");
  expect(nodeBadge.textContent).toContain("STORY");
  expect(nodeBadge.textContent).not.toContain("TASK");
});

test("TaskChips keys its type badge off the authoritative work_kind (regression guard)", () => {
  // Regression guard for the finished-story mislabel: TaskChips must badge the item by its
  // work_kind, NOT a hardcoded 'leaf' (which would badge a finished STORY as '▪ TASK').
  const story = badgeOf({ work_kind: "node", status: "done" });
  expect(story.className).toContain("kind-node");
  expect(story.textContent).toContain("STORY");
  expect(story.className).not.toContain("kind-leaf");
  cleanup();

  const task = badgeOf({ work_kind: "leaf", status: "merged" });
  expect(task.className).toContain("kind-leaf");
  expect(task.textContent).toContain("TASK");
  expect(task.className).not.toContain("kind-node");
  cleanup();

  // An item with no work_kind lands on the neutral fallback rather than silently reading TASK.
  expect(badgeOf({ status: "merged" }).className).toContain("kind-unknown");
});

test("TaskChips preserves the ASYMMETRIC literal spaces between sibling chips", () => {
  // The separators are real text nodes, and they are NOT uniform: the kind badge and the
  // plan-preview chip carry a TRAILING space; the state-kind, conflict, priority and released chips
  // carry a LEADING one; the status chip carries neither. Dropping any of them silently changes the
  // rendered spacing, and no other test would notice. In JSX each is an explicit `{" "}`, which a
  // formatter cannot eat — but a careless refactor still can. Assert the exact interleave.
  const { container } = render(
    createElement(TaskChips, {
      task: {
        work_kind: "leaf",
        status: "merged",
        plan_preview: 1,
        conflict: 1,
        priority: 3,
        released_version: "0.9.1",
      } as never,
      plan: true,
    }),
  );
  const shape = [...container.childNodes].map((n) =>
    n.nodeType === 3 ? JSON.stringify(n.textContent) : (n as Element).className,
  );
  expect(shape).toEqual([
    "kind-badge kind-leaf",
    '" "',
    "chip plan",
    '" "',
    "chip merged",
    '" "',
    "chip aborted",
    '" "',
    "chip priority",
    '" "',
    "chip released",
  ]);
  // …and the whole cluster reads with single spaces between every chip.
  expect(container.textContent).toBe("▪ TASK plan-preview merged conflict prio 3 v0.9.1");
});
