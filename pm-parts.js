/* TFS pages kit — small Power Maps parts (kit 1.8.0, design hand-off 2026-10-15).
 *
 *   K4 <tfs-section heading="Scores on this map" kind-table="power_map_judgement" key="…" open>
 *        a collapsible details-panel section; its children are the body.
 *   K5 <tfs-record-peek table="kms_entries" row="i-…" source="https://…" editable>
 *        a record opened IN the page (screen 11), read fresh, with Edit and "Open in Coda ↗".
 *   K6 <tfs-view-switch views="rings,network,list,cards" key="<map id>" default="rings">
 *        the Rings / Network / List / Cards switcher, remembered per viewer per map.
 *
 * Plus helpers the page shares: historySentence / historyParts / historyGroups / renderHistory
 * (the History section as sentences), undoToast (one toast at a time), stanceLabel,
 * stanceWithValue, relLabel, formatDay.
 *
 * Record text reaches the DOM through textContent / setAttribute only. The one exception is a
 * record's BODY in <tfs-record-peek>, rendered through the kit's own mdToHtml — the same closed
 * Markdown subset <tfs-rich-text> already renders record text with (it escapes & < > first and
 * makes only http/https/mailto links). Markup and classes are lifted from the design's screens
 * 01, 11, 12 and 13 and styled by pm.css (injected by ensurePmCss).
 *
 * The logic lives in exported pure functions, tested under Node without a DOM
 * (test/pm-parts.test.js); the element classes are thin.
 */
import { ensurePmCss } from "./pm-css.js";
import { transportOf, safeHref, NO_CONNECTOR } from "./form.js";
import { mdToHtml } from "./markdown.js";
import { TfsKind, kindOf } from "./kind.js";

const Base = globalThis.HTMLElement || class {};

/* ---------------------------------------------------------------------------------------------
   Shared words
   ------------------------------------------------------------------------------------------- */

/** localStorage that never throws (private windows, blocked site data, previews). */
export function pmStorage(getStore = () => globalThis.localStorage) {
  const store = () => { try { return getStore() || null; } catch { return null; } };
  return {
    get(k) { try { const s = store(); return s ? s.getItem(k) : null; } catch { return null; } },
    set(k, v) { try { const s = store(); if (s) s.setItem(k, v); } catch { /* not kept; the page still works */ } },
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-01" (or an ISO timestamp) → "1 Oct 2026". Anything unreadable → "" (never raw). */
export function formatDay(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ""));
  if (!m) return "";
  const mon = MONTHS[Number(m[2]) - 1];
  return mon ? `${Number(m[3])} ${mon} ${m[1]}` : "";
}

const STANCES = { 2: "Champions", 1: "Supportive", 0: "Neutral", "-1": "Sceptical", "-2": "Opposes" };

/** A stance score in words: 2 Champions · 1 Supportive · 0 Neutral · −1 Sceptical · −2 Opposes.
 *  No score is "Unknown". (On the canvas the 0 band reads "Neutral or unknown": STANCE_BAND_ZERO.) */
export function stanceLabel(v) {
  if (v == null || v === "") return "Unknown";
  const n = Number(v);
  return Number.isFinite(n) && STANCES[String(Math.round(n))] ? STANCES[String(Math.round(n))] : "Unknown";
}
export const STANCE_BAND_ZERO = "Neutral or unknown";

/** "Supportive (+1)", "Neutral (0)", "Sceptical (−1)"; no score → "Unknown". */
export function stanceWithValue(v) {
  const word = stanceLabel(v);
  if (word === "Unknown") return word;
  const n = Math.round(Number(v));
  return `${word} (${n > 0 ? "+" + n : n < 0 ? "−" + Math.abs(n) : "0"})`;
}

const REL = {
  warm: "Met in the last year",
  known: "Met, over a year ago",
  owner_only: "Only a TFS owner",
  owner: "Only a TFS owner",
  none: "No meeting logged",
};
/** Who-at-TFS-knows-them label (relationship.label from the server) in words; unknown → "". */
export function relLabel(label) { return REL[label] || ""; }

