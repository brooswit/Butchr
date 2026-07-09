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

## 2. Every modal opens and is keyboard-navigable

NOT INVESTIGATED

## 3. The directory picker (Autocomplete + ListBox + SearchField)

NOT INVESTIGATED
