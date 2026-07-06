// Story st-f4858e23 (ask #4, SECONDARY): a story container shouldn't just read "OPEN". The
// dashboard derives a working/parked/stalled lifecycle — PURELY front-end, from data every
// StoryView already carries (the per-status `counts` rollup + leader{running,desired} + status),
// with NO new backend field. This guards the derivation rule + the own-children progress rollup.
//
// public/app.js is a classic browser script (touches `document` at module load, no exports), so we
// can't import it. We extract the PURE, DOM-free helper block fenced with
// `// <test-extract:story-lifecycle-ui>` sentinels and eval it in isolation — the same approach as
// test/kind-badge.test.ts / test/graph-rollup-completion.test.ts.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const APP = readFileSync(join(ROOT, "public", "app.js"), "utf8");

/** Pull the source fenced by `// <test-extract:name>` ... `// </test-extract:name>`. The opening
 *  sentinel may share its `//` line with prose, so capture from the NEXT line. */
function extract(name: string): string {
  const m = APP.match(new RegExp(`// <test-extract:${name}>[^\\n]*\\n([\\s\\S]*?)// </test-extract:${name}>`));
  if (!m) throw new Error(`missing test-extract sentinel block: ${name}`);
  return m[1];
}

// The block references esc()/isCompleteStatus()/storySubtaskTotal() from elsewhere in app.js —
// provide faithful stand-ins so the eval'd block is self-contained (mirrors kind-badge's esc stub).
const harness = `
function esc(s){ return String(s).replace(/[&<>"']/g, c => (
  { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c])); }
const COMPLETE = new Set(["merged","rolled_back","done"]);
function isCompleteStatus(s){ return COMPLETE.has(s); }
function storySubtaskTotal(counts){ const c = counts||{};
  return Object.keys(c).reduce((n,k)=> (k==="idle"? n : n+(c[k]||0)), 0); }
${extract("story-lifecycle-ui")}
return { storyLifecycle, storyProgress, storyLifecycleChip };
`;
const { storyLifecycle, storyProgress, storyLifecycleChip } = new Function(harness)() as {
  storyLifecycle: (s: any) => { key: string; glyph: string; cls: string } | null;
  storyProgress: (counts: any) => { done: number; total: number };
  storyLifecycleChip: (s: any) => string;
};

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

// ── The shared chip: '' when null, otherwise a quiet outlined pill keyed by state ──
test("storyLifecycleChip renders per-state class + is empty for non-open", () => {
  expect(storyLifecycleChip(story({ counts: { in_progress: 1 } }))).toContain("chip lc-working");
  expect(storyLifecycleChip(story({ counts: { blocked: 1 }, leader: { desired: true, running: false } }))).toContain("chip lc-stalled");
  expect(storyLifecycleChip(story({ status: "done", counts: { in_progress: 1 } }))).toBe("");
});
