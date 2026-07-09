// The BUTTON component — the missing piece the RFC named D6
// (docs/rfc-frontend-design-system.md §3: "Genuinely missing: `Button` — there is no button
// helper at all"). It owns BOTH halves of what a butchr button is: the `.btn` markup, and the
// disable/try/toast/restore dance every async control repeats.
//
// It replaces the TWO rival async-action-button implementations the RFC called out: the generic
// `action()` (which used to have its own module under core/, now folded in below) and cto-panel's
// private `btn()` factory. They did NOT behave identically, so `action()` is parameterized rather
// than normalized — see its header for the deltas and the flags that reproduce each.
//
// WHY `render` COMES FROM core/nav.js AND NOT FROM app.js. `onDone` defaults to a re-render of
// the current route, whose dispatcher lives in app.js. Importing `render` from app.js directly
// would close the `components/ -> app.js` cycle: app.js's boot touches `document` at load, so
// that edge would drag a DOM into every test that imports a component. nav.js is the LEAF the
// dispatcher registers itself with, which is what lets this continuation live down here at all.
// See core/nav.js's header for the full argument. `components/` may import `core/` and its
// sibling components; it may NEVER import app.js.
//
// DOM-free at module load, like everything under components/: `document` is touched only inside
// a CALLED function (via `el`, and via toast()), so importing this module under a non-browser
// test runner is safe. test/cli-helpers.test.ts leans on that property for a sibling.
import { el } from "../core/dom.js";
import { toast } from "./toast.js";
import { render } from "../core/nav.js";

// The disable/try/restore/toast dance every action button repeats: disable `btn` (when
// present), run `fn` (typically an api() call), and on success toast `success` (a string, or a
// fn of fn's result) then run `onDone` (defaults to render()). On failure, toast the error and
// re-enable the button so it can be retried. The few buttons whose success message depends on
// the response toast inside `fn` themselves and pass no `success`. `btn` is optional — a caller
// with no button to disable (e.g. a term-link) passes none. Any pre-flight confirm() must run
// before calling action(), so a cancel never disables the button.
//
// THE THREE FLAGS EXIST TO KEEP TWO PRE-EXISTING BEHAVIORS BYTE-IDENTICAL. Before this module,
// cto-panel.js had its own `btn()` whose dance differed from action()'s in three observable
// ways. All three defaults below reproduce `action()`; cto-panel opts into all three. Do NOT
// "simplify" one into the other — that is a behavior change, and both behaviors are load-bearing
// where they are used:
//
//   renderOnError     — cto-panel re-rendered on FAILURE too (its render() sat in a `finally`).
//                       action() does not: it re-enables the button and leaves the view alone,
//                       so an inline error stays on screen next to a retryable button.
//   restoreOnSuccess  — cto-panel re-enabled the button BEFORE render(). action() leaves it
//                       disabled and relies on the re-render to discard the node. This is NOT
//                       cosmetic: render() is async (ctoPanel awaits an api() call), so there is
//                       a real window in which an enabled, re-clickable button is still mounted.
//   errorFallback     — cto-panel toasted `e.message || "failed"`; action() toasts a bare
//                       `e.message`. They diverge on a thrown non-Error or an empty message.
//                       Left `undefined`, the bare `e.message` is passed through unchanged.
export async function action(
  btn,
  fn,
  { success, onDone, renderOnError = false, restoreOnSuccess = false, errorFallback } = {},
) {
  if (btn) btn.disabled = true;
  try {
    const r = await fn();
    if (success != null) toast(typeof success === "function" ? success(r) : success);
    if (restoreOnSuccess && btn) btn.disabled = false;
    (onDone || render)();
  } catch (e) {
    toast(errorFallback === undefined ? e.message : e.message || errorFallback, true);
    if (btn) btn.disabled = false;
    if (renderOnError) (onDone || render)();
  }
}

// The shared button. Returns a `<button class="btn …">` node — never a string — so it composes
// into any el() tree (RFC §2.1: unify on the node-returning model).
//
// Wiring the click is an either/or:
//   onClick  — a plain, synchronous handler, attached as-is. Nothing is disabled or toasted.
//   onAction — an async fn run through action() above: disable → await → toast → restore.
//              `success` / `onDone` / `renderOnError` / `restoreOnSuccess` / `errorFallback`
//              are forwarded to it verbatim and mean exactly what they mean there.
// Passing both is a caller bug; onAction wins, since it is the one that manages `disabled`.
//
// `class` is the VARIANT string appended to the base `btn` class ("ghost", "danger-outline",
// "success", "ghost xs", …), matching the classes style.css already ships. Destructured as
// `cls` because `class` is a reserved word and cannot name a binding.
export function Button({
  label,
  class: cls = "",
  type,
  disabled = false,
  title,
  onClick,
  onAction,
  success,
  onDone,
  renderOnError,
  restoreOnSuccess,
  errorFallback,
} = {}) {
  const b = el("button", {
    class: cls ? "btn " + cls : "btn",
    type: type ?? null,
    title: title ?? null,
  }, label);
  if (disabled) b.disabled = true;
  if (onAction) {
    b.addEventListener("click", () =>
      action(b, onAction, { success, onDone, renderOnError, restoreOnSuccess, errorFallback }));
  } else if (onClick) {
    b.addEventListener("click", onClick);
  }
  return b;
}
