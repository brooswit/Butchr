// The DIFF view — the unified-diff reader on a task's review surface: parsing, dependency-free
// syntax highlighting, per-file collapse, and the inline review-comment editor. Extracted from
// app.js (RFC Phase 2, story st-46f1e8d9 S5).
//
// It imports only LEAVES — `core/dom.js` for `el` — and NOTHING else. In particular it does
// NOT import core/nav.js: nothing here navigates or re-renders. (The `render` mentioned in the
// comments below is the app's SSE re-render, which this module survives rather than triggers.)
// It never imports app.js; see the header of core/nav.js for why that edge is fatal.
//
// Everything here builds NODES, never markup strings: renderDiff() returns a DocumentFragment, so
// escaping is STRUCTURAL (createTextNode cannot be forgotten the way esc() could) and no caller has
// to trust a string. This matters more here than anywhere else — a diff body is arbitrary source
// text, angle brackets and all.
//
// DOM-free at module load: the module-level state below is a Map, two Sets, and a null. `document`
// is touched only inside a CALLED function (updateCommentSummary), so this module is importable
// under a non-browser runner.
//
// Called only by renderTask (views/task.js): renderDiff() builds the nodes, wireDiff() wires the
// freshly-painted result, composeReviewNote() folds the inline comments into a change-request note.
// setPendingInlineRestore() is the ONE inbound write — see the comment on pendingInlineRestore.
//
// PAINT AND WIRE ARE SPLIT ON PURPOSE. renderDiff() registers no listeners; wireDiff() queries the
// LIVE box after the fragment is attached. A DocumentFragment's children are unreachable through
// `box.querySelectorAll` until then, so the call site must replaceChildren() FIRST and wireDiff()
// second. The split is also what lets the SSE restore path call wireDiff() on its own.
import { el } from "../core/dom.js";

