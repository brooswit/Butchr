// The TASK view — the task detail / review page (`#/task/:id`). It owns everything that page
// paints: the crumbs + header controls (attach-terminal, abort, roll back), the needs-your-input
// card, the metadata grid and its label formatters, the audit timeline and the rescue note, the
// blocked-by list and the dependent-subtree rollup, the live-output panel, the agent transcript,
// and the five feedback control surfaces (in_review diff review / idea / spec_review / needs_info /
// idle). Extracted from app.js (RFC Phase 2, story st-ffcc9cec).
//
// It imports only LEAVES — core/ (dom, format, api, state-meta, nav, action, work-graph),
// components/ (chips, panel), and the sibling views/diff.js whose ONLY caller is renderTask.
// It never imports app.js; see the header of core/nav.js for why that edge is fatal. The route
// dispatcher (renderRoute) stays in app.js and imports the two names exported here — that
// direction is fine; the reverse would drag app.js, which touches `document` at load, into the
// module graph of every view and break the DOM-free-at-load property the tests rest on.
//
// DOM-free at module load: every module-level binding below is a timer handle, a flag, a string,
// or a plain object. `document` is touched only inside a CALLED function (renderTask's post-mount
// wiring), so this module is importable under a non-browser runner.
//
// WHY THE MODULE-LEVEL STATE IS MODULE-LEVEL — do not "clean it up" into renderTask.
// The task page is rebuilt WHOLESALE on every SSE event. `liveOutputOpen` / `transcriptOpen` carry
// the operator's open/closed choice across that rebuild, and `liveOutputCache` / `transcriptState`
// carry the already-fetched content so a rebuild repaints it instead of flashing empty (or re-
// fetching). Function-local state would reset on every event and make both panels unusable. They
// have NO reader outside this module, so no setter is exported: app.js never writes them (contrast
// views/diff.js, whose pendingInlineRestore IS written from app.js's SSE restore path and therefore
// exports setPendingInlineRestore — an imported `let` cannot be assigned across modules).
//
// `stopLiveOutput` is exported because the poll timer must not survive a navigation: renderRoute
// clears it up front on every route change, and renderTask restarts it if the task is still live.
// `htmlOf` is the TRANSITIONAL bridge that lets the innerHTML templates below consume the
// now-node-returning chip components. A later subtask converts those templates and drops it.
import { el, esc, htmlOf } from "../core/dom.js";
import { fmtDuration, fmtTime } from "../core/format.js";
import { api, terminalToast, toast } from "../core/api.js";
// TERMINAL_STATUSES is an `export let` reassigned once /api/state-meta lands; the ES live binding
// propagates the new value here. Read it at CALL time — never destructure it into a local const.
import { TERMINAL_STATUSES, statusLabel } from "../core/state-meta.js";
import {
  chip,
  effStatus,
  feedbackStepLabel,
  livenessChip,
  tagChips,
  taskChips,
} from "../components/chips.js";
import {
  block,
  blockerRow,
  ciBadge,
  collapsible,
  conformanceBadge,
  listPanel,
  rollupPanel,
} from "../components/panel.js";
import { backToWorkspace, mount, render } from "../core/nav.js";
import { action } from "../components/button.js";
import {
  gatedSubtree,
  isCompleteStatus,
  reverseDeps,
  workLeaves,
} from "../core/work-graph.js";
// The diff reader (parse + highlight + inline review comments). renderTask is its only caller,
// so this import moved here with the view.
import { composeReviewNote, renderDiff, wireDiff } from "./diff.js";

// The agent is live (attachable) whenever butchr owns a launched agent for it
// (has_agent): a running/idle `in_progress` build agent until butchr tears it down.
// Gating on has_agent mirrors the /terminal endpoint exactly — the button shows iff the
// attach would succeed. (Agents are addressed BY NAME; no pane id is stored.)
function isLive(t) {
  return !!t.has_agent;
}

// Open a GUI terminal attached to a running task's live agent pane. Routed through
// action(), which owns the disable/try/toast/re-enable dance; `btn` is optional
// (the term-link callers pass none). onDone re-enables on success (action's catch
// re-enables on failure) — opening a terminal never navigates, so no render().
async function openTaskTerminal(id, btn) {
  await action(btn, async () => {
    const r = await api("POST", "/work/" + id + "/terminal");
    terminalToast(r);
  }, { onDone: () => { if (btn) btn.disabled = false; } });
}

// Does the captured pane (needs_user_input_context) look like the dev-channels consent /
// folder-trust / numbered-proceed prompt whose SAFE answer is option "1"? Mirrors the
// '1'-response rules in src/startup-confirm.ts so the one-click Confirm button is offered
// ONLY where nudging "1" is the right move; any other prompt falls back to Open terminal.
function isOneKeyConfirmPrompt(ctx) {
  if (!ctx) return false;
  return /local development|development channel|trust the files|do you trust|(^|\n)\s*[❯>*]?\s*1\.\s*(yes|proceed|continue|i am|allow|trust)/i.test(ctx);
}

