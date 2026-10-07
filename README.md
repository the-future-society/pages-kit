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

## Events

Dispatched on the element; they bubble, and cross shadow roots (composed).

- `tfs-loaded` — (form) the form description (and the record, in edit mode) has loaded. `detail: { form, record }`.
- `tfs-state` — (form) the save state changed. `detail: { state, receipt }`.
- `tfs-saved` — a save was confirmed. From a form, `detail` is the save receipt; from `<tfs-status-menu>`, `detail: { table, row, field, value, receipt }`.
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
