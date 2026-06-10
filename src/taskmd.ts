// task.md is the on-disk source of truth for a task: prompt, metadata, and the
// running log of rejection notes. Lives at
//   <directory-root>/.butchr/tasks/<task-id>/task.md
//
// We deliberately hand-roll a tiny YAML reader/writer for the front matter
// (zero dependencies). The shape is fixed and simple, so this is safe.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  "question to the CTO and get an answer — prefer asking over guessing.",
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
  "tool to put a clarifying question to the CTO before proposing — prefer asking over",
  "guessing.",
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
    status: "queued",
    context: [],
    kind: "task",
  };

  let rest = raw;
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    rest = raw.slice(fm[0].length);
    const fmLines = fm[1]!.split("\n");
    let inContext = false;
    for (const line of fmLines) {
      const ctxItem = line.match(/^\s*-\s+(.*)$/);
      if (inContext && ctxItem) {
        const v = ctxItem[1]!.trim();
        if (v) meta.context.push(v);
        continue;
      }
      inContext = false;
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1]!;
      const val = kv[2]!.trim();
      if (key === "id") meta.id = val;
      else if (key === "created") meta.created = val;
      else if (key === "status") meta.status = (val as TaskStatus) || "queued";
      else if (key === "kind") meta.kind = val === "plan" ? "plan" : "task";
      else if (key === "context") {
        if (val === "" ) inContext = true;
        else if (val === "[]") meta.context = [];
        // inline list `context: [a, b]` support
        else if (val.startsWith("[")) {
          meta.context = val
            .replace(/^\[|\]$/g, "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }
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
  // A plan task decomposes the request via propose_subtasks; an ordinary task does
  // the work and submits via request_review. Hand each the matching protocol.
  parts.push(doc.meta.kind === "plan" ? PLAN_PROTOCOL : REVIEW_PROTOCOL);
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

/** Ensure a parent directory exists for a given file path. */
export function ensureParent(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}
