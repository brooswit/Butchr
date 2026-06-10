// Tests for the CSRF / DNS-rebinding guard (see server.csrfGuard). butchr binds
// to loopback, but a page the operator visits can make their browser forge
// cross-site state-changing requests at http://127.0.0.1:<port>/api/... . The
// guard rejects those (present-but-foreign Origin, or a rebound non-loopback
// Host) while letting the same-origin webapp and every NON-browser caller
// (CLI / MCP / curl — which send no Origin) through. It is hardening, NOT auth.
//
// Pure / in-process: the guard is a pure function over the Request + config, so
// these exercise the REAL guard directly with crafted Requests — no HTTP server,
// no claude, no herdr. These assert against butchr's DERIVED loopback origins
// only — the config singleton is shared across the whole `bun test` run and is
// locked in by whichever file imports it first, so this file cannot reliably set
// BUTCHR_ALLOWED_ORIGINS for itself in a multi-file run. The env-overridable
// extra-origins path is covered by the config field + the guard's allowlist
// construction; here we pin the behavior that doesn't depend on import order.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 47800;
const BASE = `http://127.0.0.1:${PORT}`;

let DATA_DIR: string;
let csrfGuard: typeof import("../src/server.ts").csrfGuard;

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-csrf-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  ({ csrfGuard } = await import("../src/server.ts"));
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// Run the guard for a request and report whether it was allowed (null) and, if
// rejected, the 403 status. `url` defaults to a loopback URL so only the Origin
// header varies unless a test overrides it.
function check(
  method: string,
  opts: { origin?: string | null; url?: string } = {},
): { allowed: boolean; status: number | null } {
  const headers: Record<string, string> = {};
  if (opts.origin != null) headers.origin = opts.origin;
  const req = new Request(opts.url ?? `${BASE}/api/pause`, { method, headers });
  const res = csrfGuard(req, new URL(req.url));
  return { allowed: res === null, status: res ? res.status : null };
}

describe("csrfGuard — Origin check on state-changing requests", () => {
  test("a forged/mismatched Origin on a POST is 403'd", () => {
    const { allowed, status } = check("POST", { origin: "http://evil.example.com" });
    expect(allowed).toBe(false);
    expect(status).toBe(403);
  });

  test("a cross-site Origin on the loopback port (different scheme/host) is 403'd", () => {
    // Same port, but https / a foreign host → not one of butchr's own origins.
    expect(check("POST", { origin: "https://127.0.0.1:47800" }).status).toBe(403);
    expect(check("POST", { origin: "http://127.0.0.1:9999" }).status).toBe(403);
  });

  test("a matching same-origin Origin passes (the webapp)", () => {
    expect(check("POST", { origin: `${BASE}` }).allowed).toBe(true);
    expect(check("POST", { origin: `http://localhost:${PORT}` }).allowed).toBe(true);
  });

  test("a request with NO Origin passes (CLI / MCP / curl / server-to-server)", () => {
    expect(check("POST", { origin: null }).allowed).toBe(true);
    expect(check("DELETE", { origin: null }).allowed).toBe(true);
    expect(check("PUT", { origin: null }).allowed).toBe(true);
    expect(check("PATCH", { origin: null }).allowed).toBe(true);
  });
});

describe("csrfGuard — reads and the SSE stream are never gated", () => {
  test("GET passes regardless of a foreign Origin", () => {
    expect(check("GET", { origin: "http://evil.example.com" }).allowed).toBe(true);
  });

  test("a GET to the SSE stream passes", () => {
    expect(check("GET", { origin: null, url: `${BASE}/api/events` }).allowed).toBe(true);
  });
});

describe("csrfGuard — DNS-rebinding Host check", () => {
  test("a state-changing request to a non-loopback Host is 403'd (rebinding)", () => {
    // A rebound attacker domain (attacker.com → 127.0.0.1) carries a foreign Host
    // even with no cross-site Origin.
    const { allowed, status } = check("POST", {
      origin: null,
      url: `http://attacker.com:${PORT}/api/pause`,
    });
    expect(allowed).toBe(false);
    expect(status).toBe(403);
  });

  test("loopback Hosts pass", () => {
    expect(check("POST", { origin: null, url: `http://127.0.0.1:${PORT}/api/pause` }).allowed).toBe(
      true,
    );
    expect(check("POST", { origin: null, url: `http://localhost:${PORT}/api/pause` }).allowed).toBe(
      true,
    );
  });

  test("a GET to a non-loopback Host is NOT gated (reads are never blocked)", () => {
    expect(
      check("GET", { origin: null, url: `http://attacker.com:${PORT}/api/health` }).allowed,
    ).toBe(true);
  });
});
