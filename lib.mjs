// Pure helpers for server.mjs, kept apart so `node --test` can drive them
// without a network, a token or an MCP client.

import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_URL = "https://guardstein.com";

/** The instance to talk to: GUARDSTEIN_URL, then the pre-rebrand BRAINSTORM_URL, then production. */
export function resolveBaseUrl(env = process.env) {
  return (env.GUARDSTEIN_URL || env.BRAINSTORM_URL || DEFAULT_URL).replace(/\/+$/, "");
}

const hostKey = (url) => url.replace(/[^a-z0-9]+/gi, "_");

/** One token file per host, so a preview or localhost never reuses the production token. */
export function cachePath(baseUrl, home = homedir()) {
  return join(home, `.guardstein-mcp-${hostKey(baseUrl)}.json`);
}

/**
 * Token files the old @cintelisai/brainstorm-mcp wrote that may hold a token
 * this host accepts, best first. The same deployment answers on the old and
 * new domains, so a token approved at brainstorm.cintelis.ai is valid at
 * guardstein.com: reusing it spares every existing user a fresh sign-in. A
 * token the server no longer accepts simply answers 401 and the user connects
 * again, which is where they would have been anyway.
 */
export function legacyCachePaths(baseUrl, home = homedir()) {
  const paths = [join(home, `.brainstorm-mcp-${hostKey(baseUrl)}.json`)];
  if (baseUrl === DEFAULT_URL) {
    paths.push(join(home, `.brainstorm-mcp-${hostKey("https://brainstorm.cintelis.ai")}.json`));
  }
  return paths;
}

/** Whether an SVG carries an editable draw.io diagram (uncompressed or compressed). */
export function isEditableDrawioSvg(svgText) {
  const m = /<svg\b[^>]*\scontent="([^"]*)"/s.exec(svgText);
  return !!m && /^\s*(&lt;|<)mxfile\b/.test(m[1]);
}

/** Whether a PNG carries an embedded draw.io diagram (an mxfile text chunk). */
export function isEditableDrawioPng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return false;
  return buf.includes(Buffer.from("mxfile")) || buf.includes(Buffer.from("mxGraphModel"));
}

/**
 * Put a diagram's markdown into a note's content.
 *
 * - replaceLink: swap the image link that points at that asset (an edited
 *   diagram). The old file stays stored, since another note may link to it.
 * - afterHeading: insert below the first heading with that text.
 * - otherwise: append.
 *
 * Throws with a message the model can act on when the target is not there.
 */
export function insertDiagram(content, markdown, { afterHeading, replaceLink } = {}) {
  if (replaceLink) {
    const target = replaceLink.replace(/^\.?\//, "");
    const re = new RegExp(`!\\[[^\\]]*\\]\\(${escapeRe(target)}\\)`);
    if (!re.test(content)) {
      throw new Error(`The note has no image link to ${target}. Read the note and pass the link exactly as it appears.`);
    }
    return content.replace(re, () => markdown);
  }
  if (afterHeading) {
    const re = new RegExp(`^(#{1,6})[ \\t]+${escapeRe(afterHeading.trim())}[ \\t]*$`, "m");
    const m = re.exec(content);
    if (!m) {
      throw new Error(`The note has no heading "${afterHeading}". Headings must match exactly, without the #s.`);
    }
    const end = m.index + m[0].length;
    return `${content.slice(0, end)}\n\n${markdown}\n${content.slice(end)}`;
  }
  return `${content.replace(/\s+$/, "")}\n\n${markdown}\n`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Vercel caps a function's request body at 4.5 MB whatever the route allows,
 * so a larger upload fails at the platform with a body that is not even JSON.
 * Refusing it here says why.
 */
export const MAX_UPLOAD_BYTES = Math.floor(4.5 * 1024 * 1024);
