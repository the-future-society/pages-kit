/* TFS pages kit — form components: <tfs-record-form>, <tfs-picker>, <tfs-rich-text> (spec §6.1).
 *
 * A PAGE NEVER CARRIES ITS OWN COPY OF HOW TFS DATA WORKS. The form is built from
 * `describe_record_form` (fields, kinds, options, defaults, rules) and, to edit, from
 * `get_record_for_editing` (values, per-field `editable`, `row_version`). The `fields` attribute
 * may choose and order a subset of what the server serves; it can never add a field.
 *
 * ONLY CHANGED FIELDS ARE SENT (Review Focus 4). The form keeps each field's `initial` value in
 * WIRE form (what `save_record` takes: a linked field as row id(s), a date as YYYY-MM-DD) and
 * sends only the fields whose current value differs. An untouched field holding a value no
 * longer offered (an archived status) is therefore never sent, so it survives a save of others.
 * A rich-text field the person did not edit returns its ORIGINAL markdown, not a re-serialisation
 * of it, so opening a record and saving its status never rewrites its notes.
 *
 * The logic is exported as pure functions (`selectFields`, `dirtyFields`, `wireOf`, `payloadFor`,
 * `stateView`, …) so Node can test it without a DOM; the elements only wire them to controls.
 *
 * THE RICH-TEXT EDITOR is the Review Inbox's, ported: `blockAt`, `setBlock`, the command table,
 * `runCmd`, the link bar, the tick-box, Tab nesting and the plain-text paste handler keep their
 * logic. Two changes, both forced by the new home:
 *   - the toolbar is exactly the supported subset (H1, H2, H3, bold, italic, strikethrough, link, bullets,
 *     numbers, tick-box list, quote) as plain buttons, with no heading menu and no body button
 *     (pressing a heading level again already returns to body text, `setBlock`);
 *   - the link address is asked for in a small inline field, not `window.prompt`, because a
 *     sandboxed artifact frame may refuse modal dialogs, and a refused prompt returns null
 *     silently: the Link button would do nothing and say nothing.
 * Every document-level listener is scoped to `tfs-rich-text`, so the kit can share a page with
 * the Review Inbox's own editor without either answering the other's events.
 */
import { mdToHtml, htmlToMd } from "./markdown.js";
import { SaveMachine } from "./save.js";
import { createTransport } from "./transport.js";

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
export const LINK_REFUSED = "Links must start with https://, http:// or mailto:";

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

const SAVED_TEXT = "Saved · showing on pages within a few minutes";

/**
 * What the status area shows for a machine state: `{tone, lines, link, actions}`.
 * `link` is `{href|null, text}`; `actions` names the buttons to offer.
 */
