// <tfs-map-people> (K2) and <tfs-quick-contact> (K3): the logic a person relies on — who counts
// as already on the map, how an organisation's people are grouped, what the bulk-add progress
// and failure lines say, the either/or workplace rule, and reading a duplicate refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SHAPES, splitActorId, kindOfMatch, mapsInHint, hintLine, otherMapsBadge, idVariants, isOnMap,
  matchView, newContactText, startName, moveHighlight, firstEnabled, buildOrgTree, countPeople,
  contactsLabel, treeGroups, bulkProgressText, bulkProgressPct, bulkFailureView, addedLine,
  nodeIdFromRowId, todayIso, judgementFields, stanceText, scoresOffered, outcomeOf, saveOnce,
  removeActor, restoreActor, UNKNOWN_SAVE, workplaceAnswered, EITHER_OR_RULE, duplicateFrom,
  contactHint, orgFormFields, choicesOf, orgPick,
} from "../map-people.js";

/* ---------------------------------------------------------------- matches */

test("a picker match's shape comes from its id prefix, or a map actor's kind word", () => {
  assert.equal(kindOfMatch("contact:i-abc", "OECD · not on a map yet"), "person");
  assert.equal(kindOfMatch("org:i-abc", "oecd.org · not on a map yet"), "organization");
  assert.equal(kindOfMatch("node:u1", "Seat · on 1 map"), "seat");
  assert.equal(kindOfMatch("node:u1", "Forum · on 2 maps"), "forum");
  assert.equal(kindOfMatch("node:u1", "Country · on 1 map"), "country");
  assert.equal(kindOfMatch("node:u1", "Group · on 1 map"), "group");
  assert.equal(kindOfMatch("node:u1", null), "person");
  for (const k of ["person", "organization", "seat", "group", "forum", "country"]) assert.ok(SHAPES[k], k);
});

test("the map count is read from the hint; the hint line drops the kind word and the count", () => {
  assert.equal(mapsInHint("Person · on 3 maps"), 3);
  assert.equal(mapsInHint("Seat · on 1 map"), 1);
  assert.equal(mapsInHint("OECD · not on a map yet"), 0);
  assert.equal(mapsInHint("OECD"), null);
  assert.equal(hintLine("node:u1", "Person · on 3 maps"), "");
  assert.equal(hintLine("node:u1", "Seat · on 1 map"), "Seat");
  assert.equal(hintLine("contact:i-1", "OECD · not on a map yet"), "OECD");
  assert.equal(hintLine("org:i-1", "not on a map yet"), "Organisation");
});

test("other-maps badge words", () => {
  assert.equal(otherMapsBadge(1), "On 1 other map");
  assert.equal(otherMapsBadge(3), "On 3 other maps");
  assert.equal(otherMapsBadge(0), "");
  assert.equal(otherMapsBadge(null), "");
});

test("onMap matches either spelling of a node or a contact", () => {
  assert.deepEqual(splitActorId("node:abc"), { prefix: "node", id: "abc" });
  assert.deepEqual(splitActorId("i-1"), { prefix: "", id: "i-1" });
  assert.deepEqual(idVariants("node:abc"), ["node:abc", "abc"]);
  assert.deepEqual(idVariants("i-1"), ["i-1", "contact:i-1", "node:i-1"]);
  const bare = new Set(["abc", "i-1"]);
  assert.equal(isOnMap(bare, "node:abc"), true);
  assert.equal(isOnMap(bare, "contact:i-1"), true);
  assert.equal(isOnMap(bare, "i-1"), true);
  assert.equal(isOnMap(new Set(["node:abc"]), "node:abc"), true);
  assert.equal(isOnMap(new Set(["contact:i-2"]), "i-2"), true);
  assert.equal(isOnMap(["abc"], "node:abc"), true, "an array works too");
  assert.equal(isOnMap(bare, "node:zzz"), false);
  assert.equal(isOnMap(null, "node:abc"), false, "no onMap: nobody is on it");
  assert.equal(isOnMap(bare, ""), false);
});

