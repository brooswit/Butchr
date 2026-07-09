// Pure display formatters — no DOM, no module state. Every one of these maps a raw
// value to the string an operator reads, and returns "—" for absent data so empty
// cells and medians read cleanly rather than showing "null" or "NaN".
//
// Ported to `.ts` by RFC Phase 4 with zero logic change (§1.1 row 3: "the hypothesis is exactly
// right here"). test/projects-detail-ui.test.ts imports it and needed no edit.

import type { Repo, Workspace } from "./types.ts";

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
// Format a millisecond duration as a compact human string (e.g. "2h 5m", "3m",
// "45s"). Returns "—" for null/zero so empty medians read cleanly.
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !isFinite(ms) || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hr = h % 24;
  return hr ? `${d}d ${hr}h` : `${d}d`;
}
// Format a byte count as a human-readable size (KB/MB/GB, binary units). "—" for
// null/non-finite; "0 B" for zero.
export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null || !isFinite(bytes)) return "—";
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  const v = n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1);
  return `${v} ${units[i]}`;
}
// Format a rate (0..1 or null) as a percentage string; "—" when there's no data.
export function fmtPct(rate: number | null | undefined): string {
  if (rate == null || !isFinite(rate)) return "—";
  const pct = rate * 100;
  return (pct < 10 && pct > 0 ? pct.toFixed(1) : Math.round(pct)) + "%";
}

// A compact title derived from the project's brief (a project node has no short-title
// field). Splits on the first sentence/clause boundary and clamps length.
//
// It lives with the formatters, not with the projects code, because it has callers in TWO
// modules: the projects overview/detail surfaces AND views/workspace.tsx's breadcrumb (which
// names the parent project). Copying it would be a defect — so the shared derivation sits here.
export function projectTitle(p: { brief?: string | null } | null | undefined): string {
  const t = String((p && p.brief) || "").split(/[—\-:.]/)[0].trim();
  if (!t) return "Untitled project";
  return t.length > 60 ? t.slice(0, 57) + "…" : t;
}

// A member repo's display fields, resolved against the workspaces map. Defensive: a repo
// whose id isn't in /api/workspaces (stale/filtered directory) still renders honestly
// from its id/brief rather than blanking the panel or throwing on basename(undefined).
export function repoDisplay(repo: Repo, wsById: Map<string, Workspace>): { name: string; dir: string } {
  const ws = wsById.get(repo.id);
  if (ws) {
    return { name: ws.label || basenameOf(ws.path) || repo.id, dir: ws.path || repo.id };
  }
  return { name: (repo.brief && String(repo.brief).trim()) || repo.id, dir: repo.id };
}

// Basename of a path (last non-empty segment), tolerating trailing slashes. "" for a
// null/empty input so callers can fall back.
export function basenameOf(path: string | null | undefined): string {
  const parts = String(path || "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}
