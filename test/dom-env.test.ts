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
//      test/metrics-view.test.ts survives. This is what lets a React test file and that tripwire
//      coexist in one `bun test` process, in either order, until Phase 4e deletes the tripwire.
//
// THIS FILE IS ALSO THE REFERENCE for how a 4b–4d React test is shaped: `./dom-register.ts` first,
// React second, `afterAll(unregisterDom)` always, and queries taken from `render()` — never from
// `screen`. See dom-register.ts for why `screen` cannot work here.
import "./dom-register.ts"; // must precede every React import — installs `document`
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterAll, expect, test } from "bun:test";
import { unregisterDom } from "./dom-env.ts";

test("registerDom() installs a DOM React can mount into", () => {
  expect(typeof globalThis.document).toBe("object");

  // Queries from `render()`, NOT from `screen` — see dom-register.ts. They bind to the rendered
  // container at CALL time, so they are immune to the module-eval ordering that breaks `screen`.
  const { getByTestId } = render(createElement("p", { "data-testid": "hello" }, "phase 4a"));
  expect(getByTestId("hello").textContent).toBe("phase 4a");
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
// so a DOM left standing here is a DOM standing in test/metrics-view.test.ts, whose
// `typeof globalThis.document === "undefined"` assertion would then fail for a reason that names
// neither happy-dom nor this file. Restore unconditionally, even if a test above threw.
afterAll(async () => {
  await unregisterDom();
  if (typeof globalThis.document !== "undefined") {
    throw new Error("dom-env: unregisterDom() left a document behind — the next test file inherits it");
  }
});