test("a match already on the map is disabled and says so; others show their other maps", () => {
  const on = matchView({ row_id: "node:abc", label: "Marco Bellini", hint: "Person · on 2 maps" }, new Set(["abc"]));
  assert.deepEqual(on, { id: "node:abc", label: "Marco Bellini", kind: "person", hint: "",
    badge: "Already on this map", badgeOn: true, disabled: true });
  const off = matchView({ row_id: "node:def", label: "Mariana Costa", hint: "Person · on 3 maps" }, new Set(["abc"]));
  assert.equal(off.badge, "On 3 other maps");
  assert.equal(off.disabled, false);
  const crm = matchView({ row_id: "contact:i-9", label: "New Person", hint: "OECD · not on a map yet" }, null);
  assert.equal(crm.badge, "");
  assert.equal(crm.hint, "OECD");
});

test("the new-contact item and the name it starts from", () => {
  assert.equal(newContactText(" mar "), "Add “mar” as a new contact");
  assert.equal(startName("  lucía   ferraro "), "Lucía ferraro");
  assert.equal(startName(""), "");
});

test("arrow keys skip rows already on the map and wrap", () => {
  const rows = [{ disabled: true }, { disabled: false }, { disabled: true }, { disabled: false }];
  assert.equal(firstEnabled(rows), 1);
  assert.equal(moveHighlight(rows, 1, "ArrowDown"), 3);
  assert.equal(moveHighlight(rows, 3, "ArrowDown"), 1);
  assert.equal(moveHighlight(rows, 1, "ArrowUp"), 3);
  assert.equal(moveHighlight(rows, -1, "ArrowDown"), 1);
  assert.equal(moveHighlight([{ disabled: true }], 0, "ArrowDown"), -1);
  assert.equal(moveHighlight([], -1, "ArrowDown"), -1);
});

/* ---------------------------------------------------------------- browse an organisation */

const SUB = [
  { coda_row_id: "i-cnect", name: "DG CNECT", part_of_coda_row_id: "i-ec", part_of_name: "European Commission", depth: 1 },
  { coda_row_id: "i-aio", name: "AI Office", part_of_coda_row_id: "i-cnect", part_of_name: "DG CNECT", depth: 2 },
  { coda_row_id: "i-just", name: "DG JUST", part_of_coda_row_id: "i-ec", depth: 1 },
  { coda_row_id: "i-empty", name: "Empty unit", part_of_coda_row_id: "i-ec", depth: 1 },
  { coda_row_id: "i-orphan", name: "Hidden parent's unit", part_of_coda_row_id: null, depth: 2 },
];
const ROWS = [
  { coda_row_id: "i-p1", full_name: "Ursula B", position: "Director", primary_org_coda_row_id: "i-aio" },
  { coda_row_id: "i-p2", full_name: "Ana F", position: "Head of Unit", primary_org_coda_row_id: "i-cnect" },
  { coda_row_id: "i-p3", full_name: "Marco B", position: null, primary_org_coda_row_id: "i-just" },
  { coda_row_id: "i-p4", full_name: "Zed Root", position: "Adviser", primary_org_coda_row_id: "i-ec" },
  { coda_row_id: "i-p5", full_name: "Secondary Sam", primary_org_coda_row_id: "i-elsewhere", org_match: "secondary" },
  { coda_row_id: "i-p6", full_name: "Orphan Olga", primary_org_coda_row_id: "i-orphan" },
];

test("an organisation's people are grouped by sub-organisation, nested by Part of", () => {
  const t = buildOrgTree(ROWS, SUB, "i-ec", "European Commission");
  assert.equal(t.name, "European Commission");
  assert.deepEqual(t.people.map((p) => p.name), ["Secondary Sam", "Zed Root"], "root people + a secondary-org contact");
  assert.deepEqual(t.children.map((c) => c.name), ["DG CNECT", "DG JUST", "Hidden parent's unit"],
    "empty unit dropped; an unknown parent hangs off the root; name order");
  const cnect = t.children[0];
  assert.deepEqual(cnect.people.map((p) => p.name), ["Ana F"]);
  assert.deepEqual(cnect.children.map((c) => c.name), ["AI Office"]);
  assert.deepEqual(cnect.children[0].people, [{ id: "i-p1", name: "Ursula B", position: "Director" }]);
  assert.equal(countPeople(t), 6);
  assert.equal(countPeople(cnect), 2);
  assert.ok(!("_parent" in cnect), "no working fields left behind");
});

