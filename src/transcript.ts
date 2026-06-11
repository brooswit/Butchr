// Human-readable transcript extracted from a Claude Code session JSONL, so the
// webapp can surface what an agent actually did for a task WITHOUT attaching to
// herdr (the live pane is gone the moment the agent exits — see usage.ts for the
// transcript-location contract this reuses).
//
// Claude Code writes one JSONL line per frame to
//   ~/.claude/projects/<munged-cwd>/<session-id>.jsonl
// Most frames are internal bookkeeping (mode/permission-mode/file-history-snapshot/
// ai-title/last-prompt/attachment); the conversation itself lives on `user` and
// `assistant` frames whose `message.content` is either a plain string or an array
// of typed blocks (text / thinking / tool_use / tool_result). We flatten those into
// an ordered list of TranscriptItems — one per block, role-labelled, with long
// bodies truncated — and skip everything else as noise.
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { clipLine } from "./text.ts";
import { findTranscript } from "./usage.ts";

/** One renderable line of an agent transcript (one content block, in order). */
export type TranscriptItem = {
  /** Which side of the conversation produced this block. */
  role: "user" | "assistant";
  /**
   * What this block is:
   *  - "text"        → prose from the user or assistant
   *  - "thinking"    → the assistant's extended-thinking block
   *  - "tool_use"    → the assistant invoking a tool (see `tool` + `args`)
   *  - "tool_result" → the result fed back for a prior tool_use (in `text`)
   */
  kind: "text" | "thinking" | "tool_use" | "tool_result";
  /** ISO timestamp of the owning frame, or null if the frame carried none. */
  ts: string | null;
  /** Prose / thinking text, or the (truncated) tool-result body. */
  text?: string;
  /** For kind="tool_use": the tool name (e.g. "Read", "Bash"). */
  tool?: string;
  /** For kind="tool_use": a brief one-line summary of the tool input. */
  args?: string;
  /** True when `text` was clipped to the cap (the UI shows a "truncated" hint). */
  truncated?: boolean;
};

// Per-block size caps. Tool results dump whole files and command output, so they
// get the tightest clip; prose/thinking are usually short but can run long on a
// big plan, so they get more headroom. Both keep a single transcript response from
// ballooning regardless of how large the underlying session got.
const RESULT_CAP = 2000;
const TEXT_CAP = 8000;
// Brief-args caps: keep a tool_use line scannable (one short line per arg, capped
// total) rather than echoing a whole multi-KB Write `content` or Edit `new_string`.
const ARG_VALUE_CAP = 80;
const ARGS_TOTAL_CAP = 300;

function clamp(s: string, max: number): { text: string; truncated: boolean } {
  return s.length <= max ? { text: s, truncated: false } : { text: s.slice(0, max), truncated: true };
}

/** Collapse whitespace and clip a single arg value so the summary stays one line. */
function briefValue(v: unknown): string | null {
  let val: string;
  if (typeof v === "string") val = v;
  else if (typeof v === "number" || typeof v === "boolean") val = String(v);
  else if (Array.isArray(v)) val = `[${v.length}]`;
  else if (v && typeof v === "object") val = "{…}";
  else return null; // null / undefined — omit
  return clipLine(val, ARG_VALUE_CAP);
}

/** One-line `key=value, …` summary of a tool_use input, capped for readability. */
function briefArgs(input: unknown): string {
  if (input == null) return "";
  if (typeof input !== "object" || Array.isArray(input)) {
    return briefValue(input) ?? "";
  }
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const val = briefValue(v);
    if (val === null) continue;
    parts.push(`${k}=${val}`);
  }
  return clamp(parts.join(", "), ARGS_TOTAL_CAP).text;
}

