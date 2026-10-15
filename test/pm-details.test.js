// K7–K9: the one details panel, map setup and Find on this map — their pure rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ownRecord, onMapFields, ownRows, onMapRows, setupRows, findMatches, ratedBy, earlierFor,
  judgementPresets, TfsActorDetails, TfsMapSetup, TfsMapFind,
} from "../pm-details.js";

test("an actor's own record: a CRM contact or organisation is edited in the CRM, anything else as a map node", () => {
  assert.deepEqual(ownRecord({ kind: "person", node_id: "n1", contact_coda_row_id: "i-c1" }).table, "contacts");
  assert.match(ownRecord({ kind: "person", node_id: "n1", contact_coda_row_id: "i-c1" }).fields, /full_name,position,primary_org/);
  assert.equal(ownRecord({ kind: "organization", node_id: "n2", organization_coda_row_id: "i-o1" }).table, "organizations");
  assert.deepEqual(ownRecord({ kind: "seat", node_id: "n3" }), { table: "power_map_node", row: "node:n3", label: "Seat", fields: null });
  assert.equal(ownRecord({ kind: "person", node_id: "n4", in_crm: false }).table, "power_map_node", "a person not in the CRM edits as a node");
  assert.equal(ownRecord({ kind: "person", node_id: "n5", in_crm: true }), null, "a CRM person without a row id is read-only, never an empty node form");
  assert.equal(ownRecord(null), null);
});

test("on a country map a person's countries are edited (their shared works-on links); elsewhere their group", () => {
  assert.equal(onMapFields({ kind: "person" }, "country"), "role,countries,owner,messenger");
  assert.equal(onMapFields({ kind: "organization" }, "country"), "role,countries,owner,messenger");
  assert.equal(onMapFields({ kind: "forum" }, "country"), "role,grouping,owner,messenger", "a forum has no countries of its own");
  assert.equal(onMapFields({ kind: "person" }, "role"), "role,grouping,owner,messenger");
  const rows = onMapRows({ kind: "person", role: "ally", countries: ["Kenya", "Brazil"] }, { groupBy: "country", roles: { ally: "Ally" } });
  assert.deepEqual(rows, [["Role", "Ally"], ["Countries", "Kenya, Brazil"], ["Owner", "—"], ["Messenger", "—"]]);
});

test("the read view leaves blanks out and says when a person is not in the CRM", () => {
  assert.deepEqual(ownRows({ kind: "person", position: "Director", primary_org_name: "", pronouns: "she / her" }),
    [["Position", "Director"], ["Pronouns", "she / her"]]);
  assert.deepEqual(ownRows({ kind: "person", in_crm: false }), [["In the CRM", "Not linked to a CRM contact"]]);
});

test("map setup in words: scores with their scale, what sets size and colour, what is on it", () => {
  const r = setupRows({ kind: "jurisdiction", objective: "Red lines", team_label: "International AI Governance", measures: ["red_lines_support", "note"],
    colour_measure: "red_lines_support", size_measure: "none", group_by: "country", parent_name: "All maps" },
  { measures: [{ value: "red_lines_support", label: "Support for AI red lines", numeric: true }, { value: "note", label: "Note" }],
    kinds: { jurisdiction: { label: "Jurisdiction" } },
    actors: [{ kind: "country" }, { kind: "country" }, { kind: "forum" }, { kind: "person", status: "removed" }],
    links: [{ kind: "member_of" }, { kind: "member_of" }, { kind: "nonsense" }] });
  assert.deepEqual(r.about.slice(0, 3), [["Kind", "Jurisdiction"], ["Objective", "Red lines"], ["Team", "International AI Governance"]]);
  assert.ok(r.about.some(([k, v]) => k === "Part of" && v === "All maps"));
  assert.deepEqual(r.scores, [["Support for AI red lines", "1 to 5"], ["Note", "words"]]);
  assert.deepEqual(r.drawing.slice(0, 3), [["Size of each shape", "Same for everyone"], ["Colour of each shape", "Support for AI red lines"], ["Group people by", "Country"]]);
  assert.deepEqual(r.shapes, [["Forum", "1"], ["Country", "2"]], "a removed actor is not counted");
  assert.deepEqual(r.lines, [["Member of", "2"]]);
});

test("Find on this map: start-of-word matches first, then anywhere; removed people never", () => {
  const actors = [{ node_id: "1", name: "Marta Bienkiewicz" }, { node_id: "2", name: "Mira Abbot" }, { node_id: "3", name: "Ana Martins" },
    { node_id: "4", name: "Marco Gone", status: "removed" }, { node_id: "5", name: "Tamar Lee" }];
  assert.deepEqual(findMatches(actors, "mar").map((a) => a.node_id), ["3", "1", "5"]);
  assert.deepEqual(findMatches(actors, "  "), []);
  assert.equal(findMatches(actors, "a", 2).length, 2);
});

test("who judged a score, and the value before it on this map", () => {
  assert.equal(ratedBy({ judged_by: "Tara K.", as_of: "2026-10-01" }).startsWith("rated by Tara K."), true);
  assert.match(ratedBy({ aggregate: "mean", judge_count: 4, judges: [{ value: 2 }, { value: 5 }], as_of: "2026-03-24" }), /average of 4 staff ratings.*range 2–5/);
  const hist = [{ measure: "power", map: "M", value: 3, as_of: "2026-09-01", judged_by: "Lea R." }, { measure: "power", map: "M", value: 4, as_of: "2026-10-01" }];
  assert.match(earlierFor(hist, "power", { value: 4, as_of: "2026-10-01" }, "M"), /^Earlier: 3, rated by Lea R\./);
  assert.equal(earlierFor(hist, "power", { value: 4, as_of: "2026-10-01" }, "Other map"), null);
});

test("a new judgement is preset to this map, this actor, today and the score clicked", () => {
  assert.deepEqual(judgementPresets({ id: "m1", name: "Map" }, { node_id: "n1", name: "Ana" }, "stance", "2026-10-15"),
    { map: { row_id: "m1", label: "Map" }, actor: { row_id: "node:n1", label: "Ana" }, as_of: "2026-10-15", measure: "stance" });
});

test("the elements load without a DOM", () => {
  for (const c of [TfsActorDetails, TfsMapSetup, TfsMapFind]) assert.equal(typeof c, "function");
});

test("record text never goes through innerHTML", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../pm-details.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML/);
});

test("options that depend on the record come with it (a map's own groups), in any of the three shapes", async () => {
  const { recordOptions, NEW_VALUE } = await import("../form.js");
  const o = [{ value: "EU", label: "EU" }];
  assert.deepEqual(recordOptions({ options: { grouping: o } }, "grouping"), o);
  assert.deepEqual(recordOptions({ field_options: { grouping: o } }, "grouping"), o);
  assert.deepEqual(recordOptions({ fields: [{ name: "grouping", options: o }] }, "grouping"), o);
  assert.equal(recordOptions({ options: {} }, "grouping"), null);
  assert.equal(recordOptions(null, "grouping"), null);
  assert.ok(NEW_VALUE.length > 1 && NEW_VALUE.charCodeAt(0) === 0, "the New… value can never collide with a real group name");
});
