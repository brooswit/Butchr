// Story st-04869886 (S5): the project-detail CEO-agent card. This guards the two PURE,
// DOM-free helpers that decide what the card SAYS — ceoStatusPill (the status pill) and
// ceoNoteHtml (the honest global-gate note). Feature #4 lives or dies on the note being
// honest, so the whole {enabled, overridden, globalGate, live} matrix is asserted here:
// isCeoEnabled makes an explicit override WIN over the global gate, so an explicit-ON CEO
// runs REGARDLESS of the gate and must NEVER be labeled inert.
//
// All three helpers now live in public/views/projects.js, which is DOM-free at module load (it
// touches `document` only inside a called function and imports only leaves), so we IMPORT it
// directly and assert on the real exports. (This test used to scrape a
// `// <test-extract:projects-ceo-status>` sentinel block out of the classic public/app.js script
// and eval it with `new Function`, because that script could not be imported; app.js is now the
// router + bootstrap alone and that harness is gone along with the sentinel. Do not reintroduce
// one. Same approach as test/kind-badge.test.ts / test/graph-rollup-completion.test.ts.)
import { expect, test } from "bun:test";
import { ceoNoteHtml, ceoStatusPill, ceoTerminalBtnState } from "../public/views/projects.js";

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
test("note: INHERITING + gate OFF → the gate bites; points at the override, never 'saved but inert'", () => {
  const html = ceoNoteHtml({ enabled: false, overridden: false, globalGate: false, live: false });
  expect(html).toContain("global CEO gate");
  expect(html).toContain("BUTCHR_CEO_AGENT");
  expect(html).toContain("inherit the default stay disabled");
  expect(html).toContain("override");
  expect(html.toLowerCase()).not.toContain("inert");
});

test("note: INHERITING + gate ON → inheriting-the-default context (no warning)", () => {
  const html = ceoNoteHtml({ enabled: true, overridden: false, globalGate: true, live: false });
  expect(html).toContain("Inheriting the global default");
  expect(html).toContain("ceo-note inherit");
});

test("note: OVERRIDDEN-ON while gate OFF → runs via override; NEVER implies inert", () => {
  const html = ceoNoteHtml({ enabled: true, overridden: true, globalGate: false, live: true });
  expect(html).toContain("per-project override");
  expect(html).toContain("runs regardless");
  expect(html.toLowerCase()).not.toContain("inert");
  expect(html.toLowerCase()).not.toContain("stay disabled");
});

test("note: OVERRIDDEN-OFF → explicitly disabled for this project", () => {
  const html = ceoNoteHtml({ enabled: false, overridden: true, globalGate: true, live: false });
  expect(html).toContain("Explicitly disabled for this project");
});

test("note: OVERRIDDEN-ON while gate ON → no note (unambiguous)", () => {
  const html = ceoNoteHtml({ enabled: true, overridden: true, globalGate: true, live: true });
  expect(html).toBe("");
});

// --- Open-CEO-terminal button gating (mirrors the CTO terminal affordance) ---------------
// Unlike the CTO button (hidden when not running), this stays visible but disables when there's
// no live pane, with an honest title reflecting WHY — consistent with ceoNoteHtml's wording.
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
test("invariant: an ENABLED CEO is never described as inert/disabled anywhere in the matrix", () => {
  for (const overridden of [true, false]) {
    for (const globalGate of [true, false]) {
      for (const live of [true, false]) {
        // Only REALIZABLE states: when INHERITING (overridden=false) the server resolves
        // enabled === globalGate (isCeoEnabled falls back to the gate), so enabled=true while
        // inheriting a false gate is impossible and not worth asserting.
        if (!overridden && !globalGate) continue;
        const html = ceoNoteHtml({ enabled: true, overridden, globalGate, live }).toLowerCase();
        expect(html).not.toContain("inert");
        expect(html).not.toContain("stay disabled");
        expect(html).not.toContain("explicitly disabled");
      }
    }
  }
});
