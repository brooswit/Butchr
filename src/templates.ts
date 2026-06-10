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
import { HttpError } from "./directories.ts";

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

// The built-in templates. Each body captures the boilerplate of a task shape we
// actually create — the READ-FIRST / SCOPE / FOLLOW-CONTRIBUTING / zero-deps /
// add-tests skeleton — so a new task only has to fill the `{{placeholders}}`.
export const TEMPLATES: Template[] = [
  {
    name: "feature",
    description: "A new feature: read-first, scope, follow-CONTRIBUTING, zero-deps, add tests.",
    body: [
      "{{title}}",
      "",
      "READ FIRST: {{read_first}}",
      "",
      "REQUIREMENTS: {{requirements}}",
      "",
      "SCOPE: {{scope}}",
      "",
      "FOLLOW CONTRIBUTING.md: zero new dependencies (Bun stdlib only); match the",
      "surrounding module's style and import with the `.ts` extension. Update SPEC.md",
      "in the SAME change to reflect the new/changed behavior — butchr records the",
      "CHANGELOG entry + version bump at merge from your request_review summary, so do",
      "NOT hand-edit CHANGELOG.md / package.json.",
      "",
      "TESTS: add tests alongside the feature (test/*.test.ts) covering the new",
      "behavior. Make `bun build src/index.ts --target bun --outfile /dev/null` and",
      "`bun test` both green before calling request_review.",
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
      "FOLLOW CONTRIBUTING.md: zero new dependencies; match the existing module style",
      "and import with the `.ts` extension. A pure-internal refactor that changes no",
      "observable behavior needs no SPEC.md edit — but if any public surface (a route,",
      "SSE event, config var, or DB column) moves, update SPEC.md in the same change.",
      "",
      "TESTS: the existing suite must stay green —",
      "`bun build src/index.ts --target bun --outfile /dev/null` and `bun test`. Add a",
      "focused test if the extraction exposes a newly unit-testable unit.",
    ].join("\n"),
  },
  {
    name: "webapp-panel",
    description: "Add a vanilla-JS webapp panel/view consuming the existing REST + SSE contract.",
    body: [
      "Add a webapp panel: {{panel}}.",
      "",
      "READ FIRST: public/app.js, public/index.html, public/style.css, and SPEC.md §6.5",
      "(Webapp).",
      "",
      "SCOPE: render {{panel}} showing {{data}}, placed {{location}}. Vanilla JS only —",
      "no framework, no build step. Consume the existing REST + /api/events SSE",
      "contract; if you need data the API does not expose yet, add the route first (and",
      "its SPEC.md §6.1 entry).",
      "",
      "FOLLOW CONTRIBUTING.md: zero new dependencies; match the hash-routed, SSE-driven",
      "style of app.js and the existing style.css conventions. Update SPEC.md §6.5 to",
      "note the new view.",
      "",
      "TESTS: keep `bun build src/index.ts --target bun --outfile /dev/null` and",
      "`bun test` green.",
    ].join("\n"),
  },
  {
    name: "rollback",
    description: "Revert a merged task's changes through the standard pipeline, repairing any fallout so build + tests pass.",
    body: [
      "Revert the changes introduced by task {{task}} (commit {{sha}}).",
      "",
      "Prefer a clean `git revert` of that change. Then FIX any resulting breakage —",
      "dependents, tests, docs, and revert conflicts — so the tree is consistent:",
      "make `bun build src/index.ts --target bun --outfile /dev/null` and `bun test`",
      "both green before calling request_review. Update SPEC.md if the reverted change",
      "altered behavior the spec documents.",
      "",
      "FOLLOW CONTRIBUTING.md: zero new dependencies (Bun stdlib only); match the",
      "surrounding module's style and import with the `.ts` extension. butchr records",
      "the CHANGELOG entry + version bump at merge from your request_review summary, so",
      "do NOT hand-edit CHANGELOG.md / package.json.",
    ].join("\n"),
  },
  {
    name: "add-endpoint",
    description: "Add a REST endpoint: thin handler over a service function, with SPEC + a test.",
    body: [
      "Add a REST endpoint: {{method}} {{path}}.",
      "",
      "READ FIRST: src/server.ts (route registration + the json/readJson/HttpError",
      "helpers), the relevant service module, and SPEC.md §6.1 (REST API).",
      "",
      "SCOPE: register `route(\"{{method}}\", \"{{path}}\", ...)` in src/server.ts that",
      "{{behavior}}. Keep the handler THIN — validate input, call the service function",
      "({{service_fn}}) in tasks.ts/directories.ts, return json(...). Throw HttpError on",
      "failure (404/400/409). Return the canonical projection (taskView / DirectoryView)",
      "rather than a raw DB row.",
      "",
      "FOLLOW CONTRIBUTING.md: zero new dependencies. Add the route to the SPEC.md §6.1",
      "table; if it should be drivable from the shell, add a bin/butchr subcommand that",
      "maps onto exactly this route (no extra server logic).",
      "",
      "TESTS: add a test exercising the endpoint/service behavior. Make",
      "`bun build src/index.ts --target bun --outfile /dev/null` and `bun test` green.",
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
