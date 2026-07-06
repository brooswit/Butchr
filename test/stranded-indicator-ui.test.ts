// Story st-a4cc6082 (S3) — the human-visible end of the STRANDED-WORK pull-signal. S2 serves a
// `stranded` count + `strandedItems` [{workId, kind, reason}] per workspace (plus totals.stranded)
// on GET /api/dashboard; this UI renders a DISTINCT, prominent callout from it. public/app.js is a
// classic browser script (touches `document` at module load, no exports), so — mirroring
// test/app-restore-uistate.test.ts / test/state-meta-fallback.test.ts — we pull the pure helper
// block fenced with `<test-extract:stranded-indicator>` and eval it. The block's ONLY dependency is
// `esc`, which the harness provides (a copy of app.js's escaper), so the eval'd helpers are exercised
// exactly as shipped.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const APP = readFileSync(join(ROOT, "public", "app.js"), "utf8");

/** Pull the source fenced by `// <test-extract:name>` ... `// </test-extract:name>`. The opening
 *  sentinel may share its `//` line with prose, so capture from the NEXT line. */
function extract(name: string): string {
  const m = APP.match(new RegExp(`// <test-extract:${name}>[^\\n]*\\n([\\s\\S]*?)// </test-extract:${name}>`));
  if (!m) throw new Error(`missing test-extract sentinel block: ${name}`);
  return m[1];
}

function makeHarness() {
  // esc is a verbatim copy of app.js's escaper (the block's only external dependency).
  const body = `
    function esc(s) {
      return String(s ?? "").replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }
    ${extract("stranded-indicator")}
    return { strandedKindLabel, strandedHref, strandedMarkup };
  `;
  return new Function(body)() as {
    strandedKindLabel: (kind: string) => string;
    strandedHref: (kind: string, workId: string, workspaceId: string) => string;
    strandedMarkup: (data: any) => string;
  };
}

// A dashboard payload with stranded items spanning all four kinds across two workspaces, shaped
// exactly like GET /api/dashboard (workspaces[].strandedItems + totals.stranded).
function strandedData() {
  return {
    totals: { stranded: 4 },
    workspaces: [
      {
        id: "dir-A",
        label: "Project Alpha",
        path: "/home/me/alpha",
        stranded: 2,
        strandedItems: [
          { workId: "task-idea-1", kind: "idea", reason: "idea task pending; CTO gave up (dead)" },
          { workId: "task-blk-2", kind: "dead_blocked", reason: "blocked on dead dependency task-x; CTO disabled" },
        ],
      },
      {
        id: "dir-B",
        label: "Project Beta",
        path: "/home/me/beta",
        stranded: 2,
        strandedItems: [
          { workId: "st-stuck-3", kind: "stuck_story", reason: "story can never complete (dead member); leader gave up (dead)" },
          { workId: "st-mb-4", kind: "merge_blocked", reason: "story merge_blocked; leader disabled" },
        ],
      },
    ],
  };
}

describe("strandedKindLabel — friendly condition labels", () => {
  test("maps every kind, falls back to the raw kind for unknowns", () => {
    const h = makeHarness();
    expect(h.strandedKindLabel("idea")).toBe("idea awaiting spec");
    expect(h.strandedKindLabel("dead_blocked")).toBe("dead-blocked task");
    expect(h.strandedKindLabel("stuck_story")).toBe("stuck story");
    expect(h.strandedKindLabel("merge_blocked")).toBe("merge-blocked story");
    // PART 2 (story st-a32c8138): the LIVE-but-IDLE responder kind.
    expect(h.strandedKindLabel("idle_responder")).toBe("idle — not acting");
    expect(h.strandedKindLabel("something_new")).toBe("something_new");
  });
});

describe("strandedHref — kind-branched link target (stories have NO task-detail route)", () => {
  test("TASK kinds (idea / dead_blocked) link to the work-detail route #/task/<workId>", () => {
    const h = makeHarness();
    expect(h.strandedHref("idea", "task-idea-1", "dir-A")).toBe("#/task/task-idea-1");
    expect(h.strandedHref("dead_blocked", "task-blk-2", "dir-A")).toBe("#/task/task-blk-2");
  });
  test("STORY kinds (stuck_story / merge_blocked) link to the OWNING workspace, never #/task/<storyId>", () => {
    const h = makeHarness();
    expect(h.strandedHref("stuck_story", "st-stuck-3", "dir-B")).toBe("#/workspace/dir-B");
    expect(h.strandedHref("merge_blocked", "st-mb-4", "dir-B")).toBe("#/workspace/dir-B");
    expect(h.strandedHref("stuck_story", "st-stuck-3", "dir-B")).not.toContain("#/task/");
    expect(h.strandedHref("merge_blocked", "st-mb-4", "dir-B")).not.toContain("#/task/");
  });
  test("idle_responder (PART 2) links to the OWNING workspace/CTO view, never #/task/<workId>", () => {
    const h = makeHarness();
    // workId IS the directory id, so it routes to the workspace exactly like the story kinds.
    expect(h.strandedHref("idle_responder", "dir-C", "dir-C")).toBe("#/workspace/dir-C");
    expect(h.strandedHref("idle_responder", "dir-C", "dir-C")).not.toContain("#/task/");
  });
});

