// Kit 1.5.0: what the record form shows for a save Coda has not confirmed yet (unconfirmed
// rows). Pure functions; fixtures are invented (public code).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formView, failureNotice, nextRowAfterCreate, CONFIRM_WORDS, waitingCopy, orphanNotice, TfsRecordForm,
} from "../form.js";
import { SaveMachine } from "../save.js";
import { WAIT_TIMEOUT, WAIT_ENDED } from "../save.js";
import { statusOutcome, STATUS_WORDS } from "../actions.js";

const base = { phase: "ready", noun: "task", labelOf: (n) => n };
const UNCONF = { state: "unconfirmed", since: "2026-10-07T10:00:00Z", pending_fields: ["parent_task", "theme"], message: "Saved. Coda hasn't confirmed it yet — it usually does within a few minutes." };
const CONF = { state: "confirmed", pending_fields: [], message: "Saved, and Coda has confirmed it." };

// The pin against 1.3.1's real output is formview-1.3.1.test.js; this checks the extra keys.
test("no confirmation: passing confirmation null/undefined changes nothing, and nothing is pending", () => {
  const states = ["idle", "previewing", "confirm", "saving", "saved_syncing", "refused", "outcome_unknown"];
  const receipts = [null, { warnings: [], lag: { new_row_editable_after: "A new record can be edited after a few minutes." } }];
  for (const state of states) for (const receipt of receipts) for (const isUpdate of [true, false]) {
    const o = { ...base, state, receipt, isUpdate, dirtyCount: 1 };
    const v = formView(o);
    assert.deepEqual(v.pending, []);
    assert.deepEqual(formView({ ...o, confirmation: null, watchTimedOut: true }), v, `${state}/${isUpdate}`);
  }
  const saved = formView({ ...base, isUpdate: true, state: "saved_syncing", receipt: { warnings: [] } });
  assert.deepEqual(saved.footer, { text: "Saved · shows on pages within a few minutes", ok: true });
  const created = formView({ ...base, state: "saved_syncing", receipt: { warnings: [], lag: { new_row_editable_after: "x" } } });
  assert.deepEqual(created.notices[0].paragraphs, [["x"]]);
  assert.equal(nextRowAfterCreate({ outcome: "saved", row_id: "i-1", lag: {} }), null, "a create without confirmation starts a fresh record, as before");
});

test("saved, unconfirmed: 'Saved — waiting for Coda to confirm'; pending fields get the note", () => {
  const receipt = { outcome: "saved", row_id: "i-n", warnings: [], confirmation: UNCONF };
  const v = formView({ ...base, isUpdate: true, state: "saved_syncing", receipt, confirmation: UNCONF });
  assert.deepEqual(v.footer, { text: "Saved — waiting for Coda to confirm", ok: true });
  assert.deepEqual(v.pending, ["parent_task", "theme"]);
  assert.equal(CONFIRM_WORDS.pending, "Coda is still filling this in");
  // an opened record that is still unconfirmed: the notes, nothing else changes
  const opened = formView({ ...base, isUpdate: true, state: "idle", confirmation: UNCONF });
  assert.deepEqual(opened.pending, ["parent_task", "theme"]);
  assert.equal(opened.footer.text, "No changes");
  assert.equal(opened.notices.length, 0);
});

test("confirmed: the footer says so and nothing is pending", () => {
  const receipt = { outcome: "saved", row_id: "i-n", warnings: [], confirmation: UNCONF };
  const v = formView({ ...base, isUpdate: true, state: "saved_syncing", receipt, confirmation: CONF });
  assert.deepEqual(v.footer, { text: "Saved and confirmed by Coda", ok: true });
  assert.deepEqual(v.pending, []);
});

test("10 minutes without confirmation: the poll stops and the form says so", () => {
  const receipt = { outcome: "saved", warnings: [], confirmation: UNCONF };
  const v = formView({ ...base, isUpdate: true, state: "saved_syncing", receipt, confirmation: UNCONF, watchTimedOut: true });
  const n = v.notices.find((x) => x.quiet);
  assert.deepEqual(n.paragraphs, [["Coda hasn't confirmed this yet — it usually does within the hour; this page will show it when you reopen it."]]);
});

