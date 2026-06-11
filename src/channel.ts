// ONE-WAY CTO NOTIFICATION CHANNEL (Claude Code Channels, research preview).
//
// The long-running CTO agent currently has to POLL butchr to learn that a task
// wants its attention. This module is a tiny STDIO bridge that gives that agent a
// PUSH feed instead: it speaks the Claude Code "channel" contract on top of MCP over
// stdio, subscribes to butchr's EXISTING SSE event stream (`GET /api/events`), and
// for every task that ENTERS an attention state writes a one-way channel
// notification to stdout. The CTO's Claude Code surfaces that line into the running
// session so it reacts immediately instead of waiting for its next poll.
//
// It is launched as a SEPARATE process by the CTO's Claude Code (see SPEC.md), NOT
// hosted inside butchr — so it talks to butchr over the network (SSE), exactly like
// the dashboard does, and reconnects when that stream drops.
//
// ONE-WAY ONLY. We advertise ONLY `experimental['claude/channel']` in the
// initialize result — NO `tools` capability, NO reply tool, NO permission relay.
// The bridge can push to the CTO; the CTO cannot push back through it.
//
// ZERO new deps: this hand-rolls the MCP stdio framing (newline-delimited JSON-RPC)
// the same way src/mcp.ts hand-rolls the Streamable-HTTP framing. The only butchr
// import is `config` (for the default SSE URL); everything else is self-contained so
// the pieces stay unit-testable without a live butchr or a real claude.
import { config } from "./config.ts";

// MCP protocol version we echo back (matches src/mcp.ts).
const PROTOCOL_VERSION = "2025-06-18";

// What the CTO's Claude Code sees as the channel source name + the human-facing
// blurb describing what these notifications mean.
export const CHANNEL_SERVER_NAME = "butchr-cto-channel";
export const CHANNEL_INSTRUCTIONS =
  "One-way CTO notification channel. Each <" +
  CHANNEL_SERVER_NAME +
  "> event is a butchr task that just entered a state needing the CTO's attention " +
  "(a generated spec awaiting approval, a diff awaiting review, an agent question " +
  "awaiting an answer, or a failed task) — the same attention feed a human sees in " +
  "the butchr dashboard. These are PUSH notifications to ACT on (approve/reject/" +
  "answer/requeue via the butchr API or CLI); you cannot reply through this channel.";

/**
 * The CTO attention transitions we push. The spec lists spec_review / in_review /
 * needs_info / failed; butchr folded the former `failed` state into the canonical
 * terminal `aborted` (see db.ts migration `["failed","aborted"]` + TaskStatus), so
 * "failed" is represented here by `aborted`.
 */
export const ATTENTION_STATES = [
  "spec_review",
  "in_review",
  "needs_info",
  "aborted",
] as const;
export type AttentionState = (typeof ATTENTION_STATES)[number];

function isAttentionState(s: unknown): s is AttentionState {
  return typeof s === "string" && (ATTENTION_STATES as readonly string[]).includes(s);
}

// A short human phrase per attention state for the notification's content line.
const STATE_PHRASE: Record<AttentionState, string> = {
  spec_review: "generated spec awaiting approval",
  in_review: "diff awaiting review",
  needs_info: "agent question awaiting an answer",
  aborted: "task failed",
};

/** The channel notification payload (params of `notifications/claude/channel`). */
export type ChannelNotification = {
  content: string;
  // Identifier-keyed metadata (keys are bare identifiers: letters/digits/underscore).
  meta: { task_id: string; dir: string; state: string };
};

// --- initialize result -------------------------------------------------------

/**
 * The MCP `initialize` result for a ONE-WAY channel: it advertises the channel
 * capability under `experimental` and DELIBERATELY omits `tools` (and everything
 * else). Pure + exported so a test can assert the one-way shape.
 */
