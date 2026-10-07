// The status menu: keyboard, and the pick -> preview -> save sequence on a scripted transport.
// The DOM half (focus, open/close) is checked in a real browser (kit/test/gallery.html).
// Fixtures are invented; no real TFS record text appears here (public code).
import { test } from "node:test";
import assert from "node:assert/strict";
import { menuNav, pickAction, conflictCopy, relativeTime } from "../form.js";
import { StatusSave, statusOutcome, syncingValue, SYNC_WINDOW_MS } from "../actions.js";

const OPTIONS = [
  { value: "Not Started", label: "Not Started", color: "#9E9E9E" },
  { value: "In Progress", label: "In Progress", color: "#2F6EB5" },
  { value: "Complete", label: "Complete", color: "#2E7D45" },
];

// A scripted transport: answers per tool in order; a value with `code` is thrown.
function fake(script) {
  const calls = [];
  return { calls, call: async (tool, input, opt) => {
    calls.push({ tool, input: JSON.parse(JSON.stringify(input || {})), opt });
    const q = script[tool];
    if (!q || !q.length) throw { code: "bad_request", message: `unexpected ${tool}`, ambiguous: false };
    const r = q.shift();
    if (r && r.code) throw r;
    return typeof r === "function" ? r(input) : r;
  } };
}
const describe = () => ({ contract: 1, fields: [{ name: "status", kind: "dropdown", options: OPTIONS }] });
const record = (v = "v1") => ({ contract: 1, row_version: v, values: { status: "In Progress" }, source: "https://coda.example/r" });

test("keys: arrows wrap, Home/End jump, Enter/Space pick, Escape closes, Tab closes and moves on", () => {
  assert.deepEqual(menuNav(0, 3, "ArrowDown"), { active: 1, action: null });
  assert.deepEqual(menuNav(2, 3, "ArrowDown"), { active: 0, action: null }, "wraps forward");
  assert.deepEqual(menuNav(0, 3, "ArrowUp"), { active: 2, action: null }, "wraps back");
  assert.deepEqual(menuNav(1, 3, "Home"), { active: 0, action: null });
  assert.deepEqual(menuNav(0, 3, "End"), { active: 2, action: null });
  assert.equal(menuNav(1, 3, "Enter").action, "pick");
  assert.equal(menuNav(1, 3, " ").action, "pick");
  assert.equal(menuNav(1, 3, "Escape").action, "close");
  assert.equal(menuNav(1, 3, "Tab").action, "tab");
  assert.deepEqual(menuNav(1, 3, "x"), { active: 1, action: null });
  assert.deepEqual(menuNav(-1, 0, "ArrowDown"), { active: -1, action: null }, "an empty menu goes nowhere");
});

test("picking the current status just closes; another picks; nothing while a save is out", () => {
  assert.equal(pickAction("In Progress", "In Progress"), "close");
  assert.equal(pickAction("Complete", "In Progress"), "pick");
  assert.equal(pickAction("Complete", "In Progress", true), "ignore");
});

test("pick: load the record, preview, then save with a fresh key and the row's version", async () => {
  const tr = fake({
    describe_record_form: [describe()],
    get_record_for_editing: [record("v1")],
    save_record: [{ contract: 1, outcome: "previewed", warnings: [] }, { contract: 1, outcome: "saved", row_id: "r-1", warnings: [] }],
  });
  const s = new StatusSave({ transport: tr, table: "tasks", row: "r-1" });
  const opts = await s.options();
  assert.deepEqual(opts.map((o) => [o.value, o.color]), OPTIONS.map((o) => [o.value, o.color]), "Coda's order and colours, as served");
  assert.equal(await s.pick("Complete"), "saved_syncing");
  const tools = tr.calls.map((c) => c.tool);
  assert.deepEqual(tools, ["describe_record_form", "get_record_for_editing", "save_record", "save_record"]);
  assert.deepEqual(tr.calls[0].input, { table: "tasks", mode: "edit" });
  assert.deepEqual(tr.calls[1].opt, { fresh: true }, "the record is read fresh: its version decides 'changed since'");
  const [pre, commit] = tr.calls.slice(2);
  assert.equal(pre.input.preview, true);
  assert.equal(commit.input.preview, false);
  assert.deepEqual(commit.opt, { write: true });
  assert.deepEqual(commit.input.fields, { status: "Complete" }, "only the status is sent");
  assert.equal(commit.input.row_id, "r-1");
  assert.equal(commit.input.row_version, "v1");
  assert.equal(typeof commit.input.idempotency_key, "string");
  assert.ok(commit.input.idempotency_key.length >= 8);
  assert.deepEqual(statusOutcome("saved_syncing"), { close: true, message: null, hint: null });
});

