// public/views/diff.tsx — the React diff reader (RFC Phase 4b), driven through
// @testing-library/react against a real (happy-dom) DOM.
//
// >>> IT IS NOT MOUNTED IN THE APP YET, AND THESE TESTS ARE THE ONLY THING EXERCISING IT. <<<
// The brief said to "point the `#/metrics` and diff routes at real React elements". There is no diff
// route: `renderDiff`'s only caller is `renderTask` in the still-vanilla views/task.js, so the diff
// reader is a COMPONENT of the task view and nothing in App.tsx can point at it. views/task.tsx
// (Phase 4c) is what mounts this. Until then the vanilla views/diff.js still ships and keeps its own
// coverage in test/diff-vanilla-view.test.ts — and both renderers call ONE tokenizer and ONE line
// anchor in views/diff-logic.ts, which is what stops them drifting while both exist.
//
// The load-bearing test here is "unknown language": escaping is STRUCTURAL. A `<` or `&` reaches the
// DOM as a JSX string child, so it cannot be re-parsed as markup and no future edit can forget to
// call esc(). The vanilla file proved the same property through createTextNode.
//
// Two rendered-whitespace facts are asserted because style.css makes them load-bearing:
//   - `.fstat` is an inline span (no flex), so the single space between its +N and −M IS rendered.
//   - `.dl` is `white-space: pre`, so a hunk header's EMPTY sign differs from a meta line's " ".
//
// The PURE half's assertions (`parseDiff`, `composeReviewNote`) are not re-tested here; they belong
// to views/diff-logic.ts and are covered where they always were.
import "./dom-register.ts"; // must precede every React import — installs `document`
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { registerDom, unregisterDom } from "./dom-env.ts";
import { DiffView } from "../public/views/diff.tsx";
import type { InlineComment } from "../public/views/diff-logic.js";

// The import above only installs a DOM for the FIRST React file `bun test` reaches — a module's side
// effect runs once per process, and another React file's `afterAll` may have torn it down before
// this one runs. See test/dom-register.ts. `registerDom` is idempotent.
beforeAll(registerDom);

const TEXT_NODE = 3;

const SAMPLE = [
  "diff --git a/src/a.js b/src/a.js",
  "--- a/src/a.js",
  "+++ b/src/a.js",
  "@@ -1,2 +1,3 @@",
  " const x = 1;",
  '+const s = "hi";',
  "-let y = 2;",
].join("\n");

afterEach(cleanup);

/** `DiffView` is CONTROLLED on `comments`: it never stores them, it hands the caller the next map.
 *  This is the caller — it holds the map and re-renders, which is exactly what views/task.tsx will
 *  do with the `useState` it needs anyway for `composeReviewNote`. `latest()` reads the current map. */
function mount(diff: string, taskId = "t1") {
  let comments: ReadonlyMap<string, InlineComment> = new Map();
  function element() {
    return createElement(DiffView, {
      diff,
      taskId,
      comments,
      onCommentsChange: (next: Map<string, InlineComment>) => {
        comments = next;
        view.rerender(element());
      },
    });
  }
  const view = render(element());
  return { ...view, latest: () => comments };
}

const dlRow = (container: HTMLElement, kind: string) => container.querySelector<HTMLElement>(`.dl.${kind}`)!;

/** LaunchPad's `Button` fires `onPress`, not `onClick` — react-aria's `usePress` listens on the
 *  POINTER events and only synthesizes a press from them. `fireEvent.click` alone does nothing, and
 *  the test fails one assertion later with a missing element rather than a missing handler. */
function press(el: Element) {
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, isPrimary: true });
  fireEvent.pointerUp(el, { pointerId: 1, button: 0, isPrimary: true });
  fireEvent.click(el, { detail: 1 });
}

/** The editor/row action buttons are the only `<button>`s inside a `.dlc-actions`; the file card's
 *  head is a `<button>` too, so a bare `querySelectorAll("button")` scan would find it first. */
const action = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll(".dlc-actions button")].find((b) => b.textContent === label)!;

test("empty diff renders the (no changes) meta node", () => {
  const { container } = mount("   ");
  expect(container.querySelectorAll(".diff-file").length).toBe(0);
  expect(container.querySelector(".meta")!.textContent).toBe("(no changes)");
});

test("summary counts files and totals adds/dels", () => {
  const { container } = mount(SAMPLE);
  const summary = container.querySelector(".diff-summary")!;
  expect(summary.children[0].textContent).toBe("1 file changed");
  expect(summary.querySelector(".add")!.textContent).toBe("+1");
  expect(summary.querySelector(".del")!.textContent).toBe("−1");
});

