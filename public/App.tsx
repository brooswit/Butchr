// The React shell (RFC §10 Phase 3). It owns the chrome — topbar, pause banner, conn LED, theme
// toggle, toast region, the hash router, and the SSE stream — and NOTHING inside `#app`, which the
// still-vanilla views own through the bridge. Phase 4 moves the views in and deletes the bridge; this
// file survives it.
//
// This is the ROLLBACK BOUNDARY. Phase 4 reverts to exactly this: a LaunchPad shell wrapping the old
// view bodies, fully usable.
//
// NO <StrictMode>. Its development-only double-invoked effects would run every vanilla view render
// twice (two fetches, two mount() calls) and open the EventSource twice. React's own guarantees are
// what Phase 4 buys; until the views are React there is nothing here for StrictMode to find.

import { Alert, AlertText, Button, RouterProvider, ToastRegion, ToggleButton, toastQueue } from "@launchpad-ui/components";
import { Icon } from "@launchpad-ui/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import type { To } from "react-router";
import { HashRouter, Link, Navigate, Route, Routes, useHref, useLocation, useNavigate, useParams } from "react-router";

import { refreshSoon, VanillaView } from "./bridge";
import { setToastSink, toast } from "./components/toast.js";
import { api } from "./core/api.js";
import type { Health, Project, Repo } from "./core/types.js";
import { ensureStateMeta, isStateMetaLoaded } from "./state-meta-store";
import { renderMetrics } from "./views/metrics.js";
import { renderProjectDetail, renderProjects } from "./views/projects.js";
import { renderTask } from "./views/task.js";
import { renderWorkspace } from "./views/workspace.js";

const BASE_TITLE = "butchr";
const THEME_KEY = "butchr-theme";

type Attention = {
  total: number;
  in_review?: number;
  spec_review?: number;
  needs_info?: number;
};

// ---------- needs-attention signal ----------
// A live pull-signal so the operator gets drawn in instead of polling: GET /health reports
// needsAttention { in_review, spec_review, needs_info, total } and we reflect it as a tab-title badge
// ("(2) butchr") plus a header indicator that links to the Projects overview. When permitted, a Web
// Notification fires as a task NEWLY enters a feedback state.

/** Fire a desktop notification when a task NEWLY enters a feedback state (a count went up since the
 *  last poll). Fully gated on granted permission, so it is silent until the operator opts in by
 *  clicking the header indicator. `prev` is null on the first poll — establish a baseline, don't
 *  alert. */
function maybeNotify(na: Attention, prev: Attention | null): void {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (!prev) return;
  const newInReview = (na.in_review || 0) - (prev.in_review || 0);
  const newSpecReview = (na.spec_review || 0) - (prev.spec_review || 0);
  const newNeedsInfo = (na.needs_info || 0) - (prev.needs_info || 0);
  if (newInReview <= 0 && newSpecReview <= 0 && newNeedsInfo <= 0) return;
  const bits: string[] = [];
  if (newInReview > 0) bits.push(`${newInReview} ready for review`);
  if (newSpecReview > 0) bits.push(`${newSpecReview} spec ready for review`);
  if (newNeedsInfo > 0) bits.push(`${newNeedsInfo} awaiting an answer`);
  try {
    new Notification("butchr — needs attention", { body: bits.join(", "), tag: "butchr-attention" });
  } catch {
    /* notifications unavailable — ignore */
  }
}

function attentionTitle(na: Attention): string {
  const parts: string[] = [];
  if (na.in_review) parts.push(`${na.in_review} in review`);
  if (na.spec_review) parts.push(`${na.spec_review} spec review`);
  if (na.needs_info) parts.push(`${na.needs_info} needs info`);
  return "Needs attention: " + (parts.length ? parts.join(", ") : `${na.total} tasks`);
}

/** GET /health, which carries BOTH the dispatcher's pause state and the needs-attention counts, so
 *  one poll tracks pause/resume and review transitions live regardless of which page is open. A
 *  transient failure (e.g. a degraded /health 503) keeps the last values rather than clearing them. */
