/* TFS pages kit — form components: <tfs-record-form>, <tfs-picker>, <tfs-rich-text> (spec §6.1),
 * and the status menu both the form and <tfs-status-menu> open.
 *
 * A PAGE NEVER CARRIES ITS OWN COPY OF HOW TFS DATA WORKS. The form is built from
 * `describe_record_form` (fields, kinds, options, option colours, defaults, rules) and, to edit,
 * from `get_record_for_editing` (values, per-field `editable`, `row_version`). The `fields`
 * attribute may choose and order a subset of what the server serves; it can never add a field.
 *
 * ONLY CHANGED FIELDS ARE SENT (Review Focus 4). The form keeps each field's `initial` value in
 * WIRE form (what `save_record` takes: a linked field as row id(s), a date as YYYY-MM-DD) and
 * sends only the fields whose current value differs. An untouched field holding a value no
 * longer offered (an archived status) is therefore never sent, so it survives a save of others.
 * A rich-text field the person did not edit returns its ORIGINAL markdown, not a re-serialisation
 * of it, so opening a record and saving its status never rewrites its notes.
 *
 * THE LOOK is the design pass of 2026-10-07 (Claude Design; `kit.css` is that design,
 * finished): labels above every control, a header with a close ×, a footer with Close/Cancel and
 * Save in EVERY state, short state words in the footer line and anything needing a sentence or
 * an action in `.tfs-form__notice` as a `.tfs-msg`. `formView` is the one place that decides
 * what each state shows; it is pure, so Node tests every row of the handover's state table.
 *
 * STATUS COLOURS COME ONLY FROM THE SERVER: each option's `color` (Coda's hex), painted with
 * `paintStatusChip`. A status NAME is never mapped to a colour here.
 *
 * The logic is exported as pure functions (`selectFields`, `dirtyFields`, `wireOf`, `payloadFor`,
 * `formView`, `conflictCopy`, `menuNav`, …) so Node can test it without a DOM; the elements only
 * wire them to controls.
 *
 * THE RICH-TEXT EDITOR is the Review Inbox's, ported: `blockAt`, `setBlock`, the command table,
 * `runCmd`, the link bar, the tick-box, Tab nesting and the plain-text paste handler keep their
 * logic (and markdown.js, its converter, is untouched). Changes forced by the new home:
 *   - the toolbar is exactly the supported subset (H1, H2, H3, bold, italic, strikethrough, link,
 *     bullets, numbers, tick-box list, quote) in groups; at 470px editor width or less, link,
 *     lists and quote fold into a More menu (the fold itself is kit.css's container query);
 *   - the link address is asked for in a small inline field, not `window.prompt`, because a
 *     sandboxed artifact frame may refuse modal dialogs, and a refused prompt returns null
 *     silently: the Link button would do nothing and say nothing.
 * Every document-level listener is scoped to `tfs-rich-text`, so the kit can share a page with
 * the Review Inbox's own editor without either answering the other's events.
 */
import { mdToHtml, htmlToMd } from "./markdown.js";
import { SaveMachine } from "./save.js";
import { createTransport } from "./transport.js";
import { icon } from "./icons.js";
import { paintStatusChip } from "./status-colour.js";

const Base = globalThis.HTMLElement || class {};

/* ===========================================================================
   Pure logic (Node-tested)
   ========================================================================= */

/** The served fields a page shows: all of them, or the `fields` attribute's names in its order.
 * Unknown names are ignored, never invented; a repeated name appears once. */
export function selectFields(served, attr) {
  const list = Array.isArray(served) ? served : [];
  if (attr == null || !String(attr).trim()) return list.slice();
  const byName = new Map(list.map((f) => [f.name, f]));
  const seen = new Set();
  const out = [];
  for (const raw of String(attr).split(",")) {
    const n = raw.trim();
    if (!n || seen.has(n) || !byName.has(n)) continue;
    seen.add(n); out.push(byName.get(n));
  }
  return out;
}

