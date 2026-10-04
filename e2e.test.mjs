// The server over real stdio, against a fake GuardStein API on localhost.
// Covers the token migration from the old package, uploads, the version check
// on updates, and adding/replacing a diagram in a note.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TOKEN = "bbt_test";
let api, base, home, client;
const notes = new Map();
const uploads = [];

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

before(async () => {
  api = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: "unauthorized" });
    const url = new URL(req.url, "http://x");
    const m = /^\/api\/v1\/notes\/([^/]+)$/.exec(url.pathname);
    if (req.method === "POST" && url.pathname === "/api/v1/assets") {
      const name = `abcd1234-${decodeURIComponent(req.headers["x-filename"])}`;
      uploads.push({ name, bytes: raw.length });
      return json(res, 201, { path: `assets/${name}`, name, bytes: raw.length, markdown: `![x](assets/${name})` });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/notes") {
      const body = JSON.parse(raw);
      const id = `n${notes.size + 1}`;
      notes.set(id, { id, title: body.title ?? body.content.split("\n")[0].replace(/^#\s*/, ""), content: body.content, updatedAt: 1000 });
      return json(res, 201, { id, title: notes.get(id).title, url: `/?note=${id}` });
    }
    if (m && req.method === "GET") {
      const n = notes.get(m[1]);
      return n ? json(res, 200, n) : json(res, 404, { error: "not_found", message: "No note" });
    }
    if (m && req.method === "PATCH") {
      const n = notes.get(m[1]);
      const body = JSON.parse(raw);
      if (!body.force && body.expectedUpdatedAt !== n.updatedAt) {
        return json(res, 409, { error: "conflict", updatedAt: n.updatedAt, updatedBy: "Alex" });
      }
      Object.assign(n, { content: body.content ?? n.content, updatedAt: n.updatedAt + 1 });
      return json(res, 200, { id: n.id, title: n.title, updatedAt: n.updatedAt, url: `/?note=${n.id}` });
    }
    json(res, 404, { error: "no_route" });
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${api.address().port}`;

  home = mkdtempSync(join(tmpdir(), "gs-mcp-"));
  // A token the OLD package stored for this host: the new one must pick it up.
  writeFileSync(join(home, `.brainstorm-mcp-${base.replace(/[^a-z0-9]+/gi, "_")}.json`),
    JSON.stringify({ token: TOKEN, workspaceId: "ws_1" }));
  writeFileSync(join(home, "flow.drawio.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" content="&lt;mxfile&gt;&lt;/mxfile&gt;"><rect/></svg>');
  writeFileSync(join(home, "plain.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');

  client = new Client({ name: "e2e", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [new URL("./server.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
    env: { ...process.env, HOME: home, USERPROFILE: home, BRAINSTORM_URL: "", GUARDSTEIN_URL: base, GUARDSTEIN_WORKDIR: home },
  }));
});

after(async () => {
  await client?.close();
  api?.close();
});

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { error: !!r.isError, text: r.content.map((c) => c.text ?? "").join("\n") };
};

test("every tool is guardstein_*, including the new ones", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.every((n) => n.startsWith("guardstein_")), names.join(","));
  for (const n of ["guardstein_update_note", "guardstein_upload_asset", "guardstein_add_diagram"]) assert.ok(names.includes(n));
});

test("the old package's token is migrated, so the user is already connected", async () => {
  const r = await call("guardstein_status");
  assert.match(r.text, /Connected to .* \(workspace ws_1\)/);
  assert.ok(existsSync(join(home, `.guardstein-mcp-${base.replace(/[^a-z0-9]+/gi, "_")}.json`)));
});

test("add_diagram refuses a plain SVG, then creates a note with an editable one", async () => {
  const bad = await call("guardstein_add_diagram", { path: "plain.svg" });
  assert.ok(bad.error && /no embedded draw\.io diagram/.test(bad.text));
  const ok = await call("guardstein_add_diagram", { path: "flow.drawio.svg", alt: "Order flow", title: "Architecture" });
  assert.ok(!ok.error, ok.text);
  const n = notes.get("n1");
  assert.equal(n.content, "# Architecture\n\n![Order flow](assets/abcd1234-flow.drawio.svg)\n");
});

test("add_diagram inserts under a heading, and replaces a figure by its link", async () => {
  notes.set("n2", { id: "n2", title: "Design", content: "# Design\n\n## Flow\n\ntext\n\n![Old](assets/old.drawio.svg)\n", updatedAt: 50 });
  const under = await call("guardstein_add_diagram", { path: "flow.drawio.svg", note_id: "n2", after_heading: "Flow", alt: "New" });
  assert.ok(!under.error, under.text);
  assert.match(notes.get("n2").content, /## Flow\n\n!\[New\]\(assets\/abcd1234-flow\.drawio\.svg\)\n/);
  const swap = await call("guardstein_add_diagram", { path: "flow.drawio.svg", note_id: "n2", replace_link: "assets/old.drawio.svg", alt: "Swapped" });
  assert.ok(!swap.error, swap.text);
  assert.ok(!notes.get("n2").content.includes("old.drawio.svg"));
});

test("update_note needs a version, and a stale one is refused with a way forward", async () => {
  const none = await call("guardstein_update_note", { id: "n2", content: "x" });
  assert.ok(none.error && /expected_version/.test(none.text));
  const stale = await call("guardstein_update_note", { id: "n2", content: "x", expected_version: 1 });
  assert.ok(stale.error && /changed after you read it/.test(stale.text) && /Alex/.test(stale.text));
  const current = notes.get("n2").updatedAt;
  const ok = await call("guardstein_update_note", { id: "n2", content: "# Design\n\nnew", expected_version: current });
  assert.ok(!ok.error, ok.text);
  assert.equal(notes.get("n2").content, "# Design\n\nnew");
});

test("read_note reports the version update_note needs", async () => {
  const r = await call("guardstein_read_note", { id: "n2" });
  assert.match(r.text, new RegExp(`version ${notes.get("n2").updatedAt}`));
});

test("upload_asset sends the bytes under the file's name", async () => {
  const r = await call("guardstein_upload_asset", { path: "plain.svg" });
  assert.ok(!r.error, r.text);
  assert.equal(uploads.at(-1).name, "abcd1234-plain.svg");
  assert.equal(uploads.at(-1).bytes, readFileSync(join(home, "plain.svg")).length);
});

test("a revoked token is dropped, so connect can start a fresh sign-in", async () => {
  const cacheFile = join(home, `.guardstein-mcp-${base.replace(/[^a-z0-9]+/gi, "_")}.json`);
  writeFileSync(cacheFile, JSON.stringify({ token: "revoked_token", workspaceId: "ws_1" }));
  const r = await call("guardstein_status");
  assert.match(r.text, /revoked or has expired/);
  assert.deepEqual(JSON.parse(readFileSync(cacheFile, "utf8")), {});
});

test("disconnect stays disconnected: the old package's token is not carried over again", async () => {
  // The legacy file from before() still holds a VALID token.
  await call("guardstein_disconnect");
  const r = await call("guardstein_status");
  assert.match(r.text, /^Not connected/);
});
