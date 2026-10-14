// <tfs-power-map> (K1): the pure geometry and rules behind Rings and Network, checked against
// the 2026-10-15 design hand-off (HANDOFF §4) and the prototype's own numbers (Main.dc.html).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shapeD, nodeRadius, trimRadius, wrapLabel, numeric, stanceBucket, colourBucket, relKey,
  ringOf, ringRadius, stanceAnchors, ringAngle, ringPlacement, RINGS, ringScale, ringsView, spreadAngles,
  labelSet, nodeKeys, keyFilter, keyRows, linkLanes, linkPath, linkWidth, linkClass, linkId,
  isResearched, liveActors, drawableLinks, groupBubbles, groupingOf, bubbleLayout, opensGrouped,
  networkLayout, NET_BOX, partialText, LINK_KINDS, LINK_ORDER, DEFAULT_RING_LABELS, TfsPowerMap,
} from "../power-map.js";

const actor = (id, o = {}) => ({ node_id: id, kind: "person", name: id.toUpperCase(), judgements: {}, ...o });
const scored = (id, power, stance, o = {}) => actor(id, { judgements: { power: { value: power }, stance: { value: stance } }, ...o });

/* ---------------------------------------------------------------- shapes and sizes */

test("shapeD at r = 8 is the prototype's SHAPE table, path for path", () => {
  assert.equal(shapeD("person"), "M-8,0 a8,8 0 1,0 16,0 a8,8 0 1,0 -16,0");
  assert.equal(shapeD("organization"), "M-4.95,-6.88 H4.95 Q6.88,-6.88 6.88,-4.95 V4.95 Q6.88,6.88 4.95,6.88 H-4.95 Q-6.88,6.88 -6.88,4.95 V-4.95 Q-6.88,-6.88 -4.95,-6.88 Z");
  assert.equal(shapeD("seat"), "M-7.6,-6.23 L7.6,-6.23 L7.6,2.13 L0,7.98 L-7.6,2.13 Z");
  assert.equal(shapeD("group"), "M-4.48,-3.36 a4.48,4.48 0 1,0 8.96,0 a4.48,4.48 0 1,0 -8.96,0 M-8.32,2.88 a4.48,4.48 0 1,0 8.96,0 a4.48,4.48 0 1,0 -8.96,0 M-0.64,2.88 a4.48,4.48 0 1,0 8.96,0 a4.48,4.48 0 1,0 -8.96,0");
  assert.equal(shapeD("forum"), "M0,-8.64 L8.64,0 L0,8.64 L-8.64,0 Z");
  assert.equal(shapeD("country"), "M8.16,0 L4.08,7.07 L-4.08,7.07 L-8.16,0 L-4.08,-7.07 L4.08,-7.07 Z");
});

test("shapeD scales to the sizes drawn on the network screen", () => {
  assert.equal(shapeD("person", 26), "M-26,0 a26,26 0 1,0 52,0 a26,26 0 1,0 -52,0");                      // Ana
  assert.equal(shapeD("organization", 15.2), "M-9.41,-13.07 H9.41 Q13.07,-13.07 13.07,-9.41 V9.41 Q13.07,13.07 9.41,13.07 H-9.41 Q-13.07,13.07 -13.07,9.41 V-9.41 Q-13.07,-13.07 -9.41,-13.07 Z"); // ENISA
  assert.match(shapeD("seat", 26), /^M-24\.7,-20\.25 L24\.7,-20\.25 L24\.7,6\.92 L0,25\.9[34] L-24\.7,6\.92 Z$/); // Presidency
  assert.equal(shapeD("forum", 14), "M0,-15.12 L15.12,0 L0,15.12 L-15.12,0 Z");                             // GPAI
  assert.equal(shapeD("group", 18.8), "M-10.53,-7.9 a10.53,10.53 0 1,0 21.06,0 a10.53,10.53 0 1,0 -21.06,0 M-19.55,6.77 a10.53,10.53 0 1,0 21.06,0 a10.53,10.53 0 1,0 -21.06,0 M-1.5,6.77 a10.53,10.53 0 1,0 21.06,0 a10.53,10.53 0 1,0 -21.06,0"); // NL ministers
  assert.equal(shapeD("something-new", 8), shapeD("person", 8));
});