test("a second pick re-reads the record and uses a NEW key", async () => {
  const tr = fake({
    get_record_for_editing: [record("v1"), record("v2")],
    save_record: [{ outcome: "previewed", warnings: [] }, { outcome: "saved", warnings: [] },
      { outcome: "previewed", warnings: [] }, { outcome: "saved", warnings: [] }],
  });
  const s = new StatusSave({ transport: tr, table: "tasks", row: "r-1" });
  await s.pick("Complete");
  await s.pick("Not Started");
  const saves = tr.calls.filter((c) => c.tool === "save_record" && c.input.preview === false);
  assert.equal(tr.calls.filter((c) => c.tool === "get_record_for_editing").length, 2);
  assert.equal(saves[1].input.row_version, "v2");
  assert.notEqual(saves[0].input.idempotency_key, saves[1].input.idempotency_key);
});

test("conflict: the preview's changed_since_opened stops the save and asks; Save anyway saves", async () => {
  const warning = { code: "changed_since_opened", fields: ["status"], by: "Ana Example", at: "2026-10-07T10:00:00Z", message: "Ana Example changed Status since you opened this record." };
  const tr = fake({
    get_record_for_editing: [record("v1")],
    save_record: [{ outcome: "previewed", warnings: [warning] }, { outcome: "saved", warnings: [] }],
  });
  const s = new StatusSave({ transport: tr, table: "tasks", row: "r-1" });
  assert.equal(await s.pick("Complete"), "confirm");
  assert.equal(tr.calls.filter((c) => c.tool === "save_record").length, 1, "nothing written while the person decides");
  const out = statusOutcome("confirm");
  assert.equal(out.close, false); assert.equal(out.ask, true); assert.equal(out.message, "warn");
  const c = conflictCopy(warning, { noun: "task", labelOf: () => "Status", now: Date.parse("2026-10-07T10:04:00Z") });
  assert.equal(c.title, "Ana Example changed this task 4 minutes ago");
  assert.deepEqual(c.paragraphs[0], ["They changed ", { strong: "Status" }, ". Saving now replaces their version with yours. Save anyway?"]);
  assert.equal(await s.confirm(), "saved_syncing");
  assert.equal(tr.calls.filter((c2) => c2.tool === "save_record").length, 2);
});

test("conflict, Cancel: nothing is written and the next pick can go ahead", async () => {
  const tr = fake({
    get_record_for_editing: [record("v1")],
    save_record: [{ outcome: "previewed", warnings: [{ code: "changed_since_opened", fields: ["status"], by: null, at: null }] }],
  });
  const s = new StatusSave({ transport: tr, table: "tasks", row: "r-1" });
  assert.equal(await s.pick("Complete"), "confirm");
  s.cancel();
  assert.equal(s.machine.state, "idle");
  assert.equal(tr.calls.filter((c) => c.tool === "save_record").length, 1);
});

test("failure: a refusal keeps the menu open with the server's words", async () => {
  const tr = fake({
    get_record_for_editing: [record("v1")],
    save_record: [{ outcome: "refused", refusals: [{ field: "status", code: "bad_value", message: "This task has 2 open sub-tasks." }] }],
  });
  const s = new StatusSave({ transport: tr, table: "tasks", row: "r-1" });
  assert.equal(await s.pick("Complete"), "refused");
  assert.equal(s.machine.receipt.refusals[0].message, "This task has 2 open sub-tasks.");
  assert.deepEqual(statusOutcome("refused"), { close: false, message: "error", hint: null });
});

test("a failed PREVIEW is 'not saved' (a preview writes nothing), whatever the error", async () => {
  const tr = fake({
    get_record_for_editing: [record("v1")],
    save_record: [{ code: "server_unavailable", message: "The TFS server didn't answer in time.", ambiguous: true }],
  });
  const s = new StatusSave({ transport: tr, table: "tasks", row: "r-1" });
  assert.equal(await s.pick("Complete"), "refused");
});

