// The router's LEAF surface: the `#app` mount point, hash navigation, and a re-render
// handle. Views under `views/` import from here; NOTHING here imports the entry module.
//
// The route dispatcher used to live in the vanilla `app.js`. Since RFC Phase 3 it is
// `bridge.tsx`'s `VanillaView`, which registers the mounted view's render thunk here on every
// route change. Phase 4 deletes this module along with the bridge.
//
// WHY THE `setRenderer` INDIRECTION EXISTS — do not "simplify" it away.
// A view needs to re-render the current route after it acts (a merge, a park). The route
// dispatcher lives in the entry graph, so the naive move is `views/x.js` importing `render`
// from it. ES modules technically tolerate that cycle for hoisted function declarations,
// so it looks harmless. It is not: the edge drags the entry into the module graph of every
// view, and the entry touches `document` at load — and, now, imports React and a stylesheet.
// `bun test` importing any view then dies with `ReferenceError: document is not defined`, which
// destroys the DOM-free-at-load property the whole test strategy rests on
// (test/kind-badge.test.ts, test/cli-helpers.test.ts, test/metrics-view.test.ts all import
// public/*.js directly). So the dependency is INVERTED: the entry registers its dispatcher here
// via setRenderer(), and views import `render` from this module. The `views/ -> entry` edge must
// never exist.
//
// This module is DOM-FREE at module load: `mount` resolves `#app` lazily inside the call,
// so importing nav.js under a non-browser runner is safe. mount()'s `innerHTML = ""` can never
// destroy a React-owned node, because a vanilla route and a React route are never mounted together:
// a vanilla route's element renders null, so React creates no children under `#app`. See bridge.tsx.

// The registered route dispatcher (bridge.tsx's current view thunk). Set on every route change.
let renderer = null;

// Register the route dispatcher. bridge.tsx calls this at module load, before any view can act.
export function setRenderer(fn) {
  renderer = fn;
}

// Re-render the current route. Delegates to the dispatcher the entry registered; RETURNS its
// promise (the dispatcher is async) so callers can await a completed re-render.
export function render() {
  if (!renderer) throw new Error("nav: render() called before setRenderer()");
  return renderer();
}

// Replace the app's contents with `node`. The single place `#app` is resolved — resolved
// LAZILY (not at module load) so this module stays importable without a DOM.
export function mount(node) {
  const app = document.getElementById("app");
  app.innerHTML = "";
  app.appendChild(node);
}

// After acting on a task (merge / request changes), return to its workspace's
// task list — that's the next thing you want, not the now-stale task page.
export function backToWorkspace(workspaceId) {
  location.hash = workspaceId ? "#/workspace/" + workspaceId : "#/";
}
