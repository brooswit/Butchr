// Story service: create / get / list / update / delete stories + assign a task to a
// story. A STORY is a CONTAINER that GROUPS subtasks (tasks carry a nullable story_id
// FK — see the `stories` table + tasks.story_id column in db.ts).
//
// PHASE 1 — DATA MODEL + CRUD ONLY. This is the persistence foundation, fully INERT:
// nothing in the dispatch / review / lifecycle / responder / channel machinery reads a
// story or a task's story_id yet. Later phases add a story-leader agent (a mini-CTO that
// decomposes / feedbacks / merges) + a responder-escalation chain that consume it. This
// module mirrors the shape of src/workspaces.ts (a thin CRUD service over the DB).
import { ALL_STATUSES, db, ensureStoryWorkNode, isTerminal, nowIso } from "./db.ts";
import type { StoryRow, StoryStatus, TaskKind, TaskRow, TaskStatus } from "./db.ts";
import { publish } from "./events.ts";
import * as git from "./git.ts";
import { generateStoryId } from "./ids.ts";
import {
  onStoryCreated,
  onStoryStatusChanged,
  storyAgentStatus,
  stopStoryAgent,
} from "./story-agent.ts";
import type { StoryAgentStatus } from "./story-agent.ts";
import { abortTask, createTask, getTask, mergeStoryBranch, taskView } from "./tasks.ts";
import type { TaskView } from "./tasks.ts";
import { teardownLeaderWorkspaceForWork } from "./workspace-agent.ts";
import { HttpError, getWorkspace, listWorkspaces, workspaceBranchIsolation } from "./workspaces.ts";

// The three valid story statuses (mirrors the StoryStatus union in db.ts). Used to
// validate an incoming status before it touches the row.
const STORY_STATUSES: ReadonlySet<string> = new Set<StoryStatus>(["open", "done", "aborted"]);

/**
 * The ONE guarded STORY-status transition (story st-a632b2cc) — the story-level sibling of
 * task setStatus (src/tasks.ts). Builds a `WHERE id=? [AND status IN (…from)]` UPDATE that
 * writes `status` (plus any `opts.set` columns) and returns whether a row ACTUALLY changed
 * (false = lost a race / illegal source — the caller bails, firing none of the side-effects
 * that ride alongside the write).
 *
 * Every story-status write routes through here with a legal `from` set per transition, so a
 * TERMINAL story (done/aborted) can never be re-opened or re-transitioned, and a done/aborted
 * write can never race an in-flight `merging` (landStory's done/merge_blocked writes CAS from
 * `merging` only). The CAS is the SOURCE guard; callers keep the existing TARGET validation
 * (STORY_STATUSES.has) and own the side-effects, gating them on the returned boolean.
 *
 *  - `from` — the status(es) the row must be in for the UPDATE to apply (the race guard);
 *    omit for an unconditional `WHERE id=?`.
 *  - `set`  — extra columns written alongside status as `col=?` (e.g. brief, merge shas, the
 *    pending_ask/ask_responder terminal clear).
 */
function setStoryStatus(
  id: string,
  to: StoryStatus,
  opts: { from?: StoryStatus | StoryStatus[]; set?: Record<string, string | null> } = {},
): boolean {
  const assigns = ["status=?"];
  const params: (string | null)[] = [to];
  for (const [col, val] of Object.entries(opts.set ?? {})) {
    assigns.push(`${col}=?`);
    params.push(val);
  }
  let where = "id=?";
  params.push(id);
  if (opts.from !== undefined) {
    const froms = Array.isArray(opts.from) ? opts.from : [opts.from];
    where += ` AND status IN (${froms.map(() => "?").join(", ")})`;
    params.push(...froms);
  }
  const res = db.query(`UPDATE stories SET ${assigns.join(", ")} WHERE ${where}`).run(...params);
  return res.changes > 0;
}

/** Look up a story by its id, or null if none matches. */
export function getStory(id: string): StoryRow | null {
  return db.query<StoryRow, [string]>(`SELECT * FROM stories WHERE id=?`).get(id) ?? null;
}

/** A workspace's stories, newest-first (mirrors listTasks' ordering). */
export function listStories(workspaceId: string): StoryRow[] {
  return db
    .query<StoryRow, [string]>(
      `SELECT * FROM stories WHERE workspace_id=? ORDER BY created_at DESC`,
    )
    .all(workspaceId);
}

/** Mint a story id not already taken (mirrors uniqueTaskId's retry shape). */
function uniqueStoryId(): string {
  for (let i = 0; i < 100; i++) {
    const id = generateStoryId();
    if (!getStory(id)) return id;
  }
  // Astronomically unlikely; fall back to extra entropy.
  return `${generateStoryId()}-${generateStoryId().slice(3)}`;
}

/**
 * Create a story in a workspace. 404 if the workspace is gone; 400 if the brief is
 * blank. Lands `open` with the current timestamp. Returns the new row. PURELY a
 * grouping container this phase — creating a story has no side effects on any task.
 */
