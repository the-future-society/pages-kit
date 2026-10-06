/* TFS pages kit — transport: one `call(tool, input, opts)` over three surfaces (spec §6.2).
 *
 *   artifact  claude.ai artifact `mcp` capability: `callTool("TFS MCP Server", tool, input, opts)`
 *   mcp-app   an MCP App screen: `app.callServerTool({name, arguments})` (ext-apps SDK)
 *   fetch     same-origin JSON POST, for a page TFS serves itself (the Review Inbox)
 *
 * Every failure is thrown as ONE shape, `{code, message, retryable, ambiguous}`:
 *
 * - `message` is plain words a person can act on (never a stack, never the runtime's own text
 *   when we have a better sentence).
 * - `ambiguous` answers the only question a WRITE needs answered: "could the tool have run?"
 *   It is FALSE only for codes the runtime documents as "the call never reached the connector"
 *   (`NOT_SENT`). Everything else — a timeout, a drop, `upstream_error`, `cancelled`, a tool
 *   that raised, a code newer than this file — is ambiguous, because a timeout is not a failure
 *   (the Coda create keeps going after the client gives up; two rows were duplicated that way
 *   on 2026-09-03). The save machine turns an ambiguous write failure into outcome-unknown.
 * - `retryable` is the runtime's own stamp (or `server_unavailable`), and licenses at most one
 *   unattended retry of a READ. A write is never retried unattended.
 *
 * CONTRACT. Every request carries `contract: 1`, and every answer must carry a `contract` whose
 * major is 1; anything else is refused with "This page needs updating." (spec §5, §6.4). The
 * server ignores the request field (FastMCP drops undeclared arguments); it is there so a
 * future server can tell an old page from a new one.
 *
 * CACHING (artifact). A write is `cache: false`. `describe_record_form` and the picker may be
 * served from the runtime's cache for a minute. `get_record_for_editing` is always `fresh`
 * (`cache: {refresh: true}`): its `row_version` is what "changed since you opened it" compares
 * against, and a cached one would be the pre-save token right after a save.
 */

export const SERVER = "TFS MCP Server";
export const KIT_CONTRACT = 1;

/** Codes the claude.ai runtime documents as "this call never reached the connector". Only
 * these are NOT ambiguous for a write. (`rejected` is the fetch adapter's 4xx, which our own
 * server sends before doing anything.) */
const NOT_SENT = new Set([
  "server_not_connected", "needs_reauth", "selection_required", "server_not_found",
  "not_in_manifest", "blocked_by_policy", "approval_required", "bad_request", "not_granted",
  "capability_disabled", "capability_removed", "transform_error", "consent_required",
  "user_changed", "rate_limited", "rejected",
]);

const PLAIN = {
  server_not_connected: "Add the TFS MCP Server connector in claude.ai → Settings → Connectors, then reload.",
  selection_required: "You have more than one TFS MCP Server connector. Choose one when claude.ai asks, then reload.",
  server_not_found: "The TFS MCP Server connector is no longer available. Reconnect it in claude.ai → Settings → Connectors.",
  needs_reauth: "Your TFS sign-in has lapsed. Reconnect the TFS MCP Server connector in claude.ai.",
  not_in_manifest: "This page isn't allowed to use that TFS tool. Ask whoever built it to update it.",
  consent_required: "Allow this page to use the TFS MCP Server when it asks, then try again.",
  blocked_by_policy: "Your organisation blocks this TFS tool for you.",
  approval_required: "Your organisation requires approval for this TFS tool, which pages can't ask for yet.",
  not_granted: "This page can't reach TFS from here. Open it in claude.ai while signed in.",
  capability_disabled: "This page can't reach TFS from here. Open it in claude.ai while signed in.",
  capability_removed: "This page can't reach TFS from here. Open it in claude.ai while signed in.",
  user_changed: "You signed in as someone else. Reload the page.",
  rate_limited: "Too many requests at once. Wait a few seconds and try again.",
  server_unavailable: "The TFS server didn't answer in time.",
  upstream_error: "The connection to TFS dropped before it answered.",
  cancelled: "The request was cancelled before TFS answered.",
  tool_error: "The TFS server couldn't do that.",
  rejected: "The TFS server refused the request.",
  contract_mismatch: "This page needs updating.",
  bad_payload: "The TFS server sent an answer this page doesn't understand.",
};

