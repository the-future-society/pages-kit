/* TFS pages kit — the Power Maps details and setup parts (kit 1.9.0).
 *
 *   K7 <tfs-actor-details>  ONE details panel for an actor, the same wherever it was opened
 *        (Rings, Network, List, Cards). Everything shown is editable IN PLACE by an editor:
 *        the CRM record itself (contacts / organizations, saved straight to the CRM), a seat /
 *        group / forum / country's own name and description, its place on this map (role,
 *        countries or group, owner, messenger), and each score (a new judgement; the old one
 *        stays in History).
 *   K8 <tfs-map-setup>      how a map is set up — kind, objective, team, owner, parent and child
 *        maps, linked records, its scores, what sets size and colour, ring names, how people are
 *        grouped, and every shape and line kind on it — with "Edit setup" for editors.
 *   K9 <tfs-map-find>       "Find on this map": type a name, pick, the page shows them.
 *
 * The element writes nothing itself except through <tfs-record-form> (the kit's form, built from
 * describe_record_form and saved with save_record). Every other action is an event the page acts on:
 *   tfs-actor-select  {node_id}                         another actor clicked in a link row
 *   tfs-actor-action  {action, node_id, …}              link | remove | end-link {link} |
 *                                                       open-map {map_id} | country {name} |
 *                                                       stakeholders {name} | retry-profile | close
 *   tfs-actor-saved   {node_id, table}                  an in-place form saved: re-read the map
 *   tfs-map-saved     {map_id}                          the setup form saved
 *   tfs-find          {node_id}                         a name picked in <tfs-map-find>
 *
 * Record text reaches the DOM through textContent / setAttribute only. Pure logic is exported
 * and tested in Node (test/pm-details.test.js).
 */
import { ensurePmCss } from "./pm-css.js";
import { renderHistory, stanceWithValue, relLabel, formatDay } from "./pm-parts.js";
import { shapeD, LINK_KINDS, ACTOR_KINDS, KIND_ORDER, LINK_ORDER, DEFAULT_RING_LABELS } from "./power-map.js";

const Base = globalThis.HTMLElement || class {};
const SVGNS = "http://www.w3.org/2000/svg";

/* ---------------------------------------------------------------- pure helpers */

