// Tests for the bin/butchr CLI's shared DRY helpers (requireId + emit) and the
// ciBadge→ciCell rename.
//
// bin/butchr is a runnable script (it calls main() at module load) with no exports,
// so the requireId behavior is exercised by invoking the CLI as a subprocess: every
// id-taking command, run with no id, must fail with the SAME standardized
// `butchr: <cmd>: missing <id>` message and exit 1 — proving they all funnel through
// the one helper. The id-missing guard runs BEFORE any API call, so no server is
// needed. The rename is asserted by reading the source (a cross-surface grep trap:
// public/app.js has an unrelated DOM ciBadge that must NOT be touched here).
import { expect, test } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "bin", "butchr");

/** Run `bun bin/butchr <args>`, capturing stderr/stdout and the exit code. */
function runCli(args: string[]): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync("bun", [CLI, ...args], { encoding: "utf8", stdio: "pipe" });
    return { stdout, stderr: "", code: 0 };
  } catch (e: any) {
    return {
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
      code: e.status ?? 1,
    };
  }
}

const execFileAsync = promisify(execFile);

/**
 * Async variant of runCli with a custom environment. Used by the F3 test, which
 * must keep this process's event loop FREE to serve an in-process http server
 * while the CLI runs (execFileSync would block it). MERGE process.env so PATH /
 * bun resolution isn't lost when overriding BUTCHR_URL.
 */
