// The managed CTO agent's PANEL — the per-workspace card the workspace view mounts above the
// Pipeline: a status line (running/stopped, session, since, restarts) plus Open-terminal / Enable /
// Start / Stop / Restart / Restart-fresh, all scoped to a workspace id via
// /api/workspaces/:id/cto/*.
//
// It stays under components/ because it is a shared leaf, not a part of one view.
//
// NO LAUNCHPAD CONTAINER EXISTS FOR IT (RFC §7.2, "CUSTOM composition"). It is composed from
// `Button` plus butchr's `.panel`/`.cto-card` CSS. The RFC's suggestion of `Avatar`/`InitialsAvatar`
// is not taken: this card identifies the agent with the shared `KindBadge`, which is the SAME
// badge every other agent and work-item surface uses (`kindVisual("cto")` → "★ CTO"), and swapping
// one surface onto an avatar would fork that vocabulary for no gain.
//
// EVERY CONTROL SHARES ONE DANCE, and it is not `useAction`'s default one. The old private `btn()`
// re-rendered on failure too and toasted "failed" when an error carried no message. Those two
// opt-ins reproduce it. The third — `restoreOnSuccess` — is gone from the whole codebase, and its
// absence is the fix; see components/button.tsx's header.
import { api } from "../core/api.ts";
import { fmtTime } from "../core/format.ts";
import type { CtoStatus, TerminalResult } from "../core/types.ts";
import { useAsync } from "../core/use-async.ts";
import { useRefreshVersion } from "../core/refresh.ts";
import { ActionButton } from "./button.tsx";
import { KindBadge } from "./chips.tsx";
import { terminalToast, toast } from "./toast.ts";

const CTO_BTN = { renderOnError: true, errorFallback: "failed" } as const;

/** The CTO agent's tri-state status, mapped from running/desired to a display label and the
 *  matching `.cto-badge` class. Pure — the one thing on this card worth testing without a DOM. */
export function ctoState(s: CtoStatus): { state: string; cls: "ok" | "warn" | "off" } {
  return {
    state: s.running ? "running" : s.desired ? "starting…" : "stopped",
    cls: s.running ? "ok" : s.desired ? "warn" : "off",
  };
}

export function CtoPanel({ workspaceId }: { workspaceId: string }) {
  const version = useRefreshVersion();
  const base = "/workspaces/" + workspaceId + "/cto";
  // Fail-soft, exactly as the vanilla `ctoPanel`'s catch was: a status-probe hiccup yields a muted
  // card rather than blocking the page. `useAsync` keeps the last good status painted while a
  // refresh is in flight, so the controls do not flicker on every SSE event.
  const { data: s, error } = useAsync<CtoStatus>(() => api<CtoStatus>("GET", base), [base, version]);

  if (error && !s) {
    return (
      <div className="panel cto-card stacked">
        <small className="muted">CTO agent status unavailable</small>
      </div>
    );
  }
  if (!s) return <div className="panel cto-card stacked" />;

  const { state, cls: stateCls } = ctoState(s);
  const bits: string[] = [];
  if (s.sessionId) bits.push(`session ${s.sessionId.slice(0, 8)}`);
  if (s.since) bits.push(`since ${fmtTime(s.since)}`);
  if (s.restarts) bits.push(`${s.restarts} restart${s.restarts === 1 ? "" : "s"}`);
  if (!s.enabled) bits.push("auto-start disabled");

  return (
    <div className="panel cto-card stacked">
      <div className="row between">
        <div>
          <h2>
            <KindBadge kind="cto" /> CTO agent <span className={"cto-badge " + stateCls}>{state}</span>
          </h2>
          {/* `bits` is joined into ONE string, which JSX renders as a single text node — the
              per-bit escaping this replaced is not merely redundant, it is structurally
              impossible to need: no bit can ever be parsed as markup. */}
          <div className="meta">{bits.join(" · ") || "not started"}</div>
          {s.lastError ? <div className="meta err">last error: {s.lastError}</div> : null}
        </div>
        <div className="row cto-controls">
          {s.running ? (
            <ActionButton
              label="Open CTO terminal"
              {...CTO_BTN}
              onAction={async () => terminalToast(await api<TerminalResult>("POST", base + "/terminal"))}
            />
          ) : null}
          {s.running || s.desired ? (
            <>
              <ActionButton
                label="Restart"
                kind="ghost"
                {...CTO_BTN}
                onAction={async () => {
                  await api("POST", base + "/restart");
                  toast("CTO agent restarting (resuming session)");
                }}
              />
              <ActionButton
                label="Restart fresh"
                kind="ghost"
                {...CTO_BTN}
                onAction={async () => {
                  await api("POST", base + "/restart?fresh=1");
                  toast("CTO agent restarting with a fresh session");
                }}
              />
              <ActionButton
                label="Stop"
                kind="danger-outline"
                {...CTO_BTN}
                onAction={async () => {
                  await api("POST", base + "/stop");
                  toast("CTO agent stopped");
                }}
              />
            </>
          ) : (
            <>
              <ActionButton
                label="Start"
                {...CTO_BTN}
                onAction={async () => {
                  await api("POST", base + "/start");
                  toast("CTO agent starting");
                }}
              />
              {/* Opt the workspace into boot auto-start + supervision, and start it now. */}
              {!s.enabled ? (
                <ActionButton
                  label="Enable"
                  kind="ghost"
                  {...CTO_BTN}
                  onAction={async () => {
                    await api("PATCH", "/workspaces/" + workspaceId, { cto_enabled: true });
                    await api("POST", base + "/start");
                    toast("CTO agent enabled + starting");
                  }}
                />
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