test("waiting for Coda to finish creating: plain words, Save busy, fields locked, Close stays", () => {
  const v = formView({ ...base, isUpdate: true, state: "waiting_for_coda", receipt: {}, confirmation: UNCONF });
  assert.equal(v.notices[0].tone, "info");
  assert.equal(v.notices[0].title, "Coda is still creating this task");
  assert.deepEqual(v.notices[0].paragraphs, [["Keep this form open — your change will save automatically once Coda has finished creating the record."]]);
  assert.doesNotMatch(JSON.stringify(v), /you can close/i, "never promise a save after Close (fix round 1, I2)");
  assert.deepEqual(v.footer, { text: "Waiting for Coda…", spinner: true });
  assert.equal(v.save.busy, true);
  assert.equal(v.save.disabled, true);
  assert.equal(v.locked, true);
  assert.deepEqual(v.close, { label: "Close", action: "close" });
  assert.deepEqual(waitingCopy("project").title, "Coda is still creating this project");
});

test("failed create offers Recreate prefilled from values_sent", () => {
  const conf = { state: "failed", message: "Coda accepted the save but never added the task, so it doesn't actually exist yet. If you still need it, create it again.", values_sent: { title: "Draft", owner: { row_id: "r-1", label: "Ana" } } };
  const v = formView({ ...base, phase: "record_failed", isUpdate: true, confirmation: conf, recordExists: false });
  assert.equal(v.save.hidden, true);
  assert.equal(v.notices.length, 1);
  assert.equal(v.notices[0].title, "Coda didn't keep this task");
  assert.deepEqual(v.notices[0].paragraphs, [[conf.message]]);
  assert.deepEqual(v.notices[0].actions, [{ kind: "recreate", values: conf.values_sent }]);
  const withLink = failureNotice(conf, { recordExists: false, source: "https://coda.example/r", noun: "task" });
  assert.deepEqual(withLink.actions[1], { kind: "link", href: "https://coda.example/r", label: "Open in Coda" });
});

test("failed update offers Re-edit with what was sent, and Open in Coda; never Recreate", () => {
  const conf = { state: "failed", message: "Your change didn't stick, because Coda still shows the earlier value. If you still want the change, make it again.", values_sent: { urgency: "High" } };
  const v = formView({ ...base, isUpdate: true, state: "idle", confirmation: conf, source: "https://coda.example/r" });
  assert.equal(v.notices[0].title, "Your change didn't stick");
  assert.deepEqual(v.notices[0].actions, [{ kind: "reedit", values: { urgency: "High" } }, { kind: "link", href: "https://coda.example/r", label: "Open in Coda" }]);
  assert.deepEqual(failureNotice({ ...conf, values_sent: {} }, { recordExists: true, noun: "task" }).actions, [], "nothing to re-edit, no link: no buttons");
});

test("not in view: it IS in Coda, so Open in Coda only — Recreate would make a duplicate", () => {
  const conf = { state: "not_in_view", message: "It was saved in Coda, but the Coda view the TFS tools use doesn't include it, so pages won't find it.", values_sent: { title: "Draft" } };
  const n = failureNotice(conf, { recordExists: false, source: "https://coda.example/r", noun: "task" });
  assert.equal(n.title, "Pages can't find this task");
  assert.deepEqual(n.actions, [{ kind: "link", href: "https://coda.example/r", label: "Open in Coda" }]);
  assert.deepEqual(failureNotice(conf, { recordExists: false, noun: "task" }).actions, []);
});

test("create keeps the form open on the new row (only when the save is confirmed-tracked)", () => {
  assert.equal(nextRowAfterCreate({ outcome: "saved", row_id: "i-n", confirmation: UNCONF }), "i-n");
  assert.equal(nextRowAfterCreate({ outcome: "saved", row_id: null, confirmation: UNCONF }), null);
  assert.equal(nextRowAfterCreate({ outcome: "saved", row_id: "i-n", confirmation: UNCONF, warnings: [{ code: "already_saved" }] }), "i-n");
  assert.equal(nextRowAfterCreate(null), null);
});

test("status menu: the wait note says to keep it open; closing asks first", () => {
  assert.equal(STATUS_WORDS.waitingBody, "Keep this open — this status will save automatically once Coda has finished creating the record.");
  assert.equal(STATUS_WORDS.closeAsk, "Your change hasn't saved yet. Close anyway and lose it?");
});

