// Open a GUI terminal attached to a running task's live herdr pane, so the
// operator can watch (or take over) the agent. butchr is normally started as a
// systemd USER service, which — unlike a process launched from the graphical
// session — does NOT inherit DISPLAY / XAUTHORITY / WAYLAND_DISPLAY. So we can't
// assume `process.env.DISPLAY` is set: when it (and WAYLAND_DISPLAY) are unset we
// DISCOVER the active session's display (via loginctl, or an X socket under
// /tmp/.X11-unix) and inject it into the emulator's env, rather than giving up and
// showing the manual-command fallback. Discovery is best-effort and bounded — it
// never throws and never hangs.
import { config } from "./config.ts";
import { run as realRun } from "./exec.ts";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The herdr command that attaches to a task's agent terminal. */
export function attachArgv(taskId: string): string[] {
  return [config.herdrBin, "agent", "attach", taskId];
}

// Detected GUI terminal emulators, in preference order, with how each wraps a
// command argv. kitty/konsole first: they reliably spawn a standalone window
// when launched from a background service. gnome-terminal is deprioritized
// because, started from a daemon, it hands off to gnome-terminal-server and
// often fails to map a visible window.
const EMULATORS: { bin: string; wrap: (argv: string[]) => string[] }[] = [
  { bin: "kitty", wrap: (a) => ["kitty", ...a] },
  { bin: "konsole", wrap: (a) => ["konsole", "-e", ...a] },
  { bin: "alacritty", wrap: (a) => ["alacritty", "-e", ...a] },
  { bin: "xfce4-terminal", wrap: (a) => ["xfce4-terminal", "-x", ...a] },
  { bin: "xterm", wrap: (a) => ["xterm", "-e", ...a] },
  { bin: "gnome-terminal", wrap: (a) => ["gnome-terminal", "--wait", "--", ...a] },
  { bin: "x-terminal-emulator", wrap: (a) => ["x-terminal-emulator", "-e", ...a] },
];

// Max wall-clock for any discovery subprocess (loginctl). Bounded so a wedged
// helper can never hang the terminal-open request.
const DISCOVER_TIMEOUT_MS = 2000;

// Injectable seams so the discovery + spawn path can be exercised without a real
// loginctl / X server / GUI. Real implementations are the defaults; tests swap
// them via setTerminalDeps() and reset with a bare setTerminalDeps().
type Deps = {
  // Bounded subprocess runner (mirrors exec.run's signature).
  run: typeof realRun;
  // Spawn a detached GUI process with the given env; true on success, false on throw.
  spawn: (argv: string[], env: Record<string, string>) => boolean;
  // X server socket names under /tmp/.X11-unix (e.g. ["X0","X1"]); [] if none/unreadable.
  listX11Sockets: () => string[];
  // Whether a path exists (used to pick an XAUTHORITY default).
  exists: (path: string) => boolean;
};

const realSpawn = (argv: string[], env: Record<string, string>): boolean => {
  try {
    Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"], env });
    return true;
  } catch {
    return false;
  }
};

const realListX11Sockets = (): string[] => {
  try {
    return readdirSync("/tmp/.X11-unix");
  } catch {
    return [];
  }
};

const realExists = (path: string): boolean => {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
};

const defaultDeps: Deps = {
  run: realRun,
  spawn: realSpawn,
  listX11Sockets: realListX11Sockets,
  exists: realExists,
};

let deps: Deps = defaultDeps;

/**
 * TEST SEAM: override the subprocess / filesystem / spawn dependencies used by
 * discovery. Pass a partial set; anything omitted falls back to the real
 * implementation. Call with no argument to fully reset.
 */
export function setTerminalDeps(overrides?: Partial<Deps>): void {
  deps = { ...defaultDeps, ...overrides };
}

/** The graphical-session env discovered for a service that didn't inherit it. */
type DisplayEnv = { DISPLAY?: string; WAYLAND_DISPLAY?: string; XAUTHORITY?: string };

/** Parse `Key=Value` lines (loginctl --property output) into a map. */
function parseProps(out: string): Record<string, string> {
  const m: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) m[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return m;
}

/**
 * Best-effort discovery of the active graphical session's display vars, for when
 * butchr runs as a systemd --user service that didn't inherit DISPLAY /
 * WAYLAND_DISPLAY. Strategy, in order:
 *   1. loginctl: resolve the user's graphical session (`show-user … Display`),
 *      then read that session's Type + Display (`show-session`). An x11 session
 *      yields a `:N` DISPLAY; a wayland session yields a WAYLAND_DISPLAY.
 *   2. fallback: scan /tmp/.X11-unix for an `XN` socket → `:N`.
 * Plus an XAUTHORITY default (~/.Xauthority) when an X DISPLAY is found and the
 * file exists. Returns null when nothing is discoverable. Never throws; every
 * subprocess is timeout-bounded.
 */