export function createStory(workspaceId: string, brief: unknown): StoryRow {
  if (!getWorkspace(workspaceId)) {
    throw new HttpError(404, `workspace not found: ${workspaceId}`);
  }
  if (typeof brief !== "string" || !brief.trim()) {
    throw new HttpError(400, "brief is required");
  }
  const id = uniqueStoryId();
  const created = nowIso();
  // Capture the per-story ISOLATION bit ONCE from the workspace flag — the §11.8
  // bootstrapping cut. Isolation keys off THIS captured bit, never the live flag, so
  // flipping the workspace flag never retroactively changes an already-open story. The
  // A story opened while the flag is ON captures isolated=1; while OFF, isolated=0.
  const isolated = workspaceBranchIsolation(workspaceId) ? 1 : 0;
  db.query(
    `INSERT INTO stories (id, workspace_id, brief, status, created_at, isolated) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, workspaceId, brief.trim(), "open", created, isolated);
  // A new `open` story gets a managed STORY-LEADER agent (Phase 3): mark it desired +
  // launch it. Thin hook into story-agent.ts so the CRUD here stays clean; the hook marks
  // desired synchronously and fires the launch best-effort (never fails story creation).
  onStoryCreated(id);
  return getStory(id)!;
}

/**
 * Apply a PARTIAL update to a story (brief and/or status), by KEY PRESENCE so updating
 * one field never clobbers the other. `brief` must be a non-empty string; `status` must
 * be one of open|done|aborted (400 otherwise — `merging`/`merge_blocked` are butchr-owned
 * transients, never settable via PATCH). 404 if the story is gone. Returns the refreshed row.
 * A patch with neither recognized key is a no-op refresh.
 *
 * ISOLATED-STORY "done" IS A REQUEST TO LAND (CONTRIBUTING §11.7, Phase E). For an isolated
 * story (isolated=1) currently `open`/`merge_blocked`, a PATCH `done` does NOT write `done`
 * (and does NOT fire `complete` / tear the leader down): instead the story enters `merging`
 * and the story→main landing path runs asynchronously (landStory) — only a landed-and-green
 * story reaches `done`. A NON-isolated story's `done` is byte-for-byte unchanged (immediate
 * `done` + `complete` report + leader teardown). From `merge_blocked`, a re-PATCH `done`
 * re-enters `merging` (the re-attempt loop).
 */
export function updateStory(
  id: string,
  patch: { brief?: unknown; status?: unknown },
): StoryRow {
  const story = getStory(id);
  if (!story) throw new HttpError(404, `story not found: ${id}`);

  // Validate up front (so an invalid brief/status is rejected before any side effect).
  let briefUpdate: string | null = null;
  if (patch.brief !== undefined) {
    if (typeof patch.brief !== "string" || !patch.brief.trim()) {
      throw new HttpError(400, "brief must be a non-empty string");
    }
    briefUpdate = patch.brief.trim();
  }
  if (
    patch.status !== undefined &&
    (typeof patch.status !== "string" || !STORY_STATUSES.has(patch.status))
  ) {
    throw new HttpError(400, "status must be 'open', 'done', or 'aborted'");
  }

  // REQUEST-TO-LAND interception: an isolated story's `done` (from `open`/`merge_blocked`)
  // routes through the story→main landing path instead of a direct `done` write. Set `merging`
  // via the GUARDED CAS (from open/merge_blocked, folding any brief update into the SAME write
  // so brief is atomic with the guarded status), keep the leader up, and drive landStory in the
  // background (restart-recoverable: boot recovery re-drives a `merging` story). Returns the row
  // immediately — the merge runs async + surfaces its outcome via attention events. A racing
  // terminal write that already moved the story off open/merge_blocked makes the CAS a no-op, in
  // which case we do NOT spin up the merge.
  const isLandRequest =
    patch.status === "done" &&
    story.isolated === 1 &&
    (story.status === "open" || story.status === "merge_blocked");
  if (isLandRequest) {
    const moved = setStoryStatus(id, "merging", {
      from: ["open", "merge_blocked"],
      set: briefUpdate !== null ? { brief: briefUpdate } : undefined,
    });
    if (moved) {
      onStoryStatusChanged(id, "merging"); // keep the leader up through the merge
      void landStory(id).catch((e) => {
        console.error(`[butchr] story ${id} landStory failed: ${(e as Error).message}`);
      });
    }
    return getStory(id)!;
  }

  // BRIEF-ONLY PATCH (no status): a plain brief edit is allowed in ANY state and never touches
  // status, so it skips the guarded transition entirely.
  if (patch.status === undefined) {
    if (briefUpdate !== null) {
      db.query(`UPDATE stories SET brief=? WHERE id=?`).run(briefUpdate, id);
    }
    return getStory(id)!;
  }

  // GUARDED STATUS TRANSITION (st-a632b2cc F2) — mirrors the task-level setStatus CAS: a PATCH
  // status write fires ONLY from a legal SOURCE state, so an illegal/racing transition is a
  // silent no-op (the row is left untouched and none of the side-effects below run). Legal
  // `from` per target:
  //   - `open`    : only a no-op from `open` — a terminal/merging/merge_blocked story can NEVER
  //                 be RE-OPENED (the re-open-from-done bug: writing `open` over a terminal `done`
  //                 would relaunch a leader for a story whose branch was already merged-and-deleted).
  //   - `done`    : from `open` only (the NON-isolated immediate-done; an isolated open/
  //                 merge_blocked `done` was intercepted as a land request above). Blocks a `done`
  //                 racing an in-flight `merging` and a re-`done` on a terminal row.
  //   - `aborted` : from `open`/`merge_blocked` — NOT `merging`, so an abort can never race an
  //                 in-flight landStory (a `merging` story's abort PATCH is a rejected no-op).
  // The pending_ask/ask_responder terminal clear + any brief update ride in the SAME guarded
  // write, so they apply iff the transition is legal.
  const legalFrom: Record<string, StoryStatus[]> = {
    open: ["open"],
    done: ["open"],
    aborted: ["open", "merge_blocked"],
  };
  const target = patch.status as StoryStatus;
  const set: Record<string, string | null> = {};
  if (briefUpdate !== null) set.brief = briefUpdate;
  // HYGIENE: a TERMINAL transition (`done`/`aborted`) clears any open story-level ask — leaving
  // stale `pending_ask`/`ask_responder` on a finished story is dead data and a pointless still-
  // answerable ask. (answerStoryAsk is otherwise the only writer that clears the pair.)
  if (target === "done" || target === "aborted") {
    set.pending_ask = null;
    set.ask_responder = null;
  }
  const changed = setStoryStatus(id, target, { from: legalFrom[target], set });
  if (!changed) {
    // Illegal/racing transition — row untouched, NO side-effects (matches task setStatus, where
    // a lost CAS just returns false and the caller bails).
    return getStory(id)!;
  }

  // A NODE going ABORTED tears down its LIVE members, or each in-flight member is STRANDED as an
  // orphaned standalone top-level task (its feedback re-routes to the CTO; it merges to main with
  // no story context) AND keeps a story_id/parent_id pointing at an aborted node whose completion
  // seam can never fire. Fire the shared cascade now that the abort has PROVABLY taken effect
  // (gated on the CAS) — an abort rejected against a terminal/merging story must NOT tear members
  // down. The member SELECT runs synchronously inside abortInflightMembers (before its first
  // await), so it captures the full live-member set now; per-member teardown completes async
  // (mirrors this file's `void landStory` fire-and-forget idiom). Already-MERGED members are
  // PRESERVED untouched.
  if (target === "aborted") {
    void abortInflightMembers(id).catch(() => {});
  }
  // STORY COMPLETION REPORTED UP (Phase 6): on the ENTRY into `done` (the CAS proved the row
  // actually moved open→done, so a no-op re-PATCH never re-notifies), report completion UP to
  // the CTO via a story-level attention event targeted at the WORKSPACE/CTO feed. Published
  // BEFORE the leader teardown below — the leader (the diff-review responder that merged the
  // last subtask) is provably still up, but the report is for the CTO, not it. (An isolated
  // story never reaches here for `done` — its land path publishes `complete` from landStory
  // only once the branch has actually landed on main.)
  if (target === "done") {
    publish({
      type: "story.attention",
      story_id: id,
      workspace_id: story.workspace_id,
      target: "cto",
      reason: "complete",
      detail: story.brief ?? null,
    });
  }
  // Drive the STORY-LEADER agent off the REAL status change (Phase 3): `done`/`aborted` stop the
  // leader (desired-down + teardown); `open` (re)launches it. Thin hook into story-agent.ts.
  onStoryStatusChanged(id, target);
  // UNIFIED-PATH completion teardown: a genuine story terminal (`done`/`aborted`) tears the
  // node's leader WORKSPACE row down too (the legacy onStoryStatusChanged only zeroes the
  // story_agent table), so the unified supervisor stops relaunching a finished story's leader.
  // `open` (reopen-as-no-op) must NOT tear down; the isolated-`done` land request returned early
  // above (landStory tears down on the actual land). Best-effort; no-op when the unified gate is OFF.
  if (target === "done" || target === "aborted") {
    void teardownLeaderWorkspaceForWork(id).catch(() => {});
  }
  return getStory(id)!;
}

// --- STORY-LEVEL ASK: leader <-> CTO <-> user (responder-redesign §4b/§4c) ----
//
// The story-level ASK is the leader's escalation seam: a leader raises a STORY-LEVEL
// question (its decomposition plan, a scope call, etc.) UP to the CTO, the CTO may
// ESCALATE it once to the user, and whoever owns it ANSWERS to clear it. State lives on
// the story row: `pending_ask` (the question text, NULL when none) + `ask_responder`
// ('cto' | 'user', NULL when none). These three helpers are the only writers of that
// pair. ADDITIVE + INERT: nothing calls them until the activation subtask wires the
// agent docs — no live behavior changes here.

/**
 * OPEN a story-level ask (the LEADER → CTO). 404 if the story is gone; 400 if the
 * question is blank; 409 if the story is not `open` (no asks on a done/aborted story);
 * 409 if an ask is already open (one ask at a time — answer/escalate the current one
 * first). Sets `pending_ask`=question, `ask_responder`='cto' and publishes
 * `story.attention { target:cto, reason:ask, detail:question }` so the CTO feed surfaces
 * it. Returns the refreshed StoryRow.
 */
export function openStoryAsk(id: string, question: unknown): StoryRow {
  const story = getStory(id);
  if (!story) throw new HttpError(404, `story not found: ${id}`);
  if (typeof question !== "string" || !question.trim()) {
    throw new HttpError(400, "question is required");
  }
  if (story.status !== "open") {
    throw new HttpError(409, `cannot open an ask on a ${story.status} story`);
  }
  if (story.pending_ask !== null) {
    throw new HttpError(409, "an ask is already open on this story");
  }
  const q = question.trim();
  db.query(`UPDATE stories SET pending_ask=?, ask_responder='cto' WHERE id=?`).run(q, id);
  publish({
    type: "story.attention",
    story_id: id,
    workspace_id: story.workspace_id,
    target: "cto",
    reason: "ask",
    detail: q,
    // DE-DUP MARKER (channel.ts reconnect-resync): the pending_ask text itself — durable +
    // REST-derivable (the work view exposes `pending_ask`), unlike the volatile `detail`. A new
    // ask cycle with a DIFFERENT question gets a new marker and re-fires. KNOWN/ACCEPTED LIMIT
    // (LOW): two DISTINCT ask cycles with byte-IDENTICAL question text collide on the same marker,
    // so the CTO bridge would suppress the second one's live push (the bridge never sees the
    // leader-targeted `ask-answered` that would clear its set). Bounded by the CTO's /api/work
    // pending_ask poll — acceptable here; we do NOT add an asked_at column to disambiguate.
    marker: q,
  });
  return getStory(id)!;
}

/**
 * ESCALATE the open ask (CTO → user) — the single story-level cto→user boundary. 404 if
 * the story is gone; 409 if there is no open ask OR it is not currently the CTO's
 * (`ask_responder` !== 'cto', so a re-escalation of a user-owned ask is rejected). Sets
 * `ask_responder`='user' and RE-PUBLISHES the ask toward the user
 * (`story.attention { target:user, reason:ask, detail:question }`, §4b). NO channel
 * bridge owns `target:user` (the CTO + leader feeds drop it); the dashboard's SSE
 * consumer surfaces it to the human. Returns the refreshed StoryRow.
 */
export function escalateStoryAsk(id: string): StoryRow {
  const story = getStory(id);
  if (!story) throw new HttpError(404, `story not found: ${id}`);
  if (story.pending_ask === null || story.ask_responder !== "cto") {
    throw new HttpError(409, "no open CTO-owned ask to escalate");
  }
  db.query(`UPDATE stories SET ask_responder='user' WHERE id=?`).run(id);
  publish({
    type: "story.attention",
    story_id: id,
    workspace_id: story.workspace_id,
    target: "user",
    reason: "ask",
    detail: story.pending_ask,
  });
  return getStory(id)!;
}

/**
 * ANSWER the open ask, clearing it (the CTO or the user, whoever owns it — mirroring task
 * feedback being answerable by either responder). 404 if the story is gone; 400 if the
 * answer is blank; 409 if there is no open ask. Clears `pending_ask`/`ask_responder` to
 * NULL and notifies the LEADER (`story.attention { target:story, reason:ask-answered,
 * detail:answer }`). Returns the refreshed StoryRow.
 */
export function answerStoryAsk(id: string, answer: unknown): StoryRow {
  const story = getStory(id);
  if (!story) throw new HttpError(404, `story not found: ${id}`);
  if (typeof answer !== "string" || !answer.trim()) {
    throw new HttpError(400, "answer is required");
  }
  if (story.pending_ask === null) {
    throw new HttpError(409, "no open ask to answer on this story");
  }
  const a = answer.trim();
  db.query(`UPDATE stories SET pending_ask=NULL, ask_responder=NULL WHERE id=?`).run(id);
  publish({
    type: "story.attention",
    story_id: id,
    workspace_id: story.workspace_id,
    target: "story",
    reason: "ask-answered",
    detail: a,
  });
  return getStory(id)!;
}

/**
 * LAND AN ISOLATED STORY (CONTRIBUTING §11.4/§11.5/§11.7, Phase E) — the orchestration around
 * the story→main merge: own the story-state transitions, the attention events, and the leader
 * teardown (the git mechanics live in tasks.mergeStoryBranch, run through the global merge
 * queue). Drives `→ merging` then, on the merge outcome:
 *   - LANDED  → store the story-level merge range, set `done`, report `complete` UP to the CTO,
 *               and tear the leader down (onStoryStatusChanged "done"). The ONLY path to `done`.
 *   - gateRed / postVerifyRed → `merge_blocked` + a `gate-red` attention event to the LEADER
 *               (it fixes the assembled story with MORE subtasks; leader kept up).
 *   - conflict → `merge_blocked` + a `merge-conflict` attention event to the CTO (a CTO/human
 *               git action in the story worktree — the leader has no worktree; runbook in `detail`).
 *   - mergeError → `merge_blocked` + a loud log (a rare non-conflict git failure; no event).
 * Idempotent + restart-safe: a no-op if the story is gone, non-isolated, or already terminal
 * (done/aborted); safe to call from updateStory (the PATCH path) and recoverMergingStories
 * (boot). The story branch + main are untouched on every non-landed outcome.
 */
/** Count of a story's TERMINAL-MERGED members (merged + rolled_back) — the gate-red de-dup
 * marker (channel.ts reconnect-resync). Mirrors the REST work view's `counts.merged +
 * counts.rolled_back` (and tasks.ts's identically-named completion-review marker), so the live
 * event and the reconnect-resync compute a byte-identical marker. */
function mergedMemberCount(storyId: string): number {
  return db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM tasks WHERE story_id=? AND (status='merged' OR status='rolled_back')`,
    )
    .get(storyId)!.n;
}

