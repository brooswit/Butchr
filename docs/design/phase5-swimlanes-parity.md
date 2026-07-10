# Phase 5b — Swimlanes visual parity (React vs `p3-rollback-boundary`)

STATUS: **SETTLED.** One regression found and fixed; everything else matches or differs deliberately.

Reference: git tag `p3-rollback-boundary` (4d10906, v0.9.281) — the last commit where every view was
still vanilla inside the React shell. Compared against `main` @ 0.9.289 (100% React/TS, 30 modules
under `public/`, zero `.js`).

## Verdict

The React swimlanes are a **faithful port**. Across both themes, at a fixed 1440×1200 viewport, over
five lanes and nine subtask cards, the structural extract showed **zero differences** in step order,
step contents, card padding/border/radius/background/box-shadow/opacity, chip classes, chip
foreground and background colours, connector SVG markup, the done-pile row's dashed border and
padding, the lane container's border and radius, the legend, and the caption.

**One genuine regression** — the lane header wrapped to two rows — was found and **fixed in this
task** (`public/style.css`). It was not introduced by the React port itself: it was introduced by the
`Open Leader terminal` button that landed in **0.9.282**, one version *after* the reference tag, and
so no prior comparison could have caught it.

## Method, and one deliberate deviation

Both builds were built with `bun install --frozen-lockfile && bun run build:fe` (the tag's `build:fe`
is byte-identical to `main`'s) and served on two ports, then driven in headless Chrome at a fixed
1440×1200 viewport, in both themes, at `#/` and `#/workspace/ws-1`.

**Deviation from the brief.** The brief asked for one seeded scratch *database* behind the real
server. I served both builds from a **stub API** pinned to one frozen fixture instead. Booting
`src/index.ts` runs `pruneTempWorkspaces()` (which DELETE-cascades any workspace under the OS temp
dir — i.e. exactly the scratch workspace this task would create) and `reconcileWorkspaceAgents()`,
which adopts and tears down **herdr panes**, and herdr panes are global to the host. `BUTCHR_PORT`
and `BUTCHR_DB` isolate the HTTP port and the database; they do **not** isolate herdr. Running it
would have risked the live butchr's agents, which the brief forbids. The stub serves the real
`STATE_META` (dumped once with `BUTCHR_DB` pointed at a scratch file) and the identical fixture to
both builds, so any difference observed is the renderer's, not the data's.

The fixture covers the mix the brief asked for: a story with six active leaves in different statuses
(`in_progress`, `idle`, `needs_user_input`, `in_review`, `needs_info`, `blocked`) plus three finished
ones behind the done-pile; a childless parked story; a stalled story (leader desired, not running,
with a `lastError`) holding two blocked leaves, one with a cross-lane blocker; a
decomposed-but-all-finished parked story; an ungrouped orphan leaf; a merged leaf; a failed leaf; a
running CTO panel; and an idle agent.

`#/` is **not** the swimlanes route. In both builds it `Navigate`s to `/projects`. The pipeline
swimlanes live at `#/workspace/:id`. Both routes were captured; the comparison below is the workspace
route.

## The five pure functions are still driving the render

Not merely present with green tests — each was confirmed to be *called for the same decision*, by
reading `swimlanes.tsx` and then by observing the decision it made in the live DOM.

| function | called from `swimlanes.tsx` | decision it drives | runtime evidence | verdict |
|---|---|---|---|---|
| `storyLifecycle` | `StoryLifecycleChip` (L73); `hasLifecycle` gate (L237) | whether the lane gets a lifecycle chip, and which | three distinct chips rendered — `lc-working`, `lc-parked`, `lc-stalled` — matching the leader/counts of each lane | **DRIVING** |
| `storyProgress` | `SwimLane` (L228) | progress text + bar fill width | `2 / 6 done` → `width: 33%`; `0 / 2 done` → `0%`; `2 / 2 done` → `100%`; `not started` when total is 0 | **DRIVING** |
| `orderLaneLeaves` | `SwimPipe` (L144), for both the active and the done pipes | left→right step order within a lane | `lf-a3 → lf-a4 → lf-a9 → lf-a5 → lf-a7 → lf-a6` — longest-blocked_by-chain order, identical to the reference | **DRIVING** |
| `swimEmphasis` | `SwimStep` (L105) | which card is loud (`is-attn` / `is-active` / `is-blocked` / `is-done`) | all four buckets observed; `needs_info` and `needs_user_input` both → `is-attn`; `in_review` → `is-done` | **DRIVING** |
| `laneTitle` | `SwimLane` (L230) | the clamped one-line lane title | a 233-char brief rendered clamped to 70 chars with a single `…`, full brief in the `title` tooltip | **DRIVING** |
| `leaderTerminalBtnState` | `LeaderTerminalBtn` (L172) | button enabled state + honest tooltip | all four branches observed (see below) | **DRIVING** |

All 28 unit tests across `test/swimlane-order.test.ts`, `test/swimlane-leader-terminal-btn.test.ts`
and `test/story-lifecycle-ui.test.ts` pass.

## Visual comparison

| aspect | verdict | notes |
|---|---|---|
| lane order (`orderLaneLeaves`) | **MATCHES** | identical step sequence in all five lanes, both themes |
| lane titles (`laneTitle`) | **MATCHES** | same clamp, same `…`, same `title` tooltip carrying the full brief |
| story lifecycle chip (`storyLifecycle`) | **MATCHES** | same class, same glyph+label text, same `title`, same computed colours |
| progress text (`storyProgress`) | **MATCHES** | same strings including the `not started` branch |
| progress bar geometry | **MATCHES** | track 96×6px, `border-radius: 3px`; fill boxes identical to the sub-pixel (`31.671875px` in both) |
| emphasis (`swimEmphasis`) | **MATCHES** | same `is-*` class on every card |
| chip colours per status | **MATCHES** | every `.chip.<status>` foreground/background identical in light *and* dark |
| card padding and borders | **MATCHES** | padding, border, radius, background, box-shadow, opacity all identical on all nine cards |
| connector arrows | **MATCHES** | inline JSX `<svg>` emits markup byte-identical to the vanilla `svg()` helper's |
| done-pile row | **MATCHES** | same `▸ N done` text, `role=button`, `tabindex=0`, `aria-expanded`, dashed top border, padding, colour |
| empty states | **MATCHES** | both the childless and the all-finished wording, and the shared `lc-parked` chip |
| legend + caption | **MATCHES** | identical text and swatch classes |
| **lane header height** | **REGRESSION — FIXED** | see below |
| "Open Leader terminal" button + disabled state + tooltip | **DIFFERS — new feature, no baseline** | see below |
| crumb separators | **DIFFERS-DELIBERATELY** | see below |
| "Unregister workspace" button border | **DIFFERS-DELIBERATELY** | see below |

### REGRESSION (fixed): the lane header wrapped to two rows

On `main` before this fix, lane headers whose title reached its width cap pushed `.swim-meta` (the
status chip, lifecycle chip, leader-terminal button and progress bar) onto a **second row**. Headers
measured **86px** on those lanes against **50px** on the reference — and, worse, **51px** on the
*sibling* lanes whose titles were shorter, so the pipeline showed ragged, inconsistent header heights
down the page. Total pipeline height grew 1063px → 1138px.

Cause: `.swim-hd` is `flex-wrap: wrap`, and a wrapping flex container breaks lines on each item's
**hypothetical main size** — its flex-basis clamped by `max-width`, computed *before* any shrinking.
`.swim-title` sat at its `min(52ch, 60vw)` = 519px cap, so the header's items totalled 1120px against
1026px of content box and `.swim-meta` broke to line two. The title's `overflow: hidden` ellipsis
never got a chance to absorb the overflow, because shrinking happens only *after* line-breaking.

This is a real regression against the reference, but the React port did not cause it: the button that
tipped the header over its budget was added in **0.9.282**, one commit *after* `p3-rollback-boundary`.
The vanilla lane header never carried it, so it never overflowed. `leaderTerminalBtnState` does not
exist at the tag at all.

Fixed in `public/style.css` by capping `.swim-title` at `min(42ch, 44vw)`, pinning `.swim-laneid` to
`flex: none`, and setting `.swim-meta` to `flex-wrap: nowrap` so the meta cluster can never fold in
half (chips over progress bar). After the fix every header is 50–51px and none wraps; total pipeline
height is 1069px against the reference's 1063px, the 6px being four lanes × the button's ~1px
line-height contribution. `flex-wrap: wrap` stays on `.swim-hd` as the genuine small-screen valve.

### The "Open Leader terminal" button has no parity baseline

`leaderTerminalBtnState` is **absent from the tag** — `public/views/swimlanes-logic.js` at
`p3-rollback-boundary` does not export it, and `public/views/swimlanes.js` does not render any leader
control. It was added in **0.9.282** ("Added — *Open Leader terminal on a story lane*"), dropped by
the abandoned Phase-4 branch, and restored in a later entry. So there is nothing at the tag to compare
it against; it cannot be a port regression.

Its behaviour on `main` is correct. All four branches of the pure gate were observed live:

| lane | `leader` | rendered |
|---|---|---|
| `st-alpha` | `running` | **enabled**, "Attach a terminal to the live leader agent" |
| `st-gamma` | `desired`, not running, `lastError` | disabled, "…no live pane (starting, or it crashed) — last error: herdr pane exited: code 1" |
| `st-delta` | `desired`, not running, no `lastError` | disabled, "Leader agent is starting… — no live pane to attach yet" |
| `st-beta` | neither | disabled, "Leader agent isn't running — torn down or never launched" |

The tooltip sits on the wrapper `<span title>`, not the `<button>` — deliberate, and documented in
`LeaderTerminalBtn`: LaunchPad's `ButtonProps` has no `title`, and browsers suppress hover events on a
disabled `<button>`, so the hint that matters most (the disabled one) would otherwise never appear.
Verified: `wrapperTitle` is populated, `btnTitle` is `null`, `disabled` is the expected boolean.

### Crumb separators — DIFFERS-DELIBERATELY

The reference builds crumbs as a `<div class="crumbs">` with literal `" / "` **text nodes** between
anchors. `main` renders LaunchPad `Breadcrumbs` — an `<ol>` of `<li>` with a 24×24 `data-icon="slash"`
`<svg><use href="#lp-icon-slash">` separator and **zero** text separators. Same font size (13px), same
two separators, same link targets.

The icons genuinely **render** — this was checked against RFC §4.3's silent-failure mode, where an
un-inlined sprite leaves every icon blank at full layout size, which a bounding-box check alone would
not catch. The sprite is inlined (`scripts/assert-fe-artifact` reports 337 symbols spliced, 378
`--lp-*` tokens, minified production bundle) and a cropped screenshot of the crumb bar shows the slash
glyphs. Keep.

### "Unregister workspace" button border — DIFFERS-DELIBERATELY

Reference: `<button class="btn ghost">` with `border: 1px solid var(--border)`. `main`: LaunchPad
`Button` in its `minimal` variant, `border: 0px none`. This is the RFC §7.1 Button adoption doing what
it says — butchr's `ghost` maps onto LaunchPad's `minimal`, which is borderless by design. Outside the
swimlanes proper, but inside `#/workspace/:id`, so recorded here. Keep.

## Non-differences worth stating

- **`fillInline` string formatting.** The reference emits `style="width:33%"`; React emits
  `style="width: 33%;"`. The *computed* box is identical to the sub-pixel. Cosmetic; not a difference.
- **`.swim-meta` child list.** `main` has two extra children — a text-node space and
  `<span.swim-leader-btn>`. That is the 0.9.282 button, not drift.

## Noted, out of scope, NOT a regression

- **The progress-bar fill is `--merged` = `rgb(0, 105, 51)` in *both* themes.** Against the dark
  track (`rgb(63, 69, 76)`) that is a low-contrast dark green. It is **identical in the reference**,
  so it is pre-existing and not this migration's doing — but it is the one genuinely weak spot the
  side-by-side surfaced. Worth a follow-up: give `--merged` a dark-theme lift.
- **Stale comment.** `public/views/swimlanes-logic.ts` (L11, L14) still says the node emitter and the
  `leaderTerminalBtnState` caller live in `views/swimlanes.js`. That file no longer exists; both moved
  to `swimlanes.tsx`. Comment-only; left alone to keep this diff reviewable.

## NOT INVESTIGATED

- Viewports other than 1440×1200 (the fix's `44vw` clamp is viewport-relative; `flex-wrap: wrap`
  remains the small-screen valve, but no narrow-viewport screenshot was taken).
- The done-pile in its **expanded** state, and the `swim-done-pipe` dimmed styling.
- `prefers-reduced-motion` gating of the `in_progress` pulsing dot.
- Hover and focus-ring styling on `.swim-step` (the brief flags a real focus ring as a likely
  deliberate LaunchPad improvement; not exercised).
- The `#/task/:id` detail route the step cards link to.