test("file card carries data-file-key and a .fstat with a RENDERED literal space", () => {
  const { container } = mount(SAMPLE);
  const card = container.querySelector(".diff-file")!;
  expect(card.getAttribute("data-file-key")).toBe("src/a.js");
  expect(card.querySelector(".fname")!.textContent).toBe("src/a.js");
  const fstat = card.querySelector(".fstat")!;
  expect([...fstat.childNodes].map((c) => c.nodeType)).toEqual([1, TEXT_NODE, 1]);
  expect(fstat.textContent).toBe("+1 −1");
});

test("commentable lines carry the stable data-key / data-ctx anchors", () => {
  const { container } = mount(SAMPLE);
  const keys = [...container.querySelectorAll(".dl[data-key]")].map((d) => d.getAttribute("data-key"));
  // ctx line (new side 1), added line (new side 2), deleted line (OLD side 2 — the ctx line already
  // advanced the pre-image counter past 1).
  expect(keys).toEqual(["src/a.js␟n1", "src/a.js␟n2", "src/a.js␟o2"]);
  const del = dlRow(container, "del");
  expect(del.getAttribute("data-ctx")).toBe("src/a.js:2");
  expect(del.querySelector(".dl-num")!.textContent).toBe("2");
  expect(del.querySelector(".dl-sign")!.textContent).toBe("−");
});

test("hunk sign is EMPTY while a meta line's sign is a single space (.dl is white-space: pre)", () => {
  const { container } = mount(`${SAMPLE}\n\\ No newline at end of file`);
  const hunk = dlRow(container, "hunk");
  const meta = dlRow(container, "meta");
  expect(hunk.querySelector(".dl-sign")!.textContent).toBe("");
  expect(meta.querySelector(".dl-sign")!.textContent).toBe(" ");
  expect(hunk.querySelector(".dl-text")!.textContent).toBe("@@ -1,2 +1,3 @@");
});

test("js lines highlight keywords and strings as tok spans, one node per SEGMENT", () => {
  const { container } = mount(SAMPLE);
  const text = dlRow(container, "add").querySelector(".dl-text")!;
  expect(text.querySelector(".tok-k")!.textContent).toBe("const");
  expect(text.querySelector(".tok-s")!.textContent).toBe('"hi"');
  // The unclassified run between them (` s = `) is ONE text node, not one per character, and not a
  // wrapper span — `<Fragment key>` is how a bare string child is keyed.
  expect([...text.childNodes].filter((c) => c.nodeType === TEXT_NODE).map((c) => c.textContent)).toEqual([
    " s = ",
    ";",
  ]);
});

test("css lines highlight at-rules and hex colors", () => {
  const css = ["diff --git a/s.css b/s.css", "+++ b/s.css", "@@ -0,0 +1,1 @@", "+@media { color: #fff; }"].join("\n");
  const { container } = mount(css);
  const text = dlRow(container, "add").querySelector(".dl-text")!;
  expect(text.querySelector(".tok-k")!.textContent).toBe("@media");
  expect(text.querySelector(".tok-n")!.textContent).toBe("#fff");
});

// THE THESIS. No lexer for .txt → the line becomes ONE plain text node, and the markup
// metacharacters survive as themselves. JSX cannot forget to escape a string child.
test("unknown language falls back to a single text node with < and & intact", () => {
  const txt = ["diff --git a/n.txt b/n.txt", "+++ b/n.txt", "@@ -0,0 +1,1 @@", "+a < b && <script>"].join("\n");
  const { container } = mount(txt);
  const text = dlRow(container, "add").querySelector(".dl-text")!;
  expect(text.childNodes.length).toBe(1);
  expect(text.childNodes[0].nodeType).toBe(TEXT_NODE);
  expect(text.textContent).toBe("a < b && <script>");
  expect(text.querySelectorAll(".tok-k").length).toBe(0);
});

test("binary files render the placeholder instead of lines", () => {
  const bin = ["diff --git a/i.png b/i.png", "Binary files a/i.png and b/i.png differ"].join("\n");
  const { container } = mount(bin);
  expect(container.querySelector(".diff-binary")!.textContent).toBe("Binary file not shown");
  expect(container.querySelectorAll(".dl").length).toBe(0);
});

// ---------- what the vanilla version could only do through wireDiff() ----------
// renderDiff() registered no listeners; wireDiff() queried the LIVE box afterwards. There is one
// pass now, so the behaviour below is reachable straight off render().

