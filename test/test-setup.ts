import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test-suite preload (wired via `bunfig.toml` → `[test] preload`). Runs ONCE before any
// test file is imported, so it can set process.env defaults that `src/config.ts` reads via
// `envInt(...)` at its first import.
//
// >>> THE DOM IS INSTALLED HERE, ONCE, AND LEFT STANDING (RFC §9.3). <<<
// This is what §9.3 asked for from the start, and Phase 4e is the first phase that can do it.
// Through 4d it was impossible: a preload is process-global across all ~150 files, so registering
// here permanently defines `globalThis.document` — and `test/vanilla-views-dom-free.test.ts`
// asserted that it was `undefined`, the tripwire proving no module under `public/` touched
// `document` at MODULE LOAD. That tripwire existed to protect the vanilla views. They are deleted,
// so it is deleted (CTO decision 4 approved retiring it together with test/dom-stub.ts), and the
// DOM can finally just be here.
//
// THREE FILES COLLAPSED INTO THESE FOUR LINES. `test/dom-warmup.ts` registered a DOM, forced
// react-dom to evaluate against it, and tore it down again — an elaborate dance whose ONLY purpose
// was to leave `globalThis.document` undefined for the tripwire while still letting react-dom cache
// `canUseDOM` / `isInputEventSupported` / `queueMicrotask` as true. `test/dom-register.ts` existed
// so a React test file could install a `document` before ES-module hoisting evaluated
// @testing-library/react's CJS graph. A DOM that is simply always present needs neither: react-dom
// evaluates against a window that is never destroyed, so its cached flags and its cached microtask
// queue both stay valid for the life of the process. That is why the warmup's timer-shuffling is
// gone rather than moved.
//
// BEST-EFFORT, AND ONLY FOR ONE REASON. test/gate-sibling-worktree.test.ts copies bunfig.toml and
// THIS FILE into a synthetic repo under `os.tmpdir()` and runs a bare `bun test` there, to prove
// `[test] root` scopes discovery. That temp dir has no `node_modules`, so `@happy-dom/…` cannot
// resolve and an unguarded import would fail the preload — turning a test about test DISCOVERY red
// for a reason about the DOM. A module-resolution failure is therefore swallowed; anything else
// still throws. Nothing is silently degraded: a registration that did not happen makes
// test/dom-env.test.ts's four guards fail loudly, in the repo, by name.
try {
  const { registerDom } = await import("./dom-env.ts");
  registerDom();
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!/Cannot find (module|package)/i.test(msg)) throw e;
}

// `registerDom` hands bun's `fetch` back immediately after happy-dom overwrites it — without that,
// the six test files that issue a real `fetch` against a real `Bun.serve()` origin go red with a
// `NetworkError` naming neither happy-dom nor this file. See test/dom-env.ts for the full rationale
// and test/dom-env.test.ts for the proof, which now covers the whole suite rather than one file.
//
// A React test file no longer opts in to anything, and no longer tears anything down. It renders.
// There is deliberately no `unregisterDom`: destroying the window after react-dom has captured its
// microtask queue makes every later async state update vanish, silently. dom-env.ts spells it out.
//
// >>> DO NOT USE `screen` FROM @testing-library/react. USE THE QUERIES `render()` RETURNS. <<<
// Measured, not guessed, and STILL TRUE with the DOM in the preload. `@testing-library/dom`'s
// screen.js binds `screen` AT MODULE EVAL to `document.body`. Under bun that CJS graph is hoisted
// above ESM imports — but the preload runs before every import, so `screen` now binds to a real
// body. It binds to the body of THIS preload's window, which is the same window every test renders
// into, so it happens to work; it is still the wrong habit, because `render()`'s returned queries
// scope to the rendered container and `screen` does not. test/dom-env.test.ts is the reference for
// how a React test in this suite is shaped.
//
// WHY THIS EXISTS — detached startup-auto-confirm probes must not bleed across test files.
// The launch auto-confirm (`autoConfirmStartupPrompts`) is FIRE-AND-FORGET on both the build
// path (`dispatcher.dispatch` → `void autoConfirmAndFlagTaskStartup`) and the operator path
// (`workspace-agent` → `void autoConfirmWorkspaceStartup`). Many integration tests drive a real
// `dispatch()` / `startWorkspaceAgent()` against a fake harness whose `agentRead` returns a BLANK
// pane (`""`). With the dev-channels-give-up fix (story st-2ef28e4f) a BLANK pane no longer ends
// the poll — the loop keeps polling (the consent dialog may still render) up to `maxPolls`. Under
// the PRODUCTION defaults (`maxPolls=60`, `pollMs=500`) that detached probe would poll a blank
// fake for ~30s, and — because the herdr bin / harness runner is process-global across files —
// its `agentRead`/`send` calls would land in LATER test files and corrupt their recorded calls
// (e.g. a stray `agent read` leaking into `test/send.test.ts`).
//
// Setting a TIGHT probe cadence for the whole suite makes every detached probe drain within a
// handful of fast (pollMs=0) reads — bounded by `maxPolls` — so it completes inside its own file
// instead of leaking. Individual files that exercise the poll loop directly still override these
// at runtime (`config.ctoPrompt*` in their own `beforeAll`). Production is unaffected: this is a
// `[test]`-only preload, and `bun run src/index.ts` keeps the real `BUTCHR_CTO_PROMPT_*` defaults.
process.env.BUTCHR_CTO_PROMPT_POLL_MS ??= "0";
process.env.BUTCHR_CTO_PROMPT_MAX_POLLS ??= "3";
process.env.BUTCHR_CTO_PROMPT_QUIET_POLLS ??= "1";

// LIVE-DB GUARD. `src/db.ts` runs its migrations at IMPORT time, and several test files
// (e.g. channel.test.ts, disk.test.ts, metrics.test.ts) reach it through a STATIC import
// without setting `BUTCHR_DB` first — so with no default they open the operator's real
// `~/.local/share/butchr/butchr.db`. That was survivable while the migrations were
// additive (CREATE IF NOT EXISTS / ensureColumn), but the `output_snapshot` null-migration
// is a DESTRUCTIVE `UPDATE`: a bare `bun test` (or `./scripts/ci`) would wipe the live
// column. Default the path to a throwaway temp db BEFORE any test file — hence any
// `src/config.ts` — is imported. Files that set their own `BUTCHR_DB` still win (they
// assign before their own dynamic `import("../src/db.ts")`); this only covers the ones
// that never set it at all. Test-only: the `[test]` preload never runs in production.
process.env.BUTCHR_DB ??= join(mkdtempSync(join(tmpdir(), "butchr-test-db-")), "test.db");
