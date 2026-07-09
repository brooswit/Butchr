// The PANEL cluster — the collapsible scaffold, the container/section helpers the task detail
// composes its body from, and the two review-panel gate badges that hang off them.
//
// WHAT LAUNCHPAD GAVE US, AND WHAT IT DID NOT (RFC §7.1, §7.2).
//   • `collapsible` — the one genuinely stateful component in the old front end, a 38-line
//     hand-rolled caret + head + toggle-body + localStorage dance — IS `Disclosure` /
//     `DisclosurePanel`. Direct. Deleted, not ported.
//   • `rollupPanel`'s progress bar IS `Meter variant="bar"`. Its CSS grid is literally
//     `"label value" / "bar bar"`, it formats `valueText` as a percent from value/min/max, and it
//     fills a track from `--fill-color`. That is exactly what `.rollup-summary` + `.rollup-bar`
//     hand-built, and it deletes two of the three dynamic inline-width divs the prior RFC's
//     Errata #2 named. (The third — the swimlane lane header's 96×6px `.swim-track` — stays
//     bespoke. See views/swimlanes.tsx for why, and it is not laziness.)
//   • Everything else here is a CONTAINER, and LaunchPad has no container layer. No `Card`, no
//     `Panel`, no `Stack`/`Grid`/`Box` — verified against the installed package's 257 exports, not
//     assumed. So `.panel` stays a `<div>` on butchr's own CSS, re-based on `--lp-*` tokens.
//     RFC §7.1 says this plainly rather than inventing a component name.
//
// `CiBadge` lives HERE and not in chips.tsx despite its name: it hangs the CI output tail under
// the badge in a `Disclosure`, so it is a panel that happens to lead with a badge, not a chip.
import { Button, Disclosure, DisclosurePanel, Heading, Meter } from "@launchpad-ui/components";
import { Icon } from "@launchpad-ui/icons";
import type { ReactNode } from "react";
import { useState } from "react";
import { Link } from "react-router";
import type { DependentRollup, TaskView } from "../core/types.ts";
import { effStatus } from "./chips-logic.ts";
import { StatusChip } from "./chips.tsx";

// ---------- collapsible ----------
//
// `Disclosure` owns the open/closed state machine, the `aria-expanded` wiring and the keyboard
// contract. What it does NOT own is butchr's caret or the persisted choice, so both stay here —
// the caret as an `Icon` (`chevron-down` / `chevron-right` are real symbols in the installed
// sprite; checked, not assumed) and the persistence as the same three lines of localStorage.
//
// CONTROLLED, always. Three callers read the open state back — the live-output panel starts and
// stops a poll timer with it, and the transcript lazily fetches on first open — so
// `isExpanded`/`onExpandedChange` is the shape, never `defaultExpanded`.
export function Collapsible({
  title,
  meta,
  isOpen,
  onOpenChange,
  className = "",
  headClassName = "",
  titleClassName,
  metaClassName,
  children,
}: {
  title: string;
  meta?: ReactNode;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
  headClassName?: string;
  titleClassName?: string;
  metaClassName?: string;
  children: ReactNode;
}) {
  return (
    <Disclosure className={className} isExpanded={isOpen} onExpandedChange={onOpenChange}>
      <Heading level={3} className="collapsible-heading">
        <Button slot="trigger" variant="minimal" className={("collapsible-head " + headClassName).trim()}>
          <Icon name={isOpen ? "chevron-down" : "chevron-right"} size="small" className="caret" />
          {title ? <span className={titleClassName}>{title}</span> : null}
          {meta != null ? <span className={metaClassName}>{meta}</span> : null}
        </Button>
      </Heading>
      <DisclosurePanel>{children}</DisclosurePanel>
    </Disclosure>
  );
}

/** `Disclosure` is controlled, so a panel that only wants to REMEMBER the operator's choice keeps
 *  the same localStorage lines `collapsible()` carried. Neither throws (private mode). */
