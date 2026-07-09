# Phase 5b — Swimlanes visual parity (React vs `p3-rollback-boundary`)

STATUS: **IN PROGRESS** — skeleton committed early per task budget rule.

Reference: git tag `p3-rollback-boundary` (4d10906, v0.9.281) — last commit where every view was
still vanilla inside the React shell. Compared against `main` @ 0.9.289 (100% React/TS).

Method: both builds served against ONE seeded scratch DB on two ports; headless Chrome at a fixed
viewport, both themes, routes `#/` and `#/workspace/:id`.

## Verdict

TBD

## Are the five pure functions still driving the render?

| function | called from | decision it drives | verdict |
|---|---|---|---|
| `storyLifecycle` | TBD | TBD | TBD |
| `storyProgress` | TBD | TBD | TBD |
| `orderLaneLeaves` | TBD | TBD | TBD |
| `swimEmphasis` | TBD | TBD | TBD |
| `laneTitle` | TBD | TBD | TBD |
| `leaderTerminalBtnState` | TBD | TBD | TBD |

## Visual comparison

| aspect | verdict | notes |
|---|---|---|
| lane order (`orderLaneLeaves`) | TBD | |
| lane titles (`laneTitle`) | TBD | |
| story lifecycle chip (`storyLifecycle`) | TBD | |
| progress text + bar geometry (`storyProgress`) | TBD | |
| emphasis (`swimEmphasis`) | TBD | |
| "Open Leader terminal" button + disabled state + tooltip | TBD | |
| chip colours per status | TBD | |
| card padding + borders | TBD | |
| crumb separators | TBD | |

## NOT INVESTIGATED

- everything above.