export function stateView(state, receipt, { isUpdate = false, tokenStale = false } = {}) {
  const r = receipt || {};
  const warnings = (r.warnings || []).filter((w) => w && w.message);
  switch (state) {
    case "previewing": return { tone: "busy", lines: ["Checking…"], link: null, actions: [] };
    case "saving": return { tone: "busy", lines: ["Saving…"], link: null, actions: [] };
    case "confirm": {
      const w = warnings.find((x) => x.code === "changed_since_opened");
      const lines = [w ? w.message : "This record changed since you opened it."];
      // Stale token: the page could not re-read the record after the person's last save, so the
      // server is comparing with the pre-save version. Only "You" is explained; a change by
      // anyone else is always shown as theirs.
      if (w && w.by === "You" && tokenStale) {
        lines.push("That is probably your own save just now: this page couldn't reload the record after it.");
      }
      return { tone: "warn", lines, link: null, actions: ["save_anyway", "cancel"] };
    }
    case "saved_syncing": {
      const first = isUpdate ? SAVED_TEXT : `${SAVED_TEXT}. ${(r.lag && r.lag.new_row_editable_after) || "A new record can be edited after a few minutes."}`;
      const ordered = [...warnings.filter((w) => w.code === "already_saved"), ...warnings.filter((w) => w.code !== "already_saved")];
      return { tone: "ok", lines: [first, ...ordered.map((w) => w.message)], link: r.source ? { href: r.source, text: "Open in Coda" } : null, actions: [] };
    }
    case "refused": {
      const msgs = (r.refusals || []).map((x) => x && x.message).filter(Boolean);
      return { tone: "error", lines: msgs.length ? msgs : ["Not saved."], link: null, actions: [] };
    }
    case "outcome_unknown":
      return { tone: "warn", lines: [r.message || "This may have been saved. Check in Coda before trying again."], link: { href: r.source || null, text: "Check in Coda" }, actions: isUpdate ? ["retry"] : [] };
    default: return { tone: "idle", lines: [], link: null, actions: [] };
  }
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
 * `configure`. So a form never reads its transport in `connectedCallback`: it loads one
 * microtask later, after the importing script's body has run. */
export function configure({ transport } = {}) { if (transport) defaultTransport = transport; }
function transportOf(el) {
  return el._transport || defaultTransport || autoTransport || (autoTransport = createTransport({ kind: "artifact" }));
}

/* The Review Inbox's `esc`, verbatim: attribute-safe escaping for the link bar. */
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

function h(tag, attrs = {}, ...kids) {
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
          b.setAttribute('aria-checked','false'); b.tabIndex=0;
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
  return Promise.resolve(fn(editor)).then(()=>notify(editor));
}

/* The supported subset's toolbar, exactly. Each button maps to ONE construct in the subset. */
const RICH_BUTTONS = [
  ["h1", "H1", "Heading 1"], ["h2", "H2", "Heading 2"], ["h3", "H3", "Heading 3"], null,
  ["bold", "B", "Bold"], ["italic", "I", "Italic"], ["strike", "S", "Strikethrough"], ["link", "Link", "Link"], null,
  ["ul", "• Bullets", "Bulleted list"], ["ol", "1. Numbers", "Numbered list"], ["task", "Tick", "Tick-box checklist"], ["quote", "Quote", "Blockquote"],
];
export const TOOLBAR_COMMANDS = RICH_BUTTONS.filter(Boolean).map((b) => b[0]);

/* A LINK YOU CAN CHECK AND CHANGE (ported). */
function closeLinkBar(){ document.querySelectorAll('.tfs-linkbar').forEach(b=>b.remove()); }

function linkAtCaret(){
  const sel=window.getSelection();
  let n=sel && sel.anchorNode;
  while(n && n.nodeName!=='A' && !(n.dataset && n.dataset.rich)) n=n.parentNode;
  return (n && n.nodeName==='A' && n.closest('tfs-rich-text')) ? n : null;
}

function showLinkBar(a){
  closeLinkBar();
  const ed=a.closest('[data-rich]'); if(!ed) return;
  const href=a.getAttribute('href')||'';
  const ok=allowedLinkHref(href);
  const bar=document.createElement('div');
  bar.className='tfs-linkbar';
  /* A disallowed address is shown as TEXT, never as a link, and offers no Open. */
  bar.innerHTML=(ok ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(href)}</a>`
                    : `<span class="tfs-linkbar__bad">${esc(href)}</span>`)
    +(ok ? `<button type="button" data-link="open">Open</button>` : '')
    +`<button type="button" data-link="edit">Change</button>`
    +`<button type="button" data-link="remove">Remove</button>`;
  document.body.appendChild(bar);
  const r=a.getBoundingClientRect();
  bar.style.top=(window.scrollY+r.bottom+6)+'px';
  bar.style.left=(window.scrollX+r.left)+'px';
  bar._anchor=a;
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
      const a=b._anchor; const ed=a && a.closest('[data-rich]');
      closeLinkBar();
      const host=ed && ed.closest('tfs-rich-text');
      if(host && host.disabled && act.dataset.link!=='open') return;
      /* Open changes nothing, so it does not count as an edit. */
      if(act.dataset.link==='open'){
        const href=allowedLinkHref(a.getAttribute('href'));
        if(href) window.open(href,'_blank','noopener');
        return;
      }
      if(act.dataset.link==='edit'){
        const before=a.getAttribute('href')||'';
        askUrl(ed, before||'https://').then(raw=>{
          const u=allowedLinkHref(raw);
          /* Only a NEW address is an edit; Cancel, or the same address, changes nothing. */
          if(u && u!==before){ a.setAttribute('href',u); if(ed) notify(ed); }
        });
        return;
      }
      if(act.dataset.link==='remove'){
        const t=document.createTextNode(a.textContent||''); a.replaceWith(t);
      }
      if(ed) notify(ed);
      return;
    }
    if(!richOf(e)) closeLinkBar();
  });
  document.addEventListener('keyup',()=>{
    const a=linkAtCaret();
    if(a) showLinkBar(a); else closeLinkBar();
  });
  document.addEventListener('click',e=>{
    const a=e.target.closest && e.target.closest('tfs-rich-text [data-rich] a');
    if(a) showLinkBar(a);
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
    for (const b of RICH_BUTTONS) {
      if (!b) { bar.append(h("span", { class: "tfs-rt__sep", "aria-hidden": "true" })); continue; }
      bar.append(h("button", { type: "button", "data-cmd": b[0], "aria-label": b[2], title: b[2], text: b[1] }));
    }
    this._ask = h("div", { class: "tfs-rt__ask", hidden: true });
    this._area = h("div", { class: "tfs-rt__area", contenteditable: "true", role: "textbox",
      "aria-multiline": "true", "data-rich": "1" });
    if (this.id) { this._area.id = `${this.id}-area`; }
    const lab = this.getAttribute("aria-label");
    if (lab) this._area.setAttribute("aria-label", lab);
    this._area.addEventListener("input", () => { this._touched = true; });
    // Enter makes a <p>, not a <div>: a paragraph is what `htmlToMd` reads as one.
    this._area.addEventListener("focus", () => { try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch { /* old browser */ } });
    this._fill();
    this.append(bar, this._ask, this._area);
  }

  /* ⛔ AN EMPTY FIELD IS `<p><br></p>`, NOT `<p></p>`. An empty paragraph has no height, so a
     click puts the caret in the editor ROOT, and text typed there is a bare text node. Bold
     applied to it is then a top-level <b>, which `htmlToMd` reads as a paragraph of its TEXT:
     the bold is silently lost (measured in a real browser, 2026-10-02). The <br> gives the
     paragraph a line to hold the caret, and serialises to nothing. Element-level only; the
     converter is untouched. */
  _fill() {
    const html = mdToHtml(this._md || "");
    this._area.innerHTML = html === "<p></p>" ? "<p><br></p>" : html;
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
    return new Promise((resolve) => {
      const input = h("input", { type: "url", class: "tfs-input", "aria-label": "Link address", value: initial || "https://" });
      input.value = initial || "https://";
      const done = (v) => { this._ask.hidden = true; this._ask.replaceChildren(); resolve(v); };
      const err = h("p", { class: "tfs-rt__askerr", role: "alert", hidden: true });
      const ok = h("button", { type: "button", class: "tfs-btn tfs-btn--small", text: "Add link",
        onclick: () => {
          const v = input.value.trim();
          if (!v || v === "https://") return done(null);
          // A refused address keeps the field open with the reason, so the person can fix it.
          if (!allowedLinkHref(v)) { err.textContent = LINK_REFUSED; err.hidden = false; input.focus(); return; }
          done(v);
        } });
      const no = h("button", { type: "button", class: "tfs-btn tfs-btn--quiet tfs-btn--small", text: "Cancel", onclick: () => done(null) });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); ok.click(); }
        if (e.key === "Escape") { e.preventDefault(); done(null); }
      });
      this._ask.replaceChildren(h("label", { class: "tfs-rt__asklabel", text: "Link to where?" }), input, ok, no, err);
      this._ask.hidden = false;
      input.focus(); input.select();
    });
  }
}

/* ===========================================================================
   <tfs-picker> — a linked-record field. The value is the row id, never the typed text.
   ========================================================================= */

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
    const lid = `tfs-pk-${++uid}`;
    this._chips = h("div", { class: "tfs-chips" });
    this._input = h("input", { class: "tfs-input", type: "text", role: "combobox", autocomplete: "off",
      "aria-expanded": "false", "aria-autocomplete": "list", "aria-controls": lid,
      placeholder: this.getAttribute("placeholder") || "Type to search…" });
    if (this.getAttribute("input-id")) this._input.id = this.getAttribute("input-id");
    this._clear = h("button", { type: "button", class: "tfs-picker__clear", "aria-label": "Clear", text: "×", hidden: true,
      onclick: () => { this._items = []; this._render(); this._changed(); this._input.focus(); } });
    this._list = h("ul", { class: "tfs-picker__list", role: "listbox", id: lid, hidden: true });
    this._input.addEventListener("input", () => this._schedule());
    this._input.addEventListener("focus", () => this._schedule());
    this._input.addEventListener("keydown", (e) => this._key(e));
    this._input.addEventListener("blur", () => setTimeout(() => {
      if (this.contains(document.activeElement)) return;
      this._close();
      if (!this.multi) this._input.value = this._items[0] ? (this._items[0].label || this._items[0].row_id) : "";
    }, 150));
    this.append(this._chips, h("div", { class: "tfs-picker__row" }, this._input, this._clear), this._list);
    this._render();
  }

  _render() {
    this._chips.replaceChildren();
    if (this.multi) {
      for (const it of this._items) {
        const chip = h("span", { class: "tfs-chip" }, h("span", { text: it.label || it.row_id }));
        if (!this._locked.has(it.row_id)) {
          chip.append(h("button", { type: "button", class: "tfs-chip__x", "aria-label": `Remove ${it.label || it.row_id}`, text: "×",
            onclick: () => { this._items = this._items.filter((x) => x.row_id !== it.row_id); this._render(); this._changed(); } }));
        }
        this._chips.append(chip);
      }
      this._chips.hidden = this._items.length === 0;
      this._clear.hidden = true;
    } else {
      this._chips.hidden = true;
      if (document.activeElement !== this._input) this._input.value = this._items[0] ? (this._items[0].label || this._items[0].row_id) : "";
      this._clear.hidden = this._items.length === 0 || this._locked.size > 0;
    }
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
    const q = this.multi || !this._items[0] || this._input.value !== (this._items[0].label || this._items[0].row_id) ? this._input.value.trim() : "";
    this._showMessage("Searching…");
    let opts;
    try {
      const r = await this.transport.call("search_records_for_picker",
        { entity_type: this.getAttribute("entity-type"), query: q, limit: 20 });
      opts = (r && r.options) || [];
    } catch (e) {
      if (seq === this._seq) this._showMessage(`Couldn't search: ${e.message}`);
      return;
    }
    if (seq !== this._seq) return;               // a newer search is under way
    const chosen = new Set(this._items.map((i) => i.row_id));
    this._options = opts.filter((o) => o && o.row_id && !(this.multi && chosen.has(o.row_id)));
    this._active = this._options.length ? 0 : -1;
    this._drawOptions();
  }

  _showMessage(text) {
    this._list.replaceChildren(h("li", { class: "tfs-picker__msg", role: "presentation", text }));
    this._open();
  }

  _drawOptions() {
    if (!this._options.length) return this._showMessage("No matches");
    this._list.replaceChildren(...this._options.map((o, i) => {
      const li = h("li", { role: "option", id: `${this._list.id}-${i}`, class: "tfs-picker__opt", "aria-selected": String(i === this._active) },
        h("span", { class: "tfs-picker__label", text: o.label || o.row_id }),
        o.hint ? h("span", { class: "tfs-picker__hint", text: String(o.hint) }) : null);
      li.addEventListener("mousedown", (e) => { e.preventDefault(); this._pick(o); });
      return li;
    }));
    this._input.setAttribute("aria-activedescendant", this._active >= 0 ? `${this._list.id}-${this._active}` : "");
    this._open();
  }

  _open() { if (lockedByFieldset(this)) return; this._list.hidden = false; this._input.setAttribute("aria-expanded", "true"); }
  _close() { this._list.hidden = true; this._input.setAttribute("aria-expanded", "false"); this._input.removeAttribute("aria-activedescendant"); }

  _pick(o) {
    if (lockedByFieldset(this)) { this._close(); return; }
    const item = { row_id: o.row_id, label: o.label || null };
    if (this.multi) { if (!this._items.some((x) => x.row_id === item.row_id)) this._items.push(item); this._input.value = ""; }
    else { this._items = [item]; this._input.value = item.label || item.row_id; }
    this._close(); this._render(); this._changed();
  }

  _key(e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (this._list.hidden) { this._schedule(); return; }
      e.preventDefault();
      if (!this._options.length) return;
      const d = e.key === "ArrowDown" ? 1 : -1;
      this._active = (this._active + d + this._options.length) % this._options.length;
      this._drawOptions();
    } else if (e.key === "Enter") {
      e.preventDefault();   // Enter picks; it never submits the surrounding form with half a name typed
      if (!this._list.hidden && this._active >= 0 && this._options[this._active]) this._pick(this._options[this._active]);
    } else if (e.key === "Escape") {
      if (!this._list.hidden) { e.preventDefault(); this._close(); }
    } else if (e.key === "Backspace" && this.multi && !this._input.value && this._items.length) {
      const last = this._items[this._items.length - 1];
      if (!this._locked.has(last.row_id)) { this._items.pop(); this._render(); this._changed(); }
    }
  }
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

