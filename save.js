/* TFS pages kit — the save-state machine (spec §6.3).
 *
 *   idle → previewing → (changed_since_opened? → confirm → saving) | saving
 *   saving → saved_syncing | refused | outcome_unknown
 *
 * ONE CLICK NORMALLY. `submit` previews silently (`preview: true` writes nothing) and saves at
 * once unless the preview warns `changed_since_opened`; only then is the person asked.
 *
 * NO DOUBLE SUBMIT. `busy()` is true while previewing, saving or waiting on the person's
 * confirm; a submit then does nothing. `outcome_unknown` is NOT busy: the next action (a retry
 * of an update, or the page's own reset) must be possible.
 *
 * IDEMPOTENCY. A fresh random key (UUID) per submission. It is reused ONLY to retry an UPDATE
 * whose outcome is unknown, and only with the SAME fields: the server's prior-key lookup
 * matches on the key alone, so the same key with different content would come back "already
 * saved" and silently drop the new edit. An update with new content takes a new key, which is
 * safe — an update written twice is the same update.
 *
 * A CREATE IS NEVER RETRIED FROM HERE. When a create's outcome is unknown, even the same key
 * does not prevent a duplicate (a timed-out insert leaves no success audit row for the key to
 * match), so `canRetry()` is false and `submit` refuses to fire: the page offers only "Check
 * in Coda". `reset()` is the page's deliberate way to start a new record after checking.
 *
 * OUTCOME UNKNOWN comes from two places, both meaning "it may have been saved": the server's
 * own `outcome: "unknown"` receipt (Coda did not confirm), and a transport failure on the
 * WRITE call that the transport marks `ambiguous` (the call may have reached the server).
 *
 * CONFIRMATION (kit 1.5.0, unconfirmed rows). When the server has put a save into TFS's reads
 * ahead of Coda, its receipt and `get_record_for_editing` carry `confirmation: {state:
 * unconfirmed|confirmed|failed|not_in_view, pending_fields, message, values_sent?}`. Then:
 *   - an unconfirmed save (or an opened record that is unconfirmed, `watchConfirmation`) is
 *     WATCHED: `get_record_for_editing` every 15 s for at most 10 minutes, and `onConfirm`
 *     listeners hear ONE result: confirmed | failed | not_in_view | gone | timeout;
 *   - WAITING FOR CODA (ruling D2, 2026-10-07): Coda refuses (404) an edit of a record
 *     it is still creating, for the 3-5 minutes a create takes. An UPDATE refused that way
 *     while the record is unconfirmed is not a failure: the machine waits
 *     (`waiting_for_coda`, busy) and sends the SAME fields with the SAME key once the record
 *     is confirmed. Once only: a second refusal is shown. A refused write wrote nothing, and
 *     the server's prior-key lookup matches only successful saves, so the same key cannot
 *     come back "already saved"; and it can never write twice, because only one save is ever
 *     out. A CREATE is never retried (as above).
 * Without `confirmation` (the server is not putting saves ahead of Coda for this person),
 * nothing here runs: no poll, no wait, the states and receipts are exactly 1.3's.
 */

const uuid = () => (globalThis.crypto && globalThis.crypto.randomUUID
  ? globalThis.crypto.randomUUID()
  : "k-" + Date.now().toString(16) + "-" + Math.random().toString(16).slice(2));

const DROPPED = "The connection dropped before TFS answered, so this may have been saved. Check in Coda before trying again.";
const UNREADABLE = "The TFS server sent an answer this page doesn't understand, so this may have been saved. Check in Coda before trying again.";

export const STATES = ["idle", "previewing", "confirm", "saving", "saved_syncing", "refused", "outcome_unknown", "waiting_for_coda"];

export const POLL_EVERY_MS = 15 * 1000;
export const POLL_LIMIT_MS = 10 * 60 * 1000;
export const WAIT_TIMEOUT = "Coda still hasn't finished creating this record, so your change wasn't saved. Try saving again in a few minutes.";
export const WAIT_ENDED = "Your change wasn't saved, because Coda didn't finish creating this record.";

const defaultTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (t) => globalThis.clearTimeout(t),
  now: () => Date.now(),
};

/** What one `get_record_for_editing` answer says about a watched record: null (still
 * unconfirmed, or no usable answer: ask again), "confirmed", "failed", "not_in_view", or "gone"
 * (refused with nothing to say: no longer there for this person). A record WITHOUT
 * `confirmation` has nothing left to report: it is as Coda has it, so it counts as confirmed. */
