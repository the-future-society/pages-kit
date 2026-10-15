/* TFS pages kit — power-map people: <tfs-map-people> (K2) and <tfs-quick-contact> (K3).
 *
 *   <tfs-map-people map="<map id>" map-name="EU crisis coordination" editable></tfs-map-people>
 *     el.onMap = new Set(["<node id>", "node:<node id>", "contact:i-…", "i-…"]);   // who is on it now
 *   <tfs-quick-contact name="Lucía Ferraro" editable></tfs-quick-contact>
 *
 * K2 is the "Add people to this map" drawer (design screens 19-21, DESIGN-BRIEF §4.3):
 *   - SEARCH BY NAME: type-ahead over `search_records_for_picker(entity_type "power_map_actor")`.
 *     Each match shows its shape (person circle, organisation rounded square, seat shield, group
 *     three circles, forum diamond, country hexagon), its name, one hint line, and "Already on
 *     this map" (disabled) or "On N other maps". Enter or a click ADDS AT ONCE with the name only
 *     (`save_record(power_map_actor, create, {map, actor})`); the added row then offers role /
 *     power / stance, all optional. The last item is always "Add 'typed' as a new contact",
 *     which opens K3 in place.
 *   - BROWSE AN ORGANISATION: pick an organisation, list `get_org_contacts(org, include_sub_orgs
 *     true, limit 200)` grouped by sub-organisation (nested by Part of, collapsible), tick
 *     people, "Add N selected". Saves run ONE AT A TIME, each with its own idempotency key; the
 *     progress line reads "Adding N… n added", then "n of N added"; a failure names the person
 *     and quotes the server; the others still land.
 *   - Power and stance save as NEW `power_map_judgement` rows (as_of today, this map): a
 *     judgement is never edited, so picking a different value adds another. Role is an edit of
 *     the member row (`<map>:<node>`).
 *   Events (bubble, composed): `tfs-map-people-added` {node_id, actor_id, label} per person
 *   added; `tfs-map-people-removed` {node_id, label} and `tfs-map-people-restored` {node_id,
 *   label} for the × on an added row and its Undo; `tfs-map-people-done` {added: n} on Done/×.
 *
 * K3 is the quick-add contact form (screens 22-23), built on <tfs-record-form table="contacts"
 * mode="create">. It states the either/or rule (an organisation, or Independent / self-employed
 * / Retired), offers "+ New organisation" inline (name + sector, both required; the sector
 * choices are the server's), and turns an exact-name duplicate refusal into the existing record
 * with "Use this one". Events: `tfs-contact-ready` {contact_id, label} (saved, or Use this
 * one); `tfs-quick-contact-cancel` (Back to search / Cancel).
 *
 * `removeActor(mapId, nodeId)` / `restoreActor(mapId, nodeId)` are the page's undo-toast
 * helpers: one status edit each (preview then save, fresh key), resolving `{outcome: "saved" |
 * "refused" | "unknown", message, receipt}`. Nothing is ever deleted.
 *
 * Every record value reaches the DOM through textContent / setAttribute only. No identifier
 * is ever shown. All logic a test can reach is exported as pure functions.
 */
import { SaveMachine } from "./save.js";
import { transportOf } from "./form.js";
import { ensurePmCss } from "./pm-css.js";

const Base = globalThis.HTMLElement || class {};
const SVG_NS = "http://www.w3.org/2000/svg";

/* ===========================================================================
   Pure logic (Node-tested)
   ========================================================================= */

/** The six actor shapes, in a `-10 -10 20 20` box (the design's `SHAPE`, verbatim). */
export const SHAPES = {
  person: "M-8,0 a8,8 0 1,0 16,0 a8,8 0 1,0 -16,0",
  organization: "M-4.95,-6.88 H4.95 Q6.88,-6.88 6.88,-4.95 V4.95 Q6.88,6.88 4.95,6.88 H-4.95 Q-6.88,6.88 -6.88,4.95 V-4.95 Q-6.88,-6.88 -4.95,-6.88 Z",
  seat: "M-7.6,-6.23 L7.6,-6.23 L7.6,2.13 L0,7.98 L-7.6,2.13 Z",
  group: "M-4.48,-3.36 a4.48,4.48 0 1,0 8.96,0 a4.48,4.48 0 1,0 -8.96,0 M-8.32,2.88 a4.48,4.48 0 1,0 8.96,0 a4.48,4.48 0 1,0 -8.96,0 M-0.64,2.88 a4.48,4.48 0 1,0 8.96,0 a4.48,4.48 0 1,0 -8.96,0",
  forum: "M0,-8.64 L8.64,0 L0,8.64 L-8.64,0 Z",
  country: "M8.16,0 L4.08,7.07 L-4.08,7.07 L-8.16,0 L-4.08,-7.07 L4.08,-7.07 Z",
};

/** The server's kind words (src/power_maps/vocab.py `node_kind`), for reading a picker hint. */
export const KIND_WORDS = { person: "Person", organization: "Organisation", seat: "Seat",
  group: "Group", forum: "Forum", country: "Country" };

const ON_MAPS = /^on (\d+) maps?$/i;
const NOT_ON_A_MAP = /^not on a map yet$/i;

function hintParts(hint) {
  return String(hint == null ? "" : hint).split(" · ").map((s) => s.trim()).filter(Boolean);
}

/** The prefix and bare id of a picker id: "node:abc" → {prefix: "node", id: "abc"};
 * a bare id has prefix "". */
export function splitActorId(rowId) {
  const s = String(rowId == null ? "" : rowId);
  const m = s.match(/^(node|contact|org):(.+)$/);
  return m ? { prefix: m[1], id: m[2] } : { prefix: "", id: s };
}

/** What shape a picker match is: a CRM contact is a person, a CRM organisation an
 * organisation, a map actor (`node:`) the kind its hint names (default person). */
export function kindOfMatch(rowId, hint) {
  const { prefix } = splitActorId(rowId);
  if (prefix === "contact") return "person";
  if (prefix === "org") return "organization";
  const first = hintParts(hint)[0];
  for (const [k, w] of Object.entries(KIND_WORDS)) if (first === w) return k;
  return "person";
}

/** How many maps the hint says the actor is on (`node:` "on 3 maps"); 0 for "not on a map
 * yet"; null when the hint does not say. */
export function mapsInHint(hint) {
  for (const p of hintParts(hint)) {
    const m = p.match(ON_MAPS);
    if (m) return Number(m[1]);
    if (NOT_ON_A_MAP.test(p)) return 0;
  }
  return null;
}

/** The hint line a person reads: the server's hint without the kind word and the map count
 * (those are the shape and the badge). An actor with nothing else to say shows its kind,
 * except a person, who shows nothing. */
export function hintLine(rowId, hint) {
  const kind = kindOfMatch(rowId, hint);
  const { prefix } = splitActorId(rowId);
  const parts = hintParts(hint).filter((p, i) => !ON_MAPS.test(p) && !NOT_ON_A_MAP.test(p)
    && !(prefix === "node" && i === 0 && p === KIND_WORDS[kind]));
  if (parts.length) return parts.join(" · ");
  return kind === "person" ? "" : KIND_WORDS[kind];
}

/** "On 1 other map" / "On 3 other maps", or "" for none or unknown. */
export function otherMapsBadge(n) {
  const k = Number(n);
  if (!Number.isFinite(k) || k <= 0) return "";
  return `On ${k} other map${k === 1 ? "" : "s"}`;
}

/** Every spelling of an actor the page might have put in `onMap`: the picker id, and its bare
 * id ("node:abc" → "node:abc", "abc"; "i-1" → "i-1", "contact:i-1"). */
export function idVariants(rowId) {
  const s = String(rowId == null ? "" : rowId);
  const { prefix, id } = splitActorId(s);
  if (prefix) return [s, id];
  return [s, `contact:${s}`, `node:${s}`];
}

