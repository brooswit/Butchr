// herdr CLI wrapper. butchr delegates ALL terminal/agent session management to
// herdr: it owns PTYs, butchr owns task state. We shell out to the `herdr` CLI,
// which speaks to the running herdr server over its unix socket and replies with
// a JSON envelope: {"id": "...", "result": { ... }}.
import { config } from "./config.ts";
import { run } from "./exec.ts";

const bin = config.herdrBin;

type Envelope = { id?: string; result?: any; error?: any };

async function herdr(args: string[]): Promise<any> {
  const res = await run([bin, ...args]);
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

/** Is the herdr server reachable? */
export async function isUp(): Promise<boolean> {
  const res = await run([bin, "status", "server"]);
  return res.ok && /status:\s*running/.test(res.stdout);
}

export type Workspace = { workspaceId: string; rootPaneId: string };

/** Provision a workspace for a directory. Returns the workspace + root pane id. */
export async function workspaceCreate(
  cwd: string,
  label: string,
): Promise<Workspace> {
  const r = await herdr([
    "workspace", "create", "--cwd", cwd, "--label", label, "--no-focus",
  ]);
  return {
    workspaceId: r.workspace?.workspace_id ?? r.root_pane?.workspace_id,
    rootPaneId: r.root_pane?.pane_id,
  };
}

/** Does a workspace still exist? (herdr may have been restarted/closed.) */
export async function workspaceExists(workspaceId: string): Promise<boolean> {
  if (!workspaceId) return false;
  const res = await run([bin, "workspace", "get", workspaceId]);
  if (!res.ok) return false;
  return !res.stdout.includes('"error"');
}

/** Tear a workspace down. */
export async function workspaceClose(workspaceId: string): Promise<void> {
  if (!workspaceId) return;
  await herdr(["workspace", "close", workspaceId]).catch(() => {});
}

export type Tab = { tabId?: string; rootPaneId?: string };

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
    const r = await herdr(args);
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
  await run([bin, "tab", "close", tabId]).catch(() => {});
}

/**
 * The tab id backing the agent terminal named `name`, or undefined if there is no
 * such agent / we can't determine it. Used to derive a task's tab for teardown
 * when it wasn't persisted (e.g. a re-adopted agent, or reclaiming a stale name).
 */
export async function agentTabId(name: string): Promise<string | undefined> {
  if (!name) return undefined;
  const res = await run([bin, "agent", "get", name]);
  if (!res.ok) return undefined;
  const text = res.stdout.trim();
  if (!text) return undefined;
  let env: Envelope;
  try {
    env = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (env.error) return undefined;
  const r = env.result ?? env;
  return r.agent?.tab_id ?? r.pane?.tab_id ?? r.root_pane?.tab_id ?? r.tab_id ?? undefined;
}

export type StartedAgent = { paneId: string; terminalId?: string };

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
  const r = await herdr(args);
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
  const res = await run([bin, "agent", "get", name]);
  return res.ok && !res.stdout.includes('"error"');
}

/**
 * The pane id backing the existing agent terminal named `name`, or undefined if
 * there is no such agent (or we can't determine it). Used by the dispatcher to
 * reclaim a lingering same-named agent before retrying `agentStart` on an
 * `agent_name_taken` collision.
 */