/**
 * Flatten a tool_result `content` (a string, or an array of {type:"text",text}/
 * image/other blocks) into plain text. Non-text blocks are reduced to a `[type]`
 * marker so an image result still reads as something rather than vanishing.
 */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (typeof b === "string") return b;
      if (b && typeof b === "object") {
        const o = b as { type?: unknown; text?: unknown };
        if (o.type === "text") return String(o.text ?? "");
        return `[${typeof o.type === "string" ? o.type : "block"}]`;
      }
      return "";
    })
    .join("\n");
}

/**
 * Parse a session JSONL into an ordered list of transcript items. Tolerant of a
 * truncated/partial final line (a live session is still being written) and of any
 * unexpected frame shape — anything it can't read is skipped, never thrown.
 *
 * Duplicate-safe like parseTranscriptUsage: a streamed turn can be re-logged on
 * resume, so we dedupe whole frames by the assistant message id (or the frame
 * uuid for user frames) and emit each frame's blocks exactly once.
 */
export function parseTranscript(text: string): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const seen = new Set<string>();

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o: { type?: string; uuid?: unknown; timestamp?: unknown; message?: Record<string, unknown> };
    try {
      o = JSON.parse(line);
    } catch {
      continue; // tolerate a partial final line / non-JSON noise
    }
    const role = o.type;
    if (role !== "user" && role !== "assistant") continue; // skip internal frames
    const msg = o.message;
    if (!msg || typeof msg !== "object") continue;

    // Dedupe re-logged frames: assistant turns by message id, user frames by uuid.
    const m = msg as { id?: unknown; content?: unknown };
    const key =
      typeof m.id === "string" ? `m:${m.id}` : typeof o.uuid === "string" ? `u:${o.uuid}` : null;
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }

    const ts = typeof o.timestamp === "string" ? o.timestamp : null;
    const content = m.content;

    // A bare string is plain prose for this role.
    if (typeof content === "string") {
      const c = clamp(content, TEXT_CAP);
      if (c.text.trim()) {
        items.push({ role, kind: "text", ts, text: c.text, truncated: c.truncated || undefined });
      }
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as {
        type?: unknown;
        text?: unknown;
        thinking?: unknown;
        name?: unknown;
        input?: unknown;
        content?: unknown;
      };
      switch (b.type) {
        case "text": {
          const c = clamp(String(b.text ?? ""), TEXT_CAP);
          if (c.text.trim()) {
            items.push({ role, kind: "text", ts, text: c.text, truncated: c.truncated || undefined });
          }
          break;
        }
        case "thinking": {
          const c = clamp(String(b.thinking ?? ""), TEXT_CAP);
          if (c.text.trim()) {
            items.push({ role, kind: "thinking", ts, text: c.text, truncated: c.truncated || undefined });
          }
          break;
        }
        case "tool_use": {
          items.push({
            role,
            kind: "tool_use",
            ts,
            tool: typeof b.name === "string" && b.name ? b.name : "tool",
            args: briefArgs(b.input),
          });
          break;
        }
        case "tool_result": {
          const c = clamp(resultText(b.content), RESULT_CAP);
          items.push({ role, kind: "tool_result", ts, text: c.text, truncated: c.truncated || undefined });
          break;
        }
        default:
          break; // image / unknown block — skip
      }
    }
  }
  return items;
}

/**
 * Read and parse a session's transcript from disk. Best-effort: returns an empty
 * list when the session id is empty, the transcript can't be found/read, or it
 * holds no renderable turns — callers treat that as "no transcript available".
 */
