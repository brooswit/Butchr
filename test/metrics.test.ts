// Tests for the METRICS aggregation (see db.computeMetrics, surfaced at
// GET /api/metrics and the webapp's Metrics view).
//
// Pure / in-process: computeMetrics is a pure function over raw rows + a fixed
// `now`, so these tests build synthetic MetricRow arrays and assert the derived
// aggregates with NO DB, no git, and no clock dependence.
import { describe, expect, test } from "bun:test";
import { computeMetrics } from "../src/db.ts";
import type { MetricRow } from "../src/db.ts";

// Fixed "now" so the throughput day-buckets are deterministic. 2026-06-10T12:00Z.
const NOW = Date.parse("2026-06-10T12:00:00.000Z");
const DAY = 86_400_000;

// Minimal row builder — every metric field defaults to the empty/zero value.
function r(over: Partial<MetricRow> = {}): MetricRow {
  return {
    status: "queued",
    started_at: null,
    completed_at: null,
    merged_at: null,
    conflict: 0,
    auto_merged: 0,
    revert_reason: null,
    ci_status: null,
    ...over,
  };
}

describe("computeMetrics — counts + throughput", () => {
  test("status counts and total", () => {
    const m = computeMetrics(
      [r({ status: "merged" }), r({ status: "merged" }), r({ status: "running" }), r({ status: "queued" })],
      NOW,
    );
    expect(m.total).toBe(4);
    expect(m.byStatus).toEqual({ merged: 2, running: 1, queued: 1 });
  });

  test("merged-per-day buckets the window, oldest → newest, with zero-fill", () => {
    const today = "2026-06-10T09:00:00.000Z"; // same UTC day as NOW
    const twoDaysAgo = new Date(NOW - 2 * DAY).toISOString();
    const m = computeMetrics(
      [
        r({ status: "merged", merged_at: today }),
        r({ status: "merged", merged_at: today }),
        r({ status: "merged", merged_at: twoDaysAgo }),
        r({ status: "queued" }), // unmerged — ignored
      ],
      NOW,
      7,
    );
    expect(m.throughput.days).toBe(7);
    expect(m.throughput.perDay).toHaveLength(7);
    // last bucket is today; first is 6 days ago; ordered ascending
    expect(m.throughput.perDay[6]!.date).toBe("2026-06-10");
    expect(m.throughput.perDay[0]!.date).toBe("2026-06-04");
    expect(m.throughput.perDay[6]!.count).toBe(2);
    expect(m.throughput.perDay[4]!.count).toBe(1); // 2 days ago
    expect(m.throughput.windowMerged).toBe(3);
    expect(m.throughput.totalMerged).toBe(3);
  });

  test("merges outside the window count toward all-time but not the window", () => {
    const old = new Date(NOW - 30 * DAY).toISOString();
    const m = computeMetrics([r({ status: "merged", merged_at: old })], NOW, 7);
    expect(m.throughput.totalMerged).toBe(1);
    expect(m.throughput.windowMerged).toBe(0);
    expect(m.throughput.perDay.every((d) => d.count === 0)).toBe(true);
  });
});

describe("computeMetrics — medians", () => {
  test("time-to-review (started→completed) and time-to-merge (started→merged)", () => {
    const base = "2026-06-10T00:00:00.000Z";
    const plus = (mins: number) => new Date(Date.parse(base) + mins * 60_000).toISOString();
    const m = computeMetrics(
      [
        // review spans: 10m, 20m, 30m → median 20m
        r({ status: "review", started_at: base, completed_at: plus(10) }),
        r({ status: "merged", started_at: base, completed_at: plus(20), merged_at: plus(60) }),
        r({ status: "review", started_at: base, completed_at: plus(30) }),
      ],
      NOW,
    );
    expect(m.timeToReview.count).toBe(3);
    expect(m.timeToReview.medianMs).toBe(20 * 60_000);
    // only one task merged → its started→merged span (60m) is the median
    expect(m.timeToMerge.count).toBe(1);
    expect(m.timeToMerge.medianMs).toBe(60 * 60_000);
  });

  test("even count averages the two middle spans; non-positive/missing spans are dropped", () => {
    const base = "2026-06-10T00:00:00.000Z";
    const plus = (mins: number) => new Date(Date.parse(base) + mins * 60_000).toISOString();
    const m = computeMetrics(
      [
        r({ status: "review", started_at: base, completed_at: plus(10) }),
        r({ status: "review", started_at: base, completed_at: plus(20) }),
        // completed before started (clock skew) → dropped
        r({ status: "review", started_at: plus(10), completed_at: base }),
        // no started_at → dropped
        r({ status: "review", completed_at: plus(99) }),
      ],
      NOW,
    );
    expect(m.timeToReview.count).toBe(2);
    expect(m.timeToReview.medianMs).toBe(15 * 60_000); // avg(10m, 20m)
    expect(m.timeToMerge.medianMs).toBeNull();
  });
});

describe("computeMetrics — rates", () => {
  test("conflict / revert / CI-pass / auto-merge rates with raw num/of", () => {
    const m = computeMetrics(
      [
        // dispatched + merged, auto-merged, CI pass
        r({ status: "merged", started_at: "x", auto_merged: 1, ci_status: "pass" }),
        // dispatched + merged, human, CI fail, hit a conflict
        r({ status: "merged", started_at: "x", ci_status: "fail", conflict: 1 }),
        // dispatched but reverted off main (ends failed, carries revert_reason)
        r({ status: "failed", started_at: "x", revert_reason: "tests red" }),
        // never dispatched
        r({ status: "queued" }),
      ],
      NOW,
    );
    // conflict: 1 of 3 dispatched
    expect(m.conflictRate).toEqual({ rate: 1 / 3, num: 1, of: 3 });
    // revert: 1 reverted of (2 merged + 1 reverted) = 3 merge attempts
    expect(m.revertRate).toEqual({ rate: 1 / 3, num: 1, of: 3 });
    // CI: 1 pass of (1 pass + 1 fail)
    expect(m.ciPassRate).toEqual({ rate: 1 / 2, num: 1, of: 2 });
    // auto-merge: 1 of 2 merged
    expect(m.autoMergeRate).toEqual({ rate: 1 / 2, num: 1, of: 2 });
  });

  test("zero denominators yield rate=null (no data), not 0 or NaN", () => {
    const m = computeMetrics([r({ status: "queued" })], NOW);
    expect(m.conflictRate.rate).toBeNull();
    expect(m.revertRate.rate).toBeNull();
    expect(m.ciPassRate.rate).toBeNull();
    expect(m.autoMergeRate.rate).toBeNull();
    expect(m.timeToReview.medianMs).toBeNull();
  });
});