export function confirmationKind(rec) {
  if (!rec || typeof rec !== "object") return null;
  const c = rec.confirmation && typeof rec.confirmation === "object" ? rec.confirmation : null;
  if (rec.refused) return c && (c.state === "failed" || c.state === "not_in_view") ? c.state : "gone";
  if (!c) return "confirmed";
  if (c.state === "unconfirmed") return null;
  return ["confirmed", "failed", "not_in_view"].includes(c.state) ? c.state : null;
}

/** True when a refusal is Coda answering 404 for THIS row's own URL: what an edit of a record
 * Coda is still creating gets. The pipeline's text is httpx's, after its own 404 retries:
 * `update failed: Client error '404 Not Found' for url '…/rows/<row id>'`. Anything else (a
 * bare "404", another row, a linked record) is an ordinary refusal. Read from `technical`,
 * which a page never shows. */
export function looksLikeCreateLag(receipt, rowId) {
  if (!rowId || !receipt || !Array.isArray(receipt.refusals)) return false;
  const id = String(rowId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^update failed: Client error '404 [^']*' for url '[^']*/rows/${id}(?:\\?[^']*)?'`);
  return receipt.refusals.some((r) => r && typeof r.technical === "string" && re.test(r.technical));
}

/** Polls `get_record_for_editing` every `every` ms until the answer settles
 * (`confirmationKind`) or `limit` ms have passed; then calls `onResult({kind, record,
 * confirmation})` ONCE (kind "timeout" with no record at the limit). A failed read is asked
 * again. `start` is idempotent; `stop` ends it silently. */
