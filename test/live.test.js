// autoRefresh (live.js): a page re-reads itself on a timer and on return to the tab, never under
// an edit. Fake timers, a fake document; no real TFS anything (public code).
import { test } from "node:test";
import assert from "node:assert/strict";
import { autoRefresh, isEditing, focusIsEditable, stampText, REFRESH_EVERY_MS } from "../live.js";

function world() {
  let t = Date.UTC(2026, 2, 10, 9, 0, 0);
  const timers = new Map(); let seq = 0;
  const win = {
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const listeners = {};
  const doc = {
    visibilityState: "visible", activeElement: null, elements: [],
    addEventListener(n, f) { (listeners[n] ||= []).push(f); },
    removeEventListener(n, f) { listeners[n] = (listeners[n] || []).filter((x) => x !== f); },
    querySelectorAll() { return this.elements; },
  };
  const flush = () => new Promise((r) => setImmediate(r));
  async function advance(ms) {
    const end = t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); t = due[1].at; due[1].fn(); await flush(); await flush();
    }
    t = end;
  }
  async function setVisible(v) {
    doc.visibilityState = v ? "visible" : "hidden";
    for (const f of listeners.visibilitychange || []) f();
    await flush(); await flush();
  }
  return { win, doc, advance, setVisible, now: () => new Date(t), pending: () => timers.size };
}

function counter(fail = false) {
  const calls = [];
  const load = async (fresh) => { calls.push(fresh); if (fail) throw new Error("down"); };
  return { calls, load };
}

test("re-reads FRESH every 5 minutes while visible", async () => {
  const w = world(); const c = counter();
  const live = autoRefresh({ load: c.load, doc: w.doc, win: w.win, now: w.now });
  await live.refresh(false);
  assert.deepEqual(c.calls, [false]);
  await w.advance(REFRESH_EVERY_MS - 1);
  assert.equal(c.calls.length, 1);
  await w.advance(1);
  assert.deepEqual(c.calls, [false, true]);
  await w.advance(REFRESH_EVERY_MS * 2);
  assert.equal(c.calls.length, 4);
  live.stop();
});

test("a hidden tab never polls; coming back after 30 s re-reads at once", async () => {
  const w = world(); const c = counter();
  const live = autoRefresh({ load: c.load, doc: w.doc, win: w.win, now: w.now });
  await live.refresh(false);
  await w.setVisible(false);
  await w.advance(REFRESH_EVERY_MS * 6);
  assert.equal(c.calls.length, 1, "nothing while hidden");
  await w.setVisible(true);
  assert.deepEqual(c.calls, [false, true]);
  live.stop();
});

test("coming back within 30 s does not re-read, and keeps the 5-minute rhythm", async () => {
  const w = world(); const c = counter();
  const live = autoRefresh({ load: c.load, doc: w.doc, win: w.win, now: w.now });
  await live.refresh(false);
  await w.setVisible(false);
  await w.advance(10_000);
  await w.setVisible(true);
  assert.equal(c.calls.length, 1);
  await w.advance(REFRESH_EVERY_MS - 10_000);
  assert.equal(c.calls.length, 2);
  live.stop();
});

test("never redraws under an edit: held while a form says editing, then made", async () => {
  const w = world(); const c = counter();
  const form = { editing: true };
  w.doc.elements = [form];
  const live = autoRefresh({ load: c.load, doc: w.doc, win: w.win, now: w.now });
  await live.refresh(false);
  await w.advance(REFRESH_EVERY_MS + 60_000);
  assert.equal(c.calls.length, 1, "held for the whole edit");
  form.editing = false;
  await w.advance(15_000);
  assert.deepEqual(c.calls, [false, true]);
  live.stop();
});

test("the page's own isBusy holds it too; a page-asked refresh is never held", async () => {
  const w = world(); const c = counter();
  const live = autoRefresh({ load: c.load, isBusy: () => true, doc: w.doc, win: w.win, now: w.now });
  await live.refresh(false);
  await w.advance(REFRESH_EVERY_MS * 2);
  assert.equal(c.calls.length, 1);
  await live.refresh();
  assert.deepEqual(c.calls, [false, true]);
  live.stop();
});

