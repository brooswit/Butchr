// public/views/metrics.tsx — the FIRST view to render as React (RFC Phase 4b), and the first test
// in this repo to drive one through @testing-library/react against a real (happy-dom) DOM.
//
// WHAT MOVED, AND WHERE IT WENT. Until 4b this file was three things at once, because
// views/metrics.js could not be rendered without a browser:
//
//   1. THE TRIPWIRE — `typeof globalThis.document === "undefined"`, proving no module under
//      `public/` touches `document` at MODULE LOAD. It cannot live here any more: this file installs
//      a DOM on purpose. It moved VERBATIM to test/vanilla-views-dom-free.test.ts, which imports the
//      four views that are still vanilla (and so still depend on the property) plus core/nav.js.
//      The property is NOT retired — Phase 4e retires it, with the last vanilla view.
//   2. THE core/nav.js EXPORT-SURFACE GUARDS — moved to the same file, for the same reason.
//   3. `rateSub`'s unit tests — the DOM-free half (views/metrics-logic.ts). They stayed, character
//      for character. Re-pointed, not rewritten.
//
// And what it can finally do instead: RENDER THE VIEW. The old header conceded "Note what it does
// NOT prove: that renderMetrics() actually runs." It runs here.
//
// `api()` is stubbed by replacing `globalThis.fetch`, not by mocking the module: `core/api.ts` is a
// twenty-line wrapper over `fetch("/api" + path)`, so intercepting there exercises the wrapper's own
// JSON/error handling on the way through. Assign AFTER `./dom-register.ts` — registerDom() restores
// bun's native fetch as its last act, and would overwrite a stub installed before it.
import "./dom-register.ts"; // must precede every React import — installs `document`
import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { registerDom, unregisterDom } from "./dom-env.ts";
import { MetricsView } from "../public/views/metrics.js";
import { rateSub } from "../public/views/metrics-logic.js";

// The import above only installs a DOM for the FIRST React file `bun test` reaches — a module's side
// effect runs once per process, and the previous React file's `afterAll` tore it down. See
// test/dom-register.ts. `registerDom` is idempotent, so this is free when it is already up.
beforeAll(registerDom);

const nativeFetch = globalThis.fetch;

const METRICS = {
  total: 12,
  byStatus: { merged: 7, in_review: 3, failed: 1 },
  throughput: {
    days: 14,
    totalMerged: 40,
    windowMerged: 7,
    perDay: [
      { date: "2026-07-01", count: 0 },
      { date: "2026-07-02", count: 4 },
    ],
  },
  timeToReview: { medianMs: 60_000, count: 1 },
  timeToMerge: { medianMs: 120_000, count: 3 },
  conflictRate: { rate: 0.5, num: 1, of: 2 },
  revertRate: { rate: 0, num: 0, of: 7 },
  ciPassRate: { rate: 1, num: 3, of: 3 },
  autoMergeRate: { rate: null, num: 0, of: 0 },
};

const HEALTH = {
  paused: false,
  disk: {
    worktreesBytes: 2048,
    worktreeCount: 1,
    backupsBytes: 1024,
    totalBytes: 3072,
    warnBytes: 1024,
    warn: true,
  },
};

/** Route each `/api/...` path to a canned body. `null` means "this endpoint is down" — a 503, the
 *  exact shape `/health` degrades into, which the view must survive. */
