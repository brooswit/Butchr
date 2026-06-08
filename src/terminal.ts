// Open a GUI terminal attached to a running task's live herdr pane, so the
// operator can watch (or take over) the agent. butchr runs as a service started
// from the user's session, so it inherits DISPLAY and can spawn a terminal.
import { config } from "./config.ts";
import { run } from "./exec.ts";

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

async function have(bin: string): Promise<boolean> {
  const r = await run(["bash", "-lc", `command -v ${bin}`]);
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
 * first available emulator is used. Always returns the attach command so the UI
 * can offer a copyable fallback when no emulator is found / DISPLAY is unset.
 */
export async function openTerminal(argv: string[]): Promise<OpenResult> {
  const command = argv.join(" ");

  // Explicit override template.
  if (config.terminalCmd) {
    const quoted = argv.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(" ");
    const full = config.terminalCmd.replaceAll("{{CMD}}", quoted);
    try {
      Bun.spawn(["bash", "-lc", full], {
        stdio: ["ignore", "ignore", "ignore"],
        env: process.env as Record<string, string>,
      });
      return { ok: true, emulator: "BUTCHR_TERMINAL_CMD", command };
    } catch {
      return { ok: false, command };
    }
  }

  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return { ok: false, command };
  }

  for (const e of EMULATORS) {
    if (!(await have(e.bin))) continue;
    try {
      Bun.spawn(e.wrap(argv), {
        stdio: ["ignore", "ignore", "ignore"],
        env: process.env as Record<string, string>,
      });
      return { ok: true, emulator: e.bin, command };
    } catch {
      // try the next emulator
    }
  }
  return { ok: false, command };
}
