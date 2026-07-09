// WHY THIS FILE EXISTS. Deleting it re-opens an XSS-shaped hole. It is not a style rule.
//
// The front end builds DOM one way: React elements. JSX renders a string child through a text node,
// so agent-authored text — task titles, tags, transcript lines, diff bodies — reaches the DOM as
// ITSELF. A `<` or an `&` cannot be re-parsed as markup. Escaping is therefore STRUCTURAL: there is
// nothing to call, and so nothing to forget. That property is what story st-82c11fd1 bought and what
// RFC Phase 4 preserved across the rewrite, and it holds only as long as nothing can opt out of it.
//
// >>> RENAMED FROM test/no-opt-in-escaping.test.ts BY RFC PHASE 4e (RFC §9.5). <<<
// The old file globbed the same tree and banned the VANILLA opt-outs: `esc()`, `htmlOf()`, el()'s
// `{html:}` sugar, and raw `innerHTML` writes. Phase 4e deleted the vanilla front end — `core/dom.js`
// and its `el()` are gone, and `public/` is TypeScript and JSX end to end. Those bans did not become
// wrong; they became insufficient. React re-opens the hole under a longer name, and
// `dangerouslySetInnerHTML` is what this file is now primarily here to keep out.
//
// The opt-outs do NOT all fail the same way, and this file is sized to the difference:
//
//   `dangerouslySetInnerHTML={{__html: agentAuthoredString}}` is `el(tag, {html: …})` with a warning
//   label. It is guarded by NOTHING else: not by the bundler, not by tsc (React types it), not by a
//   runtime warning. It builds clean and ships the hole. It appears the moment somebody wants to
//   render a diff, a brief, or a transcript as markup — which is every view in this app. Tests (b)
//   and (c) are the real guard, and this SILENT SUCCESS is the reason the file is worth its bytes.
//
//   Raw `node.innerHTML = agentAuthoredString` re-opens the same hole under a third name. `{html:}`
//   was never the disease — it was the sugar. Test (d) covers it.
//
//   esc() and htmlOf() were named exports of the deleted core/dom.js, so an IMPORT of either is
//   already a red build. A module that re-DEFINES `function esc(s)` locally imports nothing, builds
//   perfectly, and the opt-in escaping HABIT is back. Only a source-level scan sees that. Test (e).
//
// Every check strips comments FIRST, via Bun.Transpiler. This is load-bearing. Prose in this repo
// discusses esc(), `html:` and `innerHTML` constantly — a raw grep reports hits in EIGHT files under
// public/ where only comments live, and that miscount has produced a wrong answer repeatedly. Do not
// hand-roll a comment stripper with a regex.

import { expect, test } from "bun:test";
import { Glob } from "bun";

const ROOT = new URL("..", import.meta.url).pathname;

// One transpiler per loader: `.tsx` will not parse as `ts`, and neither parses as `js`. The `js`
// entry is kept deliberately — see test (f). If a `.js` file ever comes back, this guard must still
// be able to READ it rather than throw on an unknown loader before it can report anything.
const TRANSPILERS: Record<string, Bun.Transpiler> = {
  js: new Bun.Transpiler({ loader: "js" }),
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};

