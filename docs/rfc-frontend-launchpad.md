# RFC: Front end → LaunchDarkly LaunchPad (React), bundled with bun (story st-95b7d87c)

> **Status: SIGNED OFF by the CTO (2026-07-09). All nine §12 decisions approved.**
>
> The story leader escalated this to the CTO, and the CTO signed it off. The phases
> in §10 may proceed, in order; no dependency may be added before **Phase 1a**
> lands. Two CTO decisions were taken *after* sign-off — they created Phase 1a and
> ruled it in scope — and are recorded in **§0.4**.
>
> **This RFC SUPERSEDES `docs/rfc-frontend-design-system.md`** (story st-b1ca22e5,
> signed off by the CTO on 2026-07-08), which chose **Option 0 — no framework, no
> build step, no dependency**. What changed is not a technical finding but a
> **CEO ratification**: the CEO has decided to give up the zero-npm-dependency and
> no-build-step constraints, adopt `bun` as the bundler, and adopt
> `@launchpad-ui`. The *whether* is settled and is not re-litigated here. This
> document is the *how*.
>
> **What survives from the prior RFC** (see §0.3 for detail):
> - **Phase 1's `serveStatic` rules** (`src/server.ts:335-351`) — a missing path
>   *with an extension* 404s; only extensionless route-like paths get the SPA
>   fallback. Both survive, and §3 shows how.
> - **The `--space-1..6` scale** (`public/style.css:91-96`) — survives, and §7.4
>   maps it onto `--lp-spacing-*`.
> - **The module seams** (`core/` ⊣ `components/` ⊣ `views/`) — survive as the
>   *shape* of the port, though §1 shows the seam is one module-boundary off from
>   where the brief believes it is.
> - **The Errata discipline.** This document adopts it (§0.2).
>
> **What is void:** Option 0 itself; §2's "`el()` not a framework" conclusion;
> §4's "no build step" serve story; the prior RFC's deferred **Phase 5 (targeted
> re-render)**, which React delivers for free (§1.4).

---

## 0. Executive summary

**The bundling question is closed and the answer is yes.** The immediately
preceding subtask ran the experiment and wrote it up in
`docs/design/launchpad-bun-spike.md`: `bun build` alone — no webpack, no vite, no
rollup, no loader, no plugin, no `tsconfig.json` — produces a 1216-module
production bundle in ~0.12 s that renders React 19 + `@launchpad-ui` **fully
styled** in real headless Chrome, verified by `getComputedStyle` and screenshots,
not by assumption. This RFC does not re-derive those measurements; it designs
around them.

The real work is elsewhere, and it is in four places:

1. **Three silent-failure modes.** Each exits 0, boots, and is still wrong:
   missing token CSS (the page renders unstyled), a missing icon sprite (every
   icon renders blank while keeping its 20×20 box), and the default build
   shipping React's development bundle (3.5× larger). None of these produce a
   build error. §2 and §3 design against all three.
2. **The reuse hypothesis is 70% right and wrong in four specific, load-bearing
   places.** §1 gives a per-module verdict for all 19 modules, grounded in the
   source. The seam is **not** `core/` vs `views/`+`components/`; it is
   **pure-logic vs DOM-building**, and that seam cuts *through* five modules
   rather than between directories.
3. **LaunchPad is a forms/controls/overlays library, not a dashboard-layout
   library.** It exports **no `Card`, no `Badge`, no `Panel`, and no layout
   primitives** (`Stack`/`Grid`/`Box`) — verified against the 170 exported
   component names in the installed package. butchr's swimlanes, task cards, and
   panels have **no LaunchPad equivalent** and stay custom CSS on LaunchPad
   tokens. §7 says so plainly rather than inventing component names.
4. **The test suite is the largest under-costed line item.** 12 test files
   statically import `public/*.js`; one scrapes `public/app.js` by sentinel; one
   globs every `public/**/*.js`; one pins `/app.js` and `/style.css` as served
   paths. §9 treats this as first-class.

**The single best news in this document:** butchr's `public/style.css` is
*already a hand-transcription of LaunchPad.* Its own comment at
`public/style.css:11` reads `/* LaunchPad LIGHT theme (default) */`, and
`--accent: #425eff` (`public/style.css:18`, annotated `blue-500 (interactive
primary)`) is byte-for-byte the value the spike measured coming out of the real
`--lp-color-bg-interactive-primary-base` (`BTN_BG=rgb(66, 94, 255)`,
`TOKEN_primary_base=#425eff`, spike §4). And butchr's dark-mode mechanism is
*the same contract* LaunchPad uses (§7.5). This migration is a **convergence onto
the thing the CSS was already imitating**, not a re-skin.

**The single worst piece of news:** `bun build` performs **zero type checking**
(spike §3). Adopting a typed React component library and then running no `tsc`
buys the `.d.ts` files and none of their protection. §5.5 takes the position that
`typescript` must be a dependency and `tsc --noEmit` must be a gate step. Without
it, the icon-name typo the spike itself hit (`icon="pencil"`, which does not
exist; the real name is `edit`) ships silently.

**Recommended migration: BIG-BANG on the view layer, staged behind a phase
boundary** (§6). Vanilla-DOM and React do not interleave the way the module split
did, and the bridged-islands alternative pays for a bridge that is deleted the
moment it works.

---

## 0.1 Corrections to the brief (grounding beat the brief)

House rule, inherited from the prior RFC: **where the brief and the code
disagree, the code wins, and the disagreement is stated, not silently worked
around.**

1. **Module count: the brief says 19, the story context says 20, and the code says
   19 — but the two files the context flagged as missing are both real.**
   `find public -name '*.js'` returns exactly **19** files: `app.js`, six under
   `core/`, six under `components/`, six under `views/`. The story context's own
   enumeration of its claimed "20" lists only 19 names. **What the correction got
   right, and what matters:** `public/components/cto-panel.js` (139 lines) and
   `public/core/work-graph.js` (140 lines) **do exist** and are frequently
   forgotten; both are in §1.1 (rows 12 and 6). `public/` holds 22 files in all —
   19 modules, `index.html`, `style.css`, and one `.woff2`. Every one is
   accounted for. **The code wins: 19 modules.**
2. **`core/api.js` is NOT framework-agnostic.** The brief's hypothesis lists it
   among the modules that "feed React unchanged." `public/core/api.js:3` reads
   `import { el } from "./dom.js";` — the module owns `toast()`
   (`api.js:20-27`) and `terminalToast()` (`api.js:30-32`), which build and
   append DOM nodes. Only `api()` (`api.js:5-16`) is framework-agnostic. The
   module must be **split**, not ported.
3. **`core/dom.js` cannot die first.** Because `state-meta.js:10` imports
   `api.js`, and `work-graph.js:15` imports `state-meta.js`, the two "purest"
   core leaves **transitively depend on `dom.js` today**. `dom.js` becomes
   deletable only *after* `toast` leaves `api.js`. This is a hard ordering
   constraint on the phase plan (§10, Phase 2).
4. **`core/nav.js` is NOT framework-agnostic; it IS the DOM-building layer.**
   `nav.js:36-40`'s `mount()` does `app.innerHTML = ""` then `appendChild(node)`
   — that is the render loop. And `setRenderer()` (`nav.js:23-25`) exists,
   per its own 14-line header comment, *solely* to invert a `views/ → app.js`
   edge. React plus a router removes the cycle and therefore removes the reason
   for the indirection. Of `nav.js`'s four exports, only `backToWorkspace`
   (`nav.js:44-46`) carries any logic, and it is one line.