/** A measure key in words: labels.measures wins, else "relationship_strength" → "Relationship strength". */
export function measureLabel(measure, labels = {}) {
  const given = labels.measures && labels.measures[measure];
  if (given) return given;
  const s = String(measure || "score").replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ---------------------------------------------------------------------------------------------
   History as sentences (DESIGN-BRIEF §4.4 item 8, HANDOFF §4 "Details panel")
   ------------------------------------------------------------------------------------------- */

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

function valueText(measure, v) {
  if (measure === "stance" && (typeof v === "number" || /^-?\d+(\.\d+)?$/.test(String(v ?? "")))) return stanceWithValue(v);
  if (v == null || v === "") return "nothing";
  return typeof v === "number" ? String(v) : `“${clip(String(v), 140)}”`;
}
const isText = (v) => typeof v === "string" && !/^-?\d+(\.\d+)?$/.test(v);

/**
 * Each history entry (get_power_map_profile `history`, newest first) with `previous` set to the
 * value of the next OLDER entry on the same map and measure — the "changed from" half of the
 * sentence. AI-drafted entries not yet confirmed (they carry `status`) are never a previous value.
 */
export function withPrevious(history) {
  const list = Array.isArray(history) ? history : [];
  return list.map((h, i) => {
    if (!h || h.previous !== undefined) return h;
    for (let j = i + 1; j < list.length; j++) {
      const o = list[j];
      if (o && !o.status && (o.map ?? null) === (h.map ?? null) && o.measure === h.measure) return { ...h, previous: o.value };
    }
    return { ...h, previous: undefined };
  });
}

/**
 * One history entry as its three parts, matching screen 11's row: `{date, text, by}`.
 *   date "1 Oct 2026"
 *   text "Stance changed from Neutral (0) to Supportive (+1) on EU convener (IA)"
 *   by   "— rated by Jakob M." / "— imported from the Coda Mind Map" / ""
 * `entry.previous` (see withPrevious) turns "rated" into "changed from … to …". `withMap: false`
 * leaves out "on <map>" (inside a group already headed by that map). `labels.measures` names the
 * measures; `labels.sources` may rename an import source.
 */
export function historyParts(entry, labels = {}, { withMap = true } = {}) {
  const e = entry || {};
  const m = measureLabel(e.measure, labels);
  const v = valueText(e.measure, e.value);
  const on = withMap && e.map ? ` on ${e.map}` : "";
  let text, by = "";
  if (e.author && e.status) {
    // AI-drafted and not confirmed (or rejected): never "rated by".
    const tail = /reject/i.test(e.status) ? " — rejected" : " — not yet confirmed";
    text = `AI drafted a ${m.toLowerCase()} of ${e.measure === "stance" ? stanceWithValue(e.value) : valueText(e.measure, e.value)}${on}${tail}`;
  } else {
    const prev = e.previous;
    if (prev !== undefined && prev !== null && String(prev) !== String(e.value) && !isText(e.value)) {
      text = `${m} changed from ${valueText(e.measure, prev)} to ${v}${on}`;
    } else if (isText(e.value)) {
      text = `${m} set to ${v}${on}`;
    } else {
      text = `${m} rated ${v}${on}`;
    }
    if (e.judged_by) by = `— rated by ${e.judged_by}`;
    else if (e.source) {
      const src = (labels.sources && labels.sources[e.source]) || e.source;
      by = `— imported from ${src}`;
    } else if (e.author) by = `— drafted by AI, confirmed`;
  }
  return { date: formatDay(e.as_of), text, by };
}

/** One history entry as one sentence: "1 Oct 2026 · Stance changed from Neutral (0) to Supportive
 *  (+1) on EU convener (IA) — rated by Jakob M." */
export function historySentence(entry, labels = {}, opts = {}) {
  const p = historyParts(entry, labels, opts);
  return [p.date ? `${p.date} · ${p.text}` : p.text, p.by].filter(Boolean).join(" ");
}

/**
 * History laid out for the section: up to `groupOver` (10) entries → ONE ungrouped list (map shown
 * in each sentence); more → grouped by map (in order of each map's newest entry), each group
 * showing `show` (5) with the rest behind "Show n more". Returns
 * `[{map, title, count, entries:[{parts, sentence}], hidden:[{parts, sentence}], moreLabel}]`;
 * `map` is null for the ungrouped list. `currentMap` titles that map's group "On this map".
 */
export function historyGroups(history, labels = {}, { groupOver = 10, show = 5, currentMap = null } = {}) {
  const list = withPrevious(history).filter(Boolean);
  const row = (h, withMap) => ({ parts: historyParts(h, labels, { withMap }), sentence: historySentence(h, labels, { withMap }) });
  if (list.length <= groupOver) {
    return [{ map: null, title: null, count: list.length, entries: list.map((h) => row(h, true)), hidden: [], moreLabel: null }];
  }
  const by = new Map();
  for (const h of list) {
    const k = h.map ?? "";
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(h);
  }
  return [...by.entries()].map(([k, hs]) => {
    const rows = hs.map((h) => row(h, false));
    const hidden = rows.slice(show);
    return {
      map: k || null,
      title: currentMap && k === currentMap ? "On this map" : (k || "Across all maps"),
      count: hs.length,
      entries: rows.slice(0, show),
      hidden,
      moreLabel: hidden.length ? `Show ${hidden.length} more` : null,
    };
  });
}

const CHEV = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>';

function hrow(doc, parts) {
  const r = doc.createElement("div");
  r.className = "hrow";
  const d = doc.createElement("span");
  d.className = "d";
  d.textContent = parts.date;
  const by = doc.createElement("span");
  by.className = "by";
  by.textContent = parts.by;
  r.append(d, doc.createTextNode(`${parts.date ? " · " : ""}${parts.text} `), by);
  return r;
}

/** Fill `el` with the History section's body (screen 11): sentences, grouped by map past 10
 *  entries, "Show n more" per group. Text only. Returns `el`. */
export function renderHistory(el, history, labels = {}, opts = {}) {
  const doc = el.ownerDocument;
  el.replaceChildren();
  const groups = historyGroups(history, labels, opts);
  if (!groups.length || (groups.length === 1 && !groups[0].count)) {
    const p = doc.createElement("div");
    p.className = "quiet";
    p.textContent = "No history yet.";
    el.append(p);
    return el;
  }
  for (const g of groups) {
    const wrap = doc.createElement("div");
    const list = doc.createElement("div");
    list.className = "hist";
    for (const r of g.entries) list.append(hrow(doc, r.parts));
    if (g.hidden.length) {
      const more = doc.createElement("button");
      more.type = "button";
      more.className = "quietbtn";
      more.style.alignSelf = "flex-start";
      more.style.marginTop = "4px";
      more.textContent = g.moreLabel;
      more.addEventListener("click", () => {
        for (const r of g.hidden) list.insertBefore(hrow(doc, r.parts), more);
        more.remove();
      });
      list.append(more);
    }
    if (g.title) {
      const head = doc.createElement("button");
      head.type = "button";
      head.className = "hgrp";
      head.setAttribute("aria-expanded", "true");
      head.innerHTML = CHEV;   // static markup, no data
      const count = doc.createElement("span");
      count.className = "quiet";
      count.style.marginLeft = "auto";
      count.style.fontWeight = "600";
      count.textContent = `${g.count} ${g.count === 1 ? "entry" : "entries"}`;
      head.append(doc.createTextNode(g.title), count);
      head.addEventListener("click", () => {
        const open = head.getAttribute("aria-expanded") !== "true";
        head.setAttribute("aria-expanded", String(open));
        list.hidden = !open;
      });
      wrap.append(head);
    }
    wrap.append(list);
    el.append(wrap);
  }
  return el;
}

/* ---------------------------------------------------------------------------------------------
   Undo toast — one at a time (HANDOFF §4 "Editing")
   ------------------------------------------------------------------------------------------- */

let currentToast = null;
export const TOAST_MS = 8000;

/**
 * Show "message · Undo" at the foot of the page (pm.css .toast, screen 10). One toast at a time:
 * a new one replaces the old (whose undo is then no longer offered). It dismisses itself after
 * `ms` (paused while the pointer or focus is on it); Undo calls `onUndo` once and dismisses.
 * Without `onUndo` there is no button (e.g. "Link ended · it stays in History").
 * `role="status"` + `aria-live="polite"` so a screen reader hears it. Returns `{el, dismiss}`,
 * or null without a DOM. The toast goes inside the page's `.pm` root so it takes its tokens.
 */
export function undoToast(message, onUndo = null, { doc = globalThis.document, ms = TOAST_MS,
  setTimer = (f, t) => setTimeout(f, t), clearTimer = (h) => clearTimeout(h), undoLabel = "Undo" } = {}) {
  if (!doc || typeof doc.createElement !== "function") return null;
  if (currentToast) currentToast.dismiss();
  const el = doc.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  const text = doc.createElement("span");
  text.textContent = String(message ?? "");
  el.append(text);
  let timer = null, done = false;
  const handle = {
    el,
    dismiss() {
      if (done) return;
      done = true;
      if (timer != null) clearTimer(timer);
      el.remove();
      if (currentToast === handle) currentToast = null;
    },
  };
  const arm = () => { if (!done) { if (timer != null) clearTimer(timer); timer = setTimer(() => handle.dismiss(), ms); } };
  const hold = () => { if (timer != null) { clearTimer(timer); timer = null; } };
  if (typeof onUndo === "function") {
    const b = doc.createElement("button");
    b.type = "button";
    b.textContent = undoLabel;
    b.addEventListener("click", () => {
      if (done) return;
      handle.dismiss();
      onUndo();
    });
    el.append(b);
  }
  el.addEventListener("mouseenter", hold);
  el.addEventListener("focusin", hold);
  el.addEventListener("mouseleave", arm);
  el.addEventListener("focusout", arm);
  const root = (doc.querySelector && doc.querySelector(".pm")) || doc.body || doc.documentElement;
  root.append(el);
  currentToast = handle;
  arm();
  return handle;
}

/* ---------------------------------------------------------------------------------------------
   K4 <tfs-section>
   ------------------------------------------------------------------------------------------- */

export const SECTION_KEY_PREFIX = "tfs-pm-section:";

/** Whether a section starts open: what this viewer last chose for `key`, else the `open` attribute. */
export function sectionOpen(storage, key, defaultOpen) {
  if (key) {
    const v = storage.get(SECTION_KEY_PREFIX + key);
    if (v === "1") return true;
    if (v === "0") return false;
  }
  return !!defaultOpen;
}
export function rememberSection(storage, key, open) {
  if (key) storage.set(SECTION_KEY_PREFIX + key, open ? "1" : "0");
}

/** The ⓘ popover's lines from an `info` attribute: split on "|" or new lines, blanks dropped. */
export function infoLines(text) {
  return String(text ?? "").split(/\s*\|\s*|\n+/).map((s) => s.trim()).filter(Boolean);
}

let uid = 0;
const nextId = (p) => `${p}-${++uid}`;

/**
 * <tfs-section heading="Who at TFS knows them" kind-table="power_map_judgement"
 *              kind-label="Computed" key="<map>:who" count="3" open
 *              info="Worked out from meetings… | Met in the last year · … | “No meeting logged” is…">
 *   …body…
 * </tfs-section>
 * The whole heading is the toggle (a button with aria-expanded, 18px chevron, ≥46px tall).
 * Open/closed is remembered per `key` for this viewer. The ⓘ lines may also come from a child
 * `<div slot="info">` (each child element one line). Children are the body, including ones added
 * after the element is on the page; `el.body` is the body element. Fires `tfs-toggle` {open, key}.
 * `kind-tone="ai"` gives the tag the AI-drafted colour.
 */
export class TfsSection extends Base {
  static get observedAttributes() { return ["heading", "count", "kind-table", "kind-label"]; }
  constructor() { super(); this._built = false; this._storage = pmStorage(); }

  get open() { return this._open === true; }
  set open(v) { this._setOpen(!!v, false); }
  get body() { return this._body || null; }

  connectedCallback() {
    ensurePmCss(this.ownerDocument);
    if (!this._built) this._build();
    if (!this._mo && globalThis.MutationObserver) {
      this._mo = new MutationObserver(() => this._adopt());
      this._mo.observe(this, { childList: true });
    }
    this._adopt();
  }
  disconnectedCallback() {
    if (this._mo) { this._mo.disconnect(); this._mo = null; }
    this._closeInfo();
  }
  attributeChangedCallback() { if (this._built) this._renderHead(); }

  _build() {
    const doc = this.ownerDocument;
    this._built = true;
    this.classList.add("sec");
    const bodyId = nextId("tfs-sec");
    this._head = doc.createElement("button");
    this._head.type = "button";
    this._head.className = "sechead";
    this._head.setAttribute("aria-controls", bodyId);
    this._head.addEventListener("click", () => this._setOpen(!this.open, true));
    this._body = doc.createElement("div");
    this._body.className = "secbody";
    this._body.id = bodyId;
    this._row = doc.createElement("div");
    this._row.style.display = "flex";
    this._row.style.alignItems = "center";
    this._row.append(this._head);
    this._renderHead();
    this.append(this._row, this._body);
    this._adopt();
    this._setOpen(sectionOpen(this._storage, this.getAttribute("key"), this.hasAttribute("open")), false);
  }

  _renderHead() {
    const doc = this.ownerDocument;
    const h = this._head;
    h.innerHTML = CHEV;   // static markup, no data
    const t = doc.createElement("span");
    t.className = "t";
    t.textContent = this.getAttribute("heading") || "";
    h.append(t);
    const count = this.getAttribute("count");
    if (count) {
      const n = doc.createElement("span");
      n.className = "n";
      n.textContent = count;
      h.append(n);
    }
    if (this.hasAttribute("kind-table") || this.hasAttribute("kind-label")) {
      const k = doc.createElement("tfs-kind");
      k.setAttribute("table", this.getAttribute("kind-table") || "");
      if (this.getAttribute("kind-label")) k.setAttribute("label", this.getAttribute("kind-label"));
      k.classList.add("ktag");
      if (this.getAttribute("kind-tone") === "ai") k.classList.add("ai");
      h.append(k);
    }
    this._renderInfo();
  }

  _renderInfo() {
    const doc = this.ownerDocument;
    if (this._info) { this._info.remove(); this._info = null; }
    const slot = [...this.children].find((c) => c.getAttribute && c.getAttribute("slot") === "info");
    let lines = infoLines(this.getAttribute("info"));
    if (slot) {
      const kids = [...slot.children];
      lines = kids.length ? kids.map((k) => k.textContent.trim()).filter(Boolean) : infoLines(slot.textContent);
      slot.remove();
      this._slotLines = lines;
    } else if (!lines.length && this._slotLines) lines = this._slotLines;
    if (!lines.length) { this._head.style.flex = ""; return; }
    this._head.style.flex = "1";
    const wrap = doc.createElement("span");
    wrap.className = "info";
    wrap.style.marginRight = "10px";
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "infobtn";
    btn.setAttribute("aria-label", this.getAttribute("info-label") || "How this is worked out");
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 8h.01"></path></svg>';
    const pop = doc.createElement("span");
    pop.className = "infopop";
    pop.setAttribute("role", "note");
    pop.id = nextId("tfs-info");
    pop.hidden = true;
    btn.setAttribute("aria-controls", pop.id);
    for (const l of lines) { const s = doc.createElement("span"); s.textContent = l; pop.append(s); }
    btn.addEventListener("click", (e) => { e.stopPropagation(); pop.hidden ? this._openInfo() : this._closeInfo(); });
    wrap.append(btn, pop);
    this._row.append(wrap);
    this._info = wrap; this._infoBtn = btn; this._infoPop = pop;
  }
  _openInfo() {
    if (!this._infoPop) return;
    this._infoPop.hidden = false;
    this._infoBtn.setAttribute("aria-expanded", "true");
    const doc = this.ownerDocument;
    this._offInfo = (e) => {
      if (e.type === "keydown" && e.key !== "Escape") return;
      if (e.type === "pointerdown" && this._info.contains(e.target)) return;
      this._closeInfo();
      if (e.type === "keydown") this._infoBtn.focus();
    };
    doc.addEventListener("pointerdown", this._offInfo, true);
    doc.addEventListener("keydown", this._offInfo, true);
  }
  _closeInfo() {
    if (this._infoPop) { this._infoPop.hidden = true; this._infoBtn.setAttribute("aria-expanded", "false"); }
    if (this._offInfo) {
      const doc = this.ownerDocument;
      doc.removeEventListener("pointerdown", this._offInfo, true);
      doc.removeEventListener("keydown", this._offInfo, true);
      this._offInfo = null;
    }
  }

  /** Move any direct child that is not our own heading row or body into the body. */
  _adopt() {
    if (!this._built) return;
    const strays = [...this.childNodes].filter((n) => n !== this._row && n !== this._body);
    for (const n of strays) {
      if (n.getAttribute && n.getAttribute("slot") === "info") { this._renderInfo(); continue; }
      this._body.append(n);
    }
  }

  _setOpen(open, byPerson) {
    this._open = open;
    if (!this._head) return;
    this._head.setAttribute("aria-expanded", String(open));
    this._body.hidden = !open;
    if (byPerson) {
      rememberSection(this._storage, this.getAttribute("key"), open);
      this.dispatchEvent(new CustomEvent("tfs-toggle", { bubbles: true, detail: { open, key: this.getAttribute("key") } }));
    }
  }
}

/* ---------------------------------------------------------------------------------------------
   K6 <tfs-view-switch>
   ------------------------------------------------------------------------------------------- */

export const VIEW_KEY_PREFIX = "tfs-pm-view:";
export const VIEW_LABELS = { rings: "Rings", network: "Network", list: "List", cards: "Cards" };
const VIEW_ICONS = {
  rings: '<circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="5.5"></circle><circle cx="12" cy="12" r="2"></circle>',
  network: '<circle cx="6" cy="7" r="2.5"></circle><circle cx="18" cy="6" r="2.5"></circle><circle cx="12" cy="17" r="2.5"></circle><path d="M8.3 8.3l2.6 6.3M15.8 7.6l-2.8 7.2M8.5 6.8l7-.6"></path>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"></path>',
  cards: '<rect x="4" y="4" width="7" height="7" rx="1.5"></rect><rect x="13" y="4" width="7" height="7" rx="1.5"></rect><rect x="4" y="13" width="7" height="7" rx="1.5"></rect><rect x="13" y="13" width="7" height="7" rx="1.5"></rect>',
};

/** "rings, network,,list" → ["rings","network","list"] (unique, in order). */
export function parseViews(s) {
  return [...new Set(String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean))];
}
export function viewLabel(v) {
  if (VIEW_LABELS[v]) return VIEW_LABELS[v];
  const s = String(v || "").replace(/[_-]/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The view to open: this viewer's last choice for this map, else the page's `value`, else the
 *  map's `default`, else the first view. A remembered or given view no longer offered is skipped. */
export function resolveView({ views, stored = null, value = null, def = null }) {
  for (const v of [stored, value, def]) if (v && views.includes(v)) return v;
  return views[0] || null;
}

/**
 * <tfs-view-switch views="rings,network,list,cards" key="<map id>" default="rings"></tfs-view-switch>
 * A segmented control (pm.css .seg; buttons with aria-pressed). `value` reads/sets the view.
 * A person's click remembers the view for this viewer and this `key`, and fires
 * `tfs-view-change` {view}. Left/Right arrows move between views.
 */
export class TfsViewSwitch extends Base {
  static get observedAttributes() { return ["views", "value", "default", "key"]; }
  constructor() { super(); this._storage = pmStorage(); this._value = null; }

  get views() { return parseViews(this.getAttribute("views") || "rings,network,list,cards"); }
  get value() { return this._value; }
  set value(v) { if (this.views.includes(v)) { this._value = v; this._paint(); } }

  connectedCallback() {
    ensurePmCss(this.ownerDocument);
    this._pick();
    this._render();
  }
  attributeChangedCallback(name) {
    if (!this.isConnected) return;
    if (name === "value") { this.value = this.getAttribute("value"); return; }
    this._pick();
    this._render();
  }
  _storeKey() { const k = this.getAttribute("key"); return k ? VIEW_KEY_PREFIX + k : null; }
  _pick() {
    const k = this._storeKey();
    this._value = resolveView({ views: this.views, stored: k ? this._storage.get(k) : null,
      value: this._value || this.getAttribute("value"), def: this.getAttribute("default") });
  }
  _render() {
    const doc = this.ownerDocument;
    const nav = doc.createElement("nav");
    nav.className = "seg";
    nav.setAttribute("aria-label", this.getAttribute("label") || "View");
    this._buttons = this.views.map((v) => {
      const b = doc.createElement("button");
      b.type = "button";
      b.dataset.view = v;
      if (VIEW_ICONS[v]) {
        b.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">${VIEW_ICONS[v]}</svg>`;   // static
      }
      b.append(doc.createTextNode(viewLabel(v)));
      b.addEventListener("click", () => this._choose(v));
      b.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        const vs = this.views, i = vs.indexOf(v);
        const next = vs[(i + (e.key === "ArrowRight" ? 1 : vs.length - 1)) % vs.length];
        this._choose(next);
        const nb = this._buttons.find((x) => x.dataset.view === next);
        if (nb) nb.focus();
      });
      return b;
    });
    nav.append(...this._buttons);
    this.replaceChildren(nav);
    this._paint();
  }
  _paint() {
    for (const b of this._buttons || []) b.setAttribute("aria-pressed", String(b.dataset.view === this._value));
  }
  _choose(v) {
    if (v === this._value) return;
    this._value = v;
    const k = this._storeKey();
    if (k) this._storage.set(k, v);
    this._paint();
    this.dispatchEvent(new CustomEvent("tfs-view-change", { bubbles: true, detail: { view: v } }));
  }
}

