// The OVERLAY cluster, in React — the shared modal scaffold, and nothing else yet.
//
// >>> IMPORT THIS AS `"./overlay.tsx"`, WITH THE EXTENSION. <<< The vanilla `components/overlay.js`
// is still here (views/projects.js and components/project-modals.js open modals through it), so
// `"./overlay.js"` resolves to THAT file. Same rule as chips.tsx and button.tsx; see chips.tsx's
// header for why. Phase 4d deletes overlay.js.
//
// WHAT `openModal` DID, AND WHY LAUNCHPAD IS A STRICT WIN HERE (RFC §7.2: **Direct**).
// `openModal` hand-rolled a backdrop, an Escape keydown listener, a backdrop-click handler and a
// `document.body.appendChild`, then handed the caller a `{close, backdrop, modal}` triple.
// `ModalOverlay` + `Modal` + `Dialog` are all of it: `isDismissable` gives Escape and outside-click,
// the overlay portals itself, and focus is TRAPPED AND RESTORED on close — which the hand-rolled one
// never did at all. That last property is the reason this is a win rather than a wash.
//
// `openPicker` (the directory browser) is NOT ported here. Its only callers are the still-vanilla
// projects surfaces, which keep reaching it through `overlay.js`; porting it now would ship a second
// unreachable copy. It belongs to Phase 4d, with the views that open it.
//
// TWO CLASSES, ONE BOX. LaunchPad's `Modal` is the positioned element and carries its own width and
// surface; butchr's `.modal` chrome (the 640px column with a scrolling body between a fixed head and
// foot) belongs on the `Dialog` inside it. `.modal-wrap` strips the outer element back to a bare
// positioning box so the two do not paint two nested cards.
import { Dialog, Heading, IconButton, Modal, ModalOverlay } from "@launchpad-ui/components";
import type { ReactNode } from "react";

/**
 * The shared modal scaffold: backdrop, Escape, outside-click, focus trap, and the standard head
 * (title + ✕). `children` supplies the `.m-body` and `.m-foot`.
 *
 * Controlled — every caller closes it programmatically after a successful submit, so `isOpen` is
 * the state and `onOpenChange` the setter. `Dialog`'s children may be a function of `{close}` in
 * react-aria; we do not use that form, because these dialogs' submit handlers close themselves from
 * inside an async callback, where a render-prop argument is out of scope.
 *
 * `level={3}` on the `Heading`, not `size` alone: `.modal .m-head h3` is what style.css targets, and
 * LaunchPad's `Heading` picks its tag from `size` (medium → h2) unless told otherwise.
 */
export function ModalShell({
  isOpen,
  onOpenChange,
  title,
  children,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <ModalOverlay isOpen={isOpen} onOpenChange={onOpenChange} isDismissable>
      <Modal className="modal-wrap">
        <Dialog className="modal">
          <div className="m-head">
            <Heading slot="title" level={3} size="small">
              {title}
            </Heading>
            <IconButton icon="cancel" aria-label="Close" variant="minimal" size="small" onPress={() => onOpenChange(false)} />
          </div>
          {children}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/** The inline error a modal surfaces next to its submit button. It exists because a server error
 *  must NEVER be only a transient toast — the message is the whole answer to what the operator just
 *  tried to do. `.m-error.on` is what turns it red; an empty message keeps the node (and so the
 *  `.m-foot` flex layout) in place. */
export function ModalError({ message }: { message: string }) {
  return <span className={"m-error hint" + (message ? " on" : "")}>{message}</span>;
}