export function isBlank(v) {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

/** A value reduced to what decides "changed": blanks are equal, a linked item is its row id, a
 * list compares as a sorted set. */
export function canon(v) {
  if (isBlank(v)) return null;
  if (Array.isArray(v)) return v.map(canon).filter((x) => x !== null).map((x) => JSON.stringify(x)).sort();
  if (v && typeof v === "object" && "row_id" in v) return v.row_id;
  return v;
}

/** `{field: current value}` for every field whose current value differs from its initial one. */
export function dirtyFields(initial, current) {
  const out = {};
  for (const k of Object.keys(current || {})) {
    if (JSON.stringify(canon(current[k])) !== JSON.stringify(canon((initial || {})[k]))) out[k] = current[k];
  }
  return out;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** What `get_record_for_editing` / a default / a preset holds, as `save_record` takes it. */
export function wireOf(field, value) {
  const kind = field.kind;
  if (kind === "linked") {
    const items = Array.isArray(value) ? value : isBlank(value) ? [] : [value];
    const ids = items.map((i) => (i && typeof i === "object" ? i.row_id : i)).filter((i) => typeof i === "string" && i);
    return field.multi ? ids : (ids[0] || null);
  }
  if (isBlank(value)) return field.multi ? [] : null;
  if (kind === "date") { const s = String(value); return ISO_DATE.test(s) ? s.slice(0, 10) : s; }
  if (kind === "number") { const n = Number(value); return Number.isNaN(n) ? value : n; }
  if (kind === "checkbox") return value === true || value === "true" ? true : value === false || value === "false" ? false : null;
  if (kind === "dropdown" && field.multi) return (Array.isArray(value) ? value : [value]).map(String);
  if (kind === "rich_text") return String(value);
  return typeof value === "string" ? value : String(value);
}

/** The `fields` argument for `save_record`: changed fields only, each in wire form. A field the
 * person EMPTIED is sent as the pipeline's clear (`""`, or `[]` for a list), never as `null`,
 * which the pipeline reads as "leave unchanged". Names the server did not serve are dropped. */
export function payloadFor(fieldsByName, initialWire, currentWire) {
  const dirty = dirtyFields(initialWire, currentWire);
  const out = {};
  for (const [k, v] of Object.entries(dirty)) {
    const f = fieldsByName[k];
    if (!f) continue;
    out[k] = isBlank(v) ? (f.multi ? [] : "") : v;
  }
  return out;
}

/** A rich-text field's value: the original markdown until the person edits, then the editor's
 * serialisation. (`htmlToMd(mdToHtml(md))` is not always byte-equal to `md`; an untouched field
 * must not be rewritten.) */
export function richTextValue(original, touched, serialize, baseline) {
  if (!touched) return original == null ? null : original;
  const now = serialize();
  // A gesture that leaves the text as it was loaded (opening a link, Change then Cancel, a
  // toolbar press undone) is not an edit. A stored twin that is not in `htmlToMd`'s canonical
  // form (`* ` bullets, 4-space nesting) serialises differently from ITSELF, so comparing with
  // the original would read as a change and rewrite the whole cell. The baseline is what the
  // editor serialised to right after it was filled.
  if (baseline !== undefined && now === baseline) return original == null ? null : original;
  return now;
}

/** A native control's wire value: what the person entered once they have touched it, else
 * EXACTLY the initial value. The browser sanitises a value on set (<input type=text> drops
 * newlines, url/email trim, date/number blank what they cannot parse), so reading an untouched
 * control back would report a change nobody made — and send it, or clear the field. */
export function controlValue(touched, read, initial) {
  return touched ? read() : initial;
}

/** `<textarea>` for a text value with a line break (an <input> would join the lines). */
export function textControlTag(initial) {
  return typeof initial === "string" && initial.includes("\n") ? "textarea" : "input";
}

/** A link a page may open: http(s) only, else null (rendered as plain text). */
export function safeHref(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

/** Links a person can WRITE into a rich-text field, open from the link bar, or have rendered as a
 * link: http, https and mailto only. Anything else (`javascript:`, `data:`, a bare domain) is
 * refused where it is typed and shown as plain text where it already exists. */
export function allowedLinkHref(u) {
  return typeof u === "string" && /^(https?:\/\/|mailto:)/i.test(u) ? u : null;
}
export const LINK_REFUSED = "That doesn't look like a web address. Start it with https://";

/** The local refusal for a touched number/date input the browser could not parse, or null.
 * The browser reports such an input's value as "", which would otherwise be sent as a CLEAR.
 * `rawText` is the typed text where the caller can see it; an empty one is a real clear. */
export function badInputMessage(field, { badInput = false, rawText = "", value = "" } = {}) {
  if (field.kind !== "number" && field.kind !== "date") return null;
  const unparsed = badInput || (String(rawText || "").trim() !== "" && value === "");
  if (!unparsed) return null;
  return `${field.label || field.name} isn't a valid ${field.kind === "number" ? "number" : "date"}.`;
}

/** Edit mode fails closed: a field is editable only when the server said exactly `true`. */
export function isEditable(editable) { return editable === true; }

/** The starting point after a save landed but the record could not be re-read: what was SENT
 * (the machine's `pending`) is now the stored value, so it must not be sent again. Never the
 * form's current values — anything not in the save is not stored. */
export function initialAfterUnreadSave(initial, pending) {
  return { ...(initial || {}), ...(pending || {}) };
}

/** Whether the form's fields are locked: while the machine is busy (checking, saving, waiting
 * on the person's confirm) and while the page re-reads the record after a save — a redraw
 * from that re-read would silently drop anything typed in the meantime. */
export function formLocked(busy, rereading) { return !!(busy || rereading); }

/** True when the element sits inside a disabled <fieldset> (the record form locks itself
 * this way during a save). A disabled fieldset does not block mousedown on a plain <li>, so
 * the picker checks it itself. */
export function lockedByFieldset(el) {
  return !!(el && typeof el.closest === "function" && el.closest("fieldset")?.disabled);
}

/** A dropdown's options with the current value kept even when no longer offered. */
export function optionsWithCurrent(options, current) {
  const opts = (options || []).map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  const cur = Array.isArray(current) ? current : isBlank(current) ? [] : [current];
  for (const c of cur) {
    if (!opts.some((o) => o.value === c)) opts.push({ value: c, label: `${c} (no longer offered)`, retired: true });
  }
  return opts;
}

/** "Choose at least one of: …" lines for `required_groups`, in the served labels. */
export function groupLines(groups, served) {
  const label = new Map((served || []).map((f) => [f.name, f.label || f.name]));
  return (groups || []).filter((g) => Array.isArray(g) && g.length)
    .map((g) => `Choose at least one of: ${g.map((n) => label.get(n) || n).join(", ")}`);
}

/* ---------------------------------------------------------------------------
   Words and states (design pass 2026-10-07). Pure, so Node tests every row.
   ------------------------------------------------------------------------- */

const NOUNS = {
  tasks: "task", projects: "project", kms_entries: "KMS entry", impact: "impact entry",
  contacts: "contact", organizations: "organisation", project_updates: "project update",
};
/** The plain word for one record of `table` ("task"); "record" for a table the kit has no word for. */
export function nounOf(table) { return NOUNS[table] || "record"; }
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** "No changes" / "1 unsaved change" / "N unsaved changes". */
export function countLabel(n) {
  return !n ? "No changes" : n === 1 ? "1 unsaved change" : `${n} unsaved changes`;
}

/** The first required field (in the order shown) that is still blank, or null. */
export function missingRequired(shown, current) {
  for (const f of shown || []) if (f && f.required && isBlank((current || {})[f.name])) return f;
  return null;
}

/** "Add a title to save" — the create footer naming the first missing required field. */
export function addPhrase(label) {
  const raw = String(label || "value");
  // Lower-case the first letter of an ordinary word, never an acronym ("KMS entry" stays).
  const word = /^[A-Z][a-z]/.test(raw) ? raw.charAt(0).toLowerCase() + raw.slice(1) : raw;
  return `Add ${/^[aeiou]/i.test(word) ? "an" : "a"} ${word} to save`;
}

/** "just now" / "4 minutes ago" / "2 hours ago" / "3 days ago"; "" when `iso` is unusable. */
export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso || "");
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const unit = (n, w) => `${n} ${w}${n === 1 ? "" : "s"} ago`;
  if (s < 3600) return unit(Math.floor(s / 60), "minute");
  if (s < 86400) return unit(Math.floor(s / 3600), "hour");
  return unit(Math.floor(s / 86400), "day");
}

/** ["A"] / ["A", " and ", "B"] … as body segments, each name `{strong}`. */
function strongList(names) {
  const out = [];
  names.forEach((n, i) => {
    if (i) out.push(i === names.length - 1 ? " and " : ", ");
    out.push({ strong: n });
  });
  return out;
}

/**
 * The "changed since you opened it" message, from the server's `changed_since_opened` warning
 * (`{fields, by, at, message}`; `by` is a name, "You", or null). The server's `fields` are the
 * fields the person is saving that were ALSO changed since they opened the record.
 * Returns `{title, paragraphs}`; a paragraph is a list of segments (text, or `{strong}`).
 * Never a pronoun guess: another person is "they".
 */
export function conflictCopy(w, { noun = "record", labelOf = (n) => n, now = Date.now(), tokenStale = false } = {}) {
  const warning = w || {};
  const fields = (Array.isArray(warning.fields) ? warning.fields : []).map((n) => labelOf(n));
  const ago = relativeTime(warning.at, now);
  const when = ago ? ` ${ago}` : " since you opened it";
  const by = typeof warning.by === "string" && warning.by.trim() ? warning.by.trim() : null;
  if (by === "You") {
    const p = fields.length
      ? ["You changed ", ...strongList(fields), " in another tab or session. Saving now replaces that version with this one. Save anyway?"]
      : ["You changed it in another tab or session. Saving now replaces that version with this one. Save anyway?"];
    const paras = [p];
    if (tokenStale) paras.push(["That is probably your own save just now: this page couldn't reload the record after it."]);
    return { title: `You changed this ${noun}${when}`, paragraphs: paras };
  }
  if (by) {
    const p = fields.length
      ? ["They changed ", ...strongList(fields), ". Saving now replaces their version with yours. Save anyway?"]
      : ["Saving now replaces their version with yours. Save anyway?"];
    return { title: `${by} changed this ${noun}${when}`, paragraphs: [p] };
  }
  // Who (or when) is not known — a change made in Coda itself: say what is known.
  const p = fields.length
    ? ["The change touches ", ...strongList(fields), ". Saving now replaces that version with yours. Save anyway?"]
    : ["Saving now replaces that version with yours. Save anyway?"];
  return { title: "Someone changed this since you opened it", paragraphs: [p] };
}

/** `{fieldErrors: {name: message}, other: [message]}` from a refusal receipt. A refusal whose
 * `field` is shown on the form is marked at that field; everything else is listed. */
export function refusalView(receipt, shownNames = []) {
  const shown = new Set(shownNames);
  const fieldErrors = {};
  const other = [];
  for (const r of (receipt && receipt.refusals) || []) {
    const msg = r && r.message;
    if (!msg) continue;
    if (r.field && shown.has(r.field)) fieldErrors[r.field] = fieldErrors[r.field] ? `${fieldErrors[r.field]} ${msg}` : msg;
    else other.push(msg);
  }
  return { fieldErrors, other };
}

function notSavedNotice(fieldErrors, other) {
  const nField = Object.keys(fieldErrors).length;
  const count = nField + other.length;
  if (!count) return { tone: "error", title: "Not saved", paragraphs: [["Nothing was saved."]] };
  const title = `Not saved: ${count} thing${count === 1 ? "" : "s"} to fix`;
  if (!other.length) return { tone: "error", title, paragraphs: [[count === 1 ? "It is marked at its field." : "Each is marked at its field."]] };
  const paragraphs = nField ? [[nField === 1 ? "One more is marked at its field." : `${nField} more are marked at their fields.`]] : [];
  return { tone: "error", title, list: other, paragraphs };
}

const SAVED_LINE = "Saved · shows on pages within a few minutes";
const UNKNOWN_BODY = "It may have gone through. Check Coda before trying again.";
export const NO_CONNECTOR = {
  title: "Add the TFS connector to edit here",
  body: "This page saves to Coda through the TFS MCP Server connector, which isn't on your claude.ai account yet. Add it in claude.ai's settings, under Connectors, then reload this page.",
};

/**
 * What the record form shows, for one moment: the handover's state table as data.
 *
 *   {footer: {text, spinner, ok} | null,
 *    notices: [{tone, title, paragraphs, list, actions, quiet}],
 *    close: {label: "Close"|"Cancel", action: "close"|"abort"},
 *    save: {label, disabled, busy, hidden, action: "save"|"confirm"},
 *    fieldErrors: {name: message}, locked}
 *
 * `phase` is "loading" | "load_failed" | "no_connector" | "ready"; `state` is the save
 * machine's. Notice `actions` are descriptors: `{kind: "link", href, label}`, `{kind: "retry"}`
 * (retry an update whose outcome is unknown), `{kind: "reload"}` (load the form again).
 */
export function formView(o = {}) {
  const {
    phase = "ready", state = "idle", receipt = null, isUpdate = false, tokenStale = false,
    dirtyCount = 0, missing = null, noun = "record", saveLabel = null, labelOf = (n) => n,
    shownNames = [], now = Date.now(), loadError = null, localErrors = null,
    rereading = false, rereadFailed = false,
  } = o;
  const r = receipt || {};
  const label = saveLabel || (isUpdate ? "Save changes" : `Add ${noun}`);
  const view = {
    footer: null, notices: [], close: { label: "Close", action: "close" },
    save: { label, disabled: false, busy: false, hidden: false, action: "save" },
    fieldErrors: {}, locked: false,
  };
  if (phase === "loading") {
    view.footer = { text: "Loading the form…", spinner: true };
    view.close.label = "Cancel"; view.save.hidden = true; return view;
  }
  if (phase === "no_connector") {
    view.notices.push({ tone: "info", title: NO_CONNECTOR.title, paragraphs: [[NO_CONNECTOR.body]] });
    view.save.hidden = true; return view;
  }
  if (phase === "load_failed") {
    const e = loadError || {};
    view.notices.push({ tone: "error", title: "Couldn't load this form",
      paragraphs: [[e.message || "The TFS server didn't answer. Nothing has been changed."]],
      actions: e.retry ? [{ kind: "reload" }] : [] });
    view.save.hidden = true; return view;
  }

  const dirtyClose = () => { view.close.label = !isUpdate || dirtyCount ? "Cancel" : "Close"; };
  const idle = () => {
    if (!isUpdate) {
      view.close.label = "Cancel";
      if (missing) { view.footer = { text: addPhrase(missing) }; view.save.disabled = true; }
      else if (dirtyCount) view.footer = { text: countLabel(dirtyCount) };
    } else {
      view.footer = { text: countLabel(dirtyCount) };
      view.save.disabled = dirtyCount === 0;
      dirtyClose();
    }
  };

  if (localErrors && Object.keys(localErrors).length && !["previewing", "saving", "confirm"].includes(state)) {
    idle();
    view.footer = null;
    view.save.disabled = false;
    view.fieldErrors = { ...localErrors };
    view.notices.push(notSavedNotice(localErrors, []));
    return view;
  }

  switch (state) {
    case "previewing":
      view.footer = { text: "Checking with Coda…" };
      view.close = { label: "Cancel", action: "abort" };
      view.save = { ...view.save, label: "Checking…", busy: true, disabled: true };
      view.locked = true; return view;
    case "confirm": {
      const w = (r.warnings || []).find((x) => x && x.code === "changed_since_opened");
      const c = conflictCopy(w, { noun, labelOf, now, tokenStale });
      view.notices.push({ tone: "warn", title: c.title, paragraphs: c.paragraphs });
      view.close = { label: "Cancel", action: "abort" };
      view.save = { ...view.save, label: "Save anyway", action: "confirm" };
      view.locked = true; return view;
    }
    case "saving":
      view.footer = { text: "You can close this; the save carries on." };
      view.save = { ...view.save, label: "Saving…", busy: true, disabled: true };
      view.locked = true; return view;
    case "outcome_unknown": {
      const actions = [];
      const href = safeHref(r.source);
      if (href) actions.push({ kind: "link", href, label: "Check in Coda" });
      if (isUpdate) actions.push({ kind: "retry" });
      view.notices.push({ tone: "warn", title: "Coda didn't confirm this save",
        paragraphs: [[r.message || UNKNOWN_BODY]], actions });
      view.save.hidden = true; return view;
    }
    case "refused": {
      const { fieldErrors, other } = refusalView(r, shownNames);
      view.fieldErrors = fieldErrors;
      view.notices.push(notSavedNotice(fieldErrors, other));
      view.close.label = "Cancel";
      view.save.disabled = !isUpdate && !!missing;
      return view;
    }
    case "saved_syncing": {
      if (dirtyCount && !rereading) { idle(); return view; }
      const warnings = (r.warnings || []).filter((x) => x && x.message);
      if (warnings.some((x) => x.code === "already_saved")) {
        view.notices.push({ tone: "info", title: "Already saved", paragraphs: [["This was already saved earlier. Nothing new was written."]] });
        view.save.hidden = true;
      } else {
        view.footer = { text: rereadFailed ? "Saved · refresh to see the latest" : SAVED_LINE, ok: true };
        view.save.disabled = true;
      }
      const rest = warnings.filter((x) => x.code !== "already_saved").map((x) => x.message);
      if (rest.length) view.notices.push({ tone: "info", title: null, list: rest, paragraphs: [] });
      if (!isUpdate && r.lag && r.lag.new_row_editable_after) {
        view.notices.push({ tone: "info", quiet: true, paragraphs: [[r.lag.new_row_editable_after]] });
      }
      view.locked = !!rereading;
      if (!isUpdate) view.close.label = "Close";
      return view;
    }
    default:
      idle(); return view;
  }
}

/** Kept for pages written against 1.0: the old name, now the new view. */
export function stateView(state, receipt, opts = {}) { return formView({ ...opts, state, receipt }); }

/** Keyboard in a menu: the next active index and what to do (`pick`, `close`, `tab`, or null).
 * ArrowDown/ArrowUp wrap; Home/End jump; Enter and Space pick; Escape closes; Tab closes and
 * lets focus move on. */
export function menuNav(active, count, key) {
  if (!count) return { active: -1, action: key === "Escape" ? "close" : key === "Tab" ? "tab" : null };
  const a = active < 0 ? -1 : active;
  switch (key) {
    case "ArrowDown": return { active: (a + 1) % count, action: null };
    case "ArrowUp": return { active: a <= 0 ? count - 1 : a - 1, action: null };
    case "Home": return { active: 0, action: null };
    case "End": return { active: count - 1, action: null };
    case "Enter": case " ": return { active: a, action: a >= 0 ? "pick" : null };
    case "Escape": return { active: a, action: "close" };
    case "Tab": return { active: a, action: "tab" };
    default: return { active: a, action: null };
  }
}

/** What picking `value` in the status menu does: "ignore" while a save is out, "close" for the
 * current status (nothing changes), "pick" for another. */
export function pickAction(value, current, busy = false) {
  if (busy) return "ignore";
  return value === current ? "close" : "pick";
}

/** "Ana O'Example" -> "AO"; one name -> its first letter. */
export function initials(name) {
  const w = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!w.length) return "?";
  return (w[0][0] + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase();
}

/** `[before, match, after]` around the first case-insensitive match of `q`, or `[text, "", ""]`. */
export function markMatch(text, q) {
  const s = String(text == null ? "" : text);
  const needle = String(q || "").trim();
  const i = needle ? s.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (i < 0) return [s, "", ""];
  return [s.slice(0, i), s.slice(i, i + needle.length), s.slice(i + needle.length)];
}

/** Whether a served field is a STATUS: a single dropdown called `status`, or one whose options
 * carry the server's colours. Drawn as a status chip that opens the status menu. */
export function isStatusField(f) {
  return !!f && f.kind === "dropdown" && !f.multi
    && (f.name === "status" || (f.options || []).some((o) => o && typeof o === "object" && o.color));
}

/* ===========================================================================
   Shared helpers
   ========================================================================= */

let defaultTransport = null;
let autoTransport = null;
/** Set the transport every kit element uses unless it is given its own (`el.transport = …`).
 * Without one, the kit uses the claude.ai artifact transport.
 *
 * ⛔ ELEMENTS UPGRADE THE MOMENT kit.js DEFINES THEM — before the page's own module code runs
 * `configure`. So an element never reads its transport in `connectedCallback`: it loads one
 * microtask later, after the importing script's body has run. */
export function configure({ transport } = {}) { if (transport) defaultTransport = transport; }
export function transportOf(el) {
  return el._transport || defaultTransport || autoTransport || (autoTransport = createTransport({ kind: "artifact" }));
}

/* Status options per transport and table, from `describe_record_form(table, "edit")`: the
   order and the colours are Coda's, served. A failed load is forgotten so the next asks again. */
const statusCache = new WeakMap();
export function loadStatusOptions(transport, table, field = "status") {
  let per = statusCache.get(transport);
  if (!per) { per = new Map(); statusCache.set(transport, per); }
  const key = `${table}\u0000${field}`;
  if (!per.has(key)) {
    const p = Promise.resolve(transport.call("describe_record_form", { table, mode: "edit" })).then((form) => {
      if (!form || form.refused) throw { code: "refused", message: (form && form.message) || "This form isn't available." };
      const f = (form.fields || []).find((x) => x.name === field);
      return optionsWithCurrent(f ? f.options : [], null);
    });
    p.catch(() => per.delete(key));
    per.set(key, p);
  }
  return per.get(key);
}

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c);
  return el;
}

