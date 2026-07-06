// Story service: create / get / list / update / delete stories + assign a task to a
// story. A STORY is a CONTAINER that GROUPS subtasks (tasks carry a nullable story_id
// FK — see the `stories` table + tasks.story_id column in db.ts).
//
// PHASE 1 — DATA MODEL + CRUD ONLY. This is the persistence foundation, fully INERT:
// nothing in the dispatch / review / lifecycle / responder / channel machinery reads a
// story or a task's story_id yet. Later phases add a story-leader agent (a mini-CTO that
// decomposes / feedbacks / merges) + a responder-escalation chain that consume it. This
// module mirrors the shape of src/workspaces.ts (a thin CRUD service over the DB).
import { ALL_STATUSES, db, ensureStoryWorkNode, getStoryRow, isTerminal, nowIso } from "./db.ts";
import type { StoryRow, StoryStatus, TaskKind, TaskRow, TaskStatus } from "./db.ts";
import { publish } from "./events.ts";
import * as git from "./git.ts";
import { generateInitiativeId, generateStoryId } from "./ids.ts";
import { abortTask, createTask, getTask, mergeStoryBranch, taskView } from "./tasks.ts";
import type { TaskView } from "./tasks.ts";
import { owningRepoOf } from "./work.ts";
// REVAMP-1 Phase C: the story lifecycle hooks live in workspace-agent.ts (moved there in S2
// alongside teardownLeaderWorkspaceForWork; the legacy story-agent.ts launcher was deleted in S5).
import {
  onStoryCreated,
  onStoryStatusChanged,
  storyAgentStatus,
  stopStoryAgent,
  teardownLeaderWorkspaceForWork,
} from "./workspace-agent.ts";
import type { StoryAgentStatus } from "./workspace-agent.ts";
import {
  HttpError,
  assertRepoIsProjectMember,
  getProject,
  getWorkspace,
  listWorkspaces,
  workspaceBranchIsolation,
} from "./workspaces.ts";

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
  // REVAMP Phase B.5b (story st-78a8b4e7): the story NODE's own `tasks` row is the SOLE story
  // record — the `stories` mirror is gone. The CAS writes it DIRECTLY. The `work_kind='node'`
  // guard means this can ONLY ever touch a NODE row (never clobber a leaf). The `from` race-guard
  // set + the `res.changes > 0` gating that drives the caller's side-effects are UNCHANGED from
  // the pre-flip stories-CAS (story st-a632b2cc) — byte-identical transition semantics.
  let where = "id=? AND work_kind='node'";
  params.push(id);
  if (opts.from !== undefined) {
    const froms = Array.isArray(opts.from) ? opts.from : [opts.from];
    where += ` AND status IN (${froms.map(() => "?").join(", ")})`;
    params.push(...froms);
  }
  const res = db.query(`UPDATE tasks SET ${assigns.join(", ")} WHERE ${where}`).run(...params);
  return res.changes > 0;
}

/** Look up a story by its id, or null if none matches. Thin wrapper over the canonical
 *  by-id read (db.getStoryRow) so there's a single definition of the stories row read. */
export function getStory(id: string): StoryRow | null {
  return getStoryRow(id);
}

/** A workspace's stories, newest-first (mirrors listTasks' ordering). REVAMP Phase B.4
 *  (story st-6372812d): reads the node rows from `tasks` (work_kind='node') — the
 *  authoritative source post-flip — with the EXPLICIT StoryRow column list so the shape
 *  is byte-identical to the old `SELECT * FROM stories`. B.3's dual-write keeps the values
 *  identical; the `stories` mirror stays until B.5. */
