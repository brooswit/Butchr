// The TASK view — the task detail / review page (`#/task/:id`). It owns everything that page
// paints: the crumbs + header controls (attach-terminal, abort, roll back), the needs-your-input
// card, the metadata grid and its label formatters, the audit timeline and the rescue note, the
// blocked-by list and the dependent-subtree rollup, the live-output panel, the agent transcript,
// and the five feedback control surfaces (in_review diff review / idea / spec_review / needs_info /
// idle). Extracted from app.js (RFC Phase 2, story st-ffcc9cec).
//
// It imports only LEAVES — core/ (dom, format, api, state-meta, nav, action, work-graph),
// components/ (chips, panel, button), and the sibling views/diff.js whose ONLY caller is renderTask.
// It never imports app.js; see the header of core/nav.js for why that edge is fatal. The route
// dispatcher (renderRoute) stays in app.js and imports the two names exported here — that
// direction is fine; the reverse would drag app.js, which touches `document` at load, into the
// module graph of every view and break the DOM-free-at-load property the tests rest on.
//
// DOM-free at module load: every module-level binding below is a timer handle, a flag, a string,
// or a plain object. `document` is touched only inside a CALLED function (the el() trees and the
// fragment helpers), so this module is importable under a non-browser runner. This is why
// `insufficientEstimate()` is a FUNCTION and not a module-level node constant: a node built at
// module scope would touch `document` at import AND would be one shared node silently MOVED
// between parents by each append.
//
// FULLY NODE-BUILT (RFC Phase 4, delivered): no innerHTML write anywhere. Every element comes from
// el(), whose text children go through createTextNode — so escaping is STRUCTURAL rather than the
// author's job, and the esc()/`{html:}`/htmlOf() escape hatches are deleted. Each control below is
// built, held as a local const, and wired on that held node; nothing is re-queried after
// construction. The ids that remain are the ones read ACROSS a module boundary
// (`#inline-comment-summary`, from views/diff.js) or by app.js's `[data-restore-key]` scan, plus
// the ones style.css and habit expect — never as a way to find a node we just made.
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
import { el } from "../core/dom.js";
import { fmtDuration, fmtTime } from "../core/format.js";
import { api } from "../core/api.js";
import { terminalToast, toast } from "../components/toast.js";
// TERMINAL_STATUSES is an `export let` reassigned once /api/state-meta lands; the ES live binding
// propagates the new value here. Read it at CALL time — never destructure it into a local const.
import { TERMINAL_STATUSES, statusLabel } from "../core/state-meta.js";
import {
  chip,
  livenessChip,
  tagChips,
  taskChips,
} from "../components/chips.js";
import { effStatus, feedbackStepLabel } from "../components/chips-logic.js";
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
import { Button, action } from "../components/button.js";
import {
  gatedSubtree,
  isCompleteStatus,
  reverseDeps,
  workLeaves,
} from "../core/work-graph.js";
// The diff reader (parse + highlight + inline review comments). renderTask is its only caller,
// so this import moved here with the view.
import { renderDiff, wireDiff } from "./diff.js";
import { composeReviewNote } from "./diff-logic.js";

