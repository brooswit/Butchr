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
// public/ dir — no HTTP server, no claude, no herdr.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let serveStatic: typeof import("../src/server.ts").serveStatic;

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-static-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

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

test("/app.js returns 200 with a JavaScript content-type", async () => {
  const res = await serveStatic("/app.js");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") ?? "").toContain("javascript");
});

test("/style.css returns 200 with a CSS content-type", async () => {
  const res = await serveStatic("/style.css");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") ?? "").toContain("text/css");
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
