// Tests for TASK TEMPLATES (recipes) — see src/templates.ts and the template branch
// of the create route (server.ts).
//
// Two halves:
//   1. PURE template machinery — listTemplates exposes the built-ins with their
//      extracted {{placeholders}}, and substitute/renderTemplate fill the markers
//      (missing keys left visible, unknown template → 404, bad vars → 400). No DB.
//   2. CREATE-FROM-TEMPLATE — rendering a template + vars produces the prompt that
//      lands in a real created task (createTask + task.md round-trip), mirroring what
//      the create route does server-side for `new --template`.
//
// createTask exercises the REAL function (worktree + task.md + DB row), so we stand up
// a throwaway git repo with one commit. Pure / in-process otherwise (BUTCHR_HERDR_BIN
// points at `true` so every herdr probe is a no-op).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
// Distinct workspace id — the db/config singletons are shared across test files.
const DIR_ID = "templates-dir";

let templatesMod: typeof import("../src/templates.ts");
let tasksMod: typeof import("../src/tasks.ts");
let dbMod: typeof import("../src/db.ts");
let taskmdMod: typeof import("../src/taskmd.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-templates-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-templates-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  const g = (args: string[]) =>
    execFileSync("git", ["-C", REPO_ROOT, ...args], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", REPO_ROOT], { stdio: "ignore" });
  g(["config", "user.email", "test@butchr.local"]);
  g(["config", "user.name", "butchr test"]);
  g(["commit", "--allow-empty", "-q", "-m", "init"]);

  dbMod = await import("../src/db.ts");
  taskmdMod = await import("../src/taskmd.ts");
  tasksMod = await import("../src/tasks.ts");
  templatesMod = await import("../src/templates.ts");

  dbMod.db
    .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
    .run(DIR_ID, REPO_ROOT, "test", dbMod.nowIso());
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

// ---- LISTING ---------------------------------------------------------------

test("listTemplates exposes the built-ins with extracted placeholders", () => {
  const list = templatesMod.listTemplates();
  const names = list.map((t) => t.name).sort();
  // The repo-agnostic task shapes butchr ships as recipes (incl. `rollback`, which
  // drives the webapp's "Roll back" button). butchr manages OTHER repos, so the
  // butchr-architecture-specific recipes (a webapp panel, a REST endpoint) were
  // dropped — they only ever made sense for editing butchr itself.
  expect(names).toEqual(["feature", "refactor-extract", "rollback"]);

  for (const t of list) {
    expect(typeof t.name).toBe("string");
    expect(t.description.length).toBeGreaterThan(0);
    expect(t.body.length).toBeGreaterThan(0);
    expect(Array.isArray(t.placeholders)).toBe(true);
    // Every listed placeholder really appears in the body, and they are de-duped.
    expect(new Set(t.placeholders).size).toBe(t.placeholders.length);
    for (const p of t.placeholders) expect(t.body).toContain(`{{${p}}}`);
  }

  // The feature template carries its core boilerplate slots.
  const feature = list.find((t) => t.name === "feature")!;
  expect(feature.placeholders).toEqual(["title", "read_first", "requirements", "scope"]);
});

test("extractPlaceholders is de-duped + in first-seen order (whitespace tolerated)", () => {
  expect(templatesMod.extractPlaceholders("a {{ x }} b {{y}} c {{x}}")).toEqual(["x", "y"]);
  expect(templatesMod.extractPlaceholders("no markers here")).toEqual([]);
});

// ---- SUBSTITUTION ----------------------------------------------------------

test("substitute fills supplied keys and leaves unsupplied markers visible", () => {
  const body = "hello {{name}}, see {{file}} — {{name}} again";
  // A supplied key replaces every occurrence; an unsupplied one stays as `{{file}}`.
  expect(templatesMod.substitute(body, { name: "world" })).toBe(
    "hello world, see {{file}} — world again",
  );
  expect(templatesMod.substitute(body, { name: "a", file: "b" })).toBe(
    "hello a, see b — a again",
  );
});

test("renderTemplate renders a known template and rejects an unknown one (404)", () => {
  const rendered = templatesMod.renderTemplate("feature", {
    title: "Add a thing",
    read_first: "src/foo.ts",
    requirements: "do X",
    scope: "src/foo.ts",
  });
  expect(rendered).toContain("Add a thing");
  expect(rendered).toContain("READ FIRST: src/foo.ts");
  expect(rendered).toContain("do X");
  // No leftover markers for the keys we supplied.
  expect(rendered).not.toContain("{{title}}");
  expect(rendered).not.toContain("{{requirements}}");

  let status: number | undefined;
  try {
    templatesMod.renderTemplate("nope", {});
  } catch (e) {
    status = (e as { status?: number }).status;
  }
  expect(status).toBe(404);
});

test("validateVars rejects non-object vars (400) and coerces values to strings", () => {
  expect(templatesMod.validateVars(undefined)).toEqual({});
  expect(templatesMod.validateVars(null)).toEqual({});
  expect(templatesMod.validateVars({ a: 1, b: true })).toEqual({ a: "1", b: "true" });

  for (const bad of ["str", ["a"], 7] as unknown[]) {
    let status: number | undefined;
    try {
      templatesMod.validateVars(bad);
    } catch (e) {
      status = (e as { status?: number }).status;
    }
    expect(status).toBe(400);
  }
});

// ---- CREATE-FROM-TEMPLATE --------------------------------------------------

test("a rendered template substitutes into a created task's prompt + task.md", async () => {
  // Mirror what the create route does: render the template, then create the task
  // with the rendered prompt.
  const prompt = templatesMod.renderTemplate("feature", {
    title: "Add a widgets list",
    read_first: "src/widgets.ts",
    requirements: "expose the widgets",
    scope: "src/widgets.ts",
  });
  const v = await tasksMod.createTask(DIR_ID, prompt, []);

  // The substituted values land in the task's stored prompt...
  expect(v.prompt).toContain("Add a widgets list");
  expect(v.prompt).toContain("READ FIRST: src/widgets.ts");
  expect(v.prompt).toContain("expose the widgets");
  // ...and round-trip through task.md on disk.
  const doc = taskmdMod.readTaskMd(REPO_ROOT, v.id);
  expect(doc.prompt).toContain("Add a widgets list");
  expect(doc.prompt).toContain("expose the widgets");
});

// ---- ROLLBACK TEMPLATE -----------------------------------------------------
// Rollback is no longer a mechanical `git revert` endpoint — it's a deliberate TASK
// created from this template (the webapp's "Roll back" button on a merged task),
// flowing through the standard dispatch → CI gate → review → merge pipeline.

test("the rollback template exposes {{task}}/{{sha}} and renders a correct revert prompt", () => {
  const tpl = templatesMod.listTemplates().find((t) => t.name === "rollback")!;
  expect(tpl).toBeDefined();
  // The two slots the webapp pre-fills (target task id + its merge/finalize commit).
  expect(tpl.placeholders).toEqual(["task", "sha"]);

  const prompt = templatesMod.renderTemplate("rollback", {
    task: "plush-zebra-6caf",
    sha: "abc1234def567",
  });
  // It instructs a clean revert of the named task's commit...
  expect(prompt).toContain("Revert the changes introduced by task plush-zebra-6caf (commit abc1234def567).");
  expect(prompt).toContain("git revert");
  // ...then a real fix-the-fallout pass gated on the PROJECT's build + tests (no
  // butchr-specific command — butchr manages other repos)...
  expect(prompt).toContain("the project's build and test suite green");
  // ...and the standard convention (butchr owns CHANGELOG/version at merge).
  expect(prompt).toContain("don't hand-edit those files");
  // No leftover markers once both vars are supplied.
  expect(prompt).not.toContain("{{task}}");
  expect(prompt).not.toContain("{{sha}}");
});

test("the 'Roll back' button's create flow yields a real rollback task", async () => {
  // The button POSTs { template: "rollback", vars: { task, sha } } to the create
  // route, which renders the template and creates the task. Exercise that exact
  // server path (renderTemplate → createTask) end-to-end.
  const prompt = templatesMod.renderTemplate("rollback", {
    task: "crimson-magpie-563b",
    sha: "deadbeefcafe",
  });
  const v = await tasksMod.createTask(DIR_ID, prompt, []);

  expect(v.status === "in_progress" || v.status === "blocked").toBe(true);
  expect(v.prompt).toContain("Revert the changes introduced by task crimson-magpie-563b (commit deadbeefcafe).");
  // The prompt round-trips through task.md on disk for the agent to read.
  const doc = taskmdMod.readTaskMd(REPO_ROOT, v.id);
  expect(doc.prompt).toContain("crimson-magpie-563b");
  expect(doc.prompt).toContain("deadbeefcafe");
});
