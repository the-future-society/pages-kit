/* TFS pages kit — icons. Inline SVG, never a sprite or an icon font: the kit lives inside
 * someone else's page and can rely on nothing being there (design handover 2026-10-07, "Icons").
 * Each icon is `viewBox="0 0 24 24"`, class `tfs-ico` (stroke = currentColor, no fill), and
 * `aria-hidden="true"`: the words beside it carry the meaning. */

const SVG_NS = "http://www.w3.org/2000/svg";

/* name -> list of [element, attributes]. Paths are the handover's, verbatim. */
export const ICONS = {
  close: [["path", { d: "M6 6l12 12M18 6 6 18" }]],
  chevron: [["path", { d: "m7 10 5 5 5-5" }]],
  tick: [["path", { d: "m5 12.5 4.5 4.5L19 7.5" }]],
  plus: [["path", { d: "M12 5v14M5 12h14" }]],
  open: [["path", { d: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" }]],
  info: [["circle", { cx: "12", cy: "12", r: "9" }], ["path", { d: "M12 11v5M12 8h.01" }]],
  ok: [["circle", { cx: "12", cy: "12", r: "9" }], ["path", { d: "m8 12.5 2.7 2.7L16.2 9.5" }]],
  warn: [["path", { d: "M12 3.5 2.8 19.5h18.4z" }], ["path", { d: "M12 10v4M12 16.8h.01" }]],
  error: [["circle", { cx: "12", cy: "12", r: "9" }], ["path", { d: "m9 9 6 6M15 9l-6 6" }]],
  fieldError: [["circle", { cx: "12", cy: "12", r: "9" }], ["path", { d: "M12 7.5v5.5M12 16.5h.01" }]],
  lock: [["rect", { x: "5", y: "11", width: "14", height: "9", rx: "2" }], ["path", { d: "M8 11V8a4 4 0 0 1 8 0v3" }]],
  sync: [["path", { d: "M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4" }]],
  trash: [["path", { d: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" }]],
  link: [["path", { d: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" }]],
  bullets: [["path", { d: "M9 6h11M9 12h11M9 18h11" }],
    ["circle", { cx: "4.5", cy: "6", r: "1" }], ["circle", { cx: "4.5", cy: "12", r: "1" }], ["circle", { cx: "4.5", cy: "18", r: "1" }]],
  numbers: [["path", { d: "M10 6h10M10 12h10M10 18h10M4 5h1.5v4M4 9h3M4 14.5c0-.8.7-1.5 1.5-1.5S7 13.7 7 14.5c0 1.2-3 2-3 3.5h3" }]],
  checklist: [["rect", { x: "3", y: "4", width: "6", height: "6", rx: "1.5" }], ["path", { d: "m4.5 15.5 1.5 1.5 3-3M12 7h9M12 16h9" }]],
  quote: [["path", { d: "M6 8h4v4c0 2.5-1.3 4.2-3.5 5M14 8h4v4c0 2.5-1.3 4.2-3.5 5" }]],
  more: [["circle", { cx: "5", cy: "12", r: "1.3" }], ["circle", { cx: "12", cy: "12", r: "1.3" }], ["circle", { cx: "19", cy: "12", r: "1.3" }]],
};

/** An `<svg class="tfs-ico">` for `name` (extra classes in `cls`). Needs a DOM. */
export function icon(name, cls = "") {
  const parts = ICONS[name];
  if (!parts) throw new Error(`unknown icon ${name}`);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", cls ? `tfs-ico ${cls}` : "tfs-ico");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const [tag, attrs] of parts) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}
