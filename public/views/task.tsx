// The TASK view — the task detail / review page (`#/task/:id`), in React. The largest view, and the
// last one to leave the bridge: after this file is routed, NO route renders `<VanillaView>`.
//
// It owns everything that page paints: the crumbs + header controls (attach-terminal, abort, roll
// back), the needs-your-input card, the metadata grid and its label formatters, the audit timeline
// and the rescue note, the blocked-by list and the dependent-subtree rollup, the live-output panel,
// the agent transcript, and the five feedback control surfaces (in_review diff review / idea /
// spec_review / needs_info / idle).
//
// >>> NOT SALVAGED. WRITTEN. <<< The aborted Phase-4 big-bang produced `.tsx` for every other view;
// it ran out of clock before this one. So this is a fresh port of `public/views/task.js`, whose 13
// former innerHTML templates were already `el()` trees. `views/task-logic.ts` — landed early as
// "the 4d foundation", with its own header noting that until 4d "the two ARE duplicates" — is
// imported here rather than re-derived. Phase 4e deleted `views/task.js` and its duplicate copies,
// and re-pointed `test/output-snapshot-retired.test.ts` at task-logic.ts's real `rescueNote` export
// instead of scraping that file's source text.
//
// ---------------------------------------------------------------------------------------------
// WHAT THE REWRITE DELETED HERE, NAMED. Each of these was module-level state whose only purpose was
// to survive `mount()` destroying and rebuilding `#app` on every SSE event:
//
//   • `liveOutputOpen` / `liveOutputCache` / `liveOutputCacheId` / `liveOutputTimer` — the operator's
//     open/closed choice, the last text so a rebuild would not flash empty, and the poll handle.
//     They are `useState` inside `<LiveOutputPanel>` now. Nothing unmounts it, so nothing is lost;
//     the `key={taskId}` on the panel is what replaces the `liveOutputCacheId` guard.
//   • `transcriptOpen` / `transcriptState` — same story, plus a hand-rolled `renderBody()` that
//     `replaceChildren()`d the panel on every state change. That is a render.
//   • `stopLiveOutput()`, exported ONLY so the router could clear a timer that outlived its own
//     view's DOM. An effect cleanup owns it now, and no caller has to remember.
//   • The `frag()` / `muted()` helpers and the ⚠ "a DocumentFragment IS CONSUMED ON APPEND, so call
//     it once per use site" hazard they carried. A JSX element is a value; rendering it twice is
//     two renders.
//   • `submitTo(btn, …)`, which took a BUTTON NODE so `action()` could disable it. `useAction`
//     returns its own `pending`.
//   • Every `id` on a control (`#abort`, `#approve`, `#reject`, `#requeue`, `#nudge`, `#spec`, …).
//     They existed because the vanilla file once re-found its own nodes with `getElementById`; the
//     last of them was the ⚠ CROSS-MODULE `#inline-comment-summary`, which views/diff.js reached
//     into this view's DOM to repaint. `comments` is state here and the count is just a render.
//
// The two `#requeue` controls that a post-mount `getElementById` used to conflate are, as the
// vanilla file's comment insisted, DIFFERENT controls: the aborted panels' Re-queue is a clean
// action, and the idle panel's `confirm()`s first. They are separate components below.
//
// ---------------------------------------------------------------------------------------------
// THE TYPED-TEXT PROPERTY, AND WHY IT IS NOT A CLAIM.
// `captureUiState`/`restoreUiState` (public/ui-state.js) existed because `mount()` destroyed the
// operator's half-typed change-request note on every SSE event, and the harness put the text, caret,
// focus and scroll back. Every textarea below is a CONTROLLED input on state that React never
// unmounts, so the whole harness is subsumed. RFC §1.4's "targeted re-render" comes free.
// I typed into the review note, drove an SSE refresh, and watched the text survive — see the task
// summary. Phase 4e deleted the harness and `test/app-restore-uistate.test.ts` with it.
import { Button } from "@launchpad-ui/components";
import type { ReactNode } from "react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";

import { ActionButton, look, useAction } from "../components/button.tsx";
import { LivenessChip, StatusChip, TagChips, TaskChips } from "../components/chips.tsx";
import { effStatus, feedbackStepLabel } from "../components/chips-logic.js";
import { Block, BlockerRow, CiBadge, Collapsible, ConformanceBadge, ListPanel, RollupPanel } from "../components/panel.tsx";
import { terminalToast, toast } from "../components/toast.js";
import { api } from "../core/api.js";
import { fmtDuration, fmtTime } from "../core/format.js";
import { bumpRefresh, useRefreshVersion } from "../core/refresh.js";
// TERMINAL_STATUSES is an `export let` reassigned once /api/state-meta lands. Read it at CALL time —
// never destructure it into a module const. `useStateMetaVersion()` is what re-renders us when it is.
import { TERMINAL_STATUSES, statusLabel } from "../core/state-meta.js";
import { useStateMetaVersion } from "../state-meta-store";
import type {
  ApproveResult,
  ChainEstimate,
  DependentRollup,
  Estimate,
  TaskEvent,
  TaskView,
  TerminalResult,
  TranscriptItem,
  TranscriptPage,
  WorkItem,
  Workspace,
} from "../core/types.js";
import { useAsync } from "../core/use-async.js";
import { gatedSubtree, isCompleteStatus, reverseDeps, workLeaves } from "../core/work-graph.js";
import { DiffView } from "./diff.tsx";
import type { InlineComment } from "./diff-logic.js";
import { composeReviewNote } from "./diff-logic.js";
import { costLabel, hasTokenUsage, isLive, isOneKeyConfirmPrompt, modelLabel, rescueNote } from "./task-logic.js";

// ---------- small shared pieces ----------

/** `#/workspace/:id` — the flat hash the vanilla `backToWorkspace()` set. The router rewrites it to
 *  the workspace's nested home; an un-adopted repo renders flat. Empty id goes to the root. */
function useBackToWorkspace(): (workspaceId: string | undefined) => void {
  const navigate = useNavigate();
  return useCallback((workspaceId) => navigate(workspaceId ? "/workspace/" + workspaceId : "/"), [navigate]);
}

/** Open a GUI terminal attached to a running task's live agent pane. Attaching never navigates, so
 *  `onDone` is a no-op — it must not re-fetch the page. */
function OpenTerminalButton({ taskId, label, kind }: { taskId: string; label: string; kind?: "ghost" }) {
  return (
    <ActionButton
      label={label}
      kind={kind}
      onAction={async () => terminalToast(await api<TerminalResult>("POST", "/work/" + taskId + "/terminal"))}
      onDone={() => {}}
    />
  );
}

// ---------- needs-your-input ----------

