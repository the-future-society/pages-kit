// Kit 1.7.0: records the TFS database itself holds (power maps) read right. Invented fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formView, loadStatusOptions, offeredOptions, optionsWithCurrent, payloadFor, groupLines, wireOf, refusalView, recordFields } from "../form.js";
import { SaveMachine } from "../save.js";
import { kindOf, KINDS } from "../kind.js";

const base = { phase: "ready", noun: "record", labelOf: (n) => n };

test("a native (store tfs) save says it shows everywhere now, with no lag notice", () => {
  const receipt = { outcome: "saved", store: "tfs", lag: null, source: null, warnings: [] };
  for (const isUpdate of [true, false]) {
    const v = formView({ ...base, isUpdate, state: "saved_syncing", receipt });
    assert.deepEqual(v.footer, { text: "Saved · shows everywhere now", ok: true });
    assert.equal(v.notices.length, 0);
  }
  const lagged = formView({ ...base, state: "saved_syncing", receipt: { ...receipt, lag: { new_row_editable_after: "x" } } });
  assert.equal(lagged.notices.length, 0, "no lag notice for a native record");
});

test("an older server (no store) is unchanged", () => {
  const v = formView({ ...base, isUpdate: true, state: "saved_syncing", receipt: { outcome: "saved", warnings: [] } });
  assert.equal(v.footer.text, "Saved · shows on pages within a few minutes");
  const c = formView({ ...base, state: "saved_syncing", receipt: { warnings: [], lag: { new_row_editable_after: "x" } } });
  assert.deepEqual(c.notices[0].paragraphs, [["x"]]);
});

test("loadStatusOptions keeps the array and remembers the form's store", async () => {
  const opts = [{ value: "a", label: "A" }];
  const mk = (store) => ({ call: async () => ({ contract: 1, ...(store ? { store } : {}), fields: [{ name: "status", options: opts }] }) });
  const native = await loadStatusOptions(mk("tfs"), "power_map", "status");
  assert.ok(Array.isArray(native));
  assert.equal(native.length, 1);
  assert.equal(native.store, "tfs");
  const old = await loadStatusOptions(mk(null), "tasks", "status");
  assert.ok(Array.isArray(old));
  assert.equal(old.store, undefined);
});

test("power-map kinds are labelled, one shared tone", () => {
  const want = { power_map: "MAP", power_map_actor: "ACTOR", power_map_link: "LINK",
    power_map_judgement: "JUDGEMENT", power_map_node: "ACTOR", power_map_measure: "MEASURE" };
  const tones = new Set();
  for (const [t, label] of Object.entries(want)) {
    assert.equal(kindOf(t).label, label, t);
    tones.add(KINDS[t][1]);
  }
  assert.equal(tones.size, 1);
  assert.equal(kindOf("tasks").label, "Task");
});

// SPEC section 10: the served judgement create form.
const FORM = { contract: 1, store: "tfs", required_groups: [["value_num", "value_text"]], fields: [
  { name: "value_num", label: "Value", kind: "number" },
  { name: "value_text", label: "Value (list)", kind: "text" },
] };
const F = Object.fromEntries(FORM.fields.map((f) => [f.name, f]));

test("judgement form: both value fields are served and the group is stated", () => {
  assert.deepEqual(groupLines(FORM.required_groups, FORM.fields), ["Choose at least one of: Value, Value (list)"]);
});

test("judgement save sends only the value that was filled, in its own type", () => {
  assert.deepEqual(payloadFor(F, {}, { value_num: wireOf(F.value_num, "4"), value_text: null }), { value_num: 4 });
  assert.deepEqual(payloadFor(F, {}, { value_num: null, value_text: "Tier 1" }), { value_text: "Tier 1" });
});

test("judgement with neither value is refused by the server and the kit shows it, saving nothing", async () => {
  const calls = [];
  const transport = { call: async (tool, input) => {
    calls.push({ tool, input });
    return { contract: 1, outcome: "refused", store: "tfs", refusals: [{ field: "value_num", code: "required_group", message: "Choose a value." }], warnings: [] };
  } };
  const m = new SaveMachine({ transport, table: "power_map_judgement" });
  await m.submit(payloadFor(F, {}, { value_num: null, value_text: null }));
  assert.equal(m.state, "refused");
  assert.equal(calls.length, 1, "only the preview went out");
  assert.equal(calls[0].input.preview, true);
  assert.ok(refusalView(m.receipt, ["value_num"]).fieldErrors.value_num);
});