test("size is 8 + power × 3.6; an unscored actor is 10", () => {
  assert.equal(nodeRadius(5), 26);
  assert.equal(Math.round(nodeRadius(3) * 100) / 100, 18.8);
  assert.equal(Math.round(nodeRadius("4") * 100) / 100, 22.4);
  assert.equal(nodeRadius(null), 10);
  assert.equal(nodeRadius({ value: null }), 10);
  assert.equal(nodeRadius(""), 10);
});

test("links stop at the shape edge plus its outline, with room for an arrowhead", () => {
  assert.equal(trimRadius(26, true, false), 33);   // 26 + 4 + 3, the prototype's seg()
  assert.equal(trimRadius(26, true, true), 38);    // arrow end: +8
  assert.equal(trimRadius(10, false, false), 13);
});

test("numbers, stance bands and the 1–5 colour scale", () => {
  assert.equal(numeric("−1"), -1);
  assert.equal(numeric({ value: "3" }), 3);
  assert.equal(numeric("n/a"), null);
  assert.equal(stanceBucket(1.6), 2);
  assert.equal(stanceBucket(-7), -2);
  assert.equal(stanceBucket(null), null);
  assert.equal(colourBucket(5, "five"), 2);
  assert.equal(colourBucket(1, "five"), -2);
  assert.equal(colourBucket(3, "five"), 0);
});

test("only people and organisations get a who-knows-them outline; owner-only reads as no meeting", () => {
  assert.equal(relKey(actor("a", { relationship: { label: "warm" } })), "warm");
  assert.equal(relKey(actor("a", { kind: "organization", relationship: { label: "known" } })), "known");
  assert.equal(relKey(actor("a", { relationship: { label: "owner_only" } })), "none");
  assert.equal(relKey(actor("a", { kind: "seat", relationship: { label: "warm" } })), null);
  assert.equal(relKey(actor("a", { kind: "forum", relationship: { label: "warm" } })), null);
  assert.equal(relKey(actor("a")), null);
});

test("a long name wraps onto two lines and is clipped after that", () => {
  assert.deepEqual(wrapLabel("Ana Ferreira-Lindqvist"), ["Ana Ferreira-Lindqvist"]);
  assert.deepEqual(wrapLabel("EU Agency for Cybersecurity (ENISA)"), ["EU Agency for", "Cybersecurity (ENISA)"]);
  const three = wrapLabel("Rotating Presidency of the Council of the European Union and friends");
  assert.equal(three.length, 2);
  assert.match(three[1], /…$/);
});

/* ---------------------------------------------------------------- Rings */

test("ring = role on this map; no role means the tray", () => {
  assert.equal(ringOf("decision_maker"), 1);
  assert.equal(ringOf("direct_influencer"), 2);
  assert.equal(ringOf("indirect_influencer"), 3);
  for (const r of ["affected", "ally", "tfs", "other"]) assert.equal(ringOf(r), 4, r);
  assert.equal(ringOf(null), 0);
  assert.equal(ringOf(undefined), 0);
  assert.deepEqual([1, 2, 3, 4].map((r) => ringRadius(r)), [105, 186, 266, 338]);
});

test("angle from stance: +2 → 0°, +1 → about ±40°, 0 → 90°, −1 → about ±140°, −2 → 180°", () => {
  for (const ring of [1, 2, 3]) {
    assert.equal(ringAngle(2, 0, ring), 0);
    assert.equal(ringAngle(0, 0, ring), 90);
    assert.equal(ringAngle(null, 0, ring), 90);   // unknown sits with neutral, at the bottom
    assert.equal(ringAngle(-2, 0, ring), 180);
    const [up, down] = stanceAnchors(1, ring);
    assert.ok(up < 0 && down > 0 && Math.abs(up) === down && down >= 20 && down <= 55, `ring ${ring}: ±${down}`);
    const neg = stanceAnchors(-1, ring).map((a) => ((a % 360) + 360) % 360).sort((a, b) => a - b);
    assert.equal(neg[0] + neg[1], 360);
    assert.ok(neg[0] >= 125 && neg[0] <= 160, `ring ${ring}: ${neg}`);
  }
  // neighbouring rings are staggered so their +1 actors do not line up
  assert.notEqual(stanceAnchors(1, 1)[1], stanceAnchors(1, 2)[1]);
});

