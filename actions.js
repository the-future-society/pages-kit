/* TFS pages kit — one-gesture actions: <tfs-status-menu> and <tfs-delete-task> (design pass
 * 2026-10-07, HANDOVER "Status menu" and "Delete confirmation").
 *
 *   <tfs-status-menu table="tasks" row="ROW-ID" value="In Progress"></tfs-status-menu>
 *   <tfs-delete-task row="ROW-ID" title="Draft the brief"></tfs-delete-task>
 *
 * The status menu's foot carries a quiet "Refresh from Coda" (2026-10-07): get_record_for_editing
 * with `refresh: true` re-reads the record from Coda into TFS's copy, for a change made in Coda
 * that hasn't reached the page. It sends `tfs-refreshed` so the page can redraw its lists.
 *
 * THE STATUS MENU SAVES ON PICK. No Save button: picking a different status loads the record
 * (for its `row_version`), previews the save, and saves at once unless the preview says someone
 * changed the record since — then it asks, inside the menu. It is the form's save machine
 * (`SaveMachine`), so a dropped connection is outcome-unknown, never "failed", and a create is
 * never involved. Options, their order and their colours come from `describe_record_form`.
 *
 * DELETE IS TWO DELIBERATE CALLS. `delete_record` with `preview: true` checks and returns a
 * `confirm_code`; only the person's press of "Delete task" sends `preview: false` with it. A
 * refusal deleted nothing; an unknown outcome may have deleted, so the person checks Coda.
 *
 * Both use the same transport as <tfs-record-form> (`configure` / `el.transport`). Each model
 * is a plain class over a transport so Node tests the whole sequence without a DOM.
 */
import { SaveMachine } from "./save.js";
import { paintStatusChip } from "./status-colour.js";
import { icon } from "./icons.js";
import {
  transportOf, loadStatusOptions, StatusMenu, msgEl, codaLink, h, nextId, spinner, statusChip,
  conflictCopy, nounOf, safeHref,
} from "./form.js";

const Base = globalThis.HTMLElement || class {};

/* ===========================================================================
   Status: the model (pure; Node-tested)
   ========================================================================= */

/** A pick that is saved but not yet in TFS's copy of Coda: a page that redraws from a list
 * read straight after the save gets the OLD value back. For this long after a save, an element
 * given that old value shows the saved one, marked "waiting for TFS to catch up". */
export const SYNC_WINDOW_MS = 10 * 60 * 1000;
const recentSaves = new Map();

/** The value to show instead of `served`, or null. Forgets the save once the served value has
 * caught up (or the window has passed). */
export function syncingValue(store, key, served, now = Date.now()) {
  const s = store.get(key);
  if (!s) return null;
  if (now - s.at > SYNC_WINDOW_MS || s.value === served) { store.delete(key); return null; }
  return s.value;
}

/** What the menu does once a pick has settled (HANDOVER "Status menu"): saved closes it; a
 * question, a refusal and an unknown outcome keep it OPEN with a message and the items usable
 * again; an unknown outcome also marks the picked row "Unconfirmed". */
export function statusOutcome(state) {
  switch (state) {
    case "saved_syncing": return { close: true, message: null, hint: null };
    // Coda is still creating the record (ruling D2): the save goes by itself once it can.
    case "waiting_for_coda": return { close: false, message: "info", wait: true, hint: "Waiting for Coda" };
    case "confirm": return { close: false, message: "warn", ask: true, hint: null };
    case "outcome_unknown": return { close: false, message: "warn", hint: "Unconfirmed" };
    case "refused": return { close: false, message: "error", hint: null };
    default: return { close: false, message: null, hint: null };
  }
}

/** The status menu's words (kit 1.5.0). `saved(receipt)` is the quiet line after a pick: a
 * save that went in ahead of Coda says where Coda has got to; otherwise 1.3's line. */
