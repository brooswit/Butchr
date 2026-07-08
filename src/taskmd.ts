// task.md is the on-disk source of truth for a task: prompt, metadata, and the
// running log of rejection notes. Lives at
//   <workspace-root>/.butchr/tasks/<task-id>/task.md
//
// We deliberately hand-roll a tiny YAML reader/writer for the front matter
// (zero dependencies). The shape is fixed and simple, so this is safe.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskKind, TaskStatus } from "./db.ts";

export type TaskMeta = {
  id: string;
  created: string;
  status: TaskStatus;
  context: string[];
  // 'task' (default) or 'rollback' — a ROLLBACK task builds a revert like any task but
  // lands via its own `rolling_back`→`rolled_back` lifecycle tail (see db.ts `kind` +
  // tasks.finalizeMerge). Stored in the front matter so the DB row's kind is recoverable
  // from disk. Optional/absent reads back as "task".
  kind?: TaskKind;
  // Optional per-task model (e.g. 'opus'/'sonnet'/'haiku' or a full 'claude-*' id)
  // requested at creation and threaded into the agent launch (db.ts `model` column).
  // Absent/empty means "default" — no --model flag. Round-tripped in the front matter.
  model?: string | null;
  // Optional free-form organizational LABELS attached at creation (db.ts `tags`
  // column). Round-tripped in the front matter as a YAML list. Absent reads back as
  // [] — existing task.md files (which carry no `tags:` line) parse unchanged.
  tags?: string[];
  // Optional per-task FILE ALLOWLIST attached at creation (db.ts `allowlist` column):
  // the glob/path entries the task's diff may touch, enforced by the CI gate. Round-
  // tripped in the front matter as a YAML list. Absent reads back as [] — existing
  // task.md files (which carry no `allowlist:` line) parse unchanged.
  allowlist?: string[];
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
  "# Keep going until the task is done",
  "",
  "Work AUTONOMOUSLY and CONTINUOUSLY through this task to completion. Keep going on",
  "your own — do NOT stop, pause, or sit idle partway, and do NOT ask for confirmation",
  "to proceed on work that is already specified. After finishing one step, immediately",
  "continue to the next; drive the whole task in one self-sustained loop without",
  "waiting to be nudged.",
  "",
  "Before submitting, SELF-VERIFY the work is genuinely COMPLETE: build and run the",
  "tests where applicable, and confirm every requirement is met.",
  "",
  "ONLY end your turn when you either (a) call `request_review` because the task is",
  "fully done, or (b) call `raise` because you are genuinely blocked on a decision (or",
  "the task itself looks wrong). Otherwise, keep working. Once the task IS complete and",
  "you have called `request_review`, STOP — do not re-submit or loop again.",
  "",
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
  "ambiguous — or the TASK ITSELF looks wrong (wrong scope, should be split, or",
  "should be decomposed into sub-tasks) — use the **butchr** MCP server's `raise`",
  "tool. You are a WORKER, not a task-manager: you do not create or edit tasks; you",
  "raise a question, a suggested task change, or a suggested decomposition, and the",
  "operator/CTO acts on it. `raise` is ALSO non-blocking: it records your message and",
  "returns immediately, after which you should STOP and exit. butchr surfaces it to",
  "whoever operates (the CTO/operator via API/CLI, or a human in the webapp); once",
  "answered, butchr RE-LAUNCHES you in the same session with the response so you can",
  "continue. Do not wait for the response inline. Prefer raising over guessing.",
  "",
  "You do NOT need to commit or clean up — butchr captures your worktree changes",
  "automatically. After calling `request_review`, stop.",
].join("\n");

