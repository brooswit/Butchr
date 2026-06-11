// ROUGH TASK-DURATION ESTIMATES — a heuristic (NO ML) forecast built on butchr's
// OWN tracked history. The whole module is PURE (no DB / git / clock access, like
// db.computeMetrics) so it is unit-testable against synthetic rows: callers feed it
// `EstimateRow[]` assembled from the tasks table (see tasks.estimateInputRows) and
// it returns ranges. Every estimate is a LOOSE p50–p90 RANGE carrying its sample
// size — never a hard promise — and it says "insufficient data" rather than guess
// when history is too thin.
//
// HOW IT WORKS
//  1. From COMPLETED tasks we measure two running durations off the timestamps
//     (mirroring the metrics module): started→review (started_at→completed_at) and
//     started→merge (started_at→merged_at).
//  2. Each task is bucketed by a CHEAP signal captured when it entered review:
//       - a SIZE bucket from the final diff line-count (small/medium/large), and
//       - a path-based TYPE (docs/webapp/core/mixed).
//     Per bucket we compute P50 + P90 and the sample count.
//  3. To estimate a queued/running/review task we pick its bucket (a queued task may
//     only have a prompt → no size/type yet → fall back to the overall median) and
//     expose the p50–p90 range with its n. A bucket with too few samples falls back
//     to the overall pool; if even that is too thin the estimate is `insufficient`.
//  4. For a dependency CHAIN we estimate the CRITICAL PATH: along blocked_by edges,
//     each task's finish = its own duration + the max finish across its blockers, so
//     parallel branches take the max() and a chain shows an approximate total.
//
// CAVEATS (surfaced to the operator): the size/type buckets only have samples from
// tasks that recorded a footprint (a pre-feature / never-run task lands in the
// overall pool); durations are wall-clock and include any queue/idle/rework time;
// and the whole thing is a rough forecast, not an SLA.

// --- tuning constants (the size/type heuristics live here, in this module) ---

// Size-bucket thresholds on the final changed-line count (added + deleted):
// `<= small` → small, `<= medium` → medium, else large.
export const SIZE_THRESHOLDS = { small: 30, medium: 150 } as const;

// A bucket needs at least this many samples before we trust it over the overall
// pool; below it (for the overall pool too) the estimate is reported `insufficient`.
export const MIN_SAMPLES = 3;

export type SizeBucket = "small" | "medium" | "large";
export type PathType = "docs" | "webapp" | "core" | "mixed";

// The per-task fields the estimator reads. `blocked_by` is the PARSED id array (the
// caller parses the JSON column); diff_lines / path_type are the captured footprint
// signals (null for tasks that never recorded one — they only feed the overall pool).
export type EstimateRow = {
  id: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  merged_at: string | null;
  diff_lines: number | null;
  path_type: string | null;
  blocked_by: string[];
};

// --- cheap bucketing signals -------------------------------------------------

/** The size bucket for a final changed-line count, or null if unknown (no footprint). */
export function sizeBucket(diffLines: number | null | undefined): SizeBucket | null {
  if (typeof diffLines !== "number" || !Number.isFinite(diffLines) || diffLines < 0) {
    return null;
  }
  if (diffLines <= SIZE_THRESHOLDS.small) return "small";
  if (diffLines <= SIZE_THRESHOLDS.medium) return "medium";
  return "large";
}

