// Story st-04869886 (S5): the project-detail CEO-agent card. This guards the two PURE,
// DOM-free helpers that decide what the card SAYS — ceoStatusPill (the status pill) and
// ceoNote (the honest global-gate note). Feature #4 lives or dies on the note being
// honest, so the whole {enabled, overridden, globalGate, live} matrix is asserted here:
// isCeoEnabled makes an explicit override WIN over the global gate, so an explicit-ON CEO
// runs REGARDLESS of the gate and must NEVER be labeled inert.
//
// The two PURE helpers now live in public/views/projects-logic.js — the DOM-free leaf of the RFC
// Phase 2 horizontal split — and ceoNote, which returns a NODE, in public/views/projects.js, which
// is DOM-free at module load (it touches `document` only inside a called function and imports only
// leaves). We IMPORT both directly and assert on the real exports. (This test used to scrape a
// `// <test-extract:projects-ceo-status>` sentinel block out of the classic public/app.js script
// and eval it with `new Function`, because that script could not be imported; app.js is now the
// router + bootstrap alone and that harness is gone along with the sentinel. Do not reintroduce
// one. Same approach as test/kind-badge.test.ts / test/graph-rollup-completion.test.ts.)
//
// ceoNote used to be `ceoNoteHtml` and returned a markup STRING (or "" for the no-note case); it
// now builds and returns a NODE (or null), so the note tests run inside withDom(). ceoStatusPill
// and ceoTerminalBtnState stay pure data and need no DOM.
//
// >>> WHY `surface()` READS className AND textContent, NOT JUST textContent. <<<
// These assertions are NOT uniform, and narrowing them is a silent regression:
//   • `.toContain("ceo-note inherit")` matches a CLASS, never any rendered text.
//   • The NEGATIVE assertions (`not.toContain("inert")`, `not.toContain("stay disabled")`) and the
//     whole-matrix invariant at the bottom used to scan the entire serialized markup string. Point
//     them at textContent alone and they still PASS — vacuously — while no longer covering the
//     class they were written to test. A test that passes for the wrong reason is worse than a
//     deleted one.
// So `surface()` reproduces the old string's coverage: class list + rendered text, lowercased.
// It walks the node tree directly; there is no markup-serializing helper to reach for (htmlOf() is
// deleted) and the DOM stub deliberately has no `innerHTML`.
import { expect, test } from "bun:test";
import { withDom } from "./dom-stub";
import { ceoNote } from "../public/views/projects.js";
import { ceoStatusPill, ceoTerminalBtnState } from "../public/views/projects-logic.js";

// The assertable surface of a note node: everything the old markup string exposed.
// `null` (the no-note case) has no surface at all.
function surface(node: any): string {
  if (!node) return "";
  return `${node.className} ${node.textContent}`.toLowerCase();
}

// --- status pill (live > enabled > default/disabled) -------------------------------------
test("pill: live wins → green 'CEO live'", () => {
  const p = ceoStatusPill({ enabled: true, overridden: true, globalGate: true, live: true });
  expect(p).toEqual({ cls: "live", label: "CEO live" });
});

test("pill: enabled-but-not-live → blue 'CEO enabled'", () => {
  const p = ceoStatusPill({ enabled: true, overridden: true, globalGate: true, live: false });
  expect(p).toEqual({ cls: "enabled", label: "CEO enabled" });
});

test("pill: disabled while INHERITING reads the neutral 'CEO default' (not 'disabled')", () => {
  const p = ceoStatusPill({ enabled: false, overridden: false, globalGate: false, live: false });
  expect(p.cls).toBe("inactive");
  expect(p.label).toBe("CEO default");
  expect(p.title).toContain("BUTCHR_CEO_AGENT");
});

test("pill: EXPLICITLY disabled reads 'CEO disabled'", () => {
  const p = ceoStatusPill({ enabled: false, overridden: true, globalGate: true, live: false });
  expect(p).toEqual({ cls: "disabled", label: "CEO disabled" });
});

// --- honest gate note (the crux of feature #4) -------------------------------------------
// `BUTCHR_CEO_AGENT` is a real <code> child, so textContent still concatenates each note into
// one uninterrupted sentence — which is what the phrase assertions below match against.
test("note: INHERITING + gate OFF → the gate bites; points at the override, never 'saved but inert'", () => {
  withDom(() => {
    const n = ceoNote({ enabled: false, overridden: false, globalGate: false, live: false });
    expect(n.textContent).toContain("global CEO gate");
    expect(n.textContent).toContain("BUTCHR_CEO_AGENT");
    expect(n.textContent).toContain("inherit the default stay disabled");
    expect(n.textContent).toContain("override");
    expect(surface(n)).not.toContain("inert");
  });
});

