// The AGENT-EXECUTION HARNESS: a swappable interface over the session/runtime that
// actually RUNS the Claude Code agent. Historically butchr was wired directly to
// herdr (the PTY/workspace manager) for everything — provisioning a workspace,
// launching the interactive agent under a PTY, probing liveness, resolving its
// pane, reading its output, and tearing it down — and to bare `Bun.spawn` for the
// headless read-only agents (the conformance reviewer, the brief expander). That
// coupling made butchr inseparable from herdr.
//
// `AgentRunner` (a.k.a. the ExecBackend) is the seam: it names every operation the
// rest of butchr needs from the agent runtime, so the herdr implementation lives
// behind it (src/herdr.ts → `herdrRunner`) and a different backend ("herdr or
// whatever") — or a FAKE in tests — can be dropped in without touching the
// dispatcher/reaper/headless callers. The dispatcher and reaper talk to the
// `harness` proxy below, never to herdr directly.
//
// NOTE on shape: the runtime-handle TYPES (Workspace/Tab/StartedAgent/PaneInfo)
// are defined HERE so the interface owns its own contract; herdr.ts re-exports
// them for backward-compatibility with its existing importers. herdr.ts imports
// the interface types from here TYPE-ONLY (erased at runtime), and this module
// imports `herdrRunner` as a VALUE — the single runtime edge — so there is no
// import cycle at evaluation time.
import { herdrRunner } from "./herdr.ts";

/** A provisioned workspace (a workspace's herdr workspace) + its root pane id. */
export type Workspace = { workspaceId: string; rootPaneId: string };

/** A dedicated tab for a task: its id + the empty root pane the backend spawns in it. */
export type Tab = { tabId?: string; rootPaneId?: string };

/** A freshly started interactive agent: the pane it landed in + its stable terminal id. */
export type StartedAgent = { paneId: string; terminalId?: string };

/** A live pane, with the ids needed to correlate it back to an agent/tab/workspace. */
export type PaneInfo = {
  paneId: string;
  terminalId?: string;
  tabId?: string;
  workspaceId?: string;
};

/**
 * One control input to push to a LIVE interactive agent's stdin via `send`.
 * Either:
 *   - literal `text` (a slash-command like `/compact`/`/clear`, or a steering
 *     message), with an optional trailing `enter` to SUBMIT the line; or
 *   - one or more named control `keys` (e.g. `C-c` to interrupt, `Enter`,
 *     `Escape`) passed straight through to the runtime's key vocabulary.
 * The two forms are mutually exclusive — discriminated on the `keys` field.
 */
export type SendInput =
  | { text: string; enter?: boolean }
  | { keys: string[] };

/**
 * One HEADLESS, read-only agent invocation (the conformance reviewer, the brief
 * expander). The caller has already substituted
 * its command template and written any temp prompt file; the backend only has to
 * RUN the command (via `bash -lc`) in `cwd`, bounded by `timeoutMs`, and hand back
 * its stdout for the caller to parse. This is the agent-execution path that does
 * NOT go through a herdr PTY — it's a plain child process — but it still belongs to
 * the backend so ALL Claude execution sits behind one swappable seam.
 */
export type HeadlessSpec = {
  /** Fully-substituted shell command to run via `bash -lc`. */
  cmd: string;
  /** Working directory (the task's worktree / the target repo). */
  cwd: string;
  /** Wall-clock bound (ms); the child is SIGKILLed on expiry. <=0 → unbounded. */
  timeoutMs: number;
  /**
   * Optional per-stream byte cap on the captured stdout/stderr (the TAIL is kept;
   * see exec.readBoundedTail). Defaults to `config.maxSubprocOutputBytes`. <=0 →
   * unbounded. Mainly an override seam for tests; normal callers omit it.
   */
  maxOutputBytes?: number;
};

/** The outcome of one headless run. `ok` ⇔ exited 0 within the timeout. */
export type HeadlessResult = {
  ok: boolean;
  /** The child's exit code, or null when it couldn't be spawned. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the run was killed by its `timeoutMs` bound. */
  timedOut: boolean;
};

/**
 * The agent-execution backend. Every method that butchr needs from the runtime
 * that hosts the Claude Code agent — provisioning, launch (interactive + headless),
 * liveness, handle resolution, output read, teardown. herdr.ts provides the
 * concrete implementation (`herdrRunner`); tests inject a fake via `setRunner`.
 *
 * Method semantics mirror the original herdr wrappers EXACTLY (this is a pure
 * refactor): probe/read methods degrade to a default (undefined/[]/"") rather than
 * throwing; `agentStart` throws when the agent fails to register a pane;
 * teardown/close methods are best-effort and never throw.
 */
