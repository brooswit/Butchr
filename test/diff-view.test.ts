// public/views/diff.js builds NODES, not markup. These tests pin the DOM renderDiff() produces —
// structure only, never serialized bytes (test/dom-stub.ts deliberately has no innerHTML).
//
// The load-bearing one is "unknown language": the whole point of this conversion is that escaping
// became STRUCTURAL. A `<` or `&` reaches the DOM through createTextNode as itself, so it cannot be
// re-parsed as markup and no future edit can forget to call esc(). A string builder could regress
// silently; this cannot.
//
// Two rendered-whitespace facts are asserted because style.css makes them load-bearing:
//   - `.fstat` is an inline span (no flex), so the single space between its +N and −M IS rendered.
//   - `.dl` is `white-space: pre`, so a hunk header's EMPTY sign differs from a meta line's " ".
// The whitespace the old template carried between `.diff-summary` / `.diff-file-head` children was
// non-rendering (both are `display: flex`) and is intentionally NOT reproduced.
import { expect, test } from "bun:test";
import { renderDiff } from "../public/views/diff.js";
import { withDom, type StubNode } from "./dom-stub";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const hasClass = (n: StubNode, cls: string) =>
  n.nodeType === ELEMENT_NODE && n.className.split(/\s+/).includes(cls);

/** Depth-first collect of every element carrying `cls`. */
function byClass(root: StubNode, cls: string): StubNode[] {
  const out: StubNode[] = [];
  const walk = (n: StubNode) => {
    if (hasClass(n, cls)) out.push(n);
    for (const c of n.childNodes) walk(c);
  };
  walk(root);
  return out;
}

const one = (root: StubNode, cls: string): StubNode => {
  const hits = byClass(root, cls);
  expect(hits.length).toBe(1);
  return hits[0];
};

/** The `.dl` row of a given kind. NOT byClass(frag, "add") — the summary's `+N` span also
 *  carries `.add`, and it comes first in document order. */
const dlRow = (root: StubNode, kind: string): StubNode =>
  byClass(root, "dl").find((d) => hasClass(d, kind))!;

const SAMPLE = [
  "diff --git a/src/a.js b/src/a.js",
  "--- a/src/a.js",
  "+++ b/src/a.js",
  "@@ -1,2 +1,3 @@",
  " const x = 1;",
  '+const s = "hi";',
  "-let y = 2;",
].join("\n");

test("empty diff renders the (no changes) meta node", () => {
  withDom(() => {
    const frag = renderDiff("   ") as unknown as StubNode;
    expect(frag.children.length).toBe(1);
    const meta = frag.children[0];
    expect(meta.className).toBe("meta");
    expect(meta.textContent).toBe("(no changes)");
  });
});

test("summary counts files and totals adds/dels", () => {
  withDom(() => {
    const frag = renderDiff(SAMPLE) as unknown as StubNode;
    const summary = one(frag, "diff-summary");
    expect(summary.children[0].textContent).toBe("1 file changed");
    expect(one(summary, "add").textContent).toBe("+1");
    expect(one(summary, "del").textContent).toBe("−1");
  });
});

test("file card carries data-file-key and a .fstat with a RENDERED literal space", () => {
  withDom(() => {
    const frag = renderDiff(SAMPLE) as unknown as StubNode;
    const card = one(frag, "diff-file");
    expect(card.getAttribute("data-file-key")).toBe("src/a.js");
    expect(one(card, "fname").textContent).toBe("src/a.js");
    // `.fstat` is inline, not flex — the space between the counts is a real text node.
    const fstat = one(card, "fstat");
    expect(fstat.childNodes.map((c) => c.nodeType)).toEqual([ELEMENT_NODE, TEXT_NODE, ELEMENT_NODE]);
    expect(fstat.textContent).toBe("+1 −1");
  });
});

test("commentable lines carry the stable data-key / data-ctx anchors wireDiff queries", () => {
  withDom(() => {
    const frag = renderDiff(SAMPLE) as unknown as StubNode;
    const keys = byClass(frag, "dl")
      .map((d) => d.getAttribute("data-key"))
      .filter(Boolean);
    // ctx line (new side 1), added line (new side 2), deleted line (OLD side 2 — the ctx line
    // already advanced the pre-image counter past 1).
    expect(keys).toEqual(["src/a.js␟n1", "src/a.js␟n2", "src/a.js␟o2"]);
    const del = dlRow(frag, "del");
    expect(del.getAttribute("data-ctx")).toBe("src/a.js:2");
    expect(one(del, "dl-num").textContent).toBe("2");
    expect(one(del, "dl-sign").textContent).toBe("−");
  });
});

test("hunk sign is EMPTY while a meta line's sign is a single space (.dl is white-space: pre)", () => {
  withDom(() => {
    const frag = renderDiff(`${SAMPLE}\n\\ No newline at end of file`) as unknown as StubNode;
    const hunk = dlRow(frag, "hunk");
    const meta = dlRow(frag, "meta");
    expect(one(hunk, "dl-sign").textContent).toBe("");
    expect(one(meta, "dl-sign").textContent).toBe(" ");
    expect(one(hunk, "dl-text").textContent).toBe("@@ -1,2 +1,3 @@");
  });
});

test("js lines highlight keywords and strings as tok spans, one node per SEGMENT", () => {
  withDom(() => {
    const frag = renderDiff(SAMPLE) as unknown as StubNode;
    const text = one(dlRow(frag, "add"), "dl-text");
    expect(one(text, "tok-k").textContent).toBe("const");
    expect(one(text, "tok-s").textContent).toBe('"hi"');
    // The unclassified run between them (` s = `) is ONE text node, not one per character.
    expect(text.childNodes.filter((c) => c.nodeType === TEXT_NODE).map((c) => c.textContent))
      .toEqual([" s = ", ";"]);
  });
});

test("css lines highlight at-rules and hex colors", () => {
  withDom(() => {
    const css = ["diff --git a/s.css b/s.css", "+++ b/s.css", "@@ -0,0 +1,1 @@", "+@media { color: #fff; }"].join("\n");
    const frag = renderDiff(css) as unknown as StubNode;
    const text = one(dlRow(frag, "add"), "dl-text");
    expect(one(text, "tok-k").textContent).toBe("@media");
    expect(one(text, "tok-n").textContent).toBe("#fff");
  });
});

// THE THESIS OF THIS CONVERSION. No lexer for .txt → the line becomes ONE plain text node, and the
// markup metacharacters survive as themselves. Escaping is structural: there is no esc() to forget.
test("unknown language falls back to a single text node with < and & intact", () => {
  withDom(() => {
    const txt = ["diff --git a/n.txt b/n.txt", "+++ b/n.txt", "@@ -0,0 +1,1 @@", "+a < b && <script>"].join("\n");
    const frag = renderDiff(txt) as unknown as StubNode;
    const text = one(dlRow(frag, "add"), "dl-text");
    expect(text.childNodes.length).toBe(1);
    expect(text.childNodes[0].nodeType).toBe(TEXT_NODE);
    expect(text.textContent).toBe("a < b && <script>");
    expect(byClass(text, "tok-k").length).toBe(0);
  });
});

test("binary files render the placeholder instead of lines", () => {
  withDom(() => {
    const bin = ["diff --git a/i.png b/i.png", "Binary files a/i.png and b/i.png differ"].join("\n");
    const frag = renderDiff(bin) as unknown as StubNode;
    expect(one(frag, "diff-binary").textContent).toBe("Binary file not shown");
    expect(byClass(frag, "dl").length).toBe(0);
  });
});