test("a Part-of loop never hangs and never loses anyone", () => {
  const loop = [
    { coda_row_id: "i-a", name: "A", part_of_coda_row_id: "i-b" },
    { coda_row_id: "i-b", name: "B", part_of_coda_row_id: "i-a" },
  ];
  const t = buildOrgTree([{ coda_row_id: "i-x", full_name: "X", primary_org_coda_row_id: "i-a" },
    { coda_row_id: "i-y", full_name: "Y", primary_org_coda_row_id: "i-b" }], loop, "i-root", "Root");
  assert.equal(countPeople(t), 2);
});

test("bad input yields an empty tree, not a throw", () => {
  const t = buildOrgTree(null, undefined, "i-r", "R");
  assert.equal(countPeople(t), 0);
  assert.deepEqual(treeGroups(t), []);
});

test("the browse groups in display order, with depth and parent", () => {
  const g = treeGroups(buildOrgTree(ROWS, SUB, "i-ec", "European Commission"));
  assert.deepEqual(g.map((x) => [x.name, x.depth, x.total, x.parent]), [
    ["European Commission", 0, 2, null],
    ["DG CNECT", 0, 2, null],
    ["AI Office", 1, 1, "i-cnect"],
    ["DG JUST", 0, 1, null],
    ["Hidden parent's unit", 0, 1, null],
  ]);
  assert.equal(contactsLabel(1), "1 contact");
  assert.equal(contactsLabel(5), "5 contacts");
});

/* ---------------------------------------------------------------- bulk progress */

test("bulk progress reads 'Adding N… n added', then 'n of N added'", () => {
  assert.equal(bulkProgressText({ total: 4, done: 2, active: true }), "Adding 4… 2 added");
  assert.equal(bulkProgressText({ total: 4, done: 3, active: false }), "3 of 4 added");
  assert.equal(bulkProgressPct({ total: 4, done: 3 }), "75%");
  assert.equal(bulkProgressPct({ total: 0, done: 0 }), "0%");
});

test("a failure names the person, quotes the server and says the others landed", () => {
  const v = bulkFailureView([{ label: "Lukas Brandt", message: "This contact is archived in the CRM and can’t be added to a map." }], 3);
  assert.deepEqual(v.list, [{ title: "Couldn’t add Lukas Brandt.", quote: "This contact is archived in the CRM and can’t be added to a map." }]);
  assert.equal(v.others, "The other 3 were added.");
  assert.equal(bulkFailureView([{ label: "A" }], 1).others, "The other 1 was added.");
  assert.equal(bulkFailureView([{ label: "A" }], 0).others, "Nobody else was added.");
  assert.equal(bulkFailureView([{ label: "A" }], 0).list[0].quote, "Nothing was saved.");
  assert.deepEqual(bulkFailureView([], 4), { list: [], others: "" });
  assert.equal(addedLine(0), "Nothing added yet");
  assert.equal(addedLine(3), "3 added to this map");
});

/* ---------------------------------------------------------------- saves */

test("the node id comes from the member row id '<map>:<node>'", () => {
  assert.equal(nodeIdFromRowId("m-1:n-2", "m-1"), "n-2");
  assert.equal(nodeIdFromRowId("m-1:n-2", null), "n-2");
  assert.equal(nodeIdFromRowId(null, "m-1"), null);
});