export function numVal(j) {
  if (!j) return null;
  const v = j.value;
  if (v === null || v === undefined || v === "" || typeof v === "boolean" || Array.isArray(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
export function fmtNum(n) { return Number.isInteger(n) ? String(n) : (Math.round(n * 10) / 10).toFixed(1); }
export function textVal(j) {
  if (!j) return "";
  if (Array.isArray(j.values) && j.values.length) return j.values.map((x) => String(x)).join("; ");
  if (j.value == null) return "";
  return String(j.value);
}
export function relOf(r) {
  const l = r && r.label ? String(r.label) : null;
  if (l === "warm" || l === "known" || l === "none") return l;
  if (l === "owner_only" || l === "owner") return "owner";
  return null;
}
export const STRENGTH = { 1: "weak", 2: "medium", 3: "strong" };
export const KIND_NAME = { person: "Person", organization: "Organisation", seat: "Seat", group: "Group of people", forum: "Forum", country: "Country" };
const human = (s) => { s = String(s || "").replace(/_/g, " ").trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; };
const day = (v) => formatDay(v) || "";

/** Who judged a score, in words: an average of staff ratings, a named judge, AI, or an import. */
export function ratedBy(j) {
  if (!j) return "";
  if (j.aggregate === "mean" && j.judge_count) {
    const vals = (j.judges || []).map((x) => Number(x.value)).filter(Number.isFinite);
    const range = vals.length > 1 ? ` · range ${fmtNum(Math.min(...vals))}–${fmtNum(Math.max(...vals))}` : "";
    return `average of ${j.judges_in_mean || j.judge_count} staff ratings, ${day(j.as_of)}${range}`;
  }
  const who = j.judged_by ? `rated by ${j.judged_by}` : (j.author ? "drafted by AI, confirmed" : "imported");
  return [who, day(j.as_of)].filter(Boolean).join(", ") + (j.review_status === "draft" ? " · draft" : "");
}

/** The value before the current one on this map, from the profile's history, in words. */
export function earlierFor(history, m, j, mapName) {
  if (!Array.isArray(history) || !j) return null;
  const h = history.find((x) => x.measure === m && x.map === mapName && !x.status && x.as_of !== j.as_of);
  if (!h) return null;
  const v = m === "stance" && typeof h.value === "number" ? stanceWithValue(h.value) : String(h.value);
  return `Earlier: ${v}${h.judged_by ? ", rated by " + h.judged_by : ""}, ${day(h.as_of)}`;
}

/** Where an actor's OWN record lives and which of its fields the panel edits: a CRM contact or
 * organisation (saved to the CRM), or a power-map node (a seat, group, forum or country, or a
 * person not in the CRM). Null when there is no row to edit. */
export function ownRecord(a) {
  if (!a) return null;
  if (a.kind === "person" && a.contact_coda_row_id) {
    return { table: "contacts", row: a.contact_coda_row_id, label: "CRM contact",
      fields: "full_name,position,primary_org,employment_status,email,linkedin,pronouns,tfs_contacts" };
  }
  if (a.kind === "organization" && a.organization_coda_row_id) {
    return { table: "organizations", row: a.organization_coda_row_id, label: "CRM organisation",
      fields: "name,website,sector,part_of,relationship_to_tfs" };
  }
  // A CRM person or organisation whose row id did not come back is not editable here: the node
  // form would offer nothing, since the CRM owns their name.
  if ((a.kind === "person" || a.kind === "organization") && a.in_crm !== false) return null;
  if (a.node_id) return { table: "power_map_node", row: "node:" + a.node_id, label: KIND_NAME[a.kind] || "Actor", fields: null };
  return null;
}

/** The "on this map" fields: on a map grouped by country a person's or organisation's countries
 * (their shared "works on" links, several allowed); elsewhere their group on this map. */
export function onMapFields(a, groupBy) {
  const countries = groupBy === "country" && (a.kind === "person" || a.kind === "organization");
  return ["role", countries ? "countries" : "grouping", "owner", "messenger"].join(",");
}

/** The read view of an actor's own record: [label, value] rows, blanks left out. */
export function ownRows(a) {
  const rows = [];
  if (a.kind === "person") {
    rows.push(["Position", a.position], ["Organisation", a.primary_org_name], ["Pronouns", a.pronouns]);
    if (a.in_crm === false) rows.push(["In the CRM", "Not linked to a CRM contact"]);
  } else if (a.kind === "organization") {
    rows.push(["Sector", a.sector], ["Website", a.website], ["Part of", a.part_of_name], ["About", a.description]);
  } else {
    rows.push(["About", a.description]);
  }
  return rows.filter(([, v]) => v != null && String(v).trim() !== "");
}

/** The read view of an actor's place on this map. */
export function onMapRows(a, { groupBy = null, roles = {} } = {}) {
  const rows = [["Role", a.role ? (roles[a.role] || human(a.role)) : "—"]];
  if (groupBy === "country" && (a.kind === "person" || a.kind === "organization")) {
    rows.push(["Countries", Array.isArray(a.countries) && a.countries.length ? a.countries.join(", ") : "—"]);
  } else rows.push(["Group", a.grouping || "—"]);
  rows.push(["Owner", a.owner || "—"], ["Messenger", a.messenger || "—"]);
  return rows;
}

/** The presets for a new judgement on this map: the map, the actor, today, the measure. */
export function judgementPresets(map, a, measure, today) {
  const p = { map: { row_id: map.id, label: map.name }, actor: { row_id: "node:" + a.node_id, label: a.name }, as_of: today };
  if (measure) p.measure = measure;
  return p;
}

/** Map setup in words, for the read view. `measures` is the shared vocabulary: [{value, label,
 * numeric?, scale?, description?}]. Returns sections of [label, value] rows. */
export function setupRows(map, { measures = [], kinds = {}, actors = [], links = [] } = {}) {
  const mlabel = (k) => { const m = measures.find((x) => x.value === k); return m ? m.label : human(k); };
  const about = [
    ["Kind", map.kind ? ((kinds[map.kind] && kinds[map.kind].label) || human(map.kind)) : "—"],
    ["Objective", map.objective || "—"],
    ["Team", map.team_label || "—"],
    ["Owner", map.owner_name || "—"],   // never the raw row id
    ["Status", human(map.status || "active")],
  ];
  if (map.parent_name) about.push(["Part of", map.parent_name]);
  for (const [k, lab] of [["project_name", "Project"], ["workstream_name", "Workstream"], ["event_name", "Event"]]) if (map[k]) about.push([lab, map[k]]);
  const scores = (map.measures || []).map((k) => {
    const m = measures.find((x) => x.value === k) || {};
    const scale = m.scale || (k === "stance" ? "−2 to +2" : m.numeric ? "1 to 5" : "words");
    return [m.label || human(k), [scale, m.description].filter(Boolean).join(" · ")];
  });
  const drawing = [
    // Unset: the drawing's own rule — power and stance when the map scores them, else the same
    // for everyone (never name a score the map does not have).
    ["Size of each shape", map.size_measure === "none" ? "Same for everyone" : map.size_measure ? mlabel(map.size_measure)
      : (map.measures || []).includes("power") ? `${mlabel("power")} (the default)` : "Same for everyone (the default)"],
    ["Colour of each shape", map.colour_measure === "none" ? "Same for everyone" : map.colour_measure ? mlabel(map.colour_measure)
      : (map.measures || []).includes("stance") ? `${mlabel("stance")} (the default)` : "Same for everyone (the default)"],
    ["Group people by", { role: "Role on this map", country: "Country", group: "Group" }[map.group_by] || "Decided from the people on it"],
  ];
  const rl = Array.isArray(map.ring_labels) && map.ring_labels.length === 3 ? map.ring_labels : DEFAULT_RING_LABELS;
  drawing.push(["Ring names", rl.join(" · ")]);
  const live = actors.filter((a) => a && a.status !== "removed" && !a.removed);
  const kindCount = {};
  for (const a of live) kindCount[a.kind] = (kindCount[a.kind] || 0) + 1;
  const shapes = KIND_ORDER.filter((k) => kindCount[k]).map((k) => [ACTOR_KINDS[k].label, String(kindCount[k])]);
  const lineCount = {};
  for (const l of links) if (LINK_KINDS[l.kind]) lineCount[l.kind] = (lineCount[l.kind] || 0) + 1;
  const lines = LINK_ORDER.filter((k) => lineCount[k]).map((k) => [LINK_KINDS[k].label, String(lineCount[k])]);
  return { about, scores, drawing, shapes, lines };
}

/** Names on a map matching what was typed: starts-with first, then contains; at most `limit`. */
export function findMatches(actors, q, limit = 8) {
  const s = String(q || "").trim().toLowerCase();
  if (!s) return [];
  const live = actors.filter((a) => a && a.name && a.status !== "removed" && !a.removed);
  const starts = [], has = [];
  for (const a of live) {
    const n = String(a.name).toLowerCase();
    if (n.startsWith(s) || n.split(/\s+/).some((w) => w.startsWith(s))) starts.push(a);
    else if (n.includes(s)) has.push(a);
  }
  const by = (x, y) => String(x.name).localeCompare(String(y.name));
  return starts.sort(by).concat(has.sort(by)).slice(0, limit);
}

/* ---------------------------------------------------------------- DOM helpers */

function el(tag, attrs = {}, ...kids) {
  const n = globalThis.document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "text") n.textContent = String(v);
    else if (k === "class") n.className = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) n.append(c.nodeType ? c : String(c));
  return n;
}
function shapeIcon(kind, size = 14) {
  const s = globalThis.document.createElementNS(SVGNS, "svg");
  s.setAttribute("width", size); s.setAttribute("height", size); s.setAttribute("viewBox", "-10 -10 20 20"); s.setAttribute("aria-hidden", "true");
  const p = globalThis.document.createElementNS(SVGNS, "path");
  p.setAttribute("d", shapeD(kind, 8)); p.setAttribute("class", "shp" + (kind === "forum" ? " forum" : ""));
  s.append(p);
  return s;
}
const PENCIL = "M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4";
function icon(d, size = 14) {
  const s = globalThis.document.createElementNS(SVGNS, "svg");
  s.setAttribute("width", size); s.setAttribute("height", size); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true");
  s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor"); s.setAttribute("stroke-width", "2.2"); s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
  const p = globalThis.document.createElementNS(SVGNS, "path"); p.setAttribute("d", d); s.append(p);
  return s;
}
function section(o, ...body) {
  const s = el("tfs-section", { heading: o.heading, "kind-table": o.table || null, "kind-label": o.label || null,
    key: o.key || null, count: o.count != null && o.count !== "" ? String(o.count) : null, open: o.open === false ? null : true, info: o.info || null });
  for (const b of body.flat(Infinity)) if (b) s.append(b);
  return s;
}
const STANCE_BG = { "-2": "bgm2", "-1": "bgm1", 0: "bg0", 1: "bg1", 2: "bg2" };
function stanceChip(v) {
  if (v == null) return el("span", { class: "vchip" }, el("i", { class: "bg0" }), "—");
  const r = Math.max(-2, Math.min(2, Math.round(v)));
  return el("span", { class: "vchip" }, el("i", { class: STANCE_BG[r] }), stanceWithValue(v).replace(/[()]/g, ""));
}
function today() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }

