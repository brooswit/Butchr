// Tests for the ONE-WAY CTO notification channel bridge (src/channel.ts).
//
// Pure / in-process only: no real claude, no real butchr server, no socket. We
// drive the bridge's translation logic, the initialize-result shape, the SSE
// reconnect loop (with an injected `open`), and the malformed-input handling
// directly — the same seams main() wires to stdin/stdout/fetch at runtime.
import { describe, expect, test } from "bun:test";
import {
  ATTENTION_STATES,
  AttentionBridge,
  CONNECTIVITY_ONLY_INSTRUCTIONS,
  channelInitializeResult,
  channelNotificationMessage,
  handleRpc,
  makeSseParser,
  runSseLoop,
} from "../src/channel.ts";

// Build a serialized task.updated event the way taskView/SSE would emit it. taskView always
// carries the server-computed STRUCTURAL `pending_responder`, so when a fixture doesn't set
// one we fill it exactly as tasks.pendingResponder would (story member → 'story'; non-story
// awaiting → 'cto', or 'user' once escalated_to_user; null when not awaiting feedback) — the
// channel bridge routes off this field, so an event missing it would not match reality.
function taskUpdated(task: Record<string, unknown>) {
  const t = { ...task };
  if (!("pending_responder" in t)) {
    const idle = t.idle === 1 || t.idle === true;
    const awaiting =
      t.status === "idea" ||
      t.status === "spec_review" ||
      t.status === "in_review" ||
      t.status === "needs_info" ||
      (t.status === "in_progress" && idle);
    t.pending_responder = !awaiting
      ? null
      : t.story_id
      ? "story"
      : t.escalated_to_user
      ? "user"
      : "cto";
  }
  return { type: "task.updated", task: t };
}

// A ReadableStream that emits the given string chunks then closes (one SSE socket).
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

