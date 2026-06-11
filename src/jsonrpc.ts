// Shared JSON-RPC 2.0 framing for butchr's two MCP transports: the Streamable-HTTP
// server (src/mcp.ts, which wraps these bodies in a `Response`) and the stdio channel
// bridge (src/channel.ts, which writes them straight to stdout). Only the
// transport-agnostic pieces live here — the protocol version, the result/error
// envelope builders, and the "needs no reply" predicate — so each transport keeps its
// own framing (HTTP status codes vs newline-delimited stdout).

/** MCP protocol version butchr speaks (echoed back on `initialize`). */
export const PROTOCOL_VERSION = "2025-06-18";

/** A JSON-RPC 2.0 success envelope (id defaults to null when absent). */
export function jsonRpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

/** A JSON-RPC 2.0 error envelope (id defaults to null when absent). */
export function jsonRpcError(
  id: unknown,
  code: number,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/**
 * Whether an inbound message needs NO reply: a notification (method starts with
 * "notifications/") or any message carrying no id. Both transports ack these with no
 * JSON-RPC response (HTTP 202 / no stdout line).
 */
export function isNotificationOrIdless(msg: { method?: string; id?: unknown }): boolean {
  return (
    (typeof msg.method === "string" && msg.method.startsWith("notifications/")) ||
    msg.id == null
  );
}