5. **"The six `views/` and six `components/` are the DOM layer React owns" is
   refuted for five modules.** They each export pure, DOM-free, *tested* logic
   alongside their DOM builders:
   - `views/swimlanes.js` — `storyLifecycle:61`, `storyProgress:78`,
     `orderLaneLeaves:114`, `swimEmphasis:134`, `laneTitle:146` (five pure
     functions; `test/swimlane-order.test.ts` and
     `test/story-lifecycle-ui.test.ts` assert on them).
   - `components/chips.js` — `AWAITED_LABEL:41`, `feedbackStepLabel:79`,
     `awaitedLabel:94`, `effStatus:102`, `KIND_VISUAL:113`, `kindVisual:123`
     (pure tables and predicates; `effStatus` is imported by *two* views).
   - `views/diff.js` — `composeReviewNote:349` (pure).
   - `views/projects.js` — `initiativeHeading:155`, `initiativeRollup:167`,
     `projectInitiativeRollup:177` (pure; `test/projects-initiatives-ui.test.ts`
     imports all three).
   - `views/metrics.js` — `rateSub:28` (pure; the tripwire test's only import).

   **The seam is pure-logic vs DOM-building, and it runs *through* modules, not
   between directories.** This is the central structural finding of this RFC and
   it changes the shape of the port: the extraction in Phase 2 is a *horizontal*
   cut, not a directory rename.
6. **`views/swimlanes.js` also uses `svg()`** (`swimlanes.js:155-156`), not just
   `el()`. React renders SVG natively in JSX, so `svg()` dies with `el()`.
7. **Test-file count: "~13" → 12 static importers**, plus three files coupled by
   *other* means (a sentinel scraper, a glob, and two served-path assertions).
   Enumerated exactly in §9.1. A comment mentioning `public/` is not an import;
   these were read, not counted.
8. **`test/metrics-view.test.ts` does not import `public/app.js`.** It imports
   `views/metrics.js` and `core/nav.js` (`metrics-view.test.ts:17-18`). Its
   coupling to `app.js` is *semantic* — it is the tripwire proving no module in
   those import graphs touches `document` at module scope.
9. **`test/cli-helpers.test.ts` never calls `ciBadge`.** It asserts
   `typeof ciBadge === "function"` (`cli-helpers.test.ts:144`) as an existence
   probe guarding a `bin/butchr` rename. It needs **no DOM**, and under React it
   needs only a symbol to point at. This is much cheaper to fix than an import of
   a DOM builder implies.

## 0.2 Errata

*(This section is reserved, per the prior RFC's discipline: when a claim in this
document is later found wrong, it is corrected **in place** and the correction is
recorded here with what it cost. The prior RFC's Errata found three of its own
claims wrong — two counts and one framing — and the lesson it drew, that
`grep 'style="'` is blind to `el(tag, {style: "…"})`, is the reason every count in
this document was produced by reading the matches rather than counting them.)*

**E1 — §5.6 hazard 1 was wrong. `bun.lock` does NOT embed the root version.**
The hazard was raised as `UNVERIFIED:` and guessed the wrong way. Phase 0 measured
it: bun 1.3.11 records the root workspace's `name` but **not** its `version`, so a
release bump of `package.json:version` leaves `bun.lock` byte-identical and
`--frozen-lockfile` still passes. **Cost: none — it was caught before Phase 1.**
The proposed mitigation ("the release step must run `bun install` and include
`bun.lock` in the release commit") is **withdrawn**; the release step is unchanged.
Corrected in place at §5.6. Evidence: §13.1.

**E2 — §4.2's gate step 2, `bunx tsc --noEmit`, does not run.** Two independent
defects, both found by running it. (a) `bunx tsc` executes `node_modules/.bin/tsc`,
whose shebang is `#!/usr/bin/env node`; this host's `node` is **v12.22.9** and
TypeScript 5.9's emitted code uses `??`, so it dies with `SyntaxError: Unexpected
token '?'` before typechecking anything. `bunx --bun tsc` forces the bun runtime and
works. (b) A bare `tsc --noEmit` reads only the root `tsconfig.json`, whose
`include` is `["src"]` — it would **never look at `public/` at all**, silently
typechecking half of what §5.5 promises. Corrected in place at §4.2. Evidence: §13.2.

**E3 — §5.3's `devDependencies` list is incomplete.** `react@19.2.6` and
`react-dom@19.2.6` ship **no `.d.ts` files**. With `"jsx": "react-jsx"`, `tsc`
needs `react/jsx-runtime`'s types, so `@types/react` and `@types/react-dom` are
**required for the gate to function** — without them `tsc` emits TS7016 and
`bun build` still exits **0**. Corrected in place at §5.3. Evidence: §13.2.

**E4 — §7.4's spacing assumption is refuted, and it gives Phase 5 real work.**
The RFC deferred the `--space-1..6` → `--lp-spacing-*` alias to Phase 5 *"only if
they align."* **They do not.** LaunchPad's spacing scale is a strict 4px grid
(0/4/8/12/16/20/24/28/32 px); butchr's is `4/6/8/10/12/18 px`. Three of six tokens
— `--space-2` (6px), `--space-4` (10px), `--space-6` (18px) — have **no LaunchPad
equivalent at any tier**, and 7 of the 12 usage sites are on those three. Corrected
in place at §7.4. Evidence: §13.3.

## 0.3 What survives from the superseded RFC

| Prior RFC conclusion | Status | Where |
|---|---|---|
| **Phase 1** — `serveStatic` 404s a not-found path *with* an extension; SPA fallback only for extensionless routes | **SURVIVES** — both rules preserved verbatim | §3.2 |
| **Phase 1** — `index.html` loads the entry as `<script type="module">` | **SURVIVES** (bun's HTML entry emits exactly this) | §3.3 |
| **Phase 3** — `--space-1..6` scale; no dead tokens | **SURVIVES**, remapped onto `--lp-spacing-*` | §7.4 |
| **Phase 3** — explicit classes, never positional selectors | **SURVIVES** as a house rule | §7 |
| **Phase 2/4** — the `core/` ⊣ `components/` ⊣ `views/` seam | **SURVIVES in shape**, but the true seam is one cut away (§0.1 #5) | §1 |
| **Escaping is structural** (no `esc()`, no `{html:}`) — story st-82c11fd1 | **SURVIVES**, re-expressed: JSX escapes structurally; the new footgun is `dangerouslySetInnerHTML` | §9.5 |
| **Option 0** — no framework, no build, no dependency | **VOID** — reversed by CEO ratification | §5 |
| **§2** — "`el()` and not a framework"; the node-returning authoring model | **VOID** — JSX replaces it | §1 |
| **§4** — the no-build serve story (`public/` served raw) | **VOID** | §3 |
| **§5, Phase 5** — targeted re-render, *deferred* | **VOID — delivered free by React** | §1.4 |
| **CONTRIBUTING §4** — the zero-dependency hard constraint | **VOID** — replacement prose in §8 | §8 |

## 0.4 Decisions taken after sign-off

Two decisions post-date the CTO's sign-off. They are recorded here so that §10's
phase numbering does not confuse a later reader.

1. **Phase 1a exists, and it lands before Phase 1.** Phase 0 discovered that `src/`
   does not typecheck — **21 pre-existing errors** (§13.4 item 1; full list and
   method in §13.2). The story leader created a new **Phase 1a** in response. It
   fixes all 21 errors, takes **butchr's first dependency** (`typescript`), adds a
   `tsc --noEmit` gate step for **`src/` only**, and carries the **CONTRIBUTING §4
   rewrite** (§8) — decision 8 tied that rewrite to the phase that adds the first
   dependency, and Phase 1a is now that phase. **Phase 1 is re-scoped to the
   front-end toolchain only**, and depends on Phase 1a.
2. **The CTO SANCTIONED Phase 1a remaining under story st-95b7d87c**, ruling it in
   scope by **entailment** rather than scope-creep: decision 3's `tsc` gate cannot
   land green over 21 pre-existing errors, so making `src/` typecheck is that
   decision's prerequisite.

The CTO reviewed Errata **E1–E4** and did not object. §10 and §12 are reconciled
with them below; the Errata themselves remain the primary record and are
cross-referenced rather than restated.

---

## 1. REUSE vs REBUILD — all 19 modules

The CEO's hypothesis, stated for testing:

> `core/{api,format,state-meta,nav,work-graph}` + the SSE `/api/events` wiring +
> the whole `/api/*` contract are framework-agnostic and feed React unchanged;
> the six `views/` and the six `components/` are the DOM-building layer React
> owns; `core/dom.js` (`el`/`svg`) becomes obsolete.

**Verdict: CONFIRMED for the `/api/*` contract and the SSE wiring. CONFIRMED for
`format` and `work-graph`. REFUTED for `api` and `nav`. PARTIALLY REFUTED for
`views/` and `components/`, five of which export pure logic React must keep.
CONFIRMED for `dom.js`, with an ordering caveat.**

### 1.1 The per-module table

Verdicts: **PORT AS-IS** (moves to `.ts`, zero logic change) · **PORT WITH
CHANGES** · **REBUILD IN REACT** · **DELETE** · **SPLIT** (the module is two
things and the verdict differs per half — the finding of §0.1 #5).

| # | Module | LoC | Verdict | Grounded reason |
|---|---|---|---|---|
| 1 | `core/dom.js` | 48 | **DELETE** | `el()`/`svg()` are exactly what JSX compiles to. Nothing survives. **But** it is transitively imported by `state-meta.js` and `work-graph.js` via `api.js:3`, so it cannot be deleted until `toast` leaves `api.js` (§0.1 #3). |
| 2 | `core/api.js` | 32 | **SPLIT** | `api()` (`:5-16`) is a pure `fetch` wrapper → **PORT AS-IS**. `toast()` (`:20-27`) and `terminalToast()` (`:30-32`) build DOM via `el` → **REBUILD IN REACT** onto LaunchPad's `toastQueue` + `ToastRegion` (both confirmed exports). |
| 3 | `core/format.js` | 78 | **PORT AS-IS** | Zero imports, zero DOM, six pure formatters (`fmtTime`, `fmtDuration`, `fmtBytes`, `fmtPct`, `projectTitle`, `repoDisplay`, `basenameOf`). The hypothesis is exactly right here. |
| 4 | `core/nav.js` | 46 | **DELETE (REBUILD)** | `mount()` (`:36-40`) *is* the vanilla render loop; `setRenderer`/`render` (`:23-32`) exist only to break a `views/ → app.js` cycle that React + a router dissolves. Only `backToWorkspace` (`:44-46`) is logic, and it becomes a one-line `navigate()`. |
| 5 | `core/state-meta.js` | 163 | **PORT WITH CHANGES** | All the logic is pure: `STATUS_LABELS:15`, `statusLabel:41`, `DEFAULT_STATE_META:77`, `statusSetsFrom:104`, `stateKind:158`. But the six `export let` bindings reassigned by `applyStateMeta:148` are an **imperative module-global store read through ES live bindings** — React components will not re-render when they change. Becomes a context + `useSyncExternalStore`. |
| 6 | `core/work-graph.js` | 140 | **PORT AS-IS** | Every export is pure and DOM-free: `pruneWorkCaches`, `isCompleteStatus`, `workListPath`, `workLeaves`, `isHistoryItem`, `reverseDeps`, `gatedSubtree`, `graphLevels`, `graphChildOf`, `storyMemberIds`, `storySubtaskTotal`. Its one import is `TERMINAL_STATUSES`. Two test files assert on it directly and **need no change**. |
| 7 | `components/button.js` | 108 | **REBUILD IN REACT** | Its own header calls it "the missing piece the RFC named D6." LaunchPad ships `Button`, `ButtonGroup`, `IconButton`, `LinkButton`, `ToggleButton` (confirmed). The `action()` helper (async → `toast` → `render()`) becomes a hook, `useAction()`. |
| 8 | `components/chips.js` | 238 | **SPLIT** | Pure half → **PORT AS-IS**: `AWAITED_LABEL:41`, `feedbackStepLabel:79`, `awaitedLabel:94`, `effStatus:102`, `KIND_VISUAL:113`, `kindVisual:123`. DOM half → **REBUILD**: `chip:34`, `responderChip:61`, `kindBadge:128`, `taskChips:147`, `tagChips:225`, `livenessChip:235`. See §7.2 — these do **not** map onto LaunchPad's `Tag`. |
| 9 | `components/overlay.js` | 124 | **REBUILD IN REACT** | The modal scaffold → `Modal` / `ModalOverlay` / `Dialog` / `DialogTrigger` / `Heading`. The directory picker's **module-level state machine** becomes ordinary component state — a strict simplification. |
| 10 | `components/panel.js` | 215 | **REBUILD IN REACT** | `collapsible:37` → `Disclosure` / `DisclosurePanel`. `ciBadge:82`, `conformanceBadge:126`, `block:153`, `blockerRow:164`, `listPanel:181`, `rollupPanel:194` are all node emitters. `rollupPanel`'s progress bar → `ProgressBar` or `Meter` (both confirmed). |
| 11 | `components/project-modals.js` | 369 | **REBUILD IN REACT** | Three dialogs. `Modal` + `Dialog` + `Form` + `TextField` + `Label` + `FieldError` + `Button` (all confirmed). The largest single win of the migration: hand-rolled form state and validation go away. |
| 12 | `components/cto-panel.js` | 139 | **REBUILD IN REACT** | The per-workspace CTO-agent card. No LaunchPad container primitive exists (§7.3); composed from `Group`, `Heading`, `Separator`, `Button`, and custom CSS. |
| 13 | `views/task.js` | 1126 | **REBUILD IN REACT** | The largest view. Pure by exception, not by rule — its exports are `renderTask` + `stopLiveOutput` (a poll timer, which becomes a `useEffect` cleanup). |
| 14 | `views/workspace.js` | 280 | **REBUILD IN REACT** | Same shape; `stopActivity` is the second poll timer → `useEffect` cleanup. |
| 15 | `views/swimlanes.js` | 369 | **SPLIT** | Pure half → **PORT AS-IS**: `storyLifecycle:61`, `storyProgress:78`, `orderLaneLeaves:114`, `swimEmphasis:134`, `laneTitle:146`. DOM half → **REBUILD**: `storyLifecycleChip:89`, `renderSwimlanes:333` and the `svg()` connector at `:155`. **No LaunchPad equivalent exists** — this is the bespoke rebuild (§7.1). |
| 16 | `views/projects.js` | 666 | **SPLIT** | Pure half → **PORT AS-IS**: `initiativeHeading:155`, `initiativeRollup:167`, `projectInitiativeRollup:177`. Everything else → **REBUILD**. |
| 17 | `views/diff.js` | 496 | **SPLIT** | `composeReviewNote:349` is pure → **PORT AS-IS**. `parseDiff:35`, `langForPath:84`, `scanString:125` are pure but **private**; `highlightJs:132` / `highlightCss:165` / `highlightCode:208` are *fused to the DOM* because `tok:99` calls `el()`. **PORT WITH CHANGES:** the tokenizer must be refactored to return token *records* (`{cls, raw}[]`), which JSX then maps. That refactor is worth doing on its own merits — it makes the highlighter unit-testable without a DOM. |
| 18 | `views/metrics.js` | 141 | **SPLIT** | `rateSub:28` is pure → **PORT AS-IS**. `renderMetrics:70` → **REBUILD** onto `Table` / `TableHeader` / `TableBody` / `Column` / `Row` / `Cell` (all confirmed). The cleanest 1:1 mapping in the whole app. |
| 19 | `app.js` | 460 | **REBUILD IN REACT**, and **3 blocks DELETED OUTRIGHT** | Router (`parseHash:78`, `renderRoute:124`) → routes. `connectSSE:311` → a `useEffect`. `updateAttention:234` / `applyPauseState:264` / `setupTheme:436` → components + a store. **`captureUiState:347`, `restoreUiState:375`, `applyInputRestore:393` are deleted, not ported** — see §1.4. |

The two **non-module** artifacts under `public/`, for completeness:

| Artifact | LoC | Verdict | Reason |
|---|---|---|---|
| `public/index.html` | 65 | **PORT WITH CHANGES** | Ceases to be a plain static file — the icon sprite must be inlined into `<body>` (§3.4). The no-flash theme script (`:8-18`) **survives untouched** (§7.5). |
| `public/style.css` | 1250 | **PORT WITH CHANGES** | 83 token definitions, 413 `var(--…)` usages. Aliased onto `--lp-*` rather than replaced (§7.4). |

*(`public/fonts/InterVariable.woff2` is the 22nd and last file under `public/`; it
is copied into `dist/` unchanged — §2.7, §3.1.)*

### 1.2 The `/api/*` contract and SSE — CONFIRMED, unchanged

`connectSSE` (`app.js:311-335`) opens `new EventSource("/api/events")` and, on
any message, debounces a re-render (`refreshSoon:410`) and refreshes the
attention signal. Nothing about `EventSource` is framework-coupled: it is a
browser API. In React it becomes a `useEffect` that opens the stream, dispatches
into a store, and closes on unmount.

Every `/api/*` route is consumed through `api()` (`core/api.js:5`), which is a
`fetch` wrapper with JSON handling and error normalisation. **Zero server changes
are required by this RFC** apart from `serveStatic`'s root (§3). The
`/api/state-meta` self-heal path (`app.js:327`, `state-meta.js:139`) survives as
a store action.

**Recommendation: keep `api()` verbatim. Do not adopt a data-fetching library.**
`react-query`/`swr` would be a fifth dependency solving a problem butchr does not
have — a single-operator local tool whose invalidation strategy is "re-render on
any SSE event."

### 1.3 The routing decision the brief never poses

`react-router@7.15.1` is an **exact peer dependency** of
`@launchpad-ui/components@0.21.0` (spike §1). It enters the tree whether or not
butchr imports it. LaunchPad also exports `RouterProvider` and the `useHref` hook
(both confirmed in the installed `dist/index.es.js` export statement) — i.e. the
library *expects* a router and offers the integration seam.

Meanwhile `core/nav.js` is a bespoke hash router, and `app.js:78-98`'s
`parseHash` plus `app.js:124-160`'s canonicalising redirects
(`location.replace("#/projects")`) encode real product behaviour: the
`#/workspace/:wid` → `#/projects/:pid/workspaces/:wid` rewrite, and the
Back-trap avoidance that `location.replace` (not `location.hash =`) buys.

**Recommendation: adopt `react-router` in its hash-history mode, and port the
canonicalising redirects to route-level `<Navigate replace>` equivalents.**

Defence: it is **already paid for** — it is installed, pinned, and in the bundle
regardless, so keeping `nav.js` means shipping a router *and* hand-rolling a
second one. LaunchPad's `RouterProvider`/`useHref` exist precisely so that
`Link`, `LinkButton`, and `Breadcrumbs` render real anchors that participate in
the router; declining react-router forfeits that and leaves those components
navigating by full page load. The `replace` semantics that `app.js:135` depends
on are first-class in react-router. The one thing to preserve deliberately is the
**hash** history (not browser history): butchr's URLs are `#/…` today, operators
have bookmarks, and `serveStatic`'s SPA fallback (§3.2) is only exercised for
extensionless paths — switching to path-based routing would push far more traffic
through that fallback for no gain.

`UNVERIFIED:` I have not exercised `RouterProvider` against `react-router@7`'s
hash history in this repo. The spike rendered `Button`/`Table`/`Modal` only. Risk
logged in §11.

### 1.4 The prior RFC's deferred Phase 5, delivered free

This is the strongest single argument in the document for React, and it is
grounded, not aesthetic.

`mount()` (`nav.js:36-40`) destroys and rebuilds `#app` on every render. The SSE
path calls it on **every event** (`app.js:410-418`). That would discard the
operator's scroll position, focus, and any text typed into a not-yet-submitted
input. So `app.js` carries a **hand-rolled state-preservation harness** — 51 lines
of code across three functions (62 counting the sentinel fences,
`app.js:346-407`) — purely to work around its own render strategy:

- `captureUiState()` — `app.js:347-368`
- `restoreUiState()` — `app.js:375-389`
- `applyInputRestore()` — `app.js:393-406`

It snapshots `window.scrollY`, `document.activeElement`, every
`[data-restore-key]` input's value **and caret range**, plus the open inline
diff-comment editor keyed by its line, then re-applies all of it after the
re-render — carefully, because "any element/key may have vanished between
renders" (`app.js:371-373`).

**React's reconciliation makes all 61 lines unnecessary.** A controlled input
that is not unmounted keeps its value, its caret, and its focus, because the DOM
node is never destroyed. The prior RFC deferred exactly this as its Phase 5
("targeted re-render"). React is targeted re-render.

Consequences, all of them good:
- The three `// <test-extract:…>` sentinel blocks (`app.js:346`, `:374`, `:392`)
  — the **last** sentinel scrapes in the repo — are deleted with the functions
  they fence.
- `test/app-restore-uistate.test.ts` is **retired by deletion**, not rewritten
  (§9.4). It is the only file left doing `new Function`-style evaluation of
  scraped source.
- The `pendingInlineRestore` setter (`diff.js:334`, imported by `app.js:68`),
  which exists only because "an imported `let` cannot be assigned"
  (`app.js:62-63`), goes away with it.

---

## 2. (A) BUN BUILD SETUP

All numbers here are the spike's measurements; none are re-derived.

### 2.1 Recommendation, in one block

```
# production
bun build public/index.html --outdir dist --production --sourcemap=linked

# dev
bun build public/index.html --outdir dist --watch
```

That is the whole build. No `tsconfig.json` for JSX purposes, no loader, no
plugin, no config file.

### 2.2 Entry point: `index.html`, not `app.tsx`

**Recommendation: use bun's HTML entry mode.**

The spike (§5) proved `bun build index.html --outdir …` works in bun 1.3.11: bun
follows `<script type="module" src="./app.tsx">` into the source entry, bundles
it, hashes **both** the JS and the CSS automatically (even without
`--entry-naming`), rewrites the HTML, and **injects the `<link rel="stylesheet">`
itself**:

```html
<link rel="stylesheet" crossorigin href="./index-yw5sqb9k.css">
<script type="module" crossorigin src="./index-vcn253rv.js"></script>
```

Defence: the alternative (a `app.tsx` entry with a hand-written `<link>` in a
static `index.html`) requires *us* to know the emitted CSS filename, which
defeats content hashing, which defeats cache-busting. bun's HTML mode solves
naming, hashing, and CSS linkage in one move, and the spike verified bun **leaves
unknown markup alone** — a `full.html` with the 214 KB sprite inlined built
correctly to a 214.68 KB output. That last fact is what makes §3.4 possible.

### 2.3 Output directory: `--outdir dist`, and **never** `--outfile`

**This is not a preference; `--outfile` is unusable.** Any CSS in the import
graph makes the build multi-output, and bun errors (spike §2):

```
error: Multiple files share the same output path
```

Since `@launchpad-ui/components/dist/index.es.js` imports its own stylesheet on
line 1, CSS is *always* in the graph. `--outfile` is dead for this project — see
§4 for what that does to `scripts/ci`.

### 2.4 JSX/TSX config: **add none for JSX; add `tsconfig` only for `tsc`**

The spike's table (§3) is unambiguous: `.tsx`, `.jsx`, and even a `.js` file
containing JSX all build with **no `tsconfig.json` and no `--jsx` flag** (no such
flag exists). Bun defaults to the automatic runtime, so a component that never
imports `React` works.

**Two hazards, and the recommendation that follows:**

1. `tsconfig.json` **is honored and can silently break the bundle.** Setting
   `"jsx": "react"` flips bun to the classic transform, emitting
   `React.createElement` into files that never import `React`. `bun build` still
   exits **0**; the page throws at runtime.
2. A `.js` file containing JSX compiles. Bun does not gate the JSX parser on the
   extension.

**Recommendation:** the repo already has a `tsconfig.json` (for `src/`, strict,
`verbatimModuleSyntax`). When the FE moves in, it must set **`"jsx": "react-jsx"`
explicitly** — not omit it. Omission works *today* because bun's default happens
to be the automatic runtime; an explicit `react-jsx` is the same behaviour
stated, and it is what `tsc` (§5.5) needs to typecheck JSX at all. Hazard 2 is
mooted by the FE moving to `.tsx`, and by §4's gate change removing the per-file
`.js` parse loop that hazard 2 weakened.

### 2.5 CSS and tokens: **two explicit imports, mandatory**

This is silent-failure mode #1 and it is the highest-risk item in the toolchain.

`@launchpad-ui/components`' CSS ships with **no token definitions**. The spike
measured the default build: **187 distinct `var(--lp-*)` usages, 1 definition**
(and that one is a component-local `--lp-button-padding`). Every colour, radius,
and spacing value resolves to nothing. **The build exits 0 and the app boots. It
just looks broken. Nothing warns.**

The tokens' **JS** entry does not help: it exports a nested object of raw values
and imports no CSS. Tokens are two separate artifacts — a JS object and a set of
CSS custom properties — and styling needs the CSS.

**Recommendation — the FE entry module's first two lines:**

```ts
import "@launchpad-ui/tokens/index.css";   // defines tokens under :root
import "@launchpad-ui/tokens/themes.css";  // defines them under :root,[data-theme] and [data-theme='dark']
```

Both specifiers were **verified by building `import "<spec>";`** (spike §4).
`themes.css` is where the actual colour values live —
`--lp-color-text-ui-primary-base` is defined *only* there — so importing
`index.css` alone still leaves the page mis-coloured.

**Do not guess these paths.** `components` and `icons` expose `./style.css`;
`tokens` **does not** — `@launchpad-ui/tokens/style.css` fails with
`error: Could not resolve`. The naming is inconsistent across the three packages,
and this is exactly the sort of thing that gets "fixed" by someone pattern-matching
from the sibling packages.

**Do not import `@launchpad-ui/tokens/fonts.css`.** See §2.7.

**Enforcement (mandatory, because the failure is silent):** the gate must assert
that the emitted CSS defines the tokens it uses. The spike's own measurement is
the assertion, and it is two `grep`s (§4.3).

### 2.6 Minification: `--production` is **mandatory**, not an optimisation

Silent-failure mode #3. Without it, butchr ships **React's development bundle** —
`jsxDEV` ×9, `react-dom.development` ×16 — at **1.61 MB instead of 0.46 MB**
(3.5×), running React's dev-mode checks in the operator's browser. Nothing warns.

`--production` is exactly equivalent to
`--minify --define 'process.env.NODE_ENV="production"'` (spike §5), and is
confirmed in `bun build --help` as *"Set NODE_ENV=production and enable
minification."*

**Recommendation: `--production` in the release build and in the gate.** The gate
must additionally assert the emitted JS contains **zero** occurrences of
`react-dom.development` — a one-line `grep -c` that turns a silent 3.5× regression
into a red build.

### 2.7 Fonts: **do not import `fonts.css`**

`@launchpad-ui/tokens/fonts.css` declares two `@font-face` rules pointing at
`./assets/*.woff2` (160,292 bytes). If imported, bun **inlines both as base64
`data:` URIs into the CSS** and emits no asset file. Measured cost: CSS goes from
124.1 KB → 338 KB; production `app.css` is 323,377 raw / **176,457 gzipped**,
because base64'd woff2 does not re-compress. Worse, it is in the
**render-blocking** stylesheet.

butchr **already self-hosts Inter** — `public/fonts/InterVariable.woff2`, declared
at `public/style.css:1-8` with `font-display: swap`. And LaunchPad's own computed
font stack begins with Inter (spike §4: `BTN_FONTFAMILY=Inter, -apple-system, …`).

**Recommendation: keep butchr's existing `@font-face`; never import `fonts.css`.**
This is strictly better on every axis: 160 KB served as a cacheable, compressed,
non-render-blocking asset instead of 176 KB of base64 in the critical path, and
the same typeface either way. The spike flagged `UNVERIFIED:` that no bun flag
forces fonts out to a file — with this recommendation that question never needs
answering.

### 2.8 Sourcemaps: `--sourcemap=linked`, and the map is **not** served

`--sourcemap=linked` produces a **2.30 MB** `.map` alongside a 0.46 MB JS.
`linked` (rather than `inline`) keeps the map out of the JS payload; the browser
fetches it only when devtools are open.

**Recommendation:** emit it, and let `serveStatic` serve it. butchr is a
single-operator local tool behind loopback (`config.loopbackHost`); there is no
source-disclosure threat model, and a stack trace from a minified 0.46 MB bundle
is otherwise useless. If a future deployment is not loopback-only, the map is one
`rm` in the release step.

### 2.9 Dev workflow: `bun build --watch`

**Recommendation: `bun build public/index.html --outdir dist --watch`, run as a
sidecar to `bun --watch run src/index.ts`** (the existing `dev` script,
`package.json:12`).

The spike verified `--watch` rebuilds and rewrites the output on source change,
in ~123 ms. A full production build of 1216 modules is **~0.11–0.13 s**, measured
over three runs — **build time is a non-issue**, so the watch loop does not need
to be incremental to be instant.

Rejected alternative: `bun ./index.html`'s dev server. The spike confirmed it
serves HTTP 200 and boots, but butchr's own `Bun.serve` must serve the app
anyway — it owns `/api/*` and `/api/events`. Running a second server on :3000 and
proxying is complexity for nothing. Also `UNVERIFIED:` its HMR behaviour, and
`--app`/Bun Bake is marked EXPERIMENTAL in the installed binary's own help text.
Both are logged in §11 and neither is on the recommended path.

**Recommendation for `package.json` scripts:**

```json
"build:fe":  "bun build public/index.html --outdir dist --production --sourcemap=linked",
"dev:fe":    "bun build public/index.html --outdir dist --watch",
"dev":       "bun run dev:fe & bun --watch run src/index.ts"
```

---

## 3. (B) SERVE

### 3.1 `PUBLIC_DIR` points at `dist/`, and `dist/` is **gitignored**

**Recommendation: build output is a build artifact. `dist/` goes in
`.gitignore`.**

Defence: committing `dist/` means every FE change carries a 0.46 MB minified JS
diff plus a 2.3 MB sourcemap diff, which is unreviewable, and it makes the
CHANGELOG rebase-race (`scripts/ci`'s last rule) dramatically more likely by
inflating every FE branch's conflict surface. It also creates a class of bug
where the committed bundle and the source disagree — the worst possible failure
for a repo whose lesson file already says *"verify REAL code on main; merged flag
≠ landed."*

**What that implies for `PUBLIC_DIR`:** it must resolve to `dist/`, and **`dist/`
must exist before `Bun.serve` binds.** Two obligations follow:

1. **`bun run build:fe` becomes part of `bun start`** — a prerequisite step, not
   a separate ritual. A ~0.12 s build is cheaper than the class of "why is the
   dashboard blank after a deploy" incidents that a missing `dist/` produces.
2. **`serveStatic` must fail loudly, not blankly, when `dist/index.html` is
   absent.** Today `serveStatic` (`src/server.ts:349-350`) falls through to
   `new Response("not found", { status: 404 })` if `index.html` does not exist.
   That is a silent-ish dead end. It should stay a 404 for correctness, but boot
   should refuse to start — or log an error banner — if `PUBLIC_DIR/index.html`
   is missing, because that condition means "you did not build," not "the
   operator typed a bad URL."

Assets that are **not** build outputs — `public/fonts/InterVariable.woff2` — must
be copied into `dist/` by the build step, or `serveStatic` must fall back to
`public/` for them. **Recommendation: copy.** A single `PUBLIC_DIR` with one
source of truth is worth a `cp` in `build:fe`; a two-root resolver reintroduces
exactly the ambiguity §3.2's 404 rule exists to kill.

### 3.2 The two `serveStatic` rules SURVIVE, verbatim

`src/server.ts:335-351`:

```ts
export async function serveStatic(pathname: string): Promise<Response> {
  let rel = pathname === "/" ? "/index.html" : pathname;
  if (rel.includes("..")) return new Response("forbidden", { status: 403 });
  const file = Bun.file(join(PUBLIC_DIR, rel));
  if (await file.exists()) return new Response(file);
  // A missing FILE must 404, never fall through to index.html …
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  if (base.includes(".")) return new Response("not found", { status: 404 });
  // SPA fallback
  const index = Bun.file(join(PUBLIC_DIR, "index.html"));
  ...
}
```

**Recommendation: change exactly one thing — what `PUBLIC_DIR` resolves to. Not
one line of the logic.**

Both rules survive *and get stronger* under a bundle:

- **The extension-404 rule** exists because "under `<script type=module>` a
  mistyped import path that answers 200 text/html surfaces as an opaque MIME-type
  error pointing nowhere near the typo" (`server.ts:341-343`). Under a hashed
  bundle, the paths are *generated*, so a mistyped one is impossible — but a
  **stale** one is not. An operator with a cached `index.html` requesting
  `index-OLDHASH.js` must get a clean 404, not an HTML page that the module
  loader then chokes on. The rule is more valuable after the migration, not less.
- **The extensionless SPA fallback** is what makes `#/projects/…` deep links
  work. Hash routes never hit the server (the fragment is client-side), so this
  fallback is exercised only by genuinely path-like URLs. Keeping hash history
  (§1.3) keeps that surface small.
- **The traversal guard precedes both** (`server.ts:337`), and
  `test/serve-static.test.ts:101` explicitly asserts that ordering. Preserve it.

`test/serve-static.test.ts` has two path-pinned assertions that must be updated:
`"/app.js returns 200 with a JavaScript content-type"` (`:56`) and
`"/style.css returns 200 with a CSS content-type"` (`:62`). Both names die with
the bundle. See §9.6.

### 3.3 How `index.html` loads the built entry: it doesn't — bun rewrites it

Authored `public/index.html` keeps `<script type="module" src="/app.tsx">`. bun
emits `dist/index.html` with the hashed JS and an injected hashed
`<link rel="stylesheet">` (§2.2). `serveStatic` serves `dist/index.html` at `/`.
Nothing hand-maintains a filename.

The prior RFC's Phase 1 conclusion — *"`index.html` loads `app.js` as
`<script type="module">`"* — survives as a property of the emitted HTML.

### 3.4 The sprite: `index.html` can no longer be a plain static file

Silent-failure mode #2, and the one that makes this section non-trivial.

`@launchpad-ui/icons`' `Icon` renders `<use href="#lp-icon-check">` — a
**document-local fragment reference with no URL**. The 214 KB `sprite.svg` (337
`<symbol>`s) is never pulled into the JS graph and never emitted. So `<use>`
resolves against the current document, finds nothing, and **every icon renders
blank**. The spike proved this in real Chrome, both ways. And critically:

> `SVG_BOX` is `20x20` in **both** cases — the icon reserves its layout box either
> way, so a missing sprite is invisible to any size/layout assertion.

Importing `sprite.svg` from JS emits it as a hashed asset and hands you a URL
string — **which is useless**, because the components hardcode `href="#lp-icon-x"`
with no path.

**Recommendation: inline the sprite into `<body>` at build time, and make it a
gate assertion.**

Concretely, in `build:fe`, after `bun build`:

1. Read `node_modules/@launchpad-ui/icons/sprite.svg`.
2. Splice it as the first child of `<body>` in `dist/index.html`, inside a
   `<svg aria-hidden="true" style="display:none">` wrapper.
3. The spike verified bun **leaves unknown markup alone**, so this can equally be
   done *before* `bun build` by authoring the sprite into `public/index.html` —
   but that commits 214 KB of vendored SVG into the repo, which will drift from
   the installed `@launchpad-ui/icons` version on every bump. **Post-build
   splice, from `node_modules`, is correct**: the sprite always matches the
   installed icons package.

**Cost:** `dist/index.html` grows to ~215 KB, uncached-per-navigation. For a
single-operator loopback tool that is free. For the record: the alternative
(fetching `sprite.svg` and injecting at runtime) trades 214 KB of HTML for a
flash of invisible icons on every load and a new failure mode.

**Gate assertion (§4.3):** `dist/index.html` must contain
`id="lp-icon-` at least once. One `grep`. Without it, this failure ships and no
test catches it.

### 3.5 Dev vs prod

| | dev | prod |
|---|---|---|
| build | `bun build … --outdir dist --watch` (sidecar) | `bun build … --outdir dist --production --sourcemap=linked` |
| React | development bundle (fine — dev warnings are the point) | production bundle, asserted (§4.3) |
| server | `bun --watch run src/index.ts`, `PUBLIC_DIR=dist` | `bun run src/index.ts`, `PUBLIC_DIR=dist` |
| sprite | spliced by the same post-build step | spliced |

**One `serveStatic`, one `PUBLIC_DIR`, in both modes.** No dev-only code path in
the server. The only difference is which flags the bundler ran with.

---

## 4. (C) THE GATE (`scripts/ci`)

### 4.1 What this supersedes, and why

`scripts/ci` currently runs two front-end rules:

```bash
# fe rule 1: whole-graph build from the real entry point
bun build public/app.js --target browser --outfile /dev/null
# fe rule 2: parse EVERY module on disk, not just the reachable ones
for f in "${FE_FILES[@]}"; do bun build "$f" --target browser --outfile /dev/null; done
```

Both are **superseded**, and one of them is **already broken** by this migration:

- **Rule 1 cannot survive a CSS-importing entry point.** The spike ran it:
  `bun build app.tsx --target browser --outfile /dev/null` exits **1** with
  `error: Multiple files share the same output path` — because CSS is a second
  output and `--outfile` names only one. `bun build full.html --outfile /dev/null`
  fails likewise with `error: cannot write multiple output files without an
  output directory`. **The gate's current FE rule is not merely redundant after
  this migration; it would fail the build.** It must move to `--outdir` on a
  throwaway directory.

- **Rule 2's purpose evaporates.** Its comment states it exactly: *"Rule 1 is
  blind to a file nothing imports yet — an orphan `public/views/foo.js` full of
  syntax errors exits 0. A not-yet-wired module is the normal intermediate state
  of a module split."* The module split is **finished**. And the spike found the
  rule was weaker than believed anyway: **JSX compiles inside `.js` files**
  (bun does not gate the JSX parser on the extension), so a stray JSX syntax error
  in a plain `.js` module would have been parsed as JSX rather than rejected.

  Under a real bundler, an orphan module is caught by the *typechecker* (§5.5),
  which walks every file `tsconfig.json` includes, not just the import graph.
  That is a strictly stronger guarantee than a per-file parse.

**"It builds" IS the FE validation** — but only for *resolution and syntax*.
The spike is emphatic that a green build proves nothing about the three silent
failures. So the new gate replaces two weak rules with one real build **plus
three cheap assertions on the artifact**.

### 4.2 The recommended gate

```bash
#!/usr/bin/env bash
set -euo pipefail

# 0. deps — reproducible, and a lockfile drift is a RED BUILD, not a silent upgrade.
bun install --frozen-lockfile

# 1. backend build (unchanged)
bun build src/index.ts --target bun --outfile /dev/null

# 2. typecheck — bun build does ZERO type checking (see RFC §5.5). This is the
#    step that makes adopting a *typed* component library worth anything.
#
#    --bun is REQUIRED, not stylistic: `bunx tsc` runs node_modules/.bin/tsc, whose
#    shebang is `#!/usr/bin/env node`. This host's node is v12 and TypeScript 5.9's
#    emitted code uses `??`, so plain `bunx tsc` dies with a SyntaxError before it
#    typechecks a single file. `--bun` forces the bun runtime. (Errata E2.)
#
#    BOTH configs, explicitly. A bare `tsc --noEmit` reads only ./tsconfig.json,
#    whose include is ["src"] — it would never look at public/ at all. src/ and
#    public/ CANNOT share one config: public/ needs lib DOM, and adding DOM to
#    src/ breaks `for await (… of Bun.stdin.stream())` in channel.ts. (RFC §5.5.)
bunx --bun tsc --noEmit -p tsconfig.json          # src/    — bun target, no DOM
bunx --bun tsc --noEmit -p tsconfig.public.json   # public/ — browser target, JSX

# 3. front-end bundle. --outdir, NEVER --outfile: CSS makes the build multi-output.
FE_OUT="$(mktemp -d)"; trap 'rm -rf "$FE_OUT"' EXIT
bun build public/index.html --outdir "$FE_OUT" --production
scripts/inline-sprite "$FE_OUT/index.html"

# 4. the three silent-failure assertions (RFC §4.3)
scripts/assert-fe-artifact "$FE_OUT"

# 5. tests (unchanged)
bun test ./test

# 6. CHANGELOG + rebase-race rules (unchanged, verbatim)
...
```

Ordering rationale, preserved from the current script's own comment: the FE rules
run **before** the backend suite because they cost ~100 ms and the suite costs
orders of magnitude more. That holds — a full production bundle is ~0.12 s. The
typecheck moves ahead of the bundle because it is the step most likely to catch
a real error and, unlike the bundle, it reads every file.

⚠️ **Measured cost of step 2: ~10.6 s** (6.0 s for `src/`, 4.6 s for `public/`),
not the ~100 ms the ordering rationale assumes. It is still far cheaper than
`bun test ./test` and it stays where it is — but it is now the gate's second-most
expensive step, and it is *two* processes, not one. (Evidence: §13.2.)

🚨 **`tsc --noEmit -p tsconfig.json` does not pass on `main` today.** `src/` has
**21 pre-existing type errors** (§13.2). They are real — `tasks.ts` annotates three
signatures with a `TaskKind` it never imports; `dispatcher.ts:553` does the same
with `SendInput`; `db.ts:2879` is a TS1117 duplicate key. `bun build` strips types
without checking them, so nothing has ever run `tsc` against this repo. **Phase 1
cannot add gate step 2 without first fixing all 21**, and that work is not in any
phase's budget. See §13.2 for the full list and §10 Phase 1 for the re-scoping.

### 4.3 The three artifact assertions

Each corresponds to one silent-failure mode. Each is one `grep`. **Each is the
only thing standing between a green build and a broken dashboard.**

```bash
# assertion 1 — TOKENS. The components' CSS uses var(--lp-*) but defines almost none.
# The spike measured 187 usages / 1 definition without the token imports.
defs=$(grep -oE '\-\-lp-[a-z0-9-]+:' "$FE_OUT"/*.css | sort -u | wc -l)
[ "$defs" -gt 300 ] || { echo "FE: token CSS missing — page will render UNSTYLED (exit 0, boots, broken)"; exit 1; }

# assertion 2 — SPRITE. Icon emits <use href="#lp-icon-x">, document-local.
# A missing sprite renders every icon blank while KEEPING its 20x20 box.
grep -q 'id="lp-icon-' "$FE_OUT/index.html" \
  || { echo "FE: icon sprite not inlined into <body> — every icon renders BLANK"; exit 1; }

# assertion 3 — PRODUCTION BUILD. Default build ships React dev (1.61MB vs 0.46MB).
! grep -q 'react-dom.development' "$FE_OUT"/*.js \
  || { echo "FE: React DEVELOPMENT build in output — did --production get dropped?"; exit 1; }
```

Assertion 1's threshold: the spike measured **378 definitions** with both token
stylesheets imported, versus **1** without. `> 300` is far from both. A brittle
exact count would break on every `@launchpad-ui/tokens` bump; the failure this
guards is 1-vs-378, not 377-vs-378.

### 4.4 `--frozen-lockfile`: **yes, in the gate**

**Recommendation: `bun install --frozen-lockfile` in `scripts/ci`. Plain
`bun install` locally.**

Defence: `@launchpad-ui/components@0.21.0` pins its peers to **exact** versions
(§5.2). A gate that runs plain `bun install` will happily resolve a floating
transitive dep and produce a green build against a tree that no one has ever run.
`--frozen-lockfile` makes a lockfile that disagrees with `package.json` a **red
build** — which is precisely what you want on a repo whose lesson file already
carries a `CHANGELOG rebase-race playbook`: the lockfile is now a second file
that a rebase can silently mangle, and it deserves the same "fail loudly"
treatment.

### 4.5 CI install time

Measured, from the spike: **`bun install` of the pinned tree = 623 ms** (30
packages, warm cache); **1.99–2.09 s cold**, including a scrubbed-environment
anonymous install. `node_modules` is **78 MB**.

**This is not a problem and needs no caching.** `bun test ./test` dominates the
gate by orders of magnitude. **Recommendation: do not add an install cache.** It
is a moving part that can serve a stale tree — the exact failure `--frozen-lockfile`
exists to prevent — in exchange for saving ~2 s on a gate that already runs a
full test suite.

`UNVERIFIED:` I have not measured `bun install` in butchr's actual CI environment
(cold cache, cold disk). The spike's numbers are from the developer host. Logged
in §11.

---

## 5. (D) DEPENDENCIES — butchr's first

### 5.1 What CONTRIBUTING says today, and that it must go first

`CONTRIBUTING.md:605` opens **"## 4. The zero-dependency rule"**:

> **butchr ships with zero npm/runtime dependencies, and that is a hard
> constraint.** There is no `dependencies` / `devDependencies` block in
> `package.json` and no `node_modules` … The webapp under `public/` is vanilla JS
> — no framework, no build step.
>
> **Do not add an npm dependency without explicit approval from the CTO.**

And `CONTRIBUTING.md:31-32`:

> - **Stack:** Bun · SQLite (`bun:sqlite`) · herdr · git — **zero npm dependencies.**
> - **Webapp:** vanilla JS single-page app, no framework, no build step.

**Every recommendation in this RFC violates all three sentences.** §8 writes the
replacement prose. **CONTRIBUTING must be amended in the same phase that adds the
first dependency — which is now Phase 1a (§0.4), not Phase 1** — otherwise the
repo's own governing document forbids the code on `main`, and the next agent to
read it will faithfully revert the work.

### 5.2 The pinning problem, stated precisely

`@launchpad-ui/components@0.21.0`'s `peerDependencies` are **exact versions, not
ranges** (verbatim from the installed `package.json`, spike §1):

```json
"react": "19.2.6", "react-dom": "19.2.6",
"react-aria": "3.49.0", "react-aria-components": "1.18.0",
"react-stately": "3.47.0", "@react-stately/utils": "3.12.1",
"@react-aria/focus": "3.22.1", "@react-aria/interactions": "3.28.1",
"@react-aria/utils": "3.34.1", "@react-types/shared": "3.35.0",
"react-hook-form": "7.59.0", "react-router": "7.15.1"
```

A plain `bun install react` resolves `^19.2.7` and immediately trips **five peer
warnings**. The warnings are **not fatal** — the spike's build and browser render
both succeeded with the mismatched tree — but silencing them requires pinning
**15 direct dependencies**.

Note what is in that list: **`react-router` and `react-hook-form` are peers of a
component library.** LaunchPad expects the app to have a router and a form
library. §1.3 turns the first into an asset by actually adopting it.

### 5.3 Recommendation: **exact pins, all 15, no carets**

```jsonc
"dependencies": {
  "@launchpad-ui/components": "0.21.0",
  "@launchpad-ui/icons": "0.26.0",
  "@launchpad-ui/tokens": "0.16.0",
  "react": "19.2.6",
  "react-dom": "19.2.6",
  "react-aria": "3.49.0",
  "react-aria-components": "1.18.0",
  "react-stately": "3.47.0",
  "react-router": "7.15.1",
  "react-hook-form": "7.59.0",
  "@react-aria/focus": "3.22.1",
  "@react-aria/interactions": "3.28.1",
  "@react-aria/utils": "3.34.1",
  "@react-stately/utils": "3.12.1",
  "@react-types/shared": "3.35.0"
},
"devDependencies": {
  "typescript": "5.9.3",                   // §5.5 — verified in Phase 0
  "@types/react": "19.2.17",               // §5.5 — REQUIRED; react ships no .d.ts
  "@types/react-dom": "19.2.3",            // §5.5 — REQUIRED; react-dom ships no .d.ts
  "happy-dom": "<latest, exact>",          // §9.3
  "@testing-library/react": "<latest, exact>"  // §9.3
}
```

⚠️ **`@types/react` and `@types/react-dom` are not optional, and Phase 0 added
them to this list** (Errata E3). `react@19.2.6` and `react-dom@19.2.6` ship **zero
`.d.ts` files**; with `"jsx": "react-jsx"` the compiler must resolve
`react/jsx-runtime`'s types for *every* `.tsx` file. Omit them and `tsc` emits
`TS7016: Could not find a declaration file for module 'react/jsx-runtime'` — while
`bun build` exits **0** and produces a working bundle. That asymmetry is the whole
thesis of §5.5 in miniature.

**They are `devDependencies`, so the count of EXACT-pinned DIRECT dependencies is
unchanged: still 15.** §12 decision 2 — "exact pinning of 15 direct dependencies,
no carets" — stands exactly as the CTO approved it; only the `devDependencies`
list grew, by two.

They are `@types/*` packages, so `bun install` resolves them independently of
`@launchpad-ui`'s exact-peer set; the versions above are what resolved against the
pinned tree in Phase 0. `@types/bun` (or `bun-types`) is **already implied** by the
existing `tsconfig.json`'s `"types": ["bun-types"]`, which has never been exercised
because `typescript` was never installed — Phase 1 must add it too, or `tsc` reports
`Cannot find name 'console'` on every `src/` file.

Defence for **exact, no carets**:

1. **The upstream forces it.** The peers *are* exact. A caret on `react` means
   `bun install` resolves `19.2.7` and the tree is permanently warned-about. You
   cannot half-adopt exact pinning against a library that pins exactly.
2. **The mismatched tree is a genuine unknown.** The spike is explicit:
   `UNVERIFIED:` whether the warned-about tree misbehaves at runtime beyond the
   smoke test. *"React Aria context sharing across two minor versions is exactly
   the sort of thing that breaks subtly, and a `Button`/`Table` smoke test would
   not show it."* A caret converts that unknown from a one-time decision into a
   thing that can change under you on any `bun install`.
3. **butchr's identity is reproducibility.** This is a tool that supervises
   agents merging code. A dashboard that renders differently depending on when
   you installed is a bad trade for saving a `bun update`.

**The cost, named honestly: every `@launchpad-ui` bump moves several pins in
lockstep.** There is no way around this — it is a property of the library, not of
our policy. **The mitigation is procedural: treat a LaunchPad bump as a task, not
a chore.** It updates ≥3 lines of `package.json`, regenerates `bun.lock`, and
must re-run §4.3's three assertions (a bump can change the token surface —
see §5.4). A caret would not remove that work; it would only make it happen
unannounced.

### 5.4 A real upstream bug, for the record

`@launchpad-ui/components@0.21.0` `var()`-references two tokens that
`@launchpad-ui/tokens@0.16.0` defines **nowhere**:

```
--lp-color-text-ui-secondary-base
--lp-color-text-ui-tertiary
```

Confirmed empty at runtime in Chrome (`getPropertyValue` → `""`). Cosmetic today
(the affected elements inherit a colour), but it is a genuine upstream defect,
and it is evidence that these two packages' versions are coupled more tightly
than their independent version numbers admit. **This is the single strongest
argument for §5.3's exact pins**, and it is why §4.3's assertion 1 uses a
threshold rather than "zero undefined tokens" — a "zero undefined" assertion
would fail today, on upstream's bug, for reasons we cannot fix.

**Recommendation:** file it upstream; do not work around it; re-check on every
bump.

### 5.5 Typechecking: **`tsc` is a dependency and a gate step. Take the position.**

`bun build` performs **zero type checking**. The spike demonstrated:

```
const n: number = "definitely a string";
<Button totallyBogusProp={123} variant="not-a-variant">x</Button>
```

…builds clean, **exit 0**. And independently, the spike's own first `app.tsx`
used `icon="pencil"` — **not a real icon name**; the real one is `edit`. It built
clean and *rendered an empty box*. LaunchPad ships an `IconName` union of all 337
names that would have caught it — **but only under a typechecker.**

**Recommendation: add `typescript` as a `devDependency` and `bunx --bun tsc
--noEmit` as gate step 2 (§4.2), passed `-p` twice** — `--bun` because a bare
`bunx tsc` honours the node shebang and dies on this host's node v12, and `-p`
twice because one `tsconfig.json` cannot cover both trees (Errata E2, §13.2).

Defence: the whole point of adopting a typed component library is the types.
Without `tsc`, butchr pays 78 MB of `node_modules` and 15 pinned dependencies and
receives, in exchange, `.d.ts` files that nothing reads. The alternative —
knowingly forgoing types — is coherent but strictly worse than the status quo:
today's vanilla `el()` calls at least fail loudly on a typo'd DOM property,
whereas `<Icon name="pencil">` fails silently, invisibly, and with a correctly
sized 20×20 box.

Note that `tsc` also **subsumes the orphan-module rule** the gate loses in §4.1:
`tsc --noEmit` typechecks every file matched by `tsconfig.json`'s `include`,
reachable from an entry point or not. The gate ends up *stronger* than before.

**SETTLED IN PHASE 0 — a second config is REQUIRED. Budget for
`tsconfig.public.json`.** (Full evidence: §13.2.)

The blocker is not JSX and it is not `allowImportingTsExtensions`; both are
harmless to the other tree. It is **`lib`**. `public/` needs `"DOM"` to see
`document`. Adding `"DOM"` to the shared `lib` changes `src/`'s type universe in
both directions:

- It **breaks** `src/channel.ts:1410`, `for await (const chunk of Bun.stdin.stream())`
  → `error TS2504: Type 'ReadableStream<Uint8Array<ArrayBuffer>>' must have a
  '[Symbol.asyncIterator]()' method`. `lib.dom`'s `ReadableStream` is not
  async-iterable; bun's is. Valid, shipping code stops typechecking.
- It **masks** `src/mcp.ts:175` (`body = await req.json()` → `unknown` under
  bun-types, `any` under `lib.dom`'s `Request`). An error silently disappears.

A shared config is therefore not merely inelegant — it is *wrong in both
directions*. The two-config split is also a **positive**: with `"types": []` in
`tsconfig.public.json`, `Bun.file(…)` in a browser module is a compile error
(`TS2868`); with no `"DOM"` in the root config, `document.title` in `src/` is a
compile error (`TS2584`). Each tree is confined to its own globals, which is
exactly what `test/metrics-view.test.ts`'s `document`-undefined tripwire (§9.2)
asserts at runtime today — now enforced statically, and about to lose its runtime
form when that tripwire is deleted in Phase 4.

The verified `tsconfig.public.json`:

```jsonc
{
  "compilerOptions": {
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "target": "ESNext", "module": "ESNext", "moduleResolution": "bundler",
    "moduleDetection": "force",
    "types": [],                 // no bun globals in browser code
    "noEmit": true, "strict": true, "skipLibCheck": true,
    "allowJs": true,             // Phases 1-3: public/ is still 19 .js modules
    "esModuleInterop": true,
    "jsx": "react-jsx"           // explicit, per §2.4
  },
  "include": ["public"]
}
```

Two properties of it were verified rather than assumed:

1. **Side-effect CSS imports need no declaration file.** `import
   "@launchpad-ui/tokens/index.css";` (§2.5) and `import "./style.css";` both
   typecheck clean with **no** `declare module "*.css"` shim. TS only demands a
   declaration when you import a *binding* from the module. **Do not add a
   `declarations.d.ts`** — it is the obvious-looking move and it is unnecessary.
2. **The orphan-module claim below holds.** An orphan `public/views/foo.tsx` with
   a type error fails `tsc`; an orphan `public/views/foo.js` with a *syntax* error
   also fails it. (Caveat: under `allowJs` without `checkJs`, an orphan `.js` with
   a *type* error does not — so during Phases 1–3, while `public/` is still
   vanilla, `tsc` is exactly as strong as the gate rule it replaces, no stronger.
   From Phase 4 it is strictly stronger.)

And the §5.5 thesis itself was confirmed end-to-end: `<Icon name="pencil" />`
fails with `TS2322: Type '"pencil"' is not assignable to … 318 more … | undefined`,
while `bun build` accepts it and renders an empty 20×20 box.

### 5.6 The lockfile, `node_modules`, and the versioned-releases rule

- **`bun.lock` is committed.** bun 1.3.11 writes a **text** `bun.lock` (9,931
  bytes for the pinned tree), not a binary `bun.lockb` — so it diffs, reviews,
  and merges like a normal file. Committing it is what makes §4.4's
  `--frozen-lockfile` mean anything.
- **`node_modules/` is gitignored.** 78 MB; never commit.
- **`dist/` is gitignored** (§3.1).

**Interaction with the versioned-releases rule and `release_mode`:** butchr's
release step bumps `package.json`'s `version` and stamps `CHANGELOG.md`. That
step now touches a file that **also** carries a `dependencies` block.

1. ~~**`bun.lock` records the workspace version.**~~ **REFUTED IN PHASE 0
   (Errata E1). `bun.lock` does not embed the root `version`, and the release step
   needs no change.** bun 1.3.11 writes the root workspace as
   `"workspaces": { "": { "name": "butchr", "dependencies": {…} } }` — `name` and
   `dependencies`, and **no `version` key**. Verified by generating a lockfile,
   bumping `package.json` from `0.9.275` → `0.9.276`, and re-running `bun install`:
   the lockfile is **byte-identical** and `bun install --frozen-lockfile`
   subsequently exits **0**. **`--frozen-lockfile` in the gate is therefore safe
   (§4.4 stands), and the release step must NOT be changed.** Evidence: §13.1.

   *(A `bun.lock` **does** record the root `name`. Renaming the package — which
   butchr's release step never does — would dirty it.)*
2. **`bun.lock` is now rebase-race surface.** The existing rebase-race rule
   guards `CHANGELOG.md` against a diff that *deletes* a `## [x.y.z]` header. A
   concurrent dependency change plus a release bump can conflict in `bun.lock`
   the same way. **Recommendation: no new gate rule yet** — a lockfile conflict
   surfaces as a git conflict, not a silent drop, and `--frozen-lockfile` catches
   a mis-resolved one. Revisit if it bites.

   Phase 0 narrows this risk further: because the release bump does not touch
   `bun.lock` at all (hazard 1), the *only* thing that writes it is a deliberate
   dependency change. Two branches both changing dependencies is rare and conflicts
   loudly.

---

## 6. (E) MIGRATION STRATEGY

### 6.1 The two candidates

**BIG-BANG.** Keep `core/{api,format,state-meta,work-graph}`, the `/api/*`
contract, and the SSE wiring. Rebuild the entire view layer — six views, six
components, the router, the shell — as React, in one landable phase, behind a
phase boundary.

**BRIDGED-INCREMENTAL.** Keep `app.js`'s vanilla router and `mount()`. Convert
one view at a time into a React island: `renderMetrics()` becomes
`createRoot(container).render(<Metrics/>)`, and `mount()` hands it a container.
Ship view-by-view.

### 6.2 Recommendation: **BIG-BANG on the view layer.**

The module split (story st-ffcc9cec, st-8084acca) was incremental and it worked
beautifully — but **that is exactly why the analogy misleads.** Moving a function
from `app.js` to `views/metrics.js` preserves its contract: it still returns a
DOM node, it still calls `el()`, `mount()` still appends it. Every intermediate
state was a *working app built the same way*. **Vanilla-DOM → React changes the
contract itself**, and the interleaving that made the split cheap is precisely
what makes this expensive.

Four grounded reasons:

1. **The bridge is a load-bearing artifact that gets deleted.**
   `createRoot()`-per-view means, at every increment, two render loops: `mount()`
   destroying and rebuilding `#app` on every SSE event
   (`nav.js:36-40`, `app.js:410-418`), and React reconciling inside an island
   that `mount()` just orphaned. Every `refreshSoon()` would unmount and remount
   every root. You must either teach `mount()` about React roots or teach React
   about `mount()`. Both are code written to be thrown away.

2. **The UI-state harness (§1.4) cannot be half-retired.**
   `captureUiState`/`restoreUiState` operate on `document.querySelectorAll("[data-restore-key]")`
   — *globally*, across whatever is on screen. A half-React page has some inputs
   preserved by React reconciliation and some by the harness, and the harness's
   `applyInputRestore` explicitly refuses to clobber a non-empty field
   (`app.js:399`). The interaction between "React already restored this" and
   "the harness thinks it must restore it" is a bug generator with a bad failure
   mode: the operator's typed text vanishes on an SSE event. This is the state
   the tool is *for*.

3. **The state store is global and shared.** `state-meta.js`'s six `export let`
   bindings are reassigned by `applyStateMeta` and read live by chips, swimlanes,
   and work-graph. React needs these in a store that triggers re-render
   (§1.1 row 5). Islands would each need the store, and the vanilla views would
   need the live bindings, so both mechanisms must coexist and stay consistent.

4. **The `views/ → app.js` inversion has no meaning in React.** `nav.js`'s
   `setRenderer` exists solely to prevent that edge. In bridged-incremental, that
   constraint must be honoured *and* React roots threaded through it. In
   big-bang, the whole indirection is deleted on day one.

**Cost of big-bang, stated:** the largest single phase in the plan (Phase 4)
rewrites ~3,000 lines of view code. That is real. But it is *bounded*, it is
reviewable as one coherent diff, and the alternative does not avoid the work — it
adds a bridge on top of it.

### 6.3 Is the dashboard usable throughout? **Yes — but by phase, not by view.**

This is the honest answer, and it is why the phase boundary in §10 matters more
than the migration style.

| After phase | What the operator sees | Dashboard usable? |
|---|---|---|
| **P1a** — `src/` typecheck fixes + `typescript` + CONTRIBUTING, **no FE change at all** (§0.4) | **Nothing changes.** Backend-only. | **Yes — identical** |
| **P1** — FE deps + gate + build pipeline, **no FE code change** | **Nothing changes.** `dist/` is built from the *existing* vanilla `public/`; `serveStatic` points at it. Identical pixels. | **Yes — identical** |
| **P2** — horizontal split: pure logic extracted from the 5 mixed modules | **Nothing changes.** Pure re-export shuffle, still vanilla. | **Yes — identical** |
| **P3** — React shell only (topbar, pause banner, conn LED, theme, router, toasts); views still vanilla, mounted into a React-owned container | Shell is LaunchPad; view bodies are the old DOM. Visibly a hybrid for **one phase**. | **Yes** |
| **P4** — all six views rebuilt in React; `dom.js`/`nav.js` deleted | The new UI. | **Yes** |
| **P5** — swimlanes polish + a11y + dark-mode verification | Refinements. | **Yes** |

The crucial property: **P1a, P1 and P2 change zero pixels and zero behaviour.** The
risky work is concentrated in P3–P4, and P3's hybrid is a *shell-vs-body* split,
not a view-vs-view split — the shell is `index.html`'s topbar and banner (65
lines of static markup), so there is exactly one bridge, not six, and it lives
for exactly one phase.

**Rollback is per-phase and real** (§10), because `dist/` is gitignored: reverting
the commit and rebuilding restores the previous UI exactly.

---

## 7. (F) DESIGN MAPPING

**Discipline for this section:** every LaunchPad name below was read out of the
**installed package's own export statement** (`@launchpad-ui/components@0.21.0`,
`dist/index.es.js`; 170 exported component names) or its `.d.ts`. Where LaunchPad
has no such component, this section **says so** rather than inventing one.

### 7.1 The finding that shapes everything: LaunchPad has no layout layer

Verified absent from the 170 exports:

| Looked for | Present? |
|---|---|
| `Card` | **NO** |
| `Badge` | **NO** (`BadgeIcon` exists in `@launchpad-ui/icons`, and it is an *icon*) |
| `Panel` | **NO** |
| `Chip` | **NO** |
| `Stack` / `Grid` / `Box` | **NO** |

**`@launchpad-ui` is a forms / controls / overlays / data-entry library. It is not
a dashboard-layout library.** butchr's dashboard is ~70% layout: swimlanes, task
cards, panels, rollup bars.

**This is the product fork the brief asked me to flag if it appeared — and it does
not rise to one.** LaunchPad is entirely usable; it simply covers a smaller
fraction of butchr's surface than "adopt the design system" implies. The correct
posture:

> **Adopt LaunchPad's *tokens* everywhere and its *components* where they exist.
> Keep butchr's bespoke layout CSS, re-based onto `--lp-*` tokens.**

That is not a compromise — it is what `public/style.css` is *already doing by
hand* (§0), except that today the token values are transcribed copies that can
drift, and afterwards they are the real thing.

### 7.2 Component-by-component map

**Confirmed LaunchPad exports** are in `code`. Everything else is named as custom.

| butchr surface | Source | LaunchPad | Verdict |
|---|---|---|---|
| Buttons | `components/button.js` | `Button`, `ButtonGroup`, `IconButton`, `LinkButton`, `ToggleButton` | **Direct.** |
| Toasts | `core/api.js:20-32` | `toastQueue`, `ToastRegion`, `Toast`, `snackbarQueue`, `SnackbarRegion` | **Direct.** Deletes hand-rolled timer state (`api.js:19`). |
| Modals | `components/overlay.js` | `Modal`, `ModalOverlay`, `Dialog`, `DialogTrigger`, `Heading` | **Direct.** |
| Directory picker | `overlay.js` (module-level state machine) | `Autocomplete` + `ListBox` + `ListBoxItem`, or `ComboBox` | **Direct.** `UNVERIFIED:` which fits better; neither was exercised in the spike. |
| Project modals (3 forms) | `components/project-modals.js` | `Form`, `TextField`, `TextArea`, `Label`, `Input`, `FieldError`, `Button` | **Direct.** Biggest single win. |
| Collapsible panels | `panel.js:37` `collapsible` | `Disclosure`, `DisclosurePanel`, `DisclosureGroup` | **Direct.** |
| Metrics table | `views/metrics.js:70` | `Table`, `TableHeader`, `TableBody`, `Column`, `Row`, `Cell` | **Direct.** Cleanest 1:1 in the app. |
| Progress / rollup bars | `panel.js:194` `rollupPanel`; `swimlanes.js` `storyProgress` | `ProgressBar`, `Meter` | **Direct.** Replaces the 3 dynamic inline-width bars the prior RFC's Errata #2 identified. |
| Pause banner | `index.html:54-61` | `Alert` + `AlertText` (`status: "warning"`, `variant: "inline"`, `isDismissable`) | **Direct.** Variants read from `Alert.d.ts`. |
| Empty states | `.empty` (`app.js:158`) | `EmptyState` (+ `BadgeIcon` illustration) | **Direct.** |
| Breadcrumbs | `views/workspace.js` crumbs | `Breadcrumbs`, `Breadcrumb` | **Direct**, with `RouterProvider` (§1.3). |
| Tooltips | `title=` attributes throughout | `Tooltip`, `TooltipTrigger` | **Direct**, and an a11y upgrade. |
| Tabs (Pipeline / list) | `views/workspace.js` | `Tabs`, `TabList`, `Tab`, `TabPanel` | **Direct.** |
| Separators | `.hr`-ish rules | `Separator` | Direct. |
| Icons | `☾`, `⏸`, `✓`, `✗` (literal glyphs) | `Icon`, `IconButton`, `StatusIcon` | **Direct**, *and* requires §3.4's sprite inlining. |
| **Status chips** | `chips.js:34` `chip` + 14 status colours | `Tag`, `TagGroup`, `TagList` — **but see below** | **CUSTOM.** |
| **Task cards** | `views/swimlanes.js`, `views/workspace.js` | — | **CUSTOM** (no `Card`). |
| **Panels / containers** | `components/panel.js` | `Group`, `Header`, `Heading`, `Text`, `Separator` as primitives | **CUSTOM composition.** |
| **CTO / CEO agent panel** | `components/cto-panel.js` | `Group` + `Heading` + `Button` + `Avatar`/`InitialsAvatar` | **CUSTOM composition.** |
| **Pipeline swimlanes** | `views/swimlanes.js` | — | **CUSTOM.** §7.3. |
| **Diff reader** | `views/diff.js` (496 lines, own highlighter) | `Code` for inline spans only | **CUSTOM.** |
| Conn LED | `index.html:49-51` | — | **CUSTOM** (3 lines of CSS). |

**The status-chip refutation, in detail.** `Tag`'s variants, read from
`TagGroup.d.ts`:

```ts
variant?: "error" | "default" | "info" | "warning" | "success" | "beta" | "federal" | "new"
size?: "small" | "medium"
```

**Eight variants.** butchr defines **fourteen** distinct status colours at
`public/style.css:28-41` (`--idea`, `--spec_review`, `--blocked`, `--needs_info`,
`--inactive`, `--in_progress`, `--idle`, `--needs_user_input`, `--in_review`,
`--merged`, `--rolling_back`, `--rolled_back`, `--failed`, `--aborted`), each
chosen deliberately — the comment block immediately above them documents the
scheme: feedback states amber/orange, agent states blue/indigo, terminal states
green/red/brown/gray. **Thirteen of the fourteen are re-defined again for dark**
at `style.css:111-123` ("lifted for dark surfaces"), which is hand-tuned
perceptual work with no LaunchPad counterpart.

Forcing 14 states into 8 semantic variants would collapse
`rolling_back`/`rolled_back`/`failed` into one red, and `spec_review`/`in_review`
into one amber — **destroying the at-a-glance colour coding the pipeline view
exists to provide.**

**Recommendation: keep the bespoke status chip.** Render it as a `<span>` styled
by the existing `--{status}` custom properties, sized and typeset to match
LaunchPad's `Tag`. Use `TagGroup`/`TagList` only where the *interaction* (a
removable, focusable, keyboard-navigable tag set) is actually wanted — which,
today, is nowhere. `kindBadge`/`livenessChip`/`responderChip` follow the same
rule.

### 7.3 The swimlanes rebuild, composed from primitives

`views/swimlanes.js` (369 lines) is the workspace's Pipeline tab. It has **no
LaunchPad analogue and will not get one.** Its parts, and how to compose them:

| Part | Today | React + LaunchPad |
|---|---|---|
| Lane container | `el("div", {class:"swim-lane"})` | Custom `<section>` + custom CSS grid |
| Lane title | `laneTitle:146` (pure) | **PORT AS-IS**; render with `Heading` |
| Lane order | `orderLaneLeaves:114` (pure) | **PORT AS-IS** |
| Story lifecycle | `storyLifecycle:61`, `swimEmphasis:134` (pure) | **PORT AS-IS** |
| Progress bar | `storyProgress:78` (pure) + inline-width div | pure fn ported; bar → `Meter` |
| Done-pile toggle | `SWIM_DONE_EXPANDED:45` (module `Set`) | `Disclosure` + component state |
| **Connector arrows** | `svg("svg", …)` at `swimlanes.js:155-156` | **JSX `<svg>` inline.** React renders SVG natively; `core/dom.js`'s `svg()` helper is pure overhead. |
| Subtask card | `el(...)` cluster | **Custom** — no `Card`; `Group` + custom CSS |

**Net: the five pure functions (~65 lines, interleaved with the DOM builders —
`storyLifecycleChip:89` sits between `storyProgress:78` and `orderLaneLeaves:114`)
port unchanged
and keep their two test files. Only the DOM construction — the bulk of the file's
369 lines — is rewritten**, and one of those rewrites (`svg()` → JSX) is a net
deletion.

### 7.4 Token mapping: `style.css` → `@launchpad-ui/tokens`

`public/style.css` is 1,250 lines with **83 custom-property definitions** and
**413 `var(--…)` usages**. Its own header comment at `:11` says
`/* LaunchPad LIGHT theme (default) */` — the palette was transcribed by hand.

**Recommendation: alias, do not replace.** Keep butchr's semantic names; redefine
them *in terms of* `--lp-*`. This is a one-block change, it keeps 413 usage sites
untouched, and it converts a drifting copy into a live reference.

```css
:root {
  /* was: --bg: #ffffff;  → now sourced from the real token */
  --bg:      var(--lp-color-bg-ui-primary);
  --panel:   var(--lp-color-bg-ui-secondary);
  --panel-2: var(--lp-color-bg-ui-tertiary);
  --border:  var(--lp-color-border-ui-primary);
  --text:    var(--lp-color-text-ui-primary-base);
  --accent:  var(--lp-color-bg-interactive-primary-base);   /* #425eff, verified */
  --accent-2:var(--lp-color-bg-interactive-primary-hover);
}
```

`--lp-color-bg-ui-primary`, `--lp-color-bg-interactive-primary-base|hover`,
`--lp-color-text-ui-primary-base`, `--lp-color-border-ui-primary` are all
confirmed present in the installed `themes.css`.

⚠️ **`--muted: #545a62` must stay custom.** Its natural target,
`--lp-color-text-ui-secondary-base`, is one of the **two tokens `components@0.21.0`
references but `tokens@0.16.0` never defines** (§5.4). Aliasing to it would make
every muted label inherit its parent's colour. **Keep the literal until upstream
fixes it, with a comment pointing at §5.4.** The same applies to
`--lp-color-text-ui-tertiary`.

**Must stay custom (no LaunchPad equivalent exists):**

- The **14 status colours** (`style.css:28-41`, plus 13 dark overrides at
  `:111-123`) — §7.2.
- The **7 kind-badge colours** (`--kind-node`, `--kind-leaf`, `--kind-cto`,
  `--kind-ceo`, `--kind-leader`, `--kind-build`, `--kind-unknown`,
  `style.css:52-58`, plus 2 dark overrides at `:126-127`) — butchr domain
  concepts.
- The **story-lifecycle** hint colours.
- The **6 legacy aliases** (`--finalizing`, `--queued`, `--running`, `--review`,
  `--awaiting`, `--rejected`) — defined **twice**, at `style.css:43-48` *and*
  again for dark at `:130-135`, so deleting them removes 12 lines.
  **Recommendation: delete them in Phase 2.** They are documented in-file as
  "kept for backward-compat with any code paths still referencing them." Per the
  repo's `pre-1.0-no-backwards-compat` rule and the prior RFC's "no dead tokens"
  criterion, grep for each — **both** `var(--running)` in CSS *and* any
  `el(x, {style: …})` / `{class: …}` usage in JS, the Errata #1 lesson — **read
  the matches rather than counting them**, and remove if dead.

**Spacing — SETTLED IN PHASE 0. The scales DO NOT ALIGN.** (Errata E4; evidence
§13.3.)

The RFC guessed that a Phase 5 alias would be mechanical. It is not. LaunchPad's
spacing is a **strict 4px grid**; butchr's is not:

| butchr | px | LaunchPad equivalent | verdict |
|---|---|---|---|
| `--space-1` | 4px | `--lp-spacing-200` (4px) | ✅ exact |
| `--space-2` | **6px** | — *(4px or 8px)* | ❌ **no equivalent** |
| `--space-3` | 8px | `--lp-spacing-300` (8px) | ✅ exact |
| `--space-4` | **10px** | — *(8px or 12px)* | ❌ **no equivalent** |
| `--space-5` | 12px | `--lp-spacing-400` (12px) | ✅ exact |
| `--space-6` | **18px** | — *(16px or 20px)* | ❌ **no equivalent** |

The full LaunchPad scale, resolved to real pixels in Chrome (each
`--lp-spacing-*` is an indirection to a `--lp-size-*`, which is a `rem` value;
`rem` here is the browser default 16px because butchr's only `font-size: 14px` is
on `body`, not `html`):

| token | via | value |
|---|---|---|
| `--lp-spacing-100` | `--lp-size-0` | **0px** |
| `--lp-spacing-200` | `--lp-size-4` | **4px** |
| `--lp-spacing-300` | `--lp-size-8` | **8px** |
| `--lp-spacing-400` | `--lp-size-12` | **12px** |
| `--lp-spacing-500` | `--lp-size-16` | **16px** |
| `--lp-spacing-600` | `--lp-size-20` | **20px** |
| `--lp-spacing-700` | `--lp-size-24` | **24px** |
| `--lp-spacing-800` | `--lp-size-28` | **28px** |
| `--lp-spacing-900` | `--lp-size-32` | **32px** |

**Recommendation: keep `--space-*` as butchr's own scale. Do NOT alias it.** Per
the RFC's own instruction — *"If the scales do not align, keep `--space-*` as
butchr's scale and say so"* — this is that saying-so.

The good news is that the blast radius the RFC feared does not exist. **The
spacing tokens have 12 usage sites, not 413** — the 413 figure counts *all*
`var(--…)` usages, overwhelmingly colours. Read, not counted, they are
`style.css:867, 870, 875, 879, 884, 888 (×2), 895, 897, 1234, 1238, 1247`, and
**zero** JS references in either the `el(x, {style: …})` or `{class: …}` form. Of
the 12, **7 sit on the three off-grid tokens** (`--space-2` ×1, `--space-4` ×2,
`--space-6` ×4).

So Phase 5 has a **real but small** decision, and it is a *design* decision, not a
mechanical one: snapping 6→4/8, 10→8/12, 18→16/20 moves real pixels on 7 rules.
The three aligned tokens (`--space-1/3/5`) *could* be aliased for free, but
aliasing half a scale is worse than aliasing none — it leaves a reader unable to
tell which tokens are live references and which are literals. **Keep all six
literal.**

### 7.5 Dark mode: **the contracts are already identical.** A real win.

Verified against both files:

| | butchr | `@launchpad-ui/tokens@0.16.0` |
|---|---|---|
| Where the theme lives | `document.documentElement.dataset.theme` (`index.html:13`) | an ancestor's `data-theme` attribute |
| Light selector | `:root` (`style.css:10`) | `:root, [data-theme]` (`themes.css`) |
| Dark selector | `html[data-theme="dark"]` (`style.css:99`) | `[data-theme='dark']` (`themes.css`) |

**Same mechanism, same attribute, same element.** Three consequences:

1. **The no-flash-of-wrong-theme script survives untouched.** `index.html:8-18`
   reads `localStorage` and stamps `documentElement.dataset.theme` *before first
   paint*. It must be preserved verbatim in the authored `index.html` and must
   run **before** the bundle's `<script type="module">` (which is deferred by
   definition, so this is automatic). LaunchPad's tokens will resolve against the
   already-stamped attribute on the very first paint.
2. **The theme toggle stays trivial.** `applyTheme` (`app.js:427-435`) sets the
   same attribute. In React it becomes a `ToggleButton` (or `IconButton`) writing
   `documentElement.dataset.theme` — the LaunchPad tokens re-resolve with no
   further wiring, because CSS custom properties cascade.
3. **Specificity favours butchr, correctly.** `html[data-theme="dark"]`
   (specificity 0,1,1) beats `[data-theme='dark']` (0,1,0). So during the
   coexistence in P3, where both define a variable, **butchr's value wins** —
   which is exactly the desired behaviour for an incremental re-basing, and it
   means the alias block in §7.4 can be introduced token-by-token.

⚠️ `UNVERIFIED:` the spike explicitly *did not* set `data-theme='dark'` and
re-measure. It confirmed the selectors exist in `themes.css` and nothing more.
**Phase 5 must verify dark mode in a real browser**, and §11 logs it.

---

## 8. (G) CONTRIBUTING — the rewrite

**Do not edit `CONTRIBUTING.md` in this subtask.** The prose below is the proposed
replacement, to be applied in **Phase 1a** (§0.4), in the same commit that adds the
first dependency (§5.1).

### 8.1 Replacing lines 31–32

> - **Stack:** Bun · SQLite (`bun:sqlite`) · herdr · git.
> - **Webapp:** React 19 + [LaunchDarkly LaunchPad](https://launchpad.launchdarkly.com/)
>   (`@launchpad-ui`), a single-page app bundled by `bun build`. The server has
>   **zero runtime npm dependencies**; every dependency is front-end or
>   build/test tooling.

### 8.2 Replacing `## 4. The zero-dependency rule` (line 605)

> ## 4. The dependency rule
>
> **butchr's *server* ships with zero runtime npm dependencies, and that remains a
> hard constraint.** `src/` is built entirely on the Bun standard library
> (`Bun.serve`, `Bun.spawn`, `bun:sqlite`, `fetch`, `node:fs`/`node:path`/
> `node:os`) plus the external `git` and `herdr` binaries. **Do not add a runtime
> dependency to `src/` without explicit CTO approval.** If you think you need a
> library, first check whether the Bun stdlib already covers it — it usually does
> (the MCP transport, the SSE stream, the operator CLI, and the log rotator are
> all hand-rolled for exactly this reason).
>
> **The front end is different, by CEO ratification (2026-07-09, story
> st-95b7d87c).** The webapp under `public/` is **React 19 + `@launchpad-ui`,
> bundled by `bun build` into `dist/`**, which is what the server serves. The
> zero-npm-dependency and no-build-step rules **no longer apply to the front
> end**, and `docs/rfc-frontend-launchpad.md` — which supersedes
> `docs/rfc-frontend-design-system.md` — is the standard.
>
> ### 4.1 The toolchain, and the four things that fail silently
>
> `bun build` is the *only* bundler. No webpack, no vite, no rollup, no loader,
> no plugin. Four rules are **not optional**, because each failure exits 0, boots,
> and is still wrong. `scripts/ci` asserts all of them; do not remove those
> assertions.
>
> 1. **`--outdir`, never `--outfile`.** LaunchPad's JS imports its own CSS, so
>    every build is multi-output and `--outfile` errors.
> 2. **`--production`.** Otherwise you ship React's development bundle — 1.61 MB
>    instead of 0.46 MB, with dev-mode checks running in the operator's browser.
> 3. **Import both token stylesheets** — `@launchpad-ui/tokens/index.css` **and**
>    `@launchpad-ui/tokens/themes.css` — from the entry module. The component CSS
>    defines almost none of the `--lp-*` variables it uses; without these the app
>    renders unstyled. Note `@launchpad-ui/tokens/style.css` **does not exist**
>    (only `components` and `icons` expose `./style.css`). Do not guess the path.
> 4. **Inline `@launchpad-ui/icons`' `sprite.svg` into `<body>`.** `Icon` emits
>    `<use href="#lp-icon-…">`, a document-local reference. Without the sprite,
>    every icon renders blank while keeping its 20×20 layout box — no test catches
>    it. `scripts/inline-sprite` does this after every build.
>
> ### 4.2 Dependencies are pinned EXACTLY. No carets.
>
> `@launchpad-ui/components` pins its peers to exact versions, including
> `react@19.2.6`. A caret anywhere produces a permanently peer-warned tree whose
> runtime behaviour is unverified. `bun.lock` is **committed** (it is text, not
> binary); `node_modules/` and `dist/` are **gitignored**; the gate runs
> `bun install --frozen-lockfile`.
>
> **Bumping `@launchpad-ui` is a task, not a chore.** It moves several pins in
> lockstep and can change the token surface — re-run the gate's artifact
> assertions and check dark mode in a real browser.
>
> ### 4.3 `bun build` does not typecheck. `tsc` does.
>
> `bun build` will happily compile `const n: number = "a string"`, a bogus
> component prop, and a nonexistent `<Icon name="pencil">` (there is no `pencil`;
> it is `edit`) — all exit 0. `bunx --bun tsc --noEmit` is a **required gate step**
> (`--bun`, not bare `bunx tsc`, and `-p` once per tsconfig). Do not remove it:
> without it, adopting a typed component library buys the `.d.ts` files and none of
> their protection.
>
> ### 4.4 Escaping is still structural
>
> The `esc()` / `{html:}` escape hatches were deleted (story st-82c11fd1) and must
> not return. JSX escapes every interpolated string by construction. **The
> equivalent footgun in React is `dangerouslySetInnerHTML`**, and
> `test/no-dangerous-html.test.ts` forbids it across `public/**/*.tsx`. Same rule,
> new spelling.

---

## 9. (H) TEST STRATEGY

The brief omits this and it is the largest under-costed item in the migration.
Here it is, first-class.

### 9.1 Exactly what is coupled today

**12 static importers** of `public/*` (read, not counted):

| Test file | Imports | DOM? | Fate |
|---|---|---|---|
| `test/graph-hierarchy.test.ts` | `core/work-graph.js` | no | **UNTOUCHED** (path → `.ts`) |
| `test/graph-rollup-completion.test.ts` | `core/work-graph.js` | no | **UNTOUCHED** |
| `test/projects-detail-ui.test.ts` | `core/format.js` | no | **UNTOUCHED** |
| `test/swimlane-order.test.ts` | `views/swimlanes.js` (`orderLaneLeaves`) | no | **RE-POINT** at the extracted pure module |
| `test/projects-initiatives-ui.test.ts` | `views/projects.js` (3 pure fns) | no | **RE-POINT** |
| `test/metrics-view.test.ts` | `views/metrics.js` (`rateSub`), `core/nav.js` | no | **RE-POINT** + tripwire question (§9.2) |
| `test/cli-helpers.test.ts` | `components/panel.js` (`ciBadge`) | no — asserts `typeof … === "function"` only (`:144`) | **RE-POINT** at a symbol. Cheap. |
| `test/state-meta-fallback.test.ts` | `core/state-meta.js`, `components/chips.js` | **yes** (`dom-stub`) | **SPLIT**: pure half untouched; chip half → RTL |
| `test/kind-badge.test.ts` | `components/chips.js` | **yes** (`dom-stub`) | **REWRITE** (RTL) |
| `test/diff-view.test.ts` | `views/diff.js` | **yes** (`dom-stub`) | **SPLIT**: `parseDiff`/`composeReviewNote` pure; render → RTL |
| `test/story-lifecycle-ui.test.ts` | `views/swimlanes.js` | **yes** (`dom-stub`) | **SPLIT**: `storyLifecycle` pure; chip → RTL |
| `test/projects-ceo-ui.test.ts` | `views/projects.js` | **yes** (`dom-stub`) | **REWRITE** (RTL) |

**3 coupled by other means:**

| Test file | Coupling | Fate |
|---|---|---|
| `test/app-restore-uistate.test.ts` | **scrapes** 3 `// <test-extract:…>` blocks out of `public/app.js` (`:346`, `:374`, `:392`) and evals them (`:27`) | **DELETED** (§9.4) |
| `test/no-opt-in-escaping.test.ts` | `new Glob("**/*.js").scanSync("public")` (`:43`) — asserts no `esc()`, no `{html:}`, no `innerHTML` | **RETARGETED** (§9.5) |
| `test/serve-static.test.ts` | asserts `/app.js` (`:56`) and `/style.css` (`:62`) serve 200 with the right content-type | **UPDATED** (§9.6) |

**5 files use `test/dom-stub.ts`:** `diff-view`, `projects-ceo-ui`, `kind-badge`,
`state-meta-fallback`, `story-lifecycle-ui`.

### 9.2 The crux: `document`-undefined-at-module-load is **incompatible with React**

`core/nav.js`'s header says the quiet part out loud:

> a `views/ -> app.js` import … destroys the DOM-free-at-load property **the whole
> test strategy rests on**

and `test/metrics-view.test.ts:23` is the tripwire:

```ts
expect(typeof globalThis.document).toBe("undefined");
```

This property is real, it is load-bearing today, and **React breaks it by
construction** — `react-dom/client` and `@launchpad-ui/components` reference DOM
globals in their module graphs. Any test importing a `.tsx` component needs a
`document` at import time. There is no way to keep both.

But look at *why* the property was invented. It was a **proxy** for the actual
invariant: **no module may drag `app.js`'s boot into its import graph.** That
boot (`setupTheme`, `wireAttention`, `connectSSE`, `app.js:449-460`) runs at
module scope and would fire an `EventSource` inside a test. The `document`
assertion detected it because `app.js`'s boot touches `document`.

**In React that invariant is enforced structurally, not by a tripwire.** There is
no `app.js` with a top-level boot: the entry is
`createRoot(...).render(<App/>)`, which nothing imports, and every component is a
pure function until rendered. The cycle `nav.js`'s `setRenderer` was invented to
prevent **cannot exist**, because `render` is not a module-global function
anybody imports.

**Recommendation:**

1. **Retire the `document`-undefined tripwire** (`metrics-view.test.ts:23`). It
   is a proxy for an invariant that the architecture now guarantees.
2. **Replace it with a direct assertion of the real invariant.** A new
   `test/no-side-effects-at-import.test.ts` that imports every `public/**/*.tsx`
   module and asserts that **no `EventSource` was constructed and no `fetch`
   issued** at import time (stub both globals, import, assert zero calls). That
   tests the thing we care about, rather than a symptom.
3. **Keep the pure-logic modules DOM-free and test them with no DOM at all.**
   After §1's horizontal split, `core/{format,work-graph,state-meta}` and the
   extracted pure halves of `chips`/`swimlanes`/`projects`/`diff`/`metrics` are
   importable with no `document`. Six of the twelve test files above then need
   **zero changes beyond a path**.

That last point is the payoff of §0.1 #5. **The horizontal split (Phase 2) is
what makes the test migration cheap**, and it lands *before* any React code —
which means Phase 2's diff is reviewable as "pure refactor, test suite green,
zero pixels changed."

### 9.3 Adopt a real DOM and a React testing library. Both.

`test/dom-stub.ts`'s own header states the reason it exists:

> **(1) ZERO DEPENDENCIES.** CONTRIBUTING §4 and the signed-off RFC … make "no npm
> dependency, no build step" a HARD constraint, and a test-only devDependency is
> still a dependency. **The CTO explicitly rejected pulling in happy-dom/jsdom for
> this.**

**That constraint is exactly what the CEO ratification retires.** The stub's
*sole* justification is gone. Keeping a hand-rolled ~100-line DOM to test React
components — which exercise React Aria's portals, focus management, and overlay
positioning — would be perverse: the stub cannot model any of it.

**Recommendation:**
- **`happy-dom`** as the DOM, registered via `bunfig.toml`'s test preload (butchr
  already has a `bunfig.toml`). Chosen over `jsdom` for speed and because bun's
  ecosystem defaults to it. `UNVERIFIED:` whether React Aria's overlay
  positioning (which reads layout geometry) works under happy-dom; jsdom has the
  same limitation. Logged in §11.
- **`@testing-library/react`** for component tests — queries by role and label,
  which for an `aria`-first library like LaunchPad is the *correct* assertion
  surface. Testing `C_Feta_base xisFqG_interactive` (the real emitted class names
  the spike observed) would be insane.
- **Delete `test/dom-stub.ts`** in Phase 4, when its last caller is rewritten.
  Its header's `withDom() MUST stay synchronous` constraint dies with it.

**Cost, named:** two more devDependencies, and the five `dom-stub` tests get
rewritten rather than ported. Roughly 300 lines of test churn. This is real, and
it is the correct price for testing React components against a DOM that behaves
like a DOM.

### 9.4 The sentinel scraper is retired by **deletion**

`test/app-restore-uistate.test.ts` reads `public/app.js` as text, extracts three
regions fenced by `// <test-extract:name>` comments (`:27`), and evaluates them.
It is the last such harness in the repo — `state-meta.js:6-9`,
`work-graph.js:8-10`, `swimlanes.js:17`, and `projects.js:15` all carry comments
recording that *their* sentinels were removed when they became importable
modules, each ending "do not reintroduce a sentinel here."

Per §1.4, the three functions it tests — `captureUiState`, `restoreUiState`,
`applyInputRestore` — **do not survive into React.** They exist only to undo
`mount()`'s destroy-and-rebuild. React's reconciliation preserves input value,
caret, and focus because it never unmounts the node.

**Recommendation: delete the test with the code, in Phase 4.** Do not port it.
Do not reintroduce a sentinel.

**Replace it with the assertion that actually matters to the operator**, which
the old test could only approximate: an RTL test that renders a view with an
uncommitted textarea, types into it, dispatches a state-changing SSE event
through the store, and asserts the text and caret survive the re-render. That is
the behaviour `captureUiState` was faking; now it is tested directly, against the
real mechanism.

### 9.5 `no-opt-in-escaping.test.ts` → `no-dangerous-html.test.ts`

The test globs `public/**/*.js` (`:43`) and forbids `esc()`, `el()`'s `{html:}`
prop, and `innerHTML =`. Its premise — *escaping is structural, and there is no
way to opt out* — **survives the migration and gets stronger**: JSX escapes every
interpolated string by construction, with no `el()` to route around.

But the glob is `*.js`, and after Phase 4 the front end is `*.tsx`. Left alone
the test would match **zero files and silently pass** — which is precisely the
"path-pinned ABSENCE assertions rot silently" failure the repo already learned
from (story st-ffcc9cec).

**Recommendation, Phase 4:**
- Glob `public/**/*.{ts,tsx}`.
- **Assert the glob matched > 0 files** (the st-ffcc9cec lesson, applied).
- Forbid `dangerouslySetInnerHTML` — the React spelling of the same hole.
- Keep forbidding `innerHTML =`.
- Drop `esc()` / `{html:}` (the symbols will not exist).

One caveat, from the spike: **`bun build` compiles JSX inside `.js` files.** The
glob must therefore cover `.js` too, or a `.js` file with JSX escapes the guard.
Simplest correct rule: glob `public/**/*.{js,jsx,ts,tsx}` and assert non-empty.

### 9.6 `serve-static.test.ts`

Nine tests. Seven are about the *rules* and survive untouched, including
`"the traversal guard precedes the new 404 branch"` (`:101`) and
`"an extensionless unknown path still returns index.html (SPA fallback)"` (`:76`).

Two are path-pinned to artifacts that cease to exist:
- `:56` `"/app.js returns 200 with a JavaScript content-type"`
- `:62` `"/style.css returns 200 with a CSS content-type"`

**Recommendation:** rewrite both to assert against the *built* artifact rather
than a literal name — read `dist/index.html`, extract the `src`/`href` the
bundler injected, request those, assert 200 and content-type. This tests the real
contract (whatever the bundler emitted is servable) instead of a filename that
now contains a content hash.

Add one test: `"a stale hashed bundle path 404s"` — request
`/index-DEADBEEF.js` and assert 404, not `index.html`. That is the §3.2 rule
doing its most valuable work.

### 9.7 Summary of test-suite churn

| Fate | Count | Files |
|---|---|---|
| **Untouched** (beyond an import path) | 3 | `graph-hierarchy`, `graph-rollup-completion`, `projects-detail-ui` |
| **Re-point** at the extracted pure module | 4 | `swimlane-order`, `projects-initiatives-ui`, `metrics-view`, `cli-helpers` |
| **Split** (pure half survives, DOM half → RTL) | 3 | `state-meta-fallback`, `diff-view`, `story-lifecycle-ui` |
| **Rewrite** onto RTL | 2 | `kind-badge`, `projects-ceo-ui` |
| **Delete** | 2 | `app-restore-uistate`, `dom-stub.ts` (helper) |
| **Retarget** | 1 | `no-opt-in-escaping` → `no-dangerous-html` |
| **Update** | 1 | `serve-static` (2 of 9 tests) |
| **New** | 2 | `no-side-effects-at-import`, the SSE-preserves-input RTL test |

**Net: ~7 files change meaningfully, 2 die, 2 are born.** That is a real cost and
it is bounded. Six of the twelve importers survive on a path change alone —
because of the horizontal split in Phase 2.

---

## 10. PHASED PLAN

Each phase is **independently landable**, has its own gate, and has a **real
rollback** (`dist/` is gitignored, so `git revert` + rebuild restores the prior
UI byte-for-byte).

### Phase 0 — pre-flight (no code) — ✅ **DONE**

- ~~**Verify** whether `bun.lock` embeds the root `package.json` version~~ →
  **it does not; the release step is unchanged** (Errata E1, §13.1).
- ~~**Verify** whether one `tsconfig.json` can cover `src/` and `public/`~~ →
  **it cannot; `tsconfig.public.json` is required** (§5.5, §13.2).
- ~~**Read the pixel values** of `--lp-spacing-100…900`~~ → **the scales do not
  align; keep `--space-*` literal** (Errata E4, §13.3).

Results, with commands and real output: **§13**. Three unbudgeted findings came out
of it — §13.4 — of which **one blocks Phase 1 as written** (`src/` does not
typecheck).

**Gate:** none (no code). **Rollback:** n/a.

### Phase 1a — make `src/` typecheck; butchr's first dependency

**Created after sign-off** (§0.4 decision 1), because Phase 0 found `src/` carries
**21 pre-existing type errors** (§13.2, §13.4 item 1) and `tsc` has never run
against this repository. Gate step 2 cannot land green over them, so this phase
lands **before Phase 1**. It is the option §10's earlier re-scoping note called
(a): a separate, purely-backend, reviewable phase.

**The CTO SANCTIONED this phase remaining under story st-95b7d87c**, in scope by
**entailment**, not scope-creep: decision 3's `tsc` gate presupposes a `src/` that
typechecks (§0.4 decision 2).

- Fix all **21** errors across `db.ts`, `tasks.ts`, `dispatcher.ts`, `channel.ts`,
  `stories.ts`, `exec.ts`, `herdr.ts`, `mcp.ts`, `workspace-agent.ts`,
  `startup-confirm.ts`. §13.4 item 1 enumerates every one.
- Add `typescript` (§5.5), plus the `bun-types`/`@types/bun` the root
  `tsconfig.json` already names but which was never installed — **butchr's first
  dependency.** Commit `bun.lock`. `.gitignore`: `node_modules/`.
- Add **gate step 2 for `src/` only**:
  `bunx --bun tsc --noEmit -p tsconfig.json`. `--bun`, not bare `bunx tsc`
  (Errata E2). The root `tsconfig.json` is unchanged.
- **Rewrite `CONTRIBUTING.md` §4 and lines 31–32** per §8. *Same commit* —
  decision 8 ties that rewrite to the phase adding the first dependency, and this
  is that phase (§0.4, §5.1).
- **Do NOT change the release step** — Errata E1 withdrew that requirement.

**Operator sees:** nothing. No FE change; no React, no `@launchpad-ui`.
**Gate:** full `scripts/ci`, now with `tsc` over `src/`.
**Rollback:** revert; the gate loses step 2 and `src/` returns to untypechecked.

> Purely backend, and reviewable as such. Folding 21 type fixes into Phase 1's
> toolchain diff would destroy the "deliberately boring" property that is Phase 1's
> whole point.

### Phase 1 — the front-end toolchain, with **zero FE code change**

**Depends on Phase 1a**, and **re-scoped** by it (§0.4 decision 1): the backend
typecheck, the first dependency, and the CONTRIBUTING rewrite have moved there.
What remains here is the front-end toolchain.

- Add the 15 exact dependencies (§5.3 — the count is **unchanged**) + the
  front-end devDependencies `@types/react`, `@types/react-dom`, `happy-dom`,
  `@testing-library/react` (§5.3; the first two are mandatory, per Errata E3);
  update `bun.lock`.
- `.gitignore`: `dist/`.
- **Add `tsconfig.public.json`** (§5.5) and extend gate step 2 with a second `-p`
  for it — one config **cannot** cover both trees (§13.2).
- Add `scripts/inline-sprite`, `scripts/assert-fe-artifact`.
- Rewrite `scripts/ci`'s front-end rules per §4.2 — **including replacing
  `--outfile /dev/null` with `--outdir`**, which is required before any CSS enters
  the graph.
- `build:fe` bundles the **existing vanilla `public/app.js`**; `PUBLIC_DIR` → `dist/`.

**Operator sees:** nothing. Identical pixels, identical behaviour.
**Gate:** full `scripts/ci`; `test/serve-static.test.ts` updated per §9.6.
**Rollback:** revert; `PUBLIC_DIR` returns to `public/`.

> This phase is deliberately boring and deliberately first *among the front-end
> phases*. It proves the build, the serve, the sprite step, the three assertions,
> and the lockfile *before* a single line of React exists. If anything in §2–§5 is
> wrong, it is wrong here, against a UI we can still see working.

### Phase 2 — the horizontal split (still vanilla, still zero pixels)

- Extract the pure halves of `chips`, `swimlanes`, `projects`, `diff`, `metrics`
  into DOM-free leaf modules (§0.1 #5).
- Move `toast`/`terminalToast` out of `core/api.js` into a `components/` leaf —
  **this is what finally lets `core/dom.js` die** (§0.1 #3).
- Delete the 6 dead legacy colour aliases if grep (**both** `style.css` *and*
  `el(…, {style:…})` forms) proves them unused (§7.4).
- Re-point the 6 pure test files.

**Operator sees:** nothing. **Gate:** full `scripts/ci`; test suite green with
zero rewritten assertions. **Rollback:** revert; it is a pure refactor.

> Phase 2 is what makes Phase 4's test migration cheap (§9.2). It lands before any
> React, so its diff is reviewable as "moves, no logic."

### Phase 3 — the React shell

- `public/index.html` → authored entry with `<script type="module" src="/main.tsx">`;
  no-flash theme script preserved verbatim (§7.5).
- `main.tsx` imports both token stylesheets (§2.5), mounts `<App/>`.
- React owns: topbar, `Alert` pause banner, conn LED, theme `ToggleButton`,
  `ToastRegion`, `react-router` hash routes (§1.3), the state-meta store, the SSE
  `useEffect`.
- Views still vanilla, called from a `useEffect` into a React-owned container —
  **one bridge, one phase.**
- `style.css` gains the §7.4 alias block.

**Operator sees:** a LaunchPad shell around the existing view bodies. Usable.
**Gate:** full `scripts/ci` + the three artifact assertions now doing real work
(this is the first build with LaunchPad CSS in the graph).
**Rollback:** revert to Phase 2's `index.html` + `app.js`.

### Phase 4 — the views (the big-bang)

- Rebuild all six views and the six components in `.tsx`.
- **Delete** `core/dom.js`, `core/nav.js`, `app.js`'s UI-state harness and
  its 3 sentinel blocks, `views/diff.js`'s `tok()`-fused highlighter (refactored
  to token records), `test/app-restore-uistate.test.ts`, `test/dom-stub.ts`.
- Rewrite the 5 DOM tests onto `@testing-library/react`; add the two new tests
  (§9.7); retarget `no-opt-in-escaping` → `no-dangerous-html` (§9.5).
- Remove the bridge.

**Operator sees:** the new UI. **Gate:** full `scripts/ci`; **plus a manual
browser check** — the spike is unambiguous that a green build proves nothing
about tokens, icons, or the dev bundle, and §4.3's assertions cover exactly those
three and nothing else.
**Rollback:** revert to Phase 3 (shell + vanilla views), which is a working
dashboard. **This is the reason Phase 3 exists as a boundary.**

### Phase 5 — polish

- Swimlanes visual parity pass.
- **Verify dark mode in a real browser** (spike `UNVERIFIED:` #13).
- **Verify `Modal`/`DialogTrigger` open state and keyboard a11y** (spike
  `UNVERIFIED:` #12 — "I rendered the trigger; I never clicked it").
- ~~Map `--space-*` → `--lp-spacing-*` **only if** Phase 0's pixel diff says they
  align.~~ **CANCELLED, not deferred.** §7.4 conditioned the mapping on the two
  scales aligning, and Phase 0 measured that they do not: LaunchPad is a strict 4px
  grid, butchr's scale is `4/6/8/10/12/18px`, and `--space-2/4/6` have **no
  LaunchPad equivalent at any tier** (Errata E4; evidence §13.3). **All six
  `--space-*` stay literal.** What remains is an optional *design* call — whether
  to snap `--space-2/4/6` (6/10/18px) onto the 4px grid, moving pixels on **7 CSS
  rules**. Cheap either way; not required for parity.
- Measure the real bundle with the full component surface; consider `--splitting`
  (spike `UNVERIFIED:` #11).

**Gate:** full `scripts/ci`. **Rollback:** per-commit.

---

## 11. RISKS AND OPEN QUESTIONS

Ranked by expected cost. Items marked ⚠️ are the spike's own `UNVERIFIED:` list,
carried forward as **open questions, not settled facts.**

1. **Three silent failures, forever.** Tokens, sprite, dev-build. Each exits 0.
   §4.3's three assertions are the *entire* defence. **If a future agent deletes
   them as "redundant with the build," the failure returns undetected.** Their
   comments must say so; §8.2's CONTRIBUTING prose says so.
2. ⚠️ **The mismatched-peer tree's runtime behaviour.** The spike: *"React Aria
   context sharing across two minor versions is exactly the sort of thing that
   breaks subtly, and a `Button`/`Table` smoke test would not show it."* §5.3's
   exact pins are the mitigation; the risk is that a future `bun update` or a
   careless caret reintroduces the mismatch.
3. **The swimlanes rebuild.** The bulk of a 369-line module is bespoke DOM with no
   LaunchPad analogue (§7.3), and it is the view operators look at most. The five pure
   functions port unchanged and keep their tests, which bounds the risk to
   *visual* regression — which no test catches. Phase 5 exists for it.
4. **LaunchPad API churn.** `@launchpad-ui/components` is at **0.21.0** — a
   `0.x` version with **179 published versions**. It is pre-1.0 and its peers are
   exact-pinned, so every bump moves several pins in lockstep (§5.3) and can
   change the token surface. Budget a task per bump. **Do not bump on a whim.**
5. **The upstream token bug.** `components@0.21.0` references two tokens
   `tokens@0.16.0` never defines (§5.4). Cosmetic today. It is evidence the two
   packages are more tightly coupled than their version numbers admit, and it is
   why `--muted` must stay a literal.
6. ✅ **Typechecker configuration — RESOLVED by Phase 0.** One config cannot cover
   both trees; `tsconfig.public.json` is required (§5.5, §13.2). *A new, larger
   risk replaced it:* **`src/` has 21 pre-existing type errors** and `tsc` has
   never run against this repo, so gate step 2 red-builds `main` on day one
   (§13.2, §13.4). **Addressed by Phase 1a** (§0.4, §10). The `"jsx": "react"` typo
   hazard is unchanged and still real — **exit 0, throws at runtime** (spike §3).
7. ⚠️ **happy-dom vs React Aria.** Overlay positioning reads layout geometry,
   which no headless DOM implements faithfully. Modal/Popover/Tooltip tests may
   need a real browser or may simply be untestable at the unit level. jsdom has
   the same limitation. §9.3.
8. ⚠️ **`react-router` hash history + `RouterProvider`.** Not exercised in the
   spike. §1.3 depends on it. If it fights hash history, the fallback is to keep
   `nav.js`'s `parseHash` behind a thin React hook — a contained retreat.
9. **Bundle size.** 0.46 MB JS + 0.32 MB CSS production (gzip: 142 KB + ~147 KB
   without fonts). That is a large step up from a 1,250-line CSS file and ~6,500
   lines of JS served raw. **For a loopback single-operator tool this is
   acceptable** and no CDN is involved. ⚠️ The 0.46 MB figure is for **five**
   components; the spike did not measure the full library surface, nor whether
   tree-shaking or `--splitting` helps. `sideEffects: ["**/*.css"]` is declared,
   so JS tree-shaking *should* be permitted — unconfirmed.
10. **Test-suite churn.** ~7 files change meaningfully, 2 die, 2 are born
    (§9.7). Bounded, and Phase 2 is what bounds it.
11. **Build time in CI.** ~0.12 s bundle, ~0.6–2.1 s `bun install`. **A
    non-issue** next to `bun test ./test`. ⚠️ Not measured in butchr's actual CI
    environment (cold cache/disk).
12. ⚠️ **Dark mode at runtime.** The selectors match (§7.5) but the spike never
    set `data-theme='dark'` and re-measured. Phase 5.
13. ⚠️ **`Modal`/`DialogTrigger` open state, keyboard, a11y.** The spike rendered
    the trigger and never clicked it. Overlays are where React Aria's
    portal/context machinery actually gets exercised. Phase 5.
14. ⚠️ **`bun build --watch` semantics** (full rebuild vs incremental — 123 ms
    either way, so immaterial); **`bun ./index.html` HMR** (not tested);
    **`--app` / Bun Bake** (EXPERIMENTAL per the binary's own help). None are on
    the recommended path (§2.9).
15. ⚠️ **No bun flag found to emit fonts as files rather than base64.** Mooted by
    §2.7's recommendation not to import `fonts.css` at all.
16. **`bun.lock` as new rebase-race surface.** §5.6 hazard 2. No new gate rule
    proposed; a lockfile conflict is a git conflict, not a silent drop. **Phase 0
    shrank this:** the release bump does not touch `bun.lock` at all (Errata E1), so
    only a deliberate dependency change writes it.
17. **`dist/` must exist before `Bun.serve` binds** (§3.1). A missing `dist/`
    means a blank dashboard. Boot should refuse, or log loudly — not 404 quietly.
18. 🚨 **`src/` does not typecheck** (21 errors, §13.2). **New, and the largest
    thing Phase 0 found. Now owned by Phase 1a** (§0.4, §10).
    It is not a migration risk so much as a pre-existing
    debt the migration is about to expose: adopting `tsc` as a gate step means
    adopting `tsc`'s verdict on code nobody has ever typechecked. Three of the 21
    are references to names that do not exist in scope (`TaskKind` ×3,
    `SendInput` ×1) and one is a duplicate object key (`db.ts:2879`) — i.e. the
    typechecker is already earning its keep before a line of React is written.
19. **A poisoned `~/.bun/install/cache` yields silently-empty packages.** Observed
    once during Phase 0: `bun-types` installed with every file at **0 bytes**,
    producing 399 bogus `tsc` errors. `bun install --frozen-lockfile` does **not**
    catch it (the lockfile is correct; the cache is not). `rm -rf` of the cache
    entry fixed it. Not worth a gate rule; worth knowing before someone spends an
    hour on it.

**No PRODUCT FORK found.** `@launchpad-ui` is public, Apache-2.0, installable
without auth (the spike verified this clean-room, with a scrubbed environment and
no `.npmrc`), and it works. The one finding that *approaches* a fork — LaunchPad
has no layout layer, no `Card`, no `Badge`, no `Panel` (§7.1) — is a scope
correction, not a blocker: butchr keeps its bespoke layout CSS and re-bases it on
real tokens, which is what `style.css` was already imitating by hand.

---

## 12. DECISIONS REQUESTED FROM THE CTO

**All nine were APPROVED by the CTO on 2026-07-09** (see the status block). The
CTO also reviewed Errata E1–E4 and did not object; where an erratum touches a
decision, the reconciliation is noted inline below. Two further decisions taken
after sign-off are in §0.4.

1. **Approve the supersession** of `docs/rfc-frontend-design-system.md` (Option 0)
   and the §0.3 survivals.
2. **Approve exact pinning of 15 direct dependencies, no carets** (§5.3), and the
   procedural consequence that a LaunchPad bump is a task, not a chore.
   *Reconciled with Errata E3: the **devDependency** list gains `@types/react` and
   `@types/react-dom` (`react` ships no `.d.ts`). **The count of exact-pinned
   direct dependencies is unchanged: 15.***
3. **Approve `typescript` + `bunx --bun tsc --noEmit` as a required gate step**
   (§5.5). *This is the decision that determines whether adopting a typed component
   library is worth anything.*
   *Reconciled with Errata E2: the invocation is `bunx --bun tsc` — a bare
   `bunx tsc` honours the `#!/usr/bin/env node` shebang and dies on this host's
   node v12 — and it is passed `-p` twice, because one `tsconfig.json` cannot cover
   both trees. **Measured cost ~10.6 s**, which contradicts §4.2's original ~100 ms
   ordering rationale (the step stays where it is regardless). And per §0.4, this
   decision is what entails Phase 1a: the gate cannot land green over `src/`'s 21
   pre-existing errors.*
4. **Approve `happy-dom` + `@testing-library/react`, and the deletion of
   `test/dom-stub.ts` and the `document`-undefined tripwire** (§9.2, §9.3) — the
   CTO previously rejected happy-dom/jsdom *on the zero-dependency ground that no
   longer exists.*
5. **Approve adopting `react-router`** (already an exact peer) over keeping
   `core/nav.js`'s hash router (§1.3).
6. **Approve BIG-BANG on the view layer** with Phase 3 as the rollback boundary
   (§6.2).
7. **Approve the 14 status colours and 7 kind colours staying custom** — i.e.
   *not* collapsing them into LaunchPad `Tag`'s 8 variants (§7.2).
8. **Approve the CONTRIBUTING §4 rewrite** in §8, landing alongside the first
   dependency. *Reconciled with §0.4: the phase that adds the first dependency is
   now **Phase 1a**, so the rewrite lands there, not in Phase 1.*
9. **Note** that `dist/` is gitignored and `bun run build:fe` becomes a
   prerequisite of `bun start` (§3.1).

*Errata E1 and E4 touch no decision above.* E1 **withdrew** §5.6's proposed release
step change — the release step is unchanged (§5.6, §13.1). E4 **cancelled** Phase
5's `--space-*` alias task (§10 Phase 5, §7.4, §13.3).

---

## 13. PHASE 0 RESULTS

**Status: complete.** Three questions asked, three answered empirically. **Two of
the three came back the opposite of what the RFC guessed**, and the work surfaced a
fourth thing nobody asked about that **blocks Phase 1 as written** (§13.4).

Environment: `bun 1.3.11`, `typescript 5.9.3`, Linux. All installs were performed in
a scratch directory **outside the repository**; the repo remains dependency-free and
this phase changed exactly one file — this one.

| # | Question | RFC's guess | Answer | Consequence |
|---|---|---|---|---|
| 1 | Does `bun.lock` embed the root `version`? | "probably — mitigate" | **NO** | `--frozen-lockfile` is safe; **release step unchanged** |
| 2 | Can one `tsconfig.json` cover `src/` + `public/`? | "unverified — budget for two" | **NO — two required** | Phase 1 adds `tsconfig.public.json` |
| 3 | Do `--lp-spacing-*` and `--space-1..6` align? | "defer to Phase 5 if they align" | **NO — 3 of 6 have no equivalent** | **Phase 5's alias task is cancelled** |

---

### 13.1 `bun.lock` does **not** embed the root `package.json` version

**Verdict: §5.6 hazard 1 is REFUTED. The release step must not change.**

Method: generate a real lockfile in a scratch dir, bump `version` exactly the way
butchr's release step does, re-install, diff.

```console
$ cat package.json
{ "name": "butchr", "version": "0.9.275", "type": "module",
  "dependencies": { "@launchpad-ui/components": "0.21.0", "@launchpad-ui/icons": "0.26.0",
                    "@launchpad-ui/tokens": "0.16.0", "react": "19.2.6", "react-dom": "19.2.6" } }

$ bun install
31 packages installed [840.00ms]

$ head -16 bun.lock
{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "butchr",
      "dependencies": {
        "@launchpad-ui/components": "0.21.0",
        …
      },
    },
  },
  "packages": { … }

$ grep -c '0\.9\.275' bun.lock
0
```

The root workspace entry carries **`name` and `dependencies`. There is no
`version` key.** Then the actual experiment:

```console
$ cp bun.lock lock.a
$ sed -i 's/"version": "0.9.275"/"version": "0.9.276"/' package.json
$ bun install
Checked 31 installs across 32 packages (no changes) [3.00ms]

$ diff lock.a bun.lock && echo "LOCKFILE IDENTICAL AFTER VERSION BUMP"
LOCKFILE IDENTICAL AFTER VERSION BUMP

$ bun install --frozen-lockfile; echo "exit=$?"
exit=0
```

Reproduced identically on a one-dependency tree. **Conclusions:**

1. `bun install --frozen-lockfile` in `scripts/ci` is **safe on every post-release
   branch**. §4.4 stands as written.
2. The RFC's recommendation that *"the release step must run `bun install` … and
   include `bun.lock` in the release commit"* is **withdrawn**. Adding it would
   have been a pointless write to a file on every release, and would have *created*
   the rebase-race surface §5.6 hazard 2 worries about.
3. Caveat worth stating: the lockfile **does** record the root `name`. Renaming the
   package would dirty it. butchr's release step never renames, so this is inert.

---

### 13.2 One `tsconfig.json` **cannot** cover both trees

**Verdict: §5.5's `UNVERIFIED:` is settled — `tsconfig.public.json` is required.**
Two other things fell out, and one of them is worse than the question asked.

Method: copy the **real** `src/` and `public/` into a scratch dir (`diff -r`
confirmed byte-identical to the repo), install `typescript`, React 19, and the
pinned `@launchpad-ui` set, and run `tsc` under varying configs against a
representative `public/main.tsx` (token CSS imports, a LaunchPad `Button`,
`createRoot`, `document.getElementById`).

**First, a hazard in the gate command itself (Errata E2).**

```console
$ bunx tsc --noEmit
node_modules/typescript/lib/_tsc.js:92
  for (let i = startIndex ?? 0; i < array.length; i++) {
                           ^
SyntaxError: Unexpected token '?'
    at wrapSafe (internal/modules/cjs/loader.js:915:16)

$ node --version
v12.22.9
$ head -1 node_modules/.bin/tsc
#!/usr/bin/env node

$ bunx --bun tsc --version
Version 5.9.3
```

`bunx tsc` honours the shebang and hands the script to this host's ancient `node`.
**The gate must say `bunx --bun tsc`.** `bun run tsc` fails the same way.

**Second: `lib: ["DOM"]` is the irreconcilable conflict.**

`public/` needs `DOM` (`error TS2584: Cannot find name 'document'`). Adding `DOM`
to a shared `lib` changes `src/`'s meaning **in both directions**:

```console
# with lib: ["ESNext"]           →  src/ 21 errors, public/ 1 error (document)
# with lib: ["ESNext","DOM"]     →  src/ 21 errors, public/ 0 errors
#                                   …but NOT THE SAME 21:
$ diff <(tsc -p no-dom.json) <(tsc -p with-dom.json)
> src/channel.ts(1410,31): error TS2504: Type 'ReadableStream<Uint8Array<ArrayBuffer>>'
    must have a '[Symbol.asyncIterator]()' method that returns an async iterator.
< src/mcp.ts(175,5): error TS2322: Type 'unknown' is not assignable to type
    'JsonRpcMessage | JsonRpcMessage[]'.
```

- **Breaks real code.** `src/channel.ts:1410` is `for await (const chunk of
  Bun.stdin.stream())`. Bun's `ReadableStream` is async-iterable; `lib.dom`'s is
  not. Shipping, working code stops typechecking.
- **Masks a real error.** `src/mcp.ts:175` is `body = await req.json()`. Under
  `bun-types` that is `unknown` (correctly rejected under `strict`); under
  `lib.dom`'s `Request` it is `any`, and the error silently disappears.

A shared config is wrong in both directions, so the split is not a stylistic
preference. The verified `tsconfig.public.json` is reproduced in **§5.5**; against
the real `public/` (all 19 legacy `.js` modules plus `main.tsx`) it reports
**0 errors, exit 0**.

The split is also a *feature*. Each tree is confined to its own globals:

```console
# public/, types: []          →  Bun.file("/etc/passwd")
public/probe.tsx(1,18): error TS2868: Cannot find name 'Bun'.
# src/, no DOM in lib         →  document.title
src/probe.ts(1,18): error TS2584: Cannot find name 'document'.
```

**Sub-findings, all verified, all cheap to get wrong:**

- **Side-effect CSS imports need no `declare module "*.css"`.** Both
  `import "@launchpad-ui/tokens/index.css";` and `import "./local.css";`
  typecheck clean. TS only demands a declaration for a *binding* import
  (`import styles from "./local.css"` → `TS2307`). **Do not add a
  `declarations.d.ts`.** (Controls run: injecting a deliberate `TS2322` into the
  same files proved `tsc` was really checking them, and `--listFiles` confirmed
  they were in the program.)
- **`@types/react` + `@types/react-dom` are mandatory** (Errata E3). `react@19.2.6`
  and `react-dom@19.2.6` ship **no `.d.ts`**. Without them:
  `TS7016: Could not find a declaration file for module 'react/jsx-runtime'` —
  while `bun build public/main.tsx` exits **0**. Versions that resolved against the
  pinned tree: `@types/react@19.2.17`, `@types/react-dom@19.2.3`.
- **§4.1's orphan-module claim CONFIRMED, with one caveat.** An orphan
  `public/views/foo.tsx` with a type error fails `tsc` (`TS2322`); an orphan
  `public/views/foo.js` with a *syntax* error also fails (`TS1005`). But under
  `allowJs` **without `checkJs`**, an orphan `.js` with a *type* error passes. So
  during Phases 1–3, while `public/` is still vanilla, `tsc` is exactly as strong
  as the gate rule it replaces — **not stronger**. From Phase 4 (all `.tsx`) it is
  strictly stronger, as claimed.
- **§5.5's thesis confirmed end-to-end.** The spike's own `icon="pencil"` bug:

  ```console
  public/icontest.tsx(2,24): error TS2322: Type '"pencil"' is not assignable to type
    '"article" | "code" | … | 318 more … | undefined'.
  ```

  `bun build` accepts it and renders an empty 20×20 box. The typechecker is the
  only thing that catches it.
- **Cost of gate step 2: ~10.6 s** (`src/` 6.01 s, `public/` 4.62 s), not the
  ~100 ms §4.2's ordering rationale assumes. Still trivial beside `bun test ./test`.
- **`types: ["bun-types"]` and `types: ["bun"]` behave identically** (both resolve
  to `bun-types@1.3.14`). The existing root `tsconfig.json` needs no change here —
  but note it has **never been executed**, because `typescript` was never installed.

`UNVERIFIED:` I did not test `tsc --build` with project `references` as an
alternative to two invocations. Two `-p` invocations work, cost 10.6 s, and are
what §4.2 now specifies; `references` would be an optimisation, not a fix, since
the `lib` conflict is what forces two configs either way.

---

### 13.3 `--lp-spacing-*` vs `--space-1..6`: **they do not align**

**Verdict: §7.4's deferral condition fails. Phase 5's alias task is cancelled.**

`--lp-spacing-*` is a double indirection — spacing → size → `rem` — so reading the
names is not enough, and the RFC's `UNVERIFIED:` note was right to insist on
values.

```console
$ grep -oE '\-\-lp-spacing-[a-z0-9-]+:[^;]*;' node_modules/@launchpad-ui/tokens/dist/index.css
--lp-spacing-100: var(--lp-size-0);      --lp-spacing-600: var(--lp-size-20);
--lp-spacing-200: var(--lp-size-4);      --lp-spacing-700: var(--lp-size-24);
--lp-spacing-300: var(--lp-size-8);      --lp-spacing-800: var(--lp-size-28);
--lp-spacing-400: var(--lp-size-12);     --lp-spacing-900: var(--lp-size-32);
--lp-spacing-500: var(--lp-size-16);
```

Rather than trust the arithmetic, the values were resolved in **real headless
Chrome**, in a document carrying butchr's own `body { font-size: 14px }`, by
setting `width: var(--lp-spacing-N)` and reading `getComputedStyle`:

```console
$ google-chrome --headless --dump-dom file://…/probe.html
--lp-spacing-100 = 0px      --lp-spacing-500 = 16px     --lp-spacing-900 = 32px
--lp-spacing-200 = 4px      --lp-spacing-600 = 20px     ROOT_FONT_SIZE = 16px
--lp-spacing-300 = 8px      --lp-spacing-700 = 24px     BODY_FONT_SIZE = 14px
--lp-spacing-400 = 12px     --lp-spacing-800 = 28px
```

The `rem` basis is **16px, not 14px**: butchr's only `font-size: 14px` is on `body`
(`style.css:150-157`), and `rem` resolves against `html`. There is no
`html`/`:root` `font-size` anywhere in `style.css`, and no `rem`/`em`/`%` root
font-size at all — so the browser default stands. Had the `14px` been on `html`,
every LaunchPad spacing value would have been 12.5% smaller and the table below
would be different. This was worth checking.

**The diff** (butchr's scale is `style.css:91-96`):

| butchr | px | LaunchPad | verdict |
|---|---|---|---|
| `--space-1` | 4 | `--lp-spacing-200` = 4px | ✅ exact |
| `--space-2` | **6** | *nothing at 6px* | ❌ off-grid |
| `--space-3` | 8 | `--lp-spacing-300` = 8px | ✅ exact |
| `--space-4` | **10** | *nothing at 10px* | ❌ off-grid |
| `--space-5` | 12 | `--lp-spacing-400` = 12px | ✅ exact |
| `--space-6` | **18** | *nothing at 18px* | ❌ off-grid |

LaunchPad's scale is a **strict 4px grid**. butchr's three even-but-not-multiple-of-4
values (6, 10, 18) have no equivalent **at any tier** — they are not "a tier off,"
they are between tiers.

**Blast radius is far smaller than §7.4 feared.** The RFC warned a blind remap
"silently reflows 413 usage sites." That 413 is the count of *all* `var(--…)`
usages in `style.css`, overwhelmingly colours. The spacing tokens have **12**
usages, and — per the repo's own `fe-grep-blind-to-el-props` lesson — I grepped
**both** the CSS form and the `el(x, {style: …})` / `{class: …}` JS forms, and
**read** the matches rather than counting them:

```console
$ grep -nE 'var\(\s*--space-' public/style.css        # 12 matches, 11 lines
867: label.field { margin-bottom: var(--space-5); }
870: label.field.tight { margin-bottom: var(--space-2); }      ← off-grid
875: .field-row { gap: var(--space-3); }
879: .row { gap: var(--space-4); }                             ← off-grid
884: .stacked { margin-top: var(--space-6); }                  ← off-grid
888:   padding: var(--space-6); margin-bottom: var(--space-6); ← off-grid ×2
895: .lede { margin: 0 0 var(--space-4); }                     ← off-grid
897: .panel-actions { margin-top: var(--space-5); }
1234: .cto-card { margin-bottom: var(--space-6); }             ← off-grid
1238: .cto-card .meta { margin-top: var(--space-1); }
1247: .cto-controls { gap: var(--space-3); }

$ grep -rn -- '--space-' public/*.js public/*/*.js
(no matches — zero JS references, in either form)
```

**7 of the 12 usages sit on the three off-grid tokens.**

**Recommendation: keep all six `--space-*` literal.** The RFC pre-authorised this
outcome — *"If the scales do not align, keep `--space-*` as butchr's scale and say
so."* Aliasing only the three that happen to match would be worse than aliasing
none: a reader could no longer tell which tokens are live references to LaunchPad
and which are butchr literals. Snapping 6→4/8, 10→8/12, 18→16/20 is a **design**
decision affecting 7 CSS rules; it is cheap, it is optional, and it is not needed
for parity. It stays in Phase 5 as a judgment call, not a mapping chore.

---

### 13.4 Three things Phase 0 was not asked about, and one of them blocks Phase 1

Reported because the brief asked for an honest negative over a confident guess.

1. 🚨 **`src/` does not typecheck — 21 errors.** `bun build` strips types without
   checking them and `typescript` has never been installed, so `tsc --noEmit` has
   **never run against this repository**. The moment §4.2's gate step 2 lands, the
   gate goes red on `main`. Verified against a byte-identical copy of the real
   `src/` (`diff -r` clean) using the repo's **own, unmodified** `tsconfig.json`.
   These are not lint nits; several are references to names that are not in scope:

   ```
   src/channel.ts(559,568,583,723): TS2322  ×4  Record<string,string|number> vs optional key
   src/db.ts(2879,5):               TS1117      duplicate property `kind` in one object literal
   src/dispatcher.ts(201,3):        TS2740      WorkspaceRow missing 6 properties
   src/dispatcher.ts(553,31):       TS2304      Cannot find name 'SendInput'   ← never imported
   src/dispatcher.ts(753,45):       TS2345      string|null vs string|undefined
   src/exec.ts(238,239):            TS2345  ×2  ReadableStream variance
   src/herdr.ts(314,23):            TS2677      type predicate not assignable to its parameter
   src/mcp.ts(175,5):               TS2322      await req.json() is `unknown` under strict
   src/startup-confirm.ts(65,5):    TS2322      { enter: true } vs SendInput
   src/stories.ts(301,34):          TS2339      'initiative_id' does not exist on TaskRow
   src/stories.ts(1067,5):          TS2322      "work"|"ceo" not in "cto"|"story"|"user"
   src/tasks.ts(886,935):           TS2345  ×2  object literal vs TaskListView
   src/tasks.ts(1041,1941,2005):    TS2304  ×3  Cannot find name 'TaskKind'   ← never imported
   src/workspace-agent.ts(612,26):  TS2322      optional key vs Record<string,string>
   ```

   Spot-checked against the real source: `src/tasks.ts` annotates three signatures
   with `TaskKind` and its import list (`tasks.ts:19`) pulls `TaskRow`, `TaskStatus`,
   `WorkspaceRow`, `WorkspaceAgentRow` from `./db.ts` — **not `TaskKind`**.
   `src/dispatcher.ts:553` types a callback parameter as `SendInput`, which
   `herdr.ts:21` exports and `dispatcher.ts` never imports. `src/db.ts:2879` sets
   `kind` twice in one literal, with a comment explaining that the second should
   win — which is exactly what `TS1117` forbids.

   **This is arguably the strongest evidence in the whole RFC for §5.5**: a
   typechecker found four scope errors and a duplicate key before React existed.
   But it is also **unbudgeted work that gates Phase 1**, and it is backend work,
   not front-end. See Phase 1's re-scoping note; the recommendation is a Phase 1a.

2. **`bunx tsc` is not a working command on this host.** See §13.2 / Errata E2. The
   gate must use `bunx --bun tsc`, and must pass `-p` twice.

3. **A poisoned bun cache produces silently-empty type packages.** Midway through
   §13.2, `bun-types@1.3.14` installed with **every file at 0 bytes** (`index.d.ts`,
   `globals.d.ts`, `package.json` — all empty), yielding 399 spurious errors like
   `Cannot find name 'console'`. `bun install --frozen-lockfile` does **not** detect
   it: the lockfile is correct, the *cache* is corrupt. `rm -rf ~/.bun/install/cache/bun-types*`
   plus a reinstall restored a 1,306-byte `index.d.ts`. Logged as risk 19. This was
   an environment fault, **not** a finding about bun-types — recorded only so the
   next agent does not spend an hour on it.

---

### 13.5 Scope note

Two things this phase deliberately did **not** do:

- **No repo state changed but this file.** No dependency added, no `package.json`
  touched, no `scripts/ci`, `public/`, or `src/` edit. Every install went to a
  scratch directory outside the repository. `git status` shows one modified file.
  Docs-only, so no `CHANGELOG.md` entry (`scripts/ci`'s changelog rule exempts
  `^docs/`, verified by reading the rule).
- **The RFC's own status line was left alone.** Line 3 still reads
  *"Status: DRAFT — awaiting CTO sign-off"*, while this subtask's brief states the
  RFC is CTO-signed-off with all nine §12 decisions approved. **The document and
  the brief disagree.** Following the house rule that the artifact wins over the
  prompt, I did not silently "fix" the header to match the brief — flipping a
  sign-off marker is the leader's call, not a build agent's. **Leader: please
  update line 3.** Note also that Errata E1–E4 touch decisions **2** (the
  dependency list grows by two `@types/*`) and **3** (`tsc` as a gate step is now
  known to red-build `main`), so the sign-off may warrant a second look regardless.

  > **[Leader, 2026-07-09 — done.]** The status block now records the CTO's
  > sign-off. The second look was taken: decisions 2 and 3 stand as approved, with
  > the E2/E3 reconciliations noted inline in §12; the `tsc` red-build is what
  > entails **Phase 1a** (§0.4). Phase 0 was right to refuse the flip.
