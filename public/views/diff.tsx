// The DIFF READER — the unified-diff view on a task's review surface: dependency-free syntax
// highlighting, per-file collapse, and the inline review-comment editor.
//
// LAUNCHPAD HAS NOTHING FOR THIS (RFC §7.2: "Diff reader — CUSTOM"). `Code` styles an inline span
// and that is all. So this is butchr's markup on butchr's CSS, and the only thing the migration
// changed is that it is now declarative — which deletes four separate pieces of machinery:
//
//   • PAINT-AND-WIRE IS GONE. `renderDiff()` built a DocumentFragment that registered no
//     listeners, and `wireDiff()` then queried the LIVE box afterwards, because "a DocumentFragment's
//     children are unreachable through box.querySelectorAll until [attached]". There is one pass now.
//
//   • `pendingInlineRestore` IS GONE. It was an ASYNC HANDOFF cell: `restoreUiState()` wrote an
//     open, uncommitted comment editor into it right after the SSE re-render, and `wireDiff()` read
//     it back once the async diff re-fetch had painted line rows to restore into. The producer and
//     the consumer were "separated by a network round-trip and cannot share a call frame."
//     React never unmounts the editor, so there is nothing to restore. (RFC §1.4.)
//
//   • `#inline-comment-summary` IS GONE. `updateCommentSummary()` reached out of this module with
//     `document.getElementById` to repaint a node views/task.js owned, annotated on both sides as a
//     ⚠ CROSS-MODULE ID. The comments are a prop now, so the count is just a render in task.tsx.
//
//   • THE MODULE-SCOPED `export let inlineComments` / `collapsedDiffFiles` ARE GONE. They were
//     module state so they would "survive the full re-render the app does on every SSE event", and
//     `resetInlineComments(taskId)` rebound them when a different task's diff opened. Nothing
//     re-renders wholesale now; `comments` is lifted to views/task.tsx (which needs it for
//     `composeReviewNote` anyway) and the collapse set is component state keyed on the task.
//
// ESCAPING MATTERS MORE HERE THAN ANYWHERE ELSE — a diff body is arbitrary source text, angle
// brackets and all. Every token below is a JSX string child, so it goes to the DOM as itself.
import { Button } from "@launchpad-ui/components";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { DiffFile, DiffLine, InlineComment, Lang, LineAnchor } from "./diff-logic.ts";
import { highlightCode, langForPath, lineKey, parseDiff } from "./diff-logic.ts";

/**
 * One line's code, syntax-highlighted.
 *
 * An unclassified run renders as a BARE TEXT NODE, not a wrapper span — `<Fragment key>` is how you
 * key a string child. That is not cosmetic: `.dl` is `white-space: pre`, the old builder emitted one
 * text node per segment, and test/diff-highlight.test.ts asserts the node shape. A `<span>` around
 * every plain run would double the node count of a thousand-line diff for nothing.
 */
function Code({ text, lang }: { text: string; lang: Lang }) {
  return (
    <>
      {highlightCode(text, lang).map((t, i) =>
        t.cls === null ? (
          // eslint-disable-next-line react/no-array-index-key -- tokens have no identity
          <Fragment key={i}>{t.raw}</Fragment>
        ) : (
          // eslint-disable-next-line react/no-array-index-key
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
  const anchor = lineKey(path, l)!;
  const sign = l.t === "add" ? "+" : l.t === "del" ? "−" : " ";
  const text = l.t === "add" || l.t === "del" ? l.text.slice(1) : l.text;

  return (
    <>
      <div className={`dl ${l.t}`} data-key={anchor.key} data-ctx={anchor.ctx}>
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
  ...lineProps
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
  const { comments, editingKey, onOpenEditor, onCloseEditor, onSave, onDelete } = lineProps;

  return (
    <div className={"diff-file" + (collapsed ? " collapsed" : "")} data-file-key={name}>
      {/* The file card's caret is a static glyph rotated by CSS (`.diff-file.collapsed .caret`),
          which is why it deliberately does NOT use the shared `Collapsible`/`Disclosure`: routing
          it through there would swap the whole class contract for the same behaviour. */}
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
                // eslint-disable-next-line react/no-array-index-key -- a hunk line has no id
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
 * CONTROLLED on `comments`. views/task.tsx owns them because it is the thing that sends them
 * (`composeReviewNote`) and the thing that counts them ("N inline comments will be included").
 * `taskId` is here only to reset the per-file collapse state when a different task's diff opens —
 * the exact job `resetInlineComments(taskId)` used to do for both maps at once.
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

  // A thousand-line diff re-parses on every keystroke in the review note otherwise — the parent
  // re-renders on each one, and `diff` is a prop.
  const files = useMemo(() => (diff && diff.trim() ? parseDiff(diff) : []), [diff]);

  if (!files.length) return <div className="meta">(no changes)</div>;

  const totAdd = files.reduce((a, f) => a + f.add, 0);
  const totDel = files.reduce((a, f) => a + f.del, 0);

  // The anchor carries `path`, `lineNo` and `side` already — reconstructing them by slicing the
  // key back apart (as the vanilla version did off `dl.dataset.ctx`) is a decode of something we
  // never had to encode.
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
