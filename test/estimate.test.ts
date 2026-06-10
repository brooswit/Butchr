// Tests for the ROUGH DURATION-ESTIMATE model (see src/estimate.ts, surfaced on
// TaskView.estimate, GET /api/tasks/:id/estimate, and the webapp's task detail).
//
// Pure / in-process: the estimator is a pure function over synthetic EstimateRow
// arrays — no DB, no git, no clock — so these tests seed historical rows directly
// and assert the bucketing, the P50/P90 distributions, the bucket-selection +
// insufficient-data fallback, and the critical-path (chain) sum.
import { describe, expect, test } from "bun:test";
import {
  classifyPathType,
  computeEstimateStats,
  estimateChain,
  estimateTask,
  MIN_SAMPLES,
  sizeBucket,
} from "../src/estimate.ts";
import type { EstimateRow } from "../src/estimate.ts";

const MIN = 60_000; // one minute in ms
const base = "2026-06-10T00:00:00.000Z";
const plus = (mins: number) => new Date(Date.parse(base) + mins * MIN).toISOString();

// Minimal row builder — defaults to a bare queued task with no history/footprint.
function row(over: Partial<EstimateRow> = {}): EstimateRow {
  return {
    id: "t",
    status: "queued",
    started_at: null,
    completed_at: null,
    merged_at: null,
    diff_lines: null,
    path_type: null,
    blocked_by: [],
    ...over,
  };
}

// A merged historical task: started at `base`, reviewed at +review, merged at +merge.
function merged(
  id: string,
  reviewMin: number,
  mergeMin: number,
  extra: Partial<EstimateRow> = {},
): EstimateRow {
  return row({
    id,
    status: "merged",
    started_at: base,
    completed_at: plus(reviewMin),
    merged_at: plus(mergeMin),
    ...extra,
  });
}

describe("sizeBucket", () => {
  test("thresholds (<=30 small, <=150 medium, else large)", () => {
    expect(sizeBucket(0)).toBe("small");
    expect(sizeBucket(30)).toBe("small");
    expect(sizeBucket(31)).toBe("medium");
    expect(sizeBucket(150)).toBe("medium");
    expect(sizeBucket(151)).toBe("large");
    expect(sizeBucket(5000)).toBe("large");
  });
  test("unknown / invalid footprint → null (no size bucket)", () => {
    expect(sizeBucket(null)).toBeNull();
    expect(sizeBucket(undefined)).toBeNull();
    expect(sizeBucket(-1)).toBeNull();
    expect(sizeBucket(NaN)).toBeNull();
  });
});

describe("classifyPathType", () => {
  test("single-category file sets", () => {
    expect(classifyPathType(["src/a.ts", "test/b.test.ts", "bin/x"])).toBe("core");
    expect(classifyPathType(["public/app.js", "public/style.css"])).toBe("webapp");
    expect(classifyPathType(["SPEC.md", "README.md", "docs/guide.txt"])).toBe("docs");
  });
  test("cross-category set → mixed; empty → core", () => {
    expect(classifyPathType(["src/a.ts", "public/app.js"])).toBe("mixed");
    expect(classifyPathType(["SPEC.md", "src/a.ts"])).toBe("mixed");
    expect(classifyPathType([])).toBe("core");
  });
});

