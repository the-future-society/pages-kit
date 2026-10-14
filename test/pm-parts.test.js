import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  pmStorage, formatDay, stanceLabel, stanceWithValue, relLabel, measureLabel, STANCE_BAND_ZERO,
  withPrevious, historyParts, historySentence, historyGroups,
  undoToast, sectionOpen, rememberSection, infoLines, SECTION_KEY_PREFIX,
  parseViews, viewLabel, resolveView, VIEW_KEY_PREFIX,
  displayText, peekView, peekMeta,
} from "../pm-parts.js";

const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };

test("pmStorage never throws: a missing, throwing or blocked localStorage is just 'not kept'", () => {
  const boom = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceeded"); } };
  assert.equal(pmStorage(() => boom).get("k"), null);
  assert.doesNotThrow(() => pmStorage(() => boom).set("k", "v"));
  assert.equal(pmStorage(() => { throw new Error("denied"); }).get("k"), null);
  assert.equal(pmStorage(() => null).get("k"), null);
  const s = pmStorage(() => memStore());
  assert.equal(s.get("x"), null);
  const st = memStore(); const ok = pmStorage(() => st);
  ok.set("a", "1"); assert.equal(ok.get("a"), "1");
});

test("formatDay: '2026-10-01' → '1 Oct 2026'; timestamps work; junk is '' never raw", () => {
  assert.equal(formatDay("2026-10-01"), "1 Oct 2026");
  assert.equal(formatDay("2026-03-12T09:00:00Z"), "12 Mar 2026");
  assert.equal(formatDay(null), "");
  assert.equal(formatDay("soon"), "");
  assert.equal(formatDay("2026-13-01"), "");
});

test("stance words and values match the design (Champions … Opposes, U+2212 minus)", () => {
  assert.deepEqual([2, 1, 0, -1, -2].map(stanceLabel), ["Champions", "Supportive", "Neutral", "Sceptical", "Opposes"]);
  assert.equal(stanceLabel(null), "Unknown");
  assert.equal(stanceLabel("x"), "Unknown");
  assert.equal(stanceWithValue(1), "Supportive (+1)");
  assert.equal(stanceWithValue(0), "Neutral (0)");
  assert.equal(stanceWithValue("-2"), "Opposes (−2)");
  assert.equal(stanceWithValue(undefined), "Unknown");
  assert.equal(STANCE_BAND_ZERO, "Neutral or unknown");
});

test("relLabel: the four who-knows-them labels in words; unknown is empty, never raw", () => {
  assert.equal(relLabel("warm"), "Met in the last year");
  assert.equal(relLabel("known"), "Met, over a year ago");
  assert.equal(relLabel("owner_only"), "Only a TFS owner");
  assert.equal(relLabel("none"), "No meeting logged");
  assert.equal(relLabel("something_new"), "");
  assert.equal(relLabel(undefined), "");
});

test("measureLabel: given labels win, else humanised (no underscores)", () => {
  assert.equal(measureLabel("power"), "Power");
  assert.equal(measureLabel("relationship_strength"), "Relationship strength");
  assert.equal(measureLabel("lever", { measures: { lever: "How to move them" } }), "How to move them");
});

/* History — the profile's `history` shape (src/mcp/tools/power_maps.py get_power_map_profile):
   {id, map, measure, value, as_of, judged_by, review_status, note, source, author?, status?} */
const H = (o) => ({ id: o.id || Math.random().toString(36).slice(2), map: "EU convener (IA)", measure: "stance",
  value: 1, as_of: "2026-10-01", judged_by: null, review_status: "reviewed", note: null, source: null, ...o });

test("historySentence: a change reads 'changed from … to …', with map and rater (design brief §4.4 item 8)", () => {
  const hist = [H({ value: 1, judged_by: "Jakob M." }), H({ value: 0, as_of: "2026-09-03", judged_by: "Rita O." })];
  const [newest] = withPrevious(hist);
  assert.equal(historySentence(newest),
    "1 Oct 2026 · Stance changed from Neutral (0) to Supportive (+1) on EU convener (IA) — rated by Jakob M.");
});

