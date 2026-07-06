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
  type ChannelNotification,
  channelInitializeResult,
  channelNotificationMessage,
  handleRpc,
  makeSseParser,
  resyncAttention,
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

// A fake `fetch` serving the REST surface resyncAttention reads: the scoped work LIST at
// `/api/work` and per-item full TaskViews at `/api/work/:id`. Records every requested URL so a
// test can assert scoping + that only attention-surface leaves were fetched.
function makeFakeFetch(
  list: unknown[],
  views: Record<string, unknown>,
): { f: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const f = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/api/work/")) {
      const id = decodeURIComponent(url.split("/api/work/")[1]!);
      const v = views[id];
      return { ok: v != null, status: v != null ? 200 : 404, json: async () => v };
    }
    return { ok: true, status: 200, json: async () => list };
  }) as unknown as typeof fetch;
  return { f, urls };
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

describe("channel: routeOwns PROJECT scope (REVAMP-4 P3b — the CEO feed)", () => {
  // A project-scoped (CEO) bridge owns an item whose OWNING PROJECT (project_id) matches its
  // scope AND that is awaiting the CEO ('ceo') OR failed/aborted/dead-blocked — the exact project
  // mirror of the story-leader branch. Bridges: pr-1's CEO feed, pr-2's CEO feed, the CTO feed,
  // and a st-1 leader feed. DORMANT in prod (no BUTCHR_CHANNEL_PROJECT set, no project nodes), so
  // every EXISTING story/cto case above is untouched; these exercise the reachable-via-test shapes.
  const projectBridge = (p: string) => new AttentionBridge("dir-1", false, "", p);
  const ctoBridge = () => new AttentionBridge("dir-1");
  const leaderBridge = () => new AttentionBridge("dir-1", false, "st-1");
  const globalBridge = () => new AttentionBridge();

  // A ceo item: a work item whose IMMEDIATE parent is a project → taskView carries project_id (and
  // NULLs story_id) and pendingResponder resolves to 'ceo'.
  const ceoItem = {
    id: "v3-ceo-review",
    workspace_id: "dir-1",
    status: "in_review",
    summary: "project-direct change",
    project_id: "pr-1",
    pending_responder: "ceo",
  };

  test("a 'ceo' item routes to its OWN project bridge, with project_id (not story_id) in meta", () => {
    const ceo = projectBridge("pr-1").consume(taskUpdated(ceoItem));
    expect(ceo).not.toBeNull();
    // project_id is the project mirror of story_id — present, and NO story_id key.
    expect(ceo!.meta).toEqual({
      task_id: "v3-ceo-review",
      workspace: "dir-1",
      state: "in_review",
      project_id: "pr-1",
    });
  });

  test("a 'ceo' item is NOT owned by ANOTHER project's bridge, the CTO feed, or a leader feed", () => {
    expect(projectBridge("pr-2").consume(taskUpdated(ceoItem))).toBeNull();
    expect(ctoBridge().consume(taskUpdated(ceoItem))).toBeNull();
    expect(leaderBridge().consume(taskUpdated(ceoItem))).toBeNull();
  });

  test("BYTE-IDENTICAL: with NO project scope, a 'ceo' item is owned by NO bridge (dropped)", () => {
    // The dormant P3a behavior: no project-scoped bridge exists, so a 'ceo' item falls through
    // every feed to the webapp/user surface — exactly as before this change.
    expect(ctoBridge().consume(taskUpdated(ceoItem))).toBeNull();
    expect(leaderBridge().consume(taskUpdated(ceoItem))).toBeNull();
    expect(globalBridge().consume(taskUpdated(ceoItem))).toBeNull();
  });

  test("a FAILED direct-project-child is owned by its project bridge, NOT leaked to the CTO feed", () => {
    // A terminal failure has no responder — the explicit status check owns it, keyed on project_id
    // (mirrors a story member's failure keyed on story_id).
    const failed = {
      id: "v3-ceo-fail",
      workspace_id: "dir-1",
      status: "failed",
      last_dispatch_error: "spawn failed",
      project_id: "pr-1",
    };
    const owned = projectBridge("pr-1").consume(taskUpdated(failed));
    expect(owned).not.toBeNull();
    expect(owned!.meta.state).toBe("failed");
    expect(owned!.meta.project_id).toBe("pr-1");
    // The CTO fall-through's `projectId == null` guard keeps a failed project-child off the CTO feed
    // (story_id is now null on such an item, so without the guard it WOULD have leaked).
    expect(ctoBridge().consume(taskUpdated(failed))).toBeNull();
    // ...and another project's bridge does not own it.
    expect(projectBridge("pr-2").consume(taskUpdated(failed))).toBeNull();

    const aborted = { ...failed, id: "v3-ceo-abort", status: "aborted" };
    expect(projectBridge("pr-1").consume(taskUpdated(aborted))).not.toBeNull();
    expect(ctoBridge().consume(taskUpdated(aborted))).toBeNull();
  });

  test("a DEAD-BLOCKED item in a project's subtree is owned by its project bridge, not the CTO", () => {
    const dead = {
      id: "v3-ceo-db",
      workspace_id: "dir-1",
      status: "blocked",
      deadBlockers: ["t-blocker"],
      project_id: "pr-1",
      pending_responder: null,
    };
    const owned = projectBridge("pr-1").consume(taskUpdated(dead));
    expect(owned).not.toBeNull();
    expect(owned!.meta).toEqual({
      task_id: "v3-ceo-db",
      workspace: "dir-1",
      state: "dead_blocked",
      project_id: "pr-1",
    });
    expect(ctoBridge().consume(taskUpdated(dead))).toBeNull();
  });

  test("BYTE-IDENTICAL: a non-project 'cto' task is still owned by the CTO feed (projectId==null guard)", () => {
    // The new `projectId == null` guard must not regress the ordinary CTO feed: a standalone task
    // carries no project_id → the guard is satisfied → still owned, byte-for-byte today's meta.
    const cto = ctoBridge().consume(
      taskUpdated({
        id: "v3-plain-cto",
        workspace_id: "dir-1",
        status: "in_review",
        summary: "standalone change",
        pending_responder: "cto",
      }),
    );
    expect(cto).not.toBeNull();
    expect(cto!.meta).toEqual({ task_id: "v3-plain-cto", workspace: "dir-1", state: "in_review" });
  });
});