export function channelInitializeResult(requestedProtocol?: string): {
  protocolVersion: string;
  capabilities: { experimental: { "claude/channel": Record<string, never> } };
  serverInfo: { name: string; version: string };
  instructions: string;
} {
  return {
    protocolVersion:
      typeof requestedProtocol === "string" ? requestedProtocol : PROTOCOL_VERSION,
    // ONE-WAY: channel capability only. No `tools`, no `resources`, no `prompts`.
    capabilities: { experimental: { "claude/channel": {} } },
    serverInfo: { name: CHANNEL_SERVER_NAME, version: "1.0.0" },
    instructions: CHANNEL_INSTRUCTIONS,
  };
}

// --- the attention bridge ----------------------------------------------------

/** Collapse whitespace + truncate a free-form field for a single-line notification. */
function tidy(text: unknown, max = 280): string {
  if (typeof text !== "string") return "";
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** First non-empty tidied string among the candidates ("" if none). */
function firstText(...candidates: unknown[]): string {
  for (const c of candidates) {
    const t = tidy(c);
    if (t) return t;
  }
  return "";
}

/**
 * The most relevant human text for an attention state, pulled from the serialized
 * TaskView the same way the dashboard surfaces it: the agent's question for
 * needs_info, the request_review summary for in_review, the generated spec for
 * spec_review, and the failure reason for a failed/aborted task.
 */
function attentionText(task: Record<string, unknown>, state: AttentionState): string {
  switch (state) {
    case "needs_info":
      return firstText(task.question, task.summary);
    case "in_review":
      return firstText(task.summary, task.review_note);
    case "spec_review":
      // The generated spec lives in the task's prompt (task.md); summary is a fallback.
      return firstText(task.summary, task.prompt);
    case "aborted":
      return firstText(
        task.last_dispatch_error,
        task.revert_reason,
        task.review_note,
        task.summary,
      );
  }
}

/**
 * Stateful translator from butchr's SSE events to channel notifications. It is the
 * pure core of the bridge (no I/O): feed it each parsed event via `consume`, and it
 * returns a ChannelNotification exactly when a task ENTERS an attention state, or
 * null otherwise. Resilient by construction — a malformed/irrelevant event simply
 * yields null and never throws.
 *
 * "Entering" is detected by remembering each task's last-seen status: we emit only
 * when the status CHANGED into an attention state, so a task.updated that merely
 * touches a task already in (say) in_review does not re-notify, and a reconnect
 * (which replays no history) cannot re-fire a transition we already saw this run.
 */
export class AttentionBridge {
  private lastStatus = new Map<string, string>();
  // directory_id -> human label, populated from directory.* events on the same
  // stream (and optionally seeded once at startup). Used only for the content line;
  // meta.dir is always the stable directory_id.
  private dirLabels = new Map<string, string>();

  /** Seed the directory-label cache (best-effort, e.g. from GET /api/directories). */
  seedDirectoryLabels(dirs: Array<{ id?: unknown; label?: unknown }>): void {
    for (const d of dirs) {
      if (d && typeof d.id === "string" && typeof d.label === "string" && d.label) {
        this.dirLabels.set(d.id, d.label);
      }
    }
  }

  /**
   * Consume one parsed SSE event. Returns a notification on an attention transition,
   * else null. Never throws on malformed input.
   */
  consume(event: unknown): ChannelNotification | null {
    if (!event || typeof event !== "object") return null;
    const e = event as Record<string, unknown>;

    // Keep the directory-label cache fresh off the same stream.
    if (e.type === "directory.created" || e.type === "directory.updated") {
      const dir = e.directory as Record<string, unknown> | undefined;
      if (dir && typeof dir.id === "string" && typeof dir.label === "string") {
        this.dirLabels.set(dir.id, dir.label);
      }
      return null;
    }
    if (e.type === "directory.deleted" && typeof e.id === "string") {
      this.dirLabels.delete(e.id);
      return null;
    }
    if (e.type === "task.deleted" && typeof e.id === "string") {
      this.lastStatus.delete(e.id);
      return null;
    }
    if (e.type !== "task.updated" && e.type !== "task.created") return null;

    const task = e.task;
    if (!task || typeof task !== "object") return null;
    const t = task as Record<string, unknown>;
    const id = t.id;
    const status = t.status;
    if (typeof id !== "string" || !id || typeof status !== "string") return null;

    const prev = this.lastStatus.get(id);
    this.lastStatus.set(id, status);

    if (!isAttentionState(status)) return null;
    if (prev === status) return null; // already in this state — not a fresh transition

    const dirId = typeof t.directory_id === "string" ? t.directory_id : "";
    const label = this.dirLabels.get(dirId) || dirId || "(unknown dir)";
    const text = attentionText(t, status);
    const content =
      `[${id}] ${label} — ${STATE_PHRASE[status]}` + (text ? `: ${text}` : "");

    return { content, meta: { task_id: id, dir: dirId, state: status } };
  }
}

// --- SSE parsing -------------------------------------------------------------

/**
 * Build an incremental SSE parser. Feed it raw decoded chunks via the returned
 * function; it invokes `onData` with the `data:` payload of each completed event
 * (blank-line terminated), ignoring `:` keepalive comments and non-data fields.
 * Exported so the framing can be unit-tested without a socket.
 */
export function makeSseParser(onData: (payload: string) => void): (chunk: string) => void {
  let buf = "";
  let dataLines: string[] = [];
  return (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (dataLines.length) {
          onData(dataLines.join("\n"));
          dataLines = [];
        }
        continue;
      }
      if (line.startsWith(":")) continue; // keepalive / comment
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      // other SSE fields (event:, id:, retry:) are irrelevant here
    }
  };
}