export function listStories(workspaceId: string): StoryRow[] {
  return db
    .query<StoryRow, [string]>(
      `SELECT id, workspace_id, brief, status, isolated, pending_ask, ask_responder,
              merge_base_sha, merged_sha, created_at
         FROM tasks WHERE workspace_id=? AND work_kind='node' ORDER BY created_at DESC`,
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
  // REVAMP Phase B.5b (story st-78a8b4e7): the story is materialized DIRECTLY as its Work NODE —
  // the `tasks` row whose id IS the story id — which is now the SOLE, authoritative story record
  // (the `stories` mirror is dropped). work_kind='node' + the node-only brief/isolated columns are
  // supplied; every other NOT NULL column takes its schema DEFAULT (kind='task',
  // version_bump='patch', has_agent=0, …) so the projection is valid, exactly as
  // migrateUnifyStoryParent / the old ensureStoryWorkNode materialized it. pending_ask/
  // ask_responder default NULL (no open ask on a fresh story).
  db.query(
    `INSERT INTO tasks (id, workspace_id, status, created_at, work_kind, brief, isolated)
     VALUES (?, ?, 'open', ?, 'node', ?, ?)`,
  ).run(id, workspaceId, created, brief.trim(), isolated);
  // A new `open` story gets a managed STORY-LEADER agent (Phase 3): mark it desired +
  // launch it. Thin hook into workspace-agent.ts so the CRUD here stays clean; the hook marks
  // desired synchronously and fires the launch best-effort (never fails story creation).
  onStoryCreated(id);
  return getStory(id)!;
}

/**
 * CREATE a PROJECT-LEVEL INITIATIVE (REVAMP-4 Phase 3 / P3d, story st-1a82a2e1) — the CEO's
 * delegation surface: the CEO seeds a STORY into a member repo, and that repo's own CTO/leader
 * turn it into work. This MIRRORS the human→CEO handoff one rung down (a brief a subordinate
 * decomposes), reusing the EXACT createStory machinery a CTO uses — the CEO does NOT own the
 * story's lifecycle, it DELEGATES: the created story lands `open` in the repo's workspace, gets its
 * managed LEADER (onStoryCreated), and its story-level asks / completion route to the repo's CTO
 * (existing story→cto routing), with the CEO above only via the P3a escalation ladder.
 *
 * `assertRepoIsProjectMember` enforces SINGLE-project scope: the repo must be registered under THIS
 * project (cross-repo spanning is P3e). One repo per initiative.
 *
 * REPO-PARENTING: createStory materializes the story NODE with parent_id NULL (a top-level story —
 * BYTE-IDENTICAL to a CTO-created story). To make the initiative bubble up to the CEO, we then
 * repoint its parent_id → the OWNING REPO node (its own workspace_id, which IS the repo node id by
 * S0a construction — the same shape migrateReparentTopLevelUnderRepo gives every top-level Work).
 * With the repo registered under the project, the story's chain is now story→repo→project ⇒
 * [{cto},{ceo},{user}] (immediate responder still {cto} — the CEO delegates, does not own). We do
 * NOT touch createStory itself, so the CTO/leader story-creation path stays byte-identical.
 */
export function createProjectInitiative(
  projectId: string,
  repoId: unknown,
  brief: unknown,
): StoryRow {
  return seedMemberRepoStory(projectId, repoId, brief);
}

/**
 * The SHARED per-repo initiative primitive behind both the single-repo (createProjectInitiative)
 * and CROSS-repo (createCrossRepoInitiative) surfaces: seed ONE story into a MEMBER repo of a
 * project and reparent it onto its owning repo node so its escalation chain reaches the CEO
 * (story→repo→project). BYTE-IDENTICAL to the original P3d createProjectInitiative body — the
 * single-repo path's behavior is unchanged. `assertRepoIsProjectMember` enforces the repo is
 * registered under THIS project (404/409). Does NOT stamp an initiative_id (single-repo
 * initiatives are ungrouped); the cross-repo caller stamps the grouping key on the returned node.
 */
function seedMemberRepoStory(projectId: string, repoId: unknown, brief: unknown): StoryRow {
  const repo = assertRepoIsProjectMember(projectId, repoId);
  // Reuse the CTO's story machinery verbatim — repo.id is the repo node id == its directory id
  // (S0a), the workspace createStory anchors the node + its leader to.
  const story = createStory(repo.id, brief);
  // Repoint the fresh story NODE onto its owning repo node so its escalation chain reaches the CEO
  // (story→repo→project). parent_id = the repo node id (== story.workspace_id) — the canonical S1
  // top-level shape. Immediate responder is unchanged ({cto}); only the chain gains the {ceo} tier.
  db.query(`UPDATE tasks SET parent_id=? WHERE id=? AND work_kind='node'`).run(repo.id, story.id);
  return getStory(story.id)!;
}

/** One target of a CROSS-repo initiative: a member repo id + the brief its child story carries. */
export type InitiativeTarget = { repo: unknown; brief: unknown };

/** A created CROSS-repo initiative: the grouping id, its project, and every per-repo child story. */
export type CrossRepoInitiative = {
  initiative_id: string;
  project_id: string;
  children: StoryRow[];
};

/** Mint an initiative grouping key not already in use by any node (mirrors uniqueStoryId). */
function uniqueInitiativeId(): string {
  for (let i = 0; i < 100; i++) {
    const id = generateInitiativeId();
    if (!db.query(`SELECT 1 FROM tasks WHERE initiative_id=?`).get(id)) return id;
  }
  return `${generateInitiativeId()}-${generateInitiativeId().slice(4)}`;
}

/**
 * CREATE a CROSS-REPO PROJECT INITIATIVE (REVAMP-4 Phase 3 / P3e) — the CEO's cross-repo delegation
 * surface: fan ONE initiative into MULTIPLE member repos, each landing an ordinary repo-scoped story
 * managed by that repo's own CTO/leader (reusing seedMemberRepoStory — the exact single-repo P3d
 * machinery). All children share ONE generated `initiative_id` grouping key so the completion ROLLUP
 * (listProjectInitiatives / reportInitiativeCompletionIfDone) can decide the initiative is DONE when
 * every child lands. The fan-out is PARALLEL/UNSEQUENCED in P3e: all children start immediately.
 * Cross-repo SEQUENCING (holding a repo-B child until a repo-A child merges) is NOT built here — it
 * needs node-on-node blocked_by, a separate follow-up (see the P3e R5 verification finding).
 *
 * `targets` must be a non-empty array of `{repo, brief}`. EVERY target is VALIDATED FIRST (repo is a
 * member of THIS project via assertRepoIsProjectMember — 404/409; brief non-blank — 400) BEFORE any
 * story is created, so a bad target rejects the whole initiative atomically (no half-created stories
 * with their leaders launched). Targets MAY repeat a repo (two stories in one repo, one initiative)
 * and MAY span repos (the point of P3e); a NON-member repo is refused by the member guard.
 */
export function createCrossRepoInitiative(
  projectId: string,
  targets: unknown,
): CrossRepoInitiative {
  if (!getProject(projectId)) throw new HttpError(404, `project not found: ${projectId}`);
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new HttpError(400, "targets must be a non-empty array of { repo, brief }");
  }
  // VALIDATE-ALL-FIRST: member-guard every target repo + require a non-blank brief BEFORE creating
  // any story, so an invalid target can't leave a partially-fanned initiative behind (createStory
  // launches a leader as a side effect). assertRepoIsProjectMember enforces same-project scope.
  const validated = (targets as InitiativeTarget[]).map((t) => {
    const repo = assertRepoIsProjectMember(projectId, t?.repo);
    if (typeof t?.brief !== "string" || !t.brief.trim()) {
      throw new HttpError(400, "each initiative target requires a non-empty brief");
    }
    return { repoId: repo.id, brief: t.brief };
  });
  const initiativeId = uniqueInitiativeId();
  const children: StoryRow[] = [];
  for (const v of validated) {
    const story = seedMemberRepoStory(projectId, v.repoId, v.brief);
    // Stamp the shared grouping key on the child node so the rollup can find its siblings.
    db.query(`UPDATE tasks SET initiative_id=? WHERE id=? AND work_kind='node'`).run(
      initiativeId,
      story.id,
    );
    children.push(getStory(story.id)!);
  }
  return { initiative_id: initiativeId, project_id: projectId, children };
}

