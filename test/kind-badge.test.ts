// Story st-f4858e23 (ask #1 + #3): the dashboard surfaces every work-item's TYPE
// (STORY/TASK) and every agent's KIND (CTO/leader/build) through ONE generic
// kind -> visual lookup (KIND_VISUAL) + a single kindBadge() emitter. This guards
// that the generic table maps the known kinds and — critically for forward-compat
// (REVAMP-4's repo/project, future agent perspectives) — falls back safely for an
// unmapped kind instead of throwing.
//
// public/app.js is a classic browser script (touches `document` at module load, no
// exports), so we can't import it. We extract the PURE, DOM-free helper block fenced
// with `// <test-extract:kind-badge>` sentinels and eval it in isolation — the same
// approach as test/state-meta-fallback.test.ts and test/graph-rollup-completion.test.ts.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const APP = readFileSync(join(ROOT, "public", "app.js"), "utf8");

/** Pull the source fenced by `// <test-extract:name>` ... `// </test-extract:name>`. The
 *  opening sentinel may share its `//` line with prose, so capture from the NEXT line. */
function extract(name: string): string {
  const m = APP.match(new RegExp(`// <test-extract:${name}>[^\\n]*\\n([\\s\\S]*?)// </test-extract:${name}>`));
  if (!m) throw new Error(`missing test-extract sentinel block: ${name}`);
  return m[1];
}

// The kind-badge block references `esc()` for HTML-escaping; provide a faithful stand-in
// (the real one lives elsewhere in app.js) so the eval'd block is self-contained.
const harness = `
function esc(s){ return String(s).replace(/[&<>"']/g, c => (
  { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c])); }
${extract("kind-badge")}
return { KIND_VISUAL, kindVisual, kindBadge };
`;
const { KIND_VISUAL, kindVisual, kindBadge } = new Function(harness)() as {
  KIND_VISUAL: Record<string, { label: string; glyph: string; cls: string }>;
  kindVisual: (k: string) => { label: string; glyph: string; cls: string };
  kindBadge: (k: string) => string;
};

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
  // Regression guard for the finished-story mislabel: taskChips must pass the item's
  // work_kind into kindBadge, NOT a hardcoded 'leaf' literal (which would badge a finished
  // STORY as '▪ TASK'). Assert at the source level since taskChips has DOM/helper deps that
  // make it impractical to eval in isolation.
  const body = APP.match(/function taskChips\([^]*?\n\}/);
  if (!body) throw new Error("could not locate taskChips() body");
  expect(body[0]).toContain("kindBadge(t.work_kind)");
  expect(body[0]).not.toContain('kindBadge("leaf")');
});
