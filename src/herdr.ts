// herdr CLI wrapper. butchr delegates ALL terminal/agent session management to
// herdr: it owns PTYs, butchr owns task state. We shell out to the `herdr` CLI,
// which speaks to the running herdr server over its unix socket and replies with
// a JSON envelope: {"id": "...", "result": { ... }}.
import { config } from "./config.ts";
import { readBoundedTail, run, sleep, stripAnsi } from "./exec.ts";
// The runtime-handle types + the backend interface live in harness.ts (which owns
// the abstraction's contract). We import them TYPE-ONLY (erased at runtime, so no
// import cycle: harness.ts imports `herdrRunner` from here as a value) and re-export
// the handle types so herdr.ts's existing importers keep working unchanged.
import type {
  AgentRunner,
  HeadlessResult,
  HeadlessSpec,
  PaneInfo,
  SendInput,
  StartedAgent,
  Tab,
  Workspace,
} from "./harness.ts";
export type { PaneInfo, SendInput, StartedAgent, Tab, Workspace };

type Envelope = { id?: string; result?: any; error?: any };

// We read `config.herdrBin` at each call site (rather than caching it once at
// module load) so a test can repoint the bin — `config.herdrBin` never changes at
// runtime in production, so this is byte-for-byte the same value either way.
async function herdr(
  args: string[],
  timeoutMs: number = config.herdrTimeoutMs,
): Promise<any> {
  const res = await run([config.herdrBin, ...args], { timeoutMs });
  if (!res.ok) {
    throw new Error(
      `herdr ${args.join(" ")} failed (${res.code}): ${res.stderr || res.stdout}`,
    );
  }
  const text = res.stdout.trim();
  if (!text) return {};
  let env: Envelope;
  try {
    env = JSON.parse(text);
  } catch {
    // Some commands print plain text; return it raw.
    return { _raw: text };
  }
  if (env.error) {
    throw new Error(`herdr ${args.join(" ")} error: ${JSON.stringify(env.error)}`);
  }
  return env.result ?? env;
}

/**
 * Soft sibling of `herdr()`: run a herdr command and unwrap its JSON envelope,
 * returning `null` instead of throwing on ANY failure — a non-zero exit, empty
 * output, non-JSON output, an `error` field, OR a TIMEOUT (a wedged herdr that
 * doesn't reply within `timeoutMs` makes `run()` return code 124 / ok:false, which
 * maps here to `null` just like any other failure). The probe/read functions below
 * use this so a missing/broken/HUNG herdr degrades to their default
 * (`undefined`/`[]`/`""`) rather than propagating or hanging. On success returns the
 * unwrapped `env.result ?? env` for the caller to field-probe.
 */
async function herdrSoft(
  args: string[],
  timeoutMs: number = config.herdrTimeoutMs,
): Promise<any | null> {
  const res = await run([config.herdrBin, ...args], { timeoutMs });
  if (!res.ok) return null;
  const text = res.stdout.trim();
  if (!text) return null;
  try {
    const env: Envelope = JSON.parse(text);
    if (env.error) return null;
    return env.result ?? env;
  } catch {
    return null;
  }
}

/** Is the herdr server reachable? */
export async function isUp(): Promise<boolean> {
  const res = await run([config.herdrBin, "status", "server"], {
    timeoutMs: config.herdrTimeoutMs,
  });
  return res.ok && /status:\s*running/.test(res.stdout);
}

/**
 * Shared existence probe: run a `<noun> get <id>` and report whether the entity is
 * present. herdr exits non-zero (or prints an `"error"` envelope) when the entity is
 * gone, so existence is `res.ok && !res.stdout.includes('"error"')`. The `res.ok`
 * guard matters: a non-zero exit with empty stdout must read as ABSENT (without it a
 * crashed/unreachable herdr would falsely report the entity present).
 */
async function existsByGet(args: string[]): Promise<boolean> {
  const res = await run([config.herdrBin, ...args], {
    timeoutMs: config.herdrTimeoutMs,
  });
  return res.ok && !res.stdout.includes('"error"');
}

