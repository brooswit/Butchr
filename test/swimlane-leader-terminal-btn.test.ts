// The lane header's "Open Leader terminal" gate — leaderTerminalBtnState in the DOM-free leaf
// public/views/swimlanes-logic.js. Imported DIRECTLY with NO DOM stub: that is the point of the
// horizontal split, and this test is the belt that keeps the helper pure.
//
// It reads the `leader` StoryAgentStatus the NodeWorkView already carries, and returns
// {enabled, title}. The button stays VISIBLE-but-disabled when the leader isn't live (rather than
// vanishing) and the title must say WHICH state you're in — a stalled lane is exactly when an
// operator wants to attach. The titles mirror the route's 409 reasons (server.ts:
// POST /api/work/:id/leader/terminal) so the two surfaces never contradict.
import { expect, test } from "bun:test";
import { leaderTerminalBtnState } from "../public/views/swimlanes-logic.js";

test("live leader → enabled, with the attach title", () => {
  const s = leaderTerminalBtnState({ desired: true, running: true });
  expect(s.enabled).toBe(true);
  expect(s.title).toBe("Attach a terminal to the live leader agent");
});

test("desired but not running → disabled, and says it is starting", () => {
  const s = leaderTerminalBtnState({ desired: true, running: false });
  expect(s.enabled).toBe(false);
  expect(s.title).toContain("starting");
  expect(s.title).not.toContain("torn down");
});

test("torn down / never launched → disabled, and says so", () => {
  const s = leaderTerminalBtnState({ desired: false, running: false });
  expect(s.enabled).toBe(false);
  expect(s.title).toContain("torn down or never launched");
  expect(s.title).not.toContain("starting");
});

// `lastError` can be STALE from an earlier restart while the leader is genuinely starting now, so
// it is shown as EVIDENCE, never as a verdict of "crashed".
test("a lastError is surfaced as evidence, naming BOTH possibilities", () => {
  const s = leaderTerminalBtnState({ desired: true, running: false, lastError: "boom: exit 1" });
  expect(s.enabled).toBe(false);
  expect(s.title).toContain("boom: exit 1");
  expect(s.title).toContain("starting, or it crashed");
});

// A running leader wins even with a stale lastError on the row — liveness is the fact, the error is
// history.
test("running wins over a stale lastError", () => {
  expect(leaderTerminalBtnState({ desired: true, running: true, lastError: "old" }).enabled).toBe(true);
});

// The three not-live titles must be mutually distinguishable — the same HONEST contract the route's
// 409 reasons carry.
test("the not-live titles are all different", () => {
  const titles = [
    leaderTerminalBtnState({ desired: false, running: false }).title,
    leaderTerminalBtnState({ desired: true, running: false }).title,
    leaderTerminalBtnState({ desired: true, running: false, lastError: "x" }).title,
  ];
  expect(new Set(titles).size).toBe(3);
});

// Pure and total: a story whose view carries no leader object at all must not throw.
test("a missing leader object is tolerated (disabled, honest)", () => {
  expect(leaderTerminalBtnState(undefined).enabled).toBe(false);
  expect(leaderTerminalBtnState(null).enabled).toBe(false);
  expect(leaderTerminalBtnState({}).title).toContain("torn down or never launched");
});