describe("channel: attention transitions → notifications", () => {
  test("emits a correctly-shaped notification for each attention transition", () => {
    const bridge = new AttentionBridge();
    bridge.seedWorkspaceLabels([{ id: "dir-1", label: "webapp" }]);

    const cases: Array<{
      state: string;
      task: Record<string, unknown>;
      expectText: string;
    }> = [
      {
        // `idea` is the front of the pipeline — a brief awaiting a spec, surfaced as
        // `spec requested` (the brief lives in the task's prompt).
        state: "idea",
        task: {
          id: "t-idea",
          workspace_id: "dir-1",
          status: "idea",
          prompt: "add a dark-mode toggle to the header",
        },
        expectText: "add a dark-mode toggle to the header",
      },
      {
        state: "spec_review",
        task: {
          id: "t-spec",
          workspace_id: "dir-1",
          status: "spec_review",
          summary: "Spec: add a widget",
        },
        expectText: "Spec: add a widget",
      },
      {
        state: "in_review",
        task: {
          id: "t-review",
          workspace_id: "dir-1",
          status: "in_review",
          summary: "Implemented the widget",
        },
        expectText: "Implemented the widget",
      },
      {
        state: "needs_info",
        task: {
          id: "t-ask",
          workspace_id: "dir-1",
          status: "needs_info",
          question: "Which color should the widget be?",
        },
        expectText: "Which color should the widget be?",
      },
      {
        // `failed` is a LIVE, DISTINCT terminal state (NOT folded into `aborted`) — a task
        // entering it must fire its own notification carrying the execution error.
        state: "failed",
        task: {
          id: "t-failed",
          workspace_id: "dir-1",
          status: "failed",
          last_dispatch_error: "spawn failed after 5 attempts",
        },
        expectText: "spawn failed after 5 attempts",
      },
      {
        state: "aborted",
        task: {
          id: "t-abort",
          workspace_id: "dir-1",
          status: "aborted",
          revert_reason: "operator aborted the task",
        },
        expectText: "operator aborted the task",
      },
    ];

    for (const c of cases) {
      const note = bridge.consume(taskUpdated(c.task));
      expect(note).not.toBeNull();
      // meta carries the identifier-keyed routing data.
      expect(note!.meta).toEqual({
        task_id: c.task.id as string,
        workspace: "dir-1",
        state: c.state,
      });
      // content is a single human line carrying id, label, state phrase, and text.
      expect(note!.content).toContain(`[${c.task.id}]`);
      expect(note!.content).toContain("webapp");
      expect(note!.content).toContain(c.expectText);
      expect(note!.content).not.toContain("\n");
    }
  });

  test("ATTENTION_STATES are exactly the six CTO attention states", () => {
    expect([...ATTENTION_STATES].sort()).toEqual(
      ["aborted", "failed", "idea", "in_review", "needs_info", "spec_review"].sort(),
    );
  });

  test("an idea task entering the pipeline pushes a `spec requested` event with the brief", () => {
    const bridge = new AttentionBridge();
    bridge.seedWorkspaceLabels([{ id: "dir-1", label: "webapp" }]);
    // A brand-new idea task arrives as a task.created event.
    const note = bridge.consume({
      type: "task.created",
      task: {
        id: "t-new-idea",
        workspace_id: "dir-1",
        status: "idea",
        prompt: "wire up SSO",
        pending_responder: "cto", // a non-story idea resolves to the CTO (as taskView emits)
      },
    });
    expect(note).not.toBeNull();
    expect(note!.meta).toEqual({ task_id: "t-new-idea", workspace: "dir-1", state: "idea" });
    expect(note!.content).toContain("spec requested");
    expect(note!.content).toContain("wire up SSO");
  });

  test("a re-emitted same-status update is NOT a fresh transition", () => {
    const bridge = new AttentionBridge();
    const task = {
      id: "t1",
      workspace_id: "dir-1",
      status: "in_review",
      summary: "done",
    };
    expect(bridge.consume(taskUpdated(task))).not.toBeNull();
    // Same status again (e.g. summary touched) → no duplicate notification.
    expect(bridge.consume(taskUpdated({ ...task, summary: "done v2" }))).toBeNull();
  });

  test("entering an attention state from a non-attention one fires once", () => {
    const bridge = new AttentionBridge();
    const base = { id: "t2", workspace_id: "dir-1" };
    expect(bridge.consume(taskUpdated({ ...base, status: "in_progress" }))).toBeNull();
    const note = bridge.consume(
      taskUpdated({ ...base, status: "needs_info", question: "q?" }),
    );
    expect(note).not.toBeNull();
    expect(note!.meta.state).toBe("needs_info");
  });

  test("falls back to workspace_id when no label is known", () => {
    const bridge = new AttentionBridge();
    const note = bridge.consume(
      taskUpdated({ id: "t3", workspace_id: "dir-x", status: "spec_review" }),
    );
    expect(note!.meta.workspace).toBe("dir-x");
    expect(note!.content).toContain("dir-x");
  });

  test("workspace.updated events refresh the label cache mid-stream", () => {
    const bridge = new AttentionBridge();
    expect(
      bridge.consume({
        type: "workspace.updated",
        workspace: { id: "dir-2", label: "api-server" },
      }),
    ).toBeNull();
    const note = bridge.consume(
      taskUpdated({ id: "t4", workspace_id: "dir-2", status: "in_review", summary: "x" }),
    );
    expect(note!.content).toContain("api-server");
  });
});