export async function landStory(storyId: string): Promise<StoryRow | null> {
  const story = getStory(storyId);
  if (!story) return null;
  // Only an ISOLATED story lands via this path; a non-isolated story is a programming error
  // here (updateStory never routes it in) — be defensive and no-op.
  if (story.isolated !== 1) return story;
  // Re-attemptable only from open/merge_blocked/merging; a done/aborted story is finished.
  if (story.status !== "open" && story.status !== "merge_blocked" && story.status !== "merging") {
    return story;
  }

  // Ensure the transient `merging` state (idempotent — updateStory already set it on the PATCH
  // path; boot recovery re-enters with it already set; a merge_blocked re-attempt flips it now).
  // GUARDED CAS from open/merge_blocked: if the story raced to a terminal state between the read
  // above and here, the CAS no-ops and we bail rather than clobber done/aborted back to merging.
  if (story.status !== "merging") {
    if (!setStoryStatus(storyId, "merging", { from: ["open", "merge_blocked"] })) {
      return getStory(storyId);
    }
    onStoryStatusChanged(storyId, "merging");
  }

  const outcome = await mergeStoryBranch(storyId);

  if (outcome.kind === "landed") {
    // GUARDED `done` write — CAS from `merging` ONLY. Clears any open ask on this terminal
    // transition too (hygiene, mirrors updateStory's terminal branch) — a landed story is
    // finished, so a stale answerable ask is dead data. If a concurrent abort already moved the
    // row merging→aborted, this CAS no-ops and the side-effects below DON'T fire (the abort owns
    // the terminal state); otherwise landStory's own `done` write wins.
    const landed = setStoryStatus(storyId, "done", {
      from: ["merging"],
      set: {
        merge_base_sha: outcome.baseSha,
        merged_sha: outcome.mergedSha,
        pending_ask: null,
        ask_responder: null,
      },
    });
    if (landed) {
      // Report `complete` UP to the CTO (the leader is provably still up here), THEN tear the
      // leader down. Only a landed-and-green story ever reaches this.
      publish({
        type: "story.attention",
        story_id: storyId,
        workspace_id: story.workspace_id,
        target: "cto",
        reason: "complete",
        detail: story.brief ?? null,
      });
      onStoryStatusChanged(storyId, "done");
      // Unified-path teardown of the node's leader workspace row (mirrors the updateStory
      // terminal branch) — only a landed-and-green isolated story reaches `done` here.
      void teardownLeaderWorkspaceForWork(storyId).catch(() => {});
    }
    return getStory(storyId);
  }

  // Every non-landed outcome leaves main + the story branch untouched → merge_blocked (the
  // leader is KEPT up to re-attempt). onStoryStatusChanged("merge_blocked") is a no-op stop
  // (the leader stays up), called for symmetry with the other transitions. GUARDED CAS from
  // `merging` ONLY: if a concurrent abort already terminalized the row, the CAS no-ops and we
  // bail rather than resurrect a terminal story to merge_blocked + re-fire its attention events.
  if (!setStoryStatus(storyId, "merge_blocked", { from: ["merging"] })) {
    return getStory(storyId);
  }
  onStoryStatusChanged(storyId, "merge_blocked");

  if (outcome.kind === "gateRed" || outcome.kind === "postVerifyRed") {
    // The assembled story failed its tests → notify the LEADER to fix it with more subtasks.
    const where = outcome.kind === "gateRed" ? "story re-gate" : "post-merge verify on main";
    publish({
      type: "story.attention",
      story_id: storyId,
      workspace_id: story.workspace_id,
      target: "story",
      reason: "gate-red",
      detail: `${where} RED — add subtask(s) to fix, then re-request completion. ${outcome.output}`.trim(),
      // DE-DUP MARKER (channel.ts reconnect-resync): the merged-member count, SHARED with
      // completion-review — a merge_blocked story is essentially always all-merged (members merge
      // into the story branch BEFORE the story→main attempt), and between two RED land attempts the
      // leader adds + merges fix subtasks, so this count advances and a genuine re-RED re-fires.
      marker: String(mergedMemberCount(storyId)),
    });
  } else if (outcome.kind === "conflict") {
    // The story↔main rebase conflicted: the LEADER cannot resolve it (no worktree). Notify
    // the CTO directly with the resolution runbook (a CTO/human git action IN the story worktree).
    const dir = getWorkspace(story.workspace_id);
    const storyWt = dir ? git.storyWorktreePath(dir.path, storyId) : `<repo>/butchr-story-${storyId}`;
    const branch = git.storyBranchName(storyId);
    const fileList = outcome.files.length ? ` (conflicting: ${outcome.files.join(", ")})` : "";
    publish({
      type: "story.attention",
      story_id: storyId,
      workspace_id: story.workspace_id,
      target: "cto",
      reason: "merge-conflict",
      // CTO RUNBOOK: resolve in the story worktree, then re-PATCH the story `done` to re-attempt.
      detail:
        `story↔main merge conflict${fileList} — resolve in the story worktree: ` +
        `cd ${storyWt} && git rebase $(git -C ${dir?.path ?? "<repo>"} branch --show-current || echo main); ` +
        `resolve + 'git add' each file, 'git rebase --continue'; then re-PATCH the story 'done' ` +
        `(PATCH /api/work/${storyId} {"status":"done"}) to re-attempt the land. Branch: ${branch}.`,
    });
  } else {
    // A rare non-conflict git failure — main untouched; surface loud, no spurious attention event.
    console.error(`[butchr] story ${storyId} story→main merge failed (non-conflict): ${outcome.message}`);
  }
  return getStory(storyId);
}

