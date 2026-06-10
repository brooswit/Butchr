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
import { HttpError } from "./directories.ts";
import {
  getTask,
  markAwaitingInputFromAgent,
  markReviewFromAgent,
  proposeSubtasks,
} from "./tasks.ts";
import type { SubtaskSpec } from "./tasks.ts";

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
    "Ask a clarifying question about this task — requirements, conventions, design " +
    "judgment calls. Returns IMMEDIATELY (does NOT block): it records your question " +
    "and parks the task awaiting an answer, after which you should STOP and exit. " +
    "Whoever operates answers through butchr (the CTO/operator via API/CLI, or a " +
    "human in the webapp); once answered, butchr RE-LAUNCHES you in this same " +
    "session with the answer so you can continue. Prefer asking over guessing when " +
    "something is genuinely ambiguous.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The clarifying question to put to the operator/CTO.",
      },
    },
    required: ["question"],
    additionalProperties: false,
  },
} as const;

// Exposed ONLY for PLAN tasks (kind='plan'). The agent submits its decomposition —
// an ordered array of sub-task specs whose `blocked_by` reference siblings by INDEX
// (the ids don't exist yet) — and butchr creates the wired sub-tasks + completes the
// plan task. Non-blocking, like request_review (see tasks.proposeSubtasks).
const PROPOSE_SUBTASKS_TOOL = {
  name: "propose_subtasks",
  description:
    "Submit a decomposition of this PLAN task's request into sub-tasks. Returns " +
    "IMMEDIATELY with the created sub-task ids; after it returns, stop and exit. " +
    "Pass `subtasks`: an array of { prompt, context?, blocked_by? }. `prompt` is the " +
    "full instructions for that sub-task's own agent. `context` is an optional list " +
    "of repo-relative file paths it should read. `blocked_by` is an optional list of " +
    "INDICES (0-based positions in this same `subtasks` array) of sibling sub-tasks " +
    "that must merge before this one runs — reference siblings by index, not id (the " +
    "ids don't exist yet). butchr validates the graph (a cycle/self-reference is " +
    "rejected), creates the sub-tasks wiring their dependencies, and completes this " +
    "plan task. Do NOT write code in a plan task.",
  inputSchema: {
    type: "object",
    properties: {
      subtasks: {
        type: "array",
        description: "Ordered sub-task specs the request decomposes into.",
        items: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "The sub-task's agent prompt." },
            context: {
              type: "array",
              items: { type: "string" },
              description: "Optional repo-relative file paths the sub-task should read.",
            },
            blocked_by: {
              type: "array",
              items: { type: "integer" },
              description:
                "Indices of sibling sub-tasks (in this array) that must merge first.",
            },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
      },
      summary: {
        type: "string",
        description: "Optional short summary of the decomposition.",
      },
    },
    required: ["subtasks"],
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

    case "tools/list": {
      // A PLAN task gets the decomposition tool; an ordinary task gets the review
      // tool. `ask` is offered to both. The registry's `plan` flag encodes this
      // (see TOOLS). (handleMcp already verified the task exists.)
      const isPlan = getTask(taskId)?.kind === "plan";
      const tools = TOOLS
        .filter((t) => t.plan === undefined || t.plan === isPlan)
        .map((t) => t.def);
      return rpcResult(msg.id, { tools });
    }

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

type ToolResult = { content: unknown[]; isError: boolean };

/**
 * One dispatchable MCP tool: its public definition (name/description/inputSchema),
 * an optional `plan` gate, and a `run` that produces the tool result. The `plan`
 * flag drives `tools/list` filtering: `true` exposes the tool only to PLAN tasks,
 * `false` only to ordinary tasks, and omitted to both. The shared dispatcher
 * (`handleToolCall`) does name lookup + arg extraction; each `run` owns its own
 * field validation and error→`textResult` wrapping, since the messages are
 * tool-specific.
 */
type ToolEntry = {
  def: { name: string; description: string; inputSchema: unknown };
  plan?: boolean;
  run(taskId: string, args: any): Promise<ToolResult>;
};

// The tool registry. Order here is the order tools appear in `tools/list`:
// PLAN tasks see [propose_subtasks, ask]; ordinary tasks see [request_review, ask].
const TOOLS: ToolEntry[] = [
  { def: PROPOSE_SUBTASKS_TOOL, plan: true, run: runProposeSubtasks },
  { def: REQUEST_REVIEW_TOOL, plan: false, run: runRequestReview },
  { def: ASK_TOOL, run: runAsk },
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
 * `request_review`: record the review request and move the task to `review`, then
 * RETURN AT ONCE (non-blocking). If the task is already terminal (merged/aborted
 * out from under the agent), report that instead. The agent should exit after this
 * call; butchr drives merge-on-approve / resume-on-reject entirely from DB state.
 */
async function runRequestReview(taskId: string, args: any): Promise<ToolResult> {
  const summary: string | undefined = args.summary;
  const state = markReviewFromAgent(taskId, summary);
  if (state !== "ok") {
    return toolResult({ status: getTask(taskId)?.status ?? "unknown" });
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
 * `propose_subtasks` (PLAN tasks): validate + create the decomposition's sub-tasks
 * (wiring blocked_by among them) and complete the plan task. A validation failure
 * (bad/cyclic graph, blank prompt, wrong task kind) comes back as an `isError` tool
 * result so the agent sees the message and can re-propose, rather than crashing the
 * MCP server.
 */
async function runProposeSubtasks(taskId: string, args: any): Promise<ToolResult> {
  const subtasks: unknown = args.subtasks;
  const summary: string | undefined =
    typeof args.summary === "string" ? args.summary : undefined;

  if (!Array.isArray(subtasks)) {
    return textResult("`propose_subtasks` requires a `subtasks` array.", true);
  }

  try {
    const { created } = await proposeSubtasks(
      taskId,
      subtasks as SubtaskSpec[],
      summary,
    );
    return toolResult({
      status: "decomposed",
      created,
      message:
        `Created ${created.length} sub-task(s): ${created.join(", ")}. The ` +
        `dependencies were wired and this plan task is complete. You can stop now.`,
    });
  } catch (e) {
    // A validation HttpError is a normal "re-propose" signal for the agent; any
    // other error is reported the same way (never crashes the server).
    const detail = e instanceof HttpError ? e.message : (e as Error).message;
    return textResult(`Could not create sub-tasks: ${detail}`, true);
  }
}

/**
 * `ask`: record the agent's clarifying question and park the task in
 * `awaiting_input`, then RETURN AT ONCE (non-blocking) — the unified AWAITING-INPUT
 * handshake that mirrors request_review. The agent should exit after this call;
 * butchr surfaces the question through one surface (API + CLI + webapp), and on an
 * answer re-launches the SAME Claude session (`--resume`) with the answer injected
 * (see tasks.markAwaitingInputFromAgent / answerTask). If the task is already
 * terminal (merged/aborted out from under the agent), report that instead.
 */
async function runAsk(taskId: string, args: any): Promise<ToolResult> {
  const question: unknown = args.question;
  if (typeof question !== "string" || !question.trim()) {
    return textResult("`ask` requires a non-empty `question` string.", true);
  }

  const state = markAwaitingInputFromAgent(taskId, question.trim());
  if (state !== "ok") {
    return toolResult({ status: getTask(taskId)?.status ?? "unknown" });
  }
  return toolResult({
    status: "awaiting_input",
    message:
      "Your question has been recorded and this task is now awaiting an answer. " +
      "You can stop now — do not wait. butchr will surface it to whoever operates " +
      "(the CTO/operator via API/CLI, or a human in the webapp) and, once answered, " +
      "RE-LAUNCH you in this same session with the answer so you can continue.",
  });
}
