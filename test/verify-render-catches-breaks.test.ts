// Tests for scripts/verify-render — the headless-Chrome render gate.
//
// WHY THIS FILE EXISTS. `scripts/verify-render` is a GUARD, and an unproven guard is worse than no
// guard: it makes `scripts/ci` LOOK like it can see a blank dashboard. Every claim that script's
// comments make ("VERIFIED RED: stripping the four `[data-theme=dark]{…}` blocks…") was established
// by HAND, once, by its author. A hand-run demo rots the moment somebody edits a probe. So each of
// the verifier's five checks gets a test here that BREAKS a copy of a REAL built artifact and
// requires the script to go red WITH THAT CHECK'S OWN DIAGNOSTIC — plus a happy-path case that
// requires it to stay green, so a script that simply `exit 1`s unconditionally cannot pass this file.
//
// This mirrors test/fe-artifact-assertions.test.ts, which does the same job for the BYTE-level
// assertions in scripts/assert-fe-artifact. The difference: those run against synthetic fixture
// directories, because greps do not need a real bundle. These CANNOT. A browser check is only
// meaningful against bytes a browser will really load, so every case here copies a genuinely built
// `dist/` and corrupts the copy.
//
// TARGETING IS THE POINT. A corruption that reddens three checks at once proves nothing about the
// other two — it proves only that SOMETHING broke. So every case below asserts both that its own
// check fired AND that the others did NOT. Four of the five isolate perfectly. The fifth (MOUNT)
// provably cannot; see its test.
//
// See also: `docs`-free by design — the reasoning lives next to the assertion it justifies.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO_ROOT = dirname(import.meta.dir);
const VERIFY = join(REPO_ROOT, "scripts", "verify-render");
const ASSERT_FE = join(REPO_ROOT, "scripts", "assert-fe-artifact");
const DIST = join(REPO_ROOT, "dist");

/** Every check name `scripts/verify-render` can print. `fired()` is closed over this list, so a new
 *  check added to the script without a test here shows up as an unexplained name in a `fired` set. */
const CHECKS = ["MOUNT", "CONSOLE", "STYLED", "ICONS", "DARK_MODE"] as const;
type Check = (typeof CHECKS)[number];

// ---- browser presence -------------------------------------------------------------------------
// A VACUOUSLY-GREEN TEST FILE IS THE EXACT BUG THIS STORY EXISTS TO KILL. With no browser on the
// host, `verify-render` takes its LOUD-SKIP path and exits 0 for EVERY input — so all five
// corruption tests would "pass" while proving precisely nothing. They are therefore gated on a
// browser actually resolving, by the same resolution order the script itself uses, and the file
// SHOUTS when that gate closes.
function resolveBrowser(): string | null {
  const override = process.env.CHROME;
  if (override) return Bun.which(override);
  for (const c of ["google-chrome", "chromium", "chrome"]) {
    const found = Bun.which(c);
    if (found) return found;
  }
  return null;
}
const BROWSER = resolveBrowser();
const NO_BROWSER = BROWSER === null;

if (NO_BROWSER) {
  console.warn(
    "\n" +
      "  ============================================================\n" +
      "  WARNING: verify-render CORRUPTION TESTS SKIPPED\n" +
      "  ============================================================\n" +
      "  No headless browser resolved ($CHROME, google-chrome, chromium,\n" +
      "  chrome). Without one, scripts/verify-render takes its loud-skip\n" +
      "  path and exits 0 for every input — so the five corruption tests\n" +
      "  below would pass VACUOUSLY, proving nothing.\n" +
      "\n" +
      "  UNPROVEN on this run: MOUNT, CONSOLE, STYLED, ICONS, DARK_MODE,\n" +
      "  and the happy path. Only the two skip-semantics tests ran.\n" +
      "  ============================================================\n",
  );
}

// ---- running the verifier ---------------------------------------------------------------------
type Run = { code: number; out: string; ms: number };