/**
 * BOOT RECOVERY (CONTRIBUTING §11.7, Phase E) — re-drive every story left mid-merge in
 * `merging` (butchr stopped while a story→main land was in flight) through landStory so it
 * lands (`done`) or bounces (`merge_blocked`) rather than stranding. The sibling of
 * tasks.recoverRollingBackTasks for the story level. Returns how many were re-driven.
 */
export async function recoverMergingStories(): Promise<number> {
  const rows = db.query<{ id: string }, []>(`SELECT id FROM stories WHERE status='merging'`).all();
  for (const r of rows) await landStory(r.id).catch(() => {});
  return rows.length;
}

/**
 * Delete a story. 404 if it is gone. LIVE (in-flight) member tasks are ABORTED first — their
 * agents/worktrees torn down — so none is STRANDED as an orphaned standalone top-level task
 * (its feedback re-routing to the CTO; merging to main with no story context). Already-MERGED
 * (or otherwise terminal) members are PRESERVED as a historical record — they are NOT deleted,
 * only detached: their story_id/parent_id is NULLed (tasks are real work; only the grouping goes
 * away), then the story row is removed. (The workspace cascade still removes a workspace's
 * stories wholesale.)
 */
export function deleteStory(id: string): void {
  if (!getStory(id)) throw new HttpError(404, `story not found: ${id}`);
  // FIRST abort the LIVE members so none is orphaned by the detach/DELETE below. Fire-and-forget
  // (deleteStory is deliberately synchronous — see story-agent.ts stopStoryAgent's note), but the
  // member SELECT inside the cascade runs synchronously NOW (before its first await), so it
  // captures every in-flight member while story_id is still set — the subsequent NULLing can't
  // hide a live member from the abort. abortTask works by task id, so the detach below never
  // races it. Terminal/merged members are skipped (preserved). Best-effort; never blocks delete.
  void abortInflightMembers(id).catch(() => {});
  // Tear down the story's managed STORY-LEADER agent FIRST (desired-down + close its
  // tab/pane + free its name) so the DELETE below — which cascade-removes its story_agent
  // row — can't strand an orphaned leader pane. Best-effort; never blocks delete.
  void stopStoryAgent(id).catch(() => {});
  // Same for the UNIFIED leader workspace row. Fired BEFORE the DELETEs: the helper's
  // synchronous prefix snapshots the leader rows + writes desired=0 before the `tasks`-row
  // DELETE below cascade-removes the workspace row, while the by-name pane teardown still
  // completes afterward — so no leader pane is orphaned. No-op when the unified gate is OFF.
  void teardownLeaderWorkspaceForWork(id).catch(() => {});
  // Detach member tasks (keep the tasks — only the grouping is removed). Clear BOTH the
  // legacy story_id AND the unified parent_id (step 6a — they move in lock-step) so a detached
  // member becomes a standalone top-level Work and no longer points at the about-to-be-removed
  // node. Clearing parent_id first also frees the node from any member FK reference.
  db.query(`UPDATE tasks SET story_id=NULL, parent_id=NULL WHERE story_id=?`).run(id);
  // Remove the story's materialized Work node (the `tasks` row whose id IS the story id — see
  // ensureStoryWorkNode). Members are already detached, so its self-FK has no referrers. A
  // no-op when the story was never materialized (no member was ever created/assigned).
  db.query(`DELETE FROM tasks WHERE id=?`).run(id);
  db.query(`DELETE FROM stories WHERE id=?`).run(id);
}

