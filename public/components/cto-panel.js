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
import { el, esc } from "../core/dom.js";
import { fmtTime } from "../core/format.js";
import { api, terminalToast, toast } from "../core/api.js";
import { render } from "../core/nav.js";
import { kindBadge } from "./chips.js";

// The CTO agent's tri-state status, mapped from running/desired to a display label
// and the matching cto-badge CSS class. Used by the workspace panel (its dashboard-card
// mini-badge counterpart went with the dashboard).
export function ctoState(s) {
  return {
    state: s.running ? "running" : (s.desired ? "starting…" : "stopped"),
    cls: s.running ? "ok" : (s.desired ? "warn" : "off"),
  };
}

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
  const card = el("div", { class: "panel cto-card stacked" });
  const { state, cls: stateCls } = ctoState(s);
  const bits = [];
  if (s.sessionId) bits.push(`session ${esc(s.sessionId.slice(0, 8))}`);
  if (s.since) bits.push(`since ${fmtTime(s.since)}`);
  if (s.restarts) bits.push(`${s.restarts} restart${s.restarts === 1 ? "" : "s"}`);
  if (!s.enabled) bits.push("auto-start disabled");
  card.innerHTML = `
    <div class="row between">
      <div>
        <h2>${kindBadge("cto")} CTO agent <span class="cto-badge ${stateCls}">${state}</span></h2>
        <div class="meta">${bits.map(esc).join(" · ") || "not started"}</div>
        ${s.lastError ? `<div class="meta err">last error: ${esc(s.lastError)}</div>` : ""}
      </div>
      <div class="row cto-controls"></div>
    </div>`;
  const controls = card.querySelector(".cto-controls");
  const btn = (label, cls, fn) => {
    const b = el("button", { class: "btn " + cls }, label);
    b.addEventListener("click", async () => {
      b.disabled = true;
      try { await fn(); } catch (e) { toast(e.message || "failed", true); }
      finally { b.disabled = false; render(); }
    });
    return b;
  };
  if (s.running) {
    controls.appendChild(btn("Open CTO terminal", "", async () => {
      const r = await api("POST", base + "/terminal");
      terminalToast(r);
    }));
  }
  if (s.running || s.desired) {
    controls.appendChild(btn("Restart", "ghost", async () => {
      await api("POST", base + "/restart");
      toast("CTO agent restarting (resuming session)");
    }));
    controls.appendChild(btn("Restart fresh", "ghost", async () => {
      await api("POST", base + "/restart?fresh=1");
      toast("CTO agent restarting with a fresh session");
    }));
    controls.appendChild(btn("Stop", "ghost danger-outline", async () => {
      await api("POST", base + "/stop");
      toast("CTO agent stopped");
    }));
  } else {
    controls.appendChild(btn("Start", "", async () => {
      await api("POST", base + "/start");
      toast("CTO agent starting");
    }));
    // Opt the workspace into boot auto-start + supervision, and start it now.
    if (!s.enabled) {
      controls.appendChild(btn("Enable", "ghost", async () => {
        await api("PATCH", "/workspaces/" + dirId, { cto_enabled: true });
        await api("POST", base + "/start");
        toast("CTO agent enabled + starting");
      }));
    }
  }
  return card;
}