test("a judgement is one measure, one number, today, on this map", () => {
  assert.equal(todayIso(new Date(2026, 9, 5)), "2026-10-05");
  assert.deepEqual(judgementFields({ mapId: "m", nodeId: "n", measure: "stance", value: -1, asOf: "2026-10-15" }),
    { map: "m", actor: "node:n", measure: "stance", value_num: -1, as_of: "2026-10-15" });
  assert.deepEqual([-2, -1, 0, 1, 2].map(stanceText), ["−2", "−1", "0", "+1", "+2"]);
});

test("the scores offered follow the map's measures", () => {
  assert.deepEqual(scoresOffered(null), { power: true, stance: true });
  assert.deepEqual(scoresOffered("power,lever"), { power: true, stance: false });
  assert.deepEqual(scoresOffered(["stance"]), { power: false, stance: true });
  assert.deepEqual(scoresOffered([{ key: "power" }]), { power: true, stance: false });
});

test("outcomes: saved, refused (server's words), unknown", () => {
  assert.equal(outcomeOf({ state: "saved_syncing", receipt: { row_id: "x" } }).outcome, "saved");
  assert.deepEqual(outcomeOf({ state: "refused", receipt: { refusals: [{ message: "Already on this map." }] } }).message, "Already on this map.");
  assert.equal(outcomeOf({ state: "refused", receipt: {} }).message, "Nothing was saved.");
  assert.deepEqual(outcomeOf({ state: "outcome_unknown", receipt: {} }).message, UNKNOWN_SAVE);
});

/** A transport double: answers `save_record` from `script(input)`, records every call. */
function fakeTransport(script) {
  const calls = [];
  return { calls, call: async (tool, input, opts) => { calls.push({ tool, input, opts }); return script(tool, input); } };
}

test("removeActor previews then saves status 'removed' on '<map>:<node>' with a fresh key each time", async () => {
  const t = fakeTransport((tool, i) => (i.preview ? { contract: 1, outcome: "previewed", warnings: [] }
    : { contract: 1, outcome: "saved", row_id: i.row_id }));
  const out = await removeActor("m-1", "n-2", { transport: t });
  assert.equal(out.outcome, "saved");
  assert.deepEqual(t.calls.map((c) => [c.tool, c.input.preview, c.input.row_id, c.input.fields.status]),
    [["save_record", true, "m-1:n-2", "removed"], ["save_record", false, "m-1:n-2", "removed"]]);
  assert.equal(t.calls[0].input.table, "power_map_actor");
  assert.equal(t.calls[0].input.idempotency_key, t.calls[1].input.idempotency_key, "one submission, one key");
  const back = await restoreActor("m-1", "n-2", { transport: t });
  assert.equal(back.outcome, "saved");
  assert.equal(t.calls[2].input.fields.status, "active");
  assert.notEqual(t.calls[2].input.idempotency_key, t.calls[0].input.idempotency_key, "a new submission, a new key");
});

test("a refused remove carries the server's message; a dropped save is 'unknown'", async () => {
  const refused = fakeTransport(() => ({ contract: 1, outcome: "refused", refusals: [{ message: "This map is archived." }], warnings: [] }));
  const r = await removeActor("m", "n", { transport: refused });
  assert.deepEqual([r.outcome, r.message], ["refused", "This map is archived."]);
  assert.equal(refused.calls.length, 1, "a refused preview writes nothing more");
  const dropped = fakeTransport((tool, i) => { if (i.preview) return { contract: 1, outcome: "previewed", warnings: [] };
    throw { code: "upstream_error", ambiguous: true, message: "dropped" }; });
  const u = await saveOnce(dropped, "power_map_actor", { map: "m", actor: "contact:i-1" });
  assert.deepEqual([u.outcome, u.message], ["unknown", UNKNOWN_SAVE]);
});

/* ---------------------------------------------------------------- K3: either/or + duplicates */