/** Provision a herdr workspace for a registered workspace. Returns it + root pane id. */
export async function workspaceCreate(
  cwd: string,
  label: string,
): Promise<Workspace> {
  const r = await herdr([
    "workspace", "create", "--cwd", cwd, "--label", label, "--no-focus",
  ], config.herdrStartTimeoutMs);
  return {
    workspaceId: r.workspace?.workspace_id ?? r.root_pane?.workspace_id,
    rootPaneId: r.root_pane?.pane_id,
  };
}

/** Does a workspace still exist? (herdr may have been restarted/closed.) */
export async function workspaceExists(workspaceId: string): Promise<boolean> {
  if (!workspaceId) return false;
  return existsByGet(["workspace", "get", workspaceId]);
}

/** Tear a workspace down. */
export async function workspaceClose(workspaceId: string): Promise<void> {
  if (!workspaceId) return;
  await herdr(["workspace", "close", workspaceId]).catch(() => {});
}

/**
 * Create a dedicated herdr TAB for a task (one tab per task — the operator's
 * requirement). Returns the new tab id and the id of the empty root pane herdr
 * spawns inside it. We start the agent in this tab via `agentStart({tabId})`;
 * passing `--tab` makes herdr place the agent in THIS tab instead of splitting
 * the currently-focused tab (the old behavior that produced a wall of panes).
 *
 * Best-effort: returns `{}` (no tabId) on any failure so the caller can fall back
 * to the implicit-split path rather than failing the whole dispatch.
 */
export async function tabCreate(
  workspaceId: string | undefined,
  cwd: string,
  label: string,
): Promise<Tab> {
  try {
    const args = ["tab", "create", "--cwd", cwd, "--label", label, "--no-focus"];
    if (workspaceId) args.push("--workspace", workspaceId);
    const r = await herdr(args, config.herdrStartTimeoutMs);
    return {
      tabId: r.tab?.tab_id ?? r.root_pane?.tab_id ?? r.tab_id,
      rootPaneId: r.root_pane?.pane_id ?? r.pane?.pane_id,
    };
  } catch {
    return {};
  }
}

/** Close a herdr tab (kills every pane/agent inside it and removes the tab). */
export async function tabClose(tabId: string | null | undefined): Promise<void> {
  if (!tabId) return;
  await run([config.herdrBin, "tab", "close", tabId], {
    timeoutMs: config.herdrTimeoutMs,
  }).catch(() => {});
}

// Field-probes over a single `agent get` envelope. herdr response shapes vary
// slightly by version, so each handle is probed across the common field paths. Kept
// as standalone helpers so `agentInfo` derives all three from ONE payload.
function pickTabId(r: any): string | undefined {
  return r.agent?.tab_id ?? r.pane?.tab_id ?? r.root_pane?.tab_id ?? r.tab_id ?? undefined;
}
function pickPaneId(r: any): string | undefined {
  return (
    r.pane?.pane_id ?? r.root_pane?.pane_id ?? r.pane_id ?? r.terminal_id ??
    r.terminal?.terminal_id ?? undefined
  );
}
function pickTerminalId(r: any): string | undefined {
  return r.agent?.terminal_id ?? r.terminal_id ?? r.pane?.terminal_id ?? undefined;
}

/**
 * One `agent get <name>` round-trip, returning the agent's tab/pane/terminal handles
 * probed from the SAME envelope — so callers that need more than one handle (or the
 * three single-handle readers below) don't each re-fetch the identical payload.
 * Returns null when there is no such agent / herdr can't read it.
 */
async function agentInfo(
  name: string,
): Promise<{ tabId?: string; paneId?: string; terminalId?: string } | null> {
  if (!name) return null;
  const r = await herdrSoft(["agent", "get", name]);
  if (!r) return null;
  return { tabId: pickTabId(r), paneId: pickPaneId(r), terminalId: pickTerminalId(r) };
}

/**
 * The tab id backing the agent terminal named `name`, or undefined if there is no
 * such agent / we can't determine it. Used to derive a task's tab for teardown
 * when it wasn't persisted (e.g. a re-adopted agent, or reclaiming a stale name).
 */
export async function agentTabId(name: string): Promise<string | undefined> {
  return (await agentInfo(name))?.tabId;
}

