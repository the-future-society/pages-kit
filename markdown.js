/* TFS pages kit — Markdown <-> rich text over a closed subset of Markdown.
 *
 * ⛔ PORTED VERBATIM from TFS's own review page (the block that starts "Markdown <-> rich text,
 * over a CLOSED subset." and ends with `htmlToMd`). Do not change the logic here: that page
 * moves onto this kit only once the two are proven to behave identically, and a parity test in
 * TFS's source repository fails if this block and the page's drift apart. Fix a defect in BOTH
 * places, in the same change.
 *
 * Only this header and the `export` line at the bottom are new.
 */
/* ===========================================================================
   Markdown <-> rich text, over a CLOSED subset.

   **THE SUBSET IS THE WHOLE SAFETY ARGUMENT.** This is not a general Markdown
   engine and must never become one: round-tripping arbitrary Markdown is
   genuinely hard, and round-tripping the narrow dialect a capture run emits is
   not. Everything here was verified to render through Coda's own path on
   2026-09-17, construct by construct, on live rows.

   ⛔ WHAT IS DELIBERATELY ABSENT, because Coda's renderer DESTROYS it:
     - TABLES. Pipes are stripped and every cell runs together into the
       preceding paragraph. The MEANING goes, not the formatting, and the write
       reports success.
     - `> [!NOTE]` callouts — rendered as a plain quote with the label as text.
     - inline colour spans — left in the prose as raw markup.
   A capture run is instructed not to emit any of them. If one appears anyway,
   that is a bug in the skill, not a case for this file to handle: the field
   falls back to a plain box so a person sees exactly what will be written.

   ⛔ HAND-WRITTEN, NOT A LIBRARY. A general serialiser normalises things nobody
   asked it to — list markers, emphasis characters, line breaks — and every one
   of those is a silent edit to somebody's text.
   ========================================================================= */

const MD_INLINE_RE = /(\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|\[[^\]]+\]\([^)\s]+\))/g;

function esc_(t){ return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function mdInline(text){
  return esc_(text).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
                   .replace(/(^|[^*])\*([^*]+)\*/g,'$1<em>$2</em>')
                   .replace(/~~([^~]+)~~/g,'<s>$1</s>')
                   .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
                            /* A `javascript:` or `data:` URL in a cell must not become a
                               clickable link on a page that signs people in. Anything but
                               http, https and mailto renders as plain text, which is what
                               the cell honestly contains. */
                            (m,t,u)=>/^(https?:|mailto:)/i.test(u)
                              ? `<a href="${u.replace(/"/g,'&quot;')}">${t}</a>`
                              : `${t} (${u})`);
}

/* Markdown -> HTML for the editing surface. Line-based, because every block in
   the subset is identifiable from the start of its own line. */
