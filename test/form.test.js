// The form's logic, extracted as pure functions so Node can test it without a DOM.
// Fixtures are invented; no real TFS record text appears here (public code).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dirtyFields, selectFields, wireOf, payloadFor, stateView, optionsWithCurrent, groupLines,
  richTextValue, TOOLBAR_COMMANDS, controlValue, textControlTag, safeHref,
  allowedLinkHref, LINK_REFUSED, badInputMessage, isEditable,
  initialAfterUnreadSave, formLocked, lockedByFieldset, formView, countLabel, addPhrase,
  missingRequired, refusalView, initials, markMatch, isStatusField, nounOf, noMatchText, shortUrl,
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
  assert.equal(LINK_REFUSED, "That doesn't look like a web address. Start it with https://");
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

/* ---- the record form's state table (design handover 2026-10-07), one test per row ---- */

const base = { phase: "ready", noun: "task", labelOf: (n) => ({ due: "Due date", status: "Status", org: "Organisation" }[n] || n) };
const btns = (v) => ({ close: v.close.label, save: v.save.hidden ? null : v.save.label, disabled: !!v.save.disabled, busy: !!v.save.busy });

test("loading: spinner line, Cancel, no Save", () => {
  const v = formView({ ...base, phase: "loading" });
  assert.deepEqual(v.footer, { text: "Loading the form…", spinner: true });
  assert.equal(v.close.label, "Cancel");
  assert.equal(v.save.hidden, true);
});

test("failed to load: error notice with Try again, Close", () => {
  const v = formView({ ...base, phase: "load_failed", loadError: { message: "The TFS server didn't answer. Nothing has been changed.", retry: true } });
  assert.equal(v.footer, null);
  assert.equal(v.notices[0].tone, "error");
  assert.equal(v.notices[0].title, "Couldn't load this form");
  assert.deepEqual(v.notices[0].paragraphs, [["The TFS server didn't answer. Nothing has been changed."]]);
  assert.deepEqual(v.notices[0].actions, [{ kind: "reload" }]);
  assert.equal(v.close.label, "Close");
  assert.equal(v.save.hidden, true);
});

test("no connector: the info notice telling them to add it", () => {
  const v = formView({ ...base, phase: "no_connector" });
  assert.equal(v.notices[0].tone, "info");
  assert.equal(v.notices[0].title, "Add the TFS connector to edit here");
  assert.match(v.notices[0].paragraphs[0][0], /under Connectors, then reload this page\.$/);
  assert.equal(v.close.label, "Close");
});

test("clean: 'No changes', Close, Save disabled", () => {
  const v = formView({ ...base, isUpdate: true, dirtyCount: 0 });
  assert.equal(v.footer.text, "No changes");
  assert.deepEqual(btns(v), { close: "Close", save: "Save changes", disabled: true, busy: false });
});

test("dirty: 'N unsaved change(s)', Cancel, Save", () => {
  assert.equal(formView({ ...base, isUpdate: true, dirtyCount: 1 }).footer.text, "1 unsaved change");
  const v = formView({ ...base, isUpdate: true, dirtyCount: 2 });
  assert.equal(v.footer.text, "2 unsaved changes");
  assert.deepEqual(btns(v), { close: "Cancel", save: "Save changes", disabled: false, busy: false });
  assert.equal(countLabel(0), "No changes");
});

test("checking: 'Checking with Coda…', Cancel stops it, Save busy 'Checking…', fields locked", () => {
  const v = formView({ ...base, isUpdate: true, dirtyCount: 1, state: "previewing" });
  assert.equal(v.footer.text, "Checking with Coda…");
  assert.deepEqual(v.close, { label: "Cancel", action: "abort" });
  assert.deepEqual(btns(v), { close: "Cancel", save: "Checking…", disabled: true, busy: true });
  assert.equal(v.locked, true);
});

test("conflict: warn notice naming who, when and which fields; Cancel, Save anyway", () => {
  const receipt = { warnings: [{ code: "changed_since_opened", fields: ["due"], by: "Ana Example", at: "2026-10-07T09:56:00Z", message: "x" }] };
  const v = formView({ ...base, isUpdate: true, dirtyCount: 1, state: "confirm", receipt, now: Date.parse("2026-10-07T10:00:00Z") });
  assert.equal(v.footer, null);
  assert.equal(v.notices[0].tone, "warn");
  assert.equal(v.notices[0].title, "Ana Example changed this task 4 minutes ago");
  assert.deepEqual(v.notices[0].paragraphs[0], ["They changed ", { strong: "Due date" }, ". Saving now replaces their version with yours. Save anyway?"]);
  assert.deepEqual(v.close, { label: "Cancel", action: "abort" });
  assert.equal(v.save.label, "Save anyway");
  assert.equal(v.save.action, "confirm");
});