export const STATUS_WORDS = {
  saved: (r) => (r && r.confirmation && typeof r.confirmation === "object"
    ? "Saved — waiting for Coda to confirm" : "Saved · shows on pages within a few minutes"),
  waitingTitle: "Coda is still creating this record",
  waitingBody: "Keep this open — this status will save automatically once Coda has finished creating the record.",
  closeAsk: "Your change hasn't saved yet. Close anyway and lose it?",
};

export class StatusSave {
  /**
   * @param {object} o
   * @param {{call: Function}} o.transport
   * @param {string} o.table
   * @param {string} o.row
   * @param {string} [o.field]
   */
  constructor({ transport, table, row, field = "status" }) {
    Object.assign(this, { transport, table, row, field });
    this.machine = null; this._rec = null; this.source = null;
  }

  /** The options, in Coda's order, with their colours (cached per table). */
  options() { return loadStatusOptions(this.transport, this.table, this.field); }

  /** Load the record (once; again after a save) for its `row_version`. */
  ready() {
    if (!this._rec) {
      this._rec = Promise.resolve(this.transport.call("get_record_for_editing", { table: this.table, row_id: this.row }, { fresh: true }))
        .then((rec) => {
          if (!rec || rec.refused) throw { code: (rec && rec.refused) || "refused", message: (rec && rec.message) || "That record isn't available." };
          // Keep a machine whose outcome is unknown: a retry of the SAME pick reuses its key.
          // …and one waiting for Coda to finish creating the record: it saves by itself.
          if (!this.machine || !(this.machine.state === "outcome_unknown" || this.machine.holdsWaitingChange)) {
            if (this.machine) this.machine.stopWatch();
            this.machine = new SaveMachine({ transport: this.transport, table: this.table, rowId: this.row,
              rowVersion: rec.row_version, source: rec.source || null, confirmation: rec.confirmation || null,
              watchSaves: false });
          }
          this.source = rec.source || null;
          return rec;
        });
      this._rec.catch(() => { this._rec = null; });
    }
    return this._rec;
  }

  /** Save `value`: preview, then save at once unless the preview warns. Resolves to the
   * machine's state: saved_syncing | confirm | refused | outcome_unknown | idle. */
  async pick(value) {
    await this.ready();
    await this.machine.submit({ [this.field]: value });
    return this._settled();
  }

  async confirm() { await this.machine.confirm(); return this._settled(); }

  /** "Refresh from Coda": the server re-reads the record from Coda into TFS's copy, then answers
   * with it. Resolves `{outcome, message, value}` — `value` is the field as TFS now holds it.
   * Outcomes: updated | unchanged | not_returned | unavailable. A re-read can itself be stale
   * (Coda's API lags its own app), so nothing here claims the record is now up to date. */
  async refreshFromCoda() {
    const rec = await this.transport.call("get_record_for_editing", { table: this.table, row_id: this.row, refresh: true }, { fresh: true });
    if (!rec || rec.refused) {
      return { outcome: "unavailable", message: (rec && rec.message) || "That record isn't available.", value: null };
    }
    this._rec = null;   // the next pick loads a fresh row_version
    const r = rec.refreshed || { outcome: "unavailable", message: "This page's TFS server can't refresh from Coda yet." };
    const v = rec.values ? rec.values[this.field] : null;
    return { outcome: r.outcome, message: r.message, value: v && typeof v === "object" ? (v.value ?? v.label ?? null) : (v ?? null) };
  }
  cancel() { if (this.machine) this.machine.cancel(); }

  _settled() {
    const st = this.machine.state;
    if (st === "saved_syncing") this._rec = null;   // re-read before the next pick: a fresh token
    return st;
  }
}

/* ===========================================================================
   <tfs-status-menu table row value [field] [display]>
   ========================================================================= */

export class TfsStatusMenu extends Base {
  static get observedAttributes() { return ["value"]; }

  constructor() { super(); this._built = false; this._options = null; }

