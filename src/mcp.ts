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
import type { TaskRow } from "./db.ts";
import {
  isNotificationOrIdless,
  jsonRpcError,
  jsonRpcResult,
  PROTOCOL_VERSION,
} from "./jsonrpc.ts";
import {
  getTask,
  markNeedsInfoFromAgent,
  markReviewFromAgent,
} from "./tasks.ts";

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

// The ONE tool an agent uses to escalate ANYTHING about its task to the operator/CTO:
// a clarifying question, a suggested change to the task itself, OR a suggested
// decomposition into sub-tasks. The agent is a WORKER, not a task-manager — it never
// creates/edits tasks; it RAISES, and the operator/CTO acts on it via the full REST
// API. Non-blocking: it parks the task in `needs_info` holding the agent's message
// (markNeedsInfoFromAgent) and returns at once so the agent exits, exactly like the
// review handshake; the operator's answer resumes the SAME session via `--resume`.
const RAISE_TOOL = {
  name: "raise",
  description:
    "Raise something about this task to the operator/CTO. Use this ONE tool for ANY " +
    "of: (a) a clarifying QUESTION (requirements, conventions, a design judgment " +
    "call); (b) a SUGGESTED CHANGE to the task itself (its scope/prompt is wrong, it " +
    "should be re-scoped, split, or its dependencies changed); or (c) a suggested " +
    "DECOMPOSITION of the work into sub-tasks. You are a WORKER, not a task-manager: " +
    "you do NOT create or edit tasks yourself — describe what you'd suggest and let " +
    "the operator act on it. Returns IMMEDIATELY (does NOT block): it records your " +
    "message and parks the task awaiting a response, after which you should STOP and " +
    "exit. Whoever operates answers through butchr (the CTO/operator via the REST " +
    "API/CLI, or a human in the webapp); once answered, butchr RE-LAUNCHES you in this " +
    "same session with the response so you can continue. Prefer raising over guessing " +
    "when something is genuinely ambiguous or the task itself looks wrong.",
  inputSchema: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description:
          "What you are raising — a question, a suggested change to this task, or a " +
          "suggested decomposition into sub-tasks. Be specific and self-contained.",
      },
    },
    required: ["message"],
    additionalProperties: false,
  },
} as const;

// Exposed ONLY for PLAN-PREVIEW tasks (plan_preview=1). On its first launch such a
// task is instructed to submit a concise implementation PLAN here BEFORE writing any
// code; this reuses the `raise` feedback handshake (markNeedsInfoFromAgent) to park
// the task in `needs_info` holding the plan, returning at once so the agent exits. The
// operator answers 'proceed'/steering notes and butchr resumes the SAME session with
// the decision, at which point the agent implements + request_review as normal.
const PROPOSE_PLAN_TOOL = {
  name: "propose_plan",
  description:
    "PLAN-PREVIEW: submit your concise implementation PLAN for operator approval " +
    "BEFORE writing any code. Returns IMMEDIATELY (does NOT block) and parks this " +
    "task awaiting the operator's decision; after it returns, STOP and exit. The " +
    "operator reviews your plan and answers 'proceed' (or sends steering notes), " +
    "after which butchr RE-LAUNCHES you in this SAME session with their decision so " +
    "you implement the plan and call request_review as normal. Pass `plan`: a short " +
    "description of the files you intend to change and the approach you will take. Do " +
    "NOT start implementing before calling this.",
  inputSchema: {
    type: "object",
    properties: {
      plan: {
        type: "string",
        description:
          "The concise implementation plan to put to the operator for approval.",
      },
    },
    required: ["plan"],
    additionalProperties: false,
  },
} as const;

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
};

// HTTP transport: wrap a shared JSON-RPC body (see ./jsonrpc.ts) in a JSON Response.
function rpcResult(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify(jsonRpcResult(id, result)), {
    headers: { "content-type": "application/json" },
  });
}

