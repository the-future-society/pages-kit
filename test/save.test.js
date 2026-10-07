import { test } from "node:test";
import assert from "node:assert/strict";
import { SaveMachine } from "../save.js";

// A scripted transport: each call takes the next response; an object with `code` is thrown.
const t = (responses) => {
  const calls = [];
  return { calls, call: async (tool, input, opt) => {
    calls.push({ tool, input, opt });
    const r = responses.shift();
    if (r instanceof Error || (r && r.code)) throw r;
    return r;
  } };
};
const dropped = { code: "server_unavailable", ambiguous: true, retryable: true, message: "x" };

test("one click: silent preview then save, one key", async () => {
  const tr = t([{ outcome: "previewed", warnings: [] }, { outcome: "saved", row_id: "i-1" }]);
  const m = new SaveMachine({ transport: tr, table: "tasks" });
  await m.submit({ title: "x" });
  assert.equal(m.state, "saved_syncing");
  assert.equal(tr.calls[0].input.preview, true);
  assert.equal(tr.calls[1].input.preview, false);
  assert.deepEqual(tr.calls[1].opt, { write: true });
  assert.equal(tr.calls[0].input.idempotency_key, tr.calls[1].input.idempotency_key);
  assert.equal(m.createdRowId, "i-1");
  assert.equal(m.rowId, null, "a create form stays a create form after saving");
  assert.equal("row_id" in tr.calls[1].input, false);
});

test("an update sends its row id and row_version", async () => {
  const tr = t([{ outcome: "previewed", warnings: [] }, { outcome: "saved", row_id: "i-p" }]);
  const m = new SaveMachine({ transport: tr, table: "projects", rowId: "i-p", rowVersion: "v1.x" });
  await m.submit({ status: "Complete" });
  assert.equal(tr.calls[1].input.row_id, "i-p");
  assert.equal(tr.calls[1].input.row_version, "v1.x");
});

test("changed since opened asks before saving", async () => {
  const tr = t([{ outcome: "previewed", warnings: [{ code: "changed_since_opened", message: "Ana changed Status since you opened this record." }] }, { outcome: "saved" }]);
  const m = new SaveMachine({ transport: tr, table: "projects", rowId: "i-p", rowVersion: "v1.x" });
  await m.submit({ status: "Complete" });
  assert.equal(m.state, "confirm");
  assert.equal(tr.calls.length, 1, "nothing written while the person decides");
  assert.equal(m.busy(), true);
  await m.confirm();
  assert.equal(m.state, "saved_syncing");
});

test("cancel on confirm writes nothing", async () => {
  const tr = t([{ outcome: "previewed", warnings: [{ code: "changed_since_opened" }] }]);
  const m = new SaveMachine({ transport: tr, table: "projects", rowId: "i-p", rowVersion: "v" });
  await m.submit({ status: "Complete" });
  m.cancel();
  assert.equal(m.state, "idle");
  assert.equal(tr.calls.length, 1);
});

test("a refusal shows the server's refusals and writes nothing", async () => {
  const tr = t([{ outcome: "refused", refusals: [{ code: "unknown_field", message: "This page can't set 'Owner'." }] }]);
  const m = new SaveMachine({ transport: tr, table: "tasks" });
  await m.submit({ owner: "x" });
  assert.equal(m.state, "refused");
  assert.equal(m.receipt.refusals[0].message, "This page can't set 'Owner'.");
  assert.equal(tr.calls.length, 1);
});

test("a dropped UPDATE save is outcome-unknown; a retry of the same fields reuses the key", async () => {
  const tr = t([{ outcome: "previewed", warnings: [] }, dropped, { outcome: "previewed", warnings: [] }, { outcome: "saved", warnings: [{ code: "already_saved", message: "already" }] }]);
  const m = new SaveMachine({ transport: tr, table: "tasks", rowId: "i-t", rowVersion: "v", source: "https://coda.example/row" });
  await m.submit({ status: "Done" });
  assert.equal(m.state, "outcome_unknown");
  assert.equal(m.busy(), false, "outcome_unknown must allow the next action");
  assert.equal(m.canRetry(), true);
  assert.equal(m.receipt.source, "https://coda.example/row");
  const k = tr.calls[1].input.idempotency_key;
  await m.retry();
  assert.equal(tr.calls[3].input.idempotency_key, k);
  assert.equal(m.state, "saved_syncing");
});

