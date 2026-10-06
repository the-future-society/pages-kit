import { test } from "node:test";
import assert from "node:assert/strict";
import { createTransport, SERVER, KIT_CONTRACT, kitError, checkContract } from "../transport.js";

const ok = (body) => ({ payload: { result: JSON.stringify({ contract: 1, ...body }) } });

test("artifact writes bypass the cache and name the TFS server", async () => {
  const seen = [];
  const mcp = { callTool: async (s, t, i, o) => { seen.push([s, t, i, o]); return ok({ ok: 1 }); } };
  const out = await createTransport({ kind: "artifact", mcp }).call("save_record", {}, { write: true });
  assert.deepEqual(out, { contract: 1, ok: 1 });
  assert.equal(seen[0][0], SERVER);
  assert.equal(SERVER, "TFS MCP Server");
  assert.deepEqual(seen[0][3], { cache: false });
});

test("reads may be cached; a fresh read refreshes the cache", async () => {
  const opts = [];
  const mcp = { callTool: async (s, t, i, o) => { opts.push(o); return ok({}); } };
  const tr = createTransport({ kind: "artifact", mcp });
  await tr.call("describe_record_form", { table: "tasks", mode: "create" });
  await tr.call("get_record_for_editing", { table: "tasks", row_id: "i-x" }, { fresh: true });
  assert.deepEqual(opts[0], { cache: { staleTime: 60000 } });
  assert.deepEqual(opts[1], { cache: { refresh: true } });
});

test("every request carries contract: 1", async () => {
  const inputs = [];
  const mcp = { callTool: async (s, t, i) => { inputs.push(i); return ok({}); } };
  await createTransport({ kind: "artifact", mcp }).call("describe_record_form", { table: "tasks" });
  assert.deepEqual(inputs[0], { table: "tasks", contract: KIT_CONTRACT });
});

test("a structured payload (not wrapped in result) is read as is", async () => {
  const mcp = { callTool: async () => ({ payload: { contract: 1, fields: [] } }) };
  assert.deepEqual(await createTransport({ kind: "artifact", mcp }).call("describe_record_form", {}), { contract: 1, fields: [] });
});

test("another contract major, or none, refuses with 'This page needs updating.'", async () => {
  for (const payload of [{ contract: 2 }, { fields: [] }, { contract: "2.0" }]) {
    const mcp = { callTool: async () => ({ payload }) };
    await assert.rejects(createTransport({ kind: "artifact", mcp }).call("describe_record_form", {}),
      (e) => e.code === "contract_mismatch" && e.message === "This page needs updating.");
  }
  assert.equal(checkContract({ contract: 1 }).contract, 1);
  assert.equal(checkContract({ contract: "1.3" }).contract, "1.3");
});

test("a dropped connection is ambiguous, a lapsed login is not", async () => {
  const t = (code) => createTransport({ kind: "artifact", mcp: { callTool: async () => { throw { code }; } } });
  await assert.rejects(t("server_unavailable").call("save_record", {}), (e) => e.ambiguous === true && e.retryable === true);
  await assert.rejects(t("needs_reauth").call("save_record", {}), (e) => e.ambiguous === false && /Reconnect/.test(e.message));
});

test("only codes that never reached the server are unambiguous", () => {
  for (const c of ["upstream_error", "cancelled", "tool_error", "server_unavailable", "something_new", undefined]) {
    assert.equal(kitError(c).ambiguous, true, String(c));
  }
  for (const c of ["server_not_connected", "needs_reauth", "not_in_manifest", "blocked_by_policy", "consent_required", "not_granted", "selection_required"]) {
    assert.equal(kitError(c).ambiguous, false, c);
  }
  assert.match(kitError("server_not_connected").message, /Settings → Connectors/);
  assert.equal(kitError("upstream_error", "x", { retryable: true }).retryable, true);
});

test("no mcp capability (claude.use resolves null) is not_granted, not a crash", async () => {
  const saved = globalThis.claude;
  globalThis.claude = { use: async () => null };
  try {
    await assert.rejects(createTransport({ kind: "artifact" }).call("describe_record_form", {}),
      (e) => e.code === "not_granted" && e.ambiguous === false);
  } finally { globalThis.claude = saved; }
});

test("the artifact transport resolves claude.use('mcp') once", async () => {
  const saved = globalThis.claude; let uses = 0;
  globalThis.claude = { use: async (n) => { uses++; assert.equal(n, "mcp"); return { callTool: async () => ok({}) }; } };
  try {
    const tr = createTransport({ kind: "artifact" });
    await tr.call("a", {}); await tr.call("b", {});
    assert.equal(uses, 1);
  } finally { globalThis.claude = saved; }
});

test("mcp-app: structured content is the payload; an isError result is a tool_error", async () => {
  const app = { callServerTool: async ({ name, arguments: a }) => (name === "bad"
    ? { isError: true, content: [{ type: "text", text: "boom" }] }
    : { structuredContent: { result: { contract: 1, echo: a.table } } }) };
  const tr = createTransport({ kind: "mcp-app", app });
  assert.deepEqual(await tr.call("describe_record_form", { table: "tasks" }), { contract: 1, echo: "tasks" });
  await assert.rejects(tr.call("bad", {}), (e) => e.code === "tool_error");
});

test("fetch: 5xx and a network drop are ambiguous; 401 asks to sign in again", async () => {
  const mk = (impl) => createTransport({ kind: "fetch", baseUrl: "https://x.test", fetchImpl: impl });
  const res = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });
  assert.deepEqual(await mk(res(200, { contract: 1, a: 1 })).call("t", {}), { contract: 1, a: 1 });
  await assert.rejects(mk(res(502)).call("save_record", {}), (e) => e.code === "server_unavailable" && e.ambiguous);
  await assert.rejects(mk(async () => { throw new TypeError("network"); }).call("save_record", {}), (e) => e.ambiguous === true);
  await assert.rejects(mk(res(401)).call("save_record", {}), (e) => e.code === "needs_reauth" && !e.ambiguous);
  await assert.rejects(mk(res(400)).call("save_record", {}), (e) => e.code === "rejected" && !e.ambiguous);
  let seen;
  await mk(async (url, init) => { seen = [url, JSON.parse(init.body)]; return { ok: true, status: 200, json: async () => ({ contract: 1 }) }; }).call("save_record", { table: "tasks" });
  assert.equal(seen[0], "https://x.test/api/tools/save_record");
  assert.deepEqual(seen[1], { table: "tasks", contract: 1 });
});
