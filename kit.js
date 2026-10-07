/* TFS pages kit — the one file a page loads.
 *
 *   <script type="module">
 *     import { configure, createTransport } from "https://unpkg.com/@thefuturesociety/pages-kit@1/kit.js";
 *     // optional: the default is the claude.ai artifact transport (`claude.use("mcp")`)
 *     configure({ transport: createTransport({ kind: "artifact" }) });
 *   </script>
 *   <tfs-record-form table="tasks" mode="create"></tfs-record-form>
 *   <tfs-record-form table="tasks" mode="edit" row="i-…" fields="status"></tfs-record-form>
 *   <tfs-status-menu table="tasks" row="i-…" value="In Progress"></tfs-status-menu>
 *   <tfs-delete-task row="i-…" title="Draft the brief"></tfs-delete-task>
 *   <tfs-task-filters bar="mine,closed,snoozed"></tfs-task-filters>   (task filter bar; see tasks.js)
 *   <tfs-kind table="tasks"></tfs-kind>   (says what kind of record a card or drawer shows)
 *
 * The artifact must declare the TFS MCP Server's four page tools in its `mcp` manifest:
 * describe_record_form, get_record_for_editing, search_records_for_picker, save_record —
 * plus delete_record when the page uses <tfs-delete-task>.
 *
 * Importing this file brings the kit's styles: do NOT <link> kit.css. claude.ai artifact pages
 * admit stylesheets only from the artifact itself and Google Fonts, so a CDN stylesheet is
 * blocked and every form renders unstyled. A page that inlines kit.css itself sets
 * data-tfs-no-kit-css on <html> to skip the injection.
 *
 * Load from unpkg, not jsDelivr: unpkg 302s `@1` to the exact version (60-second cache) and that
 * file is immutable, so a release reaches browsers in minutes; jsDelivr caches `@1` for 7 days.
 */
export const KIT_VERSION = "1.5.2";
export { SERVER, KIT_CONTRACT, createTransport, kitError, checkContract, unwrap } from "./transport.js";
export {
  SaveMachine, STATES, ConfirmWatch, confirmationKind, looksLikeCreateLag, POLL_EVERY_MS, POLL_LIMIT_MS,
  WAIT_TIMEOUT, WAIT_ENDED,
} from "./save.js";
export { mdToHtml, htmlToMd, mdInline } from "./markdown.js";
export {
  TfsRecordForm, TfsPicker, TfsRichText, configure, selectFields, dirtyFields, wireOf, payloadFor,
  stateView, formView, conflictCopy, menuNav, nounOf, countLabel, addPhrase, relativeTime,
  missingRequired, refusalView, initials, markMatch, isStatusField, StatusMenu, pickAction,
  optionsWithCurrent, groupLines, richTextValue, TOOLBAR_COMMANDS, controlValue,
  textControlTag, safeHref, allowedLinkHref, LINK_REFUSED, badInputMessage, isEditable,
  initialAfterUnreadSave, formLocked, lockedByFieldset,
  CONFIRM_WORDS, waitingCopy, failureNotice, nextRowAfterCreate,
} from "./form.js";
export {
  TfsStatusMenu, TfsDeleteTask, StatusSave, DeleteFlow, deleteView, deleteBody, syncingValue, statusOutcome,
  STATUS_WORDS,
} from "./actions.js";
export { statusChipColours, paintStatusChip } from "./status-colour.js";
export {
  todayISO, addDays, isClosedTask, isHeadingRow, normaliseTree, markSnoozed, hideSnoozed, DUE_OPTIONS, dueMatches, taskMatcher,
  filterTree, treeCounts, countTasks, formatCount, hoursOf,
} from "./tasks.js";
export { TfsKind, KINDS, kindOf } from "./kind.js";
export { TfsTaskFilters, FilterState, TOGGLES, CHOOSERS, loadUrgencyOptions, safeStorage } from "./filters.js";
import { TfsRecordForm, TfsPicker, TfsRichText } from "./form.js";
import { TfsStatusMenu, TfsDeleteTask } from "./actions.js";
import { TfsTaskFilters } from "./filters.js";
import { TfsKind } from "./kind.js";
import { KIT_CSS } from "./kit-css.js";
export { KIT_CSS };

/** Inject the kit's styles once, unless the page opted out or already has them. Returns the
 *  <style data-tfs-kit> element, or null (no DOM, or opted out). It is PREPENDED as the first
 *  child of <head>, before the page's own styles: a module script runs after the page's
 *  <style> blocks are parsed, so an appended sheet would come LAST in the cascade and beat the
 *  page's own rules of equal specificity. First, every page rule wins ties; the tokens are
 *  also at :where(:root) (zero specificity), so a page's --tfs-* overrides win either way. */
export function injectKitStyles(doc = globalThis.document) {
  if (!doc || !doc.documentElement || typeof doc.createElement !== "function") return null;
  if (doc.documentElement.hasAttribute("data-tfs-no-kit-css")) return null;
  const existing = doc.querySelector("style[data-tfs-kit]");
  if (existing) return existing;
  const style = doc.createElement("style");
  style.setAttribute("data-tfs-kit", KIT_VERSION);
  style.textContent = KIT_CSS;
  const parent = doc.head || doc.documentElement;
  parent.insertBefore(style, parent.firstChild);
  return style;
}
injectKitStyles();

if (globalThis.customElements) {
  for (const [name, cls] of [["tfs-rich-text", TfsRichText], ["tfs-picker", TfsPicker], ["tfs-record-form", TfsRecordForm],
    ["tfs-status-menu", TfsStatusMenu], ["tfs-delete-task", TfsDeleteTask], ["tfs-task-filters", TfsTaskFilters], ["tfs-kind", TfsKind]]) {
    if (!customElements.get(name)) customElements.define(name, cls);
  }
}