test("the file head toggles collapse and reports it through aria-expanded", () => {
  const { container } = mount(SAMPLE);
  const card = container.querySelector(".diff-file")!;
  const head = card.querySelector(".diff-file-head")!;
  expect(card.className).not.toContain("collapsed");
  expect(head.getAttribute("aria-expanded")).toBe("true");

  fireEvent.click(head);
  expect(container.querySelector(".diff-file")!.className).toContain("collapsed");
  expect(container.querySelector(".diff-file-head")!.getAttribute("aria-expanded")).toBe("false");

  fireEvent.click(container.querySelector(".diff-file-head")!);
  expect(container.querySelector(".diff-file")!.className).not.toContain("collapsed");
});

test("clicking a gutter number opens the editor; saving lifts an anchored comment to the caller", () => {
  const { container, latest } = mount(SAMPLE);
  const add = dlRow(container, "add");
  fireEvent.click(add.querySelector(".dl-num")!);

  const ta = container.querySelector<HTMLTextAreaElement>(".dlc-input")!;
  expect(container.querySelector(".dl-comment-edit .dlc-ctx")!.textContent).toBe("src/a.js:2");
  fireEvent.change(ta, { target: { value: "  needs a guard  " } });
  press(action(container, "Save"));

  // The anchor carried path/line/side, so no `data-ctx` string had to be sliced back apart to
  // rebuild them. The saved text is trimmed.
  expect([...latest().entries()]).toEqual([
    ["src/a.js␟n2", { path: "src/a.js", line: 2, ctx: "src/a.js:2", text: "needs a guard", side: "n" }],
  ]);
  // The editor closed and the read-only row took its place, under the line it anchors to.
  expect(container.querySelector(".dl-comment-edit")).toBeNull();
  expect(container.querySelector(".dl-comment .dlc-text")!.textContent).toBe("needs a guard");
});

test("a deletion's comment anchors to the OLD side", () => {
  const { container, latest } = mount(SAMPLE);
  fireEvent.click(dlRow(container, "del").querySelector(".dl-num")!);
  fireEvent.change(container.querySelector(".dlc-input")!, { target: { value: "why?" } });
  press(action(container, "Save"));
  expect(latest().get("src/a.js␟o2")).toEqual({
    path: "src/a.js",
    line: 2,
    ctx: "src/a.js:2",
    text: "why?",
    side: "o",
  });
});

test("saving EMPTY deletes the comment, and so does Delete", () => {
  const { container, latest } = mount(SAMPLE);
  const openAdd = () => fireEvent.click(dlRow(container, "add").querySelector(".dl-num")!);
  const clickButton = (label: string) => press(action(container, label));

  openAdd();
  fireEvent.change(container.querySelector(".dlc-input")!, { target: { value: "keep" } });
  clickButton("Save");
  expect(latest().size).toBe(1);

  // Re-open through the saved row's Edit affordance, blank it, save.
  clickButton("Edit");
  fireEvent.change(container.querySelector(".dlc-input")!, { target: { value: "   " } });
  clickButton("Save");
  expect(latest().size).toBe(0);

  // And the explicit Delete path.
  openAdd();
  fireEvent.change(container.querySelector(".dlc-input")!, { target: { value: "again" } });
  clickButton("Save");
  expect(latest().size).toBe(1);
  clickButton("Delete");
  expect(latest().size).toBe(0);
  expect(container.querySelector(".dl-comment")).toBeNull();
});

test("Cancel reverts to the saved row without touching the caller's map", () => {
  const { container, latest } = mount(SAMPLE);
  const clickButton = (label: string) => press(action(container, label));

  fireEvent.click(dlRow(container, "add").querySelector(".dl-num")!);
  fireEvent.change(container.querySelector(".dlc-input")!, { target: { value: "saved" } });
  clickButton("Save");

  clickButton("Edit");
  fireEvent.change(container.querySelector(".dlc-input")!, { target: { value: "discarded" } });
  clickButton("Cancel");

  expect(container.querySelector(".dl-comment-edit")).toBeNull();
  expect(container.querySelector(".dl-comment .dlc-text")!.textContent).toBe("saved");
  expect(latest().get("src/a.js␟n2")!.text).toBe("saved");
});

// `resetInlineComments(taskId)` used to rebind the module-scoped collapse Set when a different
// task's diff opened. It is component state keyed on the task now — same guarantee, no module state.
test("a new taskId resets the per-file collapse state", () => {
  let props = { diff: SAMPLE, taskId: "t1", comments: new Map(), onCommentsChange: () => {} };
  const { container, rerender } = render(createElement(DiffView, props));

  fireEvent.click(container.querySelector(".diff-file-head")!);
  expect(container.querySelector(".diff-file")!.className).toContain("collapsed");

  props = { ...props, taskId: "t2" };
  rerender(createElement(DiffView, props));
  expect(container.querySelector(".diff-file")!.className).not.toContain("collapsed");
});

afterAll(unregisterDom);
