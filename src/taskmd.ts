// task.md is the on-disk source of truth for a task: prompt, metadata, and the
// running log of rejection notes. Lives at
//   <directory-root>/.butchr/tasks/<task-id>/task.md
//
// We deliberately hand-roll a tiny YAML reader/writer for the front matter
// (zero dependencies). The shape is fixed and simple, so this is safe.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskStatus } from "./db.ts";

export type TaskMeta = {
  id: string;
  created: string;
  status: TaskStatus;
  context: string[];
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

/** Absolute path to a task's directory under .butchr/tasks/. */
export function taskDir(directoryRoot: string, taskId: string): string {
  return join(directoryRoot, ".butchr", "tasks", taskId);
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
 * Build the full prompt to hand the agent: the contents of each context file
 * (resolved relative to the directory root) prepended to the task prompt.
 */
export function renderAgentPrompt(directoryRoot: string, doc: TaskDoc): string {
  const parts: string[] = [];
  for (const rel of doc.meta.context) {
    const abs = join(directoryRoot, rel);
    if (existsSync(abs)) {
      try {
        const contents = readFileSync(abs, "utf8");
        parts.push(`# Context: ${rel}\n\n\`\`\`\n${contents}\n\`\`\``);
      } catch {
        // ignore unreadable context file
      }
    }
  }
  let body = doc.prompt;
  if (doc.reviewNotes) {
    body += `\n\n# Review notes from previous attempts\n\n${doc.reviewNotes}\n\nAddress the review notes above in this attempt.`;
  }
  parts.push(body);
  return parts.join("\n\n---\n\n");
}

/** Ensure a parent directory exists for a given file path. */
export function ensureParent(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}