test("an update retried with DIFFERENT fields takes a new key (the old one would drop the edit)", async () => {
  const tr = t([{ outcome: "previewed", warnings: [] }, dropped, { outcome: "previewed", warnings: [] }, { outcome: "saved" }]);
  const m = new SaveMachine({ transport: tr, table: "tasks", rowId: "i-t", rowVersion: "v" });
  await m.submit({ status: "Done" });
  const k = tr.calls[1].input.idempotency_key;
  await m.submit({ status: "Done", urgency: "High" });
  assert.notEqual(tr.calls[3].input.idempotency_key, k);
});

test("a dropped CREATE is outcome-unknown with no retry: even the same key can create twice", async () => {
  const tr = t([{ outcome: "previewed", warnings: [] }, dropped]);
  const m = new SaveMachine({ transport: tr, table: "tasks" });
  await m.submit({ title: "x" });
  assert.equal(m.state, "outcome_unknown");
  assert.equal(m.canRetry(), false);
  await m.submit({ title: "x" });
  await m.retry();
  assert.equal(tr.calls.length, 2, "no further call is made for a create whose outcome is unknown");
  m.reset();
  assert.equal(m.state, "idle");
});

test("the server's own `unknown` outcome is outcome-unknown, with its message and source", async () => {
  const tr = t([{ outcome: "previewed", warnings: [] }, { outcome: "unknown", message: "Coda didn't confirm this save.", source: "https://coda.example/p" }]);
  const m = new SaveMachine({ transport: tr, table: "project_updates" });
  await m.submit({ summary: "x" });
  assert.equal(m.state, "outcome_unknown");
  assert.equal(m.receipt.message, "Coda didn't confirm this save.");
  assert.equal(m.receipt.source, "https://coda.example/p");
});

test("a write that failed before reaching the server is refused, not unknown", async () => {
  const tr = t([{ outcome: "previewed", warnings: [] }, { code: "needs_reauth", ambiguous: false, message: "Reconnect." }]);
  const m = new SaveMachine({ transport: tr, table: "tasks" });
  await m.submit({ title: "x" });
  assert.equal(m.state, "refused");
  assert.equal(m.receipt.refusals[0].message, "Reconnect.");
});

test("a write answer the kit cannot read is outcome-unknown, never 'refused'", async () => {
  const tr = t([{ outcome: "previewed", warnings: [] }, { outcome: "previewed" }]);
  const m = new SaveMachine({ transport: tr, table: "tasks" });
  await m.submit({ title: "x" });
  assert.equal(m.state, "outcome_unknown");
});

test("a failed preview is refused (a preview writes nothing)", async () => {
  const tr = t([dropped]);
  const m = new SaveMachine({ transport: tr, table: "tasks" });
  await m.submit({ title: "x" });
  assert.equal(m.state, "refused");
});

test("each new submission gets a fresh key", async () => {
  const tr = t([{ outcome: "previewed", warnings: [] }, { outcome: "saved" }, { outcome: "previewed", warnings: [] }, { outcome: "saved" }]);
  const m = new SaveMachine({ transport: tr, table: "tasks" });
  await m.submit({ title: "a" }); await m.submit({ title: "a" });
  assert.notEqual(tr.calls[1].input.idempotency_key, tr.calls[3].input.idempotency_key);
});

test("double submit while saving does nothing", async () => {
  let release; const gate = new Promise((r) => (release = r));
  const tr = { calls: 0, call: async () => { tr.calls++; await gate; return { outcome: "previewed", warnings: [] }; } };
  const m = new SaveMachine({ transport: tr, table: "tasks" });
  const p = m.submit({ title: "x" }); m.submit({ title: "x" });
  assert.equal(tr.calls, 1); release(); await p;
});

test("busy() is exactly previewing, saving and confirm", () => {
  const m = new SaveMachine({ transport: t([]), table: "tasks" });
  for (const [s, b] of [["idle", false], ["previewing", true], ["confirm", true], ["saving", true], ["saved_syncing", false], ["refused", false], ["outcome_unknown", false]]) {
    m.state = s; assert.equal(m.busy(), b, s);
  }
});

test("listeners hear every state", async () => {
  const tr = t([{ outcome: "previewed", warnings: [] }, { outcome: "saved" }]);
  const m = new SaveMachine({ transport: tr, table: "tasks" });
  const seen = []; m.onChange((x) => seen.push(x.state));
  await m.submit({ title: "x" });
  assert.deepEqual(seen, ["previewing", "saving", "saved_syncing"]);
});

