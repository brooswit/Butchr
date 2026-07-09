# RFC: Front-end toward reusable components + consistency (story st-b1ca22e5)

> **Status: SIGNED OFF by the CTO (2026-07-08).** Option 0 approved; the P1–P4
> sequence approved; P5 (targeted re-render) deferred. The CTO explicitly
> validated that Option 0 requires **no CEO gate** — adopting no dependency and
> no build step does not depart from butchr identity, it *is* the ratified
> policy (CONTRIBUTING §4).
>
> **Phases landed since sign-off:**
> - **Phase 1 — shipped in 0.9.248.** `serveStatic` now 404s on a not-found path
>   that has a file extension (SPA fallback kept for extensionless routes);
>   `index.html` loads `app.js` as `<script type="module">`. **No front-end code
>   moved.**
> - **Phase 3 — shipped in 0.9.249.** `--space-1..6` added to `style.css`; all
>   **49** static inline styles removed from `app.js`. The **3** dynamic
>   width bars remain inline by design. Landed as explicit `.panel-title` /
>   `.lede` / `.tight` / `.stacked` / `.mono` / `.field-row` classes rather than
>   positional selectors (see §5, Phase 3).
> - **Phases 2 and 4 remain open. Phase 5 remains deferred.**
>
> Every claim below is grounded in the tree at `main` @ 0.9.246, cited
> `file:line`. Where the story brief and the code disagree, **the code wins and
> I say so explicitly** (§1.1).
>
> ⚠ **All `file:line` citations in this document were accurate at 0.9.246 and
> will drift** as later phases move code. They are provided as pointers, not
> anchors — **the counts and the claims are what matter**, and those have been
> re-grounded (see Errata).

---

## Errata (corrected 2026-07-08, post-Phase-3)

Three claims in the original text were **wrong** — two counts and one framing.
They were found by the Phase 3 build agent while implementing §3, and
independently verified against `main` by the story leader. They are corrected in
place throughout this document; the numbers you now read are the true ones.
**The conclusions and the Option 0 recommendation are unaffected** — only these
counts, and the framing of the `.field` decision, were wrong.

1. **Inline-style count: 38 → 52.** The original figure came from
   `grep 'style="'`, which is **blind to inline styles passed through `el()`'s
   attrs object** — `el("div", { style: "margin-top:18px" })`. There were **52**
   inline styles: 38 matching `style="` plus **14** matching `style: "`. Grep for
   **both** forms.
2. **Dynamic sites: 2 → 3**, so **static: 35 → 49.** The dynamic set is the two
   `swim-track` bars *and* `rollup-bar-fill`.
3. **The `.field` spacing decision had three values, not two.** The original text
   missed the base rule `label.field { margin-bottom: 12px }` in `style.css`
   (§1.3, §3).

**Why error 1 mattered, and not just for tidiness.** **Nine of the fourteen
hidden `el()` styles were `margin-top:18px`, and they were the *only* consumers
of `--space-6` in `app.js`.** Had Phase 3 trusted the RFC's own grep, it would
have minted `--space-6` and then left it with zero callers — **contradicting this
RFC's own "no dead tokens" acceptance criterion using this RFC's own
methodology.**

---

## 0. Executive summary

The brief asks whether butchr should adopt a component framework to fix a
front-end described as "ad-hoc inline styles" with no shared CSS. **Grounding
refutes that premise.** The styling layer is already good: a 1,312-line
`public/style.css` with a **50-token custom-property system** and full dark
theming, consumed by **280 `class="…"` sites** in `app.js` against only **52
inline styles** (49 of which are trivial margin nudges; 3 are legitimately
dynamic progress-bar widths). There are **no hardcoded colors** in `app.js`.

The real defects are different, and none of them is solved by a framework:

| # | Real defect | Evidence |
|---|---|---|
| D1 | `app.js` is **one 4,379-line classic script** — no modules, so no file boundaries exist to hang components on. `renderTask` alone is ~565 lines | `index.html:63` loads `<script src="/app.js">` (not `type="module"`) |
| D2 | **Two incompatible authoring models** that cannot compose: **14 helpers return HTML strings**, ~22 return **DOM nodes** | `kindBadge`→string (`app.js:287`) vs `metricCard`→`el()` (`app.js:3091`) |
| D3 | The string path makes escaping **opt-in**: **126 hand-written `esc()` calls** guard agent-authored text | 40 `.innerHTML =` + 16 `{html:}` = **56 raw-markup injection sites** |
| D4 | Tokens cover color/radius/font but **not spacing or typography scale** — which is exactly why the 52 inline styles exist | `:root` has `--radius-sm/md/lg` but no `--space-*` |
| D5 | SSE does a **wholesale re-render**; a bespoke `captureUiState`/`restoreUiState` hack exists solely to stop it eating scroll, focus, and half-typed text | `app.js:4262` → `refreshSoon()` → `mount()` clears `innerHTML` |
| D6 | **No `Button` component at all** — ~56 hand-built buttons, and *two rival* async-action-button implementations | `ctoPanel`'s local `btn()` (`app.js:562-570`) duplicates the generic `action()` (`app.js:645-655`) |

**Recommendation: adopt NO new tooling.** Take **Option 0 — "formalize what
already exists"**: split `app.js` into native ES modules (zero build, zero
dependencies), collapse D2 onto the *node-returning* model (which is
safe-by-default and kills D3 structurally), and finish the token set. This is
the only option on the spectrum that makes butchr **smaller** rather than
larger, and it is the only one that does **not** require a CEO identity call
(§4.1) — because it stays inside policy the CEO already ratified in
CONTRIBUTING §4.

---

## 1. Current-state assessment

### 1.1 Corrections to the brief (grounding beat the brief)

The brief is wrong on three counts. Recording them because the recommendation
turns on them:

1. **"whether any CSS file exists"** — it does: `public/style.css`, 65,768
   bytes / 1,312 lines, linked at `index.html:7`. It is not a stub; it carries
   a documented, LaunchPad-derived token system with light + dark themes
   (`style.css:10` `:root`, `style.css:87` `html[data-theme="dark"]`).
2. **"ad-hoc inline styles"** — inline styling is *marginal*, not dominant:
   280 `class="` vs **52 inline styles** (38 `style="` + 14 `style: "` inside
   `el()` attrs — see Errata), 1 `.style.` assignment, 1 `var(--` in JS, and
   **zero** hardcoded hex colors beyond three `#fff`. The style layer is
   already centralized.
3. **"patterns that beg to be components"** — many already *are* components,
   informally. There are ~29 proto-component helpers, and `openModal`
   (`app.js:613`) is **already shared by 6 modal call sites** (`app.js:664,
   1251, 3367, 3753, 3859, 4083`). The codebase is roughly half a component
   library already; it needs *formalizing*, not *building*.

So the honest framing is: **butchr does not need a design system built. It
needs the one it already has finished and made consistent.**

### 1.2 How the front-end is served

`src/server.ts:335-345` (`serveStatic`) streams files raw off disk with
`Bun.file()`; the fetch handler falls through to it at `src/server.ts:1307`
after `/mcp/` and `/api/`. `PUBLIC_DIR` = repo-root `public/`
(`src/server.ts:121`). **There is no build, bundle, transpile, or minify step
anywhere.** `package.json` has *no* `dependencies` and *no* `devDependencies`
key at all, and its only scripts are `start`, `start:supervised`, `dev`.

`scripts/ci` — the sole gate — runs `bun build src/index.ts --target bun
--outfile /dev/null` (a **backend** typecheck, output discarded), `bun test
./test`, and the changelog rule. **`public/` is never touched by the gate.**

### 1.3 What `app.js` actually looks like

4,379 lines, `"use strict"`, one classic script. DOM is built two ways:

- **`el(tag, attrs, children)`** (`app.js:~30`) — 250 call sites. Appends
  string children via `document.createTextNode`, i.e. **escaping is automatic**.
  Has an `html:` attr escape hatch (16 uses) that bypasses that safety.
- **Tagged template strings** returning markup — 14 helpers, plus 40
  `innerHTML` assignments. Escaping here is **manual**, via 126 `esc()` calls.

Views: `renderDashboard` (1013), `renderWorkspace` (1125), `renderSwimlanes`
(1697), `renderTimeline` (1811), `renderTranscriptPanel` (1930), `renderTask`
(2083), `renderDiff` (2805), `renderMetrics` (3141), `renderProjects` (3272),
`renderProjectDetail` (3658). Hash router at `render()` (`app.js:877`)
dispatches on `parseHash()`; `mount()` (`app.js:925`) does
`app.innerHTML = ""` then appends — **wholesale replacement**.

The D2 split, concretely:

```js
// STRING world — app.js:287
function kindBadge(k) {
  return `<span class="kind-badge kind-${esc(v.cls)}" …>${esc(v.glyph)} …</span>`;
}
// NODE world — app.js:3091
function metricCard(label, value, sub) {
  return el("div", { class: "metric-card" }, [ … ]);
}
```

A node cannot be interpolated into a template string, and a string cannot be
passed to `el()` as markup without `{html:}`. Every boundary between the two
worlds is an `innerHTML` or an `{html:}` — **56 such bridges**. The dominant
idiom is the hybrid: build a container with `el()`, blow in a template string
via `.innerHTML`, then `querySelector` + `addEventListener` to wire it (74
`addEventListener` vs 61 `querySelector`; true delegation used only 3×). **This
is the "consistency" problem the operator actually has**, and it is invisible
from a screenshot.

**The duplication this causes, concretely.** Because there is no component
boundary, the same concept gets re-implemented per site:

- **The CTO panel (`app.js:536`) and the CEO panel (`app.js:3557`) share zero
  code** — the same concept, twice.
- **Two independent "async action button"** implementations doing the identical
  disable → `try/catch` → toast → re-render dance: `ctoPanel`'s local `btn()`
  (`562-570`) and the generic `action()` (`645-655`).
- **Three progress-bar vocabularies** for one "percent bar": `swim-track` +
  `<i style="width:%">` (`1589`), a second `swim-track` string (`3267`), and
  `rollup-bar`/`rollup-bar-fill` (`3832`).
- **Ten parallel badge/chip helpers** (`kindBadge`, `responderChip`,
  `livenessChip`, `taskChips`, `tagChips`, `storyLifecycleChip`, `ciBadge`,
  `conformanceBadge`, `ceoPill`, `ceoStatusPill`) plus bespoke pill markup, over
  **ten class families** for one "colored status label" concept: `chip`,
  `count-pill`, `ws-bucket`, `cto-badge`, `ci-badge`, `conf-badge`,
  `kind-badge`, `stranded-kind`, `git-badge`, `disk-warn-badge`.
- **Same `field`, *three* paddings — not two.** There is a **base rule**,
  `label.field { margin-bottom: 12px }` (`style.css:954`), which the original
  draft of this RFC missed (see Errata). The real distribution is **5 bare sites
  inheriting 12px**, **6 inline at `margin-bottom:6px`**, and **2 inline at
  `margin-bottom:8px`**. Naively "standardizing on 6px" by rewriting the base
  rule would have **silently moved 5 sites from 12px to 6px** — an undocumented
  visual regression. And *three* ways to zero a heading margin:
  `style="margin-top:0"` (9×), `style="margin:0"` (`555`), and no inline style at
  all (`1003`, `3565`).

`collapsible()` (`app.js:378`) is the one genuinely reusable component in the
file — stateful, returns a handle `{panel, head, caret, setOpen}`. It is the
existence proof that this codebase can do components; it just never did it
twice.

### 1.4 The re-render tax (D5)

`app.js:4262`: every SSE message calls `refreshSoon()` → full `render()`. The
comment at `app.js:4278` concedes the cost and the workaround:

> "The SSE path does a FULL re-render (`mount()` clears `app.innerHTML`), which
> would otherwise discard the operator's scroll position, focus, and any text
> typed into a not-yet-submitted input…"

`captureUiState()`/`restoreUiState()` exist purely to paper over this, keyed by
`data-restore-key`, and are load-bearing enough to have their own test
(`test/app-restore-uistate.test.ts`). This is the one defect where a real
component/VDOM model would *structurally* help. It is also the one the operator
never complained about — the hack works. **Do not lead with it** (§5, Phase 5).

---

## 2. (A) Component approach / tooling — the crux

Weighed against butchr identity: **CONTRIBUTING §4 is a hard constraint** —
"butchr ships with zero npm/runtime dependencies, and that is a hard
constraint… Do not add an npm dependency without explicit approval from the
CTO." Plus [[revamp-plan-debt-paydown]]: "the next move is NOT more hardening —
it's DELETION. Goal: make butchr SMALLER."

