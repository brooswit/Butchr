# SPIKE: can `bun build` bundle React + `@launchpad-ui` for the browser?

**Status:** throwaway empirical spike. Facts only — no design, no migration plan.
**Question:** can `bun build` alone (no webpack/vite/rollup) produce a working, *styled* browser
bundle of React + LaunchDarkly's `@launchpad-ui` component library?
**Answer:** **Yes.** Verified end-to-end in a real browser. But four non-obvious things must be
done by hand, and two of them fail *silently* (the page builds and boots, and still looks wrong).

Every claim below is backed by a command that was actually run in this spike, against the
installed binary and the installed package contents — not against documentation. Anything I could
not verify is marked `UNVERIFIED:`.

## Environment

Run on 2026-07-09, entirely inside a scratch directory outside the repo. **The butchr repo was
not touched**: no `dependencies`, no lockfile, no `node_modules`, no change to `scripts/ci`,
`public/`, `src/`, or `index.html`. The only committed artifact is this document.

```
$ bun --version
1.3.11

$ google-chrome --version
Google Chrome 150.0.7871.114
```

---

## 1. Install

```
$ bun install react react-dom @launchpad-ui/components @launchpad-ui/icons @launchpad-ui/tokens
```

Resolved versions (verbatim from `bun install` output):

```
installed react@19.2.7
installed react-dom@19.2.7
installed @launchpad-ui/components@0.21.0
installed @launchpad-ui/icons@0.26.0
installed @launchpad-ui/tokens@0.16.0

31 packages installed [1.99s]
```

### Does it resolve from public npm with no auth? Yes — verified clean-room.

This machine has a `~/.npmrc` carrying an `_authToken` for `registry.npmjs.org`, so the install
above was **not** a valid anonymity test. I re-ran it with an isolated `HOME` (no `.npmrc`
readable), a fresh cache, and a scrubbed environment:

```
$ env -i PATH="$PATH" HOME="$ANON/home" BUN_INSTALL_CACHE_DIR="$ANON/cache" \
    bun install react@19.2.6 react-dom@19.2.6 @launchpad-ui/components@0.21.0 \
      @launchpad-ui/icons@0.26.0 @launchpad-ui/tokens@0.16.0
...
31 packages installed [2.09s]
ANON_INSTALL_EXIT=0
```

An unauthenticated `curl` to the registry agrees:

```
$ curl -s -o /dev/null -w "%{http_code}\n" https://registry.npmjs.org/@launchpad-ui%2fcomponents
200
  latest: 0.21.0 | license: Apache-2.0 | versions: 179
```

**Public, Apache-2.0, no auth, no private registry.**

### React major: 19. Peers are pinned to EXACT versions.

`@launchpad-ui/components@0.21.0` `peerDependencies` (verbatim from the installed
`package.json` — note these are exact versions, **not** ranges):

```json
"peerDependencies": {
  "@react-aria/focus":        "3.22.1",
  "@react-aria/interactions": "3.28.1",
  "@react-aria/utils":        "3.34.1",
  "@react-stately/utils":     "3.12.1",
  "@react-types/shared":      "3.35.0",
  "react":                    "19.2.6",
  "react-aria":               "3.49.0",
  "react-aria-components":    "1.18.0",
  "react-dom":                "19.2.6",
  "react-hook-form":          "7.59.0",
  "react-router":             "7.15.1",
  "react-stately":            "3.47.0"
}
```

This is **React 19 only**, and it wants an exact `19.2.6`. Because the pins are exact, a plain
`bun install react` (which resolves `^19.2.7`) immediately trips peer warnings:

```
warn: incorrect peer dependency "@react-types/shared@3.36.0"
warn: incorrect peer dependency "react@19.2.7"
warn: incorrect peer dependency "react-aria@3.50.0"
warn: incorrect peer dependency "react-dom@19.2.7"
warn: incorrect peer dependency "react-stately@3.48.0"
```

The warnings are **not** fatal — the build and the browser render both succeed with the mismatched
tree (§2, §4). They can be silenced only by pinning the whole set exactly:

