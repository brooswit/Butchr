// THE BRIDGE. It shrinks with every migrated view. RFC Phase 4e DELETES this file.
//
// It hosts the still-vanilla view bodies inside the React shell, and it is written to be thrown
// away: no abstraction, no generalization. Phase 4 rebuilds the remaining views in .tsx, deletes
// core/nav.js and core/dom.js, deletes ui-state.js, and this module goes with them. If you are
// tempted to make it nicer, don't — land the next view instead.
//
// HOW IT RECONCILES WITH `mount()` (RFC §6.2's hazard, head-on).
// nav.js's mount() does `app.innerHTML = ""` then appendChild — a full destroy/rebuild of `#app` on
// every SSE event. That is fatal to React nodes living inside `#app`. The rule that makes the two
// coexist is: **a vanilla route and a React route are never mounted at the same time.** Exactly one
// route matches; a vanilla route's element renders `null`, so React creates no children under `#app`
// and its reconciler never diffs the nodes mount() put there.
//
// The second half of that rule is that `<main id="app">` is rendered by the LAYOUT, not by a route.
// A route element that rendered it would unmount it on every navigation, and refreshSoon() would
// then mount() into a detached node.
//
// >>> AND THE THIRD HALF, NEW IN PHASE 4b, IS `useLayoutEffect`'s CLEANUP BELOW. <<<
// Since 4b, `<Routes>` renders INSIDE `<main id="app">`, so navigating from a vanilla route to a
// React one asks React to insert children into a container full of foreign nodes — it would append
// AFTER them, and the stale page would sit above the new one forever. The fix is to empty `#app` as
// the vanilla view leaves. It has to be a LAYOUT effect, not a passive one: a passive cleanup runs
// after the commit, by which time React has already inserted the incoming route's DOM, and clearing
// then would delete the page that just rendered. A layout-effect destroy runs while React processes
// the deletion, which precedes the sibling placement in the same commit. That ordering is the whole
// trick, and it is why the two hooks below are not the same hook.

// >>> PHASE 4d: NO ROUTE MOUNTS THIS ANY MORE. `App.tsx` does not import it. <<<
// It is kept on disk, unreachable and still typechecked, so that reverting a single route is a
// two-line change. Phase 4e deletes it.
//
// AND IT LOST ITS `stopLiveOutput` IMPORT, WHICH WAS FORCED, NOT TIDYING.
// `import { stopLiveOutput } from "./views/task.js"` used to resolve to the vanilla `views/task.js`
// under both tools, because no `views/task.ts*` existed. `views/task.tsx` exists now, and the two
// tools DISAGREE about which file that specifier names: `tsc` tries `.ts`/`.tsx` before the literal
// `.js` and lands on the React view (which exports no such function — TS2305), while `bun build`
// resolves the literal `.js` and lands on the vanilla one. There is no specifier both agree on; that
// is precisely the hazard `components/chips.tsx`'s header documents, seen from the other side.
//
// The call was there to stop the vanilla task view's live-output poll timer, which outlived its own
// view's DOM, before every re-render. No vanilla route is mounted, so that timer can never have been
// started, and the call is unreachable. If you revert the task route to `<VanillaView>`, restore
// this import too — spell it as a relative path bun and tsc cannot disagree on, or accept the leak.
import { useEffect, useLayoutEffect, useRef } from "react";
import { el } from "./core/dom.js";
import { mount, render, setRenderer } from "./core/nav.js";
import { useStateMetaVersion } from "./state-meta-store";
import { captureUiState, restoreUiState } from "./ui-state.js";

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

  // Hand `#app` back EMPTY when this view leaves, so an incoming React route's nodes are not
  // appended below a corpse. Layout, not passive — see the header. Empty deps: this must fire on
  // unmount only, never when `id` changes between two vanilla routes (mount() clears for that).
  useLayoutEffect(() => {
    return () => {
      const app = document.getElementById("app");
      if (app) app.innerHTML = "";
    };
  }, []);

  useEffect(() => {
    // The route-scoped `stopLiveOutput()` that used to run here is gone — see the header. No vanilla
    // route is mounted, so no vanilla poll timer can exist to stop.
    const fn = async () => {
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
