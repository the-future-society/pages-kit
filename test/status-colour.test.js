// status-colour.js against Coda's REAL status colours (the hexes the server serves, read from
// Coda 2026-10-07). The fill is Coda's colour unchanged; the text is white where white reaches
// 4.5:1 on it, else near-black; a pale fill gets a hairline so it does not vanish on white.
import { test } from "node:test";
import assert from "node:assert/strict";
import { statusChipColours, paintStatusChip } from "../status-colour.js";

const DARK = "#17191d";
const WHITE = "#ffffff";

function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const CODA = {
  "Not Started": ["#9E9E9E", DARK],
  "In Progress": ["#2F6EB5", WHITE],
  Waiting: ["#C4561D", WHITE],
  Complete: ["#2E7D45", WHITE],
  Cancelled: ["#C8283E", WHITE],
  Proposed: ["#E9ECEF", DARK],
};

for (const [name, [hex, ink]] of Object.entries(CODA)) {
  test(`${name} ${hex}: fill unchanged, ${ink === WHITE ? "white" : "dark"} text`, () => {
    const c = statusChipColours(hex);
    assert.equal(c.bg, hex.toLowerCase());
    assert.equal(c.ink, ink);
    // Whatever ink is chosen is the more readable of the two.
    const other = ink === WHITE ? DARK : WHITE;
    assert.ok(contrast(c.ink, hex) >= contrast(other, hex) || contrast(c.ink, hex) >= 4.5, `${name}: ${contrast(c.ink, hex).toFixed(2)}`);
  });
}

test("only the pale Proposed grey gets a hairline", () => {
  assert.equal(statusChipColours("#E9ECEF").line, "rgba(23,25,29,.14)");
  for (const hex of ["#9E9E9E", "#2F6EB5", "#C4561D", "#2E7D45", "#C8283E"]) assert.equal(statusChipColours(hex).line, "transparent", hex);
});

test("white text reaches AA on blue, green and red; Waiting's orange is the closest call", () => {
  for (const hex of ["#2F6EB5", "#2E7D45", "#C8283E"]) assert.ok(contrast(WHITE, hex) >= 4.5, hex);
  // #C4561D: white is 4.47:1 — a hair under 4.5, but better than dark ink (3.94), so white.
  assert.ok(contrast(WHITE, "#C4561D") > contrast(DARK, "#C4561D"));
});

test("short hex and surrounding space are accepted", () => {
  assert.equal(statusChipColours(" #fff ").bg, "#ffffff");
  assert.equal(statusChipColours("2F6EB5").bg, "#2f6eb5");
});

test("no colour, or not a hex colour: null (the neutral chip)", () => {
  for (const bad of [null, undefined, "", "blue", "#12", "#1234567", "rgb(0,0,0)", 42, {}, "#GGGGGG"]) {
    assert.equal(statusChipColours(bad), null, String(bad));
  }
});

test("paintStatusChip sets the three properties, and clears them for no colour", () => {
  const props = new Map();
  const el = { style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) } };
  paintStatusChip(el, "#2F6EB5");
  assert.deepEqual(Object.fromEntries(props), { "--tfs-status-bg": "#2f6eb5", "--tfs-status-ink": "#ffffff", "--tfs-status-line": "transparent" });
  paintStatusChip(el, null);
  assert.equal(props.size, 0);
});
