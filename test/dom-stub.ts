// A HAND-ROLLED, ~100-line DOM stub for the bun test runner. It exists for two reasons, and
// both are load-bearing — please read before "simplifying" it.
//
// (1) ZERO DEPENDENCIES. CONTRIBUTING §4 and the signed-off RFC (docs/rfc-frontend-design-system.md,
//     Option 0) make "no npm dependency, no build step" a HARD constraint, and a test-only
//     devDependency is still a dependency. The CTO explicitly rejected pulling in happy-dom/jsdom
//     for this. So the components/ tests get exactly the DOM surface they need and nothing else.
//
// (2) `document` MUST STAY UNDEFINED BETWEEN TESTS. test/metrics-view.test.ts asserts
//     `typeof globalThis.document === "undefined"` — that assertion is the tripwire proving no
//     module under public/ touches `document` at MODULE LOAD (a `views/ -> app.js` import would
//     otherwise sneak app.js's boot into the graph). withDom() therefore installs the stub, runs,
//     and restores in a `finally`.
//
// >>> withDom IS SYNCHRONOUS ON PURPOSE. <<< If an `await` ever sits between install and restore,
// the event loop yields with `globalThis.document` still set, bun starts the next test file, and
// metrics-view.test.ts's guard fails (or worse, passes by luck). Do not make it async. Do not
// pass it an async fn.
//
// The surface is exactly what core/dom.js's el() and svg() touch, plus what the assertions read:
// createElement / createElementNS / createTextNode / createDocumentFragment, and per node
// appendChild, setAttribute/getAttribute, addEventListener, `className`, `classList.toggle`,
// and a `textContent` GETTER that concatenates descendant text.
//
// Deliberately ABSENT: `innerHTML`. Nothing under public/ writes it any more — escaping is
// structural, and test/no-opt-in-escaping.test.ts keeps it that way — so a component that reached
// for innerHTML would throw here rather than quietly serialize. Tests assert on STRUCTURE
// (className / getAttribute / textContent), never on serialized markup. If you ever think you need
// innerHTML, add the getter deliberately and say why; do not reach for it by reflex.

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const FRAGMENT_NODE = 11;

export interface StubNode {
  nodeType: number;
  tagName?: string;
  namespaceURI?: string | null;
  childNodes: StubNode[];
  className: string;
  readonly children: StubNode[];
  readonly textContent: string;
  classList: { toggle(cls: string, force?: boolean): void };
  listeners: Record<string, Function[]>;
  appendChild(child: StubNode): StubNode;
  setAttribute(name: string, value: unknown): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, fn: Function): void;
}

function textNode(data: string): StubNode {
  return { nodeType: TEXT_NODE, childNodes: [], textContent: data } as unknown as StubNode;
}

// appendChild must SPLICE a DocumentFragment's children in (and empty it), exactly as the real
// DOM does — taskChips() returns a fragment, so every assertion downstream depends on this.
function appendChild(this: StubNode, child: StubNode): StubNode {
  if (child && child.nodeType === FRAGMENT_NODE) {
    for (const kid of child.childNodes.slice()) this.childNodes.push(kid);
    child.childNodes.length = 0;
  } else {
    this.childNodes.push(child);
  }
  return child;
}

function collectText(node: StubNode): string {
  if (node.nodeType === TEXT_NODE) return node.textContent;
  return node.childNodes.map(collectText).join("");
}

function makeNode(nodeType: number, tagName?: string, namespaceURI?: string | null): StubNode {
  const attrs = new Map<string, string>();
  const node = {
    nodeType,
    tagName,
    namespaceURI: namespaceURI ?? null,
    childNodes: [] as StubNode[],
    className: "",
    listeners: {} as Record<string, Function[]>,
    appendChild,
    setAttribute(name: string, value: unknown) { attrs.set(name, String(value)); },
    getAttribute(name: string) { return attrs.has(name) ? attrs.get(name)! : null; },
    // Recorded, never fired — the chips are presentational and register none, but el() would
    // throw without this the moment a component grows an `on*` prop.
    addEventListener(type: string, fn: Function) { (node.listeners[type] ||= []).push(fn); },
    classList: {
      toggle(cls: string, force?: boolean) {
        const set = new Set(node.className.split(/\s+/).filter(Boolean));
        const on = force === undefined ? !set.has(cls) : force;
        if (on) set.add(cls); else set.delete(cls);
        node.className = [...set].join(" ");
      },
    },
    get children() { return node.childNodes.filter((c) => c.nodeType === ELEMENT_NODE); },
    get textContent() { return collectText(node as unknown as StubNode); },
  };
  return node as unknown as StubNode;
}

const stubDocument = {
  createElement: (tag: string) => makeNode(ELEMENT_NODE, tag, null),
  createElementNS: (ns: string, tag: string) => makeNode(ELEMENT_NODE, tag, ns),
  createTextNode: (data: string) => textNode(String(data)),
  createDocumentFragment: () => makeNode(FRAGMENT_NODE),
};

// Install the stub, run `fn`, restore. SYNCHRONOUS — see the header. Returns fn's result.
export function withDom<T>(fn: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "document");
  const prev = (globalThis as any).document;
  (globalThis as any).document = stubDocument;
  try {
    return fn();
  } finally {
    if (had) (globalThis as any).document = prev;
    else delete (globalThis as any).document;
  }
}