/** True when `onMap` (a Set or array of node ids / contact ids, either spelling) holds the
 * actor. A null `onMap` holds nobody. */
export function isOnMap(onMap, rowId) {
  if (!onMap || rowId == null || rowId === "") return false;
  const has = typeof onMap.has === "function" ? (x) => onMap.has(x) : (x) => onMap.includes(x);
  return idVariants(rowId).some(has);
}

/** One type-ahead row, as data: `{id, label, kind, hint, badge, badgeOn, disabled}`. */
export function matchView(opt, onMap) {
  const id = opt && opt.row_id;
  const on = isOnMap(onMap, id);
  const n = mapsInHint(opt && opt.hint);
  return {
    id, label: (opt && opt.label) || "", kind: kindOfMatch(id, opt && opt.hint),
    hint: hintLine(id, opt && opt.hint),
    badge: on ? "Already on this map" : otherMapsBadge(n),
    badgeOn: on, disabled: on,
  };
}

/** The type-ahead's last item: "Add “typed” as a new contact". */
export function newContactText(q) { return `Add “${String(q || "").trim()}” as a new contact`; }
/** The other kinds of actor a person can add that are not CRM records (kit 1.9). */
export const NEW_NODE_KINDS = [["seat", "Seat", "a role whose holder changes"], ["group", "Group of people", "e.g. “NL ministers”"],
  ["forum", "Forum", "e.g. the G7, the OECD"], ["country", "Country", ""]];
export function newNodeText(q) { return `Add “${String(q || "").trim()}” as a seat, group, forum or country`; }

/** A typed name as a starting full name: trimmed, first letter capitalised. */
export function startName(q) {
  const s = String(q || "").trim().replace(/\s+/g, " ");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

/** Next highlighted index for ArrowUp / ArrowDown over `rows` (each `{disabled}`), skipping
 * disabled rows and wrapping; -1 when nothing can be highlighted. */
export function moveHighlight(rows, active, key) {
  const n = rows.length;
  if (!n) return -1;
  const step = key === "ArrowUp" ? -1 : 1;
  let i = active;
  for (let k = 0; k < n; k++) {
    i = i < 0 ? (step > 0 ? 0 : n - 1) : (i + step + n) % n;
    if (!rows[i].disabled) return i;
  }
  return -1;
}

/** The first row that can be added, or -1. */
export function firstEnabled(rows) { return rows.findIndex((r) => !r.disabled); }

/**
 * `get_org_contacts(include_sub_orgs)` as a tree: `{id, name, people, children}` for the
 * organisation picked, its sub-organisations nested by Part of. A person sits under their
 * primary organisation when that is in the tree, else under the root (a secondary-org
 * contact). A sub-organisation whose parent is not in the tree hangs off the root. Groups with
 * nobody in them (at any depth) are dropped; people and groups are in name order.
 */
export function buildOrgTree(rows, subOrgs, rootId, rootName) {
  const root = { id: rootId, name: rootName || "", people: [], children: [] };
  const byId = new Map([[rootId, root]]);
  for (const o of Array.isArray(subOrgs) ? subOrgs : []) {
    if (!o || !o.coda_row_id || byId.has(o.coda_row_id)) continue;
    byId.set(o.coda_row_id, { id: o.coda_row_id, name: o.name || "", people: [], children: [], _parent: o.part_of_coda_row_id || null });
  }
  for (const node of byId.values()) {
    if (node === root) continue;
    let parent = node._parent && byId.get(node._parent);
    // A loop (the server cuts them, but never trust it) or an unknown parent: the root.
    const seen = new Set([node.id]);
    for (let p = parent; p && p !== root; p = p._parent ? byId.get(p._parent) : null) {
      if (seen.has(p.id)) { parent = null; break; }
      seen.add(p.id);
    }
    (parent || root).children.push(node);
  }
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.coda_row_id) continue;
    const home = (!r.is_secondary && r.org_match !== "secondary" && byId.get(r.primary_org_coda_row_id)) || root;
    home.people.push({ id: r.coda_row_id, name: r.full_name || "", position: r.position || "" });
  }
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  const tidy = (node) => {
    node.people.sort(byName);
    node.children = node.children.map(tidy).filter((c) => countPeople(c) > 0).sort(byName);
    delete node._parent;
    return node;
  };
  return tidy(root);
}

/** Everyone in a tree node, at any depth. */
export function countPeople(node) {
  if (!node) return 0;
  return (node.people || []).length + (node.children || []).reduce((s, c) => s + countPeople(c), 0);
}

/** "1 contact" / "5 contacts". */
export function contactsLabel(n) { return `${n} contact${n === 1 ? "" : "s"}`; }

/** The browse list's groups, in display order: the root's own people (under the root's
 * name) first, then each sub-organisation with its `depth` (0 = directly under the root). */
export function treeGroups(tree) {
  const out = [];
  if (!tree) return out;
  if (tree.people.length) out.push({ id: tree.id, name: tree.name, depth: 0, people: tree.people, total: tree.people.length, parent: null });
  const walk = (node, depth, parent) => {
    out.push({ id: node.id, name: node.name, depth, people: node.people, total: countPeople(node), parent });
    for (const c of node.children) walk(c, depth + 1, node.id);
  };
  for (const c of tree.children) walk(c, 0, null);
  return out;
}

/** The bulk-add progress line: "Adding 4… 2 added" while it runs, then "3 of 4 added". */
export function bulkProgressText({ total = 0, done = 0, active = false } = {}) {
  return active ? `Adding ${total}… ${done} added` : `${done} of ${total} added`;
}

/** The progress bar's width, as a CSS percentage. */
export function bulkProgressPct({ total = 0, done = 0 } = {}) {
  return total > 0 ? `${Math.round((done / total) * 100)}%` : "0%";
}

/** What a failed bulk add says: one entry per person `{title, quote}`, plus the closing line
 * about the others ("The other 3 were added." / "None of the others were added." …). */
export function bulkFailureView(failures, added) {
  const list = (failures || []).map((f) => ({ title: `Couldn’t add ${f.label}.`, quote: f.message || "Nothing was saved." }));
  let others = "";
  if (list.length) {
    others = added === 0 ? "Nobody else was added." : added === 1 ? "The other 1 was added." : `The other ${added} were added.`;
  }
  return { list, others };
}

/** The footer line: "Nothing added yet" / "1 added to this map". */
export function addedLine(n) { return n > 0 ? `${n} added to this map` : "Nothing added yet"; }

/** The node id a power_map_actor create made: its receipt's `row_id` is "<map>:<node>". */
export function nodeIdFromRowId(rowId, mapId) {
  const s = String(rowId || "");
  if (mapId && s.startsWith(`${mapId}:`)) return s.slice(String(mapId).length + 1) || null;
  const i = s.indexOf(":");
  return i >= 0 ? s.slice(i + 1) || null : null;
}

