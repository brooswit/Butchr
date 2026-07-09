// Tests for scripts/assert-fe-artifact and scripts/inline-sprite.
//
// WHY THIS FILE EXISTS. The three assertions in scripts/assert-fe-artifact are the ENTIRE defence
// against the three ways this front end ships broken while the build exits 0: unstyled (no token
// CSS), every icon blank (no inlined sprite), and React's 1.61 MB development bundle
// (--production dropped). None of those is visible to a build, a typecheck, or a layout test.
//
// An assertion nobody exercises rots into a comment. Each test below BREAKS one artifact and
// requires the script to go red — and one requires it to stay green, so a script that simply
// `exit 1`s unconditionally cannot pass this file.
//
// These run against synthetic fixture directories, not against dist/, so they are fast and do not
// depend on a build having happened. `assert-fe-artifact dist` is separately exercised for real by
// scripts/ci on every run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO_ROOT = dirname(import.meta.dir);
const ASSERT = join(REPO_ROOT, "scripts", "assert-fe-artifact");
const INLINE_SPRITE = join(REPO_ROOT, "scripts", "inline-sprite");

let TMP: string;

/** A CSS body carrying `n` distinct `--lp-*` definitions, mimicking the tokens stylesheets. */
function tokenCss(n: number): string {
  const decls = Array.from({ length: n }, (_, i) => `  --lp-color-token-${i}: #00${i % 10};`);
  return `:root {\n${decls.join("\n")}\n}\n`;
}

const SPRITE =
  '<svg aria-hidden="true" style="display:none"><defs>' +
  '<symbol id="lp-icon-edit" viewBox="0 0 20 20"></symbol></defs></svg>\n';

/** A dist-like index.html: relative hashed asset refs, exactly as bun's HTML entry mode emits. */
function html(cssName: string, jsName: string, sprite: boolean): string {
  return (
    `<!DOCTYPE html><html><head><link rel="stylesheet" href="./${cssName}" /></head><body>\n` +
    (sprite ? SPRITE : "") +
    `<main id="app"></main><script type="module" src="./${jsName}"></script></body></html>`
  );
}

/**
 * Write a dist-like fixture. Defaults are the HEALTHY artifact; each option degrades exactly one
 * of the three silent-failure modes, so a red result names its cause unambiguously.
 */
function fixture(
  name: string,
  opts: {
    tokenDefs?: number;
    sprite?: boolean;
    devReact?: boolean;
    /** React's development JSX runtime — what survives `--minify` without NODE_ENV=production. */
    devJsxRuntime?: boolean;
    unminified?: boolean;
    empty?: boolean;
    /** Leave a previous build's stylesheet behind, unreferenced by index.html. */
    staleCssDefs?: number;
    /** Reference a stylesheet that was never emitted. */
    danglingCss?: boolean;
  } = {},
): string {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  if (opts.empty) return dir;
  const cssName = "index-abc123.css";
  const jsName = "index-abc123.js";
  writeFileSync(
    join(dir, "index.html"),
    html(opts.danglingCss ? "index-GONE.css" : cssName, jsName, opts.sprite !== false),
  );
  if (!opts.danglingCss) writeFileSync(join(dir, cssName), tokenCss(opts.tokenDefs ?? 377));
  if (opts.staleCssDefs !== undefined) {
    writeFileSync(join(dir, "index-stale99.css"), tokenCss(opts.staleCssDefs));
  }
  // A minified bundle is one long line with no indentation; an unminified one is thousands of
  // indented ones. `bun build` without --production emitted 3,266 indented lines for today's
  // 24-module graph; 200 is far from both that and the minified build's 1.
  const body = opts.unminified
    ? `function f() {\n${Array.from({ length: 200 }, (_, i) => `  const x${i} = ${i};`).join("\n")}\n}\n`
    : 'console.log("hi");';
  const marks = [
    opts.devReact ? 'console.log("react-dom.development");' : "",
    opts.devJsxRuntime ? 'console.log("jsxDEV");' : "",
  ].filter(Boolean);
  writeFileSync(join(dir, jsName), [body, ...marks].join("\n"));
  return dir;
}

