import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { KIT_CSS } from "../kit-css.js";
import { injectKitStyles, KIT_VERSION } from "../kit.js";

test("kit-css.js is kit.css, verbatim (regenerate: node scripts/build_kit_css.mjs)", () => {
  assert.equal(KIT_CSS, readFileSync(new URL("../kit.css", import.meta.url), "utf8"));
  const src = readFileSync(new URL("../kit-css.js", import.meta.url), "utf8");
  assert.match(src, /^\/\/ generated from kit\.css by scripts\/build_kit_css\.mjs — do not edit\n/);
});

// A minimal fake DOM: enough to watch where the style goes and that it goes once.
function fakeDoc({ head = true, optOut = false } = {}) {
  const el = (tag) => ({
    tagName: tag, attrs: {}, children: [], textContent: "",
    setAttribute(k, v) { this.attrs[k] = String(v); },
    hasAttribute(k) { return k in this.attrs; },
    get firstChild() { return this.children[0] ?? null; },
    insertBefore(node, ref) {
      const i = ref ? this.children.indexOf(ref) : this.children.length;
      this.children.splice(i < 0 ? this.children.length : i, 0, node);
      return node;
    },
  });
  const root = el("html");
  if (optOut) root.setAttribute("data-tfs-no-kit-css", "");
  const h = head ? el("head") : null;
  if (h) h.children.push(el("meta"), el("style"));
  const all = () => [...(h ? h.children : []), ...root.children];
  return {
    documentElement: root, head: h, createElement: el,
    querySelector(sel) {
      assert.equal(sel, "style[data-tfs-kit]");
      return all().find((n) => n.tagName === "style" && n.hasAttribute("data-tfs-kit")) ?? null;
    },
  };
}

test("injects once, FIRST in <head>, so the page's own styles win ties", () => {
  const doc = fakeDoc();
  const s = injectKitStyles(doc);
  assert.equal(doc.head.children[0], s);
  assert.equal(s.attrs["data-tfs-kit"], KIT_VERSION);
  assert.equal(s.textContent, KIT_CSS);
  assert.equal(injectKitStyles(doc), s);
  assert.equal(doc.head.children.filter((n) => n.hasAttribute("data-tfs-kit")).length, 1);
});

test("falls back to <html> without a <head>", () => {
  const doc = fakeDoc({ head: false });
  const s = injectKitStyles(doc);
  assert.equal(doc.documentElement.children[0], s);
});

test("data-tfs-no-kit-css on <html> opts out", () => {
  const doc = fakeDoc({ optOut: true });
  assert.equal(injectKitStyles(doc), null);
  assert.equal(doc.head.children.length, 2);
});

test("no DOM (Node): importing the kit and calling it are no-ops", () => {
  assert.equal(globalThis.document, undefined);
  assert.equal(injectKitStyles(), null);
});