let uid = 0;
export const nextId = (p) => `${p}-${++uid}`;

export const spinner = () => h("span", { class: "tfs-spin", "aria-hidden": "true" });

function segments(parts) {
  return (parts || []).map((s) => (s && typeof s === "object" && "strong" in s ? h("strong", { text: s.strong }) : document.createTextNode(String(s))));
}

const MSG_ICON = { ok: "ok", warn: "warn", error: "error", info: "info" };

/** A `.tfs-msg` from `{tone, title, paragraphs, list, quiet}` plus action NODES. */
export function msgEl({ tone = "info", title = null, paragraphs = [], list = null, quiet = false } = {}, actions = []) {
  const role = tone === "warn" || tone === "error" ? "alert" : "status";
  if (quiet) {
    return h("p", { class: `tfs-msg tfs-msg--quiet tfs-msg--${tone}`, role }, icon(MSG_ICON[tone]),
      ...segments(paragraphs.flat()));
  }
  const body = h("div", { class: "tfs-msg__body" });
  if (title) body.append(h("div", { class: "tfs-msg__title", text: title }));
  for (const p of paragraphs || []) body.append(h("p", {}, ...segments(p)));
  if (list && list.length) body.append(h("ul", {}, ...list.map((t) => h("li", { text: t }))));
  if (actions && actions.length) body.append(h("div", { class: "tfs-msg__actions" }, ...actions));
  return h("div", { class: `tfs-msg tfs-msg--${tone}`, role }, icon(MSG_ICON[tone]), body);
}

/** "Check in Coda" as a small button-link that opens Coda in a new tab. */
export function codaLink(href, text = "Check in Coda") {
  return h("a", { class: "tfs-btn tfs-btn--small", href, target: "_blank", rel: "noopener" }, text, icon("open"));
}

/** A status chip (`span` or `button`) painted with the server's colour. */
export function statusChip(text, color, { tag = "span", small = false } = {}) {
  const el = h(tag, { class: small ? "tfs-status tfs-status--small" : "tfs-status" });
  el.append(document.createTextNode(text == null || text === "" ? "Not set" : String(text)));
  paintStatusChip(el, color);
  return el;
}

/* ===========================================================================
   The status menu: a menu of the status chips, in Coda's order (HANDOVER "Status menu").
   Used by <tfs-status-menu> (picking saves at once) and by the form's status field (picking
   only sets the value). The caller decides what a pick does.
   ========================================================================= */

export class StatusMenu {
  /**
   * @param {object} o
   * @param {{value, label, color}[]} o.options  in the served order
   * @param {string|null} o.current
   * @param {(value: string, menu: StatusMenu) => void} o.onPick  a DIFFERENT value was picked
   * @param {() => void} [o.onClose]
   */
  constructor({ options, current, onPick, onClose = null, label = "Change status" }) {
    this.onPick = onPick; this.onClose = onClose; this.busy = false; this.active = -1; this.anchor = null;
    const id = nextId("tfs-sm");
    this.el = h("div", { class: "tfs-menu", hidden: true });
    this.list = h("ul", { class: "tfs-menu__list", role: "menu", "aria-labelledby": `${id}-l`, tabindex: "-1" });
    this.el.append(h("p", { class: "tfs-menu__label", id: `${id}-l`, text: label }), this.list);
    this.list.addEventListener("keydown", (e) => this._key(e));
    this._outside = (e) => {
      if (this.busy) return;
      if (this.el.contains(e.target) || (this.anchor && this.anchor.contains(e.target))) return;
      this.close(false);
    };
    this.setOptions(options, current);
  }

  get isOpen() { return !this.el.hidden; }

  setOptions(options, current) {
    this.current = current == null ? null : current;
    const base = this.list.id || nextId("tfs-smi");
    this.items = (options || []).map((o, i) => {
      const hint = h("span", { class: "tfs-menu__hint" });
      const li = h("li", { class: "tfs-menu__item", id: `${base}-${i}`, role: "menuitemradio", "aria-checked": "false" },
        icon("tick", "tfs-menu__tick"), statusChip(o.label || o.value, o.color), hint);
      li.addEventListener("mousedown", (e) => e.preventDefault());   // focus stays on the list
      li.addEventListener("click", () => this._pick(i));
      return { li, hint, value: o.value };
    });
    this.list.replaceChildren(...this.items.map((x) => x.li));
    this._marks();
  }

  _marks() {
    for (const it of this.items) {
      const cur = it.value === this.current;
      it.li.setAttribute("aria-checked", String(cur));
      if (!this.busy) it.hint.replaceChildren(cur ? "Current" : "");
    }
  }

  setCurrent(v) { this.current = v; this._marks(); }

  _setActive(i) {
    this.active = i;
    this.items.forEach((it, j) => it.li.classList.toggle("is-active", j === i));
    if (i >= 0 && this.items[i]) this.list.setAttribute("aria-activedescendant", this.items[i].li.id);
    else this.list.removeAttribute("aria-activedescendant");
  }

  open(anchor) {
    this.anchor = anchor || this.anchor;
    this.clearMessage();
    this.el.hidden = false;
    this.el.style.left = "";
    if (this.anchor) this.anchor.setAttribute("aria-expanded", "true");
    const cur = this.items.findIndex((it) => it.value === this.current);
    this._setActive(cur >= 0 ? cur : 0);
    this.list.focus();
    document.addEventListener("mousedown", this._outside, true);
    // Keep the menu on screen: a chip near the right edge would push it past the viewport.
    const r = this.el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    if (r.right > vw - 8) this.el.style.left = `${Math.min(0, vw - 8 - r.right)}px`;
  }

  close(focusAnchor = true) {
    if (this.el.hidden) return;
    this.el.hidden = true;
    document.removeEventListener("mousedown", this._outside, true);
    if (this.anchor) {
      this.anchor.setAttribute("aria-expanded", "false");
      if (focusAnchor) this.anchor.focus();
    }
    if (this.onClose) this.onClose();
  }

  /** Saving: every item aria-disabled; the picked row says "Saving…". */
  setSaving(value) {
    this.busy = true;
    this.el.setAttribute("aria-busy", "true");
    for (const it of this.items) {
      it.li.setAttribute("aria-disabled", "true");
      if (it.value === value) it.hint.replaceChildren(spinner(), "Saving…");
      else it.hint.replaceChildren("");
    }
    this.clearMessage();
  }

  setIdle() {
    this.busy = false;
    this.el.removeAttribute("aria-busy");
    for (const it of this.items) it.li.removeAttribute("aria-disabled");
    this._marks();
  }

  setHint(value, text) {
    const it = this.items.find((x) => x.value === value);
    if (it) it.hint.replaceChildren(text);
  }

  showMessage(node) { this.clearMessage(); this._msg = node; this.el.append(node); }
  clearMessage() { if (this._msg) { this._msg.remove(); this._msg = null; } }

  _key(e) {
    const r = menuNav(this.active, this.items.length, e.key);
    if (r.action === "tab") { if (!this.busy) this.close(false); return; }
    if (r.action === "close") { e.preventDefault(); if (!this.busy) this.close(true); return; }
    if (r.action === "pick") { e.preventDefault(); this._pick(r.active); return; }
    if (r.active !== this.active) { e.preventDefault(); this._setActive(r.active); }
  }

  _pick(i) {
    const it = this.items[i];
    if (!it) return;
    const act = pickAction(it.value, this.current, this.busy);
    if (act === "ignore") return;
    this._setActive(i);
    if (act === "close") { this.close(true); return; }   // the current one: just close
    this.onPick(it.value, this);
  }
}

/* ===========================================================================
   <tfs-rich-text> — the Review Inbox editor, ported
   ========================================================================= */

/* The block element the cursor is currently inside, within this editor. */
function blockAt(editor){
  let n=window.getSelection && window.getSelection().anchorNode;
  while(n && n!==editor){
    if(n.nodeType===1 && /^(P|H1|H2|H3|BLOCKQUOTE|LI)$/.test(n.nodeName)) return n;
    n=n.parentNode;
  }
  return null;
}
function setBlock(editor, tag){
  const cur=blockAt(editor);
  /* Pressing the level you are already on returns you to body text. */
  const target = (cur && cur.nodeName===tag) ? 'P' : tag;
  document.execCommand('formatBlock', false, target.toLowerCase());
}

/* The selection, kept across the inline link field taking focus, and put back afterwards. */
function saveRange(){ const s=window.getSelection(); return s && s.rangeCount ? s.getRangeAt(0).cloneRange() : null; }
function restoreRange(editor, range){
  editor.focus();
  if(!range) return;
  const s=window.getSelection(); s.removeAllRanges(); s.addRange(range);
}
/* Ask for a link address in the editor's own inline field (not `prompt`: see the module note). */
function askUrl(editor, initial){
  const host=editor.closest('tfs-rich-text');
  return host ? host._askUrl(initial) : Promise.resolve(null);
}

const RICH_CMD = {
  bold:    ()=>document.execCommand('bold'),
  italic:  ()=>document.execCommand('italic'),
  strike:  ()=>document.execCommand('strikeThrough'),
  quote:   (ed)=>setBlock(ed,'BLOCKQUOTE'),
  ul:      ()=>document.execCommand('insertUnorderedList'),
  ol:      ()=>document.execCommand('insertOrderedList'),
  h1:      (ed)=>setBlock(ed,'H1'),
  h2:      (ed)=>setBlock(ed,'H2'),
  h3:      (ed)=>setBlock(ed,'H3'),
  link:    async (ed)=>{
    const range=saveRange();
    const u=allowedLinkHref(await askUrl(ed, 'https://'));
    if(!u) return;
    restoreRange(ed, range);
    if(range && !range.collapsed) document.execCommand('createLink', false, u);
    else document.execCommand('insertHTML', false,
      `<a href="${u.replace(/"/g,'&quot;')}">${u.replace(/</g,'&lt;')}</a>`);
  },
  task:    (ed)=>{
    /* A tick-box is a list item we mark; Coda renders `- [ ]` as a real checkbox and keeps
       its ticked state. `execCommand` has no notion of one, so the marking is ours — and it
       toggles, like everything else here. */
    let li=blockAt(ed);
    if(!li || li.nodeName!=='LI'){ document.execCommand('insertUnorderedList'); li=blockAt(ed); }
    if(li && li.nodeName==='LI'){
      const box=li.querySelector(':scope > .tick');
      if(li.hasAttribute('data-task')){ li.removeAttribute('data-task'); if(box) box.remove(); }
      else {
        li.setAttribute('data-task',' ');
        if(!box){
          const b=document.createElement('span');
          b.className='tick'; b.contentEditable='false'; b.setAttribute('role','checkbox');
          b.setAttribute('aria-checked','false'); b.tabIndex=0; b.setAttribute('aria-label','Done');
          li.insertBefore(b, li.firstChild);
        }
      }
    }
  },
};

/* An edit the browser did not announce (a tick, a link change): tell the field it changed. */
function notify(editor){ editor.dispatchEvent(new Event('input', {bubbles:true})); }

function runCmd(editor, name){
  const fn=RICH_CMD[name];
  if(!fn) return;
  return Promise.resolve(fn(editor)).then(()=>{ notify(editor); syncPressed(editor); });
}

/* The supported subset's toolbar, exactly, in its groups (HANDOVER "Rich text"): headings |
   inline | link | lists | quote. `fold` groups move into the More menu at 470px or less.
   [cmd, text-or-icon, accessible name, words in the More menu] */
