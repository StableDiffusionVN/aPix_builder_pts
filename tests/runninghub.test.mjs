import assert from "node:assert/strict";
import test from "node:test";
import {
  extractRunningHubWorkflowId,
  inferRunningHubFieldType,
  isRhInsufficientCoins,
  isRhQueueMaxed,
  isRunningHubWfTemplate,
  parseRhApiKeys,
  parseWorkflowFieldId,
  payloadToRunningHubNodes,
  runningHubTaskOptions,
  runWithRhFailover,
  usesSavedWorkflowJson
} from "../src/services/runninghub.js";

test("parseWorkflowFieldId supports node-inputs-field ids", () => {
  assert.deepEqual(parseWorkflowFieldId("14-inputs-resize_type.longer_size"), {
    nodeId: "14",
    fieldName: "resize_type.longer_size"
  });
  assert.deepEqual(parseWorkflowFieldId("48-image"), {
    nodeId: "48",
    fieldName: "image"
  });
});

test("payloadToRunningHubNodes infers image field types", () => {
  const nodes = payloadToRunningHubNodes({
    "48-image": "data:image/png;base64,abc",
    "49-value": "hello",
    "51-value": 2048
  });
  assert.equal(nodes.length, 3);
  assert.equal(nodes[0].fieldType, "IMAGE");
  assert.equal(nodes[1].fieldType, "STRING");
  assert.equal(nodes[2].fieldType, "INT");
});

test("isRunningHubWfTemplate detects runninghub.workflowId", () => {
  assert.equal(isRunningHubWfTemplate({ runninghub: { workflowId: "123" } }), true);
  assert.equal(isRunningHubWfTemplate({ app: { name: "Local" } }), false);
});

test("usesSavedWorkflowJson follows saveWorkflowJson flag", () => {
  assert.equal(usesSavedWorkflowJson({ runninghub: { saveWorkflowJson: false } }, true), false);
  assert.equal(usesSavedWorkflowJson({ runninghub: { saveWorkflowJson: true } }, false), true);
  assert.equal(usesSavedWorkflowJson({}, true), true);
  assert.equal(usesSavedWorkflowJson({}, false), false);
});

test("runningHubTaskOptions maps optional task flags", () => {
  assert.deepEqual(runningHubTaskOptions({
    runninghub: {
      addMetadata: true,
      usePersonalQueue: true,
      accessPassword: " secret "
    }
  }), {
    addMetadata: true,
    accessPassword: "secret",
    usePersonalQueue: true
  });
});

test("extractRunningHubWorkflowId reads yaml raw fallback", () => {
  const raw = 'runninghub:\n  workflowId: "2064644362323189762"';
  assert.equal(
    extractRunningHubWorkflowId(raw, { runninghub: { workflowId: "" } }),
    "2064644362323189762"
  );
});

test("inferRunningHubFieldType handles upload objects", () => {
  assert.equal(inferRunningHubFieldType("image", { kind: "upload", blob: {} }), "IMAGE");
});

test("parseRhApiKeys tách key theo dấu phẩy/xuống dòng", () => {
  assert.deepEqual(parseRhApiKeys("key1, key2\nkey3,,"), ["key1", "key2", "key3"]);
  assert.deepEqual(parseRhApiKeys(""), []);
});

test("isRhInsufficientCoins nhận diện code và message", () => {
  assert.equal(isRhInsufficientCoins({ code: 1001 }), true);
  assert.equal(isRhInsufficientCoins({ code: "1004" }), true);
  assert.equal(isRhInsufficientCoins({ message: "Số dư không đủ" }), true);
  assert.equal(isRhInsufficientCoins({ message: "积分不足" }), true);
  assert.equal(isRhInsufficientCoins({ code: 805, message: "task failed" }), false);
});

test("isRhQueueMaxed nhận diện 421/415/TASK_QUEUE_MAXED", () => {
  assert.equal(isRhQueueMaxed({ code: 421 }), true);
  assert.equal(isRhQueueMaxed({ code: "415" }), true);
  assert.equal(isRhQueueMaxed({ message: "TASK_QUEUE_MAXED" }), true);
  assert.equal(isRhQueueMaxed({ code: 805 }), false);
});

test("runWithRhFailover chuyển key khi hết điểm, giữ nguyên lỗi khác", async () => {
  const attempts = [];
  const result = await runWithRhFailover("k1,k2", null, async key => {
    attempts.push(key);
    if (key === "k1") {
      const error = new Error("insufficient coins");
      error.code = 1001;
      throw error;
    }
    return `ok-${key}`;
  });
  assert.equal(result, "ok-k2");
  assert.deepEqual(attempts, ["k1", "k2"]);

  // Lỗi không retryable (805) → ném ngay, không thử key kế.
  const tried = [];
  await assert.rejects(
    runWithRhFailover("k1,k2", null, async key => {
      tried.push(key);
      const error = new Error("task failed");
      error.code = 805;
      throw error;
    }),
    /task failed/
  );
  assert.deepEqual(tried, ["k1"]);

  // AbortError → ném ngay kể cả retryable đứng sau.
  await assert.rejects(
    runWithRhFailover("k1,k2", null, async () => {
      const error = new Error("cancelled");
      error.name = "AbortError";
      throw error;
    }),
    { name: "AbortError" }
  );
});
