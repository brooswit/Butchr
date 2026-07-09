// The server-fetch wrapper. Framework-agnostic and DOM-FREE OUTRIGHT: this module imports nothing
// and touches no `document`, so core/state-meta.ts (and core/work-graph.ts beneath it) can be
// imported with no DOM at all.
//
// `toast` / `terminalToast` used to live here and built DOM via `el`, which made `core/` depend on
// `core/dom.js` transitively through state-meta. They moved to components/toast.ts in the RFC
// Phase 2 horizontal split (RFC §0.1 #2, #3). Do not bring a rendering concern back into this file.
//
// NO DATA-FETCHING LIBRARY (RFC §1.2). `react-query`/`swr` would solve a problem butchr does not
// have: a single-operator local tool whose invalidation strategy is "re-render on any SSE event".
// That strategy lives in core/refresh.ts.

/**
 * `T` is what the CALLER claims the endpoint returns. It is unchecked — this is a `fetch` wrapper,
 * not a validator — but naming it at the call site is what lets `tsc` see through to the views.
 * An endpoint with no body (`POST /pause` returning 204) resolves to `null`.
 */
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch("/api" + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(errorOf(data) || res.statusText);
  return data as T;
}

/** The server serializes its errors as `{ error: string }`. Narrowed rather than cast. */
function errorOf(data: unknown): string {
  return data && typeof data === "object" && "error" in data && typeof data.error === "string"
    ? data.error
    : "";
}