describe("computeEstimateStats — P50/P90 buckets", () => {
  test("overall pool + size bucket distributions (nearest-rank percentiles)", () => {
    // 4 small tasks; to-review 10/20/30/40m, to-merge 15/25/35/45m.
    const rows = [
      merged("a", 10, 15, { diff_lines: 5 }),
      merged("b", 20, 25, { diff_lines: 10 }),
      merged("c", 30, 35, { diff_lines: 20 }),
      merged("d", 40, 45, { diff_lines: 30 }),
    ];
    const s = computeEstimateStats(rows);
    // to-review sorted [10,20,30,40] → P50 = rank ceil(.5*4)=2 → 20m; P90 = rank 4 → 40m.
    expect(s.overall.toReview).toEqual({ p50Ms: 20 * MIN, p90Ms: 40 * MIN, n: 4 });
    // to-merge sorted [15,25,35,45] → P50 25m, P90 45m.
    expect(s.overall.toMerge).toEqual({ p50Ms: 25 * MIN, p90Ms: 45 * MIN, n: 4 });
    // all four are small → the size bucket mirrors the overall pool here.
    expect(s.size.small.toMerge).toEqual({ p50Ms: 25 * MIN, p90Ms: 45 * MIN, n: 4 });
    // other size buckets are empty.
    expect(s.size.large.toMerge).toEqual({ p50Ms: null, p90Ms: null, n: 0 });
  });

  test("rows without a footprint feed only the overall pool, not size/type buckets", () => {
    const rows = [
      merged("a", 10, 15), // no diff_lines / path_type
      merged("b", 20, 25),
      merged("c", 30, 35),
    ];
    const s = computeEstimateStats(rows);
    expect(s.overall.toMerge.n).toBe(3);
    expect(s.size.small.toMerge.n).toBe(0);
    expect(s.size.medium.toMerge.n).toBe(0);
    expect(s.type.core.toMerge.n).toBe(0);
  });

  test("review-only rows feed to-review but not to-merge; bad spans dropped", () => {
    const rows = [
      row({ id: "a", status: "review", started_at: base, completed_at: plus(10) }),
      // clock skew (completed before started) → dropped from both
      row({ id: "b", status: "review", started_at: plus(10), completed_at: base }),
      // a real merged task
      merged("c", 20, 30),
    ];
    const s = computeEstimateStats(rows);
    expect(s.overall.toReview.n).toBe(2); // a (10m) + c (20m)
    expect(s.overall.toMerge.n).toBe(1); // only c merged
  });
});

describe("estimateTask — bucket selection + insufficient data", () => {
  // History: 4 small + 3 large merged tasks, so both buckets clear MIN_SAMPLES.
  const history = [
    merged("s1", 10, 12, { diff_lines: 5, path_type: "core" }),
    merged("s2", 10, 12, { diff_lines: 5, path_type: "core" }),
    merged("s3", 10, 12, { diff_lines: 5, path_type: "core" }),
    merged("s4", 10, 12, { diff_lines: 5, path_type: "core" }),
    merged("l1", 100, 120, { diff_lines: 400, path_type: "core" }),
    merged("l2", 100, 120, { diff_lines: 400, path_type: "core" }),
    merged("l3", 100, 120, { diff_lines: 400, path_type: "core" }),
  ];
  const stats = computeEstimateStats(history);

  test("a running task uses its own size bucket", () => {
    const est = estimateTask(
      row({ id: "x", status: "review", diff_lines: 8 }), // small
      stats,
    );
    expect(est.insufficient).toBe(false);
    expect(est.basis).toBe("size");
    expect(est.bucket).toBe("small");
    expect(est.toMerge).toEqual({ p50Ms: 12 * MIN, p90Ms: 12 * MIN });
    expect(est.n).toBe(4);
  });

  test("a large task uses the large bucket (distinct from small)", () => {
    const est = estimateTask(row({ id: "x", status: "running", diff_lines: 500 }), stats);
    expect(est.basis).toBe("size");
    expect(est.bucket).toBe("large");
    expect(est.toMerge).toEqual({ p50Ms: 120 * MIN, p90Ms: 120 * MIN });
    expect(est.n).toBe(3);
  });

  test("a queued task (no footprint) falls back to the overall pool", () => {
    const est = estimateTask(row({ id: "x", status: "queued" }), stats);
    expect(est.basis).toBe("overall");
    expect(est.bucket).toBe("all");
    expect(est.n).toBe(7); // all seven merged tasks
    expect(est.insufficient).toBe(false);
  });

  test("a size bucket below MIN_SAMPLES is NOT used — falls back to overall", () => {
    // medium bucket has 0 samples here, so a medium task uses the overall pool.
    const est = estimateTask(row({ id: "x", status: "review", diff_lines: 100 }), stats);
    expect(est.basis).toBe("overall");
  });

  test("insufficient data when even the overall pool is too thin", () => {
    const thin = computeEstimateStats([merged("a", 10, 12), merged("b", 10, 12)]); // n=2
    expect(MIN_SAMPLES).toBeGreaterThan(2);
    const est = estimateTask(row({ id: "x", status: "queued" }), thin);
    expect(est.insufficient).toBe(true);
    expect(est.n).toBe(2);
  });

  test("insufficient data when there's no history at all", () => {
    const empty = computeEstimateStats([]);
    const est = estimateTask(row({ id: "x", status: "queued" }), empty);
    expect(est.insufficient).toBe(true);
    expect(est.toMerge).toBeNull();
    expect(est.n).toBe(0);
  });
});

