// task.md is the on-disk source of truth for a task: prompt, metadata, and the
// running log of rejection notes. Lives at
//   <directory-root>/.butchr/tasks/<task-id>/task.md
//
// We deliberately hand-roll a tiny YAML reader/writer for the front matter
// (zero dependencies). The shape is fixed and simple, so this is safe.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskKind, TaskStatus } from "./db.ts";

export type TaskMeta = {
  id: string;
  created: string;
  status: TaskStatus;
  context: string[];
  // 'task' (default) or 'plan' — a PLAN task decomposes a request into sub-tasks
  // instead of writing code (see db.ts `kind` + tasks.proposeSubtasks). Stored in
  // the front matter so renderAgentPrompt can hand a plan task the decomposition
  // protocol rather than the review protocol. Optional/absent reads back as "task".
  kind?: TaskKind;
  // Optional per-task model (e.g. 'opus'/'sonnet'/'haiku' or a full 'claude-*' id)
  // requested at creation and threaded into the agent launch (db.ts `model` column).
  // Absent/empty means "default" — no --model flag. Round-tripped in the front matter.
  model?: string | null;
  // Optional free-form organizational LABELS attached at creation (db.ts `tags`
  // column). Round-tripped in the front matter as a YAML list. Absent reads back as
  // [] — existing task.md files (which carry no `tags:` line) parse unchanged.
  tags?: string[];
  // PLAN-PREVIEW GATE (db.ts `plan_preview` column). When true, the FIRST rendered
  // prompt hands the agent the plan-preview protocol (propose a plan via the MCP
  // `propose_plan` tool and pause for operator approval) instead of diving straight
  // into the work. Stored in the front matter so renderAgentPrompt can branch on it.
  // Absent/false reads back as the default (no plan-preview), keeping existing
  // task.md files unchanged.
  plan_preview?: boolean;
};

export type TaskDoc = {
  meta: TaskMeta;
  prompt: string;
  /** Raw text of the "## Review Notes" section body, if present. */
  reviewNotes: string;
  /** The full original file text (for round-tripping unknown content). */
  raw: string;
};

const REVIEW_BANNER = "<!-- appended by butchr on each rejection -->";

// Appended to every rendered agent prompt: how to submit work for review via the
// butchr MCP server. request_review is NON-BLOCKING — it records the request and
// returns at once, after which the agent should EXIT. butchr owns the rest of the
// lifecycle (merge on approve, resume-with-notes on reject).
const REVIEW_PROTOCOL = [
  "# How to submit your work for review",
  "",
  "When you have completed ALL of the requested work, call the `request_review`",
  "tool provided by the **butchr** MCP server (optionally passing a short",
  "`summary` of what you did).",
  "",
  "This call returns IMMEDIATELY — it does NOT block waiting for a human. Once it",
  "returns, your work has been recorded for review and you should STOP: end your",
  "turn and exit. Do not keep the session open. butchr owns everything after this:",
  "",
  "- If the reviewer requests changes, butchr RE-LAUNCHES you in the same session",
  "  with full prior context plus the reviewer's notes; address them and call",
  "  `request_review` again.",
  "- If the reviewer approves, butchr merges your branch automatically. Nothing",
  "  further is required from you.",
  "",
  "If anything about the requirements, conventions, or a design judgment call is",
  "ambiguous, use the **butchr** MCP server's `ask` tool to put a clarifying",
  "question — prefer asking over guessing. `ask` is ALSO non-blocking: it records",
  "your question and returns immediately, after which you should STOP and exit.",
  "butchr surfaces the question to whoever operates (the CTO/operator via API/CLI,",
  "or a human in the webapp); once answered, butchr RE-LAUNCHES you in the same",
  "session with the answer so you can continue. Do not wait for the answer inline.",
  "",
  "You do NOT need to commit or clean up — butchr captures your worktree changes",
  "automatically. After calling `request_review`, stop.",
].join("\n");

