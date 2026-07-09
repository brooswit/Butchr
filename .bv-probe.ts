// Focused follow-up probe: console errors, breadcrumb separators, done-pile toggle, modal open.
const PORT = process.env.BV_PORT!;
const WS_ID = process.env.BV_WS!;
const CDP = process.env.BV_CDP || "9333";

const version = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map<number, (v: any) => void>();
const consoleMsgs: string[] = [];
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pending.has(m.id)) pending.get(m.id)!(m);
  if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type))
    consoleMsgs.push(m.params.type + ": " + m.params.args.map((a: any) => a.value ?? a.description ?? a.type).join(" ").slice(0, 200));
  if (m.method === "Runtime.exceptionThrown")
    consoleMsgs.push("EXCEPTION: " + (m.params.exceptionDetails?.exception?.description ?? "?").slice(0, 200));
  if (m.method === "Log.entryAdded" && ["error", "warning"].includes(m.params.entry.level))
    consoleMsgs.push("log/" + m.params.entry.level + ": " + String(m.params.entry.text).slice(0, 200));
};
const send = (method: string, params: any = {}, sessionId?: string): Promise<any> =>
  new Promise((res) => {
    const id = ++seq;
    pending.set(id, (m) => res(m.error ? { __err: m.error } : m.result));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const S = (m: string, p: any = {}) => send(m, p, sessionId);
await S("Page.enable");
await S("Runtime.enable");
await S("Log.enable");
await S("Network.enable");
await S("Network.setCacheDisabled", { cacheDisabled: true }); // the CSS hash changes every rebuild
await S("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false });

const evaluate = async (expression: string) => {
  const r = await S("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.__err || r.exceptionDetails) throw new Error("eval failed: " + JSON.stringify(r.exceptionDetails ?? r.__err));
  return r.result.value;
};

await S("Page.navigate", { url: `http://127.0.0.1:${PORT}/#/workspace/${WS_ID}` });
let painted = false;
for (let i = 0; i < 60; i++) {
  await Bun.sleep(250);
  if (await evaluate(`!!document.querySelector(".swim-lane")`)) {
    painted = true;
    break;
  }
}
if (!painted) {
  console.log("NEVER PAINTED. body:", await evaluate(`document.body.innerText.slice(0,400)`));
  console.log("console:", consoleMsgs.join("\n"));
  process.exit(1);
}
await Bun.sleep(900);

console.log("=== BREADCRUMBS ===");
console.log(
  JSON.stringify(
    await evaluate(`(() => {
      const ol = document.querySelector(".crumbs");
      const lis = [...ol.querySelectorAll("li")];
      return {
        olTag: ol.tagName, olClass: ol.className, display: getComputedStyle(ol).display,
        marginTop: getComputedStyle(ol).marginTop, marginBottom: getComputedStyle(ol).marginBottom,
        padLeft: getComputedStyle(ol).paddingInlineStart, listStyle: getComputedStyle(ol).listStyleType,
        rendered: ol.textContent,
        items: lis.map((li) => ({
          text: li.textContent,
          anchor: li.querySelector("a") ? li.querySelector("a").getAttribute("href") : null,
          ariaCurrent: li.querySelector("[aria-current]") ? li.querySelector("[aria-current]").getAttribute("aria-current") : null,
          afterContent: getComputedStyle(li, "::after").content,
          beforeContent: getComputedStyle(li, "::before").content,
          color: getComputedStyle(li.querySelector("a,span")).color,
        })),
      };
    })()`),
    null,
    1,
  ),
);

console.log("\n=== DONE-PILE TOGGLE (click) ===");
const before = await evaluate(`(() => {
  const row = document.querySelector(".swim-done-row");
  return { expanded: row.getAttribute("aria-expanded"), caret: row.textContent, pipe: !!row.parentElement.querySelector(".swim-done-pipe") };
})()`);
await evaluate(`document.querySelector(".swim-done-row").click()`);
await Bun.sleep(400); // React state update + commit
const after = await evaluate(`(() => {
  const row = document.querySelector(".swim-done-row");
  const pipe = row.parentElement.querySelector(".swim-done-pipe");
  return { expanded: row.getAttribute("aria-expanded"), caret: row.textContent, pipe: !!pipe,
           steps: pipe ? [...pipe.querySelectorAll(".swim-sid")].map((n) => n.textContent) : [],
           opacity: pipe ? getComputedStyle(pipe).opacity : null };
})()`);
console.log(JSON.stringify({ before, after }, null, 1));

console.log("\n=== NEW-STORY MODAL (open) ===");
await evaluate(`document.getElementById("new-story").click()`);
await Bun.sleep(700);
console.log(
  JSON.stringify(
    await evaluate(`(() => {
      const dlg = document.querySelector(".modal");
      if (!dlg) return { modal: null, bodyHtml: document.body.lastElementChild?.outerHTML?.slice(0,200) };
      const ta = dlg.querySelector("textarea");
      const wrap = dlg.parentElement;
      const cs = (el) => { const s = getComputedStyle(el); return { bg: s.backgroundColor, border: s.borderTopWidth + " " + s.borderTopColor, shadow: s.boxShadow.slice(0,30), w: s.width, display: s.display, flexDir: s.flexDirection }; };
      return {
        dialog: cs(dlg), wrapTag: wrap.tagName, wrap: cs(wrap),
        head: dlg.querySelector(".m-head h3")?.textContent,
        closeBtn: !!dlg.querySelector(".m-head button"),
        label: dlg.querySelector(".lbl")?.textContent?.slice(0, 40),
        labelDisplay: getComputedStyle(dlg.querySelector(".lbl")).display,
        fieldTag: dlg.querySelector(".field")?.tagName,
        fieldMarginBottom: getComputedStyle(dlg.querySelector(".field")).marginBottom,
        taId: ta?.id, taFont: getComputedStyle(ta).fontFamily.slice(0, 20), taMinH: getComputedStyle(ta).minHeight,
        taFocused: document.activeElement === ta,
        foot: [...dlg.querySelectorAll(".m-foot button")].map((b) => b.textContent),
        errOn: dlg.querySelector(".m-error")?.className,
      };
    })()`),
    null,
    1,
  ),
);

console.log("\n=== validate empty brief (inline error, button stays live) ===");
await evaluate(`[...document.querySelectorAll(".m-foot button")].find(b=>b.textContent==="Create story").click()`);
await Bun.sleep(400);
console.log(
  JSON.stringify(
    await evaluate(`(() => {
      const e = document.querySelector(".m-error");
      const btn = [...document.querySelectorAll(".m-foot button")].find(b=>b.textContent==="Create story");
      return { errText: e.textContent, errClass: e.className, errColor: getComputedStyle(e).color, btnDisabled: btn.disabled };
    })()`),
    null,
    1,
  ),
);

await Bun.sleep(300);
console.log("\n=== CONSOLE (errors/warnings) ===");
console.log(consoleMsgs.length ? consoleMsgs.join("\n") : "(none)");
ws.close();
process.exit(0);
