import assert from "node:assert/strict";
import test from "node:test";
import {
  flattenInputs,
  buildDefaults,
  requestPayload,
  validateWorkflowMappings,
  isImageInputItem
} from "../src/services/workflow.js";
import { resolveWorkflowInput } from "../src/services/comfy.js";

const config = {
  input: {
    seed: { id: "2-seed", ui: { type: "seed", value: "random_seed" } },
    group: {
      ui: {
        type: "col",
        col: {
          steps: { id: "2-steps", ui: { type: "int", value: 4 } }
        }
      }
    },
    image: { id: "5-image", ui: { type: "image" } }
  },
  output: {
    result: { id: "11" }
  }
};

const workflow = {
  "2": { inputs: { seed: 0, steps: 4 } },
  "5": { inputs: { image: "" } },
  "11": { inputs: {} }
};

test("flattenInputs expands col groups", () => {
  const items = flattenInputs(config.input);
  assert.equal(items.length, 3);
  assert.equal(items[1].key, "group.steps");
});

test("buildDefaults uses seed sentinel", () => {
  const values = buildDefaults(flattenInputs(config.input));
  assert.equal(values["2-seed"], "random_seed");
  assert.equal(values["2-steps"], 4);
});

test("requestPayload maps values to workflow ids", () => {
  const items = flattenInputs(config.input);
  const values = buildDefaults(items);
  const payload = requestPayload(items, values);
  assert.equal(payload["2-seed"], "random_seed");
  assert.equal(payload["2-steps"], 4);
});

test("validateWorkflowMappings accepts valid template", () => {
  assert.doesNotThrow(() => validateWorkflowMappings(config, workflow));
});

test("isImageInputItem includes image_mask", () => {
  assert.equal(isImageInputItem({ ui: { type: "image_mask" } }), true);
  assert.equal(isImageInputItem({ ui: { type: "text" } }), false);
});

test("resolveWorkflowInput is case-insensitive on field names", () => {
  const wf = { "1": { inputs: { CKPT_name: "model.safetensors" } } };
  const result = resolveWorkflowInput(wf, "1-ckpt_name");
  assert.equal(result.field, "CKPT_name");
});
