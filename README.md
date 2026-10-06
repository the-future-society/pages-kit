# @thefuturesociety/pages-kit

The front-end kit behind The Future Society's staff pages: a few custom elements that render a
record form (create or edit) against the TFS MCP Server, with pickers for linked records, rich
text, and explicit save states. Zero runtime dependencies, plain ES modules, no build step.

It is built for claude.ai artifacts: the page talks to the server through the artifact's MCP
connection, never with credentials of its own.

## Use it in a page

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@thefuturesociety/pages-kit@1/kit.css">
<script type="module">import "https://cdn.jsdelivr.net/npm/@thefuturesociety/pages-kit@1/kit.js";</script>
<tfs-record-form table="tasks" mode="create"></tfs-record-form>
```

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

## `<tfs-record-form>` attributes

| Attribute | Meaning |
| --- | --- |
| `table` | The table to write to (required). |
| `mode` | `create` or `edit`. Defaults to `edit` when `row` is set, else `create`. |
| `row` | The record's row id (edit mode). |
| `fields` | Comma-separated list of fields to show; omit for the whole form. |
| `presets` | JSON object of values to pre-fill on a create. |
| `save-label` | Text of the save button. Defaults to "Save". |

## Events

Dispatched on the form element; they bubble.

- `tfs-loaded` — the form description (and the record, in edit mode) has loaded. `detail: { form, record }`.
- `tfs-state` — the save state changed. `detail: { state, receipt }`.
- `tfs-saved` — a save was confirmed. `detail` is the save receipt.

## Styling

Colours, type and radius come from `--tfs-*` custom properties (for example `--tfs-accent`,
`--tfs-ink`, `--tfs-surface`, `--tfs-font`, `--tfs-radius`). Override them on the form or any
ancestor. The defaults follow the viewer's light or dark preference.

## Versions

`@1` follows the latest 1.x within jsDelivr's cache window. Pin `@1.x.y` if you need a fix
immediately. The current version is exported as `KIT_VERSION`.

## Licence

MIT, Copyright (c) 2026 The Future Society. Source:
https://github.com/the-future-society/pages-kit.

That repository is a mirror: the kit is developed in The Future Society's private repository and
copied there for each release, which is published to npm from it with provenance. See its
`CONTRIBUTING.md`; bug reports are welcome as issues there.
