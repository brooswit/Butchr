# RFC: CEO OPERATING MODEL — DESIGN OF RECORD (story st-30a7dccd)

> **Status: SHIPPED.** This document is the design of record for the CEO
> operating model, authored **from the landed implementation** across phases
> **A1 → C2** and finalized in **Phase D1**. It supersedes the pre-build RFC,
> which could not be committed verbatim through the task prompt (butchr truncates
> a task prompt at its first `##` header, a known constraint) — so every claim
> below is grounded in the code that exists in the tree today (`src/`, `test/`,
> `bin/`), with real function and endpoint names cited inline. The single
> runnable proof of the whole model is the **north-star acceptance test**
> (`test/rfc-ceo-operating-model-north-star.test.ts`, §3).

---

## 1. Thesis — the CTO pattern, lifted one tier up and across repos

butchr already had a working supervisory pattern **inside** a repo: a **CTO**
turns a human's intent into stories, a **story leader** decomposes each story
into subtasks, and **build agents** execute the leaves. The chain is:

```
CTO  →  story leader  →  build agent          (one repo)
```

REVAMP-4 introduced the **PROJECT** tier — a container that nests member repos —
and this RFC completes it by giving that tier a real operator: the **CEO**. The
CEO is the CTO pattern lifted **one rung up and generalized across repos**:

```
HUMAN  →  CEO  →  CTO  →  story leader  →  build agent      (a project of many repos)
```

The human talks to the CEO exactly as they talk to a CTO — high-level intent. The
CEO does **not** write code, forge stories, or run any repo's pipeline. It
**directs** the per-repo CTOs, and each CTO turns a directive into the actual
stories under its own repo. Every mechanism the CEO needs is the project-tier
analog of a mechanism that already existed one tier down:

| one tier down (repo)                         | the CEO's analog (project)                                   |
|----------------------------------------------|--------------------------------------------------------------|
| a human's intent → the CTO                    | the CEO's **directive** → a CTO (Q1)                          |
| the CTO creates a repo's stories              | the CEO fans **directives** across member repos (Q1)         |
| a leader sequences subtasks (`blocked_by`)    | the CEO sequences **stories across repos** node-on-node (Q3) |
| a leader signs off on a story's subtasks      | the CEO **reviews an initiative** across repos (Q5)          |
| the CTO operating brief                       | the **CEO operating brief** (Q4)                             |

The design principle throughout was **byte-identical-until-used**: every new
capability is inert on the paths that don't invoke it, so nothing already working
was re-gated.

---

## 2. The model — directives, initiatives, and the completion rollup

Two nouns carry the whole model:

- A **directive** is a `directive`-status **leaf** parented under a member repo
  node (`createDirective`, `src/stories.ts`). It is the CEO's unit of delegation:
  a brief a CTO turns into stories. A directive **runs no agent** and has **no
  worktree** — it is a piece of intent waiting for a CTO, surfaced on that repo's
  CTO channel until accepted or pushed back.
- An **initiative** is a set of directives sharing one `initiative_id`, fanned in
  one call across one or more member repos. It is the CEO's unit of *work*: "this
  cross-repo effort," tracked by a **completion rollup** that reports done only
  when **every** decomposed child story has landed.

A CEO **never** creates a story or a task directly. It creates directives
(grouped as an initiative); the repo CTOs create the stories; the story leaders
create the subtasks. This is enforced structurally by the creation-authority
table (`assertCreationAllowed`, `src/tasks.ts`): a `ceo` may create only `repo`
and `directive`; a `cto` only `story`; a `leader` only `subtask`.

---

## 3. The north-star acceptance test (the library-extraction scenario)

The canonical scenario the model is judged by is **extracting a library out of a
source repo**: stand up new library repos, build them, then gut the source repo
to depend on them — and don't start the gutting until the libraries exist.
`test/rfc-ceo-operating-model-north-star.test.ts` proves this end-to-end,
deterministically and CI-safely, driving the REST surface directly against
**throwaway sandbox repos** (temp `BUTCHR_DATA_DIR`/`BUTCHR_DB` + temp
`config.reposRoot` + injected git identity + `BUTCHR_HERDR_BIN=true` no-op leader
launches + `afterAll` cleanup — no network, no registry publish). It asserts
every hop:

1. **(a) create-new-repos (Phase A2).** The CEO stands up two library repos —
   `POST /api/projects/:id/repos/create` ×2 → a real `git init` repo on disk
   under `config.reposRoot`, each registered + parented under the project.
2. **(b) directive fan-out (Phase B1).** The CEO fans **one** initiative across
   all three member repos (the two new libraries + the source) —
   `POST /api/projects/:id/initiatives` with a `{targets:[…]}` body → one
   `directive` leaf per repo, all sharing one `initiative_id`, and **no** story /
   **no** leader forged by the initiative.
3. **(c) CTO accept & decompose (Phase A3).** Each repo's CTO turns its directive
   into an `initiative_id`-stamped story — `POST /api/work/:directiveId/stories`
   → the directive goes terminal `accepted` and the story's leader launches.
4. **(d) cross-repo sequencing (Phase A1) — the crown.** The source **consume**
   story is sequenced behind both library stories —
   `PUT /api/work/:id/blocked_by` → its leader is held **down** (`desired=0`, the
   node stays `open`) while the libraries are unlanded, and **auto-launches**
   (`desired=1`) the instant **both** library stories reach `done`.
5. **(e) cross-repo review (Phase C1).** On completion the CEO reviews what landed
   across every repo — `GET /api/projects/:id/initiatives/:iid/review` returns
   each repo's landed summary + merge sha + merged-subtask drill-down handles.

The test validates **orchestration plumbing, not agent cognition**. LLM cognition
is not determinism-testable, so the "CTO accept" is the accept *verb*, not a live
agent — the whole point is that the plumbing between the tiers is provable and
goes green in the gate. It mirrors the style of
`test/revamp4-cross-repo-initiative.test.ts` and the `bin/butchr selftest`
REST-client harness.

---

## 4. Resolved questions — what shipped

### Q1 — Directive delivery (Phase A3 / B1)

**Shipped.** A CEO delegates via a first-class `directive` work item rather than
the old `seedMemberRepoStory` cheat (which forged a story directly into a member
repo, skipping the CTO). The retired shortcut is gone; the real path is:

- **Create.** `createDirective(repoId, brief, initiativeId)` (`src/stories.ts`)
  inserts a `directive`-status leaf parented at the repo node, stamped with the
  shared `initiative_id`, its brief written to `task.md` as the prompt. No
  worktree, no agent. Fan-out lands one per target repo
  (`createProjectInitiative` / `createCrossRepoInitiative`).
- **Surface.** The directive is an attention status: `STATE_PHRASE.directive =
  "CEO directive"` (`src/channel.ts`), and the channel body for that state is
  `firstText(task.prompt, task.summary)` — so the directive brief appears on the
  target repo's **CTO** channel as the thing to act on.
- **Accept.** `POST /api/work/:directiveId/stories` → `acceptWorkDirective` →
  `acceptDirective` (`src/stories.ts`): the CTO turns the directive into 1+ real
  stories under the same repo, each inheriting the directive's `initiative_id`,
  each with its own leader; the directive is atomically CAS-claimed
  `directive → accepted` (race-safe — a concurrent double-accept can't
  double-decompose).
- **Push back.** The other CTO response reuses the existing escalate verb:
  `POST /api/work/:id/escalate` → `escalateWork`, bubbling the directive back up
  to the CEO when it can't be handled at the repo.

### Q2 — Create new repos (Phase A2)

**Shipped.** The CEO can stand up a brand-new repo, not just register an existing
one. `POST /api/projects/:id/repos/create` → `createRepoUnderProject`
(`src/workspaces.ts`) sanitizes the name to a single traversal-free segment,
`git init`s a fresh repo at `join(config.reposRoot, name)` via `git.initRepo`
(`src/git.ts` — `git init -b main`, durability config, `.butchr/` gitignore, a
root commit), then hands it to the existing `registerWorkspaceUnderProject` so the
repo node is materialized and parented under the project and a herdr workspace is
minted. `config.reposRoot` defaults to `join(dataDir, "repos")`
(`BUTCHR_REPOS_ROOT`). Guards: 404 (missing project), 400 (invalid/traversal
name), 409 (a non-empty path is never clobbered).

**The publish boundary.** butchr sequences on node **MERGE**, not on package
registry publish. A downstream repo depending on a new library is unblocked when
the library's story reaches `done`/merged in butchr — not when the library is
published to npm or any registry. Registry publish, if any, is a step *inside* a
story, invisible to the orchestrator. This keeps the whole model hermetic and
network-free (and is why the acceptance test needs no registry).