async function runVerify(distDir: string, env?: Record<string, string>): Promise<Run> {
  const t0 = Date.now();
  // Spawn the script directly (its `#!/usr/bin/env bun` shebang) for the normal cases. The
  // empty-PATH case below cannot do that — see `skipRuns`.
  const p = Bun.spawn([VERIFY, distDir], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: env ?? process.env,
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out + err, ms: Date.now() - t0 };
}

/** The set of checks that printed a FAILED diagnostic. This is the assertion currency of the file:
 *  every case asserts the WHOLE set, not merely that its own check appears. */
function fired(run: Run): Check[] {
  return CHECKS.filter((c) => run.out.includes(`RENDER [${c}] FAILED`));
}

// ---- the corruptions --------------------------------------------------------------------------
// Each mutates a COPY of a real `dist/`, and each is the NARROWEST edit that trips its check. The
// measured `fired` set for each is asserted in its own test; the numbers in these comments were
// taken against the real 0.9.294 artifact in Chrome 150.
const cssOf = (d: string) => join(d, readdirSync(d).find((f) => f.endsWith(".css"))!);
const jsOf = (d: string) => join(d, readdirSync(d).find((f) => f.endsWith(".js"))!);
const htmlOf = (d: string) => join(d, "index.html");

/** Read-modify-write with a REQUIRED needle. A corruption whose target string has drifted out of the
 *  bundle would otherwise silently mutate nothing, the verifier would exit 0, and the test would
 *  fail with "expected 1, got 0" — pointing at the script instead of at this file. Throw instead. */
function replaceOrThrow(path: string, needle: string, with_: string): void {
  const body = readFileSync(path, "utf8");
  if (!body.includes(needle))
    throw new Error(`corruption target not found in ${path}: ${JSON.stringify(needle.slice(0, 80))}`);
  writeFileSync(path, body.replace(needle, with_));
}