function useHealth() {
  const [paused, setPaused] = useState(false);
  const [attention, setAttention] = useState<Attention | null>(null);
  const previous = useRef<Attention | null>(null);

  const refresh = useCallback(async () => {
    let health: Health;
    try {
      health = await api<Health>("GET", "/health");
    } catch {
      return;
    }
    if (health && typeof health.paused === "boolean") setPaused(health.paused);
    const na: Attention | undefined = health && health.needsAttention;
    if (!na) return;
    maybeNotify(na, previous.current);
    previous.current = {
      in_review: na.in_review || 0,
      spec_review: na.spec_review || 0,
      needs_info: na.needs_info || 0,
      total: na.total,
    };
    setAttention(na);
  }, []);

  // The tab-title badge. Owned here rather than in the topbar, because it must track `attention`
  // whether or not any topbar node is rendered.
  useEffect(() => {
    const total = attention ? attention.total : 0;
    document.title = (total > 0 ? `(${total}) ` : "") + BASE_TITLE;
  }, [attention]);

  return { paused, setPaused, attention, refresh };
}

// ---------- theme ----------
// The initial `data-theme` is stamped by the no-flash <head> script in index.html, before first
// paint; this only keeps the toggle in sync and persists the choice. @launchpad-ui/tokens' themes.css
// keys off the SAME attribute on the SAME element, so the tokens re-resolve with no further wiring —
// CSS custom properties cascade (RFC §7.5).
function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* private mode — the toggle still works for this session */
    }
  }, [theme]);
  return { theme, setTheme };
}

// ---------- topbar ----------

function Topbar({
  paused,
  onTogglePause,
  attention,
  conn,
}: {
  paused: boolean;
  onTogglePause: () => void;
  attention: Attention | null;
  conn: "connecting" | "up" | "down";
}) {
  const { theme, setTheme } = useTheme();
  const { pathname } = useLocation();
  // Only two nav items: Metrics owns `/metrics`, Projects owns everything else (the overview, a
  // project, a nested or flat workspace, a task). A flat `#/workspace/:wid` is transient — it
  // redirects to its nested home — so lighting Projects during that hop keeps the nav stable.
  const owningHref = pathname.startsWith("/metrics") ? "#/metrics" : "#/projects";

  // Clicking the header indicator opts into desktop notifications (requestPermission needs a user
  // gesture) on its way to the Projects overview. The Link handles navigation.
  const optIntoNotifications = () => {
    if ("Notification" in window && Notification.permission === "default") {
      try {
        void Notification.requestPermission();
      } catch {
        /* ignore */
      }
    }
  };

  const connLabel = conn === "up" ? "live" : conn === "down" ? "reconnecting…" : "connecting…";

  return (
    <header className="topbar">
      <Link to="/" className="brand">
        butchr<span className="dot">·</span>
      </Link>
      <nav className="topnav">
        <TopnavLink to="/projects" owningHref={owningHref}>
          Projects
        </TopnavLink>
        <TopnavLink to="/metrics" owningHref={owningHref}>
          Metrics
        </TopnavLink>
      </nav>
      <div className="topbar-right">
        {attention && attention.total > 0 ? (
          <Link to="/projects" className="attention" title={attentionTitle(attention)} onClick={optIntoNotifications}>
            {attention.total}
          </Link>
        ) : null}
        {/* `primary`, not `destructive`: resuming dispatch is not a destructive action, and LaunchPad
            has no warning-coloured Button variant to stand in for the old `.pause-toggle.paused`
            orange. The label and the banner carry the state; the fill just makes it prominent. */}
        <Button
          size="small"
          variant={paused ? "primary" : "minimal"}
          onPress={onTogglePause}
          aria-label={paused ? "Resume new task dispatch" : "Pause new task dispatch"}
        >
          <Icon name={paused ? "play" : "pause"} size="small" />
          {paused ? "Resume" : "Pause"}
        </Button>
        <ToggleButton
          size="small"
          variant="minimal"
          isSelected={theme === "dark"}
          onChange={(isDark) => setTheme(isDark ? "dark" : "light")}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          {/* Show the icon for the theme you'd switch TO. Both symbols live in the inlined sprite —
              a blank 20x20 box here means scripts/inline-sprite did not run. */}
          <Icon name={theme === "dark" ? "theme-light" : "theme-dark"} size="small" />
        </ToggleButton>
        <div className={`conn ${conn === "connecting" ? "" : conn}`} title="live connection">
          <span className="led" />
          <span className="conn-label">{connLabel}</span>
        </div>
      </div>
    </header>
  );
}

