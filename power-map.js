/* TFS pages kit — <tfs-power-map>: one power map drawn as Rings or as a Network (K1).
 *
 *   <tfs-power-map layout="rings"></tfs-power-map>
 *   el.data = await get_power_map({map, detail: "full"});   // {map, actors, links, …}
 *   el.editable = user.canEdit();                            // edit affordances or none at all
 *   el.selected = "<node_id>" | null;                        // the page's details panel follows it
 *
 * Source of truth for look and behaviour: the 2026-10-15 design hand-off (HANDOFF.md §4, pm.css,
 * screens 01–12 and 24, prototype-source/Main.dc.html). The geometry in this file is the
 * prototype's, made general: shapeD() is SHAPE scaled, the KIND table is copied, and the Rings
 * placement turns the prototype's hand-placed RING_AT into a rule (angle from stance, ring from role).
 *
 * The element WRITES NOTHING. Every action is an event the page acts on:
 *   tfs-actor-select  {node_id|null}                      click / Esc / Clear / empty click
 *   tfs-actor-menu    {node_id, x, y}                     right-click, long-press, ContextMenu key
 *   tfs-actor-action  {action, node_id[, role]}           menu items: link | score | details | remove;
 *                                                         tray role pick: set-role (+ role code)
 *   tfs-actor-move    {node_id, x, y}                     a node dragged in Network (view only)
 *   tfs-map-action    {action: "rename-rings"}            the Key's "Rename rings" (editors)
 *
 * Record text reaches the DOM ONLY through textContent / setAttribute. Every pure helper the
 * element uses is exported and tested in Node (test/power-map.test.js); the DOM class is a thin
 * shell over them.
 */
const Base = globalThis.HTMLElement || class {};
const SVGNS = "http://www.w3.org/2000/svg";

/* ---------------------------------------------------------------- vocabulary (from the prototype) */

/** Link kinds: label, whether directed (arrowhead), dash pattern, base stroke width, verb for titles. */
import { ensurePmCss } from "./pm-css.js";
export const LINK_KINDS = {
  advises: { label: "Advises", arrow: 1, dash: "7 4", w: 1.8, verb: "advises" },
  trusts: { label: "Trusts", arrow: 1, dash: "", w: 3.2, verb: "trusts" },
  funds: { label: "Funds", arrow: 1, dash: "", w: 2.4, verb: "funds" },
  convenes: { label: "Convenes", arrow: 0, dash: "10 3 2 3", w: 2, verb: "convenes" },
  communicates: { label: "Communicates with", arrow: 0, dash: "1.5 4", w: 1.8, verb: "communicates with" },
  reports_to: { label: "Reports to", arrow: 1, dash: "", w: 1.6, verb: "reports to" },
  member_of: { label: "Member of", arrow: 0, dash: "", w: 0.9, verb: "is a member of" },
  holds_seat: { label: "Holds seat", arrow: 1, dash: "", w: 1.4, verb: "holds the seat" },
  works_at: { label: "Works at", arrow: 1, dash: "", w: 1, verb: "works at" },
  works_on: { label: "Works on", arrow: 1, dash: "4 2", w: 1.4, verb: "works on" },
  allied_with: { label: "Allied with", arrow: 0, dash: "12 4", w: 2.4, verb: "is allied with" },
  opposes: { label: "Opposes", arrow: 0, dash: "3 3", w: 2.6, verb: "opposes" },
};
export const LINK_ORDER = ["advises", "trusts", "communicates", "convenes", "funds", "reports_to",
  "allied_with", "opposes", "member_of", "works_at", "holds_seat", "works_on"];

export const ACTOR_KINDS = {
  person: { label: "Person" },
  organization: { label: "Organisation" },
  seat: { label: "Seat", em: "— holder changes" },
  group: { label: "Group of people" },
  forum: { label: "Forum" },
  country: { label: "Country" },
};
export const KIND_ORDER = ["person", "organization", "seat", "group", "forum", "country"];
/** The short kind word used in aria-labels and menus ("Ana, person"). */
const KIND_WORD = { person: "person", organization: "organisation", seat: "seat", group: "group",
  forum: "forum", country: "country" };

/** Stance bands, strongest support first: [value, label, em, fill class]. */
export const STANCE_BANDS = [
  [2, "Champions", "+2", "st2"],
  [1, "Supportive", "+1", "st1"],
  [0, "Neutral or unknown", "0", "st0"],
  [-1, "Sceptical", "−1", "stm1"],
  [-2, "Opposes", "−2", "stm2"],
];
export const REL_LABELS = { warm: "Met in the last year", known: "Met, over a year ago", none: "No meeting logged" };
export const REL_ORDER = ["warm", "known", "none"];

export const ROLE_LABELS = {
  decision_maker: "Decision-maker", direct_influencer: "Direct influencer",
  indirect_influencer: "Indirect influencer", affected: "Affected", ally: "Ally", tfs: "TFS", other: "Other",
};
/** The roles an editor can pick in the "Not placed yet" tray (TFS is not a role people pick). */
export const ROLE_PICK = ["decision_maker", "direct_influencer", "indirect_influencer", "affected", "ally", "other"];
export const DEFAULT_RING_LABELS = ["Power holders", "Direct influencers", "Indirect influencers"];

/** Rings geometry (HANDOFF §4): centre (580,330) in a `-170 0 1170 660` viewBox. */
export const RINGS = {
  cx: 580, cy: 330,
  goal: 50, bands: [140, 228, 305],
  actorR: { 1: 105, 2: 186, 3: 266, 4: 338 },
};
export const VIEWBOX = [-170, 0, 1170, 660];
/** Past this many actors on screen only the selected, its neighbours and the top by power are named. */
export const LABEL_LIMIT = 80;
export const TOP_POWER = 10;
/** Over this many actors the map opens grouped (HANDOFF §2.8). */
export const GROUP_THRESHOLD = 150;
/** Network layout area: right of the Key, inside the viewBox (the prototype's own range). */
export const NET_BOX = { x0: 280, x1: 915, y0: 50, y1: 600 };

/* ---------------------------------------------------------------- small helpers */

/** A number as an SVG coordinate: at most two decimals, no trailing zeros ("-15.2", "26"). */
export function fmt(n) {
  const v = Math.round(n * 100) / 100;
  return String(Object.is(v, -0) ? 0 : v);
}

/** A judgement value as a number, or null ("4" → 4, {value: 3} → 3, "" / "n/a" → null). */
export function numeric(v) {
  if (v && typeof v === "object" && "value" in v) v = v.value;
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace("−", "-").trim());
  return Number.isFinite(n) ? n : null;
}

/** The actor's value for one measure (`power`, `stance`, …), or null. */
export function judgement(actor, measure) {
  const j = actor && actor.judgements;
  return j ? numeric(j[measure]) : null;
}

/** A stance value as a band (−2…+2), or null when unscored. Values are rounded and clamped. */
export function stanceBucket(v) {
  const n = numeric(v);
  if (n === null) return null;
  return Math.max(-2, Math.min(2, Math.round(n)));
}

/** A colour value for the Key: stance as is; a 1–5 measure (e.g. support) mapped onto the bands. */
export function colourBucket(v, scale = "stance") {
  const n = numeric(v);
  if (n === null) return null;
  return scale === "five" ? stanceBucket(n - 3) : stanceBucket(n);
}

export function stanceClass(bucket) {
  const b = STANCE_BANDS.find((s) => s[0] === (bucket === null || bucket === undefined ? 0 : bucket));
  return b ? b[3] : "st0";
}

/** Who-at-TFS-knows-them outline key: only people and organisations get one. owner_only has no
 * meeting logged either, so it draws as the dashed "No meeting logged" outline. */
export function relKey(actor) {
  if (!actor || (actor.kind !== "person" && actor.kind !== "organization")) return null;
  const label = actor.relationship && actor.relationship.label;
  if (label === "warm" || label === "known") return label;
  if (label === "none" || label === "owner_only") return "none";
  return null;
}

/* ---------------------------------------------------------------- shapes and sizes */

/** The SVG path for an actor's shape at radius r — the prototype's SHAPE table (drawn at r = 8),
 * scaled. person = circle, organization = rounded square, seat = shield, group = three circles,
 * forum = diamond, country = hexagon. Unknown kinds draw as a circle. */
export function shapeD(kind, r = 8) {
  const f = fmt;
  switch (kind) {
    case "organization": {
      const s = r * 0.86, c = s * 0.7195;
      return `M${f(-c)},${f(-s)} H${f(c)} Q${f(s)},${f(-s)} ${f(s)},${f(-c)} V${f(c)} Q${f(s)},${f(s)} ${f(c)},${f(s)} `
        + `H${f(-c)} Q${f(-s)},${f(s)} ${f(-s)},${f(c)} V${f(-c)} Q${f(-s)},${f(-s)} ${f(-c)},${f(-s)} Z`;
    }
    case "seat": {
      const x = r * 0.95, t = r * 0.77875, m = r * 0.26625, b = r * 0.9975;
      return `M${f(-x)},${f(-t)} L${f(x)},${f(-t)} L${f(x)},${f(m)} L0,${f(b)} L${f(-x)},${f(m)} Z`;
    }
    case "group": {
      const cr = r * 0.56;
      const circ = (cx, cy) => `M${f(cx - cr)},${f(cy)} a${f(cr)},${f(cr)} 0 1,0 ${f(2 * cr)},0 a${f(cr)},${f(cr)} 0 1,0 ${f(-2 * cr)},0`;
      return [circ(0, -r * 0.42), circ(-r * 0.48, r * 0.36), circ(r * 0.48, r * 0.36)].join(" ");
    }
    case "forum": {
      const d = r * 1.08;
      return `M0,${f(-d)} L${f(d)},0 L0,${f(d)} L${f(-d)},0 Z`;
    }
    case "country": {
      const x = r * 1.02, hx = r * 0.51, y = r * 0.88375;
      return `M${f(x)},0 L${f(hx)},${f(y)} L${f(-hx)},${f(y)} L${f(-x)},0 L${f(-hx)},${f(-y)} L${f(hx)},${f(-y)} Z`;
    }
    default:
      return `M${f(-r)},0 a${f(r)},${f(r)} 0 1,0 ${f(2 * r)},0 a${f(r)},${f(r)} 0 1,0 ${f(-2 * r)},0`;
  }
}

