#!/usr/bin/env node
// Writes kit-css.js from kit.css: `export const KIT_CSS = "<kit.css, JSON-escaped>";`.
// claude.ai artifact pages admit stylesheets only from the artifact itself and Google Fonts,
// so a <link> to kit.css on a CDN is blocked; kit.js imports KIT_CSS and injects it instead.
// Run after every kit.css edit:  node kit/scripts/build_kit_css.mjs   (no dependencies).
// test/kit-css.test.js fails if the two files drift.
import { readFileSync, writeFileSync } from "node:fs";

const css = readFileSync(new URL("../kit.css", import.meta.url), "utf8");
const out = "// generated from kit.css by scripts/build_kit_css.mjs — do not edit\n"
  + `export const KIT_CSS = ${JSON.stringify(css)};\n`;
writeFileSync(new URL("../kit-css.js", import.meta.url), out);
console.log(`wrote kit-css.js (${css.length} chars of CSS)`);