const RICH_GROUPS = [
  { fold: false, buttons: [["h1", "H1", "Heading 1"], ["h2", "H2", "Heading 2"], ["h3", "H3", "Heading 3"]] },
  { fold: false, buttons: [["bold", "B", "Bold"], ["italic", "I", "Italic"], ["strike", "S", "Strikethrough"]] },
  { fold: true, buttons: [["link", { icon: "link" }, "Link", "Link"]] },
  { fold: true, buttons: [["ul", { icon: "bullets" }, "Bulleted list", "Bulleted list"], ["ol", { icon: "numbers" }, "Numbered list", "Numbered list"], ["task", { icon: "checklist" }, "Checklist", "Checklist"]] },
  { fold: true, buttons: [["quote", { icon: "quote" }, "Quote", "Quote"]] },
];
export const TOOLBAR_COMMANDS = RICH_GROUPS.flatMap((g) => g.buttons.map((b) => b[0]));
const PRESSABLE = new Set(["h1", "h2", "h3", "bold", "italic", "strike", "quote"]);

/* aria-pressed on the toolbar follows the caret. */
function syncPressed(editor){
  const host=editor && editor.closest('tfs-rich-text'); if(!host) return;
  const blk=blockAt(editor); const tag=blk ? blk.nodeName : '';
  const state={
    bold: ()=>document.queryCommandState('bold'), italic: ()=>document.queryCommandState('italic'),
    strike: ()=>document.queryCommandState('strikeThrough'),
    h1: ()=>tag==='H1', h2: ()=>tag==='H2', h3: ()=>tag==='H3',
    quote: ()=>!!(blk && (tag==='BLOCKQUOTE' || blk.closest('blockquote'))),
  };
  host.querySelectorAll('.tfs-rt__bar [data-cmd]').forEach(b=>{
    if(!PRESSABLE.has(b.dataset.cmd)) return;
    let on=false; try { on=!!state[b.dataset.cmd](); } catch { on=false; }
    b.setAttribute('aria-pressed', String(on));
  });
}

/* A LINK YOU CAN CHECK AND CHANGE (ported): Open, Edit, Remove. */
function closeLinkBar(){ document.querySelectorAll('.tfs-linkbar').forEach(b=>b.remove()); }

function linkAtCaret(){
  const sel=window.getSelection();
  let n=sel && sel.anchorNode;
  while(n && n.nodeName!=='A' && !(n.dataset && n.dataset.rich)) n=n.parentNode;
  return (n && n.nodeName==='A' && n.closest('tfs-rich-text')) ? n : null;
}

/** "https://drive.example/folders/abc/" -> "drive.example/folders/abc" (shortened to 40). */
export function shortUrl(href){
  const s=String(href||'').replace(/^https?:\/\//i,'').replace(/^mailto:/i,'').replace(/\/$/,'');
  return s.length>40 ? s.slice(0,39)+'…' : s;
}

function showLinkBar(a, { hover = false } = {}){
  const existing=document.querySelector('.tfs-linkbar');
  if(existing && existing._anchor===a){ if(!hover) existing._hover=false; return; }
  closeLinkBar();
  const ed=a.closest('[data-rich]'); if(!ed) return;
  const host=ed.closest('tfs-rich-text'); if(!host) return;
  const href=a.getAttribute('href')||'';
  const ok=allowedLinkHref(href);
  const bar=h('div',{class:'tfs-linkbar', role:'toolbar', 'aria-label':'Link'});
  /* A disallowed address is shown as TEXT, never as a link, and offers no Open. */
  if(ok){
    bar.append(h('span',{class:'tfs-linkbar__url', title:href, text:shortUrl(href)}),
      h('a',{href, target:'_blank', rel:'noopener', 'data-link':'open', text:'Open'}));
  } else {
    bar.append(h('span',{class:'tfs-linkbar__bad', text:href}));
  }
  bar.append(h('button',{type:'button','data-link':'edit',text:'Edit'}),
             h('button',{type:'button','data-link':'remove',text:'Remove'}));
  bar._anchor=a; bar._hover=hover;
  host.appendChild(bar);
  /* Above the link, inside the editor box; below it when there is no room above. */
  const hr=host.getBoundingClientRect(), r=a.getBoundingClientRect();
  let top=r.top-hr.top-bar.offsetHeight-6;
  if(top<0) top=r.bottom-hr.top+6;
  const left=Math.max(0, Math.min(r.left-hr.left, hr.width-bar.offsetWidth));
  bar.style.top=top+'px';
  bar.style.left=left+'px';
}

function linkAction(bar, act){
  const a=bar._anchor; const ed=a && a.closest('[data-rich]');
  closeLinkBar();
  const host=ed && ed.closest('tfs-rich-text');
  if(host && host.disabled && act!=='open') return;
  /* Open changes nothing, so it does not count as an edit. */
  if(act==='open'){
    const href=allowedLinkHref(a.getAttribute('href'));
    if(href) window.open(href,'_blank','noopener');
    return;
  }
  if(act==='edit'){
    const before=a.getAttribute('href')||'';
    askUrl(ed, before||'https://').then(raw=>{
      const u=allowedLinkHref(raw);
      /* Only a NEW address is an edit; Cancel, or the same address, changes nothing. */
      if(u && u!==before){ a.setAttribute('href',u); if(ed) notify(ed); }
    });
    return;
  }
  if(act==='remove'){
    const t=document.createTextNode(a.textContent||''); a.replaceWith(t);
  }
  if(ed) notify(ed);
}

/* A TICK-BOX YOU CAN TICK (ported). */
function toggleTick(box){
  const host=box.closest('tfs-rich-text'); if(host && host.disabled) return;
  const li=box.closest('li'); if(!li) return;
  const on=li.getAttribute('data-task')==='x';
  li.setAttribute('data-task', on?' ':'x');
  box.setAttribute('aria-checked', String(!on));
  box.textContent = on ? '' : '✓';
  const ed=box.closest('[data-rich]');
  if(ed) notify(ed);
}

/* The editor an event is in. A selection drag's target is a TEXT node (no `closest`), so a
   text node is read as its parent element. */
const richOf = (e) => {
  const t = e.target && e.target.nodeType === 3 ? e.target.parentElement : e.target;
  return t && t.closest ? t.closest('tfs-rich-text [data-rich]') : null;
};

let listening = false;
function listenOnce(){
  if(listening || typeof document === 'undefined') return;
  listening = true;

  /* The toolbar: mousedown with preventDefault, NEVER click — clicking a toolbar button moves
     focus out of the text first, and a command with no selection does nothing at all. */
  document.addEventListener('mousedown',e=>{
    const b=e.target.closest && e.target.closest('tfs-rich-text .tfs-rt__bar [data-cmd]');
    if(!b) return;
    e.preventDefault();
    if(b.closest('tfs-rich-text').disabled) return;
    const editor=b.closest('tfs-rich-text').querySelector('[data-rich]');
    if(editor) runCmd(editor, b.dataset.cmd);
  });
  /* A keyboard user presses the toolbar button with Enter/Space: same command. */
  document.addEventListener('click',e=>{
    const b=e.target.closest && e.target.closest('tfs-rich-text .tfs-rt__bar [data-cmd]');
    if(!b || e.detail!==0) return;          // a mouse click already ran on mousedown
    if(b.closest('tfs-rich-text').disabled) return;
    const editor=b.closest('tfs-rich-text').querySelector('[data-rich]');
    if(editor) runCmd(editor, b.dataset.cmd);
  });

  document.addEventListener('mousedown',e=>{
    const b=e.target.closest && e.target.closest('.tfs-linkbar');
    if(b){
      const act=e.target.closest('[data-link]');
      if(!act) return;
      e.preventDefault();
      linkAction(b, act.dataset.link);
      return;
    }
    if(!richOf(e)) closeLinkBar();
  });
  /* The link bar's own click: a mouse already acted on mousedown (and an <a> must not also
     navigate); a keyboard press (detail 0) acts here. */
  document.addEventListener('click',e=>{
    const act=e.target.closest && e.target.closest('.tfs-linkbar [data-link]');
    if(act){
      e.preventDefault();
      if(e.detail===0) linkAction(act.closest('.tfs-linkbar'), act.dataset.link);
      return;
    }
    const a=e.target.closest && e.target.closest('tfs-rich-text [data-rich] a');
    if(a) showLinkBar(a);
  });
  document.addEventListener('keyup',e=>{
    if(e.target && e.target.closest && e.target.closest('.tfs-linkbar')) return;
    const a=linkAtCaret();
    if(a) showLinkBar(a); else closeLinkBar();
  });
  /* Hovering a link shows its bar too; it goes again when the pointer leaves both. */
  let hoverTimer=null;
  document.addEventListener('mouseover',e=>{
    const t=e.target;
    if(!t || !t.closest) return;
    if(t.closest('.tfs-linkbar')){ clearTimeout(hoverTimer); return; }
    const a=t.closest('tfs-rich-text [data-rich] a');
    if(a){ clearTimeout(hoverTimer); showLinkBar(a, { hover: true }); }
  });
  document.addEventListener('mouseout',e=>{
    const bar=document.querySelector('.tfs-linkbar');
    if(!bar || !bar._hover) return;
    const to=e.relatedTarget;
    if(to && to.closest && (to.closest('.tfs-linkbar') || to.closest('a')===bar._anchor)) return;
    clearTimeout(hoverTimer);
    hoverTimer=setTimeout(()=>{ const b=document.querySelector('.tfs-linkbar'); if(b && b._hover) b.remove(); }, 300);
  });

  document.addEventListener('mousedown',e=>{
    const box=e.target.closest && e.target.closest('tfs-rich-text .tick');
    if(!box) return;
    e.preventDefault();   /* do not put the caret inside the box */
    toggleTick(box);
  });
  /* TAB NESTS A BULLET, SHIFT-TAB LIFTS IT — only inside a list item, so a keyboard user is
     never trapped in a text box. */
  document.addEventListener('keydown',e=>{
    if(e.key!=='Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
    const ed=richOf(e);
    if(!ed) return;
    const sel=window.getSelection(); if(!sel || !sel.rangeCount) return;
    let n=sel.anchorNode;
    while(n && n!==ed && n.nodeName!=='LI') n=n.parentNode;
    if(!n || n===ed) return;
    e.preventDefault();
    document.execCommand(e.shiftKey ? 'outdent' : 'indent');
  });
  document.addEventListener('keydown',e=>{
    if(e.key!==' ' && e.key!=='Enter') return;
    const box=e.target.closest && e.target.closest('tfs-rich-text .tick');
    if(!box) return;
    e.preventDefault();
    toggleTick(box);
  });
  document.addEventListener('selectionchange',()=>{
    const s=window.getSelection();
    const n=s && s.anchorNode;
    const el=n && (n.nodeType===3 ? n.parentElement : n);
    const ed=el && el.closest ? el.closest('tfs-rich-text [data-rich]') : null;
    if(ed) syncPressed(ed);
  });
  /* ⛔ PASTE ARRIVES AS PLAIN TEXT, ALWAYS. Nothing appears that will not survive. A link
     pasted over selected words makes them the link, as in Slack and Coda. */
  document.addEventListener('paste',e=>{
    const n=richOf(e);
    if(!n) return;
    e.preventDefault();
    if(n.getAttribute('contenteditable')==='false') return;
    const text=((e.clipboardData||window.clipboardData).getData('text/plain')||'').trim();
    const sel=window.getSelection();
    if(sel && !sel.isCollapsed && /^https?:\/\/\S+$/i.test(text)){
      document.execCommand('createLink', false, text);
    } else {
      document.execCommand('insertText', false, text);
    }
    notify(n);
  });
  /* ⛔ A DROP IS A PASTE BY OTHER MEANS. Without this, dragging rich content in from another
     page inserted its HTML (tables, colours, images), which `htmlToMd` then dropped silently.
     Same rule as paste: the text only, at the point it was dropped. */
  /* A drag that STARTS in this editor and lands in it is a move of its own (already in-subset)
     text: the browser's move is kept (and announces itself). Everything else is a paste. */
  let dragFrom=null;
  document.addEventListener('dragstart',e=>{ dragFrom=richOf(e)||null; });
  document.addEventListener('dragend',()=>{ dragFrom=null; });
  document.addEventListener('drop',e=>{
    const n=richOf(e);
    if(!n) return;
    if(dragFrom===n && n.getAttribute('contenteditable')!=='false'){ dragFrom=null; return; }
    e.preventDefault();
    if(n.getAttribute('contenteditable')==='false') return;
    const text=((e.dataTransfer && e.dataTransfer.getData('text/plain'))||'').trim();
    if(!text) return;
    const r=document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
    if(r){ const sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(r); }
    n.focus();
    document.execCommand('insertText', false, text);
    notify(n);
  });
}

export class TfsRichText extends Base {
  constructor() { super(); this._md = null; this._touched = false; this._built = false; }

  _build() {
    if (this._built) return;
    this._built = true;
    listenOnce();
    this.classList.add("tfs-rt");
    const bar = h("div", { class: "tfs-rt__bar", role: "toolbar", "aria-label": "Formatting" });
    const folded = [];
    RICH_GROUPS.forEach((g, i) => {
      if (i) bar.append(h("span", { class: g.fold ? "tfs-rt__sep tfs-rt__sep--overflow" : "tfs-rt__sep", "aria-hidden": "true" }));
      const grp = h("div", { class: g.fold ? "tfs-rt__grp tfs-rt__grp--overflow" : "tfs-rt__grp" });
      for (const [cmd, face, name, words] of g.buttons) {
        const b = h("button", { type: "button", "data-cmd": cmd, "aria-label": name, title: name,
          "aria-pressed": PRESSABLE.has(cmd) ? "false" : null });
        if (typeof face === "string") b.textContent = face; else b.append(icon(face.icon));
        grp.append(b);
        if (g.fold) folded.push([cmd, face.icon, words]);
      }
      bar.append(grp);
    });
    const menuId = nextId("tfs-rtm");
    this._more = h("button", { type: "button", class: "tfs-rt__more", "aria-label": "More formatting", title: "More formatting",
      "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": menuId }, icon("more"));
    bar.append(this._more);
    this._menu = h("div", { class: "tfs-menu", role: "menu", "aria-label": "More formatting", id: menuId, hidden: true },
      ...folded.map(([cmd, ic, words]) => h("button", { type: "button", class: "tfs-menu__item", role: "menuitem",
        tabindex: "-1", "data-menu-cmd": cmd }, icon(ic), words)));
    this._wireMore();
    this._ask = h("div", { class: "tfs-rt__ask", hidden: true });
    this._area = h("div", { class: "tfs-rt__area", contenteditable: "true", role: "textbox",
      "aria-multiline": "true", "data-rich": "1", "data-placeholder": this.getAttribute("placeholder") || "Write here…" });
    if (this.id) { this._area.id = `${this.id}-area`; }
    const lab = this.getAttribute("aria-label");
    if (lab) this._area.setAttribute("aria-label", lab);
    const by = this.getAttribute("labelledby");
    if (by) this._area.setAttribute("aria-labelledby", by);
    this._area.addEventListener("input", () => { this._touched = true; });
    // Enter makes a <p>, not a <div>: a paragraph is what `htmlToMd` reads as one. An empty
    // field gets its `<p><br></p>` back while it has focus (see `_fill`).
    this._area.addEventListener("focus", () => {
      try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch { /* old browser */ }
      if (!this._area.firstChild && this._area.getAttribute("contenteditable") === "true") {
        this._area.innerHTML = "<p><br></p>";
        const s = window.getSelection(); const r = document.createRange();
        r.setStart(this._area.firstChild, 0); r.collapse(true); s.removeAllRanges(); s.addRange(r);
      }
    });
    this._area.addEventListener("blur", () => this._emptyIfBlank());
    this._fill();
    this.append(bar, this._menu, this._ask, this._area);
    // The fold is kit.css's container query; a menu left open as the editor widens past it
    // would hang under a More button that has gone, so it closes.
    if (globalThis.ResizeObserver) {
      this._ro = new ResizeObserver(() => {
        const narrow = this.getBoundingClientRect().width <= 470;
        this.toggleAttribute("data-narrow", narrow);
        if (!narrow) this._closeMenu(false);
      });
      this._ro.observe(this);
    }
  }

  _wireMore() {
    const items = () => [...this._menu.querySelectorAll("[data-menu-cmd]")];
    this._more.addEventListener("mousedown", (e) => e.preventDefault());   // keep the selection
    this._more.addEventListener("click", () => {
      if (this.disabled) return;
      if (!this._menu.hidden) { this._closeMenu(true); return; }
      this._menuRange = saveRange();
      this._menu.hidden = false;
      this._more.setAttribute("aria-expanded", "true");
      this._more.setAttribute("aria-pressed", "true");
      items()[0].focus();
      this._menuOutside = (e) => { if (!this._menu.contains(e.target) && e.target !== this._more && !this._more.contains(e.target)) this._closeMenu(false); };
      document.addEventListener("mousedown", this._menuOutside, true);
    });
    this._menu.addEventListener("mousedown", (e) => { if (e.target.closest("[data-menu-cmd]")) e.preventDefault(); });
    this._menu.addEventListener("click", (e) => {
      const b = e.target.closest("[data-menu-cmd]");
      if (!b) return;
      const range = this._menuRange;
      this._closeMenu(false);
      restoreRange(this._area, range);
      runCmd(this._area, b.dataset.menuCmd);
    });
    this._menu.addEventListener("keydown", (e) => {
      const list = items();
      const i = list.indexOf(document.activeElement);
      const r = menuNav(i, list.length, e.key);
      if (r.action === "close") { e.preventDefault(); this._closeMenu(true); return; }
      if (r.action === "tab") { this._closeMenu(false); return; }
      if (r.action === "pick") return;   // the button's own Enter/Space click runs it
      if (r.active !== i && r.active >= 0) { e.preventDefault(); list[r.active].focus(); }
    });
  }

  _closeMenu(focusMore) {
    if (!this._menu || this._menu.hidden) return;
    this._menu.hidden = true;
    this._more.setAttribute("aria-expanded", "false");
    this._more.setAttribute("aria-pressed", "false");
    if (this._menuOutside) document.removeEventListener("mousedown", this._menuOutside, true);
    if (focusMore) this._more.focus();
  }

  /* A blank field is left truly EMPTY when it has no focus, so its placeholder shows (kit.css
     draws it on `:empty`). Not while the link field or the More menu holds focus: the command
     would land in a paragraph that had gone. */
  _emptyIfBlank() {
    if (this._asking || (this._menu && !this._menu.hidden)) return;
    const a = this._area;
    if (a.textContent.trim() === "" && !a.querySelector("li,blockquote,h1,h2,h3,a,.tick") && htmlToMd(a) === "") a.innerHTML = "";
  }

  /* ⛔ AN EMPTY FIELD BEING TYPED IN IS `<p><br></p>`, NOT `<p></p>` OR NOTHING. An empty
     paragraph has no height, so a click puts the caret in the editor ROOT, and text typed there
     is a bare text node. Bold applied to it is then a top-level <b>, which `htmlToMd` reads as a
     paragraph of its TEXT: the bold is silently lost (measured in a real browser, 2026-10-02).
     So an empty field is left with no children (its placeholder shows) and gets `<p><br></p>`
     the moment it takes focus, caret inside. Element-level only; the converter is untouched. */
  _fill() {
    const html = mdToHtml(this._md || "");
    this._area.innerHTML = html === "<p></p>" ? "" : html;
    this._baseline = htmlToMd(this._area);   // what "no edit" serialises to (richTextValue)
  }

  /** While a save is in flight the text cannot change: what is on screen is what was sent. */
  get disabled() { return !!this._disabled; }
  set disabled(v) {
    this._disabled = !!v;
    this._build();
    this._area.setAttribute("contenteditable", v ? "false" : "true");
    this.classList.toggle("tfs-rt--disabled", !!v);
    this._area.setAttribute("aria-disabled", v ? "true" : "false");
    if (v) this._closeMenu(false);
  }

  connectedCallback() { this._build(); }

  /** The markdown. Untouched → the original string, byte for byte. */
  get value() { return richTextValue(this._md, this._touched, () => htmlToMd(this._area), this._baseline); }
  set value(md) {
    this._md = md == null ? null : String(md);
    this._touched = false;
    if (this._built) this._fill();
  }
  get editor() { this._build(); return this._area; }
  focus() { this._build(); this._area.focus(); }

  /* The inline link field: resolves the address, or null on Cancel / Escape / empty. */
  _askUrl(initial) {
    this._build();
    this._asking = true;
    return new Promise((resolve) => {
      const id = nextId("tfs-lk");
      const input = h("input", { type: "url", class: "tfs-input", id, inputmode: "url" });
      input.value = initial || "https://";
      const err = h("p", { class: "tfs-rt__askerr", id: `${id}-e`, role: "alert", hidden: true });
      const done = (v) => { this._asking = false; this._ask.hidden = true; this._ask.replaceChildren(); resolve(v); };
      const ok = h("button", { type: "button", class: "tfs-btn tfs-btn--small tfs-btn--primary", "data-ask": "add", text: "Add",
        onclick: () => {
          const v = input.value.trim();
          if (!v || v === "https://") return done(null);
          // A refused address keeps the field open with the reason, so the person can fix it.
          if (!allowedLinkHref(v)) {
            err.replaceChildren(icon("fieldError"), LINK_REFUSED); err.hidden = false;
            input.setAttribute("aria-invalid", "true"); input.setAttribute("aria-describedby", err.id);
            input.focus(); return;
          }
          done(v);
        } });
      const no = h("button", { type: "button", class: "tfs-btn tfs-btn--small", "data-ask": "cancel", text: "Cancel", onclick: () => done(null) });
      input.addEventListener("input", () => { if (!err.hidden) { err.hidden = true; input.removeAttribute("aria-invalid"); } });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); ok.click(); }
        if (e.key === "Escape") { e.preventDefault(); done(null); }
      });
      this._ask.replaceChildren(h("label", { class: "tfs-sr", for: id, text: "Link address" }), input, ok, no, err);
      this._ask.hidden = false;
      input.focus(); input.select();
    });
  }
}