test("after an update, a receipt without a fresh row_version marks the token stale until refreshed", async () => {
  const tr = t([{ outcome: "previewed", warnings: [] }, { outcome: "saved", row_id: "i-p" }]);
  const m = new SaveMachine({ transport: tr, table: "projects", rowId: "i-p", rowVersion: "v1" });
  await m.submit({ status: "Complete" });
  assert.equal(m.tokenStale, true);
  m.refreshToken("v2");
  assert.equal(m.tokenStale, false);
  assert.equal(m.rowVersion, "v2");
});

test("a receipt that carries a new row_version is used at once", async () => {
  const tr = t([{ outcome: "previewed", warnings: [] }, { outcome: "saved", row_id: "i-p", row_version: "v9" }]);
  const m = new SaveMachine({ transport: tr, table: "projects", rowId: "i-p", rowVersion: "v1" });
  await m.submit({ status: "Complete" });
  assert.equal(m.rowVersion, "v9");
  assert.equal(m.tokenStale, false);
});

test("a stale token is never reused silently — the next save previews, and the server's 'You changed' warning stops it for a confirm", async () => {
  const youWarn = { code: "changed_since_opened", by: "You", message: "You changed Status since you opened this record (in another tab or session). If you save, this version replaces that one." };
  const tr = t([
    { outcome: "previewed", warnings: [] }, { outcome: "saved", row_id: "i-p" },     // no row_version
    { outcome: "previewed", warnings: [youWarn] },                                    // next save
  ]);
  const m = new SaveMachine({ transport: tr, table: "projects", rowId: "i-p", rowVersion: "v1" });
  await m.submit({ status: "Complete" });
  assert.equal(m.tokenStale, true);
  await m.submit({ status: "Open" });
  assert.equal(tr.calls[2].input.preview, true, "the next save previews first");
  assert.equal(tr.calls[2].input.row_version, "v1", "the old token is still sent (rich text needs one)");
  assert.equal(m.state, "confirm", "the expected warning asks, it does not save over");
  assert.equal(tr.calls.length, 3, "nothing written without the person's confirm");
});

test("a re-read token with no row_version leaves the stale mark up", () => {
  const m = new SaveMachine({ transport: t([]), table: "projects", rowId: "i-p", rowVersion: "v1" });
  m.tokenStale = true;
  m.refreshToken(null);
  assert.equal(m.tokenStale, true);
  assert.equal(m.rowVersion, "v1");
});

test("abort while previewing: the preview's answer is dropped and nothing is written", async () => {
  let release;
  const calls = [];
  const tr = { call: (tool, input) => { calls.push(input); return new Promise((r) => { release = r; }); } };
  const m = new SaveMachine({ transport: tr, table: "tasks", rowId: "i-p", rowVersion: "v" });
  const p = m.submit({ status: "Complete" });
  assert.equal(m.state, "previewing");
  assert.equal(m.abort(), true);
  release({ outcome: "previewed", warnings: [] });
  await p;
  assert.equal(m.state, "idle");
  assert.equal(calls.length, 1, "the commit was never sent");
});

test("abort on the question is a cancel; a save already writing cannot be aborted", async () => {
  const tr = t([{ outcome: "previewed", warnings: [{ code: "changed_since_opened" }] }]);
  const m = new SaveMachine({ transport: tr, table: "projects", rowId: "i-p", rowVersion: "v" });
  await m.submit({ status: "Complete" });
  assert.equal(m.abort(), true);
  assert.equal(m.state, "idle");
  m.state = "saving";
  assert.equal(m.abort(), false);
});

/* ---- kit 1.5.0: confirmation (unconfirmed rows) ------------------------------------------
   A receipt or record that carries `confirmation` is the server saying the save is in TFS's
   reads ahead of Coda. Without it everything is exactly as before. Timers are injected. */
import { ConfirmWatch, confirmationKind, looksLikeCreateLag, POLL_EVERY_MS, POLL_LIMIT_MS } from "../save.js";