test("conflict without who/when falls back to 'Someone changed this since you opened it'", () => {
  const v = formView({ ...base, isUpdate: true, state: "confirm", receipt: { warnings: [{ code: "changed_since_opened", fields: ["due", "status"], by: null, at: null }] } });
  assert.equal(v.notices[0].title, "Someone changed this since you opened it");
  assert.deepEqual(v.notices[0].paragraphs[0].filter((x) => typeof x === "object"), [{ strong: "Due date" }, { strong: "Status" }]);
});

test("a 'You changed' conflict after a save whose re-read failed is explained as the person's own save", () => {
  const r = { warnings: [{ code: "changed_since_opened", by: "You", fields: ["status"], message: "You changed Status." }] };
  const stale = formView({ ...base, isUpdate: true, state: "confirm", receipt: r, tokenStale: true });
  assert.equal(stale.notices[0].paragraphs.length, 2);
  assert.match(stale.notices[0].paragraphs[1][0], /probably your own save/);
  assert.equal(formView({ ...base, isUpdate: true, state: "confirm", receipt: r }).notices[0].paragraphs.length, 1);
  const other = { warnings: [{ code: "changed_since_opened", by: "Ana", fields: ["status"] }] };
  assert.equal(formView({ ...base, isUpdate: true, state: "confirm", receipt: other, tokenStale: true }).notices[0].paragraphs.length, 1, "someone else's change is never explained away");
});

test("saving: 'You can close this; the save carries on.', Close stays, Save busy, fields locked", () => {
  const v = formView({ ...base, isUpdate: true, dirtyCount: 1, state: "saving" });
  assert.equal(v.footer.text, "You can close this; the save carries on.");
  assert.deepEqual(btns(v), { close: "Close", save: "Saving…", disabled: true, busy: true });
  assert.equal(v.locked, true);
});

test("saved: the quiet ok line, Close, Save disabled; other warnings as info", () => {
  const v = formView({ ...base, isUpdate: true, state: "saved_syncing", receipt: { warnings: [{ code: "pipeline_warning", message: "Note." }] } });
  assert.deepEqual(v.footer, { text: "Saved · shows on pages within a few minutes", ok: true });
  assert.deepEqual(btns(v), { close: "Close", save: "Save changes", disabled: true, busy: false });
  assert.deepEqual(v.notices[0].list, ["Note."]);
  const created = formView({ ...base, state: "saved_syncing", receipt: { warnings: [], lag: { new_row_editable_after: "A new record can be edited after a few minutes." } } });
  assert.deepEqual(created.notices[0].paragraphs, [["A new record can be edited after a few minutes."]]);
  assert.equal(formView({ ...base, isUpdate: true, state: "saved_syncing", receipt: {}, rereadFailed: true }).footer.text, "Saved · refresh to see the latest");
  assert.equal(formView({ ...base, isUpdate: true, state: "saved_syncing", receipt: {}, dirtyCount: 1 }).footer.text, "1 unsaved change", "an edit after the save is dirty again");
});

test("outcome unknown: warn notice, Check in Coda link, Close; a retry only for an update", () => {
  const upd = formView({ ...base, isUpdate: true, state: "outcome_unknown", receipt: { message: "May have saved.", source: "https://coda.example/r" } });
  assert.equal(upd.notices[0].title, "Coda didn't confirm this save");
  assert.deepEqual(upd.notices[0].actions, [{ kind: "link", href: "https://coda.example/r", label: "Check in Coda" }, { kind: "retry" }]);
  assert.equal(upd.close.label, "Close");
  assert.equal(upd.save.hidden, true);
  const cre = formView({ ...base, state: "outcome_unknown", receipt: { source: null } });
  assert.deepEqual(cre.notices[0].actions, [], "a create is never retried, and no link without a source");
  assert.deepEqual(cre.notices[0].paragraphs, [["It may have gone through. Check Coda before trying again."]]);
});

