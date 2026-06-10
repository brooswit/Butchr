# Contributing to butchr

A practical guide for working on butchr's code. It covers local setup, the rules
the codebase holds itself to, the conventions to match, and how a change gets
proposed, gated, and merged.

This doc is the **how to hack on it** companion to the two reference docs:

- **[SPEC.md](./SPEC.md)** — the living design doc: architecture, the full task
  state machine, dispatch/review/merge internals, the data model, every config
  var. **Read it first**, and when you change behavior, update it in the same
  change. This guide deliberately does **not** re-document architecture —
  reference SPEC.md instead of duplicating it.
- **[OPERATIONS.md](./OPERATIONS.md)** — running, restarting, and recovering a
  live butchr (supervisor, systemd, health, self-heal). Read it when you need to
  drive a running instance.
- **[CHANGELOG.md](./CHANGELOG.md)** — the release history (Keep a Changelog).
  **butchr appends the `[Unreleased]` entry for you at merge** (and bumps the
  version) — you don't hand-edit it. Write a clear task summary instead; the full
  living-docs convention is [§6](#6-living-docs-update-on-every-change).

---

## 1. Local dev setup

butchr is a **single [Bun](https://bun.sh) process** (HTTP server + dispatcher
loop) with state in SQLite (`bun:sqlite`) and all PTY/agent-session work
delegated to **herdr**.

**Requirements** (same as running it — see [README](./README.md#requirements)):

- Bun ≥ 1.1 (`package.json` `engines.bun`).
- `git` on `PATH`.
- `herdr` on `PATH`, **with its server running** (`herdr server`, or launch the
  herdr TUI) — required for *dispatch* to make progress. butchr starts fine
  without it and resumes dispatch automatically once herdr is reachable, but no
  task moves past `queued` while herdr is down. You can run, build, type-check,
  and `bun test` without a live herdr (tests stub it out — see §5).

**Run it** from the repo root:

```sh
bun run start            # = bun run src/index.ts
bun run dev              # watch mode: bun --watch run src/index.ts
```

Then open the webapp at **http://127.0.0.1:47800**.

**Where things live** (all overridable via `BUTCHR_*` env — full table in
[SPEC.md §8](./SPEC.md#8-configuration)):

| What | Default |
|------|---------|
| HTTP host:port | `127.0.0.1:47800` (`BUTCHR_HOST` / `BUTCHR_PORT`) |
| State dir | `~/.local/share/butchr/` (`BUTCHR_DATA_DIR`) |
| SQLite db | `~/.local/share/butchr/butchr.db` (`BUTCHR_DB`) |
| Log file | `~/.local/share/butchr/butchr.log` (`BUTCHR_LOG_FILE`) |

The state dir also holds `prompts/`, `runs/`, `mcp/`, and `ask/` working files
(see [SPEC.md §9](./SPEC.md#9-on-disk-layout)). Inside each *registered* repo,
butchr keeps a `.butchr/` folder (task.md + per-task metadata) and one git
worktree per task at `<repo>/<task-id>/`.

---

## 2. The zero-dependency rule

**butchr ships with zero npm/runtime dependencies, and that is a hard
constraint.** There is no `dependencies` / `devDependencies` block in
`package.json` and no `node_modules` — everything is built on the Bun standard
library (`Bun.serve`, `Bun.spawn`, `bun:sqlite`, `fetch`, `node:fs`/`node:path`/
`node:os`) plus the external `git` and `herdr` binaries. The webapp under
`public/` is vanilla JS — no framework, no build step.

**Do not add an npm dependency without explicit approval from the CTO** (ask via
the butchr `ask` tool if you're an agent, or open it as a question first). This
keeps install/boot trivial (just Bun + the repo), keeps the supply-chain surface
at zero, and keeps the supervised/systemd deploy a single `bun run`. If you
think you need a library, first check whether the Bun stdlib already covers it —
it usually does (the MCP transport, the SSE stream, the operator CLI, and the
log rotator are all hand-rolled for exactly this reason).

---

## 3. Code conventions

**TypeScript / Bun, strict mode.** `tsconfig.json` is `strict: true` with
`verbatimModuleSyntax` and `allowImportingTsExtensions`. Match the existing
style:

- **Import with the `.ts` extension** (`import { run } from "./exec.ts"`) —
  required by the bundler resolution + `verbatimModuleSyntax`.
- `node:`-prefix stdlib imports (`node:fs`, `node:path`, `node:os`).
- One module per concern; modules are small and single-purpose. See the file
  map in [SPEC.md §1](./SPEC.md#1-overview--architecture) and
  [README "Project layout"](./README.md#project-layout) for what lives where —
  `config.ts` (env), `db.ts` (schema), `tasks.ts` (state transitions),
  `dispatcher.ts` (tick loop), `server.ts` (HTTP), `herdr.ts` (CLI wrapper), etc.
- Prefer explicit, descriptive names and a comment block at the top of each
  module explaining its role. Comments explain **why**, not what.

**Shelling out — use the `exec` helpers.** All subprocess work goes through
`src/exec.ts`:

- `run(cmd: string[], { cwd? })` → `{ code, stdout, stderr, ok }`, never throws.
- `runOrThrow(cmd, opts)` → same, but throws a useful message on non-zero exit.

Pass argv as a **string array** (never a shell string) so there's no quoting/
injection surface. The one place a shell is used deliberately is launching the
agent and the verify/CI gate via `bash -lc` — keep new subprocess calls on the
array form.

**herdr access — go through `src/herdr.ts`.** Never call the `herdr` binary
directly from feature code. `herdr.ts` is the single wrapper: it runs the CLI
via `run()`, parses herdr's `{id, result}` JSON envelope, throws on `error`, and
exposes typed functions (`isUp`, `workspaceCreate`, `agentStart`, `agentRead`,
`agentDeregister`, …). The herdr **agent name is the task id** — keep that
invariant. Add new herdr interactions as functions here so the rest of the code
stays herdr-agnostic.

**Errors — `HttpError` for anything user-facing.** `src/directories.ts` defines
`class HttpError extends Error { status }`. Throw `new HttpError(<status>,
<message>)` from service code for expected failures (404 not found, 400 bad
input, 409 conflict, 502/503 upstream). The server's `handleError`
(`src/server.ts`) turns an `HttpError` into `{ error: message }` at its status;
anything else becomes a 500. Don't catch-and-stringify in handlers — let it
propagate.

**DB migrations — additive `ensureColumn` only.** The schema in `src/db.ts` is a
`CREATE TABLE IF NOT EXISTS` baseline plus a series of guarded
`ensureColumn(table, column, decl)` calls. `ensureColumn` checks
`PRAGMA table_info` and runs `ALTER TABLE … ADD COLUMN` only if the column is
missing, so existing databases upgrade in place with no data loss and no
migration framework. **New columns are added the same way: append an
`ensureColumn(...)` line — never edit the baseline `CREATE TABLE` for an existing
column, never write a destructive migration, never drop/rename a column.** New
columns must be nullable or carry a `DEFAULT` (existing rows get backfilled to
it).

**Serialization — `taskView`.** `taskView(id)` in `src/tasks.ts` is the
canonical task projection returned by the API and emitted over SSE: it merges the
DB row with the on-disk `task.md` (prompt, context, review notes) and computes
`blocked_by` / `blockerStates` / `deadBlockers` / `spawned_subtasks`. Return
`taskView(id)` from new endpoints and SSE events instead of raw rows so the shape
the webapp and CLI consume stays consistent. The matching `DirectoryView`
(`listDirectories`) is the directory equivalent.

---

## 4. How to add things

Keep changes small, match the surrounding module, and update SPEC.md in the same
change.

**A REST route.** Routes register with `route(method, path, handler)` in
`src/server.ts` (path params like `:id` are parsed into the handler's second
arg `p`, so `p.id`). The handler returns a `json(data, status?)` `Response` and
throws `HttpError` on failure. Keep the handler thin — validate input, call the
service function in `tasks.ts`/`directories.ts`, return `json(taskView(...))`.
Add the route to the table in [SPEC.md §6.1](./SPEC.md#61-rest-api) (and the
operator CLI in `bin/butchr` + [§6.4](./SPEC.md#64-operator-cli-binbutchr) if it
should be drivable from the shell — each CLI subcommand maps onto exactly one
route and adds no server logic).

**A `BUTCHR_*` config var.** Add a field to the `config` object in
`src/config.ts` using the typed env helpers (`env`, `envInt`, `envBool`,
`envList`) with a sensible default and a doc comment. Reference it as
`config.<field>` (never read `process.env` directly outside `config.ts`). Add a
row to the config table in [SPEC.md §8](./SPEC.md#8-configuration) and, if it's
operationally relevant, the README/OPERATIONS tables.

**A DB column / migration.** Append an `ensureColumn("tasks", "<col>", "<decl>")`
(or `directories`) line in `src/db.ts` next to the others, nullable or with a
`DEFAULT` (see §3). Document it in the data-model table in
[SPEC.md §7](./SPEC.md#7-data-model). Surface it through `taskView` if the API
should expose it.

**A webapp view.** Edit `public/app.js` / `index.html` / `style.css` — vanilla
JS, hash-routed, SSE-driven, no framework or build step. Consume the existing
REST + `/api/events` SSE contract; if you need new data, add the route first.
Note it in [SPEC.md §6.5](./SPEC.md#65-webapp-public).

---

## 5. Testing

Tests run under Bun's built-in runner:

```sh
bun test                 # whole suite (test/*.test.ts)
bun test test/ci-gate.test.ts   # a single file
```

**Test seams — exercise behavior without a live claude/herdr stack.** The suite
is pure and in-process: it never spawns a real agent, herdr, or `bun build`/`bun
test` subprocess. The seams that make that possible (set these up in
`beforeAll`, mirror an existing test like `test/ci-gate.test.ts`):

- **Temp DB + data dir.** Point `BUTCHR_DATA_DIR` and `BUTCHR_DB` at
  `mkdtempSync(...)` dirs (and `BUTCHR_LOG_FILE=""` to silence file logging)
  **before importing `src/db.ts`/`src/tasks.ts`** — the db/config singletons read
  env at import time, so set env first, then `await import(...)`. Because those
  singletons are shared across test files in one run, give each file a **unique
  directory id** to keep rows from colliding.
- **`BUTCHR_HERDR_BIN=true`** — points the herdr binary at `/usr/bin/true`, so
  every herdr probe is a harmless no-op exit-0 (no herdr server needed).
- **`setCiRunner(fn)`** (`src/tasks.ts`) — inject a fake CI runner so the
  review-gate wiring is exercised without shelling out to `bun build`/`bun test`.
- **`setVerifyRunner(fn)`** (`src/verify.ts`) — inject a fake post-merge verify
  result so the revert-on-red decision is tested without a real gate run. Pass
  nothing to restore the default.
- A real **temp git repo** (`git init` + one commit) stands in for a registered
  directory so worktree/`task.md` paths resolve.

Clean up temp dirs in `afterAll`. Add a test alongside the feature it covers, and
treat the test suite as the behavioral source of truth (SPEC.md is derived from
it).

**Build / type-check gate.** There is no separate typecheck step; the bundler is
the gate. A clean exit means it builds and type-resolves:

```sh
bun build src/index.ts --target bun --outfile /dev/null
```

Run **both** `bun test` and the build before proposing a change — they are the
same checks CI and the post-merge verify gate run (`BUTCHR_VERIFY_CMD` defaults
to exactly `bun build src/index.ts --target bun --outfile /dev/null && bun test`).

---

## 6. Living docs: update on every change

> **The golden rule of contributing to butchr: docs are part of the change, not a
> follow-up.** A code change is not "done" until SPEC.md moves with it. The
> CI/verify gates only check that it builds and tests pass — keeping SPEC.md
> honest is on you, and a reviewer will send a change back for skipping it.

butchr keeps three living artifacts in lockstep with the code. **You** own one of
them on every change; butchr now owns the other two **automatically at merge**:

**(a) Update [SPEC.md](./SPEC.md) to reflect the new/changed behavior — this is on
you.** SPEC.md is a **living design doc**, not a one-time write-up — it is meant to
describe butchr *as it actually exists in the tree right now*. When you add,
change, or remove behavior, an endpoint, an SSE event, an MCP tool, a `BUTCHR_*`
config var, a DB column, or a state-machine transition, edit the matching section
of SPEC.md so it never lags the code. There are pointers throughout §4 ("How to add
things") to the exact SPEC.md table for each kind of change (route → §6.1, config →
§8, column → §7, webapp → §6.5). Pure-internal refactors that change no observable
behavior don't need a SPEC edit — but if in doubt, update it. SPEC.md is **not**
append-only and is edited surgically, so concurrent tasks rarely collide on it —
which is exactly why it stays a manual edit while the other two moved to merge.

**(b) The [CHANGELOG.md](./CHANGELOG.md) entry is recorded by butchr at merge — do
NOT hand-edit it.** Every task used to append its own `[Unreleased]` bullet, so
under concurrency every task touched the same file and they all collided at merge.
butchr now appends the entry itself, **inside the serialized merge lock, after the
rebase**, derived from your **task summary** (the optional `summary` you pass to
`request_review`) and the task id — filed under `### Changed` in `[Unreleased]`.
So: **write a clear, user-facing summary** of what changed and why it matters (not
which files you touched) and butchr turns it into the changelog line. It's
idempotent (a re-merge won't double-add) and a docs-only diff skips the version
bump. **Do not edit CHANGELOG.md in your task** — an edit there just reintroduces
the collisions this removed.

**(c) The `version` in [package.json](./package.json) is bumped by butchr at merge —
do NOT hand-edit it.** On a successful merge butchr **patch-bumps** the version (the
simple per-task default), skipping the bump for a **docs-only** diff. You don't
touch `package.json`. `/health` reads it at import, so the bumped file is enough for
the API to report the new version. **Release cuts stay manual and human-driven**:
at release time someone (1) renames `[Unreleased]` to a new `[x.y.z] - YYYY-MM-DD`
heading, (2) starts a fresh empty `[Unreleased]` above it, and (3) sets the version
to the release `x.y.z` (a backwards-incompatible interface/config/data-model change
makes it a **minor** while pre-1.0, otherwise the accumulated patch bumps stand) —
the reserved `1.0.0` bump is the future "interfaces are now stable" promise.

Keep SPEC.md honest and the repo stays self-describing: SPEC.md answers *how it
works now*, while butchr keeps CHANGELOG.md (*what changed and when*) and the
version (*which surface you're on*) current for you at merge.

---

## 7. Contribution workflow

butchr work is organized as **tasks** (see SPEC.md) — each task is a git worktree
on its own branch, and the agent working it submits for review via the
`request_review` MCP tool. However a change is authored, the gates are the same:

1. **Make it build + test green.** A change must pass `bun build … --outfile
   /dev/null` **and** `bun test` (§5). The **CI gate** runs these in the task's
   worktree on submission and writes an advisory pass/fail badge; it does not
   hard-block, but a red badge is a signal to fix before merge.
2. **Move SPEC.md in the same change, and write a clear task summary** — see
   [§6](#6-living-docs-update-on-every-change): update **SPEC.md** to reflect any
   new/changed behavior (this is on you, and a change that doesn't carry its SPEC
   edit gets sent back), and pass a good `request_review` **summary** — butchr
   appends the **CHANGELOG.md** `[Unreleased]` entry and **bumps the version** from
   it automatically at merge, so you do **not** hand-edit those two files.
3. **Review → merge.** A reviewer approves or requests changes. On **approve**,
   butchr rebases the branch onto the current default tip, **records the
   CHANGELOG `[Unreleased]` entry + patch-bumps the version** from your task
   summary (committed onto the branch, after the rebase, inside the merge lock),
   and **fast-forwards** (linear history), then runs the **post-merge verify gate**
   (`BUTCHR_VERIFY_CMD`) on the new tip in the repo root — a **RED result
   auto-reverts the merge off main** (the task goes `failed` with the failing
   output; the worktree is kept for a fixup). So a change that isn't actually
   green won't stay on main. On **request changes**, the same agent session
   resumes with the reviewer's notes and reworks in context.
4. **Conflict handling.** Concurrent tasks branch from the same base and don't
   see each other until merged, so two can conflict at merge time. Merges are
   serialized through a global queue and each is rebased onto the live tip first;
   a content conflict is **kicked back to the agent** as a resolution note (not
   dumped on the reviewer) and re-submitted. If you're chaining work, merge the
   first task before queueing the dependent — or express the ordering with
   `blocked_by` so the dependent waits.

See [SPEC.md §4](./SPEC.md#4-review--merge) for the full review/merge/verify
machinery and [OPERATIONS.md](./OPERATIONS.md) for driving a live instance.

---

## 8. Gotchas

- **Don't inline big context into the agent prompt / don't pass huge prompts.**
  The rendered prompt is handed to the agent as a single shell argv via
  `"$(cat <prompt-file>)"`, so it's bounded by `MAX_ARG_STRLEN` (~128 KB). butchr
  deliberately **lists context-file paths** in the prompt rather than inlining
  their bodies, and the agent reads the files itself. Exceeding the argv limit
  surfaces as **E2BIG** — an exec failure (exit 126/127 with no output) that the
  watcher routes to dispatch-retry, not a silent hang. Keep prompts and any
  inlined content small.
- **Restart to pick up merged code.** butchr is a long-running process; a running
  instance keeps executing the code it booted with. After merging a change,
  **restart the service** to pick it up (see
  [OPERATIONS.md "Restart safely"](./OPERATIONS.md#restart-safely) — resolve the
  PID by listening port and kill that one; don't `pkill -f`). Restart is safe:
  butchr re-adopts its state on boot.
- **herdr down blocks dispatch.** With the herdr server unreachable, butchr stays
  *healthy* (the `/health` verdict ignores herdr) but **no task progresses past
  `queued`** — the tick loop returns early when herdr is down. If tasks are stuck
  in `queued`, check herdr first (`herdr status server`). Dispatch resumes
  automatically once herdr is back.
- **Set test env before importing modules.** The `config`/`db` singletons read
  env at import time. In tests, set `BUTCHR_*` env **then** `await import(...)` —
  importing first locks in the wrong paths.