  get transport() { return transportOf(this); }
  set transport(t) { this._transport = t; this._model = null; }
  get table() { return this.getAttribute("table") || "tasks"; }
  get field() { return this.getAttribute("field") || "status"; }
  get key() { return `${this.table}|${this.getAttribute("row") || ""}|${this.field}`; }
  /** "menu" (default: a chip that opens the menu), "chip" (display only), "context" (a finished
   * parent kept for its open sub-tasks: a quiet label, not a chip). */
  get display() { return this.getAttribute("display") || "menu"; }
  get value() { return this._shown(); }

  _shown() {
    const served = this.getAttribute("value");
    return syncingValue(recentSaves, this.key, served) ?? served;
  }
  get syncing() { return syncingValue(recentSaves, this.key, this.getAttribute("value")) != null; }

  get model() {
    if (!this._model) this._model = new StatusSave({ transport: this.transport, table: this.table, row: this.getAttribute("row"), field: this.field });
    return this._model;
  }

  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this._render();
    // After the page's own `configure` has run (see form.js `configure`).
    queueMicrotask(() => this.model.options().then((o) => { this._options = o; this._render(); }).catch(() => {}));
  }

  attributeChangedCallback() {
    if (this._built && !(this._menu && (this._menu.busy || this._menu.guard))) this._render();
  }

  _colour(v) { const o = (this._options || []).find((x) => x.value === v); return o && o.color; }
  _label(v) { const o = (this._options || []).find((x) => x.value === v); return o ? o.label : v; }

  _render() {
    if (this._menu) this._menu.close(false);
    const v = this._shown();
    if (this.display === "context") {
      const el = h("span", { class: "tfs-status-context", title: `${v}. Shown because it has open sub-tasks.` },
        h("span", { class: "tfs-status-context__dot", "aria-hidden": "true" }), this._label(v),
        h("span", { class: "tfs-sr", text: ", shown because it has open sub-tasks" }));
      paintStatusChip(el, this._colour(v));
      this.replaceChildren(el); return;
    }
    if (this.display === "chip") { this.replaceChildren(statusChip(this._label(v), this._colour(v))); return; }
    const syncing = this.syncing;
    const btn = statusChip(this._label(v), this._colour(v), { tag: "button" });
    btn.type = "button";
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    btn.title = "Change status";
    btn.append(h("span", { class: "tfs-sr", text: ". Change status" }), icon(syncing ? "sync" : "chevron"));
    this._btn = btn;
    this._menu = new StatusMenu({ options: this._options || [], current: v, onPick: (val, m) => this._pick(val, m),
      onClose: () => { if (this.model.machine && this.model.machine.state === "confirm") this.model.cancel(); } });
    btn.addEventListener("click", () => this._toggle());
    btn.addEventListener("keydown", (e) => { if (e.key === "ArrowDown" && !this._menu.isOpen) { e.preventDefault(); this._open(); } });
    const face = syncing ? h("span", { class: "tfs-status-note" }, btn, "Saved; waiting for TFS to catch up") : btn;
    // Out of the way on purpose: a quiet line at the foot of the menu, for the rare case a change
    // made in Coda hasn't reached the page. Not a toolbar button.
    const refresh = h("button", { type: "button", class: "tfs-menu__foot",
      title: "Read this record again from Coda, if a change made there hasn't reached this page" }, icon("sync"), "Refresh from Coda");
    refresh.addEventListener("click", () => this._refresh(refresh));
    this._menu.el.append(refresh);
    this.replaceChildren(face, this._menu.el);
  }

  async _refresh(button) {
    if (this._menu.busy) return;
    // A change waiting for Coda holds this menu (kit 1.5.0): a refresh would close and redraw it.
    if (this.model.machine && this.model.machine.holdsWaitingChange) { this._waitNote(this._menu); return; }
    button.disabled = true;
    button.replaceChildren(icon("sync"), "Refreshing…");
    let res;
    try { res = await this.model.refreshFromCoda(); } catch (e) {
      res = { outcome: "unavailable", message: (e && e.message) || "Couldn't reach TFS just now.", value: null };
    }
    const changed = res.value != null && res.value !== this.getAttribute("value");
    this._menu.close(false);
    if (changed) { recentSaves.delete(this.key); this.setAttribute("value", res.value); }
    this._render();
    const tone = res.outcome === "updated" ? "ok" : res.outcome === "unavailable" ? "warn" : "info";
    const note = h("p", { class: `tfs-msg tfs-msg--quiet tfs-msg--${tone} tfs-refresh-note`, role: "status" }, icon(tone === "warn" ? "warn" : tone === "ok" ? "ok" : "info"), res.message);
    this.append(note);
    setTimeout(() => note.remove(), res.outcome === "updated" ? 4000 : 9000);
    if (this._btn) this._btn.focus();
    this.dispatchEvent(new CustomEvent("tfs-refreshed", { bubbles: true, composed: true,
      detail: { table: this.table, row: this.getAttribute("row"), field: this.field, outcome: res.outcome, value: res.value } }));
  }

  _toggle() { if (this._menu.isOpen) { if (!this._menu.busy) this._menu.close(true); } else this._open(); }

  /* While a pick waits for Coda: the note, and a close attempt asks first (review I2). */
  _waitNote(menu) {
    menu.showMessage(msgEl({ tone: "info", title: STATUS_WORDS.waitingTitle, paragraphs: [[STATUS_WORDS.waitingBody]] }));
  }
  _askClose(menu, value) {
    const m = this.model.machine;
    if (!m || !m.holdsWaitingChange) { menu.guard = null; menu.close(true, true); return; }
    const keep = h("button", { type: "button", class: "tfs-btn tfs-btn--small tfs-btn--primary", text: "Keep waiting" });
    const lose = h("button", { type: "button", class: "tfs-btn tfs-btn--small", text: "Close anyway" });
    keep.addEventListener("click", () => { this._waitNote(menu); menu.list.focus(); });
    lose.addEventListener("click", () => {
      menu.guard = null;
      if (this._waitOff) { this._waitOff(); this._waitOff = null; }
      m.abandonWait();
      menu.setHint(value, "");
      menu.close(true, true);
      this._render();
    });
    menu.showMessage(msgEl({ tone: "warn", paragraphs: [[STATUS_WORDS.closeAsk]] }, [keep, lose]));
  }

  async _open() {
    this.model.ready().catch(() => {});   // the token is fetched while the person looks
    if (!this._options) {
      try { this._options = await this.model.options(); } catch (e) {
        this._options = null;
        this._menu.setOptions([], this._shown());
        this._menu.open(this._btn);
        this._menu.showMessage(msgEl({ tone: "error", title: "Couldn't load the statuses", paragraphs: [[(e && e.message) || "Something went wrong."]] }));
        return;
      }
      this._menu.setOptions(this._options, this._shown());
    }
    this._menu.open(this._btn);
  }

  async _pick(value, menu) {
    const waiting = !!(this.model.machine && this.model.machine.holdsWaitingChange);
    if (waiting) { this._waitNote(menu); return; }   // one change at a time: the waiting one saves first
    menu.setSaving(value);
    let st;
    try { st = await this.model.pick(value); } catch (e) {
      menu.setIdle();
      menu.showMessage(msgEl({ tone: "error", title: "Not saved", paragraphs: [[(e && e.message) || "Something went wrong."]] }));
      return;
    }
    this._settle(st, value, menu);
  }

  _settle(st, value, menu) {
    const m = this.model.machine;
    const r = (m && m.receipt) || {};
    const out = statusOutcome(st);
    if (out.close) {
      menu.setIdle();
      recentSaves.set(this.key, { value, at: Date.now() });
      menu.close(true);
      this._render();
      this._btn.focus();
      const note = h("p", { class: "tfs-msg tfs-msg--quiet tfs-msg--ok", role: "status", style: "font-size:12.5px" },
        icon("ok"), STATUS_WORDS.saved(r));
      this.append(note);
      setTimeout(() => note.remove(), 4000);
      this.dispatchEvent(new CustomEvent("tfs-saved", { bubbles: true, composed: true,
        detail: { table: this.table, row: this.getAttribute("row"), field: this.field, value, receipt: r } }));
      return;
    }
    if (out.wait) {
      // The menu can be closed; another pick is ignored until the wait ends (`_pick`). When the
      // machine leaves the wait, this settles again: saved closes it and tells the page.
      menu.setIdle();
      menu.setHint(value, out.hint);
      this._waitNote(menu);
      menu.guard = () => this._askClose(menu, value);   // closing would lose the change: ask
      if (!this._waitOff) {
        this._waitOff = m.onChange((mm) => {
          if (mm.busy()) return;
          this._waitOff(); this._waitOff = null;
          menu.guard = null;
          this._settle(this.model._settled(), value, menu);   // every end shows in the open menu
        });
      }
      return;
    }
    menu.setIdle();
    if (out.hint) menu.setHint(value, out.hint);
    if (out.ask) {
      const w = (r.warnings || []).find((x) => x && x.code === "changed_since_opened");
      const c = conflictCopy(w, { noun: nounOf(this.table), labelOf: () => "Status", tokenStale: m.tokenStale });
      const yes = h("button", { type: "button", class: "tfs-btn tfs-btn--small tfs-btn--primary", text: "Save anyway" });
      const no = h("button", { type: "button", class: "tfs-btn tfs-btn--small", text: "Cancel" });
      yes.addEventListener("click", async () => {
        menu.setSaving(value);
        let s2; try { s2 = await this.model.confirm(); } catch { s2 = this.model.machine.state; }
        this._settle(s2, value, menu);
      });
      no.addEventListener("click", () => { this.model.cancel(); menu.clearMessage(); menu.list.focus(); });
      menu.showMessage(msgEl({ tone: "warn", title: c.title, paragraphs: c.paragraphs }, [yes, no]));
      return;
    }
    if (st === "outcome_unknown") {
      const href = safeHref(r.source || this.model.source);
      menu.showMessage(msgEl({ tone: "warn", title: "Coda didn't confirm this",
        paragraphs: [["It may have gone through. Check Coda before trying again."]] },
        href ? [h("a", { class: "tfs-link", href, target: "_blank", rel: "noopener" }, "Check in Coda", icon("open"))] : []));
      return;
    }
    if (st === "refused") {
      const msgs = (r.refusals || []).map((x) => x && x.message).filter(Boolean);
      menu.showMessage(msgEl({ tone: "error", title: "Not saved", paragraphs: (msgs.length ? msgs : ["Nothing was saved."]).map((t) => [t]) }));
    }
    // idle: the person stopped it; nothing was written.
  }
}