// --- CROSS-REPO INITIATIVE COMPLETION ROLLUP (REVAMP-4 P3e) -------------------
//
// An initiative is DONE when EVERY per-repo child story (grouped by initiative_id) has landed
// `done`. These reads power GET /api/projects/:id/initiatives (the CEO's authoritative pull view)
// and the live completion push (reportInitiativeCompletionIfDone), MIRRORING story completion one
// rung up. Membership is scoped to the project by joining each child node → its owning repo node
// (parent_id) → the project (repo.parent_id === projectId), the same repo→project link
// registerRepoUnderProject writes.

/** One per-repo child of an initiative in the rollup view. */
export type InitiativeChild = {
  id: string;
  workspace_id: string;
  status: StoryStatus;
  brief: string | null;
};

/** A cross-repo initiative's rolled-up state: its children (across repos) + whether ALL are done. */
export type InitiativeView = {
  initiative_id: string;
  project_id: string;
  done: boolean;
  children: InitiativeChild[];
};

/** Group a flat, initiative-ordered child list into InitiativeViews (done = every child `done`). */
function rollupInitiatives(
  projectId: string,
  rows: Array<InitiativeChild & { initiative_id: string }>,
): InitiativeView[] {
  const byId = new Map<string, InitiativeChild[]>();
  for (const r of rows) {
    const list = byId.get(r.initiative_id) ?? [];
    list.push({ id: r.id, workspace_id: r.workspace_id, status: r.status, brief: r.brief });
    byId.set(r.initiative_id, list);
  }
  return [...byId.entries()].map(([initiative_id, children]) => ({
    initiative_id,
    project_id: projectId,
    done: children.length > 0 && children.every((c) => c.status === "done"),
    children,
  }));
}

