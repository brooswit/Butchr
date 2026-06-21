// F3 regression (story st-71bd5527): the SSE path does a FULL re-render (mount() clears
// app.innerHTML), so captureUiState()/restoreUiState()/applyInputRestore() snapshot and
// re-apply in-flight UI state (typed-but-unsubmitted input value + caret + focus + scroll)
// across that render. The logic is correct (clobber-prevented, vanished-node no-op, scroll
// clamp) but had ZERO tests.
//
// public/app.js is a classic browser script (touches `document` at module load, no exports),
// so we can't import it. Mirroring test/state-meta-fallback.test.ts, we pull the three
// helper blocks fenced with `<test-extract:...>` sentinels and eval them — but these helpers
// touch document/window, so we hand the eval'd harness a minimal hand-rolled fake DOM and
// exercise the REAL capture/restore logic against it. The only module-level dependency is
// `pendingInlineRestore` (restoreUiState assigns it), declared as a local in the harness.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

type FakeNode = {
  dataset: { restoreKey: string };
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  setSelectionRange: (a: number, b: number) => void;
  focus: () => void;
  // test-only spies
  _selRange: Array<[number, number]>;
  _focused: number;
};

function makeNode(key: string, value = "", selStart: number | null = null, selEnd: number | null = null): FakeNode {
  const n: FakeNode = {
    dataset: { restoreKey: key },
    value,
    selectionStart: selStart,
    selectionEnd: selEnd,
    setSelectionRange(a: number, b: number) {
      n._selRange.push([a, b]);
      n.selectionStart = a;
      n.selectionEnd = b;
    },
    focus() {
      n._focused++;
    },
    _selRange: [],
    _focused: 0,
  };
  return n;
}

/** Build the eval'd harness over a settable DOM. `setDom(nodes, active)` swaps the live node
 *  set (keyed by restore-key) — capture reads one DOM, then a "render" swaps to another that
 *  restore reads, exactly like the SSE path. The inline-comment editor is always absent here. */
function makeHarness() {
  let nodes: Record<string, FakeNode> = {};
  let active: FakeNode | null = null;

  const KEY_SEL = /^\[data-restore-key="(.+)"\]$/;
  const fakeDocument = {
    querySelectorAll(sel: string): FakeNode[] {
      return sel === "[data-restore-key]" ? Object.values(nodes) : [];
    },
    querySelector(sel: string): FakeNode | null {
      if (sel === ".dl-comment-edit .dlc-input") return null; // no open inline editor in these tests
      const m = sel.match(KEY_SEL);
      if (m) return nodes[m[1]] || null;
      return null;
    },
    get activeElement(): FakeNode | null {
      return active;
    },
  };

  const scrolls: Array<[number, number]> = [];
  const fakeWindow = {
    scrollY: 0,
    scrollTo(x: number, y: number) {
      scrolls.push([x, y]);
    },
  };

  const body = `
    let pendingInlineRestore = null;
    ${extract("capture-ui-state")}
    ${extract("restore-ui-state")}
    ${extract("apply-input-restore")}
    return { captureUiState, restoreUiState, applyInputRestore, getInline: () => pendingInlineRestore };
  `;
  const fns = new Function("document", "window", body)(fakeDocument, fakeWindow) as {
    captureUiState: () => any;
    restoreUiState: (snap: any) => void;
    applyInputRestore: (key: string, st: any, focus: boolean) => void;
    getInline: () => any;
  };

  return {
    ...fns,
    setDom(next: Record<string, FakeNode>, activeNode: FakeNode | null = null) {
      nodes = next;
      active = activeNode;
    },
    fakeWindow,
    scrolls,
  };
}

// (a) ROUND-TRIP: a keyed input with a value + caret is captured, then after a render that
// produces the SAME key as an EMPTY field, restoreUiState re-applies value + caret.
test("round-trip: captured value + caret is re-applied to an empty same-key field after render", () => {
  const h = makeHarness();
  const typed = makeNode("answer", "hello", 2, 4);
  h.setDom({ answer: typed }, typed); // focused while typing
  const snap = h.captureUiState();
  expect(snap.values.get("answer")).toEqual({ value: "hello", selStart: 2, selEnd: 4 });
  expect(snap.activeKey).toBe("answer");

  // SSE render: a brand-new, empty same-key field replaces the typed one.
  const rerendered = makeNode("answer", "");
  h.setDom({ answer: rerendered }, null);
  h.restoreUiState(snap);

  expect(rerendered.value).toBe("hello");
  expect(rerendered._selRange).toEqual([[2, 4]]);
  expect(rerendered._focused).toBe(1); // active field is re-focused
});

// (b) VANISHED KEY: if the post-render lookup returns null for a captured key, restore is a
// no-op and does NOT throw (render must stay green).
test("vanished key: restore is a safe no-op when the captured field is gone after render", () => {
  const h = makeHarness();
  const typed = makeNode("answer", "draft", 0, 5);
  h.setDom({ answer: typed }, typed);
  const snap = h.captureUiState();

  // The new view doesn't contain that input at all.
  h.setDom({}, null);
  expect(() => h.restoreUiState(snap)).not.toThrow();
});

// (c) NO-CLOBBER: if the post-render field already holds NON-EMPTY content, a captured value
// does NOT overwrite it (applyInputRestore only restores when st.value && !node.value).
test("no-clobber: a captured value never overwrites a non-empty re-rendered field", () => {
  const h = makeHarness();
  const typed = makeNode("answer", "stale-typed", 1, 3);
  h.setDom({ answer: typed }, null); // not focused → goes through the regular restore loop
  const snap = h.captureUiState();

  const rerendered = makeNode("answer", "server-provided");
  h.setDom({ answer: rerendered }, null);
  h.restoreUiState(snap);

  expect(rerendered.value).toBe("server-provided");
  expect(rerendered._selRange).toEqual([]); // caret untouched when value not restored
});