```
$ bun install --exact react@19.2.6 react-dom@19.2.6 \
    @launchpad-ui/components@0.21.0 @launchpad-ui/icons@0.26.0 @launchpad-ui/tokens@0.16.0 \
    react-aria@3.49.0 react-aria-components@1.18.0 react-stately@3.47.0 \
    @react-types/shared@3.35.0 react-hook-form@7.59.0 react-router@7.15.1 \
    @react-aria/focus@3.22.1 @react-aria/interactions@3.28.1 @react-aria/utils@3.34.1 \
    @react-stately/utils@3.12.1
...
30 packages installed [623.00ms]        # zero warnings
```

That is **15 direct dependencies** to get a clean peer graph. Also note `react-router` and
`react-hook-form` are *peers of a component library* — LaunchPad expects you to have a router and
a form library in the app. The pinned tree builds fine (`EXIT=0`, §2).

Footprint of the pinned tree:

```
$ du -sh node_modules   →  78M
packages on disk: 29
```

`bun install` writes **`bun.lock`** (text, 9931 bytes), not `bun.lockb`.

---

## 2. Build

### The first attempt FAILED. `--outfile` is incompatible with this library.

`app.tsx` imports React, mounts a root, and renders a `Button`, an `IconButton`, an `Icon`, a
`DialogTrigger`/`Modal`/`Dialog`, and a `Table`/`TableHeader`/`TableBody`/`Row`/`Cell` — all real
exports, confirmed against `dist/index.es.js`'s export statement.

```
$ bun build app.tsx --target browser --outfile out.js
error: Multiple files share the same output path
  ./out.js:
    from input app.tsx

note: entry naming is './out.js', consider adding '[hash]' to make filenames unique
EXIT=1
```

I expected a JSX or a resolution error. This is neither. The cause is that the bundle has **two**
outputs (JS *and* CSS, see §4) and `--outfile` can only name one. Control experiment — the same
build with no CSS anywhere in the graph succeeds with `--outfile`:

```
$ cat nocss.tsx
import { createRoot } from "react-dom/client";
createRoot(document.getElementById("root")!).render(<h1>hi</h1>);

$ bun build nocss.tsx --target browser --outfile nocss.js
Bundled 11 modules in 68ms
  nocss.js  0.97 MB  (entry point)
EXIT=0
```

**The fix is `--outdir`, not a flag or a config file.** With `--outdir` and *zero* config —
no `tsconfig.json`, no loader, no `--jsx`, no `--external` — it just works:

```
$ bun build app.tsx --target browser --outdir dist_a
Bundled 1217 modules in 114ms

  app.js   1.61 MB   (entry point)
  app.css  99.81 KB  (asset)

EXIT=0
```

**1217 modules, 114 ms, exit 0, no configuration of any kind.** No warnings.

> **Direct consequence for `scripts/ci`:** today's FE gate is
> `bun build public/app.js --target browser --outfile /dev/null`. That command **cannot** survive
> a CSS-importing entry point — it exits 1 with the error above. Confirmed:
> ```
> $ bun build app.tsx --target browser --outfile /dev/null
> error: Multiple files share the same output path
>   ./null:
>     from input app.tsx
> EXIT=1
>
> $ bun build full.html --outfile /dev/null
> error: cannot write multiple output files without an output directory
> EXIT=1
> ```
> A future gate must build to a throwaway `--outdir`.

---

## 3. JSX / TSX config — the minimum is *nothing*

| Entry | `tsconfig.json` | Result |
|---|---|---|
| `app.tsx` | absent | builds, exit 0 |
| `plain.jsx` | absent | builds, exit 0 |
| `plain_js.js` (contains JSX) | absent | builds, exit 0 |
| `plain.jsx` | `{"jsx":"react-jsx"}` | builds, exit 0, identical output |
| `plain.jsx` | `{"jsx":"react"}` | builds, exit 0, **but emits classic `React.createElement`** |

**Minimum viable setup: none. No `tsconfig.json` is required, and no `--jsx` flag exists in the
CLI.** Bun defaults to the automatic runtime, so a file that never imports `React` still works.

Surprises worth recording:

- **A `.js` file containing JSX compiles.** Bun does not gate JSX on the file extension. That is
  a hazard, not a feature: it means a stray JSX syntax error in a `public/**/*.js` file would be
  parsed as JSX rather than rejected.
