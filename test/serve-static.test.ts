// Tests for the static-file server (see server.serveStatic).
//
// The load-bearing behavior: a missing FILE must 404, it must NOT fall through to
// index.html. The old code served index.html for ANY path missing on disk, which is
// harmless under a classic <script> but a debugging trap under <script type="module">:
// a mistyped import path answers 200 text/html, and the browser reports "Expected a
// JavaScript module script but the server responded with a MIME type of text/html" —
// an error pointing nowhere near the actual typo.
//
// The SPA fallback still has to work for real routes, so the split is by BASENAME:
// a last path segment containing a `.` is a file request (404 when absent); an
// extensionless, route-like path still gets index.html.
//
// Pure / in-process: serveStatic is a function over a pathname reading the REAL
// dist/ dir — no HTTP server, no claude, no herdr.
//
// dist/ is a BUILD ARTIFACT (gitignored) whose asset names carry a content hash, so the
// served-file tests below cannot pin a literal `/app.js`. They read the emitted index.html and
// request whatever the bundler actually injected. That tests the real contract — "whatever bun
// emitted is servable" — instead of a filename that changes with its own contents.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO_ROOT = dirname(import.meta.dir);
const DIST = join(REPO_ROOT, "dist");

let DATA_DIR: string;
let serveStatic: typeof import("../src/server.ts").serveStatic;
/** The hashed paths bun injected into dist/index.html, as server paths (`/index-abc123.js`). */
let emittedAssets: string[];

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-static-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  // scripts/ci always builds before it tests, but a bare `bun test ./test` need not have. Build
  // on demand rather than skip: a serveStatic suite that silently vanishes when dist/ is absent
  // is worse than a slow one.
  if (!existsSync(join(DIST, "index.html"))) {
    const built = Bun.spawnSync(["bun", "run", "build:fe"], { cwd: REPO_ROOT });
    if (built.exitCode !== 0) throw new Error(`build:fe failed:\n${built.stderr.toString()}`);
  }

  const html = await Bun.file(join(DIST, "index.html")).text();
  // ABSOLUTE (`/index-<hash>.js`), because build:fe passes `--public-path=/`. The nav's
  // `href="#/…"` hash links do not match: the path must start with `/`, and theirs starts with `#`.
  emittedAssets = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]!);
  // A match set of zero must FAIL, never silently pass — an assertion over no input is an
  // assertion that cannot fail. bun injects exactly one hashed .js and one hashed .css.
  expect(emittedAssets.find((p) => p.endsWith(".js"))).toBeDefined();
  expect(emittedAssets.find((p) => p.endsWith(".css"))).toBeDefined();

  ({ serveStatic } = await import("../src/server.ts"));
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// ---- the regression this change exists to prevent ----

test("a missing .js path 404s instead of serving index.html as text/html", async () => {
  const res = await serveStatic("/views/typo.js");
  expect(res.status).toBe(404);
  // The specific failure mode: 200 + an HTML body behind a .js URL.
  expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
});

test("a missing file 404s for any extension, not just .js", async () => {
  for (const p of ["/nope.css", "/nope.mjs", "/assets/missing.png"]) {
    const res = await serveStatic(p);
    expect(res.status).toBe(404);
  }
});

// ---- real files still served, with the right content-type ----
//
// Named by the bundler, not by us: whatever index.html points at must be servable.

test("the emitted JS bundle returns 200 with a JavaScript content-type", async () => {
  const jsPath = emittedAssets.find((p) => p.endsWith(".js"))!;
  const res = await serveStatic(jsPath);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") ?? "").toContain("javascript");
});

test("the emitted CSS bundle returns 200 with a CSS content-type", async () => {
  const cssPath = emittedAssets.find((p) => p.endsWith(".css"))!;
  const res = await serveStatic(cssPath);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") ?? "").toContain("text/css");
});

// The extension-404 rule doing its most valuable work under a hashed bundle. A mistyped import
// path is now impossible (the paths are generated) — but a STALE one is not: an operator holding
// a cached index.html requests the previous build's hash. That must be a clean 404, never an HTML
// page the module loader then chokes on with an opaque MIME error.
test("a stale hashed bundle path 404s rather than falling through to index.html", async () => {
  const res = await serveStatic("/index-DEADBEEF.js");
  expect(res.status).toBe(404);
  expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
});

// REGRESSION. The two serveStatic rules interact, and the interaction bites exactly here. Rule 2
// answers a typed `/task/<id>` with index.html; rule 1 then 404s that document's own <script src>
// if it is RELATIVE, because `./index-<hash>.js` resolves to `/task/index-<hash>.js` — a missing
// path WITH an extension. The dashboard renders blank with an opaque module-load error, and no
// test that only loads `/` can see it. `--public-path=/` is what keeps the refs absolute; this is
// what proves it, at the depth where it matters.
test("assets referenced by the SPA fallback resolve from a DEEP route, not just from /", async () => {
  for (const route of ["/projects", "/task/some-deep-task-id"]) {
    expect((await serveStatic(route)).status).toBe(200);
  }
  for (const asset of emittedAssets) {
    // Absolute, so the browser requests the same path from any document depth.
    expect(asset.startsWith("/")).toBe(true);
    expect(asset.startsWith("//")).toBe(false);
    expect((await serveStatic(asset)).status).toBe(200);
  }
});

// ---- the "/" mapping and the SPA fallback are preserved ----

test("/ returns index.html", async () => {
  const res = await serveStatic("/");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('<main id="app">');
});

test("an extensionless unknown path still returns index.html (SPA fallback)", async () => {
  for (const p of ["/projects", "/metrics", "/work/st-abc123"]) {
    const res = await serveStatic(p);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<main id="app">');
  }
});

// The file-vs-route split reads the BASENAME, not the whole path: a dot in a parent
// directory must not turn a route-like request into a 404.
test("a dot in a directory segment does not defeat the SPA fallback", async () => {
  const res = await serveStatic("/v1.2/settings");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('<main id="app">');
});

// ---- traversal guard unchanged, and it still wins over everything ----

test("path traversal returns 403", async () => {
  for (const p of ["/../secrets", "/a/../../etc/passwd", "/..%2f"]) {
    const res = await serveStatic(p);
    expect(res.status).toBe(403);
  }
});

test("the traversal guard precedes the new 404 branch", async () => {
  // A traversal attempt at a file-looking path is 403, NOT 404 — the guard runs first.
  const res = await serveStatic("/../package.json");
  expect(res.status).toBe(403);
});
