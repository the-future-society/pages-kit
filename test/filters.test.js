// <tfs-task-filters>' state model: the builder's bar, a viewer's additions, what is in force,
// what is remembered. The DOM half is checked in a real browser (kit/test/gallery.html?show=filters).
// Fixtures are invented; no real TFS record text appears here (public code).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FilterState, safeStorage, loadUrgencyOptions, TOGGLES, CHOOSERS } from "../filters.js";

const mem = () => { const m = new Map(); return { m, get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v) }; };

test("defaults: My tasks, Show closed, Show snoozed on the bar; every chooser offered in the menu", () => {
  const s = new FilterState({ storage: mem() });
  assert.deepEqual(s.toggles(), ["mine", "closed", "snoozed"]);
  assert.deepEqual(s.more, Object.keys(CHOOSERS));
  assert.deepEqual(s.shown(), []);
  assert.deepEqual(s.values(), {}, "snoozed starts OFF: snoozed tasks hidden, as in Coda");
  assert.deepEqual(Object.keys(TOGGLES), ["mine", "closed", "snoozed"]);
});

test("a chooser the builder put on the bar is not also in the menu, and the viewer can't remove it", () => {
  const s = new FilterState({ bar: ["snoozed", "owner"], more: ["owner", "due"], storage: mem() });
  assert.deepEqual(s.more, ["due"]);
  assert.deepEqual(s.shown(), ["owner"]);
  s.remove("owner");
  assert.deepEqual(s.shown(), ["owner"]);
});

test("unknown filter names are ignored, never rendered", () => {
  const s = new FilterState({ bar: ["mine", "bogus"], more: ["due", "nope"], storage: mem() });
  assert.deepEqual(s.toggles(), ["mine"]);
  assert.deepEqual(s.more, ["due"]);
});

test("a value counts only while its filter is on the bar; removing a filter drops its value", () => {
  const s = new FilterState({ storage: mem() });
  s.set("due", "overdue");
  assert.deepEqual(s.values(), {}, "not on the bar yet: setting it does nothing");
  s.add("due"); s.set("due", "overdue");
  assert.deepEqual(s.values(), { due: "overdue" });
  s.remove("due");
  assert.deepEqual(s.values(), {});
  s.add("due");
  assert.deepEqual(s.values(), {}, "re-adding starts empty");
});

test("empty values are unset: '', [], null, false", () => {
  const s = new FilterState({ storage: mem() });
  s.add("urgency"); s.set("urgency", ["1 Critical"]); s.set("urgency", []);
  s.set("mine", true); s.set("mine", false);
  assert.deepEqual(s.values(), {});
});

test("remembered per viewer: additions and values survive a reload under the same key, not another", () => {
  const st = mem();
  const a = new FilterState({ storage: st, key: "k1" });
  a.add("owner"); a.set("owner", { row_id: "p1", label: "Person One" }); a.set("snoozed", true);
  const b = new FilterState({ storage: st, key: "k1" });
  assert.deepEqual(b.shown(), ["owner"]);
  assert.deepEqual(b.values(), { owner: { row_id: "p1", label: "Person One" }, snoozed: true });
  assert.deepEqual(new FilterState({ storage: st, key: "k2" }).values(), {});
});

test("a saved filter the builder no longer offers is dropped on load", () => {
  const st = mem();
  const a = new FilterState({ storage: st }); a.add("due"); a.set("due", "7");
  const b = new FilterState({ storage: st, more: ["owner"] });
  assert.deepEqual(b.shown(), []);
  assert.deepEqual(b.values(), {});
});

test("clear() empties the narrowing filters but keeps the view toggles and the bar's layout", () => {
  const s = new FilterState({ storage: mem() });
  s.add("due"); s.set("due", "7"); s.set("mine", true); s.set("snoozed", true); s.set("closed", true);
  assert.equal(s.narrowing(), true);
  s.clear();
  assert.deepEqual(s.values(), { snoozed: true, closed: true });
  assert.deepEqual(s.shown(), ["due"]);
  assert.equal(s.narrowing(), false);
});

test("corrupt or blocked storage never breaks the bar", () => {
  const bad = { get: () => "{not json", set: () => {} };
  assert.deepEqual(new FilterState({ storage: bad }).values(), {});
  const throwing = safeStorage({ getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } });
  assert.equal(throwing.get("x"), null);
  throwing.set("x", "y");
});

test("urgency options come from describe_record_form, in the server's order, once per transport", async () => {
  let calls = 0;
  const tr = { call: async (tool, input) => { calls++; assert.equal(tool, "describe_record_form"); assert.deepEqual(input, { table: "tasks", mode: "edit" });
    return { fields: [{ name: "status", options: [] }, { name: "urgency", options: [{ value: "1 Critical" }, { value: "2 High" }, "3 Medium"] }] }; } };
  assert.deepEqual(await loadUrgencyOptions(tr), ["1 Critical", "2 High", "3 Medium"]);
  await loadUrgencyOptions(tr);
  assert.equal(calls, 1);
});

test("a failed urgency load is forgotten, so the next asks again", async () => {
  let n = 0;
  const tr = { call: async () => { n++; if (n === 1) throw { code: "server_unavailable" }; return { fields: [] }; } };
  await assert.rejects(loadUrgencyOptions(tr));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(await loadUrgencyOptions(tr), []);
});
