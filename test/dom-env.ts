// A REAL DOM for the test suite (RFC §9.3), available on request.
//
// It is the eventual replacement for test/dom-stub.ts, a hand-rolled ~100-line fake whose own header
// gives its sole justification as "ZERO DEPENDENCIES … the CTO explicitly rejected pulling in
// happy-dom/jsdom". The CEO ratification retired that constraint (CTO decision 4 approved these four
// devDependencies), and a stub cannot model what React Aria actually does — portals, focus
// management, overlay positioning. So: happy-dom.
//
// >>> IT DOES NOT REGISTER ITSELF, AND `test/test-setup.ts` DOES NOT CALL IT. <<<
// RFC §9.3 says "registered via bunfig.toml's test preload" and stops there. Done literally, in THIS
// phase, that breaks the suite in two separate ways. Both were measured, not reasoned about.
//
// (1) THE TRIPWIRE. `test/metrics-view.test.ts` asserts `typeof globalThis.document === "undefined"`
//     between tests — the guard proving no module under `public/` touches `document` at MODULE LOAD.
//     `bun test` runs every file in ONE process, so a preload that registers happy-dom defines
//     `document` for the whole run and that assertion can never pass again. §9.3's plan assumes the
//     tripwire is already gone. It is not: the vanilla views still rely on it, and it is Phase 4e's
//     to retire, after they are deleted.
//
// (2) THE NETWORK. `GlobalRegistrator.register()` overwrites sixteen globals, among them the HTTP
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
// HOW A TEST OPTS IN (from Phase 4b, when the first React view lands):
//
//     import { registerDom, unregisterDom } from "./dom-env.ts";
//     beforeAll(registerDom);
//     afterAll(unregisterDom);
//
// The install/restore pair is the SAME discipline dom-stub.ts's `withDom()` already enforces, and
// for the same reason: `document` must not survive the file that asked for it, or the next file to
// run inherits it. `unregisterDom` is what lets a React test and the tripwire coexist until 4e.
//
// What `registerDom` deliberately does NOT restore: `setTimeout`/`setInterval`/`queueMicrotask`
// (happy-dom wraps them to drive its async task manager), `Event`/`CustomEvent`/`EventTarget`
// (React and React Aria dispatch these AT happy-dom nodes, which type-check their arguments), and
// `navigator`/`location`.
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

/** Register happy-dom, then put bun's network back. Idempotent. */
export function registerDom(): void {
  if (GlobalRegistrator.isRegistered) return;
  GlobalRegistrator.register();
  for (const [name, impl] of Object.entries(NATIVE)) {
    (globalThis as unknown as Record<string, unknown>)[name] = impl;
  }
}

/** Tear the DOM back down so `globalThis.document` is undefined again. Idempotent.
 *  Pair it with `registerDom` in an `afterAll`, or the next test FILE inherits a `document`. */
export async function unregisterDom(): Promise<void> {
  if (!GlobalRegistrator.isRegistered) return;
  await GlobalRegistrator.unregister();
}