/**
 * Assign a task to a story (or clear its membership with `storyId === null`). 404 if the
 * task is gone; when assigning, 404 if the story is gone and 400 if the story belongs to a
 * DIFFERENT workspace than the task (the same cross-workspace integrity guard used
 * elsewhere — a task may only join a story IN ITS OWN workspace). Emits `task.updated` so
 * the webapp reflects the new story_id, and returns the refreshed TaskView (on which
 * story_id round-trips via the row spread). PURELY stored this phase.
 */
export function assignTaskToStory(taskId: string, storyId: string | null): TaskView {
  const task: TaskRow | null = getTask(taskId);
  if (!task) throw new HttpError(404, `task not found: ${taskId}`);

  if (storyId !== null) {
    if (typeof storyId !== "string") {
      throw new HttpError(400, "story_id must be a string or null");
    }
    const story = getStory(storyId);
    if (!story) throw new HttpError(404, `story not found: ${storyId}`);
    if (story.workspace_id !== task.workspace_id) {
      throw new HttpError(400, "story belongs to a different workspace than the task");
    }
  }

  // UNIFIED-WORK PARENT POINTER (step 6a): story_id and parent_id move in lock-step. When
  // assigning, materialize the story's Work node FIRST (idempotent — the FK anchor) so the
  // parent_id self-FK is satisfied; set parent_id == story_id. When clearing (storyId === null),
  // parent_id is cleared too → the task becomes standalone top-level Work.
  if (storyId !== null) ensureStoryWorkNode(storyId);
  db.query(`UPDATE tasks SET story_id=?, parent_id=? WHERE id=?`).run(storyId, storyId, taskId);
  const view = taskView(taskId)!;
  publish({ type: "task.updated", task: view });
  return view;
}

