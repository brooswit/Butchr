// The SWIMLANES view — the workspace body's "Pipeline" tab, and the one surface RFC §11 names as
// the top residual VISUAL risk of this migration. Per-story horizontal LANES: each ACTIVE story is
// a lane, its subtask leaves run left → right in blocked_by order as a pipeline of status pills
// joined by a single arrow. Membership is shown by the lane itself — no child-of edges, no
// double-drawn story node. Finished subtasks collapse behind a per-lane toggle. Cross-story
// blockers surface as a small labelled badge on the affected step.
//
// >>> IT IS BESPOKE, AND LAUNCHPAD WILL NOT CHANGE THAT. <<< RFC §7.3: "no LaunchPad analogue and
// will not get one." Its eight parts and their fates, from that table:
//
//   Lane container    → custom <section> + CSS grid          (no Card/Panel/Box exists)
//   Lane title        → laneTitle(), ported unchanged
//   Lane order        → orderLaneLeaves(), ported unchanged
//   Story lifecycle   → storyLifecycle()/swimEmphasis(), ported unchanged
//   Progress bar      → storyProgress() ported; the BAR stays bespoke — see below
//   Done-pile toggle  → Disclosure + component state        ← the one real LaunchPad win here
//   Connector arrows  → inline JSX <svg>                    ← a net deletion: core/dom.js's svg()
//   Subtask card      → custom                              (no Card)
//
// >>> WHY THE PROGRESS BAR IS *NOT* A `Meter`, THOUGH §7.3 SAYS "bar → Meter". <<<
// Read against the installed component rather than its name. `Meter variant="bar"` is a two-row CSS
// GRID (`"label value" / "bar bar"`) that always renders its own `valueText` percentage through a
// `<Text>` node, with a track of `height: var(--lp-size-10)`. The lane header's bar is a 96×6px
// INLINE sparkline sitting in a flex row that already prints "3 / 7 done" beside it. Adopting
// `Meter` here means overriding `display`, `grid-template-areas` and the track height, and hiding
// the value node — i.e. fighting the component to arrive back where we started, and shipping a
// duplicate percentage if the override ever slips. §7.1's posture governs: LaunchPad's components
// where they exist, butchr's bespoke CSS where they do not. `Meter` DOES fit the two rollup bars
// that have a label/value/track shape, and it is used there (components/panel.tsx's FractionMeter).
//
// SWIM_DONE_EXPANDED WAS MODULE STATE, "so an expanded pile survives the full re-render the app
// does on every SSE event". Nothing re-renders wholesale now, so it is ordinary component state —
// and the `pruneWorkCaches` growth bound that existed to stop that module Set from accumulating
// story ids across a long session no longer has anything to prune here. It still prunes the
// activity cache (views/workspace.tsx), which really is long-lived.
import { Disclosure, DisclosurePanel, Heading, Button as LpButton } from "@launchpad-ui/components";
import { Icon } from "@launchpad-ui/icons";
import { Fragment, useState } from "react";
import { Link } from "react-router";
import { KindBadge } from "../components/chips.tsx";
import { effStatus } from "../components/chips-logic.ts";
import type { WorkItem } from "../core/types.ts";
import { graphChildOf, isHistoryItem, storyMemberIds, storySubtaskTotal } from "../core/work-graph.ts";
import { laneTitle, orderLaneLeaves, storyLifecycle, storyProgress, swimEmphasis } from "./swimlanes-logic.ts";

/** The lifecycle CHIP for a story's lane header — null when there is no lifecycle to show. Subtle
 *  by design (see `.chip.lc-*`): it must not compete with the coloured status chip or the kind
 *  badge beside it. */
export function StoryLifecycleChip({ story }: { story: WorkItem }) {
  const lc = storyLifecycle(story);
  if (!lc) return null;
  return (
    <span className={"chip lc-" + lc.cls} title={"story lifecycle — " + lc.key}>
      {lc.glyph} {lc.key}
    </span>
  );
}

/** A single arrow connector between two pipeline steps — the ONE edge vocabulary (blocked_by flow).
 *  React renders SVG natively, so `core/dom.js`'s `svg()` namespace helper dies here (RFC §0.1 #6). */
function SwimConn() {
  return (
    <div className="swim-conn" aria-hidden="true">
      <svg className="swim-conn-svg" viewBox="0 0 26 14">
        <path d="M0 7h20m0 0l-5-4m5 4l-5 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </div>
  );
}

