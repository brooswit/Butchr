// Test-suite preload (wired via `bunfig.toml` → `[test] preload`). Runs ONCE before any
// test file is imported, so it can set process.env defaults that `src/config.ts` reads via
// `envInt(...)` at its first import.
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