/** The cross-repo initiatives under a project (grouped by initiative_id), each with its per-repo
 *  children + rolled-up doneness. 404 if the project is gone. The CEO's authoritative rollup view
 *  behind GET /api/projects/:id/initiatives. */
export function listProjectInitiatives(projectId: string): InitiativeView[] {
  if (!getProject(projectId)) throw new HttpError(404, `project not found: ${projectId}`);
  const rows = db
    .query<InitiativeChild & { initiative_id: string }, [string]>(
      `SELECT s.id, s.workspace_id, s.status, s.brief, s.initiative_id
         FROM tasks s JOIN tasks r ON r.id = s.parent_id AND r.work_kind='repo'
        WHERE s.work_kind='node' AND s.initiative_id IS NOT NULL AND r.parent_id = ?
        ORDER BY s.initiative_id, s.created_at`,
    )
    .all(projectId);
  return rollupInitiatives(projectId, rows);
}

/** ONE cross-repo initiative under a project by its grouping id (rolled-up), or null if there is no
 *  such initiative in this project. 404 if the project is gone. */
export function getProjectInitiative(
  projectId: string,
  initiativeId: string,
): InitiativeView | null {
  return listProjectInitiatives(projectId).find((i) => i.initiative_id === initiativeId) ?? null;
}

/**
 * COMPLETION PUSH (REVAMP-4 P3e) — called right after a story NODE lands `done` (updateStory's
 * immediate-done branch + landStory's landed branch). If the story belongs to a CROSS-repo
 * initiative (initiative_id set) AND every sibling child has now landed `done`, publish
 * `initiative.completed` up the PROJECT channel — mirroring story completion one rung up. A no-op
 * for a story with no initiative_id (single-repo P3d initiatives + ordinary stories are untouched,
 * so this is byte-identical for them) or when siblings are still in flight. Best-effort read-only.
 */
export function reportInitiativeCompletionIfDone(storyId: string): void {
  const iid = db
    .query<{ initiative_id: string | null }, [string]>(
      `SELECT initiative_id FROM tasks WHERE id=? AND work_kind='node'`,
    )
    .get(storyId)?.initiative_id;
  if (!iid) return;
  const siblings = db
    .query<{ status: string }, [string]>(
      `SELECT status FROM tasks WHERE initiative_id=? AND work_kind='node'`,
    )
    .all(iid);
  if (siblings.length === 0 || !siblings.every((s) => s.status === "done")) return;
  // Resolve the owning project (the child's repo's parent) so the push is project-scoped.
  const projectId = db
    .query<{ project_id: string | null }, [string]>(
      `SELECT r.parent_id AS project_id
         FROM tasks s JOIN tasks r ON r.id = s.parent_id AND r.work_kind='repo'
        WHERE s.id=?`,
    )
    .get(storyId)?.project_id;
  if (!projectId) return;
  publish({
    type: "initiative.completed",
    project_id: projectId,
    initiative_id: iid,
    detail: `initiative ${iid}: all ${siblings.length} member-repo stories landed`,
  });
}

