// The transient TOAST surface — the one-line banner that confirms an action or reports an error.
//
// It lived in core/api.js until the RFC Phase 2 horizontal split. `toast` builds and appends DOM
// nodes, so its presence there was the single reason `core/` was NOT framework-agnostic: the chain
// core/state-meta.js -> core/api.js -> core/dom.js dragged the DOM layer into the two purest core
// leaves. Moving it here severs that edge — core/api.js now holds only the `api()` fetch wrapper,
// and core/dom.js is reachable only from components/ and views/ (RFC §0.1 #2, #3).
//
// DOM-free at module load, like everything under components/: `document` is touched only INSIDE a
// called function.
import { el } from "../core/dom.js";

// Module-private: only toast() reads or clears it, so it is deliberately not exported.
let toastTimer = null;
export function toast(msg, isErr) {
  const old = document.querySelector(".toast");
  if (old) old.remove();
  const t = el("div", { class: "toast" + (isErr ? " err" : "") }, msg);
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), isErr ? 6000 : 3000);
}

// The toast confirming a terminal attach, naming the emulator butchr launched.
export function terminalToast(r) {
  toast("opened terminal" + (r.emulator ? " (" + r.emulator + ")" : ""));
}
