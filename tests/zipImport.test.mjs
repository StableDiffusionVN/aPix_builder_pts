import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";
import { unzipSync } from "fflate";
import { templatesFromZipEntries } from "../src/lib/zipImport.js";

test("templatesFromZipEntries dựng template comfy từ entry zip", () => {
  const enc = new TextEncoder();
  const cfg = JSON.stringify({ app: { name: "Zip Tpl" }, input: {}, output: { o: { id: "9" } } });
  const api = JSON.stringify({ "9": { class_type: "SaveImage" } });
  const zipped = zipSync({
    "zip-tpl/app_build.json": enc.encode(cfg),
    "zip-tpl/api.json": enc.encode(api)
  });
  const entries = unzipSync(zipped);
  const templates = templatesFromZipEntries(entries, "zip-tpl.zip");
  assert.equal(templates.length, 1);
  assert.equal(templates[0].name, "Zip Tpl (zip)");
  assert.equal(templates[0].scope, "local");
  assert.equal(templates[0].source, "zip");
  assert.ok(templates[0].workflow["9"]);
});
