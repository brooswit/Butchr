# RFC: WORK + WORKSPACE UNIFICATION — CTO SIGN-OFF REQUESTED (story st-540ba705)

DESIGN-FIRST. No code/subtasks until you sign off. Requesting your ruling on the
model + phasing below, and on the flagged questions (some likely CEO calls). I
grounded this in the current code, not assumptions.

> **Status: SIGNED OFF.** The CTO has ruled on all nine questions (CEO looped in
> on the CEO-level calls). The original questions and their resolutions are recorded
> in [§7 Resolved questions](#7-resolved-questions-cto-sign-off) at the foot of this
> document. This RFC is the design of record for story **st-540ba705**; the
> implementation spine is sequenced but **not yet enqueued** (see the gate in §6).

---

## 1. Motivation

butchr currently models work as **two parallel, special-cased resources**:

- **`tasks`** — the atomic unit (a leaf of work: one worktree, one branch, one agent).
- **`stories`** — a container of subtasks with a persistent **story leader** agent
  (a mini-CTO) that decomposes, gives feedback, and merges.

These two grew independently and now overlap heavily. A story is "a task that has
children and a leader"; a task is "a story with no children and a worker." Every
cross-cutting feature — feedback routing, branch isolation, agent identity — has had
to be implemented **twice** (once for tasks, once for stories) and reconciled by
hand. Three recently-merged stories are each a *special case* of one general idea:

- **B — 3-level branch isolation** (`branch_isolation`, shipped INERT): a story gets
  its own branch; subtasks merge into it; it re-gates and merges to the default
  branch. This is "branch-per-node" hardcoded to exactly **one** level of nesting.
- **C — parent-based feedback** (responder redesign, story st-def561dd): subtask
  feedback is terminal at the **leader**, story feedback bubbles to the **CTO**. This
  is "feedback bubbles to the parent" hardcoded to exactly **two** tiers.
- **D — name-only agent identity** (story st-a77b050f): an agent is addressed by
  NAME, not a stored pane. Applied separately to build agents, leaders, and the CTO.

Each is the **one-level instance of a recursive rule.** Unifying `tasks` + `stories`
into a single self-referential **Work** resource, and `agents` + `directory` into a
single **Workspace** execution context, lets these three features fall out as the
*general* case instead of three bespoke implementations. This is the biggest change
to butchr's core model, hence: design-first, CTO sign-off, no code until then.

---

## 2. The model — two concepts

### 2.1 WORK — one self-referential resource (`parent_id`)

Unify `tasks` and `stories` into **one** resource, `work`, made self-referential by a
`parent_id` foreign key:

- A **leaf** (no children) is what we call a *task* today — it has a worktree, a
  branch, and a build agent.
- A **node** (has children) is what we call a *story* today — it has a leader and
  decomposes into child Work.
- The distinction is **structural, not a type column**: leaf-vs-node is "does this row
  have children." A leaf can grow children (decomposition) and a node can be emptied
  without a schema change.

**Feedback bubbles to the PARENT, recursively.** Any feedback surface (a question, a
spec to approve, a diff to review, an idle agent) is routed to the **parent** Work's
responder. That parent may itself be Work with a parent, so feedback walks up the tree
— leaf → node → … → **CTO** → **user** — instead of the hardcoded two-tier
(subtask→leader, story→CTO) rule. The recursion bottoms out at top-level Work
(`parent_id` NULL), whose parent-responder is the **CTO**, and the CTO's single
escalation boundary above it is the **user**.

- **EXCEPTION — `needs_user_input`:** a feedback state that means "only a human can
  answer this" routes **straight to the user**, short-circuiting the bubble-up. This
  is the generalized form of today's `escalated_to_user`.

**`blocked_by` is reused unchanged** — and because everything is now Work, a story can
block a story, a task can block a story, etc., with no new mechanism.

### 2.2 WORKSPACE — the (agent + directory) execution context

Today "workspace" is a misnomer: the `workspaces` table is really a **directory +
config** (a registered git repo with its gate/version/changelog settings). The
*agent* side (build agent, story leader, CTO) is modeled separately and three times.

Unify the agent surfaces into one **Workspace** = the **(agent + directory)**
execution context in which Work runs:

- A Workspace pairs a **live agent** (addressed by name — generalizing story D across
  all agent kinds) with a **directory** (a git worktree or the repo root).
- **Work HAS workspace(s)**; the **CTO HAS workspace(s)** too — the CTO is itself a
  Workspace (`kind=cto`). This collapses build-agent / leader-agent / CTO-agent into
  one concept distinguished by `kind`, not three parallel tables.
- A Workspace is **NOT** the same thing as Work. Work is *what* is being done;
  Workspace is *where and by whom* it runs. To avoid the name collision, today's
  `workspaces` table (directory+config) is **renamed `directory`** and "workspace"
  is freed up to mean agent+dir (see Q1).

---

## 3. Questions & recommendations

Each question records my recommendation; the CTO's resolution is in §7.

- **Q1 (likely CEO call) — naming.** Rename today's `workspaces` table (really a
  directory + config) → **`directory`**, freeing "workspace" to mean the
  agent+directory execution context. Done as a **pre-1.0 in-place conceptual rename**
  (guarded `ALTER … RENAME`, the sanctioned exception in CONTRIBUTING §5 — preserves
  every row and opaque `dir-…` id VALUE), not a drop/recreate.