test("refused: each field's message at its field; other messages listed; Cancel, Save", () => {
  const receipt = { refusals: [{ field: "org", message: "Add their organisation." }, { field: null, message: "Pages can't save this." }, { field: "hidden_one", message: "Not shown." }] };
  const v = formView({ ...base, isUpdate: true, dirtyCount: 1, state: "refused", receipt, shownNames: ["org", "due"] });
  assert.deepEqual(v.fieldErrors, { org: "Add their organisation." });
  assert.equal(v.notices[0].title, "Not saved: 3 things to fix");
  assert.deepEqual(v.notices[0].list, ["Pages can't save this.", "Not shown."]);
  assert.deepEqual(v.notices[0].paragraphs, [["One more is marked at its field."]]);
  assert.deepEqual(btns(v), { close: "Cancel", save: "Save changes", disabled: false, busy: false });
  const one = formView({ ...base, isUpdate: true, state: "refused", receipt: { refusals: [{ field: "org", message: "Add their organisation." }] }, shownNames: ["org"] });
  assert.equal(one.notices[0].title, "Not saved: 1 thing to fix");
  assert.deepEqual(one.notices[0].paragraphs, [["It is marked at its field."]]);
  assert.deepEqual(refusalView({ refusals: [{ field: "a", message: "x" }, { field: "a", message: "y" }] }, ["a"]).fieldErrors, { a: "x y" });
});

test("a local refusal (an unparseable date) is marked at its field, before anything is sent", () => {
  const v = formView({ ...base, isUpdate: true, dirtyCount: 1, localErrors: { due: "Due date isn't a valid date." } });
  assert.deepEqual(v.fieldErrors, { due: "Due date isn't a valid date." });
  assert.equal(v.notices[0].title, "Not saved: 1 thing to fix");
});

test("already saved: info notice, Close only", () => {
  const v = formView({ ...base, isUpdate: true, state: "saved_syncing", receipt: { warnings: [{ code: "already_saved", message: "x" }] } });
  assert.equal(v.notices[0].title, "Already saved");
  assert.deepEqual(v.notices[0].paragraphs, [["This was already saved earlier. Nothing new was written."]]);
  assert.equal(v.footer, null);
  assert.equal(v.save.hidden, true);
  assert.equal(v.close.label, "Close");
});

test("create, empty: the footer names the first missing required field; 'Add task' disabled", () => {
  const shown = [{ name: "title", label: "Title", required: true }, { name: "owner", label: "Owner", required: true }];
  const miss = missingRequired(shown, { title: null, owner: "r-1" });
  assert.equal(miss.name, "title");
  const v = formView({ ...base, missing: miss.label });
  assert.equal(v.footer.text, "Add a title to save");
  assert.deepEqual(btns(v), { close: "Cancel", save: "Add task", disabled: true, busy: false });
  assert.equal(addPhrase("Owner"), "Add an owner to save");
  assert.equal(addPhrase("KMS entry"), "Add a KMS entry to save");
  assert.equal(missingRequired(shown, { title: "x", owner: "r-1" }), null);
  assert.equal(formView({ ...base, missing: null }).save.disabled, false);
  assert.equal(formView({ ...base, saveLabel: "Add sub-task", missing: "Title" }).save.label, "Add sub-task");
});

test("words: nouns, initials, matches, no-match text, short urls", () => {
  assert.equal(nounOf("tasks"), "task");
  assert.equal(nounOf("kms_entries"), "KMS entry");
  assert.equal(nounOf("whatever"), "record");
  assert.equal(initials("Ana O'Example"), "AO");
  assert.equal(initials("Ana"), "A");
  assert.equal(initials(""), "?");
  assert.deepEqual(markMatch("Ben Sample", "en"), ["B", "en", " Sample"]);
  assert.deepEqual(markMatch("Ben Sample", "zz"), ["Ben Sample", "", ""]);
  assert.equal(noMatchText("team_member", "Simon"), "No current team member matches 'Simon'. Only current core-team members can be picked.");
  assert.equal(noMatchText("project", "x"), "No project matches 'x'.");
  assert.equal(shortUrl("https://drive.example/folders/abc/"), "drive.example/folders/abc");
});

test("a status field: `status`, or any single dropdown whose options carry colours", () => {
  assert.equal(isStatusField({ name: "status", kind: "dropdown", multi: false, options: [] }), true);
  assert.equal(isStatusField({ name: "stage", kind: "dropdown", multi: false, options: [{ value: "A", color: "#2F6EB5" }] }), true);
  assert.equal(isStatusField({ name: "urgency", kind: "dropdown", multi: false, options: [{ value: "High", label: "High" }] }), false);
  assert.equal(isStatusField({ name: "status", kind: "dropdown", multi: true }), false);
});
