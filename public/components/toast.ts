// The transient TOAST surface — the one-line banner that confirms an action or reports an error.
//
// It lived in core/api.js until the RFC Phase 2 horizontal split. `toast` builds and appends DOM
// nodes, so its presence there was the single reason `core/` was NOT framework-agnostic: the chain
// core/state-meta -> core/api -> core/dom.js dragged the DOM layer into the two purest core
// leaves. Moving it here severs that edge — core/api.ts now holds only the `api()` fetch wrapper,
// and core/dom.js is reachable only from components/ and views/ (RFC §0.1 #2, #3).
//
// DOM-free at module load, like everything under components/: `document` is touched only INSIDE a
// called function.
//
// >>> THE PHASE-3 SINK STAYS, AND THIS IS PHASE 4a's ONE DELIBERATE DEPARTURE FROM THE SALVAGE. <<<
// The abandoned Phase-4 branch rewrote this module into a two-line adapter over @launchpad-ui's
// `toastQueue`, deleting `setToastSink` and the vanilla fallback. That is the correct END state and
// it is WRONG NOW: this slice is a type port with zero UI change, and every reason the sink exists
// is still true.
//
//   • Seven vanilla views still call `toast()`, and App.tsx still calls `setToastSink(...)` at mount
//     and `setToastSink(null)` at unmount. Deleting the export breaks the build outright.
//   • Importing @launchpad-ui here would drag React and a CSS import into the module graph of every
//     `views/*.js` — and of the six tests that import those views directly with no DOM.
//
// The sink dies in Phase 4e, with the last vanilla view. Until then: null sink = the vanilla
// `.toast` div, which is what `bun test` sees and what a bridge-less page falls back to.
import { el } from "../core/dom.js";
import type { TerminalResult } from "../core/types.js";

/** `(msg, isErr) => void`, or null for the vanilla `.toast` div. Set by App.tsx's shell. */
export type ToastSink = ((msg: string, isErr: boolean) => void) | null;

let sink: ToastSink = null;
export function setToastSink(fn: ToastSink): void {
  sink = fn;
}

// Module-private: only toast() reads or clears it, so it is deliberately not exported.
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string, isErr?: boolean): void {
  if (sink) {
    sink(msg, !!isErr);
    return;
  }
  const old = document.querySelector(".toast");
  if (old) old.remove();
  // `[msg]`, not `msg`. Identical at runtime — el() normalises its children with `[].concat(children)`,
  // and `[].concat("x")` is `["x"]` — but el()'s `children = []` default makes tsc infer `any[]`, and a
  // bare string is now a type error where the untyped .js caller was silently fine.
  const t = el("div", { class: "toast" + (isErr ? " err" : "") }, [msg]);
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), isErr ? 6000 : 3000);
}

/** The toast confirming a terminal attach, naming the emulator butchr launched. */
export function terminalToast(r: TerminalResult): void {
  toast("opened terminal" + (r.emulator ? " (" + r.emulator + ")" : ""));
}
