// EVALUATE react-dom WHILE A DOM EXISTS, ONCE, BEFORE ANY TEST FILE LOADS — THEN TAKE THE DOM AWAY.
//
// This is a preload step (test/test-setup.ts imports it) and it looks absurd until you know what it
// buys. Measured in RFC Phase 4b, from `fireEvent.change()` silently doing nothing.
//
// react-dom's CJS bundle computes TWO feature flags at MODULE INIT and never revisits them:
//
//     canUseDOM = !(typeof window === "undefined" || typeof window.document === "undefined" || …)
//     canUseDOM && (isInputEventSupported = isEventSupported("input") && …)
//
// (node_modules/react-dom/cjs/react-dom-client.development.js — search `isInputEventSupported`.)
// When `isInputEventSupported` is false, react-dom's ChangeEventPlugin swaps `onChange` onto an
// IE8-era polyfill that watches `focusin` + `propertychange`. Under a modern DOM that polyfill can
// never fire, so **every `onChange` handler in every React component is dead** while `onClick`,
// `onInput` and rendering all work perfectly. A controlled `<input>`/`<textarea>` test then fails on
// an assertion about its VALUE, naming neither react-dom nor happy-dom.
//
// And react-dom initialises with no DOM, no matter what a test file does, because of the same module
// -ordering fact test/dom-register.ts documents for `screen`: `@testing-library/react` is CJS, bun
// hoists that graph ABOVE an ESM side-effect import, so `import "./dom-register.ts"` on line 1 still
// evaluates AFTER react-dom. The only hook that runs earlier than any import is the preload.
//
// So: register happy-dom, force react-dom to evaluate against it, and unregister. The flags stay
// true for the whole process; `globalThis.document` goes back to `undefined`, which is what
// test/vanilla-views-dom-free.test.ts's tripwire and the ~130 DOM-free test files require. Each
// React test file still calls `registerDom()` for a real DOM of its own.
//
// Phase 4e — when the last vanilla view is gone and the tripwire with it — replaces this whole file
// with a plain `registerDom()` in the preload, which needs no warmup because it never leaves.
// >>> AND react-dom CAPTURES ITS TIMERS AT MODULE INIT TOO. THIS IS THE OTHER HALF. <<<
// `scheduleMicrotask = typeof queueMicrotask === "function" ? queueMicrotask : …` — a reference, not
// a lookup. happy-dom REPLACES `queueMicrotask` / `setTimeout` / `setInterval` with wrappers bound to
// the window it just created, and test/dom-env.ts deliberately does not restore them (React Aria
// needs happy-dom's async task manager while a test runs). If react-dom evaluates during the warmup
// it would capture the WARMUP WINDOW's wrappers — and `unregisterDom()` tears that window down two
// lines later. React would then render synchronously and never flush an async state update again:
// `useAsync` resolves, `setState` is scheduled onto a dead microtask queue, and the view sits on
// `loading: true` forever. Measured: it cost seven metrics-view tests and no error message.
//
// So the warmup registers a DOM for the FEATURE FLAGS, hands the TIMERS back to bun before react-dom
// looks at them, and only then imports it. React ends up with happy-dom's `document` (transiently,
// which is all it needed) and bun's scheduling (permanently, which is what it must have).
import { registerDom, unregisterDom } from "./dom-env.ts";

/** Bun's own scheduling primitives, captured before happy-dom can wrap them. */
const TIMERS = {
  queueMicrotask: globalThis.queueMicrotask,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
} as const;

registerDom();
for (const [name, impl] of Object.entries(TIMERS)) {
  (globalThis as unknown as Record<string, unknown>)[name] = impl;
}

// Both specifiers, because react-dom and react-dom/client are separate module records and the flags
// live in whichever bundle @testing-library/react pulls. Awaited so they are fully evaluated before
// the DOM goes away.
await import("react-dom");
await import("react-dom/client");
await unregisterDom();

if (typeof globalThis.document !== "undefined") {
  throw new Error("dom-warmup: the DOM survived the preload — every DOM-free test file inherits it");
}