- **`tsconfig.json` IS honored, and can break the build silently.** Setting `"jsx": "react"`
  flips bun to the classic transform (`React.createElement` appears in the output, verified by
  grep). `plain.jsx` never imports `React`, so that bundle would throw `React is not defined` at
  runtime — yet `bun build` still exits **0**. If a `tsconfig.json` is ever added, `"jsx"` must be
  `"react-jsx"` or omitted.
- **Bun defaults to the DEV JSX runtime.** With no flags, the output contains `jsxDEV` (9
  occurrences) and `react-dom.development` (16 occurrences). See §5 — this must be turned off for
  production, and nothing warns you.

### `bun build` does NOT typecheck. At all.

```
$ cat bad.tsx
import { Button } from "@launchpad-ui/components";
export const X = () => <Button totallyBogusProp={123} variant="not-a-variant">x</Button>;
const n: number = "definitely a string";

$ bun build bad.tsx --target browser --outdir bad_out
  bad.js   231.95 KB  (entry point)
EXIT=0        # <-- zero
```

Bogus props, a bogus `variant`, and `const n: number = "a string"` all pass. Independently, my
first `app.tsx` used `icon="pencil"` — **not a real icon name** (`grep -c 'id="lp-icon-pencil"'
sprite.svg` → `0`; the real one is `edit`). It built clean and rendered an empty box. The types
LaunchPad ships (`IconName` is a string union of all 337 names) would have caught it, but only
under a typechecker. `tsc` is not on `PATH` and `typescript` is not installed — typechecking would
be an *additional* dependency and an *additional* CI step, not something `bun build` gives you.

---

## 4. CSS + tokens — the highest-risk area, and it does bite

### How the CSS ships

`@launchpad-ui/components/dist/index.es.js` **imports its own stylesheet on line 1**:

```
$ head -c 40 node_modules/@launchpad-ui/components/dist/index.es.js
import './style.css';
```

Same for `@launchpad-ui/icons`. Both packages declare `"sideEffects": ["**/*.css"]`. So you do
**not** import the component CSS yourself — it arrives automatically through the JS import graph,
and `bun build` handles the `.css` import from JS with no loader configuration.

`bun build` emits it as a **separate `.css` file next to the JS** (not inlined into the JS, and
not injected at runtime):

```
  app.js   1.61 MB   (entry point)
  app.css  99.81 KB  (asset)
```

Bun *re-prints* the CSS rather than passing it through: the two source stylesheets concatenate to
81,356 bytes but the emitted `app.css` is 99,809 bytes (+22.7%), because the shipped CSS is
minified and bun pretty-prints it. `--production` / `--minify` minifies it back down (§5).

### THE TRAP: the components' CSS ships with no tokens. The page renders unstyled.

Tokens are **CSS custom properties**, defined in `@launchpad-ui/tokens`, and **nothing in the JS
import graph pulls them in.** `@launchpad-ui/components/dist/style.css` contains no `@import`.
Measuring the default build:

```
$ grep -oE 'var\(--lp-[a-z0-9-]+' dist_a/app.css | sort -u | wc -l     # usages
187
$ grep -oE '\-\-lp-[a-z0-9-]+:' dist_a/app.css | sort -u | wc -l       # definitions
1
```

**187 distinct `var(--lp-*)` usages, 1 definition.** (The single definition is a component-local
`--lp-button-padding`.) Every color, radius, and spacing value resolves to nothing. The build
exits 0 and the app boots — it just looks broken. Nothing warns.

`@launchpad-ui/tokens`'s JS entry does **not** help either — it exports a nested JS object of raw
values (`export default { asset: { font: {...} } }`) and imports no CSS
(`grep -c '\.css' tokens/dist/index.es.js` → `0`). **Tokens are both a JS object and CSS custom
properties, and the two are separate artifacts.** For styling you need the CSS.

### The exact import specifiers that work

I probed each candidate by actually building `import "<spec>";`. Verified, not guessed:

