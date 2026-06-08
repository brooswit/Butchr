// Persistent server logging. Tees butchr's own console output to a rotating log
// file under the data dir, IN ADDITION to stdout/stderr, so logs survive
// restarts and detached runs. Dependency-free: a simple size-based rotation
// (butchr.log → butchr.log.1 → … → butchr.log.N) done synchronously on write.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { format } from "node:util";
import { config } from "./config.ts";

let logFile: string | null = null;
let installed = false;

// Rotate when the active log grows past the cap: shift butchr.log.(N-1)→.N, …,
// butchr.log.1→.2, then butchr.log→.1. Best-effort — any fs error is swallowed
// so logging never throws into the caller.
function rotateIfNeeded(): void {
  if (!logFile || config.logMaxBytes <= 0) return;
  let size: number;
  try {
    size = statSync(logFile).size;
  } catch {
    return; // no log yet
  }
  if (size < config.logMaxBytes) return;
  for (let i = config.logKeep - 1; i >= 1; i--) {
    try {
      renameSync(`${logFile}.${i}`, `${logFile}.${i + 1}`);
    } catch {
      /* gap in the chain — fine */
    }
  }
  try {
    renameSync(logFile, `${logFile}.1`);
  } catch {
    /* best effort */
  }
}

function writeLine(level: string, args: unknown[]): void {
  if (!logFile) return;
  rotateIfNeeded();
  const line = `${new Date().toISOString()} [${level}] ${format(...args)}\n`;
  try {
    appendFileSync(logFile, line);
  } catch {
    /* never let logging break the app */
  }
}

/**
 * Tee console.{log,info,warn,error,debug} to `config.logFile`. Idempotent; a
 * no-op when the path is empty. The original console methods still fire, so
 * stdout/stderr output is unchanged — the file is an additional sink.
 */
export function initFileLogging(): void {
  if (installed || !config.logFile) return;
  try {
    mkdirSync(dirname(config.logFile), { recursive: true });
  } catch {
    return; // can't create the dir — skip file logging rather than crash
  }
  logFile = config.logFile;
  installed = true;

  const wrap = (level: string, orig: (...a: any[]) => void) => {
    return (...args: any[]) => {
      orig(...args);
      writeLine(level, args);
    };
  };
  console.log = wrap("info", console.log.bind(console));
  console.info = wrap("info", console.info.bind(console));
  console.warn = wrap("warn", console.warn.bind(console));
  console.error = wrap("error", console.error.bind(console));
  console.debug = wrap("debug", console.debug.bind(console));

  console.log(`[butchr] logging to ${logFile}`);
}