describe("channel: dead-blocked attention (F3 — a `blocked` task stuck on a never-merging dep)", () => {
  // The serialized TaskView a blocked task emits: status `blocked` with a non-empty deadBlockers
  // set (its aborted/failed/rolled_back/gone blockers). A blocked task is not awaiting feedback,
  // so pending_responder is null — the dead-blocked surface is purely the deadBlockers set.
  const deadBlocked = (over: Record<string, unknown> = {}) => ({
    id: "t-dead",
    workspace_id: "dir-1",
    status: "blocked",
    deadBlockers: ["t-blocker"],
    pending_responder: null,
    ...over,
  });

  test("a blocked task with a non-empty deadBlockers set pushes a dead_blocked notification", () => {
    const bridge = new AttentionBridge();
    bridge.seedWorkspaceLabels([{ id: "dir-1", label: "webapp" }]);
    const note = bridge.consume(taskUpdated(deadBlocked()));
    expect(note).not.toBeNull();
    expect(note!.meta).toEqual({ task_id: "t-dead", workspace: "dir-1", state: "dead_blocked" });
    expect(note!.content).toContain("blocked on a DEAD (never-merging) dependency");
    // Names the offending blocker so the operator knows what to edit out of blocked_by.
    expect(note!.content).toContain("t-blocker");
  });

  test("a blocked task with NO dead blockers (still-pending deps) is NOT a surface", () => {
    const bridge = new AttentionBridge();
    expect(bridge.consume(taskUpdated(deadBlocked({ deadBlockers: [] })))).toBeNull();
    expect(bridge.consume(taskUpdated(deadBlocked({ deadBlockers: undefined })))).toBeNull();
  });

  test("dead-blocked emits only on the 0→1 flip — a re-render does not re-notify", () => {
    const bridge = new AttentionBridge();
    expect(bridge.consume(taskUpdated(deadBlocked()))).not.toBeNull(); // first time → push
    expect(bridge.consume(taskUpdated(deadBlocked()))).toBeNull(); // unchanged re-render → silent
  });

  test("clearing the dead block (operator edits blocked_by → inactive) stops surfacing", () => {
    const bridge = new AttentionBridge();
    expect(bridge.consume(taskUpdated(deadBlocked()))).not.toBeNull();
    // Unblocked to inactive → no longer a surface; a fresh dead-block later would flip 0→1 again.
    expect(
      bridge.consume(taskUpdated(deadBlocked({ status: "inactive", deadBlockers: [] }))),
    ).toBeNull();
  });

  test("the connectivity-only WORKER bridge never sees a dead-blocked task", () => {
    const worker = new AttentionBridge("dir-1", /* connectivityOnly */ true);
    expect(worker.consume(taskUpdated(deadBlocked()))).toBeNull();
  });

  test("a dead-blocked STORY member routes to its LEADER, not the CTO feed", () => {
    const member = deadBlocked({ id: "t-dead-member", story_id: "st-1" });
    // The st-1 leader bridge owns its member's dead-block...
    const leaderNote = new AttentionBridge("dir-1", false, "st-1").consume(taskUpdated(member));
    expect(leaderNote).not.toBeNull();
    expect(leaderNote!.meta).toEqual({
      task_id: "t-dead-member",
      workspace: "dir-1",
      state: "dead_blocked",
      story_id: "st-1",
    });
    // ...and the CTO feed (non-story only) never owns a story member's dead-block.
    expect(new AttentionBridge("dir-1").consume(taskUpdated(member))).toBeNull();
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

  test("a member-blocked event (F4) routes to the LEADER feed (target 'story'), not the CTO", () => {
    const memberBlocked = {
      type: "story.attention",
      story_id: "st-1",
      workspace_id: "dir-1",
      target: "story",
      reason: "member-blocked",
      detail: "Ship the widget",
    };
    const note = storyBridge().consume(memberBlocked);
    expect(note).not.toBeNull();
    expect(note!.meta).toEqual({
      story_id: "st-1",
      workspace: "dir-1",
      state: "story_member_blocked",
    });
    expect(note!.content).toContain("story BLOCKED");
    // The CTO feed never sees a leader-targeted member-blocked.
    expect(ctoBridge().consume(memberBlocked)).toBeNull();
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

describe("channel: story-ask CEO escalation routing + resync (REVAMP-4 P3f)", () => {
  // A story-ask escalated ONE rung above the CTO — to the CEO of the story's owning project.
  // escalateStoryAsk stamps `target:'ceo'` + the owning `project_id` (+ a de-dup marker) so ONLY the
  // matching project bridge owns it; a `user`-target (the terminal, one rung higher) is still owned
  // by no bridge. Bridges: pr-1's CEO feed, pr-2's CEO feed, the CTO feed, a leader feed, global.
  const projectBridge = (p: string) => new AttentionBridge("dir-1", false, "", p);
  const ctoBridge = () => new AttentionBridge("dir-1");
  const leaderBridge = () => new AttentionBridge("dir-1", false, "st-1");
  const globalBridge = () => new AttentionBridge();
  const ceoAsk = {
    type: "story.attention",
    story_id: "st-1",
    workspace_id: "dir-1",
    target: "ceo",
    project_id: "pr-1",
    reason: "ask",
    detail: "Cross-repo scope call?",
    marker: "Cross-repo scope call?",
  };

  test("a `ceo` ask routes to its OWN project bridge (state story_ask), not others", () => {
    const note = projectBridge("pr-1").consume(ceoAsk);
    expect(note).not.toBeNull();
    expect(note!.meta).toEqual({ story_id: "st-1", workspace: "dir-1", state: "story_ask" });
    expect(note!.content).toContain("story ask awaiting an answer");
    expect(note!.content).toContain("Cross-repo scope call?");
    // Another project's CEO feed, the CTO feed, a leader feed, and the global feed all DROP it.
    expect(projectBridge("pr-2").consume(ceoAsk)).toBeNull();
    expect(ctoBridge().consume(ceoAsk)).toBeNull();
    expect(leaderBridge().consume(ceoAsk)).toBeNull();
    expect(globalBridge().consume(ceoAsk)).toBeNull();
  });

  test("a `ceo` ask with NO project_id is owned by no bridge (can't match a scope)", () => {
    const { project_id, ...noProj } = ceoAsk;
    expect(projectBridge("pr-1").consume(noProj)).toBeNull();
  });

  test("BYTE-IDENTICAL: a `user`-target ask (terminal rung) is still dropped by every bridge", () => {
    const userAsk = { ...ceoAsk, target: "user", project_id: undefined };
    expect(projectBridge("pr-1").consume(userAsk)).toBeNull();
    expect(ctoBridge().consume(userAsk)).toBeNull();
    expect(leaderBridge().consume(userAsk)).toBeNull();
    expect(globalBridge().consume(userAsk)).toBeNull();
  });

  test("resyncAttention re-derives a ceo-owned ask to the CORRECT project bridge after a reconnect", async () => {
    // A node still holding a pending_ask escalated to the CEO of pr-1. Its owning project is the
    // node's `ask_project_id` ({ceo} rung of its ladder) — NOT its own project_id (a story node's
    // immediate parent is a repo). The resync re-derives it into a target:'ceo' event for pr-1.
    const node = {
      id: "st-1",
      work_kind: "node",
      workspace_id: "dir-1",
      status: "open",
      pending_ask: "Cross-repo scope call?",
      ask_responder: "ceo",
      ask_project_id: "pr-1",
      project_id: null,
    };
    const { f } = makeFakeFetch([node], {});

    const pr1: ChannelNotification[] = [];
    await resyncAttention({
      baseUrl: "http://x",
      bridge: projectBridge("pr-1"),
      emit: (n) => pr1.push(n),
      scopeProject: "pr-1",
      fetchImpl: f,
    });
    expect(pr1).toHaveLength(1);
    expect(pr1[0]!.meta).toEqual({ story_id: "st-1", workspace: "dir-1", state: "story_ask" });

    // The WRONG project's bridge re-derives nothing (ask_project_id !== scopeProject)...
    const pr2: ChannelNotification[] = [];
    await resyncAttention({
      baseUrl: "http://x",
      bridge: projectBridge("pr-2"),
      emit: (n) => pr2.push(n),
      scopeProject: "pr-2",
      fetchImpl: makeFakeFetch([node], {}).f,
    });
    expect(pr2).toHaveLength(0);

    // ...and a CTO bridge skips a ceo-owned ask entirely (its scan re-derives only ask_responder=cto).
    const cto: ChannelNotification[] = [];
    await resyncAttention({
      baseUrl: "http://x",
      bridge: ctoBridge(),
      emit: (n) => cto.push(n),
      fetchImpl: makeFakeFetch([node], {}).f,
    });
    expect(cto).toHaveLength(0);
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

  test("runSseLoop runs onConnect on the FIRST open AND every reconnect (before draining)", async () => {
    const connects: number[] = [];
    let openCount = 0;
    const ev = (n: number) => `data: ${JSON.stringify({ type: "hello", n })}\n\n`;
    const received: string[] = [];

    await runSseLoop({
      url: "http://test/api/events",
      onData: (p) => received.push(p),
      open: async () => {
        openCount++;
        return streamOf([ev(openCount)]);
      },
      // Record the open# at the moment onConnect fires — proves it runs BEFORE draining
      // (the event for this open has not been pushed yet) and on EVERY connect.
      onConnect: () => {
        connects.push(openCount);
      },
      shouldStop: () => received.length >= 2,
      sleep: async () => {},
    });

    // Fired on the first open (1) and again on the reconnect (2) — not reconnect-only.
    expect(connects).toEqual([1, 2]);
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

describe("channel: re-sync scoped attention on (re)connect", () => {
  test("re-emits a transition MISSED during the gap, and does NOT re-emit a delivered one", async () => {
    const bridge = new AttentionBridge("dir-1");

    // t-delivered: its in_review transition was already PUSHED before the gap, so it is
    // already reflected in the bridge's in-memory maps.
    expect(
      bridge.consume(
        taskUpdated({ id: "t-delivered", workspace_id: "dir-1", status: "in_review", summary: "old diff" }),
      ),
    ).not.toBeNull();

    // The REST snapshot at reconnect time: both attention tasks still outstanding, plus an
    // active (non-attention) leaf, a different-workspace task, and a story node — all of which
    // must NOT trigger a per-item fetch.
    const list = [
      { work_kind: "leaf", id: "t-delivered", workspace_id: "dir-1", status: "in_review" },
      { work_kind: "leaf", id: "t-missed", workspace_id: "dir-1", status: "needs_info" },
      { work_kind: "leaf", id: "t-active", workspace_id: "dir-1", status: "in_progress", idle: 0 },
      { work_kind: "node", id: "st-x", workspace_id: "dir-1", status: "in_review" },
    ];
    const views: Record<string, unknown> = {
      "t-delivered": {
        id: "t-delivered", workspace_id: "dir-1", status: "in_review",
        summary: "old diff", pending_responder: "cto",
      },
      "t-missed": {
        id: "t-missed", workspace_id: "dir-1", status: "needs_info",
        question: "which db?", pending_responder: "cto",
      },
    };

    const { f, urls } = makeFakeFetch(list, views);
    const emitted: ChannelNotification[] = [];
    await resyncAttention({
      baseUrl: "http://test", bridge, scopeDir: "dir-1",
      emit: (n) => emitted.push(n), fetchImpl: f,
    });

    // Only the MISSED transition is recovered; the already-delivered one is NOT duplicated.
    expect(emitted.map((n) => n.meta.task_id)).toEqual(["t-missed"]);
    expect(emitted[0]!.meta.state).toBe("needs_info");
    expect(emitted[0]!.content).toContain("which db?");
    // The list fetch was scoped to the bridge's workspace; only attention-surface LEAVES were
    // fetched per-item (no active leaf, no different-workspace task, no story node).
    expect(urls[0]).toContain("/api/work?workspace=dir-1");
    expect(urls.some((u) => u.includes("/api/work/t-active"))).toBe(false);
    expect(urls.some((u) => u.includes("/api/work/st-x"))).toBe(false);

    // A SECOND re-sync (e.g. a later reconnect) with the maps now populated emits nothing new.
    const { f: f2 } = makeFakeFetch(list, views);
    const emitted2: ChannelNotification[] = [];
    await resyncAttention({
      baseUrl: "http://test", bridge, scopeDir: "dir-1",
      emit: (n) => emitted2.push(n), fetchImpl: f2,
    });
    expect(emitted2).toEqual([]);
  });

  test("a story-leader bridge re-syncs only ITS story's subtasks", async () => {
    const bridge = new AttentionBridge("dir-1", false, "st-1");
    const list = [
      // belongs to this story → owned by the leader (subtask feedback resolves to 'story')
      { work_kind: "leaf", id: "t-mine", workspace_id: "dir-1", story_id: "st-1", status: "needs_info" },
      // a different story's subtask → filtered out (no per-item fetch)
      { work_kind: "leaf", id: "t-other", workspace_id: "dir-1", story_id: "st-2", status: "needs_info" },
    ];
    const views: Record<string, unknown> = {
      "t-mine": {
        id: "t-mine", workspace_id: "dir-1", story_id: "st-1", status: "needs_info",
        question: "branch?", pending_responder: "story",
      },
    };
    const { f, urls } = makeFakeFetch(list, views);
    const emitted: ChannelNotification[] = [];
    await resyncAttention({
      baseUrl: "http://test", bridge, scopeDir: "dir-1", scopeStory: "st-1",
      emit: (n) => emitted.push(n), fetchImpl: f,
    });
    expect(emitted.map((n) => n.meta.task_id)).toEqual(["t-mine"]);
    expect(emitted[0]!.meta.story_id).toBe("st-1");
    expect(urls.some((u) => u.includes("/api/work/t-other"))).toBe(false);
  });

  test("re-emits a DEAD_BLOCKED transition missed during the gap, and does NOT duplicate it", async () => {
    const bridge = new AttentionBridge("dir-1");
    // A leaf that entered the dead_blocked surface during the gap (status='blocked' with a dead
    // blocker) — the bridge has never seen it, so its maps are pre-attention.
    const list = [
      { work_kind: "leaf", id: "t-dead", workspace_id: "dir-1", status: "blocked", deadBlockers: ["t-gone"] },
      // a plain blocked leaf with NO dead blockers is NOT on the surface → no per-item fetch.
      { work_kind: "leaf", id: "t-live-block", workspace_id: "dir-1", status: "blocked", deadBlockers: [] },
    ];
    const views: Record<string, unknown> = {
      "t-dead": {
        id: "t-dead", workspace_id: "dir-1", status: "blocked",
        deadBlockers: ["t-gone"], pending_responder: null,
      },
    };
    const { f, urls } = makeFakeFetch(list, views);
    const emitted: ChannelNotification[] = [];
    await resyncAttention({
      baseUrl: "http://test", bridge, scopeDir: "dir-1",
      emit: (n) => emitted.push(n), fetchImpl: f,
    });
    // The dead_blocked transition is recovered; the live-blocked leaf is never fetched.
    expect(emitted.map((n) => n.meta.task_id)).toEqual(["t-dead"]);
    expect(emitted[0]!.meta.state).toBe("dead_blocked");
    expect(emitted[0]!.content).toContain("t-gone");
    expect(urls.some((u) => u.includes("/api/work/t-live-block"))).toBe(false);

    // A SECOND re-sync with the maps now populated emits nothing new (no duplicate).
    const { f: f2 } = makeFakeFetch(list, views);
    const emitted2: ChannelNotification[] = [];
    await resyncAttention({
      baseUrl: "http://test", bridge, scopeDir: "dir-1",
      emit: (n) => emitted2.push(n), fetchImpl: f2,
    });
    expect(emitted2).toEqual([]);
  });

  test("a failed list fetch is swallowed (best-effort) — no throw, no emit", async () => {
    const bridge = new AttentionBridge("dir-1");
    const f = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    const emitted: ChannelNotification[] = [];
    await expect(
      resyncAttention({ baseUrl: "http://test", bridge, scopeDir: "dir-1", emit: (n) => emitted.push(n), fetchImpl: f }),
    ).resolves.toBeUndefined();
    expect(emitted).toEqual([]);
  });
});

// STORY-CONTAINER reconnect-resync (the st-ad96e5c3 follow-up to st-fffc76a8). resyncAttention now
// re-derives outstanding story.attention surfaces from the REST work view's NODE rows and feeds them
// through bridge.consume(), inheriting the Part-1 marker de-dup so each is delivered EXACTLY ONCE.
describe("channel: story-container reconnect-resync (st-ad96e5c3)", () => {
  // A CTO-owned story `ask` node: pending_ask set + ask_responder 'cto'.
  const askNode = (over: Record<string, unknown> = {}) => ({
    work_kind: "node",
    id: "st-1",
    workspace_id: "dir-1",
    status: "open",
    brief: "Ship the widget",
    pending_ask: "Approve plan A?",
    ask_responder: "cto",
    counts: {},
    ...over,
  });
  // A leader-owned completion-review node: an OPEN story whose members are all merged. counts.merged
  // === total ⇒ the resync derives completion-review with marker = String(merged).
  const completeNode = (over: Record<string, unknown> = {}) => ({
    work_kind: "node",
    id: "st-1",
    workspace_id: "dir-1",
    status: "open",
    brief: "Ship the widget",
    pending_ask: null,
    ask_responder: null,
    counts: { merged: 2 },
    ...over,
  });

  test("a story ask AND a completion-review MISSED during the gap are each delivered exactly once", async () => {
    // CTO bridge: the story `ask` fired during the gap (the bridge never saw it live) → resync recovers it.
    const cto = new AttentionBridge("dir-1");
    const { f: fAsk } = makeFakeFetch([askNode()], {});
    const askEmitted: ChannelNotification[] = [];
    await resyncAttention({
      baseUrl: "http://test", bridge: cto, scopeDir: "dir-1",
      emit: (n) => askEmitted.push(n), fetchImpl: fAsk,
    });
    expect(askEmitted.map((n) => n.meta.state)).toEqual(["story_ask"]);
    expect(askEmitted[0]!.meta.story_id).toBe("st-1");
    expect(askEmitted[0]!.content).toContain("Approve plan A?");
    // A SECOND reconnect (state unchanged) re-derives the SAME marker → suppressed (exactly once).
    const { f: fAsk2 } = makeFakeFetch([askNode()], {});
    const askEmitted2: ChannelNotification[] = [];
    await resyncAttention({
      baseUrl: "http://test", bridge: cto, scopeDir: "dir-1",
      emit: (n) => askEmitted2.push(n), fetchImpl: fAsk2,
    });
    expect(askEmitted2).toEqual([]);

    // LEADER bridge: the completion-review fired during the gap → resync recovers it.
    const leader = new AttentionBridge("dir-1", false, "st-1");
    const { f: fDone } = makeFakeFetch([completeNode()], {});
    const doneEmitted: ChannelNotification[] = [];
    await resyncAttention({
      baseUrl: "http://test", bridge: leader, scopeDir: "dir-1", scopeStory: "st-1",
      emit: (n) => doneEmitted.push(n), fetchImpl: fDone,
    });
    expect(doneEmitted.map((n) => n.meta.state)).toEqual(["story_completion_review"]);
    expect(doneEmitted[0]!.meta.story_id).toBe("st-1");
    // And exactly once: a second reconnect with the same merged-count marker is suppressed.
    const { f: fDone2 } = makeFakeFetch([completeNode()], {});
    const doneEmitted2: ChannelNotification[] = [];
    await resyncAttention({
      baseUrl: "http://test", bridge: leader, scopeDir: "dir-1", scopeStory: "st-1",
      emit: (n) => doneEmitted2.push(n), fetchImpl: fDone2,
    });
    expect(doneEmitted2).toEqual([]);
  });

  test("a story.attention already DELIVERED live is NOT re-emitted on a later reconnect", async () => {
    const leader = new AttentionBridge("dir-1", false, "st-1");
    // The live completion-review event (marker = merged count "2") was pushed before the gap.
    const live = leader.consume({
      type: "story.attention", story_id: "st-1", workspace_id: "dir-1",
      target: "story", reason: "completion-review", detail: "Ship the widget", marker: "2",
    });
    expect(live).not.toBeNull();
    // On reconnect the REST node re-derives the SAME marker ("2") → the resync emits nothing.
    const { f } = makeFakeFetch([completeNode()], {});
    const emitted: ChannelNotification[] = [];
    await resyncAttention({
      baseUrl: "http://test", bridge: leader, scopeDir: "dir-1", scopeStory: "st-1",
      emit: (n) => emitted.push(n), fetchImpl: f,
    });
    expect(emitted).toEqual([]);
  });

  test("a legitimately RE-FIRED completion-review (a fix-subtask lands) DOES emit again", () => {
    const leader = new AttentionBridge("dir-1", false, "st-1");
    const base = {
      type: "story.attention", story_id: "st-1", workspace_id: "dir-1",
      target: "story", reason: "completion-review", detail: "Ship the widget",
    } as const;
    // First completion-review with 2 members merged.
    expect(leader.consume({ ...base, marker: "2" })).not.toBeNull();
    // Re-feeding the SAME marker is suppressed (de-dup).
    expect(leader.consume({ ...base, marker: "2" })).toBeNull();
    // A fix-subtask lands while merge_blocked → merged count rises to 3 → a NEW marker → re-fires.
    const refire = leader.consume({ ...base, marker: "3" });
    expect(refire).not.toBeNull();
    expect(refire!.meta.state).toBe("story_completion_review");
  });

  test("leaf AND story-container surfaces both resync in ONE pass (st-fffc76a8 leaf path unchanged)", async () => {
    const leader = new AttentionBridge("dir-1", false, "st-1");
    // One outstanding subtask leaf (a leaf surface) AND the story node ready for completion review.
    const list = [
      { work_kind: "leaf", id: "t-mine", workspace_id: "dir-1", story_id: "st-1", status: "needs_info" },
      completeNode(),
    ];
    const views: Record<string, unknown> = {
      "t-mine": {
        id: "t-mine", workspace_id: "dir-1", story_id: "st-1", status: "needs_info",
        question: "branch?", pending_responder: "story",
      },
    };
    const { f } = makeFakeFetch(list, views);
    const emitted: ChannelNotification[] = [];
    await resyncAttention({
      baseUrl: "http://test", bridge: leader, scopeDir: "dir-1", scopeStory: "st-1",
      emit: (n) => emitted.push(n), fetchImpl: f,
    });
    // The leaf (needs_info) is recovered exactly as before, AND the story-container completion-review.
    expect(emitted.map((n) => n.meta.state).sort()).toEqual(
      ["needs_info", "story_completion_review"].sort(),
    );
    expect(emitted.find((n) => n.meta.state === "needs_info")!.meta.task_id).toBe("t-mine");
    expect(emitted.find((n) => n.meta.state === "story_completion_review")!.meta.story_id).toBe("st-1");
  });

  test("a merge_blocked story re-derives BOTH completion-review and gate-red (benign overlap)", async () => {
    const leader = new AttentionBridge("dir-1", false, "st-1");
    const { f } = makeFakeFetch(
      [completeNode({ status: "merge_blocked" })],
      {},
    );
    const emitted: ChannelNotification[] = [];
    await resyncAttention({
      baseUrl: "http://test", bridge: leader, scopeDir: "dir-1", scopeStory: "st-1",
      emit: (n) => emitted.push(n), fetchImpl: f,
    });
    // Distinct reasons → distinct de-dup keys → both push once on this recovering reconnect.
    expect(emitted.map((n) => n.meta.state).sort()).toEqual(
      ["story_completion_review", "story_gate_red"].sort(),
    );
  });
});