/**
 * Start an agent process rooted at `cwd` (the task worktree). `argv` is the
 * command to run, e.g. ["bash", "-lc", "<agent cmd>"]. The agent name is set to
 * the task id for easy lookup.
 *
 * When `tabId` is given the agent is placed in THAT tab (`--tab`), so each task
 * lands in its own dedicated tab; herdr would otherwise split the focused tab. We
 * drop `--workspace` in that case — the tab already pins the workspace, and
 * passing both is redundant. Without a tabId we fall back to the workspace-scoped
 * implicit split (legacy path / tabCreate failure).
 */
export async function agentStart(
  name: string,
  cwd: string,
  argv: string[],
  workspaceId?: string,
  tabId?: string,
): Promise<StartedAgent> {
  const args = ["agent", "start", name, "--cwd", cwd, "--no-focus"];
  if (tabId) args.push("--tab", tabId);
  else if (workspaceId) args.push("--workspace", workspaceId);
  args.push("--", ...argv);
  const r = await herdr(args, config.herdrStartTimeoutMs);
  // Response shapes vary slightly by herdr version; probe common fields.
  let paneId =
    r.agent?.pane_id ?? r.pane?.pane_id ?? r.root_pane?.pane_id ?? r.pane_id ??
    r.terminal_id ?? r.terminal?.terminal_id;
  const terminalId =
    r.agent?.terminal_id ?? r.terminal_id ?? r.pane?.terminal_id ??
    r.terminal?.terminal_id;
  // Verify the agent actually registered a real pane. Under concurrent dispatches
  // a start can return without a usable pane id in the envelope; resolve it by
  // NAME as a fallback. We MUST NOT invent a pane id from `name` (the old
  // behavior) — that let dispatch mark a task `running` against a pane that never
  // existed (the phantom-task bug). If no real pane resolves, the agent did not
  // start: fail loudly so the caller treats the dispatch as failed.
  if (!paneId) paneId = await agentPaneId(name);
  if (!paneId) {
    throw new Error(
      `herdr agent start ${name}: agent did not register a pane (failed to start)`,
    );
  }
  return { paneId, terminalId };
}

// NOTE on completion detection: the running herdr destroys a pane the instant a
// one-shot command exits, so `wait agent-status done` + `pane read` (the spec's
// approach) can't capture an agent's result. butchr instead runs the agent under
// `script`, which gives it a real PTY (so its interactive UI renders live in the
// herdr pane) while logging output to a file, and observes completion + captures
// output via filesystem markers — see dispatcher.ts.

/**
 * Is the agent terminal named `name` still alive? Used by the fallback watcher
 * to notice an interactive agent whose pane/process ended without it calling
 * request_review. `herdr agent get` exits non-zero when the agent is gone.
 */
export async function agentExists(name: string): Promise<boolean> {
  if (!name) return false;
  return existsByGet(["agent", "get", name]);
}

/**
 * The pane id backing the existing agent terminal named `name`, or undefined if
 * there is no such agent (or we can't determine it). Used by the dispatcher to
 * reclaim a lingering same-named agent before retrying `agentStart` on an
 * `agent_name_taken` collision.
 */
export async function agentPaneId(name: string): Promise<string | undefined> {
  return (await agentInfo(name))?.paneId;
}

/**
 * The agent's STABLE `terminal_id`, or undefined if the agent isn't registered.
 *
 * Unlike `pane_id`, a herdr `terminal_id` is OPAQUE and does NOT change when
 * sibling panes close and the positional pane ids renumber. That stability is
 * what makes it safe to use as the key for re-resolving an agent's current pane
 * after we close a sibling (see `resolveAgentPane`).
 */
export async function agentTerminalId(name: string): Promise<string | undefined> {
  return (await agentInfo(name))?.terminalId;
}

/**
 * The stable `terminal_id` backing a pane, or undefined. Read this BEFORE closing
 * a pane: `resolveAgentPane` uses the closed pane's terminal id to detect when
 * herdr has finished renumbering (the terminal disappears from `pane list`).
 */
