#!/usr/bin/env node
// MCP server for the Brainstorm Board cloud API.
//
// Bridges Claude (Desktop, Code, or any MCP client) to /api/v1 on a deployed
// instance. Authentication is the OAuth device flow the app already ships
// (RFC 8628): `connect` hands the human a URL and a short code, they approve
// in a browser where they are already signed in, and the bearer token comes
// back over the polling channel — no credential is ever typed or pasted.
//
// The token is workspace-scoped AT APPROVAL: whichever workspace is active in
// the app when the human clicks Approve is the one this server can see. That
// is a property of the API's design, not a choice made here, and `connect`
// says so in its instructions.
//
// Deliberately dependency-light: the MCP SDK, zod (its schema language), and
// global fetch. State is one JSON file in the user's home directory holding
// the base URL, the token, and — briefly — a pending device authorization.

import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.BRAINSTORM_URL ?? "https://brainstorm.cintelis.ai").replace(
  /\/+$/,
  ""
);

/**
 * One cache file per host, so pointing BRAINSTORM_URL at a preview or
 * localhost cannot silently reuse (or clobber) the production token.
 */
const CACHE_PATH = join(
  homedir(),
  `.brainstorm-mcp-${BASE_URL.replace(/[^a-z0-9]+/gi, "_")}.json`
);

function loadCache() {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

/** Every tool answers in plain text; MCP clients render it as-is. */
function text(message, isError = false) {
  return { content: [{ type: "text", text: message }], isError };
}

async function api(path, init = {}) {
  const cache = loadCache();
  const headers = { "Content-Type": "application/json", ...(init.headers ?? {}) };
  if (cache.token) headers.Authorization = `Bearer ${cache.token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON answers (proxies, hard 500s) fall through with body null.
  }
  return { res, body };
}

/** Like api(), but for binary answers (asset downloads). */
async function apiRaw(path) {
  const cache = loadCache();
  const headers = {};
  if (cache.token) headers.Authorization = `Bearer ${cache.token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf, contentType: res.headers.get("content-type") ?? "" };
}

/**
 * Bodies are capped before they reach the model. A note tops out at 1 MB
 * server-side, which is far more than a conversation can usefully hold; the
 * cut is explicit so the model knows it is looking at a prefix.
 */
const MAX_TEXT_CHARS = 100_000;

function clip(textValue) {
  return textValue.length > MAX_TEXT_CHARS
    ? `${textValue.slice(0, MAX_TEXT_CHARS)}\n\n[truncated: ${textValue.length - MAX_TEXT_CHARS} more characters]`
    : textValue;
}

const server = new McpServer({ name: "brainstorm-board", version: "0.1.0" });

server.tool(
  "brainstorm_status",
  "Show whether this server is connected to Brainstorm Board, and to which workspace.",
  {},
  async () => {
    const cache = loadCache();
    if (cache.token) {
      return text(
        `Connected to ${BASE_URL} (workspace ${cache.workspaceId ?? "unknown"}). Use brainstorm_list_notes or brainstorm_create_note.`
      );
    }
    if (cache.pending) {
      return text(
        `A connection is awaiting approval at ${cache.pending.verificationUri} with code ${cache.pending.userCode}. Approve it in the browser, then call brainstorm_finish_connect.`
      );
    }
    return text(`Not connected to ${BASE_URL}. Call brainstorm_connect to start.`);
  }
);

server.tool(
  "brainstorm_connect",
  "Start an SSO connection to Brainstorm Board (OAuth device flow). Returns a URL and a code for the user to approve in their browser; afterwards call brainstorm_finish_connect.",
  {},
  async () => {
    const cache = loadCache();
    if (cache.token) {
      return text(
        `Already connected to ${BASE_URL} (workspace ${cache.workspaceId ?? "unknown"}). Call brainstorm_disconnect first to connect as a different workspace.`
      );
    }
    const { res, body } = await api("/api/v1/device/code", {
      method: "POST",
      body: JSON.stringify({ client_name: "Claude (MCP)" }),
    });
    if (!res.ok || !body?.device_code) {
      return text(
        `Could not start the device flow (HTTP ${res.status}): ${body?.error_description ?? body?.error ?? "no detail"}`,
        true
      );
    }
    saveCache({
      pending: {
        deviceCode: body.device_code,
        userCode: body.user_code,
        verificationUri: body.verification_uri_complete ?? body.verification_uri,
        interval: body.interval ?? 5,
        expiresAt: Date.now() + (body.expires_in ?? 600) * 1000,
      },
    });
    return text(
      [
        `To connect, the user must approve this device in their browser:`,
        ``,
        `  1. IMPORTANT: in the Brainstorm app, switch to the workspace this connection should access (the token is bound to whichever workspace is active when approving).`,
        `  2. Open: ${body.verification_uri_complete ?? body.verification_uri}`,
        `  3. Check the code on the page matches: ${body.user_code}`,
        `  4. Approve. (Requires a workspace admin on a Premium workspace.)`,
        ``,
        `The code expires in ${Math.round((body.expires_in ?? 600) / 60)} minutes. Once approved, call brainstorm_finish_connect.`,
      ].join("\n")
    );
  }
);

server.tool(
  "brainstorm_finish_connect",
  "Complete a pending SSO connection after the user has approved it in the browser.",
  {},
  async () => {
    const cache = loadCache();
    const pending = cache.pending;
    if (cache.token) return text(`Already connected to ${BASE_URL}.`);
    if (!pending) return text("No pending connection. Call brainstorm_connect first.", true);
    if (pending.expiresAt < Date.now()) {
      saveCache({});
      return text("The device code expired. Call brainstorm_connect to start again.", true);
    }

    // A few polls at the server-mandated interval, so one tool call usually
    // suffices right after the user says they approved — without turning into
    // a long-blocking call if they have not.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, pending.interval * 1000));
      }
      const { body } = await api("/api/v1/device/token", {
        method: "POST",
        body: JSON.stringify({ device_code: pending.deviceCode }),
      });
      if (body?.access_token) {
        saveCache({ token: body.access_token, workspaceId: body.workspace_id });
        return text(
          `Connected. This server now has API access to workspace ${body.workspace_id} on ${BASE_URL}.`
        );
      }
      const code = body?.error ?? "unknown";
      if (code === "authorization_pending" || code === "slow_down") continue;
      saveCache({});
      return text(
        `The connection was not completed (${code}): ${body?.error_description ?? ""}. Call brainstorm_connect to start again.`,
        true
      );
    }
    return text(
      `Still waiting for approval at ${pending.verificationUri} (code ${pending.userCode}). Approve it in the browser, then call brainstorm_finish_connect again.`
    );
  }
);