/* ===========================================================================
   <tfs-picker> — a linked-record field. The value is the row id, never the typed text.
   Chosen values are chips in one field-shaped box with the search input (HANDOVER "Picker").
   ========================================================================= */

const PICK_NOUN = { team_member: "team member", project: "project", contact: "contact", organization: "organisation", task: "task" };

export function noMatchText(entityType, q) {
  if (entityType === "team_member") return `No current team member matches '${q}'. Only current core-team members can be picked.`;
  return `No ${PICK_NOUN[entityType] || "record"} matches '${q}'.`;
}

export class TfsPicker extends Base {
  constructor() {
    super();
    this._items = []; this._locked = new Set(); this._built = false; this._seq = 0;
    this._timer = null; this._options = []; this._active = -1;
  }

  get transport() { return transportOf(this); }
  set transport(t) { this._transport = t; }
  get multi() { return this.hasAttribute("multi"); }
  get addOnly() { return this.hasAttribute("add-only"); }
  get people() { return this.getAttribute("entity-type") === "team_member"; }

  /** `[{row_id, label}]` currently chosen. */
  get items() { return this._items.slice(); }
  /** Wire value: a row id (single) or a list of row ids (multi). */
  get value() { return this.multi ? this._items.map((i) => i.row_id) : (this._items[0] ? this._items[0].row_id : null); }
  /** Accepts `{row_id,label}`, a row id, or a list of either. Items set here are the record's
   * EXISTING ones: with `add-only`, they cannot be removed. */
  set value(v) {
    const list = Array.isArray(v) ? v : (v == null || v === "" ? [] : [v]);
    this._items = list.map((i) => (typeof i === "string" ? { row_id: i, label: null } : { row_id: i.row_id, label: i.label })).filter((i) => i.row_id);
    if (!this.multi) this._items = this._items.slice(0, 1);
    this._locked = this.addOnly ? new Set(this._items.map((i) => i.row_id)) : new Set();
    if (this._built) this._render();
  }

  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this.classList.add("tfs-picker");
    const lid = nextId("tfs-pk");
    this._box = h("div", { class: "tfs-picker__box" });
    this._box.addEventListener("mousedown", (e) => { if (e.target === this._box) { e.preventDefault(); this._input.focus(); } });
    this._input = h("input", { class: "tfs-picker__input", type: "text", role: "combobox", autocomplete: "off",
      "aria-expanded": "false", "aria-autocomplete": "list", "aria-controls": lid });
    if (this.getAttribute("input-id")) this._input.id = this.getAttribute("input-id");
    if (this.getAttribute("aria-describedby")) this._input.setAttribute("aria-describedby", this.getAttribute("aria-describedby"));
    this._list = h("ul", { class: "tfs-picker__list", role: "listbox", id: lid, hidden: true,
      "aria-label": this.people ? "People" : "Matches" });
    this._msg = h("div", { class: "tfs-picker__list", hidden: true });
    this._input.addEventListener("input", () => this._schedule());
    this._input.addEventListener("focus", () => this._schedule());
    this._input.addEventListener("keydown", (e) => this._key(e));
    this._input.addEventListener("blur", () => setTimeout(() => {
      if (this.contains(document.activeElement)) return;
      this._close();
      this._input.value = "";       // typed text is never the value
    }, 150));
    this._box.append(this._input);
    this.append(this._box, this._list, this._msg);
    this._render();
  }

  _chip(it) {
    const name = it.label || it.row_id;
    const chip = h("span", { class: this.people ? "tfs-chip tfs-chip--person" : "tfs-chip" });
    if (this.people) chip.append(h("span", { class: "tfs-avatar", "aria-hidden": "true", text: initials(name) }));
    chip.append(h("span", { text: name }));
    if (!this._locked.has(it.row_id)) {
      chip.append(h("button", { type: "button", class: "tfs-chip__x", "aria-label": `Remove ${name}`,
        onclick: () => { if (lockedByFieldset(this)) return; this._items = this._items.filter((x) => x.row_id !== it.row_id); this._render(); this._changed(); this._input.focus(); } },
        icon("close")));
    }
    return chip;
  }

  _render() {
    this._box.replaceChildren(...this._items.map((it) => this._chip(it)), this._input);
    const noun = PICK_NOUN[this.getAttribute("entity-type")];
    const base = this.getAttribute("placeholder") || (this.people ? (this.multi ? "Add a person" : "Search people")
      : noun ? (this.multi ? `Add a ${noun}` : `Search ${noun}s`) : "Type to search");
    this._input.placeholder = !this.multi && this._items.length ? "Search to change" : base;
  }

  _changed() {
    this.dispatchEvent(new Event("input", { bubbles: true }));
    this.dispatchEvent(new Event("change", { bubbles: true }));
  }

  _schedule() {
    if (lockedByFieldset(this)) { clearTimeout(this._timer); return; }
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._search(), 250);
  }

  async _search() {
    const seq = ++this._seq;
    const q = this._input.value.trim();
    this._query = q;
    this._showMsg(h("p", { class: "tfs-picker__msg", role: "status" }, spinner(), "Searching…"));
    let opts;
    try {
      const r = await this.transport.call("search_records_for_picker",
        { entity_type: this.getAttribute("entity-type"), query: q, limit: 20 });
      opts = (r && r.options) || [];
    } catch (e) {
      if (seq !== this._seq) return;
      const box = h("div", { role: "alert" },
        h("p", { class: "tfs-picker__msg tfs-picker__msg--error", text: "Couldn't search just now." }),
        h("div", { style: "padding:0 10px 8px" }, h("button", { type: "button", class: "tfs-btn tfs-btn--small", text: "Try again",
          onmousedown: (ev) => ev.preventDefault(), onclick: () => { this._input.focus(); this._search(); } })));
      this._showMsg(box);
      return;
    }
    if (seq !== this._seq) return;               // a newer search is under way
    const chosen = new Set(this._items.map((i) => i.row_id));
    this._options = opts.filter((o) => o && o.row_id && !(this.multi && chosen.has(o.row_id)));
    this._active = this._options.length ? 0 : -1;
    if (this.getAttribute("entity-type") === "project") this._loadHintColours();
    this._drawOptions();
  }

  /* A project's hint is its status: drawn as a small chip in Coda's colour, from the served
     project status options (never from the name). Best effort: no colours, a neutral chip. */
  _loadHintColours() {
    if (this._hintColours) return;
    loadStatusOptions(this.transport, "projects").then((opts) => {
      this._hintColours = new Map(opts.map((o) => [o.value, o.color]));
      if (!this._list.hidden) this._drawOptions();
    }).catch(() => {});
  }

  _showMsg(node) {
    this._msg.replaceChildren(node);
    this._msg.hidden = false; this._list.hidden = true;
    if (lockedByFieldset(this)) { this._msg.hidden = true; return; }
    this._input.setAttribute("aria-expanded", "true");
    this._input.removeAttribute("aria-activedescendant");
  }

  _drawOptions() {
    if (!this._options.length) {
      return this._showMsg(h("p", { class: "tfs-picker__msg", role: "status",
        text: this._query ? noMatchText(this.getAttribute("entity-type"), this._query) : "Nothing to pick here yet." }));
    }
    const project = this.getAttribute("entity-type") === "project";
    this._list.replaceChildren(...this._options.map((o, i) => {
      const name = o.label || o.row_id;
      const [a, m, b] = markMatch(name, this._query);
      const li = h("li", { role: "option", id: `${this._list.id}-${i}`, class: "tfs-picker__opt", "aria-selected": String(i === this._active) },
        this.people ? h("span", { class: "tfs-avatar", "aria-hidden": "true", text: initials(name) }) : null,
        h("span", { class: "tfs-picker__name" }, a, m ? h("mark", { text: m }) : null, b),
        // People get no hint (the server sends none: no job titles in the picker).
        o.hint && !this.people ? h("span", { class: "tfs-picker__hint" },
          project ? statusChip(String(o.hint), this._hintColours && this._hintColours.get(String(o.hint)), { small: true }) : String(o.hint)) : null);
      li.addEventListener("mousedown", (e) => { e.preventDefault(); this._pick(o); });
      return li;
    }));
    this._input.setAttribute("aria-activedescendant", this._active >= 0 ? `${this._list.id}-${this._active}` : "");
    this._open();
    const act = this._list.children[this._active];
    if (act && act.scrollIntoView) act.scrollIntoView({ block: "nearest" });
  }

  _open() {
    if (lockedByFieldset(this)) return;
    this._msg.hidden = true; this._list.hidden = false;
    this._input.setAttribute("aria-expanded", "true");
  }
  _close() {
    this._list.hidden = true; this._msg.hidden = true;
    this._input.setAttribute("aria-expanded", "false"); this._input.removeAttribute("aria-activedescendant");
  }
  get _openNow() { return !this._list.hidden || !this._msg.hidden; }

  _pick(o) {
    if (lockedByFieldset(this)) { this._close(); return; }
    const item = { row_id: o.row_id, label: o.label || null };
    this._input.value = "";
    if (this.multi) {
      if (!this._items.some((x) => x.row_id === item.row_id)) this._items.push(item);
      this._render(); this._changed();
      this._search();                 // the list stays open, without what was just picked
    } else {
      if (this._locked.size) { this._close(); return; }
      this._items = [item];
      this._close(); this._render(); this._changed();
    }
  }

  _key(e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (this._list.hidden) { if (this._msg.hidden) this._schedule(); return; }
      e.preventDefault();
      if (!this._options.length) return;
      const d = e.key === "ArrowDown" ? 1 : -1;
      this._active = (this._active + d + this._options.length) % this._options.length;
      this._drawOptions();
    } else if (e.key === "Enter") {
      e.preventDefault();   // Enter picks; it never submits the surrounding form with half a name typed
      if (!this._list.hidden && this._active >= 0 && this._options[this._active]) this._pick(this._options[this._active]);
    } else if (e.key === "Escape") {
      if (this._openNow) { e.preventDefault(); e.stopPropagation(); this._close(); }
    } else if (e.key === "Backspace" && !this._input.value && this._items.length) {
      const last = this._items[this._items.length - 1];
      if (!this._locked.has(last.row_id) && !lockedByFieldset(this)) { this._items.pop(); this._render(); this._changed(); }
    }
  }
}