// Parse a unified diff into per-file groups for a readable, GitHub-style view.
// Each non-meta line also carries the source line numbers it maps to (oldNo on the
// pre-image side, newNo on the post-image side), tracked from the hunk `@@` headers
// — these drive the line-number gutter and the file:line context attached to inline
// review comments. The "\ No newline at end of file" marker is a `meta` line with no
// numbers (not commentable).
function parseDiff(diff) {
  const files = [];
  let cur = null;
  let oldNo = 0, newNo = 0;
  const start = (header) => {
    cur = { header, path: "", oldPath: "", add: 0, del: 0, binary: false, lines: [] };
    files.push(cur);
    oldNo = 0; newNo = 0;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      const m = line.match(/ b\/(.+)$/);
      start(line);
      if (m) cur.path = m[1];
      continue;
    }
    if (!cur) start(line); // diff without a "diff --git" preamble
    if (line.startsWith("--- ")) { cur.oldPath = line.slice(4).replace(/^a\//, ""); continue; }
    if (line.startsWith("+++ ")) { cur.path = line.slice(4).replace(/^b\//, "") || cur.path; continue; }
    if (line.startsWith("index ") || line.startsWith("new file") ||
        line.startsWith("deleted file") || line.startsWith("old mode") ||
        line.startsWith("new mode") || line.startsWith("similarity") ||
        line.startsWith("rename ")) continue;
    if (line.startsWith("Binary files")) { cur.binary = true; continue; }
    if (line.startsWith("@@")) {
      // @@ -<oldStart>[,<oldLen>] +<newStart>[,<newLen>] @@ — reset both counters.
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldNo = +m[1]; newNo = +m[2]; }
      cur.lines.push({ t: "hunk", text: line });
      continue;
    }
    if (line.startsWith("+")) { cur.add++; cur.lines.push({ t: "add", text: line, newNo }); newNo++; continue; }
    if (line.startsWith("-")) { cur.del++; cur.lines.push({ t: "del", text: line, oldNo }); oldNo++; continue; }
    if (line.startsWith("\\")) { cur.lines.push({ t: "meta", text: line }); continue; } // "No newline…"
    if (line.length) { cur.lines.push({ t: "ctx", text: line, oldNo, newNo }); oldNo++; newNo++; }
  }
  return files;
}

// ---------- dependency-free syntax highlighting ----------
// A tiny per-line tokenizer for the diff view. No external lib: we scan the line
// char-by-char and wrap keywords/strings/comments/numbers in <span class="tok-*">.
// It is intentionally line-local — a /* */ block comment that spans diff lines only
// colors the portion on each line — which is good enough for review-time reading and
// keeps the scanner stateless across the interleaved add/del/ctx lines of a hunk.

// Pick a highlight language from the file path. JSON rides the JS scanner (its
// strings/numbers/true/false/null all tokenize correctly there). Returns null for
// types we don't tokenize, so the text falls back to plain (escaped) rendering.
function langForPath(path) {
  const p = (path || "").toLowerCase();
  if (/\.(tsx?|jsx?|mjs|cjs|json)$/.test(p)) return "js";
  if (/\.css$/.test(p)) return "css";
  return null;
}

const JS_KEYWORDS = new Set(
  ("abstract,as,async,await,break,case,catch,class,const,continue,debugger,declare," +
   "default,delete,do,else,enum,export,extends,false,finally,for,from,function,get," +
   "if,implements,import,in,instanceof,interface,is,keyof,let,namespace,new,null,of," +
   "override,private,protected,public,readonly,return,satisfies,set,static,super," +
   "switch,this,throw,true,try,type,typeof,undefined,var,void,while,with,yield").split(","),
);

function tok(cls, raw) { return el("span", { class: `tok-${cls}` }, raw); }

// A line builder for the scanners below. The string version concatenated `esc(c)` ONE CHARACTER AT
// A TIME for every char the lexer didn't classify; translating that literally would mint a text node
// per character, and a diff runs to thousands of lines. So unclassified chars accumulate in a plain
// string `run`, flushed as a SINGLE text node just before each tok span and once at the end. Net:
// one node per SEGMENT, exactly the granularity the string version rendered.
function lineBuilder() {
  const frag = document.createDocumentFragment();
  let run = "";
  return {
    text(s) { run += s; },
    tok(cls, raw) {
      if (run) { frag.appendChild(document.createTextNode(run)); run = ""; }
      frag.appendChild(tok(cls, raw));
    },
    done() {
      if (run) { frag.appendChild(document.createTextNode(run)); run = ""; }
      return frag;
    },
  };
}

// Scan a quoted string starting at i (text[i] is the quote). Returns the end index
// (one past the closing quote, or end-of-line if unterminated). Honors backslash
// escapes so an escaped quote doesn't close the string early.
function scanString(text, i) {
  const q = text[i], n = text.length;
  let j = i + 1;
  while (j < n && text[j] !== q) { if (text[j] === "\\") j++; j++; }
  return Math.min(j + 1, n);
}

function highlightJs(text) {
  const out = lineBuilder();
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") { out.tok("c", text.slice(i)); break; }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out.tok("c", text.slice(i, stop)); i = stop; continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const stop = scanString(text, i);
      out.tok("s", text.slice(i, stop)); i = stop; continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] || ""))) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-Fx._]/.test(text[j])) j++;
      out.tok("n", text.slice(i, j)); i = j; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j++;
      const word = text.slice(i, j);
      if (JS_KEYWORDS.has(word)) out.tok("k", word); else out.text(word);
      i = j; continue;
    }
    out.text(c); i++;
  }
  return out.done();
}

function highlightCss(text) {
  const out = lineBuilder();
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out.tok("c", text.slice(i, stop)); i = stop; continue;
    }
    if (c === '"' || c === "'") {
      const stop = scanString(text, i);
      out.tok("s", text.slice(i, stop)); i = stop; continue;
    }
    if (c === "@") { // at-rule (@media, @keyframes, …)
      let j = i + 1;
      while (j < n && /[A-Za-z-]/.test(text[j])) j++;
      out.tok("k", text.slice(i, j)); i = j; continue;
    }
    if (c === "#") { // hex color (#fff / #ffffff / #ffffffff)
      let j = i + 1;
      while (j < n && /[0-9A-Fa-f]/.test(text[j])) j++;
      const span = text.slice(i, j);
      if (/^#([0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(span)) {
        out.tok("n", span); i = j; continue;
      }
      out.text(c); i++; continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] || ""))) {
      let j = i + 1;
      while (j < n && /[0-9a-zA-Z%._-]/.test(text[j])) j++; // number + unit (px, em, %, …)
      out.tok("n", text.slice(i, j)); i = j; continue;
    }
    out.text(c); i++;
  }
  return out.done();
}

// Highlight one line of code → a DocumentFragment of text nodes and <span class="tok-*"> wrappers.
// Unknown languages (lang null) and any scanner failure fall back to ONE plain text node — which is
// precisely where esc() stopped being needed: createTextNode escapes structurally, so a `<` or `&`
// in the source lands in the DOM as itself and can never be re-parsed as markup.
function highlightCode(text, lang) {
  if (!text) return document.createDocumentFragment();
  try {
    if (lang === "js") return highlightJs(text);
    if (lang === "css") return highlightCss(text);
  } catch (e) { /* fall through to plain text */ }
  return document.createTextNode(text);
}

