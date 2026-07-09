# Phase 5a — verification of behaviours whose evidence was lost

Phases 4c and 4d were force-reviewed past the 45-minute budget and never wrote
summaries. Their code comments assert behaviours that nobody observed. This doc
records what was actually driven in a real browser.

Status vocabulary: **SETTLED** (observed, with evidence) / **BROKEN** (repro) /
`NOT INVESTIGATED`.

## 1. The typed-text property (controlled inputs survive SSE refresh) — **SETTLED**

`views/task.tsx:48` claims the deleted `captureUiState`/`restoreUiState` harness is
"subsumed" because every textarea is a controlled input React never unmounts. Nobody
had watched it. I did.

**How it was driven.** Scratch DB + scratch server on :47911 (never the live instance),
seeded with three tasks (`in_review`, `in_progress`+`idle`, `idea`). Real Chrome via the
DevTools Protocol — real key events, not synthetic `input` dispatches. The SSE event is
genuinely server-pushed: a *second process* POSTs `/api/work/:id/priority`, the server
calls `emitUpdated()` -> `publish({type:"task.updated"})` -> SSE -> `App.tsx`'s
`es.onmessage` -> `refreshSoon()` -> `bumpRefresh()` -> `useAsync` refetch.

The trap in a test like this is a **vacuous pass**: if the event never lands, the text
survives because nothing happened. So each run asserts the event *and* the re-render:

| # | Assertion | Observed |
|---|---|---|
| A | SSE message reached the page | YES (+1) |
| B | Page refetched `/api/work/:id` | YES (+5) |
| C | DOM repainted with new server data | YES — meta grid `priority` **3 -> 9** |
| D | Textarea is the SAME DOM node | YES — expando `__id='NODE-A'` survived |
| E | Typed text survived | YES — `"half-typed change request"` |
| F | Caret survived, mid-text | YES — `selectionStart === 19` (text length 24, so the caret was NOT at the end; a harness that merely re-set `.value` would have snapped it to 24) |
| G | Focus survived | YES — `document.activeElement` is still the textarea |

D is the load-bearing one: the node was never unmounted, so text/caret/focus/scroll are
kept by the DOM itself rather than restored. That is precisely the property the deleted
harness used to fake, and it is why the harness is genuinely redundant.

Repeated for all three surfaces named in the task, each with its own real SSE event:

- **review note** (`in_review`, `ReviewPanel`) — survived. *This is the one that matters:
  the operator's half-typed change-request note before rejecting a diff.*
- **idle panel** (`in_progress` + `idle`, `IdlePanel`) — survived.
- **idea / spec** (`idea`, `IdeaPanel`) — survived.

No regression. The comment at `views/task.tsx:48-51` is accurate; only its citation
("see the task summary") pointed at a summary that never existed. This doc is that
evidence.

**One honest caveat, not a regression.** These panels are mounted *conditionally on task
status* (`task.status === "in_review"`, `task.status === "in_progress" && task.idle`,
`views/task.tsx:1303,1308`). An SSE event that changes the **status itself** — or flips
`idle` off — unmounts the panel and its text goes with it. That is also what the vanilla
build did (the panel stopped being rendered), and it is semantically right: the surface
no longer applies. Within a given status, typing is safe.

## 2. Every modal opens and is keyboard-navigable — **SETTLED**

The spike's words were *"I rendered the trigger; I never clicked it."* I clicked all of
them, with a real mouse event at the trigger's viewport coordinates, and drove the
keyboard with real `Input.dispatchKeyEvent` calls.

The app has **five** `ModalShell` modals plus the nested `DirectoryPicker` (§3). All five
were opened, tabbed, escaped, and checked for focus restoration:

| Modal | Trigger | Opens | Focus enters | Tab trapped + wraps | Escape closes | Focus restored to trigger |
|---|---|---|---|---|---|---|
| New project | `+ New project` | ✅ | ✅ textarea | ✅ 5 stops, no leak | ✅ | ✅ |
| Launch initiative | `Launch initiative` | ✅ | ✅ textarea | ✅ 7 stops, no leak | ✅ | ✅ |
| Add workspace | `+ Add workspace` | ✅ | ✅ input | ✅ 6 stops, no leak | ✅ | ✅ |
| Delete project | `Delete project` | ✅ | ✅ dialog | ✅ 3 stops, no leak | ✅ | ✅ |
| New story | `New story` | ✅ | ✅ textarea | ✅ 4 stops, no leak | ✅ | ✅ |

"Tab trapped + wraps" means: I pressed Tab `tabbables + 3` times and every single stop
had `dialog.contains(document.activeElement)`, and the stop list cycled rather than
running off the end. Focus never escaped to the page behind the overlay.

Launch-initiative's real tab ring, in order:
`Cancel -> Launch -> Close -> Single repo -> Cross-repo fan-out -> select(scratchrepo) -> textarea(brief)`.