test("a failed background read keeps the old time and says so; never claims to be current", async () => {
  const w = world(); let fail = false; const calls = [];
  const stamp = { textContent: "" };
  const live = autoRefresh({ load: async (f) => { calls.push(f); if (fail) throw new Error("x"); }, stamp, doc: w.doc, win: w.win, now: w.now });
  await live.refresh(false);
  const first = live.loadedAt;
  assert.match(stamp.textContent, /^Updated \d/);
  fail = true;
  await w.advance(REFRESH_EVERY_MS);
  assert.equal(live.loadedAt, first);
  assert.match(stamp.textContent, /couldn't refresh, will retry$/);
  fail = false;
  await w.advance(REFRESH_EVERY_MS);
  assert.doesNotMatch(stamp.textContent, /couldn't/);
  live.stop();
});

test("one read at a time: a call during a read is queued once behind it, not dropped", async () => {
  const w = world(); const calls = []; let release;
  const load = (f) => { calls.push(f); return calls.length === 1 ? new Promise((r) => { release = r; }) : Promise.resolve(); };
  const live = autoRefresh({ load, doc: w.doc, win: w.win, now: w.now });
  const a = live.refresh(false);
  const b = live.refresh(); const c2 = live.refresh();
  assert.equal(b, c2, "joined into one queued read");
  release(); await a; await b;
  assert.deepEqual(calls, [false, true]);
  live.stop();
});

test("stop() ends the timers and the tab listener", async () => {
  const w = world(); const c = counter();
  const live = autoRefresh({ load: c.load, doc: w.doc, win: w.win, now: w.now });
  await live.refresh(false);
  live.stop();
  assert.equal(w.pending(), 0);
  await w.setVisible(false); await w.setVisible(true);
  await w.advance(REFRESH_EVERY_MS * 3);
  assert.equal(c.calls.length, 1);
});

test("focus in a text field counts as editing; a button or checkbox does not", () => {
  assert.equal(focusIsEditable({ tagName: "TEXTAREA" }), true);
  assert.equal(focusIsEditable({ tagName: "INPUT", type: "text" }), true);
  assert.equal(focusIsEditable({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(focusIsEditable({ tagName: "BUTTON" }), false);
  assert.equal(focusIsEditable({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(focusIsEditable({ tagName: "DIV", shadowRoot: { activeElement: { tagName: "SELECT" } } }), true);
  assert.equal(isEditing({ querySelectorAll: () => [], activeElement: { tagName: "INPUT" } }), true);
  assert.equal(isEditing({ querySelectorAll: () => [{ editing: false }], activeElement: null }), false);
});

test("stamp words", () => {
  assert.equal(stampText(null), "");
  assert.match(stampText(new Date(2026, 2, 10, 14, 32)), /^Updated \S*:32\b/);   // the viewer's own clock format
  assert.equal(stampText(null, true), "Couldn't load — will retry");
});

test("load is required", () => {
  assert.throws(() => autoRefresh({}), TypeError);
});

test("kit elements answer `editing`: a form with a change or a save in flight; an open menu", async () => {
  const { TfsRecordForm } = await import("../form.js");
  const { TfsStatusMenu } = await import("../actions.js");
  const f = new TfsRecordForm();
  assert.equal(f.editing, false, "no form loaded yet");
  f.machine = { busy: () => false, state: "idle" }; f._ready = true;
  f.changes = () => ({}); f._startChanges = JSON.stringify({});
  assert.equal(f.editing, false, "loaded, nothing changed");
  f.changes = () => ({ status: "Complete" });
  assert.equal(f.editing, true, "a change not saved");
  // A create form's preset owner is a "change" from the start — not the person's edit.
  f._startChanges = JSON.stringify({ owner: "a" }); f.changes = () => ({ owner: "a" });
  assert.equal(f.editing, false, "presets only");
  f.changes = () => ({ owner: "a", title: "Draft" });
  assert.equal(f.editing, true, "the person typed a title");
  f.getClientRects = () => [];
  assert.equal(f.editing, false, "a form in a closed drawer is not being edited");
  f.machine = { busy: () => true, state: "saving" };
  assert.equal(f.editing, true, "a save in flight counts even out of sight");
  f.getClientRects = () => [{}];
  f.changes = () => ({}); f._startChanges = JSON.stringify({});
  f.machine = { busy: () => false, state: "outcome_unknown" };
  assert.equal(f.editing, true, "an outcome not yet known");
  const m = new TfsStatusMenu();
  assert.equal(m.editing, false);
  m._menu = { isOpen: true, busy: false };
  assert.equal(m.editing, true);
  m._menu = { isOpen: false, busy: true };
  assert.equal(m.editing, true);
});