test("judgement save over the transport carries {value_num: 4} then {value_text: 'Tier 1'}", async () => {
  const sent = [];
  const transport = { call: async (tool, input) => {
    sent.push(input);
    return input.preview ? { contract: 1, outcome: "previewed", warnings: [] } : { contract: 1, outcome: "saved", store: "tfs", row_id: "r-1", lag: null, warnings: [] };
  } };
  for (const fields of [{ value_num: 4 }, { value_text: "Tier 1" }]) {
    const m = new SaveMachine({ transport, table: "power_map_judgement" });
    await m.submit(fields);
    if (m.state === "confirm") await m.confirm();
    assert.equal(m.state, "saved_syncing");
    assert.deepEqual(sent.filter((s) => !s.preview).pop().fields, fields);
  }
});

// Final review I1/M1: describe (no row) serves the union; the record's `editable` says which
// of those THIS row takes. A native record omits the rest rather than pointing at Coda.
const EDIT_SERVED = [{ name: "strength", kind: "number" }, { name: "note", kind: "text" },
  { name: "agent_status", kind: "dropdown", options: [{ value: "confirmed", label: "Confirmed" }, { value: "rejected", label: "Rejected" }] }];

test("a native record form omits a served field its editable does not list", () => {
  const personLink = { store: "tfs", values: { strength: 2, note: null }, editable: { strength: true, note: true } };
  assert.deepEqual(recordFields(EDIT_SERVED, personLink).map((f) => f.name), ["strength", "note"]);
  const agentLink = { store: "tfs", values: {}, editable: { strength: true, note: true, agent_status: true } };
  assert.deepEqual(recordFields(EDIT_SERVED, agentLink).map((f) => f.name), ["strength", "note", "agent_status"]);
  const crmNode = { store: "tfs", editable: { description: true, jurisdiction: true } };
  assert.deepEqual(recordFields([{ name: "name" }, { name: "description" }, { name: "jurisdiction" }], crmNode)
    .map((f) => f.name), ["description", "jurisdiction"]);
});

test("a Coda record (or an older server) still shows a served field it can't edit", () => {
  const coda = { values: {}, editable: { strength: true } };
  assert.deepEqual(recordFields(EDIT_SERVED, coda).map((f) => f.name), ["strength", "note", "agent_status"]);
  assert.deepEqual(recordFields(EDIT_SERVED, null).map((f) => f.name), ["strength", "note", "agent_status"], "create: all");
});

test("the status menu for agent_status offers exactly Confirmed and Rejected", async () => {
  const transport = { call: async (tool, input) => {
    assert.equal(tool, "describe_record_form");
    assert.deepEqual(input, { table: "power_map_link", mode: "edit" });
    return { contract: 1, store: "tfs", fields: EDIT_SERVED };
  } };
  const opts = await loadStatusOptions(transport, "power_map_link", "agent_status");
  assert.deepEqual(opts.map((o) => [o.value, o.label]), [["confirmed", "Confirmed"], ["rejected", "Rejected"]]);
  assert.equal(opts.store, "tfs");
});

const AI_OPTS = [
  { value: "pending", label: "AI-drafted, unconfirmed", hidden: true },
  { value: "confirmed", label: "Confirmed" },
  { value: "rejected", label: "Rejected" },
];

test("a hidden option labels the chip but is never offered as a choice", async () => {
  const { TfsStatusMenu } = await import("../actions.js");
  const el = new TfsStatusMenu();
  el._options = AI_OPTS;
  assert.equal(el._label("pending"), "AI-drafted, unconfirmed");
  assert.deepEqual(offeredOptions(AI_OPTS).map((o) => o.value), ["confirmed", "rejected"]);
});

test("optionsWithCurrent adds no retired duplicate for a hidden current value", () => {
  const got = optionsWithCurrent(AI_OPTS, "pending");
  assert.equal(got.length, 3);
  assert.ok(!got.some((o) => o.retired));
  assert.equal(optionsWithCurrent(AI_OPTS, "other").filter((o) => o.retired).length, 1);
});

test("options without hidden behave as before (older servers)", () => {
  const legacy = [{ value: "a", label: "A" }, "b"];
  assert.deepEqual(offeredOptions(legacy).map((o) => o.value ?? o), ["a", "b"]);
  assert.equal(optionsWithCurrent(legacy, "c")[2].label, "c (no longer offered)");
});
