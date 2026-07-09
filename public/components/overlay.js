// The OVERLAY cluster — the shared modal scaffold and the one modal complex enough to have
// its own module-level state machine (the directory picker). Both mount themselves on
// `document.body` and own their own dismissal (Escape + backdrop click), so a caller never
// hand-rolls the backdrop/keydown dance.
//
// NOT here: `action()`, the async-action-button helper. It is a BUTTON concern (RFC D6), not an
// overlay one, and Phase 4 landed it in components/button.js alongside the Button it belongs to.
// Its `onDone` defaults to `render()` — imported from core/nav.js, never from app.js, so that
// the components/ -> app.js cycle stays closed. See that module's header.
//
// DOM-free at module load, like everything under components/: nothing here touches `document`
// until a function is CALLED.
import { el } from "../core/dom.js";
import { api, toast } from "../core/api.js";

// Shared modal scaffold. Builds the backdrop + modal, wires Escape and
// backdrop-click to close, and mounts it on document.body — the identical ~12
// lines every modal otherwise hand-rolls. Pass `title` for the standard head
// (title + ✕ close button) and `body`/`footer` nodes for static content; or omit
// them and paint into the returned `modal` element yourself (the picker rebuilds
// its own head/list/foot on each navigation). Returns { close, backdrop, modal }.
export function openModal({ title, body, footer } = {}) {
  const backdrop = el("div", { class: "modal-backdrop" });
  const modal = el("div", { class: "modal" });
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  function close() { backdrop.remove(); document.removeEventListener("keydown", onKey); }
  function onKey(e) { if (e.key === "Escape") close(); }
  document.addEventListener("keydown", onKey);

  if (title != null) {
    const head = el("div", { class: "m-head" });
    head.appendChild(el("h3", {}, title));
    const x = el("button", { class: "btn ghost" }, "✕");
    x.addEventListener("click", close);
    head.appendChild(x);
    modal.appendChild(head);
  }
  if (body) modal.appendChild(body);
  if (footer) modal.appendChild(footer);

  document.body.appendChild(backdrop);
  return { close, backdrop, modal };
}

// ---------- workspace picker modal ----------
// onSelect(path, register): register=false fills the field; true registers now.
export function openPicker(onSelect) {
  let cur = null;

  // No title/body/footer: the picker repaints its own head/list/foot on each
  // navigation, so it just borrows openModal's backdrop/Escape/close scaffold.
  const { close, modal } = openModal();

  async function load(path) {
    let data;
    try {
      data = await api("GET", "/fs" + (path ? "?path=" + encodeURIComponent(path) : ""));
    } catch (e) { toast(e.message, true); return; }
    cur = data;
    paint();
  }

  function paint() {
    modal.innerHTML = "";
    const head = el("div", { class: "m-head" });
    head.appendChild(el("h3", {}, "Choose a git repository"));
    const homeBtn = el("button", { class: "btn ghost" }, "Home");
    homeBtn.addEventListener("click", () => load(cur.home));
    const x = el("button", { class: "btn ghost" }, "✕");
    x.addEventListener("click", close);
    head.appendChild(homeBtn);
    head.appendChild(x);
    modal.appendChild(head);

    modal.appendChild(el("div", { class: "m-path" }, cur.path));

    const list = el("div", { class: "m-list" });
    if (cur.parent) {
      const up = el("div", { class: "fs-row up" }, [
        el("span", { class: "ic" }, "↑"),
        el("span", { class: "nm" }, ".. (up)"),
      ]);
      up.addEventListener("click", () => load(cur.parent));
      list.appendChild(up);
    }
    if (cur.entries.length === 0) {
      list.appendChild(el("div", { class: "muted m-empty" }, "(no subfolders)"));
    }
    for (const e of cur.entries) {
      const row = el("div", { class: "fs-row" });
      row.appendChild(el("span", { class: "ic" }, e.isGitRepo ? "◆" : "▸"));
      row.appendChild(el("span", { class: "nm" }, e.name));
      if (e.isGitRepo) {
        const badge = el("span", { class: "git-badge" }, "git");
        row.appendChild(badge);
        const reg = el("button", { class: "btn" }, "Register");
        reg.addEventListener("click", (ev) => { ev.stopPropagation(); onSelect(e.path, true); close(); });
        row.appendChild(reg);
      }
      row.addEventListener("click", () => load(e.path));
      list.appendChild(row);
    }
    modal.appendChild(list);

    const foot = el("div", { class: "m-foot" });
    if (cur.isGitRepo) {
      foot.appendChild(el("span", { class: "hint" }, "This folder is a git repository."));
      const reg = el("button", { class: "btn success" }, "Register this folder");
      reg.addEventListener("click", () => { onSelect(cur.path, true); close(); });
      foot.appendChild(reg);
    } else {
      foot.appendChild(el("span", { class: "hint" }, "Open a folder, or pick its path."));
      const use = el("button", { class: "btn ghost" }, "Use this path");
      use.addEventListener("click", () => { onSelect(cur.path, false); close(); });
      foot.appendChild(use);
    }
    modal.appendChild(foot);
  }

  // Start from the add-workspace modal's path field if it's open with a value, else home.
  const seed = (document.getElementById("aw-path") || {}).value || "";
  load(seed.trim() || null);
}