/* ===========================================================================
   Delete: the model (pure; Node-tested)
   ========================================================================= */

export const DELETE_STATES = ["idle", "checking", "confirm", "deleting", "deleted", "refused", "unknown", "closed"];

/** The server's question repeats the dialog's title ("Delete “X”? It disappears…"); the body
 * keeps only what follows it. A message in any other shape is shown whole. */
export function deleteBody(message) {
  const m = String(message || "");
  const rest = m.replace(/^Delete\s+[“"'‘][^”"'’]*[”"'’]\?\s*/, "");
  return rest || m;
}

export class DeleteFlow {
  constructor({ transport, row, title = "", table = "tasks" }) {
    Object.assign(this, { transport, row, table });
    this.title = title || "this task";
    this.state = "idle"; this.data = {}; this.listeners = new Set(); this._run = 0;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  set(state, data = {}) {
    this.state = state; this.data = { ...this.data, ...data };
    this.listeners.forEach((f) => { try { f(this); } catch { /* a listener must not stop the flow */ } });
  }

  /** Preview: may this task be deleted? */
  async start() {
    const run = ++this._run;
    this.data = {};
    this.set("checking");
    let r;
    try {
      r = await this.transport.call("delete_record", { table: this.table, row_id: this.row, preview: true });
    } catch (e) {
      if (run !== this._run || this.state !== "checking") return;
      // A preview deletes nothing, so a failed one is simply "not deleted".
      return this.set("refused", { messages: [`${(e && e.message) || "Something went wrong."} Nothing was deleted.`] });
    }
    if (run !== this._run || this.state !== "checking") return;   // cancelled while checking
    if (r && r.title) this.title = r.title;
    if (r && r.outcome === "previewed" && r.confirm_code) {
      return this.set("confirm", { message: r.message || "", code: r.confirm_code, source: r.source || null });
    }
    if (r && r.outcome === "refused") return this.set("refused", { messages: refusalMessages(r), source: r.source || null });
    return this.set("refused", { messages: ["The TFS server sent an answer this page doesn't understand. Nothing was deleted."] });
  }

  /** The person pressed "Delete task": the one call that deletes. */
  async confirm() {
    if (this.state !== "confirm") return;
    const source = this.data.source || null;
    this.set("deleting");
    let r;
    try {
      r = await this.transport.call("delete_record",
        { table: this.table, row_id: this.row, preview: false, confirm_code: this.data.code }, { write: true });
    } catch (e) {
      // A dropped call may have deleted: unknown, unless the runtime says it never left.
      if (!e || e.ambiguous !== false) return this.set("unknown", { source });
      return this.set("refused", { messages: [`${e.message || "Something went wrong."} Nothing was deleted.`] });
    }
    if (r && r.outcome === "deleted") return this.set("deleted", { receipt: r });
    if (r && r.outcome === "refused") return this.set("refused", { messages: refusalMessages(r), source: r.source || source });
    return this.set("unknown", { source: (r && r.source) || source, receipt: r });
  }

  /** Close without deleting (any state but deleting). */
  cancel() {
    if (this.state === "deleting") return false;
    this._run++;
    this.set("closed");
    return true;
  }
}

function refusalMessages(r) {
  const m = ((r && r.refusals) || []).map((x) => x && x.message).filter(Boolean);
  return m.length ? m : ["It can't be deleted from here. Nothing was deleted."];
}

/** What the dialog shows for a flow state (HANDOVER "Delete confirmation" table). */
export function deleteView(state, data = {}, title = "this task") {
  const q = `'${title}'`;
  const confirmText = deleteBody(data.message) || "It disappears from Coda and every TFS page. TFS keeps a copy, so the TFS MCP Server owner can bring it back if you need it.";
  switch (state) {
    case "checking":
      return { role: "dialog", title: "Delete this task?", text: "Checking whether it can be deleted…", spinner: true, busy: true,
        buttons: [{ label: "Cancel", action: "cancel", focus: true }, { label: "Delete task", danger: true, disabled: true }] };
    case "confirm":
      return { role: "alertdialog", title: `Delete ${q}?`, text: confirmText,
        buttons: [{ label: "Cancel", action: "cancel", focus: true }, { label: "Delete task", danger: true, icon: "trash", action: "delete" }] };
    case "deleting":
      return { role: "alertdialog", title: `Delete ${q}?`, text: confirmText, busy: true,
        buttons: [{ label: "Cancel", disabled: true }, { label: "Deleting…", danger: true, busy: true }] };
    case "deleted":
      return { role: "dialog", title: "Deleted",
        msg: { tone: "ok", paragraphs: [[`${q} is gone from Coda and every TFS page.`]] },
        buttons: [{ label: "Close", action: "cancel", focus: true }] };
    case "refused":
      return { role: "alertdialog", title: `Can't delete ${q}`,
        msg: { tone: "error", paragraphs: (data.messages || []).map((m) => [m]) },
        buttons: [{ label: "Close", action: "cancel", focus: true }] };
    case "unknown":
      return { role: "alertdialog", title: `Delete ${q}?`,
        msg: { tone: "warn", title: "Coda didn't confirm the delete", paragraphs: [["It may have gone through. Check Coda before trying again."]] },
        link: safeHref(data.source), buttons: [{ label: "Close", action: "cancel", focus: true }] };
    default:
      return null;
  }
}

/* ===========================================================================
   <tfs-delete-task row title [no-button]>
   ========================================================================= */

export class TfsDeleteTask extends Base {
  constructor() { super(); this._built = false; }

