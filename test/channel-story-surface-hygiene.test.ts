// Robustness regression tests for src/channel.ts story-surface hygiene
// (story st-71bd5527 subtask A):
//   F1 — the deliveredStory de-dup set is now bounded (BoundedKeySet, FIFO cap)
//        so a long-lived bridge can't leak one entry per distinct `ask` marker.
//   F2 — leaderStorySurfaces guards the gate-red push on `total > 0`, matching
//        completion-review and member-blocked, so a degenerate zero-member
//        merge_blocked story emits NO gate-red.
import { describe, expect, test } from "bun:test";
import { BoundedKeySet, leaderStorySurfaces } from "../src/channel.ts";

describe("F1 — BoundedKeySet FIFO cap", () => {
  test("evicts the oldest key once the cap is exceeded", () => {
    const s = new BoundedKeySet(3);
    s.add("a");
    s.add("b");
    s.add("c");
    expect(s.size).toBe(3);
    // adding a 4th key evicts the oldest ("a")
    s.add("d");
    expect(s.size).toBe(3);
    expect(s.has("a")).toBe(false);
    expect(s.has("b")).toBe(true);
    expect(s.has("c")).toBe(true);
    expect(s.has("d")).toBe(true);
  });

  test("a re-add of an evicted key is treated as new (would re-emit)", () => {
    const s = new BoundedKeySet(2);
    s.add("a");
    s.add("b");
    s.add("c"); // evicts "a"
    expect(s.has("a")).toBe(false);
    // "a" comes back as a fresh key — de-dup would NOT suppress it
    s.add("a"); // evicts "b" (now the oldest)
    expect(s.has("a")).toBe(true);
    expect(s.has("b")).toBe(false);
    expect(s.has("c")).toBe(true);
    expect(s.size).toBe(2);
  });

  test("re-adding an existing key does not grow the set or evict", () => {
    const s = new BoundedKeySet(2);
    s.add("a");
    s.add("b");
    s.add("a"); // already present — no growth, no eviction
    expect(s.size).toBe(2);
    expect(s.has("a")).toBe(true);
    expect(s.has("b")).toBe(true);
  });
});

describe("F2 — leaderStorySurfaces gate-red total>0 guard", () => {
  const reasons = (node: Record<string, unknown>) =>
    leaderStorySurfaces(node).map((e) => e.reason);

  test("merge_blocked with zero members produces NO gate-red surface", () => {
    const node = {
      id: "st-zero",
      workspace_id: "dir-x",
      status: "merge_blocked",
      counts: {}, // total === 0
    };
    expect(reasons(node)).not.toContain("gate-red");
    // and consistent with the other guards — nothing fires for a memberless story
    expect(leaderStorySurfaces(node)).toHaveLength(0);
  });

  test("merge_blocked with members still produces a gate-red surface", () => {
    const node = {
      id: "st-one",
      workspace_id: "dir-x",
      status: "merge_blocked",
      counts: { merged: 1 }, // total === 1, all merged
    };
    const out = leaderStorySurfaces(node);
    const gateRed = out.find((e) => e.reason === "gate-red");
    expect(gateRed).toBeDefined();
    expect(gateRed!.marker).toBe("1");
  });
});
