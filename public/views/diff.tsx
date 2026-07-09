// The DIFF READER, in React — the unified-diff view on a task's review surface: dependency-free
// syntax highlighting, per-file collapse, and the inline review-comment editor.
//
// >>> IT IS NOT MOUNTED YET, AND THAT IS A FACT ABOUT THE APP, NOT AN OVERSIGHT. <<<
// The Phase 4b brief says to "point the `#/metrics` and diff routes at real React elements".
// THERE IS NO DIFF ROUTE. `grep -n 'renderDiff' public/` returns exactly one caller: `renderTask` in
// views/task.js, which builds a `.diffview` box inside the task detail page and fills it from
// `GET /work/:id/diff`. The diff reader is a COMPONENT of the task view, not a route of its own, so
// nothing in App.tsx can point at it. Its consumer is `views/task.tsx`, which Phase 4c/4d owns.
//
// So this file is the component 4c drops into that page, typechecked (tsconfig.public.json's
// `include: ["public"]` reads every file, reachable from an entry or not) and covered by
// test/diff-view.test.ts against a real DOM. The vanilla views/diff.js keeps shipping until then,
// and the two share ONE tokenizer and ONE line-anchor (views/diff-logic.ts) so they cannot drift.
// Standing up a React root inside the vanilla task page to render this today was considered and
// REJECTED: renderTask rebuilds its diff box on every SSE event, so the root would be torn down
// mid-edit, and the `pendingInlineRestore` async-handoff cell this design deletes would have had to
// be kept alive to paper over it. That is a regression bought with throwaway glue.
//
// LAUNCHPAD HAS NOTHING FOR THIS (RFC §7.2: "Diff reader — CUSTOM"). `Code` styles an inline span
// and that is all. So this is butchr's markup on butchr's CSS, and the only thing the migration
// changes is that it is declarative — which deletes four separate pieces of machinery:
//
//   • PAINT-AND-WIRE IS GONE. `renderDiff()` built a DocumentFragment that registered no listeners,
//     and `wireDiff()` then queried the LIVE box afterwards, because "a DocumentFragment's children
//     are unreachable through box.querySelectorAll until [attached]". There is one pass now.
//
//   • `pendingInlineRestore` IS GONE. It was an ASYNC HANDOFF cell: `restoreUiState()` wrote an
//     open, uncommitted comment editor into it right after the SSE re-render, and `wireDiff()` read
//     it back once the async diff re-fetch had painted line rows to restore into. The producer and
//     the consumer were "separated by a network round-trip and cannot share a call frame."
//     React never unmounts the editor, so there is nothing to restore (RFC §1.4).
//
//   • `#inline-comment-summary` IS GONE. `updateCommentSummary()` reached out of the module with
//     `document.getElementById` to repaint a node views/task.js owns, annotated on both sides as a
//     ⚠ CROSS-MODULE ID. The comments are a prop now, so the count is just a render in task.tsx.
//
//   • THE MODULE-SCOPED `export let inlineComments` / `collapsedDiffFiles` ARE GONE. They were
//     module state so they would "survive the full re-render the app does on every SSE event", and
//     `resetInlineComments(taskId)` rebound them when a different task's diff opened. Nothing
//     re-renders wholesale here; `comments` is lifted to the caller (which needs it for
//     `composeReviewNote` anyway) and the collapse set is component state keyed on the task.
//     views/diff-logic.ts still exports the old store for the vanilla pair; 4c deletes it.
//
// ESCAPING MATTERS MORE HERE THAN ANYWHERE ELSE — a diff body is arbitrary source text, angle
// brackets and all. Every token below is a JSX string child, so it goes to the DOM as itself.
import { Button } from "@launchpad-ui/components";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { DiffFile, DiffLine, InlineComment, Lang, LineAnchor } from "./diff-logic.js";
import { highlightCode, langForPath, lineKey, parseDiff } from "./diff-logic.js";

/**
 * One line's code, syntax-highlighted.
 *
 * An unclassified run renders as a BARE TEXT NODE, not a wrapper span — `<Fragment key>` is how you
 * key a string child. That is not cosmetic: `.dl` is `white-space: pre`, the tokenizer coalesces
 * unclassified characters into one record per segment, and a `<span>` around every plain run would
 * double the node count of a thousand-line diff for nothing.
 */
function Code({ text, lang }: { text: string; lang: Lang }) {
  return (
    <>
      {highlightCode(text, lang).map((t, i) =>
        t.cls === null ? (
          <Fragment key={i}>{t.raw}</Fragment>
        ) : (
          <span className={"tok-" + t.cls} key={i}>
            {t.raw}
          </span>
        ),
      )}
    </>
  );
}