test("actors sharing a stance spread out, alternating sign and widening", () => {
  const a = [0, 1, 2, 3, 4].map((i) => ringAngle(2, i, 1));
  assert.equal(a[0], 0);
  assert.ok(a[1] > 0 && a[2] < 0, "first spread goes one way, the next the other");
  assert.equal(a[1], -a[2]);
  assert.ok(a[3] > a[1] && a[4] < a[2], "and the offset widens");
  // ±40 bands use both anchors before spreading
  const b = [0, 1, 2, 3].map((i) => ringAngle(1, i, 2));
  assert.deepEqual(b.slice(0, 2), stanceAnchors(1, 2));
  assert.ok(b[2] !== b[0] && b[3] !== b[1]);
  assert.equal(new Set(b.map((x) => x.toFixed(3))).size, 4, "nobody shares a spot");
});

test("ringPlacement puts each actor on its ring's radius, strongest on the anchor, roleless in the tray", () => {
  const actors = [
    scored("ana", 5, 1, { role: "decision_maker" }),
    scored("ursula", 4, 2, { role: "decision_maker" }),
    scored("small", 2, 1, { role: "decision_maker" }),
    scored("pieter", 3, 1, { role: "direct_influencer" }),
    scored("mei", 2, 1, { role: "indirect_influencer" }),
    scored("marta", 2, -1, { role: "affected" }),
    actor("lena", { role: null }),
  ];
  const { placed, unplaced } = ringPlacement(actors);
  assert.deepEqual(unplaced.map((a) => a.node_id), ["lena"]);
  const U = placed.get("ursula");
  assert.deepEqual([U.x, U.y], [RINGS.cx + 105, RINGS.cy]);       // +2 at 0°, ring 1
  assert.equal(placed.get("ana").angle, stanceAnchors(1, 1)[0]);     // higher power takes the first anchor
  assert.equal(placed.get("small").angle, stanceAnchors(1, 1)[1]);
  for (const [id, ring] of [["pieter", 2], ["mei", 3]]) {
    const p = placed.get(id);
    assert.equal(p.ring, ring);
    assert.ok(Math.abs(Math.hypot(p.x - RINGS.cx, p.y - RINGS.cy) - ringRadius(ring)) < 0.2, id);
  }
  const m = placed.get("marta");
  assert.equal(m.ring, 4);
  assert.ok(m.x < RINGS.cx, "sceptical sits left of centre");
  for (const p of placed.values()) assert.ok(p.y >= 0 && p.y <= 660, "inside the canvas");
});

test("outside-the-rings neutral actors stay on the canvas", () => {
  const many = Array.from({ length: 6 }, (_, i) => actor("o" + i, { role: "other" }));
  const { placed } = ringPlacement(many);
  for (const p of placed.values()) { assert.ok(p.y <= 624 && p.y >= 24); assert.ok(p.x >= -170 && p.x <= 1000); }
});

/* ---------------------------------------------------------------- labels */

test("every actor is named up to 80 on screen", () => {
  const ids = Array.from({ length: 80 }, (_, i) => "n" + i);
  const r = labelSet(ids, [], null, () => 1);
  assert.equal(r.all, true);
  assert.equal(r.named.size, 80);
});

test("past 80: only the selected actor, its neighbours and the top 10 by power", () => {
  const ids = Array.from({ length: 120 }, (_, i) => "n" + i);
  const power = (id) => Number(id.slice(1)) % 50;                   // n49 and n99 are strongest
  const links = [{ from_node_id: "n0", to_node_id: "n1", kind: "advises" }, { from_node_id: "n2", to_node_id: "n0", kind: "trusts" },
    { from_node_id: "n3", to_node_id: "n4", kind: "trusts" }];
  const r = labelSet(ids, links, "n0", power);
  assert.equal(r.all, false);
  for (const id of ["n0", "n1", "n2", "n49", "n99", "n48", "n98"]) assert.ok(r.named.has(id), id);
  assert.ok(!r.named.has("n3") && !r.named.has("n4"), "someone else's neighbours stay unnamed");
  assert.equal(r.named.size, 3 + 10);
  const none = labelSet(ids, links, null, power);
  assert.equal(none.named.size, 10);
});

