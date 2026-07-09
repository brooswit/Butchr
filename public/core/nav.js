// The router's LEAF surface: the `#app` mount point, hash navigation, and a re-render
// handle. Views under `views/` import from here; NOTHING here imports app.js.
//
// WHY THE `setRenderer` INDIRECTION EXISTS — do not "simplify" it away.
// A view needs to re-render the current route after it acts (a merge, a park). The route
// dispatcher lives in app.js, so the naive move is `views/x.js` importing `render` from
// app.js. ES modules technically tolerate that cycle for hoisted function declarations,
// so it looks harmless. It is not: the edge drags app.js into the module graph of every
// view, and app.js's boot touches `document` at load. `bun test` importing any view then
// dies with `ReferenceError: document is not defined`, which destroys the DOM-free-at-load
// property the whole test strategy rests on (test/kind-badge.test.ts, test/cli-helpers.test.ts,
// test/metrics-view.test.ts all import public/*.js directly). So the dependency is INVERTED:
// app.js registers its dispatcher here at boot via setRenderer(), and views import `render`
// from this module. The `views/ -> app.js` edge must never exist.
//
// This module is DOM-FREE at module load: `mount` resolves `#app` lazily inside the call,
// so importing nav.js under a non-browser runner is safe.

// The registered route dispatcher (app.js's `renderRoute`). Set once, at boot.
let renderer = null;

// Register the route dispatcher. app.js calls this at top level, before its boot `render()`.
export function setRenderer(fn) {
  renderer = fn;
}

// Re-render the current route. Delegates to the dispatcher app.js registered; RETURNS its
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
