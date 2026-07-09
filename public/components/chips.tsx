// The CHIP + BADGE cluster — every small, self-contained status/kind/tag pill the dashboard
// renders. Keeping the markup for a given badge in exactly ONE place here is what stops a chip's
// look from drifting across the views.
//
// >>> THESE ARE CUSTOM, AND THAT IS A DECISION, NOT AN OMISSION. <<<
// RFC §7.2 (CTO-approved, §12.7) refutes mapping them onto LaunchPad's `Tag`. `Tag` has EIGHT
// variants — error | default | info | warning | success | beta | federal | new. butchr defines
// FOURTEEN status colours (style.css:37-50) and SEVEN kind colours, each chosen deliberately:
// feedback states amber/orange, agent states blue/indigo, terminal states green/red/brown/gray.
// Thirteen of the fourteen are re-tuned again for dark surfaces. Forcing 14 into 8 collapses
// rolling_back/rolled_back/failed into one red and spec_review/in_review into one amber —
// destroying the at-a-glance colour coding the Pipeline view exists to provide. `TagGroup`/
// `TagList` are for a REMOVABLE, focusable, keyboard-navigable tag set, which is nowhere in this
// app. So: a `<span>` styled by the existing `--{status}` custom properties.
//
// ESCAPING IS STRUCTURAL, AND THERE IS NO WAY TO OPT OUT. JSX escapes every interpolated string by
// construction — there is no `el()` to route around and no `esc()` to forget. The new footgun with
// the same shape is `dangerouslySetInnerHTML`, and test/no-dangerous-html.test.ts forbids it.
//
// AGENT_TYPE is an `export let` in core/state-meta.ts that applyStateMeta REASSIGNS once
// /api/state-meta lands. Import it as a NAMED BINDING and read it at RENDER time (as TaskChips
// does) — never destructure it into a module const, which would snapshot the empty pre-load table
// and silently break every status chip.
import { AGENT_TYPE, stateKind, statusLabel } from "../core/state-meta.ts";
import type { Liveness, TaskView, WorkItem } from "../core/types.ts";
import { awaitedLabel, effStatus, kindVisual } from "./chips-logic.ts";

/** The status pill. `?? ""` keeps a null status from writing the literal string "undefined" into
 *  the class list — what the old `esc()` used to absorb. */
export function StatusChip({ status }: { status: string | null | undefined }) {
  return <span className={"chip " + (status ?? "")}>{statusLabel(status)}</span>;
}

// Who is EXPECTED to act on a feedback task, read from the server-computed STRUCTURAL
// `pending_responder` (story|cto|user — see tasks.pendingResponder). butchr is
// responder-agnostic, so the action controls are always available; this is emphasis only.
// `user` is surfaced prominently ("awaiting you"); `cto` / `story` are muted ("you can also act")
// since an agent handles it but a human may still act. Returns null when the task isn't awaiting
// feedback (responder null).
//
// Nothing currently passes `responder`, so this is prod-dead but exported. Deleting it is a
// separate cleanup story's call, not this phase's.
export function ResponderChip({ task }: { task: Pick<WorkItem, "pending_responder"> }) {
  const r = task.pending_responder;
  if (r === "user") {
    return (
      <span className="chip awaiting-you" title="this is assigned to YOU — act in the controls below">
        awaiting you
      </span>
    );
  }
  if (r === "cto") {
    return (
      <span className="chip awaiting-cto" title="this is assigned to the CTO agent (handled automatically) — you can also act">
        awaiting CTO
      </span>
    );
  }
  if (r === "story") {
    return (
      <span className="chip awaiting-cto" title="this is assigned to the story leader (handled automatically) — you can also act">
        awaiting leader
      </span>
    );
  }
  return null;
}

/** The shared kind-badge — an outlined pill (glyph + label) for a work-item or agent kind. */
export function KindBadge({ kind }: { kind: string | null | undefined }) {
  const v = kindVisual(kind);
  return (
    <span className={"kind-badge kind-" + v.cls} title={v.label}>
      {v.glyph} {v.label}
    </span>
  );
}

