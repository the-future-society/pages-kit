#!/usr/bin/env node
// Writes pm-css.js from pm.css: `PM_CSS` (pm.css, JSON-escaped) plus `ensurePmCss()`.
// pm.css is the Power Maps page's stylesheet from the 2026-10-15 design hand-off (Claude Design);
// like kit.css it cannot be linked from a CDN on a claude.ai artifact page, so the power-map
// elements inject it themselves. Run after every pm.css edit:  node kit/scripts/build_pm_css.mjs
// test/pm-css.test.js fails if the two files drift.
import { readFileSync, writeFileSync } from "node:fs";

const css = readFileSync(new URL("../pm.css", import.meta.url), "utf8");
const out = `// generated from pm.css by scripts/build_pm_css.mjs — do not edit
/* The Power Maps page's styles (tokens on .pm, light/dark, phone at 720px). Every power-map
 * element (K1–K6) calls ensurePmCss() in connectedCallback; the first call injects ONE
 * <style data-tfs-pm>, later calls return it. It goes straight AFTER the kit's own
 * <style data-tfs-kit> when that is there (so pm rules win ties with kit rules), else first in
 * <head> (so the page's own rules win ties with both). <html data-tfs-no-kit-css> opts out of
 * this sheet too. Resets are :where() (zero specificity) — never add a \`.pm button\` rule. */
export function ensurePmCss(doc = globalThis.document) {
  if (!doc || !doc.documentElement || typeof doc.createElement !== "function") return null;
  if (doc.documentElement.hasAttribute("data-tfs-no-kit-css")) return null;
  const existing = doc.querySelector("style[data-tfs-pm]");
  if (existing) return existing;
  const style = doc.createElement("style");
  style.setAttribute("data-tfs-pm", "");
  style.textContent = PM_CSS;
  const parent = doc.head || doc.documentElement;
  const kit = doc.querySelector("style[data-tfs-kit]");
  const after = kit && kit.parentNode === parent ? kit.nextSibling : parent.firstChild;
  parent.insertBefore(style, after);
  return style;
}

export const PM_CSS = ${JSON.stringify(css)};
`;
writeFileSync(new URL("../pm-css.js", import.meta.url), out);
console.log(`wrote pm-css.js (${css.length} chars of CSS)`);
