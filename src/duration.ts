// PURE duration/quantile helpers shared by the metrics (db.ts) and the rough
// task-duration estimator (estimate.ts). No DB / git / clock access, so both
// callers stay unit-testable against synthetic inputs. Two DELIBERATELY DISTINCT
// quantile definitions live here:
//   - `percentile` is NEAREST-RANK (the estimator's p50/p90 buckets).
//   - `median` AVERAGES the two middle values for an even count (the metrics
//     time-to-review / time-to-merge medians — pinned by test/metrics.test.ts).
// They are not interchangeable; keep them separate.

/**
 * Render a millisecond span as a short human phrase ("3s", "2m 5s", "1h 2m") for
 * log lines / notification content. Pure; clamps negatives to 0. Seconds are dropped
 * once the span is an hour or more (minute precision is plenty there).
 */
export function humanizeMs(ms: number): string {
  const total = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

/** Positive ms span between two ISO timestamps; null if missing or non-positive. */
export function spanMs(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** Nearest-rank percentile of an ASCENDING-sorted array; null when empty. */
export function percentile(sortedAsc: number[], p: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const rank = Math.min(n, Math.max(1, Math.ceil(p * n)));
  return sortedAsc[rank - 1]!;
}

/**
 * Median of a numeric set; null when empty. For an EVEN count this AVERAGES the
 * two middle values (rounded) — distinct from nearest-rank `percentile(_, 0.5)`.
 * Sorts a copy, so the input order is preserved.
 */
export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}