// Appended to a PLAN task's rendered prompt instead of REVIEW_PROTOCOL. A plan task
// writes NO code: it analyzes the request and submits a DECOMPOSITION through the
// butchr MCP `propose_subtasks` tool. butchr validates the proposed graph, creates
// the sub-tasks (wiring their blocked_by among one another), and completes the plan
// task. See tasks.proposeSubtasks / mcp.ts.
const PLAN_PROTOCOL = [
  "# How to submit your decomposition",
  "",
  "This is a **PLAN task**: do NOT write code. Your job is to ANALYZE the request",
  "above (read the repository with your tools as needed) and break it into an",
  "ordered set of concrete sub-tasks, then submit them by calling the",
  "`propose_subtasks` tool provided by the **butchr** MCP server.",
  "",
  "Pass `subtasks`: an array where each entry is `{ prompt, context?, blocked_by? }`:",
  "",
  "- `prompt` (required): the full instructions for that sub-task's agent — written",
  "  like a normal butchr task prompt (it will run its own agent in its own worktree).",
  "- `context` (optional): a list of repo-relative file paths the sub-task should read.",
  "- `blocked_by` (optional): the INDICES (0-based positions in this same `subtasks`",
  "  array) of the sibling sub-tasks that must merge BEFORE this one runs. Use this to",
  "  express ordering/dependencies. Reference siblings by their array index, NOT by id",
  "  (the ids do not exist yet). A cyclic or self-referential graph is rejected.",
  "",
  "You may also pass an optional `summary` describing the decomposition.",
  "",
  "`propose_subtasks` returns IMMEDIATELY with the created sub-task ids and records",
  "them against this plan task; once it returns you should STOP and exit. butchr",
  "creates the sub-tasks (wiring their dependencies) and completes this plan task.",
  "",
  "If anything about the request is ambiguous, use the **butchr** MCP server's `ask`",
  "tool to put a clarifying question before proposing — prefer asking over guessing.",
  "`ask` is non-blocking: it records your question and returns immediately, after",
  "which you should STOP and exit; butchr surfaces it to whoever operates and, once",
  "answered, RE-LAUNCHES you in the same session with the answer to continue.",
].join("\n");

// Appended to a PLAN-PREVIEW task's FIRST rendered prompt instead of REVIEW_PROTOCOL.
// A plan-preview task IS an ordinary work task (it writes code), but it must get the
// operator's sign-off on its approach FIRST: before touching any code, the agent
// submits a concise implementation plan via the butchr MCP `propose_plan` tool, which
// parks the task in `awaiting_input` holding the plan (reusing the ASK handshake) and
// returns immediately so the agent exits. The operator answers 'proceed' (or sends
// steering notes); butchr re-launches the SAME session via `--resume` with that
// decision, at which point the agent implements and submits via request_review like
// any other task (the answer-resume prompt — renderAnswerPrompt — carries the
// review protocol). See mcp.ts (propose_plan) / tasks.markAwaitingInputFromAgent.
const PLAN_PREVIEW_PROTOCOL = [
  "# First, propose a plan (PLAN-PREVIEW gate)",
  "",
  "This task has **PLAN-PREVIEW enabled**: do NOT write any code yet. FIRST analyze",
  "the request above (read the repository with your tools as needed) and produce a",
  "CONCISE implementation plan — the files you intend to change and the approach you",
  "will take — then submit it by calling the `propose_plan` tool provided by the",
  "**butchr** MCP server, passing your plan as the `plan` argument.",
  "",
  "`propose_plan` returns IMMEDIATELY (it does NOT block) and parks this task awaiting",
  "the operator's decision; once it returns you should STOP and exit. Do not start",
  "implementing and do not wait inline. The operator reviews your plan and answers",
  "'proceed' (or sends steering notes to adjust it); butchr then RE-LAUNCHES you in",
  "this SAME session with their decision, at which point you IMPLEMENT the work and",
  "submit it for review with `request_review` exactly as a normal task would.",
  "",
  "If anything about the request is ambiguous, use the **butchr** MCP server's `ask`",
  "tool to put a clarifying question before proposing — prefer asking over guessing.",
  "`ask` is also non-blocking: it records your question and returns immediately, after",
  "which you should STOP and exit; once answered butchr re-launches you in the same",
  "session with the answer to continue.",
].join("\n");

/** Absolute path to a task's directory under .butchr/tasks/. */
export function taskDir(directoryRoot: string, taskId: string): string {
  return join(directoryRoot, ".butchr", "tasks", taskId);
}

/** Absolute path to a directory's CTO context file under .butchr/. */
export function ctoMdPath(directoryRoot: string): string {
  return join(directoryRoot, ".butchr", "CTO.md");
}

/** Absolute path to a task's task.md. */
export function taskMdPath(directoryRoot: string, taskId: string): string {
  return join(taskDir(directoryRoot, taskId), "task.md");
}