// Build one diff line row: the gutter number, the +/−/space sign, and the (possibly
// highlighted) text. Registers no listeners — wireDiff() does that against the live DOM.
function renderLine(l, name, lang) {
  if (l.t === "hunk" || l.t === "meta") {
    // `.dl` is `white-space: pre`, so the hunk header's EMPTY sign and the meta line's
    // single-space sign are a real rendered difference. Keep both verbatim.
    return el("div", { class: `dl ${l.t === "hunk" ? "hunk" : "ctx meta"}` }, [
      el("span", { class: "dl-num" }),
      el("span", { class: "dl-sign" }, l.t === "hunk" ? [] : " "),
      el("span", { class: "dl-text" }, l.text),
    ]);
  }
  const sign = l.t === "add" ? "+" : l.t === "del" ? "−" : " ";
  const text = l.t === "add" || l.t === "del" ? l.text.slice(1) : l.text;
  // Comment anchor: deletions reference the pre-image line, everything else
  // the post-image line. The key (path + side + line) is stable across diff
  // re-fetches, so stored inline comments re-attach after an SSE re-render.
  const lineNo = l.t === "del" ? l.oldNo : l.newNo;
  const side = l.t === "del" ? "o" : "n";
  const key = `${name}␟${side}${lineNo}`;
  const ctx = `${name}:${lineNo}`;
  return el("div", { class: `dl ${l.t}`, "data-key": key, "data-ctx": ctx }, [
    el("span", { class: "dl-num", title: `comment on ${ctx}` }, String(lineNo)),
    el("span", { class: "dl-sign" }, sign),
    el("span", { class: "dl-text" }, highlightCode(text, lang)),
  ]);
}

// Build one file card. The body is assembled into a DETACHED fragment and appended once, so a
// thousand-line file costs one insertion into the card, not one per line, and nothing reads
// layout mid-build.
function renderFileCard(f) {
  const name = f.path || f.oldPath || "(unknown)";
  const lang = langForPath(name);
  const body = el("div", { class: "diff-file-body" });
  if (f.binary) {
    body.appendChild(el("div", { class: "diff-binary" }, "Binary file not shown"));
  } else {
    const lines = document.createDocumentFragment();
    for (const l of f.lines) lines.appendChild(renderLine(l, name, lang));
    body.appendChild(lines);
  }
  // `.fstat` is an inline span (no flex), so the literal space between the two counts IS
  // rendered — it stays an explicit text node. The whitespace the old template carried
  // between the head's own children was non-rendering (`.diff-file-head` is `display: flex`).
  const fstat = el("span", { class: "fstat" }, [
    el("span", { class: "add" }, `+${f.add}`),
    " ",
    el("span", { class: "del" }, `−${f.del}`),
  ]);
  return el("div", { class: "diff-file", "data-file-key": name }, [
    el("button", { class: "diff-file-head", type: "button" }, [
      el("span", { class: "caret" }, "▾"),
      el("span", { class: "fname" }, name),
      fstat,
    ]),
    body,
  ]);
}

// Render a unified diff to a DocumentFragment: the summary line plus one card per file.
// Returns NODES, not markup — the caller attaches it (replaceChildren) and only THEN wires it.
export function renderDiff(diff) {
  const frag = document.createDocumentFragment();
  if (!diff || !diff.trim()) {
    frag.appendChild(el("div", { class: "meta" }, "(no changes)"));
    return frag;
  }
  const files = parseDiff(diff);
  const totAdd = files.reduce((a, f) => a + f.add, 0);
  const totDel = files.reduce((a, f) => a + f.del, 0);

  // `.diff-summary` is `display: flex` with a gap, so the old template's newline+indent between
  // these spans generated no anonymous flex item and is dropped rather than reproduced.
  frag.appendChild(el("div", { class: "diff-summary" }, [
    el("span", {}, `${files.length} file${files.length === 1 ? "" : "s"} changed`),
    el("span", { class: "add" }, `+${totAdd}`),
    el("span", { class: "del" }, `−${totDel}`),
  ]));
  for (const f of files) frag.appendChild(renderFileCard(f));
  return frag;
}