export class TfsRecordForm extends Base {
  static get observedAttributes() { return ["table", "mode", "row", "fields", "presets"]; }

  constructor() {
    super();
    this._seq = 0; this._started = false; this._presets = null;
    this.form = null; this.record = null; this.machine = null;
    this._controls = new Map(); this._initial = {}; this._hidden = {};
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
    this.classList.add("tfs-form");
    queueMicrotask(() => this.load());   // after the page's `configure` (see `configure`)
  }
  attributeChangedCallback(_n, oldV, newV) { if (this._started && oldV !== newV) this.load(); }

  get table() { return this.getAttribute("table") || ""; }
  get mode() { return this.getAttribute("mode") || (this.getAttribute("row") ? "edit" : "create"); }

  _message(text, tone = "info") {
    this.replaceChildren(h("p", { class: `tfs-form__msg tfs-tone-${tone}`, role: tone === "error" ? "alert" : "status", text }));
  }

  async load() {
    const seq = ++this._seq;
    const tr = this.transport;
    const table = this.table, mode = this.mode, row = this.getAttribute("row");
    this._message("Loading…", "busy");
    let form, rec = null;
    try {
      form = await tr.call("describe_record_form", { table, mode });
      if (seq !== this._seq) return;
      if (form.refused) return this._message(form.message || "This form isn't available.", "error");
      if (mode === "edit") {
        if (!row) return this._message("This form needs a record to edit.", "error");
        rec = await tr.call("get_record_for_editing", { table, row_id: row }, { fresh: true });
        if (seq !== this._seq) return;
        if (rec.refused) return this._message(rec.message || "That record isn't available.", "error");
      }
    } catch (e) {
      if (seq === this._seq) this._message(e.message || "Something went wrong.", "error");
      return;
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
    const shown = selectFields(served, this.getAttribute("fields"));
    const presets = this.presets || {};
    const byName = this._servedByName();
    this._initial = {};
    this._hidden = {};
    for (const f of served) {
      this._initial[f.name] = edit ? wireOf(f, (rec.values || {})[f.name]) : wireOf(f, null);
      if (!edit && f.name in presets && !shown.includes(f)) this._hidden[f.name] = wireOf(f, presets[f.name]);
    }

    // ⛔ A <fieldset>, so ONE `disabled` locks every control while a save is in flight: an edit
    // made then is neither in the save nor safe after it (the redraw would drop it, or the
    // "Saved" line would claim it).
    const fieldsBox = h("fieldset", { class: "tfs-form__fields" });
    this._fieldset = fieldsBox;
    this._controls = new Map();
    this._checks = new Map();
    if (!shown.length) fieldsBox.append(h("p", { class: "tfs-form__msg", text: "This form has no fields to show." }));
    for (const f of shown) {
      const start = edit ? (rec.values || {})[f.name]
        : f.name in presets ? presets[f.name]
          : (f.kind === "linked" && typeof f.default === "string") ? null : f.default;
      const ed = edit ? (rec.editable || {})[f.name] : true;
      fieldsBox.append(this._field(f, start, ed));
    }

    // A group is stated only when the page shows one of its members and no hidden preset
    // already answers it; otherwise the server's own refusal names it, which is clearer than
    // pointing at a field the person cannot see.
    const groups = groupLines((form.required_groups || []).filter((g) => Array.isArray(g)
      && g.some((n) => shown.some((f) => f.name === n))
      && !g.some((n) => n in this._hidden && !isBlank(this._hidden[n]))), served);
    this._status = h("div", { class: "tfs-form__status", role: "status", "aria-live": "polite" });
    this._saveBtn = h("button", { type: "submit", class: "tfs-btn tfs-btn--primary", text: this.getAttribute("save-label") || "Save" });
    const el = h("form", { class: "tfs-form__body", novalidate: true },
      groups.length ? h("p", { class: "tfs-form__groups" }, ...groups.map((g) => h("span", { text: g }))) : null,
      fieldsBox,
      h("div", { class: "tfs-form__foot" }, this._saveBtn, this._status));
    el.addEventListener("submit", (e) => { e.preventDefault(); this.save(); });
    this.replaceChildren(el);
    this._byName = byName;
    this._paint(this.machine);
  }

  _field(f, start, editable) {
    const id = `tfs-f-${++uid}-${f.name}`;
    const wrap = h("div", { class: `tfs-field tfs-field--${f.kind}`, "data-field": f.name });
    const label = h("label", { class: "tfs-field__label", for: id }, f.label || f.name,
      f.required ? h("span", { class: "tfs-field__req", "aria-label": "required", text: " *" }) : null);
    wrap.append(label);
    const readOnly = !isEditable(editable);   // fail closed: only an explicit `true` edits
    if (readOnly) {
      label.removeAttribute("for");
      const ro = f.kind === "rich_text" && !isBlank(start)
        ? h("div", { class: "tfs-field__ro tfs-rt__area" })
        : h("div", { class: "tfs-field__ro", text: displayText(f, start) });
      if (f.kind === "rich_text" && !isBlank(start)) ro.innerHTML = mdToHtml(String(start));
      wrap.append(ro, h("p", { class: "tfs-field__lock", text: (editable && editable.message) || "This field can't be changed here. Edit it in Coda." }));
      const init = this._initial[f.name];
      this._controls.set(f.name, () => init);   // never dirty
      return wrap;
    }
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
      get = () => p.value;
    } else if (k === "rich_text") {
      const r = document.createElement("tfs-rich-text");
      r.id = id;
      r.setAttribute("aria-label", f.label || f.name);
      r.value = start == null ? null : String(start);
      wrap.append(r);
      label.setAttribute("for", `${id}-area`);
      get = () => r.value;
    } else if (k === "dropdown" && f.multi) {
      get = this._multiDropdown(wrap, f, id, wireOf(f, start));
    } else if (k === "dropdown") {
      const cur = wireOf(f, start);
      const sel = h("select", { class: "tfs-input tfs-select", id });
      sel.append(h("option", { value: "", text: "— not set —" }));
      for (const o of optionsWithCurrent(f.options, cur)) sel.append(h("option", { value: o.value, text: o.label }));
      sel.value = cur == null ? "" : cur;
      let touched = false;
      sel.addEventListener("change", () => { touched = true; });
      wrap.append(sel);
      get = () => controlValue(touched, () => (sel.value === "" ? null : sel.value), cur);
    } else if (k === "checkbox") {
      const init = wireOf(f, start);
      const cb = h("input", { type: "checkbox", class: "tfs-check", id });
      cb.checked = init === true;
      let touched = false;
      cb.addEventListener("change", () => { touched = true; });
      wrap.classList.add("tfs-field--inline");
      wrap.prepend(cb);
      // An untouched box reports what it was given, so a null never turns into a sent `false`.
      get = () => controlValue(touched, () => cb.checked, init);
    } else {
      const type = { url: "url", email: "email", number: "number", date: "date" }[k] || "text";
      const v = wireOf(f, start);
      const multiline = type === "text" && textControlTag(v) === "textarea";
      const inp = multiline
        ? h("textarea", { class: "tfs-input tfs-textarea", id })
        : h("input", { class: "tfs-input", type, id });
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
      // Untouched → the initial value exactly (`controlValue`): never what the browser kept.
      get = () => controlValue(touched,
        () => (inp.value === "" ? null : type === "number" ? wireOf(f, inp.value) : inp.value), v);
    }
    if (f.note) wrap.append(h("p", { class: "tfs-field__note", text: f.note }));
    if (f.help) wrap.append(h("p", { class: "tfs-field__help", text: f.help }));
    this._controls.set(f.name, get);
    return wrap;
  }

