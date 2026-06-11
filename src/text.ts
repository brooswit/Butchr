// Shared one-line text helpers. Pure, dependency-free string transforms reused
// wherever butchr renders a free-form field as a single scannable line: the channel
// notification (src/channel.ts), the transcript summarizer (src/transcript.ts), and
// the changelog bookkeeping (src/changelog.ts).

/** Collapse every run of whitespace to a single space and trim the ends. */
export function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Collapse whitespace (see collapseWs) and clip to at most `max` characters,
 * replacing the last kept character with an ellipsis when the text is truncated.
 */
export function clipLine(s: string, max: number): string {
  const t = collapseWs(s);
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