describe("channel: idle surface (FW-4 — idle as a feedback condition)", () => {
  test("emits an `idle` notification on the in_progress idle 0→1 flip, with context", () => {
    const bridge = new AttentionBridge();
    // A busy in_progress agent (idle=0) is NOT an attention transition.
    expect(
      bridge.consume(taskUpdated({ id: "x", workspace_id: "d", status: "in_progress", idle: 0 })),
    ).toBeNull();
    // It goes idle (idle=1) → an `idle` notification carrying the captured context.
    const note = bridge.consume(
      taskUpdated({
        id: "x",
        workspace_id: "d",
        status: "in_progress",
        idle: 1,
        idle_context: "…waiting on a 529 retry…",
      }),
    );
    expect(note).not.toBeNull();
    expect(note!.meta.state).toBe("idle");
    expect(note!.meta.task_id).toBe("x");
    expect(note!.content).toContain("agent idle");
    expect(note!.content).toContain("…waiting on a 529 retry…");
  });

  test("a re-render of an ALREADY-idle task does not re-notify", () => {
    const bridge = new AttentionBridge();
    expect(
      bridge.consume(taskUpdated({ id: "y", workspace_id: "d", status: "in_progress", idle: 1, idle_context: "a" })),
    ).not.toBeNull();
    // Same idle task touched again (still idle) → no fresh idle event.
    expect(
      bridge.consume(taskUpdated({ id: "y", workspace_id: "d", status: "in_progress", idle: 1, idle_context: "a" })),
    ).toBeNull();
  });

  test("idle clears then re-fires on a fresh flip; a scoped bridge drops other workspaces", () => {
    const bridge = new AttentionBridge();
    expect(
      bridge.consume(taskUpdated({ id: "z", workspace_id: "d", status: "in_progress", idle: 1, idle_context: "a" })),
    ).not.toBeNull();
    // Output resumed (idle back to 0) — no notification, but the flag is reset…
    expect(
      bridge.consume(taskUpdated({ id: "z", workspace_id: "d", status: "in_progress", idle: 0 })),
    ).toBeNull();
    // …so going idle AGAIN re-fires.
    expect(
      bridge.consume(taskUpdated({ id: "z", workspace_id: "d", status: "in_progress", idle: 1, idle_context: "b" })),
    ).not.toBeNull();

    // A scoped bridge only surfaces its own workspace's idle events.
    const scoped = new AttentionBridge("dir-1");
    expect(
      scoped.consume(taskUpdated({ id: "out", workspace_id: "dir-2", status: "in_progress", idle: 1, idle_context: "c" })),
    ).toBeNull();
    expect(
      scoped.consume(taskUpdated({ id: "in", workspace_id: "dir-1", status: "in_progress", idle: 1, idle_context: "d" })),
    ).not.toBeNull();
  });
});

describe("channel: per-workspace scope", () => {
  test("a scoped bridge emits ONLY its workspace's transitions", () => {
    // butchr launches one bridge per workspace's CTO agent, passing BUTCHR_CHANNEL_WORKSPACE.
    const bridge = new AttentionBridge("dir-1");

    // A task in the SCOPED workspace → a notification.
    const inScope = bridge.consume(
      taskUpdated({ id: "t-in", workspace_id: "dir-1", status: "in_review", summary: "mine" }),
    );
    expect(inScope).not.toBeNull();
    expect(inScope!.meta.workspace).toBe("dir-1");

    // A task in ANOTHER workspace → dropped (only this workspace's CTO sees it).
    const outScope = bridge.consume(
      taskUpdated({ id: "t-out", workspace_id: "dir-2", status: "in_review", summary: "theirs" }),
    );
    expect(outScope).toBeNull();

    // A task with no workspace_id is also out of any non-empty scope.
    const noDir = bridge.consume(
      taskUpdated({ id: "t-none", status: "spec_review", summary: "x" }),
    );
    expect(noDir).toBeNull();
  });

  test("an unscoped bridge (no scope) still emits every workspace's transitions", () => {
    const bridge = new AttentionBridge(); // legacy global feed
    expect(
      bridge.consume(taskUpdated({ id: "a", workspace_id: "dir-1", status: "in_review", summary: "x" })),
    ).not.toBeNull();
    expect(
      bridge.consume(taskUpdated({ id: "b", workspace_id: "dir-2", status: "in_review", summary: "y" })),
    ).not.toBeNull();
  });

  test("an empty/whitespace scope is treated as unscoped", () => {
    const bridge = new AttentionBridge("   ");
    expect(
      bridge.consume(taskUpdated({ id: "c", workspace_id: "dir-9", status: "in_review", summary: "z" })),
    ).not.toBeNull();
  });
});

