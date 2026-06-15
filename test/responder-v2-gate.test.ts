// RESPONDER-REDESIGN V2 — gate + additive schema (story st-def561dd, spine subtask 1).
// Asserts the SINGLE V2 gate (config.responderV2Enabled) defaults OFF and flips with the
// env var, and that the additive INERT columns (tasks.escalated_to_user, stories.pending_ask,
// stories.ask_responder) exist with the right defaults. Everything here is inert this phase —
// nothing reads the gate or the columns yet; the V1 responder model stays live.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let configMod: typeof import("../src/config.ts");
let dbMod: typeof import("../src/db.ts");

// The gate reads BUTCHR_RESPONDER_V2 at CALL TIME, so we save/restore the ambient value.
const SAVED = process.env.BUTCHR_RESPONDER_V2;

beforeAll(async () => {
  const DATA_DIR = mkdtempSync(join(tmpdir(), "butchr-rv2-data-"));
  process.env.BUTCHR_DATA_DIR = DATA_DIR;
  process.env.BUTCHR_DB = join(DATA_DIR, "test.db");
  process.env.BUTCHR_LOG_FILE = "";
  process.env.BUTCHR_HERDR_BIN = "true";
  delete process.env.BUTCHR_RESPONDER_V2;

  configMod = await import("../src/config.ts");
  dbMod = await import("../src/db.ts");
});

afterEach(() => {
  delete process.env.BUTCHR_RESPONDER_V2;
});

afterAll(() => {
  if (SAVED === undefined) delete process.env.BUTCHR_RESPONDER_V2;
  else process.env.BUTCHR_RESPONDER_V2 = SAVED;
});

describe("responderV2Enabled gate", () => {
  test("defaults to false when the env var is unset", () => {
    delete process.env.BUTCHR_RESPONDER_V2;
    expect(configMod.responderV2Enabled()).toBe(false);
  });

  test("flips to true for truthy env values, read at call time", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE", "On"]) {
      process.env.BUTCHR_RESPONDER_V2 = v;
      expect(configMod.responderV2Enabled()).toBe(true);
    }
  });

  test("stays false for falsey / garbage env values", () => {
    for (const v of ["0", "false", "no", "off", "", "nope"]) {
      process.env.BUTCHR_RESPONDER_V2 = v;
      expect(configMod.responderV2Enabled()).toBe(false);
    }
  });
});

describe("additive V2 schema columns (inert)", () => {
  const cols = (table: string): Set<string> =>
    new Set(
      dbMod.db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name),
    );

  test("tasks.escalated_to_user exists and defaults to 0", () => {
    expect(cols("tasks").has("escalated_to_user")).toBe(true);
    dbMod.db
      .query(
        `INSERT INTO workspaces (id, path, label, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run("rv2-ws", join(tmpdir(), "rv2-ws"), "rv2", dbMod.nowIso());
    dbMod.db
      .query(
        `INSERT INTO tasks (id, workspace_id, status, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run("rv2-task", "rv2-ws", "inactive", dbMod.nowIso());
    const row = dbMod.db
      .query<{ escalated_to_user: number }, [string]>(
        `SELECT escalated_to_user FROM tasks WHERE id=?`,
      )
      .get("rv2-task");
    expect(row?.escalated_to_user).toBe(0);
  });

  test("stories.pending_ask + ask_responder exist and default to NULL", () => {
    const storyCols = cols("stories");
    expect(storyCols.has("pending_ask")).toBe(true);
    expect(storyCols.has("ask_responder")).toBe(true);
    dbMod.db
      .query(
        `INSERT INTO stories (id, workspace_id, brief, status, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("rv2-story", "rv2-ws", "brief", "open", dbMod.nowIso());
    const row = dbMod.db
      .query<{ pending_ask: string | null; ask_responder: string | null }, [string]>(
        `SELECT pending_ask, ask_responder FROM stories WHERE id=?`,
      )
      .get("rv2-story");
    expect(row?.pending_ask).toBeNull();
    expect(row?.ask_responder).toBeNull();
  });
});