// --- SSE reconnect loop ------------------------------------------------------

export type SseLoopOpts = {
  /** SSE endpoint to subscribe to. */
  url: string;
  /** Called with each event's raw `data:` payload (one JSON event). */
  onData: (payload: string) => void;
  /** Stop the loop when this returns true (checked between reads + reconnects). */
  shouldStop?: () => boolean;
  /** Open the stream (overridable in tests). Resolves null/throws to trigger retry. */
  open?: (url: string) => Promise<ReadableStream<Uint8Array> | null>;
  /** Sleep between reconnect attempts (overridable in tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Reconnect backoff in ms (fixed; SSE on loopback rarely drops). */
  backoffMs?: number;
  /** Diagnostics sink (defaults to stderr). */
  log?: (msg: string) => void;
};

async function defaultOpen(url: string): Promise<ReadableStream<Uint8Array> | null> {
  const res = await fetch(url, { headers: { accept: "text/event-stream" } });
  if (!res.ok || !res.body) {
    throw new Error(`SSE connect failed: HTTP ${res.status}`);
  }
  return res.body;
}

function drainStream(
  stream: ReadableStream<Uint8Array>,
  onData: (payload: string) => void,
  shouldStop?: () => boolean,
): Promise<void> {
  return (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const feed = makeSseParser(onData);
    try {
      while (true) {
        if (shouldStop?.()) break;
        const { done, value } = await reader.read();
        if (done) break;
        if (value) feed(decoder.decode(value, { stream: true }));
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
    }
  })();
}

/**
 * Subscribe to the SSE stream and RECONNECT whenever it ends or errors, until
 * `shouldStop` says to stop. A dropped connection (server restart, network blip) is
 * caught, logged, and retried after `backoffMs` — it never crashes the bridge.
 * Exported + fully injectable (open/sleep/shouldStop) so reconnect is testable.
 */
export async function runSseLoop(opts: SseLoopOpts): Promise<void> {
  const open = opts.open ?? defaultOpen;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const backoff = opts.backoffMs ?? 2000;
  const log = opts.log ?? (() => {});
  while (!opts.shouldStop?.()) {
    try {
      const stream = await open(opts.url);
      if (stream) await drainStream(stream, opts.onData, opts.shouldStop);
    } catch (e) {
      log(`sse error (will reconnect): ${(e as Error).message}`);
    }
    if (opts.shouldStop?.()) break;
    await sleep(backoff); // stream ended/dropped → back off, then reconnect
  }
}

// --- MCP stdio request handling ----------------------------------------------

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
};

/**
 * Handle one inbound JSON-RPC message from the client. Returns a JSON-RPC response
 * object to write back, or null for notifications (which get no reply). This bridge
 * exposes NO tools — only the channel lifecycle methods (initialize / ping).
 */