  /* A multi-value dropdown: chips plus an "Add…" select. `add_only` keeps existing chips. */
  _multiDropdown(wrap, f, id, start) {
    let vals = (start || []).slice();
    const locked = new Set(f.add_only ? vals : []);
    const chips = h("div", { class: "tfs-chips" });
    const sel = h("select", { class: "tfs-input tfs-select", id });
    const draw = () => {
      chips.replaceChildren(...vals.map((v) => {
        const opt = optionsWithCurrent(f.options, vals).find((o) => o.value === v);
        const chip = h("span", { class: "tfs-chip" }, h("span", { text: opt ? opt.label : v }));
        if (!locked.has(v)) chip.append(h("button", { type: "button", class: "tfs-chip__x", "aria-label": `Remove ${v}`, text: "×",
          onclick: () => { vals = vals.filter((x) => x !== v); draw(); } }));
        return chip;
      }));
      sel.replaceChildren(h("option", { value: "", text: "Add…" }),
        ...(f.options || []).filter((o) => !vals.includes(o.value)).map((o) => h("option", { value: o.value, text: o.label })));
    };
    sel.addEventListener("change", () => { if (sel.value && !vals.includes(sel.value)) { vals.push(sel.value); draw(); } });
    draw();
    wrap.append(chips, sel);
    return () => vals.slice();
  }