/** Today in the viewer's calendar, as YYYY-MM-DD (a judgement's `as_of`). */
export function todayIso(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** The fields of a judgement create: one measure, one number, as of today, on this map. */
export function judgementFields({ mapId, nodeId, measure, value, asOf }) {
  return { map: mapId, actor: `node:${nodeId}`, measure, value_num: Number(value), as_of: asOf || todayIso() };
}

/** Stance values as the design writes them: "−2", "−1", "0", "+1", "+2". */
export function stanceText(v) { return v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : "0"; }

/** Which optional scores the added row offers, from the map's measures (a list or a
 * comma-separated string). No list given: both. */
export function scoresOffered(measures) {
  if (measures == null || measures === "") return { power: true, stance: true };
  const set = new Set((Array.isArray(measures) ? measures : String(measures).split(","))
    .map((m) => String(m && typeof m === "object" ? m.key || m.measure || "" : m).trim()).filter(Boolean));
  return { power: set.has("power"), stance: set.has("stance") };
}

/** A save outcome in the kit's three words: `{outcome, message}`. Saved, refused (the
 * server's message exactly as written), or unknown ("This may have saved…"). */
export const UNKNOWN_SAVE = "This may have saved… Check before trying again.";
export function outcomeOf(machine) {
  const m = machine || {};
  const r = m.receipt || {};
  if (m.state === "saved_syncing") return { outcome: "saved", message: "", receipt: r };
  if (m.state === "outcome_unknown") return { outcome: "unknown", message: UNKNOWN_SAVE, receipt: r };
  const msgs = (r.refusals || []).map((x) => x && x.message).filter(Boolean);
  return { outcome: "refused", message: msgs.join(" ") || "Nothing was saved.", receipt: r };
}

/** One save through the kit's machine: preview, then save, with a fresh key. A
 * `changed_since_opened` question (a status edit with no token never raises one) is answered
 * yes: this is the person's own deliberate action. */
export async function saveOnce(transport, table, fields, rowId = null) {
  const m = new SaveMachine({ transport, table, rowId, watchSaves: false });
  await m.submit(fields);
  if (m.state === "confirm") await m.confirm();
  return outcomeOf(m);
}

/** Take an actor off a map: `{status: "removed"}` on the member row. Nothing is deleted. */
export function removeActor(mapId, nodeId, { transport = transportOf({}) } = {}) {
  return saveOnce(transport, "power_map_actor", { status: "removed" }, `${mapId}:${nodeId}`);
}

/** Put a removed actor back: `{status: "active"}`; they come back with everything they had. */
export function restoreActor(mapId, nodeId, { transport = transportOf({}) } = {}) {
  return saveOnce(transport, "power_map_actor", { status: "active" }, `${mapId}:${nodeId}`);
}

/* --- K3 ------------------------------------------------------------------ */

/** The statuses that stand in for an employer (src/sync … EMPLOYER_NOT_EXPECTED_STATUSES). */
export const NO_EMPLOYER = ["Independent / self-employed", "Retired"];
export const EITHER_OR_RULE = "Primary organisation, or Independent / self-employed / Retired";

/** True when a contact's values answer "where they work": a primary organisation, or an
 * employment status that means there is no employer. */
export function workplaceAnswered(values) {
  const v = values || {};
  const org = v.primary_org;
  const hasOrg = Array.isArray(org) ? org.length > 0 : !!(org && (typeof org === "string" ? org.trim() : org.row_id));
  if (hasOrg) return true;
  const st = String(v.employment_status == null ? "" : v.employment_status).trim().toLowerCase();
  return NO_EMPLOYER.some((s) => s.toLowerCase() === st);
}

const ROW_ID = /\bi-[A-Za-z0-9_-]{4,}\b/g;

/** The existing record(s) an exact-name duplicate refusal names, or null when the receipt is
 * not one. `{ids, message}`: `ids` from the refusal's `existing_row_id` / `candidates` when the
 * server gives them, else the Coda row ids in its `technical` text; `message` is the server's
 * own words. */
export function duplicateFrom(receipt) {
  const refusals = (receipt && receipt.refusals) || [];
  for (const r of refusals) {
    if (!r) continue;
    const tech = typeof r.technical === "string" ? r.technical : "";
    const isDup = r.code === "duplicate" || r.code === "duplicate_refused" || /duplicate_refused/.test(tech);
    if (!isDup) continue;
    let ids = [];
    if (typeof r.existing_row_id === "string" && r.existing_row_id) ids.push(r.existing_row_id);
    if (Array.isArray(r.candidates)) ids.push(...r.candidates.filter((x) => typeof x === "string"));
    if (!ids.length) ids = tech.match(ROW_ID) || [];
    ids = [...new Set(ids)];
    if (!ids.length) return null;
    return { ids, message: r.message || "A record with this exact name already exists." };
  }
  return null;
}

/** The existing contact's hint line from `get_record_for_editing`: position · organisation. */
export function contactHint(rec) {
  const v = (rec && rec.values) || {};
  const org = v.primary_org;
  const orgName = Array.isArray(org) ? (org[0] && org[0].label) : org && typeof org === "object" ? org.label : null;
  return [v.position, orgName].filter((x) => typeof x === "string" && x.trim()).join(" · ");
}

/** The fields of the new-organisation form, from `describe_record_form(organizations,
 * create)`: `{name, sector}` (each a served field, or null). The name is the field called
 * `name`, else the first required text field; the sector is the field called `sector`, else
 * one whose label says Sector. */
export function orgFormFields(form) {
  const fields = (form && Array.isArray(form.fields)) ? form.fields : [];
  const name = fields.find((f) => f.name === "name")
    || fields.find((f) => f.required && (f.kind === "text" || !f.kind)) || null;
  const sector = fields.find((f) => f.name === "sector")
    || fields.find((f) => /sector/i.test(String(f.label || ""))) || null;
  return { name, sector };
}

/** A served dropdown's choices as `{value, label}`, in the server's order. */
export function choicesOf(field) {
  return ((field && field.options) || []).map((o) => (o && typeof o === "object"
    ? { value: String(o.value != null ? o.value : o.label), label: String(o.label != null ? o.label : o.value) }
    : { value: String(o), label: String(o) })).filter((o) => o.value);
}

/** What the new organisation is, for the contact form's primary organisation: `{row_id,
 * label}`, or null when the save did not say which row it made. */
export function orgPick(receipt, name) {
  const id = receipt && typeof receipt.row_id === "string" && receipt.row_id ? receipt.row_id : null;
  return id ? { row_id: id, label: String(name || "").trim() } : null;
}

/* ===========================================================================
   DOM helpers
   ========================================================================= */

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
  return e;
}

function svg(viewBox, attrs, parts) {
  const s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("viewBox", viewBox);
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("focusable", "false");
  for (const [k, v] of Object.entries(attrs || {})) s.setAttribute(k, v);
  for (const [tag, a] of parts) {
    const p = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(a)) p.setAttribute(k, v);
    s.append(p);
  }
  return s;
}

/** The actor's shape, as the screens draw it. */
export function shapeIcon(kind, size = 20) {
  const k = SHAPES[kind] ? kind : "person";
  return svg("-10 -10 20 20", { width: String(size), height: String(size) },
    [["path", { class: k === "forum" ? "shp forum" : "shp", d: SHAPES[k] }]]);
}

const stroke = (w) => ({ fill: "none", stroke: "currentColor", "stroke-width": w, "stroke-linecap": "round" });
const searchIcon = () => svg("0 0 24 24", { width: "16", height: "16", ...stroke("2") },
  [["circle", { cx: "11", cy: "11", r: "7" }], ["path", { d: "M20 20l-3.5-3.5" }]]);
const closeIcon = (n = 16) => svg("0 0 24 24", { width: String(n), height: String(n), ...stroke("2.4") },
  [["path", { d: "M6 6l12 12M18 6L6 18" }]]);
const plusIcon = () => svg("0 0 24 24", { width: "20", height: "20", ...stroke("2.4"), style: "color: var(--res)" },
  [["path", { d: "M12 5v14M5 12h14" }]]);
const chevIcon = () => svg("0 0 24 24", { class: "chev", ...stroke("2.6"), "stroke-linejoin": "round" },
  [["path", { d: "M6 9l6 6 6-6" }]]);

const srOnly = "position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0)";

let uid = 0;
const nid = (p) => `${p}-${++uid}`;

function isEditableEl(e) {
  if (e._editable === true || e._editable === false) return e._editable;
  const a = e.getAttribute("editable");
  return a != null && a !== "false";
}

function quote(text) {
  const q = el("q");
  q.textContent = text;
  return q;
}

/* ===========================================================================
   <tfs-map-people> (K2)
   ========================================================================= */

export class TfsMapPeople extends Base {
  static get observedAttributes() { return ["map", "map-name", "editable", "measures"]; }

