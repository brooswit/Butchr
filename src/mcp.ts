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
// The one tool, `request_review`, BLOCKS: its tools/call awaits a promise from
// review.ts until the human approves / rejects / aborts. Blocking is free
// token-wise — the agent is parked waiting on a tool result.
import { registerReview } from "./review.ts";
import { getTask, markReviewFromAgent } from "./tasks.ts";

const REQUEST_REVIEW_TOOL = {
  name: "request_review",
  description:
    "Call when the task's work is complete and ready for human review. Blocks " +
    "until the reviewer responds. If changes are requested, returns the notes; " +
    "address them and call this tool again. On approval the session ends.",
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
      return rpcResult(msg.id, { tools: [REQUEST_REVIEW_TOOL] });

    case "tools/call":
      return handleToolCall(req, taskId, msg);

    default:
      // Notifications (e.g. notifications/initialized) carry no id → ack with 202.
      if (msg.method.startsWith("notifications/") || msg.id == null) {
        return new Response(null, { status: 202 });
      }
      return rpcError(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

async function handleToolCall(
  req: Request,
  taskId: string,
  msg: JsonRpcMessage,
): Promise<Response> {
  const name = msg.params?.name;
  if (name !== "request_review") {
    return rpcError(msg.id, -32602, `unknown tool: ${name}`);
  }
  const summary: string | undefined = msg.params?.arguments?.summary;

  // Move the task to `review` (keeps the pane — the agent stays alive). If the
  // task is already terminal (merged/aborted out from under the agent), don't
  // block; return its state so the call resolves.
  const state = markReviewFromAgent(taskId, summary);
  if (state !== "ok") {
    return rpcResult(
      msg.id,
      toolResult({ decision: getTask(taskId)?.status ?? "unknown" }),
    );
  }

  // Park until the human acts. The connection-abort handler removes only this
  // registration, so an approve/abort that closes the pane (dropping the socket)
  // cleans up without leaking a pending entry.
  const { promise, cancelThis } = registerReview(taskId);
  req.signal?.addEventListener("abort", cancelThis);

  let verdict;
  try {
    verdict = await promise;
  } catch {
    // Cancelled (approve/abort closed the pane) or the client disconnected. The
    // agent is gone; nothing to send.
    return new Response(null, { status: 204 });
  }

  if (verdict.decision === "changes_requested") {
    return rpcResult(
      msg.id,
      toolResult({ decision: "changes_requested", notes: verdict.notes ?? "" }),
    );
  }
  // approved / aborted / superseded: the socket is usually already dead; return
  // the decision in case it isn't.
  return rpcResult(msg.id, toolResult({ decision: verdict.decision }));
}