/**
 * F5 (story st-a632b2cc) — tear down a leaked ISOLATED story's worktree + branch AFTER its
 * member cascade settles (so no member worktree is still checked out against the story branch).
 * Mirrors the landed path (tasks.mergeStoryBranch → git.removeStoryBranch), but for the
 * abort/delete paths, which previously left `<repo>/butchr-story-<id>` + `butchr/story/<id>`
 * to leak until the next boot reaper. Best-effort + idempotent (git.removeStoryBranch tolerates
 * an already-removed / never-materialized branch); a no-op for a NON-isolated story (its abort/
 * delete must not error). Always swallows the abort-promise rejection so it never blocks abort/
 * delete. Chained off the member-abort promise so the story worktree is removed only after the
 * members are torn down.
 */
function cleanupIsolatedStoryBranch(
  story: { id: string; workspace_id: string; isolated: number },
  afterMembers: Promise<unknown>,
): void {
  if (story.isolated !== 1) {
    void afterMembers.catch(() => {});
    return;
  }
  const dir = getWorkspace(story.workspace_id);
  if (!dir) {
    void afterMembers.catch(() => {});
    return;
  }
  void afterMembers
    .then(() => git.removeStoryBranch(dir.path, git.storyBranchName(story.id)))
    .catch(() => {});
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
      // B.5b (st-78a8b4e7): write the story NODE row directly (the `stories` mirror is gone).
      db.query(`UPDATE tasks SET brief=? WHERE id=? AND work_kind='node'`).run(briefUpdate, id);
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
    // F3: pass `hold` so the live members are latched non-mergeable SYNCHRONOUSLY here (belt-and-
    // suspenders alongside S1's F1 parent-status guard — the story is provably `aborted` by the
    // CAS above, but the latch closes the window at the member level too). F5: after the cascade,
    // remove the leaked isolated story worktree + branch.
    cleanupIsolatedStoryBranch(story, abortInflightMembers(id, { hold: true }));
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
    // CROSS-REPO INITIATIVE ROLLUP (P3e): if this story is a member of a cross-repo initiative and
    // it was the LAST child to land, push `initiative.completed` up the project channel. No-op for a
    // story with no initiative_id (byte-identical for single-repo / ordinary stories).
    reportInitiativeCompletionIfDone(id);
  }
  // Drive the STORY-LEADER agent off the REAL status change (Phase 3): `done`/`aborted` stop the
  // leader (desired-down + teardown); `open` (re)launches it. Thin hook into workspace-agent.ts.
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
  // B.5b (st-78a8b4e7): write the story NODE row directly (the `stories` mirror is gone).
  db.query(`UPDATE tasks SET pending_ask=?, ask_responder='cto' WHERE id=? AND work_kind='node'`).run(q, id);
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
  // TODO (REVAMP-4, deferred to P3f — story st-1a82a2e1): this is a SINGLE-HOP cursor (cto→user).
  // Once a repo is registered under a PROJECT (P3d), a CTO escalating an ask in that repo SHOULD
  // advance to the CEO (the project's supervisor) BEFORE the user — i.e. walk the container ladder
  // (work.workResponderChain) rather than jump straight to `user`. Generalizing this cursor is a
  // SEPARATE piece; P3d deliberately does NOT touch it, so escalateStoryAsk stays byte-identical
  // (proven by a non-project-repo cto→user test) and the CEO rung is opt-in via the escalation
  // CHAIN, not this runtime cursor.
  // B.5b (st-78a8b4e7): write the story NODE row directly (the `stories` mirror is gone).
  db.query(`UPDATE tasks SET ask_responder='user' WHERE id=? AND work_kind='node'`).run(id);
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
  // B.5b (st-78a8b4e7): write the story NODE row directly (the `stories` mirror is gone).
  db.query(`UPDATE tasks SET pending_ask=NULL, ask_responder=NULL WHERE id=? AND work_kind='node'`).run(id);
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
      `SELECT COUNT(*) AS n FROM tasks WHERE parent_id=? AND work_kind='leaf' AND (status='merged' OR status='rolled_back')`,
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
      // CROSS-REPO INITIATIVE ROLLUP (P3e): an isolated initiative child landing on main may be the
      // last sibling — push `initiative.completed` up the project channel (no-op if ungrouped).
      reportInitiativeCompletionIfDone(storyId);
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
  // REVAMP Phase B.4 (story st-6372812d): read the `merging` node ids from the authoritative
  // `tasks` node rows (work_kind='node'), not the `stories` mirror. SAFE against the two
  // non-transactional dual-writes in setStoryStatus: (1) that write is synchronous (no await
  // between the stories UPDATE and mirrorStoryNode), so a running process never exposes a
  // mid-state; (2) a hard crash between them self-heals at boot — migrateBackfillNodeFold
  // re-syncs every node's tasks.status FROM stories in runMigrations, which runs BEFORE this
  // recovery scan (index.ts). So the tasks node row is authoritative by the time we read it.
  const rows = db
    .query<{ id: string }, []>(`SELECT id FROM tasks WHERE work_kind='node' AND status='merging'`)
    .all();
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
  const story = getStory(id);
  if (!story) throw new HttpError(404, `story not found: ${id}`);
  // FIRST abort the LIVE members so none is orphaned by the detach/DELETE below. Fire-and-forget
  // (deleteStory is deliberately synchronous — see workspace-agent.ts stopStoryAgent's note), but the
  // member SELECT inside the cascade runs synchronously NOW (before its first await), so it
  // captures every in-flight member while story_id is still set — the subsequent NULLing can't
  // hide a live member from the abort. abortTask works by task id, so the detach below never
  // races it. Terminal/merged members are skipped (preserved). Best-effort; never blocks delete.
  //
  // F3 ORPHAN-MERGE WINDOW: `hold` latches `aborting=1` on the live members in this call's
  // SYNCHRONOUS prefix (before its first await) — so by the time the NULLing/DELETE below runs,
  // a concurrent finalizeMerge can no longer merge a member to main as a standalone orphan. The
  // latch is the load-bearing guard HERE: deleting the story row + NULLing story_id blinds S1's
  // F1 parent-status guard (it reads the now-gone `stories` row), but the member-level `aborting`
  // latch survives the detach. Keep the promise to sequence the F5 branch cleanup after teardown.
  const aborting = abortInflightMembers(id, { hold: true });
  // Tear down the story's managed STORY-LEADER agent FIRST (desired-down + close its
  // tab/pane + free its name) so the DELETE below — which cascade-removes its story_agent
  // row — can't strand an orphaned leader pane. Best-effort; never blocks delete.
  void stopStoryAgent(id).catch(() => {});
  // Same for the UNIFIED leader workspace row. Fired BEFORE the DELETEs: the helper's
  // synchronous prefix snapshots the leader rows + writes desired=0 before the `tasks`-row
  // DELETE below cascade-removes the workspace row, while the by-name pane teardown still
  // completes afterward — so no leader pane is orphaned. No-op when the unified gate is OFF.
  void teardownLeaderWorkspaceForWork(id).catch(() => {});
  // Detach member tasks (keep the tasks — only the grouping is removed). REVAMP-4 S1: a detached
  // member becomes TOP-LEVEL Work, so it re-parents onto its OWNING REPO node (its workspace_id's
  // repo node — the members all share the story's workspace) rather than NULL, preserving the
  // invariant. The correlated subquery mirrors migrateReparentTopLevelUnderRepo; it yields NULL
  // (the pre-S1 behavior) if no repo node exists. Either way the member no longer points at the
  // about-to-be-removed story node, freeing its self-FK reference.
  db.query(
    `UPDATE tasks SET parent_id=(SELECT r.id FROM tasks r WHERE r.id=tasks.workspace_id AND r.work_kind='repo')
       WHERE parent_id=?`,
  ).run(id);
  // Remove the story's Work node (the `tasks` row whose id IS the story id — the authoritative
  // story record). Members are already detached, so its self-FK has no referrers, and its
  // story_agent row is cascade-removed via the story_agent→tasks(id) FK (B.5b re-pointed it off
  // the dropped `stories` table). A no-op when the story was never materialized.
  db.query(`DELETE FROM tasks WHERE id=?`).run(id);
  // F5: after the member cascade settles, tear down the leaked isolated story worktree + branch.
  // The workspace is NOT deleted here, so getWorkspace (inside the helper) still resolves; the
  // story row is gone but we captured `story` up front. Best-effort; a no-op for a non-isolated
  // story (its delete must not error).
  cleanupIsolatedStoryBranch(story, aborting);
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
    // STORY-STATUS GUARD (story st-a632b2cc F4): only an ASSIGNABLE story accepts new members —
    // mirror createSubtask's creation guard (open|merge_blocked accept; merging/done/aborted
    // reject). Without this, an in-flight task could be assigned into a terminal/merging story and
    // (via F1's isolated branch resolution) merge into a branch its container already stopped
    // accepting work into. Applies ONLY on the ASSIGN branch; clearing (storyId===null) below
    // stays unguarded — detaching a member is always allowed.
    if (story.status !== "open" && story.status !== "merge_blocked") {
      throw new HttpError(409, `cannot assign a task to a ${story.status} story`);
    }
  }

  // UNIFIED-WORK PARENT POINTER: parent_id is the SOLE membership pointer as of B.5b
  // (st-78a8b4e7; the legacy story_id column is dropped). The story's Work node already exists
  // (getStory above 404s otherwise → its node is present), so the parent_id self-FK is satisfied;
  // ensureStoryWorkNode is a defensive no-op belt. REVAMP-4 S1: when clearing (storyId === null)
  // the task becomes TOP-LEVEL Work, so it re-parents onto its OWNING REPO node (owningRepoOf,
  // which resolves the workspace's repo node — its id == workspace_id) rather than NULL,
  // preserving the invariant.
  if (storyId !== null) ensureStoryWorkNode(storyId);
  const effectiveParent = storyId ?? owningRepoOf(task.workspace_id);
  db.query(`UPDATE tasks SET parent_id=? WHERE id=?`).run(effectiveParent, taskId);
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
  // `work_kind='leaf'` is explicit (B.2): a story's members are always leaves and the node's own
  // parent_id is NULL, so the node is never counted here — structural node-exclusion. Membership
  // is by parent_id (B.5b st-78a8b4e7 — the SOLE membership pointer; story_id column dropped).
  // Mirrors the same guard on the tasks.ts story-rollup reads.
  const rows = db
    .query<{ status: string; n: number }, [string]>(
      `SELECT status, COUNT(*) AS n FROM tasks WHERE parent_id=? AND work_kind='leaf' GROUP BY status`,
    )
    .all(storyId);
  const out: Record<string, number> = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0]));
  out.idle = 0;
  for (const r of rows) out[r.status] = r.n;
  const idle = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM tasks WHERE parent_id=? AND work_kind='leaf' AND status='in_progress' AND has_agent=1 AND idle=1`,
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
 *
 * `opts.hold` (story st-a632b2cc F3) — when set, SYNCHRONOUSLY latches `aborting=1` on the LIVE
 * members (the same ones this is about to abort — NOT the skipped terminal/merged/rolling_back
 * ones) in this pre-await prefix, so a fire-and-forget caller closes the orphan-merge WINDOW
 * BEFORE its next line runs (deleteStory NULLing story_id / removing the story row). With the
 * story row gone, the F1 parent-status guard can't see the parent; the member-level `aborting`
 * latch is what finalizeMerge/maybeAutoMerge then refuse on. ONLY the abort+delete callers pass
 * it; resetStory does not (its story stays open — members abort normally, no latch).
 */
export async function abortInflightMembers(
  storyId: string,
  opts: { hold?: boolean } = {},
): Promise<MemberAbortOutcome> {
  const members = db
    .query<{ id: string; status: TaskStatus }, [string]>(
      // Membership by parent_id (B.5b st-78a8b4e7 — the SOLE membership pointer; story_id dropped).
      // The story node's parent_id is NULL, so it is never returned here.
      `SELECT id, status FROM tasks WHERE parent_id=?`,
    )
    .all(storyId);

  // The LIVE (abortable) members — neither terminal nor mid-rollback. Computed from the SAME
  // synchronous capture the loop iterates, so the latch covers exactly what gets torn down.
  const liveIds = members
    .filter((m) => !isTerminal(m.status) && m.status !== "rolling_back")
    .map((m) => m.id);
  // F3 WINDOW-CLOSE: latch the live members non-mergeable NOW, before the first `await`. A
  // fire-and-forget caller's subsequent synchronous lines (story_id=NULL / DELETE) therefore
  // run only AFTER every live member is already refused by finalizeMerge — no orphan can merge.
  if (opts.hold && liveIds.length > 0) {
    db.query(
      `UPDATE tasks SET aborting=1 WHERE id IN (${liveIds.map(() => "?").join(", ")})`,
    ).run(...liveIds);
  }

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
