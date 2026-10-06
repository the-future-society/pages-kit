// The form's logic, extracted as pure functions so Node can test it without a DOM.
// Fixtures are invented; no real TFS record text appears here (public code).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dirtyFields, selectFields, wireOf, payloadFor, stateView, optionsWithCurrent, groupLines,
  richTextValue, TOOLBAR_COMMANDS, controlValue, textControlTag, safeHref,
  allowedLinkHref, LINK_REFUSED, badInputMessage, isEditable,
  initialAfterUnreadSave, formLocked, lockedByFieldset,
} from "../form.js";

test("only changed fields are sent", () => {
  assert.deepEqual(dirtyFields({ status: "Old", urgency: null }, { status: "Old", urgency: "High" }), { urgency: "High" });
});

test("blanks are equal: an empty input over a null value is not a change", () => {
  assert.deepEqual(dirtyFields({ a: null, b: [], c: undefined }, { a: "", b: null, c: [] }), {});
});

test("a linked value compares by row id, a list as a set", () => {
  assert.deepEqual(dirtyFields({ owner: { row_id: "i-1", label: "A" } }, { owner: "i-1" }), {});
  assert.deepEqual(dirtyFields({ people: ["i-1", "i-2"] }, { people: ["i-2", "i-1"] }), {});
  assert.deepEqual(dirtyFields({ people: ["i-1"] }, { people: ["i-1", "i-2"] }), { people: ["i-1", "i-2"] });
});

test("a page may choose and order fields but never add one", () => {
  const served = [{ name: "title" }, { name: "status" }, { name: "notes" }];
  assert.deepEqual(selectFields(served, "notes,title,invented").map((f) => f.name), ["notes", "title"]);
  assert.deepEqual(selectFields(served, " status , status ").map((f) => f.name), ["status"]);
  assert.deepEqual(selectFields(served, null).map((f) => f.name), ["title", "status", "notes"]);
  assert.deepEqual(selectFields(served, "").map((f) => f.name), ["title", "status", "notes"]);
});

const F = {
  status: { name: "status", kind: "dropdown", multi: false },
  tags: { name: "tags", kind: "dropdown", multi: true },
  owner: { name: "owner", kind: "linked", multi: false },
  people: { name: "people", kind: "linked", multi: true },
  due: { name: "due", kind: "date", multi: false },
  amount: { name: "amount", kind: "number", multi: false },
  done: { name: "done", kind: "checkbox", multi: false },
  notes: { name: "notes", kind: "rich_text", multi: false },
  title: { name: "title", kind: "text", multi: false },
};

test("wire values: linked → row ids, dates → YYYY-MM-DD, numbers → numbers", () => {
  assert.equal(wireOf(F.owner, { row_id: "i-1", label: "A" }), "i-1");
  assert.equal(wireOf(F.owner, null), null);
  assert.deepEqual(wireOf(F.people, [{ row_id: "i-2", label: "B" }, { row_id: "i-1", label: "A" }]), ["i-2", "i-1"]);
  assert.deepEqual(wireOf(F.people, null), []);
  assert.equal(wireOf(F.due, "2026-10-02T00:00:00"), "2026-10-02");
  assert.equal(wireOf(F.amount, "12.5"), 12.5);
  assert.equal(wireOf(F.done, "false"), false);
  assert.equal(wireOf(F.done, null), null);
  assert.deepEqual(wireOf(F.tags, "One"), ["One"]);
});

test("an untouched field holding a value no longer offered is never sent (Review Focus 4)", () => {
  const initial = { status: "Archived-old", title: "Draft plan" };
  const current = { status: "Archived-old", title: "Final plan" };
  assert.deepEqual(payloadFor(F, initial, current), { title: "Final plan" });
});

test("an untouched date or linked field is not sent even though display and wire shapes differ", () => {
  const initial = { due: wireOf(F.due, "2026-10-02T00:00:00"), owner: wireOf(F.owner, { row_id: "i-1", label: "A" }) };
  assert.deepEqual(payloadFor(F, initial, { due: "2026-10-02", owner: "i-1" }), {});
});

test("an emptied field is sent as the pipeline's clear, never as null", () => {
  const initial = { title: "x", owner: "i-1", people: ["i-1"], notes: "## Old" };
  const current = { title: null, owner: null, people: [], notes: "" };
  assert.deepEqual(payloadFor(F, initial, current), { title: "", owner: "", people: [], notes: "" });
});

test("a name the server did not serve is dropped from the payload", () => {
  assert.deepEqual(payloadFor(F, {}, { invented: "x", title: "y" }), { title: "y" });
});

test("an untouched rich-text field returns its original markdown, byte for byte", () => {
  let called = false;
  const ser = () => { called = true; return "rewritten"; };
  assert.equal(richTextValue("**a**  \ntext", false, ser), "**a**  \ntext");
  assert.equal(called, false);
  assert.equal(richTextValue("x", true, ser), "rewritten");
  assert.equal(richTextValue(null, false, ser), null);
});

