// The SIDE-EFFECT half of the DOM harness: importing this module installs happy-dom.
//
// It exists because of ES module hoisting, and it is not sugar. `@testing-library/react` calls
// `beforeAll()` AT IMPORT TIME (dist/index.js:44, via its act-compat shim) and its module graph
// wants a `document`. So a React test cannot say:
//
//     import { registerDom } from "./dom-env.ts";
//     registerDom();                                  // ← runs LAST, after every import
//     import { render } from "@testing-library/react"; // ← already evaluated, with no DOM
//
// Imports hoist and evaluate in source order, before any statement in the file body. Nor can the
// registration move into a `beforeAll()`, for the same reason plus a second one: bun refuses a
// nested `beforeAll` ("Cannot call beforeAll() inside a test"). The only hook that runs early
// enough is another MODULE, imported first. That is this file.
//
// Usage — this import MUST come before any React import, and a formatter that sorts imports
// alphabetically will silently break it, so keep the eslint-style pin comment:
//
//     import "./dom-register.ts"; // must precede every React import — installs `document`
//     import { render, cleanup } from "@testing-library/react";
//     import { afterAll } from "bun:test";
//     import { unregisterDom } from "./dom-env.ts";
//     afterAll(unregisterDom);   // or metrics-view.test.ts's tripwire inherits this file's DOM
//
// >>> DO NOT USE `screen`. USE THE QUERIES `render()` RETURNS. <<< Measured, not guessed.
// `@testing-library/dom`'s screen.js binds `screen` AT MODULE EVAL to `document.body`, or — when
// there is no document — to a set of helpers that throw "For queries bound to document.body a
// global document has to be available". Under bun, that CJS module graph is hoisted ABOVE this
// ESM side-effect import, so it evaluates while `document` is still undefined and `screen` is
// permanently poisoned even though `document` exists by the time the test body runs. Importing
// `@testing-library/dom` directly happens to evaluate late enough; going through
// `@testing-library/react` does not. `render()`'s returned queries bind to the container at CALL
// time and are immune. test/dom-env.test.ts demonstrates the working shape.
//
// The `afterAll(unregisterDom)` is NOT optional while `test/metrics-view.test.ts` still asserts
// `typeof globalThis.document === "undefined"`. `bun test` runs every file in one process; a DOM
// left standing here is a DOM standing in the next file. Phase 4e deletes the tripwire, moves
// `registerDom()` into `test/test-setup.ts`'s preload, and deletes this module.
import { registerDom } from "./dom-env.ts";

registerDom();