const CORRUPTIONS: Record<string, (dir: string) => void> = {
  /** HAPPY PATH. The control, and the file's load-bearing case — see `assertSourceHealthy`. */
  happy: () => {},

  /**
   * MOUNT: replace the entry bundle with an empty module. Nothing runs, so `#root` never acquires
   * children — the literal blank dashboard the whole script exists to catch — while `index.html`,
   * the token CSS and the inlined sprite are all untouched and byte-identical.
   *
   * This is the ONE corruption that reddens a second check, and it is IRREDUCIBLE. The ICONS probe
   * measures `use.getBBox()`, and EVERY `<use>` element in the document is emitted by React's
   * `Icon`. No mount => no `<use>` => `icons.uses === 0` => ICONS reddens too, for ANY corruption
   * that breaks mount. It is a property of the two checks, not of this edit.
   *
   * The alternatives all trip MORE checks, not fewer: renaming `id="root"` hits main.tsx's
   * `if (!root) throw new Error(...)`, which reddens CONSOLE as well; deleting the `<script
   * type="module">` reddens exactly the same pair as this one but leaves a bundle no browser loads,
   * which is a less honest model of "the app throws on mount". So: empty module, and assert the
   * pair.
   */
  mount: (d) => writeFileSync(jsOf(d), "export {};\n"),

  /**
   * CONSOLE: an uncaught error during boot, from a CLASSIC script in `<head>`. Classic-script
   * throws do not abort the deferred module bundle, so the app still mounts, still styles itself,
   * still paints icons, and still flips theme — leaving CONSOLE as the only red check. That is
   * exactly the failure mode the check is for: a page that "may look fine and still be broken".
   */
  console: (d) =>
    replaceOrThrow(
      htmlOf(d),
      "</head>",
      '<script>throw new Error("verify-render-catches-breaks: synthetic boot error")</script></head>',
    ),

  /**
   * STYLED: delete the ONE light-layer definition of the probe token.
   *
   * THE BRIEF ASKED FOR "the token CSS is dropped", AND THAT IS NOT A TARGETED CORRUPTION. Dropping
   * the stylesheet leaves `<body>` background `rgba(0, 0, 0, 0)` in BOTH themes, so
   * `dark.before === dark.after` and DARK_MODE reddens alongside STYLED. Grounded in the real
   * bundle: `body { background: var(--bg) }` and `:root { --bg: var(--lp-color-bg-ui-primary) }`
   * (public/style.css:72), while `html[data-theme="dark"] { --bg: #181a1f }` (:175) is a LITERAL.
   *
   * So removing only the LIGHT-layer definition of `--lp-color-bg-ui-primary` reddens both STYLED
   * probes — the custom property reads "" on `:root`, and `--bg`'s var() is then invalid at
   * computed-value time so `<body>` paints transparent — while the dark flip still lands on that
   * literal and DARK_MODE stays GREEN. The dark-layer definition
   * (`--lp-color-bg-ui-primary:var(--lp-color-gray-950)`) is deliberately left in place.
   */
  styled: (d) => replaceOrThrow(cssOf(d), "--lp-color-bg-ui-primary:var(--lp-color-white-950);", ""),

  /**
   * ICONS: excise the inlined sprite from `index.html`, exactly as a build that forgot
   * `scripts/inline-sprite` would emit it. `<use href="#lp-icon-…">` then resolves to nothing:
   * every icon renders BLANK inside an unchanged 16x16 layout box. Nothing else moves — the app
   * mounts (2 children), boots clean, styles, and flips theme.
   */
  icons: (d) => {
    const html = readFileSync(htmlOf(d), "utf8");
    const start = html.indexOf('<svg aria-hidden="true" style="display:none"');
    if (start === -1) throw new Error("no inlined sprite in the source artifact — is `dist/` un-spliced?");
    const end = html.indexOf("</svg>", start);
    if (end === -1) throw new Error("inlined sprite has no closing </svg>");
    writeFileSync(htmlOf(d), html.slice(0, start) + html.slice(end + "</svg>".length));
  },

  /**
   * DARK_MODE: strip every `[data-theme=dark]{…}` block from the built CSS — the four measured in
   * the real bundle: one from @launchpad-ui/tokens' themes.css, one lightningcss shim, one from the
   * Alert component, and butchr's own `html[data-theme=dark]`.
   *
   * The light-layer definitions survive untouched, so STYLED stays GREEN and this reddens alone.
   * That is the whole point: this is the failure `assert:fe` structurally CANNOT see, because its
   * token COUNT is unchanged — every name is still defined under `:root`; only the dark VALUES are
   * gone. The bundle is minified onto one line, so the selector is `[data-theme=dark]` (no quotes)
   * and the blocks contain no nested braces, which is what makes `[^}]*` sound here.
   */
  dark: (d) => {
    const path = cssOf(d);
    const css = readFileSync(path, "utf8");
    const blocks = /(?:html)?\[data-theme=dark\]\{[^}]*\}/g;
    const n = (css.match(blocks) || []).length;
    // Zero replacements would leave the artifact healthy and the verifier green — a corruption that
    // corrupts nothing. Assert the edit BIT, here, rather than debugging it as a script failure.
    if (n === 0) throw new Error("no [data-theme=dark] blocks in the built CSS — did themes.css fall out?");
    writeFileSync(path, css.replace(blocks, ""));
  },
};

// ---- fixture ----------------------------------------------------------------------------------
let TMP: string;
let SOURCE_DIST: string;
const runs = new Map<string, Run>();
let sourceProblem: string | null = null;

/**
 * THE HAPPY CASE IS LOAD-BEARING, so a broken SOURCE artifact must fail the WHOLE file, not one
 * test. If `dist/` were already broken, all five corruption tests would still go green — they
 * expect red and they would get red, for the wrong reason — and only `happy` would fail. A reader
 * skimming "5 pass, 1 fail" would conclude the verifier basically works. Every test calls this
 * first, so that reading is unavailable.
 */
function assertSourceHealthy(): void {
  if (sourceProblem) throw new Error(sourceProblem);
}

/**
 * NEVER blindly reuse whatever `dist/` happens to be on disk. `bun run dev:fe` (package.json:14)
 * writes `dist/` WITHOUT inlining the sprite — `dev:sprite` is a SEPARATE script — so any developer
 * who has run `bun run dev` can leave an un-spliced `dist/` behind. Copying that as the source would
 * fail only the happy-path test while all five corruption tests stayed green: a vacuous green in
 * disguise. So the source is VALIDATED with the byte-level gate, and rebuilt if it does not pass.
 * `build:fe` is 0.18s measured, so the healthy path costs nothing and the unhealthy path self-heals.
 */
