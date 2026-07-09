// The OVERLAY cluster — the shared modal scaffold and the one modal complex enough to have had
// its own state machine (the directory picker).
//
// BOTH HALVES SHRANK, AND FOR DIFFERENT REASONS (RFC §7.2).
//
//   • `openModal` hand-rolled a backdrop, an Escape keydown listener, a backdrop-click handler and
//     a `document.body.appendChild`, then handed the caller a `{close, backdrop, modal}` triple.
//     `ModalOverlay` + `Modal` + `Dialog` are all of it: `isDismissable` gives Escape and
//     outside-click, the overlay portals itself, and focus is trapped and restored on close —
//     which the hand-rolled one never did at all. Direct.
//
//   • `openPicker` kept `cur` (the current directory listing) at MODULE scope and repainted itself
//     by clearing `modal.innerHTML` and rebuilding head/list/foot on every navigation. That is
//     ordinary component state and an ordinary re-render. RFC §1.1 row 9 calls this "a strict
//     simplification", and it is: the module-level cell could leak one modal's directory into the
//     next one's first paint.
//
//   • It also stops reaching across the app for its seed. `openPicker` opened by reading
//     `document.getElementById("aw-path").value` — a documented CROSS-MODULE CONTRACT with an id
//     in components/project-modals.js ("Do not rename it"). The seed is a prop now, and the
//     contract is a function signature.
//
// The `Autocomplete`/`ComboBox` treatment RFC §7.2 floats for the picker is NOT taken. That table
// marks it `UNVERIFIED:` and it is the wrong shape: this is a directory BROWSER (each row both
// navigates and may register), not a text field that filters a list. Rows stay rows.
import { Button, Dialog, Heading, IconButton, Modal, ModalOverlay } from "@launchpad-ui/components";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../core/api.ts";
import type { FsListing } from "../core/types.ts";
import { ClickableRow } from "./clickable.tsx";
import { toast } from "./toast.ts";

/**
 * The shared modal scaffold: backdrop, Escape, outside-click, focus trap, and the standard head
 * (title + ✕). `children` supplies the `.m-body` and `.m-foot`.
 *
 * Controlled — every caller closes it programmatically after a successful submit, so `isOpen` is
 * the state and `onOpenChange` the setter. `Dialog`'s children may be a function of `{close}` in
 * react-aria; we do not use that form, because these dialogs' submit handlers close themselves
 * from inside an async callback, where a render-prop argument is out of scope.
 *
 * TWO CLASSES, ONE BOX. LaunchPad's `Modal` is the positioned element and carries its own width and
 * surface; butchr's `.modal` chrome (the 640px column with a scrolling body between a fixed head
 * and foot) belongs on the `Dialog` inside it. `.modal-wrap` strips the outer element back to a
 * bare positioning box so the two do not paint two nested cards.
 *
 * `level={3}` on the `Heading`, not `size` alone: `.modal .m-head h3` is what style.css targets,
 * and LaunchPad's `Heading` picks its level from `size` (medium → h2) unless told otherwise.
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

/** The inline error every modal surfaces next to its submit button. It exists because a server
 *  error must NEVER be only a transient toast — a 409 "still has N registered repos" is the whole
 *  answer to what the operator just tried to do. */
export function ModalError({ message }: { message: string }) {
  return <span className={"m-error hint" + (message ? " on" : "")}>{message}</span>;
}

// ---------- directory picker ----------

/**
 * Browse the filesystem for a git repository.
 *
 * `onSelect(path, register)` — `register: false` means "just fill the caller's field";
 * `true` means "register this directory now". The two are distinct because the picker is reused
 * as a FILL-ONLY browser by the Add-workspace modal, whose registration must go through the
 * project-scoped endpoint rather than the loose one.
 */
export function DirectoryPicker({
  isOpen,
  onOpenChange,
  seed,
  onSelect,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** The caller's current path field, if any. Empty string means "start at home". */
  seed?: string;
  onSelect: (path: string, register: boolean) => void;
}) {
  const [cur, setCur] = useState<FsListing | null>(null);

  const load = useCallback(async (path: string | null) => {
    try {
      setCur(await api<FsListing>("GET", "/fs" + (path ? "?path=" + encodeURIComponent(path) : "")));
    } catch (e) {
      toast((e as Error).message, true);
    }
  }, []);

  // Seed on OPEN, not on mount: the modal stays mounted (closed) inside its parent, and the
  // caller's path field may have changed since the last time it was opened.
  useEffect(() => {
    if (!isOpen) return;
    void load((seed || "").trim() || null);
  }, [isOpen, seed, load]);

  const pick = (path: string, register: boolean) => {
    onSelect(path, register);
    onOpenChange(false);
  };

  return (
    <ModalOverlay isOpen={isOpen} onOpenChange={onOpenChange} isDismissable>
      <Modal className="modal-wrap">
        <Dialog className="modal">
          <div className="m-head">
            <Heading slot="title" level={3} size="small">
              Choose a git repository
            </Heading>
            <Button variant="minimal" size="small" onPress={() => cur && void load(cur.home)}>
              Home
            </Button>
            <IconButton icon="cancel" aria-label="Close" variant="minimal" size="small" onPress={() => onOpenChange(false)} />
          </div>

          {!cur ? (
            <div className="m-path muted">loading…</div>
          ) : (
            <>
              <div className="m-path">{cur.path}</div>
              <div className="m-list">
                {cur.parent ? (
                  <ClickableRow onActivate={() => void load(cur.parent!)} className="fs-row up">
                    <span className="ic">↑</span>
                    <span className="nm">.. (up)</span>
                  </ClickableRow>
                ) : null}
                {cur.entries.length === 0 ? <div className="muted m-empty">(no subfolders)</div> : null}
                {cur.entries.map((e) => (
                  <ClickableRow key={e.path} onActivate={() => void load(e.path)} className="fs-row">
                    <span className="ic">{e.isGitRepo ? "◆" : "▸"}</span>
                    <span className="nm">{e.name}</span>
                    {e.isGitRepo ? (
                      <>
                        <span className="git-badge">git</span>
                        <Button variant="primary" size="small" onPress={() => pick(e.path, true)}>
                          Register
                        </Button>
                      </>
                    ) : null}
                  </ClickableRow>
                ))}
              </div>
              <div className="m-foot">
                {cur.isGitRepo ? (
                  <>
                    <span className="hint">This folder is a git repository.</span>
                    <Button variant="primary" className="btn-success" onPress={() => pick(cur.path, true)}>
                      Register this folder
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="hint">Open a folder, or pick its path.</span>
                    <Button variant="minimal" onPress={() => pick(cur.path, false)}>
                      Use this path
                    </Button>
                  </>
                )}
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
