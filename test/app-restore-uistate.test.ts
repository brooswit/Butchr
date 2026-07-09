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
// `setPendingInlineRestore` — restoreUiState hands an open inline-comment editor to the diff
// view through it (the real one lives in public/views/diff.js, which owns that cell; an
// imported binding is read-only, so app.js writes it via the setter). The harness stands in a
// local cell + setter of the same shape and reads it back through getInline().
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

/** A fake open inline-comment editor: the `.dlc-input` textarea inside a `.dl-comment-edit` wrap
 *  whose previous sibling is the diff line it annotates (that line's `data-key` is the anchor
 *  captureUiState records). Mirrors the DOM openCommentEditor builds in public/views/diff.js. */
function makeInlineEditor(lineKey: string, value: string, selStart: number, selEnd: number) {
  const dl = { dataset: { key: lineKey } };
  const wrap = { previousElementSibling: dl };
  return { value, selectionStart: selStart, selectionEnd: selEnd, closest: (_sel: string) => wrap };
}

/** Build the eval'd harness over a settable DOM. `setDom(nodes, active)` swaps the live node
 *  set (keyed by restore-key) — capture reads one DOM, then a "render" swaps to another that
 *  restore reads, exactly like the SSE path. `setInlineEditor` opens/closes the inline-comment
 *  editor that captureUiState stashes and (in the real app) wireDiff re-opens. */
function makeHarness() {
  let nodes: Record<string, FakeNode> = {};
  let active: FakeNode | null = null;
  let inlineEditor: ReturnType<typeof makeInlineEditor> | null = null;

  const KEY_SEL = /^\[data-restore-key="(.+)"\]$/;
  const fakeDocument = {
    querySelectorAll(sel: string): FakeNode[] {
      return sel === "[data-restore-key]" ? Object.values(nodes) : [];
    },
    querySelector(sel: string): any {
      if (sel === ".dl-comment-edit .dlc-input") return inlineEditor;
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
    const setPendingInlineRestore = (v) => { pendingInlineRestore = v; };
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
    setInlineEditor(ed: ReturnType<typeof makeInlineEditor> | null) {
      inlineEditor = ed;
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

// (d) INLINE-COMMENT HANDOFF: the one cross-module cell. An open inline-comment editor lives
// inside the ASYNC-fetched diff, so it cannot be restored inline — captureUiState stashes it and
// restoreUiState hands it to views/diff.js via setPendingInlineRestore(), which wireDiff() later
// drains once the diff's line rows exist. Before the module split this cell was a bare `let` in
// app.js and NOTHING asserted the handoff; it is the sole guard on the SSE-re-render hack, so it
// is covered here in both directions.
test("inline handoff: an open comment editor is captured by its diff-line key and handed to the diff view", () => {
  const h = makeHarness();
  // A typed-in generic field AND an open inline-comment editor, together, mid-render.
  const answer = makeNode("answer", "note", 4, 4);
  const skipped = makeNode("inline-comment", "should-not-be-captured-generically");
  h.setDom({ answer, "inline-comment": skipped }, null);
  h.setInlineEditor(makeInlineEditor("src/app.ts␟n42", "needs a guard", 3, 8));

  const snap = h.captureUiState();
  // The editor is captured SEPARATELY (by diff-line key), and skipped by the generic pass —
  // otherwise restore would try to re-apply it by restore-key into a diff that isn't painted yet.
  expect(snap.inline).toEqual({ key: "src/app.ts␟n42", value: "needs a guard", selStart: 3, selEnd: 8 });
  expect(snap.values.has("inline-comment")).toBe(false);
  expect(snap.values.has("answer")).toBe(true);

  // The SSE render tears the diff down; restore hands the editor off for wireDiff to re-open.
  h.setDom({ answer: makeNode("answer", "") }, null);
  h.setInlineEditor(null);
  h.restoreUiState(snap);
  expect(h.getInline()).toEqual({ key: "src/app.ts␟n42", value: "needs a guard", selStart: 3, selEnd: 8 });
});

// (e) NO OPEN EDITOR: restore must CLEAR the cell, not leave a stale editor pending. wireDiff only
// drains a truthy value, so a leftover would re-open an editor the operator had already closed.
test("inline handoff: with no editor open, restore clears the pending cell to null", () => {
  const h = makeHarness();
  h.setDom({ answer: makeNode("answer", "x", 0, 1) }, null);
  const snap = h.captureUiState();
  expect(snap.inline).toBe(null);

  h.setDom({ answer: makeNode("answer", "") }, null);
  h.restoreUiState(snap);
  expect(h.getInline()).toBe(null);
});

// (f) UNANCHORED EDITOR: an editor whose diff line carries no data-key (nothing to re-attach to)
// is NOT captured — capturing it would hand wireDiff a keyless restore it can never place.
test("inline handoff: an editor with no anchoring diff-line key is not captured", () => {
  const h = makeHarness();
  h.setDom({}, null);
  h.setInlineEditor(makeInlineEditor("", "orphan", 0, 0));
  expect(h.captureUiState().inline).toBe(null);
});
