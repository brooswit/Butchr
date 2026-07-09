// The PANEL cluster — the collapsible scaffold plus the container/section helpers the task
// detail composes its body from, and the two review-panel gate badges that hang off them.
//
// `collapsible` is the anchor: it is the one genuinely STATEFUL component in the front-end
// (it returns a handle `{panel, head, caret, setOpen}` rather than a bare node), and the RFC
// names its shape as the template every other component should grow toward
// (docs/rfc-frontend-design-system.md §3, "The one real component").
//
// `ciBadge` lives HERE and not in chips.js despite its name: it calls `collapsible()` to hang
// the CI output tail under the badge, so it is a panel that happens to lead with a badge, not
// a chip. Grouping it with the chips would force chips.js -> panel.js.
//
// DOM-free at module load, like everything under components/: nothing here touches `document`
// or `localStorage` until a function is CALLED, so this module imports cleanly under a
// non-browser test runner (test/cli-helpers.test.ts imports it directly).
import { el } from "../core/dom.js";
import { chip, effStatus } from "./chips.js";

// ---------- collapsible panel ----------
// Shared scaffold for the caret (▾ open / ▸ closed) + clickable head + toggle-body
// pattern behind the Finished, CI-output, transcript, and live-output panels —
// the one thing those four copied identically: the caret glyph, the open/closed
// CSS-class flip, and (optionally) persisting the choice to localStorage. Each
// panel keeps its own `body` node and its own body-fill / lazy-load / poll logic,
// plugged in via `onToggle(open)` (fired on every user toggle) and re-applied by
// the caller after construction.
//
// State is one CSS class on the panel. By default that class is `collapsed` and is
// present when CLOSED (the panel convention); set `stateMeansOpen` for the inverted
// Finished section, whose `open` class is present when OPEN. `meta` is the trailing
// hint/count span. Returns { panel, head, caret, setOpen }; `setOpen(next, persist?)`
// flips state programmatically.
//
// The diff-file cards deliberately do NOT use this: their caret is a static glyph
// rotated by CSS (`.diff-file.collapsed .caret`), not flipped in JS, so routing
// them through here would require a style.css change.
export function collapsible({
  title = "",
  titleClass,
  meta,
  metaClass,
  body,
  open = false,
  panelClass = "",
  headClass = "",
  stateClass = "collapsed",
  stateMeansOpen = false,
  persistKey,
  onToggle,
} = {}) {
  let isOpen = open;
  const caret = el("span", { class: "caret" }, isOpen ? "▾" : "▸");
  const headKids = [caret];
  if (title) headKids.push(el("span", titleClass ? { class: titleClass } : {}, title));
  if (meta != null) headKids.push(el("span", metaClass ? { class: metaClass } : {}, meta));
  const head = el("button", { class: headClass, type: "button" }, headKids);
  const panel = el("div", { class: panelClass }, body ? [head, body] : [head]);

  const apply = () => {
    panel.classList.toggle(stateClass, stateMeansOpen ? isOpen : !isOpen);
    caret.textContent = isOpen ? "▾" : "▸";
  };
  apply();

  const setOpen = (next, persist = true) => {
    isOpen = next;
    apply();
    if (persist && persistKey) {
      try { localStorage.setItem(persistKey, next ? "1" : "0"); } catch (e) { /* ignore */ }
    }
    if (onToggle) onToggle(next);
  };
  head.addEventListener("click", () => setOpen(!isOpen));
  return { panel, head, caret, setOpen };
}

// CI GATE badge for the review panel. ci_status: 'running' shows a spinner;
// 'pass'/'fail' show a green/red badge whose label is the first line of ci_summary
// ("build + N tests" / "build failed" / "K test failures"); anything else (null)
// is a neutral "not run". The rest of ci_summary (the output tail) is offered as a
// collapsible detail under the badge so a reviewer can see why CI failed.
export function ciBadge(t) {
  const status = t.ci_status || null;
  const summary = t.ci_summary || "";
  const nl = summary.indexOf("\n");
  const label = (nl === -1 ? summary : summary.slice(0, nl)).trim();
  const detail = nl === -1 ? "" : summary.slice(nl).trim();

  const wrap = el("div", { class: "ci-gate" });
  let badge;
  if (status === "running") {
    badge = el("span", { class: "ci-badge running" }, [
      el("span", { class: "ci-spinner" }),
      el("span", {}, "CI running…"),
    ]);
  } else if (status === "pass") {
    badge = el("span", { class: "ci-badge pass" }, "✓ " + (label || "build + tests"));
  } else if (status === "fail") {
    badge = el("span", { class: "ci-badge fail" }, "✗ " + (label || "build failed"));
  } else {
    badge = el("span", { class: "ci-badge none" }, "CI not run");
  }
  wrap.appendChild(badge);

  // Collapsible output tail (only when CI has settled with detail to show).
  if (detail && status !== "running") {
    const pre = el("pre", { class: "block ci-detail-body" }, detail);
    const { panel } = collapsible({
      title: "output",
      body: pre,
      open: false,
      panelClass: "ci-detail",
      headClass: "ci-detail-toggle",
    });
    wrap.appendChild(panel);
  }
  return wrap;
}