function stubApi(routes: Record<string, unknown>) {
  globalThis.fetch = (async (input: string) => {
    const path = String(input).replace(/^\/api/, "");
    if (!(path in routes)) throw new Error(`unstubbed fetch: ${input}`);
    const body = routes[path];
    if (body === null) return new Response('{"error":"degraded"}', { status: 503 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(() => stubApi({ "/metrics": METRICS, "/health": HEALTH }));

afterEach(() => {
  cleanup();
  globalThis.fetch = nativeFetch;
});

// Queries come from `render()`, NEVER from `screen` — see test/dom-register.ts for why `screen` is
// permanently poisoned under bun's module ordering.
const mount = () => render(createElement(MetricsView));

test("renders the number cards from GET /api/metrics", async () => {
  const { container, findByText } = mount();
  await findByText("Metrics");

  const cards = container.querySelectorAll(".metric-card");
  expect(cards.length).toBe(12); // 9 rate/count cards + 3 disk cards

  const labelled = (label: string) =>
    [...container.querySelectorAll<HTMLElement>(".metric-card")].find(
      (c) => c.querySelector(".metric-label")!.textContent === label,
    )!;

  expect(labelled("Total tasks").querySelector(".metric-value")!.textContent).toBe("12");
  expect(labelled("Merged / last 14d").querySelector(".metric-value")!.textContent).toBe("7");
  // The sub-line is metrics-logic's rateSub — a zero denominator is "no data yet", never 0%.
  expect(labelled("Conflict rate").querySelector(".metric-sub")!.textContent).toBe("1 / 2");
  expect(labelled("Auto-merge rate").querySelector(".metric-sub")!.textContent).toBe("no data yet");
  // "1 sample", not "1 samples" — the singular is a real branch.
  expect(labelled("Median time to review").querySelector(".metric-sub")!.textContent).toBe("1 sample");
  expect(labelled("Median time to merge").querySelector(".metric-sub")!.textContent).toBe("3 samples");
});

test("throughput sparkline scales bar heights to the busiest day and titles each column", async () => {
  const { container, findByText } = mount();
  await findByText("Metrics");

  const bars = [...container.querySelectorAll<HTMLElement>(".spark-bar")];
  expect(bars.length).toBe(2);
  // A zero day is a 2% baseline stub AND carries `.zero`; the max day is the full 100%.
  expect(bars[0].className).toContain("zero");
  expect(bars[0].style.height).toBe("2%");
  expect(bars[1].className).not.toContain("zero");
  expect(bars[1].style.height).toBe("100%");
  expect(bars[1].getAttribute("title")).toBe("2026-07-02: 4 merged");

  const axis = container.querySelectorAll(".spark-axis span");
  expect([...axis].map((s) => s.textContent)).toEqual(["2026-07-01", "2026-07-02"]);
});

// The 14 status colours are the reason the chips stay CUSTOM (CTO decision 7): the bar's fill class
// IS the status, so `.sb-fill.merged` and `.sb-fill.failed` resolve to different custom properties.
test("status bars sort by count, key the fill on the status, and scale to the largest", async () => {
  const { container, findByText } = mount();
  await findByText("Metrics");

  const rows = [...container.querySelectorAll(".status-bar-row")];
  expect(rows.length).toBe(3);

  const fills = rows.map((r) => r.querySelector<HTMLElement>(".sb-fill")!);
  expect(fills.map((f) => f.className)).toEqual(["sb-fill merged", "sb-fill in_review", "sb-fill failed"]);
  expect(fills[0].style.width).toBe("100%"); // 7 of 7
  expect(fills[1].style.width).toBe("43%"); // 3 of 7
  expect(fills[2].style.width).toBe("14%"); // 1 of 7
  expect(rows.map((r) => r.querySelector(".sb-count")!.textContent)).toEqual(["7", "3", "1"]);

  // Each row's label is a StatusChip — a `<span class="chip <status>">`, not a LaunchPad `Tag`.
  const chips = rows.map((r) => r.querySelector(".sb-label .chip")!);
  expect(chips.map((c) => c.className)).toEqual(["chip merged", "chip in_review", "chip failed"]);
});

test("an empty byStatus renders the empty-state, not a bar chart of nothing", async () => {
  stubApi({ "/metrics": { ...METRICS, byStatus: {} }, "/health": HEALTH });
  const { container, findByText } = mount();
  await findByText("No tasks yet.");
  expect(container.querySelector(".status-bars")).toBeNull();
});

test("disk readout renders the over-threshold badge off /health's disk object", async () => {
  const { container, findByText } = mount();
  await findByText("Metrics");

  const badge = container.querySelector(".disk-warn-badge")!;
  expect(badge.textContent).toBe("over threshold");
  expect(badge.getAttribute("title")).toContain("advisory threshold");

  const labels = [...container.querySelectorAll(".metric-label")].map((l) => l.textContent);
  expect(labels).toContain("Task worktrees");
  expect(labels).toContain("DB backups");
});

// A degraded /health (503) is NOT the view's failure. The vanilla version wrapped that fetch in its
// own try/catch and skipped the readout; the React one catches the rejection inside the fetch thunk
// for the same reason. If this ever regresses, the whole page goes to "error:".
test("a degraded /health drops the disk readout and paints everything else", async () => {
  stubApi({ "/metrics": METRICS, "/health": null });
  const { container, findByText } = mount();
  await findByText("Metrics");

  expect(container.querySelector(".disk-warn-badge")).toBeNull();
  expect(container.textContent).not.toContain("Disk usage");
  expect(container.querySelectorAll(".metric-card").length).toBe(9); // the 3 disk cards are gone
  expect(container.querySelector(".status-bars")).not.toBeNull();
});

// A view that threw painted `<div class="empty">error: …</div>` and nothing else. That is `useAsync`'s
// `error` branch now, and it must carry the SERVER's message, not "Service Unavailable".
test("a failed /api/metrics paints the empty-state error line", async () => {
  stubApi({ "/metrics": null, "/health": HEALTH });
  const { container } = mount();
  await waitFor(() => expect(container.querySelector(".empty")).not.toBeNull());
  expect(container.querySelector(".empty")!.textContent).toBe("error: degraded");
  expect(container.querySelector("h1")).toBeNull();
});

// ---------- the DOM-free half: views/metrics-logic.ts ----------
// Unchanged from the pre-React file. `rateSub` never needed a DOM and still doesn't.

test("rateSub renders a rate's raw numerator/denominator", () => {
  expect(rateSub({ rate: 0.5, num: 1, of: 2 })).toBe("1 / 2");
  expect(rateSub({ rate: 0, num: 0, of: 7 })).toBe("0 / 7");
});

test("rateSub says 'no data yet' when nothing has happened", () => {
  expect(rateSub(null)).toBe("no data yet");
  expect(rateSub(undefined)).toBe("no data yet");
  // A zero denominator is "no data", NOT a division-by-zero rate.
  expect(rateSub({ rate: null, num: 0, of: 0 })).toBe("no data yet");
});

// `bun test` runs every file in one process, so a DOM left standing here is a DOM standing in
// test/vanilla-views-dom-free.test.ts, whose tripwire would then fail for a reason that names
// neither happy-dom nor this file. Restore unconditionally, even if a test above threw.
afterAll(async () => {
  globalThis.fetch = nativeFetch;
  await unregisterDom();
});
