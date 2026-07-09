// The server-fetch wrapper. Framework-agnostic and DOM-FREE OUTRIGHT: this module imports nothing
// and touches no `document`, so core/state-meta.ts (and core/work-graph.ts beneath it) can be
// imported with no DOM at all. KEEP IT THAT WAY — it is the one core leaf with zero imports.
//
// `toast` / `terminalToast` used to live here and built DOM via `el`, which made `core/` depend on
// `core/dom.js` transitively through state-meta. They moved to components/toast.ts in the RFC
// Phase 2 horizontal split (RFC §0.1 #2, #3). Do not bring a rendering concern back into this file.
//
// NO DATA-FETCHING LIBRARY (RFC §1.2). `react-query`/`swr` would solve a problem butchr does not
// have: a single-operator local tool whose invalidation strategy is "re-render on any SSE event".
//
// >>> IMPORTS SPELL THE `.js` EXTENSION, NOT `.ts`. <<< Throughout `public/`, and it is not a
// leftover. `tsc` rejects a `.ts` import specifier with TS5097 unless `allowImportingTsExtensions`
// is set, and `scripts/ci` typechecks this tree. Bun resolves `./api.js` to `api.ts` at runtime, in
// `bun build`, and in a dynamic `import()`, so a `.js` specifier is the ONE spelling every tool
// here agrees on. It is also what Phase 3 already wrote (state-meta-store.ts, App.tsx).

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

// The message for a failed response, reproducing `(data && data.error) || res.statusText` EXACTLY.
//
// The obvious typed version — `typeof data.error === "string" ? data.error : ""` — is NOT the same
// function. `new Error(x)` stringifies whatever it is given, so a server that answered
// `{"error": 404}` used to throw "404"; narrowing to `string` would silently fall through to
// `res.statusText` instead. Every real error route sends a string, so nothing observable changes
// today — which is precisely why the difference would never be caught. `String(e)` on a truthy
// value keeps the old behaviour and needs no cast.
function errorOf(data: unknown): string {
  if (data && typeof data === "object" && "error" in data) {
    const e = (data as { error: unknown }).error;
    if (e) return String(e);
  }
  return "";
}
