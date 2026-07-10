# RFC Phase 5c — the spike's remaining open questions

Status of each item is one of **SETTLED** (driven and observed) or **NOT INVESTIGATED**.
Nothing here is marked settled on the strength of reading the source alone.

## 1. `bun run dev` drops the icon sprite — FIX

**SETTLED.** The bug is real, and the fix as originally salvaged did not work.

The bug. `dev:fe` is `bun build public/index.html --outdir dist --watch`. Every rebuild regenerates
`dist/index.html` from `public/index.html`, which does not contain the sprite — `build:fe` splices it
in *after* the build. Measured, with `dev:sprite` not running: a one-character edit to
`public/style.css` takes `dist/index.html` from 217,613 bytes / 337 `<symbol>`s to 3,171 bytes / 0.
The page still boots, `bun build` still exits 0, and every icon is a blank 20×20 box. `assert:fe`
would catch it and `assert:fe` does not run in dev.

**The salvaged fix was inert, and it failed silently — the same class of bug, one layer up.** Wiring
`dev:sprite` into `dev` is necessary but not sufficient: `scripts/inline-sprite --watch` watched
`dirname(htmlPath)`, and a bun directory watcher does not report `index.html` when `bun build --watch`
is the writer. Probed directly, watching `dist/` and `dist/index.html` simultaneously across a
rebuild:

```
DIR  event=rename name="index-qe8xt6gg.js"   matches=false
DIR  event=change name="index-qe8xt6gg.js"   matches=false
FILE event=change name="index.html"                          <- only the FILE watch sees it
DIR  event=rename name="index-vymdyz5z.css"  matches=false
DIR  event=change name="index-vymdyz5z.css"  matches=false
```

The directory watch fires for the newly content-hashed siblings and never for `index.html` (which bun
overwrites in place). It *does* fire for a shell `>>` or `mv` — which is why this survived casual
testing. So `dev:sprite` printed `inline-sprite: watching dist/index.html` and re-spliced nothing;
with it running, the sprite still went to 0 symbols on every rebuild.

Three defects fixed in `scripts/inline-sprite`:

1. **Watch the file, not the directory.** The directory watch is kept only to re-arm the file watch
   (a file watch is bound to an inode; bun overwrites in place today, but `mv` would not) and to
   cover `dist/index.html` not existing yet at startup.
2. **Serialize the read-then-write.** `inline()` reads, then writes. Rebuilds arrive in bursts, so
   two overlapping runs can interleave `read(A) read(B) write(B) write(A)` and A's write — made from
   the older bytes — wins. Every request is now chained onto one promise.
3. **Refuse to splice into a truncated document.** In watch mode we read a file another process is
   actively rewriting. A partial read that still contains `<body>` would be spliced and written back,
   clobbering the real build with a half-document that still parses and still boots. `</html>` is the
   last thing bun emits; without it, `inline()` returns `incomplete` and waits for the next event.