// ---------- inline review comments ----------
// Per-line review comments the reviewer attaches by clicking a diff line's gutter.
// Kept at module scope (keyed by a stable path+side+line key) so they survive the
// full re-render the app does on every SSE event AND the async diff re-fetch — the
// diff is re-rendered with the same keys, and wireDiff re-paints the stored comments
// onto it. Reset when a different task's diff is opened. On "Request change" they are
// composed (with their file:line context) into the single change-request note sent
// to /reject, so the resumed agent gets specific per-line feedback in its rework
// prompt — no change to the reject payload shape (see composeReviewNote).
let inlineComments = new Map(); // key -> { path, line, side, ctx, text }
let inlineCommentsTaskId = null;
// Diff-file collapse state — module-persisted (keyed by file path) so a collapsed
// file stays collapsed across the full re-render the app does on every SSE event,
// mirroring inlineComments above. Reset alongside inlineComments when a different
// task's diff is opened, so a new task doesn't inherit the prior task's collapse set.
let collapsedDiffFiles = new Set();
// An open (uncommitted) inline-comment editor lives inside the async-fetched diff, so
// it isn't in the DOM right after render(); captureUiState() stashes it here and
// wireDiff() re-opens + refills it once the diff is painted. Null when none is open.
//
// This cell is an ASYNC HANDOFF, which is why it is state and not a parameter: app.js's
// restoreUiState() writes it immediately after render(), but the diff is fetched later, so
// wireDiff() is the first moment its line rows exist to restore into. The producer and the
// consumer are separated by a network round-trip and cannot share a call frame.
//
// It lives HERE, in the module that consumes it, because "an open inline-comment editor
// inside the diff" is diff-view state. app.js writes it through setPendingInlineRestore()
// rather than importing the binding: ES module imports are read-only, so an `export let`
// could not be assigned across the boundary. The edge is `app.js -> views/diff.js`, the
// same direction app.js already imports views/metrics.js — never the reverse.
let pendingInlineRestore = null;

// Hand an open inline-comment editor (or null) to the next wireDiff(). The ONE inbound write:
// called by app.js's restoreUiState() on the SSE path. wireDiff() consumes and clears it.
export function setPendingInlineRestore(v) {
  pendingInlineRestore = v;
}

function resetInlineComments(taskId) {
  if (inlineCommentsTaskId !== taskId) {
    inlineComments = new Map();
    collapsedDiffFiles = new Set();
    inlineCommentsTaskId = taskId;
  }
}