function runAssert(dir: string): { code: number; out: string } {
  const p = Bun.spawnSync([ASSERT, dir]);
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), "butchr-fe-artifact-"));
});
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("scripts/assert-fe-artifact", () => {
  // The control. Without this, a script that always failed would pass every test below.
  test("a healthy artifact passes", () => {
    const r = runAssert(fixture("ok"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("377");
  });

  test("silent-failure 1: missing token CSS fails, and SAYS SO", () => {
    // 0 definitions is the real-world number when the two token imports are dropped — and it is
    // also the case where `grep` exits 1, which under `set -o pipefail` once aborted the script
    // with an EMPTY diagnostic. Assert on the message, not just the exit code.
    const r = runAssert(fixture("no-tokens", { tokenDefs: 0 }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("token CSS missing");
    expect(r.out).toContain("UNSTYLED");
  });

  test("silent-failure 1: a token count just under the threshold fails", () => {
    expect(runAssert(fixture("few-tokens", { tokenDefs: 300 })).code).toBe(1);
    expect(runAssert(fixture("enough-tokens", { tokenDefs: 301 })).code).toBe(0);
  });

  // REGRESSION. `bun build --outdir` does not clean, and assets are content-hashed, so a rebuild
  // leaves the previous bundle behind under its old name. An earlier version of this script
  // globbed `$DIST/*.css` and unioned them: dropping the themes.css import took the real sheet
  // from 377 definitions to 149, and the stale 377-definition file from the last build masked it.
  // The gate exited 0 on an unstyled artifact. `build:fe` now cleans dist/, AND the script reads
  // only what index.html references — either fix alone would have caught it; both is correct.
  test("silent-failure 1: a STALE unreferenced stylesheet cannot mask a broken one", () => {
    const r = runAssert(fixture("stale-css", { tokenDefs: 149, staleCssDefs: 377 }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("only 149");
  });

  test("a dangling stylesheet reference is a stale/partial build, not a pass", () => {
    const r = runAssert(fixture("dangling-css", { danglingCss: true }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("does not exist");
  });

  test("silent-failure 2: an un-inlined sprite fails", () => {
    const r = runAssert(fixture("no-sprite", { sprite: false }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("sprite not inlined");
  });

  // Assertion 3 is checked THREE ways and all three are needed. Measured against the real Phase 3
  // bundle on bun 1.3.11: an unflagged build is 1.4 MB, 26,983 indented lines, and carries
  // `react-dom.development`; a `--minify`-only build is 604 KB, minified, and carries NO
  // `react-dom.development` (bun resolves react-dom to its production copy anyway) — but it DOES
  // carry React's development JSX runtime. `--production` alone gets all three to zero.
  test("silent-failure 3a: a non-minified bundle fails", () => {
    const r = runAssert(fixture("unminified", { unminified: true }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("NOT minified");
  });

  test("silent-failure 3b: React's development bundle in a minified output still fails", () => {
    // Minified, so ONLY the React grep can be what reddens this — proving the checks are
    // independent rather than one masking the other.
    const r = runAssert(fixture("dev-react", { devReact: true }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("DEVELOPMENT build");
    expect(r.out).not.toContain("NOT minified");
  });

  // REGRESSION, and the reason this check exists at all. `--minify` without NODE_ENV=production is
  // the mistake the two checks above were BELIEVED to cover between them, and neither does: the
  // bundle is minified and its react-dom is the production copy, so both go green while
  // react/jsx-dev-runtime ships its warning strings and dev-mode checks to the operator's browser.
  test("silent-failure 3c: React's development JSX runtime fails even when minified and react-dom is production", () => {
    const r = runAssert(fixture("dev-jsx-runtime", { devJsxRuntime: true }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("DEVELOPMENT JSX runtime");
    expect(r.out).not.toContain("NOT minified");
    // The `react-dom.development` grep is silent here — that is exactly the gap being covered.
    expect(r.out).not.toContain("DEVELOPMENT build in the output");
  });

  // An assertion that runs over zero files is an assertion that cannot fail.
  test("a directory that is not a built front end fails rather than vacuously passing", () => {
    const r = runAssert(fixture("empty", { empty: true }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("not a built front end");
  });
});

describe("scripts/inline-sprite", () => {
  test("splices the real @launchpad-ui sprite into <body> and is idempotent", async () => {
    const dir = fixture("to-inline", { sprite: false });
    const html = join(dir, "index.html");

    expect(Bun.spawnSync([INLINE_SPRITE, html]).exitCode).toBe(0);
    const once = await Bun.file(html).text();
    // The document-local ids that <use href="#lp-icon-…"> resolves against.
    expect(once).toContain('id="lp-icon-edit"');
    expect(once).toContain('aria-hidden="true"');
    // Spliced into <body>, not <head> — and before the app root.
    expect(once.indexOf("<body>")).toBeLessThan(once.indexOf('id="lp-icon-edit"'));
    expect(once.indexOf('id="lp-icon-edit"')).toBeLessThan(once.indexOf('<main id="app">'));
    // The whole 337-symbol sprite, not a fragment.
    expect(once.match(/<symbol /g)?.length).toBeGreaterThan(300);

    // Re-running after `bun run build:fe` (which already inlined) must not double-splice.
    expect(Bun.spawnSync([INLINE_SPRITE, html]).exitCode).toBe(0);
    expect(await Bun.file(html).text()).toBe(once);
  });

  test("the inlined sprite satisfies assertion 2", () => {
    const dir = fixture("inline-then-assert", { sprite: false });
    expect(runAssert(dir).code).toBe(1);
    expect(Bun.spawnSync([INLINE_SPRITE, join(dir, "index.html")]).exitCode).toBe(0);
    expect(runAssert(dir).code).toBe(0);
  });
});