function serializeFrontMatter(meta: TaskMeta): string {
  const lines: string[] = ["---"];
  lines.push(`id: ${meta.id}`);
  lines.push(`created: ${meta.created}`);
  lines.push(`status: ${meta.status}`);
  // Only emit a kind line for plan tasks — ordinary tasks omit it and parse back as
  // the "task" default, keeping existing task.md files unchanged.
  if (meta.kind === "plan") lines.push(`kind: ${meta.kind}`);
  // Only emit a model line when one was requested — an unset model omits it and
  // parses back as null (the default), keeping existing task.md files unchanged.
  if (meta.model) lines.push(`model: ${meta.model}`);
  // Only emit a plan_preview line when the gate is on — the default (off) omits it
  // and parses back as false, keeping existing task.md files unchanged.
  if (meta.plan_preview) lines.push(`plan_preview: true`);
  // Only emit a tags line when the task has labels — an empty/absent set omits it
  // and parses back as [], keeping existing task.md files unchanged.
  if (meta.tags && meta.tags.length) {
    lines.push("tags:");
    for (const t of meta.tags) lines.push(`  - ${t}`);
  }
  if (meta.context.length === 0) {
    lines.push("context: []");
  } else {
    lines.push("context:");
    for (const c of meta.context) lines.push(`  - ${c}`);
  }
  lines.push("---");
  return lines.join("\n");
}

/** Create the task directory and write the initial task.md. */
export function writeTaskMd(
  directoryRoot: string,
  meta: TaskMeta,
  prompt: string,
): void {
  const dir = taskDir(directoryRoot, meta.id);
  mkdirSync(dir, { recursive: true });
  const body = [
    serializeFrontMatter(meta),
    "",
    "## Prompt",
    "",
    prompt.trim(),
    "",
    "## Review Notes",
    "",
    REVIEW_BANNER,
    "",
  ].join("\n");
  writeFileSync(taskMdPath(directoryRoot, meta.id), body, "utf8");
}

/** Append a rejection note to an existing task.md's Review Notes section. */
export function appendRejection(
  directoryRoot: string,
  taskId: string,
  note: string,
  whenIso: string,
): void {
  const p = taskMdPath(directoryRoot, taskId);
  let text = existsSync(p) ? readFileSync(p, "utf8") : "";
  if (!text.includes("## Review Notes")) {
    text += `\n\n## Review Notes\n\n${REVIEW_BANNER}\n`;
  }
  const entry = `\n### Rejection — ${whenIso}\n${note.trim()}\n`;
  writeFileSync(p, text.trimEnd() + "\n" + entry, "utf8");
}

const CLARIFY_SECTION = "## Clarifications";

/**
 * Append a question/answer pair to task.md's Clarifications section — the durable
 * audit trail of the ASK handshake (a running agent asked via the MCP `ask` tool
 * and an operator answered). Purely for the record/UI; the resume itself injects the
 * answer from the `answer` column, mirroring how appendRejection logs review notes
 * while the resume reads them back.
 */
export function appendAnswer(
  directoryRoot: string,
  taskId: string,
  question: string,
  answer: string,
  whenIso: string,
): void {
  const p = taskMdPath(directoryRoot, taskId);
  let text = existsSync(p) ? readFileSync(p, "utf8") : "";
  if (!text.includes(CLARIFY_SECTION)) {
    text += `\n\n${CLARIFY_SECTION}\n`;
  }
  const q = question.trim() || "(question not recorded)";
  const entry = `\n### Q&A — ${whenIso}\n**Q:** ${q}\n\n**A:** ${answer.trim()}\n`;
  writeFileSync(p, text.trimEnd() + "\n" + entry, "utf8");
}

/**
 * Build the prompt for an ANSWER-driven re-launch. The agent paused mid-task by
 * calling the MCP `ask` tool (parking the task in `awaiting_input` and exiting);
 * an operator answered, and butchr resumes the SAME `claude --resume <session-id>`
 * session — so it still has the original prompt, its prior work, and its own
 * question in context. This is a focused message: the answer plus a reminder to
 * continue and submit, exactly like renderReworkPrompt is for a reject.
 */
export function renderAnswerPrompt(answer: string): string {
  const body =
    `You paused this task to ask a clarifying question via the \`ask\` tool. Here ` +
    `is the answer:\n\n${answer.trim()}\n\nUse it to continue the task. When the ` +
    `work is complete, call \`request_review\` (or use \`ask\` again if something ` +
    `else is genuinely ambiguous).`;
  return [`# Answer to your question`, "", body].join("\n") + "\n\n---\n\n" + REVIEW_PROTOCOL;
}

/** Update only the `status:` line in the front matter, in place. */
export function updateTaskMdStatus(
  directoryRoot: string,
  taskId: string,
  status: TaskStatus,
): void {
  const p = taskMdPath(directoryRoot, taskId);
  if (!existsSync(p)) return;
  const text = readFileSync(p, "utf8");
  const updated = text.replace(/^status:.*$/m, `status: ${status}`);
  writeFileSync(p, updated, "utf8");
}