/* ---------------------------------------------------------------- Key */

test("nodeKeys: kind, stance band, ring (Rings only), outline", () => {
  const a = scored("ana", 5, 1, { role: "decision_maker", relationship: { label: "warm" } });
  assert.deepEqual(nodeKeys(a, "network"), ["kind:person", "st:1", "rel:warm"]);
  assert.deepEqual(nodeKeys(a, "rings"), ["kind:person", "st:1", "ring:1", "rel:warm"]);
  assert.deepEqual(nodeKeys(actor("p")), ["kind:person", "st:0"]);              // unscored person = neutral or unknown
  assert.deepEqual(nodeKeys(actor("f", { kind: "forum" })), ["kind:forum"]);   // unscored forum: no stance key
  assert.deepEqual(nodeKeys(actor("o", { kind: "organization" })), ["kind:organization"]);
});

test("a hidden row hides its actors; a link hides if its kind or either end is hidden", () => {
  const actors = [scored("a", 3, 1), scored("b", 3, -1), actor("c", { kind: "organization" })];
  const links = [
    { link_id: "1", from_node_id: "a", to_node_id: "b", kind: "advises" },
    { link_id: "2", from_node_id: "a", to_node_id: "c", kind: "works_at" },
    { link_id: "3", from_node_id: "c", to_node_id: "a", kind: "communicates" },
  ];
  let f = keyFilter(actors, links, { "st:-1": true });
  assert.deepEqual([...f.hiddenNodes], ["b"]);
  assert.deepEqual([...f.hiddenLinks], ["1"]);
  f = keyFilter(actors, links, { "link:works_at": true });
  assert.deepEqual([...f.hiddenNodes], []);
  assert.deepEqual([...f.hiddenLinks], ["2"]);
  f = keyFilter(actors, links, { "kind:organization": true });
  assert.deepEqual([...f.hiddenLinks].sort(), ["2", "3"]);
  f = keyFilter(actors, links, {});
  assert.equal(f.hiddenNodes.size + f.hiddenLinks.size, 0);
});

test("the Key lists only what the map has, in the design's order", () => {
  const actors = [scored("a", 3, 2, { relationship: { label: "warm" } }), scored("b", 3, -1, { kind: "seat" }), actor("f", { kind: "forum" })];
  const links = [{ from_node_id: "a", to_node_id: "b", kind: "opposes" }, { from_node_id: "a", to_node_id: "f", kind: "advises" }];
  const s = keyRows(actors, links, "network");
  assert.deepEqual(s.map((x) => x.id), ["size", "colour", "rel", "shape", "lines"]);
  const by = Object.fromEntries(s.map((x) => [x.id, x.rows.map((r) => r.key)]));
  assert.deepEqual(by.colour, ["st:2", "st:-1"]);
  assert.deepEqual(by.rel, ["rel:warm"]);
  assert.deepEqual(by.shape, ["kind:person", "kind:seat", "kind:forum"]);
  assert.deepEqual(by.lines, ["link:advises", "link:opposes"]);          // LINK_ORDER, not data order
  assert.equal(s.find((x) => x.id === "shape").rows[1].em, "— holder changes");
});

test("in Rings the Key names the three rings (map's own names or the defaults) and 'outside' when used", () => {
  const actors = [scored("a", 3, 1, { role: "decision_maker" }), actor("t", { kind: "organization", role: "tfs" })];
  let s = keyRows(actors, [], "rings");
  assert.deepEqual(s[0].rows.map((r) => r.label), [...DEFAULT_RING_LABELS, "Outside the rings"]);
  s = keyRows([actors[0]], [], "rings", { ringLabels: ["Deciders", "Shapers", "Voices"] });
  assert.deepEqual(s[0].rows.map((r) => r.label), ["Deciders", "Shapers", "Voices"]);
});

