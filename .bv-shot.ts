// Headless-Chrome screenshotter for the Phase 4c browser verification (CDP over WebSocket; no
// puppeteer, so package.json is untouched). Loads the workspace page in BOTH themes, waits for the
// swimlanes to paint, and writes a full-page PNG per theme. Also dumps a structural summary of what
// it actually found in the live DOM, so the verification is not "the screenshot looked fine".
const PORT = process.env.BV_PORT!;
const WS_ID = process.env.BV_WS!;
const OUT = process.env.BV_OUT!;
const CDP = process.env.BV_CDP || "9333";

const version = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let seq = 0;
const pending = new Map<number, (v: any) => void>();
const sessions = new Map<string, (v: any) => void>();
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pending.has(m.id)) pending.get(m.id)!(m);
};
const send = (method: string, params: any = {}, sessionId?: string): Promise<any> => {
  const id = ++seq;
  return new Promise((res) => {
    pending.set(id, (m) => (m.error ? res({ __err: m.error }) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
};

// One tab, reused for both themes.
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const S = (m: string, p: any = {}) => send(m, p, sessionId);

await S("Page.enable");
await S("Runtime.enable");
await S("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false });

const evaluate = async (expression: string) => {
  const r = await S("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.__err || r.exceptionDetails) throw new Error("eval failed: " + JSON.stringify(r.exceptionDetails ?? r.__err));
  return r.result.value;
};

const url = `http://127.0.0.1:${PORT}/#/workspace/${WS_ID}`;

for (const theme of ["light", "dark"] as const) {
  // Seed the theme BEFORE the document's no-flash <head> script runs, then load the SPA.
  await S("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  await Bun.sleep(600);
  await evaluate(`localStorage.setItem("butchr-theme", ${JSON.stringify(theme)})`);
  await S("Page.navigate", { url });
  await Bun.sleep(400);
  await S("Page.reload", { ignoreCache: true });

  // Wait for the lanes to actually paint (the view fetches /dashboard + /work).
  let ok = false;
  for (let i = 0; i < 60; i++) {
    await Bun.sleep(250);
    if (await evaluate(`!!document.querySelector(".swim-lane")`)) {
      ok = true;
      break;
    }
  }
  if (!ok) {
    console.log(`[${theme}] TIMED OUT waiting for .swim-lane. body =`, (await evaluate(`document.body.innerText.slice(0,600)`)) || "(empty)");
    console.log(`[${theme}] app html =`, (await evaluate(`(document.getElementById("app")||{}).innerHTML || ""`))?.slice(0, 500));
    continue;
  }
  await Bun.sleep(700); // fonts + the CTO panel's own fetch

  const summary = await evaluate(`(() => {
    const q = (s, r = document) => r.querySelector(s);
    const qa = (s, r = document) => [...r.querySelectorAll(s)];
    const cs = (el, p) => el ? getComputedStyle(el).getPropertyValue(p).trim() : null;
    const lanes = qa(".swim-lane").map((l) => ({
      title: q(".swim-title", l)?.textContent,
      badge: q(".swim-kind .kind-badge", l)?.textContent,
      statusChip: q(".swim-meta > .chip", l)?.textContent,
      lifecycle: q(".swim-meta .chip[class*='lc-']", l)?.textContent ?? null,
      leaderBtn: (() => { const h = q(".swim-leader-btn", l); const b = h && h.querySelector("button");
        return b ? { text: b.textContent, disabled: b.disabled, title: h.getAttribute("title") } : null; })(),
      prog: q(".swim-prog-txt", l)?.textContent,
      trackFillPct: q(".swim-track i", l)?.style.width ?? null,
      steps: qa(".swim-pipe:not(.swim-done-pipe) .swim-step", l).map((s) => ({
        id: q(".swim-sid", s)?.textContent, cls: s.className,
        chipBg: cs(q(".chip", s), "background-color"), chipColor: cs(q(".chip", s), "color"),
        needsYou: !!q(".swim-needs", s), dot: !!q(".swim-dot", s), xdep: q(".swim-xdep", s)?.textContent ?? null,
      })),
      empty: q(".swim-empty-txt", l)?.textContent ?? null,
      donePile: q(".swim-done-row", l)?.textContent ?? null,
      conns: qa(".swim-conn", l).length,
    }));
    const bodyBg = cs(document.body, "background-color");
    const laneBg = cs(q(".swim-lane"), "background-color");
    const laneBorder = cs(q(".swim-lane"), "border-color");
    // A blank-icon check: the inlined sprite means <svg><use> resolves to a symbol with a viewBox.
    const icons = qa("svg use").length;
    const spriteSymbols = document.querySelectorAll("svg symbol").length;
    return {
      theme: document.documentElement.dataset.theme,
      title: document.title,
      h1: q("h1")?.textContent,
      crumbs: q(".crumbs")?.textContent,
      crumbsTag: q(".crumbs")?.tagName,
      crumbsPadLeft: cs(q(".crumbs"), "padding-inline-start"),
      crumbsListStyle: cs(q(".crumbs"), "list-style-type"),
      ctoCard: q(".cto-card h2")?.textContent ?? null,
      ctoControls: qa(".cto-controls button").map((b) => b.textContent),
      newStory: q("#new-story")?.textContent ?? null,
      queueLine: q(".row.between.stacked small")?.textContent ?? null,
      pipelineH2: qa("h2").map((h) => h.textContent),
      legend: qa(".swim-legend span").map((s) => s.textContent),
      caption: q(".swim-caption")?.textContent?.slice(0, 60),
      unregister: qa(".ws-danger-zone button").map((b) => b.textContent),
      bodyBg, laneBg, laneBorder, icons, spriteSymbols,
      consoleNote: "see Runtime console below",
      lanes,
    };
  })()`);
  console.log(`\n========== ${theme.toUpperCase()} ==========`);
  console.log(JSON.stringify(summary, null, 1));

  const { data } = await S("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await Bun.write(`${OUT}/workspace-${theme}.png`, Buffer.from(data, "base64"));
  console.log(`[${theme}] wrote ${OUT}/workspace-${theme}.png`);
}

// Console errors, collected across both loads.
const errs = await evaluate(`window.__bvErrors ? window.__bvErrors : "(no hook)"`);
console.log("\nconsole hook:", JSON.stringify(errs));
ws.close();
process.exit(0);
