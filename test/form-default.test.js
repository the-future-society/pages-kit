// A create form built from a served field description with a rich-text default (TFS KMS notes
// template) sends that default when the person changes nothing else. Drives the REAL
// <tfs-record-form> build path (form.js `_build` -> `_field`, where the create start value is
// `f.default`) and the REAL <tfs-rich-text> value getter, on a minimal fake DOM (no dependency).
// Fixtures are invented (public code).
import { test } from "node:test";
import assert from "node:assert/strict";
import { TfsRecordForm, TfsRichText } from "../form.js";

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.style = {}; this.ls = {}; this.dataset = {}; }
  get classList() { return { add() {}, remove() {}, toggle() {}, contains: () => false }; }
  append(...k) { this.children.push(...k); }
  replaceChildren(...k) { this.children = k; }
  setAttribute(n, v) { this.attrs[n] = v; }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  hasAttribute(n) { return n in this.attrs; }
  removeAttribute(n) { delete this.attrs[n]; }
  toggleAttribute() {}
  addEventListener(t, f) { (this.ls[t] = this.ls[t] || []).push(f); }
  removeEventListener() {}
  querySelector() { return null; }
  closest() { return null; }
}
const HOST = ["append", "setAttribute", "getAttribute", "hasAttribute", "removeAttribute", "toggleAttribute",
  "addEventListener", "removeEventListener", "querySelector", "closest", "replaceChildren"];
function asHost(obj) {
  const proto = El.prototype;
  obj.children = []; obj.attrs = {}; obj.style = {}; obj.ls = {}; obj.dataset = {};
  for (const m of HOST) obj[m] = proto[m].bind(obj);
  obj.dispatchEvent = () => true;
  return obj;
}
function withFakeDom(fn) {
  const saved = globalThis.document;
  globalThis.document = {
    createElement: (tag) => {
      if (tag !== "tfs-rich-text") return new El(tag);
      // The real editor class; only its DOM-building `editor` getter is stood in for.
      const r = asHost(new TfsRichText());
      Object.defineProperty(r, "editor", { value: new El("div") });
      return r;
    },
    createElementNS: (_ns, tag) => new El(tag),
    createTextNode: (text) => ({ text }),
    addEventListener() {},
  };
  try { return fn(); } finally { globalThis.document = saved; }
}
function createForm(fields) {
  const el = asHost(new TfsRecordForm());
  el.getAttribute = () => null; el.hasAttribute = () => false;
  el.form = { fields };
  el.record = null;            // create mode
  el._build();
  return el;
}

const TPL = "## Section one\n*A prompt line.*\n\n## Section two\n*Another prompt.*";
const FIELDS = (def) => [
  { name: "title", kind: "text", label: "Title", multi: false },
  { name: "notes", kind: "rich_text", label: "Notes", multi: false, default: def },
];

test("a create form sends the rich-text default it was served, byte for byte, when nothing is touched", () => {
  const el = withFakeDom(() => createForm(FIELDS(TPL)));
  assert.deepEqual(el.changes(), { notes: TPL });
});

test("positive control: with no served default the same untouched form sends nothing", () => {
  const el = withFakeDom(() => createForm(FIELDS(null)));
  assert.deepEqual(el.changes(), {});
});