test("researched member-of lines are tagged 'from public sources' and drawn blue", () => {
  const actors = [actor("ca", { kind: "country" }), actor("g7", { kind: "forum" })];
  const l = { from_node_id: "ca", to_node_id: "g7", kind: "member_of", source: "import: Samples page research" };
  assert.equal(isResearched(l), true);
  assert.equal(linkClass(l), "ed mem res");
  const row = keyRows(actors, [l], "network").find((x) => x.id === "lines").rows[0];
  assert.equal(row.em, "· from public sources");
  assert.equal(isResearched({ kind: "member_of", source: "page" }), false);
  assert.equal(linkClass({ kind: "opposes" }), "ed neg");
});

/* ---------------------------------------------------------------- links */

test("the KIND table: arrowheads only on directed kinds; works_on is dashed", () => {
  const directed = LINK_ORDER.filter((k) => LINK_KINDS[k].arrow);
  assert.deepEqual(directed.sort(), ["advises", "funds", "holds_seat", "reports_to", "trusts", "works_at", "works_on"].sort());
  assert.equal(LINK_KINDS.works_on.dash, "4 2");
  assert.equal(LINK_ORDER.length, Object.keys(LINK_KINDS).length);
});

test("stroke width scales with strength as in the prototype", () => {
  assert.equal(linkWidth({ kind: "advises", strength: 2 }), 2.25);
  assert.equal(linkWidth({ kind: "communicates", strength: 3 }), 2.7);
  assert.equal(linkWidth({ kind: "works_at" }), 1);
});

test("one link between a pair is straight; two curve apart, whichever way they point", () => {
  const one = linkLanes([{ link_id: "x", from_node_id: "a", to_node_id: "b" }]);
  assert.equal(one.get("x"), 0);
  const two = linkLanes([{ link_id: "1", from_node_id: "a", to_node_id: "b" }, { link_id: "2", from_node_id: "b", to_node_id: "a" }]);
  assert.ok(two.get("1") !== 0 && two.get("2") !== 0);
  // drawn from their own ends, the two curves must bow to opposite sides of the a–b line
  const pa = { x: 0, y: 0 }, pb = { x: 100, y: 0 };
  const d1 = linkPath(pa, pb, 0, 0, two.get("1")), d2 = linkPath(pb, pa, 0, 0, two.get("2"));
  const cy = (d) => Number(d.match(/Q[-\d.]+,([-\d.]+)/)[1]);
  assert.ok(Math.sign(cy(d1)) !== Math.sign(cy(d2)), `${d1} / ${d2}`);
  const three = linkLanes([1, 2, 3].map((i) => ({ link_id: String(i), from_node_id: "a", to_node_id: "b" })));
  assert.deepEqual([...three.values()], [-22, 0, 22]);
});

test("a straight link is trimmed at both ends", () => {
  assert.equal(linkPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 15), "M10.0,0.0 L85.0,0.0");
  assert.equal(linkPath({ x: 0, y: 0 }, { x: 0, y: 50 }, 5, 5), "M0.0,5.0 L0.0,45.0");
  const curved = linkPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 15, 11);
  assert.match(curved, /^M[-\d.]+,[-\d.]+ Q50\.0,-22\.0 [-\d.]+,[-\d.]+$/);
});

test("links drawn: both ends on the map, known kind, and never an unconfirmed AI draft", () => {
  const ids = new Set(["a", "b"]);
  const data = { links: [
    { link_id: "1", from_node_id: "a", to_node_id: "b", kind: "advises" },
    { link_id: "2", from_node_id: "a", to_node_id: "b", kind: "trusts", ai_unconfirmed: true },
    { link_id: "3", from_node_id: "a", to_node_id: "zz", kind: "advises" },
    { link_id: "4", from_node_id: "a", to_node_id: "b", kind: "mystery" },
    { link_id: "5", from_node_id: "a", to_node_id: "a", kind: "advises" },
  ] };
  assert.deepEqual(drawableLinks(data, ids).map((l) => l.link_id), ["1"]);
  assert.equal(linkId({ id: "abc" }), "abc");
});

