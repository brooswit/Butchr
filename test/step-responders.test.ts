// Tests for the PER-WORKSPACE STEP-RESPONDER config (the feedback-workflow
// foundation): the `workspaces.step_responders` JSON column + the read helper
// (responderFor / resolveStepResponders) + the validated partial setter
// (updateWorkspaceStepResponders) + the resolved detail view (workspaceDetail).
// CONFIG ONLY — nothing routes off it yet; these tests pin the storage/read/validate
// contract the later routing tasks consume.
//
// Pure / in-process: no real claude/herdr is spawned (BUTCHR_HERDR_BIN → `true`), and
// workspace rows are inserted directly (no registerWorkspace, which needs a live
// herdr). The db/config singletons are shared across test files, so ids are distinct.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let DATA_DIR: string;
let REPO_ROOT: string;
const DIR_A = "resp-dir-a";
const DIR_B = "resp-dir-b";

let dirsMod: typeof import("../src/workspaces.ts");
let dbMod: typeof import("../src/db.ts");

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-resp-data-"));
  REPO_ROOT = mkdtempSync(join(tmpdir(), "butchr-resp-repo-"));

  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";

  dbMod = await import("../src/db.ts");
  dirsMod = await import("../src/workspaces.ts");

  const ins = (id: string) =>
    dbMod.db
      .query(`INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, join(REPO_ROOT, id), id, dbMod.nowIso());
  ins(DIR_A);
  ins(DIR_B);
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

// Read the raw stored JSON column for a workspace (to assert normalization).
function rawColumn(id: string): string | null {
  return dbMod.db
    .query<{ step_responders: string | null }, [string]>(
      `SELECT step_responders FROM workspaces WHERE id=?`,
    )
    .get(id)!.step_responders;
}

describe("step set", () => {
  test("RESPONDER_STEPS is exactly the six canonical steps", () => {
    expect([...dirsMod.RESPONDER_STEPS]).toEqual([
      "spec-generation",
      "spec-approval",
      "plan-approval",
      "diff-review",
      "answer-question",
      "idle-handling",
    ]);
  });

  test("isResponderStep validates membership", () => {
    expect(dirsMod.isResponderStep("diff-review")).toBe(true);
    expect(dirsMod.isResponderStep("nope")).toBe(false);
  });
});

describe("responderFor resolution", () => {
  test("an unset step defaults to cto", () => {
    expect(dirsMod.responderFor(DIR_A, "spec-approval")).toBe("cto");
  });

  test("an unknown workspace id defaults to cto", () => {
    expect(dirsMod.responderFor("does-not-exist", "diff-review")).toBe("cto");
  });

  test("an unknown STEP NAME throws (programming error)", () => {
    // Cast through any — TS would normally reject a non-step at the call site.
    expect(() => dirsMod.responderFor(DIR_A, "bogus-step" as any)).toThrow(/unknown responder step/);
  });

  test("returns a configured override once set", () => {
    dirsMod.updateWorkspaceStepResponders(DIR_A, { "diff-review": "user" });
    expect(dirsMod.responderFor(DIR_A, "diff-review")).toBe("user");
    // Other steps remain cto.
    expect(dirsMod.responderFor(DIR_A, "spec-approval")).toBe("cto");
  });

  test("never throws on corrupt/legacy stored data — falls back to cto", () => {
    // Hand-write garbage that bypasses the validated setter.
    const cases = ["not json", "[]", '{"diff-review":"robot"}', '{"unknown-step":"user"}', "null"];
    for (const bad of cases) {
      dbMod.db.query(`UPDATE workspaces SET step_responders=? WHERE id=?`).run(bad, DIR_B);
      expect(dirsMod.responderFor(DIR_B, "diff-review")).toBe("cto");
      // resolveStepResponders is equally tolerant — a full all-cto map.
      const resolved = dirsMod.resolveStepResponders(DIR_B);
      for (const step of dirsMod.RESPONDER_STEPS) expect(resolved[step]).toBe("cto");
    }
    // Reset DIR_B to a clean slate for later tests.
    dbMod.db.query(`UPDATE workspaces SET step_responders=NULL WHERE id=?`).run(DIR_B);
  });
});

describe("resolveStepResponders / workspaceDetail", () => {
  test("resolveStepResponders fills every step with its effective value", () => {
    dirsMod.updateWorkspaceStepResponders(DIR_B, { "answer-question": "user" });
    const map = dirsMod.resolveStepResponders(DIR_B);
    expect(Object.keys(map).sort()).toEqual([...dirsMod.RESPONDER_STEPS].sort());
    expect(map["answer-question"]).toBe("user");
    expect(map["spec-generation"]).toBe("cto");
  });

  test("workspaceDetail attaches the resolved map (overriding the raw column) + 404s when gone", () => {
    const detail = dirsMod.workspaceDetail(DIR_B);
    expect(detail.id).toBe(DIR_B);
    expect(detail.counts).toBeTruthy();
    expect(detail.step_responders["answer-question"]).toBe("user");
    expect(detail.step_responders["diff-review"]).toBe("cto");
    expect(() => dirsMod.workspaceDetail("nope")).toThrow(/workspace not found/);
  });
});

describe("updateWorkspaceStepResponders normalization + validation", () => {
  test("merges partial updates onto existing overrides", () => {
    dirsMod.updateWorkspaceStepResponders(DIR_A, { "spec-generation": "user" });
    // The earlier diff-review override is preserved by the merge.
    expect(dirsMod.responderFor(DIR_A, "diff-review")).toBe("user");
    expect(dirsMod.responderFor(DIR_A, "spec-generation")).toBe("user");
  });

  test("a redundant cto value is dropped from storage (normalized away)", () => {
    dirsMod.updateWorkspaceStepResponders(DIR_A, { "spec-generation": "cto" });
    expect(dirsMod.responderFor(DIR_A, "spec-generation")).toBe("cto");
    const stored = JSON.parse(rawColumn(DIR_A)!);
    expect("spec-generation" in stored).toBe(false);
    // diff-review (user) is still stored.
    expect(stored["diff-review"]).toBe("user");
  });

  test("clearing the last override stores NULL (= all cto)", () => {
    dirsMod.updateWorkspaceStepResponders(DIR_A, { "diff-review": "cto" });
    expect(rawColumn(DIR_A)).toBeNull();
    for (const step of dirsMod.RESPONDER_STEPS) {
      expect(dirsMod.responderFor(DIR_A, step)).toBe("cto");
    }
  });

  test("rejects an unknown step name (400)", () => {
    expect(() => dirsMod.updateWorkspaceStepResponders(DIR_A, { "bogus": "user" }))
      .toThrow(/unknown responder step/);
  });

  test("rejects a bad responder value (400)", () => {
    expect(() => dirsMod.updateWorkspaceStepResponders(DIR_A, { "diff-review": "robot" }))
      .toThrow(/must be 'cto' or 'user'/);
  });

  test("rejects a non-object patch (400)", () => {
    expect(() => dirsMod.updateWorkspaceStepResponders(DIR_A, "nope")).toThrow(/must be an object/);
    expect(() => dirsMod.updateWorkspaceStepResponders(DIR_A, [])).toThrow(/must be an object/);
  });

  test("404s on an unknown workspace", () => {
    expect(() => dirsMod.updateWorkspaceStepResponders("nope", { "diff-review": "user" }))
      .toThrow(/workspace not found/);
  });
});