function TopnavLink({ to, owningHref, children }: { to: string; owningHref: string; children: string }) {
  const active = `#${to}` === owningHref;
  return (
    <Link to={to} className={active ? "topnav-link active" : "topnav-link"} aria-current={active ? "page" : undefined}>
      {children}
    </Link>
  );
}

// ---------- dispatcher pause / maintenance mode ----------
// A global switch that stops NEW agent dispatch (drain-only) for restarts / recovery / maintenance,
// without disturbing running/review/idle tasks. The state comes from GET /health (`paused`), is
// persisted server-side, and survives a butchr restart until resumed.

function PauseBanner({ onResume }: { onResume: () => void }) {
  return (
    <div className="pause-banner">
      {/* No `actionsLayout`: its own d.ts says "block variant only", and this is the inline variant.
          The message is ONE element — Alert lays AlertText's children out as grid rows, so a bare
          `<b>` sibling would break "PAUSED" onto a line of its own. */}
      <Alert status="warning" variant="inline" role="status" aria-live="polite">
        <AlertText>
          <span>
            <b>PAUSED</b> — new task dispatch is halted (maintenance mode). Running, review, and idle tasks continue;
            queued tasks wait until you resume.
          </span>
        </AlertText>
        <Button size="small" onPress={onResume}>
          Resume dispatch
        </Button>
      </Alert>
    </div>
  );
}

// ---------- routes ----------
// react-router in HASH history: butchr's URLs are `#/…`, operators have bookmarks, and serveStatic's
// SPA fallback is only exercised by genuinely path-like URLs — keeping the hash keeps that surface
// small (RFC §1.3). `<Navigate replace>` is the react-router spelling of app.js's
// `location.replace()`: it rewrites history rather than pushing, so Back walks UP the hierarchy
// instead of bouncing forward into the redirect again.

/** Map a flat workspace/repo id to the PROJECT that owns it. The repo IS a work node whose id ===
 *  the workspace id, registered under a project via parent_id; there is no single "which project owns
 *  this repo" endpoint, so we scan the SAME REST surface the Projects overview uses. Returns the
 *  owning project id, or null when no project claims it (an un-adopted repo → render it FLAT) or on
 *  any error (best-effort; never throws). */
async function projectIdForWorkspace(wid: string): Promise<string | null> {
  try {
    const projects = await api<Project[]>("GET", "/projects");
    const matches = await Promise.all(
      (projects || []).map(async (p: { id: string }) => {
        try {
          const repos = await api<Repo[]>("GET", "/projects/" + encodeURIComponent(p.id) + "/repos");
          return Array.isArray(repos) && repos.some((r) => r && r.id === wid) ? p.id : null;
        } catch {
          return null;
        }
      }),
    );
    return matches.find(Boolean) || null;
  } catch {
    return null;
  }
}

function MetricsRoute() {
  return <VanillaView id="metrics" run={renderMetrics} />;
}

function ProjectsRoute() {
  return <VanillaView id="projects" run={renderProjects} />;
}

function ProjectRoute() {
  const { projectId = "" } = useParams();
  return <VanillaView id={`project:${projectId}`} run={() => renderProjectDetail(projectId)} />;
}

function WorkspaceRoute() {
  const { projectId = "", workspaceId = "" } = useParams();
  return <VanillaView id={`workspace:${projectId}:${workspaceId}`} run={() => renderWorkspace(workspaceId, projectId)} />;
}

function TaskRoute() {
  const { taskId = "" } = useParams();
  return <VanillaView id={`task:${taskId}`} run={() => renderTask(taskId)} />;
}

/** The legacy flat `#/workspace/:wid` → `#/projects/:pid/workspaces/:wid` rewrite. The owning project
 *  is derived from the API, so the redirect cannot be expressed as a static `<Navigate>`; a repo not
 *  yet adopted by any project has no nested home and renders flat (an old bookmark still resolves). */
