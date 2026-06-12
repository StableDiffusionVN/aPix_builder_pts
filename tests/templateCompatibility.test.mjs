import assert from "node:assert/strict";
import test from "node:test";
import {
  lookupMenuSubFields,
  menuChoiceOptions,
  parseMenuChoice,
  parseMenuChoices,
  resolveMenuStoredValue
} from "../src/lib/menuChoices.js";
import {
  filterFolderEntries,
  isConfigBucketName,
  isFolderEntry,
  pickTemplateScanTargets,
  shouldRecurseIntoScanTarget,
  templateDisplayName,
  templateFolderId
} from "../src/lib/templateFolder.js";
import {
  buildDefaults,
  flattenInputs,
  getMenuSubOptions,
  requestPayload
} from "../src/services/workflow.js";

test("parseMenuChoice supports Label:API syntax", () => {
  const parsed = parseMenuChoice("Portrait:9:16", { labelSyntax: true });
  assert.deepEqual(parsed, { label: "Portrait", value: "9:16", raw: "Portrait:9:16" });
});

test("resolveMenuStoredValue maps legacy label to API value", () => {
  const choices = ["Fast:fast", "Detail:detail"];
  assert.equal(resolveMenuStoredValue("Detail", choices, { labelSyntax: true }), "detail");
  assert.equal(resolveMenuStoredValue("detail", choices, { labelSyntax: true }), "detail");
});

test("lookupMenuSubFields resolves sub by API value", () => {
  const sub = {
    fast: { steps: { id: "2-steps", ui: { type: "int", value: 4 } } },
    detail: { cfg: { id: "2-cfg", ui: { type: "float", value: 7 } } }
  };
  const fields = lookupMenuSubFields(sub, "detail", ["Fast:fast", "Detail:detail"], { labelSyntax: true });
  assert.ok(fields.cfg);
});

test("menu-sub uses menuLabelSyntax in options and payload", () => {
  const items = flattenInputs({
    mode: {
      ui: {
        type: "menu-sub",
        menuLabelSyntax: true,
        value: "Detail:detail",
        choices: ["Fast:fast", "Detail:detail"],
        sub: {
          fast: {
            denoise: { id: "2-denoise", ui: { type: "float", value: 0.4 } }
          },
          detail: {
            steps: { id: "2-steps", ui: { type: "int", value: 24 } }
          }
        }
      }
    }
  });
  const options = getMenuSubOptions(items[0]);
  assert.deepEqual(options, [
    { value: "fast", label: "Fast" },
    { value: "detail", label: "Detail" }
  ]);
  const values = buildDefaults(items);
  assert.equal(values["2-steps"], 24);
  const payload = requestPayload(items, values);
  assert.deepEqual(payload, { "2-steps": 24 });
});

test("template folder helpers recognize app config buckets", () => {
  assert.equal(isConfigBucketName("default-rh"), true);
  assert.equal(isConfigBucketName("random"), false);
  assert.equal(isFolderEntry({ isFolder: true }), true);
  assert.equal(isFolderEntry(null), false);
  assert.equal(filterFolderEntries([null, { isFolder: true, name: "a" }]).length, 1);
  assert.equal(
    pickTemplateScanTargets("config", [
      { isFolder: true, name: "default-rh" },
      { isFolder: true, name: "node_modules" }
    ]).map(entry => entry.name).join(","),
    "default-rh"
  );
  assert.equal(
    pickTemplateScanTargets("repo-root", [
      { isFolder: true, name: "config" },
      { isFolder: true, name: "node_modules" }
    ]).map(entry => entry.name).join(","),
    "config"
  );
  assert.equal(shouldRecurseIntoScanTarget("default-rh", 0), true);
  assert.equal(shouldRecurseIntoScanTarget("random", 0), false);
  assert.equal(templateFolderId("default/", "klein-edit-image"), "folder:default/klein-edit-image");
  assert.equal(
    templateDisplayName({ app: { name: "Klein Edit" } }, "klein-edit-image", "default/"),
    "Klein Edit (default)"
  );
});