test("removed actors are not drawn", () => {
  const data = { actors: [actor("a"), actor("b", { status: "removed" }), actor("c", { removed: true }), null, {}] };
  assert.deepEqual(liveActors(data).map((a) => a.node_id), ["a"]);
  assert.deepEqual(liveActors(null), []);
});

/* ---------------------------------------------------------------- Network layout */

test("the network layout is deterministic and stays inside its box", () => {
  const actors = Array.from({ length: 40 }, (_, i) => scored("n" + i, (i % 5) + 1, (i % 5) - 2));
  const links = Array.from({ length: 50 }, (_, i) => ({ from_node_id: "n" + (i % 40), to_node_id: "n" + ((i * 7 + 3) % 40), kind: "advises" }))
    .filter((l) => l.from_node_id !== l.to_node_id);
  const a = networkLayout(actors, links), b = networkLayout(actors.slice().reverse(), links);
  assert.equal(a.size, 40);
  for (const [id, p] of a) {
    assert.deepEqual(p, b.get(id), "same input, same picture, whatever the order");
    assert.ok(p.x >= NET_BOX.x0 && p.x <= NET_BOX.x1 && p.y >= NET_BOX.y0 && p.y <= NET_BOX.y1, id);
  }
  // nobody sits on top of anybody else
  const pts = [...a.values()];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) assert.ok(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) > 12);
});

test("linked actors end up closer than unlinked ones, and fixed positions are kept", () => {
  const actors = ["a", "b", "c", "d", "e", "f"].map((id) => actor(id));
  const links = [{ from_node_id: "a", to_node_id: "b", kind: "trusts" }, { from_node_id: "a", to_node_id: "c", kind: "trusts" }];
  const p = networkLayout(actors, links);
  const d = (x, y) => Math.hypot(p.get(x).x - p.get(y).x, p.get(x).y - p.get(y).y);
  assert.ok(d("a", "b") < d("e", "f") + 200);
  const fixed = networkLayout([actor("z", { x: 500, y: 300 }), actor("y")], []);
  assert.deepEqual(fixed.get("z"), { x: 500, y: 300 });
  assert.equal(networkLayout([], []).size, 0);
});

test("a crowded network gets a bigger drawing instead of piling actors on the walls", () => {
  const n = 200;
  const actors = Array.from({ length: n }, (_, i) => scored("n" + i, (i % 5) + 1, 0));
  const links = Array.from({ length: 240 }, (_, i) => ({ from_node_id: "n" + (i % n), to_node_id: "n" + ((i * 13 + 5) % n), kind: "advises" }));
  const p = networkLayout(actors, links);
  const pts = [...p.values()];
  const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
  assert.ok(Math.max(...xs) - Math.min(...xs) > NET_BOX.x1 - NET_BOX.x0, "wider than the default box");
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const nearWall = pts.filter((q) => q.x - x0 < 30 || x1 - q.x < 30 || q.y - y0 < 30 || y1 - q.y < 30).length;
  assert.ok(nearWall / n < 0.35, `${nearWall} of ${n} actors hug the edge`);
});

/* ---------------------------------------------------------------- large maps */

test("over 150 actors the map opens grouped, with exact counts that add up", () => {
  assert.equal(opensGrouped(150), false);
  assert.equal(opensGrouped(151), true);
  assert.equal(opensGrouped(504, true), false);
  const actors = [
    ...Array.from({ length: 5 }, (_, i) => actor("eu" + i, { countries: ["European Union", "France"] })),
    ...Array.from({ length: 3 }, (_, i) => actor("us" + i, { countries: ["United States"] })),
    actor("x", { countries: [] }), actor("y"),
  ];
  assert.equal(groupingOf(actors), "country");
  const g = groupBubbles(actors, "country");
  assert.deepEqual(g.map((x) => [x.label, x.count]), [["European Union", 5], ["United States", 3], ["No country", 2]]);
  assert.equal(g.reduce((s, x) => s + x.count, 0), actors.length, "each actor counted once");
  const byGrouping = groupBubbles([actor("a", { grouping: "Regulators" }), actor("b")], "grouping");
  assert.deepEqual(byGrouping.map((x) => x.label), ["Regulators", "No group"]);
  assert.equal(groupingOf([actor("a", { grouping: "G" })]), "grouping");
});