/* A multi-value dropdown (fixed options; the server has no search for these): the picker's
   look — chips in the box, a filter input, a list of options with tick boxes. `add_only` keeps
   the record's existing values. Returns `{el, get}`. */
function multiSelect(f, id, start) {
  let vals = (start || []).slice();
  const locked = new Set(f.add_only ? vals : []);
  const all = optionsWithCurrent(f.options, vals);
  const lid = `${id}-list`;
  const wrap = h("div", { class: "tfs-picker" });
  const box = h("div", { class: "tfs-picker__box" });
  const input = h("input", { class: "tfs-picker__input", id, type: "text", role: "combobox", autocomplete: "off",
    "aria-expanded": "false", "aria-autocomplete": "list", "aria-controls": lid, placeholder: "Filter" });
  const list = h("ul", { class: "tfs-picker__list", role: "listbox", id: lid, hidden: true, "aria-multiselectable": "true", "aria-label": f.label || f.name });
  let active = -1; let shown = [];
  const labelOf = (v) => { const o = all.find((x) => x.value === v); return o ? o.label : v; };
  const changed = () => input.dispatchEvent(new Event("input", { bubbles: true }));
  const chips = () => {
    box.replaceChildren(...vals.map((v) => {
      const chip = h("span", { class: "tfs-chip" }, h("span", { text: labelOf(v) }));
      if (!locked.has(v)) chip.append(h("button", { type: "button", class: "tfs-chip__x", "aria-label": `Remove ${labelOf(v)}`,
        onclick: () => { if (lockedByFieldset(wrap)) return; vals = vals.filter((x) => x !== v); chips(); draw(); changed(); input.focus(); } }, icon("close")));
      return chip;
    }), input);
  };
  const toggle = (v) => {
    if (lockedByFieldset(wrap)) return;
    if (vals.includes(v)) { if (locked.has(v)) return; vals = vals.filter((x) => x !== v); }
    else vals.push(v);
    chips(); draw(); changed(); input.focus();
  };
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    shown = all.filter((o) => !q || String(o.label).toLowerCase().includes(q));
    if (active >= shown.length) active = shown.length - 1;
    list.replaceChildren(...shown.map((o, i) => {
      const chosen = vals.includes(o.value);
      const li = h("li", { class: chosen ? "tfs-picker__opt tfs-picker__opt--chosen" : "tfs-picker__opt", role: "option",
        id: `${lid}-${i}`, "aria-selected": String(i === active), "aria-checked": String(chosen) },
        h("span", { class: "tfs-picker__tick", "aria-hidden": "true" }, icon("tick")),
        h("span", { class: "tfs-picker__name", text: o.label }));
      li.addEventListener("mousedown", (e) => { e.preventDefault(); toggle(o.value); });
      return li;
    }));
    if (active >= 0) input.setAttribute("aria-activedescendant", `${lid}-${active}`); else input.removeAttribute("aria-activedescendant");
  };
  const open = () => { if (lockedByFieldset(wrap)) return; draw(); list.hidden = false; input.setAttribute("aria-expanded", "true"); };
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); };
  input.addEventListener("focus", open);
  input.addEventListener("input", (e) => { if (e.isTrusted !== false && e.target === input && input.value !== undefined) { active = 0; open(); } });
  input.addEventListener("blur", () => setTimeout(() => { if (!wrap.contains(document.activeElement)) { close(); input.value = ""; } }, 150));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); if (list.hidden) { open(); return; }
      if (!shown.length) return;
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length; draw();
    } else if (e.key === "Enter") {
      e.preventDefault(); if (!list.hidden && shown[active]) toggle(shown[active].value);
    } else if (e.key === "Escape") {
      if (!list.hidden) { e.preventDefault(); e.stopPropagation(); close(); }
    } else if (e.key === "Backspace" && !input.value && vals.length && !locked.has(vals[vals.length - 1])) {
      vals.pop(); chips(); draw(); changed();
    }
  });
  box.addEventListener("mousedown", (e) => { if (e.target === box) { e.preventDefault(); input.focus(); } });
  chips();
  wrap.append(box, list);
  return { el: wrap, input, get: () => vals.slice() };
}

/* ===========================================================================
   <tfs-record-form table mode row fields>
   ========================================================================= */

function displayText(field, v) {
  if (isBlank(v)) return "—";
  if (field.kind === "linked") return (Array.isArray(v) ? v : [v]).map((i) => (i && i.label) || (i && i.row_id) || String(i)).join(", ");
  if (field.kind === "checkbox") return v === true || v === "true" ? "Yes" : "No";
  return Array.isArray(v) ? v.join(", ") : String(v);
}

const SHORT_KINDS = new Set(["date", "number", "checkbox"]);
const isShort = (f) => SHORT_KINDS.has(f.kind) || (f.kind === "dropdown" && !f.multi);
/* Load failures a retry can help with: not a page that needs updating, nor one the
   organisation blocks. */
const NO_RETRY = new Set(["contract_mismatch", "not_in_manifest", "blocked_by_policy", "approval_required", "bad_payload"]);
const DIDNT_ANSWER = new Set(["server_unavailable", "upstream_error", "cancelled"]);

export class TfsRecordForm extends Base {
  static get observedAttributes() { return ["table", "mode", "row", "fields", "presets"]; }

  constructor() {
    super();
    this._seq = 0; this._started = false; this._presets = null;
    this.form = null; this.record = null; this.machine = null;
    this._controls = new Map(); this._initial = {}; this._hidden = {}; this._meta = new Map();
    this._ready = false; this._dismissed = new Set(); this._localErrors = null;
  }

  get transport() { return transportOf(this); }
  set transport(t) { this._transport = t; if (this._started) this.load(); }

