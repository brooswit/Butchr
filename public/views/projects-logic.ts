// The PURE half of the PROJECTS views — the initiative heading/rollup derivations and the CEO
// card's status-pill + terminal-button state. Split out of views/projects.js by the RFC Phase 2
// horizontal cut (RFC §0.1 #5).
//
// DOM-free OUTRIGHT, not merely at module load: zero value imports, and nothing here touches
// `document` even when called. test/projects-initiatives-ui.test.ts and the pure half of
// test/projects-ceo-ui.test.ts import this leaf directly, with no DOM stub.
//
// §0.1 #5 names only the three initiative* helpers. `ceoStatusPill` and `ceoTerminalBtnState` are
// the same seam — pure data, DOM-free, already tested as such (projects-ceo-ui.test.ts's own header
// says so) — so they came across too. `ceoNote` returns a NODE and stays in views/projects.js.
import type { CeoStatus, InitiativeView } from "../core/types.js";

/** A status pill: a `.pill.<cls>` with its label and an optional hover explanation. */
export type Pill = { cls: string; label: string; title?: string };
/** A progress-bar fraction. `pct` is a whole number 0..100, already rounded. */
export type Rollup = { done: number; total: number; pct: number };

// A cross-repo InitiativeView (GET /api/projects/:id/initiatives) has NO top-level brief — each
// per-repo child story carries its own — so derive a compact panel heading from the FIRST child's
// brief (first line, clamped). Falls back to the initiative id when no child has a brief, so the
// row never renders blank.
export function initiativeHeading(init: InitiativeView | null | undefined): string {
  const kids = (init && init.children) || [];
  const withBrief = kids.find((c) => c && c.brief && String(c.brief).trim());
  const raw = withBrief ? String(withBrief.brief).trim() : "";
  if (!raw) return "Initiative " + (String((init && init.initiative_id) || "").trim() || "—");
  const oneLine = raw.split("\n")[0].trim();
  return oneLine.length > 80 ? oneLine.slice(0, 77) + "…" : oneLine;
}
// The rollup fraction for an initiative's progress bar. LOCKED to the SERVER's done predicate
// (rollupInitiatives in src/stories.ts): a child counts as done ONLY when status==='done'
// (strictly — NOT merged/landed), so the bar reaches 100% EXACTLY when the server's
// initiative.done is true, with no bar/boolean disagreement.
export function initiativeRollup(init: InitiativeView | null | undefined): Rollup {
  const kids = (init && init.children) || [];
  const total = kids.length;
  const done = kids.filter((c) => c && c.status === "done").length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}
// The project-level "X/Y initiatives done" rollup for the overview card — counts DONE
// initiatives using the server's authoritative `done` boolean on each InitiativeView. Only
// cross-repo initiatives appear in the list (single-repo ones are ungrouped), so this counts
// those.
export function projectInitiativeRollup(inits: InitiativeView[] | null | undefined): Rollup {
  const list = Array.isArray(inits) ? inits : [];
  const total = list.length;
  const done = list.filter((i) => i && i.done).length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

// The CEO card's status pill, derived from the RESOLVED fields: live wins (green), else enabled
// (blue), else a disabled project that's merely INHERITING the default reads the neutral
// "CEO default" (not "CEO disabled" — nothing was explicitly turned off), and an explicit-off reads
// "CEO disabled".
export function ceoStatusPill(s: CeoStatus): Pill {
  if (s.live) return { cls: "live", label: "CEO live" };
  if (s.enabled) return { cls: "enabled", label: "CEO enabled" };
  if (!s.overridden) {
    return {
      cls: "inactive",
      label: "CEO default",
      title: "Inherits the global CEO gate (BUTCHR_CEO_AGENT) — currently off",
    };
  }
  return { cls: "disabled", label: "CEO disabled" };
}

// The "Open CEO terminal" button's enabled state + honest hint, derived only from the RESOLVED
// {enabled, overridden, globalGate, live} fields. Unlike the CTO button (which HIDES when not
// running), this stays visible but disables when there's no live pane and explains WHY — using
// the same honest wording as ceoNote so the two never contradict.
export function ceoTerminalBtnState(s: CeoStatus): { enabled: boolean; title: string } {
  if (s.live) return { enabled: true, title: "Attach a terminal to the live CEO agent" };
  if (s.enabled) return { enabled: false, title: "CEO agent is starting… — no live pane to attach yet" };
  if (s.overridden) return { enabled: false, title: "CEO is disabled for this project — enable it to attach a terminal" };
  if (!s.globalGate) {
    return {
      enabled: false,
      title: "The global CEO gate (BUTCHR_CEO_AGENT) is off — enable this project's CEO to attach a terminal",
    };
  }
  return { enabled: false, title: "CEO agent isn't live — no terminal to attach" };
}
