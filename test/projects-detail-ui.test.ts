// Story st-04869886 (S3): the project DETAIL view resolves each member repo's display
// name/dir against GET /api/workspaces, because listProjectRepos returns work_kind='repo'
// task rows (id === directory id) with NO path/label of their own. This guards the pure
// resolution helper — especially the DEFENSIVE FALLBACK: a member repo whose id isn't in
// the workspaces list must still render honestly (from its id/brief) instead of blanking
// the panel or throwing on basename(undefined).
//
// repoDisplay/basenameOf now live in public/core/format.js — pure display formatters, no
// DOM and no module state — so we IMPORT them directly and assert on the real exports.
// (They used to be fenced by `<test-extract:projects-repo-display>` sentinels inside the
// classic public/app.js script and eval'd out with `new Function`, because that script
// could not be imported. That harness is gone, along with the sentinel — do not
// reintroduce one. Same approach as test/kind-badge.test.ts and
// test/graph-rollup-completion.test.ts.)
import { expect, test } from "bun:test";
import { basenameOf, repoDisplay } from "../public/core/format.js";

function wsMap(rows: Array<{ id: string; path?: string | null; label?: string | null }>) {
  return new Map(rows.map((r) => [r.id, r]));
}

test("basenameOf: last non-empty segment, trailing-slash tolerant", () => {
  expect(basenameOf("/home/dev/acme/web")).toBe("web");
  expect(basenameOf("/home/dev/acme/web/")).toBe("web");
  expect(basenameOf("web")).toBe("web");
  expect(basenameOf("")).toBe("");
  expect(basenameOf(null)).toBe("");
  expect(basenameOf(undefined)).toBe("");
});

test("repoDisplay: prefers the workspace label, then the path basename", () => {
  const ws = wsMap([
    { id: "dir-1", path: "/home/dev/acme/web", label: "web-frontend" },
    { id: "dir-2", path: "/home/dev/acme/api", label: null },
  ]);
  expect(repoDisplay({ id: "dir-1" }, ws)).toEqual({ name: "web-frontend", dir: "/home/dev/acme/web" });
  // no label → basename of the path
  expect(repoDisplay({ id: "dir-2" }, ws)).toEqual({ name: "api", dir: "/home/dev/acme/api" });
});

test("repoDisplay: DEFENSIVE fallback when the repo id isn't in the workspaces list", () => {
  const ws = wsMap([{ id: "dir-1", path: "/home/dev/acme/web", label: "web" }]);
  // A stale/filtered directory: not in the map. Must NOT throw on basename(undefined) —
  // renders from brief (preferred) or the id, and uses the id as the dir.
  expect(repoDisplay({ id: "dir-missing", brief: "legacy service" }, ws))
    .toEqual({ name: "legacy service", dir: "dir-missing" });
  // no brief either → the id is the honest last resort for both fields
  expect(repoDisplay({ id: "dir-missing" }, ws))
    .toEqual({ name: "dir-missing", dir: "dir-missing" });
});

test("repoDisplay: workspace present but path/label empty → id last resort", () => {
  const ws = wsMap([{ id: "dir-3", path: "", label: "" }]);
  expect(repoDisplay({ id: "dir-3" }, ws)).toEqual({ name: "dir-3", dir: "dir-3" });
});
