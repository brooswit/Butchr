// The React-visible store over `core/state-meta.js`.
//
// WHY THIS EXISTS. state-meta.js's six exported tables are `export let` bindings that
// `applyStateMeta()` REASSIGNS once `/api/state-meta` lands. ES live bindings propagate the new
// value to every importer, so vanilla code that reads them at call time sees the update — but a
// React component never re-renders, because nothing told React anything changed (RFC §1.1 row 5).
//
// So the tables stay exactly where they are (the vanilla views still read them live) and this module
// adds the ONE thing React needs: a subscribable version counter that ticks whenever the tables are
// rebuilt. `useSyncExternalStore` turns that into a re-render. Nothing here mirrors the tables — a
// second copy is the bug this file exists to avoid.

import { useSyncExternalStore } from "react";
import { loadStateMeta, stateMetaLoaded } from "./core/state-meta.js";

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

/** Fetch (or re-fetch) `/api/state-meta`, rebuild the tables, and wake every subscriber. Never
 *  rejects: `loadStateMeta` swallows a failed fetch and installs DEFAULT_STATE_META instead. */
export async function ensureStateMeta(): Promise<void> {
  await loadStateMeta();
  version++;
  for (const listener of [...listeners]) listener();
}

/** Read at CALL time, never destructured into a const — `stateMetaLoaded` is a live binding that
 *  flips to true only once a real fetch succeeds. False means "still on the built-in fallback", and
 *  that is the SSE handler's cue to retry (see App.tsx's SSE effect). */
export function isStateMetaLoaded(): boolean {
  return stateMetaLoaded;
}

/** Re-renders its caller whenever the tables are rebuilt. The bridge uses it to re-run the current
 *  vanilla view once the real server metadata replaces the fallback. */
export function useStateMetaVersion(): number {
  return useSyncExternalStore(subscribe, getSnapshot);
}
