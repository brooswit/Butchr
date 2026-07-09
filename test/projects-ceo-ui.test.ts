// Story st-04869886 (S5): the project-detail CEO-agent card. This guards the PURE, DOM-free helpers
// that decide what the card SAYS — ceoStatusPill (the status pill), ceoTerminalBtnState (the
// terminal button's gate) and ceoNote (the honest global-gate note) — plus ceoPill, the overview
// card's coarser pill. Feature #4 lives or dies on the note being honest, so the whole
// {enabled, overridden, globalGate, live} matrix is asserted here: isCeoEnabled makes an explicit
// override WIN over the global gate, so an explicit-ON CEO runs REGARDLESS of the gate and must
// NEVER be labeled inert.
//
// The pure helpers live in public/views/projects-logic.ts — the DOM-free leaf of the RFC Phase 2
// horizontal split — and `ceoNote`, which returns a NODE, in public/views/projects.tsx.
//
// >>> PHASE 4d: `ceoPill` MOVED INTO THE LEAF, AND `ceoNote` BECAME A COMPONENT. <<<
// `ceoPill` was a private function inside the vanilla views/projects.js and had no coverage at all;
// the salvage branch's views/projects.tsx imported it from projects-logic.ts, where it did not
// exist. It is pure, so it now lives there in fact as well as in that import's imagination, and it
// is asserted below.
//
// `ceoNote` returned an HTMLElement built with el(), asserted inside `withDom()` — a hand-rolled,
// zero-dependency `document` stub. It returns a React element (or null), so its half of this file
// renders through @testing-library/react into a real happy-dom DOM. The NULL case still needs no DOM
// at all: `ceoNote` returns `null` before it ever builds anything.
//
// >>> WHY `surface()` READS className AND textContent, NOT JUST textContent. <<<
// These assertions are NOT uniform, and narrowing them is a silent regression:
//   • `.toContain("ceo-note inherit")` matches a CLASS, never any rendered text.
//   • The NEGATIVE assertions (`not.toContain("inert")`, `not.toContain("stay disabled")`) and the
//     whole-matrix invariant at the bottom used to scan the entire serialized markup string. Point
//     them at textContent alone and they still PASS — vacuously — while no longer covering the class
//     they were written to test. A test that passes for the wrong reason is worse than a deleted one.
// So `surface()` reproduces the old string's coverage: class list + rendered text, lowercased.
import "./dom-register.ts"; // must precede every React import — installs `document`
import { cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { registerDom, unregisterDom } from "./dom-env.ts";
import { ceoNote } from "../public/views/projects.tsx";
import { ceoPill, ceoStatusPill, ceoTerminalBtnState } from "../public/views/projects-logic.js";

beforeAll(registerDom);
afterEach(cleanup);
// Not optional: `test/vanilla-views-dom-free.test.ts` asserts `globalThis.document` is undefined, and
// `bun test` runs every file in one process.
afterAll(unregisterDom);

type Ceo = { enabled: boolean; overridden: boolean; globalGate: boolean; live: boolean };

/** Render a note and hand back its single root element. Only ever called for a non-null note. */
function note(s: Ceo): Element {
  const el = ceoNote(s);
  expect(el).not.toBe(null);
  return render(el as never).container.children[0];
}

/** The assertable surface of a note node: everything the old markup string exposed.
 *  `null` (the no-note case) has no surface at all. */
function surface(s: Ceo): string {
  const el = ceoNote(s);
  if (!el) return "";
  const root = render(el as never).container.children[0];
  const out = `${root.className} ${root.textContent}`.toLowerCase();
  cleanup();
  return out;
}

// --- overview pill (the coarse, three-way ceo_enabled column) ----------------------------
test("ceoPill: explicit 1 / 0 / null map to enabled / disabled / default", () => {
  expect(ceoPill({ id: "p", ceo_enabled: 1 })).toEqual({ cls: "enabled", label: "CEO enabled" });
  expect(ceoPill({ id: "p", ceo_enabled: 0 })).toEqual({ cls: "disabled", label: "CEO disabled" });

  // null / absent / a null project all INHERIT — the overview never fetches /ceo, so it cannot know
  // whether the gate is on. It says "default" and names the gate in the hover title.
  for (const p of [{ id: "p", ceo_enabled: null }, { id: "p" }, null, undefined] as const) {
    const pill = ceoPill(p as never);
    expect(pill.cls).toBe("inactive");
    expect(pill.label).toBe("CEO default");
    expect(pill.title).toContain("BUTCHR_CEO_AGENT");
  }
});

// --- detail status pill (live > enabled > default/disabled) -------------------------------
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
  const n = note({ enabled: false, overridden: false, globalGate: false, live: false });
  expect(n.textContent).toContain("global CEO gate");
  expect(n.textContent).toContain("BUTCHR_CEO_AGENT");
  expect(n.textContent).toContain("inherit the default stay disabled");
  expect(n.textContent).toContain("override");
  expect(surface({ enabled: false, overridden: false, globalGate: false, live: false })).not.toContain("inert");
});

test("note: INHERITING + gate ON → inheriting-the-default context (no warning)", () => {
  const n = note({ enabled: true, overridden: false, globalGate: true, live: false });
  expect(n.textContent).toContain("Inheriting the global default");
  expect(n.textContent).toContain("BUTCHR_CEO_AGENT");
  // a CLASS, not text — the neutral (non-warning) variant
  expect(n.className).toContain("ceo-note inherit");
});

test("note: OVERRIDDEN-ON while gate OFF → runs via override; NEVER implies inert", () => {
  const s: Ceo = { enabled: true, overridden: true, globalGate: false, live: true };
  const n = note(s);
  expect(n.textContent).toContain("per-project override");
  expect(n.textContent).toContain("runs regardless");
  cleanup();
  expect(surface(s)).not.toContain("inert");
  expect(surface(s)).not.toContain("stay disabled");
});

test("note: OVERRIDDEN-OFF → explicitly disabled for this project", () => {
  const n = note({ enabled: false, overridden: true, globalGate: true, live: false });
  expect(n.textContent).toContain("Explicitly disabled for this project");
});

test("note: OVERRIDDEN-ON while gate ON → no note (unambiguous)", () => {
  // The no-note case returns `null` WITHOUT touching the DOM — no render needed.
  expect(ceoNote({ enabled: true, overridden: true, globalGate: true, live: true })).toBe(null);
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
  for (const overridden of [true, false]) {
    for (const globalGate of [true, false]) {
      for (const live of [true, false]) {
        // Only REALIZABLE states: when INHERITING (overridden=false) the server resolves
        // enabled === globalGate (isCeoEnabled falls back to the gate), so enabled=true while
        // inheriting a false gate is impossible and not worth asserting.
        if (!overridden && !globalGate) continue;
        const s = surface({ enabled: true, overridden, globalGate, live });
        expect(s).not.toContain("inert");
        expect(s).not.toContain("stay disabled");
        expect(s).not.toContain("explicitly disabled");
      }
    }
  }
});
