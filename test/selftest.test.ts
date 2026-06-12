// Tests for the SELF-TEST / smoke harness (src/selftest.runSelftest, behind
// `butchr selftest`). The harness is a PURE REST CLIENT, so here we mock the `api`
// client entirely — no real server, no real claude/herdr, no wall-clock waits
// (sleep is a no-op and the clock is a deterministic counter). We assert it walks
// the probe through the lifecycle (resolve → create → dispatch → review → optional
// merge), reports each stage, and ALWAYS cleans up (abort / rollback) on every exit
// path — pass, failure, and timeout.
import { expect, test } from "bun:test";
import { buildProbePrompt, resolveSandbox, runSelftest } from "../src/selftest.ts";
import type { SelftestApi } from "../src/selftest.ts";

/** A deterministic clock: each call advances by 1ms so stage timings are stable. */
function fakeClock() {
  let t = 0;
  return () => ++t;
}

/** No-op sleep so polling loops don't actually wait. */
const noSleep = async () => {};

/**
 * Build a mock `api` that records every call and returns scripted responses. The
 * `tasks` GET sequence is consumed one entry per poll so we can script the
 * queued→running→review progression.
 */
function mockApi(opts: {
  workspaces?: any[];
  created?: any;
  taskSequence?: any[];
  approve?: any;
  onAbort?: () => void;
}): { api: SelftestApi; calls: Array<{ method: string; path: string; body?: unknown }> } {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const seq = [...(opts.taskSequence ?? [])];
  const api: SelftestApi = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET" && path === "/api/workspaces") {
      return opts.workspaces ?? [];
    }
    if (method === "POST" && /\/tasks$/.test(path)) {
      return opts.created ?? { id: "probe-1", status: "queued" };
    }
    if (method === "GET" && /\/api\/tasks\//.test(path)) {
      // Return the next scripted snapshot; stick on the last one once exhausted.
      return seq.length > 1 ? seq.shift() : seq[0];
    }
    if (method === "POST" && /\/approve$/.test(path)) {
      return opts.approve;
    }
    if (method === "POST" && /\/abort$/.test(path)) {
      opts.onAbort?.();
      return { id: "probe-1", status: "aborted" };
    }
    throw new Error(`unexpected call ${method} ${path}`);
  };
  return { api, calls };
}

const SANDBOX = { id: "dir-sandbox", label: "sandbox", path: "/repos/sandbox" };

test("buildProbePrompt sanitizes the marker into the file names", () => {
  const p = buildProbePrompt("run-2026.06");
  expect(p).toContain("selftest_run_2026_06.ts");
  expect(p).toContain("selftest_run_2026_06.test.ts");
  expect(p).toContain("request_review");
});

test("resolveSandbox auto-finds the workspace labelled 'sandbox'", async () => {
  const { api } = mockApi({
    workspaces: [{ id: "d1", label: "Prod", path: "/repos/prod" }, SANDBOX],
  });
  const dir = await resolveSandbox(api);
  expect(dir.id).toBe("dir-sandbox");
});

test("resolveSandbox falls back to a path basename of 'sandbox'", async () => {
  const { api } = mockApi({
    workspaces: [{ id: "d2", label: "scratch", path: "/repos/sandbox" }],
  });
  const dir = await resolveSandbox(api);
  expect(dir.id).toBe("d2");
});

test("resolveSandbox resolves an explicit --dir by id or path", async () => {
  const { api } = mockApi({ workspaces: [SANDBOX, { id: "d3", label: "x", path: "/repos/x" }] });
  expect((await resolveSandbox(api, "d3")).id).toBe("d3");
  expect((await resolveSandbox(api, "/repos/x")).id).toBe("d3");
});

test("resolveSandbox errors clearly when no sandbox is registered", async () => {
  const { api } = mockApi({ workspaces: [{ id: "d1", label: "prod", path: "/repos/prod" }] });
  await expect(resolveSandbox(api)).rejects.toThrow(/no 'sandbox' workspace/);
});

test("happy path (no merge): resolve→create→dispatch→review→abort cleanup", async () => {
  let aborted = false;
  const { api, calls } = mockApi({
    workspaces: [SANDBOX],
    created: { id: "probe-1", status: "in_progress" },
    taskSequence: [
      { id: "probe-1", status: "in_progress" },
      { id: "probe-1", status: "in_progress" },
      { id: "probe-1", status: "in_review", ci_status: "pass" },
    ],
    onAbort: () => (aborted = true),
  });
  const result = await runSelftest({ api, sleep: noSleep, now: fakeClock(), marker: "m1" });

  expect(result.ok).toBe(true);
  expect(result.taskId).toBe("probe-1");
  expect(result.dir?.id).toBe("dir-sandbox");
  expect(result.stages.map((s) => s.name)).toEqual([
    "resolve",
    "create",
    "dispatch",
    "review",
    "cleanup",
  ]);
  expect(result.stages.find((s) => s.name === "review")?.detail).toContain("ci=pass");
  expect(aborted).toBe(true);
  // The probe was tagged so it's identifiable in the UI.
  const createCall = calls.find((c) => c.method === "POST" && /\/tasks$/.test(c.path));
  expect((createCall?.body as any).tags).toEqual(["selftest"]);
});