// The PROMINENT "needs your input" card for a work item whose LIVE agent is wedged at a
// human-only OS/CLI prompt (effStatus === "needs_user_input"). The highest-attention surface
// on the task detail: it states the agent is alive-but-blocked, shows the captured pane so the
// human sees exactly WHAT prompt is blocking, and offers the tools to resolve it in place —
//  • Open terminal — reuses POST /api/work/:id/terminal to attach a GUI terminal to the live
//    pane (the agent is in_progress/attachable) so the human can type the answer.
//  • Confirm — only for the dev-channels-style numbered prompt: reuses POST /api/work/:id/nudge
//    with {text:"1"} (a bare nudge of "1\n" confirms the consent dialog). The agent then moves
//    past the prompt and the safety-net watcher clears the flag on the next clean pane read, so
//    the card resolves on the next SSE update — no explicit "resolve" action needed.
function needsUserInputPanel(t) {
  const ctx = (t.needs_user_input_context || "").trim();
  const panel = el("div", { class: "panel needs-input-panel" });
  panel.innerHTML = `
    <div class="ni-head">
      <span class="ni-icon" aria-hidden="true">⌨</span>
      <h2>Needs your input</h2>
    </div>
    <p class="ni-lead">This agent is <strong>alive but blocked</strong> at a prompt only a
      human can answer — it can't proceed until you respond in its live terminal.</p>
    ${ctx
      ? `<div class="ni-ctx-label">What it's waiting on</div><pre class="block ni-ctx">${esc(ctx)}</pre>`
      : `<p class="muted ni-noctx">No captured prompt text — open the terminal to see what it's waiting on.</p>`}
    <div class="ni-actions"></div>`;
  const actions = panel.querySelector(".ni-actions");

  const term = el("button", { class: "btn" }, "⌗ Open terminal to answer");
  term.addEventListener("click", () => openTaskTerminal(t.id, term));
  actions.appendChild(term);

  if (isOneKeyConfirmPrompt(ctx)) {
    const confirmBtn = el("button", { class: "btn ghost", title: "send “1” to the live pane — the safe proceed/consent choice" }, "Confirm (send “1”)");
    confirmBtn.addEventListener("click", () => action(confirmBtn,
      () => api("POST", "/work/" + t.id + "/nudge", { text: "1" }),
      { success: "sent “1” — the agent should continue past the prompt", onDone: () => { confirmBtn.disabled = false; } }));
    actions.appendChild(confirmBtn);
  }
  return panel;
}

// ---------- live output panel state ----------
// A single poll timer drives the task page's "Live output" panel. It must not
// survive a navigation/re-render (the page is rebuilt on every SSE event), so
// render() clears it up front and renderTask restarts it if appropriate.
let liveOutputTimer = null;
let liveOutputOpen = true; // panel open/closed, persisted across re-renders
let liveOutputCache = ""; // last text, so SSE rebuilds don't flash empty
let liveOutputCacheId = null; // task id the cache belongs to
export function stopLiveOutput() {
  if (liveOutputTimer) { clearInterval(liveOutputTimer); liveOutputTimer = null; }
}

// ---------- task detail / review ----------
// Compact vertical AUDIT TIMELINE of a task's status transitions (oldest → newest):
// one row per change with the transition (from → to chips) and the short note that
// explains why it moved, plus a relative timestamp (full ISO on hover). Driven by
// GET /api/work/:id/events. Returns null when there are no recorded events.
function renderTimeline(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const panel = el("div", { class: "panel timeline-panel" });
  panel.appendChild(el("h2", { class: "panel-title" }, "Timeline"));
  const list = el("div", { class: "timeline" });
  for (const ev of events) {
    const transition = ev.from_status && ev.from_status !== ev.to_status
      ? `${htmlOf(chip(ev.from_status))}<span class="tl-arrow">→</span>${htmlOf(chip(ev.to_status))}`
      : htmlOf(chip(ev.to_status));
    const row = el("div", { class: "tl-event" });
    row.innerHTML = `
      <span class="tl-dot ${esc(ev.to_status)}"></span>
      <div class="tl-body">
        <div class="tl-head">
          <span class="tl-transition">${transition}</span>
          <span class="tl-time" title="${esc(ev.at)}">${esc(fmtTime(ev.at))}</span>
        </div>
        ${ev.note ? `<div class="tl-note">${esc(ev.note)}</div>` : ""}
      </div>`;
    list.appendChild(row);
  }
  panel.appendChild(list);
  return panel;
}

// The RESCUE NOTE for a task butchr force-moved to review, or null. butchr stamps its
// reason ("[butchr] moved to review automatically: ...") as the note of the transition
// INTO `in_review` (tasks.markInReview); an agent that submitted normally leaves a
// different note, so the prefix is what distinguishes a rescue. Only meaningful while the
// task still sits in review — once it merges or is re-worked, the Timeline keeps the
// history and the dedicated panel would be stale. Returns the LATEST such note (a task can
// be rescued, re-dispatched, and rescued again).
function rescueNote(events, status) {
  if (status !== "in_review" || !Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.to_status === "in_review" && typeof ev.note === "string") {
      return ev.note.startsWith("[butchr] moved to review automatically") ? ev.note : null;
    }
  }
  return null;
}

// Human label for a task's model: the requested model, and (when known and
// different) the model it actually ran under per the session transcript. An unset
// request shows "default", annotated with what the default resolved to if captured.
function modelLabel(t) {
  const want = (t.model || "").trim();
  const used = (t.model_used || "").trim();
  if (want && used && want !== used) return `${want} (ran as ${used})`;
  if (want) return want;
  if (used) return `default (${used})`;
  return "default";
}

// Compact token-usage summary built from the captured session totals. Returns "—"
// until any usage has been recorded. Numbers only → safe to inject as HTML.
function tokensLabel(t) {
  const inT = t.usage_input_tokens, outT = t.usage_output_tokens;
  const cr = t.usage_cache_read_tokens, cw = t.usage_cache_creation_tokens;
  const has = [inT, outT, cr, cw].some((n) => typeof n === "number" && n > 0);
  if (!has) return "—";
  const n = (v) => (typeof v === "number" ? v : 0).toLocaleString();
  const total = (inT || 0) + (outT || 0) + (cr || 0) + (cw || 0);
  return `${n(total)} total <span class="muted">· in ${n(inT)} · out ${n(outT)} `
    + `· cache r ${n(cr)} / w ${n(cw)}</span>`;
}

// Cost label. The session transcript records tokens but no dollar cost and butchr
// has no pricing table, so we show "—" (not tracked) rather than fabricate a number.
function costLabel(t) {
  return typeof t.cost_usd === "number" ? `$${t.cost_usd.toFixed(4)}` : "— (not tracked)";
}

// ROUGH duration estimate, rendered as a loose p50–p90 RANGE with its sample size —
// deliberately hedged ("~", "rough"), never a promise. Prefers the to-merge range,
// falling back to to-review; says "insufficient data" when history is too thin.
// Numbers are formatted via fmtDuration; the bucket/basis annotation is escaped.
const INSUFFICIENT = `insufficient data <span class="muted">· not enough history yet</span>`;
function fmtEstimate(est) {
  if (!est) return "—";
  if (est.insufficient) return INSUFFICIENT;
  const r = est.toMerge || est.toReview;
  if (!r) return INSUFFICIENT;
  const label = est.toMerge ? "to merge" : "to review";
  const bucket = est.basis === "overall" ? "all tasks" : `${est.bucket} ${est.basis}`;
  return `est ~${fmtDuration(r.p50Ms)}–${fmtDuration(r.p90Ms)} `
    + `<span class="muted">· ${label} · n=${est.n} · ${esc(bucket)} · rough</span>`;
}

// Critical-path estimate across a task's dependency chain (a blocked task's
// blockers). Returns null when there's nothing pending to chain.
function fmtChain(chain) {
  if (!chain || chain.taskCount === 0 || chain.p50Ms == null) return null;
  const n = chain.taskCount;
  const partial = chain.insufficient
    ? ' <span class="muted">· partial — some tasks lack history</span>'
    : "";
  return `est ~${fmtDuration(chain.p50Ms)}–${fmtDuration(chain.p90Ms)} `
    + `<span class="muted">· critical path across ${n} task${n === 1 ? "" : "s"} · rough</span>${partial}`;
}

// ---------- agent transcript panel state ----------
// The transcript is large and read straight off disk, so we fetch it lazily (only
// on first open) and page it. `transcriptOpen` persists the open/closed choice
// across SSE re-renders; `transcriptState` caches the loaded turns for ONE task at
// a time (reset when a different task's panel is built).
let transcriptOpen = false;
const transcriptState = { id: null, turns: [], total: 0, loaded: false, loading: false };
const TRANSCRIPT_PAGE = 200;

// Render one transcript item (one content block) as a labelled, monospace row.
function renderTranscriptItem(it) {
  const row = el("div", { class: `ts-item ts-${esc(it.kind)} role-${esc(it.role)}` });
  const time = it.ts
    ? `<span class="ts-time" title="${esc(it.ts)}">${esc(fmtTime(it.ts))}</span>` : "";
  const trunc = it.truncated ? '<span class="ts-trunc"> … (truncated)</span>' : "";
  let label, bodyHtml;
  if (it.kind === "tool_use") {
    label = `<span class="ts-label tool">⚙ ${esc(it.tool)}</span>`;
    bodyHtml = it.args ? `<code class="ts-args">${esc(it.args)}</code>` : "";
  } else if (it.kind === "tool_result") {
    label = `<span class="ts-label result">↳ result</span>`;
    bodyHtml = `<pre class="ts-pre">${esc(it.text || "")}${trunc}</pre>`;
  } else if (it.kind === "thinking") {
    label = `<span class="ts-label thinking">${esc(it.role)} · thinking</span>`;
    bodyHtml = `<pre class="ts-pre">${esc(it.text || "")}${trunc}</pre>`;
  } else {
    label = `<span class="ts-label ${esc(it.role)}">${esc(it.role)}</span>`;
    bodyHtml = `<pre class="ts-pre">${esc(it.text || "")}${trunc}</pre>`;
  }
  row.innerHTML = `<div class="ts-head">${label}${time}</div>${bodyHtml}`;
  return row;
}

// Build the collapsible "Agent transcript" panel for a task. Lazy: nothing is
// fetched until the panel is opened; subsequent pages append via "Load more".
function renderTranscriptPanel(id) {
  // New task → drop any cached turns from a previously-viewed one.
  if (transcriptState.id !== id) {
    transcriptState.id = id;
    transcriptState.turns = [];
    transcriptState.total = 0;
    transcriptState.loaded = false;
    transcriptState.loading = false;
  }

  const body = el("div", { class: "transcript-body" });

  const renderBody = () => {
    body.innerHTML = "";
    if (transcriptState.loading && !transcriptState.turns.length) {
      body.appendChild(el("div", { class: "ts-empty" }, "loading transcript…"));
      return;
    }
    if (transcriptState.loaded && !transcriptState.turns.length) {
      body.appendChild(el("div", { class: "ts-empty" }, "No transcript available for this task yet."));
      return;
    }
    for (const it of transcriptState.turns) body.appendChild(renderTranscriptItem(it));
    if (transcriptState.turns.length < transcriptState.total) {
      const more = el("button", { class: "btn ghost ts-more" },
        `Load more (${transcriptState.turns.length} of ${transcriptState.total})`);
      more.addEventListener("click", () => load(more));
      body.appendChild(more);
    }
  };

  const load = async (moreBtn) => {
    if (transcriptState.loading) return;
    transcriptState.loading = true;
    if (moreBtn) moreBtn.disabled = true; else renderBody();
    try {
      const offset = transcriptState.turns.length;
      const r = await api("GET",
        `/work/${id}/transcript?offset=${offset}&limit=${TRANSCRIPT_PAGE}`);
      transcriptState.turns = transcriptState.turns.concat(r.turns || []);
      transcriptState.total = r.total || 0;
      transcriptState.loaded = true;
    } catch (e) {
      transcriptState.loaded = true;
      toast(e.message, true);
    } finally {
      transcriptState.loading = false;
      renderBody();
    }
  };

  const { panel } = collapsible({
    title: "Agent transcript",
    titleClass: "ts-title",
    meta: "what the agent did · read-only",
    metaClass: "ts-hint",
    body,
    open: transcriptOpen,
    panelClass: "panel transcript",
    headClass: "transcript-head",
    onToggle: (open) => {
      transcriptOpen = open;
      if (open && !transcriptState.loaded && !transcriptState.loading) load();
      else renderBody();
    },
  });

  if (transcriptOpen) {
    if (!transcriptState.loaded && !transcriptState.loading) load();
    else renderBody();
  }
  return panel;
}

// Sub-task PROGRESS ROLLUP — for a task that GATES others (its id appears in their
// blocked_by), summarize how far the
// dependent sub-tree has landed. Walks the reversed edges of the workspace's task
// list (no extra API field needed) to find the transitive sub-tree, then counts the
// merged ones. Returns null when the task gates nothing, so a leaf task shows no
// rollup. `direct` is the immediate dependents (for the per-child status list);
// `total`/`merged` cover the whole transitive sub-tree.
function dependentRollup(rootId, tasks) {
  const dependentsOf = reverseDeps(tasks);
  const directIds = dependentsOf.get(rootId) || [];
  if (directIds.length === 0) return null;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const subtree = [...gatedSubtree(rootId, dependentsOf)].map((sid) => byId.get(sid)).filter(Boolean);
  const direct = directIds.map((did) => byId.get(did)).filter(Boolean);
  // COMPLETE, not just `merged` — a dependent STORY completes at status `done`, so the merged-only
  // count under-reported any subtree containing one (mirrors the graph sub-bar; see isCompleteStatus).
  const merged = subtree.filter((t) => isCompleteStatus(t.status)).length;
  return { direct, total: subtree.length, merged };
}

export async function renderTask(id) {
  const t = await api("GET", "/work/" + id);
  const dirs = await api("GET", "/workspaces");
  const dir = dirs.find((x) => x.id === t.workspace_id);

  const wrap = el("div");
  wrap.appendChild(el("div", {
    class: "crumbs",
    html: `<a href="#/projects">Projects</a> / <a href="#/workspace/${esc(t.workspace_id)}">${esc(dir ? (dir.label || dir.path) : t.workspace_id)}</a> / <span aria-current="page">${esc(t.id)}</span>`,
  }));
  const headerRight = el("div", { class: "row" });
  if (isLive(t)) {
    const term = el("button", { class: "btn ghost" }, "⌗ Open terminal");
    term.addEventListener("click", () => openTaskTerminal(t.id, term));
    headerRight.appendChild(term);
  }
  headerRight.appendChild(el("div", {}, taskChips(t, { plan: true, kind: true })));
  // Abort is available from any non-terminal state (TERMINAL_STATUSES comes from the
  // server meta), EXCEPT `rolling_back` — a mechanical merge in flight with no live
  // agent to stop.
  const canAbort = !TERMINAL_STATUSES.includes(t.status) && t.status !== "rolling_back";
  if (canAbort) {
    const abortBtn = el("button", { class: "btn ghost danger-outline", id: "abort" }, "Abort task");
    headerRight.appendChild(abortBtn);
  }
  // Roll back: create a deliberate ROLLBACK TASK (from the built-in `rollback`
  // template) that reverts this merged task's change AND repairs any fallout, then
  // flows through the normal dispatch → CI gate → review → merge → post-merge-verify
  // pipeline like any task — NOT a mechanical bypass. Offered only for a merged task
  // whose merge range was recorded (older merges have no commit to pre-fill).
  const canRollback = t.status === "merged"
    && !!t.merge_base_sha && !!t.merged_sha && t.merge_base_sha !== t.merged_sha;
  if (canRollback) {
    headerRight.appendChild(el("button", { class: "btn ghost danger-outline", id: "rollback" }, "Roll back"));
  }
  wrap.appendChild(el("div", { class: "row between" }, [
    el("h1", { html: `<span class="mono">${esc(t.id)}</span>` }),
    headerRight,
  ]));

  // NEEDS-YOUR-INPUT card — surfaced FIRST (above the metadata) when the live agent is wedged
  // at a human-only prompt, so the highest-attention state and its resolve controls (open
  // terminal / one-click confirm) read immediately. Resolves on the next SSE update once the
  // agent moves past the prompt and the safety-net watcher clears the flag.
  if (effStatus(t) === "needs_user_input") wrap.appendChild(needsUserInputPanel(t));

  // metadata
  const meta = el("div", { class: "panel" });
  meta.innerHTML = `<div class="meta-grid">
    <div class="k">status</div><div class="v">${esc(statusLabel(effStatus(t)))}</div>
    ${t.liveness ? `<div class="k">liveness</div><div class="v" title="${esc(t.liveness.evidence)}">${htmlOf(livenessChip(t.liveness))}</div>` : ""}
    ${Array.isArray(t.tags) && t.tags.length ? `<div class="k">tags</div><div class="v">${htmlOf(tagChips(t))}</div>` : ""}
    ${Array.isArray(t.allowlist) && t.allowlist.length ? `<div class="k">allowlist</div><div class="v">${t.allowlist.map((a) => `<code>${esc(a)}</code>`).join(" ")}</div>` : ""}
    <div class="k">priority</div><div class="v">${esc(String(t.priority ?? 0))}</div>
    <div class="k">created</div><div class="v">${esc(t.created_at || "—")}</div>
    <div class="k">started</div><div class="v">${esc(t.started_at || "—")}</div>
    <div class="k">completed</div><div class="v">${esc(t.completed_at || "—")}</div>
    <div class="k">merged</div><div class="v">${esc(t.merged_at || "—")}</div>
    ${t.estimate ? `<div class="k">est. duration</div><div class="v">${fmtEstimate(t.estimate)}</div>` : ""}
    <div class="k">model</div><div class="v">${esc(modelLabel(t))}</div>
    <div class="k">tokens</div><div class="v">${tokensLabel(t)}</div>
    <div class="k">cost</div><div class="v">${esc(costLabel(t))}</div>
  </div>`;
  wrap.appendChild(meta);

  // Rough critical-path estimate across this task's dependency chain (a blocked
  // task's blockers). Best-effort — a fetch failure or a
  // null chain just omits the line. The task's OWN estimate already rides on
  // t.estimate (shown in the meta grid above).
  const estData = await api("GET", "/work/" + id + "/estimate").catch(() => null);
  const chainLine = estData ? fmtChain(estData.chain) : null;

  // audit timeline — the task's status-transition history (best-effort: a fetch
  // failure just omits the panel rather than breaking the detail view).
  const events = await api("GET", "/work/" + id + "/events").catch(() => []);
  const timeline = renderTimeline(events);
  if (timeline) wrap.appendChild(timeline);

  // blocked-by — what this task is waiting on. Shown whenever the task has a
  // dependency set, with each blocker's current status; dead blockers (terminal,
  // never-merging) are flagged so a stuck `blocked` task is obvious. The list of
  // blocker statuses comes back on the task view (blockerStates), computed below.
  if (Array.isArray(t.blocked_by) && t.blocked_by.length) {
    const dead = new Set(t.deadBlockers || []);
    const head = t.status === "blocked" ? "Blocked — waiting on:" : "Depends on:";
    const rows = t.blocked_by.map((bid) => blockerRow(
      bid,
      (t.blockerStates && t.blockerStates[bid]) || "unknown",
      { dead: dead.has(bid) },
    ));
    wrap.appendChild(listPanel(head, rows, { chainLine, cls: "blocked-panel" }));
  }

  // sub-task progress rollup — if this task GATES others (its id is in their
  // blocked_by), summarize how far the dependent sub-tree has merged: a fraction, a
  // progress bar, and the direct children with their statuses. Computed purely
  // client-side from the workspace's task list (no extra API field); best-effort —
  // a fetch failure just omits the panel — and nothing renders for a task with no
  // dependents. Re-fetched on each render so it live-updates via the SSE re-render.
  // The sibling LEAF tasks in this workspace (for the dependent-subtree rollup) — the leaf
  // members of the unified work list. null (not []) on failure so the rollup is skipped.
  const siblingWork = await api("GET", "/work?workspace=" + encodeURIComponent(t.workspace_id)).catch(() => null);
  const siblings = siblingWork ? workLeaves(siblingWork) : null;
  const rollup = siblings ? dependentRollup(t.id, siblings) : null;
  if (rollup) wrap.appendChild(rollupPanel(rollup));

  // prompt
  block("Prompt", t.prompt || "—", wrap);

  // aborted with revert_reason — the task's merge was fast-forwarded into main but the
  // post-merge verify gate (build + tests) came back RED, so the merge was auto-reverted
  // off main and the task flagged as aborted. Surface that distinctly with the failing
  // build/test output. Re-queue re-launches the agent (worktree + branch were kept).
  // An aborted task WITHOUT revert_reason was a dispatch give-up or operator abort.
  if (t.status === "aborted" && t.revert_reason) {
    const panel = el("div", { class: "panel failed-panel" });
    panel.innerHTML = `
      <h2 class="panel-title">Merge auto-reverted off main</h2>
      <p class="muted lede">This branch merged, but the post-merge verify (build + tests) failed on the default branch, so the merge was reverted to keep main green. The branch + worktree were kept.</p>
      <pre class="block">${esc(t.revert_reason)}</pre>
      <div class="row panel-actions">
        <button class="btn" id="requeue">Re-queue</button>
        <small class="muted">Re-launches the agent (in-context) to fix the breakage, then it can be re-reviewed.</small>
      </div>`;
    wrap.appendChild(panel);
  } else if (t.status === "aborted" && t.last_dispatch_error) {
    const n = t.dispatch_attempts || 0;
    const panel = el("div", { class: "panel failed-panel" });
    panel.innerHTML = `
      <h2 class="panel-title">Dispatch failed</h2>
      <p class="muted lede">Failed after ${n} dispatch attempt${n === 1 ? "" : "s"}. The agent never started.</p>
      <pre class="block">${esc(t.last_dispatch_error || "(no error recorded)")}</pre>
      <div class="row panel-actions">
        <button class="btn" id="requeue">Re-queue</button>
        <small class="muted">Clears the retry state and dispatches again from scratch.</small>
      </div>`;
    wrap.appendChild(panel);
  }

  // live output — best-effort snapshot of the agent's recent terminal output,
  // polled while the panel is open and the task still has a live pane. This is a
  // convenience view; the git diff below stays the source of truth for review.
  if (isLive(t)) {
    if (liveOutputCacheId !== t.id) { liveOutputCache = ""; liveOutputCacheId = t.id; }
    const pre = el("pre", { class: "block live-output-body" },
      liveOutputCache || "loading recent output…");

    const poll = async () => {
      try {
        const r = await api("GET", "/work/" + t.id + "/output");
        const text = (r.output || "").trimEnd();
        liveOutputCache = text;
        // Keep the view pinned to the newest output if already scrolled to bottom.
        const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
        pre.textContent = text || "(no recent output)";
        if (atBottom) pre.scrollTop = pre.scrollHeight;
      } catch { /* transient — keep whatever was there */ }
    };
    const startPolling = () => { stopLiveOutput(); poll(); liveOutputTimer = setInterval(poll, 2500); };

    const { panel } = collapsible({
      title: "Live output",
      titleClass: "lo-title",
      meta: "best-effort · updates every few seconds",
      metaClass: "lo-hint",
      body: pre,
      open: liveOutputOpen,
      panelClass: "panel live-output",
      headClass: "live-output-head",
      onToggle: (open) => {
        liveOutputOpen = open;
        if (open) startPolling(); else stopLiveOutput();
      },
    });
    if (liveOutputOpen) startPolling();
    wrap.appendChild(panel);
  }

  // review notes
  if (t.review_notes) block("Review notes", t.review_notes, wrap);

  // agent summary (from request_review)
  if (t.summary) block("Agent summary", t.summary, wrap);

  // WHY BUTCHR INTERVENED — for a task butchr FORCE-moved to review (the agent died, ran
  // away, or blew the resume cap), surface its own account of why. This is butchr's text,
  // not the agent's, so the session transcript below cannot carry it; it is persisted as the
  // transition's `task_events.note` and also appears on the Timeline. Rendered from the
  // already-fetched `events` — no extra route, no extra column. Omitted entirely for a task
  // that reached review normally (no rescue note ⇒ no panel).
  const rescue = rescueNote(events, t.status);
  if (rescue) block("Why butchr moved this to review", rescue, wrap);

  // agent transcript — a readable, lazily-fetched view of what the session's agent
  // actually did (prose, thinking, tool calls + truncated results). Collapsible and
  // read-only; only offered once the task has a session to read. The body is fetched
  // on first open (transcripts get large) and paged via a "Load more" button.
  if (t.session_id) wrap.appendChild(renderTranscriptPanel(t.id));

  // AWAITING-WHO BANNER. For a task awaiting feedback, surface WHO is expected to act — the
  // server-computed STRUCTURAL `pending_responder` (story|cto|ceo|user). `user` is emphasized
  // ("awaiting you"); `cto` / `story` are muted (an agent — the CTO, or the story leader —
  // handles it, but you can also act). butchr is responder-agnostic: the action controls
  // below render regardless. Null pending_responder (non-feedback state) shows no banner.
  // REVAMP-4 P3a: `ceo` (a project container's supervisor) is DORMANT — the server never emits
  // it (no project nodes in prod), so a defensive `ceo` value would fall to the muted `else`
  // (awaiting-cto styling); the dedicated CEO banner is P3c, when the CEO surface lands.
  if (t.pending_responder) {
    const stepLbl = feedbackStepLabel(t);
    const stepStr = stepLbl ? ` (${esc(stepLbl)})` : "";
    let html;
    if (t.pending_responder === "user") {
      html = `<strong>Awaiting you</strong> — this${stepStr} is assigned to <strong>you</strong>. Act in the controls below.`;
    } else if (t.pending_responder === "story") {
      html = `<strong>Awaiting the story leader</strong> — this${stepStr} is handled automatically by the story leader agent. You can also act in the controls below.`;
    } else {
      html = `<strong>Awaiting the CTO agent</strong> — this${stepStr} is handled automatically by this workspace's CTO agent. You can also act in the controls below.`;
    }
    wrap.appendChild(el("div", {
      class: "responder-banner " + (t.pending_responder === "user" ? "awaiting-you" : "awaiting-cto"),
      html,
    }));
  }

  // Shared submit wrapper for the feedback control panels below: POST `path` (relative
  // to this task) with `body`, toast `successMsg`, then return to the workspace list
  // (the next thing you want after acting). Each panel builder closes over this and
  // wires its OWN buttons before it's appended, so a control's build + wire live in one
  // place instead of split across a panel block here and a getElementById block far below.
  const submitTo = (btn, path, body, successMsg) =>
    action(btn, () => api("POST", "/work/" + id + path, body), {
      success: successMsg,
      onDone: () => backToWorkspace(t.workspace_id),
    });

  // diff + review controls (when in_review)
  if (t.status === "in_review") {
    // CI GATE badge — shown BEFORE the diff. Reflects the build/test job butchr
    // runs in the task's worktree on the in_review transition; updates live via the
    // SSE-driven re-render when CI flips running→pass/fail.
    wrap.appendChild(ciBadge(t));
    // SPEC-CONFORMANCE badge — next to the CI badge. Reflects the read-only reviewer
    // that judges whether the diff satisfies the prompt; null when it didn't run.
    const confBadge = conformanceBadge(t);
    if (confBadge) wrap.appendChild(confBadge);

    // MAJOR-VERSION DOUBLE-CONFIRM banner. In a release_mode workspace a major-bump task
    // does NOT merge on Approve — Approve PARKS it. Landing it is the HUMAN's deliberate
    // double-confirm: two CONSECUTIVE Confirm clicks (streak 0→1→2); ANY other action
    // (Approve, Request change, re-review, …) resets the streak to 0. Shown only off the
    // workspace view's release_mode (no hardcoded id) + the task's declared major bump, so
    // it's invisible everywhere else. The streak count comes straight off the task view.
    if (dir && dir.release_mode && t.version_bump === "major") {
      const n = t.major_confirm_count || 0;
      const banner = el("div", { class: "panel major-confirm-panel" });
      banner.innerHTML = `
        <h2 class="panel-title">Awaiting major-version confirmation (${esc(String(n))}/2)</h2>
        <p class="muted lede">This task declares a <strong>major</strong> version bump, so merging it is a deliberate human double-confirm — <strong>Approve does not merge it</strong>. Click <strong>Confirm major version</strong> <strong>twice in a row</strong> (streak ${esc(String(n))}/2); the second consecutive confirm lands the merge. <strong>Any other action</strong> (Approve, Request change, re-review, re-declaring the bump) <strong>resets the streak to 0</strong>.</p>
        <div class="row">
          <button class="btn danger" id="confirm-major">Confirm major version (${esc(String(n))}/2)</button>
          <small class="muted">Two consecutive confirms required — this is the human gate on a breaking release.</small>
        </div>`;
      banner.querySelector("#confirm-major").addEventListener("click", (ev) => {
        let merged = false;
        action(ev.target, async () => {
          const r = await api("POST", "/work/" + id + "/confirm-major");
          if (r && r.conflictSentBack) {
            toast("Merge conflict — sent back to the agent to resolve");
            merged = true;
          } else if (r && r.revertedOnRed) {
            toast("Merged but verify FAILED — auto-reverted off main", true);
            merged = true;
          } else if (r && r.awaitingMajorConfirm) {
            const c = (r.task && r.task.major_confirm_count) || 0;
            toast(`Major-version confirmation ${c}/2 — one more consecutive confirm to merge`);
          } else {
            // Streak reached 2 → merged. The returned task view carries released_version.
            merged = true;
            const v = r && r.released_version;
            toast(`Confirmed ✓ — merged${v ? ` (v${v})` : ""}`);
          }
          // On a still-awaiting confirm, re-render IN PLACE so the operator sees the
          // streak tick up and can click the second confirm; otherwise leave for the list.
        }, { onDone: () => (merged ? backToWorkspace(t.workspace_id) : render()) });
      });
      wrap.appendChild(banner);
    }

    wrap.appendChild(el("h2", {}, "Diff vs main"));
    const diffBox = el("div", { class: "diffview" }, [el("div", { class: "meta" }, "loading diff…")]);
    wrap.appendChild(diffBox);
    // renderDiff returns a DocumentFragment. Attach it FIRST — a fragment's children are
    // unreachable through diffBox.querySelectorAll until then — and only then wireDiff().
    api("GET", "/work/" + id + "/diff")
      .then((d) => { diffBox.replaceChildren(renderDiff(d.diff)); wireDiff(diffBox, id); })
      .catch((e) => { diffBox.replaceChildren(el("div", { class: "meta" }, `diff error: ${e.message}`)); });

    const controls = el("div", { class: "panel stacked" });
    controls.innerHTML = `
      <h2 class="panel-title">Review</h2>
      <label class="field tight">
        <span class="lbl">change request note</span>
        <textarea id="rnote" data-restore-key="reject" placeholder="What needs to change? The note (plus any inline comments above) goes back to the same live agent, which keeps working in-context (no restart)."></textarea>
      </label>
      <div id="inline-comment-summary" class="inline-comment-summary hint"></div>
      <div class="row">
        <button class="btn success" id="approve">Approve &amp; merge</button>
        <button class="btn danger" id="reject">Request change</button>
        <div class="spacer"></div>
      </div>`;
    // Approve carries bespoke advisory-gate confirms (CI / conformance) and
    // conflict/revert toasts, so it calls action() directly rather than submitTo.
    controls.querySelector("#approve").addEventListener("click", (ev) => {
      // CI gate is advisory, not a hard block: warn on a failed build/tests but let
      // the operator proceed if they confirm.
      if (t.ci_status === "fail") {
        const label = (t.ci_summary || "CI failed").split("\n")[0].trim();
        if (!confirm(`CI failed (${label}). Approve and merge anyway?`)) return;
      }
      // SPEC-CONFORMANCE gate is likewise advisory: warn on a flagged concern (the
      // diff may not fully implement the prompt) but let the operator proceed.
      if (t.conformance_status === "concern") {
        const why = (t.conformance_summary || "").trim();
        if (!confirm(`Conformance concern${why ? `: ${why}` : ""}. Approve and merge anyway?`)) return;
      }
      let parked = false;
      action(ev.target, async () => {
        const r = await api("POST", "/work/" + id + "/approve");
        // A merge conflict isn't an error — it's sent back to the live agent to
        // resolve in-context. The SSE refresh will show the task back in in_progress.
        if (r && r.conflictSentBack) {
          toast("Merge conflict — sent back to the agent to resolve");
        } else if (r && r.revertedOnRed) {
          toast("Merged but verify FAILED — auto-reverted off main", true);
        } else if (r && r.awaitingMajorConfirm) {
          // release_mode major bump: Approve PARKS (it does NOT merge). Surface the streak
          // and stay on the task so the operator runs the deliberate double-confirm above.
          const n = (r.task && r.task.major_confirm_count) || 0;
          parked = true;
          toast(`Parked — awaiting major-version confirmation (${n}/2). Use “Confirm major version” above.`);
        } else {
          toast("approved ✓ — merged, agent wrapping up");
        }
        // Parked: re-render IN PLACE (the major-confirm banner is here). Otherwise leave.
      }, { onDone: () => (parked ? render() : backToWorkspace(t.workspace_id)) });
    });
    controls.querySelector("#reject").addEventListener("click", (ev) => {
      // The note sent to the agent is the freeform text plus any inline comments,
      // composed into one string (composeReviewNote). Either alone is enough to
      // request changes — so a reviewer can reject purely with per-line comments.
      const note = composeReviewNote(controls.querySelector("#rnote").value);
      if (!note) return toast("add a note or at least one inline comment", true);
      submitTo(ev.target, "/reject", { note }, "changes requested");
    });
    wrap.appendChild(controls);
  }

  // idea — a brief AWAITING a spec. butchr runs NO agent for it: it pushes a `spec
  // requested` event on the channel and waits for the task's STRUCTURAL responder to submit
  // a spec (POST /work/:id/spec), which advances it to spec_review. The responder
  // (story|cto|user) only frames this UI — the editor is ALWAYS available so a human can
  // submit, but for a cto/story task the responsible agent normally handles it.
  if (t.status === "idea") {
    // The responder for this idea, read straight from the task's server-computed structural
    // pending_responder (story|cto|user). Falls back to "cto" defensively.
    const specResponder = t.pending_responder || "cto";
    if (t.review_note) block("Spec changes requested", t.review_note, wrap);
    const specPanel = el("div", { class: "panel stacked" });
    const specResponderCopy = specResponder === "user"
      ? "You are the responder for this spec. Turn the brief above into a concrete, repo-grounded spec and submit it to advance the task to spec review."
      : specResponder === "story"
      ? "The <strong>story leader</strong> agent will write the spec from the brief (it was notified on its story channel). You can also write and submit one yourself below."
      : "The <strong>CTO agent</strong> will write the spec from the brief (it was notified on the CTO channel). You can also write and submit one yourself below.";
    specPanel.innerHTML = `
      <h2 class="panel-title">${specResponder === "user" ? "Write the spec" : "Spec requested"}</h2>
      <p class="muted lede">${specResponderCopy}</p>
      <label class="field tight">
        <span class="lbl">spec (required)</span>
        <textarea id="spec" data-restore-key="spec" placeholder="Write the full spec for this brief — what to build, where, and how it should be verified."></textarea>
      </label>
      <div class="row">
        <button class="btn success" id="submitSpec">Submit spec</button>
        <div class="spacer"></div>
      </div>`;
    specPanel.querySelector("#submitSpec").addEventListener("click", (ev) => {
      const spec = (specPanel.querySelector("#spec").value || "").trim();
      if (!spec) return toast("a spec is required", true);
      submitTo(ev.target, "/spec", { spec }, "spec submitted ✓ — awaiting approval");
    });
    wrap.appendChild(specPanel);
  }

  // spec_review — a spec was submitted (by the CTO agent or a human); operator approves
  // to start the workspace agent, or requests changes to revise the spec (back to idea).
  if (t.status === "spec_review") {
    const controls = el("div", { class: "panel stacked" });
    controls.innerHTML = `
      <h2 class="panel-title">Review spec</h2>
      <p class="muted lede">A spec was submitted for this idea. Approve to dispatch the workspace agent, or request changes to revise the spec.</p>
      <label class="field tight">
        <span class="lbl">change request note (required if requesting changes)</span>
        <textarea id="rnote" data-restore-key="spec-reject" placeholder="What needs to change in the spec?"></textarea>
      </label>
      <div class="row">
        <button class="btn success" id="approve">Approve spec</button>
        <button class="btn danger" id="reject">Request changes</button>
        <div class="spacer"></div>
      </div>`;
    // Approve toasts its own dispatching message, so it calls action() directly; reject
    // is the common submit-and-leave path.
    controls.querySelector("#approve").addEventListener("click", (ev) => {
      action(ev.target, async () => {
        await api("POST", "/work/" + id + "/approve");
        toast("spec approved ✓ — dispatching workspace agent");
      }, { onDone: () => backToWorkspace(t.workspace_id) });
    });
    controls.querySelector("#reject").addEventListener("click", (ev) => {
      const note = (controls.querySelector("#rnote").value || "").trim();
      if (!note) return toast("add a note describing what to change in the spec", true);
      submitTo(ev.target, "/reject", { note }, "spec changes requested — revising");
    });
    wrap.appendChild(controls);
  }

  // needs_info — the agent paused by calling an MCP tool. Two distinct surfaces, keyed off
  // whether this is a PLAN-PREVIEW task at the plan-approval step (t.plan_preview):
  //   - plan-approval → a STRUCTURED plan review: Approve (resume to implement, with optional
  //     steering) or Reject (send the plan back for revision with required feedback). These
  //     POST /plan/{approve,reject}, distinct from the freeform /answer.
  //   - any other needs_info → the freeform answer box (the agent raised a question / a
  //     suggested task change / a decomposition). On answer butchr re-launches the SAME
  //     agent session via `--resume` with the response injected.
  if (t.status === "needs_info" && t.plan_preview) {
    if (t.question) block("Proposed plan", t.question, wrap);
    const planPanel = el("div", { class: "panel stacked" });
    planPanel.innerHTML = `
      <h2 class="panel-title">Review plan</h2>
      <p class="muted lede">Approve to let the agent implement this plan, or request changes with feedback — the agent revises and re-proposes. Both resume the same session in-context.</p>
      <label class="field">
        <span class="lbl">feedback (optional for approve · required to request changes)</span>
        <textarea id="planNote" data-restore-key="plan-note" placeholder="On approve: optional steering notes folded into the implementation. On request-changes: what the plan must change before implementing."></textarea>
      </label>
      <div class="row">
        <button class="btn success" id="planApprove">Approve plan</button>
        <button class="btn danger-outline" id="planReject">Request changes</button>
        <div class="spacer"></div>
      </div>`;
    planPanel.querySelector("#planApprove").addEventListener("click", (ev) => {
      const note = (planPanel.querySelector("#planNote").value || "").trim();
      submitTo(ev.target, "/plan/approve", note ? { note } : {}, "plan approved — agent implementing");
    });
    planPanel.querySelector("#planReject").addEventListener("click", (ev) => {
      const note = (planPanel.querySelector("#planNote").value || "").trim();
      if (!note) return toast("add feedback describing what the plan must change", true);
      submitTo(ev.target, "/plan/reject", { note }, "plan changes requested — agent revising");
    });
    wrap.appendChild(planPanel);
  } else if (t.status === "needs_info") {
    if (t.question) block("Agent raised", t.question, wrap);
    const answerPanel = el("div", { class: "panel stacked" });
    answerPanel.innerHTML = `
      <h2 class="panel-title">Respond</h2>
      <label class="field">
        <span class="lbl">your response (required)</span>
        <textarea id="answer" data-restore-key="answer" placeholder="Respond to what the agent raised. It goes back to the same agent, which butchr re-launches in-context (--resume) to continue."></textarea>
      </label>
      <div class="row">
        <button class="btn success" id="sendAnswer">Send answer</button>
        <div class="spacer"></div>
      </div>`;
    answerPanel.querySelector("#sendAnswer").addEventListener("click", (ev) => {
      const answer = answerPanel.querySelector("#answer").value.trim();
      if (!answer) return toast("an answer is required", true);
      submitTo(ev.target, "/answer", { answer }, "answer sent — agent resuming");
    });
    wrap.appendChild(answerPanel);
  }

  // Idle agent panel — a LIVE in_progress agent that went quiet (the `idle` flag).
  // GRACEFUL idle-handling (FW-4): show the captured context, then let the operator
  // STEER it (nudge-with-guidance, or a bare "continue") or re-queue it — replacing the
  // old blind auto-"continue". Abort lives in the header. A dead-shell pane is never shown
  // here as nudgeable: the backend auto-resumes it instead, so an idle agent surfaced here
  // is genuinely alive (and /nudge re-checks liveness regardless).
  if (t.status === "in_progress" && t.idle) {
    if (t.idle_context) block("Idle context (recent output)", t.idle_context, wrap);
    const idlePanel = el("div", { class: "panel stacked" });
    idlePanel.innerHTML = `
      <h2 class="panel-title">Idle agent</h2>
      <p class="muted lede">This agent is alive but has gone quiet. Read the context above to judge why it stopped, then steer it with guidance (or a bare “continue”), re-queue it to relaunch its session, or abort it from the header.</p>
      <label class="field">
        <span class="lbl">guidance (optional — blank sends a bare “continue”)</span>
        <textarea id="nudgeText" data-restore-key="nudge" placeholder="Optional steering note, sent to the agent as if typed by a human. Leave blank to just nudge it to continue."></textarea>
      </label>
      <div class="row">
        <button class="btn success" id="nudge">Nudge</button>
        <button class="btn" id="requeue">Re-queue</button>
        <div class="spacer"></div>
      </div>`;
    // Idle actions stay on this page (no backToWorkspace), so they call action()
    // directly rather than submitTo.
    idlePanel.querySelector("#nudge").addEventListener("click", (ev) => {
      const text = (idlePanel.querySelector("#nudgeText").value || "").trim();
      // A bare nudge sends "continue"; with text it sends guidance. The backend re-checks
      // liveness and auto-resumes a dead pane instead of poking it.
      action(ev.target, () => api("POST", "/work/" + id + "/nudge", text ? { text } : {}),
        { success: text ? "guidance sent ✓" : "nudged — sent “continue” ✓" });
    });
    idlePanel.querySelector("#requeue").addEventListener("click", (ev) => {
      if (!confirm("Re-queue this idle agent? Its current run is torn down and re-launched (resuming its session) from scratch.")) return;
      action(ev.target, () => api("POST", "/work/" + id + "/requeue"), { success: "re-queued ✓" });
    });
    wrap.appendChild(idlePanel);
  }

  mount(wrap);

  if (t.status === "aborted" && (t.revert_reason || t.last_dispatch_error)) {
    document.getElementById("requeue").addEventListener("click", (ev) => {
      action(ev.target, () => api("POST", "/work/" + id + "/requeue"), { success: "re-queued ✓" });
    });
  }

  if (canAbort) {
    document.getElementById("abort").addEventListener("click", (ev) => {
      const msg = t.status === "in_progress"
        ? "Abort this in-progress task? The agent is stopped and its worktree + branch are discarded without merging."
        : "Abort this task? Its worktree + branch are discarded without merging.";
      if (!confirm(msg)) return;
      action(ev.target, () => api("POST", "/work/" + id + "/abort"), { success: "task aborted" });
    });
  }

  if (canRollback) {
    document.getElementById("rollback").addEventListener("click", (ev) => {
      if (!confirm(
        "Create a rollback task for this merged task? An agent reverts its change "
        + "(commit " + t.merged_sha.slice(0, 12) + ") and repairs any fallout — "
        + "dependents, tests, docs, revert conflicts — then it flows through the "
        + "normal CI gate → review → merge pipeline like any task.",
      )) return;
      // Create from the built-in `rollback` template via the unified work surface: a
      // rollback is the one workspace-level LEAF still created directly (kind:'rollback'),
      // and the server renders {{task}}/{{sha}} into the prompt (server.ts). Jump to the new
      // task so the operator can follow it through the pipeline.
      action(ev.target, async () => {
        const created = await api("POST", "/workspaces/" + t.workspace_id + "/work", {
          kind: "rollback",
          template: "rollback",
          vars: { task: id, sha: t.merged_sha },
        });
        if (created && created.id) location.hash = "#/task/" + created.id;
      }, { success: "rollback task created ✓" });
    });
  }

  // The feedback control panels (in_review / idea / spec_review / needs_info / idle)
  // build AND wire their own buttons before mount — see their builders above (each
  // closes over submitTo / action). Only the header/failed-panel controls (abort,
  // rollback, aborted-requeue) are wired here, since their nodes live outside those panels.
}