/** The inline comment editor under a diff line. Prefilled with any existing comment; saving empty
 *  deletes it; Cancel reverts to the saved display row. */
function CommentEditor({
  ctx,
  initial,
  onSave,
  onCancel,
}: {
  ctx: string;
  initial: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <div className="dl-comment-edit">
      <div className="dlc-ctx">{ctx}</div>
      <textarea
        className="dlc-input"
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Comment on this line — sent to the agent on Request change…"
      />
      <div className="dlc-actions">
        <Button variant="primary" size="small" onPress={() => onSave(text.trim())}>
          Save
        </Button>
        <Button variant="minimal" size="small" onPress={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The saved comment for a line, as a read-only row with edit/delete affordances. */
function CommentRow({ c, onEdit, onDelete }: { c: InlineComment; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="dl-comment">
      <div className="dlc-ctx">{c.ctx}</div>
      <div className="dlc-text">{c.text}</div>
      <div className="dlc-actions">
        <Button variant="minimal" size="small" onPress={onEdit}>
          Edit
        </Button>
        <Button variant="minimal" size="small" onPress={onDelete}>
          Delete
        </Button>
      </div>
    </div>
  );
}

function Line({
  l,
  path,
  lang,
  comment,
  editing,
  onOpenEditor,
  onCloseEditor,
  onSave,
  onDelete,
}: {
  l: DiffLine;
  path: string;
  lang: Lang;
  comment?: InlineComment;
  editing: boolean;
  onOpenEditor: (key: string) => void;
  onCloseEditor: () => void;
  onSave: (anchor: LineAnchor, text: string) => void;
  onDelete: (key: string) => void;
}) {
  // `.dl` is `white-space: pre`, so the hunk header's EMPTY sign and the meta line's single-space
  // sign are a real rendered difference. Keep both verbatim.
  if (l.t === "hunk" || l.t === "meta") {
    return (
      <div className={`dl ${l.t === "hunk" ? "hunk" : "ctx meta"}`}>
        <span className="dl-num" />
        <span className="dl-sign">{l.t === "hunk" ? "" : " "}</span>
        <span className="dl-text">{l.text}</span>
      </div>
    );
  }
  // Non-null by the guard above: lineKey() returns null only for `hunk` and `meta`.
  const anchor = lineKey(path, l)!;
  const sign = l.t === "add" ? "+" : l.t === "del" ? "−" : " ";
  const text = l.t === "add" || l.t === "del" ? l.text.slice(1) : l.text;

  return (
    <>
      <div className={`dl ${l.t}`} data-key={anchor.key} data-ctx={anchor.ctx}>
        {/* The gutter number opens the editor. It was a bare click handler on a `<span>` in the
            vanilla version; role/tabIndex/Enter+Space make the same affordance reachable from the
            keyboard, which is the one behaviour change in this file. */}
        <span
          className="dl-num"
          title={`comment on ${anchor.ctx}`}
          role="button"
          tabIndex={0}
          onClick={() => onOpenEditor(anchor.key)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOpenEditor(anchor.key);
            }
          }}
        >
          {anchor.lineNo}
        </span>
        <span className="dl-sign">{sign}</span>
        <span className="dl-text">
          <Code text={text} lang={lang} />
        </span>
      </div>
      {editing ? (
        <CommentEditor
          ctx={anchor.ctx}
          initial={comment?.text ?? ""}
          onSave={(t) => onSave(anchor, t)}
          onCancel={onCloseEditor}
        />
      ) : comment ? (
        <CommentRow c={comment} onEdit={() => onOpenEditor(anchor.key)} onDelete={() => onDelete(anchor.key)} />
      ) : null}
    </>
  );
}

function FileCard({
  f,
  collapsed,
  onToggle,
  comments,
  editingKey,
  onOpenEditor,
  onCloseEditor,
  onSave,
  onDelete,
}: {
  f: DiffFile;
  collapsed: boolean;
  onToggle: () => void;
  comments: ReadonlyMap<string, InlineComment>;
  editingKey: string | null;
  onOpenEditor: (key: string) => void;
  onCloseEditor: () => void;
  onSave: (anchor: LineAnchor, text: string) => void;
  onDelete: (key: string) => void;
}) {
  const name = f.path || f.oldPath || "(unknown)";
  const lang = langForPath(name);

  return (
    <div className={"diff-file" + (collapsed ? " collapsed" : "")} data-file-key={name}>
      {/* The caret is a static glyph rotated by CSS (`.diff-file.collapsed .caret`), which is why
          this deliberately does NOT use LaunchPad's `Disclosure`: routing it through there would
          swap the whole class contract for the same behaviour. */}
      <button className="diff-file-head" type="button" onClick={onToggle} aria-expanded={!collapsed}>
        <span className="caret">▾</span>
        <span className="fname">{name}</span>
        {/* `.fstat` is an inline span (no flex), so the literal space between the two counts IS
            rendered. It stays an explicit text node. */}
        <span className="fstat">
          <span className="add">+{f.add}</span> <span className="del">−{f.del}</span>
        </span>
      </button>
      <div className="diff-file-body">
        {f.binary ? (
          <div className="diff-binary">Binary file not shown</div>
        ) : (
          f.lines.map((l, i) => {
            const anchor = lineKey(name, l);
            return (
              <Line
                // A hunk/meta row has no identity of its own, and a line's anchor is not unique
                // either (a rename can repeat a number). Index within a file is the stable key.
                key={i}
                l={l}
                path={name}
                lang={lang}
                comment={anchor ? comments.get(anchor.key) : undefined}
                editing={!!anchor && editingKey === anchor.key}
                onOpenEditor={onOpenEditor}
                onCloseEditor={onCloseEditor}
                onSave={onSave}
                onDelete={onDelete}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

/**
 * The whole diff: a summary line plus one card per file.
 *
 * CONTROLLED on `comments`. The caller (views/task.tsx, Phase 4c) owns them because it is the thing
 * that sends them (`composeReviewNote`) and the thing that counts them ("N inline comments will be
 * included"). `taskId` is here only to reset the per-file collapse state when a different task's
 * diff opens — the exact job `resetInlineComments(taskId)` used to do for both maps at once.
 */
export function DiffView({
  diff,
  taskId,
  comments,
  onCommentsChange,
}: {
  diff: string;
  taskId: string;
  comments: ReadonlyMap<string, InlineComment>;
  onCommentsChange: (next: Map<string, InlineComment>) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editingKey, setEditingKey] = useState<string | null>(null);

  // A new task's diff must not inherit the previous task's collapse set.
  useEffect(() => {
    setCollapsed(new Set());
    setEditingKey(null);
  }, [taskId]);

  // A thousand-line diff would re-parse on every keystroke in the review note otherwise — the
  // parent re-renders on each one, and `diff` is a prop.
  const files = useMemo(() => (diff && diff.trim() ? parseDiff(diff) : []), [diff]);

  if (!files.length) return <div className="meta">(no changes)</div>;

  const totAdd = files.reduce((a, f) => a + f.add, 0);
  const totDel = files.reduce((a, f) => a + f.del, 0);

  // The anchor carries `path`, `lineNo` and `side` already — reconstructing them by slicing the key
  // back apart (as the vanilla editor did off `dl.dataset.ctx`) decodes something never encoded.
  const save = (anchor: LineAnchor, text: string) => {
    const next = new Map(comments);
    if (!text) next.delete(anchor.key); // saving empty deletes the comment
    else next.set(anchor.key, { path: anchor.path, line: anchor.lineNo, ctx: anchor.ctx, text, side: anchor.side });
    onCommentsChange(next);
    setEditingKey(null);
  };

  const remove = (key: string) => {
    const next = new Map(comments);
    next.delete(key);
    onCommentsChange(next);
    setEditingKey(null);
  };

  return (
    <>
      {/* `.diff-summary` is `display: flex` with a gap, so no separator text nodes. */}
      <div className="diff-summary">
        <span>
          {files.length} file{files.length === 1 ? "" : "s"} changed
        </span>
        <span className="add">+{totAdd}</span>
        <span className="del">−{totDel}</span>
      </div>
      {files.map((f) => {
        const name = f.path || f.oldPath || "(unknown)";
        return (
          <FileCard
            key={name}
            f={f}
            collapsed={collapsed.has(name)}
            onToggle={() =>
              setCollapsed((s) => {
                const next = new Set(s);
                if (next.has(name)) next.delete(name);
                else next.add(name);
                return next;
              })
            }
            comments={comments}
            editingKey={editingKey}
            onOpenEditor={setEditingKey}
            onCloseEditor={() => setEditingKey(null)}
            onSave={save}
            onDelete={remove}
          />
        );
      })}
    </>
  );
}