test("status menu: waiting for Coda keeps the menu open with a note; saved words follow confirmation", () => {
  assert.deepEqual(statusOutcome("waiting_for_coda"), { close: false, message: "info", wait: true, hint: "Waiting for Coda" });
  assert.equal(STATUS_WORDS.saved({ confirmation: UNCONF }), "Saved — waiting for Coda to confirm");
  assert.equal(STATUS_WORDS.saved({}), "Saved · shows on pages within a few minutes");
});

test("staff-facing words never speak of a copy, a mirror or what TFS reads", () => {
  const words = [...Object.values(CONFIRM_WORDS), waitingCopy("task").title, ...waitingCopy("task").paragraphs.flat(),
    WAIT_TIMEOUT, WAIT_ENDED, STATUS_WORDS.waitingTitle, STATUS_WORDS.waitingBody, STATUS_WORDS.closeAsk, CONFIRM_WORDS.closeAsk, STATUS_WORDS.saved({ confirmation: UNCONF }),
    ...["failed", "not_in_view"].flatMap((state) => [true, false].map((recordExists) => failureNotice({ state, message: "m" }, { recordExists, noun: "task" }).title))];
  for (const w of words) {
    assert.equal(typeof w, "string");
    assert.doesNotMatch(w, /\bcopy\b|mirror|TFS reads|catch up/i, w);
  }
});

/* ---- fix round 1 (review I1, I2) ---------------------------------------------------------- */

test("Close while a change waits for Coda asks first; 'Keep waiting' keeps it, 'Close anyway' loses it", () => {
  const v = formView({ ...base, isUpdate: true, state: "waiting_for_coda", receipt: {}, confirmation: UNCONF, closeAsk: true });
  const ask = v.notices.find((n) => n.tone === "warn");
  assert.deepEqual(ask.paragraphs, [["Your change hasn't saved yet. Close anyway and lose it?"]]);
  assert.deepEqual(ask.actions, [{ kind: "keep_waiting" }, { kind: "close_anyway" }]);
  assert.equal(CONFIRM_WORDS.keepWaiting, "Keep waiting");
  assert.equal(CONFIRM_WORDS.closeAnyway, "Close anyway");
  assert.equal(formView({ ...base, isUpdate: true, state: "waiting_for_coda", receipt: {}, confirmation: UNCONF }).notices.length, 1, "no question until Close is pressed");
});

test("the re-sent save's check goes through Close, not Cancel, so Close still asks", () => {
  const v = formView({ ...base, isUpdate: true, state: "previewing", confirmation: UNCONF, retrying: true });
  assert.deepEqual(v.close, { label: "Close", action: "close" });
  assert.deepEqual(formView({ ...base, isUpdate: true, state: "previewing" }).close, { label: "Cancel", action: "abort" }, "an ordinary check is still cancellable");
});

test("a waiting change that ended unsaved after the form moved on is shown in the open form", () => {
  const refused = orphanNotice({ state: "refused", receipt: { refusals: [{ message: "Coda still hasn't finished creating this record, so your change wasn't saved. Try saving again in a few minutes." }] } }, "task");
  assert.equal(refused.title, "An earlier change to a task wasn't saved");
  assert.deepEqual(refused.paragraphs, [["Coda still hasn't finished creating this record, so your change wasn't saved. Try saving again in a few minutes."]]);
  const unknown = orphanNotice({ state: "outcome_unknown", receipt: {} }, "task");
  assert.deepEqual(unknown.paragraphs, [["Coda didn't confirm it. It may have gone through, so check Coda before making it again."]]);
  const asked = orphanNotice({ state: "confirm", receipt: {} }, "task");
  assert.deepEqual(asked.paragraphs, [["Someone changed that task while Coda was creating it, so your change was held back. Open it again and redo the change if you still want it."]]);
  assert.equal(orphanNotice({ state: "saved_syncing", receipt: {} }, "task"), null);
  const v = formView({ ...base, isUpdate: true, state: "idle", orphan: refused });
  assert.equal(v.notices[0], refused);
});

