// THE ASYNC-ACTION DANCE — `action()` from components/button.js, as a hook — plus the one place
// butchr's button vocabulary is reconciled with LaunchPad's.
//
// Every async control in butchr repeats the same four steps: disable the button, run the call,
// toast the outcome, re-enable. The vanilla `action()` owned that, and a hand-rolled `Button()`
// owned the `.btn` markup. LaunchPad's `Button` now owns the markup (RFC §7.2: **Direct**), so
// what is left here is the dance — and one behaviour that had to change, deliberately.
//
// >>> IMPORT THIS AS `"./button.tsx"`, WITH THE EXTENSION. <<< The vanilla `components/button.js`
// is still here — three vanilla modules (views/task.js, views/projects.js,
// components/project-modals.js) still build buttons through it — so `"./button.js"` resolves to
// THAT file under both `tsc` and `bun build`. Same rule as chips.tsx; see its header. Phase 4d
// deletes button.js and the specifiers can go back to being extensionless.
//
// >>> `restoreOnSuccess` IS GONE, AND ITS ABSENCE IS THE FIX. <<<
// The vanilla `action()` left the button DISABLED on success and relied on `render()` to destroy
// the node. Its own header said so: "action() leaves it disabled and relies on the re-render to
// discard the node. This is NOT cosmetic: render() is async … so there is a real window in which
// an enabled, re-clickable button is still mounted." cto-panel.js opted OUT of that (its private
// `btn()` re-enabled before re-rendering), and the flag existed only to keep both behaviours
// byte-identical through the Phase-2 unification.
//
// Under React NOTHING DESTROYS THE NODE. A refresh re-runs a fetch; the button reconciles in
// place. So "leave it disabled" is no longer a default that a rebuild tidies up — it is a
// permanently dead control. Both call sites therefore collapse onto the behaviour cto-panel
// already had: always re-enable, in a `finally`. The double-click window the flag guarded is
// closed by `inFlight` instead, which is the guarantee the disabled attribute was standing in for.
//
// The other two flags survive, because they encode real, differing intent:
//   renderOnError  — cto-panel re-fetches on FAILURE too (its render() sat in a `finally`).
//                    The default does not: it leaves the view alone so an inline error stays on
//                    screen next to a retryable button.
//   errorFallback  — cto-panel toasted `e.message || "failed"`; the default toasts a bare
//                    `e.message`. They diverge on a thrown non-Error or an empty message.
import { Button } from "@launchpad-ui/components";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { bumpRefresh } from "../core/refresh.js";
import { asError } from "../core/use-async.js";
import { toast } from "./toast.js";

// ---------- the variant map ----------
//
// LaunchPad's `Button` ships five variants — default | primary | destructive | minimal | picker —
// read out of the installed package, not guessed. butchr's `.btn` classes map onto them cleanly
// EXCEPT for one, and the exception is not laziness:
//
//   .btn                      → variant="primary"     (both are #425eff; style.css's alias block
//                                                      already proves they are the same token)
//   .btn.ghost                → variant="minimal"
//   .btn.danger               → variant="destructive"
//   .btn.ghost.danger-outline → variant="destructive" + `.btn-outline`   ← LaunchPad's destructive
//                                                      is FILLED; there is no outline treatment
//   .btn.xs / .btn.ghost.xs   → size="small"
//
// `.btn-outline` is ADDITIVE. LaunchPad's `Button` composes whatever `className` it is given onto
// its own style output, so the component keeps its geometry, focus ring and hover/press `data-*`
// attributes and butchr overrides only `background`/`border`/`color`. style.css is imported LAST
// (main.tsx), so the override lands. This is RFC §7.1's posture applied at the variant level:
// LaunchPad's component, butchr's one missing semantic.
//
// `.btn.success` (green, `--merged`) has NO entry here ON PURPOSE. Its only call sites are still
// vanilla (components/project-modals.js's "Register this folder"), so an entry would ship a
// `.btn-success` class with no CSS rule behind it — a silently unstyled button, which is exactly
// the class of failure RFC §4.3 is about. Phase 4d adds it together with its rule.
export type ButtonKind = "primary" | "ghost" | "danger" | "danger-outline";

const VARIANT: Record<ButtonKind, "primary" | "minimal" | "destructive"> = {
  primary: "primary",
  ghost: "minimal",
  danger: "destructive",
  "danger-outline": "destructive",
};
const EXTRA: Partial<Record<ButtonKind, string>> = {
  "danger-outline": "btn-outline",
};