function LegacyWorkspaceRoute() {
  const { workspaceId = "" } = useParams();
  const navigate = useNavigate();
  const [flat, setFlat] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void projectIdForWorkspace(workspaceId).then((projectId) => {
      if (cancelled) return;
      if (projectId) {
        navigate(`/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}`, {
          replace: true,
        });
      } else {
        setFlat(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, navigate]);

  if (!flat) return null;
  return <VanillaView id={`workspace::${workspaceId}`} run={() => renderWorkspace(workspaceId, undefined)} />;
}

// ---------- shell ----------

/** Adapts react-router's `useHref` to the shape react-aria's RouterProvider calls as a hook, so
 *  LaunchPad's Link/LinkButton/Breadcrumbs render real anchors that participate in the hash router
 *  instead of navigating by full page load (RFC §1.3). The parameter is react-router's `To`, not
 *  `string` — react-router augments react-aria's RouterConfig with its own href type. */
function useLaunchPadHref(href: To): string {
  return useHref(href);
}

function Shell() {
  const navigate = useNavigate();
  const { paused, setPaused, attention, refresh } = useHealth();
  const [conn, setConn] = useState<"connecting" | "up" | "down">("connecting");

  const togglePause = useCallback(async () => {
    try {
      // Resume when currently paused, otherwise pause. The button + banner reflect the authoritative
      // `paused` the endpoint returns, not an optimistic flip.
      const r = await api<{ paused?: boolean }>("POST", paused ? "/resume" : "/pause");
      const next = !!(r && r.paused);
      setPaused(next);
      toast(next ? "dispatch paused — new tasks won't start" : "dispatch resumed");
    } catch (e) {
      toast((e as Error).message, true);
    }
  }, [paused, setPaused]);

  // Route every vanilla `toast()` call into LaunchPad's ToastRegion. Registered as a SINK rather than
  // by rewriting components/toast.js's import, deliberately: importing @launchpad-ui from a vanilla
  // leaf would drag React and a CSS import into the module graph of every view — and of the six tests
  // that import those views directly. The sink is unset in Phase 4 along with the vanilla fallback.
  useEffect(() => {
    setToastSink((msg: string, isErr: boolean) => {
      toastQueue.add({ title: msg, status: isErr ? "error" : "success" }, { timeout: isErr ? 8000 : 5000 });
    });
    return () => setToastSink(null);
  }, []);

  // ---------- SSE live updates ----------
  // `EventSource` is a browser API, not a framework concern: the stream opens once, dispatches into
  // the stores, and closes on unmount. Empty deps — this must not reconnect on a conn-LED state
  // change. `refresh` and `refreshSoon` are stable.
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onopen = () => setConn("up");
    es.onerror = () => setConn("down");
    es.onmessage = (ev) => {
      let e;
      try {
        e = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (e.type === "hello") return;
      // Self-heal a failed state-meta load: while we're still on the built-in DEFAULT_STATE_META
      // fallback, retry the fetch on this event. Once it succeeds the real server values land, the
      // store's version ticks, and every VanillaView re-renders against the authoritative set.
      if (!isStateMetaLoaded()) {
        void ensureStateMeta().then(() => {
          refreshSoon();
          void refresh();
        });
      }
      // Re-render the current view on any relevant change. Cheap enough for a single-operator local
      // tool. Refresh the needs-attention signal too, so the tab badge and header indicator track
      // review/failed transitions regardless of which page is open.
      refreshSoon();
      void refresh();
    };
    return () => es.close();
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <RouterProvider navigate={(href) => navigate(href)} useHref={useLaunchPadHref}>
      <Topbar paused={paused} onTogglePause={togglePause} attention={attention} conn={conn} />
      {paused ? <PauseBanner onResume={togglePause} /> : null}
      {/*
        THE BRIDGE CONTAINER. React renders this element and NEVER a child of it: the vanilla views
        own everything inside, through nav.js's mount(). It lives in the layout, not in a route, so no
        navigation can unmount it out from under an in-flight mount(). See bridge.tsx's header.
        Phase 4 deletes the comment and the bridge; the element stays.
      */}
      <main id="app" />
      <Routes>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route path="/metrics" element={<MetricsRoute />} />
        <Route path="/projects" element={<ProjectsRoute />} />
        <Route path="/projects/:projectId" element={<ProjectRoute />} />
        <Route path="/projects/:projectId/workspaces/:workspaceId" element={<WorkspaceRoute />} />
        <Route path="/workspace/:workspaceId" element={<LegacyWorkspaceRoute />} />
        <Route path="/task/:taskId" element={<TaskRoute />} />
        {/* An unknown hash is not an error: everything is reached project→workspace→work now, so it
            lands on the Projects overview with the URL rewritten to match what is rendered. */}
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Routes>
      <ToastRegion />
    </RouterProvider>
  );
}

export function App() {
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  );
}