- **Q2 — how to unify tasks + stories.** **Generalize the existing `tasks` table into
  `work` in place.** `tasks` already carries the superset of columns; migrate each
  `stories` row → a `work` row with children, and `story_id` → `parent_id`. Don't
  build a third table — evolve the one that already holds the richer shape.

- **Q3 — Work↔Workspace cardinality.** **1:N, one live at a time.** A unit of Work may,
  over its life, be associated with several Workspaces (a resumed agent, a re-dispatch),
  but exactly **one is live** at any moment — mirroring today's "a running task has one
  pane" invariant.

- **Q4 — status.** **One unified status enum** (the superset of task + story states),
  with **kind-conditioned valid sets** — a leaf and a node draw their legal
  transitions from the same enum but are constrained to the subset that makes sense for
  their structural role.

- **Q5 — is the CTO Work or Workspace?** The CTO is a **Workspace** (`kind=cto`), not
  Work. It executes and responds; it is not itself a unit of work that gets reviewed
  and merged.

- **Q6 — who is the parent of top-level Work?** Top-level Work (`parent_id` NULL) has
  the **CTO** as its parent-responder — the recursion's base case, so the bubble-up
  rule needs no special "if null" branch beyond resolving to the CTO Workspace.

- **Q7 — API surface.** **Unify to `/api/work/*`.** Keep `/api/tasks` and
  `/api/stories` as **identical thin adapters** over the unified model until the
  cutover, then **delete** them (pre-1.0, no back-compat shim — CONTRIBUTING’s
  no-legacy rule). The adapters must behave **byte-identically** to today's endpoints
  for the whole transition.

- **Q8 — nesting depth.** **Arbitrary depth.** Nothing in the recursive feedback /
  branch / addressing rules needs a depth cap; a node may contain nodes to any depth.

- **Q9 (CEO-ish) — branch isolation default.** Does unification **activate** recursive
  branch isolation by default, or keep it **gated** like story B shipped (INERT,
  `branch_isolation` OFF)? Recommendation: **build the recursive branch/merge machinery
  but DO NOT activate it in the spine** — keep it behind the existing gate so the
  unification lands behavior-preserving, and activation is a separate, deliberate CEO
  call.

---

## 4. How the merged stories generalize

| Merged story (special case) | Generalized rule under unification |
|---|---|
| **B** — 3-level branch isolation (story branch, 1 level) | **Recursive branch-per-node**: every node Work can own a branch; children merge into the nearest branched ancestor, which re-gates and merges upward. The 3-level strategy is the depth-2 instance. Built but **kept gated** (Q9). |
| **C** — parent-based feedback (subtask→leader, story→CTO, 2 tiers) | **Recursive bubble-up to `parent_id`** at every level, bottoming out CTO→user. The two-tier rule is the depth-1 instance. |
| **D** — name-only agent identity (per agent kind) | **Uniform name-only addressing across all Workspaces** (build / leader / CTO) — one Workspace concept, one addressing rule. |

Unification **supersedes** these three as special cases by making each the
single-level instance of the recursive general rule. No behavior is removed; the
implementations collapse from three-each into one.

---

## 5. Phasing (additive → inert → flip)