test("a dropdown keeps a value no longer offered", () => {
  const opts = optionsWithCurrent([{ value: "Open", label: "Open" }], "Retired");
  assert.deepEqual(opts.map((o) => o.label), ["Open", "Retired (no longer offered)"]);
  assert.equal(optionsWithCurrent([{ value: "Open", label: "Open" }], "Open").length, 1);
  assert.equal(optionsWithCurrent([{ value: "Open", label: "Open" }], null).length, 1);
});

test("required groups read as 'Choose at least one of'", () => {
  const served = [{ name: "project", label: "Project" }, { name: "parent_task", label: "Parent task" }];
  assert.deepEqual(groupLines([["project", "parent_task"]], served), ["Choose at least one of: Project, Parent task"]);
});

test("the toolbar is exactly the supported subset — no underline, no tables", () => {
  assert.deepEqual(TOOLBAR_COMMANDS, ["h1", "h2", "h3", "bold", "italic", "strike", "link", "ul", "ol", "task", "quote"]);
});

test("state text", () => {
  assert.deepEqual(stateView("saving", null).lines, ["Saving…"]);
  assert.equal(stateView("saved_syncing", { warnings: [] }, { isUpdate: true }).lines[0], "Saved · showing on pages within a few minutes");
  assert.match(stateView("saved_syncing", { warnings: [], lag: { new_row_editable_after: "A new record can be edited after a few minutes." } }).lines[0], /A new record can be edited after a few minutes\.$/);
  const saved = stateView("saved_syncing", { warnings: [{ code: "pipeline_warning", message: "Note." }, { code: "already_saved", message: "Already saved." }] }, { isUpdate: true });
  assert.deepEqual(saved.lines.slice(1), ["Already saved.", "Note."]);
  assert.deepEqual(stateView("refused", { refusals: [{ message: "One." }, { message: "Two." }] }).lines, ["One.", "Two."]);
  const conf = stateView("confirm", { warnings: [{ code: "changed_since_opened", message: "Ana changed Status." }] });
  assert.deepEqual(conf.lines, ["Ana changed Status."]);
  assert.deepEqual(conf.actions, ["save_anyway", "cancel"]);
});

test("outcome unknown: Check in Coda always; a retry only for an update", () => {
  const upd = stateView("outcome_unknown", { message: "May have saved.", source: "https://coda.example/r" }, { isUpdate: true });
  assert.deepEqual(upd.link, { href: "https://coda.example/r", text: "Check in Coda" });
  assert.deepEqual(upd.actions, ["retry"]);
  const cre = stateView("outcome_unknown", { message: "May have saved.", source: null }, { isUpdate: false });
  assert.deepEqual(cre.link, { href: null, text: "Check in Coda" });
  assert.deepEqual(cre.actions, []);
});

test("an untouched native control reports its initial wire value, never what the browser kept", () => {
  // The browser sanitises on set: <input type=text> drops newlines, url/email trim, date and
  // number blank an unparseable value. Read back, each would look changed and be sent.
  let reads = 0;
  const read = () => { reads++; return "one line"; };
  assert.equal(controlValue(false, read, "line one\nline two"), "line one\nline two");
  assert.equal(controlValue(false, () => null, "31/02/2026"), "31/02/2026");
  assert.equal(reads, 0);
  assert.equal(controlValue(true, read, "old"), "one line");
});

test("an untouched multi-line or unparseable value is not in the payload; a touched one is", () => {
  const initial = { title: "line one\nline two", due: "31/02/2026" };
  const untouched = { title: controlValue(false, () => "line oneline two", initial.title), due: controlValue(false, () => null, initial.due) };
  assert.deepEqual(payloadFor(F, initial, untouched), {});
  const touched = { title: controlValue(true, () => "edited", initial.title), due: controlValue(false, () => null, initial.due) };
  assert.deepEqual(payloadFor(F, initial, touched), { title: "edited" });
});

test("a multi-line text value gets a textarea; a single line keeps an input", () => {
  assert.equal(textControlTag("a\nb"), "textarea");
  assert.equal(textControlTag("a"), "input");
  assert.equal(textControlTag(null), "input");
});

test("only http(s) links become hrefs", () => {
  assert.equal(safeHref("https://coda.example/r"), "https://coda.example/r");
  assert.equal(safeHref("http://x.test"), "http://x.test");
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref(" https://x"), null);
  assert.equal(safeHref(null), null);
});