const flush = () => new Promise((r) => setImmediate(r));
function clock() {
  let now = 0; const q = [];
  return {
    timers: {
      setTimeout: (fn, ms) => { const tm = { at: now + ms, fn }; q.push(tm); return tm; },
      clearTimeout: (tm) => { const i = q.indexOf(tm); if (i >= 0) q.splice(i, 1); },
      now: () => now,
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await flush();
        q.sort((a, b) => a.at - b.at);
        const tm = q[0];
        if (!tm || tm.at > end) break;
        q.shift(); now = tm.at; tm.fn();
        await flush();
      }
      now = end; await flush();
    },
    pending: () => q.length,
  };
}
// Routes by tool: `save` and `read` are queues; the last read repeats once the queue is empty.
function routed({ save = [], read = [] }) {
  const calls = [];
  let lastRead = null;
  return { calls, call: async (tool, input, opt) => {
    calls.push({ tool, input, opt });
    if (tool === "get_record_for_editing") {
      const r = read.length ? read.shift() : lastRead; lastRead = r;
      if (r && r.code) throw r;
      return r;
    }
    const r = save.shift();
    if (r && r.code) throw r;
    return r;
  } };
}
const reads = (tr) => tr.calls.filter((c) => c.tool === "get_record_for_editing");
const writes = (tr) => tr.calls.filter((c) => c.tool === "save_record" && c.input.preview === false);
const UNCONF = { state: "unconfirmed", since: "2026-10-07T10:00:00Z", pending_fields: ["parent_task"], message: "Saved. Coda hasn't confirmed it yet — it usually does within a few minutes." };
const recUnconf = { row_id: "i-n", row_version: "v1", values: {}, confirmation: UNCONF };
const recConf = { row_id: "i-n", row_version: "v2", values: {}, confirmation: { state: "confirmed", pending_fields: [], message: "Saved, and Coda has confirmed it." } };
const LAG_REFUSAL = { outcome: "refused", warnings: [], refusals: [{ field: null, code: "pipeline", message: "Coda didn't take this one. Try again in a minute.", technical: "update failed: Client error '404 Not Found' for url 'https://coda.example/apis/v1/docs/d/tables/grid-x/rows/i-n'\nFor more information check: https://developer.example/404" }] };

test("the poll's timing is 15 s, for at most 10 minutes", () => {
  assert.equal(POLL_EVERY_MS, 15000);
  assert.equal(POLL_LIMIT_MS, 600000);
});

test("confirmationKind: unconfirmed keeps waiting; absent means settled; a refused read is a failure or gone", () => {
  assert.equal(confirmationKind(null), null, "an unreadable answer: ask again");
  assert.equal(confirmationKind(recUnconf), null);
  assert.equal(confirmationKind(recConf), "confirmed");
  assert.equal(confirmationKind({ row_id: "i-n", values: {} }), "confirmed", "nothing left to report: the record is as Coda has it");
  assert.equal(confirmationKind({ refused: "not_found", confirmation: { state: "failed" } }), "failed");
  assert.equal(confirmationKind({ refused: "not_found", confirmation: { state: "not_in_view" } }), "not_in_view");
  assert.equal(confirmationKind({ refused: "not_found" }), "gone");
  assert.equal(confirmationKind({ row_id: "i-n", confirmation: { state: "failed" } }), "failed");
});

test("looksLikeCreateLag: only Coda's row-not-found for THAT row", () => {
  assert.equal(looksLikeCreateLag(LAG_REFUSAL, "i-n"), true);
  assert.equal(looksLikeCreateLag(LAG_REFUSAL, "i-other"), false, "another row's 404 is not this record's create lag");
  assert.equal(looksLikeCreateLag(LAG_REFUSAL), false, "no row: never");
  const linked = { refusals: [{ code: "pipeline", message: "x", technical: "update failed: Client error '404 Not Found' for url 'https://coda.example/apis/v1/docs/d/tables/grid-y/rows/i-n/linked'" }] };
  assert.equal(looksLikeCreateLag(linked, "i-n"), false);
  const bare = { refusals: [{ code: "pipeline", message: "x", technical: "insert failed: value 404 for rows/i-n" }] };
  assert.equal(looksLikeCreateLag(bare, "i-n"), false, "a bare '404' somewhere is not Coda's answer");
  assert.equal(looksLikeCreateLag({ refusals: [{ code: "pipeline", message: "x", technical: "update failed: Client error '400 Bad Request' for url 'https://coda.example/rows/i-n'" }] }, "i-n"), false);
  assert.equal(looksLikeCreateLag({ refusals: [{ code: "unknown_field", message: "x" }] }, "i-n"), false);
  assert.equal(looksLikeCreateLag(null, "i-n"), false);
});