/* ---------------------------------------------------------------------------------------------
   K5 <tfs-record-peek>
   ------------------------------------------------------------------------------------------- */

const BODY_FIELDS = ["notes", "body", "description", "details", "summary"];
const TYPE_FIELDS = ["type", "entry_type", "kind"];
const BY_FIELDS = ["logged_by", "created_by", "author", "owner"];

/** A display value (string, {row_id,label}, or a list of either) as words; "" when empty. */
export function displayText(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(displayText).filter(Boolean).join(", ");
  if (typeof v === "object") return v.label != null ? String(v.label) : (v.name != null ? String(v.name) : "");
  return String(v);
}

/**
 * What the peek shows for a `get_record_for_editing` answer: `{title, date, type, by, body,
 * canEdit, source}`. `title` is the record's label (else its `title` value); `body` its notes /
 * body / description; `canEdit` is true only when at least one field is editable for this
 * person. `source` is the page's `_source` URL when given, else the record's own (http(s) only).
 */
export function peekView(rec, { source = null } = {}) {
  const r = rec || {};
  const vals = r.values || {};
  const first = (names) => { for (const n of names) { const t = displayText(vals[n]).trim(); if (t) return t; } return ""; };
  const ed = r.editable || {};
  return {
    title: (displayText(vals.title).trim() || displayText(r.label).trim() || "Untitled"),
    date: formatDay(displayText(vals.date)),
    type: first(TYPE_FIELDS),
    by: first(BY_FIELDS),
    body: (() => { for (const n of BODY_FIELDS) { const t = displayText(vals[n]); if (t.trim()) return t; } return ""; })(),
    canEdit: Object.values(ed).some((v) => v === true),
    source: safeHref(source) || safeHref(r.source) || null,
  };
}

