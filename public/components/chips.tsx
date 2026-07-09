// The CHIP + BADGE cluster, in React. Grows one component per phase as the views that need it land;
// Phase 4b needed exactly one, the status pill, for views/metrics.tsx's status breakdown bars.
// Phase 4c adds the kind badge, for the swimlanes' lane headers and the CTO panel's title.
// Phase 4d adds the rest — `TaskChips`, `TagChips`, `LivenessChip` — for the task detail header,
// which is the surface that consumed all of them.
//
// >>> IMPORT THIS AS `"./chips.tsx"`, WITH THE EXTENSION. <<< The vanilla `components/chips.js` is
// still here — four vanilla views render chips through it — so `"./chips.js"` resolves to THAT file,
// not to this one, under both `tsc` and `bun build`. The explicit `.tsx` is what disambiguates, and
// tsconfig.public.json's `allowImportingTsExtensions` is what permits it. When Phase 4d deletes the
// last vanilla view it deletes chips.js with it, and the specifiers can go back to being extensionless.
//
// >>> THESE ARE CUSTOM, AND THAT IS A DECISION, NOT AN OMISSION. <<<
// RFC §7.2 (CTO decision 7) refutes mapping them onto LaunchPad's `Tag`. `Tag` has EIGHT variants —
// error | default | info | warning | success | beta | federal | new. butchr defines FOURTEEN status
// colours and SEVEN kind colours, each chosen deliberately: feedback states amber/orange, agent
// states blue/indigo, terminal states green/red/brown/gray, and thirteen of the fourteen re-tuned
// again for dark surfaces. Forcing 14 into 8 collapses rolling_back/rolled_back/failed into one red
// and spec_review/in_review into one amber — destroying the at-a-glance colour coding. So: a
// `<span>` styled by the existing `.chip.<status>` rules in style.css.
//
// ESCAPING IS STRUCTURAL AND THERE IS NO WAY TO OPT OUT. JSX escapes every interpolated string by
// construction — there is no `el()` to route around and no `esc()` to forget.
//
// `statusLabel` reads core/state-meta.ts's `STATUS_LABEL`, an `export let` that applyStateMeta
// REASSIGNS once `/api/state-meta` lands. It is called at RENDER time (never snapshotted into a
// module const), and a component that shows a chip must list `useStateMetaVersion()` among its deps
// so React learns the tables were rebuilt — see views/metrics.tsx.
import { AGENT_TYPE, stateKind, statusLabel } from "../core/state-meta.js";
import type { Liveness, TaskView, WorkItem } from "../core/types.js";
import { awaitedLabel, effStatus, kindVisual } from "./chips-logic.js";

/** The status pill. `?? ""` keeps a null status from writing the literal string "undefined" into
 *  the class list — what the old `esc()` used to absorb. */
export function StatusChip({ status }: { status: string | null | undefined }) {
  return <span className={"chip " + (status ?? "")}>{statusLabel(status)}</span>;
}

/**
 * The shared kind-badge — an outlined pill (glyph + label) for a work-item or agent kind.
 *
 * `kindVisual` is the pure, DOM-free lookup behind the vanilla `chips.js`'s `kindBadge()`, and it
 * has an unmapped-kind FALLBACK: an unknown kind (the swimlanes' synthetic `"ungrouped"` lane, say)
 * yields `kind-unknown` plus an upper-cased label, which is precisely the markup that lane used to
 * hand-roll. Do not add a special case for it.
 *
 * The literal space between glyph and label is a real text node — the rendered gap. JSX collapses
 * `{v.glyph} {v.label}` to exactly that, so it survives a formatter.
 */
export function KindBadge({ kind }: { kind: string | null | undefined }) {
  const v = kindVisual(kind);
  return (
    <span className={"kind-badge kind-" + v.cls} title={v.label}>
      {v.glyph} {v.label}
    </span>
  );
}

/** A task's organizational LABELS as a row of neutral chips, distinct from the coloured status
 *  chips. Null when the task has no tags. A tag is the one FREE-FORM operator string on this page;
 *  as a JSX child it reaches the DOM as itself, and there is no `esc()` left to forget. */
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
  const cls = liveness.state === "working" ? "has-running" : liveness.state === "stalled" ? "has-idle" : "has-failed";
  return <span className={"chip " + cls}>{liveness.state}</span>;
}

/** Who is EXPECTED to act on a feedback task, from the server-computed structural
 *  `pending_responder`. Emphasis only — butchr is responder-agnostic and the action controls are
 *  always available. Null when the task is not awaiting feedback. */
function ResponderChip({ responder }: { responder: WorkItem["pending_responder"] }) {
  if (responder === "user") {
    return (
      <span className="chip awaiting-you" title="this is assigned to YOU — act in the controls below">
        awaiting you
      </span>
    );
  }
  if (responder === "cto") {
    return (
      <span className="chip awaiting-cto" title="this is assigned to the CTO agent (handled automatically) — you can also act">
        awaiting CTO
      </span>
    );
  }
  if (responder === "story") {
    return (
      <span className="chip awaiting-cto" title="this is assigned to the story leader (handled automatically) — you can also act">
        awaiting leader
      </span>
    );
  }
  return null;
}

/**
 * A task's badge cluster — the kind badge, the optional plan-preview chip, the status chip, and the
 * optional state-kind / responder / conflict / priority / released chips. Which badges a view shows
 * stays the caller's call; the MARKUP for each lives here only, so a chip's look cannot drift.
 *
 * `stateKind` and `AGENT_TYPE` come from core/state-meta.ts's `export let` tables, which
 * `applyStateMeta` REASSIGNS once `/api/state-meta` lands. They are read at RENDER time, never
 * snapshotted into a module const, and a component that shows a chip must list
 * `useStateMetaVersion()` among its deps so React learns the tables were rebuilt.
 *
 * ⚠ THE SEPARATOR LAYOUT IS ASYMMETRIC — do not "tidy" it into a uniform join. The kind badge and
 * the plan-preview chip each carry a TRAILING `{" "}`; the state-kind, responder, conflict, priority
 * and released chips each carry a LEADING one; the status chip has neither. Each `{" "}` is a real
 * text node and it is the rendered gap between two chips. test/kind-badge.test.ts asserts the exact
 * interleave.
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
  const rc = responder ? <ResponderChip responder={task.pending_responder} /> : null;

  return (
    <>
      {/* Key off the AUTHORITATIVE work_kind, never a hardcoded 'leaf': TaskChips renders both
          TASKS ('leaf') and STORIES ('node'), so a literal would mislabel a story '▪ TASK'. */}
      <KindBadge kind={task.work_kind} />
      {" "}
      {plan && task.plan_preview ? (
        <>
          <span className="chip plan" title="plan-preview gate — proposes a plan and pauses for approval before writing code">
            plan-preview
          </span>
          {" "}
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
            {kindStr + (awaited ? ": " + awaited : "")}
          </span>
        </>
      ) : null}
      {rc ? (
        <>
          {" "}
          {rc}
        </>
      ) : null}
      {task.conflict ? (
        <>
          {" "}
          <span className="chip aborted">conflict</span>
        </>
      ) : null}
      {Number(task.priority) ? (
        <>
          {" "}
          <span className="chip priority" title="dispatch priority — higher runs sooner">
            prio {String(task.priority)}
          </span>
        </>
      ) : null}
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
