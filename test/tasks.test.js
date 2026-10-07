// Task helpers: the snooze rule, filtering, exact counts. Fixtures are invented; no real TFS
// record text appears here (public code).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  todayISO, addDays, normaliseTree, markSnoozed, hideSnoozed, taskMatcher, filterTree, treeCounts,
  countTasks, formatCount, hoursOf, dueMatches, DUE_OPTIONS, isHeadingRow,
} from "../tasks.js";

const T = "2026-03-10";
const n = (id, o = {}) => ({ coda_row_id: id, title: "Task " + id, status_name: "Not Started", owner_coda_row_id: "a",
  created_by_coda_row_id: "b", urgency_name: "2 High", due_date: null, snooze_until: null, children: [], ...o });

test("addDays and todayISO are calendar dates", () => {
  assert.equal(addDays("2026-02-27", 2), "2026-03-01");
  assert.equal(addDays("2026-03-10", -10), "2026-02-28");
  assert.equal(todayISO(new Date(2026, 0, 5)), "2026-01-05");
});

test("normaliseTree folds a shadow parent's children to the top and sorts by due date", () => {
  const r = { roots: [{ coda_row_id: "s", is_shadow_parent: true }, { coda_row_id: "r", due_date: "2026-01-01" }],
    tree_by_root: { s: [{ coda_row_id: "k2", due_date: "2026-05-01" }, { coda_row_id: "k1", due_date: "2026-02-01", children: [{ coda_row_id: "g" }] }], r: [] } };
  const t = normaliseTree(r);
  assert.deepEqual(t.map((x) => x.coda_row_id), ["r", "k1", "k2"]);
  assert.equal(t[1].children[0].coda_row_id, "g");
  assert.deepEqual(normaliseTree(null), []);
});

test("snooze: own date after today; snoozed until TODAY is awake", () => {
  const t = markSnoozed([n("x", { snooze_until: "2026-03-11" }), n("y", { snooze_until: T }), n("z")], T);
  assert.deepEqual(t.map((x) => x._snoozed), [true, false, false]);
  assert.equal(t[0]._snoozedUntil, "2026-03-11");
});

test("snooze: a same-owner sub-task inherits; another owner's sub-task is awake; inheritance stops at an owner change", () => {
  const t = markSnoozed([n("p", { snooze_until: "2026-04-01", children: [
    n("same", { children: [n("grand-same"), n("grand-other", { owner_coda_row_id: "c" })] }),
    n("other", { owner_coda_row_id: "c", children: [n("back-to-a")] }),
  ] })], T);
  const [p] = t; const [same, other] = p.children;
  assert.equal(same._snoozed, true); assert.equal(same._snoozedUntil, "2026-04-01");
  assert.equal(same.children[0]._snoozed, true);
  assert.equal(same.children[1]._snoozed, false);
  assert.equal(other._snoozed, false);
  assert.equal(other.children[0]._snoozed, false, "an owner change breaks the chain, even if the owner matches further up");
});

test("hideSnoozed keeps a snoozed parent of awake sub-tasks as context, drops the rest, never mutates", () => {
  const src = markSnoozed([n("p", { snooze_until: "2026-04-01", children: [n("same"), n("other", { owner_coda_row_id: "c" })] }), n("q", { snooze_until: "2026-04-01" }), n("r")], T);
  const out = hideSnoozed(src);
  assert.deepEqual(out.map((x) => x.coda_row_id), ["p", "r"]);
  assert.equal(out[0]._snoozedContext, true);
  assert.deepEqual(out[0].children.map((x) => x.coda_row_id), ["other"]);
  assert.equal(src[0].children.length, 2, "input untouched");
});

test("taskMatcher: null when nothing filters; each filter ANDs", () => {
  assert.equal(taskMatcher({}), null);
  assert.equal(taskMatcher({ urgency: [], owner: null, due: "" }), null);
  const m = taskMatcher({ owner: { row_id: "a", label: "A" }, urgency: ["1 Critical"] }, { today: T });
  assert.equal(m(n("1", { urgency_name: "1 Critical" })), true);
  assert.equal(m(n("2")), false, "urgency differs");
  assert.equal(m(n("3", { urgency_name: "1 Critical", owner_coda_row_id: "z" })), false, "owner differs");
  assert.equal(taskMatcher({ created: "b" })(n("4")), true);
  assert.equal(taskMatcher({ query: "task 5" })(n("5")), true);
});

test("taskMatcher: 'mine' with no known viewer matches nothing (never everything)", () => {
  assert.equal(taskMatcher({ mine: true }, { me: null })(n("1")), false);
  assert.equal(taskMatcher({ mine: true }, { me: "a" })(n("1")), true);
});

test("due filters: overdue, windows inclusive of today and the last day, none; closed tasks never match", () => {
  assert.deepEqual(DUE_OPTIONS.map((d) => d[0]), ["overdue", "7", "30", "none"]);
  assert.equal(dueMatches(n("1", { due_date: "2026-03-09" }), "overdue", T), true);
  assert.equal(dueMatches(n("1", { due_date: T }), "overdue", T), false);
  assert.equal(dueMatches(n("1", { due_date: T }), "7", T), true);
  assert.equal(dueMatches(n("1", { due_date: "2026-03-17" }), "7", T), true);
  assert.equal(dueMatches(n("1", { due_date: "2026-03-18" }), "7", T), false);
  assert.equal(dueMatches(n("1"), "none", T), true);
  assert.equal(dueMatches(n("1", { status_name: "Complete" }), "none", T), false);
  assert.equal(dueMatches(n("1", { context_only: true }), "none", T), false);
});