  constructor() {
    super();
    this._onMap = null;
    this._sessionOn = new Set();   // actors added in this drawer (either spelling)
    this.tab = "search"; this.quick = null;
    this._q = ""; this._matches = []; this._active = -1; this._seq = 0; this._searchState = "idle";
    this._added = [];             // [{key, nodeId, actorId, label, kind, state, message, role, power, stance, busy}]
    this._org = null; this._orgQ = ""; this._orgMatches = []; this._orgState = "idle"; this._orgSeq = 0;
    this._tree = null; this._open = new Set(); this._picked = new Set(); this._run = null; this._failures = [];
    this._roles = null; this._toast = null;
  }

  get transport() { return transportOf(this); }
  set transport(t) { this._transport = t; }
  get mapId() { return this.getAttribute("map") || ""; }
  get editable() { return isEditableEl(this); }
  set editable(v) { this._editable = !!v; this._render(); }
  /** Who is on the map now (node ids / contact ids, either spelling). */
  get onMap() { return this._onMap; }
  set onMap(s) { this._onMap = s || null; this._render(); }

  _isOn(id) { return isOnMap(this._onMap, id) || isOnMap(this._sessionOn, id); }

  connectedCallback() {
    ensurePmCss();
    this._render();
    queueMicrotask(() => this._loadRoles());
  }
  attributeChangedCallback() { if (this.isConnected) this._render(); }

  /* Role choices come from the server's power_map_actor form, never from the screens. */
  async _loadRoles() {
    if (this._roles) return;
    try {
      const form = await this.transport.call("describe_record_form", { table: "power_map_actor", mode: "create" });
      const f = form && (form.fields || []).find((x) => x.name === "role");
      this._roles = choicesOf(f);
    } catch { this._roles = []; }
    this._render();
  }

