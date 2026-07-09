// The transient TOAST surface — the one-line banner that confirms an action or reports an error.
//
// THE PHASE-3 SINK IS GONE. Through Phase 3 this module carried a `setToastSink()` indirection and
// a hand-rolled `.toast` div fallback, because the vanilla views still called `toast()` and
// importing `@launchpad-ui` from a leaf would have dragged React and a CSS import into the module
// graph of every view — and of the six tests that imported those views directly with no DOM. Both
// halves of that reason are now false: the views ARE React, and the tests have a real DOM
// (test/dom-env.ts). So this is what RFC §7.2 said it should be all along — a two-line adapter
// onto LaunchPad's `toastQueue`, which the shell's `<ToastRegion/>` renders.
//
// The hand-rolled timer state (`toastTimer`) goes with it: `toastQueue.add`'s `timeout` owns it.
import { toastQueue } from "@launchpad-ui/components";
import type { TerminalResult } from "../core/types.ts";

// The two timeouts are the vanilla ones, preserved: an error stays up longer because it is the one
// you may need to read twice. (The vanilla div used 6s/3s; Phase 3's shell sink used 8s/5s. The
// shell's values win — they are what the operator has been living with since Phase 3 landed.)
const ERROR_MS = 8000;
const SUCCESS_MS = 5000;

export function toast(msg: string, isErr?: boolean): void {
  toastQueue.add(
    { title: msg, status: isErr ? "error" : "success" },
    { timeout: isErr ? ERROR_MS : SUCCESS_MS },
  );
}

/** The toast confirming a terminal attach, naming the emulator butchr launched. */
export function terminalToast(r: TerminalResult): void {
  toast("opened terminal" + (r.emulator ? " (" + r.emulator + ")" : ""));
}