| Option | Deps | Build step | Ergonomics | Fit with identity |
|---|---|---|---|---|
| **0. Formalize what exists** (ES modules + `el()` + finish tokens) | **0** | **none** | Good. `el()` already ergonomic, already 250 uses. No new concepts to learn. | **Best.** Net *deletes* code (130 `esc()`, 12 string helpers). Nothing to approve. |
| 1. Native Web Components | 0 | none | Poor. Verbose boilerplate (`class extends HTMLElement`, `connectedCallback`). Shadow DOM would sever the `class=`→`style.css` cascade that 287 sites rely on; light DOM keeps it but then encapsulation buys ~nothing. | Neutral deps, but a **large rewrite for no styling gain**. |
| 2. Preact + htm (no-build) | 2 (vendored) | none | Good. Real components, hooks, diffing (fixes D5). But `htm` tagged templates **re-introduce string authoring** — the exact D2 defect, now with a VDOM. | Violates zero-dep; needs vendoring into `public/`; **grows** the tree. |
| 3. Framework + bundler (Preact/React/Svelte/Solid + Vite/`bun build`) | many | **yes** | Best ergonomics, best D5 fix. | **Worst fit.** Adds `node_modules`, a build step, a `public/` artifact the gate must build and `serveStatic` must serve. Directly contradicts "smaller", "local-first", "zero build". |

**Recommendation: Option 0.**

The argument is not "frameworks are bad." It is that **every defect the operator
can actually feel (D1–D4) is fixed by Option 0 at negative code cost**, and the
only defect a framework uniquely fixes (D5) is already mitigated and unremarked.
Options 2 and 3 pay a permanent identity cost — a dependency, a build, a
supply-chain surface, a `node_modules` — to fix a problem nobody reported.

Option 0 also has a property the others lack: **it is reversible and
incremental by construction.** Splitting into ES modules and unifying on `el()`
leaves the app a plain static SPA at every commit. If, two phases in, D5 starts
hurting, Option 2 remains fully open — and it is *easier* from a modularized
tree than from today's 4,401-line script. **Option 0 is a strict prerequisite
for Options 1–3 anyway.** It is not a fork in the road; it is the road.

### 2.1 Why `el()` and not strings

Unify on the **node-returning** model. Three reasons, in order:

1. **Safety, structurally.** `el()` appends string children as
   `createTextNode` — escaping is automatic. Converting the 12 string helpers
   deletes the *category* of D3, not just instances: the 130 `esc()` calls go
   away because escaping stops being the author's job.
2. **It already won.** 250 `el()` sites vs 12 string helpers. Follow the
   grain.
3. **It composes.** Nodes nest into nodes. Strings do not nest into nodes
   without `innerHTML`.

Cost: `el()` is clumsier than markup for deep static trees. Mitigation: that is
precisely what a component library (§3) is for — write the tree once, call it
by name.

---

## 3. (B) Design-system layer

**Tokens — extend, don't replace.** `style.css:10` already defines color
(`--bg --panel --text --accent`, 12 canonical status colors, kind colors,
lifecycle colors, diff/syntax colors), radius (`--radius-sm/md/lg`), and
families (`--font --mono`). **Missing: a spacing scale and a type scale.** Add:

```css
--space-1: 4px;  --space-2: 6px;  --space-3: 8px;
--space-4: 10px; --space-5: 12px; --space-6: 18px;
```

These six values are not invented — they are the *observed* margins in the 52
inline styles (`4px 6px 8px 10px 12px 18px`, from `grep -oE '[0-9]+px'`).
Introducing them lets all 49 non-dynamic inline styles become classes and
**deletes the inline-style category** (the 3 progress-bar `width:${pct}%` sites
must stay inline — they are genuinely dynamic, and that is correct).

⚠ **Grep both forms when enumerating these.** `grep 'style="'` misses the 14
styles passed through `el()`'s attrs object (`style: "…"`). Nine of those are
`margin-top:18px` and are the **only** consumers of `--space-6` — miss them and
the token lands dead. See Errata.

**`.field` — keep the 12px base, add a modifier.** Do *not* rewrite the base rule
to 6px: 5 sites rely on the 12px inherited default (§1.3). The correct shape is
`label.field { margin-bottom: var(--space-5) }` (12px, unchanged) plus a
`label.field.tight { margin-bottom: var(--space-2) }` (6px) applied to the 8-site
tight cohort. **The only intended visual delta is the two Add-workspace fields
tightening from 8px to 6px.** (This is what shipped in 0.9.249.)

**Component library.** Formalize the ~29 existing helpers into a named set with
one uniform signature (`(props) => HTMLElement`):

