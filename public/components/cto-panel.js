// The managed CTO agent's PANEL — a per-workspace component (RFC Phase 2).
//
// It owns the CTO-agent card the workspace view mounts at the top of its page: the tri-state
// status mapping (`ctoState`) and the async panel builder (`ctoPanel`) with its Open-terminal /
// Enable / Start / Stop / Restart / Restart-fresh controls, all scoped to a workspace id via
// /api/workspaces/:id/cto/*.
//
// WHY IT LIVES UNDER components/ AND NOT INSIDE views/workspace.js. It is a shared leaf: a helper
// reached from more than one module cannot live inside a view, because a view is only ever
// imported by app.js's route dispatcher. Keeping it here also keeps the CEO card's prose (in
// app.js) honest — that card is explicitly the tier-above analog of this one.
//
// Like every module under components/, this is a presentational leaf: DOM-free at module load
// (`document` is touched only inside a CALLED function, via `el`), importing only from `core/`
// and from its sibling components. It NEVER imports app.js — see the header of core/nav.js for
// why that edge is fatal.
//
// This module is fully NODE-RETURNING (RFC Phase 4): it writes no raw markup and does no manual
// escaping. Its controls come from the shared Button, which subsumed the private `btn()` factory
// this file used to carry — one of the two rival async-action-button implementations named in D6.
import { el } from "../core/dom.js";
import { fmtTime } from "../core/format.js";
import { api, terminalToast, toast } from "../core/api.js";
import { Button } from "./button.js";
import { kindVisual } from "./chips.js";

// The CTO agent's tri-state status, mapped from running/desired to a display label
// and the matching cto-badge CSS class. Used by the workspace panel (its dashboard-card
// mini-badge counterpart went with the dashboard).
export function ctoState(s) {
  return {
    state: s.running ? "running" : (s.desired ? "starting…" : "stopped"),
    cls: s.running ? "ok" : (s.desired ? "warn" : "off"),
  };
}

// Every control on this card shares one dance, and it is NOT action()'s default one: the old
// private `btn()` re-enabled the button on success *before* re-rendering, re-rendered on failure
// too, and toasted "failed" when an error carried no message. Those three opt-ins reproduce it
// exactly — see components/button.js's `action` header. Do not drop them: the UI must stay
// byte-identical through this conversion.
const CTO_BTN = { renderOnError: true, restoreOnSuccess: true, errorFallback: "failed" };

// Each workspace runs its OWN CTO agent (in that repo's root — its principal/dev
// agent). This panel renders that workspace's CTO agent: a status line (running/
// stopped, session, since, restarts) plus controls — Open CTO terminal (reuses the
// workspace-agent attach), Enable/Start/Stop, Restart, and Restart fresh (a brand-new
// session) — all scoped to `dirId` via /api/workspaces/:id/cto/*.
export async function ctoPanel(dirId) {
  const base = "/workspaces/" + dirId + "/cto";
  let s;
  try {
    s = await api("GET", base);
  } catch {
    return el("div", { class: "panel cto-card stacked" },
      el("small", { class: "muted" }, "CTO agent status unavailable"));
  }
  const { state, cls: stateCls } = ctoState(s);
  const bits = [];
  if (s.sessionId) bits.push(`session ${s.sessionId.slice(0, 8)}`);
  if (s.since) bits.push(`since ${fmtTime(s.since)}`);
  if (s.restarts) bits.push(`${s.restarts} restart${s.restarts === 1 ? "" : "s"}`);
  if (!s.enabled) bits.push("auto-start disabled");

  // The kind badge is sourced from kindVisual() — the pure, DOM-free lookup behind chips.js's
  // kindBadge() — and rebuilt inline here. kindBadge() now returns a NODE and would drop straight
  // in; collapsing this onto it is a follow-up, not this subtask's business. Same class, title,
  // and text either way.
  const kv = kindVisual("cto");
  const badge = el("span", { class: "kind-badge kind-" + kv.cls, title: kv.label },
    `${kv.glyph} ${kv.label}`);

  const controls = el("div", { class: "row cto-controls" });
  const card = el("div", { class: "panel cto-card stacked" },
    el("div", { class: "row between" }, [
      el("div", {}, [
        el("h2", {}, [badge, " CTO agent ", el("span", { class: "cto-badge " + stateCls }, state)]),
        // `bits` is joined into ONE string, which el() appends as a single createTextNode — so
        // the per-bit escaping this replaced is not merely redundant, it is structurally
        // impossible to need: no bit can ever be parsed as markup.
        el("div", { class: "meta" }, bits.join(" · ") || "not started"),
        s.lastError ? el("div", { class: "meta err" }, "last error: " + s.lastError) : null,
      ]),
      controls,
    ]));

  if (s.running) {
    controls.appendChild(Button({
      label: "Open CTO terminal", ...CTO_BTN,
      onAction: async () => {
        const r = await api("POST", base + "/terminal");
        terminalToast(r);
      },
    }));
  }
  if (s.running || s.desired) {
    controls.appendChild(Button({
      label: "Restart", class: "ghost", ...CTO_BTN,
      onAction: async () => {
        await api("POST", base + "/restart");
        toast("CTO agent restarting (resuming session)");
      },
    }));
    controls.appendChild(Button({
      label: "Restart fresh", class: "ghost", ...CTO_BTN,
      onAction: async () => {
        await api("POST", base + "/restart?fresh=1");
        toast("CTO agent restarting with a fresh session");
      },
    }));
    controls.appendChild(Button({
      label: "Stop", class: "ghost danger-outline", ...CTO_BTN,
      onAction: async () => {
        await api("POST", base + "/stop");
        toast("CTO agent stopped");
      },
    }));
  } else {
    controls.appendChild(Button({
      label: "Start", ...CTO_BTN,
      onAction: async () => {
        await api("POST", base + "/start");
        toast("CTO agent starting");
      },
    }));
    // Opt the workspace into boot auto-start + supervision, and start it now.
    if (!s.enabled) {
      controls.appendChild(Button({
        label: "Enable", class: "ghost", ...CTO_BTN,
        onAction: async () => {
          await api("PATCH", "/workspaces/" + dirId, { cto_enabled: true });
          await api("POST", base + "/start");
          toast("CTO agent enabled + starting");
        },
      }));
    }
  }
  return card;
}