### Q3 — Cross-repo node-on-node `blocked_by` sequencing (Phase A1)

**Shipped.** A **story node** may now carry a dependency set, so one story can be
sequenced behind another — across repos. `setWorkBlockedBy` (`src/work-api.ts`)
routes by kind: a leaf keeps its byte-identical leaf behavior; a **node** routes
to `setStoryBlockedBy` (`src/tasks.ts`), which stores the set on the node's own
`tasks.blocked_by` and **kills the leader on block** (a held node stays `open`,
leader `desired=0`). A repo/project **container** still 409s (no dependency set on
a container). The launch gate is `storyLeaderReleasable` (`src/tasks.ts`), which
`onStoryCreated` (`src/workspace-agent.ts`) consults before launching a leader —
so a node *created* carrying an unmet blocker never launches in the first place.
Release is the dispatcher's node-arm sweep `reevaluateBlockedStoryNodes`
(`src/tasks.ts`, run from `reevaluateAllBlocked` after every merge): once every
blocker has reached a terminal landed state, the held leader is launched via the
same hook. Resolution is **global** (no directory scoping), which is exactly what
makes it work across repos. **Byte-identical until used:** a story with an empty
`blocked_by` launches its leader immediately, precisely as before this engine
landed.

### Q4 — The CEO operating-model brief (Phase C2)

**Shipped.** `buildCeoBrief(projectId)` (`src/workspace-agent.ts`) was rewritten
from a thin delegation-mechanics list into a genuine operating model that mirrors
the CTO brief one tier up. It tells the persistent, butchr-managed CEO session:
it supervises the PROJECT tier (`human → CEO → CTO → story leader → build`); that
cross-repo work flows through **directives**, not stories (it never forges a story
or task); how to seed single-repo and cross-repo initiatives
(`POST /api/projects/:id/initiatives`, both body shapes); how it receives work
(the human via its interactive terminal + the push-only project channel
`BUTCHR_CHANNEL_PROJECT`); and a **who-acts table** keyed by state (a pushed-back
directive → reshape/re-direct or escalate to the human; a child landed → track; an
initiative ready for review → review + accept or corrective follow-up; a repo
needed → create/register). The brief cites the **real** current endpoint names so
the CEO drives the live surface.

### Q5 — Cross-repo review (Phase C1)

**Shipped.** The CEO reviews landed work at **initiative** granularity — the
project-tier analog of a leader signing off on a story's subtasks, one rung up.

- **Rollup.** `GET /api/projects/:id/initiatives/:iid/review` →
  `reviewProjectInitiative` (`src/stories.ts`) returns, per child story, **what
  landed**: the story summary + its story-level merge sha + its merged subtasks
  (each a drill-down handle for `GET /api/work/:id/diff`). Still-pending directives
  (nothing landed) are excluded; 404 on a missing project/initiative.
- **Surface.** On the last child landing, `initiative.completed` fires up the
  project channel; the `AttentionBridge` (`src/channel.ts`) translates it into an
  `initiative_review` "READY FOR REVIEW" notification for the matching project
  bridge **only** (a story/CTO bridge stays silent). The completed initiative
  appears in `ceoInitiativesAwaitingReview` (`src/stories.ts`).
- **Accept.** `POST /api/projects/:id/initiatives/:iid/accept` →
  `acceptInitiativeReview` (`src/stories.ts`) stamps the sign-off, publishes
  `initiative.reviewed` (reporting completion up to the human), and drops the
  initiative out of the actionable set (no re-nag); it 409s an in-flight (not-done)
  initiative.
- **No CEO reject/rollback.** The per-diff merge stays the **CTO's**. The CEO's
  only corrective is a **new directive** (a follow-up `POST
  /api/projects/:id/initiatives`) — the model never adds a project-tier
  reject/rollback that would reach around the CTO's merge authority.

### Q6 — The phasing that was executed (A → D)

The build was sequenced so each phase landed a provable capability on top of the
prior one, on a moving foundation:

- **A1** — node-on-node `blocked_by` sequencing engine (Q3).
- **A2** — create-new-repos primitive (Q2).
- **A3** — directive create/accept/escalate machinery (Q1).
- **B1** — the capability flip: an initiative fans **directives**, not stories,
  with a uniform completion rollup (Q1).