// Fragment + text-node helpers, mirroring the pair in components/chips.js. Both touch `document`
// only when CALLED (see the module-load note above).
//
// ⚠ A DocumentFragment IS CONSUMED ON APPEND: appending it MOVES its children out and leaves it
// empty. Every helper below that returns one must therefore be CALLED ONCE PER USE SITE — never
// built once, held, and appended twice (the second append silently yields nothing). Each call
// site in this file appends the fragment immediately, exactly once.
const frag = (...kids) => {
  const f = document.createDocumentFragment();
  for (const k of kids) f.appendChild(typeof k === "string" ? document.createTextNode(k) : k);
  return f;
};
const muted = (text) => el("span", { class: "muted" }, text);

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
  panel.appendChild(el("div", { class: "ni-head" }, [
    el("span", { class: "ni-icon", "aria-hidden": "true" }, "⌨"),
    el("h2", {}, "Needs your input"),
  ]));
  panel.appendChild(el("p", { class: "ni-lead" }, [
    "This agent is ",
    el("strong", {}, "alive but blocked"),
    " at a prompt only a human can answer — it can't proceed until you respond in its live terminal.",
  ]));
  if (ctx) {
    panel.appendChild(el("div", { class: "ni-ctx-label" }, "What it's waiting on"));
    panel.appendChild(el("pre", { class: "block ni-ctx" }, ctx));
  } else {
    panel.appendChild(el("p", { class: "muted ni-noctx" },
      "No captured prompt text — open the terminal to see what it's waiting on."));
  }
  const actions = el("div", { class: "ni-actions" });
  panel.appendChild(actions);

  // openTaskTerminal calls action() itself (it needs the bespoke re-enable-on-success onDone),
  // so this is a PLAIN onClick — Button must not run its own action() dance around it.
  const term = Button({ label: "⌗ Open terminal to answer", onClick: () => openTaskTerminal(t.id, term) });
  actions.appendChild(term);

  if (isOneKeyConfirmPrompt(ctx)) {
    // No pre-flight confirm() and no validation → the plain onAction dance is exactly right.
    const confirmBtn = Button({
      class: "ghost",
      title: "send “1” to the live pane — the safe proceed/consent choice",
      label: "Confirm (send “1”)",
      onAction: () => api("POST", "/work/" + t.id + "/nudge", { text: "1" }),
      success: "sent “1” — the agent should continue past the prompt",
      onDone: () => { confirmBtn.disabled = false; },
    });
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
//
// `.tl-event` and `.tl-head` are display:flex and `.tl-transition` is inline-flex (style.css),
// so the whitespace the old template carried between their children generated no anonymous flex
// item and rendered as nothing. It is dropped here rather than reproduced as text nodes.
function renderTimeline(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const panel = el("div", { class: "panel timeline-panel" });
  panel.appendChild(el("h2", { class: "panel-title" }, "Timeline"));
  const list = el("div", { class: "timeline" });
  for (const ev of events) {
    const transition = ev.from_status && ev.from_status !== ev.to_status
      ? [chip(ev.from_status), el("span", { class: "tl-arrow" }, "→"), chip(ev.to_status)]
      : [chip(ev.to_status)];
    const body = el("div", { class: "tl-body" }, [
      el("div", { class: "tl-head" }, [
        el("span", { class: "tl-transition" }, transition),
        el("span", { class: "tl-time", title: ev.at }, fmtTime(ev.at)),
      ]),
    ]);
    if (ev.note) body.appendChild(el("div", { class: "tl-note" }, ev.note));
    // `?? ""` mirrors what esc() used to absorb: a null to_status yielded a bare `class="tl-dot"`
    // rather than the literal string "null" in the class list.
    list.appendChild(el("div", { class: "tl-event" }, [
      el("span", { class: "tl-dot " + (ev.to_status ?? "") }),
      body,
    ]));
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
//
// ⚠ DO NOT RENAME, MOVE, OR RESHAPE THIS DECLARATION. test/output-snapshot-retired.test.ts does
// not import it — it reads THIS FILE as source text, matches its declaration with a regex that
// runs from the signature to the first column-0 `}`, and evaluates what it finds. Any change to
// the name, the parameter list, or the closing-brace column breaks that test with a failure that
// reads as unrelated. For the same reason, do not write that signature out literally anywhere
// above this point in the file: the regex takes the FIRST match, so a copy of it inside a comment
// hijacks the scrape and hands the test an unbalanced fragment.
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
// PLAIN TEXT (el() escapes it as a text child) — not a node.
function modelLabel(t) {
  const want = (t.model || "").trim();
  const used = (t.model_used || "").trim();
  if (want && used && want !== used) return `${want} (ran as ${used})`;
  if (want) return want;
  if (used) return `default (${used})`;
  return "default";
}

// Compact token-usage summary built from the captured session totals. Returns a FRAGMENT
// (text + a trailing `<span class="muted">` breakdown), or a bare "—" fragment until any usage
// has been recorded. The literal space before the span is real: `.meta-grid .v` is a plain block,
// not a flex container, so that gap renders.
function tokensLabel(t) {
  const inT = t.usage_input_tokens, outT = t.usage_output_tokens;
  const cr = t.usage_cache_read_tokens, cw = t.usage_cache_creation_tokens;
  const has = [inT, outT, cr, cw].some((n) => typeof n === "number" && n > 0);
  if (!has) return frag("—");
  const n = (v) => (typeof v === "number" ? v : 0).toLocaleString();
  const total = (inT || 0) + (outT || 0) + (cr || 0) + (cw || 0);
  return frag(
    `${n(total)} total `,
    muted(`· in ${n(inT)} · out ${n(outT)} · cache r ${n(cr)} / w ${n(cw)}`),
  );
}

// Cost label. The session transcript records tokens but no dollar cost and butchr
// has no pricing table, so we show "—" (not tracked) rather than fabricate a number.
// PLAIN TEXT — not a node.
function costLabel(t) {
  return typeof t.cost_usd === "number" ? `$${t.cost_usd.toFixed(4)}` : "— (not tracked)";
}

// ROUGH duration estimate, rendered as a loose p50–p90 RANGE with its sample size —
// deliberately hedged ("~", "rough"), never a promise. Prefers the to-merge range,
// falling back to to-review; says "insufficient data" when history is too thin.
//
// A FUNCTION, not a module-level node: a node built at module scope would touch `document` at
// import (breaking this file's DOM-free-at-load property) and would be a single shared node that
// each append silently MOVES out of its previous parent.
function insufficientEstimate() {
  return frag("insufficient data ", muted("· not enough history yet"));
}
function fmtEstimate(est) {
  if (!est) return frag("—");
  if (est.insufficient) return insufficientEstimate();
  const r = est.toMerge || est.toReview;
  if (!r) return insufficientEstimate();
  const label = est.toMerge ? "to merge" : "to review";
  const bucket = est.basis === "overall" ? "all tasks" : `${est.bucket} ${est.basis}`;
  return frag(
    `est ~${fmtDuration(r.p50Ms)}–${fmtDuration(r.p90Ms)} `,
    muted(`· ${label} · n=${est.n} · ${bucket} · rough`),
  );
}

// Critical-path estimate across a task's dependency chain (a blocked task's
// blockers). Returns a FRAGMENT, or null when there's nothing pending to chain.
//
// ⚠ RETURN `null` FOR THE ABSENT CASE — NEVER AN EMPTY FRAGMENT. Its one consumer,
// components/panel.js's listPanel, guards with a bare `if (chainLine)`, and a DocumentFragment is
// ALWAYS TRUTHY even when empty: an empty fragment would sail through that guard and paint a
// stray empty `<div class="chain-est">`.
function fmtChain(chain) {
  if (!chain || chain.taskCount === 0 || chain.p50Ms == null) return null;
  const n = chain.taskCount;
  const f = frag(
    `est ~${fmtDuration(chain.p50Ms)}–${fmtDuration(chain.p90Ms)} `,
    muted(`· critical path across ${n} task${n === 1 ? "" : "s"} · rough`),
  );
  // `.chain-est` is a plain block, so this leading space is a rendered gap — keep the text node.
  if (chain.insufficient) {
    f.appendChild(document.createTextNode(" "));
    f.appendChild(muted("· partial — some tasks lack history"));
  }
  return f;
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
// `.ts-head` is display:flex, so the label/time gap comes from its `gap`, not from markup
// whitespace. The truncation marker's LEADING space is inside `.ts-pre` (white-space: pre-wrap),
// where it is rendered — so it stays part of that span's text, exactly as before.
function renderTranscriptItem(it) {
  const kind = it.kind ?? "";
  const role = it.role ?? "";
  const row = el("div", { class: `ts-item ts-${kind} role-${role}` });
  const trunc = () => (it.truncated ? el("span", { class: "ts-trunc" }, " … (truncated)") : null);
  let label, body;
  if (kind === "tool_use") {
    label = el("span", { class: "ts-label tool" }, "⚙ " + (it.tool ?? ""));
    body = it.args ? el("code", { class: "ts-args" }, it.args) : null;
  } else if (kind === "tool_result") {
    label = el("span", { class: "ts-label result" }, "↳ result");
    body = el("pre", { class: "ts-pre" }, [it.text || "", trunc()]);
  } else if (kind === "thinking") {
    label = el("span", { class: "ts-label thinking" }, role + " · thinking");
    body = el("pre", { class: "ts-pre" }, [it.text || "", trunc()]);
  } else {
    label = el("span", { class: "ts-label " + role }, role);
    body = el("pre", { class: "ts-pre" }, [it.text || "", trunc()]);
  }
  const head = [label];
  if (it.ts) head.push(el("span", { class: "ts-time", title: it.ts }, fmtTime(it.ts)));
  row.appendChild(el("div", { class: "ts-head" }, head));
  if (body) row.appendChild(body);
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
    body.replaceChildren();
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
      // load() owns its own disable/re-render, so this is a PLAIN onClick — routing it through
      // Button({onAction}) would add a second, unwanted disable/toast/render dance around it.
      const more = Button({
        class: "ghost ts-more",
        label: `Load more (${transcriptState.turns.length} of ${transcriptState.total})`,
        onClick: () => load(more),
      });
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

// One `<div class="k">key</div><div class="v">value</div>` pair of the metadata grid.
// `.meta-grid` is display:grid, so the whitespace the old template carried between the cells
// generated no anonymous grid item and is simply not reproduced.
function metaRow(grid, key, value, attrs) {
  grid.appendChild(el("div", { class: "k" }, key));
  grid.appendChild(el("div", { class: "v", ...(attrs || {}) }, value));
}

export async function renderTask(id) {
  const t = await api("GET", "/work/" + id);
  const dirs = await api("GET", "/workspaces");
  const dir = dirs.find((x) => x.id === t.workspace_id);

  const wrap = el("div");
  // `.crumbs` is a plain block — the " / " separators are REAL rendered text, so they are
  // explicit text nodes rather than dropped inter-element whitespace.
  wrap.appendChild(el("div", { class: "crumbs" }, [
    el("a", { href: "#/projects" }, "Projects"),
    " / ",
    el("a", { href: "#/workspace/" + t.workspace_id },
      dir ? (dir.label || dir.path) : t.workspace_id),
    " / ",
    el("span", { "aria-current": "page" }, t.id),
  ]));
  const headerRight = el("div", { class: "row" });
  if (isLive(t)) {
    // openTaskTerminal runs its own action() dance → plain onClick (see needsUserInputPanel).
    const term = Button({ class: "ghost", label: "⌗ Open terminal", onClick: () => openTaskTerminal(t.id, term) });
    headerRight.appendChild(term);
  }
  headerRight.appendChild(el("div", {}, taskChips(t, { plan: true, kind: true })));
  // Abort is available from any non-terminal state (TERMINAL_STATUSES comes from the
  // server meta), EXCEPT `rolling_back` — a mechanical merge in flight with no live
  // agent to stop.
  const canAbort = !TERMINAL_STATUSES.includes(t.status) && t.status !== "rolling_back";
  if (canAbort) {
    // HAND-ROLLED, not Button({onAction}): a pre-flight confirm() must be able to bail WITHOUT
    // action() having already disabled the button and toasted. Wired here on the held node —
    // this used to be a post-mount document.getElementById("abort").
    const abortBtn = Button({ class: "ghost danger-outline", label: "Abort task", onClick: () => {
      const msg = t.status === "in_progress"
        ? "Abort this in-progress task? The agent is stopped and its worktree + branch are discarded without merging."
        : "Abort this task? Its worktree + branch are discarded without merging.";
      if (!confirm(msg)) return;
      action(abortBtn, () => api("POST", "/work/" + id + "/abort"), { success: "task aborted" });
    } });
    abortBtn.id = "abort";
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
    // HAND-ROLLED for the same reason as Abort: confirm() first, so no unconditional disable.
    const rollbackBtn = Button({ class: "ghost danger-outline", label: "Roll back", onClick: () => {
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
      action(rollbackBtn, async () => {
        const created = await api("POST", "/workspaces/" + t.workspace_id + "/work", {
          kind: "rollback",
          template: "rollback",
          vars: { task: id, sha: t.merged_sha },
        });
        if (created && created.id) location.hash = "#/task/" + created.id;
      }, { success: "rollback task created ✓" });
    } });
    rollbackBtn.id = "rollback";
    headerRight.appendChild(rollbackBtn);
  }
  wrap.appendChild(el("div", { class: "row between" }, [
    el("h1", {}, el("span", { class: "mono" }, t.id)),
    headerRight,
  ]));

  // NEEDS-YOUR-INPUT card — surfaced FIRST (above the metadata) when the live agent is wedged
  // at a human-only prompt, so the highest-attention state and its resolve controls (open
  // terminal / one-click confirm) read immediately. Resolves on the next SSE update once the
  // agent moves past the prompt and the safety-net watcher clears the flag.
  if (effStatus(t) === "needs_user_input") wrap.appendChild(needsUserInputPanel(t));

  // metadata
  const grid = el("div", { class: "meta-grid" });
  metaRow(grid, "status", statusLabel(effStatus(t)));
  if (t.liveness) metaRow(grid, "liveness", livenessChip(t.liveness), { title: t.liveness.evidence });
  if (Array.isArray(t.tags) && t.tags.length) metaRow(grid, "tags", tagChips(t));
  if (Array.isArray(t.allowlist) && t.allowlist.length) {
    // `.meta-grid .v` is a plain block, so the single space BETWEEN two <code> codes is a
    // rendered gap (the old template `.join(" ")`ed them) — emit it as a real text node.
    const codes = [];
    t.allowlist.forEach((a, i) => {
      if (i) codes.push(" ");
      codes.push(el("code", {}, a));
    });
    metaRow(grid, "allowlist", codes);
  }
  metaRow(grid, "priority", String(t.priority ?? 0));
  metaRow(grid, "created", t.created_at || "—");
  metaRow(grid, "started", t.started_at || "—");
  metaRow(grid, "completed", t.completed_at || "—");
  metaRow(grid, "merged", t.merged_at || "—");
  if (t.estimate) metaRow(grid, "est. duration", fmtEstimate(t.estimate));
  metaRow(grid, "model", modelLabel(t));
  metaRow(grid, "tokens", tokensLabel(t));
  metaRow(grid, "cost", costLabel(t));
  wrap.appendChild(el("div", { class: "panel" }, [grid]));

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
    // `chainLine` is a fragment: listPanel appends it ONCE, here, and this is its only use site.
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
  //
  // The Re-queue button here is a clean onAction (no confirm(), no validation, and action()'s
  // default onDone IS the render() it wanted) — so it adopts Button. Note the IDLE panel's
  // Re-queue further down is a DIFFERENT control: it confirm()s first and therefore stays
  // hand-rolled. They were only ever "the same button" because a post-mount
  // getElementById("requeue") happened to find whichever one existed; both are wired on their
  // own held node now.
  if (t.status === "aborted" && t.revert_reason) {
    const requeue = Button({
      label: "Re-queue",
      onAction: () => api("POST", "/work/" + id + "/requeue"),
      success: "re-queued ✓",
    });
    requeue.id = "requeue";
    wrap.appendChild(el("div", { class: "panel failed-panel" }, [
      el("h2", { class: "panel-title" }, "Merge auto-reverted off main"),
      el("p", { class: "muted lede" }, "This branch merged, but the post-merge verify (build + tests) failed on the default branch, so the merge was reverted to keep main green. The branch + worktree were kept."),
      el("pre", { class: "block" }, t.revert_reason),
      el("div", { class: "row panel-actions" }, [
        requeue,
        el("small", { class: "muted" }, "Re-launches the agent (in-context) to fix the breakage, then it can be re-reviewed."),
      ]),
    ]));
  } else if (t.status === "aborted" && t.last_dispatch_error) {
    const n = t.dispatch_attempts || 0;
    const requeue = Button({
      label: "Re-queue",
      onAction: () => api("POST", "/work/" + id + "/requeue"),
      success: "re-queued ✓",
    });
    requeue.id = "requeue";
    wrap.appendChild(el("div", { class: "panel failed-panel" }, [
      el("h2", { class: "panel-title" }, "Dispatch failed"),
      el("p", { class: "muted lede" }, `Failed after ${n} dispatch attempt${n === 1 ? "" : "s"}. The agent never started.`),
      el("pre", { class: "block" }, t.last_dispatch_error || "(no error recorded)"),
      el("div", { class: "row panel-actions" }, [
        requeue,
        el("small", { class: "muted" }, "Clears the retry state and dispatches again from scratch."),
      ]),
    ]));
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
    const stepStr = stepLbl ? ` (${stepLbl})` : "";
    let kids;
    if (t.pending_responder === "user") {
      kids = [
        el("strong", {}, "Awaiting you"),
        ` — this${stepStr} is assigned to `,
        el("strong", {}, "you"),
        ". Act in the controls below.",
      ];
    } else if (t.pending_responder === "story") {
      kids = [
        el("strong", {}, "Awaiting the story leader"),
        ` — this${stepStr} is handled automatically by the story leader agent. You can also act in the controls below.`,
      ];
    } else {
      kids = [
        el("strong", {}, "Awaiting the CTO agent"),
        ` — this${stepStr} is handled automatically by this workspace's CTO agent. You can also act in the controls below.`,
      ];
    }
    wrap.appendChild(el("div", {
      class: "responder-banner " + (t.pending_responder === "user" ? "awaiting-you" : "awaiting-cto"),
    }, kids));
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
      // HAND-ROLLED: this branches its own toasts AND its own onDone off the response shape
      // (a still-awaiting confirm re-renders IN PLACE; a landed merge leaves for the list),
      // which Button's construction-time `success`/`onDone` cannot express.
      const confirmBtn = el("button", { class: "btn danger", id: "confirm-major" },
        `Confirm major version (${n}/2)`);
      confirmBtn.addEventListener("click", () => {
        let merged = false;
        action(confirmBtn, async () => {
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
      wrap.appendChild(el("div", { class: "panel major-confirm-panel" }, [
        el("h2", { class: "panel-title" }, `Awaiting major-version confirmation (${n}/2)`),
        el("p", { class: "muted lede" }, [
          "This task declares a ",
          el("strong", {}, "major"),
          " version bump, so merging it is a deliberate human double-confirm — ",
          el("strong", {}, "Approve does not merge it"),
          ". Click ",
          el("strong", {}, "Confirm major version"),
          " ",
          el("strong", {}, "twice in a row"),
          ` (streak ${n}/2); the second consecutive confirm lands the merge. `,
          el("strong", {}, "Any other action"),
          " (Approve, Request change, re-review, re-declaring the bump) ",
          el("strong", {}, "resets the streak to 0"),
          ".",
        ]),
        el("div", { class: "row" }, [
          confirmBtn,
          el("small", { class: "muted" }, "Two consecutive confirms required — this is the human gate on a breaking release."),
        ]),
      ]));
    }

    wrap.appendChild(el("h2", {}, "Diff vs main"));
    const diffBox = el("div", { class: "diffview" }, [el("div", { class: "meta" }, "loading diff…")]);
    wrap.appendChild(diffBox);
    // renderDiff returns a DocumentFragment. Attach it FIRST — a fragment's children are
    // unreachable through diffBox.querySelectorAll until then — and only then wireDiff().
    api("GET", "/work/" + id + "/diff")
      .then((d) => { diffBox.replaceChildren(renderDiff(d.diff)); wireDiff(diffBox, id); })
      .catch((e) => { diffBox.replaceChildren(el("div", { class: "meta" }, `diff error: ${e.message}`)); });

    const rnote = el("textarea", {
      id: "rnote",
      "data-restore-key": "reject",
      placeholder: "What needs to change? The note (plus any inline comments above) goes back to the same live agent, which keeps working in-context (no restart).",
    });
    // HAND-ROLLED: Approve gates on up to two advisory confirm()s before it acts, and then
    // branches its toasts + onDone off the response. Button({onAction}) would disable the
    // button and start the dance before the first confirm() could cancel.
    const approve = el("button", { class: "btn success", id: "approve" }, "Approve & merge");
    approve.addEventListener("click", () => {
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
      action(approve, async () => {
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
    // HAND-ROLLED: validates first and shows an INLINE error (a toast, no navigation) when the
    // note is empty. Button({onAction}) would have already disabled the button and started the
    // dance by then, leaving it dead on screen.
    const reject = el("button", { class: "btn danger", id: "reject" }, "Request change");
    reject.addEventListener("click", () => {
      // The note sent to the agent is the freeform text plus any inline comments,
      // composed into one string (composeReviewNote). Either alone is enough to
      // request changes — so a reviewer can reject purely with per-line comments.
      const note = composeReviewNote(rnote.value);
      if (!note) return toast("add a note or at least one inline comment", true);
      submitTo(reject, "/reject", { note }, "changes requested");
    });
    wrap.appendChild(el("div", { class: "panel stacked" }, [
      el("h2", { class: "panel-title" }, "Review"),
      el("label", { class: "field tight" }, [
        el("span", { class: "lbl" }, "change request note"),
        rnote,
      ]),
      // ⚠ CROSS-MODULE ID. views/diff.js's updateCommentSummary() reaches this node by
      // document.getElementById("inline-comment-summary") after the diff paints. The id must stay
      // on THIS element.
      el("div", { id: "inline-comment-summary", class: "inline-comment-summary hint" }),
      el("div", { class: "row" }, [approve, reject, el("div", { class: "spacer" })]),
    ]));
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
    const specResponderCopy = specResponder === "user"
      ? ["You are the responder for this spec. Turn the brief above into a concrete, repo-grounded spec and submit it to advance the task to spec review."]
      : specResponder === "story"
      ? ["The ", el("strong", {}, "story leader"), " agent will write the spec from the brief (it was notified on its story channel). You can also write and submit one yourself below."]
      : ["The ", el("strong", {}, "CTO agent"), " will write the spec from the brief (it was notified on the CTO channel). You can also write and submit one yourself below."];
    const spec = el("textarea", {
      id: "spec",
      "data-restore-key": "spec",
      placeholder: "Write the full spec for this brief — what to build, where, and how it should be verified.",
    });
    // HAND-ROLLED: validates first and toasts an inline error on an empty spec.
    const submitSpec = el("button", { class: "btn success", id: "submitSpec" }, "Submit spec");
    submitSpec.addEventListener("click", () => {
      const value = (spec.value || "").trim();
      if (!value) return toast("a spec is required", true);
      submitTo(submitSpec, "/spec", { spec: value }, "spec submitted ✓ — awaiting approval");
    });
    wrap.appendChild(el("div", { class: "panel stacked" }, [
      el("h2", { class: "panel-title" }, specResponder === "user" ? "Write the spec" : "Spec requested"),
      el("p", { class: "muted lede" }, specResponderCopy),
      el("label", { class: "field tight" }, [
        el("span", { class: "lbl" }, "spec (required)"),
        spec,
      ]),
      el("div", { class: "row" }, [submitSpec, el("div", { class: "spacer" })]),
    ]));
  }

  // spec_review — a spec was submitted (by the CTO agent or a human); operator approves
  // to start the workspace agent, or requests changes to revise the spec (back to idea).
  if (t.status === "spec_review") {
    const rnote = el("textarea", {
      id: "rnote",
      "data-restore-key": "spec-reject",
      placeholder: "What needs to change in the spec?",
    });
    // Approve toasts its own dispatching message from INSIDE the action body (so the whole
    // await+toast stays in one try), and neither confirm()s nor validates → a clean onAction.
    const approve = Button({
      class: "success",
      label: "Approve spec",
      onAction: async () => {
        await api("POST", "/work/" + id + "/approve");
        toast("spec approved ✓ — dispatching workspace agent");
      },
      onDone: () => backToWorkspace(t.workspace_id),
    });
    approve.id = "approve";
    // HAND-ROLLED: validates first and toasts an inline error on an empty note.
    const reject = el("button", { class: "btn danger", id: "reject" }, "Request changes");
    reject.addEventListener("click", () => {
      const note = (rnote.value || "").trim();
      if (!note) return toast("add a note describing what to change in the spec", true);
      submitTo(reject, "/reject", { note }, "spec changes requested — revising");
    });
    wrap.appendChild(el("div", { class: "panel stacked" }, [
      el("h2", { class: "panel-title" }, "Review spec"),
      el("p", { class: "muted lede" }, "A spec was submitted for this idea. Approve to dispatch the workspace agent, or request changes to revise the spec."),
      el("label", { class: "field tight" }, [
        el("span", { class: "lbl" }, "change request note (required if requesting changes)"),
        rnote,
      ]),
      el("div", { class: "row" }, [approve, reject, el("div", { class: "spacer" })]),
    ]));
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
    const planNote = el("textarea", {
      id: "planNote",
      "data-restore-key": "plan-note",
      placeholder: "On approve: optional steering notes folded into the implementation. On request-changes: what the plan must change before implementing.",
    });
    // Approve neither confirm()s nor validates (the note is OPTIONAL here), so onAction is
    // exact. The note is read INSIDE onAction, i.e. at click time, exactly as before.
    const planApprove = Button({
      class: "success",
      label: "Approve plan",
      onAction: () => {
        const note = (planNote.value || "").trim();
        return api("POST", "/work/" + id + "/plan/approve", note ? { note } : {});
      },
      success: "plan approved — agent implementing",
      onDone: () => backToWorkspace(t.workspace_id),
    });
    planApprove.id = "planApprove";
    // HAND-ROLLED: feedback is REQUIRED to request changes — validate, then toast inline.
    // Note the class is `btn danger-outline` (no `ghost`), matching style.css as it was.
    const planReject = el("button", { class: "btn danger-outline", id: "planReject" }, "Request changes");
    planReject.addEventListener("click", () => {
      const note = (planNote.value || "").trim();
      if (!note) return toast("add feedback describing what the plan must change", true);
      submitTo(planReject, "/plan/reject", { note }, "plan changes requested — agent revising");
    });
    wrap.appendChild(el("div", { class: "panel stacked" }, [
      el("h2", { class: "panel-title" }, "Review plan"),
      el("p", { class: "muted lede" }, "Approve to let the agent implement this plan, or request changes with feedback — the agent revises and re-proposes. Both resume the same session in-context."),
      el("label", { class: "field" }, [
        el("span", { class: "lbl" }, "feedback (optional for approve · required to request changes)"),
        planNote,
      ]),
      el("div", { class: "row" }, [planApprove, planReject, el("div", { class: "spacer" })]),
    ]));
  } else if (t.status === "needs_info") {
    if (t.question) block("Agent raised", t.question, wrap);
    const answer = el("textarea", {
      id: "answer",
      "data-restore-key": "answer",
      placeholder: "Respond to what the agent raised. It goes back to the same agent, which butchr re-launches in-context (--resume) to continue.",
    });
    // HAND-ROLLED: validates first and toasts an inline error on an empty answer.
    const sendAnswer = el("button", { class: "btn success", id: "sendAnswer" }, "Send answer");
    sendAnswer.addEventListener("click", () => {
      const value = answer.value.trim();
      if (!value) return toast("an answer is required", true);
      submitTo(sendAnswer, "/answer", { answer: value }, "answer sent — agent resuming");
    });
    wrap.appendChild(el("div", { class: "panel stacked" }, [
      el("h2", { class: "panel-title" }, "Respond"),
      el("label", { class: "field" }, [
        el("span", { class: "lbl" }, "your response (required)"),
        answer,
      ]),
      el("div", { class: "row" }, [sendAnswer, el("div", { class: "spacer" })]),
    ]));
  }

  // Idle agent panel — a LIVE in_progress agent that went quiet (the `idle` flag).
  // GRACEFUL idle-handling (FW-4): show the captured context, then let the operator
  // STEER it (nudge-with-guidance, or a bare "continue") or re-queue it — replacing the
  // old blind auto-"continue". Abort lives in the header. A dead-shell pane is never shown
  // here as nudgeable: the backend auto-resumes it instead, so an idle agent surfaced here
  // is genuinely alive (and /nudge re-checks liveness regardless).
  if (t.status === "in_progress" && t.idle) {
    if (t.idle_context) block("Idle context (recent output)", t.idle_context, wrap);
    const nudgeText = el("textarea", {
      id: "nudgeText",
      "data-restore-key": "nudge",
      placeholder: "Optional steering note, sent to the agent as if typed by a human. Leave blank to just nudge it to continue.",
    });
    // HAND-ROLLED: the success MESSAGE depends on the text read at click time, and Button
    // captures `success` at CONSTRUCTION — routing this through Button({onAction}) would
    // freeze one of the two messages. Idle actions also stay on this page (no
    // backToWorkspace), which is action()'s default render() onDone.
    const nudge = el("button", { class: "btn success", id: "nudge" }, "Nudge");
    nudge.addEventListener("click", () => {
      const text = (nudgeText.value || "").trim();
      // A bare nudge sends "continue"; with text it sends guidance. The backend re-checks
      // liveness and auto-resumes a dead pane instead of poking it.
      action(nudge, () => api("POST", "/work/" + id + "/nudge", text ? { text } : {}),
        { success: text ? "guidance sent ✓" : "nudged — sent “continue” ✓" });
    });
    // HAND-ROLLED: confirm() first — a cancel must not leave the button disabled. This is the
    // OTHER `#requeue` (see the aborted panels above); it is a different control with a
    // different behavior, and it was only ever conflated with them by a post-mount
    // getElementById that returned whichever one happened to be in the document.
    const requeue = el("button", { class: "btn", id: "requeue" }, "Re-queue");
    requeue.addEventListener("click", () => {
      if (!confirm("Re-queue this idle agent? Its current run is torn down and re-launched (resuming its session) from scratch.")) return;
      action(requeue, () => api("POST", "/work/" + id + "/requeue"), { success: "re-queued ✓" });
    });
    wrap.appendChild(el("div", { class: "panel stacked" }, [
      el("h2", { class: "panel-title" }, "Idle agent"),
      el("p", { class: "muted lede" }, "This agent is alive but has gone quiet. Read the context above to judge why it stopped, then steer it with guidance (or a bare “continue”), re-queue it to relaunch its session, or abort it from the header."),
      el("label", { class: "field" }, [
        el("span", { class: "lbl" }, "guidance (optional — blank sends a bare “continue”)"),
        nudgeText,
      ]),
      el("div", { class: "row" }, [nudge, requeue, el("div", { class: "spacer" })]),
    ]));
  }

  mount(wrap);

  // NOTHING IS WIRED AFTER MOUNT. Every control on this page — the header's abort / roll back,
  // the aborted panels' re-queue, and each feedback panel's buttons — is built, held as a local
  // const, and wired on that node above. Listeners live on the node, so pre-mount wiring is
  // equivalent, and no control is ever re-found with a selector after it was created.
}