function prepareSourceDist(): string {
  const healthy =
    existsSync(join(DIST, "index.html")) && Bun.spawnSync([ASSERT_FE, DIST], { cwd: REPO_ROOT }).exitCode === 0;
  if (!healthy) {
    const build = Bun.spawnSync(["bun", "run", "build:fe"], { cwd: REPO_ROOT });
    if (build.exitCode !== 0)
      throw new Error(`bun run build:fe failed (exit ${build.exitCode}):\n${build.stderr.toString()}`);
  }
  return DIST;
}

/** Copy `dist/` into `TMP/<name>` and corrupt the COPY. `dist/` itself is never written. */
function corruptedCopy(name: string): string {
  const dir = join(TMP, name);
  cpSync(SOURCE_DIST, dir, { recursive: true });
  CORRUPTIONS[name]!(dir);
  return dir;
}

/**
 * CONCURRENCY. Sequentially this file costs ~18s, of which MOUNT alone is 11.2s — that is
 * `MOUNT_POLL_MS` (10s) burning down BY DESIGN, not slowness, so it cannot be optimised away. Each
 * `verify-render` invocation owns an ephemeral-port `Bun.serve` and a `mkdtemp` Chrome profile, so
 * the runs are independent and can overlap. Six at once brings wall clock to ~max(case) ≈ 12s.
 *
 * MEASURED over 3 back-to-back full-file runs at LANES=6: identical `fired` sets every time, no
 * leaked Chrome processes, no leftover `butchr-verify-render-*` temp profiles. If that ever drifts
 * under load, drop LANES to 3 — trading ~12s for ~20s is a good trade; a flaky gate step is not.
 */
const LANES = 6;

async function inLanes<T>(thunks: Array<() => Promise<T>>, lanes: number): Promise<T[]> {
  const out = new Array<T>(thunks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(lanes, thunks.length) }, async () => {
      while (next < thunks.length) {
        const i = next++;
        out[i] = await thunks[i]!();
      }
    }),
  );
  return out;
}

beforeAll(async () => {
  TMP = mkdtempSync(join(tmpdir(), "butchr-verify-render-test-"));

  if (NO_BROWSER) {
    // Still needed: the two skip-semantics tests take a real dist-dir argument (`verify-render`
    // checks the directory BEFORE it resolves a browser, and a missing one is exit 2, not exit 0).
    SOURCE_DIST = prepareSourceDist();
    return;
  }

  SOURCE_DIST = prepareSourceDist();
  const names = Object.keys(CORRUPTIONS);
  const dirs = names.map(corruptedCopy);
  const results = await inLanes(
    dirs.map((d) => () => runVerify(d)),
    LANES,
  );
  names.forEach((n, i) => runs.set(n, results[i]!));

  const happy = runs.get("happy")!;
  if (happy.code !== 0) {
    sourceProblem =
      "THE SOURCE ARTIFACT IS ALREADY BROKEN — every corruption result in this file is MEANINGLESS.\n" +
      "  `scripts/verify-render` exited " +
      happy.code +
      " on an UNCORRUPTED copy of dist/, so each corruption test below would have gone green by\n" +
      "  expecting red and getting red for a reason that has nothing to do with its corruption.\n" +
      "  Fix dist/ (bun run build:fe) or scripts/verify-render first. Verifier output was:\n\n" +
      happy.out.replace(/^/gm, "    ");
    console.error("\n" + sourceProblem + "\n");
  }

  console.log(
    `verify-render: ${names.length} runs in ${LANES} lanes — ` +
      names.map((n) => `${n}=${runs.get(n)!.code}/${runs.get(n)!.ms}ms`).join(" "),
  );
}, 180_000);

afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

// The runs happen once in beforeAll, so every test below is a pure assertion over captured output.
const it = test.skipIf(NO_BROWSER);
const run = (name: string): Run => {
  assertSourceHealthy();
  return runs.get(name)!;
};

