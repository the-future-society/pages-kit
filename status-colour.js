// Status chip colours from the colour Coda sends (design pass 2026-10-07).
// The fill is Coda's colour, unchanged. The text is white when white reaches 4.5:1 on that
// fill (WCAG AA for 12.5px text), otherwise near-black #17191d. A hairline is added when the
// fill is so pale it would disappear on a white surface (Coda's "Proposed" grey).
// No colour, or a value that is not #rgb / #rrggbb: return null and let the CSS fall back to
// the neutral chip. Never map a status NAME to a colour: the server's colour is the only input.

const DARK_INK = "#17191d";

function parseHex(hex) {
  if (typeof hex !== "string") return null;
  let h = hex.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]) {
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(l1, l2) {
  const [a, b] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (a + 0.05) / (b + 0.05);
}

/** @returns {{bg:string, ink:string, line:string}|null} */
export function statusChipColours(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const L = luminance(rgb);
  const onWhite = contrast(1, L);
  const onDark = contrast(luminance(parseHex(DARK_INK)), L);
  const ink = onWhite >= 4.5 || onWhite >= onDark ? "#ffffff" : DARK_INK;
  const line = L > 0.8 ? "rgba(23,25,29,.14)" : "transparent";
  return { bg: "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join(""), ink, line };
}

/** Applies the colours to a chip element (or clears them for the neutral chip). */
export function paintStatusChip(el, hex) {
  const c = statusChipColours(hex);
  for (const k of ["bg", "ink", "line"]) {
    if (c) el.style.setProperty(`--tfs-status-${k}`, c[k]);
    else el.style.removeProperty(`--tfs-status-${k}`);
  }
}