/** Node radius: 8 + power × 3.6 px; an unscored actor is 10 px. */
export function nodeRadius(power) {
  const p = numeric(power);
  return p === null ? 10 : 8 + p * 3.6;
}

/** How far a link stops short of an actor's centre: its radius, plus its outline (4) when it has
 * one, plus a gap — 8 at an arrowhead end, 3 otherwise (the prototype's seg()). */
export function trimRadius(r, hasOutline, arrowEnd) {
  return r + (hasOutline ? 4 : 0) + (arrowEnd ? 8 : 3);
}

/** A name split over at most `lines` lines of about `max` characters; the last is clipped with "…". */
export function wrapLabel(name, max = 22, lines = 2) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  const out = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= max) cur += " " + w;
    else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  if (out.length > lines) {
    const kept = out.slice(0, lines);
    kept[lines - 1] = kept[lines - 1] + "…";
    return kept.map((l) => (l.length > max + 1 ? l.slice(0, max) + "…" : l));
  }
  return out.map((l) => (l.length > max + 6 ? l.slice(0, max) + "…" : l));
}

/* ---------------------------------------------------------------- data shaping */

/** The actors the map draws: every actor not marked removed. */
export function liveActors(data) {
  const list = (data && Array.isArray(data.actors)) ? data.actors : [];
  return list.filter((a) => a && a.node_id && a.status !== "removed" && !a.removed);
}

/** A link from public research (the Samples import, BUILD-SCOPE Q2): drawn blue, tagged Researched. */
export function isResearched(link) {
  if (!link) return false;
  if (link.researched === true) return true;
  return typeof link.source === "string" && /research/i.test(link.source);
}

/** The links the map draws: both ends drawn, a known kind, and never an AI draft still awaiting
 * an editor (HANDOFF §4: "never drawn or counted until confirmed") — EXCEPT a researched link
 * (the countries map's forum memberships, imported from public sources and tagged Researched,
 * HANDOFF §2.7): it is drawn blue from the start and confirmed or rejected like any draft. */
export function drawableLinks(data, ids) {
  const list = (data && Array.isArray(data.links)) ? data.links : [];
  return list.filter((l) => l && LINK_KINDS[l.kind] && (!l.ai_unconfirmed || isResearched(l))
    && ids.has(l.from_node_id) && ids.has(l.to_node_id) && l.from_node_id !== l.to_node_id);
}

export function linkId(l, i = 0) {
  return String(l.link_id || l.id || `${l.from_node_id}>${l.to_node_id}:${l.kind}:${i}`);
}

/** Stroke width: the kind's base, scaled by strength 1–3 (0.75 + s × 0.25), as the prototype. */
export function linkWidth(link) {
  const k = LINK_KINDS[link.kind];
  const s = numeric(link.strength);
  return Math.round(k.w * (s ? 0.75 + s * 0.25 : 1) * 100) / 100;
}

export function linkClass(link) {
  return "ed" + (link.kind === "opposes" ? " neg" : "") + (link.kind === "member_of" ? " mem" : "")
    + (isResearched(link) ? " res" : "");
}

export function linkTitle(link, nameOf) {
  return `${nameOf(link.from_node_id)} ${LINK_KINDS[link.kind].verb} ${nameOf(link.to_node_id)}`;
}

/* ---------------------------------------------------------------- Rings placement */

/** Ring from role on this map: 1 decision-makers, 2 direct, 3 indirect, 4 outside (affected,
 * ally, TFS, other); 0 = no role yet, which goes in the "Not placed yet" tray. */
export function ringOf(role) {
  if (role === "decision_maker") return 1;
  if (role === "direct_influencer") return 2;
  if (role === "indirect_influencer") return 3;
  if (role === "affected" || role === "ally" || role === "tfs" || role === "other") return 4;
  return 0;
}

export function ringRadius(ring, f = 1) {
  return (RINGS.actorR[ring] || 0) * f;
}

/** How much the rings must grow so every actor in a ring has about 84 units of arc (a label's
 * room): 1 when they fit at the design's radii, more when one role holds many actors (an
 * imported map often files everyone as a decision-maker). Capped so the drawing stays legible. */
export const RING_ARC = 96;
/** How far a crowded ring's two staggered rows sit inside and outside its radius. */
export const ROW_OFFSET = { 1: 22, 2: 24, 3: 22 };
/** Rows per ring. Two staggered rows were tried (2026-10-15) and put one row's names on the
 * other row's shapes, so a crowded ring grows instead (ringScale) and its names are drawn larger
 * to match (`--pm-label-k`). Kept as a function so a later layout can change it in one place. */
export function ringRows() {
  return 1;
}
export function ringScale(counts) {
  let f = 1;
  for (const ring of [1, 2, 3]) {
    const n = counts[ring] || 0;
    if (n) f = Math.max(f, (n * RING_ARC) / (ringRows(ring, n) * 2 * Math.PI * RINGS.actorR[ring] * 0.9));
  }
  return Math.min(3, Math.round(f * 100) / 100);
}

/** The Rings viewBox for a scale: the design's box grown about the rings' centre. */
export function ringsView(f = 1) {
  const [x0, y0, w, h] = VIEWBOX;
  return [RINGS.cx - (RINGS.cx - x0) * f, RINGS.cy - (RINGS.cy - y0) * f, w * f, h * f];
}

/** Push apart actors on one ring that sit closer than `gap` degrees, keeping their order (a few
 * passes of pairwise relaxation round the circle). Mutates and returns the angle list. */
export function spreadAngles(items, gap) {
  if (items.length < 2) return items;
  const n = items.length;
  const g = Math.min(gap, 360 / n);
  for (let pass = 0; pass < 60; pass++) {
    items.sort((p, q) => p.angle - q.angle);
    let moved = false;
    for (let i = 0; i < n; i++) {
      const a = items[i], b = items[(i + 1) % n];
      let d = b.angle - a.angle; if (i === n - 1) d += 360;
      if (d < g - 0.01) { const push = (g - d) / 2; a.angle -= push; b.angle += push; moved = true; }
    }
    if (!moved) break;
  }
  return items;
}

/** Anchor angles (degrees; 0 = right, 90 = bottom) for a stance band. Supportive right, sceptical
 * left, neutral or unknown at the bottom: +2 → 0°, +1 → about ±40°, 0 → 90°, −1 → about ±140°,
 * −2 → 180°. The "about" is staggered by ring (±50° in ring 1, ±36° in ring 2, ±24° in ring 3, as the
 * prototype's hand placing does) so actors in neighbouring rings do not line up and stack labels.
 * Outside the rings (r = 338 is taller than the canvas) the bottom anchors move to ±30° of it. */
export function stanceAnchors(bucket, ring = 1) {
  const b = bucket === null || bucket === undefined ? 0 : bucket;
  if (ring === 4) return ({ 2: [0], 1: [-30, 30], 0: [60, 120], [-1]: [210, 150], [-2]: [180] })[b];
  const s = ({ 1: 50, 2: 36, 3: 24 })[ring] || 40;
  return ({ 2: [0], 1: [-s, s], 0: [90], [-1]: [180 + s, 180 - s], [-2]: [180] })[b];
}

/** The spread step for a ring: about 84 px of arc between neighbours (room for a label), never
 * under 12°. */
export function ringStep(ring, f = 1) {
  const r = ringRadius(ring, f) || 105;
  return Math.max(12, (84 / r) * 180 / Math.PI);
}

/** The angle of the index-th actor (0-based) of one stance band in one ring. Actors take the band's
 * anchors in turn; once every anchor is used they spread out from it, alternating sign and
 * widening: anchor, +step, −step, +2·step, −2·step, … */
export function ringAngle(bucket, index, ring = 1, f = 1) {
  const anchors = stanceAnchors(bucket, ring);
  const a = anchors[index % anchors.length];
  const j = Math.floor(index / anchors.length);
  const k = Math.ceil(j / 2), sign = j % 2 === 1 ? 1 : -1;
  return a + sign * k * ringStep(ring, f);
}

/** Place every actor: {placed: Map node_id → {x, y, ring, angle}, unplaced: [actor]}. Within a ring
 * and stance band, actors are ordered by power (highest first), then name, so the strongest sit
 * on the band's anchor. Outside-ring positions are clamped to stay on the canvas. */
