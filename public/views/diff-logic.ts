// The DOM-FREE half of the diff view — the unified-diff parser, the syntax tokenizer, the line
// anchor, the inline review-comment store, and the note composer that folds that store into a
// change-request. Split out of views/diff.js by the RFC Phase 2 horizontal cut (RFC §0.1 #5).
//
// A CORRECTION TO THE RFC. §0.1 #5 and §1.1 row 17 call `composeReviewNote` "pure". It is not: it
// reads the module-scoped `inlineComments` map. It IS DOM-free, which is the property the split
// actually turns on, so the map, its taskId guard, the collapse set, and `resetInlineComments`
// (the only writer that REBINDS them) come across with it.
//
// >>> PHASE 4b STILL KEEPS THAT SHAPE, AND THE REASON HAS NOT CHANGED. <<< The right end state is
// `composeReviewNote(freeform, comments)` — a parameter, finally pure — with the `export let` store
// deleted. That belongs to the phase that rewrites the CALL SITE, and the call site is
// views/task.js, which is still vanilla and out of this slice. It flips when views/task.tsx lands.
//
// WHAT PHASE 4b DID ADD: the tokenizer, unfused (RFC §1.1 row 17). `highlightJs` / `highlightCss` /
// `highlightCode` used to live in views/diff.js because `tok(cls, raw)` called `el()` — the scanners
// emitted DOM. They now return TOKEN RECORDS (`{cls, raw}[]`), which the caller maps to whatever it
// builds: views/diff.js maps them to text nodes and spans, views/diff.tsx maps them to JSX. There is
// exactly ONE highlighter, it is unit-testable without a DOM, and both renderers agree by
// construction. `lineKey` moved here for the same reason — the anchor a comment hangs off is data,
// and both renderers had to compute it identically.
//
// The `lineBuilder` that coalesced unclassified characters into ONE text node instead of one node
// per character is gone with them: a run of plain text is now a token with `cls: null`, and the
// coalescing is `run += c`. Same segment granularity, no DOM.
//
// The DOM half of the comment state — reading and writing individual entries — stays in
// views/diff.js and mutates these bindings through their own methods (`.set` / `.delete` / `.add` /
// `.has`). Only the REBINDS in resetInlineComments live here, and the ES live binding propagates the
// fresh Map/Set to views/diff.js, exactly as core/state-meta.ts's applyStateMeta does for its tables.
//
// `pendingInlineRestore` deliberately did NOT move: views/diff.js's wireDiff() both reads and
// clears it, and an imported binding cannot be assigned across a module boundary, so moving it
// would have meant inventing an accessor — new logic, not a move.

/** One rendered row of a diff. `hunk`/`meta` rows are not commentable and carry no line numbers. */
export type DiffLine =
  | { t: "hunk" | "meta"; text: string }
  | { t: "add"; text: string; newNo: number }
  | { t: "del"; text: string; oldNo: number }
  | { t: "ctx"; text: string; oldNo: number; newNo: number };

/** One file's worth of parsed diff. `path` falls back to the `+++ b/…` line when `diff --git` is absent. */
export type DiffFile = {
  header: string;
  path: string;
  oldPath: string;
  add: number;
  del: number;
  binary: boolean;
  lines: DiffLine[];
};