describe("estimateChain — critical path", () => {
  // Enough history that every pending task gets a solid 10m (p50) / 10m (p90)
  // to-merge estimate from the overall pool.
  const stats = computeEstimateStats([
    merged("h1", 8, 10),
    merged("h2", 8, 10),
    merged("h3", 8, 10),
  ]);

  test("a linear chain sums along the dependency edges", () => {
    // C depends on B depends on A; each pending → 10m.
    const rows = [
      row({ id: "A", status: "queued" }),
      row({ id: "B", status: "blocked", blocked_by: ["A"] }),
      row({ id: "C", status: "blocked", blocked_by: ["B"] }),
    ];
    const chain = estimateChain(["C"], rows, stats);
    expect(chain.p50Ms).toBe(30 * MIN); // A(10) → B(10) → C(10)
    expect(chain.p90Ms).toBe(30 * MIN);
    expect(chain.taskCount).toBe(3);
    expect(chain.insufficient).toBe(false);
  });

  test("parallel branches take the max(), not the sum", () => {
    // D depends on both B and C; B and C each depend on A. Longest path A→B→D (3 hops).
    const rows = [
      row({ id: "A", status: "queued" }),
      row({ id: "B", status: "blocked", blocked_by: ["A"] }),
      row({ id: "C", status: "blocked", blocked_by: ["A"] }),
      row({ id: "D", status: "blocked", blocked_by: ["B", "C"] }),
    ];
    const chain = estimateChain(["D"], rows, stats);
    expect(chain.p50Ms).toBe(30 * MIN); // A→{B|C}→D, branches max() not summed
    expect(chain.taskCount).toBe(4); // A,B,C,D all pending and counted
  });

  test("a plan's spawned sub-tasks → max finish across them", () => {
    // Plan total = max over leaves. A is shared; B and C are leaves at depth 2.
    const rows = [
      row({ id: "A", status: "queued" }),
      row({ id: "B", status: "blocked", blocked_by: ["A"] }),
      row({ id: "C", status: "blocked", blocked_by: ["A"] }),
    ];
    const chain = estimateChain(["B", "C"], rows, stats);
    expect(chain.p50Ms).toBe(20 * MIN); // A(10) → B/C(10)
    expect(chain.taskCount).toBe(3);
  });

  test("merged blockers contribute 0 (already landed) and aren't counted", () => {
    const rows = [
      merged("A", 8, 10), // already merged
      row({ id: "B", status: "blocked", blocked_by: ["A"] }),
    ];
    const chain = estimateChain(["B"], rows, stats);
    expect(chain.p50Ms).toBe(10 * MIN); // only B's own 10m
    expect(chain.taskCount).toBe(1); // A merged → not counted
  });

  test("a pending task with no usable estimate flags insufficient (floor, not promise)", () => {
    const thin = computeEstimateStats([merged("h1", 8, 10)]); // n=1 < MIN
    const rows = [row({ id: "A", status: "queued" })];
    const chain = estimateChain(["A"], rows, thin);
    expect(chain.insufficient).toBe(true);
    expect(chain.p50Ms).toBe(0); // contributes 0 — a floor
    expect(chain.taskCount).toBe(1);
  });

  test("everything merged / nothing pending → clean ≈0, not insufficient", () => {
    const rows = [merged("A", 8, 10)];
    const chain = estimateChain(["A"], rows, stats);
    expect(chain).toEqual({ p50Ms: 0, p90Ms: 0, taskCount: 0, insufficient: false });
  });

  test("cycle-guarded (a self/mutual dependency doesn't loop forever)", () => {
    const rows = [
      row({ id: "A", status: "blocked", blocked_by: ["B"] }),
      row({ id: "B", status: "blocked", blocked_by: ["A"] }),
    ];
    const chain = estimateChain(["A"], rows, stats);
    expect(chain.taskCount).toBe(2);
    expect(Number.isFinite(chain.p50Ms)).toBe(true);
  });
});