// Appended to a PLAN-PREVIEW task's FIRST rendered prompt instead of REVIEW_PROTOCOL.
// A plan-preview task IS an ordinary work task (it writes code), but it must get the
// operator's sign-off on its approach FIRST: before touching any code, the agent
// submits a concise implementation plan via the butchr MCP `propose_plan` tool, which
// parks the task in `needs_info` holding the plan (reusing the `raise` handshake) and
// returns immediately so the agent exits. The operator answers 'proceed' (or sends
// steering notes); butchr re-launches the SAME session via `--resume` with that
// decision, at which point the agent implements and submits via request_review like
// any other task (the answer-resume prompt — renderAnswerPrompt — carries the
// review protocol). See mcp.ts (propose_plan) / tasks.markNeedsInfoFromAgent.
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
  "If anything about the request is ambiguous, use the **butchr** MCP server's `raise`",
  "tool to put a clarifying question before proposing — prefer raising over guessing.",
  "`raise` is also non-blocking: it records your message and returns immediately, after",
  "which you should STOP and exit; once answered butchr re-launches you in the same",
  "session with the response to continue.",
].join("\n");

/** Absolute path to a task's directory under .butchr/tasks/. */
export function taskDir(workspaceRoot: string, taskId: string): string {
  return join(workspaceRoot, ".butchr", "tasks", taskId);
}

/** Absolute path to a workspace's CTO context file under .butchr/. */
export function ctoMdPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".butchr", "CTO.md");
}

/** Absolute path to a task's task.md. */
export function taskMdPath(workspaceRoot: string, taskId: string): string {
  return join(taskDir(workspaceRoot, taskId), "task.md");
}

function serializeFrontMatter(meta: TaskMeta): string {
  const lines: string[] = ["---"];
  lines.push(`id: ${meta.id}`);
  lines.push(`created: ${meta.created}`);
  lines.push(`status: ${meta.status}`);
  // Only emit a kind line for non-default kinds (plan / rollback) — ordinary tasks omit
  // it and parse back as the "task" default, keeping existing task.md files unchanged.
  if (meta.kind !== "task") lines.push(`kind: ${meta.kind}`);
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
  // Only emit an allowlist line when the task declares one — an empty/absent set omits
  // it and parses back as [], keeping existing task.md files unchanged.
  if (meta.allowlist && meta.allowlist.length) {
    lines.push("allowlist:");
    for (const a of meta.allowlist) lines.push(`  - ${a}`);
  }
  lines.push(...serializeContext(meta.context));
  lines.push("---");
  return lines.join("\n");
}

/**
 * Serialize the front-matter `context:` block as YAML lines: `context: []` for an empty
 * list, else a `context:` header followed by one `  - <path>` item per entry. Factored
 * out of serializeFrontMatter so the WRITE path and the in-place updateTaskMdContext
 * edit emit the EXACT same format.
 */
function serializeContext(context: string[]): string[] {
  if (context.length === 0) return ["context: []"];
  return ["context:", ...context.map((c) => `  - ${c}`)];
}

/** Create the task directory and write the initial task.md. */
export function writeTaskMd(
  workspaceRoot: string,
  meta: TaskMeta,
  prompt: string,
): void {
  const dir = taskDir(workspaceRoot, meta.id);
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
  writeFileSync(taskMdPath(workspaceRoot, meta.id), body, "utf8");
}

/** Append a rejection note to an existing task.md's Review Notes section. */
export function appendRejection(
  workspaceRoot: string,
  taskId: string,
  note: string,
  whenIso: string,
): void {
  const p = taskMdPath(workspaceRoot, taskId);
  let text = existsSync(p) ? readFileSync(p, "utf8") : "";
  if (!text.includes("## Review Notes")) {
    text += `\n\n## Review Notes\n\n${REVIEW_BANNER}\n`;
  }
  const entry = `\n### Rejection — ${whenIso}\n${note.trim()}\n`;
  writeFileSync(p, text.trimEnd() + "\n" + entry, "utf8");
}

const AMENDMENTS_SECTION = "## Amendments";

/**
 * Append an operator AMENDMENT to task.md's Amendments section — the durable audit trail of
 * the `update` verb (an operator amended an in-flight instruction after the fact via
 * `updateTask`). The `## Prompt` body itself is rewritten in place (updateTaskMdPrompt) so a
 * resumed/dispatched agent re-grounds on the CURRENT brief; this section is the cheap,
 * append-only record of WHAT changed and WHEN, mirroring how appendRejection logs review
 * notes and appendAnswer logs the raise handshake. Appended AFTER the Prompt rewrite so the
 * in-place body swap never clobbers the trail.
 */
