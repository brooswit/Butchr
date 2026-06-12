// Tests for the "open terminal" DISPLAY-DISCOVERY path (src/terminal.ts).
//
// butchr usually runs as a systemd --user service, which does NOT inherit
// DISPLAY/XAUTHORITY/WAYLAND_DISPLAY from the graphical session. openTerminal()
// therefore can't assume process.env.DISPLAY is set: when it (and
// WAYLAND_DISPLAY) are unset it DISCOVERS the active session's display (via
// loginctl, or an X socket under /tmp/.X11-unix) and injects it into the spawned
// emulator's env. These tests drive that path through the injectable
// setTerminalDeps() seam — no real loginctl, X server, GUI, or subprocess.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setTerminalDeps, openTerminal } from "../src/terminal.ts";
import type { ExecResult } from "../src/exec.ts";

const ARGV = ["herdr", "agent", "attach", "swift-falcon-3a2f"];
const OK = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "", ok: true });
const FAIL = (): ExecResult => ({ code: 1, stdout: "", stderr: "", ok: false });

// Saved real graphical-env values, blanked per-test so discovery actually runs,
// and restored afterward so we don't perturb other suites / the host env.
let savedDisplay: string | undefined;
let savedWayland: string | undefined;
let savedXauth: string | undefined;

beforeEach(() => {
  savedDisplay = process.env.DISPLAY;
  savedWayland = process.env.WAYLAND_DISPLAY;
  savedXauth = process.env.XAUTHORITY;
  delete process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
  delete process.env.XAUTHORITY;
  process.env.USER = process.env.USER || "tester";
});

afterEach(() => {
  setTerminalDeps(); // reset to real deps
  const restore = (k: string, v: string | undefined) =>
    v === undefined ? delete process.env[k] : (process.env[k] = v);
  restore("DISPLAY", savedDisplay);
  restore("WAYLAND_DISPLAY", savedWayland);
  restore("XAUTHORITY", savedXauth);
});

/** A fake run() that answers `command -v <emulator>` and the two loginctl probes. */
function fakeRun(opts: {
  availableEmulator?: string; // which emulator `command -v` reports as present
  loginctl?: { sessionId?: string; type?: string; display?: string } | null;
}) {
  return async (cmd: string[]): Promise<ExecResult> => {
    const joined = cmd.join(" ");
    // `bash -lc "command -v <bin>"`
    if (cmd[0] === "bash" && /command -v /.test(joined)) {
      const bin = joined.split("command -v ")[1]!.trim();
      return bin === opts.availableEmulator ? OK("/usr/bin/" + bin) : FAIL();
    }
    if (cmd[0] === "loginctl") {
      if (!opts.loginctl) return FAIL();
      if (cmd[1] === "show-user") return OK((opts.loginctl.sessionId ?? "") + "\n");
      if (cmd[1] === "show-session") {
        return OK(
          `Type=${opts.loginctl.type ?? ""}\nDisplay=${opts.loginctl.display ?? ""}\n`,
        );
      }
    }
    return FAIL();
  };
}

describe("openTerminal display discovery", () => {
  test("discovers an X11 DISPLAY via loginctl and injects DISPLAY+XAUTHORITY", async () => {
    const spawned: { argv: string[]; env: Record<string, string> }[] = [];
    setTerminalDeps({
      run: fakeRun({
        availableEmulator: "kitty",
        loginctl: { sessionId: "2", type: "x11", display: ":0" },
      }),
      spawn: (argv, env) => {
        spawned.push({ argv, env });
        return true;
      },
      listX11Sockets: () => [], // force the loginctl path to be the source
      exists: () => true, // ~/.Xauthority "exists"
    });

    const res = await openTerminal(ARGV);

    expect(res.ok).toBe(true);
    expect(res.emulator).toBe("kitty");
    expect(spawned.length).toBe(1);
    expect(spawned[0]!.argv).toEqual(["kitty", ...ARGV]);
    // The discovered display was injected into the emulator's env.
    expect(spawned[0]!.env.DISPLAY).toBe(":0");
    expect(spawned[0]!.env.XAUTHORITY).toBe(`${process.env.HOME}/.Xauthority`);
  });

  test("falls back to an X socket under /tmp/.X11-unix when loginctl yields nothing", async () => {
    const spawned: { argv: string[]; env: Record<string, string> }[] = [];
    setTerminalDeps({
      run: fakeRun({ availableEmulator: "kitty", loginctl: null }),
      spawn: (argv, env) => {
        spawned.push({ argv, env });
        return true;
      },
      listX11Sockets: () => ["X1", "X0"], // unsorted on purpose → lowest wins (:0)
      exists: () => false, // no XAUTHORITY available
    });

    const res = await openTerminal(ARGV);

    expect(res.ok).toBe(true);
    expect(spawned[0]!.env.DISPLAY).toBe(":0");
    expect(spawned[0]!.env.XAUTHORITY).toBeUndefined();
  });

  test("returns ok:false + the manual command when no display is discoverable", async () => {
    setTerminalDeps({
      run: fakeRun({ availableEmulator: "kitty", loginctl: null }),
      spawn: () => {
        throw new Error("spawn must not be called when no display is found");
      },
      listX11Sockets: () => [], // nothing in /tmp/.X11-unix
      exists: () => false,
    });

    const res = await openTerminal(ARGV);

    expect(res.ok).toBe(false);
    expect(res.command).toBe(ARGV.join(" ")); // copyable fallback
    expect(res.emulator).toBeUndefined();
  });
});
