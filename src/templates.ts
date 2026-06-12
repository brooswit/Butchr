// TASK TEMPLATES (recipes): named, parameterized prompt skeletons so the common
// task shapes we create over and over are instantiated from a template instead of
// hand-writing the same boilerplate each time.
//
// A template is a plain in-memory record: a `name`, a one-line `description`, and a
// prompt `body` carrying `{{placeholder}}` markers. Templates are STATIC built-ins
// (no DB, no config file) — keeping them as code is the simplest dependency-free
// home for a small fixed set, consistent with butchr's zero-dep rule. Two operations
// sit on top:
//   - listTemplates()      → the templates plus their extracted placeholder names,
//                            for the CLI `templates` command + the webapp picker.
//   - renderTemplate(n,v)  → substitute `{{key}}` markers from a vars map, producing
//                            a ready-to-use prompt. Used server-side by the create
//                            route when a task is created from a template.
// See server.ts (GET /api/templates + the template branch of the create route),
// bin/butchr (`templates` / `new --template`), and public/app.js (new-task picker).
import { HttpError } from "./workspaces.ts";

/** A built-in task template: a name, a one-line description, and a prompt body with `{{placeholders}}`. */
export type Template = {
  name: string;
  description: string;
  body: string;
};

/** A template enriched with the distinct `{{placeholder}}` names found in its body (in first-seen order). */
export type TemplateView = Template & { placeholders: string[] };

// The single regex that recognizes a placeholder: `{{name}}` (letters/digits/_,
// surrounding whitespace tolerated). Reused by extractPlaceholders + substitute so
// the two never disagree on what a placeholder is.
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

// The built-in templates. Each body captures the boilerplate of a common task shape
// — the READ-FIRST / SCOPE / FOLLOW-CONVENTIONS / add-tests skeleton — so a new task
// only has to fill the `{{placeholders}}`. butchr manages OTHER people's repos, so the
// bodies are REPO-AGNOSTIC: they point at "the project's conventions / build / tests"
// rather than baking in butchr's own commands, module layout, or zero-dep rule.
export const TEMPLATES: Template[] = [
  {
    name: "feature",
    description: "A new feature: read-first, scope, follow the repo's conventions, add tests.",
    body: [
      "{{title}}",
      "",
      "READ FIRST: {{read_first}}",
      "",
      "REQUIREMENTS: {{requirements}}",
      "",
      "SCOPE: {{scope}}",
      "",
      "FOLLOW THE REPO'S CONVENTIONS: match the surrounding code's style and structure,",
      "and respect the project's contributing guide / docs if it has one. Avoid adding a",
      "dependency the project doesn't already use unless it's clearly warranted. If this",
      "changes a documented public surface, update the relevant docs in the SAME change.",
      "",
      "TESTS: add tests alongside the feature covering the new behavior, and make the",
      "project's build and test suite green before calling request_review.",
    ].join("\n"),
  },
  {
    name: "refactor-extract",
    description: "Extract code into a new module and rewire call sites — pure refactor, no behavior change.",
    body: [
      "Refactor: extract {{what}} out of `{{from_file}}` into a new module `{{to_file}}`.",
      "",
      "SCOPE: move {{what}} into `{{to_file}}`, update `{{from_file}}` to import it from",
      "there, and update all call sites ({{callers}}). This is a PURE refactor — no",
      "observable behavior change.",
      "",
      "FOLLOW THE REPO'S CONVENTIONS: match the existing module style and structure. A",
      "pure refactor that changes no observable behavior needs no docs edit — but if any",
      "documented public surface moves, update the project's docs in the same change.",
      "",
      "TESTS: the existing suite must stay green. Add a focused test if the extraction",
      "exposes a newly unit-testable unit.",
    ].join("\n"),
  },
  {
    name: "rollback",
    description: "Revert a merged task's changes through the standard pipeline, repairing any fallout so build + tests pass.",
    body: [
      "Revert the changes introduced by task {{task}} (commit {{sha}}).",
      "",
      "Prefer a clean `git revert` of that change. Then FIX any resulting breakage —",
      "dependents, tests, docs, and revert conflicts — so the tree is consistent: make",
      "the project's build and test suite green before calling request_review. If the",
      "reverted change altered a documented public surface, update the docs to match.",
      "",
      "FOLLOW THE REPO'S CONVENTIONS: match the surrounding code's style. butchr handles",
      "any CHANGELOG/version bookkeeping at merge from your request_review summary, so",
      "write a clear summary and don't hand-edit those files yourself.",
    ].join("\n"),
  },
];

/** The distinct placeholder names in a template body, in first-seen order. */
export function extractPlaceholders(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(PLACEHOLDER_RE)) {
    const key = m[1]!;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Look up a built-in template by name (null if unknown). */
export function getTemplate(name: string): Template | null {
  return TEMPLATES.find((t) => t.name === name) ?? null;
}

/** All templates with their placeholders extracted — the listing the CLI + webapp consume. */
export function listTemplates(): TemplateView[] {
  return TEMPLATES.map((t) => ({ ...t, placeholders: extractPlaceholders(t.body) }));
}

/**
 * Validate + normalize a `vars` map for substitution: must be a plain object whose
 * values coerce to strings (a missing/null map is the empty object). Rejects (400) a
 * non-object (array, string, …) so a malformed body surfaces clearly rather than
 * substituting garbage. Each value is coerced to a string (numbers/booleans welcome).
 */
export function validateVars(vars: unknown): Record<string, string> {
  if (vars === undefined || vars === null) return {};
  if (typeof vars !== "object" || Array.isArray(vars)) {
    throw new HttpError(400, "vars must be an object of string values");
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars as Record<string, unknown>)) {
    out[k] = String(v ?? "");
  }
  return out;
}

/**
 * Substitute `{{key}}` markers in `body` from `vars`. A key present in `vars` is
 * replaced (every occurrence); a key WITHOUT a value is left as the literal
 * `{{key}}` marker so the operator can see — and complete — what is still unfilled
 * (the webapp picker fills the textarea with this so the user finishes it; the CLI
 * leaves any un-supplied marker visible in the created prompt). Pure + exported so
 * it's unit-testable.
 */
export function substitute(body: string, vars: Record<string, string>): string {
  return body.replace(PLACEHOLDER_RE, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : whole,
  );
}

/**
 * Render a named template into a ready-to-use prompt: validate the vars map, then
 * substitute. Throws `HttpError(404)` (listing the known names) for an unknown
 * template, so the create route + CLI surface a clear error.
 */
export function renderTemplate(name: string, vars: unknown): string {
  const tpl = getTemplate(name);
  if (!tpl) {
    const known = TEMPLATES.map((t) => t.name).join(", ");
    throw new HttpError(404, `unknown template: ${name} (known: ${known})`);
  }
  return substitute(tpl.body, validateVars(vars));
}