// Parse a unified diff into per-file groups for a readable, GitHub-style view.
// Each non-meta line also carries the source line numbers it maps to (oldNo on the
// pre-image side, newNo on the post-image side), tracked from the hunk `@@` headers
// — these drive the line-number gutter and the file:line context attached to inline
// review comments. The "\ No newline at end of file" marker is a `meta` line with no
// numbers (not commentable).
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  // `start()` always assigns, and every `cur!` below is guarded by the `if (!cur) start(line)`
  // fallthrough above it — but tsc cannot see through the closure, hence the assertions.
  let cur: DiffFile | null = null;
  let oldNo = 0, newNo = 0;
  const start = (header: string) => {
    cur = { header, path: "", oldPath: "", add: 0, del: 0, binary: false, lines: [] };
    files.push(cur);
    oldNo = 0; newNo = 0;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      const m = line.match(/ b\/(.+)$/);
      start(line);
      if (m) cur!.path = m[1];
      continue;
    }
    if (!cur) start(line); // diff without a "diff --git" preamble
    if (line.startsWith("--- ")) { cur!.oldPath = line.slice(4).replace(/^a\//, ""); continue; }
    if (line.startsWith("+++ ")) { cur!.path = line.slice(4).replace(/^b\//, "") || cur!.path; continue; }
    if (line.startsWith("index ") || line.startsWith("new file") ||
        line.startsWith("deleted file") || line.startsWith("old mode") ||
        line.startsWith("new mode") || line.startsWith("similarity") ||
        line.startsWith("rename ")) continue;
    if (line.startsWith("Binary files")) { cur!.binary = true; continue; }
    if (line.startsWith("@@")) {
      // @@ -<oldStart>[,<oldLen>] +<newStart>[,<newLen>] @@ — reset both counters.
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldNo = +m[1]; newNo = +m[2]; }
      cur!.lines.push({ t: "hunk", text: line });
      continue;
    }
    if (line.startsWith("+")) { cur!.add++; cur!.lines.push({ t: "add", text: line, newNo }); newNo++; continue; }
    if (line.startsWith("-")) { cur!.del++; cur!.lines.push({ t: "del", text: line, oldNo }); oldNo++; continue; }
    if (line.startsWith("\\")) { cur!.lines.push({ t: "meta", text: line }); continue; } // "No newline…"
    if (line.length) { cur!.lines.push({ t: "ctx", text: line, oldNo, newNo }); oldNo++; newNo++; }
  }
  return files;
}

// ---------- dependency-free syntax highlighting ----------
//
// A tiny per-line tokenizer. No external lib: scan the line char-by-char and classify keywords /
// strings / comments / numbers. It is intentionally line-local — a `/* */` block comment spanning
// diff lines only colours the portion on each line — which is good enough for review-time reading
// and keeps the scanner stateless across the interleaved add/del/ctx lines of a hunk.

/** `cls: null` is an unclassified run of source text. Everything else names a `.tok-*` class. */
export type Token = { cls: "k" | "s" | "c" | "n" | null; raw: string };

/** The languages the scanners understand. `null` means "render as one plain token". */
export type Lang = "js" | "css" | null;

// Pick a highlight language from the file path. JSON rides the JS scanner (its strings/numbers/
// true/false/null all tokenize correctly there). Returns null for types we don't tokenize.
export function langForPath(path: string | null | undefined): Lang {
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

/** Accumulates unclassified characters into ONE token rather than one per character. A diff runs to
 *  thousands of lines; the DOM version this replaces had the identical optimisation, for the
 *  identical reason (one node per SEGMENT, never one per char). */
class TokenRun {
  private out: Token[] = [];
  private run = "";
  text(s: string): void {
    this.run += s;
  }
  tok(cls: Exclude<Token["cls"], null>, raw: string): void {
    this.flush();
    this.out.push({ cls, raw });
  }
  done(): Token[] {
    this.flush();
    return this.out;
  }
  private flush(): void {
    if (this.run) {
      this.out.push({ cls: null, raw: this.run });
      this.run = "";
    }
  }
}

// Scan a quoted string starting at i (text[i] is the quote). Returns the end index (one past the
// closing quote, or end-of-line if unterminated). Honors backslash escapes so an escaped quote
// doesn't close the string early.
function scanString(text: string, i: number): number {
  const q = text[i];
  const n = text.length;
  let j = i + 1;
  while (j < n && text[j] !== q) {
    if (text[j] === "\\") j++;
    j++;
  }
  return Math.min(j + 1, n);
}

function highlightJs(text: string): Token[] {
  const out = new TokenRun();
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

function highlightCss(text: string): Token[] {
  const out = new TokenRun();
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
    if (c === "#") { // hex colour (#fff / #ffffff / #ffffffff)
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

/**
 * Highlight one line of code into token records. An empty line is ZERO tokens; an unknown language
 * and any scanner failure fall back to ONE unclassified token.
 *
 * This is precisely where `esc()` stopped being needed, and the property survives the refactor
 * because a token carries RAW text and never markup: views/diff.js hands `raw` to createTextNode,
 * views/diff.tsx hands it to JSX as a string child. Either way a `<` or `&` in the source lands in
 * the DOM as itself and can never be re-parsed as markup.
 */
export function highlightCode(text: string, lang: Lang): Token[] {
  if (!text) return [];
  try {
    if (lang === "js") return highlightJs(text);
    if (lang === "css") return highlightCss(text);
  } catch {
    /* fall through to plain text */
  }
  return [{ cls: null, raw: text }];
}

// ---------- inline review comments ----------

/** One per-line review comment, keyed by a stable `path␟side+line` that survives a diff re-fetch. */
export type InlineComment = { path: string; line: number; side: "o" | "n"; ctx: string; text: string };

/** Everything a comment needs to know about the line it hangs off. */
export type LineAnchor = { key: string; ctx: string; path: string; lineNo: number; side: "o" | "n" };

/** The comment anchor for a rendered line: deletions reference the pre-image line, everything else
 *  the post-image line. The key (path + side + line) is stable across diff re-fetches, so stored
 *  inline comments re-attach after an SSE re-render. Null for the two non-commentable row kinds.
 *
 *  The anchor carries `path`, `lineNo` and `side` as FIELDS. views/diff.js's editor used to recover
 *  them by slicing `data-ctx` back apart on save — a decode of something it never had to encode. */
export function lineKey(path: string, l: DiffLine): LineAnchor | null {
  // Positive discrimination, one arm per commentable kind. The negative form
  // (`if (l.t === "hunk" || l.t === "meta") return null`) does NOT narrow: `hunk`/`meta` share one
  // union member whose `t` is itself a union, and excluding one literal leaves the member in play.
  const anchor = (lineNo: number, side: "o" | "n"): LineAnchor => ({
    key: `${path}␟${side}${lineNo}`,
    ctx: `${path}:${lineNo}`,
    path,
    lineNo,
    side,
  });
  if (l.t === "del") return anchor(l.oldNo, "o"); // deletions reference the PRE-image line
  if (l.t === "add") return anchor(l.newNo, "n");
  if (l.t === "ctx") return anchor(l.newNo, "n");
  return null;
}

// Per-line review comments the reviewer attaches by clicking a diff line's gutter.
// Kept at module scope (keyed by a stable path+side+line key) so they survive the
// full re-render the app does on every SSE event AND the async diff re-fetch — the
// diff is re-rendered with the same keys, and wireDiff re-paints the stored comments
// onto it. Reset when a different task's diff is opened. On "Request change" they are
// composed (with their file:line context) into the single change-request note sent
// to /reject, so the resumed agent gets specific per-line feedback in its rework
// prompt — no change to the reject payload shape (see composeReviewNote).
export let inlineComments = new Map<string, InlineComment>();
let inlineCommentsTaskId: string | null = null;
// Diff-file collapse state — module-persisted (keyed by file path) so a collapsed
// file stays collapsed across the full re-render the app does on every SSE event,
// mirroring inlineComments above. Reset alongside inlineComments when a different
// task's diff is opened, so a new task doesn't inherit the prior task's collapse set.
export let collapsedDiffFiles = new Set<string>();

export function resetInlineComments(taskId: string): void {
  if (inlineCommentsTaskId !== taskId) {
    inlineComments = new Map();
    collapsedDiffFiles = new Set();
    inlineCommentsTaskId = taskId;
  }
}

// Compose the freeform note + any inline comments into one change-request note.
// Inline comments are listed in file/line order under a header so the agent reads
// them as a structured punch-list. Returns "" when there's nothing to send.
//
// >>> `comments` IS A PARAMETER NOW — THE FUNCTION IS FINALLY PURE. <<< The header above promised
// this for "the phase that rewrites the CALL SITE", and Phase 4d is it: views/task.tsx owns the
// comment map (it is the thing that sends it AND the thing that counts it) and passes it in.
//
// The DEFAULT keeps the module store, and that is not hedging — `views/task.js` still calls this
// with one argument and still ships, until Phase 4e deletes it along with `inlineComments`,
// `collapsedDiffFiles` and `resetInlineComments`. A default argument reads the LIVE binding at call
// time, so `resetInlineComments`'s rebind still propagates. Delete the default with the store.
export function composeReviewNote(
  freeform: string | null | undefined,
  comments: ReadonlyMap<string, InlineComment> = inlineComments,
): string {
  const parts: string[] = [];
  const ff = (freeform || "").trim();
  if (ff) parts.push(ff);
  if (comments.size) {
    const sorted = [...comments.values()].sort((a, b) =>
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