test("unconfirmed receipt polls every 15s and stops at 10 min", async () => {
  const c = clock();
  const tr = routed({ save: [{ outcome: "previewed", warnings: [] }, { outcome: "saved", row_id: "i-n", confirmation: UNCONF }], read: [recUnconf] });
  const m = new SaveMachine({ transport: tr, table: "tasks", rowId: "i-n", rowVersion: "v0", timers: c.timers });
  const seen = [];
  m.onConfirm((e) => seen.push(e.kind));
  await m.submit({ urgency: "High" });
  assert.equal(m.state, "saved_syncing");
  assert.equal(reads(tr).length, 0, "nothing asked at once");
  await c.advance(14999);
  assert.equal(reads(tr).length, 0);
  await c.advance(1);
  assert.equal(reads(tr).length, 1, "first ask at 15 s");
  assert.deepEqual(reads(tr)[0].input, { table: "tasks", row_id: "i-n" });
  assert.deepEqual(reads(tr)[0].opt, { fresh: true });
  await c.advance(600000);
  assert.equal(reads(tr).length, 40, "every 15 s for 10 minutes, then stop");
  assert.deepEqual(seen, ["timeout"]);
  assert.equal(m.watchTimedOut, true);
  await c.advance(3600000);
  assert.equal(reads(tr).length, 40, "nothing after the stop");
  assert.equal(c.pending(), 0);
});

test("confirmed is reported once, with the fresh record, and the poll stops", async () => {
  const c = clock();
  const tr = routed({ save: [{ outcome: "previewed", warnings: [] }, { outcome: "saved", row_id: "i-n", confirmation: UNCONF }], read: [recUnconf, recConf] });
  const m = new SaveMachine({ transport: tr, table: "tasks", rowId: "i-n", rowVersion: "v0", timers: c.timers });
  const seen = [];
  m.onConfirm((e) => seen.push(e));
  await m.submit({ urgency: "High" });
  await c.advance(120000);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "confirmed");
  assert.equal(seen[0].record.row_version, "v2");
  assert.equal(m.confirmation.state, "confirmed");
  assert.equal(reads(tr).length, 2);
  assert.equal(m.state, "saved_syncing");
});

test("receipt without confirmation keeps 1.0.1 behaviour: no poll, no confirmation, same states", async () => {
  const c = clock();
  const tr = routed({ save: [{ outcome: "previewed", warnings: [] }, { outcome: "saved", row_id: "i-1", lag: { new_row_editable_after: "x" } }] });
  const m = new SaveMachine({ transport: tr, table: "tasks", timers: c.timers });
  let told = 0; m.onConfirm(() => told++);
  await m.submit({ title: "x" });
  assert.equal(m.state, "saved_syncing");
  assert.equal(m.confirmation, null);
  await c.advance(3600000);
  assert.equal(reads(tr).length, 0);
  assert.equal(told, 0);
  assert.equal(c.pending(), 0);
  // …and a 404 refusal on a record with no confirmation is an ordinary refusal: no wait, no retry.
  const tr2 = routed({ save: [{ outcome: "previewed", warnings: [] }, LAG_REFUSAL] });
  const m2 = new SaveMachine({ transport: tr2, table: "tasks", rowId: "i-n", rowVersion: "v", timers: c.timers });
  await m2.submit({ urgency: "High" });
  assert.equal(m2.state, "refused");
  await c.advance(3600000);
  assert.equal(tr2.calls.length, 2);
});

test("an edit refused by Coda's create lag waits, then saves itself once Coda confirms — same key, same fields", async () => {
  const c = clock();
  const tr = routed({
    save: [{ outcome: "previewed", warnings: [] }, LAG_REFUSAL, { outcome: "previewed", warnings: [] }, { outcome: "saved", row_id: "i-n", confirmation: UNCONF }],
    read: [recUnconf, recConf, recUnconf],
  });
  const m = new SaveMachine({ transport: tr, table: "tasks", rowId: "i-n", rowVersion: "v1", confirmation: UNCONF, timers: c.timers });
  const states = [];
  m.onChange((x) => states.push(x.state));
  await m.submit({ urgency: "High" });
  assert.equal(m.state, "waiting_for_coda");
  assert.equal(m.busy(), true, "no second submit while it waits");
  await m.submit({ urgency: "Low" });
  assert.equal(tr.calls.filter((x) => x.tool === "save_record").length, 2, "a submit while waiting sends nothing");
  await c.advance(15000);
  assert.equal(m.state, "waiting_for_coda", "still unconfirmed at 15 s");
  await c.advance(15000);
  assert.equal(m.state, "saved_syncing");
  const saves = tr.calls.filter((x) => x.tool === "save_record");
  assert.equal(saves.length, 4);
  assert.equal(new Set(saves.map((x) => x.input.idempotency_key)).size, 1, "one key for the whole change");
  assert.deepEqual(saves.map((x) => x.input.fields), Array(4).fill({ urgency: "High" }));
  assert.equal(saves[3].input.row_version, "v1", "the token the person opened with: a real clash still asks");
  assert.equal(writes(tr).length, 2, "one refused write, one that saved — never two saves");
  assert.ok(states.includes("waiting_for_coda"));
  // The retried save is itself unconfirmed: it is watched, and nothing more is written.
  await c.advance(600000);
  assert.equal(writes(tr).length, 2);
});

