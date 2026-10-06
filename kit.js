/* TFS pages kit — the one file a page loads.
 *
 *   <script type="module">
 *     import { configure, createTransport } from ".../kit.js";
 *     // optional: the default is the claude.ai artifact transport (`claude.use("mcp")`)
 *     configure({ transport: createTransport({ kind: "artifact" }) });
 *   </script>
 *   <tfs-record-form table="tasks" mode="create"></tfs-record-form>
 *   <tfs-record-form table="tasks" mode="edit" row="i-…" fields="status"></tfs-record-form>
 *
 * The artifact must declare the TFS MCP Server's four page tools in its `mcp` manifest:
 * describe_record_form, get_record_for_editing, search_records_for_picker, save_record.
 *
 * Importing this file brings the kit's styles: do NOT <link> kit.css. claude.ai artifact pages
 * admit stylesheets only from the artifact itself and Google Fonts, so a CDN stylesheet is
 * blocked and every form renders unstyled. A page that inlines kit.css itself sets
 * data-tfs-no-kit-css on <html> to skip the injection.
 */
export const KIT_VERSION = "1.0.1";
export { SERVER, KIT_CONTRACT, createTransport, kitError, checkContract, unwrap } from "./transport.js";
export { SaveMachine, STATES } from "./save.js";
export { mdToHtml, htmlToMd, mdInline } from "./markdown.js";
export {
  TfsRecordForm, TfsPicker, TfsRichText, configure, selectFields, dirtyFields, wireOf, payloadFor,
  stateView, optionsWithCurrent, groupLines, richTextValue, TOOLBAR_COMMANDS, controlValue,
  textControlTag, safeHref, allowedLinkHref, LINK_REFUSED, badInputMessage, isEditable,
  initialAfterUnreadSave, formLocked, lockedByFieldset,
} from "./form.js";
import { TfsRecordForm, TfsPicker, TfsRichText } from "./form.js";
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
  for (const [name, cls] of [["tfs-rich-text", TfsRichText], ["tfs-picker", TfsPicker], ["tfs-record-form", TfsRecordForm]]) {
    if (!customElements.get(name)) customElements.define(name, cls);
  }
}
