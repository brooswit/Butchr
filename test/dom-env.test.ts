// Proves the Phase-4a DOM harness does the three things Phases 4b–4d depend on, and the one thing
// Phase 4a promised it would NOT do.
//
// It is a real test, not a smoke check: `registerDom()` has to be correct in a way no other test
// exercises until the first React view lands, and "we added happy-dom and nothing broke" is exactly
// the kind of claim that is true right up until it isn't. What is asserted here:
//
//   1. `registerDom()` gives React a DOM good enough to actually MOUNT a component through
//      @testing-library/react. That is the whole point of the dependency; a `document` that cannot
//      render React would pass a `typeof` check and still fail Phase 4b.
//   2. `registerDom()` leaves bun's NATIVE `fetch` in place, PROVEN against a real `Bun.serve()`
//      origin rather than by identity. happy-dom overwrites `fetch` with a browser fetch built on
//      node:http which dies with `NetworkError: … Parse Error` against a bun server — the failure
//      that would otherwise take six unrelated server test files red. An identity check (`fetch ===
//      Bun.fetch`) does NOT work: they are different function objects even before registration.
//   3. `unregisterDom()` puts `globalThis.document` back to `undefined`, so the tripwire in
//      test/vanilla-views-dom-free.test.ts survives. This is what lets a React test file and that
//      tripwire coexist in one `bun test` process, in either order, until Phase 4e deletes it.
//   4. Phase 4b added two more, both guarding test/dom-warmup.ts: react-dom's `onChange` works at
//      all, and an ASYNC state update actually flushes. Each fails silently and catastrophically if
//      react-dom first evaluated without a DOM, or against one that was then destroyed.
//
// THIS FILE IS ALSO THE REFERENCE for how a 4b–4d React test is shaped: `./dom-register.ts` first,
// React second, `afterAll(unregisterDom)` always, and queries taken from `render()` — never from
// `screen`. See dom-register.ts for why `screen` cannot work here.
import "./dom-register.ts"; // must precede every React import — installs `document`
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, useEffect, useState } from "react";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { registerDom, unregisterDom } from "./dom-env.ts";

// The import above installs a DOM only for the FIRST React file `bun test` reaches; a module's side
// effect runs once per process. See dom-register.ts. Idempotent when the DOM is already up.
beforeAll(registerDom);

test("registerDom() installs a DOM React can mount into", () => {
  expect(typeof globalThis.document).toBe("object");

  // Queries from `render()`, NOT from `screen` — see dom-register.ts. They bind to the rendered
  // container at CALL time, so they are immune to the module-eval ordering that breaks `screen`.
  const { getByTestId } = render(createElement("p", { "data-testid": "hello" }, "phase 4a"));
  expect(getByTestId("hello").textContent).toBe("phase 4a");
  cleanup();
});

// THE GUARD ON test/dom-warmup.ts, and it is not theoretical — this is exactly how it failed.
//
// react-dom decides at MODULE INIT whether the browser supports `input` events. Initialised without
// a DOM, it answers no, swaps `onChange` onto an IE8-era `propertychange` polyfill that a modern DOM
// can never trigger, and every controlled input in the app becomes untestable — while `onClick`,
// `onInput` and rendering keep working, so nothing else goes red. Deleting the warmup from the
// preload turns THIS test red, naming the flag; without it, the next React view's tests fail on a
// value assertion and the author blames @testing-library.
test("a controlled input's onChange fires (react-dom saw a DOM at module init)", () => {
  function Controlled() {
    const [text, setText] = useState("");
    return createElement("input", {
      "data-testid": "field",
      value: text,
      onChange: (e: { target: { value: string } }) => setText(e.target.value),
    });
  }
  const { getByTestId } = render(createElement(Controlled));
  const field = getByTestId("field") as HTMLInputElement;
  fireEvent.change(field, { target: { value: "typed" } });
  expect(field.value).toBe("typed");
  cleanup();
});

// THE OTHER HALF OF test/dom-warmup.ts. react-dom captures `queueMicrotask` at module init, so if it
// evaluates against the warmup's happy-dom window — which is torn down immediately after — every
// ASYNC state update is scheduled onto a dead microtask queue and never flushes. A view stays on its
// `loading` branch forever. Nothing throws; `waitFor` just times out. This is the smallest component
// that reproduces it: a promise resolved in an effect, exactly what `core/use-async.ts` does.
test("an async state update flushes (react-dom captured bun's queueMicrotask, not a dead window's)", async () => {
  function Resolving() {
    const [text, setText] = useState("pending");
    useEffect(() => {
      void Promise.resolve("resolved").then(setText);
    }, []);
    return createElement("p", null, text);
  }
  const { findByText } = render(createElement(Resolving));
  expect((await findByText("resolved")).textContent).toBe("resolved");
  cleanup();
});

// The exact failure mode registerDom()'s network restore exists to prevent: happy-dom's fetch
// cannot read a `Bun.serve()` response. If someone deletes the restore loop from dom-env.ts, this
// test goes red HERE — naming happy-dom — instead of in six server files that never mention it.
test("bun's native fetch survives registration (real Bun.serve round-trip)", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("pong") });
  try {
    const res = await fetch(`http://localhost:${server.port}/ping`);
    expect(await res.text()).toBe("pong");
  } finally {
    await server.stop(true);
  }
});

// The tripwire's survival is THIS file's responsibility. `bun test` runs every file in one process,
// so a DOM left standing here is a DOM standing in test/vanilla-views-dom-free.test.ts, whose
// `typeof globalThis.document === "undefined"` assertion would then fail for a reason that names
// neither happy-dom nor this file. Restore unconditionally, even if a test above threw.
afterAll(async () => {
  await unregisterDom();
  if (typeof globalThis.document !== "undefined") {
    throw new Error("dom-env: unregisterDom() left a document behind — the next test file inherits it");
  }
});