test("dispatch observed even when polling skips straight to review", async () => {
  const { api } = mockApi({
    workspaces: [SANDBOX],
    taskSequence: [{ id: "probe-1", status: "in_review", ci_status: "pass" }],
  });
  const result = await runSelftest({ api, sleep: noSleep, now: fakeClock(), marker: "m2" });
  expect(result.ok).toBe(true);
  const dispatch = result.stages.find((s) => s.name === "dispatch");
  expect(dispatch?.ok).toBe(true);
  expect(dispatch?.detail).toContain("via in_review");
});

test("--merge: approves, confirms merge, then reverts to clean the sandbox", async () => {
  let revertedWith: { path: string; from: string; to: string } | null = null;
  let aborted = false;
  const { api, calls } = mockApi({
    workspaces: [SANDBOX],
    taskSequence: [
      { id: "probe-1", status: "in_progress" },
      { id: "probe-1", status: "in_review", ci_status: "pass" },
      { id: "probe-1", status: "merged", merge_base_sha: "base0", merged_sha: "tip9" },
    ],
    // Approve runs the mechanical merge synchronously (no conflictSentBack); the merge
    // range comes from the polled merged task.
    approve: { task: { id: "probe-1", status: "merged" } },
    onAbort: () => (aborted = true),
  });
  const result = await runSelftest({
    api,
    sleep: noSleep,
    now: fakeClock(),
    marker: "m3",
    merge: true,
    // Stub the local git revert so no real git runs; just record the call.
    revertMerge: async (path, from, to) => {
      revertedWith = { path, from, to };
    },
  });

  expect(result.ok).toBe(true);
  expect(result.stages.map((s) => s.name)).toContain("merge");
  // The merged probe is cleaned up by reverting its recorded range in the sandbox.
  expect(revertedWith).toEqual({ path: "/repos/sandbox", from: "base0", to: "tip9" });
  expect(result.stages.find((s) => s.name === "cleanup")?.detail).toBe("reverted");
  expect(aborted).toBe(false);
  expect(calls.some((c) => /\/approve$/.test(c.path))).toBe(true);
});

test("--merge failure: a conflict-sent-back approve fails AND still cleans up", async () => {
  let aborted = false;
  const { api } = mockApi({
    workspaces: [SANDBOX],
    taskSequence: [{ id: "probe-1", status: "in_review", ci_status: "pass" }],
    approve: { task: { id: "probe-1", status: "in_progress" }, conflictSentBack: true },
    onAbort: () => (aborted = true),
  });
  const result = await runSelftest({
    api,
    sleep: noSleep,
    now: fakeClock(),
    marker: "m4",
    merge: true,
  });
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/conflict/);
  // Not merged → cleanup aborts the probe.
  expect(aborted).toBe(true);
});

test("probe failing before review is reported and cleaned up", async () => {
  let aborted = false;
  const { api } = mockApi({
    workspaces: [SANDBOX],
    taskSequence: [
      { id: "probe-1", status: "in_progress" },
      { id: "probe-1", status: "aborted", last_dispatch_error: "herdr down" },
    ],
    onAbort: () => (aborted = true),
  });
  const result = await runSelftest({ api, sleep: noSleep, now: fakeClock(), marker: "m5" });
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/aborted.*herdr down/);
  expect(aborted).toBe(true);
});

test("timeout waiting for review fails and still cleans up", async () => {
  let aborted = false;
  const { api } = mockApi({
    workspaces: [SANDBOX],
    // Never advances past in_progress → the deadline is crossed.
    taskSequence: [{ id: "probe-1", status: "in_progress" }],
    onAbort: () => (aborted = true),
  });
  const result = await runSelftest({
    api,
    sleep: noSleep,
    now: fakeClock(),
    marker: "m6",
    timeoutMs: 5, // fakeClock advances 1ms/call, so a few polls exhaust this.
    pollMs: 1,
  });
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/timed out/);
  expect(aborted).toBe(true);
});

test("a failed run whose cleanup ALSO fails surfaces the cleanup failure", async () => {
  const api: SelftestApi = async (method, path) => {
    if (method === "GET" && path === "/api/workspaces") return [SANDBOX];
    if (method === "POST" && /\/tasks$/.test(path)) return { id: "probe-1", status: "queued" };
    if (method === "GET" && /\/api\/tasks\//.test(path)) {
      return { id: "probe-1", status: "aborted", last_dispatch_error: "boom" };
    }
    if (method === "POST" && /\/abort$/.test(path)) throw new Error("abort 500");
    throw new Error(`unexpected ${method} ${path}`);
  };
  const result = await runSelftest({ api, sleep: noSleep, now: fakeClock(), marker: "m7" });
  expect(result.ok).toBe(false);
  const cleanup = result.stages.find((s) => s.name === "cleanup");
  expect(cleanup?.ok).toBe(false);
  expect(cleanup?.detail).toMatch(/FAILED: abort 500/);
});