  get transport() { return transportOf(this); }
  set transport(t) { this._transport = t; }

  connectedCallback() {
    if (this._built) return;
    this._built = true;
    if (!this.hasAttribute("no-button")) {
      this._btn = h("button", { type: "button", class: "tfs-btn tfs-btn--small" }, icon("trash"), "Delete");
      this._btn.addEventListener("click", () => this.open());
      this.append(this._btn);
    }
  }

  /** Open the confirmation and start the check. */
  open() {
    const flow = new DeleteFlow({ transport: this.transport, row: this.getAttribute("row"), title: this.getAttribute("title") || "" });
    this._flow = flow;
    if (!this._dialog) {
      const id = nextId("tfs-del");
      this._titleEl = h("p", { class: "tfs-dialog__title", id: `${id}-t` });
      this._textEl = h("p", { class: "tfs-dialog__text", id: `${id}-d` });
      this._msgSlot = document.createElement("div");
      this._actions = h("div", { class: "tfs-dialog__actions" });
      this._dialog = h("dialog", { class: "tfs-dialog", "aria-labelledby": `${id}-t` }, this._titleEl, this._textEl, this._msgSlot, this._actions);
      this._dialog.addEventListener("cancel", (e) => {   // Escape
        e.preventDefault();
        if (this._flow && this._flow.cancel()) this._close();
      });
      this.append(this._dialog);
    }
    flow.onChange((f) => {
      if (f !== this._flow) return;
      if (f.state === "closed") return;
      this._paint(f);
      if (f.state === "deleted") {
        this.dispatchEvent(new CustomEvent("tfs-deleted", { bubbles: true, composed: true,
          detail: { table: "tasks", row: f.row, title: f.title, receipt: f.data.receipt || null } }));
      }
    });
    if (typeof this._dialog.showModal === "function") { if (!this._dialog.open) this._dialog.showModal(); }
    else this._dialog.setAttribute("open", "");
    flow.start();
  }