  /** Values a page fixes for a new record (e.g. `{project: {row_id, label}}`). Only fields the
   * server serves are used; a preset field the page does not show is still sent. */
  get presets() {
    if (this._presets) return this._presets;
    try { return JSON.parse(this.getAttribute("presets") || "null") || {}; } catch { return {}; }
  }
  set presets(p) { this._presets = p || {}; if (this._started) this.load(); }

  connectedCallback() {
    if (this._started) return;
    this._started = true;
    queueMicrotask(() => this.load());   // after the page's `configure` (see `configure`)
  }
  attributeChangedCallback(_n, oldV, newV) { if (this._started && oldV !== newV) this.load(); }

  get table() { return this.getAttribute("table") || ""; }
  get mode() { return this.getAttribute("mode") || (this.getAttribute("row") ? "edit" : "create"); }
  get noun() { return nounOf(this.table); }

  /* The frame every state shares: head with ×, body, notice, footer with Close/Cancel + Save. */
  _frame() {
    const titleId = nextId("tfs-ft");
    const edit = this.mode === "edit";
    const label = this.record && this.record.label;
    const eyebrow = this.getAttribute("eyebrow") || cap(this.noun) + (edit && label ? ` · ${label}` : "");
    const title = this.getAttribute("heading") || (edit ? `Edit ${this.noun}` : `New ${this.noun}`);
    const x = h("button", { type: "button", class: "tfs-btn tfs-btn--quiet tfs-btn--icon", "aria-label": "Close", title: "Close" }, icon("close"));
    x.addEventListener("click", () => this._requestClose());
    this._bodyEl = h("div", { class: "tfs-form__body" });
    this._notice = h("div", { class: "tfs-form__notice", "aria-live": "polite" });
    this._statusEl = h("span", { class: "tfs-form__status", role: "status" });
    this._closeBtn = h("button", { type: "button", class: "tfs-btn", text: "Close" });
    this._closeBtn.addEventListener("click", () => {
      if (this._closeAction === "abort" && this.machine) this.machine.abort();
      else this._requestClose();
    });
    this._saveBtn = h("button", { type: "submit", class: "tfs-btn tfs-btn--primary" });
    this._formEl = h("form", { class: this.hasAttribute("bare") ? "tfs-form tfs-form--bare" : "tfs-form", novalidate: true, "aria-labelledby": titleId },
      h("div", { class: "tfs-form__head" },
        h("div", { class: "tfs-form__heading" },
          h("p", { class: "tfs-form__eyebrow", text: eyebrow }),
          h("p", { class: "tfs-form__title", id: titleId, role: "heading", "aria-level": "2", text: title })),
        x),
      this._bodyEl, this._notice,
      h("div", { class: "tfs-form__foot" }, this._statusEl, h("div", { class: "tfs-form__actions" }, this._closeBtn, this._saveBtn)));
    this._formEl.addEventListener("submit", (e) => {
      e.preventDefault();
      if (this.machine && this.machine.state === "confirm") this.machine.confirm(); else this.save();
    });
    this._formEl.addEventListener("input", (e) => this._onEdit(e));
    this._formEl.addEventListener("change", (e) => this._onEdit(e));
    this.replaceChildren(this._formEl);
  }

  /* A state with no fields (loading, failed, no connector). */
  _shell(phase, loadError = null) {
    this._ready = false;
    this._frame();
    this._formEl.toggleAttribute("aria-busy", phase === "loading");
    if (phase === "loading") {
      this._bodyEl.setAttribute("aria-hidden", "true");
      this._bodyEl.append(h("div", { class: "tfs-form__fields" },
        h("div", { class: "tfs-field" }, h("span", { class: "tfs-skel", style: "width:64px" }), h("span", { class: "tfs-skel tfs-skel--box" })),
        h("div", { class: "tfs-field" }, h("span", { class: "tfs-skel", style: "width:88px" }), h("span", { class: "tfs-skel tfs-skel--box", style: "height:110px" }))));
    } else {
      this._bodyEl.remove();
      this._notice.style.paddingTop = "10px";   // the reference's spacing when no body sits above
    }
    this._apply(formView({ phase, loadError, noun: this.noun }));
  }

  async load() {
    const seq = ++this._seq;
    const tr = this.transport;
    const table = this.table, mode = this.mode, row = this.getAttribute("row");
    this.record = null;
    this._shell("loading");
    let form, rec = null;
    const fail = (message, retry) => { if (seq === this._seq) this._shell("load_failed", { message, retry }); };
    try {
      form = await tr.call("describe_record_form", { table, mode });
      if (seq !== this._seq) return;
      if (form.refused) return fail(form.message || "This form isn't available.", form.refused === "options_unavailable");
      if (mode === "edit") {
        if (!row) return fail("This form needs a record to edit.", false);
        rec = await tr.call("get_record_for_editing", { table, row_id: row }, { fresh: true });
        if (seq !== this._seq) return;
        if (rec.refused) return fail(rec.message || "That record isn't available.", false);
      }
    } catch (e) {
      if (seq !== this._seq) return;
      if (e && e.code === "server_not_connected") return this._shell("no_connector");
      const code = e && e.code;
      return fail(DIDNT_ANSWER.has(code) ? "The TFS server didn't answer. Nothing has been changed."
        : `${(e && e.message) || "Something went wrong."} Nothing has been changed.`, !NO_RETRY.has(code));
    }
    this.form = form; this.record = rec;
    this.machine = new SaveMachine({ transport: tr, table, rowId: mode === "edit" ? row : null,
      rowVersion: rec ? rec.row_version : null, source: rec ? rec.source : null });
    this.machine.onChange((m) => this._onState(m));
    this._build();
    this.dispatchEvent(new CustomEvent("tfs-loaded", { bubbles: true, detail: { form, record: rec } }));
  }

  _servedByName() { return Object.fromEntries((this.form.fields || []).map((f) => [f.name, f])); }

  /** Initial wire values (the record's on edit; nothing on create) and the hidden values sent
   * for served fields the page does not show (presets on create; the record's on edit). */
  _build() {
    const form = this.form, rec = this.record, edit = !!rec;
    const served = form.fields || [];
    const attr = this.getAttribute("fields");
    const shown = selectFields(served, attr);
    const presets = this.presets || {};
    const byName = this._servedByName();
    this._initial = {};
    this._hidden = {};
    for (const f of served) {
      this._initial[f.name] = edit ? wireOf(f, (rec.values || {})[f.name]) : wireOf(f, null);
      if (!edit && f.name in presets && !shown.includes(f)) this._hidden[f.name] = wireOf(f, presets[f.name]);
    }
    this._frame();
    this._shown = shown;
    this._byName = byName;
    this._labels = Object.fromEntries(served.map((f) => [f.name, f.label || f.name]));
    this._dismissed = new Set(); this._localErrors = null;

    // ⛔ A <fieldset>, so ONE `disabled` locks every control while a save is in flight: an edit
    // made then is neither in the save nor safe after it (the redraw would drop it, or the
    // "Saved" line would claim it).
    const fieldsBox = h("fieldset", { class: "tfs-form__fields" });
    this._fieldset = fieldsBox;
    this._controls = new Map();
    this._checks = new Map();
    this._meta = new Map();
    if (!shown.length) fieldsBox.append(h("p", { class: "tfs-field__help", text: "This form has no fields to show." }));

    // A group is stated only when the page shows one of its members and no hidden preset
    // already answers it; otherwise the server's own refusal names it, which is clearer than
    // pointing at a field the person cannot see.
    const groups = groupLines((form.required_groups || []).filter((g) => Array.isArray(g)
      && g.some((n) => shown.some((f) => f.name === n))
      && !g.some((n) => n in this._hidden && !isBlank(this._hidden[n]))), served);
    for (const g of groups) fieldsBox.append(h("p", { class: "tfs-field__help", text: g }));

    // The server's "more" fields go behind a disclosure — only for the whole form. A page that
    // names its fields has chosen them, so they all show, in its order.
    const useMore = attr == null || !String(attr).trim();
    const more = [];
    for (const f of shown) {
      const start = edit ? (rec.values || {})[f.name]
        : f.name in presets ? presets[f.name]
          : (f.kind === "linked" && typeof f.default === "string") ? null : f.default;
      const ed = edit ? (rec.editable || {})[f.name] : true;
      const el = this._field(f, start, ed);
      if (useMore && f.tier === "more") more.push(el); else fieldsBox.append(el);
    }
    if (more.length) {
      this._more = h("details", { class: "tfs-form__more" },
        h("summary", {}, icon("chevron"), "More fields", h("span", { class: "tfs-form__count", text: String(more.length) })),
        h("div", { class: "tfs-form__morebody" }, ...more));
      fieldsBox.append(this._more);
    } else this._more = null;
    this._bodyEl.append(fieldsBox);
    this._ready = true;
    this._paint(this.machine);
  }

  _field(f, start, editable) {
    const id = nextId(`tfs-f-${f.name}`);
    const lid = `${id}-l`;
    const short = isShort(f);
    const wrap = h("div", { class: `tfs-field${short ? " tfs-field--short" : ""} tfs-field--${f.kind}`, "data-field": f.name });
    const readOnly = !isEditable(editable);   // fail closed: only an explicit `true` edits
    const nativeLabel = !readOnly && f.kind !== "rich_text" && f.kind !== "checkbox" && !isStatusField(f);
    const label = h(nativeLabel ? "label" : "span", { class: "tfs-field__label", id: lid, for: nativeLabel ? id : null }, f.label || f.name);
    if (f.required) label.append(" ", h("span", { class: "tfs-field__req", text: "Required" }));
    const changed = h("span", { class: "tfs-field__changed", text: "Changed", hidden: true });
    label.append(changed);
    wrap.append(label);
    const meta = { wrap, label, changed, ctrl: null, anchor: null, helpIds: [] };
    this._meta.set(f.name, meta);

    if (readOnly) {
      const msg = (editable && editable.message) || "This field can't be changed here. Edit it in Coda.";
      const src = safeHref(this.record && this.record.source);
      if (f.kind === "rich_text" && !isBlank(start)) {
        const words = src ? msg.replace(/\s*Edit it in Coda\.?\s*$/, "") : msg;
        const area = h("div", { class: "tfs-rt__area" });
        area.innerHTML = mdToHtml(String(start));
        wrap.append(h("div", { class: "tfs-rt tfs-rt--locked", "aria-labelledby": lid },
          h("p", { class: "tfs-rt__lock" }, icon("lock"),
            h("span", {}, words, src ? " " : null, src ? h("a", { class: "tfs-link", href: src, target: "_blank", rel: "noopener", text: "Edit it in Coda" }) : null)),
          area));
      } else {
        wrap.append(h("div", { class: "tfs-field__ro", "aria-labelledby": lid, text: displayText(f, start) }),
          h("p", { class: "tfs-field__lock" }, icon("lock"), h("span", { text: msg })));
      }
      const init = this._initial[f.name];
      this._controls.set(f.name, () => init);   // never dirty
      return wrap;
    }
    const helpText = [f.note, f.help].filter(Boolean);
    let get;
    const k = f.kind;
    if (k === "linked") {
      const p = document.createElement("tfs-picker");
      p.setAttribute("entity-type", (f.picker && f.picker.entity_type) || "");
      p.setAttribute("input-id", id);
      if (f.multi) p.setAttribute("multi", "");
      if (f.add_only) p.setAttribute("add-only", "");
      if (typeof f.default === "string" && !this.record) p.setAttribute("placeholder", `Default: ${f.default}`);
      p.transport = this.transport;
      p.value = start == null ? null : start;
      wrap.append(p);
      meta.ctrl = () => p.querySelector(".tfs-picker__input");
      get = () => p.value;
    } else if (k === "rich_text") {
      const r = document.createElement("tfs-rich-text");
      r.id = id;
      r.setAttribute("labelledby", lid);
      r.value = start == null ? null : String(start);
      wrap.append(r);
      r.editor.style.minHeight = "150px";   // the reference's height inside a form
      meta.ctrl = () => r.editor;
      get = () => r.value;
    } else if (isStatusField(f)) {
      get = this._statusField(f, id, lid, wrap, meta, wireOf(f, start));
    } else if (k === "dropdown" && f.multi) {
      const ms = multiSelect(f, id, wireOf(f, start));
      wrap.append(ms.el);
      meta.ctrl = () => ms.input;
      get = ms.get;
    } else if (k === "dropdown") {
      const cur = wireOf(f, start);
      const sel = h("select", { class: "tfs-input", id });
      sel.append(h("option", { value: "", text: "Not set" }));
      for (const o of optionsWithCurrent(f.options, cur)) sel.append(h("option", { value: o.value, text: o.label }));
      sel.value = cur == null ? "" : cur;
      let touched = false;
      sel.addEventListener("change", () => { touched = true; });
      wrap.append(sel);
      meta.ctrl = () => sel;
      get = () => controlValue(touched, () => (sel.value === "" ? null : sel.value), cur);
    } else if (k === "checkbox") {
      const init = wireOf(f, start);
      const cb = h("input", { type: "checkbox", class: "tfs-check", id, "aria-labelledby": `${lid} ${id}-t` });
      cb.checked = init === true;
      let touched = false;
      cb.addEventListener("change", () => { touched = true; });
      // The row's words: the field's note when it has one (shown here, not again below).
      wrap.append(h("label", { class: "tfs-checkrow" }, cb, h("span", { id: `${id}-t`, text: helpText.shift() || "Yes" })));
      meta.ctrl = () => cb;
      // An untouched box reports what it was given, so a null never turns into a sent `false`.
      get = () => controlValue(touched, () => cb.checked, init);
    } else {
      const type = { url: "url", email: "email", number: "number", date: "date" }[k] || "text";
      const v = wireOf(f, start);
      const multiline = type === "text" && textControlTag(v) === "textarea";
      const title = type === "text" && !multiline && (f.name === "title" || f.name === "name");
      const inp = multiline
        ? h("textarea", { class: "tfs-input tfs-textarea", id })
        : h("input", { class: title ? "tfs-input tfs-input--title" : "tfs-input", type, id,
          inputmode: type === "url" ? "url" : type === "email" ? "email" : type === "number" ? "decimal" : null,
          placeholder: type === "url" ? "https://" : null });
      if (type === "number") inp.step = "any";
      inp.value = v == null ? "" : String(v);
      let touched = false;
      const fit = () => { if (multiline) inp.rows = Math.max(2, inp.value.split("\n").length); };
      if (type === "number" || type === "date") {
        // The browser reports text it cannot parse as "", which would be sent as a CLEAR.
        this._checks.set(f.name, () => (touched
          ? badInputMessage(f, { badInput: !!(inp.validity && inp.validity.badInput), value: inp.value })
          : null));
      }
      fit();
      inp.addEventListener("input", () => { touched = true; fit(); });
      inp.addEventListener("change", () => { touched = true; });
      wrap.append(inp);
      meta.ctrl = () => inp;
      // Untouched → the initial value exactly (`controlValue`): never what the browser kept.
      get = () => controlValue(touched,
        () => (inp.value === "" ? null : type === "number" ? wireOf(f, inp.value) : inp.value), v);
    }
    for (const t of helpText) {
      const hid = nextId("tfs-help");
      wrap.append(h("p", { class: "tfs-field__help", id: hid, text: t }));
      meta.helpIds.push(hid);
    }
    this._describe(meta, null);
    this._controls.set(f.name, get);
    return wrap;
  }

