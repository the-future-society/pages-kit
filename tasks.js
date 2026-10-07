/* TFS pages kit — task helpers for pages that list tasks and show team metrics.
 *
 * Pure functions (no DOM), so Node tests them whole:
 *
 *   normaliseTree(result)          get_task_tree's answer → nested nodes, shadow parents folded in
 *   markSnoozed(nodes, today)      TFS's snooze rule, applied to a tree (sets `_snoozed`)
 *   hideSnoozed(nodes)             the tree without snoozed tasks (a snoozed parent of awake
 *                                  sub-tasks stays, marked `_snoozedContext`)
 *   taskMatcher(values, ctx)       one predicate from <tfs-task-filters> values (null = no filter)
 *   filterTree(nodes, pred)        keep matches and their ancestors (`_hit` marks real matches)
 *   countTasks(transport, args)    an EXACT count of a search_tasks query, without fetching rows
 *   hoursOf("2 hrs")               a task's "time required" in hours (0 when blank or unknown)
 *
 * THE SNOOZE RULE is the server's (search_tasks `is_snoozed`): a task is snoozed while its
 * snooze date is AFTER today, and a sub-task inherits its parent's snooze while it has the same
 * owner. A task snoozed until today is awake. Never write a second version of this in a page.
 *
 * A COUNT IS EXACT OR SAYS IT IS NOT. A search tool caps its list, so counting the rows of a
 * capped list gives too low a number with no error. countTasks asks for one row and reads the
 * server's `total_matched`, which the server sends exactly when the list was cut short; it
 * returns `{n, exact}`, and `exact: false` means "at least n" — show it as "n+".
 */

/** Today in the viewer's calendar, as YYYY-MM-DD. */
export function todayISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `iso` plus `k` days, as YYYY-MM-DD (calendar days, local time). */
export function addDays(iso, k) {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return todayISO(new Date(y, m - 1, d + k));
}

const CLOSED = new Set(["Complete", "Cancelled"]);
/** A task that is finished (Complete or Cancelled) or kept only as context for open sub-tasks. */
export function isClosedTask(n) { return !!(n && (n.context_only || CLOSED.has(n.status_name))); }

/**
 * get_task_tree's answer → a list of nested nodes, each `{...row, children: [...]}`, sorted by
 * due date. A shadow parent (Coda's automatic project-header task) is not work: its children
 * take its place at the top level.
 */
