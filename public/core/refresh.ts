// THE RE-RENDER SIGNAL — what `core/nav.js` was, minus the reason it was hard.
//
// nav.js existed to invert one edge. A view needs to re-fetch after it acts (a merge, a park);
// the route dispatcher lived in the entry module; so `views/x.js` importing `render` from the
// entry would drag the entry's `document`-touching boot into every view's module graph and break
// `bun test`. nav.js's `setRenderer` was the indirection that broke that cycle, and its own
// 14-line header called the property it protected "the whole test strategy".
//
// React dissolves it (RFC §9.2). There is no entry module with a top-level boot to import: the
// entry is `createRoot(...).render(<App/>)`, which nothing imports, and every component is a pure
// function until rendered. So the cycle CANNOT exist, and what is left is the one thing nav.js was
// really for: a way to say "the data changed, re-read it."
//
// That is this file, and it is 20 lines instead of a router.
//
// HOW A VIEW USES IT. Every view's fetch effect lists `useRefreshVersion()` among its deps, so a
// bump re-runs the fetch. Two things bump it:
//   • an SSE event, debounced (App.tsx) — the old `refreshSoon()`;
//   • a completed action (components/button.tsx's `useAction`) — the old `render()` default.
//
// Nothing here destroys DOM. That is the whole point: `mount()` cleared `#app` and rebuilt it on
// every event, which is why `captureUiState`/`restoreUiState` had to exist to put the operator's
// typed text, caret, focus and scroll back. React reconciles instead — a controlled input that is
// never unmounted keeps all four for free — so those 61 lines, their three `<test-extract:>`
// sentinel fences (the last sentinel scrapes in the repo) and test/app-restore-uistate.test.ts were
// deleted with the last vanilla view in Phase 4e (RFC §1.4, §9.4).
//
// >>> THIS IS NOW THE ONLY REFRESH SIGNAL. <<< From Phase 4b through 4d it ran ALONGSIDE bridge.tsx's
// own `refreshSoon()`, not instead of it: the bridge's version had to call `render()` (which
// destroyed and rebuilt `#app`) while this one must not touch the DOM at all, and App.tsx's SSE
// handler called BOTH through a local wrapper because only one of them ever had work to do. Phase 4e
// deleted `core/nav.js` and the bridge, so the wrapper is gone and App.tsx imports `refreshSoon`
// from here directly.
import { useSyncExternalStore } from "react";

let version = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): number {
  return version;
}

/** Invalidate every view's data. Synchronous — callers that need debouncing own it. */
export function bumpRefresh(): void {
  version++;
  for (const listener of [...listeners]) listener();
}

// The SSE debounce, ported verbatim from app.js's `refreshSoon` (150ms). It is a coalescer, not a
// throttle: a burst of events during a merge produces exactly one re-fetch.
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
export function refreshSoon(): void {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(bumpRefresh, 150);
}

/** Re-renders its caller on every bump. Put it in a fetch effect's dependency list. */
export function useRefreshVersion(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