test("historySentence: a first rating from an import reads 'rated … — imported from …'", () => {
  const e = H({ map: "Country Profiles", measure: "power", value: 4, as_of: "2026-03-12", source: "the Coda Mind Map" });
  assert.equal(historySentence(withPrevious([e])[0]), "12 Mar 2026 · Power rated 4 on Country Profiles — imported from the Coda Mind Map");
  assert.equal(historySentence(e, { sources: { "the Coda Mind Map": "the Coda Mind Map (March round)" } }),
    "12 Mar 2026 · Power rated 4 on Country Profiles — imported from the Coda Mind Map (March round)");
});

test("history: previous value is per map AND measure, and skips unconfirmed AI drafts", () => {
  const hist = [
    H({ id: "a", measure: "power", value: 5 }),
    H({ id: "b", measure: "stance", value: 2, author: "AI agent", status: "AI-drafted, unconfirmed" }),
    H({ id: "c", measure: "power", value: 4, map: "Other map" }),
    H({ id: "d", measure: "stance", value: 1 }),
    H({ id: "e", measure: "power", value: 3 }),
  ];
  const w = withPrevious(hist);
  assert.equal(w[0].previous, 3);           // same map, same measure — not "Other map"'s 4
  assert.equal(w[1].previous, 1);
  assert.equal(w[2].previous, undefined);
  assert.equal(withPrevious([H({ id: "x" }), hist[1]])[0].previous, undefined, "an AI draft is never 'changed from'");
  assert.equal(historyParts(w[0]).text, "Power changed from 3 to 5 on EU convener (IA)");
  assert.equal(historyParts(w[0], {}, { withMap: false }).text, "Power changed from 3 to 5");
});

test("history: AI-drafted entries say so and never 'rated by'; text scores are quoted and clipped", () => {
  const ai = H({ value: 2, author: "AI agent", status: "AI-drafted, unconfirmed", judged_by: "TFS AI Agent" });
  const p = historyParts(ai);
  assert.equal(p.text, "AI drafted a stance of Champions (+2) on EU convener (IA) — not yet confirmed");
  assert.equal(p.by, "");
  assert.match(historyParts({ ...ai, status: "Rejected" }).text, /— rejected$/);
  const long = "x".repeat(300);
  const t = historyParts(H({ measure: "note", value: long, judged_by: "Leonie R." }));
  assert.match(t.text, /^Note set to “x+…” on EU convener \(IA\)$/);
  assert.ok(t.text.length < 200);
  assert.equal(t.by, "— rated by Leonie R.");
  // An unchanged value is a re-rating, not a change.
  assert.equal(historyParts({ ...H({ value: 1 }), previous: 1 }).text, "Stance rated Supportive (+1) on EU convener (IA)");
});

test("historyGroups: ≤10 entries → one list; more → grouped by map, 5 shown + 'Show n more'", () => {
  const few = Array.from({ length: 10 }, (_, i) => H({ id: `f${i}`, as_of: `2026-09-${String(20 - i).padStart(2, "0")}` }));
  const g1 = historyGroups(few);
  assert.equal(g1.length, 1);
  assert.equal(g1[0].map, null);
  assert.equal(g1[0].entries.length, 10);
  assert.match(g1[0].entries[0].sentence, / on EU convener \(IA\)/);

  const many = [
    ...Array.from({ length: 12 }, (_, i) => H({ id: `a${i}`, map: "EU convener (IA)", value: i % 2 })),
    ...Array.from({ length: 3 }, (_, i) => H({ id: `b${i}`, map: "Country Profiles", measure: "power", value: 4 })),
  ];
  const g = historyGroups(many, {}, { currentMap: "EU convener (IA)" });
  assert.deepEqual(g.map((x) => x.title), ["On this map", "Country Profiles"]);
  assert.equal(g[0].count, 12);
  assert.equal(g[0].entries.length, 5);
  assert.equal(g[0].hidden.length, 7);
  assert.equal(g[0].moreLabel, "Show 7 more");
  assert.equal(g[1].moreLabel, null);
  assert.doesNotMatch(g[0].entries[0].sentence, / on EU convener/, "the group heading names the map");
});