- **C1** — cross-repo initiative review (Q5).
- **C2** — the CEO operating-model brief (Q4).
- **D1** — this design-of-record doc + the north-star acceptance test that proves
  A1 → C1 running together (§3).

### Q7 — Default-project-CEO reconciliation

**Shipped.** An existing single-repo install must come up already nested, with no
operator action. `migrateAdoptLooseReposUnderDefaultProject` (`src/db.ts`) is a
one-time, idempotent, reversible boot pass: if no default project exists **and** no
repo is already under some project **and** there is at least one loose repo, it
mints the deterministic `DEFAULT_PROJECT_ID = "proj-default"` (anchored to
`MIN(id)` of the loose repos, the same inert `status='merged'` / `parent_id NULL`
shape `createProject` mints) and reparents every loose repo under it in one
statement. Three ordered guards keep it non-coercive: it never mints a second
default, never re-adopts a deliberately-unregistered repo, and never forces itself
onto an install that already organizes its own repos. The CEO agent itself is
reconciled separately at boot by `reanchorAllCeoHomes` (`src/index.ts`, run before
operator reconcile), which anchors each project's CEO to its own home directory;
`setWorkspaceCeoEnabled` (`src/workspaces.ts`) toggles a project's CEO and
`ceoAgentStatus` reports its liveness. Repo/project nodes are excluded from the
`/api/work` list, so a repo merely gaining a parent pointer changes no observable
work — the reconciliation alters data, not routing.

---

## 5. RUNBOOK — driving the scenario live via the CEO terminal

To reproduce the north-star scenario against **real** repos, talk to the CEO in
its interactive terminal (the human↔CEO loop). The CEO drives the same REST
surface the acceptance test drives; the steps below are what it does on your
behalf. Substitute your project id for `<proj>`.

1. **Open the CEO terminal.** From the project's dashboard card use *Open CEO
   terminal* (or attach to the `ws-ceo-<proj>` pane). Confirm the CEO is live
   (`GET /api/projects/<proj>/ceo` → `live:true`).

2. **Create the library repos.** Tell the CEO: *"stand up two new library repos,
   `libcore` and `libutil`."* It runs, per repo:

   ```
   POST /api/projects/<proj>/repos/create   { "name": "libcore", "label": "Lib Core" }
   POST /api/projects/<proj>/repos/create   { "name": "libutil", "label": "Lib Util" }
   ```

   Each returns the new member repo's id (note them as `<libcore>` / `<libutil>`).

3. **Fan the initiative.** Tell the CEO the intent: *"build both libraries, then
   gut the source repo to depend on them."* It fans one cross-repo initiative:

   ```
   POST /api/projects/<proj>/initiatives
   { "targets": [
       { "repo": "<libcore>", "brief": "build the core library" },
       { "repo": "<libutil>", "brief": "build the util library" },
       { "repo": "<source>",  "brief": "gut the source and depend on the new libraries" }
   ] }
   ```

   Note the returned `initiative_id` (`<iid>`) and the per-repo directive ids.

4. **CTOs accept.** Each member repo's CTO sees its `CEO directive` on its channel
   and accepts it (this is where a *live agent* does the cognition the test
   simulates):

   ```
   POST /api/work/<directive id>/stories   { "targets": [ { "brief": "…" } ] }
   ```

   Each yields an `initiative_id`-stamped story under its repo, with a leader.

5. **Sequence the consume story.** So the source repo doesn't start until the
   libraries land, sequence its story behind the two library stories:

   ```
   PUT /api/work/<source story id>/blocked_by
   { "blocked_by": [ "<libcore story id>", "<libutil story id>" ] }
   ```

   The source story's leader stays down until both libraries reach `done`, then
   auto-launches — no manual kick needed.

6. **Review on completion.** When every child story lands, the CEO's project
   channel shows the initiative **READY FOR REVIEW**. Review what landed and sign
   off (or issue a corrective directive):

   ```
   GET  /api/projects/<proj>/initiatives/<iid>/review     # what landed per repo
   POST /api/projects/<proj>/initiatives/<iid>/accept     # sign off + report up
   ```

For a fully hermetic dry run with **no** real repos, run the automated proof
instead: `bun test test/rfc-ceo-operating-model-north-star.test.ts`.
