// F2 + F3 (story st-2a4aa7dc) — the exported config.envInt helper.
//
//  F2 — interval knobs are floor-clamped AT THE CONFIG SOURCE (via the {min} option)
//       so a 0/negative env override can't create a dispatcher/supervise/connectivity
//       tight loop (setInterval(fn,0) re-fires as fast as possible). The clamped value
//       IS what setInterval receives, so asserting envInt's return value asserts the
//       EFFECTIVE interval.
//  F3 — envInt rejects a non-fully-numeric value (falling back to the default) instead
//       of parseInt's silent truncation (47800abc → 47800) or silent fallback (abc).
//
// envInt reads process.env at CALL time, so we set/clear the var per assertion.
import { afterEach, describe, expect, test } from "bun:test";
import { envInt } from "../src/config.ts";

const KEY = "BUTCHR_TEST_ENVINT";

afterEach(() => {
  delete process.env[KEY];
});

describe("F2 — {min} floor-clamps interval knobs at the source", () => {
  test("0 / negative / below-floor values clamp UP to the minimum", () => {
    process.env[KEY] = "0";
    expect(envInt(KEY, 1500, { min: 250 })).toBe(250);
    process.env[KEY] = "-5";
    expect(envInt(KEY, 1500, { min: 250 })).toBe(250);
    process.env[KEY] = "100"; // positive but below the floor
    expect(envInt(KEY, 1500, { min: 250 })).toBe(250);
  });

  test("a value at/above the floor passes through unchanged", () => {
    process.env[KEY] = "250";
    expect(envInt(KEY, 1500, { min: 250 })).toBe(250);
    process.env[KEY] = "5000";
    expect(envInt(KEY, 1500, { min: 250 })).toBe(5000);
  });

  test("an unset var falls back to the default, ALSO floor-clamped", () => {
    // A default below the floor would itself be lifted (defensive); our real knobs
    // all default above their floors, so this just confirms the fallback path clamps.
    expect(envInt(KEY, 100, { min: 250 })).toBe(250);
    expect(envInt(KEY, 1500, { min: 250 })).toBe(1500);
  });

  test("the live interval knobs are clamped on the config object", async () => {
    const { config } = await import("../src/config.ts");
    expect(config.tickMs).toBeGreaterThanOrEqual(250);
    expect(config.ctoSuperviseMs).toBeGreaterThanOrEqual(1000);
    expect(config.connectivityIntervalMs).toBeGreaterThanOrEqual(1000);
  });
});

describe("F3 — envInt rejects trailing garbage / non-numeric values", () => {
  test("trailing garbage falls back to the default (NOT a silent truncation)", () => {
    process.env[KEY] = "47800abc";
    expect(envInt(KEY, 999)).toBe(999); // parseInt would have yielded 47800
  });

  test("a purely non-numeric value falls back to the default", () => {
    process.env[KEY] = "abc";
    expect(envInt(KEY, 999)).toBe(999);
  });

  test("a clean integer (with surrounding whitespace) still parses", () => {
    process.env[KEY] = "47800";
    expect(envInt(KEY, 999)).toBe(47800);
    process.env[KEY] = "  42  ";
    expect(envInt(KEY, 999)).toBe(42);
  });

  test("a signed integer parses; an unset/blank var uses the default", () => {
    process.env[KEY] = "-7";
    expect(envInt(KEY, 999)).toBe(-7);
    delete process.env[KEY];
    expect(envInt(KEY, 999)).toBe(999);
    process.env[KEY] = "";
    expect(envInt(KEY, 999)).toBe(999);
  });

  test("a non-numeric value combined with {min} still falls back, then clamps", () => {
    process.env[KEY] = "garbage";
    expect(envInt(KEY, 1500, { min: 250 })).toBe(1500);
  });
});
