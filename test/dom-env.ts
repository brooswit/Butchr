// The REAL DOM for the test suite (RFC §9.3), and the one correction that section needed.
//
// It replaces test/dom-stub.ts, a hand-rolled ~100-line fake whose own header gave its sole
// justification as "ZERO DEPENDENCIES … the CTO explicitly rejected pulling in happy-dom/jsdom".
// The CEO ratification retired that constraint, and a stub cannot model what React Aria actually
// does — portals, focus management, overlay positioning. So: happy-dom, registered once, for the
// whole suite, exactly as RFC §9.3 recommends.
//
// >>> THE CORRECTION. <<< §9.3 says "registered via bunfig.toml's test preload" and stops there.
// Done literally, that BREAKS the server suite, and it was measured rather than reasoned:
// `GlobalRegistrator.register()` overwrites sixteen globals, and among them are the HTTP
// primitives —
//
//     fetch, Response, Request, Headers, URL, Blob, FormData, AbortController, AbortSignal
//
// happy-dom's `fetch` is a *browser* fetch built on node:http. Pointed at a `Bun.serve()` origin
// it dies with `NetworkError: … Parse Error` before the response is read. Six test files issue a
// real `fetch` against a real bun server (cli-work-routes, hier-projects-s1, input-bounding,
// projects-ceo-terminal, revamp4-project-ceo-read-routes, rfc-ceo-operating-model-north-star), and
// the preload is process-global across all ~130 files. Registering and walking away turns those
// red for a reason that names neither happy-dom nor the DOM.
//
// So we register, and then hand the network back to bun. Nothing under `public/` issues a real
// request in a test — every `api()` call is stubbed — so the browser fetch buys us nothing and
// costs us six files.
//
// What we deliberately DO NOT restore: `setTimeout`/`setInterval`/`queueMicrotask` (happy-dom
// wraps them to drive its async task manager), `Event`/`CustomEvent`/`EventTarget` (React and
// React Aria dispatch these AT happy-dom nodes, which type-check their arguments), and
// `navigator`/`location`. Nothing in `src/` reads any DOM global — grepped, not assumed — so
// giving the server suite a `document` it never looks at is inert.
//
// This is also why `test/metrics-view.test.ts`'s `expect(typeof globalThis.document)
// .toBe("undefined")` tripwire had to go (RFC §9.2): with a DOM present for every file it can
// never pass. Its real invariant — no module boots an EventSource or a fetch at import — is now
// asserted directly by test/no-side-effects-at-import.test.ts, against the thing we actually care
// about rather than a symptom of it.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/** Bun's native HTTP primitives, captured BEFORE happy-dom overwrites them. */
const NATIVE = {
  fetch: globalThis.fetch,
  Response: globalThis.Response,
  Request: globalThis.Request,
  Headers: globalThis.Headers,
  URL: globalThis.URL,
  Blob: globalThis.Blob,
  FormData: globalThis.FormData,
  AbortController: globalThis.AbortController,
  AbortSignal: globalThis.AbortSignal,
} as const;

/** Register happy-dom, then put bun's network back. Idempotent. */
export function registerDom(): void {
  if (GlobalRegistrator.isRegistered) return;
  GlobalRegistrator.register();
  for (const [name, impl] of Object.entries(NATIVE)) {
    (globalThis as Record<string, unknown>)[name] = impl;
  }
}
