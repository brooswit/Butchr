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
// `openPicker` (the directory browser) LANDS HERE IN PHASE 4d, as `DirectoryPicker` below, together
// with `AddWorkspaceModal` — its one and only caller.
//
// TWO CLASSES, ONE BOX. LaunchPad's `Modal` is the positioned element and carries its own width and
// surface; butchr's `.modal` chrome (the 640px column with a scrolling body between a fixed head and
// foot) belongs on the `Dialog` inside it. `.modal-wrap` strips the outer element back to a bare
// positioning box so the two do not paint two nested cards.
import {
  Autocomplete,
  Button,
  Dialog,
  Heading,
  IconButton,
  ListBox,
  ListBoxItem,
  Modal,
  ModalOverlay,
  SearchField,
  Input,
} from "@launchpad-ui/components";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useFilter } from "react-aria";
import { api } from "../core/api.js";
import type { FsListing } from "../core/types.js";
import { toast } from "./toast.js";

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

// ---------- the directory picker ----------
//
// `openPicker`, rebuilt. The vanilla one repainted its whole `modal.innerHTML` on every navigation,
// seeded itself by reaching across modules for `document.getElementById("aw-path").value`, and
// handed its caller an `(path, register)` pair. All three are gone: it renders, it takes `seed` as a
// prop, and it is FILL-ONLY (`onSelect(path)`), because its one caller — `AddWorkspaceModal` —
// registers through the project's own endpoint and always ignored the boolean.
//
// >>> `Autocomplete`, NOT `ComboBox`. The spike marked this UNVERIFIED; here is the call. <<<
// `ComboBox` is a form FIELD: an input that collapses to one selected value behind a `Popover`, with
// the listbox as transient overlay chrome. This surface is not a field. It is a full-height browsing
// pane that already lives inside a `Dialog`, its list is the primary content, and nothing it shows is
// a "value" until the operator commits in the foot. Rendering a popover-backed listbox inside a modal
// body would also nest an overlay in an overlay and fight `.m-list`'s own scroll container.
//
// `Autocomplete` is the other thing entirely, and it is exactly this: a non-visual wrapper that binds
// a text input to an arbitrary collection and filters it. It has no popover, no field semantics, and
// no opinion about layout — you compose it from a `SearchField` and a `ListBox` you place yourself.
// So the modal keeps its shape and gains two things the hand-rolled `.fs-row` divs never had:
// type-to-filter, and real arrow-key/Home/End listbox navigation.
//
// `useFilter` comes from react-aria (locale-aware `contains`), not from a hand-rolled
// `toLowerCase().includes()` — which is wrong for accented directory names.
//
// >>> ONE DELIBERATE BEHAVIOUR CHANGE, AND IT IS AN ACCESSIBILITY FIX. <<<
// The vanilla git-repo row carried its own nested "Register" button. A `ListBoxItem` renders
// `role="option"`, and an option MAY NOT contain interactive content — a nested button there is
// unreachable to a screen reader and its click fights the option's own activation. So a row does one
// thing: it navigates into that folder. Committing a path is the FOOT's job, which is where the
// vanilla put it too ("Register this folder" / "Use this path"). Registering a git SUBFOLDER now
// costs one extra click — open it, then commit — and in exchange every row is keyboard-reachable.
export function DirectoryPicker({
  isOpen,
  onOpenChange,
  seed,
  onSelect,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** The path field's current value — where to start browsing. Empty means `$HOME`. */
  seed?: string;
  onSelect: (path: string) => void;
}) {
  const [cur, setCur] = useState<FsListing | null>(null);
  const [filter, setFilter] = useState("");
  const { contains } = useFilter({ sensitivity: "base" });

  // `GET /api/fs`. A failed listing toasts and leaves the previous one painted, exactly as the
  // vanilla `load()` did — navigating into an unreadable directory must not blank the picker.
  const load = (path: string | null) => {
    api<FsListing>("GET", "/fs" + (path ? "?path=" + encodeURIComponent(path) : "")).then(
      (data) => {
        setCur(data);
        setFilter("");
      },
      (e: Error) => toast(e.message, true),
    );
  };

  // Re-seed on every open. A picker opened a second time must start from whatever the path field
  // holds NOW, not from wherever the last session left off.
  useEffect(() => {
    if (!isOpen) return;
    setCur(null);
    load((seed || "").trim() || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `seed` is read on open only, by design.
  }, [isOpen]);

  const commit = (path: string) => {
    onSelect(path);
    onOpenChange(false);
  };

  // NOTE: the entries are NOT filtered here. `Autocomplete` applies its `filter` prop to the
  // descendant collection through context, matching against each item's `textValue`. Filtering the
  // array as well would be a second, redundant pass — and it hides `renderEmptyState`, because a
  // collection given zero items renders its empty state while a collection whose items were all
  // filtered out renders… also its empty state, but only once. One filter, one owner.
  const entries = cur?.entries || [];

  return (
    <ModalOverlay isOpen={isOpen} onOpenChange={onOpenChange} isDismissable>
      <Modal className="modal-wrap">
        <Dialog className="modal" aria-label="Choose a git repository">
          <div className="m-head">
            <Heading slot="title" level={3} size="small">
              Choose a git repository
            </Heading>
            <Button variant="minimal" size="small" isDisabled={!cur} onPress={() => cur && load(cur.home)}>
              Home
            </Button>
            <IconButton icon="cancel" aria-label="Close" variant="minimal" size="small" onPress={() => onOpenChange(false)} />
          </div>

          {!cur ? (
            <div className="m-list">
              <div className="muted m-empty">loading…</div>
            </div>
          ) : (
            <>
              <div className="m-path">{cur.path}</div>
              {/* The `..` row sits OUTSIDE the Autocomplete: it is navigation chrome, not a member
                  of the filtered collection, and typing a filter must never hide the way back up. */}
              <Autocomplete inputValue={filter} onInputChange={setFilter} filter={contains}>
                <SearchField className="m-filter" aria-label="Filter subfolders">
                  <Input placeholder="Filter subfolders…" />
                </SearchField>
                <div className="m-list">
                  {cur.parent ? (
                    <Button variant="minimal" className="fs-row up" onPress={() => load(cur.parent as string)}>
                      <span className="ic" aria-hidden="true">
                        ↑
                      </span>
                      <span className="nm">.. (up)</span>
                    </Button>
                  ) : null}
                  <ListBox
                    aria-label="Subfolders"
                    items={entries}
                    selectionMode="none"
                    onAction={(key) => load(String(key))}
                    renderEmptyState={() => (
                      <div className="muted m-empty">{filter ? "(no matching subfolders)" : "(no subfolders)"}</div>
                    )}
                  >
                    {(e) => (
                      <ListBoxItem id={e.path} textValue={e.name} className="fs-row">
                        <span className="ic" aria-hidden="true">
                          {e.isGitRepo ? "◆" : "▸"}
                        </span>
                        <span className="nm">{e.name}</span>
                        {e.isGitRepo ? <span className="git-badge">git</span> : null}
                      </ListBoxItem>
                    )}
                  </ListBox>
                </div>
              </Autocomplete>

              {/* Both feet FILL the caller's field. The labels differ because the affordance does:
                  a git repo is the thing you came for; any other folder is a path you settle for. */}
              <div className="m-foot">
                {cur.isGitRepo ? (
                  <>
                    <span className="hint">This folder is a git repository.</span>
                    <Button variant="primary" className="btn-success" onPress={() => commit(cur.path)}>
                      Register this folder
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="hint">Open a folder, or pick its path.</span>
                    <Button variant="minimal" onPress={() => commit(cur.path)}>
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
