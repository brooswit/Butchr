// THE TRIPWIRE, and the core/nav.js export-surface guards. Both lived in test/metrics-view.test.ts
// until RFC Phase 4b turned that file into a React test with a real DOM. Neither could stay there;
// neither is retired. This is where they wait for Phase 4e.
//
// WHAT THIS PROTECTS. `bun build` resolves import paths and catches importing a name a module does
// not export, but it CANNOT see a free identifier inside a function body — a symbol left behind by a
// botched extraction is a runtime ReferenceError, i.e. a blank dashboard that ships green. So the
// cheapest real guard is: import the still-vanilla modules FOR EFFECT and prove they LOAD without a
// DOM. Reaching the first assertion at all means nothing in their import graphs touched `document`
// at module scope.
//
// That load-without-a-DOM property is the whole reason core/nav.js exists. If anyone ever adds a
// `views/ -> App.tsx` import, the React entry's graph (`document`, React, a stylesheet) enters this
// module graph and THESE IMPORTS THROW. It is also the property the whole vanilla test strategy
// rests on — test/kind-badge.test.ts, test/cli-helpers.test.ts and test/state-meta-fallback.test.ts
// all import `public/*.js` directly under a runner with no browser.
//
// The four views below are the ones that are STILL VANILLA at Phase 4b. views/metrics.js is gone
// (views/metrics.tsx replaced it); views/diff.js is here because renderTask still calls it. As each
// migrates, drop it from this list. When the list is empty, delete this file, delete `unregisterDom`
// from every React test's `afterAll`, and move `registerDom()` into test/test-setup.ts's preload —
// that is Phase 4e, and this comment is the checklist.
//
// >>> DO NOT ADD A REACT IMPORT TO THIS FILE. <<< @testing-library/react and public/*.tsx both want
// a `document` at import time; either one would make the tripwire assert against a DOM it installed
// itself, which is the failure mode it exists to catch.
import { expect, test } from "bun:test";
import "../public/views/diff.js";
import "../public/views/projects.js";
import "../public/views/swimlanes.js";
import "../public/views/task.js";
import "../public/views/workspace.js";
import * as nav from "../public/core/nav.js";

test("the still-vanilla views and core/nav.js load with no DOM present", () => {
  // A DOM-free load is the tripwire: reaching this line means neither the four views nor anything in
  // their import graphs touched `document` at module scope. A React test file that forgot its
  // `afterAll(unregisterDom)` also fails HERE, naming the property it broke.
  expect(typeof globalThis.document).toBe("undefined");
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
  // The delegator is registered by bridge.tsx at module load. Importing nav.js in isolation leaves
  // it unset, so a stray call must throw a named error, not a bare `renderer is not a function`.
  expect(() => nav.render()).toThrow(/setRenderer/);
});