export async function paneTerminalId(paneId: string): Promise<string | undefined> {
  if (!paneId) return undefined;
  const r = await herdrSoft(["pane", "get", paneId]);
  if (!r) return undefined;
  return r.pane?.terminal_id ?? r.terminal_id ?? undefined;
}

/** List the live panes (optionally scoped to a workspace). [] on any failure. */
export async function paneList(workspaceId?: string): Promise<PaneInfo[]> {
  const args = ["pane", "list"];
  if (workspaceId) args.push("--workspace", workspaceId);
  const r = await herdrSoft(args);
  if (!r) return [];
  const panes: any[] = r.panes ?? [];
  return panes
    .map((p) => ({
      paneId: p.pane_id,
      terminalId: p.terminal_id,
      tabId: p.tab_id,
      workspaceId: p.workspace_id,
    }))
    .filter((p): p is PaneInfo => !!p.paneId);
}

/**
 * Resolve the agent's CURRENT pane id in a way that survives herdr's positional
 * pane-id RENUMBERING.
 *
 * herdr pane ids are POSITIONAL: when we close a task tab's empty root pane, every
 * higher-numbered pane renumbers down by one. But `pane close` RETURNS BEFORE that
 * renumber has propagated to herdr's agent->pane mapping, so reading
 * `agent get <name>`.pane_id (or `agentPaneId`) right after the close yields a
 * STALE, pre-renumber positional id — recorded permanently, it points at the wrong
 * or a NONEXISTENT pane (the phantom-pane bug).
 *
 * The agent's `terminal_id` is opaque and stable across renumbers, so we key on it
 * instead: fetch the agent's terminal id once, then poll the live `pane list` and
 * read the pane_id of the pane whose terminal_id matches — from the same snapshot,
 * so it is internally consistent. When `closedTerminalId` is given (the husk root
 * pane we just closed), we wait until that terminal has VANISHED from the list
 * before trusting a reading: its presence means the close hasn't propagated and the
 * pane numbering is still mid-renumber.
 *
 * Bounded retry (~1.5s). Returns the settled pane id, or undefined if the agent
 * never registered a live pane (a failed/clobbered start) — the caller treats that
 * as a failed dispatch rather than recording a bogus id.
 */
export async function resolveAgentPane(
  name: string,
  closedTerminalId?: string,
): Promise<string | undefined> {
  if (!name) return undefined;
  const terminalId = await agentTerminalId(name);
  if (!terminalId) return undefined; // agent never registered
  for (let i = 0; i < 12; i++) {
    const panes = await paneList();
    const huskGone =
      !closedTerminalId || !panes.some((p) => p.terminalId === closedTerminalId);
    const match = panes.find((p) => p.terminalId === terminalId);
    // Settled (husk renumber propagated) AND the agent pane is live → its pane_id
    // in this snapshot is the correct, current one.
    if (huskGone && match) return match.paneId;
    await sleep(125);
  }
  // Exhausted the window. If we never saw the husk vanish, the close simply never
  // happened (so no renumber occurred and the agent's current pane_id is still
  // right); if the agent pane is genuinely gone, the start failed → undefined.
  const panes = await paneList();
  return panes.find((p) => p.terminalId === terminalId)?.paneId;
}

/**
 * Does this error (thrown by `agentStart` / the herdr wrapper) indicate the
 * agent name is already in use? herdr surfaces this as an `agent_name_taken`
 * error code; we match loosely so a reworded message still reconciles.
 */
export function isAgentNameTaken(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /name[_-]?taken|name.{0,16}already|already.{0,16}(in use|exists|taken)/i.test(
    msg,
  );
}

/**
 * Best-effort recent output of the agent terminal named `name`, for the webapp's
 * live-output panel. Reads herdr's `recent-unwrapped` buffer (text format, so
 * most styling is already gone) and strips the remaining control sequences.
 * Returns "" if the pane/agent is gone or herdr can't read it — this is a
 * convenience view, never the source of truth for review (that's the git diff).
 */
