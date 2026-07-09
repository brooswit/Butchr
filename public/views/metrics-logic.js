// The PURE half of the METRICS view. Split out of views/metrics.js by the RFC Phase 2 horizontal
// cut (RFC §0.1 #5): `rateSub` is the one DOM-free helper on that surface — every other builder
// there calls `el`.
//
// DOM-free OUTRIGHT: zero imports, no `document` even at call time.

// "num/of" sub-line for a rate card (or "no data" when nothing has happened yet).
// Unit-tested in test/metrics-view.test.ts.
export function rateSub(r) {
  if (!r || r.of === 0) return "no data yet";
  return `${r.num} / ${r.of}`;
}