export function appendAmendment(
  workspaceRoot: string,
  taskId: string,
  brief: string,
  whenIso: string,
): void {
  const p = taskMdPath(workspaceRoot, taskId);
  let text = existsSync(p) ? readFileSync(p, "utf8") : "";
  if (!text.includes(AMENDMENTS_SECTION)) {
    text += `\n\n${AMENDMENTS_SECTION}\n`;
  }
  const entry = `\n### Amendment — ${whenIso}\n${brief.trim()}\n`;
  writeFileSync(p, text.trimEnd() + "\n" + entry, "utf8");
}

const CLARIFY_SECTION = "## Clarifications";

/**
 * Append a raised-item/answer pair to task.md's Clarifications section — the durable
 * audit trail of the `raise` handshake (a running agent raised a question / suggested
 * task change / decomposition via the MCP `raise` tool and an operator answered).
 * Purely for the record/UI; the resume itself injects the answer from the `answer`
 * column, mirroring how appendRejection logs review notes while the resume reads them
 * back.
 */
export function appendAnswer(
  workspaceRoot: string,
  taskId: string,
  question: string,
  answer: string,
  whenIso: string,
): void {
  const p = taskMdPath(workspaceRoot, taskId);
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
 * calling the MCP `raise` tool (parking the task in `needs_info` and exiting);
 * an operator answered, and butchr resumes the SAME `claude --resume <session-id>`
 * session — so it still has the original prompt, its prior work, and what it raised
 * in context. This is a focused message: the answer plus a reminder to continue and
 * submit, exactly like renderReworkPrompt is for a reject.
 */
export function renderAnswerPrompt(answer: string, reground = ""): string {
  const body =
    `You paused this task by raising something via the \`raise\` tool. Here is the ` +
    `operator's response:\n\n${answer.trim()}\n\nUse it to continue the task. When ` +
    `the work is complete, call \`request_review\` (or use \`raise\` again if ` +
    `something else is genuinely ambiguous or the task itself looks wrong).`;
  const focused = [`# Response to what you raised`, "", body].join("\n");
  // If the task was edited while it was paused, the re-grounding block (the CURRENT
  // prompt + context) leads, so the agent re-grounds before reading the answer.
  const head = reground.trim() ? reground.trim() + "\n\n---\n\n" : "";
  return head + focused + "\n\n---\n\n" + REVIEW_PROTOCOL;
}

/**
 * Stable fingerprint of the parts of a task.md that a RESUMED agent's `--resume`
 * session would NOT pick up on its own: the prompt body and the context-file list.
 * butchr records this whenever it grounds an agent (markRunning) and re-checks it on
 * every resume — a mismatch means the task's prompt/context was edited while the agent
 * was paused (needs_info / in_review), so the resume must RE-GROUND it
 * (renderRegroundBlock) instead of handing it only the focused answer/rework message.
 * Review notes are deliberately EXCLUDED (they already flow into the rework prompt), as
 * is status/usage/etc. — none of which change what the agent must build.
 */
export function groundingFingerprint(doc: TaskDoc): string {
  const payload = JSON.stringify({
    prompt: doc.prompt.trim(),
    context: doc.meta.context,
  });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Build a RE-GROUNDING block for a resumed agent whose task was EDITED while it was
 * paused (needs_info / in_review). A resume re-enters the SAME `claude --resume`
 * session, which still holds the ORIGINAL prompt + context the agent was first given —
 * so an operator's edit to the prompt/context (e.g. via the broadened `raise` tool) is
 * invisible to it unless we restate the CURRENT definition. This block carries the
 * authoritative current prompt + context-file list, framed as superseding what the
 * session holds. The dispatcher prepends it to the focused answer/rework message ONLY
 * when groundingFingerprint shows the prompt/context actually changed since the agent
 * was last grounded; an unchanged task resumes with the focused message exactly as
 * before.
 */
export function renderRegroundBlock(doc: TaskDoc): string {
  const parts: string[] = [
    `# Task updated while you were paused\n\n` +
      `This task's prompt and/or context files were REVISED while it was paused. The ` +
      `definition below is the CURRENT, authoritative one — it SUPERSEDES the original ` +
      `prompt and context files you were given earlier in this session. Re-ground ` +
      `yourself in it before continuing.`,
    `## Current prompt\n\n${doc.prompt.trim()}`,
  ];
  if (doc.meta.context.length) {
    const list = doc.meta.context.map((rel) => `- \`${rel}\``).join("\n");
    parts.push(
      `## Context files\n\n` +
        `Read these with your tools before continuing (their paths are relative to the ` +
        `repository root) — they may have changed:\n\n${list}`,
    );
  }
  return parts.join("\n\n");
}

/** Update only the `status:` line in the front matter, in place. */
export function updateTaskMdStatus(
  workspaceRoot: string,
  taskId: string,
  status: TaskStatus,
): void {
  const p = taskMdPath(workspaceRoot, taskId);
  if (!existsSync(p)) return;
  const text = readFileSync(p, "utf8");
  const updated = text.replace(/^status:.*$/m, `status: ${status}`);
  writeFileSync(p, updated, "utf8");
}

/**
 * Replace the body of the "## Prompt" section in a task.md, in place. Used when an
 * `idea`-state task's spec is SUBMITTED (by the spec-generation responder via
 * submitSpec): the brief the operator typed (stored as the initial prompt) is swapped
 * for the full SPEC, so when the task advances to `spec_review` and then `inactive`
 * ('ready') the build agent's rendered prompt (renderAgentPrompt → doc.prompt) IS the
 * spec. No-op if the file or the Prompt section is missing. Preserves the front matter
 * and everything from the next `## ` heading (e.g. "## Review Notes") onward.
 */
export function updateTaskMdPrompt(
  workspaceRoot: string,
  taskId: string,
  prompt: string,
): void {
  const p = taskMdPath(workspaceRoot, taskId);
  if (!existsSync(p)) return;
  const text = readFileSync(p, "utf8");
  // Match "## Prompt\n<body>" up to (but not including) the next "## " heading or EOF,
  // mirroring parseTaskMd's prompt regex, and replace only the body.
  const re = /(##\s*Prompt\s*\n)([\s\S]*?)(\n##\s|\s*$)/;
  if (!re.test(text)) return;
  const updated = text.replace(re, (_m, head, _body, tail) => `${head}\n${prompt.trim()}\n${tail}`);
  writeFileSync(p, updated, "utf8");
}

/**
 * Replace the front-matter `context:` block of a task.md, in place. Used when an
 * operator REFINES a paused task's context-file list (editTask): the new list
 * supersedes the old one, and on the agent's next `--resume` the grounding-fingerprint
 * mismatch re-grounds it (renderRegroundBlock). Rewrites ONLY the context lines —
 * order-independent: it strips the existing `context:` line plus its `  - item`
 * continuation lines (and the inline `context: [..]` / `context: []` forms) wherever
 * they sit in the front matter, then appends the freshly-serialized block, so the
 * Prompt body, Review Notes, and Clarifications are untouched. No-op if the file or its
 * front matter is missing.
 */
export function updateTaskMdContext(
  workspaceRoot: string,
  taskId: string,
  context: string[],
): void {
  const p = taskMdPath(workspaceRoot, taskId);
  if (!existsSync(p)) return;
  const text = readFileSync(p, "utf8");
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fm) return;
  const inner = fm[1]!.split("\n");
  // Drop the existing context block: the `context:` key line and (for the multi-line
  // form) the `  - item` lines that immediately follow it.
  const kept: string[] = [];
  let skippingItems = false;
  for (const line of inner) {
    if (/^context:/.test(line)) {
      // Begin skipping; if it's the multi-line form (`context:` with no inline value),
      // also skip the following `  - item` lines.
      skippingItems = /^context:\s*$/.test(line);
      continue;
    }
    if (skippingItems) {
      if (/^\s*-\s+/.test(line)) continue; // a context list item — skip it
      skippingItems = false; // first non-item line ends the block
    }
    kept.push(line);
  }
  const newInner = [...kept, ...serializeContext(context)].join("\n");
  const updated = text.slice(0, fm.index!) + `---\n${newInner}\n---\n` + text.slice(fm.index! + fm[0].length);
  writeFileSync(p, updated, "utf8");
}

/** Parse a task.md file. Tolerant of minor formatting differences. */
export function readTaskMd(workspaceRoot: string, taskId: string): TaskDoc {
  const p = taskMdPath(workspaceRoot, taskId);
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
    allowlist: [],
    plan_preview: false,
  };

  let rest = raw;
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    rest = raw.slice(fm[0].length);
    const fmLines = fm[1]!.split("\n");
    // `context`, `tags`, and `allowlist` are all multi-line YAML lists; track which (if
    // any) we're currently accumulating `- item` lines into.
    let inList: "context" | "tags" | "allowlist" | null = null;
    // Parse an inline list `[a, b]` into a clean string array.
    const inline = (val: string): string[] =>
      val.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const line of fmLines) {
      const item = line.match(/^\s*-\s+(.*)$/);
      if (inList && item) {
        const v = item[1]!.trim();
        if (v) (inList === "context" ? meta.context : meta[inList]!).push(v);
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
      else if (key === "kind") meta.kind = val === "rollback" ? "rollback" : "task";
      else if (key === "model") meta.model = val || null;
      else if (key === "plan_preview") meta.plan_preview = val === "true";
      // NOTE: a legacy `stage:` line from the retracted idea→spec→build axis is simply
      // ignored here (the key falls through unrecognized) — task.md files written by the
      // old code parse cleanly under the unified single-status pipeline.
      else if (key === "context" || key === "tags" || key === "allowlist") {
        const target: "context" | "tags" | "allowlist" = key;
        if (val === "") inList = target;
        else if (val === "[]") meta[target] = [];
        // inline list `context: [a, b]` / `tags: [a, b]` / `allowlist: [a, b]` support
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
 * Build the full prompt to hand the agent: the workspace's CTO context, then the
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
export function renderAgentPrompt(workspaceRoot: string, doc: TaskDoc): string {
  const parts: string[] = [];

  // Prepend the workspace's CTO context (best-effort) so every agent starts with
  // it ABOVE the context files, task prompt, and review-handshake instructions.
  const ctoPath = ctoMdPath(workspaceRoot);
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
  //  - a PLAN-PREVIEW task proposes a plan via propose_plan and pauses for approval
  //    BEFORE writing code (it implements on the answer-resume — renderAnswerPrompt);
  //  - an ordinary task (incl. a rollback task) does the work and submits via request_review.
  //
  // NOTE: an `idea`-state task is NEVER rendered here — it has no spec yet and runs no
  // agent; it WAITS for the spec-generation responder to submit a spec (submitSpec). By
  // the time renderAgentPrompt runs, the task has advanced through spec_review to
  // `inactive` ('ready') with the submitted spec as its prompt, so it gets the normal flow.
  parts.push(doc.meta.plan_preview ? PLAN_PREVIEW_PROTOCOL : REVIEW_PROTOCOL);
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
export function renderReworkPrompt(workspaceRoot: string, doc: TaskDoc, reground = ""): string {
  const notes = doc.reviewNotes.trim();
  const body = notes
    ? `Your previous submission was reviewed and changes were requested. Address ` +
      `the following review notes, then call \`request_review\` again.\n\n${notes}`
    : `Changes were requested on your previous submission. Review your work, ` +
      `make the necessary fixes, then call \`request_review\` again.`;
  const focused = [`# Changes requested`, "", body].join("\n");
  // If the task was edited while it was paused, the re-grounding block (the CURRENT
  // prompt + context) leads, so the agent re-grounds before reading the review notes.
  const head = reground.trim() ? reground.trim() + "\n\n---\n\n" : "";
  return head + focused + "\n\n---\n\n" + REVIEW_PROTOCOL;
}

