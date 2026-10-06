/* TFS pages kit — the one file a page loads.
 *
 *   <link rel="stylesheet" href=".../kit.css">
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
 */
export const KIT_VERSION = "1.0.0";
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

if (globalThis.customElements) {
  for (const [name, cls] of [["tfs-rich-text", TfsRichText], ["tfs-picker", TfsPicker], ["tfs-record-form", TfsRecordForm]]) {
    if (!customElements.get(name)) customElements.define(name, cls);
  }
}
