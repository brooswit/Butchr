// ---------- in-flight UI state preservation across SSE re-renders ----------
//
// THROWAWAY, WITH THE BRIDGE. RFC Phase 4 deletes this file, its three sentinel blocks, and
// test/app-restore-uistate.test.ts along with them (§1.4, §9.4). It exists only because the SSE path
// still drives a VANILLA render: nav.js's mount() clears `#app` and rebuilds it, which would discard
// the operator's scroll position, focus, and any text typed into a not-yet-submitted input. React's
// reconciliation makes all of it unnecessary the moment the views themselves are React — a controlled
// input that is never unmounted keeps its value, its caret, and its focus for free. Do not invest
// here, and do not generalize it.
//
// It moved here VERBATIM from public/app.js, which Phase 3 deleted. captureUiState() snapshots the
// state before render(); restoreUiState() re-applies it after, keyed by a stable data-restore-key on
// each input — so a state-change event arriving mid-typing doesn't lose the text, caret, focus, or
// scroll. Targeted (only these inputs), and used ONLY on the SSE path — plain navigation
// (route change / boot) intentionally starts fresh.
//
// DOM-free at module load: `document` and `window` are touched only inside a called function.
//
// The three `<test-extract:…>` sentinel fences are read by test/app-restore-uistate.test.ts, which
// evals the fenced source against a hand-rolled fake DOM. They are the last sentinel scrapes in the
// repo. Do not add another; do not renumber these.
import { setPendingInlineRestore } from "./views/diff.js";

// <test-extract:capture-ui-state> (fenced for test/app-restore-uistate.test.ts)
function captureUiState() {
  const values = new Map();
  document.querySelectorAll("[data-restore-key]").forEach((node) => {
    const key = node.dataset.restoreKey;
    // The inline-comment editor lives inside the async-fetched diff; it's captured
    // separately below and restored via wireDiff, so skip it in the generic pass.
    if (key === "inline-comment") return;
    values.set(key, { value: node.value || "", selStart: node.selectionStart, selEnd: node.selectionEnd });
  });
  // An open (uncommitted) inline-comment editor: record the diff line it's attached to
  // (by the line's stable data-key) plus its text + caret, for wireDiff to re-open.
  let inline = null;
  const ie = document.querySelector(".dl-comment-edit .dlc-input");
  if (ie) {
    const dl = ie.closest(".dl-comment-edit") && ie.closest(".dl-comment-edit").previousElementSibling;
    const lineKey = dl && dl.dataset ? dl.dataset.key : null;
    if (lineKey) inline = { key: lineKey, value: ie.value || "", selStart: ie.selectionStart, selEnd: ie.selectionEnd };
  }
  const ae = document.activeElement;
  const activeKey = ae && ae.dataset ? (ae.dataset.restoreKey || null) : null;
  return { scrollY: window.scrollY, activeKey, values, inline };
}
// </test-extract:capture-ui-state>

// Re-apply a captured snapshot. Resilient by design: any element/key may have vanished
// between renders (the new view may not contain that input at all), so every lookup is
// guarded and nothing here may throw — render() must stay green.
// <test-extract:restore-ui-state> (fenced for test/app-restore-uistate.test.ts)
function restoreUiState(snap) {
  if (!snap) return;
  try { window.scrollTo(0, snap.scrollY || 0); } catch (e) { /* ignore */ }
  for (const [key, st] of snap.values) {
    if (key === snap.activeKey) continue; // restore the focused one last so focus sticks
    applyInputRestore(key, st, false);
  }
  if (snap.activeKey && snap.values.has(snap.activeKey)) {
    applyInputRestore(snap.activeKey, snap.values.get(snap.activeKey), true);
  }
  // Hand any open inline-comment editor to wireDiff (the diff is fetched asynchronously,
  // so its line rows don't exist yet at this point). The cell lives in views/diff.js, which
  // consumes it; an imported binding is read-only, so we write it through its setter.
  setPendingInlineRestore(snap.inline || null);
}
// </test-extract:restore-ui-state>

// <test-extract:apply-input-restore> (fenced for test/app-restore-uistate.test.ts)
function applyInputRestore(key, st, focus) {
  // data-restore-key values are controlled constant slugs, safe in an attribute selector.
  const node = document.querySelector('[data-restore-key="' + key + '"]');
  if (!node) return;
  // These are uncommitted fields — a fresh render produces them empty — so only restore
  // when we captured text AND the rendered field is still empty (never clobber content).
  if (st.value && !node.value) {
    node.value = st.value;
    try {
      if (typeof st.selStart === "number" && node.setSelectionRange) node.setSelectionRange(st.selStart, st.selEnd);
    } catch (e) { /* ignore */ }
  }
  if (focus) { try { node.focus(); } catch (e) { /* ignore */ } }
}
// </test-extract:apply-input-restore>

// Exported OUTSIDE the sentinel fences, deliberately. test/app-restore-uistate.test.ts evals the
// fenced source as the body of a `new Function`, where an `export` keyword is a syntax error.
export { applyInputRestore, captureUiState, restoreUiState };
