// Scratch-DB seeder for the Phase 4c browser verification. Never touches the live butchr:
// BUTCHR_DB / BUTCHR_DATA_DIR are set by the caller to a temp dir.
const SP = process.env.BV_ROOT!;
const REPO = SP + "/repo";
const WS = process.env.BV_WS!;

const dbMod = await import("./src/db.ts");
const stories = await import("./src/stories.ts");


const set = (id: string, cols: Record<string, unknown>) => {
  const keys = Object.keys(cols);
  dbMod.db.query(`UPDATE tasks SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`).run(...keys.map((k) => cols[k]), id);
};

// ── Lane 1: a WORKING story with a full pipeline (blocked → in_progress → needs_info → merged) ──
const s1 = stories.createStory(
  WS,
  "Migrate the workspace + swimlanes views to React, keeping the bespoke pipeline and its status palette intact",
);
const a = await stories.createSubtask(s1.id, { prompt: "port the pure logic leaf" });
const b = await stories.createSubtask(s1.id, { prompt: "wire the route" });
const c = await stories.createSubtask(s1.id, { prompt: "re-point the tests" });
const d = await stories.createSubtask(s1.id, { prompt: "browser-verify both themes" });
set(a.id, { status: "merged", summary: "port the pure logic leaf" });
set(b.id, { status: "in_progress", summary: "wire the route", blocked_by: JSON.stringify([a.id]) });
set(c.id, { status: "needs_info", summary: "re-point the tests", blocked_by: JSON.stringify([b.id]) });
set(d.id, { status: "blocked", summary: "browser-verify both themes", blocked_by: JSON.stringify([c.id]) });

// ── Lane 2: a STALLED story — leader desired but down, work remaining. Also a CROSS-LANE blocker. ──
const s2 = stories.createStory(WS, "Delete the bridge and the last vanilla view");
const e = await stories.createSubtask(s2.id, { prompt: "delete bridge.tsx" });
set(e.id, { status: "inactive", summary: "delete bridge.tsx", blocked_by: JSON.stringify([d.id]) });
// A leader that is DESIRED but has no live pane ⇒ the ⚠ stalled lifecycle + a disabled, explained
// "Open Leader terminal". `running` is not a column — it is derived from a live herdr pane.
// createStory already launched a leader and inserted the row, so UPDATE it.
dbMod.db.query(`UPDATE story_agent SET desired=1, restarts=2, last_error=? WHERE story_id=?`).run("herdr pane vanished", s2.id);

// ── Lane 3: a PARKED, childless story ──
stories.createStory(WS, "Adopt LaunchPad Tabs if a second workspace body ever exists");

// ── Lane 4: an all-finished-but-open story, to exercise the done pile + soft empty state ──
const s4 = stories.createStory(WS, "Land the design-system RFC");
const f = await stories.createSubtask(s4.id, { prompt: "write the RFC" });
const g = await stories.createSubtask(s4.id, { prompt: "get CTO sign-off" });
set(f.id, { status: "merged", summary: "write the RFC" });
set(g.id, { status: "merged", summary: "get CTO sign-off", blocked_by: JSON.stringify([f.id]) });

const rows = dbMod.db.query(`SELECT id, work_kind, status, parent_id, summary FROM tasks ORDER BY work_kind, id`).all();
console.log("seeded ws=" + WS + " rows=" + rows.length);
for (const r of rows as Array<Record<string, unknown>>) console.log("  " + JSON.stringify(r));