function rpcError(id: unknown, code: number, message: string): Response {
  return new Response(JSON.stringify(jsonRpcError(id, code, message)), {
    headers: { "content-type": "application/json" },
  });
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

    case "tools/list": {
      // Each tool's optional `gate` decides whether it is offered for THIS task: the
      // agent surface is exactly `request_review` + `raise` (both un-gated, offered to
      // every task), plus `propose_plan` ONLY for a PLAN-PREVIEW task (its gate). The
      // CTO acts on a raised suggestion/decomposition via the REST API — there is no
      // agent-side task CRUD. (handleMcp already verified the task exists.)
      const task = getTask(taskId)!;
      const tools = TOOLS
        .filter((t) => !t.gate || t.gate(task))
        .map((t) => t.def);
      return rpcResult(msg.id, { tools });
    }

    case "tools/call":
      return handleToolCall(taskId, msg);

    default:
      // Notifications (e.g. notifications/initialized) carry no id → ack with 202.
      if (isNotificationOrIdless(msg)) {
        return new Response(null, { status: 202 });
      }
      return rpcError(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

type ToolResult = { content: unknown[]; isError: boolean };

/**
 * One dispatchable MCP tool: its public definition (name/description/inputSchema),
 * an optional `gate` predicate, and a `run` that produces the tool result. `gate`
 * drives `tools/list` filtering: a tool is offered for a task only when its gate is
 * absent (offer to all) or returns true for that task's row. The shared dispatcher
 * (`handleToolCall`) does name lookup + arg extraction; each `run` owns its own
 * field validation and error→`textResult` wrapping, since the messages are
 * tool-specific.
 */
type ToolEntry = {
  def: { name: string; description: string; inputSchema: unknown };
  gate?: (task: TaskRow) => boolean;
  run(taskId: string, args: any): Promise<ToolResult>;
};

// The tool registry. Order here is the order tools appear in `tools/list`:
// a PLAN-PREVIEW task sees [propose_plan, request_review, raise]; an ordinary task
// sees [request_review, raise].
const TOOLS: ToolEntry[] = [
  {
    def: PROPOSE_PLAN_TOOL,
    gate: (t) => !!t.plan_preview,
    run: runProposePlan,
  },
  { def: REQUEST_REVIEW_TOOL, run: runRequestReview },
  { def: RAISE_TOOL, run: runRaise },
];

// Shared dispatcher for `tools/call`: look the tool up in the registry, extract its
// arguments, and run it. Unknown tool names are a JSON-RPC invalid-params error.
async function handleToolCall(
  taskId: string,
  msg: JsonRpcMessage,
): Promise<Response> {
  const name = msg.params?.name;
  const entry = TOOLS.find((t) => t.def.name === name);
  if (!entry) {
    return rpcError(msg.id, -32602, `unknown tool: ${name}`);
  }
  const args = msg.params?.arguments ?? {};
  return rpcResult(msg.id, await entry.run(taskId, args));
}

/**
 * Tool result reporting a task's CURRENT status, used when an agent action can't
 * proceed because the task is no longer `ok` (merged/aborted out from under it).
 */
function terminalStatusResult(taskId: string): ToolResult {
  return toolResult({ status: getTask(taskId)?.status ?? "unknown" });
}

/**
 * Shared NEEDS-INFO handshake behind `raise` and `propose_plan`: validate the raw
 * input, park the task in `needs_info` holding it (markNeedsInfoFromAgent), and
 * return the non-blocking success result — or a terminal-status result if the task
 * moved out from under the agent. The two tools differ ONLY in their input field
 * (passed as `raw`), validation-error string (`field`), and success prose (`message`).
 */
async function awaitingInputTool(
  taskId: string,
  raw: unknown,
  opts: { field: string; message: string },
): Promise<ToolResult> {
  if (typeof raw !== "string" || !raw.trim()) {
    return textResult(opts.field, true);
  }
  const state = markNeedsInfoFromAgent(taskId, raw.trim());
  if (state !== "ok") return terminalStatusResult(taskId);
  return toolResult({ status: "needs_info", message: opts.message });
}

/**
 * `request_review`: record the review request and move the task to `review`, then
 * RETURN AT ONCE (non-blocking). If the task is already terminal (merged/aborted
 * out from under the agent), report that instead. The agent should exit after this
 * call; butchr drives merge-on-approve / resume-on-reject entirely from DB state.
 */
async function runRequestReview(taskId: string, args: any): Promise<ToolResult> {
  const summary: string | undefined = args.summary;
  const state = markReviewFromAgent(taskId, summary);
  if (state !== "ok") {
    return terminalStatusResult(taskId);
  }
  return toolResult({
    status: "submitted",
    message:
      "Your work has been submitted for human review. You can stop now — do " +
      "not wait. If changes are requested, butchr will re-launch you with the " +
      "reviewer's notes; if it is approved, butchr merges your branch.",
  });
}

/**
 * `raise`: record whatever the agent is raising (a question, a suggested task change,
 * or a suggested decomposition) and park the task in `needs_info`, then RETURN AT ONCE
 * (non-blocking) — the unified feedback handshake that mirrors request_review. The
 * agent should exit after this call; butchr surfaces the message through one surface
 * (API + CLI + webapp), and on an answer re-launches the SAME Claude session
 * (`--resume`) with the response injected (see tasks.markNeedsInfoFromAgent /
 * answerTask). If the task is already terminal (merged/aborted out from under the
 * agent), report that instead.
 */
async function runRaise(taskId: string, args: any): Promise<ToolResult> {
  return awaitingInputTool(taskId, args.message, {
    field: "`raise` requires a non-empty `message` string.",
    message:
      "What you raised has been recorded and this task is now awaiting a response. " +
      "You can stop now — do not wait. butchr will surface it to whoever operates " +
      "(the CTO/operator via API/CLI, or a human in the webapp) and, once answered, " +
      "RE-LAUNCH you in this same session with the response so you can continue.",
  });
}

/**
 * `propose_plan` (PLAN-PREVIEW tasks): record the agent's implementation plan and
 * park the task in `needs_info` for operator approval, then RETURN AT ONCE
 * (non-blocking). REUSES the `raise` handshake (markNeedsInfoFromAgent) — the plan is
 * stored exactly like a clarifying question, and the operator's answer ('proceed' /
 * steering notes) resumes the SAME Claude session via `--resume` (answerTask), at
 * which point the agent implements + request_review as normal. The agent should exit
 * after this call. A blank plan is an `isError` tool result so the agent re-proposes
 * rather than parking an empty plan; a terminal task reports its status instead.
 */
async function runProposePlan(taskId: string, args: any): Promise<ToolResult> {
  return awaitingInputTool(taskId, args.plan, {
    field: "`propose_plan` requires a non-empty `plan` string.",
    message:
      "Your implementation plan has been recorded and this task is now awaiting " +
      "operator approval. Stop now — do NOT start implementing and do not wait. " +
      "butchr surfaces the plan to whoever operates and, once they answer 'proceed' " +
      "(or send steering notes), RE-LAUNCHES you in this same session with their " +
      "decision so you can implement the work and call request_review.",
  });
}
