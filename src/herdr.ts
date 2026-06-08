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

export type StartedAgent = { paneId: string; terminalId?: string };

/**
 * Start an agent process in a fresh pane rooted at `cwd` (the task worktree).
 * `argv` is the command to run, e.g. ["bash", "-lc", "<agent cmd>"].
 * The agent name is set to the task id for easy lookup.
 */
export async function agentStart(
  name: string,
  cwd: string,
  argv: string[],
  workspaceId?: string,
): Promise<StartedAgent> {
  const args = ["agent", "start", name, "--cwd", cwd, "--no-focus"];
  if (workspaceId) args.push("--workspace", workspaceId);
  args.push("--", ...argv);
  const r = await herdr(args);
  // Response shapes vary slightly by herdr version; probe common fields.
  const paneId =
    r.pane?.pane_id ?? r.root_pane?.pane_id ?? r.pane_id ?? r.terminal_id ??
    r.terminal?.terminal_id ?? name;
  const terminalId = r.terminal_id ?? r.pane?.terminal_id ?? r.terminal?.terminal_id;
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

/** Close a pane / terminate the agent terminal. */
export async function paneClose(target: string): Promise<void> {
  if (!target) return;
  await run([bin, "pane", "close", target]);
}