server.tool(
  "brainstorm_disconnect",
  "Forget the stored Brainstorm Board API token for this machine. (The token itself can also be revoked in the app under Account.)",
  {},
  async () => {
    rmSync(CACHE_PATH, { force: true });
    return text("Disconnected: the stored token was deleted from this machine.");
  }
);

server.tool(
  "brainstorm_list_notes",
  "List the notes and folders in the connected Brainstorm Board workspace (titles and ids only, not content).",
  {},
  async () => {
    const { res, body } = await api("/api/v1/notes");
    if (res.status === 401) {
      return text("Not connected (or the token was revoked). Call brainstorm_connect.", true);
    }
    if (!res.ok) {
      return text(`API error (HTTP ${res.status}): ${body?.message ?? body?.error ?? "no detail"}`, true);
    }
    const folders = new Map((body.folders ?? []).map((f) => [f.id, f.name]));
    const lines = (body.notes ?? []).map(
      (n) =>
        `- ${n.title} (id ${n.id}, folder: ${n.folderId ? folders.get(n.folderId) ?? n.folderId : "none"}, updated ${new Date(n.updatedAt).toISOString()})`
    );
    const folderLine = `Folders: ${(body.folders ?? []).map((f) => f.name).join(", ") || "none"}`;
    return text(`${folderLine}\n\n${lines.join("\n") || "No notes."}`);
  }
);