/* The element without a DOM: Node's HTMLElement stand-in is a plain class, so the lifecycle
   callbacks can be called directly with a real machine on a fake clock. */
function fakeClock() {
  let now = 0; const q = [];
  return {
    timers: {
      setTimeout: (fn, ms) => { const tm = { at: now + ms, fn }; q.push(tm); return tm; },
      clearTimeout: (tm) => { const i = q.indexOf(tm); if (i >= 0) q.splice(i, 1); },
      now: () => now,
    },
    pending: () => q.length,
    async fire() { const tm = q.shift(); if (tm) { now = tm.at; await tm.fn(); } },
  };
}
const noReads = { call: async () => { throw new Error("no call expected"); } };

test("removing a form stops its confirmation poll (I1)", () => {
  const c = fakeClock();
  const el = new TfsRecordForm();
  el._connected = true;
  el.machine = new SaveMachine({ transport: noReads, table: "tasks", rowId: "r-n", confirmation: UNCONF, timers: c.timers });
  el.machine.watchConfirmation();
  assert.equal(c.pending(), 1);
  el.disconnectedCallback();
  assert.equal(c.pending(), 0, "no timer outlives the form");
  assert.equal(el._connected, false);
});

test("…except a change that is actively waiting for Coda: that one wait stays alive (I1)", () => {
  const c = fakeClock();
  const el = new TfsRecordForm();
  el._connected = true;
  const m = new SaveMachine({ transport: noReads, table: "tasks", rowId: "r-n", confirmation: UNCONF, timers: c.timers });
  m.state = "waiting_for_coda"; m.watchConfirmation();
  el.machine = m;
  el.disconnectedCallback();
  assert.equal(c.pending(), 1);
});

test("a detached form never reloads itself when a watch settles (I1)", () => {
  const el = new TfsRecordForm();
  let loads = 0; el.load = () => { loads++; };
  el._ready = true; el._connected = false;
  const m = { busy: () => false, watchedRow: "r-n" };
  el.machine = m;
  el.dispatchEvent = () => true;
  el._onConfirm(m, { kind: "gone", record: { refused: "not_found" } });
  assert.equal(loads, 0);
});

/* ---- fix round 2 ---------------------------------------------------------------------------- */

function fakeDialog() {
  const ls = {};
  return {
    open: true, modal: true, ls,
    addEventListener(t, f) { (ls[t] = ls[t] || []).push(f); },
    removeEventListener(t, f) { ls[t] = (ls[t] || []).filter((x) => x !== f); },
    fire(t) { let prevented = false; const e = { type: t, preventDefault() { prevented = true; } }; (ls[t] || []).slice().forEach((f) => f(e)); return prevented; },
    showModal() { this.open = true; this.reopened = "modal"; },
    show() { this.open = true; this.reopened = "plain"; },
    close() { this.open = false; this.fire("close"); },
    matches(q) { return q === ":modal" && this.open && this.modal; },
  };
}
function waitingForm(c, dlg) {
  const el = new TfsRecordForm();
  el.closest = (sel) => (sel === "dialog" ? dlg : null);
  el.getAttribute = (n) => ({ table: "tasks" }[n] ?? null);
  el.dispatchEvent = () => true;
  el._started = true;   // re-attach path: no load()
  const m = new SaveMachine({ transport: noReads, table: "tasks", rowId: "r-n", confirmation: UNCONF, timers: c.timers });
  m.state = "waiting_for_coda";
  el.machine = m;
  return { el, m };
}

test("(I2) Escape on the form's dialog while a change waits: prevented, and the form asks instead", () => {
  const c = fakeClock(); const dlg = fakeDialog();
  const { el, m } = waitingForm(c, dlg);
  el.connectedCallback();
  assert.equal(dlg.fire("cancel"), true, "the dialog's cancel (Escape) is prevented");
  assert.equal(el._closeAsk, true);
  m.state = "saved_syncing";
  el._closeAsk = false;
  assert.equal(dlg.fire("cancel"), false, "nothing waiting: Escape closes as always");
  el.disconnectedCallback();
  m.state = "waiting_for_coda";
  assert.equal(dlg.fire("cancel"), false, "a removed form no longer listens");
});

