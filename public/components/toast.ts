// The transient TOAST surface — the one-line banner that confirms an action or reports an error.
//
// >>> THE PHASE-3 SINK IS GONE, AND WITH IT THE LAST IMPORT OF core/dom.js. <<<
// Through Phase 4d this module carried a `setToastSink()` indirection and a hand-rolled `.toast`
// div built with `el()`. Both halves of that justification were true then and are false now:
//
//   • "Seven vanilla views still call toast(), and importing @launchpad-ui here would drag React
//     into the module graph of every views/*.js" — there are no vanilla views. Every caller is a
//     .tsx module that already imports @launchpad-ui.
//   • "…and of the six tests that import those views directly with no DOM" — those tests have a
//     real DOM now (test/dom-env.ts installs happy-dom from the suite preload).
//
// So this is what RFC §7.2 said it should be all along: a two-line adapter onto LaunchPad's
// `toastQueue`, which the shell's `<ToastRegion/>` renders. The hand-rolled `toastTimer` goes with
// it — `toastQueue.add`'s `timeout` owns that now.
//
// WORTH KNOWING: this module was the SOLE surviving importer of `public/core/dom.js`. Every route
// was already React, yet `el()` still shipped in the production bundle through this one edge —
// which is why "is the vanilla front end dead?" answered *no* to the bundler long after it answered
// *yes* to the router. Severing it is what let Phase 4e delete core/dom.js.
import { toastQueue } from "@launchpad-ui/components";
import type { TerminalResult } from "../core/types.js";

// The two timeouts are the Phase-3 shell sink's, preserved: an error stays up longer because it is
// the one you may need to read twice. (The vanilla div used 6s/3s; the sink used 8s/5s. The sink's
// values win — they are what the operator has actually been living with since Phase 3 landed.)
const ERROR_MS = 8000;
const SUCCESS_MS = 5000;

export function toast(msg: string, isErr?: boolean): void {
  toastQueue.add({ title: msg, status: isErr ? "error" : "success" }, { timeout: isErr ? ERROR_MS : SUCCESS_MS });
}

/** The toast confirming a terminal attach, naming the emulator butchr launched. */
export function terminalToast(r: TerminalResult): void {
  toast("opened terminal" + (r.emulator ? " (" + r.emulator + ")" : ""));
}
