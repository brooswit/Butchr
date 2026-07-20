// THE FRESH-INSTALL DEADLOCK, GUARDED AT THE UI LAYER.
//
// On a brand-new server with ZERO workspaces the dashboard could never create a project: the
// New-project modal required an "anchor workspace" picked from `GET /api/workspaces`, and disabled
// its submit with "no workspaces registered" when that list came back empty. The ONLY UI path to
// REGISTER a workspace lives INSIDE a project detail view — so with no project you could not add a
// workspace, and with no workspace you could not create a project. The documented escape was a raw
// `POST /api/workspaces` curl.
//
// The backend half is fixed and covered by test/project-self-hosted-home.test.ts: `createProject`
// provisions its own synthetic home (`ceo-dir-<id>`) and `POST /api/projects` takes `{ brief }`
// only. THIS suite covers the half that test cannot see — that the FORM actually submits when the
// registry is empty. Both halves are needed: the server accepting `{ brief }` is worth nothing while
// the button is greyed out.
//
// WHY `fetch` IS STUBBED AND `api` IS NOT. The assertion that matters most is the request BODY: it
// must carry `brief` and must NOT carry the removed `workspace` key (the server now ignores it
// silently — pre-1.0, no back-compat — so a stale key would NOT fail anywhere else, in the suite or
// in production; nothing but this assertion can catch it). Mocking `public/core/api.js` would assert
// against the mock's own arguments and prove nothing about the real wrapper's serialization, so the
// REAL api module runs and only the network boundary is replaced. Every requested path is recorded,
// which is what lets the "no workspace fetch at all" assertion below be a fact rather than a hope.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { NewProjectModal } from "../public/components/project-modals.tsx";

type Call = { method: string; path: string; body: Record<string, unknown> | null };

let calls: Call[];
let realFetch: typeof globalThis.fetch;

/** Record every request and answer the create with a project row. Any OTHER path resolves 404 —
 *  a blanket 200 would hide exactly the stray `/api/workspaces` fetch this suite exists to forbid. */
function stubFetch(): void {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const path = String(url);
    let body: Record<string, unknown> | null = null;
    if (init?.body) body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ method: init?.method ?? "GET", path, body });
    if (path === "/api/projects" && init?.method === "POST") {
      return new Response(JSON.stringify({ id: "pj-new", work_kind: "project" }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: `stub: unstubbed ${path}` }), { status: 404 });
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  calls = [];
  realFetch = globalThis.fetch;
  stubFetch();
  localStorage.clear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

/** Mount the modal OPEN. `onOpenChange` records closes so the success path can be asserted. */
function open(): { closed: () => boolean } {
  let closedTo: boolean | null = null;
  render(
    createElement(NewProjectModal, {
      isOpen: true,
      onOpenChange: (o: boolean) => {
        closedTo = o;
      },
    }),
  );
  return { closed: () => closedTo === false };
}

/** The brief field. It is the ONLY input the form has left. */
function briefField(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

function submitBtn(): HTMLButtonElement {
  return screen.getByRole("button", { name: /create project/i }) as HTMLButtonElement;
}

describe("New-project modal on a DB with ZERO workspaces", () => {
  test("renders with NO anchor control and an ENABLED submit", () => {
    open();

    // The select is GONE — asserted by ROLE, so it cannot be satisfied by a hidden leftover.
    //
    // COUNTS, NOT THE NODE ITSELF. `expect(queryByRole("combobox")).toBe(null)` is the same guard
    // and it DOES go red on the pre-fix modal — but bun then serializes the received
    // HTMLSelectElement, which drags in its React fiber and prints a circular graph so large the run
    // never finishes (MEASURED: killed at 60s, no summary). A failure nobody can read is a failure
    // nobody can act on, so these assert on lengths and let the message name what was found.
    expect(screen.queryAllByRole("combobox").length).toBe(0);
    expect(screen.queryAllByRole("listbox").length).toBe(0);
    expect(document.querySelectorAll("select").length).toBe(0);

    // ...and so is every string that made the old form a dead end.
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("anchor workspace");
    expect(text).not.toContain("no workspaces registered");
    expect(text).not.toContain("loading workspaces");
    expect(text).not.toContain("Register a workspace first");

    // THE POINT OF THE WHOLE STORY: submit is live with an empty registry.
    expect(submitBtn().disabled).toBe(false);
  });

  test("issues NO request on open — the workspace fetch is gone, not merely ignored", async () => {
    open();
    // Give any lingering effect a turn to fire; `waitFor` would pass instantly on an empty list, so
    // this yields first and then asserts.
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
  });

  test("submits { brief } ONLY — no `workspace` key rides along", async () => {
    const { closed } = open();

    fireEvent.change(briefField(), { target: { value: "  ship the thing  " } });
    fireEvent.click(submitBtn());

    await waitFor(() => expect(calls.length).toBe(1));
    const [call] = calls;
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/projects");
    // EXACT shape: an extra key is a failure, not a curiosity. The server ignores `workspace`
    // silently, so this is the only place a resurrected anchor param would ever be caught.
    expect(call.body).toEqual({ brief: "ship the thing" }); // trimmed
    expect(Object.keys(call.body ?? {})).toEqual(["brief"]);

    // No workspace list was consulted at any point in the flow.
    expect(calls.some((c) => c.path.includes("/workspaces"))).toBe(false);

    await waitFor(() => expect(closed()).toBe(true));
  });

  test("a blank brief is still refused — inline, and without a request", async () => {
    open();

    fireEvent.change(briefField(), { target: { value: "   " } });
    fireEvent.click(submitBtn());

    await waitFor(() => expect(document.body.textContent).toContain("Describe the project first"));
    expect(calls).toEqual([]);
  });

  test("a server failure lands INLINE and leaves the modal open", async () => {
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", path: String(url), body: null });
      return new Response(JSON.stringify({ error: "disk is full" }), { status: 500 });
    }) as typeof globalThis.fetch;

    const { closed } = open();
    fireEvent.change(briefField(), { target: { value: "a project" } });
    fireEvent.click(submitBtn());

    await waitFor(() => expect(document.body.textContent).toContain("disk is full"));
    expect(closed()).toBe(false);
    // Re-submittable: useAction re-enables the button after the rejection it swallows.
    await waitFor(() => expect(submitBtn().disabled).toBe(false));
  });
});