async function discoverDisplay(): Promise<DisplayEnv | null> {
  const found: DisplayEnv = {};

  // 1. loginctl — the user's active graphical session.
  try {
    const user = process.env.USER || process.env.LOGNAME || "";
    if (user) {
      const u = await deps.run(
        ["loginctl", "show-user", user, "--property=Display", "--value"],
        { timeoutMs: DISCOVER_TIMEOUT_MS },
      );
      const sessionId = u.ok ? u.stdout.trim() : "";
      if (sessionId) {
        const s = await deps.run(
          ["loginctl", "show-session", sessionId, "-p", "Type", "-p", "Display"],
          { timeoutMs: DISCOVER_TIMEOUT_MS },
        );
        if (s.ok) {
          const props = parseProps(s.stdout);
          if (props.Display) found.DISPLAY = props.Display;
          if (props.Type === "wayland" && !found.WAYLAND_DISPLAY) {
            // The session Display is unset for wayland; wayland-0 is the near-universal
            // default socket name (honor an already-set WAYLAND_DISPLAY if present).
            found.WAYLAND_DISPLAY = process.env.WAYLAND_DISPLAY || "wayland-0";
          }
        }
      }
    }
  } catch {
    // best-effort: fall through to the socket scan
  }

  // 2. Fallback: an X server socket under /tmp/.X11-unix → ":N".
  if (!found.DISPLAY && !found.WAYLAND_DISPLAY) {
    const sock = deps
      .listX11Sockets()
      .filter((n) => /^X\d+$/.test(n))
      .sort()[0];
    if (sock) found.DISPLAY = ":" + sock.slice(1);
  }

  if (!found.DISPLAY && !found.WAYLAND_DISPLAY) return null;

  // XAUTHORITY for an X session: inherit it if set, else default to ~/.Xauthority
  // when it exists (an emulator can't authenticate to the X server without it).
  if (found.DISPLAY) {
    const xauth = process.env.XAUTHORITY || join(homedir(), ".Xauthority");
    if (deps.exists(xauth)) found.XAUTHORITY = xauth;
  }
  return found;
}

/** Drop undefined-valued keys so a merge doesn't shadow real env with `undefined`. */
function compact(e: DisplayEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(e)) if (v) out[k] = v;
  return out;
}

/**
 * The env an emulator is spawned with. If the process already has a display
 * (DISPLAY or WAYLAND_DISPLAY), use process.env unchanged. Otherwise discover the
 * active session's display and merge it in — so a systemd --user service that
 * didn't inherit the graphical env can still open a window. When discovery finds
 * nothing, process.env is returned as-is (the emulator path then declines).
 */
async function resolveSpawnEnv(): Promise<Record<string, string>> {
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    return process.env as Record<string, string>;
  }
  const found = await discoverDisplay();
  if (!found) return process.env as Record<string, string>;
  return { ...(process.env as Record<string, string>), ...compact(found) };
}

async function have(bin: string): Promise<boolean> {
  const r = await deps.run(["bash", "-lc", `command -v ${bin}`]);
  return r.ok && r.stdout.trim().length > 0;
}

export type OpenResult = {
  ok: boolean;
  emulator?: string;
  command: string; // the attach command, for manual fallback
};

/**
 * Spawn a GUI terminal running `argv`. If BUTCHR_TERMINAL_CMD is set it is used
 * as a template (`{{CMD}}` → the shell-quoted attach command); otherwise the
 * first available emulator is used. When the process inherited no display, the
 * active session's DISPLAY/XAUTHORITY (or WAYLAND_DISPLAY) is discovered and
 * injected into the spawned process's env. Always returns the attach command so
 * the UI can offer a copyable fallback when no emulator is found / no display is
 * discoverable.
 */
export async function openTerminal(argv: string[]): Promise<OpenResult> {
  const command = argv.join(" ");

  // Resolve the spawn env once (discovering a display if we didn't inherit one),
  // so BOTH the override template and the emulator path get it injected.
  const env = await resolveSpawnEnv();

  // Explicit override template. Attempted regardless of display (the operator's
  // command may not need one, e.g. `ssh -X` or a tmux popup).
  if (config.terminalCmd) {
    const quoted = argv.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(" ");
    const full = config.terminalCmd.replaceAll("{{CMD}}", quoted);
    if (deps.spawn(["bash", "-lc", full], env)) {
      return { ok: true, emulator: "BUTCHR_TERMINAL_CMD", command };
    }
    return { ok: false, command };
  }

  // No display inherited and none discoverable → can't map a window; let the UI
  // show the manual command.
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return { ok: false, command };
  }

  for (const e of EMULATORS) {
    if (!(await have(e.bin))) continue;
    if (deps.spawn(e.wrap(argv), env)) {
      return { ok: true, emulator: e.bin, command };
    }
    // try the next emulator
  }
  return { ok: false, command };
}