const INFO_KNOWS = "Worked out from meetings logged in the KMS and shared calendars — never typed in. | Met in the last year · Met, over a year ago · Only a TFS owner · No meeting logged. | “No meeting logged” is not “nobody knows them”.";

/* ---------------------------------------------------------------- K7 <tfs-actor-details> */

export class TfsActorDetails extends Base {
  constructor() { super(); this._actor = null; this._profile = null; this._ctx = {}; this._editing = null; }
  get actor() { return this._actor; }
  set actor(v) {
    const same = v && this._actor && v.node_id === this._actor.node_id;
    this._actor = v || null;
    if (!same) this._editing = null;
    this._render();
  }
  get profile() { return this._profile; }
  set profile(v) { this._profile = v || null; this._render(); }
  /** {map: {id, name, measures, group_by}, labels: {measures, roles, linkKinds, bases}, editable,
   *  onMap(node_id) → bool, stakeCount, profileError, groupBy} */
  get context() { return this._ctx; }
  set context(v) { this._ctx = v || {}; this._render(); }

  connectedCallback() { ensurePmCss(this.ownerDocument); this._render(); }

  _emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true })); }
  _act(action, extra = {}) { this._emit("tfs-actor-action", { action, node_id: this._actor && this._actor.node_id, ...extra }); }
  /** Open or close one form in place. Drawn directly: the guard in _render() is for redraws
   * from outside (a new profile, a refreshed map), never for the person's own click. */
  _edit(what) { this._editing = this._editing === what ? null : what; this._draw(); }
  _draw() {
    const a = this._actor;
    if (!a) return this._render();
    this._stale = false;
    this.replaceChildren(this._head(a), ...this._sections(a));
  }

  _render() {
    if (!this.isConnected || !globalThis.document) return;
    const a = this._actor;
    if (!a) {
      this.replaceChildren(el("div", { class: "dempty" }, el("b", { style: "color:var(--ink)", text: "Nobody selected" }),
        el("span", { text: "Click anyone — on the map, in the list or on a card — to see where they stand, who at TFS knows them and what has been logged." })));
      return;
    }
    // While a form is open nothing redraws: moving a <tfs-record-form> disconnects it, and a
    // reconnected form drew empty (live walk 2026-10-15: the profile arriving a second after the
    // click redrew the panel under the open form). The panel catches up when the form closes.
    if (this._editing && this.querySelector(`[data-edit="${this._editing}"] tfs-record-form`)) { this._stale = true; return; }
    this._draw();
  }

  _head(a) {
    const c = this._ctx;
    const h = el("div", { class: "dhead" });
    h.append(el("div", { class: "top" }, el("span", { class: "kindlab" }, shapeIcon(a.kind, 14), KIND_NAME[a.kind] || human(a.kind)),
      el("tfs-kind", { table: "power_map_actor", label: "Actor" }),
      el("button", { type: "button", class: "xbtn x", "aria-label": "Close details", title: "Close details", onclick: () => this._act("close") }, icon("M6 6l12 12M18 6L6 18", 16))));
    h.append(el("div", { class: "nm", text: a.name || "" }));
    const sub = [a.position, a.primary_org_name].filter(Boolean).join(" · ");
    if (sub) h.append(el("div", { class: "r", text: sub }));
    const src = a._source && /\((https?:[^)]+)\)/.exec(String(a._source));
    if (src) h.append(el("div", {}, el("a", { class: "linkbtn", style: "font-size:13px;text-decoration:none", href: src[1], target: "_blank", rel: "noopener noreferrer", text: "Open in the CRM ↗" })));
    const cs = Array.isArray(a.countries) ? a.countries : [];
    if (cs.length) {
      h.append(el("div", { class: "cchips", "aria-label": "Countries they work on" }, cs.map((n) => el("a", { class: "cchip", href: "#", title: `${n} on the countries map`,
        onclick: (e) => { e.preventDefault(); this._act("country", { name: n }); } }, shapeIcon("country", 12), n))));
    }
    if (a.kind === "country") {
      const n = c.stakeCount;
      h.append(el("button", { type: "button", class: "btn stake", onclick: () => this._act("stakeholders", { name: a.name }) },
        el("span", { text: `Stakeholders in ${a.name}` + (typeof n === "number" ? ` (${n})` : "") }), icon("M5 12h14M13 6l6 6-6 6", 16)));
    }
    if (c.editable) {
      h.append(el("div", { class: "acts" },
        el("button", { type: "button", class: "btn-2", style: "min-height:34px", title: "Draw a link from them to someone else on this map", onclick: () => this._act("link") }, icon("M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1", 15), "Link to…"),
        el("button", { type: "button", class: "btn-2", style: "min-height:34px;color:var(--bad)", title: "Take them off this map. Nothing is deleted; they can be put back.", onclick: () => this._act("remove"), text: "Remove from map" })));
    }
    return h;
  }

  /** A read view of [label, value] rows; for an editor each row is a button that opens the form. */
  _rows(rows, what, readOnly = false) {
    const box = el("div", { class: "frows" });
    for (const [k, v] of rows) {
      const val = el("span", { class: "fv", text: v == null || v === "" ? "—" : String(v) });
      if (this._ctx.editable && !readOnly) {
        box.append(el("button", { type: "button", class: "frow edit", title: `Edit ${k.toLowerCase()}`, "aria-label": `${k}: ${v || "not set"} — edit`, onclick: () => this._edit(what) },
          el("span", { class: "fk", text: k }), val, el("span", { class: "pen", "aria-hidden": "true" }, icon(PENCIL, 13))));
      } else box.append(el("div", { class: "frow" }, el("span", { class: "fk", text: k }), val));
    }
    return box;
  }

  /** The kit's own form, inline, closing back to the read view; a save tells the page to re-read. */
  _form(what, attrs) {
    const f = el("tfs-record-form", attrs);
    f.addEventListener("tfs-close", (e) => { e.stopPropagation(); this._editing = null; this._draw(); });
    f.addEventListener("tfs-saved", () => {
      this._emit("tfs-actor-saved", { node_id: this._actor && this._actor.node_id, table: attrs.table });
      setTimeout(() => { if (this._editing === what) { this._editing = null; this._draw(); } }, 900);
    });
    return el("div", { class: "inform", "data-edit": what }, f);
  }

  _sections(a) {
    const c = this._ctx, p = this._profile, have = !!(p && !p.missing);
    const labels = c.labels || {}, map = c.map || {};
    const out = [];
    // AI suggestions waiting for an editor
    const sugg = [];
    for (const s of (p && Array.isArray(p.suggestions) ? p.suggestions : (a.suggestions || []))) sugg.push({ type: "judgement", ...s });
    for (const l of (have && Array.isArray(p.links) ? p.links.filter((x) => x.ai_unconfirmed) : [])) sugg.push({ type: "link", ...l });
    if (sugg.length) out.push(section({ heading: "Suggested, not yet confirmed", table: "power_map_judgement", label: "AI-drafted", key: "sugg", count: sugg.length }, sugg.map((s) => this._sugg(a, s))));

    // Their own record (the CRM, or the node itself)
    const own = ownRecord(a);
    const ownBody = this._editing === "own" && own
      ? this._form("own", { table: own.table, mode: "edit", row: own.row, fields: own.fields, heading: `Edit ${a.name || ""}`, "save-label": "Save" })
      : [own ? this._rows(ownRows(a).length ? ownRows(a) : [["Details", "Nothing recorded yet"]], "own") : this._rows(ownRows(a), "own", true),
        own && own.table !== "power_map_node" ? el("div", { class: "quiet fnote", text: `Saved to the ${own.table === "contacts" ? "CRM contact" : "CRM organisation"}: every map and every TFS tool sees the change.` }) : null];
    out.push(section({ heading: own && own.table !== "power_map_node" ? "Details" : "About", table: own ? own.table : "power_map_node", label: own ? own.label : null, key: "own" }, ownBody));

    // Their place on this map
    const onBody = this._editing === "onmap"
      ? this._form("onmap", { table: "power_map_actor", mode: "edit", row: `${map.id}:${a.node_id}`, fields: onMapFields(a, c.groupBy), heading: `${a.name || ""} on this map`, "save-label": "Save" })
      : [this._rows(onMapRows(a, { groupBy: c.groupBy, roles: labels.roles || {} }), "onmap"),
        c.groupBy === "country" && (a.kind === "person" || a.kind === "organization") ? el("div", { class: "quiet fnote", text: "Countries are their “works on” links, shared by every map." }) : null];
    out.push(section({ heading: "On this map", table: "power_map_actor", label: "Actor", key: "onmap" }, onBody));

    // Scores
    out.push(section({ heading: "Scores on this map", table: "power_map_judgement", label: "Judgement", key: "scores" }, this._scores(a, p)));
    if (a.kind === "person" || a.kind === "organization") out.push(section({ heading: "Who at TFS knows them", table: "power_map_judgement", label: "Computed", key: "knows", info: INFO_KNOWS }, this._knows(a, p)));
    const pending = this._pending(a, p);
    const links = have && Array.isArray(p.links) ? p.links.filter((l) => !l.ai_unconfirmed && (!l.valid_to || String(l.valid_to) >= today())) : [];
    out.push(section({ heading: "Links", table: "power_map_link", label: "Link", key: "links", count: have ? links.length : null }, pending ? [pending] : this._links(a, links)));
    if (a.kind === "person" || (have && Array.isArray(p.recent_entries) && p.recent_entries.length)) {
      const ents = (have && p.recent_entries) || [];
      out.push(section({ heading: "KMS entries", table: "kms_entries", label: "KMS entry", key: "kms", count: have ? ents.length : null }, pending ? [pending] : this._kms(ents)));
    }
    const others = have && Array.isArray(p.maps) ? p.maps.filter((x) => x.map_id !== map.id) : [];
    out.push(section({ heading: "Shown on other maps", table: "power_map", label: "Map", key: "maps", count: have ? others.length : (a.other_map_count != null ? a.other_map_count : null), open: false }, pending ? [pending] : this._others(others)));
    const hist = (have && p.history) || [];
    const hbox = el("div");
    if (pending) hbox.append(pending.cloneNode(true));
    else {
      renderHistory(hbox, hist, { measures: labels.measures || {} }, { currentMap: map.name });
      if (p.history_truncated) hbox.append(el("div", { class: "quiet", text: "The newest 100 entries are shown." }));
    }
    out.push(section({ heading: "History", table: "power_map_judgement", label: "History", key: "history", count: have ? `${hist.length}${p.history_truncated ? "+" : ""} ${hist.length === 1 ? "entry" : "entries"}` : null }, hbox));
    return out;
  }

  _pending(a, p) {
    if (p && !p.missing) return null;
    const e = this._ctx.profileError;
    if (e) return el("div", { class: "quiet" }, "Couldn’t load the rest. ", el("button", { type: "button", class: "linkbtn", onclick: () => this._act("retry-profile"), text: "Try again" }));
    if (p && p.missing) return el("div", { class: "quiet", text: "Nothing more is recorded for this actor." });
    return el("div", { class: "quiet" }, el("span", { class: "spin sm", "aria-hidden": "true", style: "vertical-align:-2px;margin-right:6px" }), "Loading…");
  }

  _sugg(a, s) {
    const lk = (this._ctx.labels || {}).linkKinds || {}, ml = (this._ctx.labels || {}).measures || {};
    let text;
    if (s.type === "link") {
      const other = (s.other && s.other.name) || "another actor";
      text = s.direction === "in" ? `${other} → ${lk[s.kind] || human(s.kind)} → ${a.name}` : `${a.name} → ${lk[s.kind] || human(s.kind)} → ${other}`;
    } else {
      const n = numVal(s);
      text = `${ml[s.measure] || human(s.measure)} → ${s.measure === "stance" && n !== null ? stanceWithValue(n) : n !== null ? fmtNum(n) : `“${String(s.value || "")}”`}`;
    }
    const from = s.evidence && s.evidence.type ? (/kms/i.test(s.evidence.type) ? " from a KMS entry" : " from " + human(s.evidence.type).toLowerCase()) : "";
    const row = el("div", { class: "row" });
    if (this._ctx.editable && s.id) {
      row.append(el("tfs-status-menu", { table: s.type === "link" ? "power_map_link" : "power_map_judgement", field: "agent_status", row: s.id, value: "pending" }),
        el("span", { class: "quiet", text: "Not counted until confirmed" }));
    } else row.append(el("span", { class: "quiet", text: "Waiting for an editor to confirm." }));
    return el("div", { class: "sugg" }, el("div", {}, el("span", { class: "ktag draft", text: s.type === "link" ? "Link" : "Score" }), " ", el("b", { text })),
      el("div", { class: "why", text: `Drafted by AI${from}${s.as_of || s.valid_from ? ", " + day(s.as_of || s.valid_from) : ""}.` }), row);
  }

  _scores(a, p) {
    const c = this._ctx, map = c.map || {}, ml = (c.labels || {}).measures || {};
    const ms = Array.isArray(map.measures) && map.measures.length ? map.measures : Object.keys(a.judgements || {});
    const box = el("div");
    if (!ms.length) box.append(el("div", { class: "quiet", text: "This map scores nothing yet. An editor can add scores in Map setup." }));
    for (const m of ms) {
      const j = a.judgements ? a.judgements[m] || null : null;
      const n = numVal(j);
      const v = !j ? el("span", { class: "v dash", text: "—" })
        : m === "stance" && n !== null ? el("span", { class: "v" }, stanceChip(n))
        : n !== null ? el("span", { class: "v", text: (m === "power" || m === "movability") ? `${fmtNum(n)} / 5` : fmtNum(n) })
        : el("span", { class: "v txt", text: textVal(j) });
      const right = el("span", {}, v);
      if (j) {
        right.append(el("span", { class: "sub", text: ratedBy(j) }));
        const e = earlierFor(p && p.history, m, j, map.name); if (e) right.append(el("span", { class: "sub", text: e }));
      }
      const what = "score:" + m;
      const label = ml[m] || human(m);
      if (c.editable) {
        box.append(el("button", { type: "button", class: "jrow edit", title: `Add a new ${label.toLowerCase()} judgement — the current one stays in History`,
          "aria-label": `${label}: ${j ? textVal(j) || "—" : "not scored"} — add a new judgement`, onclick: () => this._edit(what) },
          el("span", { class: "k", text: label }), right, el("span", { class: "pen", "aria-hidden": "true" }, icon(PENCIL, 13))));
        if (this._editing === what) {
          const form = this._form(what, { table: "power_map_judgement", mode: "create", fields: n !== null || (m === "power" || m === "stance" || m === "movability") ? "value_num,note" : "value_text,note",
            heading: `New ${label.toLowerCase()} judgement`, "save-label": "Save" });
          form.firstChild.setAttribute("presets", JSON.stringify(judgementPresets(map, a, m, today())));
          box.append(form);
        }
      } else box.append(el("div", { class: "jrow" }, el("span", { class: "k", text: label }), right));
    }
    return box;
  }

  _knows(a, p) {
    const r = (p && p.relationship) || a.relationship || null;
    const k = relOf(r);
    if (!r || !k) return [el("div", { class: "quiet", text: a.kind === "person" && a.in_crm === false ? "Not linked to a CRM contact, so nothing is worked out." : "Nothing is worked out for this actor." })];
    const kids = [el("div", { class: "relbox" }, el("span", { class: "rel " + k }, el("i")), relLabel(k === "owner" ? "owner_only" : k),
      r.last_met ? el("span", { class: "quiet", style: "font-weight:500", text: "last met " + day(r.last_met) }) : null)];
    const staff = Array.isArray(r.staff) ? r.staff.slice(0, 3) : [];
    if (staff.length) kids.push(el("div", { class: "staff" }, staff.map((s) => el("span", {}, el("b", { text: s.name }), s.logged_only ? " · logged it" : " · met them" + (s.last_met ? " · " + day(s.last_met) : "")))));
    const total = r.staff_count != null ? r.staff_count : (r.staff || []).length;
    if (total > staff.length) kids.push(el("div", { class: "quiet", text: `and ${total - staff.length} more` }));
    if (r.next_meeting) kids.push(el("div", { class: "quiet", text: "Next meeting " + day(r.next_meeting.date || r.next_meeting) }));
    return kids;
  }

  _links(a, links) {
    const c = this._ctx, lk = (c.labels || {}).linkKinds || {}, bases = (c.labels || {}).bases || {};
    const kids = [];
    const out = links.filter((l) => l.direction === "out"), inn = links.filter((l) => l.direction === "in");
    const short = String(a.name || "").split(/\s+/)[0];
    const researched = (l) => /research/i.test(String(l.source || l.note || ""));
    const meta = (l) => {
      const words = [STRENGTH[l.strength], l.basis ? (bases[l.basis] || human(l.basis)).toLowerCase() : ""].filter(Boolean).join(" · ");
      const m = el("span", { class: "meta" });
      if (researched(l)) m.append(el("span", { class: "ktag", style: "background:var(--res-soft);color:var(--res)", text: "Researched" }));
      if (words) m.append(el("span", { class: "basis", text: words }));
      if (c.editable && l.id) m.append(el("button", { type: "button", class: "quietbtn", title: "End this link today. It stays in History.", onclick: () => this._act("end-link", { link: l }), text: "End" }));
      return m;
    };
    const other = (l) => {
      const o = l.other || {};
      return c.onMap && c.onMap(o.node_id) ? el("button", { type: "button", class: "linkbtn", onclick: () => this._emit("tfs-actor-select", { node_id: o.node_id }), text: o.name || "" })
        : el("span", { text: (o.name || "") + " (not on this map)" });
    };
    if (out.length) {
      kids.push(el("div", { class: "lgrp", text: `Out — ${short} →` }));
      for (const l of out) kids.push(el("div", { class: "lrow" }, el("span", { class: "kd", text: "→ " + (lk[l.kind] || human(l.kind)) }), el("span", { text: "·" }), other(l), meta(l)));
    }
    if (inn.length) {
      kids.push(el("div", { class: "lgrp", text: `In — → ${short}` }));
      for (const l of inn) kids.push(el("div", { class: "lrow" }, other(l), el("span", { text: "·" }), el("span", { class: "kd", text: (lk[l.kind] || human(l.kind)) + " →" }), meta(l)));
    }
    if (!out.length && !inn.length) kids.push(el("div", { class: "quiet", text: "No links recorded yet." }));
    if (links.some(researched)) kids.push(el("span", { class: "quiet", text: "Links marked Researched come from public sources, each with its source, not from staff." }));
    if (c.editable) kids.push(el("button", { type: "button", class: "linkbtn", style: "font-size:13px;align-self:flex-start", onclick: () => this._act("link"), text: "+ Link to…" }));
    return kids;
  }

  _kms(ents) {
    if (!ents.length) return [el("div", { class: "quiet", text: "No KMS entries you can see mention them." })];
    return ents.map((e) => el("button", { type: "button", class: "kms", onclick: () => this._peek(e) },
      el("b", { text: e.title || "Untitled entry" }),
      el("small", { text: [day(e.date), e.type_name, e.logged_by ? "logged by " + e.logged_by : ""].filter(Boolean).join(" · ") })));
  }
  _peek(e) {
    const href = e._source && /\((https?:[^)]+)\)/.exec(String(e._source));
    if (!e.coda_row_id) { if (href) globalThis.open(href[1], "_blank", "noopener"); return; }
    const old = this.querySelector("tfs-record-peek"); if (old) old.remove();
    const pk = el("tfs-record-peek", { table: "kms_entries", row: e.coda_row_id, source: href ? href[1] : null, editable: this._ctx.editable ? true : null });
    pk.addEventListener("tfs-close", () => setTimeout(() => pk.remove(), 0));
    this.append(pk);
  }
  _others(others) {
    const ml = (this._ctx.labels || {}).measures || {}, roles = (this._ctx.labels || {}).roles || {};
    if (!others.length) return [el("div", { class: "quiet", text: "Only on this map." })];
    return others.map((mp) => {
      const bits = [];
      if (mp.role) bits.push(roles[mp.role] || human(mp.role));
      for (const [k, j] of Object.entries(mp.judgements || {}).slice(0, 3)) {
        const n = numVal(j);
        if (n !== null) bits.push(`${(ml[k] || human(k)).toLowerCase()} ${k === "stance" ? stanceWithValue(n) : fmtNum(n)}`);
      }
      if (mp.removed_from_map) bits.push("removed from that map");
      if (mp.status === "archived") bits.push("map archived");
      return el("button", { type: "button", class: "omap", onclick: () => this._act("open-map", { map_id: mp.map_id }) }, el("b", { text: mp.map_name || "" }), el("small", { text: bits.join(" · ") }));
    });
  }
}