export interface AgentRunner {
  /** Is the underlying runtime (the herdr server, or its replacement) reachable? */
  isUp(): Promise<boolean>;

  // ---- herdr workspace (one per registered workspace) -----------------------
  /** Provision a herdr workspace for a registered workspace; returns it + root pane id. */
  workspaceCreate(cwd: string, label: string): Promise<Workspace>;
  /** Does a workspace still exist? (the runtime may have been restarted/closed) */
  workspaceExists(workspaceId: string): Promise<boolean>;
  /** Tear a workspace down. Best-effort. */
  workspaceClose(workspaceId: string): Promise<void>;

  // ---- tab (one per task) ---------------------------------------------------
  /** Create a dedicated tab for a task; best-effort (returns {} on failure). */
  tabCreate(workspaceId: string | undefined, cwd: string, label: string): Promise<Tab>;
  /** Close a tab (kills every pane/agent inside it). Best-effort. */
  tabClose(tabId: string | null | undefined): Promise<void>;
  /** The tab backing the agent named `name`, or undefined. */
  agentTabId(name: string): Promise<string | undefined>;

  // ---- interactive agent (PTY) ----------------------------------------------
  /**
   * Start an interactive agent named `name` rooted at `cwd`, running `argv`
   * (e.g. ["bash","-lc","<script-wrapped claude cmd>"]). Placed in `tabId` when
   * given, else in `workspaceId`. Throws if the agent fails to register a pane.
   */
  agentStart(
    name: string,
    cwd: string,
    argv: string[],
    workspaceId?: string,
    tabId?: string,
  ): Promise<StartedAgent>;
  /** Is the agent named `name` still alive/registered? */
  agentExists(name: string): Promise<boolean>;
  /** The pane id backing the agent named `name`, or undefined. */
  agentPaneId(name: string): Promise<string | undefined>;
  /** The STABLE terminal id of the agent named `name`, or undefined. */
  agentTerminalId(name: string): Promise<string | undefined>;
  /** The stable terminal id backing a pane, or undefined (read BEFORE closing it). */
  paneTerminalId(paneId: string): Promise<string | undefined>;
  /** List the live panes (optionally scoped to a workspace). [] on failure. */
  paneList(workspaceId?: string): Promise<PaneInfo[]>;
  /** Resolve the agent's CURRENT pane id, surviving positional-id renumbering. */
  resolveAgentPane(name: string, closedTerminalId?: string): Promise<string | undefined>;
  /** Does this thrown error mean the agent NAME is already in use? */
  isAgentNameTaken(e: unknown): boolean;
  /** Best-effort recent output of the agent named `name` (for the live panel). "" on failure. */
  agentRead(name: string, lines?: number): Promise<string>;
  /**
   * Best-effort: push a control input to the LIVE agent's stdin — literal text
   * (with an optional trailing Enter to submit) or named control keys (C-c,
   * Enter, Escape). Only meaningful for a live interactive agent; a send to a
   * missing/dead pane is a no-op that NEVER throws.
   */
  send(name: string, input: SendInput): Promise<void>;
  /** Close a pane / terminate the agent terminal. */
  paneClose(target: string): Promise<void>;
  /** Tear down an agent's session by NAME (resolve + close its dedicated tab). Best-effort. */
  teardownTask(agentName: string): Promise<void>;
  /** Definitively free an agent NAME so a fresh start can reuse it. Best-effort. */
  agentDeregister(name: string): Promise<void>;

  // ---- headless read-only agents --------------------------------------------
  /** Run one headless, read-only agent invocation (spec-gen / conformance / expand). */
  runHeadless(spec: HeadlessSpec): Promise<HeadlessResult>;
}

// The active backend. Defaults to the herdr implementation; swappable via
// setRunner (tests inject a fake; a future deployment could swap herdr out).
let activeRunner: AgentRunner = herdrRunner;

/** Replace the active agent-execution backend (tests inject a fake). */
export function setRunner(r: AgentRunner): void {
  activeRunner = r;
}

/** The active agent-execution backend. */
export function getRunner(): AgentRunner {
  return activeRunner;
}

/**
 * The stable handle the rest of butchr imports and calls (`harness.agentStart(…)`).
 * A Proxy so call sites bind to the CURRENT backend at call time — `setRunner`
 * swaps the implementation under it without callers re-importing. Methods are
 * bound to the backend so a stateful fake's `this` resolves correctly.
 */
export const harness: AgentRunner = new Proxy({} as AgentRunner, {
  get(_target, prop) {
    const value = (activeRunner as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === "function" ? value.bind(activeRunner) : value;
  },
});