export async function agentPaneId(name: string): Promise<string | undefined> {
  if (!name) return undefined;
  const res = await run([bin, "agent", "get", name]);
  if (!res.ok) return undefined;
  const text = res.stdout.trim();
  if (!text) return undefined;
  let env: Envelope;
  try {
    env = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (env.error) return undefined;
  const r = env.result ?? env;
  return (
    r.pane?.pane_id ?? r.root_pane?.pane_id ?? r.pane_id ?? r.terminal_id ??
    r.terminal?.terminal_id ?? undefined
  );
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
  if (!name) return undefined;
  const res = await run([bin, "agent", "get", name]);
  if (!res.ok) return undefined;
  const text = res.stdout.trim();
  if (!text) return undefined;
  let env: Envelope;
  try {
    env = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (env.error) return undefined;
  const r = env.result ?? env;
  return r.agent?.terminal_id ?? r.terminal_id ?? r.pane?.terminal_id ?? undefined;
}

/**
 * The stable `terminal_id` backing a pane, or undefined. Read this BEFORE closing
 * a pane: `resolveAgentPane` uses the closed pane's terminal id to detect when
 * herdr has finished renumbering (the terminal disappears from `pane list`).
 */
export async function paneTerminalId(paneId: string): Promise<string | undefined> {
  if (!paneId) return undefined;
  const res = await run([bin, "pane", "get", paneId]);
  if (!res.ok) return undefined;
  const text = res.stdout.trim();
  if (!text) return undefined;
  let env: Envelope;
  try {
    env = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (env.error) return undefined;
  const r = env.result ?? env;
  return r.pane?.terminal_id ?? r.terminal_id ?? undefined;
}

export type PaneInfo = {
  paneId: string;
  terminalId?: string;
  tabId?: string;
  workspaceId?: string;
};

/** List the live panes (optionally scoped to a workspace). [] on any failure. */
export async function paneList(workspaceId?: string): Promise<PaneInfo[]> {
  const args = ["pane", "list"];
  if (workspaceId) args.push("--workspace", workspaceId);
  const res = await run([bin, ...args]);
  if (!res.ok) return [];
  const text = res.stdout.trim();
  if (!text) return [];
  let env: Envelope;
  try {
    env = JSON.parse(text);
  } catch {
    return [];
  }
  if (env.error) return [];
  const r = env.result ?? env;
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

// Control sequences that survive even herdr's `--format text` read (stray CSI
// escapes, charset selects, lone control chars). Strip them so the live-output
// panel renders as readable plain text rather than terminal noise.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

/**
 * Best-effort recent output of the agent terminal named `name`, for the webapp's
 * live-output panel. Reads herdr's `recent-unwrapped` buffer (text format, so
 * most styling is already gone) and strips the remaining control sequences.
 * Returns "" if the pane/agent is gone or herdr can't read it — this is a
 * convenience view, never the source of truth for review (that's the git diff).
 */
export async function agentRead(name: string, lines = 200): Promise<string> {
  if (!name) return "";
  const res = await run([
    bin, "agent", "read", name,
    "--source", "recent-unwrapped", "--format", "text", "--lines", String(lines),
  ]);
  if (!res.ok) return "";
  const text = res.stdout.trim();
  if (!text) return "";
  let env: Envelope;
  try {
    env = JSON.parse(text);
  } catch {
    return "";
  }
  if (env.error) return "";
  const r = env.result ?? env;
  const raw: string = r.read?.text ?? r.text ?? "";
  if (!raw) return "";
  return raw.replace(ANSI_RE, "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").trimEnd();
}

/** Close a pane / terminate the agent terminal. */
export async function paneClose(target: string): Promise<void> {
  if (!target) return;
  await run([bin, "pane", "close", target]);
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
 * deliberately do NOT fall back to closing the stored `tabId`/`paneId`: both are
 * positional and may now belong to another task. (Failed-dispatch husk tabs, which
 * never registered an agent, are torn down at the dispatch site while their id is
 * still fresh.) The `tabId`/`paneId` params are retained for call-site
 * compatibility. Every step is best-effort.
 */
export async function teardownTask(
  _tabId: string | null | undefined,
  agentName: string,
  _paneId?: string | null,
): Promise<void> {
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
  const tab = await agentTabId(name);
  const pane = await agentPaneId(name);
  await run([bin, "agent", "rename", name, "--clear"]).catch(() => {});
  if (pane) await run([bin, "pane", "close", pane]).catch(() => {});
  if (tab) await run([bin, "tab", "close", tab]).catch(() => {});
}