/** The meta line under the title: "18 Sep 2026 · Meeting · logged by Jakob M." */
export function peekMeta(view) {
  return [view.date, view.type, view.by ? `logged by ${view.by}` : ""].filter(Boolean).join(" · ");
}

const BACK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"></path></svg>';

/**
 * <tfs-record-peek table="kms_entries" row="i-…" source="<the _source URL>" editable></tfs-record-peek>
 * A record opened in the page (screen 11): pm.css `.peek` covers its nearest positioned
 * ancestor (the details panel / bottom sheet). Reads the record FRESH via get_record_for_editing
 * and shows its title, date, type and body. "Edit" (only with the `editable` attribute AND when
 * the server says a field is editable for this person) swaps in <tfs-record-form table row>;
 * a save re-reads, Cancel returns to the read view. "Open in Coda ↗" uses `source`.
 * Closes on ×, Esc, or a press outside it: fires `tfs-close` (cancelable; bubbles) and hides.
 * `el.reload()` reads again. `el.transport` as every kit element.
 */
export class TfsRecordPeek extends Base {
  static get observedAttributes() { return ["table", "row", "source"]; }
  constructor() { super(); this._seq = 0; this._editing = false; this.record = null; }

  get transport() { return transportOf(this); }
  set transport(t) { this._transport = t; if (this.isConnected) this.reload(); }
  get table() { return this.getAttribute("table") || ""; }
  get rowId() { return this.getAttribute("row") || ""; }
  get editable() { return this.hasAttribute("editable"); }
  set editable(v) { if (v) this.setAttribute("editable", ""); else this.removeAttribute("editable"); }