/**
 * Every public/**\/*.{js,ts,tsx}, with comments removed. Repo-relative path -> stripped source.
 *
 * THE GLOB COVERS ALL THREE EXTENSIONS, AND THAT IS LOAD-BEARING. It matched only `**​/*.js` until
 * RFC Phase 4a, which was already one hole (Phase 3 added `.tsx` this guard never saw) and would
 * have become a second: 4a ported ten modules from `.js` to `.ts`, and a `.js`-only glob would have
 * let every one of them slip out of coverage SILENTLY, still green, still "passing". By Phase 4e a
 * `.js`-only glob would match ZERO FILES and every test below would pass vacuously. That is the rot
 * test (a) exists to catch, and it is why the glob is not narrowed to what happens to exist today.
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

// A path-pinned check that silently matches nothing PASSES VACUOUSLY, and that is exactly how a guard
// rots. It has already happened once in this repo. Fail loudly instead.
//
// The floor is 20, not 1: a glob that resolved to a single stray file would satisfy `> 0` while
// covering none of the views this guard is for. public/ holds 30 modules at Phase 4e.
test("(a) the guard actually sees the front-end tree", () => {
  expect(
    sources.length,
    "the public/ glob matched (almost) nothing — every test in this file was passing vacuously",
  ).toBeGreaterThan(20);
});

// (b) THE REAL GUARD. React's spelling of the hole, banned by name. Deliberately blanket: no
// call-graph analysis, and no "only when the value is dynamic" carve-out. Both would have to stay
// honest across every future refactor, and neither is trivially true the way this is. Zero offenders
// today.
//
// If a LEGITIMATE use ever arrives — rendering trusted, developer-authored markup — narrow this check
// DELIBERATELY, with the sanitizer named in the diff. Do not delete it.
test("(b) no `dangerouslySetInnerHTML` under public/ — React's spelling of opt-in escaping", () => {
  const offenders = sources.filter(({ src }) => /\bdangerouslySetInnerHTML\b/.test(src)).map(({ file }) => file);
  expect(
    offenders,
    "dangerouslySetInnerHTML re-introduces opt-in escaping (story st-82c11fd1 deleted it in every other spelling). Render the value as a JSX text child — it is escaped structurally — or build the nodes explicitly.",
  ).toEqual([]);
});

// (c) THE PAYLOAD, not the prop. `dangerouslySetInnerHTML` takes `{__html: string}`, and that object
// can be built somewhere the prop name never appears:
//
//     const body = { __html: task.brief };                    // <- (b) does not match this line
//     return createElement("div", { dangerouslySetInnerHTML: body });
//
// (b) still catches the second line, so this is defense in depth rather than a separate hole. What it
// adds is the FIRST line — where the agent-authored string actually gets adopted — and a
// `createElement(tag, props)` whose props object is assembled dynamically and never spells the prop
// out at all. `__html` has exactly one meaning in React. There is no legitimate use of it here.
test("(c) no `__html` property key under public/ — the dangerouslySetInnerHTML payload", () => {
  const offenders = sources.filter(({ src }) => /(?:^|[{,(\s])__html\s*:/m.test(src)).map(({ file }) => file);
  expect(
    offenders,
    "`__html` is the payload dangerouslySetInnerHTML takes, and it has no other meaning. Build the content as JSX — its string children are escaped structurally.",
  ).toEqual([]);
});

// (d) `{html:}` was the SUGAR; `innerHTML =` is the substance, and it survives the framework change
// untouched. Ban every write except a bare CLEAR, which escapes nothing and cannot inject.
//
// Zero of BOTH exist today. The vanilla repaint-clears this rule used to permit (core/nav.js,
// views/swimlanes.js, components/overlay.js) went with their files — React owns the DOM now, and
// clearing a container by hand would fight the reconciler. The `= ""` carve-out is kept anyway: it is
// the safe form, and a rule that bans the safe form invites someone to weaken the rule.
//
// Reads (`return box.innerHTML`) and comparisons (`=== ""`) are untouched — the `(?!=)` lookahead
// excludes `==`/`===`. That matters, and not hypothetically: the React view tests assert on
// `container.innerHTML`, and this guard would be wrong to care.
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
  expect(
    offenders,
    "A raw innerHTML write re-opens the hole dangerouslySetInnerHTML is named after. Render the content as JSX (its string children reach the DOM through text nodes); to empty a container, render null.",
  ).toEqual([]);
});

// (e) THE HABIT, not just the hole. A hand-rolled esc() imports nothing, so the build is perfectly
// happy and tsc is happy — and opt-in escaping is back. It is also a tell: nobody writes an escaper
// unless they are about to build a string and inject it. This is what makes the property STRUCTURAL
// rather than merely currently-true.
test("(e) no calls to esc() or htmlOf() — including locally re-defined ones the build would allow", () => {
  const offenders = sources
    .filter(({ src }) => /\besc\s*\(/.test(src) || /\bhtmlOf\s*\(/.test(src))
    .map(({ file }) => file);
  expect(
    offenders,
    "esc()/htmlOf() are deleted. Escaping is structural: JSX renders a string child as a text node. A hand-rolled re-definition re-introduces opt-in escaping.",
  ).toEqual([]);
});

// (f) THE END STATE, pinned at the source. RFC Phase 4e deleted the last vanilla module from public/;
// the tree is TypeScript and JSX end to end. This is the analogue of the old test (c), which asserted
// that core/dom.js exported neither esc nor htmlOf: it makes a well-meaning revert of the vanilla
// front end trip HERE, loudly, rather than sail past (b)–(e) by having no callers yet.
//
// It is also what keeps test (a)'s floor honest. `el()` shipped in the production bundle long after
// every route was React, through a single surviving import in components/toast.ts — "no vanilla
// routes" and "no vanilla code" are different claims, and only the second one is safe to rely on.
test("(f) public/ is TypeScript and JSX — the vanilla front end stays deleted", () => {
  const js = sources.filter(({ file }) => file.endsWith(".js")).map(({ file }) => file);
  expect(
    js,
    "a .js module reappeared under public/. RFC Phase 4e deleted the vanilla front end (bridge.tsx, core/nav.js, core/dom.js, ui-state.js, and every vanilla view/component). Write it as .ts or .tsx.",
  ).toEqual([]);
});