**Answering the question asked** ("does it re-inline after each rebuild, or can it read a half-written
`index.html`?"): with the fix, it re-inlines after each rebuild and never observed a partial splice.
The stress procedure — a clean `build:fe`, both watchers backgrounded, then one slow edit, ten
`style.css` edits 150 ms apart, and six `App.tsx` edits 200 ms apart — held `dist/index.html` at
337 symbols / 217,613 bytes / one `</html>` / exactly one sprite `<svg>` throughout, with an empty
`inline-sprite` stderr. Idempotency holds: the sprite is never doubled, and `inline-sprite`'s own
write does not re-trigger a splice. `bun run assert:fe dist` passes on the result. Icons were then
confirmed to actually *render* in headless Chrome — see item 2, which reports 337 sprite symbols and
a non-zero painted box for every `<use>`.

Residual risk: the truncation guard is a heuristic on `</html>`, not a filesystem-level atomic read.
Bun writes `index.html` in one `write(2)` at its current 3 KB size, so no partial read was ever
actually observed; the guard exists because that is a property of the file's size, not a guarantee.

## 2. Dark mode at runtime (spike UNVERIFIED #13)

**SETTLED.** Dark mode works. The `--lp-*` values genuinely re-resolve; they do not merely inherit.

Method: production `build:fe`, `assert:fe` green, served by the real server on port 47911 against a
scratch DB and a scratch repo, driven over CDP in headless Chrome. `localStorage['butchr-theme']` is
seeded and then the document is **reloaded** — a `/` → `/#/projects` navigation is a hash change, the
same document, so the inline no-flash `<head>` script never re-runs and the attribute keeps its old
value. (That mistake made a first pass report `theme: light` for the dark run. Anyone re-running this
must force a real document load.)

All five routes painted in both themes: `/projects`, `/projects/:id`,
`/projects/:id/workspaces/:id`, `/task/:id`, `/metrics`. `document.body` background went
`rgb(255,255,255)` → `rgb(24,26,31)`.

**Re-resolution, not inheritance.** The distinction is decided by reading a semantic token and the
primitive it points at, on `:root`, in both themes:

| token | light | dark | |
|---|---|---|---|
| `--lp-color-bg-ui-primary` | `#fff` | `#181a1f` | re-resolves |
| `--lp-color-bg-ui-secondary` | `#f7f9fb` | `#23252a` | re-resolves |
| `--lp-color-text-ui-primary-base` | `#23252a` | `#f7f9fb` | re-resolves |
| `--lp-color-border-ui-primary` | `#d8dde3` | `#3f454c` | re-resolves |
| `--lp-color-gray-950` | `#181a1f` | `#181a1f` | unchanged (primitive) |
| `--lp-color-white-950` | `#fff` | `#fff` | unchanged (primitive) |
| `--text` (butchr's own) | `#23252a` | `#f7f9fb` | re-resolves |

The primitives are identical across themes while the semantic tokens that `var()` them invert. That is
only possible if the semantic layer is re-declared under `[data-theme=dark]` and re-resolved — an
inherited value could not change while its source did not. 73 `--lp-*` tokens are redefined in the
dark block of the built CSS, all of them also defined on `:root`.

**Icons stay visible.** In both themes, on every route, every `<use>` resolved to a symbol that exists
in the document (`document.getElementById(href)`) and its owning `<svg>` had a non-zero box: 2/2/2,
2/2/2, 4/4/4, 2/2/2, 2/2/2 for uses/with-box/resolved, against 337 sprite symbols. That is the check
the blank-icon failure mode actually requires — presence of the string `lp-icon` proves nothing.

**No flash of the wrong theme.** With `butchr-theme=dark` and a cold document load,
`document.documentElement.dataset.theme` already reads `dark` at the first `readystatechange`, i.e.
before the document finished parsing. The mechanism is structural and worth stating: the theme script
is inline and synchronous in `<head>`, and the bundle is `<script type=module>`, which is deferred by
definition. The attribute therefore always precedes first paint. Zero console errors or warnings in
either theme, on any route.

Not covered: the runtime theme *toggle* (this drove the persisted-preference path on load, not a
click), and `prefers-color-scheme` — butchr does not consult it.

## 3. Real bundle size and `--splitting` (spike UNVERIFIED #11)

**SETTLED (measured). Recommendation: do not adopt `--splitting`.**

Production build, whole app in React, bun 1.3.x:

| asset | raw | gzip |
|---|---|---|
| `index-*.js` | 542,985 B (0.52 MB) | 170,234 B |
| `index-*.css` | 149,748 B | 21,140 B |
| `index.html` (sprite inlined) | 217,613 B | 50,759 B |
| `InterVariable-*.woff2` | 352,240 B | (already compressed) |
| total, excluding sourcemap | 1,266,682 B | ≈ 242 KB + font |

`index-*.js.map` is 2,955,970 B and is `--sourcemap=linked`, so a browser only fetches it with
devtools open.

The spike's 0.46 MB was a floor for five components. The real, whole-app number is **0.52 MB** — only
about 13% above it. React and `@launchpad-ui` dominate; butchr's own 30 modules are noise against them.

`--splitting` is a **no-op here**, measured, not assumed: `bun build --production --splitting` emits a
single 542,895 B chunk (90 B smaller — chunk-boundary bookkeeping) and gzips to 170,157 B. There is
one entry point and `public/` contains no dynamic `import()` at all, so there is nothing to split out.
`--splitting` only pays once routes are lazily imported.

If bundle size is ever worth attacking, the ranked targets are not the JS:

1. **The 214 KB inlined sprite** — 337 symbols, of which the app references a handful. It is
   `index.html`'s entire weight, and being inlined it is re-parsed on every cold load and cannot be
   cached separately. Emitting only the used symbols is the single largest available win. It must stay
   *document-local* (`<use href="#lp-icon-…">`), so this means subsetting the sprite, not externalising
   it — an external `<use href="/sprite.svg#…">` reintroduces the blank-icon failure under
   `serveStatic`'s SPA fallback.
2. **The 352 KB variable font**, if a subset or a system-font stack is ever acceptable.
3. Route-level `import()` + `--splitting`, which only becomes worthwhile after (1).

## 4. The two upstream-undefined tokens (RFC §5.4)

**SETTLED. Confirmed undefined; they do NOT render wrong; no workaround needed today.**

The RFC is right about the facts. In the built CSS each token has **0 definitions and exactly 1 usage**,
and neither is defined anywhere in `@launchpad-ui/tokens@0.16.0`. Both usages are bare `color:`
declarations with no fallback:

```css
.JvJGqa_item [slot=description] { …; color: var(--lp-color-text-ui-secondary-base); … }
.zmmx8W_header                  { …; color: var(--lp-color-text-ui-tertiary); … }
```

Read on `:root` in the live page, both are empty in **both** themes.

What actually happens is benign, and it is why nothing looks broken. `color: var(--undefined)` is
*invalid at computed-value time*; `color` is an inherited property, so it computes to `inherit` rather
than to `unset`/`initial` (which would be black, and would be a real dark-mode bug). Measured directly:
against a parent with `color: rgb(1,2,3)`, both the `[slot=description]` element and the
`.zmmx8W_header` element compute to exactly `rgb(1, 2, 3)`. They take the parent's colour.

So the failure mode is a lost *de-emphasis*, not unreadable or invisible text: a description would
render at the item label's colour instead of a dimmer secondary, and a section header at its
container's colour instead of tertiary. Contrast against the background is whatever the parent had, so
there is no accessibility regression in either theme.

**Impact on butchr today is zero.** `grep` over `public/` finds no `slot="description"` and no
`<Header>`; the one `ListBoxItem` (`components/overlay.tsx:216`, the directory picker) passes
`textValue` and a `className`, never a description slot. Both rules are dead CSS in our bundle.

No workaround is warranted — a local `--lp-color-text-ui-secondary-base: …` would be a fix for a rule
we never match, and it would silently diverge from upstream when `tokens` finally defines them. If a
description slot or a LaunchPad `Header` is ever adopted, define both tokens once, under **both**
`:root,[data-theme]` and `[data-theme='dark']` (the same shape `themes.css` uses), or the dark theme
will inherit a light-theme colour.

## 5. Spacing — `--space-*` still literal

**SETTLED.** Two greps, as scoped. Nothing relitigated: the alias task stays cancelled.

All six are still defined as literal pixel values in `public/style.css:118-123` —
`--space-1: 4px`, `-2: 6px`, `-3: 8px`, `-4: 10px`, `-5: 12px`, `-6: 18px` — and none is defined in
terms of a `--lp-spacing-*` token. All six are still used, 13 `var(--space-*)` references in total
(`-6`×4, `-5`×3, `-4`×2, `-3`×2, `-2`×1, `-1`×1). Phase 0's finding stands: these values do not align
with LaunchPad's spacing scale, so aliasing them would change layout.

## Verdict

Items 1, 2, 3, 4 and 5 are all **SETTLED**. Nothing was left `NOT INVESTIGATED`.

The one substantive correction to the record: **the `dev:sprite` fix as salvaged did not work.**
`package.json` wiring alone was inert because `scripts/inline-sprite --watch` watched the directory,
which bun never notifies for `index.html`. It has been fixed and re-measured. Item 1's CHANGELOG entry
now describes the fix that exists rather than the one that was assumed.

## How to re-run this

Scratch clone, scratch DB, scratch port. Never the repo root (the live server serves its `dist/`) and
never the live database.

```
git clone --shared <repo> /tmp/p5c/clone && cd /tmp/p5c/clone && bun install --frozen-lockfile
bun run build:fe && bun run assert:fe dist
S=/tmp/p5c/scratch; mkdir -p $S/data $S/repo && git -C $S/repo init -q && git -C $S/repo commit -q --allow-empty -m init
BUTCHR_DATA_DIR=$S/data BUTCHR_DB=$S/data/scratch.db BUTCHR_PORT=47911 setsid bun run src/index.ts &
setsid google-chrome --headless=new --remote-debugging-port=9333 --user-data-dir=$S/chrome about:blank &
```

Every watcher and server is backgrounded with `setsid` and killed by process group. `bun run dev`,
`dev:fe`, `dev:sprite` and `bun run src/index.ts` never terminate; running one in the foreground
blocks forever. Do not `pkill -f p5c` — the pattern matches the agent's own command line.

The driver scripts are scratch-only and deliberately not committed: they hard-code `/tmp` paths, a
scratch DB and seeded ids, so they would rot immediately as a test. `bun test` and `scripts/ci` remain
the committed gates.