  /* Status inside a form: a field-shaped button holding the chip; it opens the status menu,
     and picking only sets the value (the form's Save writes it). */
  _statusField(f, id, lid, wrap, meta, cur) {
    let value = cur; let touched = false;
    const opts = optionsWithCurrent(f.options, cur);
    const colourOf = (v) => { const o = opts.find((x) => x.value === v); return o && o.color; };
    const textOf = (v) => { const o = opts.find((x) => x.value === v); return o ? o.label : v; };
    const btn = h("button", { type: "button", class: "tfs-chipselect", id, "aria-haspopup": "menu", "aria-expanded": "false",
      "aria-labelledby": `${lid} ${id}` });
    const paint = () => btn.replaceChildren(statusChip(textOf(value), colourOf(value)), icon("chevron"));
    paint();
    const menu = new StatusMenu({ options: opts, current: value, label: f.label || "Status",
      onPick: (v, m) => {
        value = v; touched = true; m.setCurrent(v); m.close(true); paint();
        btn.dispatchEvent(new Event("input", { bubbles: true }));
      } });
    btn.addEventListener("click", () => { if (menu.isOpen) menu.close(true); else menu.open(btn); });
    btn.addEventListener("keydown", (e) => { if (e.key === "ArrowDown" && !menu.isOpen) { e.preventDefault(); menu.open(btn); } });
    wrap.append(h("div", { style: "position:relative" }, btn, menu.el));
    meta.ctrl = () => btn;
    meta.menu = menu;
    return () => controlValue(touched, () => value, cur);
  }

  /* aria-describedby = the field's error (if any), then its help. */
  _describe(meta, errId) {
    const c = meta.ctrl && meta.ctrl();
    if (!c) return;
    const ids = [errId, ...meta.helpIds].filter(Boolean);
    if (ids.length) c.setAttribute("aria-describedby", ids.join(" ")); else c.removeAttribute("aria-describedby");
    if (errId) c.setAttribute("aria-invalid", "true"); else c.removeAttribute("aria-invalid");
  }

  /** The current wire values: every shown control, plus hidden presets. */
  currentValues() {
    const out = { ...this._hidden };
    for (const [n, get] of this._controls) out[n] = get();
    return out;
  }

  /** What a save would send now (only changed fields). */
  changes() { return payloadFor(this._byName || {}, this._initial, this.currentValues()); }

  _onEdit(e) {
    if (!this._ready) return;
    const w = e.target && e.target.closest && e.target.closest("[data-field]");
    if (w) {
      this._dismissed.add(w.dataset.field);
      if (this._localErrors) { delete this._localErrors[w.dataset.field]; }
    }
    if (this.machine && this.machine.state === "refused" && !this.machine.busy()) { /* keep the notice; marks clear per field */ }
    this._paint(this.machine);
  }

  async save() {
    if (!this.machine || formLocked(this.machine.busy(), this._rereading)) return;
    if (this.machine.state === "outcome_unknown" && !this.machine.isUpdate) return;
    this._dismissed = new Set();
    this._localErrors = null;
    const bad = {};
    for (const [name, check] of this._checks) { const m = check(); if (m) bad[name] = m; }
    if (Object.keys(bad).length) { this._localErrors = bad; this._paint(this.machine); return; }
    const fields = this.changes();
    if (!Object.keys(fields).length) { this._paint(this.machine); return; }
    this._rereadFailed = false;
    await this.machine.submit(fields);
  }

  /* The whole face of the form for the machine's state. No side effects beyond the DOM. */
  _paint(m) {
    if (!this._ready || !m) return;
    const current = this.currentValues();
    const changes = payloadFor(this._byName || {}, this._initial, current);
    const edit = m.isUpdate;
    for (const [name, meta] of this._meta) meta.changed.hidden = !(edit && name in changes);
    const missing = !edit ? missingRequired(this._shown, current) : null;
    const view = formView({
      phase: "ready", state: m.state, receipt: m.receipt, isUpdate: edit, tokenStale: m.tokenStale,
      dirtyCount: Object.keys(changes).length, missing: missing ? (missing.label || missing.name) : null,
      noun: this.noun, saveLabel: this.getAttribute("save-label"), labelOf: (n) => this._labels[n] || n,
      shownNames: (this._shown || []).map((f) => f.name), localErrors: this._localErrors,
      rereading: this._rereading, rereadFailed: this._rereadFailed,
    });
    this._apply(view);
  }

  _apply(view) {
    // footer line
    const st = this._statusEl;
    st.replaceChildren();
    if (view.footer) {
      if (view.footer.ok) st.append(h("span", { class: "tfs-msg tfs-msg--quiet tfs-msg--ok", role: "status" }, icon("ok"), view.footer.text));
      else { if (view.footer.spinner) st.append(spinner()); st.append(view.footer.text); }
    }
    // notices
    this._notice.replaceChildren(...view.notices.map((n) => msgEl(n, (n.actions || []).map((a) => this._actionNode(a)))));
    // buttons
    this._closeAction = view.close.action;
    this._closeBtn.textContent = view.close.label;
    const s = view.save;
    this._saveBtn.hidden = !!s.hidden;
    this._saveBtn.disabled = !!s.disabled;
    this._saveBtn.toggleAttribute("aria-busy", !!s.busy);
    this._saveBtn.replaceChildren(...(s.busy ? [spinner()] : []), s.label);
    // lock while busy and while the record is re-read
    if (this._fieldset) {
      this._fieldset.disabled = !!view.locked;
      // contenteditable ignores a disabled fieldset; the editor locks itself.
      this._fieldset.querySelectorAll("tfs-rich-text").forEach((r) => { r.disabled = !!view.locked; });
      if (view.locked) for (const meta of this._meta.values()) if (meta.menu) meta.menu.close(false);
    }
    this._formEl.toggleAttribute("aria-busy", !!view.locked);
    // field errors (a field the person has edited since drops its mark)
    let openMore = false;
    for (const [name, meta] of this._meta) {
      const old = meta.wrap.querySelector(":scope > .tfs-field__err");
      if (old) old.remove();
      const msg = !this._dismissed.has(name) || (this._localErrors && this._localErrors[name]) ? view.fieldErrors[name] : null;
      if (msg) {
        const eid = nextId("tfs-err");
        const err = h("p", { class: "tfs-field__err", id: eid }, icon("fieldError"), msg);
        const help = meta.wrap.querySelector(":scope > .tfs-field__help");
        meta.wrap.insertBefore(err, help || null);
        this._describe(meta, eid);
        if (this._more && this._more.contains(meta.wrap)) openMore = true;
      } else this._describe(meta, null);
    }
    if (openMore) this._more.open = true;
  }

  _actionNode(a) {
    if (a.kind === "link") return codaLink(a.href, a.label);
    if (a.kind === "retry") return h("button", { type: "button", class: "tfs-btn tfs-btn--small", text: "Try again", onclick: () => this.machine.retry() });
    if (a.kind === "reload") return h("button", { type: "button", class: "tfs-btn tfs-btn--small", text: "Try again", onclick: () => this.load() });
    return null;
  }

  /* × and the footer's Close/Cancel: a cancellable `tfs-close` (bubbles, composed). Unless the
     page cancels it, the kit closes the <dialog> the form sits in (if any) and drops unsaved
     edits, so the form opens clean next time. A save already writing carries on. */
  _requestClose() {
    const m = this.machine;
    const dirty = this._ready && Object.keys(this.changes()).length > 0;
    if (m) m.abort();   // a check or a question is stopped: nothing is written
    const ev = new CustomEvent("tfs-close", { bubbles: true, composed: true, cancelable: true,
      detail: { dirty, state: m ? m.state : null } });
    if (!this.dispatchEvent(ev)) return;
    if (this._ready && dirty && m && !m.busy()) {
      if (m.state === "refused") m.reset();
      this._build();
    }
    const dlg = this.closest && this.closest("dialog");
    if (dlg && dlg.open) dlg.close();
  }

  _onState(m) {
    this._paint(m);
    this.dispatchEvent(new CustomEvent("tfs-state", { bubbles: true, detail: { state: m.state, receipt: m.receipt } }));
    if (m.state === "saved_syncing") this._afterSave(m.receipt);
  }

  async _afterSave(receipt) {
    this.dispatchEvent(new CustomEvent("tfs-saved", { bubbles: true, composed: true, detail: receipt }));
    if (this.record) {
      // Re-read: the server overlays our own write, so the new values and token are current.
      let rec = null;
      this._rereading = true;
      this._paint(this.machine);
      try {
        rec = await this.transport.call("get_record_for_editing", { table: this.table, row_id: this.machine.rowId }, { fresh: true });
      } catch { rec = null; }
      this._rereading = false;
      if (this.machine.state !== "saved_syncing") { this._paint(this.machine); return; }
      if (!rec || rec.refused) {
        // ⛔ DO NOT REDRAW FROM THE OLD RECORD: that would show the pre-save values as if the
        // save had not happened. Keep what the person sent on screen, treat it as the new
        // starting point (so it is not re-sent), and say the view may be behind.
        // What was SENT is the new baseline (the form was locked while it went, so it is
        // also what is on screen); not `currentValues()`, which could carry anything else.
        this._initial = initialAfterUnreadSave(this._initial, this.machine.pending);
        this._rereadFailed = true;
        this._paint(this.machine);          // unlock (the re-read is over)
        return;
      }
      this.record = rec;
      this.machine.refreshToken(rec.row_version);
      if (rec.source) this.machine.source = rec.source;
    }
    // Redraw the fields from the new initial values (a create starts a fresh record); the
    // footer keeps saying "Saved" because the machine is still in saved_syncing.
    if (this.machine.state === "saved_syncing") this._build();
  }
}
