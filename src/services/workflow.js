import { normalizeId } from "../state.js";
import { canonicalDynamicType, parseDataUrl, resolveWorkflowInput } from "./comfy.js";

export function flattenInputs(input = {}) {
  const items = [];
  for (const [key, item] of Object.entries(input)) {
    if (item?.ui?.type === "col") {
      for (const [childKey, child] of Object.entries(item.ui.col || {})) {
        items.push({ key: `${key}.${childKey}`, ...child });
      }
    } else {
      items.push({ key, ...item });
    }
  }
  return items;
}

export function defaultValue(item) {
  const ui = item.ui || {};
  const type = String(ui.type || "").toLowerCase();
  if (type === "seed") return "random_seed";
  if (type === "checkbox") return Boolean(ui.value);
  if (type === "boolean") return ui.value === true || ui.value === "true";
  if (type === "number" || type === "int" || type === "float" || type === "slider") return ui.value ?? ui.minimum ?? 0;
  if (type === "dropdown" || type === "menu" || type === "radio") return ui.value ?? ui.choices?.[0] ?? "";
  if (type === "colorpicker") return ui.value || "#10b981";
  if (type === "date") return ui.value || "";
  if (type === "json") return ui.value || "{}";
  if (canonicalDynamicType(type)) return ui.value ?? "";
  return ui.value ?? "";
}

export function buildDefaults(items) {
  const values = {};
  for (const item of items) {
    if (!item.id) continue;
    values[normalizeId(item.id)] = defaultValue(item);
  }
  return values;
}

export function requestPayload(items, values) {
  const payload = {};
  for (const item of items) {
    if (!item.id) continue;
    const key = normalizeId(item.id);
    const value = values[key];
    if (Array.isArray(item.id)) {
      item.id.forEach((id, index) => {
        payload[id] = Array.isArray(value) ? value[index] : value;
      });
    } else {
      payload[item.id] = value;
    }
  }
  return payload;
}

export function validateWorkflowMappings(config, workflow) {
  for (const item of flattenInputs(config.input || {})) {
    if (!item.id) continue;
    const ids = Array.isArray(item.id) ? item.id : [item.id];
    ids.forEach(id => resolveWorkflowInput(workflow, id));
  }
  for (const item of Object.values(config.output || {})) {
    const nodeId = String(item.id || "");
    if (!nodeId || !workflow[nodeId]) throw new Error(`Workflow output node not found: ${nodeId}`);
  }
}

export async function normalizeValues(values) {
  const normalized = {};
  let fileIndex = 0;
  for (const [key, value] of Object.entries(values || {})) {
    if (value === "random_seed") {
      normalized[key] = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    } else if (typeof value === "string" && value.startsWith("data:")) {
      normalized[key] = { kind: "upload", index: fileIndex++, ...parseDataUrl(value) };
    } else {
      normalized[key] = value;
    }
  }
  return normalized;
}

export function isImageInputItem(item) {
  const type = String(item?.ui?.type || "").toLowerCase();
  return type === "image" || type === "image_mask" || type === "file";
}
