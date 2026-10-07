// The delete flow: preview -> confirm -> delete on a scripted transport, every outcome, and
// what the dialog shows for each state. The dialog itself (showModal, focus, Escape) is checked
// in a real browser (kit/test/gallery.html). Fixtures are invented (public code).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DeleteFlow, deleteView, deleteBody } from "../actions.js";

function fake(answers) {
  const calls = [];
  return { calls, call: async (tool, input, opt) => {
    calls.push({ tool, input: JSON.parse(JSON.stringify(input || {})), opt });
    const r = answers.shift();
    if (r && r.code) throw r;
    return r;
  } };
}
const PREVIEW = { contract: 1, outcome: "previewed", refusals: [], title: "Draft the brief", source: "https://coda.example/t",
  confirm_code: "d1.code", message: "Delete “Draft the brief”? It disappears from Coda and every TFS page. TFS keeps a copy of the deleted task, so the TFS MCP Server owner can bring it back if you need it (as a new task)." };

test("preview, then the confirm sends preview=false with the preview's confirm_code", async () => {
  const tr = fake([PREVIEW, { contract: 1, outcome: "deleted", refusals: [], title: "Draft the brief" }]);
  const f = new DeleteFlow({ transport: tr, row: "r-1", title: "Draft the brief" });
  const seen = [];
  f.onChange((x) => seen.push(x.state));
  await f.start();
  assert.equal(f.state, "confirm");
  assert.deepEqual(tr.calls[0].input, { table: "tasks", row_id: "r-1", preview: true });
  await f.confirm();
  assert.equal(f.state, "deleted");
  assert.deepEqual(tr.calls[1].input, { table: "tasks", row_id: "r-1", preview: false, confirm_code: "d1.code" });
  assert.deepEqual(tr.calls[1].opt, { write: true });
  assert.deepEqual(seen, ["checking", "confirm", "deleting", "deleted"]);
});

test("nothing is deleted until the person confirms", async () => {
  const tr = fake([PREVIEW]);
  const f = new DeleteFlow({ transport: tr, row: "r-1" });
  await f.start();
  assert.equal(tr.calls.length, 1);
  assert.equal(tr.calls.filter((c) => c.input.preview === false).length, 0);
});

test("a refusal shows the server's sentence and deletes nothing", async () => {
  const msg = "“Prepare for Board Meeting” has 3 sub-tasks. Delete or move them first, or set this task to Cancelled instead.";
  const tr = fake([{ contract: 1, outcome: "refused", refusals: [{ code: "has_subtasks", message: msg }], source: "https://coda.example/t" }]);
  const f = new DeleteFlow({ transport: tr, row: "r-1", title: "Prepare for Board Meeting" });
  await f.start();
  assert.equal(f.state, "refused");
  const v = deleteView(f.state, f.data, f.title);
  assert.equal(v.title, "Can't delete 'Prepare for Board Meeting'");
  assert.deepEqual(v.msg.paragraphs, [[msg]]);
  assert.deepEqual(v.buttons.map((b) => b.label), ["Close"]);
});

test("a refusal at the DELETE step (an expired code) is shown the same way", async () => {
  const tr = fake([PREVIEW, { contract: 1, outcome: "refused", refusals: [{ code: "confirm_required", message: "Please confirm the delete again." }] }]);
  const f = new DeleteFlow({ transport: tr, row: "r-1" });
  await f.start(); await f.confirm();
  assert.equal(f.state, "refused");
  assert.deepEqual(f.data.messages, ["Please confirm the delete again."]);
});

test("outcome unknown from the server: Check in Coda, with its source", async () => {
  const tr = fake([PREVIEW, { contract: 1, outcome: "unknown", refusals: [], source: "https://coda.example/t2", message: "Coda didn't confirm the delete." }]);
  const f = new DeleteFlow({ transport: tr, row: "r-1" });
  await f.start(); await f.confirm();
  assert.equal(f.state, "unknown");
  const v = deleteView(f.state, f.data, "Draft the brief");
  assert.equal(v.title, "Delete 'Draft the brief'?");
  assert.equal(v.msg.title, "Coda didn't confirm the delete");
  assert.equal(v.link, "https://coda.example/t2");
});