/** The kit's one error shape. `code` is the runtime's code (or ours); unknown codes keep their
 * name but read as ambiguous and get a generic sentence. */
export function kitError(code, message, { retryable = false } = {}) {
  const c = code || "upstream_error";
  return {
    code: c,
    message: PLAIN[c] || message || "Something went wrong.",
    retryable: retryable === true || c === "server_unavailable",
    ambiguous: !NOT_SENT.has(c),
  };
}

/** FastMCP wraps a dict return as `{"result": …}`; text blocks may carry JSON as a string. */
export function unwrap(p) {
  if (typeof p === "string") { try { p = JSON.parse(p); } catch { return p; } }
  if (p && typeof p === "object" && !Array.isArray(p) && "result" in p && Object.keys(p).length === 1) {
    let r = p.result; if (typeof r === "string") { try { r = JSON.parse(r); } catch {} } return r;
  }
  return p;
}

/** Throws `contract_mismatch` unless `payload.contract`'s major is the kit's. */
export function checkContract(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw kitError("bad_payload");
  }
  const major = Number.parseInt(String(payload.contract ?? ""), 10);
  if (major !== KIT_CONTRACT) throw kitError("contract_mismatch");
  return payload;
}

function isKitError(e) {
  return e && typeof e === "object" && typeof e.code === "string" && "ambiguous" in e;
}

/**
 * `createTransport({kind, mcp?, app?, baseUrl?})` → `{call(tool, input, {write, fresh})}`.
 *
 * `mcp` (artifact) is optional: without it the transport resolves `claude.use("mcp")` on first
 * use, and a `null` there (not granted, not served) is `not_granted`.
 */
export function createTransport({ kind, mcp = null, app = null, baseUrl = "", fetchImpl = null } = {}) {
  let mcpPromise = mcp ? Promise.resolve(mcp) : null;
  const getMcp = () => {
    if (!mcpPromise) {
      const use = globalThis.claude && globalThis.claude.use;
      mcpPromise = typeof use === "function" ? Promise.resolve(use.call(globalThis.claude, "mcp")) : Promise.resolve(null);
    }
    return mcpPromise;
  };

  async function raw(tool, input, { write, fresh }) {
    if (kind === "artifact") {
      const m = await getMcp();
      if (!m) throw { code: "not_granted" };
      const opts = write ? { cache: false } : fresh ? { cache: { refresh: true } } : { cache: { staleTime: 60000 } };
      const r = await m.callTool(SERVER, tool, input, opts);
      return unwrap(r && "payload" in r ? r.payload : r);
    }
    if (kind === "mcp-app") {
      const r = await app.callServerTool({ name: tool, arguments: input });
      const text = r && r.content && r.content[0] && r.content[0].text;
      if (r && r.isError) throw { code: "tool_error", message: text };
      return unwrap(r && r.structuredContent != null ? r.structuredContent : text);
    }
    if (kind === "fetch") {
      const f = fetchImpl || globalThis.fetch;
      let res;
      try {
        res = await f(`${baseUrl}/api/tools/${tool}`, {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
          body: JSON.stringify(input),
        });
      } catch { throw { code: "upstream_error" }; }  // the network dropped: may have landed
      if (!res.ok) {
        throw { code: res.status === 401 ? "needs_reauth" : res.status === 403 ? "blocked_by_policy"
          : res.status >= 500 || res.status === 408 ? "server_unavailable" : "rejected" };
      }
      return await res.json();
    }
    throw { code: "bad_request", message: `Unknown transport kind: ${kind}` };
  }

  async function call(tool, input = {}, { write = false, fresh = false } = {}) {
    const body = { ...(input || {}), contract: KIT_CONTRACT };
    let payload;
    try {
      payload = await raw(tool, body, { write, fresh });
    } catch (e) {
      if (isKitError(e)) throw e;
      throw kitError(e && e.code, e && e.message, { retryable: e && e.retryable });
    }
    return checkContract(payload);
  }

  return { call, kind };
}
