// The front-end entry point. `public/index.html` names this file; bun follows the
// `<script type="module" src="./main.tsx">` into it, bundles the graph, and rewrites the HTML.
//
// IMPORT ORDER IS LOAD-BEARING — do not let a formatter sort these.
//
//   1-2. The two token stylesheets. BOTH are required and neither is optional: @launchpad-ui's
//        component CSS var()s ~187 `--lp-*` names and DEFINES ONE, so a page missing these renders
//        UNSTYLED while the build still exits 0. `index.css` declares the tokens under `:root`;
//        `themes.css` declares them under `:root,[data-theme]` and `[data-theme='dark']` — that is
//        where the colour VALUES live, so importing index.css alone leaves the page mis-coloured.
//        `@launchpad-ui/tokens/style.css` does NOT exist (only `components` and `icons` expose one);
//        do not pattern-match the specifier from its siblings. `bun run assert:fe` fails the gate if
//        either sheet ever falls out of the bundle (RFC §2.5, §4.3).
//   3.   `./App` — importing it pulls @launchpad-ui/components' and /icons' own stylesheets into the
//        graph HERE, ahead of butchr's.
//   4.   butchr's `style.css`, LAST, so its rules win any specificity tie with the component CSS and
//        its `:root` alias block (§7.4) is the final word on `--bg`/`--text`/`--accent`.
import "@launchpad-ui/tokens/index.css";
import "@launchpad-ui/tokens/themes.css";
import { App } from "./App";
import "./style.css";

import { createRoot } from "react-dom/client";
import { ensureStateMeta } from "./state-meta-store";

const root = document.getElementById("root");
if (!root) throw new Error("main: #root is missing from index.html");

// Load the server-owned state metadata BEFORE the first render, exactly as the vanilla boot did:
// STATE_KIND / AGENT_TYPE / the status-membership lists must be populated before any view paints a
// status chip. `ensureStateMeta` never rejects — a failed fetch falls back to DEFAULT_STATE_META and
// leaves `stateMetaLoaded` false, which the SSE handler retries on the next event.
ensureStateMeta().then(() => {
  createRoot(root).render(<App />);
});