/**
 * One pipeline STEP: a status-coloured, clickable card for a subtask leaf. A real `<Link>`, so it
 * is keyboard-focusable with a visible focus ring from CSS. The status pill reuses `.chip.<status>`;
 * a live `in_progress` agent gets the lone pulsing dot. A blocker living in ANOTHER lane (not among
 * this story's members) surfaces as a small "⤴ blocked by …" badge, so the rare cross-story
 * dependency is never silently dropped.
 */
function SwimStep({ leaf, memberSet, byId }: { leaf: WorkItem; memberSet: Set<string>; byId: Map<string, WorkItem> }) {
  const st = effStatus(leaf);
  const emph = swimEmphasis(st);
  const foreign = (leaf.blocked_by || []).filter((b) => !memberSet.has(b) && byId.has(b));

  return (
    <Link className={"swim-step is-" + emph} to={`/task/${leaf.id}`} aria-label={`subtask ${leaf.id} — ${st}`}>
      <div className="swim-step-top">
        <span className={"chip " + st}>
          {st === "in_progress" ? <span className="swim-dot" aria-hidden="true" /> : null}
          {st}
        </span>
        {emph === "attn" ? <span className="swim-needs">needs you</span> : null}
      </div>
      <span className="swim-sid">{leaf.id}</span>
      {/* A LEAF's description lives in `summary` (its `brief` is always null); it is null until the
          agent writes one, so a not-yet-run subtask is honestly id-only. */}
      {leaf.summary && leaf.summary !== leaf.id ? <span className="swim-sum">{leaf.summary}</span> : null}
      {foreign.length ? (
        <span className="swim-xdep" title="blocked by work in another lane">
          ⤴ blocked by {foreign.join(", ")}
        </span>
      ) : null}
    </Link>
  );
}

/** A pipeline of ordered steps, arrows between. */
function SwimPipe({
  ids,
  byId,
  memberSet,
  className = "",
}: {
  ids: string[];
  byId: Map<string, WorkItem>;
  memberSet: Set<string>;
  className?: string;
}) {
  return (
    <div className={("swim-pipe " + className).trim()}>
      {orderLaneLeaves(ids, byId).map((id, i) => (
        <Fragment key={id}>
          {i > 0 ? <SwimConn /> : null}
          <SwimStep leaf={byId.get(id)!} memberSet={memberSet} byId={byId} />
        </Fragment>
      ))}
    </div>
  );
}

/** Collapsed "N done" footer row for a lane; expands in place to reveal the finished subtasks as a
 *  second, dimmed pipeline. `Disclosure` supplies the `aria-expanded` wiring and the Enter/Space
 *  contract the hand-rolled `div[role=button][tabindex=0]` had to spell out by hand. */
function SwimDoneRow({ done, byId, memberSet }: { done: string[]; byId: Map<string, WorkItem>; memberSet: Set<string> }) {
  const [open, setOpen] = useState(false);
  return (
    <Disclosure className="swim-done" isExpanded={open} onExpandedChange={setOpen}>
      <Heading level={4} className="collapsible-heading">
        <LpButton slot="trigger" variant="minimal" className="swim-done-row">
          <Icon name={open ? "chevron-down" : "chevron-right"} size="small" className="swim-done-caret" />
          {` ${done.length} done`}
        </LpButton>
      </Heading>
      <DisclosurePanel>
        <SwimPipe ids={done} byId={byId} memberSet={memberSet} className="swim-done-pipe" />
      </DisclosurePanel>
    </Disclosure>
  );
}

/** One story LANE: a header (kind badge · title · id · status + lifecycle chips · progress) over a
 *  horizontally-scrollable pipeline of its ACTIVE subtasks. A childless / all-finished story shows a
 *  compact parked empty-row INSIDE the lane, never a bare box. */