export async function agentRead(name: string, lines = 200): Promise<string> {
  if (!name) return "";
  const r = await herdrSoft([
    "agent", "read", name,
    "--source", "recent-unwrapped", "--format", "text", "--lines", String(lines),
  ]);
  if (!r) return "";
  const raw: string = r.read?.text ?? r.text ?? "";
  if (!raw) return "";
  return stripAnsi(raw).replaceAll("\r\n", "\n").replaceAll("\r", "\n").trimEnd();
}

/**
 * Push a control input to a LIVE agent's stdin — the send half of the control
 * channel (butchr otherwise only LAUNCHES + READS). Two forms:
 *
 *   - `{ text, enter? }` — write LITERAL text (a slash-command like `/compact` /
 *     `/clear`, or a steering message). Written BY NAME via `agent send`, which
 *     keys off the stable agent name (the codebase's preferred handle — it
 *     survives herdr's positional pane-id renumbering). A trailing `enter`
 *     SUBMITS the line; Enter is a key, and `send-keys` is pane-scoped, so we
 *     resolve the agent's live pane for it.
 *   - `{ keys }` — named control keys (`C-c` to interrupt a runaway/stuck agent,
 *     `Enter`, `Escape`, …) forwarded verbatim to `pane send-keys`, which is
 *     pane-scoped only, so we resolve the agent's live pane first.
 *
 * Best-effort throughout: a missing/dead agent or pane makes every step a
 * swallowed no-op (`herdrSoft` returns null; an unresolved pane is skipped) so a
 * send to a gone agent NEVER throws. Only meaningful for a LIVE interactive
 * agent — the prime consumer is the always-live managed CTO agent.
 */
export async function send(name: string, input: SendInput): Promise<void> {
  if (!name) return;
  if ("keys" in input) {
    if (!input.keys.length) return;
    const pane = await agentPaneId(name);
    if (!pane) return; // missing/dead pane → no-op
    await herdrSoft(["pane", "send-keys", pane, ...input.keys]);
    return;
  }
  if (input.text) await herdrSoft(["agent", "send", name, input.text]);
  if (input.enter) {
    const pane = await agentPaneId(name);
    if (pane) await herdrSoft(["pane", "send-keys", pane, "Enter"]);
  }
}

/** Close a pane / terminate the agent terminal. */
export async function paneClose(target: string): Promise<void> {
  if (!target) return;
  await run([config.herdrBin, "pane", "close", target], {
    timeoutMs: config.herdrTimeoutMs,
  });
}

/**
 * Tear down a task's herdr session: close its dedicated TAB, which kills the agent
 * and every pane inside the tab and removes the tab itself (so finished/aborted
 * tasks don't leave tabs accumulating).
 *
 * We resolve the tab to close LIVE, by the agent NAME — NOT from the stored
 * `tabId`. herdr tab ids (like pane ids) are POSITIONAL: closing a lower-numbered
 * tab renumbers every higher one (verified live — e.g. tab `:3` becomes `:2` once
 * `:2` closes). So the `tabId` captured at launch goes stale the moment any
 * earlier task's tab closes, and may now point at a DIFFERENT task's tab — closing
 * it would wrongly kill that other task (observed: aborting two tasks in sequence
 * left the second's tab open while the stored id no-op'd). The agent name is the
 * only stable, butchr-owned handle, so we trust the live lookup.
 *
 * If no live agent resolves, its single-pane tab was already auto-removed when the
 * agent's pane closed (one pane per task) — there is nothing left to tear down. We
 * deliberately do NOT fall back to a stored positional tab/pane id (it may now belong
 * to another task, and as of the name-only cutover none is persisted anyway).
 * (Failed-dispatch husk tabs, which never registered an agent, are torn down at the
 * dispatch site while their id is still fresh.) Every step is best-effort.
 */
export async function teardownTask(agentName: string): Promise<void> {
  const live = await agentTabId(agentName);
  if (live) await tabClose(live);
}

/**
 * Definitively free an agent NAME so a fresh `agentStart` can reuse it.
 *
 * `pane close` alone is NOT enough: the running herdr keeps the agent NAME
 * registered even after its pane is closed (and may respawn the agent on a new
 * pane), so a close-and-retry loop spins forever on `agent_name_taken`. The
 * reliable deregister is `agent rename <name> --clear`, which removes the NAME
 * itself (verified: `agent get <name>` reports `agent_not_found` afterwards).
 *
 * We resolve the tab (and pane) id BEFORE clearing (the name stops resolving once
 * cleared) and tear them down afterwards to kill the now-orphaned process. Closing
 * the tab also removes the now-empty dedicated tab so stale tabs don't accumulate.
 * Every step is best-effort — a missing agent/pane/tab is already the state we want.
 */
