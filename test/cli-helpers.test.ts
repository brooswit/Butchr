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
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

// Every command whose first positional is the required <id>.
const ID_COMMANDS = [
  "show",
  "approve",
  "reject",
  "answer",
  "spec",
  "nudge",
  "requeue",
  "block",
  "priority",
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

test("the shared requireId + emit helpers are defined once", () => {
  const cli = readFileSync(CLI, "utf8");
  expect(cli).toContain("function requireId(positionals, cmd)");
  expect(cli).toContain("function emit(flags, data, text)");
  // The per-command `if (!id) fail(...)` and `if (flags.json) { printJson; return }`
  // tails are gone — only the helper definitions reference them now.
  expect(cli.match(/if \(!id\) fail/g)?.length ?? 0).toBe(1); // inside requireId only
  expect(cli.match(/if \(flags\.json\)/g)?.length ?? 0).toBe(1); // inside emit only
});