export function readPersisted(key: string | undefined, fallback: boolean): boolean {
  if (!key) return fallback;
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
export function writePersisted(key: string | undefined, open: boolean): void {
  if (!key) return;
  try {
    localStorage.setItem(key, open ? "1" : "0");
  } catch {
    /* private mode — the toggle still works for this session */
  }
}

// ---------- gate badges ----------

/**
 * CI GATE badge for the review panel. `running` shows a spinner; `pass`/`fail` show a green/red
 * badge whose label is the FIRST LINE of `ci_summary` ("build + N tests" / "build failed" /
 * "K test failures"); anything else (null) is a neutral "not run". The rest of `ci_summary` — the
 * output tail — is offered as a collapsible detail so a reviewer can see WHY CI failed.
 */
export function CiBadge({ task }: { task: TaskView }) {
  const status = task.ci_status || null;
  const summary = task.ci_summary || "";
  const nl = summary.indexOf("\n");
  const label = (nl === -1 ? summary : summary.slice(0, nl)).trim();
  const detail = nl === -1 ? "" : summary.slice(nl).trim();
  const [open, setOpen] = useState(false);

  let badge: ReactNode;
  if (status === "running") {
    badge = (
      <span className="ci-badge running">
        <span className="ci-spinner" />
        <span>CI running…</span>
      </span>
    );
  } else if (status === "pass") {
    badge = <span className="ci-badge pass">✓ {label || "build + tests"}</span>;
  } else if (status === "fail") {
    badge = <span className="ci-badge fail">✗ {label || "build failed"}</span>;
  } else {
    badge = <span className="ci-badge none">CI not run</span>;
  }

  return (
    <div className="ci-gate">
      {badge}
      {detail && status !== "running" ? (
        <Collapsible title="output" isOpen={open} onOpenChange={setOpen} className="ci-detail" headClassName="ci-detail-toggle">
          <pre className="block ci-detail-body">{detail}</pre>
        </Collapsible>
      ) : null}
    </div>
  );
}

/**
 * SPEC-CONFORMANCE badge, shown next to the CI badge. `checking` spins; `pass` is a green
 * "conforms"; `concern` is an amber "concern: <reason>" (the reviewer's reason, truncated inline
 * and full on hover); null/absent renders nothing — it is best-effort and may not run.
 *
 * Where CI proves the change builds and its tests pass, this judges whether the diff actually did
 * what the task asked. Orthogonal, and advisory.
 */
export function ConformanceBadge({ task }: { task: TaskView }) {
  const status = task.conformance_status || null;
  if (!status) return null; // not run / couldn't run — show nothing
  const reason = (task.conformance_summary || "").trim();
  if (status === "checking") {
    return (
      <span className="conf-gate">
        <span className="conf-badge checking">
          <span className="ci-spinner" />
          <span>conformance…</span>
        </span>
      </span>
    );
  }
  if (status === "pass") {
    return (
      <span className="conf-gate">
        <span className="conf-badge pass" title={reason || "conforms"}>
          ✓ conforms
        </span>
      </span>
    );
  }
  // 'concern' — amber, with the reviewer's reason inline (truncated) + full on hover.
  const short = reason.length > 140 ? reason.slice(0, 140) + "…" : reason;
  return (
    <span className="conf-gate">
      <span className="conf-badge concern" title={reason || "concern"}>
        ⚠ concern{short ? ": " + short : ""}
      </span>
    </span>
  );
}

// ---------- sections ----------

/** The recurring "<h2> + <pre class=block>" pair of the task detail (prompt, review notes, agent
 *  summary, rescue note). JSX escapes the text child; there is nothing to forget. */
export function Block({ heading, text }: { heading: string; text: string }) {
  return (
    <>
      <h2>{heading}</h2>
      <pre className="block">{text}</pre>
    </>
  );
}

/** One `.blocker-row`: the id (linked to its task) plus an optional status chip. `dead` flags a
 *  terminal blocker that will never merge, which is what makes a stuck `blocked` task obvious. */
export function BlockerRow({ id, status, dead = false }: { id: string; status?: string | null; dead?: boolean }) {
  return (
    <div className={"blocker-row" + (dead ? " dead" : "")}>
      <Link className="bk-id" to={`/task/${id}`}>
        {id}
      </Link>
      {status ? <StatusChip status={status} /> : null}
      {dead ? <span className="bk-dead">will never merge — edit blocked_by to proceed</span> : null}
    </div>
  );
}

/** The scaffold behind the task-detail dependency panels: a `.panel` with a heading, an optional
 *  chain-estimate line, optional `lead` nodes (the rollup's bar), and a `.blockers` list.
 *
 *  The vanilla version carried a warning that `chainLine` must be `null` and NEVER an empty
 *  DocumentFragment, because a fragment is always truthy and would paint a stray empty
 *  `.chain-est`. A falsy JSX child renders nothing, so the hazard died with the fragment. */
export function ListPanel({
  heading,
  className = "",
  chainLine,
  lead,
  children,
}: {
  heading: string;
  className?: string;
  chainLine?: ReactNode;
  lead?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={"panel" + (className ? " " + className : "")}>
      <h2 className="panel-title">{heading}</h2>
      {chainLine ? <div className="chain-est">{chainLine}</div> : null}
      {lead}
      <div className="blockers">{children}</div>
    </div>
  );
}

/**
 * A fraction rendered as a LaunchPad `Meter` — the shared bar behind the sub-task rollup and the
 * initiatives panel.
 *
 * `Meter variant="bar"` lays its children out on a grid: whatever you pass goes in the `label`
 * cell, it renders `valueText` (a percent, from `value`/`minValue`/`maxValue`) in the `value`
 * cell, and the track spans the row beneath. `--fill-color` defaults to LaunchPad's brand cyan;
 * `.lp-fraction` re-points it at butchr's `--merged` green in style.css, which is the same
 * re-basing the `:root` alias block does for `--bg`/`--text`/`--accent`.
 *
 * `maxValue` is floored at 1: react-aria divides by `(maxValue - minValue)`, so a 0/0 rollup
 * would compute NaN% and render `aria-valuenow="NaN"`.
 */
export function FractionMeter({
  done,
  total,
  label,
  ariaLabel,
  className = "",
}: {
  done: number;
  total: number;
  label: ReactNode;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <Meter
      variant="bar"
      className={("lp-fraction " + className).trim()}
      value={done}
      minValue={0}
      maxValue={Math.max(total, 1)}
      aria-label={ariaLabel}
    >
      {label}
    </Meter>
  );
}

/**
 * Render the sub-task progress rollup: "N/M merged", a bar, and the direct dependents with their
 * live statuses, so the gated sub-tree's progress reads at a glance. Live-updates for free — the
 * task page re-fetches on every SSE event. Null when there is nothing to roll up.
 */
export function RollupPanel({ rollup }: { rollup: DependentRollup | null }) {
  if (!rollup) return null;
  const { direct, total, merged } = rollup;
  const nested = total - direct.length;
  return (
    <ListPanel
      heading="Sub-task progress"
      className="rollup-panel"
      lead={
        <>
          <FractionMeter
            done={merged}
            total={total}
            ariaLabel={`${merged} of ${total} sub-tasks merged`}
            label={
              <span className="rollup-frac">
                {merged}/{total} merged
              </span>
            }
          />
          {nested > 0 ? (
            <div className="rollup-nested muted">
              {direct.length} direct · +{nested} nested sub-task{nested === 1 ? "" : "s"}
            </div>
          ) : null}
        </>
      }
    >
      {direct.map((c) => (
        <BlockerRow key={c.id} id={c.id} status={effStatus(c)} />
      ))}
    </ListPanel>
  );
}