async function runCliEnv(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("bun", [CLI, ...args], { encoding: "utf8", env });
    return { stdout, stderr, code: 0 };
  } catch (e: any) {
    return {
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

// Every command whose first positional is the required <id>.
const ID_COMMANDS = [
  "show",
  "approve",
  "confirm-major",
  "reject",
  "answer",
  "plan-approve",
  "plan-reject",
  "spec",
  "nudge",
  "requeue",
  "block",
  "priority",
  "wait",
];

for (const cmd of ID_COMMANDS) {
  test(`requireId: \`${cmd}\` with no id fails with the standard message`, () => {
    const { stderr, code } = runCli([cmd]);
    expect(code).toBe(1);
    expect(stderr.trim()).toBe(`butchr: ${cmd}: missing <id>`);
  });
}

test("--help renders usage and exits 0 (script parses + runs)", () => {
  const { stdout, code } = runCli(["--help"]);
  expect(code).toBe(0);
  expect(stdout).toContain("operator CLI for the butchr REST API");
  // The release_mode surfaces are advertised in usage.
  expect(stdout).toContain("--bump patch|minor|major");
  expect(stdout).toContain("confirm-major <id>");
});

// AUTHORITY FLIP: `new` no longer creates standalone work tasks — new work flows through
// `story`, and the ONLY task `new` creates is a rollback. A plain `new -m` errors offline
// (before any network call), pointing at `story`.
test("new -m errors offline: standalone task creation is disabled (use story)", () => {
  const { stderr, code } = runCli(["new", "some-ws", "-m", "x"]);
  expect(code).toBe(1);
  expect(stderr).toContain("standalone task creation is disabled");
  expect(stderr).toContain("butchr story <workspace>");
});

// `new --template rollback --bump` is validated BEFORE any network call, so a bad level fails
// fast with the standard message and exit 1 (no server needed). This also proves --bump is a
// recognized value-flag rather than an "unknown flag" parse error (and that the rollback form
// passes the authority-flip gate to reach the bump validation).
test("new --bump rejects an invalid level offline (validated pre-network)", () => {
  const { stderr, code } = runCli(
    ["new", "some-ws", "--template", "rollback", "--var", "task=t", "--var", "sha=s", "--bump", "bananas"],
  );
  expect(code).toBe(1);
  expect(stderr.trim()).toBe(`butchr: new: --bump must be 'patch', 'minor', or 'major' (got "bananas")`);
});

// A VALID --bump level parses + validates fine, then the command proceeds PAST the flag
// check to workspace resolution (the network). Whatever it fails on there — an unreachable
// server, or an unknown workspace if one happens to be running — it is NOT the --bump
// validation error, proving the valid flag was accepted (and recognized as a value-flag,
// not an "unknown flag" parse error). Environment-robust: makes no assumption about whether
// a butchr server is up.
test("new --bump major is accepted by parsing (fails later, not on the flag)", () => {
  const { stderr, code } = runCli(
    ["new", "some-ws-that-does-not-exist", "--template", "rollback", "--var", "task=t", "--var", "sha=s", "--bump", "major"],
  );
  expect(code).toBe(1);
  expect(stderr).not.toContain("--bump must be");
  expect(stderr).not.toContain("unknown flag");
  // Not blocked by the authority-flip gate either (the rollback form is permitted).
  expect(stderr).not.toContain("standalone task creation is disabled");
});

test("ciBadge is renamed to ciCell in bin/butchr (and app.js is untouched)", () => {
  const cli = readFileSync(CLI, "utf8");
  // The CLI's CI helper is now ciCell; the old name must be gone here.
  expect(cli).not.toContain("ciBadge");
  expect(cli).toContain("function ciCell(");
  // The unrelated DOM helper in public/app.js keeps its name — not our file to edit.
  const app = readFileSync(join(ROOT, "public", "app.js"), "utf8");
  expect(app).toContain("function ciBadge(");
});

// F1 — a bare negative integer is reachable as a POSITIONAL, not rejected as an
// unknown flag, so `priority <id> -5` can deprioritize below 0. The parse layer
// must accept `-5`; with no server up the command proceeds past parsing and fails
// at the API layer (connection refused) — so we assert only that it did NOT fail
// with the parse-time `unknown flag` message.
test("priority <id> -N: a negative priority is accepted as a positional (not an unknown flag)", () => {
  const { stderr } = runCli(["priority", "some-id", "-5"]);
  expect(stderr).not.toContain("unknown flag");
});

// F2 — an unknown `--flag=value` key now errors at the parse layer (before any
// network call), mirroring the space-separated form's guard. Previously such a
// typo was silently dropped, running the command with the option MISSING.
test("ls --bogus=x errors with 'unknown flag' at the parse layer", () => {
  const { stderr, code } = runCli(["ls", "--bogus=x"]);
  expect(code).toBe(1);
  expect(stderr).toContain("unknown flag");
});

// ...and a VALID `--key=value` is still accepted by parsing: it reaches the API
// and fails on the connection (or whatever the server says), NOT on flag parsing —
// proving the new validation rejects ONLY unknown keys.
test("ls --workspace=foo is accepted by parsing (fails later, not on the flag)", () => {
  const { stderr } = runCli(["ls", "--workspace=foo"]);
  expect(stderr).not.toContain("unknown flag");
});

// F3 — `health` against a server returning a non-JSON body (e.g. an HTML 502 from
// a proxy) must report a CLEAN unreachable/degraded message and exit non-zero,
// rather than surfacing a raw SyntaxError from res.json(). Stand up a throwaway
// http server on an ephemeral port and point the CLI at it via BUTCHR_URL.
test("health surfaces a clean error on a non-JSON server response (no raw SyntaxError)", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(502, { "content-type": "text/html" });
    res.end("<html>502</html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const { port } = server.address() as { port: number };
    const { stderr, code } = await runCliEnv(["health"], {
      ...process.env,
      BUTCHR_URL: `http://127.0.0.1:${port}`,
    });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/non-JSON|unreachable|degraded/);
    expect(stderr).not.toContain("SyntaxError");
    expect(stderr).not.toContain("JSON.parse");
  } finally {
    server.close();
  }
});

test("the shared requireId + emit helpers are defined once", () => {
  const cli = readFileSync(CLI, "utf8");
  expect(cli).toContain("function requireId(positionals, cmd)");
  expect(cli).toContain("function emit(flags, data, text)");
  // The per-command `if (!id) fail(...)` and `if (flags.json) { printJson; return }`
  // tails are gone — only the helper definitions reference them now.
  expect(cli.match(/if \(!id\) fail/g)?.length ?? 0).toBe(1); // inside requireId only
  expect(cli.match(/if \(flags\.json\)/g)?.length ?? 0).toBe(1); // inside emit only
});