describe("channel: story scope (story-leader feed + structural routing)", () => {
  // A STORY-LEADER bridge (BUTCHR_CHANNEL_STORY=st-1, in workspace dir-1) and the
  // WORKSPACE/CTO bridge for that same workspace. The leader owns its story's subtasks'
  // feedback + failures (always responder 'story' — terminal at the leader); the CTO owns
  // non-story tasks. A story member NEVER reaches the CTO feed.
  const storyBridge = () => new AttentionBridge("dir-1", false, "st-1");
  const ctoBridge = () => new AttentionBridge("dir-1");

  test("(a) a story member's needs_info routes to the LEADER, not the CTO", () => {
    const task = {
      id: "sm-ask",
      workspace_id: "dir-1",
      status: "needs_info",
      question: "which API?",
      story_id: "st-1",
      pending_responder: "story", // terminal at the leader
    };
    const leader = storyBridge().consume(taskUpdated(task));
    expect(leader).not.toBeNull();
    expect(leader!.meta).toEqual({
      task_id: "sm-ask",
      workspace: "dir-1",
      state: "needs_info",
      story_id: "st-1", // story members carry story_id in meta
    });
    expect(leader!.content).toContain("which API?");
    // The CTO feed NEVER sees a story-member item.
    expect(ctoBridge().consume(taskUpdated(task))).toBeNull();
  });

  test("(c) a story member's failed/aborted routes to the LEADER (a failure has no responder)", () => {
    const failed = {
      id: "sm-fail",
      workspace_id: "dir-1",
      status: "failed",
      last_dispatch_error: "spawn failed",
      story_id: "st-1",
      // pending_responder is null on a terminal failure (not a feedback state).
    };
    const leaderFail = storyBridge().consume(taskUpdated(failed));
    expect(leaderFail).not.toBeNull();
    expect(leaderFail!.meta.state).toBe("failed");
    expect(leaderFail!.meta.story_id).toBe("st-1");
    expect(ctoBridge().consume(taskUpdated(failed))).toBeNull();

    const aborted = {
      id: "sm-abort",
      workspace_id: "dir-1",
      status: "aborted",
      revert_reason: "operator aborted",
      story_id: "st-1",
    };
    expect(storyBridge().consume(taskUpdated(aborted))).not.toBeNull();
    expect(ctoBridge().consume(taskUpdated(aborted))).toBeNull();
  });

  test("(d) a STANDALONE task routes to the CTO exactly as today (regression guard)", () => {
    const task = {
      id: "standalone",
      workspace_id: "dir-1",
      status: "in_review",
      summary: "implemented the widget",
      // no story_id, no pending_responder
    };
    const cto = ctoBridge().consume(taskUpdated(task));
    expect(cto).not.toBeNull();
    // Byte-for-byte today's meta shape — NO story_id key on a standalone task.
    expect(cto!.meta).toEqual({
      task_id: "standalone",
      workspace: "dir-1",
      state: "in_review",
    });
    // A standalone task is not part of any story → the leader bridge drops it.
    expect(storyBridge().consume(taskUpdated(task))).toBeNull();
  });

  test("(e) a non-story cto→user transition while in-state re-fires the CTO feed once", () => {
    const cto = ctoBridge();
    const base = {
      id: "ns-esc",
      workspace_id: "dir-1",
      status: "in_review",
      summary: "standalone change",
      // no story_id
    };
    // Awaiting the CTO ('cto') — the CTO owns + fires it.
    expect(cto.consume(taskUpdated({ ...base, pending_responder: "cto" }))).not.toBeNull();
    // Escalated to the user ('user') with the SAME status — a responder transition. The CTO
    // feed DROPS a 'user' item (the webapp surfaces it), so this does not re-fire here.
    expect(cto.consume(taskUpdated({ ...base, pending_responder: "user" }))).toBeNull();
    // Back to 'cto' (a fresh feedback event reset escalated_to_user) → re-fires once.
    const fired = cto.consume(taskUpdated({ ...base, pending_responder: "cto" }));
    expect(fired).not.toBeNull();
    expect(fired!.meta.state).toBe("in_review");
    // A further re-render with the SAME responder does not re-fire.
    expect(cto.consume(taskUpdated({ ...base, pending_responder: "cto" }))).toBeNull();
  });

  test("a story member's IDLE routes to the leader, not the CTO", () => {
    const idle = {
      id: "sm-idle",
      workspace_id: "dir-1",
      status: "in_progress",
      idle: 1,
      idle_context: "…parked…",
      story_id: "st-1",
      pending_responder: "story", // idle on a story member → the leader (terminal)
    };
    const leaderIdle = storyBridge().consume(taskUpdated(idle));
    expect(leaderIdle).not.toBeNull();
    expect(leaderIdle!.meta.state).toBe("idle");
    expect(leaderIdle!.meta.story_id).toBe("st-1");
    expect(ctoBridge().consume(taskUpdated(idle))).toBeNull();
  });
});