test("note: INHERITING + gate ON → inheriting-the-default context (no warning)", () => {
  withDom(() => {
    const n = ceoNote({ enabled: true, overridden: false, globalGate: true, live: false });
    expect(n.textContent).toContain("Inheriting the global default");
    expect(n.textContent).toContain("BUTCHR_CEO_AGENT");
    // a CLASS, not text — the neutral (non-warning) variant
    expect(n.className).toContain("ceo-note inherit");
  });
});

test("note: OVERRIDDEN-ON while gate OFF → runs via override; NEVER implies inert", () => {
  withDom(() => {
    const n = ceoNote({ enabled: true, overridden: true, globalGate: false, live: true });
    expect(n.textContent).toContain("per-project override");
    expect(n.textContent).toContain("runs regardless");
    expect(surface(n)).not.toContain("inert");
    expect(surface(n)).not.toContain("stay disabled");
  });
});

test("note: OVERRIDDEN-OFF → explicitly disabled for this project", () => {
  withDom(() => {
    const n = ceoNote({ enabled: false, overridden: true, globalGate: true, live: false });
    expect(n.textContent).toContain("Explicitly disabled for this project");
  });
});

test("note: OVERRIDDEN-ON while gate ON → no note (unambiguous)", () => {
  withDom(() => {
    // was `.toBe("")` while this returned a markup string; the no-note case is now a null node
    expect(ceoNote({ enabled: true, overridden: true, globalGate: true, live: true })).toBe(null);
  });
});

// --- Open-CEO-terminal button gating (mirrors the CTO terminal affordance) ---------------
// Unlike the CTO button (hidden when not running), this stays visible but disables when there's
// no live pane, with an honest title reflecting WHY — consistent with ceoNote's wording.
test("term: live → enabled", () => {
  const b = ceoTerminalBtnState({ enabled: true, overridden: true, globalGate: true, live: true });
  expect(b.enabled).toBe(true);
  expect(b.title.toLowerCase()).toContain("live");
});

test("term: enabled-but-not-live → disabled, 'starting' hint", () => {
  const b = ceoTerminalBtnState({ enabled: true, overridden: true, globalGate: true, live: false });
  expect(b.enabled).toBe(false);
  expect(b.title.toLowerCase()).toContain("starting");
});

test("term: explicitly disabled for the project → disabled, points at enabling it", () => {
  const b = ceoTerminalBtnState({ enabled: false, overridden: true, globalGate: true, live: false });
  expect(b.enabled).toBe(false);
  expect(b.title.toLowerCase()).toContain("disabled for this project");
});

test("term: inheriting while the global gate is OFF → disabled, names the gate", () => {
  const b = ceoTerminalBtnState({ enabled: false, overridden: false, globalGate: false, live: false });
  expect(b.enabled).toBe(false);
  expect(b.title).toContain("BUTCHR_CEO_AGENT");
});

// Whole matrix: the button is enabled IF AND ONLY IF the CEO is live, and every disabled state
// carries a non-empty honest hint.
test("term: enabled iff live, and never disabled without a hint", () => {
  for (const enabled of [true, false]) {
    for (const overridden of [true, false]) {
      for (const globalGate of [true, false]) {
        for (const live of [true, false]) {
          const b = ceoTerminalBtnState({ enabled, overridden, globalGate, live });
          expect(b.enabled).toBe(live);
          expect(b.title.length).toBeGreaterThan(0);
        }
      }
    }
  }
});

// Global invariant across the ENTIRE matrix: whenever the CEO is actually enabled, the note
// must never contain a disabling/inert phrase (the exact mislabel the operator flagged).
// Scans surface() — class + text — exactly as it once scanned the whole markup string.
test("invariant: an ENABLED CEO is never described as inert/disabled anywhere in the matrix", () => {
  withDom(() => {
    for (const overridden of [true, false]) {
      for (const globalGate of [true, false]) {
        for (const live of [true, false]) {
          // Only REALIZABLE states: when INHERITING (overridden=false) the server resolves
          // enabled === globalGate (isCeoEnabled falls back to the gate), so enabled=true while
          // inheriting a false gate is impossible and not worth asserting.
          if (!overridden && !globalGate) continue;
          const s = surface(ceoNote({ enabled: true, overridden, globalGate, live }));
          expect(s).not.toContain("inert");
          expect(s).not.toContain("stay disabled");
          expect(s).not.toContain("explicitly disabled");
        }
      }
    }
  });
});
