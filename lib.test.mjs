import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  DEFAULT_URL,
  cachePath,
  insertDiagram,
  isEditableDrawioPng,
  isEditableDrawioSvg,
  legacyCachePaths,
  resolveBaseUrl,
} from "./lib.mjs";

test("base URL: GUARDSTEIN_URL, then the old BRAINSTORM_URL, then production", () => {
  assert.equal(resolveBaseUrl({}), DEFAULT_URL);
  assert.equal(resolveBaseUrl({ BRAINSTORM_URL: "http://localhost:3000/" }), "http://localhost:3000");
  assert.equal(resolveBaseUrl({ GUARDSTEIN_URL: "https://x.test", BRAINSTORM_URL: "https://y.test" }), "https://x.test");
});

test("token files are per host, and the old package's files are found for migration", () => {
  assert.equal(cachePath(DEFAULT_URL, "/h"), join("/h", ".guardstein-mcp-https_guardstein_com.json"));
  assert.deepEqual(legacyCachePaths(DEFAULT_URL, "/h"), [
    join("/h", ".brainstorm-mcp-https_guardstein_com.json"),
    join("/h", ".brainstorm-mcp-https_brainstorm_cintelis_ai.json"),
  ]);
  // A custom host only ever inherits its own old token, never production's.
  assert.deepEqual(legacyCachePaths("http://localhost:3000", "/h"), [
    join("/h", ".brainstorm-mcp-http_localhost_3000.json"),
  ]);
});

test("recognises editable draw.io SVGs, and rejects plain ones", () => {
  assert.ok(isEditableDrawioSvg('<svg xmlns="x" content="&lt;mxfile host=&quot;x&quot;&gt;"><g/></svg>'));
  assert.ok(isEditableDrawioSvg('<svg content="<mxfile>" width="1"></svg>'));
  assert.ok(!isEditableDrawioSvg('<svg width="10"><rect/></svg>'));
  assert.ok(!isEditableDrawioSvg('<svg content="something else"></svg>'));
});

test("recognises a PNG with an embedded diagram", () => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(isEditableDrawioPng(Buffer.concat([sig, Buffer.from("tEXtmxfile%3C")])));
  assert.ok(!isEditableDrawioPng(Buffer.concat([sig, Buffer.from("IDAT")])));
  assert.ok(!isEditableDrawioPng(Buffer.from("not a png")));
});

const NOTE = "# Design\n\nIntro.\n\n## Architecture\n\nText.\n\n![Old](assets/aaaa1111-flow.drawio.svg)\n\n## Risks\n";
const FIG = "![Flow](assets/bbbb2222-flow.drawio.svg)";

test("appends by default", () => {
  assert.ok(insertDiagram(NOTE, FIG).endsWith(`## Risks\n\n${FIG}\n`));
});

test("inserts under a named heading", () => {
  const out = insertDiagram(NOTE, FIG, { afterHeading: "Architecture" });
  assert.ok(out.indexOf(FIG) > out.indexOf("## Architecture"));
  assert.ok(out.indexOf(FIG) < out.indexOf("Text."));
  assert.throws(() => insertDiagram(NOTE, FIG, { afterHeading: "Nope" }), /no heading "Nope"/);
});

test("replaces exactly the old figure, and says so when it is missing", () => {
  const out = insertDiagram(NOTE, FIG, { replaceLink: "assets/aaaa1111-flow.drawio.svg" });
  assert.ok(out.includes(FIG) && !out.includes("aaaa1111"));
  assert.throws(() => insertDiagram(NOTE, FIG, { replaceLink: "assets/zzzz.drawio.svg" }), /no image link/);
});

test("a link containing regex characters is matched literally", () => {
  const note = "![x](assets/a+b(1).drawio.svg)";
  assert.equal(insertDiagram(note, FIG, { replaceLink: "assets/a+b(1).drawio.svg" }), FIG);
});
