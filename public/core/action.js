// The disable/try/restore/toast dance every action button repeats.
//
// This module is DOM-FREE at module load: `action` reaches the DOM only through toast()
// and the caller's `btn`, both at CALL time.
import { toast } from "./api.js";
import { render } from "./nav.js";

// Owns the disable/try/restore/toast dance every action button repeats: disable
// `btn` (when present), run `fn` (typically an api() call), and on success toast
// `success` (a string, or a fn of fn's result) then run `onDone` (defaults to
// render()). On failure, toast the error and re-enable the button so it can be
// retried. The few buttons whose success message depends on the response toast
// inside `fn` themselves and pass no `success`. `btn` is optional — a caller with
// no button to disable (e.g. a term-link) passes none. Any pre-flight confirm()
// must run before calling action(), so a cancel never disables the button.
//
// `onDone` DEFAULTS to render(), which this module imports from core/nav.js — the leaf
// the dispatcher registers itself with. That is the whole reason action() can live under
// core/ at all: reaching for app.js's `render` directly would close the `core/ -> app.js`
// cycle the module split must never close (see core/nav.js's header). It is a BUTTON
// concern regardless (RFC D6: the missing Button component), and belongs in
// components/button.js once Phase 4 lands it.
export async function action(btn, fn, { success, onDone } = {}) {
  if (btn) btn.disabled = true;
  try {
    const r = await fn();
    if (success != null) toast(typeof success === "function" ? success(r) : success);
    (onDone || render)();
  } catch (e) {
    toast(e.message, true);
    if (btn) btn.disabled = false;
  }
}