export function normaliseTree(result) {
  const roots = (result && result.roots) || [];
  const byRoot = (result && result.tree_by_root) || {};
  const mk = (n) => ({ ...n, children: (n.children || []).map(mk) });
  const top = [];
  for (const root of roots) {
    const kids = (byRoot[root.coda_row_id] || []).map(mk);
    if (root.is_shadow_parent) top.push(...kids.filter((k) => !k.is_shadow_parent), ...kids.filter((k) => k.is_shadow_parent).flatMap((k) => k.children));
    else top.push({ ...root, children: kids });
  }
  const byDue = (a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999") || String(a.title || "").localeCompare(String(b.title || ""));
  const sortAll = (list) => { list.sort(byDue); list.forEach((n) => sortAll(n.children)); return list; };
  return sortAll(top);
}

/**
 * Apply the snooze rule to a tree, in place. Sets on every node:
 *   `_snoozed`       true while the task is snoozed (its own date, or inherited)
 *   `_snoozedUntil`  the date it wakes (its own, or the ancestor's it inherits), else null
 * Returns the same list.
 */
export function markSnoozed(nodes, today = todayISO(), parent = null) {
  for (const n of nodes || []) {
    const own = !!(n.snooze_until && n.snooze_until > today);
    const inherited = !!(parent && parent._snoozed && parent.owner_coda_row_id === n.owner_coda_row_id);
    n._snoozed = own || inherited;
    n._snoozedUntil = own ? n.snooze_until : inherited ? parent._snoozedUntil : null;
    markSnoozed(n.children, today, n);
  }
  return nodes;
}

/**
 * The tree with snoozed tasks taken out (run markSnoozed first). A snoozed task whose sub-tasks
 * are awake (another owner's) stays, marked `_snoozedContext`, so those sub-tasks keep their
 * place: show it muted, as a heading. Returns new node objects; the input is not changed.
 */
export function hideSnoozed(nodes) {
  const out = [];
  for (const n of nodes || []) {
    const kids = hideSnoozed(n.children);
    if (!n._snoozed) out.push({ ...n, children: kids });
    else if (kids.length) out.push({ ...n, children: kids, _snoozedContext: true });
  }
  return out;
}

/** Due-date filter choices: [value, label]. */
export const DUE_OPTIONS = [
  ["overdue", "Overdue"],
  ["7", "Due in the next 7 days"],
  ["30", "Due in the next 30 days"],
  ["none", "No due date"],
];

const idOf = (v) => (v && typeof v === "object" ? v.row_id : v) || null;

/** Does an open task's due date fit a DUE_OPTIONS value? Closed tasks never do. */
export function dueMatches(n, due, today = todayISO()) {
  if (isClosedTask(n)) return false;
  if (due === "none") return !n.due_date;
  if (!n.due_date) return false;
  if (due === "overdue") return n.due_date < today;
  const days = Number(due);
  return Number.isFinite(days) && n.due_date >= today && n.due_date <= addDays(today, days);
}

/**
 * One predicate from filter values, or null when nothing filters.
 *   values: { mine, owner, created, urgency: [...], due, query }  (owner/created: row id or {row_id})
 *   ctx:    { me: the viewer's team-member row id, today }
 * `mine` with no `me` matches nothing: the page could not tell who the viewer is, and it says so.
 */
export function taskMatcher(values = {}, { me = null, today = todayISO() } = {}) {
  const owner = idOf(values.owner), created = idOf(values.created);
  const urg = Array.isArray(values.urgency) && values.urgency.length ? new Set(values.urgency) : null;
  const due = values.due || null;
  const q = String(values.query || "").trim().toLowerCase();
  const mine = !!values.mine;
  if (!mine && !owner && !created && !urg && !due && !q) return null;
  return (n) => (!mine || (!!me && n.owner_coda_row_id === me))
    && (!owner || n.owner_coda_row_id === owner)
    && (!created || n.created_by_coda_row_id === created)
    && (!urg || urg.has(n.urgency_name))
    && (!due || dueMatches(n, due, today))
    && (!q || [n.title, n.owner_name, n.notes].filter(Boolean).join(" ").toLowerCase().includes(q));
}

/** Keep each node that matches or has a match under it. `_hit` is true on real matches; an
 * ancestor kept only for a match below it has `_hit: false` (show it muted). */
export function filterTree(nodes, pred) {
  if (!pred) return nodes;
  const out = [];
  for (const n of nodes || []) {
    const kids = filterTree(n.children, pred);
    const hit = !!pred(n);
    if (hit || kids.length) out.push({ ...n, children: kids, _hit: hit });
  }
  return out;
}

/** Count open tasks in a tree (snoozed ones separately), never counting context-only parents. */
export function treeCounts(nodes, { today = todayISO(), showSnoozed = false } = {}) {
  let open = 0, overdue = 0, snoozed = 0;
  const walk = (list) => { for (const n of list || []) {
    if (!isClosedTask(n)) {
      if (n._snoozed && !showSnoozed) snoozed++;
      else { open++; if (n.due_date && n.due_date < today) overdue++; }
    }
    walk(n.children);
  } };
  walk(nodes);
  return { open, overdue, snoozed };
}

/**
 * How many tasks a search_tasks query matches, without fetching them.
 * Resolves `{n, exact}`. `exact: false` only if the server cut the list short and sent no total;
 * then `n` is a floor ("n+"). Rejects as the transport rejects.
 */
export async function countTasks(transport, args = {}) {
  const r = await transport.call("search_tasks", { ...args, limit: 1, fields: "dedup" });
  const rows = (r && Array.isArray(r.rows)) ? r.rows : [];
  if (!r || !r.truncated) return { n: rows.length, exact: true };
  return typeof r.total_matched === "number" ? { n: r.total_matched, exact: true } : { n: rows.length, exact: false };
}

/** A count for display: "12", "12+" (a floor), or "…" while loading. */
export function formatCount(c) { return !c ? "…" : c.exact ? String(c.n) : `${c.n}+`; }

/** A task's "time required" ("15 mins", "2 hrs", "1 day") in hours; 0 when blank or unknown.
 * A day is 8 hours. */
export function hoursOf(label) {
  const m = String(label || "").match(/(\d+(?:\.\d+)?)\s*(min|hr|hour|day)/i);
  if (!m) return 0;
  const k = Number(m[1]); const u = m[2].toLowerCase();
  return u === "min" ? k / 60 : u === "day" ? k * 8 : k;
}