/**
 * Replace the body of the "## Prompt" section in a task.md, in place. Used when an
 * `idea`-state task's CTO-fork spec generator produces its spec: the brief the
 * operator typed (stored as the initial prompt) is swapped for the full generated
 * SPEC, so when the task advances to `queued` ('ready') the build agent's rendered
 * prompt (renderAgentPrompt → doc.prompt) IS the spec. No-op if the file or the
 * Prompt section is missing. Preserves the front matter and everything from the next
 * `## ` heading (e.g. "## Review Notes") onward.
 */
export function updateTaskMdPrompt(
  directoryRoot: string,
  taskId: string,
  prompt: string,
): void {
  const p = taskMdPath(directoryRoot, taskId);
  if (!existsSync(p)) return;
  const text = readFileSync(p, "utf8");
  // Match "## Prompt\n<body>" up to (but not including) the next "## " heading or EOF,
  // mirroring parseTaskMd's prompt regex, and replace only the body.
  const re = /(##\s*Prompt\s*\n)([\s\S]*?)(\n##\s|\s*$)/;
  if (!re.test(text)) return;
  const updated = text.replace(re, (_m, head, _body, tail) => `${head}\n${prompt.trim()}\n${tail}`);
  writeFileSync(p, updated, "utf8");
}

/** Parse a task.md file. Tolerant of minor formatting differences. */
export function readTaskMd(directoryRoot: string, taskId: string): TaskDoc {
  const p = taskMdPath(directoryRoot, taskId);
  const raw = readFileSync(p, "utf8");
  return parseTaskMd(raw);
}

export function parseTaskMd(raw: string): TaskDoc {
  const meta: TaskMeta = {
    id: "",
    created: "",
    status: "in_progress",
    context: [],
    kind: "task",
    model: null,
    tags: [],
    plan_preview: false,
  };

  let rest = raw;
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    rest = raw.slice(fm[0].length);
    const fmLines = fm[1]!.split("\n");
    // `context` and `tags` are both multi-line YAML lists; track which (if any) we're
    // currently accumulating `- item` lines into.
    let inList: "context" | "tags" | null = null;
    // Parse an inline list `[a, b]` into a clean string array.
    const inline = (val: string): string[] =>
      val.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const line of fmLines) {
      const item = line.match(/^\s*-\s+(.*)$/);
      if (inList && item) {
        const v = item[1]!.trim();
        if (v) (inList === "context" ? meta.context : meta.tags!).push(v);
        continue;
      }
      inList = null;
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1]!;
      const val = kv[2]!.trim();
      if (key === "id") meta.id = val;
      else if (key === "created") meta.created = val;
      else if (key === "status") meta.status = (val as TaskStatus) || "in_progress";
      else if (key === "kind") meta.kind = val === "plan" ? "plan" : "task";
      else if (key === "model") meta.model = val || null;
      else if (key === "plan_preview") meta.plan_preview = val === "true";
      // NOTE: a legacy `stage:` line from the retracted idea→spec→build axis is simply
      // ignored here (the key falls through unrecognized) — task.md files written by the
      // old code parse cleanly under the unified single-status pipeline.
      else if (key === "context" || key === "tags") {
        const target: "context" | "tags" = key;
        if (val === "") inList = target;
        else if (val === "[]") meta[target] = [];
        // inline list `context: [a, b]` / `tags: [a, b]` support
        else if (val.startsWith("[")) meta[target] = inline(val);
      }
    }
  }

  // Prompt section
  let prompt = "";
  const pm = rest.match(/##\s*Prompt\s*\n([\s\S]*?)(?:\n##\s|\s*$)/);
  if (pm) prompt = pm[1]!.trim();

  // Review notes section
  let reviewNotes = "";
  const rm = rest.match(/##\s*Review Notes\s*\n([\s\S]*)$/);
  if (rm) {
    reviewNotes = rm[1]!.replace(REVIEW_BANNER, "").trim();
  }

  return { meta, prompt, reviewNotes, raw };
}

/**
 * Build the full prompt to hand the agent: the directory's CTO context, then the
 * LIST of context-file PATHS to read, then the task prompt.
 *
 * We deliberately do NOT inline the context files' bodies. The rendered prompt is
 * written to disk and then passed to the agent as a single shell argv (the launch
 * command does `claude ... -- "$(cat <prompt-file>)"`), so a large prompt blows
 * past the kernel's MAX_ARG_STRLEN (~128KB) limit → exec fails with E2BIG and the
 * agent never starts. Listing the paths keeps the prompt tiny; the agent reads the
 * files itself with its own tools (it has the worktree open), which is what it
 * would do anyway.
 */
export function renderAgentPrompt(directoryRoot: string, doc: TaskDoc): string {
  const parts: string[] = [];

  // Prepend the directory's CTO context (best-effort) so every agent starts with
  // it ABOVE the context files, task prompt, and review-handshake instructions.
  const ctoPath = ctoMdPath(directoryRoot);
  if (existsSync(ctoPath)) {
    try {
      const cto = readFileSync(ctoPath, "utf8").trim();
      if (cto) parts.push(`# CTO context\n\n${cto}`);
    } catch {
      // ignore unreadable CTO context
    }
  }

  if (doc.meta.context.length) {
    // List the context-file paths (relative to the repo root) and tell the agent
    // to read them with its tools — never dump their contents into the prompt.
    const list = doc.meta.context.map((rel) => `- \`${rel}\``).join("\n");
    parts.push(
      `# Context files\n\n` +
        `The following files contain relevant context for this task. Their paths ` +
        `are relative to the repository root; READ them with your tools before ` +
        `starting (do not assume their contents):\n\n${list}`,
    );
  }
  let body = doc.prompt;
  if (doc.reviewNotes) {
    body += `\n\n# Review notes from previous attempts\n\n${doc.reviewNotes}\n\nAddress the review notes above in this attempt.`;
  }
  parts.push(body);
  // Hand the agent the matching protocol for this FIRST launch:
  //  - a PLAN task (kind='plan') decomposes the request via propose_subtasks;
  //  - a PLAN-PREVIEW task proposes a plan via propose_plan and pauses for approval
  //    BEFORE writing code (it implements on the answer-resume — renderAnswerPrompt);
  //  - an ordinary task does the work and submits via request_review.
  //
  // NOTE: an `idea`-state task is NEVER rendered here — its work (generating a spec from
  // the brief) is done by the CTO-fork spec generator in the dispatcher (src/cto.ts), not
  // by a build agent. By the time renderAgentPrompt runs, the task has advanced to
  // `queued` ('ready') with the generated spec as its prompt, so it gets the normal flow.
  parts.push(
    doc.meta.kind === "plan"
      ? PLAN_PROTOCOL
      : doc.meta.plan_preview
        ? PLAN_PREVIEW_PROTOCOL
        : REVIEW_PROTOCOL,
  );
  return parts.join("\n\n---\n\n");
}

/**
 * Build the prompt for a REJECTED task's re-launch. The agent is resumed via
 * `claude --resume <session-id>`, so it already has the original prompt, its
 * prior work, and the review exchange in context — we must NOT re-dump the
 * context files or the full prompt (that's redundant and bloats the turn).
 * Instead this is a focused message: the accumulated review notes plus a reminder
 * to address them and submit again. Falls back to a generic instruction if no
 * review notes are recorded (shouldn't happen, but keeps the agent unblocked).
 */
export function renderReworkPrompt(directoryRoot: string, doc: TaskDoc): string {
  const notes = doc.reviewNotes.trim();
  const body = notes
    ? `Your previous submission was reviewed and changes were requested. Address ` +
      `the following review notes, then call \`request_review\` again.\n\n${notes}`
    : `Changes were requested on your previous submission. Review your work, ` +
      `make the necessary fixes, then call \`request_review\` again.`;
  return [`# Changes requested`, "", body].join("\n") + "\n\n---\n\n" + REVIEW_PROTOCOL;
}

/**
 * Build the prompt for the FINALIZING phase. The operator APPROVED the task in
 * `in_review`; the workspace agent is resumed (`claude --resume <session-id>`, so it
 * still has the full task + review history in context) to do POST-APPROVAL 'final
 * thoughts' — a last wrap-up pass (tidy comments/docs, remove stray debug, a final
 * self-check) BEFORE butchr finalizes the merge. This is a focused message: it tells
 * the agent its work was approved and to call `request_review` again the moment its
 * wrap-up is done (which signals butchr to land the merge). Best-effort: butchr
 * finalizes regardless of whether the agent makes further changes.
 */
export function renderFinalizePrompt(): string {
  const body =
    `Your work was APPROVED. Before butchr lands the merge, do a brief FINAL pass: ` +
    `tidy up comments/docs touched by this change, remove any stray debugging, and ` +
    `give the diff one last self-review. Keep it minimal — do NOT start new work. ` +
    `When you're done (or if there's nothing to wrap up), call \`request_review\` ` +
    `again to signal butchr to finalize and merge your branch.`;
  return [`# Approved — final thoughts before merge`, "", body].join("\n") + "\n\n---\n\n" + REVIEW_PROTOCOL;
}
