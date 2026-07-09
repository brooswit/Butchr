// WHY THIS FILE EXISTS. Deleting it re-opens an XSS-shaped hole. It is not a style rule.
//
// The front end builds DOM one way: core/dom.js's el()/svg(). Both append every string child
// through document.createTextNode, so agent-authored text — task titles, tags, transcript lines,
// diff bodies — reaches the DOM as ITSELF. A `<` or a `&` cannot be re-parsed as markup. Escaping
// is therefore STRUCTURAL: there is no esc() to call, and so no esc() to forget. That property is
// what RFC Phase 4 bought (docs/rfc-frontend-design-system.md §5), and it holds only as long as
// nothing can opt out of it.
//
// Three opt-outs used to exist. They are deleted. They do NOT all fail the same way if they come
// back, and this file is sized to the difference:
//
//   esc() and htmlOf() were NAMED EXPORTS of core/dom.js. A surviving importer already fails the
//   existing gate LOUDLY and for free: `bun build public/app.js --target browser` (scripts/ci, fe
//   rule 1) reports `No matching export in "dom.js" for import "esc"`, and the per-file pass (fe
//   rule 2) catches an orphan module the entry graph never reaches. Assertion (b) below is NOT
//   duplicating that check — see its own comment for the narrow gap it covers.
//
//   `{html:}` — el()'s sugar for innerHTML — is the dangerous one, and it is guarded by NOTHING
//   else. It is a PROPERTY KEY, not an import. With the branch gone, `el("div", {html:"<b>x</b>"})`
//   throws nothing, builds clean, and type-checks (there are no types). el() simply falls through
//   to setAttribute("html", "<b>x</b>") and emits `<div html="<b>x</b>"></div>`. The markup SILENTLY
//   STOPS RENDERING. No build error, no runtime error, no browser warning. Assertion (a) is the
//   real guard here, and this silent failure mode is the reason the file is worth its bytes.
//
//   Raw `node.innerHTML = agentAuthoredString` re-opens the same hole under a different name.
//   `{html:}` was never the disease — it was the sugar. Deleting the branch while leaving raw
//   writes unpoliced would move the footgun, not remove it (views/task.js alone carried thirteen
//   raw innerHTML templates before this story). Assertion (d) covers it.
//
// Every check strips comments FIRST, via Bun.Transpiler. This is load-bearing. Prose in this repo
// discusses esc(), htmlOf() and `html:` constantly — a raw grep reports hits in SEVEN files under
// public/ where only comments live, and that miscount has produced a wrong answer repeatedly. Do
// not hand-roll a comment stripper with a regex.

import { expect, test } from "bun:test";
import { Glob } from "bun";

const ROOT = new URL("..", import.meta.url).pathname;

// One transpiler per loader: `.tsx` will not parse as `js`, and `.ts` will not parse as `js` once a
// type annotation appears. All three exist under public/ from RFC Phase 4a onward.
const TRANSPILERS: Record<string, Bun.Transpiler> = {
  js: new Bun.Transpiler({ loader: "js" }),
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};

/**
 * Every public/**\/*.{js,ts,tsx}, with comments removed. Repo-relative path -> stripped source.
 *
 * THE GLOB COVERS `.ts`/`.tsx`, NOT JUST `.js`, AND THAT IS LOAD-BEARING. It matched only `**​/*.js`
 * until RFC Phase 4a, which was already one hole (Phase 3 added `.tsx` this guard never saw) and
 * would have become a second: 4a ports ten modules from `.js` to `.ts`, and a `.js`-only glob would
 * have let every one of them slip out of coverage SILENTLY, still green, still "passing". That is
 * precisely the vacuous-guard rot the next test exists to catch, arriving through the back door.
 *
 * React re-opens the hole under a new name: `dangerouslySetInnerHTML` is `{html:}` with a longer
 * spelling, and test (a)'s blanket `html:` ban does not match it. Test (e) bans it by name.
 */
const sources: Array<{ file: string; src: string }> = [...new Glob("**/*.{js,ts,tsx}").scanSync(`${ROOT}public`)]
  .sort()
  .map((rel) => {
    const file = `public/${rel}`;
    const raw = require("node:fs").readFileSync(`${ROOT}${file}`, "utf8");
    const ext = rel.slice(rel.lastIndexOf(".") + 1);
    const transpiler = TRANSPILERS[ext];
    if (!transpiler) throw new Error(`no transpiler for ${file} — extend TRANSPILERS`);
    return { file, src: transpiler.transformSync(raw) };
  });

// A path-pinned check that silently matches nothing PASSES VACUOUSLY, and that is exactly how a
// guard rots. It has already happened once in this repo. Fail loudly instead.
test("the guard actually sees the front-end tree", () => {
  expect(sources.length).toBeGreaterThan(0);
});

