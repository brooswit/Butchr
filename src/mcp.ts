// Minimal MCP server that butchr hosts so interactive agents can drive the
// review handshake. Mounted on the existing Bun HTTP server at `/mcp/:taskId`
// (see server.ts) — no extra process, no external deps. We hand-roll just enough
// of the Streamable-HTTP MCP transport for Claude Code to connect and call tools:
// `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, `ping`.
//
// The transport is stateless: identity comes from the URL path (the task id), so
// we never issue an Mcp-Session-Id. Each POST carries a single JSON-RPC message;
// we answer with `application/json` (a valid Streamable-HTTP response — SSE
// framing is unnecessary on loopback).
//
// The one tool, `request_review`, is NON-BLOCKING: its tools/call records the
// review request in butchr's DB (transitioning the task to `review`) and returns
// immediately. The agent is then expected to EXIT — the task lives purely as DB
// state with no live process. butchr owns the rest: it merges on approve, and on
// reject it re-launches the SAME Claude session (`--resume <session-id>`) with the
// notes. This is what makes review durable across an agent or butchr restart — an
// MCP server cannot wake an idle Claude Code client, so we never park a call.
import { join } from "node:path";
import { askCto } from "./cto.ts";
import { getDirectory } from "./directories.ts";
import { getTask, markReviewFromAgent } from "./tasks.ts";

const REQUEST_REVIEW_TOOL = {
  name: "request_review",
  description:
    "Call when the task's work is complete and ready for human review. Returns " +
    "IMMEDIATELY (does not block): it records your work for review, after which " +
    "you should stop and exit. If the reviewer requests changes, butchr re-launches " +
    "you in the same session with their notes; address them and call this tool " +
    "again. If the reviewer approves, butchr merges your branch automatically.",
  inputSchema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Optional short summary of what was done.",
      },
    },
    additionalProperties: false,
  },
} as const;

const ASK_TOOL = {
  name: "ask",
  description:
    "Ask the CTO a clarifying question about this task — requirements, " +
    "conventions, design judgment calls. Returns the CTO's answer. Read-only: " +
    "the CTO cannot change files. Prefer asking over guessing when something is " +
    "ambiguous.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The clarifying question to put to the CTO.",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
} as const;

const PROTOCOL_VERSION = "2025-06-18";

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
};

function rpcResult(id: unknown, result: unknown): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }),
    { headers: { "content-type": "application/json" } },
  );
}

function rpcError(id: unknown, code: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }),
    { headers: { "content-type": "application/json" } },
  );
}

// Wrap a value as an MCP tool result (one text block holding JSON).
function toolResult(payload: unknown): { content: unknown[]; isError: boolean } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: false,
  };
}

// A plain-text tool result. `isError` flags a tool-level failure (the call still
// succeeds at the JSON-RPC layer — the agent sees the message and can react).
function textResult(
  text: string,
  isError = false,
): { content: unknown[]; isError: boolean } {
  return { content: [{ type: "text", text }], isError };
}

/**
 * Handle one MCP HTTP request for <taskId>. Mounted by server.ts for any path
 * under `/mcp/`. Returns 404 if the task doesn't exist.
 */
export async function handleMcp(req: Request, taskId: string): Promise<Response> {
  if (!getTask(taskId)) {
    return new Response(JSON.stringify({ error: "task not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  // We do not offer a server-initiated SSE stream; per spec, reject GET here.
  if (req.method === "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  // Session teardown (stateless server → nothing to tear down).
  if (req.method === "DELETE") return new Response(null, { status: 204 });
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: JsonRpcMessage | JsonRpcMessage[];
  try {
    body = await req.json();
  } catch {
    return rpcError(null, -32700, "parse error");
  }

  // Claude Code sends one message per request; tolerate a batch defensively by
  // handling the first request-bearing message (notifications get 202).
  const msg = Array.isArray(body) ? body.find((m) => m && m.method) : body;
  if (!msg || !msg.method) return new Response(null, { status: 202 });

  switch (msg.method) {
    case "initialize":
      return rpcResult(msg.id, {
        protocolVersion: msg.params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "butchr", version: "1.0.0" },
      });

    case "ping":
      return rpcResult(msg.id, {});

    case "tools/list":
      return rpcResult(msg.id, { tools: [REQUEST_REVIEW_TOOL, ASK_TOOL] });

    case "tools/call":
      return handleToolCall(taskId, msg);

    default:
      // Notifications (e.g. notifications/initialized) carry no id → ack with 202.
      if (msg.method.startsWith("notifications/") || msg.id == null) {
        return new Response(null, { status: 202 });
      }
      return rpcError(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

async function handleToolCall(
  taskId: string,
  msg: JsonRpcMessage,
): Promise<Response> {
  const name = msg.params?.name;
  if (name === "ask") return handleAsk(taskId, msg);
  if (name !== "request_review") {
    return rpcError(msg.id, -32602, `unknown tool: ${name}`);
  }
  const summary: string | undefined = msg.params?.arguments?.summary;

  // Record the review request and move the task to `review`, then RETURN AT ONCE
  // (non-blocking). If the task is already terminal (merged/aborted out from under
  // the agent), report that instead. The agent should exit after this call; butchr
  // drives merge-on-approve / resume-on-reject entirely from DB state.
  const state = markReviewFromAgent(taskId, summary);
  if (state !== "ok") {
    return rpcResult(
      msg.id,
      toolResult({ status: getTask(taskId)?.status ?? "unknown" }),
    );
  }
  return rpcResult(
    msg.id,
    toolResult({
      status: "submitted",
      message:
        "Your work has been submitted for human review. You can stop now — do " +
        "not wait. If changes are requested, butchr will re-launch you with the " +
        "reviewer's notes; if it is approved, butchr merges your branch.",
    }),
  );
}

/**
 * Handle an `ask` tool call: run the CTO Claude (forked, headless, read-only) in
 * the asking task's worktree and return its answer. Any failure becomes an
 * `isError` tool result — it never crashes the MCP server or the asking task.
 */
async function handleAsk(taskId: string, msg: JsonRpcMessage): Promise<Response> {
  const question: unknown = msg.params?.arguments?.question;
  if (typeof question !== "string" || !question.trim()) {
    return rpcResult(
      msg.id,
      textResult("`ask` requires a non-empty `question` string.", true),
    );
  }

  // Resolve the task's worktree so the CTO can READ the code under discussion.
  const task = getTask(taskId)!; // handleMcp already verified the task exists.
  const dir = getDirectory(task.directory_id);
  if (!dir) {
    return rpcResult(
      msg.id,
      textResult("Could not locate this task's directory to consult the CTO.", true),
    );
  }
  const cwd = join(dir.path, taskId);

  try {
    const answer = await askCto(question, { cwd, taskId });
    // askCto returns a human-readable error string on timeout/failure; treat a
    // leading "CTO did not respond"/"could not"/"Failed" as a tool error so the
    // agent knows the answer is not authoritative. Plain answers pass through.
    const failed = /^(CTO (did not respond|could not)|Failed to consult|The CTO returned an empty)/.test(
      answer,
    );
    return rpcResult(msg.id, textResult(answer, failed));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return rpcResult(msg.id, textResult(`Failed to consult the CTO: ${detail}`, true));
  }
}
