/* TFS pages kit — live.js: a page keeps itself up to date (kit 1.6.0).
 *
 * Before this, a page read TFS once when it opened and never again unless the viewer saved,
 * reloaded or pressed a Refresh button — a page left open all day showed what was true at
 * breakfast, and nobody can be expected to keep reloading.
 *
 *   import { autoRefresh } from ".../kit.js";
 *   const live = autoRefresh({ load: (fresh) => loadTasks(fresh), stamp: document.getElementById("updated") });
 *   await live.refresh(false);          // the first load (may come from the 60 s cache)
 *   document.addEventListener("tfs-saved", () => live.refresh());   // after a save: fresh
 *
 * WHAT IT DOES
 * - Every `every` ms (default 5 min) while the page is VISIBLE, re-reads with `fresh = true`
 *   (bypassing claude.ai's request cache — a cached answer would defeat the point).
 * - When the viewer comes BACK to the tab and the last load is older than `returnAfter`
 *   (default 30 s), re-reads at once. A hidden tab never polls.
 * - NEVER redraws under someone mid-edit. Before each background re-read it asks `isEditing()`:
 *   a kit form with a change not saved or a save in flight, an open or saving status menu, the
 *   focus in a text field or editable area, or the page's own `isBusy()`. While any is true it
 *   tries again every `retryEvery` ms (default 15 s). A refresh the PAGE asks for (`refresh()`)
 *   is never held: the page knows why it asked.
 * - One re-read at a time: a call while one runs is queued once behind it.
 * - `stamp` (optional element) shows "Updated 14:32". A failed BACKGROUND re-read leaves the
 *   page as it was and says "Updated 14:32 · couldn't refresh, will retry" — it never claims
 *   to be current when it is not.
 *
 * `load(fresh)` is the page's own read-and-draw function. It should keep what is on screen if
 * its read fails (a background failure must not blank the page) and may throw or reject; the
 * helper treats a throw as a failed refresh.
 *
 * Returns `{ refresh(fresh = true), stop(), get loadedAt }`. Pure DOM + timers; no TFS calls of
 * its own, so it works over any transport.
 */

export const REFRESH_EVERY_MS = 5 * 60 * 1000;
export const RETURN_AFTER_MS = 30 * 1000;
export const RETRY_EVERY_MS = 15 * 1000;

/** Is someone mid-edit on this page? Kit elements answer for themselves (`editing`); a focused
 * text field or editable area counts too, so a page's own inputs are covered. */
export function isEditing(doc = globalThis.document, isBusy = null) {
  try { if (typeof isBusy === "function" && isBusy()) return true; } catch { return true; }
  if (!doc || typeof doc.querySelectorAll !== "function") return false;
  for (const el of doc.querySelectorAll("tfs-record-form, tfs-status-menu")) {
    try { if (el.editing) return true; } catch { /* an element mid-upgrade is not editing */ }
  }
  return focusIsEditable(doc.activeElement);
}

export function focusIsEditable(el) {
  if (!el) return false;
  // Into a shadow root: the kit's own fields can live there.
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  const tag = (el.tagName || "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const t = (el.type || "text").toLowerCase();
    return !["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "image", "hidden"].includes(t);
  }
  return !!el.isContentEditable;
}

/** "Updated 14:32" in the viewer's own clock; "· couldn't refresh, will retry" after a failure. */
export function stampText(loadedAt, failed = false) {
  if (!loadedAt) return failed ? "Couldn't load — will retry" : "";
  const t = loadedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return failed ? `Updated ${t} · couldn't refresh, will retry` : `Updated ${t}`;
}

export function autoRefresh({
  load, stamp = null, isBusy = null, every = REFRESH_EVERY_MS, returnAfter = RETURN_AFTER_MS,
  retryEvery = RETRY_EVERY_MS, doc = globalThis.document, win = globalThis, now = () => new Date(),
} = {}) {
  if (typeof load !== "function") throw new TypeError("autoRefresh needs load(fresh)");
  let loadedAt = null, inflight = null, queued = null, timer = null, stopped = false;

  const visible = () => !doc || doc.visibilityState === undefined || doc.visibilityState === "visible";
  const paint = (failed) => { if (stamp) stamp.textContent = stampText(loadedAt, failed); };
  const clear = () => { if (timer != null) { win.clearTimeout(timer); timer = null; } };
  const arm = (ms) => { clear(); if (!stopped) timer = win.setTimeout(tick, Math.max(0, ms)); };

  function refresh(fresh = true) {
    // One read at a time. A call while one runs is queued ONCE behind it, never dropped: the
    // running read may have started before the save the caller is reacting to.
    if (inflight) {
      if (!queued) queued = inflight.then(() => { queued = null; return refresh(fresh); });
      return queued;
    }
    inflight = (async () => {
      try {
        await load(fresh);
        loadedAt = now();
        paint(false);
        return true;
      } catch {
        paint(true);
        return false;
      } finally {
        inflight = null;
        arm(every);                       // the next background re-read counts from now
      }
    })();
    return inflight;
  }

  /** A background re-read: only on a visible page, never under an edit. */
  function tick() {
    timer = null;
    if (stopped) return;
    if (!visible()) return;               // resumes on return to the tab
    if (isEditing(doc, isBusy)) { arm(retryEvery); return; }
    refresh(true);
  }

  function onVisibility() {
    if (stopped || !visible()) return;
    const age = loadedAt ? now() - loadedAt : Infinity;
    if (age >= returnAfter) tick();
    else arm(every - age);
  }

  if (doc && typeof doc.addEventListener === "function") doc.addEventListener("visibilitychange", onVisibility);
  arm(every);

  return {
    refresh,
    stop() {
      stopped = true; clear();
      if (doc && typeof doc.removeEventListener === "function") doc.removeEventListener("visibilitychange", onVisibility);
    },
    get loadedAt() { return loadedAt; },
  };
}