// Compose the freeform note + any inline comments into one change-request note.
// Inline comments are listed in file/line order under a header so the agent reads
// them as a structured punch-list. Returns "" when there's nothing to send.
export function composeReviewNote(freeform) {
  const parts = [];
  const ff = (freeform || "").trim();
  if (ff) parts.push(ff);
  if (inlineComments.size) {
    const sorted = [...inlineComments.values()].sort((a, b) =>
      a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1);
    const lines = ["Inline comments:"];
    for (const c of sorted) {
      const body = c.text.trim().split("\n").join("\n  "); // indent continuation lines
      lines.push(`- ${c.ctx} — ${body}`);
    }
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

// Refresh the "N inline comment(s)" hint shown next to the review controls, if the
// review panel is present. Safe to call when it isn't (other task states).
function updateCommentSummary() {
  const el2 = document.getElementById("inline-comment-summary");
  if (!el2) return;
  const n = inlineComments.size;
  el2.textContent = n
    ? `${n} inline comment${n === 1 ? "" : "s"} will be included in the change request`
    : "";
  el2.classList.toggle("on", n > 0);
}

// Find a diff line row by its stable data-key (path may contain characters that are
// awkward in an attribute selector, so scan rather than querySelector).
function dlByKey(box, key) {
  return [...box.querySelectorAll(".dl[data-key]")].find((d) => d.dataset.key === key) || null;
}

// Remove the comment-display / editor row(s) immediately following a diff line.
function clearCommentRow(dl) {
  let next = dl.nextElementSibling;
  while (next && (next.classList.contains("dl-comment") || next.classList.contains("dl-comment-edit"))) {
    const after = next.nextElementSibling;
    next.remove();
    next = after;
  }
}

// Paint the saved comment for a key (if any) as a read-only row under its line, with
// edit/delete affordances. No-op when the line isn't currently in the DOM.
function renderCommentRow(box, key) {
  const dl = dlByKey(box, key);
  if (!dl) return;
  clearCommentRow(dl);
  const c = inlineComments.get(key);
  if (!c) return;
  const row = el("div", { class: "dl-comment" });
  row.appendChild(el("div", { class: "dlc-ctx" }, c.ctx));
  row.appendChild(el("div", { class: "dlc-text" }, c.text));
  const actions = el("div", { class: "dlc-actions" });
  const edit = el("button", { type: "button", class: "btn ghost xs" }, "Edit");
  edit.addEventListener("click", () => openCommentEditor(box, dl));
  const del = el("button", { type: "button", class: "btn ghost xs" }, "Delete");
  del.addEventListener("click", () => {
    inlineComments.delete(key);
    clearCommentRow(dl);
    updateCommentSummary();
  });
  actions.appendChild(edit);
  actions.appendChild(del);
  row.appendChild(actions);
  dl.after(row);
}

// Open (or focus) the inline comment editor under a diff line, prefilled with any
// existing comment. Save stores/updates it; saving empty deletes it; Cancel reverts
// to the saved display row.
function openCommentEditor(box, dl) {
  const key = dl.dataset.key;
  if (!key) return;
  clearCommentRow(dl);
  const existing = inlineComments.get(key);
  const wrap = el("div", { class: "dl-comment-edit" });
  wrap.appendChild(el("div", { class: "dlc-ctx" }, dl.dataset.ctx || ""));
  const ta = el("textarea", { class: "dlc-input", "data-restore-key": "inline-comment", placeholder: "Comment on this line — sent to the agent on Request change…" });
  ta.value = existing ? existing.text : "";
  wrap.appendChild(ta);
  const actions = el("div", { class: "dlc-actions" });
  const save = el("button", { type: "button", class: "btn xs" }, "Save");
  const cancel = el("button", { type: "button", class: "btn ghost xs" }, "Cancel");
  save.addEventListener("click", () => {
    const text = ta.value.trim();
    if (!text) { inlineComments.delete(key); clearCommentRow(dl); updateCommentSummary(); return; }
    // ctx like "path:line"; split off the path/line for stable ordering in the note.
    const ctx = dl.dataset.ctx || key;
    const ci = ctx.lastIndexOf(":");
    const path = ci === -1 ? ctx : ctx.slice(0, ci);
    const line = ci === -1 ? 0 : Number(ctx.slice(ci + 1)) || 0;
    inlineComments.set(key, { path, line, ctx, text, side: key.includes("␟o") ? "o" : "n" });
    renderCommentRow(box, key);
    updateCommentSummary();
  });
  cancel.addEventListener("click", () => { clearCommentRow(dl); if (existing) renderCommentRow(box, key); });
  actions.appendChild(save);
  actions.appendChild(cancel);
  wrap.appendChild(actions);
  dl.after(wrap);
  ta.focus();
}

// Wire a freshly-rendered diff: collapse/expand file cards, re-paint any stored
// inline comments, and make each commentable line's gutter open the editor.
export function wireDiff(box, taskId) {
  resetInlineComments(taskId);
  box.querySelectorAll(".diff-file-head").forEach((head) => {
    head.addEventListener("click", () => {
      const card = head.parentElement;
      const collapsed = card.classList.toggle("collapsed");
      // Persist the toggle so the file stays (un)collapsed across the next SSE re-render.
      const fkey = card.dataset.fileKey;
      if (fkey) { if (collapsed) collapsedDiffFiles.add(fkey); else collapsedDiffFiles.delete(fkey); }
    });
  });
  // Re-apply any persisted collapse state to this freshly-rendered diff.
  box.querySelectorAll(".diff-file[data-file-key]").forEach((card) => {
    if (collapsedDiffFiles.has(card.dataset.fileKey)) card.classList.add("collapsed");
  });
  box.querySelectorAll(".dl[data-key] .dl-num").forEach((num) => {
    num.addEventListener("click", () => openCommentEditor(box, num.closest(".dl")));
  });
  for (const key of inlineComments.keys()) renderCommentRow(box, key);
  updateCommentSummary();
  // Re-open an inline-comment editor that was mid-edit when an SSE re-render fired
  // (captured by captureUiState before render; the diff is fetched async so this is
  // the first point its line rows exist). No-op if the line is gone from this diff.
  if (pendingInlineRestore) {
    const { key, value, selStart, selEnd } = pendingInlineRestore;
    pendingInlineRestore = null;
    const dl = dlByKey(box, key);
    if (dl) {
      openCommentEditor(box, dl); // creates+focuses the .dlc-input editor row after dl
      const ta = dl.nextElementSibling && dl.nextElementSibling.querySelector
        ? dl.nextElementSibling.querySelector(".dlc-input") : null;
      if (ta) {
        ta.value = value || "";
        try { if (typeof selStart === "number") ta.setSelectionRange(selStart, selEnd); } catch (e) { /* ignore */ }
        ta.focus();
      }
    }
  }
}