/** The props every butchr button shares, so the two exported components can't drift. */
export type ButtonLook = {
  kind?: ButtonKind;
  size?: "small" | "medium" | "large";
  className?: string;
};

/** Resolve a butchr `kind` to the LaunchPad props. Exported for the hand-rolled controls that need
 *  the same look on a `<Button>` they wire themselves (the workspace's Unregister, which confirm()s
 *  before it runs). */
export function look({ kind = "primary", size, className }: ButtonLook) {
  const extra = [EXTRA[kind], className].filter(Boolean).join(" ");
  return { variant: VARIANT[kind], size, className: extra || undefined } as const;
}

// ---------- the dance ----------

export type ActionOptions<T> = {
  /** Toasted on success. A function of the result, for messages that depend on the response. */
  success?: string | ((r: T) => string);
  /** What to do after a SUCCESSFUL run. Defaults to `bumpRefresh` — the old `render()`. */
  onDone?: (r: T) => void;
  /** Also run `onDone` when the call THROWS. Off by default. */
  renderOnError?: boolean;
  /** Message when the thrown error carries none. Left undefined, a bare `e.message` passes through. */
  errorFallback?: string;
};

/**
 * Runs `fn` through the dance and reports whether it is in flight.
 *
 * The returned `run` is stable and re-entrant-safe: a second call while one is pending is DROPPED,
 * never queued — which is what the disabled attribute used to guarantee structurally.
 */
export function useAction<T>(fn: () => Promise<T>, opts: ActionOptions<T> = {}) {
  const [pending, setPending] = useState(false);
  // Read `fn` and `opts` at CALL time. Both are fresh closures on every render and both routinely
  // close over an input's current value — freezing either at hook-call time is exactly how a
  // hand-rolled version of this silently sends a stale note.
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  // `pending` in a ref TOO: `setPending` is async, so two clicks in one tick would both read
  // `pending === false` off the render closure and both fire.
  const inFlight = useRef(false);
  // Never call `setPending` after the control has gone: `onDone` routinely navigates (unregistering
  // a workspace returns to the projects list), which unmounts this button while its `finally` is
  // still queued.
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const run = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    const { success, onDone, renderOnError, errorFallback } = optsRef.current;
    try {
      const r = await fnRef.current();
      if (success != null) toast(typeof success === "function" ? success(r) : success);
      (onDone || bumpRefresh)(r);
    } catch (e) {
      const msg = asError(e).message;
      toast(errorFallback === undefined ? msg : msg || errorFallback, true);
      if (renderOnError) (onDone || bumpRefresh)(undefined as T);
    } finally {
      inFlight.current = false;
      if (alive.current) setPending(false);
    }
  }, []);

  return { run, pending };
}

/**
 * A `Button` wired to `useAction`. The common case, and nothing more.
 *
 * A control that must validate first, `confirm()` first, or branch its toast off the response
 * shape does NOT use this — it renders a plain `<Button onPress>` and drives `useAction`'s `run`
 * itself, exactly as the vanilla code hand-rolled those cases rather than routing them through
 * `action()`. The workspace view has two of them and each says why.
 */
// NO `title` PROP, AND THAT IS THE COMPONENT'S CONSTRAINT, NOT A CHOICE. LaunchPad's `ButtonProps`
// does not accept `title` — react-aria types the prop set and a native tooltip is not in it. A
// caller that needs an honest hover hint (the swimlanes' "Open Leader terminal", which explains WHY
// it is disabled) wraps the button in a `<span title={…}>`, which ALSO fixes a real bug the vanilla
// had: browsers suppress hover events on a disabled `<button>`, so the tooltip that mattered most —
// the one on the disabled control — was the one least likely to appear.
export function ActionButton<T>({
  label,
  kind,
  size,
  className,
  isDisabled,
  onAction,
  ...opts
}: ActionOptions<T> &
  ButtonLook & {
    label: ReactNode;
    isDisabled?: boolean;
    onAction: () => Promise<T>;
  }) {
  const { run, pending } = useAction(onAction, opts);
  return (
    <Button {...look({ kind, size, className })} isDisabled={isDisabled || pending} onPress={() => void run()}>
      {label}
    </Button>
  );
}