test("filterTree keeps ancestors of a match, marking them as not a hit", () => {
  const t = [n("p", { children: [n("hit", { urgency_name: "1 Critical" }), n("miss")] }), n("alone")];
  const out = filterTree(t, taskMatcher({ urgency: ["1 Critical"] }));
  assert.deepEqual(out.map((x) => [x.coda_row_id, x._hit]), [["p", false]]);
  assert.deepEqual(out[0].children.map((x) => [x.coda_row_id, x._hit]), [["hit", true]]);
  assert.equal(filterTree(t, null), t);
});

test("treeCounts: open, overdue, snoozed apart; closed and context rows never count", () => {
  const t = markSnoozed([n("a", { due_date: "2026-03-01" }), n("b", { snooze_until: "2026-04-01", due_date: "2026-03-01" }),
    n("c", { status_name: "Complete" }), n("d", { context_only: true, children: [n("e")] })], T);
  assert.deepEqual(treeCounts(t, { today: T }), { open: 2, overdue: 1, snoozed: 1 });
  assert.deepEqual(treeCounts(t, { today: T, showSnoozed: true }), { open: 3, overdue: 2, snoozed: 0 });
});

const tr = (answer) => { const calls = []; return { calls, call: async (tool, input) => { calls.push({ tool, input }); return answer; } }; };

test("countTasks asks for ONE lean row and reads the server's total when the list was cut short", async () => {
  const t = tr({ rows: [{}], truncated: true, total_matched: 38 });
  assert.deepEqual(await countTasks(t, { project: "p1", overdue_only: true }), { n: 38, exact: true });
  assert.deepEqual(t.calls[0], { tool: "search_tasks", input: { project: "p1", overdue_only: true, limit: 1, fields: "dedup" } });
});

test("countTasks: a short list is counted directly; a cut list with no total is a floor, never exact", async () => {
  assert.deepEqual(await countTasks(tr({ rows: [], truncated: false })), { n: 0, exact: true });
  assert.deepEqual(await countTasks(tr({ rows: [{}], truncated: false })), { n: 1, exact: true });
  assert.deepEqual(await countTasks(tr({ rows: [{}], truncated: true })), { n: 1, exact: false });
  assert.equal(formatCount({ n: 1, exact: false }), "1+");
  assert.equal(formatCount({ n: 7, exact: true }), "7");
  assert.equal(formatCount(null), "…");
});

test("hoursOf reads Coda's time-required labels", () => {
  assert.equal(hoursOf("15 mins"), 0.25);
  assert.equal(hoursOf("2 hrs"), 2);
  assert.equal(hoursOf("1 hr"), 1);
  assert.equal(hoursOf("1 day"), 8);
  assert.equal(hoursOf(null), 0);
  assert.equal(hoursOf("Half a day"), 0, "an unknown label adds nothing rather than a guess");
});

// Regression, 2026-10-07: a heading row (a finished parent kept for its open sub-tasks, or a
// snoozed parent kept for ANOTHER owner's awake sub-task) was tested against the filters as if it
// were work. With "My tasks" on, the other owner's sub-task dropped out and the heading stayed,
// shown as a match: finished and snoozed tasks appeared under filters that should hide them.
test("filterTree: a heading row never counts as a match; it stays only above a real match", () => {
  const tree = markSnoozed([
    n("snoozed-parent", { snooze_until: "2026-04-01", urgency_name: "3 Medium", children: [
      n("mine-snoozed", { urgency_name: "2 High", children: [
        n("done-parent", { status_name: "Complete", context_only: true, children: [n("theirs", { owner_coda_row_id: "c" })] }),
      ] }),
      n("mine-snoozed-leaf", { urgency_name: "3 Medium" }),
    ] }),
    n("done-heading", { status_name: "Complete", context_only: true, urgency_name: "2 High", children: [n("their-open", { owner_coda_row_id: "c" })] }),
    n("real", { urgency_name: "2 High" }),
  ], T);
  const visible = hideSnoozed(tree);
  const ids = (list) => list.flatMap((x) => [x.coda_row_id, ...ids(x.children)]);
  // Unfiltered, the headings stay: another owner's awake work sits under them.
  assert.ok(ids(visible).includes("snoozed-parent") && ids(visible).includes("done-heading"));
  // Filtered to MY tasks, nothing of mine is awake under them, so they go.
  const out = filterTree(visible, taskMatcher({ mine: true, urgency: ["2 High", "3 Medium"] }, { me: "a", today: T }));
  assert.deepEqual(ids(out), ["real"]);
  // A heading above a real match stays, but as an ancestor, never a hit.
  const theirs = filterTree(visible, taskMatcher({ owner: "c" }, { today: T }));
  const heads = []; const walk = (l) => l.forEach((x) => { if (x.coda_row_id !== "theirs" && x.coda_row_id !== "their-open") heads.push([x.coda_row_id, x._hit]); walk(x.children); });
  walk(theirs);
  assert.ok(heads.length && heads.every(([, hit]) => hit === false), JSON.stringify(heads));
});

test("isHeadingRow: context-only and snoozed-context rows are headings; ordinary rows are not", () => {
  assert.equal(isHeadingRow(n("a", { context_only: true })), true);
  assert.equal(isHeadingRow({ ...n("b"), _snoozedContext: true }), true);
  assert.equal(isHeadingRow(n("c")), false);
});