export function readSessionTranscript(cwd: string, sessionId: string): TranscriptItem[] {
  if (!sessionId) return [];
  const p = findTranscript(cwd, sessionId);
  if (!p) return [];
  try {
    return parseTranscript(readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}

// --- LIVE ACTIVITY PULSE ----------------------------------------------------
//
// A read-only one-line "what is the agent doing right now" signal for a RUNNING
// task's card in the webapp, WITHOUT attaching to herdr. Derived from the SAME
// transcript the viewer parses, but cheap to poll: we read only the TAIL of the
// JSONL (the latest frames) rather than re-parsing the whole — possibly huge —
// session file on every poll.

/** The latest meaningful agent action from a session transcript (for the pulse). */
export type SessionActivity = {
  /** A short label for the most recent meaningful step (null if none found). */
  lastAction: string | null;
  /** ISO timestamp of that step's frame, or null. */
  lastAt: string | null;
};

// How much of the transcript tail to read for the pulse. A single tool_result
// frame (e.g. a whole-file Read) can be large, so keep enough headroom that the
// most recent tool_use/text frame is virtually always within the window — while
// still reading a fixed, small slice instead of the entire session each poll.
const ACTIVITY_TAIL_BYTES = 128 * 1024;
// Cap for an action label so a long prose step stays one scannable line.
const ACTION_CAP = 120;

/** Read up to the last `maxBytes` of a file as UTF-8 (whole file if smaller). */
function readFileTail(path: string, maxBytes: number): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    if (len <= 0) return "";
    const buf = Buffer.allocUnsafe(len);
    const read = readSync(fd, buf, 0, len, start);
    return buf.toString("utf8", 0, read);
  } finally {
    closeSync(fd);
  }
}

/** The first arg VALUE from a brief `key=value, …` args summary (its target). */
function primaryArg(args?: string): string | null {
  if (!args) return null;
  const first = args.split(", ")[0] ?? "";
  const eq = first.indexOf("=");
  const val = (eq >= 0 ? first.slice(eq + 1) : first).trim();
  return val || null;
}

/** Collapse to a single clipped line, or null if blank. */
function oneLine(text: string | undefined, cap: number): string | null {
  // clipLine collapses + clips; "" (blank input) is falsy → null, as before.
  return clipLine(text ?? "", cap) || null;
}

/**
 * Describe a transcript item as a pulse label, or null if it isn't a meaningful
 * AGENT action (a tool_result is a response, not an action; user prose isn't the
 * agent acting). A tool_use becomes "Read /x/y.ts"; assistant prose its first
 * line; thinking a neutral "thinking…".
 */
function describeActivity(it: TranscriptItem): string | null {
  switch (it.kind) {
    case "tool_use": {
      const tool = it.tool || "tool";
      const target = primaryArg(it.args);
      return target ? oneLine(`${tool} ${target}`, ACTION_CAP) : tool;
    }
    case "text":
      return it.role === "assistant" ? oneLine(it.text, ACTION_CAP) : null;
    case "thinking":
      return "thinking…";
    default:
      return null; // tool_result / anything else — not an action
  }
}

/**
 * The latest meaningful agent action in an ordered transcript: scan from the END
 * and return the first item that describes an action (skipping tool_results and
 * user prose). Returns nulls when nothing qualifies.
 */
export function extractActivity(items: TranscriptItem[]): SessionActivity {
  for (let i = items.length - 1; i >= 0; i--) {
    const action = describeActivity(items[i]!);
    if (action) return { lastAction: action, lastAt: items[i]!.ts ?? null };
  }
  return { lastAction: null, lastAt: null };
}

/** Extract the latest activity from a (possibly tail-only) transcript text. */
export function parseTranscriptActivity(text: string): SessionActivity {
  return extractActivity(parseTranscript(text));
}

/**
 * Cheap live-activity read for a session: locate the transcript, read only its
 * TAIL, and extract the latest meaningful action. Best-effort — returns nulls
 * when the session id is empty or the transcript can't be located/read.
 */
export function readSessionActivity(cwd: string, sessionId: string): SessionActivity {
  if (!sessionId) return { lastAction: null, lastAt: null };
  const p = findTranscript(cwd, sessionId);
  if (!p) return { lastAction: null, lastAt: null };
  try {
    return parseTranscriptActivity(readFileTail(p, ACTIVITY_TAIL_BYTES));
  } catch {
    return { lastAction: null, lastAt: null };
  }
}
