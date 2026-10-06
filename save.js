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
 */

const uuid = () => (globalThis.crypto && globalThis.crypto.randomUUID
  ? globalThis.crypto.randomUUID()
  : "k-" + Date.now().toString(16) + "-" + Math.random().toString(16).slice(2));

const DROPPED = "The connection dropped before TFS answered, so this may have been saved. Check in Coda before trying again.";
const UNREADABLE = "The TFS server sent an answer this page doesn't understand, so this may have been saved. Check in Coda before trying again.";

export const STATES = ["idle", "previewing", "confirm", "saving", "saved_syncing", "refused", "outcome_unknown"];

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
   */
  constructor({ transport, table, rowId = null, rowVersion = null, source = null }) {
    Object.assign(this, { transport, table, rowId, rowVersion, source });
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

  set(state, extra = {}) {
    Object.assign(this, extra); this.state = state;
    this.listeners.forEach((f) => { try { f(this); } catch (e) { /* a listener must not stop the machine */ } });
  }

  busy() { return ["previewing", "saving", "confirm"].includes(this.state); }

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
    this.pending = fields;
    this.set("previewing");
    let pre;
    try { pre = await this.transport.call("save_record", this.input(fields, true)); }
    catch (e) {
      // A preview writes nothing, so a failed one is simply "not saved", whatever the code.
      return this.set("refused", { receipt: { outcome: "refused", refusals: [{ code: e && e.code, message: (e && e.message) || "Something went wrong." }], warnings: [] } });
    }
    if (!pre || pre.outcome === "refused") return this.set("refused", { receipt: pre });
    if (pre.outcome !== "previewed") {
      return this.set("refused", { receipt: { outcome: "refused", refusals: [{ code: "bad_payload", message: "The TFS server sent an answer this page doesn't understand. Nothing was saved." }], warnings: [] } });
    }
    if ((pre.warnings || []).some((w) => w && w.code === "changed_since_opened")) return this.set("confirm", { receipt: pre });
    return this.commit();
  }

  /** Retry an update whose outcome is unknown: same fields, same key. */
  retry() { if (this.canRetry()) return this.submit(this.pending); }

  confirm() { if (this.state === "confirm") return this.commit(); }

  cancel() { if (this.state === "confirm") this.set("idle", { receipt: null }); }

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
      return this.set("saved_syncing", { receipt: r });
    }
    if (r && r.outcome === "refused") return this.set("refused", { receipt: r });
    // `unknown` from the server, or anything we cannot read: it may have been written.
    const receipt = r && r.outcome === "unknown"
      ? { ...r, source: r.source || this.source }
      : { outcome: "unknown", message: UNREADABLE, source: this.source };
    return this.set("outcome_unknown", { receipt });
  }
}