test("rich text: a gesture that leaves the serialisation at its baseline returns the ORIGINAL", () => {
  // A non-canonical stored twin (`* ` bullets, 4-space nesting) serialises differently from
  // itself; opening a link, a Cancel, a no-op toolbar press must not turn that into a rewrite.
  const original = "* a\n* b\n    * deep";
  const baseline = "- a\n- b\n  - deep";       // what htmlToMd made of it right after filling
  assert.equal(richTextValue(original, true, () => baseline, baseline), original);
  assert.equal(richTextValue(original, true, () => "- a\n- b\n  - deep\n- c", baseline), "- a\n- b\n  - deep\n- c");
  assert.equal(richTextValue(original, false, () => "anything", baseline), original);
  assert.equal(richTextValue(null, true, () => "", ""), null, "an empty field touched and left empty stays unset");
});

test("write-side links: http, https and mailto only", () => {
  for (const ok of ["https://example.org/a", "http://x.test", "mailto:someone@example.org", "HTTPS://X.TEST"]) {
    assert.equal(allowedLinkHref(ok), ok, ok);
  }
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "  https://x", "example.org", "", null, "vbscript:x", "ftp://x"]) {
    assert.equal(allowedLinkHref(bad), null, String(bad));
  }
  assert.equal(LINK_REFUSED, "Links must start with https://, http:// or mailto:");
});

test("an unparseable number or date refuses the save locally, naming the field", () => {
  const num = { name: "amount", label: "Amount", kind: "number" };
  const date = { name: "due", label: "Due date", kind: "date" };
  assert.equal(badInputMessage(num, { badInput: true, value: "" }), "Amount isn't a valid number.");
  assert.equal(badInputMessage(num, { badInput: false, rawText: "12,5", value: "" }), "Amount isn't a valid number.");
  assert.equal(badInputMessage(date, { badInput: true, value: "" }), "Due date isn't a valid date.");
  assert.equal(badInputMessage(num, { badInput: false, rawText: "", value: "" }), null, "an emptied field is a clear, not an error");
  assert.equal(badInputMessage(num, { badInput: false, value: "12.5" }), null);
  assert.equal(badInputMessage({ name: "t", label: "Title", kind: "text" }, { badInput: true }), null);
});

test("edit mode fails closed: only `editable === true` is editable", () => {
  assert.equal(isEditable(true), true);
  for (const v of [undefined, null, false, {}, { editable: true }, { editable: false, reason: "table" }, "true"]) {
    assert.equal(isEditable(v), false, JSON.stringify(v));
  }
});

test("a 'You changed' warning after a save whose re-read failed is explained as the person's own save", () => {
  const r = { warnings: [{ code: "changed_since_opened", by: "You", message: "You changed Status since you opened this record (in another tab or session). If you save, this version replaces that one." }] };
  const stale = stateView("confirm", r, { isUpdate: true, tokenStale: true });
  assert.equal(stale.lines.length, 2);
  assert.match(stale.lines[1], /probably your own save/);
  assert.equal(stateView("confirm", r, { isUpdate: true, tokenStale: false }).lines.length, 1);
  const other = { warnings: [{ code: "changed_since_opened", by: "Ana", message: "Ana changed Status." }] };
  assert.equal(stateView("confirm", other, { isUpdate: true, tokenStale: true }).lines.length, 1, "someone else's change is never explained away");
});

test("a save whose re-read failed: what was SENT becomes the starting point, nothing else", () => {
  const initial = { status: "Open", notes: "old", due: "2026-10-01" };
  const pending = { status: "Complete", due: "" };            // a clear is sent as ""
  const next = initialAfterUnreadSave(initial, pending);
  assert.deepEqual(next, { status: "Complete", notes: "old", due: "" });
  assert.deepEqual(initial, { status: "Open", notes: "old", due: "2026-10-01" }, "not mutated");
  // An edit typed after the save is NOT in `pending`, so it is still a change next time.
  const fieldsByName = { status: { kind: "dropdown" }, notes: { kind: "rich_text" }, due: { kind: "date" } };
  assert.deepEqual(payloadFor(fieldsByName, next, { status: "Complete", notes: "typed later", due: null }), { notes: "typed later" });
  assert.deepEqual(initialAfterUnreadSave(initial, null), initial);
});

test("the form is locked while the machine is busy AND while the record is re-read", () => {
  assert.equal(formLocked(true, false), true);
  assert.equal(formLocked(false, true), true);
  assert.equal(formLocked(false, false), false);
  assert.equal(formLocked(false, undefined), false);
});

test("lockedByFieldset: a picker inside a disabled fieldset is locked", () => {
  assert.equal(lockedByFieldset({ closest: () => ({ disabled: true }) }), true);
  assert.equal(lockedByFieldset({ closest: () => ({ disabled: false }) }), false);
  assert.equal(lockedByFieldset({ closest: () => null }), false);
  assert.equal(lockedByFieldset(null), false);
  assert.equal(lockedByFieldset({}), false);
});