describe("channel: routeOwns (structural — responder-redesign §5)", () => {
  // The CTO feed owns ONLY non-story tasks: a story member ALWAYS belongs to its leader
  // (never the CTO), and a non-story task is owned only when it is awaiting the CTO
  // ('cto') or has FAILED; a non-story 'user' escalation is DROPPED by the CTO bridge.
  const storyBridge = () => new AttentionBridge("dir-1", false, "st-1");
  const ctoBridge = () => new AttentionBridge("dir-1");

  test("a story-member in_review routes to its story-leader bridge, NOT the CTO bridge", () => {
    const task = {
      id: "v2-sm-review",
      workspace_id: "dir-1",
      status: "in_review",
      summary: "implemented subtask",
      story_id: "st-1",
      pending_responder: "story", // a story member always resolves to its leader
    };
    const leader = storyBridge().consume(taskUpdated(task));
    expect(leader).not.toBeNull();
    expect(leader!.meta).toEqual({
      task_id: "v2-sm-review",
      workspace: "dir-1",
      state: "in_review",
      story_id: "st-1",
    });
    // The CTO feed NEVER owns a story member.
    expect(ctoBridge().consume(taskUpdated(task))).toBeNull();
  });

  test("a NON-STORY 'cto' task routes to the CTO bridge", () => {
    const task = {
      id: "v2-cto-review",
      workspace_id: "dir-1",
      status: "in_review",
      summary: "standalone change",
      // no story_id
      pending_responder: "cto",
    };
    const cto = ctoBridge().consume(taskUpdated(task));
    expect(cto).not.toBeNull();
    // Standalone meta stays byte-for-byte today's shape — no story_id key.
    expect(cto!.meta).toEqual({
      task_id: "v2-cto-review",
      workspace: "dir-1",
      state: "in_review",
    });
  });

  test("a NON-STORY escalated_to_user task ('user') is DROPPED by the CTO bridge", () => {
    const task = {
      id: "v2-user-review",
      workspace_id: "dir-1",
      status: "in_review",
      summary: "escalated to the user",
      // no story_id
      pending_responder: "user", // escalated_to_user → resolves to 'user'
    };
    // The CTO feed drops a 'user' item — the webapp/dashboard surfaces it to the user.
    expect(ctoBridge().consume(taskUpdated(task))).toBeNull();
  });

  test("a story-member FAILURE is owned by the STORY-leader bridge, NOT the CTO bridge", () => {
    const failed = {
      id: "v2-sm-fail",
      workspace_id: "dir-1",
      status: "failed",
      last_dispatch_error: "spawn failed",
      story_id: "st-1",
      // a terminal failure has no responder — the explicit status check owns it.
    };
    const leaderFail = storyBridge().consume(taskUpdated(failed));
    expect(leaderFail).not.toBeNull();
    expect(leaderFail!.meta.state).toBe("failed");
    expect(leaderFail!.meta.story_id).toBe("st-1");
    // storyId != null excludes it from the CTO feed.
    expect(ctoBridge().consume(taskUpdated(failed))).toBeNull();

    const aborted = {
      id: "v2-sm-abort",
      workspace_id: "dir-1",
      status: "aborted",
      revert_reason: "operator aborted",
      story_id: "st-1",
    };
    expect(storyBridge().consume(taskUpdated(aborted))).not.toBeNull();
    expect(ctoBridge().consume(taskUpdated(aborted))).toBeNull();
  });
});