/**
 * Create a SUBTASK belonging to a story (Phase 5 — the surface the story LEADER uses to
 * decompose its story). 404 if the story is gone; 409 if the story is not `open` OR
 * `merge_blocked` (CONTRIBUTING §11.7, Phase E: a merge_blocked story accepts fix-subtasks
 * so the leader can repair a RED re-gate, then re-request the land; a `merging`/`done`/
 * `aborted` story rejects new work). Otherwise delegates to tasks.createTask, pinning the new
 * task to the story's OWN workspace and passing story_id — so the subtask is dispatched
 * exactly like any task, and its feedback then routes to the leader via the escalation chain
 * (Phase 2) + story channel (Phase 4). The delegation is ONE-WAY (stories.ts → tasks.ts);
 * createTask re-validates the same-workspace integrity itself.
 */
export async function createSubtask(
  storyId: string,
  args: {
    prompt: string;
    context?: string[];
    blockedBy?: string[];
    kind?: TaskKind;
    model?: string | null;
    tags?: string[];
    priority?: number | string | null;
    planPreview?: boolean;
    idea?: boolean;
    versionBump?: unknown;
    allowlist?: string[];
  },
): Promise<TaskView> {
  const story = getStory(storyId);
  if (!story) throw new HttpError(404, `story not found: ${storyId}`);
  if (story.status !== "open" && story.status !== "merge_blocked") {
    throw new HttpError(409, `cannot add a subtask to a ${story.status} story`);
  }
  return createTask(
    story.workspace_id,
    args.prompt,
    args.context ?? [],
    args.blockedBy ?? [],
    args.kind ?? "task",
    args.model ?? null,
    args.tags ?? [],
    args.priority ?? 0,
    args.planPreview ?? false,
    args.idea ?? false,
    args.versionBump ?? "patch",
    args.allowlist ?? [],
    story.id,
  );
}