export async function agentDeregister(name: string): Promise<void> {
  if (!name) return;
  // Resolve the tab + pane from ONE `agent get` (both come from the same envelope)
  // BEFORE clearing — the name stops resolving once cleared.
  const info = await agentInfo(name);
  const tab = info?.tabId;
  const pane = info?.paneId;
  const timeoutMs = config.herdrTimeoutMs;
  await run([config.herdrBin, "agent", "rename", name, "--clear"], { timeoutMs }).catch(() => {});
  if (pane) await run([config.herdrBin, "pane", "close", pane], { timeoutMs }).catch(() => {});
  if (tab) await run([config.herdrBin, "tab", "close", tab], { timeoutMs }).catch(() => {});
}

/**
 * Start an agent, self-healing an `agent_name_taken` collision: if a lingering
 * same-named agent (an orphan from an abandoned/aborted run) is still registered,
 * deregister it and retry once. Without this a single stale agent would block the
 * (re)launch forever. A second failure propagates to the caller.
 *
 * Operates through the supplied `runner` (the `harness` proxy) — NOT this module's
 * own exports — so a test-injected fake backend is honored. herdr.ts can't import
 * the `harness` value (it would cycle with harness.ts), hence the parameter.
 */
export async function startAgentReconciling(
  runner: AgentRunner,
  name: string,
  cwd: string,
  argv: string[],
  workspaceId?: string,
  tabId?: string,
): Promise<StartedAgent> {
  try {
    return await runner.agentStart(name, cwd, argv, workspaceId, tabId);
  } catch (e) {
    if (!runner.isAgentNameTaken(e)) throw e;
    // Reclaim the stale agent. Closing its pane is NOT enough — herdr keeps the
    // NAME registered (and respawns the agent), so the retry would fail again.
    // agentDeregister clears the name via `agent rename --clear` and then closes
    // the orphaned pane + its (old) tab, truly freeing the name for reuse. We
    // retry into the fresh tab created for this (re)launch.
    await runner.agentDeregister(name);
    console.log(`[butchr] reclaimed stale agent name ${name}; retrying agentStart`);
    return await runner.agentStart(name, cwd, argv, workspaceId, tabId);
  }
}

/**
 * Launch an agent into a FRESH dedicated tab and return its real, settled pane.
 *
 * The full create→start→close-husk→resolve sequence the dispatcher and the managed
 * CTO agent both run: create a dedicated tab (labeled `label`), start the agent in
 * it (self-healing a name collision), close the empty root husk pane the tab spawns,
 * then re-resolve the agent's CURRENT pane by its STABLE terminal id (surviving
 * herdr's positional renumber). Throws `paneError` if the agent never registered a
 * live pane. On ANY failure it cleans up INSIDE the call (deregister the name + close
 * the just-created tab) so a half-registered husk can't linger, then rethrows.
 *
 * The dispatcher wraps this in its per-workspace pane lock (positional ids renumber
 * workspace-globally on any close); the CTO agent calls it directly. Operates through
 * `runner` (the `harness` proxy) so a test fake is honored — see startAgentReconciling.
 */