describe("scripts/verify-render catches the breaks it claims to catch", () => {
  // The control. Without it, a script that unconditionally `exit 1`d would pass every test below.
  it("an UNTOUCHED built artifact passes", () => {
    const r = run("happy");
    expect(r.code).toBe(0);
    expect(fired(r)).toEqual([]);
    expect(r.out).toContain("RENDER: ok");
    // Each check's green measurement, named, so a check silently going no-op is visible here too.
    expect(r.out).toContain("#root mounted");
    expect(r.out).toContain("0 console errors");
    expect(r.out).toContain("--lp-color-bg-ui-primary resolved");
    expect(r.out).toContain("sprite symbols");
    expect(r.out).toContain("dark mode flips");
  });

  // Check 1. MOUNT + ICONS is IRREDUCIBLE — see the `mount` corruption's comment. Asserting the
  // exact pair, rather than only `MOUNT`, is what keeps this honest: if a future edit made the
  // corruption trip CONSOLE or STYLED as well, this test would fail rather than shrug.
  it("MOUNT: an entry bundle that renders nothing fails, and SAYS the dashboard boots blank", () => {
    const r = run("mount");
    expect(r.code).toBe(1);
    expect(r.out).toContain("RENDER [MOUNT] FAILED");
    expect(r.out).toContain("#root is EMPTY");
    expect(r.out).toContain("The dashboard boots BLANK");
    // ICONS necessarily co-fires: every <use> is React-emitted, so no mount means no <use>. It is
    // the only check that cannot be isolated from MOUNT, and it names its own distinct cause.
    expect(r.out).toContain("NO <use> element references it");
    expect(fired(r)).toEqual(["MOUNT", "ICONS"]);
  }, 30_000);

  // Check 2. A classic-script throw does not abort the deferred module bundle, so the page mounts,
  // styles, paints icons and flips theme — CONSOLE is alone, which is the whole claim: an app that
  // "may look fine and still be broken".
  it("CONSOLE: an uncaught error during boot fails ALONE, and quotes the error", () => {
    const r = run("console");
    expect(r.code).toBe(1);
    expect(r.out).toContain("RENDER [CONSOLE] FAILED");
    expect(r.out).toContain("error(s) during boot");
    expect(r.out).toContain("verify-render-catches-breaks: synthetic boot error");
    expect(r.out).toContain("[exceptionThrown/error]");
    expect(fired(r)).toEqual(["CONSOLE"]);
  }, 30_000);

  // Check 3. Both STYLED probes fire — the custom property reads "" AND the property it drives
  // paints transparent — while DARK_MODE stays green, because butchr's dark `--bg` is a literal.
  // See the `styled` corruption's comment for why the brief's "drop the whole stylesheet" would
  // have reddened DARK_MODE too and proved nothing about it.
  it("STYLED: a token whose light-layer definition is gone fails, WITHOUT reddening DARK_MODE", () => {
    const r = run("styled");
    expect(r.code).toBe(1);
    expect(r.out).toContain("RENDER [STYLED] FAILED");
    expect(r.out).toContain("--lp-color-bg-ui-primary resolves to EMPTY on :root");
    expect(r.out).toContain('<body> computed background-color is "rgba(0, 0, 0, 0)"');
    expect(fired(r)).toEqual(["STYLED"]);
  }, 30_000);

  // Check 4. The failure `assert:fe`'s grep CAN see (it greps `id="lp-icon-` in index.html) — but
  // only because the whole sprite is gone. The subtler case it CANNOT see, symbols present with
  // their geometry emptied, is covered by the verifier's `use.getBBox()` probe, whose own comment
  // records the four-candidate measurement. Here we assert the crude case reddens exactly ICONS.
  it("ICONS: an un-inlined sprite fails ALONE, naming the blank icons", () => {
    const r = run("icons");
    expect(r.code).toBe(1);
    expect(r.out).toContain("RENDER [ICONS] FAILED");
    expect(r.out).toContain('no <symbol id="lp-icon-..."> in the LIVE DOM');
    expect(r.out).toContain("Every icon renders BLANK");
    expect(fired(r)).toEqual(["ICONS"]);
  }, 30_000);

  // Check 5. The one `assert:fe` structurally cannot see: every token NAME is still defined under
  // `:root`, so its definition COUNT is unchanged and it exits 0 — while dark mode is dead.
  it("DARK_MODE: stripping the [data-theme=dark] blocks fails ALONE, and SAYS the flip changed nothing", () => {
    const r = run("dark");
    expect(r.code).toBe(1);
    expect(r.out).toContain("RENDER [DARK_MODE] FAILED");
    expect(r.out).toContain("flipping [data-theme=dark] on <html> changed NOTHING");
    expect(r.out).toContain('stayed "rgb(255, 255, 255)"');
    expect(fired(r)).toEqual(["DARK_MODE"]);

    // ...and the byte-level gate is GREEN on the very same artifact. Without this, the check above
    // could be dismissed as redundant with `assert:fe`. It is not: this is the gap verify-render
    // exists to close.
    const dir = join(TMP, "dark");
    expect(Bun.spawnSync([ASSERT_FE, dir], { cwd: REPO_ROOT }).exitCode).toBe(0);
  }, 30_000);
});

