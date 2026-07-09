// Guards for the FIRST extracted view (public/views/metrics.js) and its leaf router
// (public/core/nav.js), landed by the Phase 2 module split.
//
// WHAT THIS PROTECTS. `bun build public/app.js` resolves import paths and catches importing
// a name a module does not export, but it CANNOT see a free identifier inside a function
// body — a symbol left behind by a botched extraction is a runtime ReferenceError, i.e. a
// blank dashboard that ships green. There is no browser test coverage. So the cheapest real
// guard is: import the modules for effect and prove they LOAD without a DOM.
//
// That load-without-a-DOM property is the whole reason nav.js exists. If anyone ever adds a
// `views/ -> app.js` import, app.js's boot (`document`-touching) enters this module graph and
// THESE IMPORTS THROW `ReferenceError: document is not defined`. This file is the tripwire.
//
// Note what it does NOT prove: that renderMetrics() actually runs. It builds DOM via `el` and
// fetches over the network, so it is not exercised here. Only `rateSub` is pure and DOM-free, and
// since the RFC Phase 2 horizontal split it lives in the DOM-free leaf views/metrics-logic.js.
// views/metrics.js is still imported FOR EFFECT — dropping it would quietly retire the tripwire
// this whole file exists to be.
import { expect, test } from "bun:test";
import "../public/views/metrics.js";
import { rateSub } from "../public/views/metrics-logic.js";
import * as nav from "../public/core/nav.js";

test("views/metrics.js and core/nav.js load with no DOM present", () => {
  // A DOM-free load is the tripwire: reaching this line at all means neither module (nor
  // anything in their import graphs) touched `document` at module scope.
  expect(typeof globalThis.document).toBe("undefined");
  expect(typeof rateSub).toBe("function");
});

test("core/nav.js exports the router leaf surface", () => {
  for (const name of ["mount", "backToWorkspace", "render", "setRenderer"]) {
    expect(typeof nav[name as keyof typeof nav]).toBe("function");
  }
  // `current` was write-only dead state in app.js and was deleted, not moved. nav.js must not
  // resurrect it: a route-state export would be a public API around a value nothing reads.
  expect("current" in nav).toBe(false);
  expect("setCurrent" in nav).toBe(false);
});

test("nav.render() before setRenderer() fails loudly rather than silently", () => {
  // The delegator is registered by app.js at boot. Importing nav.js in isolation leaves it
  // unset, so a stray call must throw a named error, not a bare `renderer is not a function`.
  expect(() => nav.render()).toThrow(/setRenderer/);
});

test("rateSub renders a rate's raw numerator/denominator", () => {
  expect(rateSub({ num: 1, of: 2 })).toBe("1 / 2");
  expect(rateSub({ num: 0, of: 7 })).toBe("0 / 7");
});

test("rateSub says 'no data yet' when nothing has happened", () => {
  expect(rateSub(null)).toBe("no data yet");
  expect(rateSub(undefined)).toBe("no data yet");
  // A zero denominator is "no data", NOT a division-by-zero rate.
  expect(rateSub({ num: 0, of: 0 })).toBe("no data yet");
});