describe("channel: story-level attention (Phase 6 — completion + report-up routing)", () => {
  // The story-leader bridge for st-1 (in dir-1) and the workspace/CTO bridge for dir-1.
  const storyBridge = () => new AttentionBridge("dir-1", false, "st-1");
  const ctoBridge = () => new AttentionBridge("dir-1");
  const completionReview = {
    type: "story.attention",
    story_id: "st-1",
    workspace_id: "dir-1",
    target: "story",
    reason: "completion-review",
    detail: "Ship the widget",
  };
  const complete = {
    type: "story.attention",
    story_id: "st-1",
    workspace_id: "dir-1",
    target: "cto",
    reason: "complete",
    detail: "Ship the widget",
  };

  test("a completion-review event routes to the LEADER feed (target 'story'), not the CTO", () => {
    const note = storyBridge().consume(completionReview);
    expect(note).not.toBeNull();
    expect(note!.meta).toEqual({
      story_id: "st-1",
      workspace: "dir-1",
      state: "story_completion_review",
    });
    expect(note!.content).toContain("story ready for completion review");
    expect(note!.content).toContain("Ship the widget");
    // The CTO feed never sees a leader-targeted completion-review.
    expect(ctoBridge().consume(completionReview)).toBeNull();
  });

  test("a complete event routes to the CTO feed (target 'cto'), not the leader", () => {
    const note = ctoBridge().consume(complete);
    expect(note).not.toBeNull();
    expect(note!.meta).toEqual({
      story_id: "st-1",
      workspace: "dir-1",
      state: "story_complete",
    });
    expect(note!.content).toContain("story complete");
    // The leader bridge does not own a CTO-targeted report-up.
    expect(storyBridge().consume(complete)).toBeNull();
  });

  test("a completion-review for a DIFFERENT story is dropped by an st-1 leader bridge", () => {
    const other = { ...completionReview, story_id: "st-2" };
    expect(storyBridge().consume(other)).toBeNull();
  });

  test("a complete for a DIFFERENT workspace is dropped by a dir-1 CTO bridge", () => {
    const other = { ...complete, workspace_id: "dir-2" };
    expect(ctoBridge().consume(other)).toBeNull();
  });

  test("an UNSCOPED CTO bridge owns any workspace's complete event", () => {
    const note = new AttentionBridge().consume({ ...complete, workspace_id: "dir-9" });
    expect(note).not.toBeNull();
    expect(note!.meta.state).toBe("story_complete");
  });

  test("the connectivity-only WORKER bridge never sees story attention", () => {
    const worker = new AttentionBridge("dir-1", /* connectivityOnly */ true, "st-1");
    expect(worker.consume(completionReview)).toBeNull();
    expect(worker.consume(complete)).toBeNull();
  });

  test("a malformed story.attention (missing target/reason) is dropped, not thrown", () => {
    const bridge = storyBridge();
    expect(bridge.consume({ type: "story.attention", story_id: "st-1" })).toBeNull();
    expect(
      bridge.consume({ type: "story.attention", story_id: "st-1", target: "story" }),
    ).toBeNull();
  });
});

describe("channel: story-level ASK routing (responder-redesign §4b)", () => {
  const storyBridge = () => new AttentionBridge("dir-1", false, "st-1");
  const ctoBridge = () => new AttentionBridge("dir-1");
  const ask = {
    type: "story.attention",
    story_id: "st-1",
    workspace_id: "dir-1",
    target: "cto",
    reason: "ask",
    detail: "Which approach: A or B?",
  };
  const askAnswered = {
    type: "story.attention",
    story_id: "st-1",
    workspace_id: "dir-1",
    target: "story",
    reason: "ask-answered",
    detail: "Go with A.",
  };
  // A CTO→user ESCALATION of the open ask — re-published toward the user (target:user).
  const askEscalated = { ...ask, target: "user" };

  test("an `ask` (target cto) routes to the CTO feed, not the leader", () => {
    const note = ctoBridge().consume(ask);
    expect(note).not.toBeNull();
    expect(note!.meta).toEqual({ story_id: "st-1", workspace: "dir-1", state: "story_ask" });
    expect(note!.content).toContain("story ask awaiting an answer");
    expect(note!.content).toContain("Which approach: A or B?");
    expect(storyBridge().consume(ask)).toBeNull();
  });

  test("an `ask-answered` (target story) routes to the LEADER feed, not the CTO", () => {
    const note = storyBridge().consume(askAnswered);
    expect(note).not.toBeNull();
    expect(note!.meta).toEqual({
      story_id: "st-1",
      workspace: "dir-1",
      state: "story_ask_answered",
    });
    expect(note!.content).toContain("story ask answered");
    expect(note!.content).toContain("Go with A.");
    expect(ctoBridge().consume(askAnswered)).toBeNull();
  });

  test("a CTO→user escalated ask (target user) is DROPPED by BOTH the CTO and leader bridges", () => {
    // No channel bridge owns target:user — the dashboard's SSE consumer surfaces it.
    expect(ctoBridge().consume(askEscalated)).toBeNull();
    expect(storyBridge().consume(askEscalated)).toBeNull();
    // Even an UNSCOPED (all-workspaces) CTO bridge drops it.
    expect(new AttentionBridge().consume(askEscalated)).toBeNull();
  });

  test("the connectivity-only WORKER bridge never sees an ask / ask-answered", () => {
    const worker = new AttentionBridge("dir-1", /* connectivityOnly */ true, "st-1");
    expect(worker.consume(ask)).toBeNull();
    expect(worker.consume(askAnswered)).toBeNull();
  });
});