test("a dropped delete call is outcome unknown (it may have deleted), linking the preview's source", async () => {
  const tr = fake([PREVIEW, { code: "upstream_error", message: "dropped", ambiguous: true }]);
  const f = new DeleteFlow({ transport: tr, row: "r-1" });
  await f.start(); await f.confirm();
  assert.equal(f.state, "unknown");
  assert.equal(deleteView(f.state, f.data).link, "https://coda.example/t");
});

test("a call that never left (not ambiguous) is a plain refusal", async () => {
  const tr = fake([PREVIEW, { code: "not_in_manifest", message: "This page isn't allowed to use that TFS tool.", ambiguous: false }]);
  const f = new DeleteFlow({ transport: tr, row: "r-1" });
  await f.start(); await f.confirm();
  assert.equal(f.state, "refused");
  assert.match(f.data.messages[0], /Nothing was deleted\.$/);
});

test("Escape / Cancel while checking: the late preview answer is ignored, nothing deleted", async () => {
  let release;
  const tr = { calls: [], call: (tool, input) => { tr.calls.push(input); return new Promise((r) => { release = r; }); } };
  const f = new DeleteFlow({ transport: tr, row: "r-1" });
  const p = f.start();
  assert.equal(f.state, "checking");
  assert.equal(f.cancel(), true);
  release(PREVIEW);
  await p;
  assert.equal(f.state, "closed");
  assert.equal(tr.calls.length, 1);
});

test("Escape / Cancel on the question closes without deleting; not while deleting", async () => {
  let release;
  const tr = { calls: [], call: (tool, input) => { tr.calls.push(input); return input.preview ? PREVIEW : new Promise((r) => { release = r; }); } };
  const f = new DeleteFlow({ transport: tr, row: "r-1" });
  await f.start();
  const p = f.confirm();
  assert.equal(f.state, "deleting");
  assert.equal(f.cancel(), false, "a delete in flight cannot be cancelled");
  release({ outcome: "deleted", refusals: [] });
  await p;
  assert.equal(f.state, "deleted");
  const g = new DeleteFlow({ transport: fake([PREVIEW]), row: "r-2" });
  await g.start();
  assert.equal(g.cancel(), true);
  assert.equal(g.state, "closed");
});

test("the dialog's faces, per the handover's table", () => {
  const checking = deleteView("checking", {}, "Draft the brief");
  assert.equal(checking.title, "Delete this task?");
  assert.equal(checking.text, "Checking whether it can be deleted…");
  assert.deepEqual(checking.buttons.map((b) => [b.label, !!b.disabled]), [["Cancel", false], ["Delete task", true]]);
  const confirm = deleteView("confirm", { message: PREVIEW.message }, "Draft the brief");
  assert.equal(confirm.title, "Delete 'Draft the brief'?");
  assert.match(confirm.text, /^It disappears from Coda and every TFS page\. TFS keeps a copy/, "the server's words, without repeating the question");
  assert.equal(confirm.buttons[0].focus, true, "Cancel has initial focus");
  assert.equal(confirm.buttons[1].danger, true);
  const deleting = deleteView("deleting", { message: PREVIEW.message }, "Draft the brief");
  assert.deepEqual(deleting.buttons.map((b) => [b.label, !!b.disabled, !!b.busy]), [["Cancel", true, false], ["Deleting…", false, true]]);
  const deleted = deleteView("deleted", {}, "Draft the brief");
  assert.equal(deleted.title, "Deleted");
  assert.equal(deleted.msg.tone, "ok");
});

test("deleteBody keeps the whole message when it is not in the expected shape", () => {
  assert.equal(deleteBody("Something else."), "Something else.");
  assert.equal(deleteBody("Delete “X”? Rest."), "Rest.");
});