test("(I2) the dialog closed some other way while a change waits: reopened as it was, with the question", () => {
  const c = fakeClock(); const dlg = fakeDialog();
  const { el, m } = waitingForm(c, dlg);
  el.connectedCallback();
  el._onState(m);   // records that the drawer is modal
  dlg.close();      // a page's close(), or the browser forcing a repeated Escape
  assert.equal(dlg.open, true);
  assert.equal(dlg.reopened, "modal");
  assert.equal(el._closeAsk, true);
  // after "Close anyway" (the change abandoned) a close is just a close
  m.state = "idle";
  dlg.reopened = null;
  dlg.close();
  assert.equal(dlg.open, false);
  assert.equal(dlg.reopened, null);
});

test("(a) a form that is not connected never starts a confirmation watch on load", async () => {
  const el = new TfsRecordForm();
  const UREC = { row_id: "r-n", row_version: "v1", values: {}, editable: {}, confirmation: UNCONF };
  el._transport = { call: async (tool) => (tool === "describe_record_form" ? { fields: [] } : UREC) };
  el.getAttribute = (n) => ({ table: "tasks", mode: "edit", row: "r-n" }[n] ?? null);
  el._shell = () => {}; el._build = () => {}; el.dispatchEvent = () => true;
  el._connected = false;
  await el.load();
  assert.ok(el.machine, "the record loaded");
  const running = !!(el.machine._watch && el.machine._watch.running);
  el.machine.stopWatch();
  assert.equal(running, false);
});

test("(a) …nor after a create, when it reopens on the new record", async () => {
  const el = new TfsRecordForm();
  const UREC = { row_id: "r-n", row_version: "v1", values: {}, editable: {}, confirmation: UNCONF };
  el._transport = { call: async () => UREC };
  el.getAttribute = (n) => ({ table: "tasks", mode: "create" }[n] ?? null);
  el._paint = () => {}; el._build = () => {}; el.dispatchEvent = () => true;
  el._connected = false;
  const old = new SaveMachine({ transport: el._transport, table: "tasks", timers: fakeClock().timers });
  old.state = "saved_syncing";
  el.machine = old;
  await el._openCreated("r-n", { outcome: "saved", row_id: "r-n", confirmation: UNCONF });
  assert.notEqual(el.machine, old);
  const running = !!(el.machine._watch && el.machine._watch.running);
  el.machine.stopWatch();
  assert.equal(running, false);
});

test("(b) a waiting change kept alive after removal saves, and starts no new 10-minute watch", async () => {
  const c = fakeClock();
  let saves = 0; let reads = 0;
  const tr = { call: async (tool, input) => {
    if (tool === "get_record_for_editing") { reads++; return { row_id: "r-n", confirmation: { state: "confirmed", pending_fields: [] } }; }
    saves++;
    return input.preview ? { outcome: "previewed", warnings: [] } : { outcome: "saved", row_id: "r-n", confirmation: UNCONF };
  } };
  const el = new TfsRecordForm();
  el.getAttribute = () => null; el.dispatchEvent = () => true;
  el._connected = true;
  const m = new SaveMachine({ transport: tr, table: "tasks", rowId: "r-n", confirmation: UNCONF, timers: c.timers });
  m.state = "waiting_for_coda"; m.pending = { urgency: "High" }; m.key = "k"; m.waited = true;
  m.watchConfirmation();
  el.machine = m;
  el.disconnectedCallback();
  assert.equal(c.pending(), 1, "the wait itself stays alive");
  await c.fire();   // the wait's poll: confirmed → the change is re-sent and saves
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(m.state, "saved_syncing");
  assert.equal(c.pending(), 0, "no new confirmation watch for a removed form");
});

test("(c) 'Close anyway' during the re-sent save's check never shows the 'Someone changed…' note", () => {
  const el = new TfsRecordForm();
  el.getAttribute = (n) => ({ table: "tasks" }[n] ?? null);
  el.dispatchEvent = () => true;
  el.machine = { state: "idle" };
  const gone = new SaveMachine({ transport: noReads, table: "tasks", rowId: "r-n", timers: fakeClock().timers });
  gone.waited = true; gone.abandoned = true; gone.state = "idle";
  el._onState(gone);
  assert.equal(el._orphan == null, true);
});