test("where they work: an organisation, or Independent / self-employed / Retired", () => {
  assert.equal(EITHER_OR_RULE, "Primary organisation, or Independent / self-employed / Retired");
  assert.equal(workplaceAnswered({ primary_org: "i-org" }), true);
  assert.equal(workplaceAnswered({ primary_org: { row_id: "i-org", label: "OECD" } }), true);
  assert.equal(workplaceAnswered({ primary_org: ["i-org"] }), true);
  assert.equal(workplaceAnswered({ employment_status: "Retired" }), true);
  assert.equal(workplaceAnswered({ employment_status: "independent / self-employed" }), true);
  assert.equal(workplaceAnswered({ employment_status: "Employed" }), false);
  assert.equal(workplaceAnswered({ primary_org: "", employment_status: "" }), false);
  assert.equal(workplaceAnswered({ primary_org: [] }), false);
  assert.equal(workplaceAnswered(null), false);
});

test("an exact-name refusal yields the existing record's id and the server's words", () => {
  const receipt = { outcome: "refused", refusals: [{ field: null, code: "pipeline",
    message: "A contact called Mariana Costa already exists in Coda. If it's the same one, don't save it.",
    technical: "duplicate_refused: contacts 'Mariana Costa' already exists — i-AbC123xyz — existing row (identical name) (Senior policy analyst; OECD). NOTHING WAS WRITTEN for this record. … distinct_from=['i-AbC123xyz'] …" }] };
  assert.deepEqual(duplicateFrom(receipt), { ids: ["i-AbC123xyz"],
    message: "A contact called Mariana Costa already exists in Coda. If it's the same one, don't save it." });
});

test("a namesake refusal naming two rows offers both; native-style ids are read directly", () => {
  const two = duplicateFrom({ refusals: [{ code: "pipeline", message: "m",
    technical: "duplicate_refused (known_namesake): 'Jo Lee' is an established namesake — i-aaaa111 [marked 'Not a duplicate'] — x, i-bbbb222 — y." }] });
  assert.deepEqual(two.ids, ["i-aaaa111", "i-bbbb222"]);
  assert.deepEqual(duplicateFrom({ refusals: [{ code: "duplicate", message: "m", existing_row_id: "i-zzzz999" }] }).ids, ["i-zzzz999"]);
});

test("any other refusal is not a duplicate", () => {
  assert.equal(duplicateFrom({ refusals: [{ code: "missing_required", message: "Add a primary organisation." }] }), null);
  assert.equal(duplicateFrom({ refusals: [{ code: "pipeline", technical: "duplicate_refused: no id here" }] }), null);
  assert.equal(duplicateFrom(null), null);
});

test("the existing contact's hint is position · organisation", () => {
  assert.equal(contactHint({ values: { position: "Senior policy analyst", primary_org: { row_id: "i-o", label: "OECD" } } }),
    "Senior policy analyst · OECD");
  assert.equal(contactHint({ values: { primary_org: [{ row_id: "i-o", label: "OECD" }] } }), "OECD");
  assert.equal(contactHint({}), "");
});

test("the new-organisation fields come from the server's form", () => {
  const form = { fields: [
    { name: "website", kind: "url" },
    { name: "name", label: "Name", kind: "text", required: true },
    { name: "sector", label: "Sector", kind: "dropdown", required: true,
      options: [{ value: "Civil society / NGO", label: "Civil society / NGO" }, "Government"] },
  ] };
  const f = orgFormFields(form);
  assert.equal(f.name.name, "name");
  assert.equal(f.sector.name, "sector");
  assert.deepEqual(choicesOf(f.sector), [{ value: "Civil society / NGO", label: "Civil society / NGO" },
    { value: "Government", label: "Government" }]);
  const alt = orgFormFields({ fields: [{ name: "org_name", kind: "text", required: true }, { name: "sectors", label: "Sector(s)", kind: "linked" }] });
  assert.equal(alt.name.name, "org_name");
  assert.equal(alt.sector.name, "sectors");
  assert.deepEqual(orgFormFields(null), { name: null, sector: null });
});

test("a new organisation becomes the contact's pick only when the save named its row", () => {
  assert.deepEqual(orgPick({ row_id: "i-new" }, " Maris Institute "), { row_id: "i-new", label: "Maris Institute" });
  assert.equal(orgPick({ outcome: "saved" }, "X"), null);
});