server.tool(
  "brainstorm_read_note",
  "Read one note's full markdown content by id (get ids from brainstorm_list_notes). Also reports any assets/<name> attachments referenced, readable with brainstorm_read_asset.",
  {
    id: z.string().describe("The note id, from brainstorm_list_notes."),
  },
  async ({ id }) => {
    const { res, body } = await api(`/api/v1/notes/${encodeURIComponent(id)}`);
    if (res.status === 401) {
      return text("Not connected (or the token was revoked). Call brainstorm_connect.", true);
    }
    if (res.status === 404 && body?.error === "not_found") {
      return text(`No note with id ${id} in this workspace.`, true);
    }
    if (!res.ok) {
      return text(
        `API error (HTTP ${res.status}): ${body?.message ?? body?.error ?? "no detail"}${res.status === 404 ? " (a 404 here can also mean the deployed app predates the read API)" : ""}`,
        true
      );
    }
    const assets = [...new Set(body.content.match(/assets\/[A-Za-z0-9._-]+/g) ?? [])];
    const header = [
      `# ${body.title}`,
      `id: ${body.id} · updated ${new Date(body.updatedAt).toISOString()}`,
      assets.length
        ? `attachments: ${assets.map((a) => a.replace(/^assets\//, "")).join(", ")}`
        : null,
      "---",
    ]
      .filter(Boolean)
      .join("\n");
    return text(`${header}\n${clip(body.content)}`);
  }
);