// ---- skip semantics ---------------------------------------------------------------------------
// A SILENT SKIP IS THE FAILURE MODE THIS WHOLE STORY EXISTS TO PREVENT, so it gets tests — and they
// run whether or not a browser is present, because neither needs one.
describe("scripts/verify-render skip semantics", () => {
  test("a $CHROME that does not resolve exits 0 with a LOUD warning naming the bad path", async () => {
    const r = await runVerify(SOURCE_DIST, { ...process.env, CHROME: "/nonexistent/chrome" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("WARNING: RENDER VERIFICATION SKIPPED");
    expect(r.out).toContain("$CHROME is set to: /nonexistent/chrome");
    expect(r.out).toContain("NOT booted and NOT verified");
    // A typo in $CHROME must not masquerade as "this host has no browser" — distinct causes, distinct
    // warnings. The auto-detection wording must NOT appear here.
    expect(r.out).not.toContain("No headless browser found on this host");
    // Exit 2 is reserved for the two dist-dir usage errors. A bad $CHROME is not one of them.
    expect(r.code).not.toBe(2);
  }, 30_000);

  test("no browser anywhere on PATH exits 0 with a LOUD warning listing what it looked for", async () => {
    // SPAWN `bun` EXPLICITLY, NOT THROUGH THE SHEBANG. `#!/usr/bin/env bun` resolves `bun` through
    // PATH, so an emptied PATH kills the script at exec with `env: 'bun': No such file or directory`
    // and exit 127 — and a test asserting only "exit 0" would... well, it would fail, but a test
    // asserting "non-zero" or a warning substring against combined output could easily go green for
    // entirely the wrong reason. Bypass the shebang so PATH governs only `Bun.which`, which is the
    // thing under test.
    const emptyPath = mkdtempSync(join(TMP, "empty-path-"));

    const env = { ...process.env, PATH: emptyPath };
    delete (env as Record<string, string | undefined>).CHROME;

    const p = Bun.spawn([process.execPath, VERIFY, SOURCE_DIST], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    const combined = out + err;

    expect(code).toBe(0);
    expect(combined).toContain("WARNING: RENDER VERIFICATION SKIPPED");
    expect(combined).toContain("No headless browser found on this host");
    expect(combined).toContain("$CHROME (unset), google-chrome, chromium, chrome");
    expect(combined).toContain("NOT booted and NOT verified");
    // Proves the shebang was really bypassed: exec failure is 127, and `env:` would be in stderr.
    expect(combined).not.toContain("No such file or directory");
  }, 30_000);

  // THE CONVERSE, and the reason the two above are not enough. A script that printed the skip
  // warning unconditionally would pass both of them while verifying nothing, forever.
  it("does NOT print the skip warning when a browser IS present", () => {
    const r = run("happy");
    expect(r.out).not.toContain("RENDER VERIFICATION SKIPPED");
    expect(r.out).not.toContain("NOT booted and NOT verified");
    expect(r.out).toContain("RENDER: ok");
  });
});