test("a second create-lag refusal after Coda confirmed is shown, never retried again", async () => {
  const c = clock();
  const tr = routed({
    save: [{ outcome: "previewed", warnings: [] }, LAG_REFUSAL, { outcome: "previewed", warnings: [] }, LAG_REFUSAL],
    read: [recConf],
  });
  const m = new SaveMachine({ transport: tr, table: "tasks", rowId: "i-n", rowVersion: "v1", confirmation: UNCONF, timers: c.timers });
  await m.submit({ urgency: "High" });
  await c.advance(15000);
  assert.equal(m.state, "refused");
  await c.advance(3600000);
  assert.equal(writes(tr).length, 2);
});

test("the wait stops at 10 minutes and says so; nothing more is sent", async () => {
  const c = clock();
  const tr = routed({ save: [{ outcome: "previewed", warnings: [] }, LAG_REFUSAL], read: [recUnconf] });
  const m = new SaveMachine({ transport: tr, table: "tasks", rowId: "i-n", rowVersion: "v1", confirmation: UNCONF, timers: c.timers });
  await m.submit({ urgency: "High" });
  await c.advance(600000);
  assert.equal(m.state, "refused");
  assert.equal(m.receipt.refusals[0].code, "create_lag_timeout");
  assert.match(m.receipt.refusals[0].message, /Coda still hasn't finished creating this record, so your change wasn't saved\. Try saving again in a few minutes\./);
  assert.equal(writes(tr).length, 1);
  assert.equal(reads(tr).length, 40);
  // the person may save again: a fresh submission, a fresh key
  const before = tr.calls[0].input.idempotency_key;
  tr.calls.length = 0;
  await m.submit({ urgency: "High" });
  assert.notEqual(tr.calls[0].input.idempotency_key, before);
});

test("Coda never kept the record: the wait ends as not saved, with no retry", async () => {
  const c = clock();
  const failed = { refused: "not_found", message: "That record isn't available.", confirmation: { state: "failed", message: "Coda accepted the save but never added the task…", values_sent: { title: "x" } } };
  const tr = routed({ save: [{ outcome: "previewed", warnings: [] }, LAG_REFUSAL], read: [failed] });
  const m = new SaveMachine({ transport: tr, table: "tasks", rowId: "i-n", rowVersion: "v1", confirmation: UNCONF, timers: c.timers });
  await m.submit({ urgency: "High" });
  await c.advance(15000);
  assert.equal(m.state, "refused");
  assert.equal(m.confirmation.state, "failed");
  assert.equal(writes(tr).length, 1);
});

test("a create is never retried, even when it is refused with a 404", async () => {
  const c = clock();
  const tr = routed({ save: [{ outcome: "previewed", warnings: [] }, LAG_REFUSAL], read: [recConf] });
  const m = new SaveMachine({ transport: tr, table: "tasks", confirmation: UNCONF, timers: c.timers });
  await m.submit({ title: "x" });
  assert.equal(m.state, "refused");
  await c.advance(3600000);
  assert.equal(tr.calls.length, 2);
});

test("an opened record that is unconfirmed is watched; stopWatch ends it", async () => {
  const c = clock();
  const tr = routed({ read: [recUnconf] });
  const m = new SaveMachine({ transport: tr, table: "tasks", rowId: "i-n", rowVersion: "v1", confirmation: UNCONF, timers: c.timers });
  m.watchConfirmation();
  await c.advance(30000);
  assert.equal(reads(tr).length, 2);
  m.stopWatch();
  await c.advance(600000);
  assert.equal(reads(tr).length, 2);
  // a confirmed or absent confirmation is never watched
  const tr2 = routed({});
  const m2 = new SaveMachine({ transport: tr2, table: "tasks", rowId: "i-n", confirmation: recConf.confirmation, timers: c.timers });
  m2.watchConfirmation();
  await c.advance(600000);
  assert.equal(tr2.calls.length, 0);
});