describe("channel: one-way capability (no tools)", () => {
  test("initialize advertises claude/channel and NO tools", () => {
    const res = channelInitializeResult("2025-06-18");
    expect(res.capabilities).toHaveProperty("experimental");
    expect(res.capabilities.experimental).toHaveProperty("claude/channel");
    expect(res.capabilities.experimental["claude/channel"]).toEqual({});
    // ONE-WAY: must NOT advertise tools (nor any other server capability).
    expect((res.capabilities as Record<string, unknown>).tools).toBeUndefined();
    expect((res.capabilities as Record<string, unknown>).resources).toBeUndefined();
    expect((res.capabilities as Record<string, unknown>).prompts).toBeUndefined();
    expect(Object.keys(res.capabilities)).toEqual(["experimental"]);
    expect(typeof res.instructions).toBe("string");
    expect(res.instructions.length).toBeGreaterThan(0);
  });

  test("handleRpc answers initialize/ping and exposes no tools surface", () => {
    const init = handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect((init as any).result.capabilities.experimental).toHaveProperty(
      "claude/channel",
    );
    expect((init as any).result.capabilities.tools).toBeUndefined();

    expect(handleRpc({ jsonrpc: "2.0", id: 2, method: "ping" })).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {},
    });

    // Notifications get no reply.
    expect(
      handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toBeNull();

    // There is no tools/call path — an unknown method is a JSON-RPC error.
    const err = handleRpc({ jsonrpc: "2.0", id: 3, method: "tools/call" });
    expect((err as any).error.code).toBe(-32601);
  });

  test("channelNotificationMessage uses the channel method + params shape", () => {
    const msg = JSON.parse(
      channelNotificationMessage({
        content: "hello",
        meta: { task_id: "t", workspace: "d", state: "in_review" },
      }),
    );
    expect(msg.jsonrpc).toBe("2.0");
    expect(msg.method).toBe("notifications/claude/channel");
    expect(msg.id).toBeUndefined(); // a notification has no id
    expect(msg.params).toEqual({
      content: "hello",
      meta: { task_id: "t", workspace: "d", state: "in_review" },
    });
  });
});