test("bubbles past the cap fold into one 'n more' bubble that keeps the exact total", () => {
  const groups = Array.from({ length: 15 }, (_, i) => ({ key: "g" + i, label: "Group " + i, count: 40 - i, ids: [] }));
  const laid = bubbleLayout(groups, { cap: 8 });
  assert.equal(laid.length, 8);
  const more = laid[laid.length - 1];
  assert.equal(more.more, true);
  assert.equal(more.label, "8 more");
  assert.equal(laid.reduce((s, b) => s + b.count, 0), groups.reduce((s, g) => s + g.count, 0));
  for (const b of laid) { assert.ok(b.x - b.r >= -170 && b.x + b.r <= 1000, b.label); assert.ok(b.y - b.r >= 0 && b.y + b.r <= 660, b.label); }
  assert.ok(laid[0].r > laid[6].r, "a bigger group gets a bigger bubble");
});

test("partial banner: 'Showing n of N — loading the rest…' while loading; plain count when cut", () => {
  const data = { actors: [actor("a")], actor_count_returned: 289, map_actor_count: 504, truncated: true };
  assert.deepEqual(partialText(data, true), { strong: "Showing 289 of 504", rest: " — loading the rest…" });
  assert.deepEqual(partialText(data, false), { strong: "Showing 289 of 504", rest: " actors." });
  assert.equal(partialText({ actors: [actor("a")] }, false), null);
});

/* ---------------------------------------------------------------- module shape */

test("the module loads without a DOM and exports the element class", () => {
  assert.equal(typeof TfsPowerMap, "function");
  assert.deepEqual(TfsPowerMap.observedAttributes.slice().sort(), ["editable", "group-by", "heading", "layout", "partial"]);
});

test("record text never goes through innerHTML", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../power-map.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML/);
});


test("a country actor groups under its own name; no works_on falls back to the grouping", () => {
  const g = groupBubbles([
    { node_id: "c1", kind: "country", name: "Arcadia" },
    { node_id: "p1", kind: "person", countries: ["Arcadia"] },
    { node_id: "p2", kind: "person", grouping: "Arcadia" },
    { node_id: "p3", kind: "person" },
  ], "country");
  const by = Object.fromEntries(g.map((x) => [x.label, x.count]));
  assert.deepEqual(by, { Arcadia: 3, "No country": 1 });
});


test("a crowded ring grows so every actor keeps a label's room, and nobody overlaps", () => {
  assert.equal(ringScale({ 1: 6 }), 1, "six power holders fit the design's ring");
  assert.ok(ringScale({ 1: 30 }) > 1, "thirty need a bigger drawing");
  const f = ringScale({ 1: 12 });
  assert.ok(f > 1.5 && f < 2.2, String(f));
  const actors = Array.from({ length: 12 }, (_, i) => ({ node_id: "n" + i, name: "Actor " + i, role: "decision_maker",
    judgements: i % 3 ? {} : { stance: { value: 1 } } }));
  const { placed, scale } = ringPlacement(actors);
  assert.equal(scale, f);
  const pts = [...placed.values()];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
    assert.ok(d >= 80, `actors ${i} and ${j} are ${d.toFixed(1)} apart`);
  }
  const [x0, y0, w, h] = ringsView(f);
  for (const p of pts) assert.ok(p.x > x0 && p.x < x0 + w && p.y > y0 && p.y < y0 + h);
  const items = spreadAngles([{ angle: 90 }, { angle: 91 }, { angle: 92 }], 20);
  const sorted = items.map((x) => x.angle).sort((a, b) => a - b);
  assert.ok(sorted[1] - sorted[0] >= 19.9 && sorted[2] - sorted[1] >= 19.9);
});
