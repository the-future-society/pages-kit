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
