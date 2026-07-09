// A REAL DOM for the test suite (RFC §9.3). Registered ONCE from `test/test-setup.ts`'s preload and
// left standing for the whole `bun test` process.
//
// It replaced test/dom-stub.ts, a hand-rolled ~100-line fake whose own header gave its sole
// justification as "ZERO DEPENDENCIES … the CTO explicitly rejected pulling in happy-dom/jsdom". The
// CEO ratification retired that constraint (CTO decision 4 approved these four devDependencies), and
// a stub cannot model what React Aria actually does — portals, focus management, overlay
// positioning. So: happy-dom. dom-stub.ts was deleted in Phase 4e.
//
// >>> PHASE 4e MOVED REGISTRATION INTO THE PRELOAD, WHICH IS WHERE §9.3 ALWAYS WANTED IT. <<<
// Through Phase 4d it could not go there, for one reason that has now expired and one that has not.
// Both were measured, not reasoned about.
//
// (1) THE TRIPWIRE — EXPIRED. `test/vanilla-views-dom-free.test.ts` asserted `typeof
//     globalThis.document === "undefined"`, the guard proving no module under `public/` touched
//     `document` at MODULE LOAD. `bun test` runs every file in ONE process, so a preload that
//     registers happy-dom defines `document` for the whole run and that assertion could never pass
//     again. §9.3's plan assumed the tripwire was already gone. Phase 4e deleted the vanilla views it
//     protected, and the tripwire with them — so `registerDom()` finally lives in the preload, and
//     `unregisterDom()` has exactly one caller left (test/dom-env.test.ts, which proves it works).
//
// (2) THE NETWORK — STILL TRUE, AND THIS IS WHY THIS MODULE IS NOT ONE LINE.
//     `GlobalRegistrator.register()` overwrites sixteen globals, among them the HTTP
//     primitives — fetch, Response, Request, Headers, URL, Blob, FormData, AbortController,
//     AbortSignal. happy-dom's `fetch` is a *browser* fetch built on node:http; pointed at a
//     `Bun.serve()` origin it dies with `NetworkError: … Parse Error` before the response is read.
//     Six test files issue a real `fetch` against a real bun server (cli-work-routes,
//     hier-projects-s1, input-bounding, projects-ceo-terminal, revamp4-project-ceo-read-routes,
//     rfc-ceo-operating-model-north-star). Registering process-wide and walking away turns those red
//     for a reason that names neither happy-dom nor the DOM. So `registerDom` hands the network back
//     to bun immediately. Nothing under `public/` issues a real request in a test — every `api()`
//     call is stubbed — so the browser fetch buys us nothing and costs us six files.
//
// A TEST NO LONGER OPTS IN. It renders. There is nothing to import and no hook to remember, because
// the preload has already run. `unregisterDom` is kept for the one test that asserts the round-trip.
//
// What `registerDom` deliberately does NOT restore: `setTimeout`/`setInterval`/`queueMicrotask`
// (happy-dom wraps them to drive its async task manager), `Event`/`CustomEvent`/`EventTarget`
// (React and React Aria dispatch these AT happy-dom nodes, which type-check their arguments), and
// `navigator`/`location`.
//
// THOSE TIMER WRAPPERS ARE NOW PROCESS-GLOBAL, and Phase 4e made that trade with its eyes open.
// Through 4d only a React file ran under them; now all ~150 do. It is safe precisely BECAUSE the
// window is never torn down — the wrappers delegate to the real timers and drive a task manager that
// stays alive for the life of the process. The failure this replaces is react-dom capturing a
// DESTROYED window's `queueMicrotask` and then silently never flushing an async state update again:
// that is what test/dom-warmup.ts existed to prevent, and why 4e could delete it rather than move
// it. Measured, not assumed — the full suite is green and no slower.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/** Bun's native HTTP primitives, captured at import — BEFORE happy-dom can overwrite them. */
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

/** Register happy-dom, then put bun's network back. Idempotent. Called once, from the preload. */
export function registerDom(): void {
  if (GlobalRegistrator.isRegistered) return;
  GlobalRegistrator.register();
  for (const [name, impl] of Object.entries(NATIVE)) {
    (globalThis as unknown as Record<string, unknown>)[name] = impl;
  }
}

// >>> THERE IS NO `unregisterDom`, AND ADDING ONE BACK WILL BREAK THE SUITE SILENTLY. <<<
//
// Phase 4e deleted it, and not merely because the tripwire that needed it is gone. It is NOT SAFE to
// call once react-dom has evaluated, and this was measured — the first cut of 4e kept it, exercised
// the round-trip in test/dom-env.test.ts, and took SEVEN metrics-view tests red with an empty
// container and no error message.
//
// `GlobalRegistrator.unregister()` destroys the window. A subsequent `register()` builds a NEW one
// with NEW `queueMicrotask` / `setTimeout` wrappers bound to it — but react-dom captured the OLD
// window's `scheduleMicrotask` at module init and never looks again. Every async state update after
// that is scheduled onto a dead queue: `useAsync` resolves, `setState` is scheduled, nothing flushes,
// and the view sits on `loading: true` forever while `waitFor` times out. It is exactly the failure
// test/dom-warmup.ts's header described, arriving from the other direction.
//
// So the DOM is installed ONCE, by test/test-setup.ts, and never torn down. If you need to assert
// something about a torn-down DOM, do it in a subprocess.