  /** The current wire values: every shown control, plus hidden presets. */
  currentValues() {
    const out = { ...this._hidden };
    for (const [n, get] of this._controls) out[n] = get();
    return out;
  }

  /** What a save would send now (only changed fields). */
  changes() { return payloadFor(this._byName || {}, this._initial, this.currentValues()); }

  async save() {
    if (!this.machine || formLocked(this.machine.busy(), this._rereading)) return;
    if (this.machine.state === "outcome_unknown" && !this.machine.isUpdate) return;
    const bad = [...this._checks.values()].map((c) => c()).filter(Boolean);
    if (bad.length) {
      this._renderStatus({ tone: "error", lines: bad, link: null, actions: [] });
      return;
    }
    const fields = this.changes();
    if (!Object.keys(fields).length) {
      this._renderStatus({ tone: "info", lines: ["Nothing to save — nothing has changed."], link: null, actions: [] });
      return;
    }
    await this.machine.submit(fields);
  }

  /* The status area and the Save button, from the machine. No side effects: `_build` calls it. */
  _paint(m) {
    if (!this._status) return;
    this._renderStatus(stateView(m.state, m.receipt, { isUpdate: m.isUpdate, tokenStale: m.tokenStale }));
    const lock = formLocked(m.busy(), this._rereading);
    this._saveBtn.disabled = lock || (m.state === "outcome_unknown" && !m.isUpdate);
    if (this._fieldset) {
      this._fieldset.disabled = lock;
      // contenteditable ignores a disabled fieldset; the editor locks itself.
      this._fieldset.querySelectorAll("tfs-rich-text").forEach((r) => { r.disabled = lock; });
    }
  }

