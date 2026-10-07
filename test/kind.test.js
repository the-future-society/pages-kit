// <tfs-kind>'s labels: every record kind a page shows reads in plain words, never a table name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { kindOf, KINDS } from "../kind.js";

test("each known table has a plain label and a tone", () => {
  assert.deepEqual(kindOf("tasks"), { label: "Task", tone: "task" });
  assert.deepEqual(kindOf("projects"), { label: "Project", tone: "project" });
  assert.deepEqual(kindOf("kms_entries"), { label: "KMS entry", tone: "kms" });
  assert.deepEqual(kindOf("impact"), { label: "Impact", tone: "impact" });
  for (const [t, [label]] of Object.entries(KINDS)) assert.doesNotMatch(label, /_/, t);
});

test("a page's own label keeps the kind's colour", () => {
  assert.deepEqual(kindOf("tasks", "Sub-task"), { label: "Sub-task", tone: "task" });
});

test("an unknown table is shown in human form with the neutral tone, never raw", () => {
  assert.deepEqual(kindOf("power_maps"), { label: "Power map", tone: "neutral" });
  assert.deepEqual(kindOf(null), { label: "Record", tone: "neutral" });
});