Sequenced so every step before the last is **purely additive or inert** — the live
`/api/tasks` and `/api/stories` surfaces keep working **byte-identically** throughout —
and only the final step is destructive.

1. **Schema foundation (inert).** Add `parent_id` and the unified columns additively
   (`ensureColumn` only); the in-place `tasks → work` and `workspaces → directory`
   renames (guarded `ALTER … RENAME`). Nothing reads the new shape yet.
2. **Work core + recursive feedback** *(depends on 1)*. Implement the self-referential
   model and the recursive bubble-up responder over the unified table.
3. **Workspace unification** *(depends on 1)*. Collapse build/leader/CTO agents into
   the one Workspace concept (`kind`), name-only addressing uniform across kinds.
4. **Recursive branch/merge** *(depends on 2, 3)*. Generalize story B to branch-per-node
   at arbitrary depth — **built but not activated** (Q9), behind `branch_isolation`.
5. **API adapters** *(depends on 2)*. Stand up `/api/work/*`; reimplement `/api/tasks`
   and `/api/stories` as identical adapters over the unified model.
6. **Migration + activation (the ONLY destructive step).** Migrate every `stories` row
   into `work` (`story_id → parent_id`), flip the surfaces over, and **delete** the old
   split (the `/api/tasks` + `/api/stories` adapters and any dead story-specific paths).

**Spine subtask conventions** (every step 1–5, per this workspace's rules):
`release_mode` — **one** `[Unreleased]` changelog entry per subtask; **no**
`package.json` / version-file edits (butchr assigns the version at merge);
`plan_preview` ON (each spine subtask proposes its plan before coding).

> **Workaround note (V1 escalation reset):** escalations can SILENTLY RESET on a plan
> re-submit — if a step's escalation goes unanswered for a few minutes, re-escalate.

---

## 6. Invariants & the CTO gate

- **HARD INVARIANT — `/api/tasks` and `/api/stories` keep working byte-identically**
  for the entire transition (steps 1–5). The unification must be invisible to existing
  callers until the deliberate cutover.
- **CTO GATE (critical).** Steps **1–5** (the additive / inert spine) build
  autonomously. **Step 6** (the destructive migration + API swap + activation) is
  **GATED**: it must be **escalated to the CTO for explicit go-ahead (CEO looped in)
  BEFORE it is built or run.** It deletes the old split and is the one irreversible
  step — it does not proceed on standing approval.

---

## 7. Resolved questions (CTO sign-off)

**The CTO has SIGNED OFF on this RFC** (2026-06-15), ruling on all nine questions with
the CEO looped in on the CEO-level calls. Every ruling aligned with the recommendation
in §3. The resolutions:

| # | Question | Resolution |
|---|---|---|
| **Q1** | Naming — rename `workspaces` → `directory`? | **CONFIRMED.** Today's `workspaces` table is renamed **`directory`** (in-place pre-1.0 conceptual rename); "workspace" is freed to mean the agent+directory execution context. |
| **Q2** | How to unify tasks + stories? | **Single `work` table + `parent_id`.** Generalize the existing `tasks` table in place (it already carries the superset); migrate stories → work-with-children, `story_id` → `parent_id`. |
| **Q3** | Work↔Workspace cardinality? | **1:N, one live at a time.** |
| **Q4** | Status model? | **Unified status enum (superset), kind-conditioned valid sets.** |
| **Q5** | Is the CTO Work or Workspace? | **The CTO is a Workspace** (`kind=cto`). |
| **Q6** | Parent of top-level Work? | **The CTO** is the parent-responder of top-level Work (`parent_id` NULL). |
| **Q7** | API surface? | **Unify to `/api/work/*`**, with `/api/tasks` + `/api/stories` as **identical adapters** until the cutover, then **delete** them (pre-1.0, no shim). |
| **Q8** | Nesting depth? | **Arbitrary depth.** |
| **Q9** | Activate recursive branch isolation? | **Build it, but DO NOT activate it in the spine** — keep it gated (as story B shipped INERT); activation is a separate deliberate call. |

**Gate reaffirmed at sign-off:** steps 1–5 (the additive / inert spine) proceed
autonomously; **step 6 (destructive migration + API swap + activation) stays GATED** —
escalate to the CTO for explicit go-ahead (CEO looped in) before it is built or run.
The hard invariant — `/api/tasks` + `/api/stories` behave byte-identically throughout
— holds for the whole transition.