| Specifier | Result |
|---|---|
| `@launchpad-ui/tokens/index.css` | **OK** |
| `@launchpad-ui/tokens/themes.css` | **OK** |
| `@launchpad-ui/tokens/media-queries.css` | **OK** |
| `@launchpad-ui/tokens/fonts.css` | **OK** |
| `@launchpad-ui/tokens/dist/index.css` | **OK** (both forms are in `exports`) |
| `@launchpad-ui/components/style.css` | OK (redundant — the JS already imports it) |
| `@launchpad-ui/icons/style.css` | OK (redundant) |
| `@launchpad-ui/tokens/style.css` | **FAIL** — `error: Could not resolve` |

Note the naming is inconsistent across the three packages: `components`/`icons` expose
`./style.css`; `tokens` exposes `./index.css` + `./themes.css` + `./fonts.css` + `./media-queries.css`
and has **no** `./style.css`. Guessing the path fails.

`index.css` defines tokens under `:root`; `themes.css` defines them under `:root, [data-theme]`
and `[data-theme='dark']` — so **dark mode is a `data-theme` attribute on an ancestor**, and
`themes.css` is where the actual color values live (`--lp-color-text-ui-primary-base` is defined
only in `themes.css`).

Adding `import "@launchpad-ui/tokens/index.css"` + `themes.css` fixes it:

```
$ bun build app.tsx --target browser --outdir dist_b
Bundled 1222 modules in 114ms
  app.js   1.61 MB  (entry point)
  app.css  0.34 MB  (asset)

definitions: 378    usages: 241
```

### Two tokens are undefined upstream — a real bug in `@launchpad-ui@0.21.0`

Even with every token stylesheet imported, 2 of the 241 used variables are defined **nowhere in
any installed package**:

```
--lp-color-text-ui-secondary-base
--lp-color-text-ui-tertiary
```

Both are `var()`-referenced by `components/dist/style.css` and defined by no file under
`node_modules/@launchpad-ui/`. Confirmed at runtime in Chrome — `getPropertyValue` returns the
empty string:

```
TOKEN_primary_base=#425eff          <- resolves
TOKEN_text_primary=#23252a          <- resolves
TOKEN_undefined_tertiary=[]         <- EMPTY
```

This is `components@0.21.0` referencing tokens that `tokens@0.16.0` does not ship. Harmless-ish
(those elements inherit a color) but it is a genuine upstream defect and a sign the two packages'
versions are coupled more tightly than their `~0.16.0` range admits.

### Fonts get INLINED as base64, which is a pessimization

`@launchpad-ui/tokens/fonts.css` declares two `@font-face` rules pointing at
`./assets/*.woff2` (60,116 + 100,176 = 160,292 bytes). If you import `fonts.css`, `bun build`
**inlines both fonts as `data:` URIs into the CSS** and emits **no asset file**:

```
$ grep -oE 'url\([^)]*\)' dist_b/app.css | head -1
url("data:font/woff2;base64,d09GMgABAAAAAOrUAA8AAAAEClAAAOpwAAEAAAAAAAAA...

$ find dist_b -type f
  dist_b/app.css
  dist_b/app.js        # <- no .woff2 anywhere
```

Measured cost: CSS goes from **124.1 KB** (tokens, no fonts) to **338 KB** (tokens + fonts).
`woff2` is already compressed, so base64-in-CSS does not gzip back down — the production
`app.css` is 323,377 raw / **176,457 gzipped**, i.e. the fonts cost more over the wire than
serving the two `.woff2` files directly (160 KB) *and* they block first paint because they are in
the render-blocking stylesheet.

`UNVERIFIED:` I did not find a documented bun flag to force a font asset out to a file instead of
inlining. Bun's default `.svg` loader *does* emit a file (§ icons below), so the inlining appears
to be font-specific or size-threshold-driven; I did not isolate which. Not importing `fonts.css`
sidesteps it entirely.

### Icons: `<use href="#...">` — the sprite must be inlined into the document

`@launchpad-ui/icons`'s `Icon` renders a **document-local fragment reference**:

```
$ grep -oE '<use[^>]*>' dom.html
<use href="#lp-icon-pencil">
<use href="#lp-icon-check">
```

There is **no URL** — just `#id`. The 214 KB `sprite.svg` (337 `<symbol>` elements) is never
pulled into the JS graph and is never emitted by the build:

```
$ find dist_probe -type f
  dist_probe/probe-g2b3amby.js
  dist_probe/probe.html
  dist_probe/probe-znhvjpk5.css      # <- no sprite.svg
```