function SwimLane({ story, byId, allIds }: { story: WorkItem; byId: Map<string, WorkItem>; allIds: Set<string> }) {
  const st = effStatus(story);
  const p = storyProgress(story.counts);
  const title = laneTitle(story.brief, story.id);

  const members = storyMemberIds(story.id, allIds, byId);
  const memberSet = new Set(members);
  const active = members.filter((id) => !isHistoryItem(byId.get(id)));
  const done = members.filter((id) => isHistoryItem(byId.get(id)));

  const hasLifecycle = !!storyLifecycle(story);

  return (
    <div className="swim-lane">
      <div className="swim-hd">
        <span className="swim-kind">
          <KindBadge kind="node" />
        </span>
        {/* Compact one-line title (clamped) for display; the FULL brief goes in the tooltip. */}
        <span className="swim-title" title={story.brief || story.id}>
          {title}
        </span>
        <span className="swim-laneid">{story.id}</span>
        <div className="swim-meta">
          <span className={"chip " + st}>{st}</span>
          {/* The lifecycle chip's leading SPACE is a real text node — the rendered gap after the
              status chip. It belongs to this call site, not to the chip. */}
          {hasLifecycle ? (
            <>
              {" "}
              <StoryLifecycleChip story={story} />
            </>
          ) : null}
          <div className="swim-prog">
            {p.total ? (
              <>
                <span className="swim-track">
                  <i style={{ width: `${Math.round((100 * p.done) / p.total)}%` }} />
                </span>
                <span className="swim-prog-txt">
                  {p.done} / {p.total} done
                </span>
              </>
            ) : (
              <span className="swim-prog-txt">not started</span>
            )}
          </div>
        </div>
      </div>

      {active.length === 0 ? (
        // HONEST empty state: genuinely childless → "no subtasks yet"; decomposed-but-all-finished
        // (or only-waiting) → a softer note. Reuses the shared parked lifecycle chip, no new palette.
        <div className="swim-empty">
          <span className="chip lc-parked">⏸ parked</span>
          <span className="swim-empty-txt">
            {storySubtaskTotal(story.counts) === 0
              ? "No subtasks yet — parked until the leader decomposes it."
              : "No active subtasks — all work is finished or waiting."}
          </span>
        </div>
      ) : (
        <SwimPipe ids={active} byId={byId} memberSet={memberSet} />
      )}

      {done.length ? <SwimDoneRow done={done} byId={byId} memberSet={memberSet} /> : null}
    </div>
  );
}

/** A catch-all lane for ACTIVE leaves whose owning story isn't a node present in this list (an
 *  orphan, or a subtask of an already-finished story). Ensures NO active work is ever silently
 *  dropped from the view. No progress/lifecycle header — it isn't a real story.
 *
 *  Its badge is the SHARED `KindBadge`: `kindVisual("ungrouped")` hits the unmapped-kind fallback
 *  and yields exactly the classes this lane already used (`kind-badge kind-unknown`) and the same
 *  "• UNGROUPED" glyph+label. */
function SwimUngroupedLane({ leaves, byId }: { leaves: WorkItem[]; byId: Map<string, WorkItem> }) {
  const ids = leaves.map((w) => w.id);
  return (
    <div className="swim-lane swim-lane-ungrouped">
      <div className="swim-hd">
        <span className="swim-kind">
          <KindBadge kind="ungrouped" />
        </span>
        <span className="swim-title">Ungrouped work</span>
        <span className="swim-laneid">no owning story</span>
      </div>
      <SwimPipe ids={ids} byId={byId} memberSet={new Set(ids)} />
    </div>
  );
}

/** A quiet legend of the semantic emphasis vocabulary, reusing the SHARED status colour vars so the
 *  swatches can't drift from the `.chip` palette. Purely explanatory; not interactive. */
function SwimLegend() {
  const items: Array<[string, string]> = [
    ["in_progress", "in progress"],
    ["needs_info", "needs you"],
    ["blocked", "blocked (waiting its turn)"],
    ["merged", "done"],
    ["lc-parked", "parked"],
  ];
  return (
    <div className="swim-legend">
      {items.map(([cls, txt]) => (
        <span key={cls}>
          <i className={"swim-ldot " + cls} /> {txt}
        </span>
      ))}
    </div>
  );
}

/** The Pipeline view — the sole workspace-body work view. */
export function Swimlanes({ work }: { work: WorkItem[] }) {
  const list = Array.isArray(work) ? work : [];
  const byId = new Map(list.map((w) => [w.id, w]));
  const allIds = new Set(byId.keys());
  // A leaf is "grouped" when its owning id resolves to a STORY node present in this list.
  const ownedByPresentStory = (w: WorkItem) => {
    const parent = byId.get(graphChildOf(w) || "");
    return !!parent && parent.work_kind === "node";
  };
  const stories = list.filter((w) => w.work_kind === "node" && !isHistoryItem(w));
  const ungrouped = list.filter((w) => w.work_kind === "leaf" && !isHistoryItem(w) && !ownedByPresentStory(w));

  return (
    <div className="swim-wrap">
      <div className="swim-caption">
        <b>Work pipeline.</b> Each story is a lane; its subtasks run left → right in the order they unblock. The item
        that needs you is the only thing lit; finished work collapses away.
      </div>
      <SwimLegend />
      {stories.length === 0 && ungrouped.length === 0 ? (
        <div className="empty">No active work to show.</div>
      ) : (
        <div className="swim-lanes">
          {stories.map((s) => (
            <SwimLane key={s.id} story={s} byId={byId} allIds={allIds} />
          ))}
          {ungrouped.length ? <SwimUngroupedLane leaves={ungrouped} byId={byId} /> : null}
        </div>
      )}
    </div>
  );
}