/* ---------------------------------------------------------------- K8 <tfs-map-setup> */

export class TfsMapSetup extends Base {
  constructor() { super(); this._map = null; this._ctx = {}; this._editing = false; }
  /** The map object from get_power_map (plus anything from its search_power_maps row). */
  get map() { return this._map; }
  set map(v) { this._map = v || null; this._render(); }
  /** {measures: [{value, label, numeric?, scale?, description?}], kinds: {value: {label}},
   *  actors, links, editable} */
  get context() { return this._ctx; }
  set context(v) { this._ctx = v || {}; this._render(); }
  connectedCallback() { ensurePmCss(this.ownerDocument); this._render(); }
  _emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true })); }

  _render() {
    if (!this.isConnected || !globalThis.document) return;
    const m = this._map;
    if (!m) { this.replaceChildren(); return; }
    const c = this._ctx;
    const head = el("div", { class: "setuphead" }, el("h2", { text: "Map setup" }),
      c.editable && !this._editing ? el("button", { type: "button", class: "btn-2", style: "min-height:34px", onclick: () => { this._editing = true; this._render(); } }, icon(PENCIL, 14), "Edit setup") : null,
      el("button", { type: "button", class: "xbtn", "aria-label": "Close map setup", title: "Close map setup", onclick: () => this._emit("tfs-close", {}) }, icon("M6 6l12 12M18 6L6 18", 16)));
    if (this._editing) {
      const f = el("tfs-record-form", { table: "power_map", mode: "edit", row: m.id, heading: `Set up “${m.name || ""}”`, "save-label": "Save setup",
        fields: "name,short_name,kind,status,objective,team_label,owner,parent,workstream,project,event,measures,size_measure,colour_measure,group_by,ring_1_label,ring_2_label,ring_3_label" });
      f.addEventListener("tfs-close", (e) => { e.stopPropagation(); this._editing = false; this._render(); });
      f.addEventListener("tfs-saved", () => { this._emit("tfs-map-saved", { map_id: m.id }); setTimeout(() => { this._editing = false; this._render(); }, 900); });
      this.replaceChildren(head, f);
      return;
    }
    const r = setupRows(m, { measures: c.measures || [], kinds: c.kinds || {}, actors: c.actors || [], links: c.links || [] });
    const rows = (list) => el("div", { class: "frows" }, list.map(([k, v]) => el("div", { class: "frow" }, el("span", { class: "fk", text: k }), el("span", { class: "fv", text: v || "—" }))));
    const kids = [head];
    kids.push(section({ heading: "About this map", table: "power_map", label: "Map", key: "setup-about" }, rows(r.about),
      Array.isArray(m.children) && m.children.length ? el("div", { class: "kids" }, el("div", { class: "fk", text: "Maps under this one" }),
        m.children.map((ch) => el("button", { type: "button", class: "omap", onclick: () => this._emit("tfs-map-open", { map_id: ch.id }) },
          el("b", { text: ch.name || "" }), el("small", { text: ch.actor_count != null ? `${ch.actor_count} ${ch.actor_count === 1 ? "actor" : "actors"}` : "" })))) : null,
      m.parent_map_id ? el("button", { type: "button", class: "linkbtn", style: "font-size:13px", onclick: () => this._emit("tfs-map-open", { map_id: m.parent_map_id }), text: `Open the parent map: ${m.parent_name || ""}` }) : null));
    kids.push(section({ heading: "Scores", table: "power_map_measure", label: "Measure", key: "setup-scores", count: r.scores.length },
      r.scores.length ? rows(r.scores) : el("div", { class: "quiet", text: "This map scores nothing yet." })));
    kids.push(section({ heading: "How it is drawn", table: "power_map", label: "Map", key: "setup-draw" }, rows(r.drawing)));
    kids.push(section({ heading: "What is on it", table: "power_map_actor", label: "Actor", key: "setup-on" },
      r.shapes.length ? el("div", { class: "frows" }, r.shapes.map(([k, v]) => el("div", { class: "frow" }, el("span", { class: "fk" }, shapeIcon(Object.keys(ACTOR_KINDS).find((x) => ACTOR_KINDS[x].label === k) || "person", 13), " ", k), el("span", { class: "fv", text: v })))) : el("div", { class: "quiet", text: "Nobody yet." }),
      r.lines.length ? el("div", { class: "frows" }, el("div", { class: "fk", style: "margin-top:6px", text: "Links" }), r.lines.map(([k, v]) => el("div", { class: "frow" }, el("span", { class: "fk", text: k }), el("span", { class: "fv", text: v })))) : el("div", { class: "quiet", text: "No links between them yet." })));
    this.replaceChildren(...kids);
  }
}

