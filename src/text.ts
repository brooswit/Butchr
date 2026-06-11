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
 *
 * GUARD for tiny/non-positive caps (all current callers pass large caps, but this
 * is a shared helper so the edges must be sane):
 *  - `max <= 0` → "" deterministically. A non-positive cap can hold no characters,
 *    so there is nothing to show — and the naive `slice(0, max - 1)` would slice
 *    with a NEGATIVE end (dropping characters off the end / from the front), which
 *    is meaningless here. We return "" rather than "…" because an ellipsis is
 *    itself a character the zero-width cap can't fit.
 *  - `max === 1` → just "…" when truncating (slice end clamped to >= 0), instead of
 *    the old `slice(0, 0)` which already happened to work but only by luck.
 *
 * The common `max >= 2` path is unchanged for ordinary (BMP/ASCII) text. We clip on
 * CODE POINTS via Array.from rather than `String.slice` (which counts UTF-16 code
 * units): a raw slice at the boundary could split an astral char's surrogate pair
 * and leave a lone-surrogate "�". Array.from iterates by code point, so an emoji
 * straddling the cut is dropped whole. For BMP text every code point is one code
 * unit, so this is byte-for-byte the old result.
 */
export function clipLine(s: string, max: number): string {
  const t = collapseWs(s);
  if (max <= 0) return "";
  const chars = Array.from(t); // code points, so a surrogate pair counts as one
  if (chars.length <= max) return t;
  return chars.slice(0, max - 1).join("") + "…";
}