// --- SURFACING: member-task ROLLUP + leader status (Phase 6) -----------------

/**
 * Per-story member-task ROLLUP: one count per canonical status (ALL_STATUSES) plus the
 * orthogonal `idle` pseudo-bucket, MIRRORING workspaces.counts but scoped to a story's
 * members (story_id == storyId) instead of a workspace. `idle` is a flag on a LIVE
 * in_progress agent (not a status), so it is peeled out of the in_progress count the same
 * way the workspace rollup does — keeping the two rollups byte-for-byte comparable.
 */
export function storyCounts(storyId: string): Record<string, number> {
  const rows = db
    .query<{ status: string; n: number }, [string]>(
      `SELECT status, COUNT(*) AS n FROM tasks WHERE story_id=? GROUP BY status`,
    )
    .all(storyId);
  const out: Record<string, number> = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0]));
  out.idle = 0;
  for (const r of rows) out[r.status] = r.n;
  const idle = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM tasks WHERE story_id=? AND status='in_progress' AND has_agent=1 AND idle=1`,
    )
    .get(storyId)!.n;
  out.idle = idle;
  out.in_progress -= idle;
  return out;
}

/**
 * A STORY DETAIL VIEW (Phase 6): the StoryRow plus a member-task `counts` rollup
 * (storyCounts — the same per-status shape the workspace views use) and the managed
 * LEADER-agent status (storyAgentStatus). Async because the leader status probes herdr
 * for live registration (mirrors workspaces' status reads). Powers GET /api/stories/:id
 * + the operator's story-progress surface so a reader sees each story's progress + its
 * leader in one call. Returns null if the story is gone.
 */
export type StoryView = StoryRow & {
  counts: Record<string, number>;
  leader: StoryAgentStatus;
};

export async function storyView(storyId: string): Promise<StoryView | null> {
  const story = getStory(storyId);
  if (!story) return null;
  return {
    ...story,
    counts: storyCounts(storyId),
    leader: await storyAgentStatus(storyId),
  };
}

/** A workspace's stories as enriched StoryViews (newest-first; mirrors listStories' order).
 *  Leader probes run concurrently (Promise.all). */
export async function listStoryViews(workspaceId: string): Promise<StoryView[]> {
  const views = await Promise.all(
    listStories(workspaceId).map((s) => storyView(s.id)),
  );
  return views.filter((v): v is StoryView => v !== null);
}

/** EVERY workspace's stories as enriched StoryViews — the cross-workspace operator surface
 *  behind GET /api/stories (newest-first across all workspaces). */
export async function allStoryViews(): Promise<StoryView[]> {
  const lists = await Promise.all(listWorkspaces().map((w) => listStoryViews(w.id)));
  const out = lists.flat();
  out.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return out;
}

// --- ABORT A STORY'S IN-FLIGHT MEMBERS: the shared cascade primitive ----------

/** Per-member outcome of an in-flight-member abort cascade: which subtasks were aborted,
 *  which failed to abort (best-effort), and which were left untouched (already terminal, or
 *  mid-rollback) with their status. */
export type MemberAbortOutcome = {
  aborted: string[];
  failed: string[];
  skipped: Array<{ id: string; status: TaskStatus }>;
};

/**
 * ABORT ALL of a story's IN-FLIGHT member subtasks — the single cascade primitive shared by
 * resetStory (re-decompose), updateStory(`aborted`), and deleteStory. Reuses tasks.abortTask
 * verbatim per member (signalAbort + worktree/agent teardown + the `aborted` transition +
 * task.updated SSE).
 *
 * A member is IN-FLIGHT (and so abortable) iff it is neither terminal (isTerminal — merged/
 * aborted/failed/rolled_back) nor `rolling_back` (mid-rollback-pipeline work this must NOT
 * yank). An already-MERGED (or otherwise terminal) member is PRESERVED untouched — it is a
 * historical record, reported in `skipped`; only LIVE members are torn down, never orphaned.
 * Aborting is best-effort PER member — a teardown failure on one is collected in `failed` and
 * never strands the rest. Pre-condition: the caller has already verified the story exists.
 *
 * The member SELECT runs synchronously at call time (before the first `await`), so a fire-and-
 * forget caller (`void abortInflightMembers(id)`) captures the full member set BEFORE it mutates
 * the node (e.g. deleteStory NULLing story_id) — no live member can slip the capture.
 */
export async function abortInflightMembers(storyId: string): Promise<MemberAbortOutcome> {
  const members = db
    .query<{ id: string; status: TaskStatus }, [string]>(
      `SELECT id, status FROM tasks WHERE story_id=?`,
    )
    .all(storyId);

  const aborted: string[] = [];
  const failed: string[] = [];
  const skipped: Array<{ id: string; status: TaskStatus }> = [];
  for (const m of members) {
    // Leave terminal AND mid-rollback members untouched — only IN-FLIGHT work is yanked.
    // An already-merged member is PRESERVED (historical record), never aborted.
    if (isTerminal(m.status) || m.status === "rolling_back") {
      skipped.push({ id: m.id, status: m.status });
      continue;
    }
    try {
      await abortTask(m.id);
      aborted.push(m.id);
    } catch {
      // Best-effort: one teardown failure must not strand the rest of the cascade.
      failed.push(m.id);
    }
  }
  return { aborted, failed, skipped };
}

// --- RESET A STORY: abort all in-flight subtasks (additive convenience) ------

/** The result of resetStory: the refreshed StoryView plus the per-member outcome — which
 *  subtasks were aborted, which failed to abort (best-effort), and which were left untouched
 *  (already terminal, or mid-rollback) with their status. */
export type StoryResetResult = {
  ok: true;
  story: StoryView | null;
  aborted: string[];
  failed: string[];
  skipped: Array<{ id: string; status: TaskStatus }>;
};

/**
 * RESET A STORY: abort ALL of a story's IN-FLIGHT subtasks in one call, so a story leader can
 * 'throw it all away and start over' and then re-decompose. ADDITIVE — it reuses tasks.abortTask
 * verbatim (signalAbort + worktree teardown + the `aborted` transition + task.updated SSE) and
 * does NOT touch the story row: the story stays `open` for the leader to re-decompose.
 *
 * A member is RESETTABLE iff it is neither terminal (isTerminal — merged/aborted/failed/
 * rolled_back) nor `rolling_back` (mid-rollback-pipeline work that reset must NOT yank). Those
 * non-resettable members are left exactly as they are and reported in `skipped` (with status).
 * Aborting is best-effort PER member — a teardown failure on one is collected in `failed` and
 * never strands the rest. 404 if the story is gone. Returns the per-member outcome + a fresh
 * StoryView. (Aborting members can never trip isStoryComplete — aborted ≠ merged/rolled_back —
 * so no spurious story-completion event fires.)
 */
export async function resetStory(storyId: string): Promise<StoryResetResult> {
  if (!getStory(storyId)) throw new HttpError(404, `story not found: ${storyId}`);
  // Reuse the shared cascade — reset is exactly "abort the in-flight members, leave the
  // story open". The story row is untouched here (no terminal transition).
  const { aborted, failed, skipped } = await abortInflightMembers(storyId);
  return { ok: true, story: await storyView(storyId), aborted, failed, skipped };
}