test("a dropped SAVE is outcome-unknown: the row says Unconfirmed and Check in Coda is offered", async () => {
  const tr = fake({
    get_record_for_editing: [record("v1")],
    save_record: [{ outcome: "previewed", warnings: [] }, { code: "upstream_error", message: "dropped", ambiguous: true }],
  });
  const s = new StatusSave({ transport: tr, table: "tasks", row: "r-1" });
  assert.equal(await s.pick("Complete"), "outcome_unknown");
  assert.equal(s.machine.receipt.source, "https://coda.example/r");
  assert.deepEqual(statusOutcome("outcome_unknown"), { close: false, message: "warn", hint: "Unconfirmed" });
});

test("a record that cannot be loaded is refused before any save", async () => {
  const tr = fake({ get_record_for_editing: [{ contract: 1, refused: "not_found", message: "That record isn't available." }] });
  const s = new StatusSave({ transport: tr, table: "tasks", row: "r-1" });
  await assert.rejects(s.pick("Complete"), (e) => e.message === "That record isn't available.");
  assert.equal(tr.calls.filter((c) => c.tool === "save_record").length, 0);
});

test("syncing: a list redrawn with the OLD value shows the saved one until TFS catches up", () => {
  const store = new Map([["tasks|r-1|status", { value: "Complete", at: 1000 }]]);
  assert.equal(syncingValue(store, "tasks|r-1|status", "In Progress", 2000), "Complete");
  assert.equal(syncingValue(store, "tasks|r-1|status", "Complete", 3000), null, "caught up");
  assert.equal(store.size, 0, "and forgotten");
  store.set("k", { value: "Complete", at: 0 });
  assert.equal(syncingValue(store, "k", "In Progress", SYNC_WINDOW_MS + 1), null, "the window has passed");
  assert.equal(syncingValue(new Map(), "k", "x"), null);
});

test("conflict wording: 'You', unknown writer, and the times", () => {
  const you = conflictCopy({ by: "You", fields: ["status"], at: null }, { noun: "task", tokenStale: true });
  assert.equal(you.title, "You changed this task since you opened it");
  assert.match(you.paragraphs[1][0], /probably your own save/);
  const nobody = conflictCopy({ by: null, fields: [], at: null }, { noun: "task" });
  assert.equal(nobody.title, "Someone changed this since you opened it");
  const now = Date.parse("2026-10-07T12:00:00Z");
  assert.equal(relativeTime("2026-10-07T11:59:30Z", now), "just now");
  assert.equal(relativeTime("2026-10-07T11:59:00Z", now), "1 minute ago");
  assert.equal(relativeTime("2026-10-07T10:00:00Z", now), "2 hours ago");
  assert.equal(relativeTime("2026-10-05T12:00:00Z", now), "2 days ago");
  assert.equal(relativeTime("not a date", now), "");
});

// "Refresh from Coda" (2026-10-07): one call, refresh:true, never a write; the outcome is the
// server's, and no outcome claims the record is now up to date.
test("refreshFromCoda asks the server to re-read the record and reports what it found", async () => {
  const tr = fake({ get_record_for_editing: [(i) => {
    assert.deepEqual(i, { table: "tasks", row_id: "r-1", refresh: true });
    return { contract: 1, row_version: "v2", values: { status: "Complete" }, refreshed: { outcome: "updated", message: "Updated from Coda." } };
  }] });
  const s = new StatusSave({ transport: tr, table: "tasks", row: "r-1" });
  assert.deepEqual(await s.refreshFromCoda(), { outcome: "updated", message: "Updated from Coda.", value: "Complete" });
  assert.deepEqual(tr.calls.map((c) => c.tool), ["get_record_for_editing"], "no save_record: a refresh never writes to Coda");
  assert.equal(tr.calls[0].opt.fresh, true);
});

test("refreshFromCoda: a refused record or an older server is reported, never thrown", async () => {
  const gone = fake({ get_record_for_editing: [{ contract: 1, refused: "not_found", message: "That record isn't available." }] });
  assert.equal((await new StatusSave({ transport: gone, table: "tasks", row: "r-1" }).refreshFromCoda()).outcome, "unavailable");
  const old = fake({ get_record_for_editing: [{ contract: 1, row_version: "v1", values: { status: "In Progress" } }] });
  const r = await new StatusSave({ transport: old, table: "tasks", row: "r-1" }).refreshFromCoda();
  assert.equal(r.outcome, "unavailable");
  assert.match(r.message, /can't refresh/);
});