describe("strandedMarkup — the distinct pull-signal panel", () => {
  test("renders the total count, each item's kind label + reason, the owning workspace, and the right links", () => {
    const h = makeHarness();
    const html = h.strandedMarkup(strandedData());

    // A distinct, prominent panel (not the ordinary review/needsAttention badge).
    expect(html).toContain("stranded-panel");
    expect(html).toContain('role="alert"');
    // Total count surfaced.
    expect(html).toContain(">4</span>");

    // Owning workspaces named (groups by workspace).
    expect(html).toContain("Project Alpha");
    expect(html).toContain("Project Beta");

    // Each item's friendly kind label.
    expect(html).toContain("idea awaiting spec");
    expect(html).toContain("dead-blocked task");
    expect(html).toContain("stuck story");
    expect(html).toContain("merge-blocked story");

    // Each item's reason verbatim (carries BOTH condition AND responder verdict).
    expect(html).toContain("idea task pending; CTO gave up (dead)");
    expect(html).toContain("blocked on dead dependency task-x; CTO disabled");
    expect(html).toContain("story can never complete (dead member); leader gave up (dead)");
    expect(html).toContain("story merge_blocked; leader disabled");

    // TASK kinds → #/task/<workId>; STORY kinds → #/workspace/<workspaceId> (NOT #/task/<storyId>).
    expect(html).toContain('href="#/task/task-idea-1"');
    expect(html).toContain('href="#/task/task-blk-2"');
    expect(html).toContain('href="#/workspace/dir-B"');
    expect(html).not.toContain("#/task/st-stuck-3");
    expect(html).not.toContain("#/task/st-mb-4");
  });

  test("HTML-escapes item reasons and workspace names", () => {
    const h = makeHarness();
    const html = h.strandedMarkup({
      totals: { stranded: 1 },
      workspaces: [
        {
          id: "dir-X",
          label: "A & B <repo>",
          path: "/x",
          stranded: 1,
          strandedItems: [{ workId: "t1", kind: "idea", reason: "idea <pending> & \"stuck\"" }],
        },
      ],
    });
    expect(html).toContain("A &amp; B &lt;repo&gt;");
    expect(html).toContain("idea &lt;pending&gt; &amp; &quot;stuck&quot;");
    expect(html).not.toContain("<repo>");
  });

  test("PART 2 — an idle_responder entry folds into the ONE panel with a distinct idle badge + workspace href", () => {
    const h = makeHarness();
    // A dead/disabled item and a LIVE-but-IDLE item coexist in the SAME panel (combined count 2).
    const html = h.strandedMarkup({
      totals: { stranded: 2 },
      workspaces: [
        {
          id: "dir-A",
          label: "Project Alpha",
          path: "/home/me/alpha",
          stranded: 2,
          strandedItems: [
            { workId: "task-idea-1", kind: "idea", reason: "idea task pending; CTO gave up (dead)" },
            { workId: "dir-A", kind: "idle_responder", reason: "CTO idle — 3 item(s) awaiting action, responder not acting" },
          ],
        },
      ],
    });
    // ONE panel, combined count of both kinds.
    expect(html).toContain("stranded-panel");
    expect(html).toContain(">2</span>");
    // The idle entry: friendly label + distinct badge class + verbatim reason.
    expect(html).toContain("idle — not acting");
    expect(html).toContain("stranded-kind--idle");
    expect(html).toContain("CTO idle — 3 item(s) awaiting action, responder not acting");
    // The idle summary routes to the workspace/CTO view (workId === directory id), never #/task/.
    expect(html).toContain('href="#/workspace/dir-A"');
    expect(html).not.toContain("#/task/dir-A");
    // The dead/disabled sibling still renders in the same panel (distinct, red badge — no idle mod).
    expect(html).toContain("idea awaiting spec");
    expect(html).toContain("idea task pending; CTO gave up (dead)");
  });

  test("absent (empty string) when nothing is stranded — totals.stranded === 0", () => {
    const h = makeHarness();
    expect(h.strandedMarkup({ totals: { stranded: 0 }, workspaces: [] })).toBe("");
    // Defensive: missing totals also yields the calm empty state, never a thrown error.
    expect(h.strandedMarkup({ workspaces: [] })).toBe("");
    expect(h.strandedMarkup({})).toBe("");
  });
});