describe("channel: SSE reconnect on drop", () => {
  test("runSseLoop reopens the stream after it ends and keeps consuming", async () => {
    const received: string[] = [];
    let openCount = 0;

    const ev1 = `data: ${JSON.stringify({ type: "hello", n: 1 })}\n\n`;
    const ev2 = `data: ${JSON.stringify({ type: "hello", n: 2 })}\n\n`;

    await runSseLoop({
      url: "http://test/api/events",
      onData: (p) => received.push(p),
      // Each open yields one event then the stream ENDS (a drop) → loop must reconnect.
      open: async () => {
        openCount++;
        return streamOf([openCount === 1 ? ev1 : ev2]);
      },
      // Stop only after we've seen both events (i.e. after the reconnect).
      shouldStop: () => received.length >= 2,
      sleep: async () => {}, // no real backoff delay in the test
    });

    expect(openCount).toBeGreaterThanOrEqual(2); // proves it reconnected
    expect(received.map((p) => JSON.parse(p).n)).toEqual([1, 2]);
  });

  test("runSseLoop survives an open() that throws and retries", async () => {
    let openCount = 0;
    const received: string[] = [];
    await runSseLoop({
      url: "http://test/api/events",
      onData: (p) => received.push(p),
      open: async () => {
        openCount++;
        if (openCount === 1) throw new Error("connection refused");
        return streamOf([`data: ${JSON.stringify({ type: "hello" })}\n\n`]);
      },
      shouldStop: () => received.length >= 1,
      sleep: async () => {},
    });
    expect(openCount).toBeGreaterThanOrEqual(2);
    expect(received.length).toBe(1);
  });

  test("makeSseParser extracts data payloads and skips keepalive comments", () => {
    const out: string[] = [];
    const feed = makeSseParser((p) => out.push(p));
    // Split across chunk boundaries to exercise buffering.
    feed("data: {\"a\":1}\n");
    feed("\n: keepalive\n\n");
    feed('data: {"b":2}\n\n');
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe("channel: malformed / irrelevant events dropped silently", () => {
  test("consume returns null and never throws on bad or irrelevant input", () => {
    const bridge = new AttentionBridge();
    const junk: unknown[] = [
      null,
      undefined,
      42,
      "not an object",
      {},
      { type: "hello", now: "2026-06-11" },
      { type: "task.updated" }, // no task (absent session payload)
      { type: "task.updated", task: null },
      { type: "task.updated", task: {} }, // no id/status
      { type: "task.updated", task: { id: "x" } }, // no status
      { type: "task.updated", task: { id: "x", status: "in_progress" } }, // not attention
      { type: "dispatch.paused", paused: true },
    ];
    for (const j of junk) {
      expect(() => bridge.consume(j)).not.toThrow();
      expect(bridge.consume(j)).toBeNull();
    }
  });
});

describe("channel: connectivity-restored broadcast (global)", () => {
  const restored = (downMs: number) => ({
    type: "connectivity.restored",
    restoredAt: "2026-06-12T10:00:00.000Z",
    downMs,
  });

  test("emits a connectivity_restored notification carrying restored_at + down_ms", () => {
    const bridge = new AttentionBridge();
    const note = bridge.consume(restored(125000)); // 2m 5s
    expect(note).not.toBeNull();
    expect(note!.meta.state).toBe("connectivity_restored");
    expect(note!.meta.restored_at).toBe("2026-06-12T10:00:00.000Z");
    expect(note!.meta.down_ms).toBe(125000);
    // The human content surfaces the recovery + the outage duration.
    expect(note!.content).toContain("RESTORED");
    expect(note!.content).toContain("2m 5s");
  });

  test("is GLOBAL — a workspace-scoped bridge still emits it (not dropped by scope)", () => {
    const bridge = new AttentionBridge("dir-1");
    // A different workspace's attention event is dropped...
    expect(
      bridge.consume(taskUpdated({ id: "t", workspace_id: "dir-2", status: "in_review", summary: "x" })),
    ).toBeNull();
    // ...but the connectivity broadcast is delivered regardless of scope.
    expect(bridge.consume(restored(1000))).not.toBeNull();
  });

  test("handles a missing/invalid duration gracefully", () => {
    const bridge = new AttentionBridge();
    const note = bridge.consume({ type: "connectivity.restored", restoredAt: "x", downMs: -5 });
    expect(note).not.toBeNull();
    expect(note!.meta.down_ms).toBe(0);
    expect(note!.content).toContain("unknown period");
  });
});

describe("channel: connectivity-only mode (worker bridge)", () => {
  test("delivers ONLY connectivity_restored — every attention/idle event is suppressed", () => {
    const bridge = new AttentionBridge("dir-1", /* connectivityOnly */ true);

    // Attention transitions in the bridge's OWN workspace are suppressed (a worker
    // must never see another task's review/idle/attention events).
    expect(
      bridge.consume(taskUpdated({ id: "t1", workspace_id: "dir-1", status: "in_review", summary: "x" })),
    ).toBeNull();
    expect(
      bridge.consume(taskUpdated({ id: "t2", workspace_id: "dir-1", status: "needs_info", question: "q" })),
    ).toBeNull();
    // The idle surface is suppressed too.
    expect(
      bridge.consume(
        taskUpdated({ id: "t3", workspace_id: "dir-1", status: "in_progress", idle: 1, idle_context: "stuck" }),
      ),
    ).toBeNull();

    // But the connectivity broadcast IS delivered.
    const note = bridge.consume({
      type: "connectivity.restored",
      restoredAt: "2026-06-12T10:00:00.000Z",
      downMs: 3000,
    });
    expect(note).not.toBeNull();
    expect(note!.meta.state).toBe("connectivity_restored");
  });

  test("initialize for a connectivity-only bridge advertises the channel + the connectivity-only instructions", () => {
    const res = channelInitializeResult(undefined, /* connectivityOnly */ true);
    expect(res.capabilities.experimental["claude/channel"]).toBeDefined();
    expect((res.capabilities as { tools?: unknown }).tools).toBeUndefined();
    expect(res.instructions).toBe(CONNECTIVITY_ONLY_INSTRUCTIONS);
    expect(res.instructions).not.toContain("spec requested");
  });

  test("handleRpc threads connectivity-only into the initialize instructions", () => {
    const res = handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, true) as {
      result: { instructions: string };
    };
    expect(res.result.instructions).toBe(CONNECTIVITY_ONLY_INSTRUCTIONS);
  });
});