export class ConfirmWatch {
  constructor({ transport, table, rowId, every = POLL_EVERY_MS, limit = POLL_LIMIT_MS, timers = defaultTimers, onResult }) {
    Object.assign(this, { transport, table, rowId, every, limit, timers, onResult });
    this.running = false; this._t = null; this.started = 0;
  }
  start() {
    if (this.running) return;
    this.running = true; this.started = this.timers.now();
    this._next();
  }
  stop() { this.running = false; if (this._t != null) this.timers.clearTimeout(this._t); this._t = null; }
  _next() { this._t = this.timers.setTimeout(() => { this._t = null; this._tick(); }, this.every); }
  async _tick() {
    if (!this.running) return;
    let rec = null;
    try { rec = await this.transport.call("get_record_for_editing", { table: this.table, row_id: this.rowId }, { fresh: true }); }
    catch { rec = null; }
    if (!this.running) return;
    const kind = confirmationKind(rec);
    if (kind) { this.running = false; return this.onResult({ kind, record: rec, confirmation: (rec && rec.confirmation) || null }); }
    if (this.timers.now() - this.started >= this.limit) { this.running = false; return this.onResult({ kind: "timeout", record: null, confirmation: null }); }
    this._next();
  }
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class SaveMachine {
  /**
   * @param {object} o
   * @param {{call: Function}} o.transport
   * @param {string} o.table
   * @param {string|null} [o.rowId]       set for an UPDATE; absent for a create
   * @param {string|null} [o.rowVersion]  from get_record_for_editing
   * @param {string|null} [o.source]      the record's Coda link, for "Check in Coda"
   * @param {object|null} [o.confirmation] the record's `confirmation`, from get_record_for_editing
   * @param {object} [o.timers]            {setTimeout, clearTimeout, now} (tests inject a clock)
   * @param {boolean} [o.watchSaves]       watch an unconfirmed save (default). The status menu
   *   passes false: nobody shows the result. The create-lag wait watches regardless.
   */
  constructor({ transport, table, rowId = null, rowVersion = null, source = null, confirmation = null, timers = defaultTimers, watchSaves = true }) {
    Object.assign(this, { transport, table, rowId, rowVersion, source, timers, watchSaves });
    this.confirmation = confirmation && typeof confirmation === "object" ? confirmation : null;
    this.watchTimedOut = false; this._watch = null; this._retried = false;
    this.confirmListeners = new Set();
    this.state = "idle"; this.receipt = null; this.pending = null; this.key = null;
    this.createdRowId = null;
    /* STALE TOKEN. After an update lands, `rowVersion` describes the record as it was
       BEFORE our save. The receipt's own `row_version` replaces it when the server sends one;
       otherwise the page must re-read (`refreshToken`). Until then the flag stays up, so the
       next save's preview warning ("You changed … since you opened this record") is EXPECTED
       — it is our own save — and the page says so rather than presenting it as a clash. The
       token is still sent: a rich-text update without one is refused as `load_first`. */
    this.tokenStale = false;
    this.listeners = new Set();
  }

  get isUpdate() { return !!this.rowId; }

  /** A fresh `row_version` from a re-read of the record. */
  refreshToken(rowVersion) { if (rowVersion) { this.rowVersion = rowVersion; this.tokenStale = false; } }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** Hear the ONE result of a confirmation watch: `{kind, record, confirmation}`. */
  onConfirm(fn) { this.confirmListeners.add(fn); return () => this.confirmListeners.delete(fn); }

  /** The row a watch asks about: this record, or the one this create made. */
  get watchedRow() { return this.rowId || this.createdRowId || null; }

  /** Watch an unconfirmed record (an opened one, or after a save). Does nothing unless the
   * known `confirmation` is unconfirmed; idempotent while a watch runs. */
  watchConfirmation() {
    if (!this.confirmation || this.confirmation.state !== "unconfirmed" || !this.watchedRow) return;
    if (this._watch && this._watch.running) return;
    this.watchTimedOut = false;
    this._watch = new ConfirmWatch({ transport: this.transport, table: this.table, rowId: this.watchedRow,
      timers: this.timers, onResult: (e) => this._confirmed(e) });
    this._watch.start();
  }

  stopWatch() { if (this._watch) this._watch.stop(); this._watch = null; }

  _confirmed(e) {
    this._watch = null;
    if (e.kind === "timeout") this.watchTimedOut = true;
    else if (e.kind === "confirmed") this.confirmation = e.confirmation || { state: "confirmed", pending_fields: [] };
    else if (e.confirmation) this.confirmation = e.confirmation;
    else if (e.kind === "gone") this.confirmation = { state: "gone", pending_fields: [] };
    if (this.state === "waiting_for_coda") {
      if (e.kind === "confirmed") { this._retried = true; this._run(this.pending); }
      else {
        const message = e.kind === "timeout" ? WAIT_TIMEOUT : WAIT_ENDED;
        this.set("refused", { receipt: { outcome: "refused", warnings: [],
          refusals: [{ field: null, code: e.kind === "timeout" ? "create_lag_timeout" : "create_lag_ended", message }] } });
      }
    }
    this.confirmListeners.forEach((f) => { try { f(e); } catch (err) { /* a listener must not stop the machine */ } });
  }

  set(state, extra = {}) {
    Object.assign(this, extra); this.state = state;
    this.listeners.forEach((f) => { try { f(this); } catch (e) { /* a listener must not stop the machine */ } });
  }

  busy() { return ["previewing", "saving", "confirm", "waiting_for_coda"].includes(this.state); }

  /** True while the re-sent save after a create-lag wait is being checked. */
  get retrying() { return this._retried && this.state === "previewing"; }

  /** True while the person's change is held by the create-lag wait: waiting, or its re-sent
   * save being checked. Closing then must ask first (it would lose the change). */
  get holdsWaitingChange() { return !this.abandoned && (this.state === "waiting_for_coda" || this.retrying); }

  /** The person chose to lose a waiting change ("Close anyway"): stop the wait; nothing more
   * is sent. During the re-sent save's check, the commit that would follow is not sent. */
  abandonWait() {
    if (!this.holdsWaitingChange) return;
    this.abandoned = true;   // the person chose this: nothing about it is reported later
    if (this.state === "waiting_for_coda") {
      this.stopWatch(); this.key = null; this.pending = null;
      return this.set("idle", { receipt: null });
    }
    if (this.retrying) this._aborted = true;
  }

  /** True only in outcome_unknown for an UPDATE: a retry with the same key is safe there. */
  canRetry() { return this.state === "outcome_unknown" && this.isUpdate && this.pending != null; }

  input(fields, preview) {
    const out = { table: this.table, fields, preview, idempotency_key: this.key };
    if (this.rowId) { out.row_id = this.rowId; out.row_version = this.rowVersion; }
    return out;
  }

  /** Start a submission. Resolves when the machine has settled (or immediately when busy). */
  async submit(fields) {
    if (this.busy()) return;
    if (this.state === "outcome_unknown") {
      if (!this.isUpdate) return;              // a create: Check in Coda only, never a retry
      if (!same(fields, this.pending)) this.key = uuid();
    } else {
      this.key = uuid();
    }
    this._retried = false; this.abandoned = false;
    return this._run(fields);
  }

  /** One submission of `fields` under the current key: preview, then (normally) the write. */
  async _run(fields) {
    this.pending = fields;
    this._aborted = false;
    this.set("previewing");
    let pre;
    try { pre = await this.transport.call("save_record", this.input(fields, true)); }
    catch (e) {
      if (this._aborted) return this.set("idle", { receipt: null });
      // A preview writes nothing, so a failed one is simply "not saved", whatever the code.
      return this.set("refused", { receipt: { outcome: "refused", refusals: [{ code: e && e.code, message: (e && e.message) || "Something went wrong." }], warnings: [] } });
    }
    // The person cancelled while the preview was out: nothing was written, and nothing will be.
    if (this._aborted) return this.set("idle", { receipt: null });
    if (!pre || pre.outcome === "refused") return this.set("refused", { receipt: pre });
    if (pre.outcome !== "previewed") {
      return this.set("refused", { receipt: { outcome: "refused", refusals: [{ code: "bad_payload", message: "The TFS server sent an answer this page doesn't understand. Nothing was saved." }], warnings: [] } });
    }
    const clash = (pre.warnings || []).find((w) => w && w.code === "changed_since_opened");
    // The re-sent save after a create-lag wait: a clash with the person's own CREATE (the
    // newest writer is "You", at the create's write time) is not a clash to ask about. Any
    // later change of theirs (another waiting change that landed first) or anyone else's asks.
    if (clash && !(this._retried && this._ownCreate(clash))) return this.set("confirm", { receipt: pre });
    return this.commit();
  }

  /** True when a `changed_since_opened` warning is the person's own create: by "You", at no
   * later than a minute after the create's write time (`confirmation.since` when the wait
   * began; the audit and ledger stamps of one write differ by milliseconds, and Coda's create
   * lag puts any later edit minutes after it). */
  _ownCreate(clash) {
    if (!clash || clash.by !== "You" || !this._createSince) return false;
    const at = Date.parse(clash.at || ""), since = Date.parse(this._createSince);
    return !Number.isNaN(at) && !Number.isNaN(since) && at <= since + 60000;
  }

  /** Retry an update whose outcome is unknown: same fields, same key. */
  retry() { if (this.canRetry()) return this.submit(this.pending); }

  confirm() { if (this.state === "confirm") return this.commit(); }

  cancel() { if (this.state === "confirm") this.set("idle", { receipt: null }); }

  /** Stop a submission that has not reached the write: while previewing (the preview writes
   * nothing, and the commit that would follow it is not sent) or while asking the person.
   * Returns true when it stopped one. A save already writing cannot be stopped. */
  abort() {
    if (this.retrying) return false;   // the waiting change: only abandonWait (asked) drops it
    if (this.state === "previewing") { this._aborted = true; return true; }
    if (this.state === "confirm") { this.cancel(); return true; }
    return false;
  }

  /** The page's deliberate fresh start (e.g. after the person checked Coda). New key next time. */
  reset() { if (!this.busy()) { this.key = null; this.pending = null; this.set("idle", { receipt: null }); } }

  async commit() {
    this.set("saving");
    let r;
    try {
      r = await this.transport.call("save_record", this.input(this.pending, false), { write: true });
    } catch (e) {
      if (!e || e.ambiguous !== false) {
        return this.set("outcome_unknown", { receipt: { outcome: "unknown", message: e && e.code === "bad_payload" || e && e.code === "contract_mismatch" ? UNREADABLE : DROPPED, source: this.source } });
      }
      return this.set("refused", { receipt: { outcome: "refused", refusals: [{ code: e.code, message: e.message }], warnings: [] } });
    }
    if (r && r.outcome === "saved") {
      if (!this.isUpdate && r.row_id) this.createdRowId = r.row_id;
      if (this.isUpdate) {
        if (r.row_version) { this.rowVersion = r.row_version; this.tokenStale = false; }
        else this.tokenStale = true;
      }
      if (r.confirmation && typeof r.confirmation === "object") {
        this.stopWatch();
        this.confirmation = r.confirmation;
        this.set("saved_syncing", { receipt: r });
        return this.watchSaves ? this.watchConfirmation() : undefined;
      }
      return this.set("saved_syncing", { receipt: r });
    }
    if (r && r.outcome === "refused") {
      // D2: Coda is still creating this record. Wait for it, then send this same save again.
      if (this.isUpdate && !this._retried && this.confirmation && this.confirmation.state === "unconfirmed"
          && looksLikeCreateLag(r, this.rowId)) {
        this.waited = true;   // this machine has held a change for Coda (the form reports its end)
        this._createSince = this.confirmation.since || null;   // the create's write time
        this.set("waiting_for_coda", { receipt: r });
        this.stopWatch();   // a fresh watch: the wait gets its full 10 minutes
        return this.watchConfirmation();
      }
      return this.set("refused", { receipt: r });
    }
    // `unknown` from the server, or anything we cannot read: it may have been written.
    const receipt = r && r.outcome === "unknown"
      ? { ...r, source: r.source || this.source }
      : { outcome: "unknown", message: UNREADABLE, source: this.source };
    return this.set("outcome_unknown", { receipt });
  }
}
