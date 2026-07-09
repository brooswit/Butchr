// The DOM-FREE half of the diff view — the unified-diff parser, the syntax tokenizer, and the note
// composer that folds the reviewer's inline comments into a change-request.
//
// TWO THINGS CHANGED IN PHASE 4, AND BOTH ARE WHAT THE RFC ASKED FOR.
//
// 1. THE TOKENIZER IS UNFUSED. `highlightJs` / `highlightCss` / `highlightCode` lived in
//    views/diff.js because `tok(cls, raw)` called `el()` — the scanners emitted DOM. RFC §1.1
//    row 17: "the tokenizer must be refactored to return token records (`{cls, raw}[]`), which JSX
//    then maps. That refactor is worth doing on its own merits — it makes the highlighter
//    unit-testable without a DOM." It is, and it is (test/diff-highlight.test.ts).
//
//    The `lineBuilder` that existed to coalesce unclassified characters into ONE text node instead
//    of one node per character is gone with it: a run of plain text is now literally a token with
//    `cls: null`, and the coalescing is `run += c`. Same granularity, no DOM.
//
// 2. `composeReviewNote` TAKES THE COMMENTS. views/diff-logic.js's own header carried a correction
//    to the RFC — "§0.1 #5 and §1.1 row 17 call `composeReviewNote` 'pure'. It is not: it reads the
//    module-scoped `inlineComments` map" — and explained that it could not be fixed in Phase 2
//    because "a signature change to pass the comments in would have rewritten its call site in
//    views/task.js, and this phase is 'moves, no logic.'" Phase 4 rewrites that call site anyway.
//    So the map is a parameter, the function is finally pure, and the `export let` module store it
//    read (rebound by `resetInlineComments`) is DELETED — React state in views/task.tsx replaces it,
//    which is also what removes the `#inline-comment-summary` getElementById reach-across.

// ---------- parse ----------

/** One rendered row of a diff. `hunk`/`meta` rows are not commentable and carry no line numbers. */
export type DiffLine =
  | { t: "hunk" | "meta"; text: string }
  | { t: "add"; text: string; newNo: number }
  | { t: "del"; text: string; oldNo: number }
  | { t: "ctx"; text: string; oldNo: number; newNo: number };

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
// Each non-meta line also carries the source line numbers it maps to (oldNo on the pre-image side,
// newNo on the post-image side), tracked from the hunk `@@` headers — these drive the line-number
// gutter and the file:line context attached to inline review comments. The
// "\ No newline at end of file" marker is a `meta` line with no numbers (not commentable).
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  const start = (header: string) => {
    cur = { header, path: "", oldPath: "", add: 0, del: 0, binary: false, lines: [] };
    files.push(cur);
    oldNo = 0;
    newNo = 0;
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

// Pick a highlight language from the file path. JSON rides the JS scanner (its strings/numbers/
// true/false/null all tokenize correctly there). Returns null for types we don't tokenize, so the
// text falls back to one plain token.
export type Lang = "js" | "css" | null;
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
 *  thousands of lines; the old DOM version had the identical optimisation, for the identical reason
 *  (one node per SEGMENT, not per char). */
class TokenRun {
  private out: Token[] = [];
  private run = "";
  text(s: string): void { this.run += s; }
  tok(cls: Exclude<Token["cls"], null>, raw: string): void {
    this.flush();
    this.out.push({ cls, raw });
  }
  done(): Token[] {
    this.flush();
    return this.out;
  }
  private flush(): void {
    if (this.run) { this.out.push({ cls: null, raw: this.run }); this.run = ""; }
  }
}

// Scan a quoted string starting at i (text[i] is the quote). Returns the end index (one past the
// closing quote, or end-of-line if unterminated). Honors backslash escapes so an escaped quote
// doesn't close the string early.
function scanString(text: string, i: number): number {
  const q = text[i];
  const n = text.length;
  let j = i + 1;
  while (j < n && text[j] !== q) { if (text[j] === "\\") j++; j++; }
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
 * Highlight one line of code into token records. An unknown language and any scanner failure fall
 * back to ONE unclassified token — which is precisely where `esc()` stopped being needed: JSX
 * renders a string child as a text node, so a `<` or `&` in the source lands in the DOM as itself
 * and can never be re-parsed as markup.
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

/**
 * Compose the freeform note + any inline comments into one change-request note. Inline comments are
 * listed in file/line order under a header so the agent reads them as a structured punch-list.
 * Returns "" when there's nothing to send.
 *
 * PURE, at last. It took the comments off a module-scoped `Map` through Phase 3; they are a
 * parameter now, which is what lets it be tested without constructing the diff view at all.
 */
export function composeReviewNote(freeform: string, comments: ReadonlyMap<string, InlineComment>): string {
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

/** Everything a comment needs to know about the line it hangs off. */
export type LineAnchor = { key: string; ctx: string; path: string; lineNo: number; side: "o" | "n" };

/** The comment anchor for a rendered line: deletions reference the pre-image line, everything else
 *  the post-image line. The key (path + side + line) is stable across diff re-fetches, so stored
 *  inline comments re-attach after a refresh. Null for the two non-commentable row kinds. */
export function lineKey(path: string, l: DiffLine): LineAnchor | null {
  if (l.t === "hunk" || l.t === "meta") return null;
  const lineNo = l.t === "del" ? l.oldNo : l.newNo;
  const side = l.t === "del" ? "o" : "n";
  return { key: `${path}␟${side}${lineNo}`, ctx: `${path}:${lineNo}`, path, lineNo, side };
}
