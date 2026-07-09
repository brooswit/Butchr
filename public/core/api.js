// The server-fetch wrapper. Framework-agnostic and DOM-FREE OUTRIGHT: this module imports nothing
// and touches no `document`, so core/state-meta.js (and core/work-graph.js beneath it) can be
// imported with no DOM at all.
//
// `toast` / `terminalToast` used to live here and built DOM via `el`, which made `core/` depend on
// `core/dom.js` transitively through state-meta.js. They moved to components/toast.js in the RFC
// Phase 2 horizontal split (RFC §0.1 #2, #3). Do not bring a DOM builder back into this file.

export async function api(method, path, body) {
  const res = await fetch("/api" + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error((data && data.error) || res.statusText);
  return data;
}