  connectedCallback() {
    ensurePmCss(this.ownerDocument);
    this.hidden = false;
    this._focused = false;
    this._returnFocus = this.ownerDocument.activeElement || null;
    if (!this._shell) this._build();
    const doc = this.ownerDocument;
    this._onKey = (e) => { if (e.key === "Escape" && !this._editing && !this.hidden) { e.stopPropagation(); this.close(); } };
    this._onDown = (e) => { if (!this.hidden && !this._editing && !this._shell.contains(e.target)) this.close(); };
    doc.addEventListener("keydown", this._onKey, true);
    doc.addEventListener("pointerdown", this._onDown, true);
    queueMicrotask(() => this.reload());   // after the page's `configure`
  }
  disconnectedCallback() {
    const doc = this.ownerDocument;
    doc.removeEventListener("keydown", this._onKey, true);
    doc.removeEventListener("pointerdown", this._onDown, true);
  }
  attributeChangedCallback(name) {
    if (!this.isConnected || !this._shell) return;
    if (name === "source") this._paintFoot();
    else { this._editing = false; this.reload(); }
  }

  /** Hide and tell the page (`tfs-close`, cancelable). Focus goes back where it came from. */
  close() {
    const ev = new CustomEvent("tfs-close", { bubbles: true, composed: true, cancelable: true, detail: { table: this.table, row: this.rowId } });
    if (!this.dispatchEvent(ev)) return;
    this.hidden = true;
    const back = this._returnFocus;
    if (back && back.isConnected && typeof back.focus === "function") back.focus();
  }

