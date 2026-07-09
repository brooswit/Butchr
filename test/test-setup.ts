import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test-suite preload (wired via `bunfig.toml` → `[test] preload`). Runs ONCE before any
// test file is imported, so it can set process.env defaults that `src/config.ts` reads via
// `envInt(...)` at its first import.
//
// >>> THE DOM IS NOT INSTALLED HERE, AND THAT IS A DECISION, NOT AN OMISSION. <<<
// RFC §9.3 calls for happy-dom to be registered from this preload. It cannot be, yet. A preload is
// process-global across all ~130 files, so registering here would permanently define
// `globalThis.document` — and `test/metrics-view.test.ts` asserts that it is `undefined` between
// tests, the tripwire proving no module under `public/` touches `document` at MODULE LOAD. The
// vanilla views still rely on that guard; Phase 4e retires it along with them, and only then does
// this preload get its `registerDom()` line.
//
// Until then a test opts IN per file, and restores on the way out:
//     import { registerDom, unregisterDom } from "./dom-env.ts";
//     beforeAll(registerDom); afterAll(unregisterDom);
// See test/dom-env.ts for the full rationale (it also hands bun's `fetch` back after registering,
// without which six server test files go red), and test/dom-env.test.ts for the proof it round-trips.
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
