/* TFS pages kit — <tfs-task-filters>: a task filter bar each viewer can extend.
 *
 *   <tfs-task-filters bar="mine,closed,snoozed" more="owner,created,urgency,due"></tfs-task-filters>
 *
 * THE BUILDER PICKS WHAT IS ALWAYS ON THE BAR (`bar`); EACH VIEWER ADDS THE REST from
 * "+ More filters" (`more`). What a viewer adds, and the values they set, are remembered in
 * their own browser (`storage-key`), so a light user never sees more than the builder chose.
 *
 * Filters (any of them may go in `bar`; the choosers may also go in `more`):
 *   mine      toggle  "My tasks"
 *   closed    toggle  "Show closed"  — the PAGE reloads its tree with open_only=false
 *   snoozed   toggle  "Show snoozed" — OFF by default: snoozed tasks are hidden, as in Coda
 *   owner     chooser one team member (the kit's people picker)
 *   created   chooser who created the task
 *   urgency   chooser one or more levels, in Coda's order, from describe_record_form
 *   due       chooser overdue / next 7 days / next 30 days / no due date
 *
 * It runs on rows the page already has: tasks.js `taskMatcher` turns the values into one
 * predicate, and `hideSnoozed` handles the snooze toggle. NO NEW SERVER TOOLS: the people
 * picker uses search_records_for_picker and the urgency list describe_record_form, both among
 * the four page tools every kit page declares.
 *
 * Event: `tfs-filters-change` (bubbles) whenever anything changes; `detail.values` is what is in
 * force. Read `el.values` at any time; `el.matcher({me})` is the predicate (null = no filter).
 */
import { h, transportOf } from "./form.js";
import { DUE_OPTIONS, taskMatcher } from "./tasks.js";

const Base = globalThis.HTMLElement || class {};

export const TOGGLES = { mine: "My tasks", closed: "Show closed", snoozed: "Show snoozed" };
export const CHOOSERS = {
  owner: { label: "Owner", help: "Tasks one person owns" },
  created: { label: "Created by", help: "Tasks a person created, whoever owns them" },
  urgency: { label: "Urgency", help: "One or more urgency levels" },
  due: { label: "Due date", help: "Overdue, due soon, or no due date" },
};
const NARROWING = ["mine", "owner", "created", "urgency", "due"];
const isSet = (v) => v != null && v !== "" && v !== false && !(Array.isArray(v) && !v.length);

/** Browser storage that never throws (private windows, blocked site data). */
export function safeStorage(s = globalThis.localStorage) {
  return {
    get(k) { try { return s ? s.getItem(k) : null; } catch { return null; } },
    set(k, v) { try { if (s) s.setItem(k, v); } catch { /* not kept; the page still works */ } },
  };
}
const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

/**
 * The filter bar's state, without a DOM (Node-tested).
 *   bar:  the builder's always-on filters (toggles and/or choosers)
 *   more: choosers a viewer may add from the menu
 */
export class FilterState {
  constructor({ bar = ["mine", "closed", "snoozed"], more = Object.keys(CHOOSERS), storage = safeStorage(), key = "tfs-task-filters" } = {}) {
    this.bar = bar.filter((k) => k in TOGGLES || k in CHOOSERS);
    this.more = more.filter((k) => k in CHOOSERS && !this.bar.includes(k));
    this.storage = storage; this.key = key;
    this.added = []; this.vals = {};
    try {
      const saved = JSON.parse(storage.get(key) || "null");
      if (saved && typeof saved === "object") {
        if (Array.isArray(saved.added)) this.added = saved.added.filter((k) => this.more.includes(k));
        if (saved.vals && typeof saved.vals === "object") this.vals = saved.vals;
      }
    } catch { /* a corrupt saved state starts clean */ }
    for (const k of Object.keys(this.vals)) if (!this.offered(k)) delete this.vals[k];
  }
  offered(k) { return this.bar.includes(k) || this.more.includes(k); }
  /** The toggles on the bar, in the builder's order. */
  toggles() { return this.bar.filter((k) => k in TOGGLES); }
  /** The choosers on the bar: the builder's, then the ones this viewer added. */
  shown() { return [...this.bar.filter((k) => k in CHOOSERS), ...this.added]; }
  isShown(k) { return k in TOGGLES ? this.bar.includes(k) : this.shown().includes(k); }
  add(k) { if (this.more.includes(k) && !this.added.includes(k)) { this.added.push(k); this.save(); } }
  /** Take a viewer-added chooser off the bar; its value goes with it. */
  remove(k) { if (this.added.includes(k)) { this.added = this.added.filter((x) => x !== k); delete this.vals[k]; this.save(); } }
  set(k, v) { if (!this.isShown(k)) return; if (isSet(v)) this.vals[k] = v; else delete this.vals[k]; this.save(); }
  get(k) { return this.vals[k]; }
  /** What is in force: only filters that are on the bar AND set. */
  values() { const out = {}; for (const [k, v] of Object.entries(this.vals)) if (this.isShown(k) && isSet(v)) out[k] = v; return out; }
  /** Any filter that narrows the list (not the closed/snoozed view toggles). */
  narrowing() { const v = this.values(); return NARROWING.some((k) => k in v); }
  /** Clear the narrowing filters; the closed/snoozed toggles and the bar's layout stay. */
  clear() { for (const k of NARROWING) delete this.vals[k]; this.save(); }
  save() { this.storage.set(this.key, JSON.stringify({ added: this.added, vals: this.vals })); }
}