/**
 * The PROMINENT "needs your input" card for a work item whose LIVE agent is wedged at a human-only
 * OS/CLI prompt (`effStatus === "needs_user_input"`). The highest-attention surface on the page: it
 * states the agent is alive-but-blocked, shows the captured pane so the human sees exactly WHAT is
 * blocking, and offers the tools to resolve it in place —
 *  • Open terminal — attach a GUI terminal to the live pane so the human can type the answer.
 *  • Confirm — ONLY for the dev-channels-style numbered prompt, where a bare nudge of "1" is the
 *    safe proceed/consent choice. The agent then moves past the prompt and the safety-net watcher
 *    clears the flag on the next clean pane read, so the card resolves on the next SSE update.
 */
function NeedsUserInputPanel({ task }: { task: TaskView }) {
  const ctx = (task.needs_user_input_context || "").trim();
  return (
    <div className="panel needs-input-panel">
      <div className="ni-head">
        <span className="ni-icon" aria-hidden="true">
          ⌨
        </span>
        <h2>Needs your input</h2>
      </div>
      <p className="ni-lead">
        This agent is <strong>alive but blocked</strong> at a prompt only a human can answer — it can&rsquo;t proceed
        until you respond in its live terminal.
      </p>
      {ctx ? (
        <>
          <div className="ni-ctx-label">What it&rsquo;s waiting on</div>
          <pre className="block ni-ctx">{ctx}</pre>
        </>
      ) : (
        <p className="muted ni-noctx">No captured prompt text — open the terminal to see what it&rsquo;s waiting on.</p>
      )}
      <div className="ni-actions">
        <OpenTerminalButton taskId={task.id} label="⌗ Open terminal to answer" />
        {isOneKeyConfirmPrompt(ctx) ? (
          // No pre-flight confirm() and no validation → the plain action dance is exactly right.
          // The `title` rides on a wrapping span: LaunchPad's ButtonProps has no `title` (see
          // components/button.tsx).
          <span title="send “1” to the live pane — the safe proceed/consent choice">
            <ActionButton
              kind="ghost"
              label="Confirm (send “1”)"
              onAction={() => api("POST", "/work/" + task.id + "/nudge", { text: "1" })}
              success="sent “1” — the agent should continue past the prompt"
              onDone={() => {}}
            />
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ---------- timeline ----------

/** Compact vertical AUDIT TIMELINE of a task's status transitions (oldest → newest): one row per
 *  change with the transition (from → to chips) and the short note that explains why it moved, plus
 *  a relative timestamp (full ISO on hover). Null when there are no recorded events.
 *
 *  `.tl-event` / `.tl-head` are flex and `.tl-transition` is inline-flex, so the whitespace the old
 *  template carried between their children generated no anonymous flex item and rendered as nothing.
 *  It is not reproduced. */
function Timeline({ events }: { events: TaskEvent[] }) {
  if (!events.length) return null;
  return (
    <div className="panel timeline-panel">
      <h2 className="panel-title">Timeline</h2>
      <div className="timeline">
        {events.map((ev, i) => (
          // eslint-disable-next-line react/no-array-index-key -- an event row has no id on the wire
          <div className="tl-event" key={i}>
            {/* `?? ""` is what esc() used to absorb: a null to_status yielded a bare `class="tl-dot"`
                rather than the literal string "null" in the class list. */}
            <span className={"tl-dot " + (ev.to_status ?? "")} />
            <div className="tl-body">
              <div className="tl-head">
                <span className="tl-transition">
                  {ev.from_status && ev.from_status !== ev.to_status ? (
                    <>
                      <StatusChip status={ev.from_status} />
                      <span className="tl-arrow">→</span>
                      <StatusChip status={ev.to_status} />
                    </>
                  ) : (
                    <StatusChip status={ev.to_status} />
                  )}
                </span>
                <span className="tl-time" title={ev.at}>
                  {fmtTime(ev.at)}
                </span>
              </div>
              {ev.note ? <div className="tl-note">{ev.note}</div> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- metadata grid ----------

/** One `<div class="k">key</div><div class="v">value</div>` pair. `.meta-grid` is a grid, so the
 *  whitespace the old template carried between the cells generated no anonymous grid item. */
function MetaRow({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <>
      <div className="k">{label}</div>
      <div className="v" title={title}>
        {children}
      </div>
    </>
  );
}

/** Compact token-usage summary from the captured session totals, or "—" until any usage is recorded.
 *  The literal space before the `.muted` span is real: `.meta-grid .v` is a plain block, not a flex
 *  container, so that gap renders. */
function TokensLabel({ task }: { task: TaskView }) {
  if (!hasTokenUsage(task)) return <>—</>;
  const n = (v: number | null | undefined) => (typeof v === "number" ? v : 0).toLocaleString();
  const { usage_input_tokens: i, usage_output_tokens: o, usage_cache_read_tokens: r, usage_cache_creation_tokens: w } = task;
  const total = (i || 0) + (o || 0) + (r || 0) + (w || 0);
  return (
    <>
      {`${n(total)} total `}
      <span className="muted">{`· in ${n(i)} · out ${n(o)} · cache r ${n(r)} / w ${n(w)}`}</span>
    </>
  );
}

/** ROUGH duration estimate as a loose p50–p90 RANGE with its sample size — deliberately hedged
 *  ("~", "rough"), never a promise. Prefers the to-merge range, falling back to to-review. */
function EstimateLabel({ estimate }: { estimate: Estimate }) {
  const insufficient = (
    <>
      {"insufficient data "}
      <span className="muted">· not enough history yet</span>
    </>
  );
  if (estimate.insufficient) return insufficient;
  const r = estimate.toMerge || estimate.toReview;
  if (!r) return insufficient;
  const label = estimate.toMerge ? "to merge" : "to review";
  const bucket = estimate.basis === "overall" ? "all tasks" : `${estimate.bucket} ${estimate.basis}`;
  return (
    <>
      {`est ~${fmtDuration(r.p50Ms)}–${fmtDuration(r.p90Ms)} `}
      <span className="muted">{`· ${label} · n=${estimate.n} · ${bucket} · rough`}</span>
    </>
  );
}

/** Critical-path estimate across a blocked task's blocker chain, or null when there is nothing
 *  pending to chain.
 *
 *  The vanilla `fmtChain` carried a ⚠ warning that it must return `null` and NEVER an empty
 *  DocumentFragment, because a fragment is always truthy and `listPanel`'s bare `if (chainLine)`
 *  would paint a stray empty `.chain-est`. Returning `null` from a component renders nothing, and
 *  `ListPanel` guards on the value, so the hazard died with the fragment. */
function chainLine(chain: ChainEstimate | null | undefined): ReactNode {
  if (!chain || chain.taskCount === 0 || chain.p50Ms == null) return null;
  const n = chain.taskCount;
  return (
    <>
      {`est ~${fmtDuration(chain.p50Ms)}–${fmtDuration(chain.p90Ms)} `}
      <span className="muted">{`· critical path across ${n} task${n === 1 ? "" : "s"} · rough`}</span>
      {/* `.chain-est` is a plain block, so this leading space is a rendered gap. */}
      {chain.insufficient ? (
        <>
          {" "}
          <span className="muted">· partial — some tasks lack history</span>
        </>
      ) : null}
    </>
  );
}

function MetaPanel({ task }: { task: TaskView }) {
  return (
    <div className="panel">
      <div className="meta-grid">
        <MetaRow label="status">{statusLabel(effStatus(task))}</MetaRow>
        {task.liveness ? (
          <MetaRow label="liveness" title={task.liveness.evidence}>
            <LivenessChip liveness={task.liveness} />
          </MetaRow>
        ) : null}
        {Array.isArray(task.tags) && task.tags.length ? (
          <MetaRow label="tags">
            <TagChips task={task} />
          </MetaRow>
        ) : null}
        {Array.isArray(task.allowlist) && task.allowlist.length ? (
          <MetaRow label="allowlist">
            {/* `.meta-grid .v` is a plain block, so the single space BETWEEN two <code>s is a
                rendered gap (the old template `.join(" ")`ed them) — emit it as a real text node. */}
            {task.allowlist.map((a, i) => (
              <Fragment key={a}>
                {i ? " " : null}
                <code>{a}</code>
              </Fragment>
            ))}
          </MetaRow>
        ) : null}
        <MetaRow label="priority">{String(task.priority ?? 0)}</MetaRow>
        <MetaRow label="created">{task.created_at || "—"}</MetaRow>
        <MetaRow label="started">{task.started_at || "—"}</MetaRow>
        <MetaRow label="completed">{task.completed_at || "—"}</MetaRow>
        <MetaRow label="merged">{task.merged_at || "—"}</MetaRow>
        {task.estimate ? (
          <MetaRow label="est. duration">
            <EstimateLabel estimate={task.estimate} />
          </MetaRow>
        ) : null}
        <MetaRow label="model">{modelLabel(task)}</MetaRow>
        <MetaRow label="tokens">
          <TokensLabel task={task} />
        </MetaRow>
        <MetaRow label="cost">{costLabel(task)}</MetaRow>
      </div>
    </div>
  );
}

// ---------- live output ----------

/**
 * Best-effort snapshot of the agent's recent terminal output, polled every 2.5s while the panel is
 * open and the task still has a live pane. A convenience view; the git diff stays the source of
 * truth for review.
 *
 * The poll lives in an effect keyed on `open`, so closing the panel stops it and unmounting stops it
 * — which is the whole of what the exported `stopLiveOutput()` and the router's "clear it up front
 * on every route change" existed to guarantee.
 *
 * The scroll pin is the one thing here that MUST touch the DOM: "keep the view pinned to the newest
 * output if it is already scrolled to the bottom" is a question about layout, not about state.
 */
function LiveOutputPanel({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(true);
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const poll = async () => {
      let out: string;
      try {
        const r = await api<{ output?: string }>("GET", "/work/" + taskId + "/output");
        out = (r.output || "").trimEnd();
      } catch {
        return; // transient — keep whatever was there
      }
      if (cancelled) return;
      const pre = preRef.current;
      const atBottom = pre ? pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24 : true;
      setText(out);
      setLoaded(true);
      if (atBottom) {
        // After the commit that paints `out`, not before it.
        queueMicrotask(() => {
          const el = preRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, taskId]);

  return (
    <Collapsible
      title="Live output"
      titleClassName="lo-title"
      meta="best-effort · updates every few seconds"
      metaClassName="lo-hint"
      isOpen={open}
      onOpenChange={setOpen}
      className="panel live-output"
      headClassName="live-output-head"
    >
      <pre className="block live-output-body" ref={preRef}>
        {loaded ? text || "(no recent output)" : "loading recent output…"}
      </pre>
    </Collapsible>
  );
}

// ---------- agent transcript ----------

const TRANSCRIPT_PAGE = 200;

/** One transcript item (one content block) as a labelled, monospace row. `.ts-head` is flex, so the
 *  label/time gap comes from its `gap`. The truncation marker's LEADING space lives inside `.ts-pre`
 *  (`white-space: pre-wrap`), where it is rendered. */
function TranscriptRow({ item }: { item: TranscriptItem }) {
  const kind = item.kind ?? "";
  const role = item.role ?? "";
  const trunc = item.truncated ? <span className="ts-trunc"> … (truncated)</span> : null;

  let label: ReactNode;
  let body: ReactNode = null;
  if (kind === "tool_use") {
    label = <span className="ts-label tool">{"⚙ " + (item.tool ?? "")}</span>;
    body = item.args ? <code className="ts-args">{item.args}</code> : null;
  } else if (kind === "tool_result") {
    label = <span className="ts-label result">↳ result</span>;
    body = (
      <pre className="ts-pre">
        {item.text || ""}
        {trunc}
      </pre>
    );
  } else if (kind === "thinking") {
    label = <span className="ts-label thinking">{role + " · thinking"}</span>;
    body = (
      <pre className="ts-pre">
        {item.text || ""}
        {trunc}
      </pre>
    );
  } else {
    label = <span className={"ts-label " + role}>{role}</span>;
    body = (
      <pre className="ts-pre">
        {item.text || ""}
        {trunc}
      </pre>
    );
  }

  return (
    <div className={`ts-item ts-${kind} role-${role}`}>
      <div className="ts-head">
        {label}
        {item.ts ? (
          <span className="ts-time" title={item.ts}>
            {fmtTime(item.ts)}
          </span>
        ) : null}
      </div>
      {body}
    </div>
  );
}

/** The collapsible "Agent transcript" panel. LAZY: nothing is fetched until it is opened (transcripts
 *  get large), and subsequent pages append via "Load more". Only offered once the task has a session.
 *
 *  The vanilla kept a module-level `transcriptState` cache keyed by task id, because `mount()` threw
 *  the loaded turns away on every SSE event. Nothing throws them away now, and the `key={taskId}` on
 *  this element is what the `transcriptState.id !== id` reset guard used to be. */
function TranscriptPanel({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<TranscriptItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const offset = turns.length;
      const r = await api<TranscriptPage>("GET", `/work/${taskId}/transcript?offset=${offset}&limit=${TRANSCRIPT_PAGE}`);
      setTurns((prev) => prev.concat(r.turns || []));
      setTotal(r.total || 0);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      loadingRef.current = false;
      setLoading(false);
      setLoaded(true);
    }
  }, [taskId, turns.length]);

  // Fetch on FIRST open only. `loaded` is set even on a failed fetch, exactly as the vanilla did —
  // an error toasts once and the panel shows its empty state rather than retrying on every render.
  useEffect(() => {
    if (open && !loaded && !loadingRef.current) void load();
  }, [open, loaded, load]);

  return (
    <Collapsible
      title="Agent transcript"
      titleClassName="ts-title"
      meta="what the agent did · read-only"
      metaClassName="ts-hint"
      isOpen={open}
      onOpenChange={setOpen}
      className="panel transcript"
      headClassName="transcript-head"
    >
      <div className="transcript-body">
        {loading && !turns.length ? (
          <div className="ts-empty">loading transcript…</div>
        ) : loaded && !turns.length ? (
          <div className="ts-empty">No transcript available for this task yet.</div>
        ) : (
          <>
            {turns.map((it, i) => (
              // eslint-disable-next-line react/no-array-index-key -- a content block has no id
              <TranscriptRow item={it} key={i} />
            ))}
            {turns.length < total ? (
              <Button
                {...look({ kind: "ghost", className: "ts-more" })}
                isDisabled={loading}
                onPress={() => void load()}
              >
                {`Load more (${turns.length} of ${total})`}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </Collapsible>
  );
}

// ---------- dependent rollup ----------

/** For a task that GATES others (its id appears in their `blocked_by`), summarize how far the
 *  dependent sub-tree has landed. Walks the reversed edges of the workspace's leaf list — no extra
 *  API field — then counts the COMPLETE ones. Null when the task gates nothing.
 *
 *  COMPLETE, not merely `merged`: a dependent STORY completes at status `done`, so a merged-only
 *  count under-reported any subtree containing one. */
function dependentRollup(rootId: string, tasks: WorkItem[]): DependentRollup | null {
  const dependentsOf = reverseDeps(tasks);
  const directIds = dependentsOf.get(rootId) || [];
  if (directIds.length === 0) return null;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const subtree = [...gatedSubtree(rootId, dependentsOf)].map((sid) => byId.get(sid)).filter((t): t is WorkItem => !!t);
  const direct = directIds.map((did) => byId.get(did)).filter((t): t is WorkItem => !!t);
  const merged = subtree.filter((t) => isCompleteStatus(t.status)).length;
  return { direct, total: subtree.length, merged };
}

// ---------- the failed / aborted panels ----------

/** The aborted panels' Re-queue: no confirm(), no validation, and the default post-action refresh is
 *  exactly what it wants. This is the clean `ActionButton` case.
 *
 *  ⚠ It is NOT the idle panel's Re-queue, which `confirm()`s first. The vanilla only ever looked like
 *  one control because a post-mount `getElementById("requeue")` found whichever happened to exist. */
function RequeueButton({ taskId }: { taskId: string }) {
  return <ActionButton label="Re-queue" onAction={() => api("POST", "/work/" + taskId + "/requeue")} success="re-queued ✓" />;
}

function RevertedPanel({ task }: { task: TaskView }) {
  return (
    <div className="panel failed-panel">
      <h2 className="panel-title">Merge auto-reverted off main</h2>
      <p className="muted lede">
        This branch merged, but the post-merge verify (build + tests) failed on the default branch, so the merge was
        reverted to keep main green. The branch + worktree were kept.
      </p>
      <pre className="block">{task.revert_reason}</pre>
      <div className="row panel-actions">
        <RequeueButton taskId={task.id} />
        <small className="muted">
          Re-launches the agent (in-context) to fix the breakage, then it can be re-reviewed.
        </small>
      </div>
    </div>
  );
}

function DispatchFailedPanel({ task }: { task: TaskView }) {
  const n = task.dispatch_attempts || 0;
  return (
    <div className="panel failed-panel">
      <h2 className="panel-title">Dispatch failed</h2>
      <p className="muted lede">{`Failed after ${n} dispatch attempt${n === 1 ? "" : "s"}. The agent never started.`}</p>
      <pre className="block">{task.last_dispatch_error || "(no error recorded)"}</pre>
      <div className="row panel-actions">
        <RequeueButton taskId={task.id} />
        <small className="muted">Clears the retry state and dispatches again from scratch.</small>
      </div>
    </div>
  );
}

// ---------- the awaiting-who banner ----------

/** For a task awaiting feedback, surface WHO is expected to act — the server-computed STRUCTURAL
 *  `pending_responder` (story|cto|ceo|user). `user` is emphasized; `cto`/`story` are muted (an agent
 *  handles it, but you can also act). butchr is responder-agnostic: the action controls below render
 *  regardless. A null responder (non-feedback state) shows no banner.
 *
 *  REVAMP-4 P3a: `ceo` is DORMANT — the server never emits it — so a defensive `ceo` value falls to
 *  the muted `else`, exactly as the vanilla did. */
function ResponderBanner({ task }: { task: TaskView }) {
  if (!task.pending_responder) return null;
  const stepLbl = feedbackStepLabel(task);
  const step = stepLbl ? ` (${stepLbl})` : "";
  const you = task.pending_responder === "user";
  return (
    <div className={"responder-banner " + (you ? "awaiting-you" : "awaiting-cto")}>
      {you ? (
        <>
          <strong>Awaiting you</strong>
          {` — this${step} is assigned to `}
          <strong>you</strong>. Act in the controls below.
        </>
      ) : task.pending_responder === "story" ? (
        <>
          <strong>Awaiting the story leader</strong>
          {` — this${step} is handled automatically by the story leader agent. You can also act in the controls below.`}
        </>
      ) : (
        <>
          <strong>Awaiting the CTO agent</strong>
          {` — this${step} is handled automatically by this workspace's CTO agent. You can also act in the controls below.`}
        </>
      )}
    </div>
  );
}

// ---------- major-version double-confirm ----------

/**
 * In a `release_mode` workspace a major-bump task does NOT merge on Approve — Approve PARKS it.
 * Landing it is the HUMAN's deliberate double-confirm: two CONSECUTIVE Confirm clicks (streak
 * 0→1→2); ANY other action resets the streak to 0. Shown only off the workspace's `release_mode` (no
 * hardcoded id) + the task's declared major bump.
 *
 * HAND-ROLLED, not `ActionButton`: it branches its own toasts AND its own post-action step off the
 * response shape — a still-awaiting confirm re-renders IN PLACE so the operator sees the streak tick
 * up, while a landed merge leaves for the list. `ActionButton`'s construction-time `success`/`onDone`
 * cannot express that.
 */
function MajorConfirmPanel({ task }: { task: TaskView }) {
  const back = useBackToWorkspace();
  const n = task.major_confirm_count || 0;
  const landed = useRef(false);

  const { run, pending } = useAction(
    async () => {
      landed.current = false;
      const r = await api<ApproveResult>("POST", "/work/" + task.id + "/confirm-major");
      if (r && r.conflictSentBack) {
        toast("Merge conflict — sent back to the agent to resolve");
        landed.current = true;
      } else if (r && r.revertedOnRed) {
        toast("Merged but verify FAILED — auto-reverted off main", true);
        landed.current = true;
      } else if (r && r.awaitingMajorConfirm) {
        const c = (r.task && r.task.major_confirm_count) || 0;
        toast(`Major-version confirmation ${c}/2 — one more consecutive confirm to merge`);
      } else {
        landed.current = true;
        const v = r && r.released_version;
        toast(`Confirmed ✓ — merged${v ? ` (v${v})` : ""}`);
      }
    },
    { onDone: () => (landed.current ? back(task.workspace_id) : bumpRefresh()) },
  );

  return (
    <div className="panel major-confirm-panel">
      <h2 className="panel-title">{`Awaiting major-version confirmation (${n}/2)`}</h2>
      <p className="muted lede">
        This task declares a <strong>major</strong> version bump, so merging it is a deliberate human double-confirm —{" "}
        <strong>Approve does not merge it</strong>. Click <strong>Confirm major version</strong>{" "}
        <strong>twice in a row</strong>
        {` (streak ${n}/2); the second consecutive confirm lands the merge. `}
        <strong>Any other action</strong> (Approve, Request change, re-review, re-declaring the bump){" "}
        <strong>resets the streak to 0</strong>.
      </p>
      <div className="row">
        <Button {...look({ kind: "danger" })} isDisabled={pending} onPress={() => void run()}>
          {`Confirm major version (${n}/2)`}
        </Button>
        <small className="muted">Two consecutive confirms required — this is the human gate on a breaking release.</small>
      </div>
    </div>
  );
}

// ---------- in_review: the diff + review controls ----------

/**
 * The review surface. It owns `comments` — the inline review-comment map — because it is the thing
 * that SENDS them (`composeReviewNote`) and the thing that COUNTS them. That lift is what deleted
 * views/diff.js's module-scoped `inlineComments` store, its `pendingInlineRestore` async-handoff
 * cell, and its `document.getElementById("inline-comment-summary")` reach into this view's DOM.
 */
function ReviewPanel({ task, releaseMode }: { task: TaskView; releaseMode: boolean }) {
  const back = useBackToWorkspace();
  const version = useRefreshVersion();
  const [note, setNote] = useState("");
  const [comments, setComments] = useState<Map<string, InlineComment>>(new Map());

  // A different task's diff must not inherit this one's comments.
  useEffect(() => {
    setComments(new Map());
    setNote("");
  }, [task.id]);

  const diff = useAsync(() => api<{ diff: string }>("GET", "/work/" + task.id + "/diff"), [task.id, version]);

  const parked = useRef(false);
  const approve = useAction(
    async () => {
      parked.current = false;
      const r = await api<ApproveResult>("POST", "/work/" + task.id + "/approve");
      // A merge conflict isn't an error — it goes back to the live agent to resolve in-context.
      if (r && r.conflictSentBack) {
        toast("Merge conflict — sent back to the agent to resolve");
      } else if (r && r.revertedOnRed) {
        toast("Merged but verify FAILED — auto-reverted off main", true);
      } else if (r && r.awaitingMajorConfirm) {
        // release_mode major bump: Approve PARKS. Stay on the task for the double-confirm above.
        const n = (r.task && r.task.major_confirm_count) || 0;
        parked.current = true;
        toast(`Parked — awaiting major-version confirmation (${n}/2). Use “Confirm major version” above.`);
      } else {
        toast("approved ✓ — merged, agent wrapping up");
      }
    },
    { onDone: () => (parked.current ? bumpRefresh() : back(task.workspace_id)) },
  );

  const reject = useAction(() => api("POST", "/work/" + task.id + "/reject", { note: composeReviewNote(note, comments) }), {
    success: "changes requested",
    onDone: () => back(task.workspace_id),
  });

  // HAND-ROLLED: Approve gates on up to two ADVISORY confirm()s before it acts. Routing it through
  // `ActionButton` would disable the button and start the dance before the first confirm() could
  // cancel, leaving a dead control on screen.
  const onApprove = () => {
    if (task.ci_status === "fail") {
      const label = (task.ci_summary || "CI failed").split("\n")[0].trim();
      if (!confirm(`CI failed (${label}). Approve and merge anyway?`)) return;
    }
    if (task.conformance_status === "concern") {
      const why = (task.conformance_summary || "").trim();
      if (!confirm(`Conformance concern${why ? `: ${why}` : ""}. Approve and merge anyway?`)) return;
    }
    void approve.run();
  };

  // HAND-ROLLED: validates first and toasts an INLINE error when there is nothing to send. Either a
  // freeform note or at least one inline comment is enough — a reviewer can reject purely with
  // per-line comments.
  const onReject = () => {
    if (!composeReviewNote(note, comments)) return toast("add a note or at least one inline comment", true);
    void reject.run();
  };

  const n = comments.size;
  const pending = approve.pending || reject.pending;

  return (
    <>
      {/* CI GATE badge — BEFORE the diff. Reflects the build/test job butchr runs in the task's
          worktree on the in_review transition; updates live when CI flips running→pass/fail. */}
      <CiBadge task={task} />
      {/* SPEC-CONFORMANCE badge — next to it. Null when the read-only reviewer didn't run. */}
      <ConformanceBadge task={task} />

      {releaseMode && task.version_bump === "major" ? <MajorConfirmPanel task={task} /> : null}

      <h2>Diff vs main</h2>
      <div className="diffview">
        {diff.error && !diff.data ? (
          <div className="meta">{`diff error: ${diff.error.message}`}</div>
        ) : !diff.data ? (
          <div className="meta">loading diff…</div>
        ) : (
          <DiffView diff={diff.data.diff} taskId={task.id} comments={comments} onCommentsChange={setComments} />
        )}
      </div>

      <div className="panel stacked">
        <h2 className="panel-title">Review</h2>
        <label className="field tight">
          <span className="lbl">change request note</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What needs to change? The note (plus any inline comments above) goes back to the same live agent, which keeps working in-context (no restart)."
          />
        </label>
        {/* Was `#inline-comment-summary`, repainted from views/diff.js by getElementById. It is a
            render of `comments.size` now, and the cross-module id is gone from both sides. */}
        <div className={"inline-comment-summary hint" + (n ? " on" : "")}>
          {n ? `${n} inline comment${n === 1 ? "" : "s"} will be included` : ""}
        </div>
        <div className="row">
          <Button {...look({ kind: "success" })} isDisabled={pending} onPress={onApprove}>
            Approve &amp; merge
          </Button>
          <Button {...look({ kind: "danger" })} isDisabled={pending} onPress={onReject}>
            Request change
          </Button>
          <div className="spacer" />
        </div>
      </div>
    </>
  );
}

// ---------- idea: write the spec ----------

/** A brief AWAITING a spec. butchr runs NO agent for it: it pushes a `spec requested` event on the
 *  channel and waits for the task's STRUCTURAL responder to submit a spec, which advances it to
 *  spec_review. The responder only FRAMES this UI — the editor is ALWAYS available so a human can
 *  submit, but for a cto/story task the responsible agent normally handles it. */
function IdeaPanel({ task }: { task: TaskView }) {
  const back = useBackToWorkspace();
  const [spec, setSpec] = useState("");
  const responder = task.pending_responder || "cto"; // defensive fallback, as the vanilla had

  const submit = useAction(() => api("POST", "/work/" + task.id + "/spec", { spec: spec.trim() }), {
    success: "spec submitted ✓ — awaiting approval",
    onDone: () => back(task.workspace_id),
  });

  // HAND-ROLLED: validates first and toasts an inline error on an empty spec.
  const onSubmit = () => {
    if (!spec.trim()) return toast("a spec is required", true);
    void submit.run();
  };

  return (
    <>
      {task.review_note ? <Block heading="Spec changes requested" text={task.review_note} /> : null}
      <div className="panel stacked">
        <h2 className="panel-title">{responder === "user" ? "Write the spec" : "Spec requested"}</h2>
        <p className="muted lede">
          {responder === "user" ? (
            "You are the responder for this spec. Turn the brief above into a concrete, repo-grounded spec and submit it to advance the task to spec review."
          ) : responder === "story" ? (
            <>
              The <strong>story leader</strong> agent will write the spec from the brief (it was notified on its story
              channel). You can also write and submit one yourself below.
            </>
          ) : (
            <>
              The <strong>CTO agent</strong> will write the spec from the brief (it was notified on the CTO channel). You
              can also write and submit one yourself below.
            </>
          )}
        </p>
        <label className="field tight">
          <span className="lbl">spec (required)</span>
          <textarea
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            placeholder="Write the full spec for this brief — what to build, where, and how it should be verified."
          />
        </label>
        <div className="row">
          <Button {...look({ kind: "success" })} isDisabled={submit.pending} onPress={onSubmit}>
            Submit spec
          </Button>
          <div className="spacer" />
        </div>
      </div>
    </>
  );
}

// ---------- spec_review ----------

/** A spec was submitted (by the CTO agent or a human); the operator approves to start the workspace
 *  agent, or requests changes to revise the spec (back to `idea`). */
function SpecReviewPanel({ task }: { task: TaskView }) {
  const back = useBackToWorkspace();
  const [note, setNote] = useState("");

  const reject = useAction(() => api("POST", "/work/" + task.id + "/reject", { note: note.trim() }), {
    success: "spec changes requested — revising",
    onDone: () => back(task.workspace_id),
  });

  // HAND-ROLLED: validates first and toasts an inline error on an empty note.
  const onReject = () => {
    if (!note.trim()) return toast("add a note describing what to change in the spec", true);
    void reject.run();
  };

  return (
    <div className="panel stacked">
      <h2 className="panel-title">Review spec</h2>
      <p className="muted lede">
        A spec was submitted for this idea. Approve to dispatch the workspace agent, or request changes to revise the
        spec.
      </p>
      <label className="field tight">
        <span className="lbl">change request note (required if requesting changes)</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="What needs to change in the spec?" />
      </label>
      <div className="row">
        {/* Approve toasts its own dispatching message from INSIDE the action body (so the whole
            await+toast stays in one try), and neither confirm()s nor validates → a clean action. */}
        <ActionButton
          kind="success"
          label="Approve spec"
          isDisabled={reject.pending}
          onAction={async () => {
            await api("POST", "/work/" + task.id + "/approve");
            toast("spec approved ✓ — dispatching workspace agent");
          }}
          onDone={() => back(task.workspace_id)}
        />
        <Button {...look({ kind: "danger" })} isDisabled={reject.pending} onPress={onReject}>
          Request changes
        </Button>
        <div className="spacer" />
      </div>
    </div>
  );
}

// ---------- needs_info: plan approval ----------

/** A PLAN-PREVIEW task at the plan-approval step: Approve (resume to implement, with optional
 *  steering) or Request changes (send the plan back with REQUIRED feedback). These POST
 *  `/plan/{approve,reject}`, distinct from the freeform `/answer`. Both resume the same session. */
function PlanReviewPanel({ task }: { task: TaskView }) {
  const back = useBackToWorkspace();
  const [note, setNote] = useState("");

  const reject = useAction(() => api("POST", "/work/" + task.id + "/plan/reject", { note: note.trim() }), {
    success: "plan changes requested — agent revising",
    onDone: () => back(task.workspace_id),
  });

  // HAND-ROLLED: feedback is REQUIRED to request changes — validate, then toast inline.
  const onReject = () => {
    if (!note.trim()) return toast("add feedback describing what the plan must change", true);
    void reject.run();
  };

  return (
    <>
      {task.question ? <Block heading="Proposed plan" text={task.question} /> : null}
      <div className="panel stacked">
        <h2 className="panel-title">Review plan</h2>
        <p className="muted lede">
          Approve to let the agent implement this plan, or request changes with feedback — the agent revises and
          re-proposes. Both resume the same session in-context.
        </p>
        <label className="field">
          <span className="lbl">feedback (optional for approve · required to request changes)</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="On approve: optional steering notes folded into the implementation. On request-changes: what the plan must change before implementing."
          />
        </label>
        <div className="row">
          {/* Approve neither confirm()s nor validates (the note is OPTIONAL here) → a clean action.
              `onAction` reads `note` at CLICK time, which is what `useAction`'s ref indirection buys:
              a hook that froze the closure would send a stale note. */}
          <ActionButton
            kind="success"
            label="Approve plan"
            isDisabled={reject.pending}
            onAction={() => api("POST", "/work/" + task.id + "/plan/approve", note.trim() ? { note: note.trim() } : {})}
            success="plan approved — agent implementing"
            onDone={() => back(task.workspace_id)}
          />
          {/* `danger-outline`, NOT `ghost danger-outline` — matching style.css as the vanilla had it. */}
          <Button {...look({ kind: "danger-outline" })} isDisabled={reject.pending} onPress={onReject}>
            Request changes
          </Button>
          <div className="spacer" />
        </div>
      </div>
    </>
  );
}

// ---------- needs_info: the freeform answer ----------

/** The agent paused by calling an MCP tool — it raised a question, a suggested task change, or a
 *  decomposition. On answer butchr re-launches the SAME agent session via `--resume` with the
 *  response injected. */
function AnswerPanel({ task }: { task: TaskView }) {
  const back = useBackToWorkspace();
  const [answer, setAnswer] = useState("");

  const send = useAction(() => api("POST", "/work/" + task.id + "/answer", { answer: answer.trim() }), {
    success: "answer sent — agent resuming",
    onDone: () => back(task.workspace_id),
  });

  // HAND-ROLLED: validates first and toasts an inline error on an empty answer.
  const onSend = () => {
    if (!answer.trim()) return toast("an answer is required", true);
    void send.run();
  };

  return (
    <>
      {task.question ? <Block heading="Agent raised" text={task.question} /> : null}
      <div className="panel stacked">
        <h2 className="panel-title">Respond</h2>
        <label className="field">
          <span className="lbl">your response (required)</span>
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Respond to what the agent raised. It goes back to the same agent, which butchr re-launches in-context (--resume) to continue."
          />
        </label>
        <div className="row">
          <Button {...look({ kind: "success" })} isDisabled={send.pending} onPress={onSend}>
            Send answer
          </Button>
          <div className="spacer" />
        </div>
      </div>
    </>
  );
}

// ---------- idle agent ----------

/** A LIVE `in_progress` agent that went quiet (the `idle` flag). GRACEFUL idle-handling (FW-4): show
 *  the captured context, then let the operator STEER it (nudge-with-guidance, or a bare "continue")
 *  or re-queue it — replacing the old blind auto-"continue". Abort lives in the header.
 *
 *  A dead-shell pane is never shown here as nudgeable: the backend auto-resumes it instead, so an
 *  idle agent surfaced here is genuinely alive (and `/nudge` re-checks liveness regardless). */
function IdlePanel({ task }: { task: TaskView }) {
  const [text, setText] = useState("");

  // HAND-ROLLED: the success MESSAGE depends on the text read at click time, and `ActionButton`
  // captures `success` at CONSTRUCTION. Idle actions also stay on this page (no backToWorkspace),
  // which is the default post-action refresh.
  const trimmed = text.trim();
  const nudge = useAction(() => api("POST", "/work/" + task.id + "/nudge", trimmed ? { text: trimmed } : {}), {
    success: trimmed ? "guidance sent ✓" : "nudged — sent “continue” ✓",
  });

  // HAND-ROLLED: confirm() first — a cancel must not leave the button disabled.
  const requeue = useAction(() => api("POST", "/work/" + task.id + "/requeue"), { success: "re-queued ✓" });
  const onRequeue = () => {
    if (!confirm("Re-queue this idle agent? Its current run is torn down and re-launched (resuming its session) from scratch.")) return;
    void requeue.run();
  };

  const pending = nudge.pending || requeue.pending;

  return (
    <>
      {task.idle_context ? <Block heading="Idle context (recent output)" text={task.idle_context} /> : null}
      <div className="panel stacked">
        <h2 className="panel-title">Idle agent</h2>
        <p className="muted lede">
          This agent is alive but has gone quiet. Read the context above to judge why it stopped, then steer it with
          guidance (or a bare “continue”), re-queue it to relaunch its session, or abort it from the header.
        </p>
        <label className="field">
          <span className="lbl">guidance (optional — blank sends a bare “continue”)</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Optional steering note, sent to the agent as if typed by a human. Leave blank to just nudge it to continue."
          />
        </label>
        <div className="row">
          <Button {...look({ kind: "success" })} isDisabled={pending} onPress={() => void nudge.run()}>
            Nudge
          </Button>
          <Button {...look({})} isDisabled={pending} onPress={onRequeue}>
            Re-queue
          </Button>
          <div className="spacer" />
        </div>
      </div>
    </>
  );
}

// ---------- header controls ----------

/** Abort is available from any non-terminal state EXCEPT `rolling_back` — a mechanical merge in
 *  flight with no live agent to stop. HAND-ROLLED: a pre-flight confirm() must be able to bail
 *  WITHOUT the action having already disabled the button and toasted. */
function AbortButton({ task }: { task: TaskView }) {
  const { run, pending } = useAction(() => api("POST", "/work/" + task.id + "/abort"), { success: "task aborted" });
  const onPress = () => {
    const msg =
      task.status === "in_progress"
        ? "Abort this in-progress task? The agent is stopped and its worktree + branch are discarded without merging."
        : "Abort this task? Its worktree + branch are discarded without merging.";
    if (!confirm(msg)) return;
    void run();
  };
  return (
    <Button {...look({ kind: "danger-outline" })} isDisabled={pending} onPress={onPress}>
      Abort task
    </Button>
  );
}

/** Roll back: create a deliberate ROLLBACK TASK (from the built-in `rollback` template) that reverts
 *  this merged task's change AND repairs any fallout, then flows through the normal dispatch → CI
 *  gate → review → merge → post-merge-verify pipeline like any task — NOT a mechanical bypass.
 *  Offered only for a merged task whose merge range was recorded. HAND-ROLLED for the same reason as
 *  Abort: confirm() first, so no unconditional disable. */
function RollbackButton({ task }: { task: TaskView }) {
  const navigate = useNavigate();
  const { run, pending } = useAction(
    async () => {
      // Created from the built-in `rollback` template via the unified work surface: a rollback is
      // the one workspace-level LEAF still created directly (kind:'rollback'), and the server
      // renders {{task}}/{{sha}} into the prompt.
      const created = await api<{ id?: string }>("POST", "/workspaces/" + task.workspace_id + "/work", {
        kind: "rollback",
        template: "rollback",
        vars: { task: task.id, sha: task.merged_sha },
      });
      // Jump to the new task so the operator can follow it through the pipeline.
      if (created && created.id) navigate("/task/" + created.id);
    },
    { success: "rollback task created ✓" },
  );

  const onPress = () => {
    if (
      !confirm(
        "Create a rollback task for this merged task? An agent reverts its change " +
          "(commit " +
          (task.merged_sha || "").slice(0, 12) +
          ") and repairs any fallout — " +
          "dependents, tests, docs, revert conflicts — then it flows through the " +
          "normal CI gate → review → merge pipeline like any task.",
      )
    )
      return;
    void run();
  };

  return (
    <Button {...look({ kind: "danger-outline" })} isDisabled={pending} onPress={onPress}>
      Roll back
    </Button>
  );
}

// ---------- the page ----------

type TaskData = {
  task: TaskView;
  dir: Workspace | null;
  chain: ChainEstimate | null;
  events: TaskEvent[];
  rollup: DependentRollup | null;
};

export function TaskDetail({ taskId }: { taskId: string }) {
  const version = useRefreshVersion();
  const metaVersion = useStateMetaVersion();

  const { data, error } = useAsync<TaskData>(async () => {
    const task = await api<TaskView>("GET", "/work/" + taskId);
    const dirs = await api<Workspace[]>("GET", "/workspaces");
    const dir = dirs.find((x) => x.id === task.workspace_id) || null;

    // All three below are BEST-EFFORT: a fetch failure omits the panel rather than breaking the
    // detail view. The task's OWN estimate rides on `task.estimate` (shown in the meta grid).
    const est = await api<{ chain?: ChainEstimate }>("GET", "/work/" + taskId + "/estimate").catch(() => null);
    const events = await api<TaskEvent[]>("GET", "/work/" + taskId + "/events").catch(() => [] as TaskEvent[]);
    // The sibling LEAF tasks in this workspace, for the dependent-subtree rollup. null (not []) on
    // failure so the rollup is skipped rather than asserted empty.
    const siblingWork = await api<WorkItem[]>("GET", "/work?workspace=" + encodeURIComponent(task.workspace_id)).catch(
      () => null,
    );
    const siblings = siblingWork ? workLeaves(siblingWork) : null;
    const rollup = siblings ? dependentRollup(task.id, siblings) : null;

    return { task, dir, chain: est?.chain ?? null, events, rollup };
  }, [taskId, version, metaVersion]);

  // The vanilla painted `<div class="empty">error: …</div>` and nothing else when a view threw.
  if (error && !data) return <div className="empty">{"error: " + error.message}</div>;
  if (!data) return null;
  const { task, dir, chain, events, rollup } = data;

  const eff = effStatus(task);
  // Abort is available from any non-terminal state (TERMINAL_STATUSES comes from the server meta),
  // EXCEPT `rolling_back` — a mechanical merge in flight with no live agent to stop.
  const canAbort = !TERMINAL_STATUSES.includes(task.status) && task.status !== "rolling_back";
  // Offered only for a merged task whose merge range was recorded (older merges have no commit).
  const canRollback =
    task.status === "merged" && !!task.merge_base_sha && !!task.merged_sha && task.merge_base_sha !== task.merged_sha;
  const rescue = rescueNote(events, task.status);

  return (
    <div>
      {/* `.crumbs` is a plain block — the " / " separators are REAL rendered text. */}
      <div className="crumbs">
        <Link to="/projects">Projects</Link>
        {" / "}
        <Link to={"/workspace/" + task.workspace_id}>{dir ? dir.label || dir.path : task.workspace_id}</Link>
        {" / "}
        <span aria-current="page">{task.id}</span>
      </div>

      <div className="row between">
        <h1>
          <span className="mono">{task.id}</span>
        </h1>
        <div className="row">
          {isLive(task) ? <OpenTerminalButton taskId={task.id} label="⌗ Open terminal" kind="ghost" /> : null}
          <div>
            <TaskChips task={task} plan kind />
          </div>
          {canAbort ? <AbortButton task={task} /> : null}
          {canRollback ? <RollbackButton task={task} /> : null}
        </div>
      </div>

      {/* NEEDS-YOUR-INPUT card — surfaced FIRST (above the metadata) when the live agent is wedged at
          a human-only prompt, so the highest-attention state and its resolve controls read
          immediately. Resolves on the next SSE update once the agent moves past the prompt. */}
      {eff === "needs_user_input" ? <NeedsUserInputPanel task={task} /> : null}

      <MetaPanel task={task} />

      <Timeline events={events} />

      {/* blocked-by — what this task is waiting on, with each blocker's current status. Dead blockers
          (terminal, never-merging) are flagged so a stuck `blocked` task is obvious. */}
      {Array.isArray(task.blocked_by) && task.blocked_by.length ? (
        <ListPanel
          heading={task.status === "blocked" ? "Blocked — waiting on:" : "Depends on:"}
          className="blocked-panel"
          chainLine={chainLine(chain)}
        >
          {task.blocked_by.map((bid) => (
            <BlockerRow
              key={bid}
              id={bid}
              status={(task.blockerStates && task.blockerStates[bid]) || "unknown"}
              dead={(task.deadBlockers || []).includes(bid)}
            />
          ))}
        </ListPanel>
      ) : null}

      <RollupPanel rollup={rollup} />

      <Block heading="Prompt" text={task.prompt || "—"} />

      {/* An aborted task WITH revert_reason merged, then failed the post-merge verify and was
          auto-reverted off main. WITHOUT one it was a dispatch give-up or an operator abort. */}
      {task.status === "aborted" && task.revert_reason ? (
        <RevertedPanel task={task} />
      ) : task.status === "aborted" && task.last_dispatch_error ? (
        <DispatchFailedPanel task={task} />
      ) : null}

      {/* `key` remounts the poll + its cached text when a different task's page opens — what the
          module-level `liveOutputCacheId` guard used to do. */}
      {isLive(task) ? <LiveOutputPanel key={task.id} taskId={task.id} /> : null}

      {task.review_notes ? <Block heading="Review notes" text={task.review_notes} /> : null}
      {task.summary ? <Block heading="Agent summary" text={task.summary} /> : null}

      {/* WHY BUTCHR INTERVENED — for a task butchr FORCE-moved to review (the agent died, ran away, or
          blew the resume cap), surface its own account of why. This is butchr's text, not the
          agent's, so no transcript can carry it; it is persisted as the transition's
          `task_events.note` and also appears on the Timeline. */}
      {rescue ? <Block heading="Why butchr moved this to review" text={rescue} /> : null}

      {/* Only offered once the task has a session to read. `key` resets the lazy page cache. */}
      {task.session_id ? <TranscriptPanel key={task.id} taskId={task.id} /> : null}

      <ResponderBanner task={task} />

      {task.status === "in_review" ? <ReviewPanel task={task} releaseMode={!!(dir && dir.release_mode)} /> : null}
      {task.status === "idea" ? <IdeaPanel task={task} /> : null}
      {task.status === "spec_review" ? <SpecReviewPanel task={task} /> : null}
      {task.status === "needs_info" && task.plan_preview ? <PlanReviewPanel task={task} /> : null}
      {task.status === "needs_info" && !task.plan_preview ? <AnswerPanel task={task} /> : null}
      {task.status === "in_progress" && task.idle ? <IdlePanel task={task} /> : null}
    </div>
  );
}
