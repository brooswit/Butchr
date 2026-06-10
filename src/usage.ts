// Per-task token usage, read back from the Claude Code session transcript.
//
// Claude Code writes a JSONL transcript for every session at
//   ~/.claude/projects/<munged-cwd>/<session-id>.jsonl
// where <munged-cwd> is the agent's working directory with every non-alphanumeric
// character replaced by '-'. Each `assistant` line carries `message.usage` (the
// per-turn token counts) and `message.model` (the model that turn ran under).
// butchr already knows a task's session id (it assigns `--session-id`) and its
// worktree cwd, so it can locate the transcript and sum the usage across turns.
//
// The transcript records token USAGE but NOT a dollar cost — there is no `costUSD`
// field — so we deliberately do not compute or fabricate a cost here (see the
// `cost_usd` column TODO in db.ts). We surface what IS available: tokens + model.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Cumulative token usage for a session, plus the model the agent ran under. */
export type SessionUsage = {
  /** The model from the LAST assistant turn in the transcript (null if none). */
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

/**
 * Root directory where Claude Code stores per-project session transcripts. Honors
 * Claude Code's own `CLAUDE_CONFIG_DIR` override (users who relocate `~/.claude`)
 * and falls back to `~/.claude` otherwise; the transcripts live under `projects/`.
 */
function projectsRoot(): string {
  const base = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  return join(base, "projects");
}

/**
 * Reproduce Claude Code's cwd→folder munging: every character that is not an
 * ASCII letter or digit becomes '-'. (e.g. `/home/u/Code/x.y` → `-home-u-Code-x-y`).
 */
export function mungeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Locate a session's transcript JSONL from its cwd + session id. Tries the munged
 * path first (the fast, exact case); if that misses, scans the project dirs for a
 * `<sessionId>.jsonl` (robust to any munging quirk, since session ids are unique
 * UUIDs). Returns null if nothing matches.
 */
export function findTranscript(cwd: string, sessionId: string): string | null {
  if (!sessionId) return null;
  const root = projectsRoot();
  const direct = join(root, mungeCwd(cwd), `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null; // no projects dir yet
  }
  for (const d of dirs) {
    const p = join(root, d, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Sum token usage across the `assistant` turns of a transcript and capture the
 * model. Returns null if the transcript carries no assistant turns at all.
 *
 * Duplicate-safe: a transcript can repeat an assistant message (e.g. a streamed
 * turn re-logged on resume), so we dedupe by the assistant message id and count
 * each turn's usage exactly once. A turn with no id still counts (best effort).
 */
export function parseTranscriptUsage(text: string): SessionUsage | null {
  let model: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let any = false;
  const seen = new Set<string>();

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o: { type?: string; message?: Record<string, unknown> };
    try {
      o = JSON.parse(line);
    } catch {
      continue; // tolerate a truncated/partial final line
    }
    if (o.type !== "assistant" || !o.message || typeof o.message !== "object") continue;
    const m = o.message as { id?: unknown; model?: unknown; usage?: Record<string, unknown> };

    if (typeof m.id === "string") {
      if (seen.has(m.id)) continue; // already counted this turn
      seen.add(m.id);
    }
    if (typeof m.model === "string" && m.model && m.model !== "<synthetic>") {
      model = m.model;
    }
    const u = m.usage;
    if (!u || typeof u !== "object") continue;
    any = true;
    inputTokens += numField(u.input_tokens);
    outputTokens += numField(u.output_tokens);
    cacheReadTokens += numField(u.cache_read_input_tokens);
    cacheCreationTokens += numField(u.cache_creation_input_tokens);
  }

  if (!any && model === null) return null;
  return { model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
}

/** Coerce a transcript usage field to a finite non-negative number (else 0). */
function numField(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Read and aggregate a session's token usage from disk. Returns null when the
 * session id is empty, the transcript can't be found/read, or it has no usable
 * turns — callers leave the stored usage untouched in that case.
 */
export function readSessionUsage(cwd: string, sessionId: string): SessionUsage | null {
  const p = findTranscript(cwd, sessionId);
  if (!p) return null;
  try {
    return parseTranscriptUsage(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
