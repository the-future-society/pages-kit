# @thefuturesociety/pages-kit

The front-end kit behind The Future Society's staff pages: a few custom elements that render a
record form (create or edit) against the TFS MCP Server, with pickers for linked records, rich
text, and explicit save states; a status chip that saves on pick; and a delete confirmation for
tasks. Zero runtime dependencies, plain ES modules, no build step.

It is built for claude.ai artifacts: the page talks to the server through the artifact's MCP
connection, never with credentials of its own.

## Use it in a page

```html
<script type="module">import "https://unpkg.com/@thefuturesociety/pages-kit@1/kit.js";</script>
<tfs-record-form table="tasks" mode="create"></tfs-record-form>
```

Importing `kit.js` brings the kit's styles: it adds one `<style data-tfs-kit>` element as the
first child of `<head>`, so the page's own styles still win ties. **Do not `<link>` `kit.css`.**
claude.ai artifact pages admit stylesheets only from the artifact itself and Google Fonts, so a
stylesheet from a CDN is blocked and the forms render unstyled. Pages that inline the CSS
themselves can set `data-tfs-no-kit-css` on `<html>` to skip the injection.

Edit an existing record, showing only some fields:

```html
<tfs-record-form table="tasks" mode="edit" row="ROW-ID-HERE" fields="status"></tfs-record-form>
```

## Artifact manifest

The artifact must declare the TFS MCP Server's four page tools in its `mcp` manifest:

- `describe_record_form`
- `get_record_for_editing`
- `search_records_for_picker`
- `save_record`

`<tfs-status-menu>` uses `describe_record_form`, `get_record_for_editing` and `save_record`
(already in that list). A page that uses `<tfs-delete-task>` also declares `delete_record`.

## `<tfs-record-form>` attributes

| Attribute | Meaning |
| --- | --- |
| `table` | The table to write to (required). |
| `mode` | `create` or `edit`. Defaults to `edit` when `row` is set, else `create`. |
| `row` | The record's row id (edit mode). |
| `fields` | Comma-separated list of fields to show; omit for the whole form (its "more" fields then sit behind a "More fields" disclosure). |
| `presets` | JSON object of values to pre-fill on a create. |
| `save-label` | Text of the save button. Defaults to "Save changes" (edit) or "Add task" etc. (create). |
| `heading` | The form's title. Defaults to "Edit task" / "New task" (the record's kind). |
| `eyebrow` | The small line above the title. Defaults to the kind, plus the record's name on edit. |
| `bare` | Drops the form's own border and shadow, for a page that frames it itself. |

The form always has a header × and a footer Close (nothing changed) or Cancel (unsaved
changes). A status field is a coloured chip that opens the status menu; inside a form, picking
only sets the value, and the form's Save writes it.

## `<tfs-status-menu>` attributes

A status chip in the server's colour. Clicking it opens a menu of the statuses, in Coda's order;
**picking another status saves at once** (it loads the record, previews the save, and saves
unless someone changed the record since you opened it — then it asks in the menu). Escape or a
click outside closes it with no change.

| Attribute | Meaning |
| --- | --- |
| `table` | `tasks` or `projects` (default `tasks`). |
| `row` | The record's row id (required). |
| `value` | The status the page read. |
| `field` | The field to set (default `status`). |
| `display` | `menu` (default), `chip` (display only), or `context` (a finished parent kept for its open sub-tasks: a quiet label, not a chip). |

After a save, a page that redraws from a list read straight away gets the old status back for a
few minutes; the chip then shows the saved status with "Saved; waiting for TFS to catch up".

**Refresh from Coda.** The menu's foot carries a quiet "Refresh from Coda", for the rare case a
change made in Coda hasn't reached the page (TFS's copy is refreshed by Coda's change
notifications, and Coda's API can briefly answer with the old row). It calls
`get_record_for_editing` with `refresh: true` — no extra tool — and shows what happened:
"Updated from Coda", or that Coda had nothing newer *yet*. It never promises the record is now
up to date. It sends **`tfs-refreshed`** (`detail: {table, row, field, outcome, value}`); a page
that lists records should redraw that row or its list on it.

## `<tfs-delete-task>` attributes

A Delete button for ONE task. It asks first, in a modal dialog: `delete_record` previews, the
person confirms, and only then is the task deleted. Refusals (not theirs, has sub-tasks) show the
server's sentence. The element is `display: block`; set `tfs-delete-task { display: inline-block }`
to sit it in a row.

| Attribute | Meaning |
| --- | --- |
| `row` | The task's row id (required). |
| `title` | The task's title, for the question until the server's answer arrives. |
| `no-button` | Render nothing; the page calls the element's `open()` itself. |

