// The METRICS view — the aggregate dashboard at #/metrics.
//
// >>> A CORRECTION TO THE RFC, AND IT IS LOAD-BEARING FOR THIS FILE. <<<
// RFC §7.2 and §1.1 row 18 both say this view maps onto LaunchPad's `Table` / `TableHeader` /
// `TableBody` / `Column` / `Row` / `Cell`, and call it "the cleanest 1:1 mapping in the whole app".
// It is not, because there is no table. `renderMetrics` (views/metrics.js) built exactly three
// things: a grid of number CARDS, a CSS-height bar SPARKLINE of merged-per-day throughput, and a
// row of proportional status BARS. `grep -E '"(table|thead|tbody|tr|td|th)"'` over that file
// returns nothing. The RFC was describing a surface this app does not have.
//
// So the view is what it always was — data-visualisation on butchr's own CSS — and it takes from
// LaunchPad only the thing LaunchPad has: `Button` (none needed here) and the tokens underneath
// every colour. Per the house rule, the disagreement is stated rather than silently worked around,
// and forcing a `Table` around a bar chart would have been the silent version.
//
// The status bars stay keyed on the 14 status colours for the same reason the chips do (RFC §7.2,
// CTO decision §12.7): `.sb-fill.merged` and `.sb-fill.failed` are not two shades of one `Meter`.
import { api } from "../core/api.ts";
import { fmtBytes, fmtDuration, fmtPct } from "../core/format.ts";
import { useRefreshVersion } from "../core/refresh.ts";
import type { Health, Metrics } from "../core/types.ts";
import { useAsync } from "../core/use-async.ts";
import { StatusChip } from "../components/chips.tsx";
import { rateSub } from "./metrics-logic.ts";

/** A single number card: big value, label, and an optional sub-line (e.g. the raw
 *  numerator/denominator behind a rate). */
function MetricCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="metric-card">
      <div className="metric-value">{String(value)}</div>
      <div className="metric-label">{label}</div>
      {sub != null ? <div className="metric-sub">{sub}</div> : null}
    </div>
  );
}

/** Tiny inline bar sparkline for merged-per-day throughput. No chart lib: a row of CSS-height
 *  bars, each titled with its date + count. Heights scale to the busiest day in the window (a flat
 *  zero series renders as a baseline). */
function ThroughputSpark({ perDay }: { perDay: Array<{ date: string; count: number }> }) {
  const max = Math.max(1, ...perDay.map((d) => d.count));
  return (
    <div className="spark">
      {perDay.map((d) => {
        const h = d.count > 0 ? Math.max(8, Math.round((d.count / max) * 100)) : 2;
        return (
          <div className="spark-col" key={d.date}>
            <div
              className={"spark-bar" + (d.count > 0 ? "" : " zero")}
              style={{ height: `${h}%` }}
              title={`${d.date}: ${d.count} merged`}
            />
          </div>
        );
      })}
    </div>
  );
}

/** Horizontal status breakdown bars: one row per present status, reusing the `.chip` colour via a
 *  class, width proportional to the largest count. */
function StatusBars({ byStatus }: { byStatus: Record<string, number> }) {
  const entries = Object.entries(byStatus).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return <div className="empty">No tasks yet.</div>;
  const max = Math.max(1, ...entries.map(([, n]) => n));
  return (
    <div className="status-bars">
      {entries.map(([status, n]) => (
        <div className="status-bar-row" key={status}>
          <span className="sb-label">
            <StatusChip status={status} />
          </span>
          <div className="sb-track">
            <div className={"sb-fill " + status} style={{ width: `${Math.max(2, Math.round((n / max) * 100))}%` }} />
          </div>
          <span className="sb-count">{n}</span>
        </div>
      ))}
    </div>
  );
}

/** Disk-usage readout, sourced from `/health`'s `disk` object. Best-effort and absent if sizing
 *  failed. Surfaces butchr's two growth footprints (task worktrees + DB backups) plus an advisory
 *  badge when the total crosses the configured threshold. */