// SPEC-CONFORMANCE badge for the review panel, shown next to the CI badge.
// conformance_status: 'checking' shows a spinner; 'pass' shows a green "conforms";
// 'concern' shows an amber "concern: <reason>" (the reviewer's reason in
// conformance_summary); null/absent renders nothing (best-effort — it may not run).
// Whereas CI proves the change builds + tests pass, this judges whether the diff
// actually did what the task asked — an orthogonal, advisory signal.
export function conformanceBadge(t) {
  const status = t.conformance_status || null;
  if (!status) return null; // not run / couldn't run — show nothing
  const reason = (t.conformance_summary || "").trim();
  let badge;
  if (status === "checking") {
    badge = el("span", { class: "conf-badge checking" }, [
      el("span", { class: "ci-spinner" }),
      el("span", {}, "conformance…"),
    ]);
  } else if (status === "pass") {
    badge = el("span", { class: "conf-badge pass", title: reason || "conforms" }, "✓ conforms");
  } else {
    // 'concern' — amber, with the reviewer's reason inline (truncated) + full on hover.
    const short = reason.length > 140 ? reason.slice(0, 140) + "…" : reason;
    badge = el(
      "span",
      { class: "conf-badge concern", title: reason || "concern" },
      "⚠ concern" + (short ? ": " + short : ""),
    );
  }
  return el("span", { class: "conf-gate" }, [badge]);
}

// Append a heading + monospace block pair to `parent`. el() escapes a text child,
// so callers pass the RAW string (no esc()/innerHTML) — the recurring "<h2> + <pre
// class=block>" pair in the task detail (prompt, review notes, summary, output, …).
export function block(heading, text, parent) {
  parent.appendChild(el("h2", {}, heading));
  parent.appendChild(el("pre", { class: "block" }, text));
}

// One ".blocker-row": the id (linked to its task) plus an optional status chip, with
// a "dead" flag (terminal blocker that will never merge) adding the class + warning.
// Pass a falsy `status` to omit the chip (an id-only row).
//
// Built entirely with el() now that chip() returns a node: no innerHTML write, and escaping is
// structural (el() text children go through createTextNode, setAttribute takes a raw value).
export function blockerRow(id, status, { dead = false } = {}) {
  const kids = [el("a", { class: "bk-id", href: "#/task/" + id }, id)];
  if (status) kids.push(chip(status));
  if (dead) kids.push(el("span", { class: "bk-dead" }, "will never merge — edit blocked_by to proceed"));
  return el("div", { class: "blocker-row" + (dead ? " dead" : "") }, kids);
}

// The shared scaffold behind the task-detail dependency panels (blocked-by,
// rollup): a ".panel" (distinguished by `cls`) with a margin-collapsed h2 heading, an
// optional chain-estimate line, optional `lead` nodes (the rollup's summary/bar), and
// a ".blockers" list of `rows`.
export function listPanel(heading, rows, { chainLine, cls = "", lead } = {}) {
  const panel = el("div", { class: "panel" + (cls ? " " + cls : "") });
  panel.appendChild(el("h2", { class: "panel-title" }, heading));
  if (chainLine) panel.appendChild(el("div", { class: "chain-est", html: chainLine }));
  for (const node of [].concat(lead || [])) panel.appendChild(node);
  panel.appendChild(el("div", { class: "blockers" }, rows));
  return panel;
}

// Render the sub-task progress rollup panel: "N/M merged", a progress bar, and the
// direct dependents with their live statuses (so the gated sub-tree's progress reads
// at a glance). Live-updates for free — the task page re-renders on every SSE event.
// Returns null when there's nothing to roll up.
export function rollupPanel(rollup) {
  if (!rollup) return null;
  const { direct, total, merged } = rollup;
  const pct = total ? Math.round((merged / total) * 100) : 0;
  const lead = [
    el("div", { class: "rollup-summary" }, [
      el("span", { class: "rollup-frac" }, `${merged}/${total} merged`),
      el("span", { class: "rollup-pct muted" }, `${pct}%`),
    ]),
    el("div", { class: "rollup-bar", role: "progressbar",
      "aria-valuenow": String(merged), "aria-valuemin": "0", "aria-valuemax": String(total) }, [
      el("div", { class: "rollup-bar-fill", style: `width:${pct}%` }),
    ]),
  ];
  const nested = total - direct.length;
  if (nested > 0) {
    lead.push(el("div", { class: "rollup-nested muted" },
      `${direct.length} direct · +${nested} nested sub-task${nested === 1 ? "" : "s"}`));
  }
  const rows = direct.map((c) => blockerRow(c.id, effStatus(c)));
  return listPanel("Sub-task progress", rows, { cls: "rollup-panel", lead });
}
