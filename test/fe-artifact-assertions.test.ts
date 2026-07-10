// Tests for scripts/assert-fe-artifact and scripts/inline-sprite.
//
// WHY THIS FILE EXISTS. The four assertions in scripts/assert-fe-artifact are the ENTIRE defence
// against the four ways this front end ships broken while the build exits 0: unstyled (no token
// CSS), every icon blank (no inlined sprite), React's 1.61 MB development bundle (--production
// dropped), and an ORPHANED token — a `var(--lp-x)` defined nowhere in the bundle, whose
// declaration is invalid at computed-value time and is silently dropped, leaving an inherited
// property like `color` showing its PARENT's value. None of those is visible to a build, a
// typecheck, or a layout test.
//
// The fourth is not hypothetical: @launchpad-ui/components@0.21.0 references
// `--lp-color-text-ui-secondary-base` and `--lp-color-text-ui-tertiary`, which
// @launchpad-ui/tokens@0.16.0 defines nowhere. Assertion 1 stayed GREEN throughout — it counts
// DEFINITIONS (378 were present), and cannot see a USED name that resolves to nothing.
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

/**
 * A CSS body carrying `n` distinct `--lp-*` definitions, mimicking the tokens stylesheets.
 *
 * It also USES one of them. That is not decoration: assertion 4 fails a bundle with zero
 * `var(--lp-*)` usages (an assertion that runs over no input cannot fail), and a real stylesheet
 * always uses the tokens it defines. Emitting a usage makes the fixture MORE faithful rather than
 * weakening the rule — which is separately exercised by the `noLpUsage` option below. The used
 * token is a DEFINED one, so the healthy fixture stays green.
 */
function tokenCss(n: number, usage = true): string {
  const decls = Array.from({ length: n }, (_, i) => `  --lp-color-token-${i}: #00${i % 10};`);
  const use = usage && n > 0 ? `.t { color: var(--lp-color-token-0); }\n` : "";
  return `:root {\n${decls.join("\n")}\n}\n${use}`;
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
 * of the four silent-failure modes, so a red result names its cause unambiguously.
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
    /** Appended to the referenced stylesheet — how assertion 4's cases are driven. */
    extraCss?: string;
    /** Suppress tokenCss's `var()` usage, leaving DEFINITIONS but zero usages. */
    noLpUsage?: boolean;
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
  if (!opts.danglingCss) {
    const css = tokenCss(opts.tokenDefs ?? 377, !opts.noLpUsage) + (opts.extraCss ?? "");
    writeFileSync(join(dir, cssName), css);
  }
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

  // Assertion 4. THE REAL BUG: @launchpad-ui/components@0.21.0 var()s
  // `--lp-color-text-ui-secondary-base` and `--lp-color-text-ui-tertiary`; @launchpad-ui/tokens
  // @0.16.0 defines neither. Both `color:` declarations are invalid at computed-value time and get
  // dropped, so the text inherits its parent's colour. Build, typecheck and gate all exited 0.
  test("silent-failure 4: a var(--lp-*) with no definition fails, and NAMES the orphan", () => {
    const r = runAssert(fixture("orphan-token", { extraCss: `.x { color: var(--lp-x); }\n` }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("orphaned --lp-* token");
    expect(r.out).toContain("--lp-x");
    expect(r.out).toContain("INVALID AT COMPUTED-VALUE TIME");
    // Assertion 1 is GREEN here (377 definitions > 300) — which is exactly why 4 exists. If this
    // fired instead, the test would be proving nothing about the orphan check.
    expect(r.out).not.toContain("token CSS missing");
  });

  test("silent-failure 4: EVERY orphan is named, not just the first", () => {
    const r = runAssert(
      fixture("orphan-tokens-many", {
        // The two real names, verbatim.
        extraCss:
          `.a { color: var(--lp-color-text-ui-secondary-base); }\n` +
          `.b { color: var(--lp-color-text-ui-tertiary); }\n`,
      }),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain("--lp-color-text-ui-secondary-base");
    expect(r.out).toContain("--lp-color-text-ui-tertiary");
  });

  // The stays-GREEN case for assertion 4: a script that unconditionally `exit 1`s cannot pass.
  test("silent-failure 4: a var(--lp-*) that IS defined stays green", () => {
    const r = runAssert(
      fixture("defined-token", {
        extraCss: `:root { --lp-mine: #fff; }\n.x { color: var(--lp-mine); }\n`,
      }),
    );
    expect(r.code).toBe(0);
  });

  // A fallback is a deliberate may-be-undefined: `var(--x, red)` is VALID with no `--x`. Tested
  // against an UNDEFINED name on purpose — the real bundle's only fallback-guarded token
  // (--lp-button-padding) happens to also be defined, so exercising that one would pass even if
  // the exemption were broken.
  test("silent-failure 4: an UNDEFINED var(--lp-x, fallback) is exempt and stays green", () => {
    const r = runAssert(
      fixture("fallback-token", { extraCss: `.x { padding: var(--lp-never-defined, 0px); }\n` }),
    );
    expect(r.code).toBe(0);
  });

  // The definition regex must be anchored to NEITHER `:root` NOR a line start: themes.css defines
  // its dark palette inside `[data-theme='dark']`, and the real bundle is minified onto one line.
  test("silent-failure 4: a definition inside [data-theme='dark'] counts as a definition", () => {
    const r = runAssert(
      fixture("dark-block-def", {
        extraCss: `[data-theme='dark']{--lp-dark-only:#000}.x{color:var(--lp-dark-only)}\n`,
      }),
    );
    expect(r.code).toBe(0);
  });

  // ...and minification itself must not blind it: no newlines at all, definition and usage jammed
  // onto one line, exactly as `bun build --production` emits.
  test("silent-failure 4: an orphan is caught in a MINIFIED single-line stylesheet", () => {
    const r = runAssert(
      fixture("minified-orphan", { extraCss: `@media (min-width:1px){.x{color:var(--lp-min)}}` }),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain("--lp-min");
  });

  // The zero-input rule, exercised directly. This fixture is healthy in every OTHER respect
  // (377 defs, sprite, minified) so it reaches assertion 4 rather than dying at 1, 2 or 3.
  test("silent-failure 4: a stylesheet with definitions but ZERO usages fails, not vacuously passes", () => {
    const r = runAssert(fixture("no-lp-usage", { noLpUsage: true }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("no var(--lp-*) usages");
    expect(r.out).not.toContain("token CSS missing");
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