So `<use>` resolves against the current document, finds nothing, and the icon renders **blank**.
Proven in real Chrome, both cases, production builds:

```
===== CASE 1: sprite NOT inlined =====
USE_HREF=#lp-icon-check
SYMBOL_IN_DOC=NO -- <use> points at nothing
SVG_BOX=20x20

===== CASE 2: sprite INLINED into <body> =====
USE_HREF=#lp-icon-check
SYMBOL_IN_DOC=YES (symbol)
SVG_BOX=20x20
```

Note `SVG_BOX` is `20x20` in **both** cases — the icon reserves its layout box either way, so a
missing sprite is invisible to any size/layout assertion. Screenshots confirm: case 1 is a blank
white image, case 2 renders a checkmark.

`sprite.svg` *is* importable from JS, which emits it as a hashed asset and hands you a URL string:

```
$ echo 'import s from "@launchpad-ui/icons/sprite.svg"; console.log(s);' > sp.js
$ bun build sp.js --target browser --outdir sp_out
  sp.js                137 bytes  (entry point)
  sprite-y535e2x4.svg  214.49 KB  (asset)
```

…but that URL is **useless to the components**, because they hardcode `href="#lp-icon-x"` with no
path. **The sprite's `<svg>` element must be inlined into the served HTML body.** That is a
serving requirement, not a bundling one, and `bun build` will not do it for you.

### Verified: the page really does render STYLED

Not assumed. I built a probe entry, served it over HTTP with `Bun.serve`, drove headless Chrome
at it, and read `getComputedStyle` out of the live DOM. **Production build** (`--production`),
tokens imported, sprite inlined:

```
BTN_TAG=BUTTON
BTN_CLASS=C_Feta_base xisFqG_interactive C_Feta_medium C_Feta_primary C_Feta_button
BTN_BG=rgb(66, 94, 255)          <- == #425eff, the resolved --lp-color-bg-interactive-primary-base
BTN_COLOR=rgb(255, 255, 255)
BTN_RADIUS=6px
BTN_PADDING=6px 8px
BTN_FONTFAMILY=Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", ...
TOKEN_primary_base=#425eff
SHEETS=2
CSSRULES=802
TABLE_PRESENT=true
SVG_ICONS=2
```

The button's computed background equals the token's hex value, 802 CSS rules are live, the
`Table` mounted, and the icons are real `<svg>` nodes. A `--window-size=520,360` screenshot of the
full app shows a blue primary Button, a pencil `IconButton`, a check `Icon`, an "Open modal"
Button, and a styled Table with header rules. **React 19 + LaunchPad renders correctly, styled, in
a real browser, from a plain `bun build`.**

---

## 5. Output shape

Default (`--outdir`) emits `[name].js` + `[name].css`. No sourcemap, no hashing, no asset files
(fonts inlined; sprite absent).

**`--production` exists and is the flag that matters** (confirmed in `bun build --help`:
`"Set NODE_ENV=production and enable minification"`):

| Build | JS | CSS |
|---|---|---|
| default (dev) | **1.61 MB** | 0.34 MB |
| `--production` | **0.46 MB** | 0.32 MB |
| `--minify --define 'process.env.NODE_ENV="production"'` | 0.46 MB | 0.32 MB |

`--production` is exactly equivalent to the explicit minify + define pair. Without it you ship the
**React development build** (`jsxDEV` ×9, `react-dom.development` ×16); with it both are **0**.
This is the single biggest silent footgun in the toolchain — the default build is 3.5× larger and
runs React's dev-mode checks.

Transfer sizes (production, tokens + fonts):

```
  app.js    raw=457342   gzip=141965
  app.css   raw=323377   gzip=176457      # 176 KB of that is base64 fonts
```

Sourcemaps and hashing:

```
$ bun build app.tsx --target browser --outdir o_hash --production \
    --sourcemap=linked --entry-naming '[name]-[hash].[ext]'
Bundled 1216 modules in 122ms

  app-fgp5bfyv.js      0.46 MB  (entry point)
  app-9z559f1y.css     0.32 MB  (asset)
  app-fgp5bfyv.js.map  2.30 MB  (source map)
```

