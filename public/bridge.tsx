// THE BRIDGE. One bridge, one phase. RFC Phase 4 DELETES this file.
//
// It hosts the still-vanilla view bodies inside the React shell, and it is written to be thrown
// away: no abstraction, no generalization, no second consumer. Phase 4 rebuilds the six views in
// .tsx, deletes core/nav.js and core/dom.js, deletes ui-state.js, and this module goes with them.
// If you are tempted to make it nicer, don't — make Phase 4 land instead.
//
// HOW IT RECONCILES WITH `mount()` (RFC §6.2's hazard, head-on).
// nav.js's mount() does `app.innerHTML = ""` then appendChild — a full destroy/rebuild of `#app` on
// every SSE event. That is fatal to a React root living inside `#app`. The rule that makes the two
// coexist is: **React renders `<main id="app" />` with NO children, ever.** React's reconciler only
// touches children it created, so an element it renders empty is one whose childNodes it will never
// diff. The vanilla views own everything under it; React owns the element itself.
//
// The second half of that rule is that `<main id="app">` is rendered by the LAYOUT, not by a route.
// A route element that rendered it would unmount it on every navigation, and refreshSoon() would
// then mount() into a detached node. Route elements here render `null` and do their work in an
// effect. That is the whole trick.

import { useEffect, useRef } from "react";
import { el } from "./core/dom.js";
import { mount, render, setRenderer } from "./core/nav.js";
import { useStateMetaVersion } from "./state-meta-store";
import { captureUiState, restoreUiState } from "./ui-state.js";
import { stopLiveOutput } from "./views/task.js";
import { stopActivity } from "./views/workspace.js";

/** The currently-mounted view's render thunk, or null between routes. This is the cell nav.js's
 *  `render()` delegates into — the same inversion app.js's `setRenderer(renderRoute)` performed, for
 *  the same reason (a view may never import the router). */
let currentRender: (() => Promise<void>) | null = null;

// Registered ONCE, at module load, before any view can call render(). nav.js's render() throws if no
// renderer is registered; a view acting between routes (there is no such moment, but the cell is
// nullable) resolves to a no-op rather than throwing into a click handler.
setRenderer(() => (currentRender ? currentRender() : Promise.resolve()));

/**
 * Mounts one vanilla view into React's `#app` container and registers it as the re-render target.
 *
 * `id` is the route identity — `"task:abc123"`, `"projects"`. It, not `run`, is the effect's
 * dependency: `run` is a fresh closure on every render and would re-run the view on every parent
 * state change (a conn-LED flicker would re-fetch the whole page). `run` is read through a ref so
 * the effect always calls the latest one without depending on it.
 *
 * The other dependency is the state-meta version, so a view that painted against the built-in
 * fallback re-paints once `/api/state-meta` self-heals (see App.tsx's SSE effect).
 */
export function VanillaView({ id, run }: { id: string; run: () => Promise<unknown> }) {
  const runRef = useRef(run);
  runRef.current = run;
  const version = useStateMetaVersion();

  useEffect(() => {
    // Both poll timers are route-scoped and outlive their view's DOM: task.js's live-output poll and
    // workspace.js's activity pulse. Stop them before every render, exactly as the vanilla
    // renderRoute did; each view restarts its own after mount().
    const fn = async () => {
      stopLiveOutput();
      stopActivity();
      try {
        await runRef.current();
      } catch (e) {
        // `[…]`, not a bare string: el()'s `children = []` default types the parameter as an array
        // for `tsc`, even though `[].concat()` accepts either. Same node, and the .js callers that
        // pass a bare string are not typechecked (tsconfig.public.json sets allowJs, not checkJs).
        mount(el("div", { class: "empty" }, ["error: " + (e as Error).message]));
      }
    };
    currentRender = fn;
    void fn();
    return () => {
      if (currentRender === fn) currentRender = null;
      stopLiveOutput();
      stopActivity();
    };
  }, [id, version]);

  return null;
}

// The SSE re-render, debounced. Identical to app.js's: snapshot the operator's in-flight UI state,
// re-run the current view (mount() destroys and rebuilds `#app`), re-apply the snapshot. render()
// swallows the view's own errors, so this never rejects.
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
export function refreshSoon(): void {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    const snap = captureUiState();
    await render();
    restoreUiState(snap);
  }, 150);
}