- *Already exist, need normalizing:* `Modal` (`openModal:613`), `Chip`
  (`responderChip:221`, `livenessChip:347`, `storyLifecycleChip:1479`,
  `tagChips:335`), `Badge` (`kindBadge:287`, `ciBadge:1738`,
  `conformanceBadge:1782`), `Card` (`dirCard:1064`, `metricCard:3091`,
  `buildCeoCard:3557`), `Panel` (`listPanel:2047`, `rollupPanel:2060`,
  `needsUserInputPanel:490`, `reposPanel:3975`, `initiativesPanel:3782`),
  `Pill` (`ceoPill:3237`, `ceoStatusPill:3496`).
- *The one real component:* `collapsible` (`app.js:378`) — stateful, returns a
  handle. Use its shape as the template for all the others.
- *Genuinely missing:* `Button` — there is **no button helper at all** (D6).
  ~56 hand-built buttons (`el("button"` 34× + `<button` in strings 22×) lean
  directly on `.btn` CSS classes, with variants `btn ghost` (13×), `btn` (12×),
  `btn success` (7×), `btn ghost xs` (4×), `btn danger` (4×) — plus one site
  with a stray trailing space, `"btn "`. This is the highest-yield single
  extraction in the whole plan.

Note the ratio: **five of the six components already have 2–4 competing
implementations.** Consolidating them is a deletion exercise. That is the whole
thesis in miniature.

**✅ Coordination (RESOLVED 2026-07-08):** the dead-code sweep (st-ef0e7690) and the
launch-row reorder (st-deb5ecce) have BOTH landed on `main` (verified in code, not just
by merge flag). `pulseMarkup` and `termLinkMarkup` are gone. `app.js` is now 4,379 lines
with 14 string-returning helpers and 126 `esc()` calls. **The Phase 2 same-file conflict
risk is cleared.**

---

## 4. (C) Build / serve story

**No build step is adopted.** Confirming the zero-build path works end-to-end:

`serveStatic` (`src/server.ts:335`) resolves any `public/`-relative path off
disk. Switching `index.html:63` to `<script type="module" src="/app.js">` makes
native ES `import`/`export` work with **no build, no importmap, no bundler** —
Bun already serves `.js` as `text/javascript;charset=utf-8` (verified live).
`scripts/ci` needs **no change**: it never touched `public/`, and it will
continue not to.

**⚠ One concrete prerequisite (proven, not theoretical).** `serveStatic`'s SPA
fallback (`src/server.ts:342-343`) returns `index.html` for *any* path missing
on disk. Verified against the running server:

```
GET /app.js         -> 200 text/javascript;charset=utf-8
GET /views/typo.js  -> 200 text/html;charset=utf-8   ← should be 404
GET /style.css      -> 200 text/css;charset=utf-8
```

Under a classic script this is harmless. Under `type="module"`, a mistyped
import path yields a 200 `text/html` response, and the browser reports *"Expected
a JavaScript module script but the server responded with a MIME type of
text/html"* — a confusing error that points nowhere near the typo. **Phase 1
must first make `serveStatic` 404 on a not-found path that has a file
extension**, keeping the SPA fallback only for extensionless (route) paths.
This is a ~3-line change and is the single riskiest thing in the whole plan.

**If a build step were ever adopted** (Options 2/3 — not recommended): `scripts/ci`
would need a frontend build + the built artifact would have to be either
committed (ugly, churns diffs) or built at boot (slows `bun run`, adds a failure
mode to a supervised systemd service). `serveStatic` would serve `public/dist/`
instead of `public/`. Both are real costs; neither is paid under Option 0.

---

## 5. (D) Migration strategy — incremental, working surface at every step

Big-bang is rejected outright: the operator steers butchr *by using the
dashboard*, so a dark period is unacceptable. Every phase below leaves the app
fully working and is independently shippable and revertible. Ordering is by
**dependency, then by risk-adjusted payoff.**

- **Phase 1 — Make modules possible.** *(Shipped 0.9.248.)* Fix `serveStatic` to
  404 on extensioned misses (§4); flip `index.html` to `type="module"`. **No move
  of code yet.** Ships alone, provably inert. *This is the only phase with a
  server-side change.*
- **Phase 2 — Split by seam, not by size.** Extract in dependency order:
  `tokens/esc/el` + `api.js` (fetch wrappers) → `components/` → `views/`
  (one module per `render*` view). One view per commit. `app.js` becomes a thin
  entry that imports and registers routes. Each commit: UI byte-identical.
