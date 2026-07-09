// The METRICS view — the aggregate dashboard at #/metrics. The first view extracted from
// app.js (RFC Phase 2), and the template the remaining six follow.
//
// A view owns one route: its `render*` entry point fetches, builds, and mount()s. It imports
// only LEAVES — `core/` (dom, format, api, nav) and `components/` — never app.js. See the
// header of core/nav.js for why that edge must never exist.
//
// DOM-free at module load: nothing here touches `document` until a function is CALLED, so
// test/metrics-view.test.ts imports this module directly under bun test.
//
// Its one pure helper, `rateSub`, moved to the DOM-free leaf views/metrics-logic.js in the RFC
// Phase 2 horizontal split (§0.1 #5). It is NOT re-exported from here.
import { el } from "../core/dom.js";
import { api } from "../core/api.js";
import { fmtBytes, fmtDuration, fmtPct } from "../core/format.js";
import { mount } from "../core/nav.js";
import { chip } from "../components/chips.js";
import { rateSub } from "./metrics-logic.js";

// A single number card: big value, label, and an optional sub-line (e.g. raw
// numerator/denominator behind a rate).
function metricCard(label, value, sub) {
  return el("div", { class: "metric-card" }, [
    el("div", { class: "metric-value" }, String(value)),
    el("div", { class: "metric-label" }, label),
    sub != null ? el("div", { class: "metric-sub" }, sub) : null,
  ]);
}
// Tiny inline bar sparkline for merged-per-day throughput. No chart lib: a row of
// CSS-height bars, each titled with its date + count. Heights are scaled to the
// busiest day in the window (a flat zero series renders as a baseline).
function throughputSpark(perDay) {
  const max = Math.max(1, ...perDay.map((d) => d.count));
  const bars = perDay.map((d) => {
    const h = d.count > 0 ? Math.max(8, Math.round((d.count / max) * 100)) : 2;
    const bar = el("div", {
      class: "spark-bar" + (d.count > 0 ? "" : " zero"),
      style: `height:${h}%`,
      title: `${d.date}: ${d.count} merged`,
    });
    return el("div", { class: "spark-col" }, [bar]);
  });
  return el("div", { class: "spark" }, bars);
}

// Horizontal status breakdown bars: one row per present status, reusing the
// existing .chip color via a class, width proportional to the largest count.
function statusBars(byStatus) {
  const entries = Object.entries(byStatus).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return el("div", { class: "empty" }, "No tasks yet.");
  const max = Math.max(1, ...entries.map(([, n]) => n));
  const rows = entries.map(([status, n]) => {
    const fill = el("div", {
      class: "sb-fill " + status,
      style: `width:${Math.max(2, Math.round((n / max) * 100))}%`,
    });
    return el("div", { class: "status-bar-row" }, [
      el("span", { class: "sb-label" }, chip(status)),
      el("div", { class: "sb-track" }, [fill]),
      el("span", { class: "sb-count" }, String(n)),
    ]);
  });
  return el("div", { class: "status-bars" }, rows);
}

export async function renderMetrics() {
  const m = await api("GET", "/metrics");
  const wrap = el("div");
  wrap.appendChild(el("h1", {}, "Metrics"));
  wrap.appendChild(el("div", { class: "crumbs" },
    `aggregate across all tasks · ${m.total} total`));

  // number cards
  const cards = el("div", { class: "metrics-cards" });
  cards.appendChild(metricCard("Total tasks", m.total));
  cards.appendChild(metricCard("Merged (all-time)", m.throughput.totalMerged));
  cards.appendChild(metricCard("Merged / last " + m.throughput.days + "d", m.throughput.windowMerged));
  cards.appendChild(metricCard("Median time to review",
    fmtDuration(m.timeToReview.medianMs), `${m.timeToReview.count} sample${m.timeToReview.count === 1 ? "" : "s"}`));
  cards.appendChild(metricCard("Median time to merge",
    fmtDuration(m.timeToMerge.medianMs), `${m.timeToMerge.count} sample${m.timeToMerge.count === 1 ? "" : "s"}`));
  cards.appendChild(metricCard("Conflict rate", fmtPct(m.conflictRate.rate), rateSub(m.conflictRate)));
  cards.appendChild(metricCard("Revert rate", fmtPct(m.revertRate.rate), rateSub(m.revertRate)));
  cards.appendChild(metricCard("CI pass rate", fmtPct(m.ciPassRate.rate), rateSub(m.ciPassRate)));
  cards.appendChild(metricCard("Auto-merge rate", fmtPct(m.autoMergeRate.rate), rateSub(m.autoMergeRate)));
  wrap.appendChild(cards);

  // throughput sparkline
  wrap.appendChild(el("h2", {}, "Throughput — merged / day"));
  const tp = el("div", { class: "panel" });
  tp.appendChild(throughputSpark(m.throughput.perDay));
  tp.appendChild(el("div", { class: "spark-axis" }, [
    el("span", {}, m.throughput.perDay[0] ? m.throughput.perDay[0].date : ""),
    el("span", {}, m.throughput.perDay.length
      ? m.throughput.perDay[m.throughput.perDay.length - 1].date : ""),
  ]));
  wrap.appendChild(tp);

  // status breakdown
  wrap.appendChild(el("h2", {}, "Tasks by status"));
  const sb = el("div", { class: "panel" });
  sb.appendChild(statusBars(m.byStatus));
  wrap.appendChild(sb);

  wrap.appendChild(el("small", { class: "muted" },
    "Rates reflect each task's current state — conflict/CI flags can be cleared as a task moves on, so treat them as best-effort snapshots."));

  // Disk usage readout — sourced from /health's `disk` object (best-effort; absent
  // if sizing failed). Surfaces butchr's two growth footprints (task worktrees + DB
  // backups) and an advisory badge when the total crosses the configured threshold.
  let health = null;
  try { health = await api("GET", "/health"); } catch (e) { /* degraded — skip readout */ }
  const disk = health && health.disk;
  if (disk) {
    const head = el("h2", {}, "Disk usage");
    if (disk.warn) {
      head.appendChild(el("span", {
        class: "disk-warn-badge",
        title: `Total ${fmtBytes(disk.totalBytes)} exceeds the ${fmtBytes(disk.warnBytes)} advisory threshold (BUTCHR_DISK_WARN_BYTES)`,
      }, "over threshold"));
    }
    wrap.appendChild(head);
    const dcards = el("div", { class: "metrics-cards" });
    dcards.appendChild(metricCard("Task worktrees", fmtBytes(disk.worktreesBytes),
      `${disk.worktreeCount} worktree${disk.worktreeCount === 1 ? "" : "s"}`));
    dcards.appendChild(metricCard("DB backups", fmtBytes(disk.backupsBytes)));
    dcards.appendChild(metricCard("Total", fmtBytes(disk.totalBytes),
      disk.warnBytes > 0 ? `threshold ${fmtBytes(disk.warnBytes)}` : "no threshold"));
    wrap.appendChild(dcards);
    wrap.appendChild(el("small", { class: "muted" },
      "Worktrees are the per-task git checkouts under each repo; backups are the DB snapshots. "
      + (disk.truncated ? "Some trees hit the scan cap, so totals are a floor. " : "")
      + "Set BUTCHR_DISK_WARN_BYTES to tune the advisory threshold (0 disables it)."));
  }

  mount(wrap);
}