/**
 * A task's badge cluster — the kind badge, the optional plan-preview chip, the status chip, and
 * the optional state-kind / responder / conflict / priority / released chips.
 *
 * Which badges a view shows stays the CALLER's call (the pipeline card stays lean, the detail
 * header shows all); the conflict badge is always included when set, because every view shows it.
 *
 * ⚠ THE SEPARATOR SPACES ARE REAL TEXT NODES AND THE LAYOUT IS ASYMMETRIC — do not "tidy" them
 * into a uniform join. The kind badge and the plan-preview chip each carry a TRAILING space; the
 * state-kind, responder, conflict, priority and released chips each carry a LEADING one; the
 * status chip has neither. Each `{" "}` below is the rendered gap between two chips. JSX drops
 * whitespace that spans a newline, so every one of them is explicit.
 */
export function TaskChips({
  task,
  plan = false,
  kind = false,
  responder = false,
}: {
  task: TaskView | WorkItem;
  plan?: boolean;
  kind?: boolean;
  responder?: boolean;
}) {
  const st = effStatus(task);
  const kindStr = stateKind(st);
  const awaited = awaitedLabel(st);
  const responderChip = responder ? <ResponderChip task={task} /> : null;

  return (
    <>
      {/* Key off the AUTHORITATIVE work_kind, never a hardcoded 'leaf': this renders both TASKS
          ('leaf') and STORIES ('node'), so a literal would mislabel a story '▪ TASK'. */}
      <KindBadge kind={task.work_kind} />{" "}
      {plan && task.plan_preview ? (
        <>
          <span
            className="chip plan"
            title="plan-preview gate — proposes a plan and pauses for approval before writing code"
          >
            plan-preview
          </span>{" "}
        </>
      ) : null}
      <StatusChip status={st} />
      {kind ? (
        <>
          {" "}
          <span
            className={"chip state-kind state-kind-" + kindStr}
            title={
              kindStr === "feedback"
                ? "feedback state — awaiting " + (awaited || "operator response")
                : kindStr === "agent"
                  ? "agent state — " + (AGENT_TYPE[st] || "agent") + " is running"
                  : "idle state"
            }
          >
            {kindStr}
            {awaited ? ": " + awaited : ""}
          </span>
        </>
      ) : null}
      {responderChip ? <> {responderChip}</> : null}
      {task.conflict ? (
        <>
          {" "}
          <span className="chip aborted">conflict</span>
        </>
      ) : null}
      {/* A non-zero dispatch priority jumps the queue — flag it so its order is visible
          (priority 0 is the silent FIFO default, shown on no card). */}
      {Number(task.priority) ? (
        <>
          {" "}
          <span className="chip priority" title="dispatch priority — higher runs sooner">
            prio {String(task.priority)}
          </span>
        </>
      ) : null}
      {/* The version butchr stamped at merge in a release_mode workspace. */}
      {task.released_version ? (
        <>
          {" "}
          <span className="chip released" title="version butchr stamped at merge">
            v{task.released_version}
          </span>
        </>
      ) : null}
    </>
  );
}

/** A task's organizational LABELS as a row of neutral chips (distinct from the coloured status
 *  chips). Null when the task has no tags. A tag is the one FREE-FORM operator string in this
 *  file, which is where escaping matters most — and JSX cannot forget to do it. */
export function TagChips({ task }: { task: Pick<WorkItem, "tags"> }) {
  const tags = Array.isArray(task.tags) ? task.tags : [];
  if (!tags.length) return null;
  return (
    <span className="tag-chips">
      {tags.map((g) => (
        <span className="chip tag" key={g}>
          {g}
        </span>
      ))}
    </span>
  );
}

/** The agent-liveness verdict (working/stalled/dead) as a coloured chip — the idle/stall
 *  dispatcher step's judgement, so the operator reads it off the task view instead of probing
 *  herdr panes by hand. Reuses the status-chip colour classes (running=green, idle=amber,
 *  failed=red). */
export function LivenessChip({ liveness }: { liveness: Liveness }) {
  const cls =
    liveness.state === "working" ? "has-running" : liveness.state === "stalled" ? "has-idle" : "has-failed";
  return <span className={"chip " + cls}>{liveness.state}</span>;
}