- `--sourcemap=` takes `linked` | `inline` | `external` | `none`. The map is **2.30 MB**.
- Hashing is **not** on by default for the entry; `--entry-naming '[name]-[hash].[ext]'` turns it
  on. `--chunk-naming` and `--asset-naming` already default to `[name]-[hash].[ext]`.

### `index.html` as an entry point — bun wires it for you

**`bun build` in 1.3.11 has a real HTML entry mode.** Given an `index.html` whose `<script
type="module" src="./app.tsx">` points at the TSX source:

```
$ bun build index.html --outdir dist_html
Bundled 1223 modules in 134ms

  index-vcn253rv.js   1.61 MB    (entry point)
  index.html          196 bytes  (entry point)
  index-yw5sqb9k.css  0.34 MB    (asset)
```

It rewrites the HTML, hashes both assets automatically (even without `--entry-naming`), and
**injects the `<link rel="stylesheet">` itself**:

```html
<!doctype html>
<html><body><div id="root"></div>
<link rel="stylesheet" crossorigin href="./index-yw5sqb9k.css">
<script type="module" crossorigin src="./index-vcn253rv.js"></script>
</body></html>
```

This is the cleanest answer to "how does `index.html` reference the outputs": it doesn't — you
author the HTML against the *source* entry and bun rewrites it. (The sprite still has to be pasted
into `<body>` by hand; bun leaves unknown markup alone, verified — a `full.html` with the sprite
inlined built to a 214.68 KB `full.html`.)

---

## 6. Dev workflow

**`bun build --watch` works.** Verified by mutating a string mid-run:

```
$ bun build app.tsx --target browser --outdir w_out --watch &
Bundled 1222 modules in 132ms
# (edit app.tsx: "LaunchPad spike" -> "LaunchPad spike CHANGED")
Bundled 1222 modules in 123ms
$ grep -c 'LaunchPad spike CHANGED' w_out/app.js
1
```

It rebuilds and rewrites the output. `UNVERIFIED:` whether it does anything smarter than a full
rebuild — 1222 modules in ~123 ms either way, so it does not matter much.

**`bun ./index.html` starts a dev server.** Not `bun build` — the `bun` runtime itself serves an
HTML entry:

```
$ bun ./full.html
Bun v1.3.11 dev server ready in 11.92 ms
url: http://localhost:3000/

$ curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/
200
```

`UNVERIFIED:` I confirmed it serves HTTP 200 and boots, but did not test hot-module reload
behavior.

There is also an `--app` flag (`"(EXPERIMENTAL) Build a web app for production using Bun Bake"`).
`UNVERIFIED:` not exercised — it is marked experimental in the installed binary's own help text.

Build performance is a non-issue: **~0.11–0.13 s wall** for a full production build of 1216
modules, measured over three runs.

---

## 7. Failures, risks, and things I could not verify

Ranked by how likely each is to cost someone a day.

1. **Tokens are not included by the components' CSS.** 187 `var(--lp-*)` usages, 1 definition. The
   build exits 0, React mounts, the page is unstyled. You must explicitly
   `import "@launchpad-ui/tokens/index.css"` **and** `"@launchpad-ui/tokens/themes.css"`.
   *Fails silently.*
2. **Icons are blank unless `sprite.svg` is inlined into the served HTML.** The components emit
   `<use href="#lp-icon-x">` with no path. The sprite is never bundled. The `<svg>` still occupies
   its 20×20 layout box, so nothing — not the build, not a layout test — catches it.
   *Fails silently.* Requires a serving-side change: paste 214 KB of `<symbol>`s into `<body>`.
3. **The default build ships React's development bundle.** 1.61 MB vs 0.46 MB. `--production` is
   opt-in and nothing warns. *Fails silently.*
4. **`--outfile` cannot be used at all.** Any CSS in the graph → `error: Multiple files share the
   same output path`. **This breaks `scripts/ci`'s current
   `bun build public/app.js --target browser --outfile /dev/null` gate**, which must become an
   `--outdir` to a temp directory.
5. **`bun build` performs zero type checking.** `const n: number = "a string"` builds clean, as
   does a nonexistent `icon="pencil"` and a bogus `variant`. LaunchPad's own `IconName` union
   would catch the icon typo, but only under `tsc` — which is not installed and would be a new
   dependency plus a new CI step. Without it, adopting a typed React library buys you the
   `.d.ts` files and none of their protection.