  _onState(m) {
    this._paint(m);
    this.dispatchEvent(new CustomEvent("tfs-state", { bubbles: true, detail: { state: m.state, receipt: m.receipt } }));
    if (m.state === "saved_syncing") this._afterSave(m.receipt);
  }

  _renderStatus(view) {
    const box = this._status;
    box.className = `tfs-form__status tfs-tone-${view.tone}`;
    box.replaceChildren(...view.lines.map((t) => h("p", { text: t })));
    if (view.link) {
      const href = safeHref(view.link.href);
      box.append(href
        ? h("a", { href, target: "_blank", rel: "noopener", class: "tfs-link", text: view.link.text })
        : h("p", { class: "tfs-form__checkhint", text: `${view.link.text}.` }));
    }
    const act = { save_anyway: ["Save anyway", () => this.machine.confirm(), "tfs-btn--primary"],
      cancel: ["Cancel", () => this.machine.cancel(), "tfs-btn--quiet"],
      retry: ["Try again", () => this.machine.retry(), ""] };
    if (view.actions.length) {
      box.append(h("div", { class: "tfs-form__actions" }, ...view.actions.map((a) =>
        h("button", { type: "button", class: `tfs-btn ${act[a][2]}`, text: act[a][0], onclick: act[a][1] }))));
    }
  }

  async _afterSave(receipt) {
    this.dispatchEvent(new CustomEvent("tfs-saved", { bubbles: true, detail: receipt }));
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
        const view = stateView("saved_syncing", receipt, { isUpdate: true });
        view.lines[0] = "Saved — refresh to see the latest";
        this._paint(this.machine);          // unlock (the re-read is over)
        this._renderStatus(view);
        return;
      }
      this.record = rec;
      this.machine.refreshToken(rec.row_version);
      if (rec.source) this.machine.source = rec.source;
    }
    // Redraw the fields from the new initial values (a create starts a fresh record); the
    // status keeps saying "Saved" because the machine is still in saved_syncing.
    if (this.machine.state === "saved_syncing") this._build();
  }
}