  _emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail })); }

  /* ----- render ----- */

  _render() {
    if (!this.isConnected) return;
    if (!this.editable) { this.replaceChildren(); this.hidden = true; return; }
    this.hidden = false;
    // Keep focus (and the caret) on the control in use across a redraw.
    const act = this.contains(document.activeElement) ? document.activeElement : null;
    const focusId = act && act.id ? act.id : null;
    let caret = null;
    try { caret = act && typeof act.selectionStart === "number" ? [act.selectionStart, act.selectionEnd] : null; } catch { caret = null; }
    const aside = el("aside", { class: "drawer", "aria-label": "Add to this map" });
    const close = el("button", { type: "button", class: "xbtn", "aria-label": "Close", onclick: () => this._done() }, closeIcon(16));
    aside.append(el("div", { class: "dh" },
      el("div", { style: "flex: 1; min-width: 0" }, el("b", { text: "Add to this map" }),
        this.getAttribute("map-name") ? el("small", { text: this.getAttribute("map-name") }) : null),
      close));
    const body = el("div", { class: "db" });
    if (this.nodeNew) body.append(this._nodeView());
    else if (this.quick) body.append(this._quickView());
    else {
      body.append(this._tabs());
      body.append(this.tab === "browse" ? this._browseView() : this._searchView());
    }
    if (this._added.length) body.append(this._addedView());
    aside.append(body);
    const foot = el("div", { class: "df" }, el("span", { class: "grow", text: addedLine(this._addedCount()) }));
    if (!this.quick && this.tab === "browse" && this._tree) {
      const n = this._picked.size;
      foot.append(el("button", { type: "button", class: "btn", disabled: !n || (this._run && this._run.active),
        text: `Add ${n} selected`, onclick: () => this._bulk() }));
    }
    foot.append(el("button", { type: "button", class: "btn-2", text: "Done", onclick: () => this._done() }));
    aside.append(foot);
    const kids = [aside];
    if (this._toast) {
      const t = this._toast;
      kids.push(el("div", { class: "toast", role: "status" }, el("span", { text: t.text }),
        t.undo ? el("button", { type: "button", text: "Undo", onclick: t.undo }) : null));
    }
    this.replaceChildren(...kids);
    if (focusId) {
      const f = this.querySelector(`[id="${String(focusId).replace(/["\\]/g, "\\$&")}"]`);
      if (f && document.activeElement !== f) {
        f.focus();
        try { if (caret && f.setSelectionRange) f.setSelectionRange(caret[0], caret[1]); } catch { /* not a text field */ }
      }
    }
  }

  _addedCount() { return this._added.filter((a) => a.state === "saved").length; }

  _tabs() {
    const base = this._tabId || (this._tabId = nid("tfs-mp-tab"));
    const tab = (id, text) => el("button", { type: "button", role: "tab", id: `${base}-${id}`, "aria-selected": String(this.tab === id), text,
      onclick: () => { if (this.tab !== id) { this.tab = id; this._render(); } } });
    return el("div", { class: "seg", role: "tablist", "aria-label": "How to find people", style: "align-self: flex-start" },
      tab("search", "Search by name"), tab("browse", "Browse an organisation"));
  }

  /* ----- search by name ----- */

  _rows() {
    const rows = this._matches.map((o) => matchView(o, { has: (x) => this._isOn(x) }));
    if (this._q.trim()) rows.push({ id: "__new", newContact: true, disabled: false });
    if (this._q.trim()) rows.push({ id: "__node", newNode: true, disabled: false });
    return rows;
  }

  _searchView() {
    const wrap = el("div", { style: "display: flex; flex-direction: column; gap: 8px" });
    const inputId = this._pqId || (this._pqId = nid("tfs-pq"));
    const listId = `${inputId}-list`;
    const input = el("input", { id: inputId, class: "input", type: "search", autocomplete: "off",
      placeholder: "Type a name — people, organisations, seats, forums",
      role: "combobox", "aria-expanded": String(!!this._q.trim()), "aria-controls": listId, "aria-autocomplete": "list" });
    input.value = this._q;
    input.addEventListener("input", () => { this._q = input.value; this._search(); });
    input.addEventListener("keydown", (e) => this._key(e));
    const rows = this._rows();
    if (this._active >= 0 && rows[this._active]) input.setAttribute("aria-activedescendant", `${listId}-${this._active}`);
    wrap.append(el("div", { class: "search" }, searchIcon(),
      el("label", { for: inputId, style: srOnly, text: "Search people and organisations in the CRM" }), input));
    wrap.append(el("span", { class: "quiet", text: "Searches the CRM and every map. Enter adds the highlighted match." }));
    if (!this._q.trim()) return wrap;
    const list = el("div", { class: "results", role: "listbox", id: listId, "aria-label": "Matches" });
    if (this._searchState === "loading" && !this._matches.length) list.append(el("div", { class: "res", role: "status", "aria-disabled": "true" }, el("span"), el("span", { class: "quiet", text: "Searching…" }), el("span")));
    if (this._searchState === "error") {
      list.append(el("div", { class: "res", role: "alert" }, el("span"),
        el("span", {}, el("b", { text: "Couldn’t search just now." })),
        el("button", { type: "button", class: "btn-2", text: "Try again", onclick: () => this._search(true) })));
    }
    rows.forEach((r, i) => {
      if (r.newContact) {
        list.append(el("button", { type: "button", class: `res${i === this._active ? " on" : ""}`, role: "option", id: `${listId}-${i}`,
          "aria-selected": String(i === this._active), onclick: () => this._openQuick() }, plusIcon(),
          el("span", {}, el("span", { class: "new", text: newContactText(this._q) }),
            el("small", { text: "Not in the CRM yet? Create them and add them here in one go." })), el("span")));
        return;
      }
      if (r.newNode) {
        list.append(el("button", { type: "button", class: `res${i === this._active ? " on" : ""}`, role: "option", id: `${listId}-${i}`,
          "aria-selected": String(i === this._active), onclick: () => { this.nodeNew = { name: this._q.trim(), state: "pick", message: "" }; this._render(); } }, plusIcon(),
          el("span", {}, el("span", { class: "new", text: newNodeText(this._q) }),
            el("small", { text: "Not a person or an organisation: a role, a group, a forum or a country." })), el("span")));
        return;
      }
      list.append(el("button", { type: "button", class: `res${i === this._active ? " on" : ""}`, role: "option", id: `${listId}-${i}`,
        "aria-selected": String(i === this._active), disabled: r.disabled, onclick: () => this._addMatch(this._matches[i]) },
        shapeIcon(r.kind, r.kind === "person" ? 18 : 20),
        el("span", { style: "min-width: 0" }, el("b", { text: r.label }), r.hint ? el("small", { text: r.hint }) : null),
        r.badge ? el("span", { class: r.badgeOn ? "badge on" : "badge", text: r.badge }) : el("span")));
    });
    if (this._searchState === "done" && !this._matches.length) {
      list.prepend(el("div", { class: "res", role: "status", "aria-disabled": "true" }, el("span"),
        el("span", { class: "quiet", text: "No one by that name in the CRM or on any map." }), el("span")));
    }
    wrap.append(list);
    return wrap;
  }

  _search(now = false) {
    clearTimeout(this._deb);
    const q = this._q.trim();
    if (!q) { this._matches = []; this._active = -1; this._searchState = "idle"; this._render(); return; }
    this._deb = setTimeout(async () => {
      const seq = ++this._seq;
      this._searchState = "loading"; this._render();
      let opts = [];
      try {
        const r = await this.transport.call("search_records_for_picker", { entity_type: "power_map_actor", query: q, limit: 20 });
        opts = (r && r.options) || [];
      } catch {
        if (seq !== this._seq) return;
        this._searchState = "error"; this._matches = []; this._active = -1; this._render(); return;
      }
      if (seq !== this._seq) return;
      this._matches = opts.filter((o) => o && o.row_id);
      this._searchState = "done";
      this._active = firstEnabled(this._rows());
      this._render();
    }, now ? 0 : 200);
  }

  _key(e) {
    const rows = this._rows();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      this._active = moveHighlight(rows, this._active, e.key);
      this._render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Nothing moved with the arrows yet: Enter takes the first match it can add (the row the
      // list shows highlighted), as the hint under the box promises.
      const i = this._active >= 0 ? this._active : firstEnabled(rows);
      const r = rows[i];
      if (!r || r.disabled) return;
      if (r.newContact) this._openQuick();
      else if (r.newNode) { this.nodeNew = { name: this._q.trim(), state: "pick", message: "" }; this._render(); }
      else this._addMatch(this._matches[i]);
    } else if (e.key === "Escape" && this._q) {
      e.preventDefault(); this._q = ""; this._search();
    }
  }

  /* Adds at once, with the name only. The row appears straight away as "Adding…". */
  async _addMatch(opt) {
    if (!opt || this._isOn(opt.row_id)) return;
    const kind = kindOfMatch(opt.row_id, opt.hint);
    clearTimeout(this._deb); this._seq++;   // a search still out must not refill the list
    this._q = ""; this._matches = []; this._active = -1; this._searchState = "idle";
    await this._addActor(opt.row_id, opt.label || "", kind);
  }

  /** Save one member create; the added row reports its outcome. Resolves the outcome. */
  async _addActor(actorId, label, kind, { keepFailed = true } = {}) {
    const row = { key: nid("add"), nodeId: null, actorId, label, kind, state: "saving", message: "", power: null, stance: null, role: "", busy: false };
    this._added.unshift(row);
    for (const v of idVariants(actorId)) this._sessionOn.add(v);
    this._render();
    const out = await saveOnce(this.transport, "power_map_actor", { map: this.mapId, actor: actorId });
    if (out.outcome === "saved") {
      row.state = "saved";
      row.nodeId = nodeIdFromRowId(out.receipt.row_id, this.mapId);
      if (row.nodeId) for (const v of idVariants(`node:${row.nodeId}`)) this._sessionOn.add(v);
      this._emit("tfs-map-people-added", { node_id: row.nodeId, actor_id: actorId, label });
    } else {
      row.state = out.outcome; row.message = out.message;
      // A refusal wrote nothing: they can be picked again. Unknown: they may be on the map.
      if (out.outcome === "refused") for (const v of idVariants(actorId)) this._sessionOn.delete(v);
      // Bulk adds report failures in one box under the list, not row by row.
      if (!keepFailed) this._added.splice(this._added.indexOf(row), 1);
    }
    this._render();
    return out;
  }

  /** A new seat, group, forum or country: pick its kind, the node is created, then added here. A
   * name already on TFS's maps as that kind is added instead of duplicated (the server says which). */
  _nodeView() {
    const n = this.nodeNew;
    const box = el("div", { class: "nodenew", style: "display:flex;flex-direction:column;gap:10px" },
      el("b", { text: `Add “${n.name}” as…` }));
    const kinds = el("div", { style: "display:flex;flex-direction:column;gap:6px" });
    for (const [k, label, hint] of NEW_NODE_KINDS) {
      kinds.append(el("button", { type: "button", class: "res", disabled: n.state === "saving", onclick: () => this._createNode(k) },
        shapeIcon(k, 20), el("span", {}, el("b", { text: label }), hint ? el("small", { text: hint }) : null), el("span")));
    }
    box.append(kinds);
    if (n.state === "saving") box.append(el("span", { class: "quiet", text: "Saving…" }));
    if (n.message) box.append(el("div", { class: "quiet", role: "alert", text: n.message }));
    box.append(el("button", { type: "button", class: "btn-2", style: "align-self:flex-start", onclick: () => { this.nodeNew = null; this._render(); }, text: "Back to search" }));
    return box;
  }
  async _createNode(kind) {
    const n = this.nodeNew; if (!n) return;
    n.state = "saving"; n.message = ""; this._render();
    const out = await saveOnce(this.transport, "power_map_node", { kind, name: n.name });
    let rowId = out.outcome === "saved" ? out.receipt.row_id : null;
    if (!rowId && out.outcome === "refused") {
      const dup = (out.receipt.refusals || []).find((x) => x && x.code === "already_exists" && x.existing_row_id);
      if (dup) rowId = dup.existing_row_id;
    }
    if (!rowId) { n.state = "pick"; n.message = out.message || "Nothing was saved."; this._render(); return; }
    const id = String(rowId).startsWith("node:") ? String(rowId) : `node:${rowId}`;
    this.nodeNew = null; this._q = ""; this._render();
    await this._addActor(id, n.name, kind);
  }

  _openQuick() {
    this.quick = { name: startName(this._q) };
    this._qc = null;
    this._render();
  }

  /* One <tfs-quick-contact> per opening: a redraw of the drawer moves it, never rebuilds it. */
  _quickView() {
    if (this._qc) return this._qc;
    const qc = document.createElement("tfs-quick-contact");
    this._qc = qc;
    qc.setAttribute("name", this.quick.name);
    qc.setAttribute("editable", "");
    if (this._transport) qc.transport = this._transport;
    qc.addEventListener("tfs-contact-ready", (e) => {
      e.stopPropagation();
      const d = e.detail || {};
      this.quick = null; this._qc = null; this.tab = "search"; this._q = "";
      this._addActor(`contact:${d.contact_id}`, d.label || "", "person");
    });
    qc.addEventListener("tfs-quick-contact-cancel", (e) => { e.stopPropagation(); this.quick = null; this._qc = null; this._render(); });
    return qc;
  }

  /* ----- added rows: optional role / power / stance ----- */

  _addedView() {
    const box = el("div", { class: "added" }, el("div", { class: "flab", text: `Added just now · ${this._addedCount()}` }));
    const scores = scoresOffered(this.getAttribute("measures"));
    for (const a of this._added) {
      const t = el("div", { class: "t" }, shapeIcon(a.kind, 18), el("b", { text: a.label }));
      if (a.state === "saved" && a.nodeId) {
        t.append(el("button", { type: "button", class: "xbtn x", style: "width: 30px; height: 30px",
          "aria-label": `Remove ${a.label} from this map`, disabled: a.busy, onclick: () => this._removeAdded(a) }, closeIcon(14)));
      }
      const r = el("div", { class: "arow" }, t);
      if (a.state === "saving") r.append(el("span", { class: "quiet", role: "status", text: "Adding…" }));
      else if (a.state === "refused") {
        r.append(el("div", { class: "fail", role: "alert" }, el("b", { text: `Couldn’t add ${a.label}.` }),
          el("span", {}, "The server said: ", quote(a.message))));
      } else if (a.state === "unknown") {
        r.append(el("div", { class: "fail", role: "alert" }, el("b", { text: `${a.label} may have been added.` }), el("span", { text: a.message })));
      } else if (a.state === "saved" && a.nodeId) {
        r.append(this._optRow(a, scores));
        if (a.note) r.append(el("span", { class: a.noteBad ? "fail" : "quiet", role: a.noteBad ? "alert" : "status", text: a.note }));
      }
      box.append(r);
    }
    return box;
  }

  _optRow(a, scores) {
    const opt = el("div", { class: "opt" }, el("span", { text: "Add role · power · stance — optional" }));
    if (this._roles && this._roles.length) {
      const sel = el("select", { class: "sel", id: `${a.key}-role`, disabled: a.busy });
      sel.append(el("option", { value: "", text: "Choose…" }));
      for (const o of this._roles) {
        const op = el("option", { value: o.value, text: o.label });
        if (o.value === a.role) op.selected = true;
        sel.append(op);
      }
      sel.addEventListener("change", () => { if (sel.value) this._setRole(a, sel.value); });
      opt.append(el("label", { style: "display: inline-flex; gap: 6px; align-items: center" }, "Role ", sel));
    }
    const mini = (label, values, cur, text, measure) => el("span", { style: "display: inline-flex; gap: 6px; align-items: center" }, label,
      el("span", { class: "mini", role: "group", "aria-label": label },
        ...values.map((v) => el("button", { type: "button", id: `${a.key}-${measure}-${v}`, "aria-pressed": String(cur === v), disabled: a.busy, text: text(v),
          onclick: () => { if (cur !== v) this._score(a, measure, v); } }))));
    if (scores.power) opt.append(mini("Power", [1, 2, 3, 4, 5], a.power, String, "power"));
    if (scores.stance) opt.append(mini("Stance", [-2, -1, 0, 1, 2], a.stance, stanceText, "stance"));
    return opt;
  }

  async _rowSave(a, run, onSaved) {
    a.busy = true; a.note = "Saving…"; a.noteBad = false; this._render();
    const out = await run();
    a.busy = false;
    if (out.outcome === "saved") { onSaved(); a.note = "Saved"; }
    else { a.note = out.outcome === "unknown" ? out.message : `Not saved. The server said: “${out.message}”`; a.noteBad = true; }
    this._render();
  }

  _setRole(a, value) {
    return this._rowSave(a, () => saveOnce(this.transport, "power_map_actor", { role: value }, `${this.mapId}:${a.nodeId}`),
      () => { a.role = value; });
  }

  /* A judgement is never edited: a different value is a NEW judgement (the old one stays in
     History). */
  _score(a, measure, value) {
    return this._rowSave(a, () => saveOnce(this.transport, "power_map_judgement",
      judgementFields({ mapId: this.mapId, nodeId: a.nodeId, measure, value })), () => { a[measure] = value; });
  }

  async _removeAdded(a) {
    a.busy = true; this._render();
    const out = await removeActor(this.mapId, a.nodeId, { transport: this.transport });
    a.busy = false;
    if (out.outcome !== "saved") {
      a.note = out.outcome === "unknown" ? out.message : `Not removed. The server said: “${out.message}”`; a.noteBad = true;
      this._render(); return;
    }
    const i = this._added.indexOf(a);
    this._added.splice(i, 1);
    for (const v of [...idVariants(a.actorId), ...idVariants(`node:${a.nodeId}`)]) this._sessionOn.delete(v);
    this._emit("tfs-map-people-removed", { node_id: a.nodeId, label: a.label });
    this._showToast(`Removed ${a.label} from this map`, async () => {
      this._toast = null; this._render();
      const back = await restoreActor(this.mapId, a.nodeId, { transport: this.transport });
      if (back.outcome === "saved") {
        this._added.splice(Math.min(i, this._added.length), 0, a);
        for (const v of [...idVariants(a.actorId), ...idVariants(`node:${a.nodeId}`)]) this._sessionOn.add(v);
        a.note = ""; this._emit("tfs-map-people-restored", { node_id: a.nodeId, label: a.label });
        this._render();
      } else {
        this._showToast(back.outcome === "unknown" ? `${a.label}: ${back.message}` : `Couldn’t put ${a.label} back. ${back.message}`, null);
      }
    });
    this._render();
  }

  _showToast(text, undo) {
    clearTimeout(this._toastT);
    this._toast = { text, undo };
    this._toastT = setTimeout(() => { this._toast = null; this._render(); }, 8000);
    this._render();
  }

  /* ----- browse an organisation ----- */

  _browseView() {
    const wrap = el("div", { style: "display: flex; flex-direction: column; gap: 10px" });
    const inputId = this._orgId || (this._orgId = nid("tfs-orgq"));
    const helpId = `${inputId}-help`;
    const input = el("input", { id: inputId, class: "input", type: "search", autocomplete: "off",
      placeholder: "Type an organisation’s name", "aria-describedby": helpId });
    input.value = this._org ? this._org.label : this._orgQ;
    input.addEventListener("input", () => { this._org = null; this._tree = null; this._picked.clear(); this._orgQ = input.value; this._orgSearch(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && this._orgMatches[0]) { e.preventDefault(); this._pickOrg(this._orgMatches[0]); }
    });
    wrap.append(el("div", { class: "field" }, el("label", { for: inputId, text: "Organisation" }),
      el("div", { class: "search" }, searchIcon(), input),
      el("span", { class: "help", id: helpId, text: "Every CRM contact there, with its parts nested. People already on this map are ticked." })));
    if (!this._org && this._orgQ.trim()) {
      const list = el("div", { class: "results", role: "listbox", "aria-label": "Organisations" });
      if (this._orgState === "loading") list.append(el("div", { class: "res", role: "status" }, el("span"), el("span", { class: "quiet", text: "Searching…" }), el("span")));
      else if (this._orgState === "error") list.append(el("div", { class: "res", role: "alert" }, el("span"), el("b", { text: "Couldn’t search just now." }),
        el("button", { type: "button", class: "btn-2", text: "Try again", onclick: () => this._orgSearch(true) })));
      else if (!this._orgMatches.length) list.append(el("div", { class: "res", role: "status" }, el("span"), el("span", { class: "quiet", text: "No organisation by that name in the CRM." }), el("span")));
      for (const o of this._orgMatches) {
        list.append(el("button", { type: "button", class: "res", role: "option", onclick: () => this._pickOrg(o) }, shapeIcon("organization", 20),
          el("span", { style: "min-width: 0" }, el("b", { text: o.label || "" }), o.hint ? el("small", { text: o.hint }) : null), el("span")));
      }
      wrap.append(list);
    }
    if (this._org) wrap.append(this._treeView());
    if (this._run) {
      wrap.append(el("div", { class: "progress", role: "status" }, el("span", {}, el("b", { text: bulkProgressText(this._run) })),
        el("span", { class: "bar" }, el("i", { style: `width: ${bulkProgressPct(this._run)}` }))));
    }
    if (this._run && !this._run.active && this._failures.length) {
      const v = bulkFailureView(this._failures, this._run.done);
      const box = el("div", { class: "fail", role: "alert" });
      for (const f of v.list) box.append(el("b", { text: f.title }), el("span", {}, "The server said: ", quote(f.quote)));
      box.append(el("span", { class: "quiet", text: v.others }));
      wrap.append(box);
    }
    return wrap;
  }

  _orgSearch(now = false) {
    clearTimeout(this._orgDeb);
    const q = this._orgQ.trim();
    if (!q) { this._orgMatches = []; this._orgState = "idle"; this._render(); return; }
    this._orgDeb = setTimeout(async () => {
      const seq = ++this._orgSeq;
      this._orgState = "loading"; this._render();
      try {
        const r = await this.transport.call("search_records_for_picker", { entity_type: "organization", query: q, limit: 10 });
        if (seq !== this._orgSeq) return;
        this._orgMatches = ((r && r.options) || []).filter((o) => o && o.row_id);
        this._orgState = "done";
      } catch {
        if (seq !== this._orgSeq) return;
        this._orgState = "error"; this._orgMatches = [];
      }
      this._render();
    }, now ? 0 : 200);
  }

  async _pickOrg(o) {
    this._org = { id: o.row_id, label: o.label || "" };
    this._orgMatches = []; this._tree = null; this._treeState = "loading"; this._picked.clear(); this._run = null; this._failures = [];
    this._render();
    const org = this._org;
    let r;
    try {
      // get_org_contacts is an ordinary reading tool, not a page tool: it carries no contract.
      r = await this.transport.call("get_org_contacts", { org_name: org.id, include_sub_orgs: true, limit: 200 },
                                    { contract: false });
    } catch {
      if (this._org !== org) return;
      this._treeState = "error"; this._render(); return;
    }
    if (this._org !== org) return;
    this._tree = buildOrgTree(r && r.rows, r && r.sub_orgs, org.id, org.label);
    this._treeTruncated = !!(r && r.truncated);
    this._treeState = "done";
    const groups = treeGroups(this._tree);
    // Small lists open; a big organisation opens folded, so the groups are the overview.
    this._open = new Set(countPeople(this._tree) <= 40 ? groups.map((g) => g.id) : []);
    this._render();
  }

  _treeView() {
    if (this._treeState === "loading") return el("p", { class: "quiet", role: "status", text: "Loading contacts…" });
    if (this._treeState === "error") {
      return el("div", { class: "fail", role: "alert" }, el("b", { text: "Couldn’t load the contacts just now." }),
        el("button", { type: "button", class: "linkbtn", text: "Try again", onclick: () => this._pickOrg({ row_id: this._org.id, label: this._org.label }) }));
    }
    const groups = treeGroups(this._tree);
    if (!groups.length) return el("p", { class: "quiet", text: "No contacts at this organisation in the CRM." });
    const tree = el("div", { class: "tree" });
    const running = !!(this._run && this._run.active);
    const shown = new Set();   // a group shows only when every group above it is open
    for (const g of groups) {
      if (g.parent && !(shown.has(g.parent) && this._open.has(g.parent))) continue;
      shown.add(g.id);
      const open = this._open.has(g.id);
      const box = el("div");
      box.append(el("button", { type: "button", class: g.depth > 0 ? "tnode sub" : "tnode", id: `${this._orgId}-g-${g.id}`, "aria-expanded": String(open),
        style: g.depth > 1 ? `padding-left: ${10 + g.depth * 16}px` : null,
        onclick: () => { if (open) this._open.delete(g.id); else this._open.add(g.id); this._render(); } },
        chevIcon(), document.createTextNode(g.name), el("small", { text: contactsLabel(g.total) })));
      if (open) {
        for (const p of g.people) {
          const on = this._isOn(p.id);
          const cb = el("input", { type: "checkbox", id: `${this._orgId}-p-${p.id}` });
          cb.checked = on || this._picked.has(p.id);
          cb.disabled = on || running;
          cb.addEventListener("change", () => { if (cb.checked) this._picked.add(p.id); else this._picked.delete(p.id); this._render(); });
          box.append(el("label", { class: g.depth > 0 ? "tperson deep" : "tperson" }, cb,
            el("span", { style: "min-width: 0" }, el("b", { text: p.name }), p.position ? el("small", { text: p.position }) : null),
            on ? el("span", { class: "badge on", text: "On this map" }) : el("span")));
        }
      }
      tree.append(box);
    }
    const out = [tree];
    if (this._treeTruncated) out.push(el("p", { class: "quiet", text: "Showing the first 200 contacts. Search by name for anyone not listed." }));
    return el("div", { style: "display: flex; flex-direction: column; gap: 6px" }, ...out);
  }

  /* One at a time, each with its own key. A failure is named and quoted; the rest still land. */
  async _bulk() {
    if (this._run && this._run.active) return;
    const people = new Map();
    for (const g of treeGroups(this._tree)) for (const p of g.people) people.set(p.id, p);
    const ids = [...this._picked].filter((id) => people.has(id) && !this._isOn(id));
    if (!ids.length) return;
    this._run = { total: ids.length, done: 0, active: true };
    this._failures = [];
    this._render();
    for (const id of ids) {
      const p = people.get(id);
      const out = await this._addActor(`contact:${id}`, p.name, "person", { keepFailed: false });
      this._picked.delete(id);
      if (out.outcome === "saved") this._run.done += 1;
      else this._failures.push({ label: p.name, message: out.message });
      this._render();
    }
    this._run.active = false;
    this._render();
  }

  _done() { this._emit("tfs-map-people-done", { added: this._addedCount() }); }
}