6. **Peer dependencies are pinned to exact versions**, including `react@19.2.6`. A clean install
   warns 5×; silencing it means pinning **15 direct dependencies**, two of which
   (`react-router@7.15.1`, `react-hook-form@7.59.0`) are whole libraries butchr does not otherwise
   need. Every LaunchPad bump will move several pins in lockstep. `UNVERIFIED:` I did not test
   whether the mismatched (warned-about) tree misbehaves at runtime in any way beyond the smoke
   test — it rendered correctly, but React Aria context sharing across two minor versions is
   exactly the sort of thing that breaks subtly, and a `Button`/`Table` smoke test would not show
   it.
7. **`@launchpad-ui@0.21.0` references 2 tokens that `@launchpad-ui/tokens@0.16.0` does not
   define** (`--lp-color-text-ui-secondary-base`, `--lp-color-text-ui-tertiary`). Verified empty at
   runtime. An upstream bug; cosmetic today.
8. **Importing `fonts.css` inlines 160 KB of `woff2` as base64 into the render-blocking
   stylesheet** (CSS 124 KB → 338 KB; 176 KB gzipped, since base64'd woff2 does not compress).
   `UNVERIFIED:` no flag found to force fonts out to files. Simply not importing `fonts.css`
   avoids it, at the cost of not shipping Inter.
9. **`tsconfig.json` is honored and can silently break the bundle.** `"jsx": "react"` emits
   `React.createElement` into files that never import React; `bun build` still exits 0 and the
   page throws at runtime.
10. **JSX compiles inside `.js` files.** Bun does not gate the JSX parser on the extension, which
    weakens `scripts/ci`'s per-file parse loop as a syntax guard for plain `public/**/*.js`.
11. `UNVERIFIED:` bundle-size reduction via tree-shaking. The 0.46 MB production JS is for **five**
    components; I did not measure whether importing the full library's surface grows it, nor
    whether `--splitting` helps. `sideEffects: ["**/*.css"]` is declared, so JS tree-shaking should
    be permitted, but I did not confirm it empirically.
12. `UNVERIFIED:` accessibility, keyboard interaction, and the `Modal`/`DialogTrigger` **open**
    state. I rendered the trigger; I never clicked it. Overlay components are where React Aria's
    portal/context machinery actually gets exercised.
13. `UNVERIFIED:` dark mode. I confirmed `themes.css` defines `[data-theme='dark']` selectors but
    never set the attribute and re-measured.

Nothing about this was slow, and nothing needed a workaround beyond `--outdir`. The failures above
are all *silent-by-default correctness* problems, not toolchain fights.

---

## Bottom line

**`bun build` + React 19 + `@launchpad-ui` is VIABLE with no extra bundler.** No webpack, no vite,
no rollup, no loader, no plugin, no `tsconfig.json`. A 1216-module production bundle builds in
~0.12 s and renders correctly and fully styled in a real browser — verified by computed styles and
screenshots, not assumed.

The minimum toolchain is:

- **Bun ≥ 1.3.11** (nothing else; the installed binary supports HTML entries, `--watch`,
  `--production`, `--sourcemap`, and hashed naming).
- **15 pinned npm dependencies** for a warning-free peer graph (~78 MB `node_modules`), or 5 if
  you accept 5 peer warnings.
- **`--outdir`, never `--outfile`** — CSS makes the build multi-output.
- **`--production`** — otherwise you ship React's dev build (3.5× larger).
- **Two explicit CSS imports** — `@launchpad-ui/tokens/index.css` and `.../themes.css` — or the
  app renders unstyled while exiting 0.
- **`sprite.svg` inlined into the served HTML `<body>`** — or every icon is invisible while
  exiting 0.
- **A typechecker (`tsc`) is NOT included** and would be a further dependency + CI step. Without
  it, none of LaunchPad's types are enforced.

The bundling question is settled and the answer is yes. The real costs are elsewhere: three
silent-failure modes that no build error will ever surface (tokens, sprite, dev build), a
15-package exact-pinned peer graph that includes a router and a form library, and the fact that
adopting a typed React component library without `tsc` buys none of the type safety that is
supposedly the point.