/** Coarse category for one changed path (repo-relative). */
function categorizeFile(file: string): "docs" | "webapp" | "core" {
  const f = file.replace(/^\.\//, "");
  if (f.startsWith("public/")) return "webapp";
  if (/\.md$/i.test(f) || f === "LICENSE" || f.startsWith("docs/")) return "docs";
  // Everything else — src/, test/, bin/, scripts/, deploy/, package.json, … — is core.
  return "core";
}

/**
 * Path-based TYPE for a changed file set: `docs` / `webapp` / `core` when every
 * file falls in one category, else `mixed`. Used at footprint-capture time
 * (tasks.captureDiffFootprint) to label a task by a signal cheaper than its prompt.
 * An empty set defaults to `core` (nothing doc/webapp-only about it).
 */
export function classifyPathType(files: string[]): PathType {
  const cats = new Set<string>();
  for (const f of files) cats.add(categorizeFile(f));
  if (cats.size === 0) return "core";
  if (cats.size === 1) return [...cats][0] as PathType;
  return "mixed";
}

// --- percentiles + durations -------------------------------------------------

/** Nearest-rank percentile of an ASCENDING-sorted array; null when empty. */
function percentile(sortedAsc: number[], p: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const rank = Math.min(n, Math.max(1, Math.ceil(p * n)));
  return sortedAsc[rank - 1]!;
}

/** Positive ms span between two ISO timestamps; null if missing or non-positive. */
function spanMs(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

// A duration distribution: P50, P90, and the number of samples behind them.
export type DurStat = { p50Ms: number | null; p90Ms: number | null; n: number };
// One bucket's two distributions: time-to-review and time-to-merge.
export type BucketStat = { toReview: DurStat; toMerge: DurStat };

function emptyBucket(): { review: number[]; merge: number[] } {
  return { review: [], merge: [] };
}
function durStat(spans: number[]): DurStat {
  const s = spans.slice().sort((a, b) => a - b);
  return { p50Ms: percentile(s, 0.5), p90Ms: percentile(s, 0.9), n: s.length };
}

// The full set of bucketed distributions computed from history.
export type EstimateStats = {
  overall: BucketStat;
  size: Record<SizeBucket, BucketStat>;
  type: Record<PathType, BucketStat>;
};

const SIZE_KEYS: SizeBucket[] = ["small", "medium", "large"];
const TYPE_KEYS: PathType[] = ["docs", "webapp", "core", "mixed"];

/**
 * Compute the bucketed P50/P90 distributions from historical rows. A row feeds a
 * distribution whenever the matching span is present: started→review samples come
 * from any row with both started_at + completed_at; started→merge samples from any
 * row with started_at + merged_at (so a merged row feeds both). Every row feeds the
 * `overall` pool; it additionally feeds its size / type bucket only when it recorded
 * that footprint signal (diff_lines / path_type) — the documented thin-data caveat.
 */
export function computeEstimateStats(rows: EstimateRow[]): EstimateStats {
  const overall = emptyBucket();
  const size: Record<string, { review: number[]; merge: number[] }> = {};
  const type: Record<string, { review: number[]; merge: number[] }> = {};
  for (const k of SIZE_KEYS) size[k] = emptyBucket();
  for (const k of TYPE_KEYS) type[k] = emptyBucket();

  for (const r of rows) {
    const tr = spanMs(r.started_at, r.completed_at);
    const tm = spanMs(r.started_at, r.merged_at);
    if (tr === null && tm === null) continue; // no usable duration → skip
    const push = (b: { review: number[]; merge: number[] }) => {
      if (tr !== null) b.review.push(tr);
      if (tm !== null) b.merge.push(tm);
    };
    push(overall);
    const sb = sizeBucket(r.diff_lines);
    if (sb) push(size[sb]!);
    const pt = r.path_type as PathType | null;
    if (pt && type[pt]) push(type[pt]!);
  }

  const bs = (b: { review: number[]; merge: number[] }): BucketStat => ({
    toReview: durStat(b.review),
    toMerge: durStat(b.merge),
  });
  return {
    overall: bs(overall),
    size: { small: bs(size.small!), medium: bs(size.medium!), large: bs(size.large!) },
    type: {
      docs: bs(type.docs!),
      webapp: bs(type.webapp!),
      core: bs(type.core!),
      mixed: bs(type.mixed!),
    },
  };
}

// --- a single task's estimate ------------------------------------------------

export type Range = { p50Ms: number; p90Ms: number };
export type Estimate = {
  // Which bucket the numbers came from: a size bucket, a path-type bucket, or the
  // overall pool (the fallback when the specific bucket is thin or unknown).
  basis: "size" | "type" | "overall";
  bucket: string; // "small" | "medium" | "large" | "docs" | … | "all"
  toReview: Range | null; // started→review p50–p90
  toMerge: Range | null; // started→merge p50–p90 (the headline range)
  n: number; // samples behind the chosen bucket (merge count, else review count)
  insufficient: boolean; // true → no usable history; treat as "no estimate"
};

function rangeOf(d: DurStat): Range | null {
  if (d.p50Ms == null || d.p90Ms == null) return null;
  return { p50Ms: d.p50Ms, p90Ms: d.p90Ms };
}
function enough(s: BucketStat): boolean {
  return s.toMerge.n >= MIN_SAMPLES || s.toReview.n >= MIN_SAMPLES;
}

/**
 * Estimate one task's remaining running duration as a p50–p90 RANGE. Prefers the
 * task's size bucket, then its path-type bucket, then the overall pool — using the
 * first that clears MIN_SAMPLES. A queued task with no footprint signal goes
 * straight to overall. When no bucket (overall included) has enough samples the
 * estimate is flagged `insufficient` so the caller renders "insufficient data"
 * rather than a fabricated number.
 */
export function estimateTask(row: EstimateRow, stats: EstimateStats): Estimate {
  let stat = stats.overall;
  let basis: Estimate["basis"] = "overall";
  let bucket = "all";

  const sb = sizeBucket(row.diff_lines);
  const pt = row.path_type as PathType | null;
  if (sb && enough(stats.size[sb])) {
    stat = stats.size[sb];
    basis = "size";
    bucket = sb;
  } else if (pt && stats.type[pt] && enough(stats.type[pt])) {
    stat = stats.type[pt];
    basis = "type";
    bucket = pt;
  }

  const toReview = rangeOf(stat.toReview);
  const toMerge = rangeOf(stat.toMerge);
  // n + the insufficient flag track the HEADLINE range (to-merge preferred, else
  // to-review): we report "insufficient data" rather than guess when no range
  // exists OR when it's backed by fewer than MIN_SAMPLES samples. (A specific
  // size/type bucket is only chosen when it already clears MIN_SAMPLES, so the
  // fallback to the overall pool is the case this thinness check guards.)
  const headline = toMerge || toReview;
  const n = toMerge ? stat.toMerge.n : toReview ? stat.toReview.n : 0;
  return {
    basis,
    bucket,
    toReview,
    toMerge,
    n,
    insufficient: !headline || n < MIN_SAMPLES,
  };
}

// --- dependency-chain / critical-path estimate -------------------------------

export type ChainEstimate = {
  // Approximate total running time of the critical path (longest blocked_by chain),
  // as a p50–p90 range. null when nothing is pending or no path has usable history.
  p50Ms: number | null;
  p90Ms: number | null;
  taskCount: number; // distinct NOT-yet-merged tasks counted on the path closure
  insufficient: boolean; // some pending task on the path had no usable estimate
};

/**
 * Estimate the CRITICAL PATH to finish a set of target tasks (the task itself, or a
 * plan's spawned sub-tasks). For each task, finish = its own to-merge duration + the
 * MAX finish across its blockers (parallel branches take the max), so the total is
 * the longest dependency chain. Already-merged tasks contribute 0 (done); unknown /
 * gone blockers contribute 0. A pending task with no usable estimate contributes 0
 * but flips `insufficient` so the total is shown as a floor, not a promise. p50 and
 * p90 are summed along their own longest paths independently. Cycle-guarded + memoized.
 */
export function estimateChain(
  targetIds: string[],
  rows: EstimateRow[],
  stats: EstimateStats,
): ChainEstimate {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const memo = new Map<string, number>(); // key `${id}:${metric}`
  const visiting = new Set<string>();
  const counted = new Set<string>();
  let insufficient = false;

  function dur(r: EstimateRow, metric: 50 | 90): number {
    if (r.status === "merged") return 0; // already landed
    const est = estimateTask(r, stats);
    if (est.insufficient || !est.toMerge) {
      insufficient = true;
      return 0;
    }
    return metric === 50 ? est.toMerge.p50Ms : est.toMerge.p90Ms;
  }

  function finish(id: string, metric: 50 | 90): number {
    const r = byId.get(id);
    if (!r) return 0; // unknown / gone blocker
    if (visiting.has(id)) return 0; // cycle guard
    const key = `${id}:${metric}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (r.status !== "merged") counted.add(id);
    visiting.add(id);
    let maxBlocker = 0;
    for (const b of r.blocked_by) maxBlocker = Math.max(maxBlocker, finish(b, metric));
    visiting.delete(id);
    const total = dur(r, metric) + maxBlocker;
    memo.set(key, total);
    return total;
  }

  let p50 = 0;
  let p90 = 0;
  for (const id of targetIds) {
    p50 = Math.max(p50, finish(id, 50));
    p90 = Math.max(p90, finish(id, 90));
  }

  // Nothing pending (all targets merged / gone) → a clean "≈0 remaining", not an
  // insufficient-data result.
  if (counted.size === 0) {
    return { p50Ms: 0, p90Ms: 0, taskCount: 0, insufficient: false };
  }
  return { p50Ms: p50, p90Ms: p90, taskCount: counted.size, insufficient };
}