function DiskUsage({ health }: { health: Health | null }) {
  const disk = health && health.disk;
  if (!disk) return null;
  return (
    <>
      <h2>
        Disk usage
        {disk.warn ? (
          <span
            className="disk-warn-badge"
            title={`Total ${fmtBytes(disk.totalBytes)} exceeds the ${fmtBytes(disk.warnBytes)} advisory threshold (BUTCHR_DISK_WARN_BYTES)`}
          >
            over threshold
          </span>
        ) : null}
      </h2>
      <div className="metrics-cards">
        <MetricCard
          label="Task worktrees"
          value={fmtBytes(disk.worktreesBytes)}
          sub={`${disk.worktreeCount} worktree${disk.worktreeCount === 1 ? "" : "s"}`}
        />
        <MetricCard label="DB backups" value={fmtBytes(disk.backupsBytes)} />
        <MetricCard
          label="Total"
          value={fmtBytes(disk.totalBytes)}
          sub={disk.warnBytes > 0 ? `threshold ${fmtBytes(disk.warnBytes)}` : "no threshold"}
        />
      </div>
      <small className="muted">
        Worktrees are the per-task git checkouts under each repo; backups are the DB snapshots.{" "}
        {disk.truncated ? "Some trees hit the scan cap, so totals are a floor. " : ""}
        Set BUTCHR_DISK_WARN_BYTES to tune the advisory threshold (0 disables it).
      </small>
    </>
  );
}

export function MetricsView() {
  const version = useRefreshVersion();
  // `/health` is fetched alongside, and its failure is NOT the view's failure: a degraded /health
  // (503) drops the disk readout and leaves everything else painted, exactly as the vanilla
  // `try { health = await api(...) } catch { /* degraded — skip readout */ }` did.
  const { data, error } = useAsync(
    async () => {
      const [m, health] = await Promise.all([
        api<Metrics>("GET", "/metrics"),
        api<Health>("GET", "/health").catch(() => null),
      ]);
      return { m, health };
    },
    [version],
  );

  if (error && !data) return <div className="empty">error: {error.message}</div>;
  if (!data) return null;
  const { m, health } = data;

  return (
    <div>
      <h1>Metrics</h1>
      <div className="crumbs">aggregate across all tasks · {m.total} total</div>

      <div className="metrics-cards">
        <MetricCard label="Total tasks" value={m.total} />
        <MetricCard label="Merged (all-time)" value={m.throughput.totalMerged} />
        <MetricCard label={"Merged / last " + m.throughput.days + "d"} value={m.throughput.windowMerged} />
        <MetricCard
          label="Median time to review"
          value={fmtDuration(m.timeToReview.medianMs)}
          sub={`${m.timeToReview.count} sample${m.timeToReview.count === 1 ? "" : "s"}`}
        />
        <MetricCard
          label="Median time to merge"
          value={fmtDuration(m.timeToMerge.medianMs)}
          sub={`${m.timeToMerge.count} sample${m.timeToMerge.count === 1 ? "" : "s"}`}
        />
        <MetricCard label="Conflict rate" value={fmtPct(m.conflictRate.rate)} sub={rateSub(m.conflictRate)} />
        <MetricCard label="Revert rate" value={fmtPct(m.revertRate.rate)} sub={rateSub(m.revertRate)} />
        <MetricCard label="CI pass rate" value={fmtPct(m.ciPassRate.rate)} sub={rateSub(m.ciPassRate)} />
        <MetricCard label="Auto-merge rate" value={fmtPct(m.autoMergeRate.rate)} sub={rateSub(m.autoMergeRate)} />
      </div>

      <h2>Throughput — merged / day</h2>
      <div className="panel">
        <ThroughputSpark perDay={m.throughput.perDay} />
        <div className="spark-axis">
          <span>{m.throughput.perDay[0] ? m.throughput.perDay[0].date : ""}</span>
          <span>{m.throughput.perDay.length ? m.throughput.perDay[m.throughput.perDay.length - 1].date : ""}</span>
        </div>
      </div>

      <h2>Tasks by status</h2>
      <div className="panel">
        <StatusBars byStatus={m.byStatus} />
      </div>

      <small className="muted">
        Rates reflect each task&rsquo;s current state — conflict/CI flags can be cleared as a task moves on, so treat
        them as best-effort snapshots.
      </small>

      <DiskUsage health={health} />
    </div>
  );
}