  _build() {
    const doc = this.ownerDocument;
    const s = doc.createElement("div");
    s.className = "peek";
    s.setAttribute("role", "dialog");
    const ph = doc.createElement("div");
    ph.className = "ph";
    this._x = doc.createElement("button");
    this._x.type = "button";
    this._x.className = "xbtn";
    this._x.setAttribute("aria-label", "Close");
    this._x.innerHTML = BACK;   // static
    this._x.addEventListener("click", () => (this._editing ? this._read() : this.close()));
    this._kind = doc.createElement("tfs-kind");
    this._kind.classList.add("ktag");
    this._type = doc.createElement("span");
    this._type.className = "quiet";
    ph.append(this._x, this._kind, this._type);
    this._pb = doc.createElement("div");
    this._pb.className = "pb";
    this._pf = doc.createElement("div");
    this._pf.className = "pf";
    s.append(ph, this._pb, this._pf);
    this._shell = s;
    this.replaceChildren(s);
  }

  async reload() {
    if (!this._shell) return;
    const seq = ++this._seq;
    this._kind.setAttribute("table", this.table);
    this._shell.setAttribute("aria-label", kindOf(this.table).label);
    this._editing = false;
    this._message("Loading…");
    this._pf.replaceChildren();
    let rec;
    try {
      rec = await this.transport.call("get_record_for_editing", { table: this.table, row_id: this.rowId }, { fresh: true });
    } catch (e) {
      if (seq !== this._seq) return;
      if (e && e.code === "server_not_connected") return this._message(`${NO_CONNECTOR.title}. ${NO_CONNECTOR.body}`);
      return this._message((e && e.message) || "The TFS server didn't answer.", true);
    }
    if (seq !== this._seq) return;
    if (!rec || rec.refused) return this._message((rec && rec.message) || "That record isn't available.", false);
    this.record = rec;
    this._read();
  }

