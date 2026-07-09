// A whole-row / whole-card click target that contains its own buttons.
//
// Three surfaces need exactly this and each hand-rolled it: the projects overview card (opens the
// project), the project-detail repo row (drills into the workspace, but not when you hit the
// unregister ×), and the directory picker's rows (navigate into the folder, but not when you hit
// Register). LaunchPad has no `Card` and no clickable-row primitive — verified against its 257
// exports — so this is the one place the pattern lives.
//
// TWO THINGS IT GETS RIGHT THAT THE VANILLA VERSIONS DID NOT, UNIFORMLY.
//
//   1. A NESTED CONTROL SWALLOWS THE ACTIVATION. views/projects.js did this for `.icon-btn` with
//      an explicit `e.target.closest(".icon-btn")` guard; components/overlay.js did it for its
//      Register button with `stopPropagation`; the picker's plain `.fs-row` divs did neither and
//      did not need to. Here it is one rule — a click that originated inside ANY `<button>` or
//      `<a>` is that control's, not the row's — so a control added later cannot forget it.
//
//   2. IT IS KEYBOARD-OPERABLE. `role="button" tabIndex={0}` without an Enter/Space handler is
//      WORSE than a plain div: it advertises a control that cannot be activated. The picker's
//      `.fs-row`s were plain divs (unreachable, honestly); the cards and repo rows had the
//      keydown handler. Everything gets it now.
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";

export function ClickableRow({
  className,
  onActivate,
  ariaLabel,
  children,
}: {
  className: string;
  onActivate: () => void;
  ariaLabel?: string;
  children: ReactNode;
}) {
  // `closest` walks up from the ORIGINATING node, so this catches a click on an icon or a text
  // span inside a nested button just as well as one on the button itself.
  const fromNestedControl = (e: MouseEvent) => !!(e.target as Element | null)?.closest?.("button, a");

  return (
    <div
      className={className}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      onClick={(e) => {
        if (fromNestedControl(e)) return;
        onActivate();
      }}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        // A nested button already handles its own Enter/Space when IT holds focus.
        if ((e.target as Element) !== e.currentTarget) return;
        e.preventDefault();
        onActivate();
      }}
    >
      {children}
    </div>
  );
}