// (a) THE REAL GUARD. Deliberately broader than "an `html:` key inside an el()/svg() call": a
// blanket ban needs no call-graph analysis to stay honest, and it is trivially true today. If a
// LEGITIMATE, unrelated `{html: …}` object ever needs to exist, narrow this check deliberately —
// do not delete it. What must never come back is `el(tag, {html: …})`, which silently degrades to
// setAttribute("html", …) and renders nothing.
test("(a) no `html:` property key anywhere under public/ — el()'s innerHTML sugar stays dead", () => {
  const offenders = sources
    .filter(({ src }) => /(?:^|[{,(\s])html\s*:/m.test(src))
    .map(({ file }) => file);
  expect(offenders, "`html:` is el()'s deleted innerHTML escape hatch. el() now falls through to setAttribute(\"html\", …) and the markup silently stops rendering. Build the content with el() instead.").toEqual([]);
});

// (b) DEFENSE IN DEPTH, not a duplicate of the build's export check. The bundler can only catch an
// IMPORT of a symbol dom.js no longer exports. A module that re-DEFINES `function esc(s)` locally,
// or assigns one to a const, imports nothing — the build is perfectly happy, and the opt-in
// escaping habit is back. Only a source-level scan sees that.
test("(b) no calls to esc() or htmlOf() — including locally re-defined ones the build would allow", () => {
  const offenders = sources
    .filter(({ src }) => /\besc\s*\(/.test(src) || /\bhtmlOf\s*\(/.test(src))
    .map(({ file }) => file);
  expect(offenders, "esc()/htmlOf() are deleted. Escaping is structural via el() + createTextNode; a hand-rolled re-definition re-introduces opt-in escaping.").toEqual([]);
});

// (c) The deletions themselves, asserted at the source. Pins the end state so a well-meaning revert
// of core/dom.js trips here rather than passing (a)/(b) by having no callers yet.
test("(c) core/dom.js exports neither esc nor htmlOf, and el() has no `html` branch", () => {
  const dom = sources.find(({ file }) => file === "public/core/dom.js");
  expect(dom, "public/core/dom.js not found").toBeDefined();
  const src = dom!.src;
  expect(/export\s+function\s+esc\b/.test(src), "esc must not be exported").toBe(false);
  expect(/export\s+function\s+htmlOf\b/.test(src), "htmlOf must not be exported").toBe(false);
  expect(/\bhtmlOf\b/.test(src), "htmlOf must be gone entirely").toBe(false);
  // el()'s attr loop must not special-case an "html" key any more.
  expect(/===?\s*["']html["']/.test(src), "el() must have no `html` branch").toBe(false);
  expect(/\.innerHTML\s*=(?!=)/.test(src), "core/dom.js must not write innerHTML").toBe(false);
});

// (d) `{html:}` was the SUGAR; `innerHTML =` is the substance. Ban every write except a bare CLEAR,
// which escapes nothing and cannot inject: three legitimate ones exist (core/nav.js,
// views/swimlanes.js, components/overlay.js) as repaint clears. Reads (`return box.innerHTML`) and
// comparisons (`=== ""`) are untouched — the `(?!=)` lookahead excludes `==`/`===`.
test("(d) no raw `innerHTML =` writes under public/ except a bare clear", () => {
  const offenders: string[] = [];
  for (const { file, src } of sources) {
    for (const m of src.matchAll(/\.innerHTML\s*=(?!=)/g)) {
      const rest = src.slice(m.index! + m[0].length);
      // Bun.Transpiler normalizes '' -> "" and always emits the terminating `;`, so requiring one
      // keeps `= "" + userInput` from slipping through as a "clear".
      if (/^\s*(""|'')\s*;/.test(rest)) continue;
      const line = src.slice(0, m.index!).split("\n").length;
      offenders.push(`${file}:${line}`);
    }
  }
  expect(offenders, "A raw innerHTML write re-opens the hole `{html:}` used to be. Build the content with el() (its text children are escaped via createTextNode); to empty a container use replaceChildren(), or the bare `innerHTML = \"\"` clear.").toEqual([]);
});

// (e) THE REACT-SHAPED HOLE. `dangerouslySetInnerHTML={{__html: …}}` is exactly `el(tag, {html: …})`
// with a longer name and a warning label, and NONE of (a)–(d) catches it: it is not an `html:` key,
// not an `esc()` call, and not a `.innerHTML =` write. It appears the moment somebody wants to
// render a diff, a brief, or a transcript as markup — which is every view Phases 4b–4d migrate.
//
// Escaping stays STRUCTURAL under React for the same reason it is structural under el(): JSX renders
// a string child as a text node, so a `<` or `&` in agent-authored text reaches the DOM as itself.
// There is nothing to opt into, and this is what keeps it that way. Zero offenders today.
test("(e) no `dangerouslySetInnerHTML` under public/ — React's spelling of the same hole", () => {
  const offenders = sources
    .filter(({ src }) => /\bdangerouslySetInnerHTML\b/.test(src))
    .map(({ file }) => file);
  expect(offenders, "dangerouslySetInnerHTML re-introduces opt-in escaping (story st-82c11fd1 deleted it in every other spelling). Render the value as a JSX text child — it is escaped structurally — or build the nodes explicitly.").toEqual([]);
});