  _message(text, retry = false) {
    const doc = this.ownerDocument;
    const p = doc.createElement("div");
    p.className = "quiet";
    p.textContent = text;
    this._pb.replaceChildren(p);
    if (retry) {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "btn-2";
      b.textContent = "Try again";
      b.addEventListener("click", () => this.reload());
      this._pb.append(b);
    }
  }

  _read() {
    const doc = this.ownerDocument;
    this._editing = false;
    this._x.setAttribute("aria-label", "Close");
    const v = peekView(this.record, { source: this.getAttribute("source") });
    this._view = v;
    this._type.textContent = v.type;
    const h = doc.createElement("h3");
    h.textContent = v.title;
    const meta = doc.createElement("div");
    meta.className = "quiet";
    meta.textContent = peekMeta(v);
    const body = doc.createElement("div");
    body.className = "tfs-peek-body";
    body.style.color = "var(--ink)";
    if (v.body.trim()) {
      // The kit's closed Markdown subset (escapes & < > first; http/https/mailto links only) —
      // the same renderer <tfs-rich-text> shows record text with.
      body.innerHTML = mdToHtml(v.body);
      for (const a of body.querySelectorAll("a[href]")) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
    } else {
      body.className = "quiet";
      body.textContent = "Nothing written in this entry yet.";
    }
    this._pb.replaceChildren(h, ...(meta.textContent ? [meta] : []), body);
    this._paintFoot();
    if (!this._focused) { this._focused = true; this._x.focus(); }
  }