/* Toast — a minimal fake DOM: enough to watch one-at-a-time, undo, timers and aria. */
function fakeDoc() {
  const mk = (tag) => {
    const n = {
      tagName: tag, attrs: {}, children: [], parent: null, listeners: {}, className: "", type: "", _text: "",
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      append(...ks) { for (const k of ks) { k.parent = this; this.children.push(k); } },
      remove() { if (this.parent) { this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; } },
      addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
      fire(t) { for (const f of this.listeners[t] || []) f({ type: t }); },
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); },
      set textContent(v) { this._text = String(v); },
    };
    return n;
  };
  const pm = mk("div"); pm.className = "pm";
  const body = mk("body"); body.append(pm);
  return { body, pm, createElement: mk, querySelector: (s) => (s === ".pm" ? pm : null) };
}
function fakeTimers() {
  let id = 0; const live = new Map();
  return {
    setTimer: (f, ms) => { live.set(++id, { f, ms }); return id; },
    clearTimer: (h) => live.delete(h),
    fireAll() { for (const [k, t] of [...live]) { live.delete(k); t.f(); } },
    live,
  };
}

test("undoToast: goes in the .pm root, announces politely, Undo calls back once and dismisses", () => {
  const doc = fakeDoc(); const t = fakeTimers();
  let undone = 0;
  const h = undoToast("Removed Ana Ferreira-Lindqvist from this map", () => undone++, { doc, ...t });
  assert.equal(h.el.parent, doc.pm);
  assert.equal(h.el.className, "toast");
  assert.equal(h.el.getAttribute("role"), "status");
  assert.equal(h.el.getAttribute("aria-live"), "polite");
  assert.equal(h.el.children[0].textContent, "Removed Ana Ferreira-Lindqvist from this map");
  const btn = h.el.children[1];
  assert.equal(btn.textContent, "Undo");
  btn.fire("click"); btn.fire("click");
  assert.equal(undone, 1);
  assert.equal(doc.pm.children.length, 0);
  assert.equal(t.live.size, 0);
});

test("undoToast: one at a time, auto-dismisses, pauses while hovered; no Undo without a callback", () => {
  const doc = fakeDoc(); const t = fakeTimers();
  let undone = 0;
  const a = undoToast("first", () => undone++, { doc, ...t, ms: 5000 });
  const b = undoToast("Link ended · it stays in History", null, { doc, ...t });
  assert.equal(doc.pm.children.length, 1);
  assert.equal(doc.pm.children[0], b.el);
  assert.equal(a.el.parent, null);
  assert.equal(b.el.children.length, 1, "no Undo button");
  b.el.fire("mouseenter");
  assert.equal(t.live.size, 0, "held while hovered");
  b.el.fire("mouseleave");
  assert.equal(t.live.size, 1);
  t.fireAll();
  assert.equal(doc.pm.children.length, 0);
  assert.equal(undone, 0, "a replaced or expired toast never undoes");
  assert.equal(undoToast("x", null, { doc: null }), null);
});

test("section open state: remembered per key, else the `open` attribute", () => {
  const st = memStore(); const s = pmStorage(() => st);
  assert.equal(sectionOpen(s, "m1:scores", true), true);
  assert.equal(sectionOpen(s, "m1:scores", false), false);
  rememberSection(s, "m1:scores", false);
  assert.equal(st.m.get(SECTION_KEY_PREFIX + "m1:scores"), "0");
  assert.equal(sectionOpen(s, "m1:scores", true), false);
  rememberSection(s, "m1:scores", true);
  assert.equal(sectionOpen(s, "m1:scores", false), true);
  rememberSection(s, null, true);   // no key: nothing kept
  assert.equal(sectionOpen(s, null, false), false);
});