export function ringPlacement(actors, { stanceMeasure = "stance", powerMeasure = "power", scale = "stance" } = {}) {
  const placed = new Map();
  const unplaced = [];
  const buckets = new Map();
  const counts = {};
  for (const a of actors) {
    const ring = ringOf(a.role);
    if (!ring) { unplaced.push(a); continue; }
    counts[ring] = (counts[ring] || 0) + 1;
    const b = colourBucket(judgement(a, stanceMeasure), scale);
    const key = `${ring}|${b === null ? 0 : b}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(a);
  }
  const f = ringScale(counts);
  const byRing = new Map();
  for (const [key, list] of buckets) {
    const [ringS, bS] = key.split("|");
    const ring = Number(ringS), b = Number(bS);
    list.sort((p, q) => (judgement(q, powerMeasure) ?? -1) - (judgement(p, powerMeasure) ?? -1)
      || String(p.name || "").localeCompare(String(q.name || "")) || String(p.node_id).localeCompare(String(q.node_id)));
    list.forEach((a, i) => {
      if (!byRing.has(ring)) byRing.set(ring, []);
      byRing.get(ring).push({ a, angle: ringAngle(b, i, ring, f) });
    });
  }
  // Two stance bands spreading out from their anchors can meet: relax each ring so neighbours
  // keep a label's room apart (outside the rings, r = 338, too).
  for (const [ring, items] of byRing) {
    const rows = ringRows(ring, counts[ring] || items.length);
    // a label's room of arc between neighbours (RING_ARC), halved when two rows stagger
    spreadAngles(items, ((RING_ARC / ringRadius(ring, f)) * 180 / Math.PI * 0.92) / rows);
    items.sort((p, q) => p.angle - q.angle);
    items.forEach((it, i) => {
      const { a, angle } = it;
      const r = ringRadius(ring, f) + (rows === 2 ? (i % 2 ? 1 : -1) * ROW_OFFSET[ring] * f : 0);
      const th = angle * Math.PI / 180;
      let x = RINGS.cx + r * Math.cos(th), y = RINGS.cy + r * Math.sin(th);
      const [, vy, , vh] = ringsView(f);
      y = Math.max(vy + 24, Math.min(vy + vh - 36, y));
      placed.set(a.node_id, { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, ring, angle: Math.round(angle * 10) / 10 });
    });
  }
  unplaced.sort((p, q) => String(p.name || "").localeCompare(String(q.name || "")));
  return { placed, unplaced, scale: f };
}

/* ---------------------------------------------------------------- Network layout */

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

/** A deterministic force layout (no randomness, no dependencies): actors start on a golden-angle
 * spiral (most-linked first), then a fixed number of Fruchterman–Reingold steps with a cooling
 * temperature, a label-aware collision push, and every position clamped to the box. Actors that
 * carry finite x/y keep them. Returns Map node_id → {x, y}. */
export function networkLayout(actors, links, { box: box0 = NET_BOX, iterations, radius = (a) => nodeRadius(judgement(a, "power")), labels } = {}) {
  const n = actors.length;
  const pos = new Map();
  if (!n) return pos;
  // a crowded map gets a bigger drawing (about 3,600 square units an actor); the element fits the
  // view to it. Labels need room only when every actor is named (≤ LABEL_LIMIT on screen).
  const named = labels ?? n <= LABEL_LIMIT;
  const grow = Math.max(1, Math.sqrt((n * 3600) / ((box0.x1 - box0.x0) * (box0.y1 - box0.y0))));
  const bcx = (box0.x0 + box0.x1) / 2, bcy = (box0.y0 + box0.y1) / 2;
  const box = grow === 1 ? box0 : { x0: bcx - (bcx - box0.x0) * grow, x1: bcx + (box0.x1 - bcx) * grow,
    y0: bcy - (bcy - box0.y0) * grow, y1: bcy + (box0.y1 - bcy) * grow };
  const W = box.x1 - box.x0, H = box.y1 - box.y0, cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  const deg = new Map(actors.map((a) => [a.node_id, 0]));
  for (const l of links) {
    if (deg.has(l.from_node_id)) deg.set(l.from_node_id, deg.get(l.from_node_id) + 1);
    if (deg.has(l.to_node_id)) deg.set(l.to_node_id, deg.get(l.to_node_id) + 1);
  }
  const order = actors.slice().sort((p, q) => deg.get(q.node_id) - deg.get(p.node_id)
    || String(p.name || "").localeCompare(String(q.name || "")) || String(p.node_id).localeCompare(String(q.node_id)));
  const idx = new Map();
  const X = new Float64Array(n), Y = new Float64Array(n), R = new Float64Array(n), fixed = new Uint8Array(n);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const spread = Math.min(W, H) / 2 * 0.9;
  order.forEach((a, i) => {
    idx.set(a.node_id, i);
    R[i] = radius(a);
    if (Number.isFinite(a.x) && Number.isFinite(a.y)) { X[i] = a.x; Y[i] = a.y; fixed[i] = 1; return; }
    const rr = spread * Math.sqrt((i + 0.5) / n);
    const th = i * golden + hash(String(a.node_id)) * 0.3;
    X[i] = cx + rr * Math.cos(th) * (W / Math.min(W, H));
    Y[i] = cy + rr * Math.sin(th);
  });
  const E = [];
  const seen = new Set();
  for (const l of links) {              // one spring per pair, however many links it carries
    const a = idx.get(l.from_node_id), b = idx.get(l.to_node_id);
    if (a === undefined || b === undefined || a === b) continue;
    const key = a < b ? a + "," + b : b + "," + a;
    if (!seen.has(key)) { seen.add(key); E.push([a, b]); }
  }
  // Forces run unclamped (walls make actors pile along the edges); afterwards the whole cloud is
  // scaled into the box, keeping its shape.
  const k = Math.sqrt((W * H) / n) * 0.6;
  const cut = 3 * k;
  const iters = iterations ?? (n > 200 ? 90 : n > 80 ? 160 : 260);
  let t = k * 1.5;
  const cool = t / (iters + 1);
  const dx = new Float64Array(n), dy = new Float64Array(n);
  for (let it = 0; it < iters; it++) {
    dx.fill(0); dy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ex = X[i] - X[j], ey = Y[i] - Y[j];
        let d = Math.hypot(ex, ey);
        if (d > cut) continue;
        if (d < 0.01) { ex = (i - j) * 0.37 + 0.11; ey = (j % 7) * 0.29 + 0.13; d = Math.hypot(ex, ey); }
        const f = (k * k) / d;
        const ux = ex / d, uy = ey / d;
        dx[i] += ux * f; dy[i] += uy * f; dx[j] -= ux * f; dy[j] -= uy * f;
      }
    }
    for (const [a, b] of E) {
      const ex = X[a] - X[b], ey = Y[a] - Y[b];
      const d = Math.max(0.01, Math.hypot(ex, ey));
      const f = (d * d) / k;
      const ux = ex / d, uy = ey / d;
      dx[a] -= ux * f; dy[a] -= uy * f; dx[b] += ux * f; dy[b] += uy * f;
    }
    for (let i = 0; i < n; i++) {
      // a pull to the centre, a little stronger vertically (the box is wide)
      dx[i] += (cx - X[i]) * 0.05; dy[i] += (cy - Y[i]) * 0.05 * (W / H);
      if (fixed[i]) continue;
      const d = Math.hypot(dx[i], dy[i]);
      if (d > 0) { const m = Math.min(d, t); X[i] += (dx[i] / d) * m; Y[i] += (dy[i] / d) * m; }
    }
    t = Math.max(1, t - cool);
  }
  {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) if (!fixed[i]) { x0 = Math.min(x0, X[i]); x1 = Math.max(x1, X[i]); y0 = Math.min(y0, Y[i]); y1 = Math.max(y1, Y[i]); }
    if (x1 > x0 || y1 > y0) {
      const pad = 30;
      const sx = (W - 2 * pad) / Math.max(1, x1 - x0), sy = (H - 2 * pad - 14) / Math.max(1, y1 - y0);
      const sc = Math.min(sx, sy);
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      for (let i = 0; i < n; i++) if (!fixed[i]) { X[i] = cx + (X[i] - mx) * sc; Y[i] = cy - 7 + (Y[i] - my) * sc; }
    }
  }
  // last: push apart any two actors whose shape-plus-label boxes still overlap. A label sits
  // under its shape (12.5 px type, about 6.9 units a character, 14 a line), so the box is as wide
  // as the longer of the shape and the label, and runs from the shape's top to the label's foot.
  const HW = new Float64Array(n), UP = new Float64Array(n), DN = new Float64Array(n);
  order.forEach((a, i) => {
    const lines = named ? wrapLabel(a.name, 22, 2) : [];
    const lw = Math.max(0, ...lines.map((l) => l.length)) * 6.9;
    HW[i] = Math.max(R[i] + 4, lw / 2); UP[i] = R[i] + 4; DN[i] = R[i] + 6 + lines.length * 14;
  });
  for (let pass = 0; pass < 80; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ex = X[j] - X[i];
        const ox = HW[i] + HW[j] + 8 - Math.abs(ex);
        if (ox <= 0) continue;
        // vertical overlap of [Y-UP, Y+DN] intervals
        const oy = Math.min(Y[i] + DN[i], Y[j] + DN[j]) - Math.max(Y[i] - UP[i], Y[j] - UP[j]) + 6;
        if (oy <= 0) continue;
        moved = true;
        const fi = fixed[i] ? 0 : fixed[j] ? 1 : 0.5, fj = 1 - fi;
        if (ox < oy) {
          const s = ex >= 0 ? 1 : -1;
          X[i] -= s * ox * fi; X[j] += s * ox * fj;
        } else {
          const s = Y[j] >= Y[i] ? 1 : -1;
          Y[i] -= s * oy * fi; Y[j] += s * oy * fj;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      X[i] = Math.max(box.x0 + R[i], Math.min(box.x1 - R[i], X[i]));
      Y[i] = Math.max(box.y0 + R[i], Math.min(box.y1 - R[i] - 14, Y[i]));
    }
    if (!moved) break;
  }
  order.forEach((a, i) => pos.set(a.node_id, { x: Math.round(X[i] * 10) / 10, y: Math.round(Y[i] * 10) / 10 }));
  return pos;
}

/* ---------------------------------------------------------------- links: lanes and geometry */

/** Two or more links between the same pair curve apart (the Samples page's lane rule). Returns
 * Map link id → signed offset in px (0 = straight). The sign is taken against one fixed direction
 * per pair, so A→B and B→A separate too. */
export function linkLanes(links, gap = 22) {
  const pairs = new Map();
  links.forEach((l, i) => {
    const a = String(l.from_node_id), b = String(l.to_node_id);
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push([linkId(l, i), a < b ? 1 : -1]);
  });
  const out = new Map();
  for (const list of pairs.values()) {
    const m = list.length;
    list.forEach(([id, dir], i) => {
      const off = m === 1 ? 0 : (i - (m - 1) / 2) * gap;
      out.set(id, off * dir);
    });
  }
  return out;
}

/** The path for one link from p to q, trimmed `ra` from p and `rb` from q. offset 0 = a straight
 * line; otherwise a quadratic curve whose middle sits `offset` px to the left of p→q. */
export function linkPath(p, q, ra, rb, offset = 0) {
  const ex = q.x - p.x, ey = q.y - p.y, L = Math.hypot(ex, ey) || 1;
  const f = (v) => v.toFixed(1);
  if (!offset) {
    return `M${f(p.x + ex / L * ra)},${f(p.y + ey / L * ra)} L${f(q.x - ex / L * rb)},${f(q.y - ey / L * rb)}`;
  }
  const nx = ey / L, ny = -ex / L;            // left normal of p→q
  const c = { x: (p.x + q.x) / 2 + nx * offset * 2, y: (p.y + q.y) / 2 + ny * offset * 2 };
  const s1x = c.x - p.x, s1y = c.y - p.y, l1 = Math.hypot(s1x, s1y) || 1;
  const s2x = q.x - c.x, s2y = q.y - c.y, l2 = Math.hypot(s2x, s2y) || 1;
  return `M${f(p.x + s1x / l1 * ra)},${f(p.y + s1y / l1 * ra)} Q${f(c.x)},${f(c.y)} ${f(q.x - s2x / l2 * rb)},${f(q.y - s2y / l2 * rb)}`;
}

/* ---------------------------------------------------------------- Key: filters and rows */

/** The filter keys an actor answers to: its kind, its stance band, its ring (Rings only) and its
 * who-knows-them outline. Organisations, forums and countries without a stance have no stance key
 * (as the prototype), so hiding "Neutral or unknown" does not hide every unscored organisation. */
export function nodeKeys(actor, layout = "network", { stanceMeasure = "stance", scale = "stance" } = {}) {
  const keys = ["kind:" + actor.kind];
  const v = judgement(actor, stanceMeasure);
  const unkeyed = actor.kind === "forum" || actor.kind === "organization" || actor.kind === "country";
  if (!unkeyed || v !== null) keys.push("st:" + (colourBucket(v, scale) ?? 0));
  if (layout === "rings") { const r = ringOf(actor.role); if (r) keys.push("ring:" + r); }
  const rel = relKey(actor);
  if (rel) keys.push("rel:" + rel);
  return keys;
}

/** What the Key hides: an actor whose any key is off; a link whose kind is off or either end is
 * hidden. Returns {hiddenNodes: Set, hiddenLinks: Set of link ids}. */
export function keyFilter(actors, links, off = {}, layout = "network", opts = {}) {
  const hiddenNodes = new Set();
  for (const a of actors) if (nodeKeys(a, layout, opts).some((k) => off[k])) hiddenNodes.add(a.node_id);
  const hiddenLinks = new Set();
  links.forEach((l, i) => {
    if (off["link:" + l.kind] || hiddenNodes.has(l.from_node_id) || hiddenNodes.has(l.to_node_id)) hiddenLinks.add(linkId(l, i));
  });
  return { hiddenNodes, hiddenLinks };
}

/** The Key's sections, listing only what is present on the map (Rings always lists its three
 * bands, since they are drawn). Each row: {key, label, em?, icon: {type, …}}. */
export function keyRows(actors, links, layout = "network", { ringLabels = DEFAULT_RING_LABELS, scale = "stance", stanceMeasure = "stance", colourLabels = null } = {}) {
  const sections = [];
  const has = new Set();
  for (const a of actors) for (const k of nodeKeys(a, layout, { stanceMeasure, scale })) has.add(k);
  if (layout === "rings") {
    const rows = [1, 2, 3].map((r) => ({ key: "ring:" + r, label: ringLabels[r - 1], icon: { type: "band", band: r } }));
    if (has.has("ring:4")) rows.push({ key: "ring:4", label: "Outside the rings", em: "· affected, TFS", icon: { type: "outside" } });
    sections.push({ id: "rings", title: "Rings", sub: "· role on this map", rows });
  }
  sections.push({ id: "size", title: "Size", sub: null, rows: [] });
  const st = STANCE_BANDS.filter(([v]) => has.has("st:" + v)).map(([v, label, em, cls]) => {
    const custom = colourLabels && colourLabels[String(scale === "five" ? v + 3 : v)];
    return { key: "st:" + v, label: custom || label, em: scale === "five" ? String(v + 3) : em, icon: { type: "fill", cls } };
  });
  if (st.length) sections.push({ id: "colour", title: "Colour", sub: null, rows: st });
  const rel = REL_ORDER.filter((r) => has.has("rel:" + r)).map((r) => ({ key: "rel:" + r, label: REL_LABELS[r], icon: { type: "rel", rel: r } }));
  if (rel.length) sections.push({ id: "rel", title: "Ring", sub: "· who at TFS knows them", rows: rel });
  const kinds = KIND_ORDER.filter((k) => has.has("kind:" + k)).map((k) => ({ key: "kind:" + k, label: ACTOR_KINDS[k].label, em: ACTOR_KINDS[k].em, icon: { type: "shape", kind: k } }));
  if (kinds.length) sections.push({ id: "shape", title: "Shape", sub: null, rows: kinds });
  const present = new Set(links.map((l) => l.kind));
  const lines = LINK_ORDER.filter((k) => present.has(k)).map((k) => {
    const ofKind = links.filter((l) => l.kind === k);
    const res = ofKind.length > 0 && ofKind.every(isResearched);
    return { key: "link:" + k, label: LINK_KINDS[k].label, em: res ? "· from public sources" : undefined, icon: { type: "line", kind: k, res } };
  });
  if (lines.length) sections.push({ id: "lines", title: "Lines", sub: "· kind of link", rows: lines });
  return sections;
}

/** Which actors are named. Up to `limit` on screen: all of them. Past it: only the selected
 * actor, its neighbours and the `top` highest-power actors — and the Key says so.
 * Returns {named: Set, all: boolean}. */
export function labelSet(visibleIds, links, selected, powerOf, { limit = LABEL_LIMIT, top = TOP_POWER } = {}) {
  const ids = [...visibleIds];
  if (ids.length <= limit) return { named: new Set(ids), all: true };
  const vis = new Set(ids);
  const named = new Set();
  if (selected && vis.has(selected)) {
    named.add(selected);
    for (const l of links) {
      if (l.from_node_id === selected && vis.has(l.to_node_id)) named.add(l.to_node_id);
      if (l.to_node_id === selected && vis.has(l.from_node_id)) named.add(l.from_node_id);
    }
  }
  ids.slice().sort((a, b) => (powerOf(b) ?? -1) - (powerOf(a) ?? -1) || String(a).localeCompare(String(b)))
    .slice(0, top).forEach((id) => named.add(id));
  return { named, all: false };
}

/* ---------------------------------------------------------------- grouped (large) maps */

/** One bubble per group with an exact count; every actor counts in exactly one group (its first
 * country, or its grouping), so the counts add up to the actors drawn. Largest group first. */
export function groupBubbles(actors, by = "country") {
  const groups = new Map();
  for (const a of actors) {
    let label;
    // A country sits in its own bubble; someone with no "works on" link falls back to the
    // map's own grouping text (imported trackers filed people under their country's name).
    if (by === "country") {
      label = Array.isArray(a.countries) && a.countries.length ? String(a.countries[0])
        : a.kind === "country" && a.name ? String(a.name)
        : a.grouping ? String(a.grouping) : null;
    }
    else label = a.grouping ? String(a.grouping) : null;
    const key = label === null ? "\u0000none" : label;
    if (!groups.has(key)) groups.set(key, { key, label: label === null ? (by === "country" ? "No country" : "No group") : label, count: 0, ids: [] });
    const g = groups.get(key);
    g.count++; g.ids.push(a.node_id);
  }
  return [...groups.values()].sort((p, q) => q.count - p.count || (p.key === "\u0000none") - (q.key === "\u0000none") || p.label.localeCompare(q.label));
}

/** Choose how a large map groups: by country when actors carry countries, else by grouping. */
export function groupingOf(actors) {
  return actors.some((a) => Array.isArray(a.countries) && a.countries.length) ? "country" : "grouping";
}

/** Lay bubbles out in rows across the viewBox; past `cap` groups, the rest fold into one
 * "n more groups" bubble. Returns [{key, label, count, ids, x, y, r, more?}]. */
export function bubbleLayout(groups, { cap = 12, box = { x0: -150, x1: 990, y0: 20, y1: 640 } } = {}) {
  let shown = groups;
  if (groups.length > cap) {
    const head = groups.slice(0, cap - 1), rest = groups.slice(cap - 1);
    shown = head.concat([{ key: "\u0000more", label: `${rest.length} more`, more: true, groups: rest.length,
      count: rest.reduce((s, g) => s + g.count, 0), ids: rest.flatMap((g) => g.ids) }]);
  }
  const max = Math.max(1, ...shown.filter((g) => !g.more).map((g) => g.count));
  const sized = shown.map((g) => ({ ...g, r: g.more ? 46 : Math.round(30 + 42 * Math.sqrt(g.count / max)) }));
  const rows = [];
  let row = [], w = 0;
  const gap = 26, W = box.x1 - box.x0;
  for (const g of sized) {
    const need = 2 * g.r + (row.length ? gap : 0);
    if (row.length && w + need > W) { rows.push({ items: row, w }); row = []; w = 0; }
    w += 2 * g.r + (row.length ? gap : 0);
    row.push(g);
  }
  if (row.length) rows.push({ items: row, w });
  const heights = rows.map((r) => Math.max(...r.items.map((g) => 2 * g.r)) + 30);
  const total = heights.reduce((s, h) => s + h, 0);
  let y = box.y0 + Math.max(0, ((box.y1 - box.y0) - total) / 2);
  const out = [];
  rows.forEach((r, i) => {
    let x = box.x0 + (W - r.w) / 2;
    const mid = y + heights[i] / 2;
    for (const g of r.items) { out.push({ ...g, x: Math.round(x + g.r), y: Math.round(mid) }); x += 2 * g.r + gap; }
    y += heights[i];
  });
  return out;
}

/** Whether the map opens grouped: more than GROUP_THRESHOLD actors and nobody asked for all. */
export function opensGrouped(count, showAll = false) {
  return count > GROUP_THRESHOLD && !showAll;
}

/** The partial-load line: "Showing n of N — loading the rest…" while loading; without the
 * "loading" clause when the server cut the list and nothing more is coming. null when complete. */
export function partialText(data, loading) {
  if (!data) return null;
  const shown = numeric(data.actor_count_returned) ?? liveActors(data).length;
  const total = numeric(data.map_actor_count) ?? numeric(data.actor_count);
  if (!loading && !data.truncated) return null;
  if (total === null || total <= shown) return loading ? { strong: `Showing ${shown}`, rest: " — loading the rest…" } : null;
  return loading ? { strong: `Showing ${shown} of ${total}`, rest: " — loading the rest…" }
    : { strong: `Showing ${shown} of ${total}`, rest: " actors." };
}

/* ---------------------------------------------------------------- the element */

let uid = 0;

function el(tag, attrs = {}, kids = []) {
  const n = globalThis.document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of [].concat(kids)) if (c) n.appendChild(typeof c === "string" ? globalThis.document.createTextNode(c) : c);
  return n;
}
function svg(tag, attrs = {}, kids = []) {
  const n = globalThis.document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, String(v));
  }
  for (const c of [].concat(kids)) if (c) n.appendChild(c);
  return n;
}
/** A small stroked UI icon (the design's 24-unit icons). Static paths only. */
function icon(d, size = 16, sw = 2) {
  return svg("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": sw, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, [svg("path", { d })]);
}
const ICON = {
  x: "M6 6l12 12M18 6L6 18",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z",
  link: "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1",
  plus: "M12 5v14M5 12h14",
  panel: "M4 4h16v16H4zM14 4v16",
  minus: "M5 12h14",
};

function phoneNow() {
  try { return !!(globalThis.matchMedia && globalThis.matchMedia("(max-width:720px)").matches); } catch { return false; }
}

export class TfsPowerMap extends Base {
  static get observedAttributes() { return ["layout", "editable", "partial", "heading", "group-by"]; }

  constructor() {
    super();
    this._uid = ++uid;
    this._data = null;
    this._selected = null;
    this._off = {};
    this._keyOpen = null;            // null = decide at first render (closed on a phone)
    this._menu = null;               // {node_id}
    this._layoutCache = new Map();
    this._dragPos = new Map();
    this._view = VIEWBOX.slice();
    this._group = null;              // the group opened from the grouped view
    this._showAll = false;           // "Show every actor" on a large map
    this._allGroups = false;         // the "n more groups" bubble opened
    this._ptr = null;
    this._onDocKey = (e) => this._docKey(e);
    this._onDocDown = (e) => this._docDown(e);
  }

  /* ---- properties */
  get data() { return this._data; }
  set data(v) {
    this._data = v || null;
    this._layoutCache.clear();
    this._centreNext = true;
    if (this._selected && !this._actorById(this._selected)) this._selected = null;
    this._render();
  }
  get editable() { return this.hasAttribute ? this.hasAttribute("editable") : !!this._editable; }
  set editable(v) {
    if (this.toggleAttribute) this.toggleAttribute("editable", !!v); else this._editable = !!v;
    this._render();
  }
  get selected() { return this._selected; }
  set selected(v) { this._selected = v || null; this._menu = null; this._render(); }
  get partial() { return this.hasAttribute ? this.hasAttribute("partial") : !!this._partial; }
  set partial(v) { if (this.toggleAttribute) this.toggleAttribute("partial", !!v); else this._partial = !!v; this._render(); }
  get layout() { return (this.getAttribute && this.getAttribute("layout")) === "rings" ? "rings" : "network"; }
  set layout(v) { this.setAttribute("layout", v === "rings" ? "rings" : "network"); }

  /** Options a page may set: which measures drive size and colour, and the colour scale
   *  ("stance" −2…+2, or "five" for a 1–5 measure such as support), with optional labels. */
  get options() { return this._opts || {}; }
  set options(v) { this._opts = v || {}; this._layoutCache.clear(); this._render(); }

  connectedCallback() {
    // pm.css is owned by pm-css.js (builder C); load it without making this module depend on it.
    ensurePmCss();
    globalThis.document.addEventListener("keydown", this._onDocKey);
    globalThis.document.addEventListener("pointerdown", this._onDocDown, true);
    this._render();
  }
  disconnectedCallback() {
    globalThis.document.removeEventListener("keydown", this._onDocKey);
    globalThis.document.removeEventListener("pointerdown", this._onDocDown, true);
    clearTimeout(this._lpTimer);
  }
  attributeChangedCallback(name) {
    if (name === "layout") { this._view = VIEWBOX.slice(); this._menu = null; this._centreNext = true; }
    if (this.isConnected) this._render();
  }

  /* ---- derived state */
  _measures() {
    const o = this.options;
    return { size: o.sizeMeasure || "power", colour: o.colourMeasure || "stance", scale: o.colourScale || "stance", colourLabels: o.colourLabels || null };
  }
  _actors() { return liveActors(this._data); }
  _actorById(id) { return this._actors().find((a) => a.node_id === id) || null; }
  _ringLabels() {
    const m = this._data && this._data.map;
    const r = m && Array.isArray(m.ring_labels) && m.ring_labels.length === 3 ? m.ring_labels : null;
    return r ? r.map((x, i) => (x && String(x).trim()) || DEFAULT_RING_LABELS[i]) : DEFAULT_RING_LABELS;
  }
  _emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }
  _select(id) {
    this._selected = id || null;
    this._menu = null;
    this._emit("tfs-actor-select", { node_id: this._selected });
    this._render();
  }
  _setKeyOpen(open) {
    this._keyOpen = open;
    const root = (this.closest && this.closest(".pm")) || this;
    if (root.classList) root.classList.toggle("keyopen", !!open);
    this._render();
  }

  /** Which actors are on screen and where. */
  _scene() {
    const all = this._actors();
    const layout = this.layout;
    const M = this._measures();
    let actors = all, mode = layout, groups = null, groupLabel = null;
    if (layout === "network" && this._group === null && opensGrouped(all.length, this._showAll)) {
      mode = "bubbles";
      groups = groupBubbles(all, this.getAttribute("group-by") || groupingOf(all));
    } else if (layout === "network" && this._group !== null) {
      const g = groupBubbles(all, this.getAttribute("group-by") || groupingOf(all)).find((x) => x.key === this._group);
      if (g) { const ids = new Set(g.ids); actors = all.filter((a) => ids.has(a.node_id)); groupLabel = g.label; }
      else this._group = null;
    }
    const ids = new Set(actors.map((a) => a.node_id));
    const links = drawableLinks(this._data, ids);
    let pos = new Map(), unplaced = [], ringF = 1;
    if (mode === "rings") {
      const p = ringPlacement(actors, { stanceMeasure: M.colour, powerMeasure: M.size, scale: M.scale });
      pos = p.placed; unplaced = p.unplaced; ringF = p.scale;
    } else if (mode === "network") {
      const key = [...ids].sort().join(",") + "|" + links.length;
      if (!this._layoutCache.has(key)) {
        const laid = networkLayout(actors, links, { radius: (a) => nodeRadius(judgement(a, M.size)) });
        this._layoutCache.set(key, laid);
        let over = false;
        for (const p of laid.values()) if (p.x < NET_BOX.x0 - 1 || p.x > NET_BOX.x1 + 1 || p.y < NET_BOX.y0 - 1 || p.y > NET_BOX.y1 + 1) { over = true; break; }
        this._fitNext = over;
      }
      pos = new Map(this._layoutCache.get(key));
      for (const [id, p] of this._dragPos) if (pos.has(id)) pos.set(id, p);
    }
    const byId = new Map(actors.map((a) => [a.node_id, a]));
    return { all, actors, byId, links, pos, unplaced, mode, groups, groupLabel, M, ringF };
  }

  /* ---- render */
  _render() {
    if (!globalThis.document || !this.isConnected) return;
    if (this._keyOpen === null) {
      this._keyOpen = !phoneNow();
      const root = (this.closest && this.closest(".pm")) || this;
      if (root.classList) root.classList.toggle("keyopen", this._keyOpen);
    }
    const sc = this._scene();
    this._sc = sc;
    // A grown drawing would shrink every name on screen: draw them larger by about √f to keep
    // them readable (the shapes keep their size, which is what makes the room).
    this.style.setProperty("--pm-label-k", sc.mode === "rings" ? String(Math.round(Math.sqrt(sc.ringF || 1) * 100) / 100) : "1");
    // Rings grow when a ring is crowded: show the grown drawing whole unless the viewer has zoomed.
    if (sc.mode === "rings" && this._ringF !== sc.ringF) {
      const was = this._ringF === undefined ? VIEWBOX : ringsView(this._ringF);
      if (this._view.every((v, i) => Math.abs(v - was[i]) < 0.5) || this._ringF === undefined) this._view = ringsView(sc.ringF);
      this._ringF = sc.ringF;
    }
    if (this._fitNext) { this._fitNext = false; this._view = this._fitView(sc) || this._view; }
    const linkVisible = new Set();
    const editable = this.editable;
    const layout = this.layout;
    const sel = this._selected && sc.pos.has(this._selected) ? this._selected : null;

    const nodesOnMap = sc.actors.filter((a) => sc.pos.has(a.node_id));
    const filter = keyFilter(nodesOnMap, sc.links, this._off, layout, { stanceMeasure: sc.M.colour, scale: sc.M.scale });
    const visible = nodesOnMap.filter((a) => !filter.hiddenNodes.has(a.node_id));
    const visibleLinks = sc.links.filter((l, i) => !filter.hiddenLinks.has(linkId(l, i)));
    for (const l of visibleLinks) linkVisible.add(l);
    const near = new Set();
    if (sel) {
      near.add(sel);
      for (const l of visibleLinks) {
        if (l.from_node_id === sel) near.add(l.to_node_id);
        if (l.to_node_id === sel) near.add(l.from_node_id);
      }
    }
    const labels = labelSet(visible.map((a) => a.node_id), visibleLinks, sel, (id) => judgement(this._actorByIdIn(sc.actors, id), sc.M.size));
    this._labels = labels;

    const section = el("section", { class: "panel ovis", "aria-label": layout === "rings" ? "Rings" : "Network" });
    section.appendChild(this._head(sc));
    const part = partialText(this._data, this.partial);
    if (part) {
      section.appendChild(el("div", { class: "banner info", role: "status" }, [
        this.partial ? el("span", { class: "spin", style: "width:16px;height:16px;border-width:2px", "aria-hidden": "true" }) : null,
        el("span", { class: "grow" }, [el("b", { text: part.strong }), part.rest]),
      ]));
    }
    if (sc.mode === "bubbles") {
      const n = sc.all.length, gc = sc.groups.length, by = this.getAttribute("group-by") || groupingOf(sc.all);
      section.appendChild(el("div", { class: "banner info" }, [
        el("span", { class: "grow" }, [el("b", { text: `${n} actors in ${gc} ${gc === 1 ? "group" : "groups"}` }),
          ` · grouped by ${by === "country" ? "country" : "group"} · click a group to open it`]),
        el("button", { type: "button", class: "quietbtn", text: "Show every actor", onclick: () => { this._showAll = true; this._render(); } }),
      ]));
    } else if (sc.groupLabel !== null) {
      section.appendChild(el("div", { class: "banner info" }, [
        el("span", { class: "grow" }, [el("b", { text: sc.groupLabel }), ` · ${sc.actors.length} ${sc.actors.length === 1 ? "actor" : "actors"}`]),
        el("button", { type: "button", class: "quietbtn", text: "Back to all groups", onclick: () => { this._group = null; this._view = VIEWBOX.slice(); this._select(null); } }),
      ]));
    } else if (layout === "network" && this._showAll && sc.all.length > GROUP_THRESHOLD) {
      section.appendChild(el("div", { class: "banner info" }, [
        el("span", { class: "grow" }, [el("b", { text: `All ${sc.all.length} actors` })]),
        el("button", { type: "button", class: "quietbtn", text: "Group them again", onclick: () => { this._showAll = false; this._view = VIEWBOX.slice(); this._select(null); } }),
      ]));
    }

    const gbox = el("div", { class: "gbox" });
    const svgEl = svg("svg", {
      class: "net" + (layout === "rings" ? " rings" : "") + (sel ? " hassel" : ""),
      viewBox: this._view.map(fmt).join(" "), role: "img",
      "aria-label": sc.mode === "bubbles" ? "Actors grouped, one bubble per group"
        : layout === "rings" ? "Rings: the actors on this map by their role and stance" : "Network of the actors on this map and the links between them",
    });
    this._svg = svgEl;
    const arrowId = `tfs-pm-arr-${this._uid}`;
    svgEl.appendChild(svg("defs", {}, [svg("marker", { id: arrowId, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6.5, markerHeight: 6.5, orient: "auto-start-reverse" },
      [svg("path", { class: "arrowfill", d: "M0,0 L10,5 L0,10 z" })])]));

    if (sc.mode === "bubbles") {
      svgEl.appendChild(this._bubbles(sc));
    } else {
      if (layout === "rings") svgEl.appendChild(this._ringsBg());
      svgEl.appendChild(this._links(sc, linkVisible, sel, arrowId));
      if (layout === "rings") svgEl.appendChild(this._goal());
      svgEl.appendChild(this._nodes(sc, visible, sel, near, labels));
    }
    this._wirePointer(svgEl);
    gbox.appendChild(svgEl);

    if (sc.mode !== "bubbles" && this._keyOpen) gbox.appendChild(this._key(sc, nodesOnMap, labels));
    if (this._menu && sc.pos.has(this._menu.node_id)) gbox.appendChild(this._menuEl(this._menu.node_id, editable));
    else this._menu = null;
    if (sel) {
      gbox.appendChild(el("div", { class: "selhint" }, ["Click empty space or press Esc to clear ",
        el("button", { type: "button", class: "linkbtn", style: "font-size:12px", text: "Clear", onclick: () => this._select(null) })]));
    }
    section.appendChild(gbox);
    if (sc.mode === "rings" && sc.unplaced.length) section.appendChild(this._tray(sc.unplaced, editable));

    const focusId = this._focusNode;
    const oldBox = this.querySelector(".gbox"), keyEl = this.querySelector(".key");
    const keep = oldBox ? { l: oldBox.scrollLeft, t: oldBox.scrollTop, k: keyEl ? keyEl.scrollTop : 0 } : null;
    this.replaceChildren(section);
    if (keep) {                             // a re-render must not lose the reader's place
      gbox.scrollLeft = keep.l; gbox.scrollTop = keep.t;
      const k2 = this.querySelector(".key");
      if (k2) k2.scrollTop = keep.k;
    }
    if (this._menu) {
      const menu = this.querySelector("div.menu"), pos = this._menuPos(this._menu.node_id);
      if (menu && pos) menu.setAttribute("style", `left:${pos.left}px;top:${pos.top}px;transform:${pos.right ? "translateX(-100%)" : "none"}`);
    }
    // phone: the 780 px drawing pans inside the box; open it on the actors, not on the empty
    // strip the desktop Key uses
    if (this._centreNext && phoneNow()) {
      const box = this.querySelector(".gbox");
      const pts = [...sc.pos.values()];
      if (box && pts.length && box.scrollWidth > box.clientWidth) {
        const [vx, vy, vw, vh] = this._view;
        const r = this._svg.getBoundingClientRect();
        const cx = pts.reduce((t, p) => t + p.x, 0) / pts.length, cy = pts.reduce((t, p) => t + p.y, 0) / pts.length;
        box.scrollLeft = Math.max(0, (cx - vx) * (r.width / vw) - box.clientWidth / 2);
        box.scrollTop = Math.max(0, (cy - vy) * (r.height / vh) - box.clientHeight / 2);
      }
    }
    this._centreNext = false;
    if (this._focusKey) {
      const esc = globalThis.CSS && globalThis.CSS.escape ? globalThis.CSS.escape(this._focusKey) : this._focusKey;
      const b = this.querySelector(`.key [data-key="${esc}"]`) || this.querySelector(".key .xbtn");
      if (b && b.focus) b.focus();
      this._focusKey = null;
    }
    if (focusId) {
      const esc = globalThis.CSS && globalThis.CSS.escape ? globalThis.CSS.escape(focusId) : focusId;
      const n = this.querySelector(`[data-node="${esc}"]`);
      if (n && n.focus) n.focus();
      this._focusNode = null;
    }
    if (this._focusMenu) {
      const b = this.querySelector("div.menu button");
      if (b) b.focus();
      this._focusMenu = false;
    }
  }
  _actorByIdIn(list, id) {
    if (this._sc && this._sc.actors === list) return this._sc.byId.get(id) || null;
    return list.find((a) => a.node_id === id) || null;
  }

  _head(sc) {
    const layout = this.layout;
    const title = this.getAttribute("heading") || (layout === "rings" ? "Power holders and influencers" : "Who influences whom");
    const tools = el("div", { class: "tools" });
    if (sc.mode !== "bubbles") {
      tools.appendChild(el("button", { type: "button", class: "ibtn", "aria-pressed": String(!!this._keyOpen), text: "Key", onclick: () => this._setKeyOpen(!this._keyOpen) }));
    }
    tools.appendChild(el("button", { type: "button", class: "ibtn", "aria-label": "Zoom out", text: "−", onclick: () => this._zoom(1.25) }));
    tools.appendChild(el("button", { type: "button", class: "ibtn", "aria-label": "Zoom in", text: "+", onclick: () => this._zoom(0.8) }));
    tools.appendChild(el("button", { type: "button", class: "ibtn", text: "Fit", onclick: () => this._fit() }));
    const hint = sc.mode === "bubbles" ? "Click a group to open it" : "Click someone for details · right-click for actions";
    return el("div", { class: "phead" }, [el("h2", { text: title }), el("span", { class: "quiet hint", text: hint }), tools]);
  }

  _ringsBg() {
    const { cx, cy, bands } = RINGS;
    const f = (this._sc && this._sc.ringF) || 1;
    const [r1, r2, r3] = this._ringLabels();
    return svg("g", { class: "ringsbg", "aria-hidden": "true" }, [
      svg("circle", { class: "band b3", cx, cy, r: bands[2] * f }),
      svg("circle", { class: "band b2", cx, cy, r: bands[1] * f }),
      svg("circle", { class: "band b1", cx, cy, r: bands[0] * f }),
      svg("text", { class: "ringlab", x: cx, y: cy - (bands[0] - 8) * f, text: r1 }),
      svg("text", { class: "ringlab", x: cx, y: cy - (bands[1] - 12) * f, text: r2 }),
      svg("text", { class: "ringlab", x: cx, y: cy - (bands[2] - 21) * f, text: r3 }),
      svg("text", { class: "sidelab", x: cx + 320 * f, y: cy + 4, style: "text-anchor:start", text: "Supportive →" }),
      svg("text", { class: "sidelab", x: cx - 320 * f, y: cy + 4, style: "text-anchor:end", text: "← Sceptical" }),
      svg("text", { class: "sidelab", x: cx, y: cy + 322 * f, text: "Neutral or unknown" }),
    ]);
  }

  _goal() {
    const m = (this._data && this._data.map) || {};
    const o = this.options;
    const text = o.goal || m.goal || m.short_name || m.name || "";
    const lines = wrapLabel(text, 18, 3);
    const t = svg("text", { class: "goaltxt", x: RINGS.cx, y: RINGS.cy - (lines.length - 1) * 7 + 4 });
    lines.forEach((l, i) => t.appendChild(svg("tspan", { x: RINGS.cx, dy: i ? 14 : 0, text: l })));
    return svg("g", { class: "ringsbg", "aria-hidden": "true" }, [svg("circle", { class: "goal", cx: RINGS.cx, cy: RINGS.cy, r: RINGS.goal }), t]);
  }

  _geom(sc, id) {
    const a = this._actorByIdIn(sc.actors, id);
    const r = nodeRadius(judgement(a, sc.M.size));
    return { a, r, outline: !!relKey(a), p: sc.pos.get(id) };
  }

  _linkD(sc, l, i, lanes) {
    const A = this._geom(sc, l.from_node_id), B = this._geom(sc, l.to_node_id);
    const k = LINK_KINDS[l.kind];
    return linkPath(A.p, B.p, trimRadius(A.r, A.outline, false), trimRadius(B.r, B.outline, !!k.arrow), lanes.get(linkId(l, i)) || 0);
  }

  _links(sc, linkVisible, sel, arrowId) {
    const g = svg("g", { "data-layer": "links" });
    const lanes = linkLanes(sc.links);
    const nameOf = (id) => { const a = this._actorByIdIn(sc.actors, id); return a ? a.name : ""; };
    this._linkEls = [];
    sc.links.forEach((l, i) => {
      if (!linkVisible.has(l)) return;
      const k = LINK_KINDS[l.kind];
      const dim = sel && l.from_node_id !== sel && l.to_node_id !== sel;
      const p = svg("path", {
        class: linkClass(l) + (dim ? " dim" : ""), d: this._linkD(sc, l, i, lanes),
        "stroke-width": linkWidth(l), "stroke-dasharray": k.dash || null,
        "stroke-linecap": l.kind === "communicates" ? "round" : null,
        "marker-end": k.arrow ? `url(#${arrowId})` : null,
      }, [svg("title", { text: linkTitle(l, nameOf) })]);
      this._linkEls.push({ l, i, p, lanes });
      g.appendChild(p);
    });
    return g;
  }

  _nodes(sc, visible, sel, near, labels) {
    const g = svg("g", { "data-layer": "nodes" });
    this._nodeEls = new Map();
    // smaller on top: draw largest first so a small actor is never hidden under a large one
    const order = visible.slice().sort((p, q) => nodeRadius(judgement(q, sc.M.size)) - nodeRadius(judgement(p, sc.M.size)));
    for (const a of order) {
      const { r, p } = this._geom(sc, a.node_id);
      const rel = relKey(a);
      const isForum = a.kind === "forum";
      const cls = "nd" + (isForum ? " forum" : "") + (sel === a.node_id ? " sel" : "")
        + (this._menu && this._menu.node_id === a.node_id ? " menu" : "") + (sel && !near.has(a.node_id) ? " dim" : "");
      const stCls = isForum && judgement(a, sc.M.colour) === null ? "" : " " + stanceClass(colourBucket(judgement(a, sc.M.colour), sc.M.scale));
      const node = svg("g", {
        class: cls, transform: `translate(${fmt(p.x)},${fmt(p.y)})`, tabindex: 0, role: "button",
        "aria-label": `${a.name}, ${KIND_WORD[a.kind] || "actor"}`, "data-node": a.node_id,
        style: this.layout === "network" && !phoneNow() ? "touch-action:none" : null,
      });
      if (rel) node.appendChild(svg("circle", { class: `ring rg-${rel}`, r: fmt(r + 4) }));
      node.appendChild(svg("path", { class: "body" + stCls, d: shapeD(a.kind, r) }));
      node.appendChild(svg("circle", { class: "selring", r: fmt(r + 10) }));
      if (labels.named.has(a.node_id)) {
        const lines = wrapLabel(a.name, 22, 2);
        const t = svg("text", { y: fmt(r + 17) });
        if (lines.length === 1) t.textContent = lines[0];
        else lines.forEach((l, i) => t.appendChild(svg("tspan", { x: 0, dy: i ? 14 : 0, text: l })));
        node.appendChild(t);
      } else {
        node.appendChild(svg("title", { text: a.name }));
      }
      node.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this._select(a.node_id); this._focusNode = a.node_id; }
        else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); this._openMenu(a.node_id, null); }
      });
      node.addEventListener("contextmenu", (e) => {
        e.preventDefault(); e.stopPropagation();
        clearTimeout(this._lpTimer);
        if (this._ptr) { if (this._ptr.long) return; this._ptr.long = true; }
        this._openMenu(a.node_id, e);
      });
      this._nodeEls.set(a.node_id, node);
      g.appendChild(node);
    }
    return g;
  }

  _bubbles(sc) {
    const g = svg("g", { "data-layer": "bubbles" });
    const laid = bubbleLayout(sc.groups, { cap: this._allGroups ? Infinity : 12 });
    for (const b of laid) {
      const lines = b.more ? [`${b.label}`, "groups", `${b.count} actors`] : [wrapLabel(b.label, 16, 1)[0], `${b.count} ${b.count === 1 ? "actor" : "actors"}`];
      const node = svg("g", { class: "nd", role: "button", tabindex: 0, "data-group": b.key,
        "aria-label": b.more ? `${b.label} groups, ${b.count} actors — show them` : `${b.label}, ${b.count} ${b.count === 1 ? "actor" : "actors"} — open this group` });
      node.appendChild(b.more
        ? svg("circle", { cx: b.x, cy: b.y, r: b.r, style: "fill:var(--wash);stroke:var(--ink-3);stroke-dasharray:4 3" })
        : svg("circle", { cx: b.x, cy: b.y, r: b.r, class: "st0", style: "fill-opacity:.55;stroke:var(--ink-3)" }));
      const y0 = b.y - (lines.length - 1) * 8 + 4;
      lines.forEach((l, i) => node.appendChild(svg("text", { x: b.x, y: y0 + i * 16, "text-anchor": "middle",
        style: i === 0 ? "font-size:13px;font-weight:800;fill:var(--ink);stroke:none" : "font-size:12px;font-weight:400;fill:var(--ink-2);stroke:none", text: l })));
      node.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this._openGroup(b); } });
      g.appendChild(node);
    }
    return g;
  }
  _openGroup(b) {
    if (b.more) { this._allGroups = true; this._render(); return; }
    this._group = b.key;
    this._view = VIEWBOX.slice();
    this._render();
  }

  _keyIcon(ic) {
    if (ic.type === "band") return svg("svg", { width: 22, height: 22, "aria-hidden": "true" }, [svg("circle", { class: `band b${ic.band}`, cx: 11, cy: 11, r: 9 })]);
    if (ic.type === "outside") return svg("svg", { width: 22, height: 22, "aria-hidden": "true" }, [svg("circle", { cx: 11, cy: 11, r: 8, fill: "none", stroke: "var(--ink-3)", "stroke-dasharray": "2 3" })]);
    if (ic.type === "fill") return svg("svg", { width: 22, height: 22, "aria-hidden": "true" }, [svg("circle", { class: ic.cls, cx: 11, cy: 11, r: 8 })]);
    if (ic.type === "rel") return svg("svg", { width: 22, height: 22, "aria-hidden": "true" }, [svg("circle", { class: "st0", cx: 11, cy: 11, r: 5.5 }), svg("circle", { class: `rg-${ic.rel}`, fill: "none", cx: 11, cy: 11, r: 9 })]);
    if (ic.type === "shape") return svg("svg", { width: 22, height: 22, viewBox: "-11 -11 22 22", "aria-hidden": "true" }, [svg("path", { class: "shp" + (ic.kind === "forum" ? " forum" : ""), d: shapeD(ic.kind, 8) })]);
    if (ic.type === "line") {
      const k = LINK_KINDS[ic.kind];
      const cls = "ed" + (ic.kind === "opposes" ? " neg" : "") + (ic.kind === "member_of" && !ic.res ? " mem" : "") + (ic.res ? " res" : "");
      const kids = [svg("line", { class: cls, x1: 2, y1: 7, x2: k.arrow ? 31 : 38, y2: 7, "stroke-width": ic.kind === "member_of" ? 1.2 : k.w,
        "stroke-dasharray": k.dash || null, "stroke-linecap": ic.kind === "communicates" ? "round" : null })];
      if (k.arrow) kids.push(svg("path", { class: "arrowfill", d: "M31,2.5 L39,7 L31,11.5 z" }));
      return svg("svg", { width: 40, height: 14, "aria-hidden": "true" }, kids);
    }
    return null;
  }

  _key(sc, nodesOnMap, labels) {
    const M = sc.M;
    const sections = keyRows(nodesOnMap, sc.links, this.layout, { ringLabels: this._ringLabels(), scale: M.scale, stanceMeasure: M.colour, colourLabels: M.colourLabels });
    const anyOff = Object.values(this._off).some(Boolean);
    const key = el("div", { class: "key", role: "group", "aria-label": "Key" });
    key.appendChild(el("div", { class: "khead" }, [el("b", { text: "Key" }), el("span", { style: "display:flex;gap:6px;align-items:center" }, [
      anyOff ? el("button", { type: "button", class: "kreset", text: "Show all", onclick: () => { this._off = {}; this._focusKey = "\u0000"; this._render(); } }) : null,
      el("button", { type: "button", class: "xbtn", style: "width:28px;height:28px", "aria-label": "Hide the key", onclick: () => this._setKeyOpen(false) }, [icon(ICON.x, 14, 2.4)]),
    ])]));
    key.appendChild(el("div", { class: "khint" }, [icon(ICON.eye, 14, 2), "Click any row below to hide or show it on the map."]));
    const o = this.options;
    for (const s of sections) {
      const sec = el("div", { class: "ksec" });
      let title = s.title, sub = s.sub;
      if (s.id === "size") sub = "· " + (o.sizeLabel || "power over this goal");
      if (s.id === "colour") sub = "· " + (o.colourLabel || "stance on this goal");
      sec.appendChild(el("div", { class: "kt" }, [title + " ", sub ? el("span", { text: sub }) : null]));
      if (s.id === "size") {
        sec.appendChild(el("div", { class: "krow static" }, [svg("svg", { width: 64, height: 30, "aria-hidden": "true" }, [
          svg("circle", { class: "st0", cx: 9, cy: 17, r: 6 }), svg("circle", { class: "st0", cx: 27, cy: 16, r: 9 }), svg("circle", { class: "st0", cx: 50, cy: 15, r: 13 })]),
        el("span", { text: "Bigger means more" })]));
      }
      for (const row of s.rows) {
        const off = !!this._off[row.key];
        sec.appendChild(el("button", { type: "button", class: "krow" + (off ? " off" : ""), "aria-pressed": String(!off), "data-key": row.key,
          onclick: () => { this._off = { ...this._off, [row.key]: !off }; this._focusKey = row.key; this._render(); } }, [
          this._keyIcon(row.icon), el("span", {}, [row.label, row.em ? " " : null, row.em ? el("em", { text: row.em }) : null]),
        ]));
      }
      if (s.id === "rings") {
        sec.appendChild(el("div", { class: "quiet", style: "font-size:11.5px" }, ["Right of centre supports the goal, left is sceptical. ",
          this.editable ? el("button", { type: "button", class: "linkbtn", style: "font-size:11.5px", text: "Rename rings", onclick: () => this._emit("tfs-map-action", { action: "rename-rings" }) }) : null]));
      }
      if (s.id === "lines") {
        sec.appendChild(el("div", { class: "quiet", style: "font-size:11.5px;margin-top:4px", text: labels.all
          ? "Thicker means a stronger link. Every actor is named."
          : `Thicker means a stronger link. With more than ${LABEL_LIMIT} actors showing, only the selected actor, its neighbours and the ${TOP_POWER} most powerful are named.` }));
      }
      key.appendChild(sec);
    }
    if (!sections.some((s) => s.id === "lines")) {
      key.appendChild(el("div", { class: "quiet", style: "font-size:11.5px", text: labels.all ? "Every actor is named."
        : `With more than ${LABEL_LIMIT} actors showing, only the selected actor, its neighbours and the ${TOP_POWER} most powerful are named.` }));
    }
    return key;
  }

  _menuEl(id, editable) {
    const a = this._actorById(id);
    const act = (action) => () => {
      this._menu = null;
      if (action === "details") this._selected = id;
      this._emit("tfs-actor-action", { action, node_id: id });
      if (action === "details") this._emit("tfs-actor-select", { node_id: id });
      this._render();
    };
    const item = (label, d, action, cls) => el("button", { type: "button", role: "menuitem", class: cls || null, onclick: act(action) }, [icon(d, 16, 2), label]);
    const kids = [el("div", { class: "mt", text: a ? a.name : "" })];
    if (editable) { kids.push(item("Link to…", ICON.link, "link")); kids.push(item("Add a score", ICON.plus, "score")); }
    kids.push(item("Open details", ICON.panel, "details"));
    if (editable) { kids.push(el("hr")); kids.push(item("Remove from map", ICON.minus, "remove", "danger")); }
    const menu = el("div", { class: "menu", role: "menu", "aria-label": a ? a.name : "Actions" }, kids);
    menu.addEventListener("keydown", (e) => {
      const items = [...menu.querySelectorAll("button")];
      const i = items.indexOf(globalThis.document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    });
    // position beside the actor, flipping to its left past 62 % of the canvas (the prototype's rule)
    return menu;
  }
  _menuPos(id) {
    const sc = this._sc, p = sc && sc.pos.get(id);
    if (!p || !this._svg) return null;
    const box = this.querySelector(".gbox") || this._svg.parentNode;
    const [vx, vy, vw, vh] = this._view;
    const rect = this._svg.getBoundingClientRect ? this._svg.getBoundingClientRect() : null;
    const brect = box && box.getBoundingClientRect ? box.getBoundingClientRect() : rect;
    if (!rect || !rect.width) return null;
    const scale = rect.width / vw;
    const px = (p.x - vx) * scale + (rect.left - brect.left), py = (p.y - vy) * (rect.height / vh) + (rect.top - brect.top);
    const r = nodeRadius(judgement(this._actorById(id), sc.M.size)) * scale;
    const right = (px - (rect.left - brect.left)) / rect.width > 0.62;
    return { left: Math.round(right ? px - r - 14 : px + r + 14), top: Math.round(py - 24), right, cx: rect.left + (p.x - vx) * scale, cy: rect.top + (p.y - vy) * (rect.height / vh) };
  }
  _openMenu(id, evt) {
    this._selected = id;
    this._menu = { node_id: id };
    this._render();
    const pos = this._menuPos(id);
    const x = evt && Number.isFinite(evt.clientX) ? evt.clientX : pos ? Math.round(pos.cx) : 0;
    const y = evt && Number.isFinite(evt.clientY) ? evt.clientY : pos ? Math.round(pos.cy) : 0;
    this._emit("tfs-actor-select", { node_id: id });
    this._emit("tfs-actor-menu", { node_id: id, x, y });
    this._focusMenu = true;
    const b = this.querySelector("div.menu button");
    if (b) b.focus();
  }

  _tray(unplaced, editable) {
    const tray = el("div", { class: "tray", role: "region", "aria-label": "Not placed yet" }, [
      el("span", {}, [el("b", { text: `Not placed yet (${unplaced.length})` }), " · no role on this map, so no ring"]),
    ]);
    unplaced.forEach((a, i) => {
      const chip = el("span", { class: "tchip" }, [
        svg("svg", { width: 14, height: 14, viewBox: "-10 -10 20 20", "aria-hidden": "true" }, [svg("path", { class: "shp" + (a.kind === "forum" ? " forum" : ""), d: shapeD(a.kind, 8) })]),
        a.name || "",
      ]);
      if (editable) {
        const fid = `tfs-pm-role-${this._uid}-${i}`;
        chip.appendChild(el("label", { for: fid, style: "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)", text: `Role for ${a.name || ""}` }));
        const sel = el("select", { id: fid }, [el("option", { value: "", text: "Set role…" }), ...ROLE_PICK.map((r) => el("option", { value: r, text: ROLE_LABELS[r] }))]);
        sel.addEventListener("change", () => { if (sel.value) this._emit("tfs-actor-action", { action: "set-role", node_id: a.node_id, role: sel.value }); });
        chip.appendChild(sel);
      }
      tray.appendChild(chip);
    });
    return tray;
  }

  /* ---- pan, zoom, drag, long-press */
  _toSvg(e) {
    const s = this._svg;
    if (!s || !s.getScreenCTM) return null;
    const m = s.getScreenCTM();
    if (!m) return null;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: pt.x, y: pt.y };
  }
  _zoom(f, around) {
    const [x, y, w, h] = this._view;
    const nw = Math.max(VIEWBOX[2] / 6, Math.min(VIEWBOX[2] * 2.5, w * f));
    const nh = nw * (VIEWBOX[3] / VIEWBOX[2]);
    const c = around || { x: x + w / 2, y: y + h / 2 };
    this._view = [c.x - (c.x - x) * (nw / w), c.y - (c.y - y) * (nh / h), nw, nh];
    this._menu = null;
    this._render();
  }
  _fit() {
    const sc = this._sc;
    this._view = (sc && sc.mode === "network" && this._fitView(sc))
      || (sc && sc.mode === "rings" ? ringsView(sc.ringF || 1) : VIEWBOX.slice());
    this._render();
  }
  _fitView(sc) {
    if (!sc || sc.mode !== "network" || !sc.pos.size) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of sc.pos.values()) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    // leave room for the Key on the left when it is open, and for labels under the shapes
    const padL = this._keyOpen && !phoneNow() ? 330 : 70;
    x0 -= padL; x1 += 90; y0 -= 50; y1 += 70;
    const ar = VIEWBOX[3] / VIEWBOX[2];
    let w = Math.max(500, x1 - x0), h = w * ar;
    if (y1 - y0 > h) { h = y1 - y0; w = h / ar; }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    return [cx - w / 2, cy - h / 2, w, h];
  }
  _wirePointer(s) {
    s.addEventListener("pointerdown", (e) => {
      if (e.button === 2) return;
      const node = e.target.closest && e.target.closest("[data-node]");
      const bubble = e.target.closest && e.target.closest("[data-group]");
      const touch = e.pointerType === "touch";
      this._ptr = { id: e.pointerId, node: node ? node.getAttribute("data-node") : null, group: bubble ? bubble.getAttribute("data-group") : null,
        x: e.clientX, y: e.clientY, moved: false, touch, view: this._view.slice(), start: this._toSvg(e), long: false };
      if (!touch) { try { s.setPointerCapture(e.pointerId); } catch { /* not capturable */ } }
      clearTimeout(this._lpTimer);
      if (touch && this._ptr.node) {
        const id = this._ptr.node;
        this._lpTimer = setTimeout(() => { if (this._ptr && !this._ptr.moved) { this._ptr.long = true; this._openMenu(id, { clientX: e.clientX, clientY: e.clientY }); } }, 550);
      }
    });
    s.addEventListener("pointermove", (e) => {
      const p = this._ptr;
      if (!p || p.id !== e.pointerId) return;
      const dist = Math.hypot(e.clientX - p.x, e.clientY - p.y);
      if (!p.moved && dist > (p.touch ? 8 : 4)) { p.moved = true; clearTimeout(this._lpTimer); }
      if (!p.moved || p.touch) return;      // on touch the box scrolls natively
      const now = this._toSvg(e);
      if (!now || !p.start) return;
      if (p.node && this.layout === "network" && this._sc && this._sc.mode === "network") {
        const b = NET_BOX;
        const np = { x: Math.max(VIEWBOX[0] + 20, Math.min(VIEWBOX[0] + VIEWBOX[2] - 20, now.x)), y: Math.max(b.y0 - 30, Math.min(VIEWBOX[3] - 20, now.y)) };
        this._dragPos.set(p.node, np);
        this._sc.pos.set(p.node, np);
        this._moveNode(p.node, np);
        p.dragged = np;
      } else if (!p.node && !p.group) {
        // pan: move the viewBox by the pointer's travel in drawing units (from the start view)
        const [vx, vy, vw, vh] = p.view;
        const rect = s.getBoundingClientRect();
        const kx = vw / rect.width, ky = vh / rect.height;
        this._view = [vx - (e.clientX - p.x) * kx, vy - (e.clientY - p.y) * ky, vw, vh];
        s.setAttribute("viewBox", this._view.map(fmt).join(" "));
      }
    });
    const end = (e, cancelled) => {
      const p = this._ptr;
      if (!p || p.id !== e.pointerId) return;
      this._ptr = null;
      clearTimeout(this._lpTimer);
      if (cancelled || p.long) return;
      if (p.dragged) { this._emit("tfs-actor-move", { node_id: p.node, x: Math.round(p.dragged.x * 10) / 10, y: Math.round(p.dragged.y * 10) / 10 }); return; }
      if (p.moved) return;
      if (p.group) {
        const sc = this._sc;
        const b = sc && sc.groups ? bubbleLayout(sc.groups, { cap: this._allGroups ? Infinity : 12 }).find((x) => x.key === p.group) : null;
        if (b) this._openGroup(b);
        return;
      }
      if (p.node) { this._select(p.node); return; }
      if (this._menu || this._selected) { this._menu = null; this._select(null); }
    };
    s.addEventListener("pointerup", (e) => end(e, false));
    s.addEventListener("pointercancel", (e) => end(e, true));
  }
  _moveNode(id, np) {
    const g = this._nodeEls && this._nodeEls.get(id);
    if (g) g.setAttribute("transform", `translate(${fmt(np.x)},${fmt(np.y)})`);
    for (const { l, i, p, lanes } of this._linkEls || []) {
      if (l.from_node_id === id || l.to_node_id === id) p.setAttribute("d", this._linkD(this._sc, l, i, lanes));
    }
  }

  /* ---- document listeners */
  _docKey(e) {
    if (e.key !== "Escape") return;
    if (this._menu) { const id = this._menu.node_id; this._menu = null; this._focusNode = id; this._render(); return; }
    if (!this._selected) return;
    const t = e.target;
    const inside = t === globalThis.document.body || (this.contains && this.contains(t));
    if (inside) this._select(null);
  }
  _docDown(e) {
    if (!this._menu) return;
    const menu = this.querySelector("div.menu");
    if (menu && menu.contains(e.target)) return;
    const node = e.target.closest && e.target.closest("[data-node]");
    if (node && this.contains(node) && e.button === 2) return;
    this._menu = null;
    this._render();
  }
}

if (globalThis.customElements && !globalThis.customElements.get("tfs-power-map")) {
  globalThis.customElements.define("tfs-power-map", TfsPowerMap);
}
