import test from "node:test";
import assert from "node:assert/strict";
import { normalizeExecutionMode } from "../src/services/runninghub.js";

test("normalizeExecutionMode maps legacy and current values", () => {
  assert.equal(normalizeExecutionMode("local"), "local");
  assert.equal(normalizeExecutionMode("runninghub"), "runninghub-app");
  assert.equal(normalizeExecutionMode("runninghub-app"), "runninghub-app");
  assert.equal(normalizeExecutionMode("runninghub-wf"), "runninghub-wf");
  assert.equal(normalizeExecutionMode(undefined), "local");
  assert.equal(normalizeExecutionMode("unknown"), "local");
});
