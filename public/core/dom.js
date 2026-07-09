// DOM construction primitives — the node-returning authoring model the RFC unifies on
// (docs/rfc-frontend-design-system.md §2.1). DOM-free at module load: nothing here touches
// `document` until a function is CALLED, so this module is safe to import from anywhere
// (including a non-browser test runner).

// ---------- tiny helpers ----------
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function")
      node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}
// SVG sibling of el(): builds nodes in the SVG namespace so <svg>, <path>, <rect>,
// <text> etc. render correctly (createElement would put them in the HTML namespace
// and they'd be inert). Same attr/children contract as el().
export const SVG_NS = "http://www.w3.org/2000/svg";
export function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.setAttribute("class", v);
    else if (k.startsWith("on") && typeof v === "function")
      node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

// ⚠ TRANSITIONAL — SCHEDULED FOR DELETION. Serializes a node (or DocumentFragment) to an HTML
// string, so a caller that is STILL an innerHTML template literal can consume a component that
// has already been converted to return a NODE. It exists only to let Phase 4 of the RFC convert
// components innermost-first without rewriting every call site in the same commit
// (docs/rfc-frontend-design-system.md §5, "Phase 4"). The FINAL subtask of this story deletes
// `htmlOf`, `esc`, and el()'s `html:` branch together, once all three hit zero callers. Do not
// add a NEW caller — convert the call site to append the node instead.
//
// It DROPS EVENT LISTENERS: addEventListener registrations don't survive serialization, so this
// is only ever valid for listener-free PRESENTATIONAL nodes (which every chip is).
//
// Note on "byte-identical": the guarantee is the rendered DOM, not the serialized bytes. esc()
// escapes an apostrophe to `&#39;`, whereas the innerHTML serializer leaves `'` literal — so a
// free-form string (e.g. a tag containing an apostrophe) serializes to different BYTES through
// htmlOf while producing an IDENTICAL DOM. That difference is expected. Do not chase it.
export function htmlOf(node) {
  const box = document.createElement("div");
  box.appendChild(node);
  return box.innerHTML;
}
