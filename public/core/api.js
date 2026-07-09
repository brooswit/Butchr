// The server-fetch wrapper and the transient toast surface. DOM-free at module load:
// `toast` touches `document` only when CALLED.
import { el } from "./dom.js";

export async function api(method, path, body) {
  const res = await fetch("/api" + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error((data && data.error) || res.statusText);
  return data;
}

// Module-private: only toast() reads or clears it, so it is deliberately not exported.
let toastTimer = null;
export function toast(msg, isErr) {
  const old = document.querySelector(".toast");
  if (old) old.remove();
  const t = el("div", { class: "toast" + (isErr ? " err" : "") }, msg);
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), isErr ? 6000 : 3000);
}

// The toast confirming a terminal attach, naming the emulator butchr launched.
export function terminalToast(r) {
  toast("opened terminal" + (r.emulator ? " (" + r.emulator + ")" : ""));
}