test("infoLines: three short lines from 'a | b | c' or new lines", () => {
  assert.deepEqual(infoLines("Worked out from meetings. | Four labels. |  Not 'nobody'. "), ["Worked out from meetings.", "Four labels.", "Not 'nobody'."]);
  assert.deepEqual(infoLines("a\n\nb"), ["a", "b"]);
  assert.deepEqual(infoLines(null), []);
});

test("view switch: views parse, labels are words, choice = remembered > value > default > first", () => {
  assert.deepEqual(parseViews(" rings, network,,list,rings "), ["rings", "network", "list"]);
  assert.deepEqual(["rings", "network", "list", "cards", "by_country"].map(viewLabel), ["Rings", "Network", "List", "Cards", "By country"]);
  const views = ["rings", "network", "list", "cards"];
  assert.equal(resolveView({ views, stored: "list", value: "network", def: "rings" }), "list");
  assert.equal(resolveView({ views, stored: "gone", value: "network", def: "rings" }), "network");
  assert.equal(resolveView({ views, def: "cards" }), "cards");
  assert.equal(resolveView({ views, def: "nope" }), "rings");
  assert.equal(resolveView({ views: [] }), null);
  assert.equal(VIEW_KEY_PREFIX, "tfs-pm-view:");
});

test("peekView: title/date/type/body from get_record_for_editing; Edit only if a field is editable", () => {
  const rec = {
    table: "kms_entries", row_id: "i-abc", label: "Call with DG CNECT",
    values: { title: "Call with DG CNECT on the implementing act", date: "2026-09-18",
      type: { row_id: "i-t", label: "Meeting" }, notes: "Line one\n\nFollow-up owed by TFS." },
    editable: { title: true, notes: { editable: false, reason: "embedded", message: "…" } },
    source: "https://records.example.org/d/x#row",
  };
  const v = peekView(rec);
  assert.equal(v.title, "Call with DG CNECT on the implementing act");
  assert.equal(v.date, "18 Sep 2026");
  assert.equal(v.type, "Meeting");
  assert.equal(v.body, "Line one\n\nFollow-up owed by TFS.");
  assert.equal(v.canEdit, true);
  assert.equal(v.source, "https://records.example.org/d/x#row");
  assert.equal(peekMeta(v), "18 Sep 2026 · Meeting");
  assert.equal(peekMeta({ ...v, by: "Jakob M." }), "18 Sep 2026 · Meeting · logged by Jakob M.");
  // The page's _source wins; a non-http source is never a link.
  assert.equal(peekView(rec, { source: "https://records.example.org/page" }).source, "https://records.example.org/page");
  assert.equal(peekView({ ...rec, source: "javascript:alert(1)" }).source, null);
  assert.equal(peekView({ ...rec, editable: { notes: { editable: false } } }).canEdit, false);
  assert.equal(peekView({ label: "Only a label" }).title, "Only a label");
  assert.equal(peekView(null).title, "Untitled");
});

test("displayText: strings, linked {row_id,label} and lists, never a raw object", () => {
  assert.equal(displayText([{ row_id: "i-1", label: "A" }, "B", null]), "A, B");
  assert.equal(displayText({ row_id: "i-1" }), "");
  assert.equal(displayText(3), "3");
});

test("pm-parts puts record text in the DOM only via textContent; innerHTML only for static icons and the md body", () => {
  const src = readFileSync(new URL("../pm-parts.js", import.meta.url), "utf8");
  const uses = [...src.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
  for (const u of uses) {
    assert.ok(/^(CHEV|BACK|'<svg|`<svg|mdToHtml\(v\.body\))/.test(u), `unexpected innerHTML source: ${u}`);
  }
  assert.ok(uses.includes("mdToHtml(v.body)"));
  assert.doesNotMatch(src, /\.pm\s+button/, "no page-level `.pm button` rule (HANDOFF §6)");
  assert.doesNotMatch(src, /claude\.use/, "server calls go through the kit transport");
});