export function handleRpc(msg: JsonRpcMessage): Record<string, unknown> | null {
  if (!msg || typeof msg.method !== "string") return null;
  switch (msg.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: msg.id ?? null,
        result: channelInitializeResult(msg.params?.protocolVersion),
      };
    case "ping":
      return { jsonrpc: "2.0", id: msg.id ?? null, result: {} };
    default:
      // Notifications (notifications/initialized, etc.) carry no id → no reply.
      if (msg.method.startsWith("notifications/") || msg.id == null) return null;
      return {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `method not found: ${msg.method}` },
      };
  }
}

/** Serialize a channel notification as a JSON-RPC notification line (no trailing \n). */
export function channelNotificationMessage(n: ChannelNotification): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/claude/channel",
    params: { content: n.content, meta: n.meta },
  });
}

// --- runtime wiring (only runs when invoked as a script) ---------------------

function defaultSseUrl(): string {
  const env = process.env.BUTCHR_CHANNEL_SSE_URL;
  if (env && env.trim()) return env.trim();
  return `http://${config.host}:${config.port}/api/events`;
}

/** Write a server→client message (response or notification) on stdout, one per line. */
function writeMessage(obj: Record<string, unknown> | string): void {
  const line = typeof obj === "string" ? obj : JSON.stringify(obj);
  process.stdout.write(line + "\n");
}

// All diagnostics go to STDERR — stdout is reserved for the JSON-RPC protocol.
function elog(msg: string): void {
  process.stderr.write(`[butchr-channel] ${msg}\n`);
}

/**
 * Run the bridge: read newline-delimited JSON-RPC from stdin (answering
 * initialize/ping), and once initialized, subscribe to butchr's SSE stream and push
 * a channel notification for every CTO attention transition. Best-effort throughout:
 * a single bad event/notification is dropped, never fatal.
 */
export async function main(): Promise<void> {
  const url = defaultSseUrl();
  const bridge = new AttentionBridge();
  let stopped = false;

  // Best-effort seed of directory labels so the very first notifications carry a
  // human label rather than a bare directory id (the cache then self-updates off the
  // directory.* events on the stream).
  try {
    const base = url.replace(/\/api\/events.*$/, "");
    const res = await fetch(`${base}/api/directories`);
    if (res.ok) {
      const dirs = await res.json();
      if (Array.isArray(dirs)) bridge.seedDirectoryLabels(dirs);
    }
  } catch {
    /* seeding is optional */
  }

  // Translate each SSE event into a channel notification (if it is a transition).
  const onData = (payload: string) => {
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return; // malformed frame — drop silently
    }
    let note: ChannelNotification | null = null;
    try {
      note = bridge.consume(event);
    } catch {
      return; // never let a bad event crash the bridge
    }
    if (!note) return;
    try {
      writeMessage(channelNotificationMessage(note));
    } catch (e) {
      elog(`failed to write notification: ${(e as Error).message}`);
    }
  };

  // SSE subscription with auto-reconnect (runs for the life of the process).
  elog(`subscribing to ${url}`);
  const sse = runSseLoop({
    url,
    onData,
    shouldStop: () => stopped,
    log: elog,
  });

  // Read stdin: newline-delimited JSON-RPC. Answer initialize/ping; ignore the rest.
  const decoder = new TextDecoder();
  let buf = "";
  const onLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // not JSON — ignore
    }
    let res: Record<string, unknown> | null = null;
    try {
      res = handleRpc(msg);
    } catch (e) {
      elog(`rpc error: ${(e as Error).message}`);
      return;
    }
    if (res) writeMessage(res);
  };

  try {
    for await (const chunk of Bun.stdin.stream()) {
      buf += decoder.decode(chunk as Uint8Array, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        onLine(line);
      }
    }
    if (buf) onLine(buf); // trailing line without newline
  } finally {
    // stdin closed → the client is gone; stop the SSE loop and exit.
    stopped = true;
    await sse;
  }
}

// Run only when executed directly (not when imported by tests).
if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(`[butchr-channel] fatal: ${(e as Error).stack ?? e}\n`);
    process.exit(1);
  });
}
