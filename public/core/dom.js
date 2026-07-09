// DOM construction primitives — the node-returning authoring model the RFC unifies on
// (docs/rfc-frontend-design-system.md §2.1, Phase 4, now DELIVERED). DOM-free at module load:
// nothing here touches `document` until a function is CALLED, so this module is safe to import
// from anywhere (including a non-browser test runner).
//
// ESCAPING IS STRUCTURAL, AND THERE IS NO WAY TO OPT OUT. Both el() and svg() append every
// string child through document.createTextNode, so a `<` or `&` in agent-authored text reaches
// the DOM as itself and can never be re-parsed as markup. There is no esc() to call and no
// esc() to forget. The old escape hatches — esc(), el()'s `{html:}` prop, and the transitional
// htmlOf() bridge — are DELETED, not deprecated.
//
// Do not reintroduce them, and do not reach for `node.innerHTML = …` to get around this: that
// is the same hole by another name. Build with el(); to empty a container use replaceChildren().
// test/no-opt-in-escaping.test.ts enforces all of the above across public/**/*.{js,ts,tsx}.

// ---------- tiny helpers ----------
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
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