test("a read that fails while polling is asked again, not treated as an answer", async () => {
  const c = clock();
  const tr = routed({ save: [{ outcome: "previewed", warnings: [] }, { outcome: "saved", row_id: "i-n", confirmation: UNCONF }], read: [{ code: "server_unavailable", message: "x" }, recConf] });
  const m = new SaveMachine({ transport: tr, table: "tasks", rowId: "i-n", rowVersion: "v1", timers: c.timers });
  const seen = []; m.onConfirm((e) => seen.push(e.kind));
  await m.submit({ urgency: "High" });
  await c.advance(30000);
  assert.deepEqual(seen, ["confirmed"]);
});

test("ConfirmWatch on its own: start is idempotent", async () => {
  const c = clock();
  const tr = routed({ read: [recUnconf] });
  const w = new ConfirmWatch({ transport: tr, table: "tasks", rowId: "i-n", timers: c.timers, onResult: () => {} });
  w.start(); w.start();
  await c.advance(15000);
  assert.equal(reads(tr).length, 1);
  w.stop();
});

test("watchSaves: false (the status menu) never polls after a save, but still waits out the create lag", async () => {
  const c = clock();
  const tr = routed({ save: [{ outcome: "previewed", warnings: [] }, { outcome: "saved", row_id: "i-n", confirmation: UNCONF }], read: [recUnconf] });
  const m = new SaveMachine({ transport: tr, table: "tasks", rowId: "i-n", rowVersion: "v1", timers: c.timers, watchSaves: false });
  await m.submit({ status: "Done" });
  assert.equal(m.confirmation.state, "unconfirmed");
  await c.advance(600000);
  assert.equal(reads(tr).length, 0);
  const tr2 = routed({ save: [{ outcome: "previewed", warnings: [] }, LAG_REFUSAL, { outcome: "previewed", warnings: [] }, { outcome: "saved", row_id: "i-n", confirmation: UNCONF }], read: [recConf] });
  const m2 = new SaveMachine({ transport: tr2, table: "tasks", rowId: "i-n", rowVersion: "v1", confirmation: UNCONF, timers: c.timers, watchSaves: false });
  await m2.submit({ status: "Done" });
  assert.equal(m2.state, "waiting_for_coda");
  await c.advance(15000);
  assert.equal(m2.state, "saved_syncing");
  await c.advance(600000);
  assert.equal(reads(tr2).length, 1, "no watch after the retried save either");
});

/* ---- fix round 1 ---------------------------------------------------------------------------- */

test("the re-sent save never asks 'You changed…' about the person's own CREATE: it saves", async () => {
  const c = clock();
  // `at` is the create's own write (the record's confirmation.since when the wait began).
  const own = { outcome: "previewed", warnings: [{ code: "changed_since_opened", fields: ["urgency"], by: "You", at: "2026-10-07T10:00:00.400Z", message: "You changed Urgency since you opened this record (in another tab or session)." }] };
  const tr = routed({ save: [{ outcome: "previewed", warnings: [] }, LAG_REFUSAL, own, { outcome: "saved", row_id: "i-n", confirmation: UNCONF }], read: [recConf] });
  const m = new SaveMachine({ transport: tr, table: "tasks", rowId: "i-n", rowVersion: "v1", confirmation: UNCONF, timers: c.timers, watchSaves: false });
  await m.submit({ urgency: "High" });
  await c.advance(15000);
  assert.equal(m.state, "saved_syncing");
  assert.equal(writes(tr).length, 2);
});

test("…but someone ELSE's change still asks, in the form (a terminal outcome the person sees)", async () => {
  const c = clock();
  const other = { outcome: "previewed", warnings: [{ code: "changed_since_opened", fields: ["urgency"], by: "Ana Example" }] };
  const tr = routed({ save: [{ outcome: "previewed", warnings: [] }, LAG_REFUSAL, other], read: [recConf] });
  const m = new SaveMachine({ transport: tr, table: "tasks", rowId: "i-n", rowVersion: "v1", confirmation: UNCONF, timers: c.timers });
  await m.submit({ urgency: "High" });
  await c.advance(15000);
  assert.equal(m.state, "confirm");
  assert.equal(writes(tr).length, 1);
});