- **Phase 3 — Finish the tokens.** *(Shipped 0.9.249.)* Add `--space-*` + type
  scale to `style.css`; convert the 49 static inline styles to classes. Leaves
  the 3 dynamic width sites alone. Pure CSS + markup; no logic touched.
  Two rules emerged while building, and hold for Phase 4:
  - **A spacing token needs a *cohort* of callers.** Single-caller values stay
    literal inside a named component rule rather than minting a token for one
    consumer each — `padding:14px` (a modal's empty-list row) and
    `margin-top:32px` (the workspace danger zone) did **not** become
    `--space-7`/`--space-8`.
  - **Do NOT use positional selectors** (`:first-child`, `:first-of-type`) for
    component styling. They encode "happens to be first" as a contract, and
    **Phases 2 and 4 move nodes** — they would break silently, and there is
    **zero front-end test coverage** to catch it. Use explicit classes
    (`.panel-title`, `.lede`, `.tight`, `.stacked`, `.mono`, `.field-row`).
- **Phase 4 — Unify on nodes, one component at a time.** Convert the 12
  string helpers to `(props) => HTMLElement`, innermost-first (Badge, Chip,
  Pill → Button → Card, Panel → Modal). Each conversion deletes its `esc()`
  calls and its `innerHTML`/`{html:}` bridge. **Convert a component only when
  every one of its call sites is converted** — mixed states are where bugs
  hide. Introduce the missing `Button`. Target end-state: `esc()` and `html:`
  have **zero** callers and are deleted.
- **Phase 5 — (OPTIONAL, defer) targeted re-render.** Only if D5 hurts after
  Phases 1–4. Revisit `captureUiState` and consider keyed patching. **Do not
  schedule this now**; re-evaluate with evidence.

**Sequencing rule:** Phases 1→2 are strictly ordered. Phase 3 is independent of
2 and 4 and can land any time after 1 (it is CSS-only). Phase 4 requires 2.

### 5.1 Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Module-path typo → confusing MIME error | High, if Phase 1 skipped | Phase 1's `serveStatic` 404 fix, first, alone |
| `type="module"` is deferred + strict-mode; top-level code that relied on classic-script timing breaks | Medium | Phase 1 flips the flag with **no code moved**, so any breakage is isolated and trivially revertible |
| Mixed string/node state during Phase 4 ships a visual regression | Medium | Convert per-component, all call sites in one commit; UI must be byte-identical |
| Losing `captureUiState` behavior during the split | Low | It is test-covered (`test/app-restore-uistate.test.ts`); keep the test green through Phase 2 |
| No FE test coverage to catch regressions | **High — real gap** | The gate never runs `public/`. Phases 2/4 rely on human review + the few `test-extract:` harnesses. **Flagging: consider a smoke test, but that is scope beyond this RFC.** |
| **Merge conflict with in-flight FE stories.** Phase 2 moves nearly every line of `app.js`; st-ef0e7690 (deletes FE helpers) and st-deb5ecce (reorders `renderWorkspace`) both touch it now | **High** | **Sequence Phase 2 AFTER both land.** A wholesale file split cannot be rebased over a concurrent edit to the same file without hand-resolution. This is a scheduling constraint, not a code one. |
| Scope creep into a framework mid-migration | Medium | Option 0 is a prerequisite for 1–3; nothing is foreclosed. Re-decide at Phase 5 with data. |

---

## 6. Decisions requested

1. **CTO — approve Option 0** (formalize; no framework, no build, no deps) and
   the Phase 1–4 sequence, deferring Phase 5.
2. **CTO — confirm the (A) tooling call does NOT need a CEO gate under Option
   0.** My reading: adopting *no* dependency and *no* build step changes
   nothing about butchr's identity; it is already the ratified policy
   (CONTRIBUTING §4, CEO-authored). A CEO decision is required only to
   **depart** from it (Options 2/3). If the CTO disagrees, the CEO is away —
   escalate rather than block, and I will hold.
3. **CTO — note the brief's three factual errors (§1.1)** so the story's
   framing is corrected of record before any build subtask is written.

Only after sign-off: author this document as a committed doc via a subtask
(dir-8b35f904 rules — CHANGELOG entry, patch bump), then decompose Phases 1–4.
Nothing touches `app.js` until then.