export async function startAgentInFreshTab(
  runner: AgentRunner,
  opts: {
    name: string;
    cwd: string;
    argv: string[];
    workspaceId?: string;
    label: string;
    paneError: string;
  },
): Promise<{ paneId: string; tabId?: string }> {
  const { name, cwd, argv, workspaceId, label, paneError } = opts;
  const tab = await runner.tabCreate(workspaceId, cwd, label);
  try {
    await startAgentReconciling(runner, name, cwd, argv, workspaceId, tab.tabId);

    // `tab create` spawns an empty root shell pane; `agent start --tab` then adds
    // the agent as a SECOND pane. Close that empty pane so the tab holds only the
    // agent. Capture the husk's STABLE terminal id FIRST: closing it renumbers the
    // positional pane ids, and `pane close` returns BEFORE that renumber propagates,
    // so resolveAgentPane waits for this terminal to vanish before trusting a
    // re-resolved pane id.
    let closedTerminalId: string | undefined;
    if (tab.tabId && tab.rootPaneId) {
      closedTerminalId = await runner.paneTerminalId(tab.rootPaneId);
      await runner.paneClose(tab.rootPaneId).catch(() => {});
    }

    // Re-resolve the agent's CURRENT pane by its STABLE terminal id, waiting out
    // herdr's positional-id renumber. Returns undefined if the agent never
    // registered a live pane (a failed/clobbered start) — treat the whole launch as
    // FAILED rather than recording a stale/phantom pane id (the phantom-task bug).
    const realPane = await runner.resolveAgentPane(name, closedTerminalId);
    if (!realPane) throw new Error(paneError);
    return { paneId: realPane, tabId: tab.tabId };
  } catch (e) {
    // Clean up while the just-created tab id is still fresh (a concurrent launch
    // could renumber it): deregister the name (frees it + closes its pane/tab if it
    // partly registered) and close the dedicated tab in case the agent never
    // registered (an empty husk tab).
    await runner.agentDeregister(name).catch(() => {});
    if (tab.tabId) await runner.tabClose(tab.tabId).catch(() => {});
    throw e;
  }
}

/**
 * Run one HEADLESS, read-only agent invocation (the conformance reviewer, the brief
 * expander). Unlike the interactive agent these do
 * NOT go through a herdr PTY — they are plain child processes — but they live on
 * the backend so ALL Claude execution sits behind the one swappable seam.
 *
 * The caller has already substituted the command template and written any temp
 * prompt file; we just spawn `bash -lc <cmd>` in `cwd` with stdin ignored (a
 * read-only agent must never block on input), bounded by `timeoutMs` (SIGKILL on
 * expiry), and return its stdout for the caller to parse. Never throws — a
 * spawn/timeout/non-zero run surfaces as `ok: false`. This is the byte-for-byte
 * behavior the three headless callers previously inlined via `Bun.spawn`.
 */
export async function runHeadless(spec: HeadlessSpec): Promise<HeadlessResult> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const proc = Bun.spawn(["bash", "-lc", spec.cmd], {
      cwd: spec.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    if (spec.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, spec.timeoutMs);
    }
    // Bound the captured output (TAIL retained) so a runaway headless `claude` that
    // prints gigabytes before its timeout fires can't buffer unboundedly and OOM
    // butchr. Sub-cap output is byte-for-byte the historical read; the
    // verdict-parsers want the END of the stream, which is exactly what's kept.
    const cap =
      spec.maxOutputBytes !== undefined
        ? spec.maxOutputBytes
        : config.maxSubprocOutputBytes;
    const [stdout, stderr, code] = await Promise.all([
      readBoundedTail(proc.stdout, cap),
      readBoundedTail(proc.stderr, cap),
      proc.exited,
    ]);
    return { ok: !timedOut && code === 0, code, stdout, stderr, timedOut };
  } catch {
    return { ok: false, code: null, stdout: "", stderr: "", timedOut };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The herdr-backed implementation of the AgentRunner interface (src/harness.ts).
 * This is the DEFAULT backend butchr runs with: each method delegates to the
 * herdr CLI wrapper above. Assembled as an object literal of the existing
 * standalone exports so herdr.ts's other importers (server/workspaces/tasks) keep
 * calling them directly, while the dispatcher/reaper/headless callers go through
 * the `harness` proxy that points here.
 */
export const herdrRunner: AgentRunner = {
  isUp,
  workspaceCreate,
  workspaceExists,
  workspaceClose,
  tabCreate,
  tabClose,
  agentTabId,
  agentStart,
  agentExists,
  agentPaneId,
  agentTerminalId,
  paneTerminalId,
  paneList,
  resolveAgentPane,
  isAgentNameTaken,
  agentRead,
  send,
  paneClose,
  teardownTask,
  agentDeregister,
  runHeadless,
};