function mdToHtml(md){
  const lines = String(md==null?'':md).replace(/\r\n?/g,'\n').split('\n');
  const out=[]; let para=[]; let items=[];
  /* A paragraph's single line breaks are KEPT (as <br>). They were joined with a space, so a
     "Plan for next week:" line under a paragraph was silently merged into it on save. */
  const flushPara=()=>{ if(para.length){ out.push(`<p>${para.map(mdInline).join('<br>')}</p>`); para=[]; } };
  /* ⛔ LISTS NEST. Every bullet used to be read as top-level whatever its indent, so a nested
     list Claude drafted was flattened the moment the card opened, and saved flat (a reported
     bug). Items are collected with their indent, then built as a tree: an item more
     indented than the one before it is that item's child, inside its <li>. */
  const flushList=()=>{ if(items.length){ out.push(buildList(items)); items=[]; } };
  for(const raw of lines){
    const line = raw.replace(/\s+$/,'');
    /* A blank line between two list items does NOT end the list. Coda writes lists that way,
       and so does Claude; ending the list there made every numbered item a one-item list, so
       the card showed "1. 1. 1." and an edit saved it that way (a reported bug). The
       list ends at the first line after the gap that is not a list item. */
    if(!line.trim()){ flushPara(); continue; }
    let m;
    if(!items.length || !/^\s/.test(line)){
      if((m = line.match(/^(#{1,3})\s+(.*)$/))){
        flushPara(); flushList();
        out.push(`<h${m[1].length}>${mdInline(m[2])}</h${m[1].length}>`); continue;
      }
      if((m = line.match(/^>\s?(.*)$/))){
        flushPara(); flushList();
        out.push(`<blockquote>${mdInline(m[1])}</blockquote>`); continue;
      }
    }
    if((m = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/))){
      flushPara(); items.push({indent:m[1].length, tag:'ul', task:m[2].toLowerCase()==='x'?'x':' ', text:m[3]}); continue;
    }
    if((m = line.match(/^(\s*)[-*+]\s+(.*)$/))){
      flushPara(); items.push({indent:m[1].length, tag:'ul', text:m[2]}); continue;
    }
    if((m = line.match(/^(\s*)\d+[.)]\s+(.*)$/))){
      flushPara(); items.push({indent:m[1].length, tag:'ol', text:m[2]}); continue;
    }
    flushList();
    para.push(line);
  }
  flushPara(); flushList();
  return out.join('') || '<p></p>';
}
/* A run of list items -> nested <ul>/<ol>. Indent is compared RELATIVELY (more than the
   parent's = child), so two-space, three-space and four-space nesting all read the same. */
function buildList(items){
  const liHTML=(it)=>it.task!=null
    /* The tick-box is a real element inside the item, so it can be clicked. `htmlToMd` skips
       it by class, so it never becomes part of the text. */
    ? `<li data-task="${it.task}"><span class="tick" contenteditable="false" role="checkbox" `
      + `aria-checked="${it.task==='x'}" tabindex="0">${it.task==='x'?'✓':''}</span>${mdInline(it.text)}`
    : `<li>${mdInline(it.text)}`;
  let i=0;
  const level=(indent)=>{
    let html=''; let tag=null;
    while(i<items.length && items[i].indent>=indent){
      const it=items[i];
      if(tag && it.tag!==tag && it.indent===indent){ html+=`</${tag}>`; tag=null; }
      if(!tag){ tag=it.tag; html+=`<${tag}>`; }
      i++;
      html+=liHTML(it);
      if(i<items.length && items[i].indent>it.indent) html+=level(items[i].indent);
      html+='</li>';
    }
    return html+(tag?`</${tag}>`:'');
  };
  let html='';
  while(i<items.length) html+=level(items[i].indent);
  return html;
}

/* HTML -> Markdown. A walk over the node types the subset allows, and nothing
   else: an unrecognised element contributes its TEXT, never its markup, so a
   paste from elsewhere degrades to prose rather than smuggling a construct
   through. */
function htmlToMd(root){
  const BLOCK = /^(P|DIV|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|UL|OL|LI|PRE)$/;
  const inline = (node, skipLists) => {
    let s='';
    node.childNodes.forEach(n=>{
      if(n.nodeType===3){ s += n.nodeValue.replace(/\s+/g,' '); return; }
      const tag = n.nodeName.toLowerCase();
      /* A list inside a list item is its CHILD list, serialised on its own lines below. */
      if(skipLists && (tag==='ul'||tag==='ol')) return;
      /* The tick-box is furniture, not text. Without this its glyph would be serialised into
         the note and written to Coda as a stray character. */
      if(n.classList && n.classList.contains('tick')) return;
      if(tag==='br'){ s += '\n'; return; }
      const inner = inline(n);
      if(!inner.trim() && tag!=='a'){ s += inner; return; }
      if(tag==='strong'||tag==='b') s += `**${inner}**`;
      else if(tag==='em'||tag==='i') s += `*${inner}*`;
      else if(tag==='s'||tag==='del'||tag==='strike') s += `~~${inner}~~`;
      else if(tag==='a') s += `[${inner}](${n.getAttribute('href')||''})`;
      else s += inner;
    });
    return s;
  };
  /* ⛔ WALK INTO BLOCKS, DO NOT ASSUME A FLAT DOCUMENT. `execCommand('insertUnorderedList')`
     in Chrome produces `<p><ul><li>…</li></ul></p>` — the list NESTED INSIDE the paragraph.
     A converter that only read top-level nodes saw a paragraph, serialised its text, and
     dropped the list: the Bullets button did nothing, visibly, and nothing errored. A
     hand-written serialiser over browser-generated HTML has to handle what the browser
     actually emits, not the tidy shape it would emit if it were being helpful. */
  const hasBlockChild = (n) => [...n.childNodes].some(
    c => c.nodeType===1 && BLOCK.test(c.nodeName));

  /* A list and everything nested in it, as Markdown lines. A child list is indented to its
     parent item's TEXT (two spaces under "- ", three under "1. "), which is what CommonMark and
     Coda's renderer both read as nesting. Chrome's indent command puts the child list BESIDE
     the item (<ul><li>a</li><ul>…</ul></ul>) rather than inside it; that is read as a child of
     the item before it. */
  const listMd = (list, pad) => {
    const tag=list.nodeName.toLowerCase(); const lines=[]; let k=0; let lastMarker='- ';
    list.childNodes.forEach(c=>{
      const ct=c.nodeName.toLowerCase();
      if(ct==='ul'||ct==='ol'){ lines.push(...listMd(c, pad+' '.repeat(lastMarker.length))); return; }
      if(ct!=='li') return;
      const task = c.getAttribute && c.getAttribute('data-task');
      const body = inline(c, true).trim();
      k+=1;
      lastMarker = tag==='ol' ? `${k}. ` : '- ';
      const tick = (task!=null && task!=='') ? `[${task.trim()?'x':' '}] ` : '';
      /* An empty item left by an indent/outdent is still a line, or the nesting under it shifts. */
      lines.push(pad+lastMarker+tick+body);
      c.childNodes.forEach(g=>{
        const gt=g.nodeName.toLowerCase();
        if(gt==='ul'||gt==='ol') lines.push(...listMd(g, pad+' '.repeat(lastMarker.length)));
      });
    });
    return lines;
  };
  const blocks=[];
  const walk = (node) => {
    node.childNodes.forEach(n=>{
      if(n.nodeType===3){ const t=n.nodeValue.trim(); if(t) blocks.push(t); return; }
      if(n.nodeType!==1) return;
      const tag=n.nodeName.toLowerCase();
      if(tag==='ul'||tag==='ol'){
        const lines=listMd(n,'');
        if(lines.length) blocks.push(lines.join('\n'));
        return;
      }
      /* A container that holds other blocks contributes nothing itself — recurse past it. */
      if(hasBlockChild(n)){ walk(n); return; }
      if(/^h[1-3]$/.test(tag)){ const t=inline(n).trim(); if(t) blocks.push('#'.repeat(+tag[1])+' '+t); return; }
      if(tag==='blockquote'){ const t=inline(n).trim(); if(t) blocks.push('> '+t); return; }
      const t=inline(n).trim(); if(t) blocks.push(t);
    });
  };
  walk(root);
  return blocks.filter(Boolean).join('\n\n');
}

export { MD_INLINE_RE, esc_, mdInline, mdToHtml, buildList, htmlToMd };