## `<tfs-task-filters>` — a task filter bar each viewer can extend

```html
<tfs-task-filters bar="mine,closed,snoozed" more="owner,created,urgency,due" storage-key="my-page-filters"></tfs-task-filters>
```

The page's builder decides what is always on the bar (`bar`). Each viewer adds the rest from
**+ More filters** (`more`); what they add, and the values they set, are remembered in their own
browser under `storage-key`. A viewer who never opens the menu sees only the builder's choice.

| Filter | Kind | Meaning |
| --- | --- | --- |
| `mine` | toggle | Tasks the viewer owns. |
| `closed` | toggle | Show finished tasks — the page reloads its tree with `open_only: false`. |
| `snoozed` | toggle | Show snoozed tasks. **Off by default: snoozed tasks are hidden, as in Coda.** |
| `owner` | chooser | One team member (the kit's people picker). |
| `created` | chooser | Who created the task. |
| `urgency` | chooser | One or more levels, in Coda's order, from `describe_record_form`. |
| `due` | chooser | Overdue, due in 7 or 30 days, or no due date. |

It needs **no extra tools**: the people picker uses `search_records_for_picker` and the urgency
list `describe_record_form`, both already in every kit page's manifest. It filters rows the page
has already loaded:

```js
import { normaliseTree, markSnoozed, hideSnoozed, filterTree } from ".../kit.js";
const bar = document.querySelector("tfs-task-filters");
const tree = markSnoozed(normaliseTree(await callTool("get_task_tree", { project, closed_parents: "context" })));
function draw() {
  const v = bar.values;                              // e.g. {snoozed: true, urgency: ["1🔴 Critical"]}
  const shown = filterTree(v.snoozed ? tree : hideSnoozed(tree), bar.matcher({ me: viewerRowId }));
  // render `shown`: `_hit: false` = an ancestor kept for a match below it; `_snoozedContext` = a
  // snoozed parent kept for another owner's awake sub-tasks (show both muted)
}
bar.addEventListener("tfs-filters-change", draw);
```

`el.values` is what is in force; `el.matcher({me})` is one predicate (null when nothing
narrows); `el.clear()` empties the narrowing filters (the closed/snoozed toggles stay). The
**snooze rule** is the server's: snoozed while the snooze date is after today, and a sub-task
inherits its parent's snooze while it has the same owner. Use `markSnoozed`; never re-write it.

## `<tfs-kind>` — what kind of record this is

```html
<tfs-kind table="tasks"></tfs-kind>                    <!-- TASK -->
<tfs-kind table="tasks" label="Sub-task"></tfs-kind>   <!-- SUB-TASK, a task's colour -->
<tfs-kind table="kms_entries"></tfs-kind>              <!-- KMS ENTRY -->
```

Put one at the top of every record card, drawer and pop-up, so nobody has to work out whether
they are looking at a task, a project or a KMS entry. `table` is the name the forms use; each
kind has its own colour. `label` changes the words, not the colour. An unknown table shows in
human form ("power_maps" → "Power map"), never raw. `kindOf(table, label)` gives the same
`{label, tone}` for a page that draws its own markup.

## Task helpers and exact counts (`tasks.js`)

| Export | What it does |
| --- | --- |
| `normaliseTree(result)` | `get_task_tree`'s answer → nested nodes, Coda's project-header task folded away. |
| `markSnoozed(nodes, today?)` / `hideSnoozed(nodes)` | The snooze rule, and the tree without snoozed tasks. |
| `taskMatcher(values, {me})` / `filterTree(nodes, pred)` | Filter values → predicate; keep matches and their ancestors. |
| `treeCounts(nodes, {showSnoozed})` | `{open, overdue, snoozed}` for a loaded tree. |
| `countTasks(transport, args)` | **An exact count of any `search_tasks` query without fetching the rows.** |
| `formatCount(c)` | `"12"`, or `"12+"` when the count is only a floor. |
| `hoursOf("2 hrs")` | A task's "time required" in hours (a day is 8); 0 when blank or unknown. |

**A count on a page is exact or it says it is not.** Every search tool caps its list, so
counting the rows of a capped list gives a number that is too low, with no error. `countTasks`
asks for one row and reads the server's `total_matched`; it resolves `{n, exact}`, and
`exact: false` (the server cut the list and sent no total) must be shown as `n+`. For a
dashboard, one `countTasks` per box: `{project, overdue_only: true}`,
`{project, due_date_state: "undated"}`, `{project, status: "Complete", open_only: false}`, and
so on. State on the page how each number is worked out.

## When Coda hasn't confirmed a save yet (1.5.0)

For some people the TFS server shows a save on pages at once, before Coda has confirmed it. Its
`save_record` receipt and `get_record_for_editing` then carry `confirmation: {state, since,
pending_fields, message, values_sent?}`, `state` being `unconfirmed`, `confirmed`, `failed` or
`not_in_view`. When the field is absent, the kit behaves exactly as 1.4.0 did. When it is present:

- **Saved, waiting.** The form's footer says "Saved — waiting for Coda to confirm", and each
  field Coda fills in itself (`pending_fields`) says "Coda is still filling this in". The kit
  asks `get_record_for_editing` every 15 seconds, for at most 10 minutes. On confirmation it
  shows Coda's values (unless the person is editing) and sends `tfs-confirmed`; after 10
  minutes it stops and says Coda usually confirms within the hour.
- **A new record stays open.** After a create, the form switches to editing the new record, so
  a slip can be fixed at once. Closing it (× or Close) returns it to a blank create form.
- **Editing a record Coda is still creating.** Coda refuses an edit for the few minutes a create
  takes. The form says "Coda is still creating this task" and saves the change by itself once
  Coda confirms the record: the same fields under the same idempotency key, once, so it never
  saves twice. After 10 minutes it stops and asks the person to save again. A create is never
  retried. The machine's state meanwhile is `waiting_for_coda` (busy). The form asks the
  person to keep it open; pressing Close (or closing the status menu) asks "Your change hasn't
  saved yet. Close anyway and lose it?", and Keep waiting keeps the wait. In a `<dialog>`, Escape
  is held back for the same question, and a dialog the page closes meanwhile is reopened with it. Every end of the wait
  (saved, not saved, a clash with someone else's change, an unknown outcome) shows in the open
  form. If the page itself moves the form to another record mid-wait, the change still saves,
  and if it does not, the form says so. Removing a form stops its polling, except for a change
  that is waiting.
- **Coda didn't keep it.** A banner gives the server's plain-words reason, with **Re-edit**
  (an edit: what was sent goes back into the form, unsaved), **Recreate** (a record Coda never
  added: a new-record form prefilled with what was sent) and **Open in Coda** when a link is
  known. A record that is in Coda but not visible to pages (`not_in_view`) gets no Recreate,
  because recreating it would make a duplicate.

`<tfs-status-menu>` waits out the same create lag the same way (the menu stays open and asks
before closing; Refresh from Coda is held until the wait ends), and does not poll after an
ordinary pick.

## Events

Dispatched on the element; they bubble, and cross shadow roots (composed).

- `tfs-loaded` — (form) the form description (and the record, in edit mode) has loaded. `detail: { form, record }`.
- `tfs-state` — (form) the save state changed. `detail: { state, receipt, confirmation }`.
- `tfs-saved` — a save was confirmed. From a form, `detail` is the save receipt; from `<tfs-status-menu>`, `detail: { table, row, field, value, receipt }`.
- `tfs-confirmed` — (form) Coda confirmed a save the form was watching (see above). Re-read
  your lists on it as well as on `tfs-saved`. `detail: { table, row_id }`.
- `tfs-close` — (form) the person pressed × or Close/Cancel. **Cancellable**: unless the page calls `preventDefault()`, the kit closes the `<dialog>` the form sits in (if any) and drops unsaved edits. `detail: { dirty, state }`. A save already writing carries on.
- `tfs-deleted` — (`<tfs-delete-task>`) the task was deleted. `detail: { table, row, title, receipt }`.

## Status colours

Every status chip takes its colour from the server (`describe_record_form` serves each option's
`color`, Coda's own). `paintStatusChip(el, hex)` (exported) sets the fill and picks white or
dark text for contrast; no colour sent gives a neutral chip. The kit never maps a status name to
a colour.

## Styling

Colours, type and radius come from `--tfs-*` custom properties (for example `--tfs-accent`,
`--tfs-ink`, `--tfs-surface`, `--tfs-font`, `--tfs-radius`). Override them on the form or any
ancestor. The defaults follow the viewer's light or dark preference.

## Versions

Load from unpkg, not jsDelivr. unpkg answers `@1` with a redirect to the exact latest 1.x
version, cached for 60 seconds, and the exact-version file is immutable — so a release reaches
browsers within minutes. jsDelivr caches the `@1` range itself for 7 days, so a browser that
fetched a broken release keeps it for a week. Do not pin `@1.x.y`: a pinned page never receives
a fix. The current version is exported as `KIT_VERSION`.

## Licence

MIT, Copyright (c) 2026 The Future Society. Source:
https://github.com/the-future-society/pages-kit.

That repository is a mirror: the kit is developed in The Future Society's private repository and
copied there for each release, which is published to npm from it with provenance. See its
`CONTRIBUTING.md`; bug reports are welcome as issues there.
