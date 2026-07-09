// The DOM-FREE half of the diff view — the unified-diff parser, the inline review-comment store,
// and the note composer that folds that store into a change-request. Split out of views/diff.js by
// the RFC Phase 2 horizontal cut (RFC §0.1 #5).
//
// A CORRECTION TO THE RFC. §0.1 #5 and §1.1 row 17 call `composeReviewNote` "pure". It is not: it
// reads the module-scoped `inlineComments` map. It IS DOM-free, which is the property the split
// actually turns on, so the map, its taskId guard, the collapse set, and `resetInlineComments`
// (the only writer that REBINDS them) come across with it.
//
// >>> PHASE 4a KEEPS THAT SHAPE ON PURPOSE. <<< The abandoned Phase-4 branch made
// `composeReviewNote(freeform, comments)` take the map as a parameter — finally pure — and deleted
// the `export let` store outright. That is the right end state and it belongs to the phase that
// rewrites the CALL SITE. views/diff.js and views/task.js are still vanilla and still read these
// bindings and call the one-argument form; changing the signature here would break them, and this
// slice is "types, no logic." The map becomes a parameter when views/task.tsx lands.
//
// `parseDiff` was module-private in views/diff.js; §1.1 row 17 notes it is pure. It is exported here
// so views/diff.js can call it. Nothing else imports it.
//
// The DOM half of this state — reading and writing individual entries — stays in views/diff.js and
// mutates these bindings through their own methods (`.set` / `.delete` / `.add` / `.has`). Only the
// REBINDS in resetInlineComments live here, and the ES live binding propagates the fresh Map/Set to
// views/diff.js, exactly as core/state-meta.ts's applyStateMeta does for its tables.
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

// ---------- inline review comments ----------

/** One per-line review comment, keyed by a stable `path␟side+line` that survives a diff re-fetch. */
export type InlineComment = { path: string; line: number; side: "o" | "n"; ctx: string; text: string };

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
export function composeReviewNote(freeform: string | null | undefined): string {
  const parts: string[] = [];
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
