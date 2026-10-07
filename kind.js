/* TFS pages kit — <tfs-kind>: says what kind of record a card, drawer or pop-up shows.
 *
 *   <tfs-kind table="tasks"></tfs-kind>                    → TASK
 *   <tfs-kind table="tasks" label="Sub-task"></tfs-kind>   → SUB-TASK (same colour as a task)
 *   <tfs-kind table="kms_entries"></tfs-kind>              → KMS ENTRY
 *
 * 2026-10-07: a person opening a drawer or a pop-up should never have to work out whether
 * they are looking at a task, a project or a KMS entry. So every record card, drawer and pop-up
 * on a page carries one of these at the top. `table` is the same table name the write tools and
 * <tfs-record-form> use; each kind has its own colour, so the eye learns them.
 */
const Base = globalThis.HTMLElement || class {};

/** table name → [label, colour class]. A table not listed shows its name in human form. */
export const KINDS = {
  tasks: ["Task", "task"],
  projects: ["Project", "project"],
  project_updates: ["Project update", "update"],
  kms_entries: ["KMS entry", "kms"],
  impact: ["Impact", "impact"],
  impact_tracking: ["Impact", "impact"],
  okrs: ["OKR", "okr"],
  workstreams: ["Workstream", "project"],
  contacts: ["Contact", "person"],
  organizations: ["Organisation", "person"],
  events: ["Event", "event"],
  leave: ["Leave", "event"],
  questions: ["Question", "update"],
  content_calendar: ["Content", "kms"],
  risk_register: ["Risk", "update"],
};

/** The label and colour class for a table: `{label, tone}`. Unknown tables are humanised
 * ("power_maps" → "Power map") with the neutral tone, never shown raw. */
export function kindOf(table, label = null) {
  const k = KINDS[table];
  if (k) return { label: label || k[0], tone: k[1] };
  const human = String(table || "Record").replace(/_/g, " ").replace(/s$/, "");
  return { label: label || human.charAt(0).toUpperCase() + human.slice(1), tone: "neutral" };
}

export class TfsKind extends Base {
  static get observedAttributes() { return ["table", "label"]; }
  connectedCallback() { this._render(); }
  attributeChangedCallback() { if (this.isConnected) this._render(); }
  _render() {
    const { label, tone } = kindOf(this.getAttribute("table"), this.getAttribute("label"));
    // classList, not className: a page may add classes of its own to the element.
    for (const c of [...this.classList]) if (c.startsWith("tfs-kind--")) this.classList.remove(c);
    this.classList.add("tfs-kind", `tfs-kind--${tone}`);
    this.textContent = label;
  }
}