/* Urgency options per transport, from describe_record_form(tasks, edit): Coda's order. */
const urgencyCache = new WeakMap();
export function loadUrgencyOptions(transport) {
  if (!urgencyCache.has(transport)) {
    const p = Promise.resolve(transport.call("describe_record_form", { table: "tasks", mode: "edit" })).then((form) => {
      const f = form && Array.isArray(form.fields) ? form.fields.find((x) => x.name === "urgency") : null;
      return f && Array.isArray(f.options) ? f.options.map((o) => (o && typeof o === "object" ? o.value || o.label : o)).filter((x) => typeof x === "string") : [];
    });
    p.catch(() => urgencyCache.delete(transport));
    urgencyCache.set(transport, p);
  }
  return urgencyCache.get(transport);
}

export class TfsTaskFilters extends Base {
  constructor() { super(); this._built = false; this._menuOpen = false; this._urgency = null; }

  get transport() { return transportOf(this); }
  set transport(t) { this._transport = t; this._urgency = null; }
  /** The state model (built on first use from the attributes). */
  get state() {
    if (!this._state) this._state = new FilterState({
      bar: this.hasAttribute("bar") ? list(this.getAttribute("bar")) : undefined,
      more: this.hasAttribute("more") ? list(this.getAttribute("more")) : undefined,
      key: this.getAttribute("storage-key") || "tfs-task-filters",
    });
    return this._state;
  }
  /** What is in force, e.g. `{snoozed: true, urgency: ["1🔴 Critical"]}`. */
  get values() { return this.state.values(); }
  /** One predicate over task rows, or null when nothing narrows (see tasks.js taskMatcher). */
  matcher(ctx = {}) { return taskMatcher(this.values, ctx); }
  clear() { this.state.clear(); this._render(); this._changed(); }

  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.classList.add("tfs-filters");
    this.setAttribute("role", "group");
    if (!this.getAttribute("aria-label")) this.setAttribute("aria-label", "Task filters");
    this._onDoc = (e) => { if (this._menuOpen && !this.contains(e.target)) this._setMenu(false); };
    // On the document, not the element: ticking a box redraws the menu, and the page's focus may
    // have moved anywhere since. Escape closes an open menu and returns focus to its button.
    this._onKey = (e) => { if (e.key === "Escape" && this._menuOpen && !e.defaultPrevented) { e.preventDefault(); this._setMenu(false); if (this._moreBtn) this._moreBtn.focus(); } };
    document.addEventListener("click", this._onDoc);
    document.addEventListener("keydown", this._onKey);
    // One microtask later: the page's own module code may still be running `configure`.
    queueMicrotask(() => this._render());
  }
  disconnectedCallback() {
    if (this._onDoc) document.removeEventListener("click", this._onDoc);
    if (this._onKey) document.removeEventListener("keydown", this._onKey);
    this._built = false;
  }

  _changed() { this.dispatchEvent(new CustomEvent("tfs-filters-change", { bubbles: true, detail: { values: this.values } })); }

  _render() {
    const st = this.state;
    const row = h("div", { class: "tfs-filters__row" });
    for (const k of st.toggles()) {
      const cb = h("input", { type: "checkbox" }); cb.checked = !!st.get(k);
      cb.addEventListener("change", () => { st.set(k, cb.checked); this._render(); this._changed(); });
      row.append(h("label", { class: "tfs-filters__toggle" + (cb.checked ? " is-on" : "") }, cb, h("span", { text: TOGGLES[k] })));
    }
    if (st.more.length) {
      this._moreBtn = h("button", { type: "button", class: "tfs-btn tfs-btn--small tfs-filters__more", "aria-expanded": String(this._menuOpen), "aria-haspopup": "true", text: "+ More filters" });
      this._moreBtn.addEventListener("click", (e) => { e.stopPropagation(); this._setMenu(!this._menuOpen); });
      const wrap = h("span", { class: "tfs-filters__morewrap" }, this._moreBtn);
      if (this._menuOpen) wrap.append(this._menu());
      row.append(wrap);
    }
    if (st.narrowing()) {
      const clr = h("button", { type: "button", class: "tfs-btn tfs-btn--small tfs-btn--quiet", text: "Clear filters" });
      clr.addEventListener("click", () => this.clear());
      row.append(clr);
    }
    const choosers = h("div", { class: "tfs-filters__row tfs-filters__choosers" });
    for (const k of st.shown()) choosers.append(this._chooser(k));
    this.replaceChildren(row);
    if (st.shown().length) this.append(choosers);
  }

  _setMenu(open) { this._menuOpen = open; this._render(); if (open) { const first = this.querySelector(".tfs-filters__menu input"); if (first) first.focus(); } }

  _menu() {
    const st = this.state;
    const m = h("div", { class: "tfs-filters__menu", role: "group", "aria-label": "Add filters" },
      h("div", { class: "tfs-filters__menuhead", text: "Show on the bar · remembered for you" }));
    for (const k of st.more) {
      const cb = h("input", { type: "checkbox" }); cb.checked = st.shown().includes(k);
      cb.dataset.filter = k;
      cb.addEventListener("change", () => {
        if (cb.checked) st.add(k); else st.remove(k);
        this._render(); this._changed();
        const again = this.querySelector(`.tfs-filters__menu input[data-filter="${k}"]`); if (again) again.focus();
      });
      m.append(h("label", { class: "tfs-filters__option" }, cb, h("span", { text: CHOOSERS[k].label }), h("small", { text: CHOOSERS[k].help })));
    }
    m.addEventListener("click", (e) => e.stopPropagation());
    return m;
  }

  _chooser(k) {
    const st = this.state; const on = st.get(k) != null && isSet(st.get(k));
    const box = h("span", { class: "tfs-filters__chooser" + (on ? " is-on" : "") }, h("span", { class: "tfs-filters__label", text: CHOOSERS[k].label }));
    if (k === "owner" || k === "created") {
      const pk = document.createElement("tfs-picker");
      pk.setAttribute("entity-type", "team_member");
      if (this._transport) pk.transport = this._transport;
      const cur = st.get(k);
      if (cur) pk.value = cur;
      pk.addEventListener("change", () => { const it = pk.items[0] || null; st.set(k, it ? { row_id: it.row_id, label: it.label } : null); this._render(); this._changed(); });
      box.append(pk);
    } else if (k === "due") {
      const sel = h("select", { "aria-label": CHOOSERS.due.label }, h("option", { value: "", text: "Any" }), ...DUE_OPTIONS.map(([v, l]) => h("option", { value: v, text: l })));
      sel.value = st.get("due") || "";
      sel.addEventListener("change", () => { st.set("due", sel.value || null); this._render(); this._changed(); });
      box.append(sel);
    } else if (k === "urgency") {
      const chips = h("span", { class: "tfs-filters__chips" }, h("span", { class: "tfs-filters__hint", text: "Loading…" }));
      box.append(chips);
      if (!this._urgency) this._urgency = loadUrgencyOptions(this.transport);
      this._urgency.then((opts) => {
        const cur = new Set(st.get("urgency") || []);
        chips.replaceChildren(...(opts.length ? opts.map((u) => {
          const b = h("button", { type: "button", "aria-pressed": String(cur.has(u)), text: u });
          b.addEventListener("click", () => { cur.has(u) ? cur.delete(u) : cur.add(u); st.set("urgency", [...cur]); this._render(); this._changed(); });
          return b;
        }) : [h("span", { class: "tfs-filters__hint", text: "No urgency levels available" })]));
      }, () => { this._urgency = null; chips.replaceChildren(h("span", { class: "tfs-filters__hint", text: "Couldn't load urgency levels." })); });
    }
    if (st.added.includes(k)) {
      const x = h("button", { type: "button", class: "tfs-filters__x", "aria-label": `Remove the ${CHOOSERS[k].label} filter`, title: "Remove this filter from the bar", text: "×" });
      x.addEventListener("click", () => { st.remove(k); this._render(); this._changed(); });
      box.append(x);
    }
    return box;
  }
}