  _paintFoot() {
    if (!this._view || this._editing) return;
    const doc = this.ownerDocument;
    const kids = [];
    if (this.editable && this._view.canEdit) {
      const e = doc.createElement("button");
      e.type = "button";
      e.className = "btn-2";
      e.style.minHeight = "34px";
      e.textContent = "Edit";
      e.addEventListener("click", () => this._edit());
      kids.push(e);
    }
    const href = safeHref(this.getAttribute("source")) || this._view.source;
    if (href) {
      const a = doc.createElement("a");
      a.className = "linkbtn";
      a.style.marginLeft = "auto";
      a.style.fontSize = "13px";
      a.style.textDecoration = "none";
      a.setAttribute("href", href);
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "Open in Coda ↗";
      kids.push(a);
    }
    this._pf.replaceChildren(...kids);
    this._pf.hidden = !kids.length;
  }

  _edit() {
    const doc = this.ownerDocument;
    this._editing = true;
    this._x.setAttribute("aria-label", "Back to the entry");
    const f = doc.createElement("tfs-record-form");
    f.setAttribute("table", this.table);
    f.setAttribute("row", this.rowId);
    f.setAttribute("mode", "edit");
    if (this._transport) f.transport = this._transport;
    f.addEventListener("tfs-close", (e) => { e.stopPropagation(); this._read(); });
    f.addEventListener("tfs-saved", () => { this.reload(); });
    this._pf.replaceChildren();
    this._pf.hidden = true;
    this._pb.replaceChildren(f);
  }
}

if (globalThis.customElements) {
  for (const [name, cls] of [["tfs-section", TfsSection], ["tfs-view-switch", TfsViewSwitch],
    ["tfs-record-peek", TfsRecordPeek], ["tfs-kind", TfsKind]]) {
    if (!customElements.get(name)) customElements.define(name, cls);
  }
}