**A trap I fell into, and the correction.** My first pass reported Launch-initiative
"settled" with only 2 reachable stops for 3 tabbables. It was opening the *empty state* —
`project-modals.tsx:318` renders "Register at least one repo before launching an
initiative" when the project has no member repos, and my scratch project had none. That
is not the modal. I created a real git repo, registered it under the project via
`POST /api/projects/:id/workspaces`, and re-ran: 7 tabbables, 7 distinct stops, full ring.
**A modal that renders its empty state is not evidence that its form is keyboard-navigable.**

**Not a bug, worth naming.** `Delete project` puts initial focus on the `<section
role="dialog">` itself rather than on a control, because it has no autofocus target. That
is react-aria's documented fallback and it keeps the dialog announced on open; Tab then
moves into the ring normally. `overlay.tsx:12`'s claim that focus is "TRAPPED AND
RESTORED on close — which the hand-rolled one never did at all" is confirmed on all five.

## 3. The directory picker (Autocomplete + ListBox + SearchField) — **SETTLED**

The spike said which of `ComboBox` / `Autocomplete` fits was UNVERIFIED. Phase 4d chose
`Autocomplete` + `SearchField` + `ListBox` + `ListBoxItem` (`overlay.tsx:95-118`). Driven
against a scratch tree: `scratch-repo/sub/{alpha, beta, gamma-repo}` where `gamma-repo` is
a real git repo.

Opened from `Add workspace` -> `Browse…`; two dialogs stack (`Add workspace` +
`Choose a git repository`) and the picker seeds from the path field's current value.
Unfiltered rows: `▸alpha`, `▸beta`, `◆gamma-repo git`.

**Filter by typing** — typed `gam` into the SearchField: rows narrowed to
`["◆gamma-repo git"]`. Typed on to `gamzzz`: `renderEmptyState` painted
`(no matching subfolders)` — so the single-owner filter note at `overlay.tsx:165` holds
(the array is not pre-filtered, `Autocomplete` filters the collection, and the empty state
still renders). `.. (up)` stayed visible throughout, confirming the comment at
`overlay.tsx:190` that it is chrome outside the filtered collection — a filter can never
hide the way back up.

**Select with the keyboard** — from the SearchField, `ArrowDown` moved the listbox's
focused option onto `◆gamma-repo` (Autocomplete forwards nav keys to the collection);
`Enter` fired `onAction` and navigated: `…/sub` -> `…/sub/gamma-repo`. This is the real
arrow-key/listbox navigation the hand-rolled `.fs-row` divs never had.

**Select with the mouse** — clicked `.. (up)` back to `…/sub`, then clicked the `beta`
row: navigated to `…/sub/beta`.

**`onSelect(path)` fires with the correct path** — twice, and rows never commit (they
navigate; committing is the foot's job, exactly as `overlay.tsx:115-118` argues):

| Path | Foot (scoped to the picker dialog) | Hint | Commit | Value landed in the caller's field |
|---|---|---|---|---|
| `…/sub/gamma-repo` (git) | `Register this folder` | "This folder is a git repository." | click | `…/sub/gamma-repo` ✅ |
| `…/sub/beta` (plain) | `Use this path` | "Open a folder, or pick its path." | click | `…/sub/beta` ✅ |

In both cases the picker closed, the `Add workspace` modal stayed open, and its `path`
input held exactly the committed path. `Escape` inside the picker closes **only** the
picker and leaves `Add workspace` mounted.

**The accessibility claim checks out.** `overlay.tsx:113` says a `ListBoxItem` renders
`role="option"` and may not contain interactive content, so the vanilla row's nested
"Register" button was removed. Observed: `0` nested `button`/`a`/`input` inside any
`[role=option]`; `ListBox` carries `aria-label="Subfolders"` and the `SearchField`
`aria-label="Filter subfolders"`. Re-seeding on every open (`overlay.tsx:150`) also
confirmed: reopening after committing `gamma-repo` started the picker at `…/gamma-repo`,
not where the previous session left off.

`Autocomplete` was the right call. Nothing here needs `ComboBox`, and a popover-backed
listbox inside the dialog would have nested an overlay in an overlay as the comment warned.

---

## Verdict

All three behaviours are **SETTLED**. No regressions found, so this change is docs-only
and adds no CHANGELOG entry. Nothing was left `NOT INVESTIGATED`.

The one substantive correction to the record: `views/task.tsx:50-51` cites "see the task
summary" for the typed-text property, and that summary never existed. The evidence is now
here instead.

## How to re-run this

Scratch DB and scratch port only — never the live instance or its database.

```
BUTCHR_DATA_DIR=$S/data BUTCHR_DB=$S/data/scratch.db BUTCHR_PORT=47911 bun run src/index.ts
```

The browser was driven over the Chrome DevTools Protocol (`google-chrome --headless=new
--remote-debugging-port`), using `Input.dispatchKeyEvent` / `Input.dispatchMouseEvent` so
that every keystroke and click is a real user-input event, not a synthetic `dispatchEvent`
that would bypass React's event plumbing and prove nothing. The driver and the three
scripts are scratch-only and are deliberately not committed: they hard-code a scratch DB,
a seeded project id and absolute `/tmp` paths, so they would rot immediately as a test.
`bun test` and `scripts/ci` remain the committed gates.
