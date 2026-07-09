// Proves the DOM harness does the four things the React suite depends on, and the one thing it must
// never do to its neighbours.
//
// It is a real test, not a smoke check: `registerDom()` has to be correct in a way no other test
// exercises directly, and "we added happy-dom and nothing broke" is exactly the kind of claim that is
// true right up until it isn't. What is asserted here:
//
//   1. The suite preload gave React a DOM good enough to actually MOUNT a component through
//      @testing-library/react. A `document` that cannot render React would pass a `typeof` check and
//      still fail every view test.
//   2. `registerDom()` leaves bun's NATIVE `fetch` in place, PROVEN against a real `Bun.serve()`
//      origin rather than by identity. happy-dom overwrites `fetch` with a browser fetch built on
//      node:http which dies with `NetworkError: … Parse Error` against a bun server — the failure
//      that would otherwise take six unrelated server test files red. An identity check (`fetch ===
//      Bun.fetch`) does NOT work: they are different function objects even before registration.
//   3. react-dom's `onChange` works at all, and an ASYNC state update actually flushes. Each fails
//      silently and catastrophically if react-dom first evaluated without a DOM, or against one that
//      was then destroyed. Through Phase 4d these guarded test/dom-warmup.ts's register-evaluate-
//      unregister dance. 4e deleted that file: the preload's DOM is never torn down, so react-dom
//      caches the feature flags and the microtask queue of a window that outlives the process. These
//      two tests are what prove that reasoning, and they are why deleting the warmup was safe.
//   4. `registerDom()` is idempotent. It is called once from the preload; a second call must not
//      build a second window.
//
// >>> THE DOM IS THE SUITE'S, NOT THIS FILE'S. <<< Through 4d every React file installed its own DOM
// and tore it down in `afterAll`, because test/vanilla-views-dom-free.test.ts asserted `document` was
// undefined. That tripwire is retired (RFC §9.3, CTO decision 4) and the polarity has INVERTED: `bun
// test` runs every file in one process, so a DOM torn down here is a DOM missing from every file that
// runs after this one. There is no teardown — `unregisterDom` was deleted, and dom-env.ts explains
// why re-adding it breaks the suite in a way nothing reports.
//
// THIS FILE IS ALSO THE REFERENCE for how a React test in this suite is shaped: import React, render,
// take your queries from `render()` — never from `screen` (see test/test-setup.ts). No DOM ceremony.
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, useEffect, useState } from "react";
import { expect, test } from "bun:test";
import { registerDom } from "./dom-env.ts";

test("the suite preload installed a DOM React can mount into", () => {
  expect(typeof globalThis.document).toBe("object");

  // Queries from `render()`, NOT from `screen` — see test/test-setup.ts. They bind to the rendered
  // container at CALL time, so they are immune to the module-eval ordering that poisons `screen`.
  const { getByTestId } = render(createElement("p", { "data-testid": "hello" }, "phase 4e"));
  expect(getByTestId("hello").textContent).toBe("phase 4e");
  cleanup();
});

// THE GUARD ON THE PRELOAD'S DOM BEING PERMANENT, and it is not theoretical — this is exactly how it
// failed back when a DOM was installed and then removed.
//
// react-dom decides at MODULE INIT whether the browser supports `input` events. Initialised without a
// DOM, it answers no, swaps `onChange` onto an IE8-era `propertychange` polyfill that a modern DOM can
// never trigger, and every controlled input in the app becomes untestable — while `onClick`,
// `onInput` and rendering keep working, so nothing else goes red. Remove `registerDom()` from the
// preload and THIS test goes red, naming the flag; without it, the next React view's tests fail on a
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

// THE OTHER HALF. react-dom captures `queueMicrotask` at module init, so if it ever evaluates against
// a window that is subsequently torn down, every ASYNC state update is scheduled onto a dead microtask
// queue and never flushes. A view stays on its `loading` branch forever. Nothing throws; `waitFor`
// just times out. This is the smallest component that reproduces it: a promise resolved in an effect,
// exactly what `core/use-async.ts` does. It passes because the preload's window is permanent.
test("an async state update flushes (react-dom captured a live window's queueMicrotask)", async () => {
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

// The exact failure mode registerDom()'s network restore exists to prevent: happy-dom's fetch cannot
// read a `Bun.serve()` response. If someone deletes the restore loop from dom-env.ts, this test goes
// red HERE — naming happy-dom — instead of in six server files that never mention it.
test("bun's native fetch survives registration (real Bun.serve round-trip)", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("pong") });
  try {
    const res = await fetch(`http://localhost:${server.port}/ping`);
    expect(await res.text()).toBe("pong");
  } finally {
    await server.stop(true);
  }
});

// `registerDom()` is IDEMPOTENT, and the preload already called it. Calling it again must be a no-op
// rather than a re-registration — a second `GlobalRegistrator.register()` would build a new window
// while react-dom keeps scheduling onto the old one's microtask queue, and every async state update
// in every file after this one would stop flushing. Silently. See test/dom-env.ts.
test("registerDom() is idempotent — a second call does not replace the window", () => {
  const before = globalThis.document;
  registerDom();
  expect(globalThis.document).toBe(before);

  // Still a working DOM, and still bun's fetch.
  const { getByTestId } = render(createElement("p", { "data-testid": "same" }, "same window"));
  expect(getByTestId("same").textContent).toBe("same window");
  cleanup();
});