test("abandonWait: the person chose to lose the waiting change — the wait stops, nothing more is sent", async () => {
  const c = clock();
  const tr = routed({ save: [{ outcome: "previewed", warnings: [] }, LAG_REFUSAL], read: [recConf] });
  const m = new SaveMachine({ transport: tr, table: "tasks", rowId: "i-n", rowVersion: "v1", confirmation: UNCONF, timers: c.timers });
  await m.submit({ urgency: "High" });
  assert.equal(m.holdsWaitingChange, true);
  m.abandonWait();
  assert.equal(m.state, "idle");
  assert.equal(m.holdsWaitingChange, false);
  assert.equal(c.pending(), 0);
  await c.advance(600000);
  assert.equal(tr.calls.length, 2);
});

test("the re-sent save's check cannot be silently aborted: abort() refuses, holdsWaitingChange stays true", async () => {
  const c = clock();
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const queue = [{ outcome: "previewed", warnings: [] }, LAG_REFUSAL, null, { outcome: "saved", row_id: "i-n" }];
  const tr = { calls, call: async (tool, input) => {
    calls.push({ tool, input });
    if (tool === "get_record_for_editing") return recConf;
    const r = queue.shift();
    if (r === null) { await gate; return { outcome: "previewed", warnings: [] }; }
    return r;
  } };
  const m = new SaveMachine({ transport: tr, table: "tasks", rowId: "i-n", rowVersion: "v1", confirmation: UNCONF, timers: c.timers, watchSaves: false });
  await m.submit({ urgency: "High" });
  await c.advance(15000);
  assert.equal(m.state, "previewing");
  assert.equal(m.retrying, true);
  assert.equal(m.holdsWaitingChange, true);
  assert.equal(m.abort(), false);
  release(); await flush(); await flush();
  assert.equal(m.state, "saved_syncing");
});

/* ---- fix round 2 ---------------------------------------------------------------------------- */

test("(d) a 'You' clash LATER than the create (another waiting change of theirs landed first) still asks", async () => {
  const c = clock();
  const later = { outcome: "previewed", warnings: [{ code: "changed_since_opened", fields: ["urgency"], by: "You", at: "2026-10-07T10:04:00Z" }] };
  const tr = routed({ save: [{ outcome: "previewed", warnings: [] }, LAG_REFUSAL, later], read: [recConf] });
  const m = new SaveMachine({ transport: tr, table: "tasks", rowId: "i-n", rowVersion: "v1", confirmation: UNCONF, timers: c.timers, watchSaves: false });
  await m.submit({ urgency: "High" });
  await c.advance(15000);
  assert.equal(m.state, "confirm", "never a silent overwrite of the person's other change");
  assert.equal(writes(tr).length, 1);
  // …and a 'You' clash with no time at all asks too
  const tr2 = routed({ save: [{ outcome: "previewed", warnings: [] }, LAG_REFUSAL, { outcome: "previewed", warnings: [{ code: "changed_since_opened", by: "You", at: null }] }], read: [recConf] });
  const m2 = new SaveMachine({ transport: tr2, table: "tasks", rowId: "i-n", rowVersion: "v1", confirmation: UNCONF, timers: c.timers, watchSaves: false });
  await m2.submit({ urgency: "High" });
  await c.advance(15000);
  assert.equal(m2.state, "confirm");
});

test("(c) abandonWait during the re-sent save's check: abandoned, no longer holding the change, ends idle", async () => {
  const c = clock();
  let release;
  const gate = new Promise((r) => { release = r; });
  const queue = [{ outcome: "previewed", warnings: [] }, LAG_REFUSAL, null];
  const calls = [];
  const tr = { calls, call: async (tool, input) => {
    calls.push({ tool, input });
    if (tool === "get_record_for_editing") return recConf;
    const r = queue.shift();
    if (r === null) { await gate; return { outcome: "previewed", warnings: [] }; }
    return r;
  } };
  const m = new SaveMachine({ transport: tr, table: "tasks", rowId: "i-n", rowVersion: "v1", confirmation: UNCONF, timers: c.timers, watchSaves: false });
  await m.submit({ urgency: "High" });
  await c.advance(15000);
  assert.equal(m.retrying, true);
  m.abandonWait();
  assert.equal(m.abandoned, true);
  assert.equal(m.holdsWaitingChange, false, "the person let it go: nothing to ask about any more");
  release(); await flush(); await flush();
  assert.equal(m.state, "idle");
  assert.equal(calls.filter((x) => x.tool === "save_record" && x.input.preview === false).length, 1, "the commit was not sent");
});