  _close() {
    if (this._dialog.open && typeof this._dialog.close === "function") this._dialog.close();
    else this._dialog.removeAttribute("open");
    if (this._btn) this._btn.focus();
  }

  _paint(f) {
    const v = deleteView(f.state, f.data, f.title);
    if (!v) return;
    const d = this._dialog;
    d.setAttribute("role", v.role);
    d.toggleAttribute("aria-busy", !!v.busy);
    this._titleEl.textContent = v.title;
    if (v.text) {
      this._textEl.hidden = false;
      this._textEl.replaceChildren(...(v.spinner ? [spinner()] : []), v.text);
      this._textEl.style.cssText = v.spinner ? "display:flex;gap:8px;align-items:center" : "";
      if (v.spinner) this._textEl.firstChild.style.color = "var(--tfs-muted)";
      d.setAttribute("aria-describedby", this._textEl.id);
    } else {
      // Clear the spinner state's inline display:flex too: an inline display beats the `hidden`
      // attribute, so the empty line stayed on screen after a spinner step (found 2026-10-07).
      this._textEl.style.cssText = "";
      this._textEl.hidden = true;
      d.removeAttribute("aria-describedby");
    }
    this._msgSlot.replaceChildren(v.msg ? msgEl(v.msg, v.link ? [codaLink(v.link)] : []) : "");
    let focusBtn = null;
    this._actions.replaceChildren(...v.buttons.map((b) => {
      const btn = h("button", { type: "button", class: b.danger ? "tfs-btn tfs-btn--danger" : "tfs-btn", disabled: !!b.disabled,
        "aria-busy": b.busy ? "true" : null },
      ...(b.busy ? [spinner()] : []), ...(b.icon ? [icon(b.icon)] : []), b.label);
      if (b.action === "cancel") btn.addEventListener("click", () => { if (this._flow.cancel()) this._close(); });
      if (b.action === "delete") btn.addEventListener("click", () => this._flow.confirm());
      if (b.focus) focusBtn = btn;
      return btn;
    }));
    if (focusBtn) focusBtn.focus();
  }
}