/** Image types Claude can actually display; everything else is described. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

server.tool(
  "brainstorm_read_asset",
  "Fetch an attachment (image, document, diagram) from the workspace by its asset name, e.g. from a note's assets/<name> link. Images are returned for viewing; Word documents (.docx), spreadsheets (.xlsx/.xls/.ods) and PDFs are converted to text; text formats pass through; other binaries are described.",
  {
    name: z.string().describe("The asset filename, without the assets/ prefix."),
  },
  async ({ name }) => {
    const { res, buf, contentType } = await apiRaw(
      `/api/v1/assets/${encodeURIComponent(name.replace(/^assets\//, ""))}`
    );
    if (res.status === 401) {
      return text("Not connected (or the token was revoked). Call brainstorm_connect.", true);
    }
    if (!res.ok) {
      let detail = "";
      try {
        detail = JSON.parse(buf.toString("utf8")).message ?? "";
      } catch {
        // Body was not JSON; the status alone will have to explain it.
      }
      return text(`Could not fetch the asset (HTTP ${res.status}): ${detail}`, true);
    }

    const type = contentType.split(";")[0].trim().toLowerCase();
    if (IMAGE_TYPES.has(type)) {
      if (buf.length > MAX_IMAGE_BYTES) {
        return text(
          `"${name}" is a ${type} of ${(buf.length / 1024 / 1024).toFixed(1)} MB — too large to display inline (limit ${MAX_IMAGE_BYTES / 1024 / 1024} MB).`
        );
      }
      return {
        content: [{ type: "image", data: buf.toString("base64"), mimeType: type }],
      };
    }
    // Office formats are extracted here, in the client, mirroring what the
    // app itself does at preview time (its lib/office-doc.ts): the server
    // stores only the original bytes, and conversion happens wherever the
    // reader is. mammoth walks the OOXML for prose; SheetJS reads workbooks —
    // installed from the vendor's CDN tarball, not npm, whose newest published
    // build carries prototype-pollution and ReDoS advisories that matter
    // precisely because this input is an untrusted upload.
    //
    // These branches run BEFORE the plain-text check, and the text check must
    // never use a bare /xml/ match: a .docx announces itself as
    // application/vnd.openXMLformats-…, which contains "xml", and the first
    // cut of this code duly printed a Word document as raw ZIP bytes.
    if (/\.docx$/i.test(name) || type.includes("wordprocessingml.document")) {
      const mod = await import("mammoth");
      const mammoth = mod.default ?? mod;
      try {
        const { value } = await mammoth.extractRawText({ buffer: buf });
        return text(
          value.trim()
            ? `Text extracted from "${name}" (formatting not preserved):\n\n${clip(value)}`
            : `"${name}" contains no extractable text.`
        );
      } catch (err) {
        return text(
          `Could not read "${name}" as a Word document: ${err instanceof Error ? err.message : String(err)}`,
          true
        );
      }
    }

    if (
      /\.(xlsx|xlsm|xls|ods)$/i.test(name) ||
      type.includes("spreadsheetml") ||
      type.includes("ms-excel")
    ) {
      const mod = await import("xlsx");
      const XLSX = mod.default ?? mod;
      try {
        const wb = XLSX.read(buf, { type: "buffer" });
        const MAX_SHEETS = 12;
        const shown = wb.SheetNames.slice(0, MAX_SHEETS);
        const parts = shown.map((sheetName) => {
          const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]).trim();
          return `## Sheet: ${sheetName}\n${csv || "(empty)"}`;
        });
        const omitted = wb.SheetNames.length - shown.length;
        if (omitted > 0) {
          parts.push(`[${omitted} more sheet(s) omitted: ${wb.SheetNames.slice(MAX_SHEETS).join(", ")}]`);
        }
        return text(`Workbook "${name}" as CSV:\n\n${clip(parts.join("\n\n"))}`);
      } catch (err) {
        return text(
          `Could not read "${name}" as a spreadsheet: ${err instanceof Error ? err.message : String(err)}`,
          true
        );
      }
    }

    if (/\.pdf$/i.test(name) || type === "application/pdf") {
      try {
        const { extractText, getDocumentProxy } = await import("unpdf");
        const pdf = await getDocumentProxy(new Uint8Array(buf));
        const { text: extracted, totalPages } = await extractText(pdf, { mergePages: true });
        return text(
          extracted.trim()
            ? `Text extracted from "${name}" (${totalPages} page(s), layout not preserved):\n\n${clip(extracted)}`
            : `"${name}" has ${totalPages} page(s) but no text layer — likely a scan. There is nothing to extract without OCR.`
        );
      } catch (err) {
        return text(
          `Could not read "${name}" as a PDF: ${err instanceof Error ? err.message : String(err)}`,
          true
        );
      }
    }

    const isTextual =
      type.startsWith("text/") ||
      type === "application/json" ||
      type === "application/xml" ||
      type.endsWith("+json") ||
      type.endsWith("+xml") ||
      /(csv|markdown|javascript)/.test(type) ||
      /\.(md|txt|json|csv|xml|drawio|svg)$/i.test(name);
    if (isTextual) {
      return text(clip(buf.toString("utf8")));
    }

    // Word 97 .doc, .rtf and .odt are stored and served but not convertible —
    // the same honest refusal the app's preview makes.
    return text(
      `"${name}" is ${type || "an unknown type"}, ${(buf.length / 1024).toFixed(0)} kB — a binary format that cannot be displayed in chat. It can be downloaded in the app from the note that references it.`
    );
  }
);

server.tool(
  "brainstorm_create_note",
  "Create a markdown note in the connected Brainstorm Board workspace. `folder` is a folder NAME (created if it does not exist yet); omit it to leave the note unfiled.",
  {
    content: z.string().describe("The note body, markdown. The first line becomes the title if none is given."),
    title: z.string().optional().describe("Optional explicit title."),
    folder: z.string().optional().describe("Folder name to file the note under, e.g. 'DekkoSecure'."),
  },
  async ({ content, title, folder }) => {
    const { res, body } = await api("/api/v1/notes", {
      method: "POST",
      body: JSON.stringify({ content, title, folder }),
    });
    if (res.status === 401) {
      return text("Not connected (or the token was revoked). Call brainstorm_connect.", true);
    }
    if (!res.ok) {
      return text(`Could not create the note (HTTP ${res.status}): ${body?.message ?? body?.error ?? "no detail"}`, true);
    }
    return text(
      `Created "${body.title}" (id ${body.id}${body.filename ? `, file ${body.filename}` : ""}). Open it at ${BASE_URL}${body.url}`
    );
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
