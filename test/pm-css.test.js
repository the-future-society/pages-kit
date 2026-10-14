import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { PM_CSS, ensurePmCss } from "../pm-css.js";

const KIT_PM = readFileSync(new URL("../pm.css", import.meta.url), "utf8");

test("pm-css.js is pm.css, verbatim (regenerate: node scripts/build_pm_css.mjs)", () => {
  assert.equal(PM_CSS, KIT_PM);
  const src = readFileSync(new URL("../pm-css.js", import.meta.url), "utf8");
  assert.match(src, /^\/\/ generated from pm\.css by scripts\/build_pm_css\.mjs — do not edit\n/);
  // The only escaping is JSON's: the source holds exactly JSON.stringify(pm.css).
  assert.ok(src.includes(`export const PM_CSS = ${JSON.stringify(KIT_PM)};`));
});


/** Every selector in a stylesheet (comments stripped, @media bodies included). */
function selectors(css) {
  const out = [];
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of body.matchAll(/([^{}]+)\{/g)) {
    const s = m[1].trim();
    if (!s || s.startsWith("@")) continue;
    let depth = 0, cur = "";
    for (const ch of s) {   // split on top-level commas only: `:where(button,input)` is one selector
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
    }
    out.push(cur.trim());
  }
  return out;
}

// HANDOFF §6: `.pm button{color:inherit}` once beat `.btn` and made primary buttons unreadable.
// Resets must stay zero-specificity (:where); no `.pm button` (or input/select/textarea) outside it.
test("no `.pm button` selector outside :where() — the resets stay zero-specificity", () => {
  const sels = selectors(PM_CSS);
  assert.ok(sels.length > 100, "selectors were parsed");
  assert.ok(sels.some((s) => s.startsWith(":where(.pm) :where(button")), "the :where() reset is kept");
  for (const s of sels) {
    const bare = s.replace(/:where\([^()]*\)/g, "");
    assert.doesNotMatch(bare, /\.pm(\[[^\]]*\]|\.[\w-]+)*\s+(button|input|select|textarea)\b/, `unsafe reset: ${s}`);
    assert.doesNotMatch(bare, /^(button|input|select|textarea)\b/, `unscoped element rule: ${s}`);
  }
});

function fakeDoc({ head = true, optOut = false, kit = false } = {}) {
  const el = (tag) => ({
    tagName: tag, attrs: {}, children: [], textContent: "", parentNode: null,
    setAttribute(k, v) { this.attrs[k] = String(v); },
    hasAttribute(k) { return k in this.attrs; },
    get firstChild() { return this.children[0] ?? null; },
    get nextSibling() { const p = this.parentNode; if (!p) return null; return p.children[p.children.indexOf(this) + 1] ?? null; },
    insertBefore(node, ref) {
      const i = ref ? this.children.indexOf(ref) : this.children.length;
      this.children.splice(i < 0 ? this.children.length : i, 0, node);
      node.parentNode = this;
      return node;
    },
  });
  const root = el("html");
  if (optOut) root.setAttribute("data-tfs-no-kit-css", "");
  const h = head ? el("head") : null;
  if (h) {
    if (kit) { const k = el("style"); k.setAttribute("data-tfs-kit", "1.8.0"); h.insertBefore(k, null); }
    h.insertBefore(el("meta"), null); h.insertBefore(el("style"), null);
  }
  const all = () => [...(h ? h.children : []), ...root.children];
  return {
    documentElement: root, head: h, createElement: el,
    querySelector(sel) {
      const attr = { "style[data-tfs-pm]": "data-tfs-pm", "style[data-tfs-kit]": "data-tfs-kit" }[sel];
      assert.ok(attr, `unexpected selector ${sel}`);
      return all().find((n) => n.tagName === "style" && n.hasAttribute(attr)) ?? null;
    },
  };
}

test("ensurePmCss injects one <style data-tfs-pm>, first in <head> without the kit's sheet", () => {
  const doc = fakeDoc();
  const s = ensurePmCss(doc);
  assert.equal(doc.head.children[0], s);
  assert.ok(s.hasAttribute("data-tfs-pm"));
  assert.equal(s.textContent, PM_CSS);
  assert.equal(ensurePmCss(doc), s);
  assert.equal(doc.head.children.filter((n) => n.hasAttribute("data-tfs-pm")).length, 1);
});

test("it goes straight after the kit's <style data-tfs-kit>, so pm rules win ties with kit rules", () => {
  const doc = fakeDoc({ kit: true });
  const s = ensurePmCss(doc);
  assert.ok(doc.head.children[0].hasAttribute("data-tfs-kit"));
  assert.equal(doc.head.children[1], s);
});

test("falls back to <html> without a <head>; data-tfs-no-kit-css opts out; no DOM is a no-op", () => {
  const bare = fakeDoc({ head: false });
  const placed = ensurePmCss(bare);
  assert.equal(bare.documentElement.children[0], placed);
  const out = fakeDoc({ optOut: true });
  assert.equal(ensurePmCss(out), null);
  assert.equal(out.head.children.length, 2);
  assert.equal(globalThis.document, undefined);
  assert.equal(ensurePmCss(), null);
});