/* ---------------------------------------------------------------- K9 <tfs-map-find> */

let findSeq = 0;
export class TfsMapFind extends Base {
  constructor() { super(); this._actors = []; this._hits = []; this._active = -1; this._id = "tfs-find-" + (++findSeq); }
  get actors() { return this._actors; }
  set actors(v) { this._actors = Array.isArray(v) ? v : []; }
  connectedCallback() {
    ensurePmCss(this.ownerDocument);
    if (this._built) return;
    this._built = true;
    this.classList.add("mapfind");
    const lab = el("label", { for: this._id + "-q", class: "sr", text: "Find someone on this map" });
    this._q = el("input", { id: this._id + "-q", class: "input", type: "search", autocomplete: "off", placeholder: "Find on this map", role: "combobox",
      "aria-expanded": "false", "aria-controls": this._id + "-l", "aria-autocomplete": "list" });
    this._list = el("ul", { id: this._id + "-l", class: "findlist", role: "listbox", hidden: true });
    this._q.addEventListener("input", () => this._update());
    this._q.addEventListener("keydown", (e) => this._key(e));
    this._q.addEventListener("blur", () => setTimeout(() => this._close(), 150));
    this.append(lab, icon("M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14M20 20l-3.5-3.5", 15), this._q, this._list);
  }
  _update() {
    this._hits = findMatches(this._actors, this._q.value);
    this._active = this._hits.length ? 0 : -1;
    this._paint();
  }
  _paint() {
    const open = this._q.value.trim() !== "";
    this._list.hidden = !open;
    this._q.setAttribute("aria-expanded", String(open));
    if (!open) return;
    const items = this._hits.map((a, i) => el("li", { role: "option", id: `${this._id}-o${i}`, "aria-selected": String(i === this._active), class: i === this._active ? "on" : null,
      onmousedown: (e) => { e.preventDefault(); this._pick(a); } }, shapeIcon(a.kind, 13), el("span", { text: a.name || "" }),
      a.primary_org_name ? el("small", { text: a.primary_org_name }) : null));
    this._list.replaceChildren(...(items.length ? items : [el("li", { class: "none", text: "Nobody on this map by that name" })]));
    if (this._active >= 0) this._q.setAttribute("aria-activedescendant", `${this._id}-o${this._active}`); else this._q.removeAttribute("aria-activedescendant");
  }
  _key(e) {
    if (e.key === "ArrowDown" && this._hits.length) { e.preventDefault(); this._active = (this._active + 1) % this._hits.length; this._paint(); }
    else if (e.key === "ArrowUp" && this._hits.length) { e.preventDefault(); this._active = (this._active - 1 + this._hits.length) % this._hits.length; this._paint(); }
    else if (e.key === "Enter" && this._active >= 0) { e.preventDefault(); this._pick(this._hits[this._active]); }
    else if (e.key === "Escape") { this._q.value = ""; this._close(); }
  }
  _close() { this._list.hidden = true; this._q.setAttribute("aria-expanded", "false"); }
  _pick(a) {
    this._q.value = a.name || "";
    this._close();
    this.dispatchEvent(new CustomEvent("tfs-find", { detail: { node_id: a.node_id }, bubbles: true, composed: true }));
  }
}

if (globalThis.customElements) {
  for (const [name, cls] of [["tfs-actor-details", TfsActorDetails], ["tfs-map-setup", TfsMapSetup], ["tfs-map-find", TfsMapFind]]) {
    if (!globalThis.customElements.get(name)) globalThis.customElements.define(name, cls);
  }
}
