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

NOT INVESTIGATED

## 3. Real bundle size and `--splitting` (spike UNVERIFIED #11)

NOT INVESTIGATED

## 4. The two upstream-undefined tokens (RFC §5.4)

NOT INVESTIGATED

## 5. Spacing — `--space-*` still literal

NOT INVESTIGATED