/* ===========================================================================
   <tfs-quick-contact> (K3)
   ========================================================================= */

export class TfsQuickContact extends Base {
  static get observedAttributes() { return ["name", "editable"]; }

  constructor() {
    super();
    this._dup = null; this._dupRecs = []; this._orgOpen = false; this._orgForm = null; this._orgState = "idle";
    this._orgMsg = ""; this._orgVals = { name: "", sector: "" }; this._done = false; this._notice = "";
  }

  get transport() { return transportOf(this); }
  set transport(t) { this._transport = t; if (this._form) this._form.transport = t; }
  get editable() { return isEditableEl(this); }
  set editable(v) { this._editable = !!v; if (this.isConnected) this._build(); }

  connectedCallback() { ensurePmCss(); if (!this._built) this._build(); }
  attributeChangedCallback(name, o, n) { if (this._built && o !== n) this._build(); }

  _emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail })); }

  _build() {
    if (!this.isConnected) return;
    if (!this.editable) { this.replaceChildren(); this.hidden = true; this._built = false; return; }
    this.hidden = false; this._built = true; this._done = false;
    const name = startName(this.getAttribute("name"));
    const form = document.createElement("tfs-record-form");
    form.setAttribute("table", "contacts");
    form.setAttribute("mode", "create");
    form.setAttribute("fields", "full_name,position,primary_org,employment_status");
    form.setAttribute("heading", "New contact");
    form.setAttribute("save-label", "Add to the CRM and this map");
    form.presets = name ? { full_name: name } : {};
    if (this._transport) form.transport = this._transport;
    form.addEventListener("tfs-state", (e) => this._onState(e.detail || {}));
    form.addEventListener("tfs-saved", (e) => this._onSaved(e.detail || {}));
    form.addEventListener("tfs-close", () => this._cancel());
    this._form = form;
    this._ruleBox = el("div");
    this._orgBox = el("div");
    this._dupBox = el("div");
    this._noticeBox = el("div");
    this.replaceChildren(el("div", { class: "form", "aria-label": "New contact" },
      el("button", { type: "button", class: "linkbtn", style: "font-size: 13px", text: "← Back to search", onclick: () => this._cancel() }),
      el("div", { class: "quiet", text: "Saved to the CRM and added to this map in one go." }),
      this._ruleBox, form, this._orgBox, this._dupBox, this._noticeBox));
    this._paintRule(false); this._paintOrg(); this._paintDup(); this._paintNotice();
  }

  _cancel() { this._emit("tfs-quick-contact-cancel", {}); }

  /* The either/or rule, in place. It turns to a warning when a save was refused without it. */
  _paintRule(warn) {
    this._ruleBox.replaceChildren(el("div", { class: "field" },
      el("span", { class: "lab" }, "Where they work ", el("span", { class: "req", text: "*" })),
      el("span", { class: warn ? "fail" : "help", role: warn ? "alert" : null, text: EITHER_OR_RULE })));
  }

  _onState({ state, receipt }) {
    if (state === "refused") {
      const vals = this._form && typeof this._form.currentValues === "function" ? this._form.currentValues() : {};
      this._paintRule(!workplaceAnswered(vals));
      const dup = duplicateFrom(receipt);
      if (dup) this._showDup(dup);
    } else if (state === "previewing" || state === "saving") {
      this._dup = null; this._dupRecs = []; this._paintDup(); this._paintRule(false);
      this._pendingName = this._form && this._form.machine && this._form.machine.pending
        ? this._form.machine.pending.full_name : null;
    }
  }

  async _showDup(dup) {
    this._dup = dup; this._dupRecs = dup.ids.slice(0, 3).map((id) => ({ id, label: null, hint: "" }));
    this._paintDup();
    const recs = await Promise.all(this._dupRecs.map(async (d) => {
      try {
        const rec = await this.transport.call("get_record_for_editing", { table: "contacts", row_id: d.id });
        return rec && !rec.refused ? { id: d.id, label: rec.label || null, hint: contactHint(rec) } : d;
      } catch { return d; }
    }));
    if (this._dup !== dup) return;
    this._dupRecs = recs;
    this._paintDup();
  }

  _paintDup() {
    if (!this._dup) { this._dupBox.replaceChildren(); return; }
    const typed = (this._form && this._form.currentValues ? this._form.currentValues().full_name : "") || this.getAttribute("name") || "";
    const box = el("div", { class: "dup", role: "alert" },
      el("span", {}, "The server said: ", el("b", { text: `“${this._dup.message}”` })));
    for (const d of this._dupRecs) {
      const label = d.label || typed;
      box.append(el("div", { class: "rec" }, shapeIcon("person", 20),
        el("span", { style: "flex: 1; min-width: 0" }, el("b", { text: label }), d.hint ? el("small", { text: d.hint }) : null),
        el("button", { type: "button", class: "btn", style: "min-height: 34px", text: "Use this one",
          onclick: () => this._ready(d.id, label) })));
    }
    box.append(el("span", { class: "quiet", text: "A different person with the same name? Add a middle initial or another detail to the name, then save again." }));
    this._dupBox.replaceChildren(box);
  }

  _onSaved(receipt) {
    if (this._done) return;
    const id = receipt && typeof receipt.row_id === "string" && receipt.row_id ? receipt.row_id : null;
    const label = this._pendingName || startName(this.getAttribute("name"));
    if (!id) {
      this._notice = "Saved to the CRM. Coda is still creating the record, so they can be added to this map in a few minutes: search for them by name then.";
      this._paintNotice();
      return;
    }
    this._ready(id, label);
  }

  _ready(id, label) {
    if (this._done) return;
    this._done = true;
    this._emit("tfs-contact-ready", { contact_id: id, label: label || "" });
  }

  _paintNotice() {
    this._noticeBox.replaceChildren(...(this._notice ? [el("p", { class: "quiet", role: "status", text: this._notice })] : []));
  }

  /* ----- + New organisation ----- */

  async _openOrg() {
    this._orgOpen = true; this._paintOrg();
    if (this._orgForm) return;
    try {
      const form = await this.transport.call("describe_record_form", { table: "organizations", mode: "create" });
      this._orgForm = orgFormFields(form);
      if (this._orgForm.sector && this._orgForm.sector.kind === "linked" && this._orgForm.sector.picker) {
        const r = await this.transport.call("search_records_for_picker", { entity_type: this._orgForm.sector.picker.entity_type, query: "", limit: 50 });
        this._sectorChoices = ((r && r.options) || []).map((o) => ({ value: o.row_id, label: o.label || "" })).filter((o) => o.value && o.label);
      } else this._sectorChoices = choicesOf(this._orgForm.sector);
    } catch { this._orgForm = { name: null, sector: null, failed: true }; this._sectorChoices = []; }
    this._paintOrg();
  }

  _paintOrg() {
    if (!this._orgOpen) {
      this._orgBox.replaceChildren(el("button", { type: "button", class: "linkbtn", style: "font-size: 13px", text: "+ New organisation",
        onclick: () => this._openOrg() }));
      return;
    }
    const box = el("div", { class: "neworg" });
    if (!this._orgForm) { box.append(el("p", { class: "quiet", role: "status", text: "Loading…" })); this._orgBox.replaceChildren(box); return; }
    if (this._orgForm.failed || !this._orgForm.name || !this._orgForm.sector) {
      box.append(el("p", { class: "fail", role: "alert", text: "The new-organisation form isn’t available just now." }));
      this._orgBox.replaceChildren(box); return;
    }
    const busy = this._orgState === "saving";
    const nameId = nid("tfs-on"), secId = nid("tfs-os"), helpId = `${secId}-help`;
    const name = el("input", { id: nameId, class: "input", required: true, disabled: busy });
    name.value = this._orgVals.name;
    name.addEventListener("input", () => { this._orgVals.name = name.value; });
    const sel = el("select", { id: secId, class: "input", required: true, disabled: busy, "aria-describedby": helpId });
    sel.append(el("option", { value: "", text: "Choose a sector" }));
    for (const c of this._sectorChoices || []) {
      const o = el("option", { value: c.value, text: c.label });
      if (c.value === this._orgVals.sector) o.selected = true;
      sel.append(o);
    }
    sel.addEventListener("change", () => { this._orgVals.sector = sel.value; });
    box.append(
      el("div", { class: "field" }, el("label", { for: nameId }, "Organisation name ", el("span", { class: "req", text: "*" })), name),
      el("div", { class: "field" }, el("label", { for: secId }, "Sector ", el("span", { class: "req", text: "*" })), sel,
        el("span", { class: "help", id: helpId, text: "Required for a new organisation." })));
    if (this._orgMsg) box.append(el("div", { class: "fail", role: "alert", text: this._orgMsg }));
    box.append(el("div", { style: "display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap" },
      el("button", { type: "button", class: "btn-2", text: "Cancel", disabled: busy, onclick: () => { this._orgOpen = false; this._orgMsg = ""; this._paintOrg(); } }),
      el("button", { type: "button", class: "btn", text: busy ? "Saving…" : "Add organisation", disabled: busy, onclick: () => this._saveOrg() })));
    this._orgBox.replaceChildren(box);
  }

  async _saveOrg() {
    const nm = this._orgVals.name.trim();
    if (!nm || !this._orgVals.sector) { this._orgMsg = "Give the organisation a name and a sector."; this._paintOrg(); return; }
    this._orgState = "saving"; this._orgMsg = ""; this._paintOrg();
    const f = this._orgForm;
    const out = await saveOnce(this.transport, "organizations", { [f.name.name]: nm, [f.sector.name]: this._orgVals.sector });
    this._orgState = "idle";
    if (out.outcome !== "saved") {
      this._orgMsg = out.outcome === "unknown" ? out.message : `Not saved. The server said: “${out.message}”`;
      this._paintOrg(); return;
    }
    const pick = orgPick(out.receipt, nm);
    this._orgOpen = false; this._orgVals = { name: "", sector: "" };
    if (!pick) {
      this._notice = `${nm} was saved to the CRM. Coda is still creating it, so pick it as the primary organisation in a few minutes.`;
      this._paintNotice(); this._paintOrg(); return;
    }
    // Keep what was typed, and fill in the new organisation.
    const keep = {};
    const cur = this._form && this._form.currentValues ? this._form.currentValues() : {};
    for (const k of ["full_name", "position", "employment_status"]) if (cur[k] != null && cur[k] !== "") keep[k] = cur[k];
    this._form.presets = { ...keep, primary_org: pick };
    this._paintOrg();
  }
}

if (globalThis.customElements) {
  for (const [name, cls] of [["tfs-map-people", TfsMapPeople], ["tfs-quick-contact", TfsQuickContact]]) {
    if (!customElements.get(name)) customElements.define(name, cls);
  }
}
