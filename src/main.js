import YAML from "yaml";

const photoshop = require("photoshop");
const { app, core, imaging } = photoshop;
const { batchPlay } = photoshop.action;
const { storage } = require("uxp");
const fs = require("fs");

const BUILTIN_TEMPLATES = [
  "klein-edit-image",
  "fashion-flatlay",
  "mask-upscale",
  "test-2output",
  "upscale-klein"
];
const SETTINGS_KEY = "apix-builder:settings:v1";
const TEMPLATE_FOLDER_KEY = "apix-builder:template-folder:v1";
const DEFAULT_SERVER = "http://127.0.0.1:8188";

const state = {
  settings: { serverUrl: DEFAULT_SERVER },
  templates: [],
  selectedTemplate: null,
  config: null,
  workflow: null,
  values: {},
  imageValues: {},
  imageSources: {},
  imagePreviews: {},
  serverChoices: {},
  abortController: null,
  activeWebSocket: null,
  activePromptId: null,
  running: false,
  lastRunEventAt: 0
};

const els = {};

function byId(id) {
  return document.getElementById(id);
}

function setStatus(message) {
  els.statusText.textContent = message;
}

function setProgress(value, max) {
  if (Number.isFinite(value) && Number.isFinite(max) && max > 0) {
    els.progressBar.hidden = false;
    els.progressBar.max = max;
    els.progressBar.value = value;
  } else {
    els.progressBar.hidden = true;
    els.progressBar.value = 0;
  }
}

function setImageInputValue(key, dataUrl, source) {
  state.values[key] = dataUrl;
  state.imageValues[key] = dataUrl;
  state.imageSources[key] = source;
  const preview = state.imagePreviews[key];
  if (preview) {
    preview.src = dataUrl;
    preview.hidden = false;
  }
}

function cloneData(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `apix-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]);
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new Error("Request cancelled"));
    }, { once: true });
  });
}

function isImageInputItem(item) {
  const type = String(item?.ui?.type || "").toLowerCase();
  return type === "image" || type === "image_mask" || type === "file";
}

function numericValue(value) {
  if (Number.isFinite(value)) return value;
  if (Number.isFinite(value?._value)) return value._value;
  if (Number.isFinite(value?.value)) return value.value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readSettings() {
  try {
    return { serverUrl: DEFAULT_SERVER, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { serverUrl: DEFAULT_SERVER };
  }
}

function saveSettings() {
  state.settings.serverUrl = els.serverUrlInput.value.trim() || DEFAULT_SERVER;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  setStatus("Saved settings");
}

function isLocalHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (host === "localhost" || host === "::1" || host === "0.0.0.0" || host.endsWith(".local")) return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^10(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}$/.test(host)) return true;
  return false;
}

function normalizeComfyTarget(rawAddress) {
  if (!rawAddress) throw new Error("Missing ComfyUI server URL");
  let value = String(rawAddress).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  let url = new URL(value);
  if (url.protocol === "http:" && !isLocalHost(url.hostname)) {
    url.protocol = "https:";
  }
  const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
  const username = decodeURIComponent(url.username || "");
  const password = decodeURIComponent(url.password || "");
  const authHeader = username || password ? `Basic ${btoa(`${username}:${password}`)}` : null;
  const authPart = username || password ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : "";
  return {
    label: `${url.protocol}//${authPart}${url.host}`,
    httpBase: url.origin,
    wsBase: `${wsProtocol}//${authPart}${url.host}`,
    headers: authHeader ? { authorization: authHeader } : {}
  };
}

function flattenInputs(input = {}) {
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

function normalizeId(id) {
  return Array.isArray(id) ? id.join("|") : String(id);
}

function defaultValue(item) {
  const ui = item.ui || {};
  const type = String(ui.type || "").toLowerCase();
  if (type === "seed") return "random_seed";
  if (type === "checkbox") return Boolean(ui.value);
  if (type === "boolean") return ui.value === true || ui.value === "true" ? true : false;
  if (type === "number" || type === "int" || type === "float" || type === "slider") return ui.value ?? ui.minimum ?? 0;
  if (type === "dropdown" || type === "menu" || type === "radio") return ui.value ?? ui.choices?.[0] ?? "";
  if (type === "colorpicker") return ui.value || "#10b981";
  if (type === "date") return ui.value || "";
  if (type === "json") return ui.value || "{}";
  if (canonicalDynamicType(type)) return ui.value ?? "";
  return ui.value ?? "";
}

function buildDefaults(items) {
  const values = {};
  for (const item of items) {
    if (!item.id) continue;
    values[normalizeId(item.id)] = defaultValue(item);
  }
  return values;
}

function requestPayload(items, values) {
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

function resolveWorkflowInput(workflow, id) {
  const parts = String(id).split("-");
  if (parts.length < 2) throw new Error(`Invalid YAML id "${id}". Expected "node-field".`);
  const [nodeId] = parts;
  const hasSection = parts.length >= 3;
  const section = hasSection ? parts[1] : "inputs";
  const requestedField = (hasSection ? parts.slice(2) : parts.slice(1)).join("-");
  const node = workflow[nodeId];
  if (!node) throw new Error(`Workflow node not found: ${nodeId}`);
  const nodeInputs = node[section];
  if (!nodeInputs) throw new Error(`Workflow path not found: ${nodeId}.${section}`);
  const field = Object.keys(nodeInputs).find(key => key === requestedField)
    || Object.keys(nodeInputs).find(key => key.toLowerCase() === requestedField.toLowerCase());
  if (!field) throw new Error(`Workflow field not found: ${nodeId}.${section}.${requestedField}`);
  return { nodeInputs, section, field };
}

function validateWorkflowMappings(config, workflow) {
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

function parseDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || "");
  if (!match) return null;
  return {
    mimeType: match[1],
    base64: match[2],
    blob: base64ToBlob(match[2], match[1])
  };
}

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

async function readUxFileAsDataUrl(file) {
  const bytes = await file.read({ format: storage.formats.binary });
  const ext = String(file.name || "").toLowerCase();
  const mime = ext.endsWith(".jpg") || ext.endsWith(".jpeg") ? "image/jpeg" : ext.endsWith(".webp") ? "image/webp" : "image/png";
  let binary = "";
  const buffer = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer || bytes);
  for (let i = 0; i < buffer.length; i += 1) binary += String.fromCharCode(buffer[i]);
  return `data:${mime};base64,${btoa(binary)}`;
}

function loadDataUrlImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = dataUrl;
  });
}

async function cropDataUrlToSelection(dataUrl, selectionInfo) {
  if (!selectionInfo) return dataUrl;
  if (typeof Image === "undefined") return dataUrl;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext?.("2d");
  if (!context) return dataUrl;
  const image = await loadDataUrlImage(dataUrl);
  const docWidth = numericValue(app.activeDocument.width) || image.naturalWidth;
  const docHeight = numericValue(app.activeDocument.height) || image.naturalHeight;
  const scaleX = image.naturalWidth / docWidth;
  const scaleY = image.naturalHeight / docHeight;
  const sx = Math.max(0, Math.round(selectionInfo.left * scaleX));
  const sy = Math.max(0, Math.round(selectionInfo.top * scaleY));
  const sw = Math.max(1, Math.round(selectionInfo.width * scaleX));
  const sh = Math.max(1, Math.round(selectionInfo.height * scaleY));
  canvas.width = sw;
  canvas.height = sh;
  context.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toDataURL("image/png");
}

async function getSelectionInfo() {
  try {
    const result = await core.executeAsModal(async () => batchPlay([
      {
        _obj: "get",
        _target: [
          { _property: "selection" },
          { _ref: "document", _id: app.activeDocument._id || app.activeDocument.id }
        ],
        _options: { dialogOptions: "dontDisplay" }
      }
    ], {
      synchronousExecution: true,
      modalBehavior: "execute"
    }), { commandName: "Read aPix selection" });
    const selection = result?.[0]?.selection;
    if (!selection?.left || !selection?.right || !selection?.top || !selection?.bottom) return null;
    const left = selection.left._value;
    const right = selection.right._value;
    const top = selection.top._value;
    const bottom = selection.bottom._value;
    if (![left, right, top, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
    return { left, right, top, bottom, width: right - left, height: bottom - top };
  } catch {
    return null;
  }
}

function selectionSourceBounds(selectionInfo) {
  return {
    left: Math.max(0, Math.floor(selectionInfo.left)),
    top: Math.max(0, Math.floor(selectionInfo.top)),
    right: Math.max(1, Math.ceil(selectionInfo.right)),
    bottom: Math.max(1, Math.ceil(selectionInfo.bottom))
  };
}

async function getPixelsAsDataUrl(options, commandName) {
  let imageObj = null;
  try {
    const base64 = await core.executeAsModal(async () => {
      imageObj = await imaging.getPixels(options);
      return imaging.encodeImageData({
        imageData: imageObj.imageData,
        base64: true
      });
    }, { commandName });
    return `data:image/jpeg;base64,${base64}`;
  } finally {
    try { imageObj?.imageData?.dispose?.(); } catch {}
  }
}

async function exportSelectionCompositeDataUrl(selectionInfo) {
  if (!imaging?.getPixels || !imaging?.encodeImageData) {
    throw new Error("Photoshop Imaging API is not available");
  }
  const doc = app.activeDocument;
  if (!doc) throw new Error("No active Photoshop document");
  return getPixelsAsDataUrl({
    documentID: doc.id || doc._id,
    sourceBounds: selectionSourceBounds(selectionInfo),
    colorSpace: "RGB",
    componentSize: 8,
    applyAlpha: true
  }, "Export selected pixels");
}

async function exportVisibleLayerOnlyDataUrl(layer) {
  const visibility = [];
  await core.executeAsModal(async () => {
    for (const docLayer of app.activeDocument.layers || []) {
      visibility.push([docLayer, docLayer.visible]);
      docLayer.visible = docLayer === layer;
    }
  }, { commandName: "Prepare active layer export" });
  try {
    return await exportActiveDocumentDataUrl();
  } finally {
    await core.executeAsModal(async () => {
      for (const [docLayer, visible] of visibility) {
        try { docLayer.visible = visible; } catch {}
      }
    }, { commandName: "Restore layer visibility" });
  }
}

async function exportActiveLayerDataUrl() {
  const doc = app.activeDocument;
  const layer = doc?.activeLayers?.[0];
  if (!doc || !layer) throw new Error("No active Photoshop layer");
  if (imaging?.getPixels && imaging?.encodeImageData) {
    return getPixelsAsDataUrl({
      documentID: doc.id || doc._id,
      layerID: layer.id || layer._id,
      colorSpace: "RGB",
      componentSize: 8,
      applyAlpha: true
    }, "Export active layer pixels");
  }
  return exportVisibleLayerOnlyDataUrl(layer);
}

async function reselectSelection(selectionInfo) {
  if (!selectionInfo) return;
  await batchPlay([
    {
      _obj: "set",
      _target: [{ _ref: "channel", _property: "selection" }],
      to: {
        _obj: "rectangle",
        top: { _unit: "pixelsUnit", _value: selectionInfo.top },
        left: { _unit: "pixelsUnit", _value: selectionInfo.left },
        bottom: { _unit: "pixelsUnit", _value: selectionInfo.bottom },
        right: { _unit: "pixelsUnit", _value: selectionInfo.right }
      },
      _options: { dialogOptions: "dontDisplay" }
    }
  ], {
    synchronousExecution: true,
    modalBehavior: "execute"
  });
}

async function copySelectionMergedToLayer(selectionInfo) {
  if (!selectionInfo) return null;
  let createdLayer = null;
  await core.executeAsModal(async () => {
    await reselectSelection(selectionInfo);
    try {
      await batchPlay([
        {
          _obj: "copyEvent",
          copyHint: "merged",
          _options: { dialogOptions: "dontDisplay" }
        }
      ], {
        synchronousExecution: true,
        modalBehavior: "execute"
      });
    } catch {
      await batchPlay([
        {
          _obj: "copy",
          merged: true,
          _options: { dialogOptions: "dontDisplay" }
        }
      ], {
        synchronousExecution: true,
        modalBehavior: "execute"
      });
    }
    await batchPlay([
      {
        _obj: "paste",
        antiAlias: { _enum: "antiAliasType", _value: "antiAliasNone" },
        as: { _class: "pixel" },
        _options: { dialogOptions: "dontDisplay" }
      }
    ], {
      synchronousExecution: true,
      modalBehavior: "execute"
    });
    createdLayer = app.activeDocument.activeLayers?.[0] || null;
    if (createdLayer) createdLayer.name = `aPix selection input ${Date.now()}`;
    await reselectSelection(selectionInfo);
  }, { commandName: "Create aPix selection input layer" });
  return createdLayer;
}

async function deleteLayer(layer) {
  if (!layer) return;
  try {
    await core.executeAsModal(async () => {
      await layer.delete();
    }, { commandName: "Delete aPix temporary layer" });
  } catch (error) {
    console.warn("Cannot delete temporary selection layer", error);
  }
}

async function fitActiveLayerToSelectionOrigin(selectionInfo) {
  const layer = app.activeDocument.activeLayers?.[0];
  const current = layerBounds(layer);
  if (!current) throw new Error("Cannot read temporary selection layer bounds");
  await layer.translate(-current.left, -current.top);
  const moved = layerBounds(layer);
  if (!moved) throw new Error("Cannot read moved temporary selection layer bounds");
  const widthPercent = (selectionInfo.width / moved.width) * 100;
  const heightPercent = (selectionInfo.height / moved.height) * 100;
  await batchPlay([
    {
      _obj: "transform",
      _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
      freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
      width: { _unit: "percentUnit", _value: widthPercent },
      height: { _unit: "percentUnit", _value: heightPercent },
      linked: false,
      interfaceIconFrameDimmed: { _enum: "interpolationType", _value: "bicubic" },
      _isCommand: true,
      _options: { dialogOptions: "dontDisplay" }
    }
  ], {
    synchronousExecution: true,
    modalBehavior: "execute"
  });
  const scaled = layerBounds(layer);
  if (scaled) await layer.translate(-scaled.left, -scaled.top);
}

async function exportSelectionLayerCacheDataUrl(layer, selectionInfo) {
  if (!layer) throw new Error("Missing layer to export");
  const sourceDoc = app.activeDocument;
  let dataUrl = "";
  await core.executeAsModal(async () => {
    const tempDoc = await app.documents.add({
      width: Math.max(1, Math.round(selectionInfo.width)),
      height: Math.max(1, Math.round(selectionInfo.height)),
      resolution: sourceDoc.resolution,
      mode: "RGBColorMode",
      fill: "transparent"
    });
    const duplicatedLayer = await layer.duplicate(tempDoc);
    for (const docLayer of tempDoc.layers || []) {
      docLayer.visible = docLayer === duplicatedLayer;
      docLayer.selected = docLayer === duplicatedLayer;
    }
    await fitActiveLayerToSelectionOrigin(selectionInfo);
    dataUrl = await saveActiveDocumentPngDataUrlNoModal("apix_selection_cache");
    await tempDoc.closeWithoutSaving();
  }, { commandName: "Export aPix selection cache" });
  await core.executeAsModal(async () => {
    if (selectionInfo) await reselectSelection(selectionInfo);
  }, { commandName: "Restore aPix source selection" });
  return dataUrl;
}

async function exportInputDataUrlForRun(selectionInfo) {
  const fullDataUrl = await exportActiveDocumentDataUrl();
  if (!selectionInfo) return fullDataUrl;
  try {
    return await cropDataUrlToSelection(fullDataUrl, selectionInfo);
  } catch (error) {
    console.warn("Selection crop failed, using full document input", error);
    return fullDataUrl;
  }
}

async function prepareSelectionInputDataUrl(selectionInfo, existingValue) {
  try {
    setStatus("Exporting selected pixels in background...");
    return await withTimeout(
      exportSelectionCompositeDataUrl(selectionInfo),
      10000,
      "Export selected pixels timed out"
    );
  } catch (error) {
    console.warn("Selection pixel export failed", error);
  }
  if (typeof existingValue === "string" && existingValue.startsWith("data:")) return existingValue;
  throw new Error("Cannot export selected pixels and no image input fallback is available");
}

async function prepareSelectionLayerInputDataUrl(selectionInfo, imageKey) {
  setStatus("Duplicating selection to input layer...");
  const layer = await copySelectionMergedToLayer(selectionInfo);
  if (!layer) throw new Error("Cannot create layer from selected pixels");
  setStatus("Exporting duplicated selection layer...");
  const dataUrl = await exportActiveLayerDataUrl();
  setImageInputValue(imageKey, dataUrl, "layer");
  setStatus("Selection layer image ready");
  return dataUrl;
}

async function exportActiveDocumentDataUrl() {
  if (!app.activeDocument) throw new Error("No active Photoshop document");
  const tempFolder = await storage.localFileSystem.getTemporaryFolder();
  const file = await tempFolder.createFile(`apix_${Date.now()}.png`, { overwrite: true });
  await core.executeAsModal(async () => {
    await app.activeDocument.saveAs.png(file, { compression: 6 }, true);
  }, { commandName: "Export aPix input" });
  return readUxFileAsDataUrl(file);
}

async function saveActiveDocumentPngDataUrlNoModal(prefix = "apix") {
  if (!app.activeDocument) throw new Error("No active Photoshop document");
  const tempFolder = await storage.localFileSystem.getTemporaryFolder();
  const file = await tempFolder.createFile(`${prefix}_${Date.now()}.png`, { overwrite: true });
  await app.activeDocument.saveAs.png(file, { compression: 6 }, true);
  return readUxFileAsDataUrl(file);
}

async function uploadImageToComfy(target, upload, signal) {
  const extension = upload.mimeType.includes("jpeg") ? "jpg" : upload.mimeType.split("/")[1] || "png";
  const filename = `apix_ps_${Date.now()}_${upload.index}.${extension}`;
  setStatus(`Uploading image input ${upload.index + 1}...`);
  const form = new FormData();
  form.append("image", upload.blob, filename);
  form.append("type", "input");
  form.append("overwrite", "true");
  const response = await fetch(`${target.httpBase}/upload/image`, {
    method: "POST",
    headers: target.headers,
    body: form,
    signal
  });
  if (!response.ok) throw new Error(`ComfyUI /upload/image failed: ${response.status} ${await response.text()}`);
  return response.json();
}

function uploadedName(uploaded) {
  return uploaded.name || uploaded.filename || uploaded.image || uploaded;
}

async function normalizeValues(values) {
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

async function setWorkflowValue(workflow, id, value, target, signal) {
  const { nodeInputs, section, field } = resolveWorkflowInput(workflow, id);
  if (value?.kind === "upload") {
    const uploaded = await uploadImageToComfy(target, value, signal);
    if (section === "inputs" && field.toLowerCase() === "url") {
      const query = new URLSearchParams({ filename: uploadedName(uploaded), subfolder: uploaded.subfolder || "", type: uploaded.type || "input" });
      if ("Load_url" in nodeInputs) nodeInputs.Load_url = true;
      if ("mode" in nodeInputs) nodeInputs.mode = "Url";
      if ("image" in nodeInputs) nodeInputs.image = "None";
      nodeInputs[field] = `${target.label}/view?${query.toString()}`;
      return;
    }
    if (section === "inputs" && "image" in nodeInputs) {
      if ("Load_url" in nodeInputs) nodeInputs.Load_url = false;
      if ("Url" in nodeInputs) nodeInputs.Url = "";
      if ("url" in nodeInputs) nodeInputs.url = "";
      if ("mode" in nodeInputs) nodeInputs.mode = "Image";
      nodeInputs.image = uploadedName(uploaded);
      return;
    }
  }
  nodeInputs[field] = value;
}

async function queuePrompt(target, workflow, clientId, signal) {
  const response = await fetch(`${target.httpBase}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json", ...target.headers },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    signal
  });
  if (!response.ok) throw new Error(`ComfyUI /prompt failed: ${response.status} ${await response.text()}`);
  const queued = await response.json();
  if (queued.node_errors && Object.keys(queued.node_errors).length) {
    throw new Error(`ComfyUI validation failed: ${JSON.stringify(queued.node_errors)}`);
  }
  if (!queued.prompt_id) throw new Error(`ComfyUI did not return prompt_id: ${JSON.stringify(queued)}`);
  return queued;
}

function waitForPrompt(target, promptId, clientId, signal) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${target.wsBase}/ws?clientId=${clientId}`);
    state.activeWebSocket = ws;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      state.activeWebSocket = null;
      fn(value);
    };
    signal.addEventListener("abort", () => finish(reject, new Error("Request cancelled")), { once: true });
    ws.addEventListener("message", event => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data);
      const data = message.data || {};
      if (data.prompt_id && data.prompt_id !== promptId) return;
      if (message.type === "progress") setProgress(data.value, data.max);
      if (message.type === "executing" && data.node) setStatus(`Processing node ${data.node}...`);
      if (message.type === "execution_error") {
        const detail = data.exception_message || data.exception_type || JSON.stringify(data);
        finish(reject, new Error(`ComfyUI execution error: ${detail}`));
      }
      if (message.type === "execution_interrupted") finish(reject, new Error("ComfyUI execution interrupted"));
      if (message.type === "executing" && data.node === null && data.prompt_id === promptId) finish(resolve);
    });
    ws.addEventListener("error", () => finish(reject, new Error("ComfyUI websocket error")));
    ws.addEventListener("close", () => {
      if (!settled) finish(reject, new Error("ComfyUI websocket closed before completion"));
    });
  });
}

async function getHistory(target, promptId, signal) {
  const response = await fetch(`${target.httpBase}/history/${promptId}`, {
    headers: target.headers,
    signal
  });
  if (!response.ok) throw new Error(`ComfyUI /history failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function waitForPromptHistory(target, promptId, signal) {
  while (!signal?.aborted) {
    const history = await getHistory(target, promptId, signal);
    if (history?.[promptId]) return history;
    await delay(800, signal);
  }
  throw new Error("Request cancelled");
}

async function waitForPromptCompletion(target, promptId, clientId, signal) {
  let websocketError = null;
  await Promise.race([
    waitForPrompt(target, promptId, clientId, signal).catch(error => {
      if (/execution error|execution interrupted/i.test(error.message || "")) throw error;
      websocketError = error;
      return waitForPromptHistory(target, promptId, signal);
    }),
    waitForPromptHistory(target, promptId, signal)
  ]);
  if (websocketError) {
    console.warn("ComfyUI websocket wait failed, completed through history polling", websocketError);
  }
}

function collectOutputs(config, history, target) {
  const outputIds = Object.values(config.output || {}).map(item => String(item.id));
  const outputs = [];
  for (const nodeId of outputIds) {
    const images = history?.outputs?.[nodeId]?.images || [];
    for (const image of images) {
      const query = new URLSearchParams({
        filename: image.filename,
        subfolder: image.subfolder || "",
        type: image.type || "output"
      });
      outputs.push({ nodeId, filename: image.filename, url: `${target.label}/view?${query.toString()}`, headers: target.headers });
    }
  }
  if (!outputs.length) {
    for (const [nodeId, output] of Object.entries(history?.outputs || {})) {
      for (const image of output?.images || []) {
        const query = new URLSearchParams({
          filename: image.filename,
          subfolder: image.subfolder || "",
          type: image.type || "output"
        });
        outputs.push({ nodeId, filename: image.filename, url: `${target.label}/view?${query.toString()}`, headers: target.headers });
      }
    }
  }
  return outputs;
}

async function fetchOutputBytes(output, signal) {
  const response = await fetch(output.url, {
    headers: output.headers || {},
    signal
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return {
    buffer: await response.arrayBuffer(),
    mimeType: response.headers.get("content-type") || "image/png"
  };
}

function layerBounds(layer) {
  const bounds = layer?.bounds || layer?.boundsNoEffects;
  if (!bounds) return null;
  const left = Number(bounds.left ?? bounds._left);
  const right = Number(bounds.right ?? bounds._right);
  const top = Number(bounds.top ?? bounds._top);
  const bottom = Number(bounds.bottom ?? bounds._bottom);
  if (![left, right, top, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

async function transformActiveLayerToBounds(bounds) {
  if (!bounds) return;
  await core.executeAsModal(async () => {
    const layer = app.activeDocument.activeLayers?.[0];
    const current = layerBounds(layer);
    if (!current) throw new Error("Cannot read imported layer bounds");
    const widthPercent = (bounds.width / current.width) * 100;
    const heightPercent = (bounds.height / current.height) * 100;
    await batchPlay([
      {
        _obj: "set",
        _target: [{ _ref: "channel", _property: "selection" }],
        to: { _enum: "ordinal", _value: "none" },
        _options: { dialogOptions: "dontDisplay" }
      },
      {
        _obj: "transform",
        _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
        freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
        width: { _unit: "percentUnit", _value: widthPercent },
        height: { _unit: "percentUnit", _value: heightPercent },
        linked: false,
        interfaceIconFrameDimmed: { _enum: "interpolationType", _value: "bicubic" },
        _isCommand: true,
        _options: { dialogOptions: "dontDisplay" }
      }
    ], {
      synchronousExecution: true,
      modalBehavior: "execute"
    });
    const scaled = layerBounds(layer);
    if (!scaled) throw new Error("Cannot read scaled layer bounds");
    await layer.translate(bounds.left - scaled.left, bounds.top - scaled.top);
  }, { commandName: "Fit aPix output to selection" });
}

async function importBufferAsLayer(buffer, filename = "apix_output.png", fitBounds = null) {
  if (!app.activeDocument) throw new Error("No active Photoshop document");
  const tempFolder = await storage.localFileSystem.getTemporaryFolder();
  const safeName = String(filename || "apix_output.png").replace(/[^\w.-]+/g, "_");
  const file = await tempFolder.createFile(safeName, { overwrite: true });
  await file.write(buffer, { format: storage.formats.binary });
  const token = await storage.localFileSystem.createSessionToken(file);
  let placedLayer = null;
  await core.executeAsModal(async () => {
    await batchPlay([
      {
        _obj: "placeEvent",
        null: {
          _path: token,
          _kind: "local"
        },
        freeTransformCenterState: {
          _enum: "quadCenterState",
          _value: "QCSAverage"
        },
        offset: {
          _obj: "offset",
          horizontal: { _unit: "pixelsUnit", _value: 0 },
          vertical: { _unit: "pixelsUnit", _value: 0 }
        },
        _isCommand: true,
        _options: {
          dialogOptions: "dontDisplay"
        }
      }
    ], {
      synchronousExecution: true,
      modalBehavior: "execute"
    });
    placedLayer = app.activeDocument.activeLayers?.[0] || null;
    if (placedLayer) placedLayer.name = safeName.replace(/\.[^.]+$/, "");
  }, { commandName: "Import aPix output" });
  if (fitBounds) await transformActiveLayerToBounds(fitBounds);
  return placedLayer;
}

async function importOutputAsLayer(output, signal, fitBounds = null) {
  const { buffer } = await fetchOutputBytes(output, signal);
  return importBufferAsLayer(buffer, output.filename, fitBounds);
}

async function testConnection() {
  try {
    const raw = els.serverUrlInput.value.trim() || DEFAULT_SERVER;
    const target = normalizeComfyTarget(raw);
    state.settings.serverUrl = target.label;
    els.serverUrlInput.value = target.label;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    setStatus("Connecting...");
    const response = await fetch(`${target.httpBase}/system_stats`, {
      headers: target.headers,
      credentials: "omit"
    });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    setStatus("✓ Saved — ComfyUI connected");
    fetchServerChoices().then(() => updateServerSelects()).catch(() => {});
  } catch (error) {
    const msg = error.message || String(error);
    if (/failed to fetch|network|blocked|insecure/i.test(msg)) {
      setStatus(`Connection failed: plugin may be blocking HTTP — reload plugin after saving`);
    } else {
      setStatus(`Connection failed: ${msg}`);
    }
  }
}

async function loadBuiltInTemplate(id) {
  const yamlRaw = fs.readFileSync(`plugin:templates/${id}/app_build.yaml`, "utf8");
  const workflow = JSON.parse(fs.readFileSync(`plugin:templates/${id}/api.json`, "utf8"));
  const config = YAML.parse(yamlRaw);
  return { id, name: config?.app?.name || id, source: "bundled", config, workflow };
}

async function readFolderText(folder, name) {
  const file = await folder.getEntry(name);
  return file.read();
}

async function loadFolderTemplate(folder) {
  const yamlRaw = await readFolderText(folder, "app_build.yaml");
  const apiRaw = await readFolderText(folder, "api.json");
  const config = YAML.parse(yamlRaw);
  return {
    id: `folder:${folder.name}`,
    name: `${config?.app?.name || folder.name} (folder)`,
    source: "folder",
    folder,
    config,
    workflow: JSON.parse(apiRaw)
  };
}

async function loadTemplates() {
  const templates = [];
  const errors = [];
  for (const id of BUILTIN_TEMPLATES) {
    try {
      templates.push(await loadBuiltInTemplate(id));
    } catch (error) {
      errors.push(`${id}: ${error.message}`);
      console.warn(`Failed to load bundled template ${id}`, error);
    }
  }
  try {
    const token = localStorage.getItem(TEMPLATE_FOLDER_KEY);
    if (token) {
      const folder = await storage.localFileSystem.getEntryForPersistentToken(token);
      templates.push(await loadFolderTemplate(folder));
    }
  } catch (error) {
    console.warn("Stored template folder is no longer available", error);
  }
  state.templates = templates;
  els.templateSelect.innerHTML = "";
  for (const template of templates) {
    const option = document.createElement("option");
    option.value = template.id;
    option.textContent = template.name;
    els.templateSelect.append(option);
  }
  if (templates.length) {
    await selectTemplate(templates[0].id);
  } else {
    setStatus(errors.length ? `No templates found: ${errors[0]}` : "No templates found");
  }
}

async function chooseTemplateFolder() {
  try {
    const folder = await storage.localFileSystem.getFolder();
    const token = await storage.localFileSystem.createPersistentToken(folder);
    localStorage.setItem(TEMPLATE_FOLDER_KEY, token);
    const template = await loadFolderTemplate(folder);
    state.templates = state.templates.filter(item => item.source !== "folder").concat(template);
    await refreshTemplateSelect(template.id);
    setStatus(`Loaded ${template.name}`);
  } catch (error) {
    setStatus(`Cannot load folder: ${error.message}`);
  }
}

async function refreshTemplateSelect(selectedId) {
  els.templateSelect.innerHTML = "";
  for (const template of state.templates) {
    const option = document.createElement("option");
    option.value = template.id;
    option.textContent = template.name;
    els.templateSelect.append(option);
  }
  await selectTemplate(selectedId || state.templates[0]?.id);
}

async function selectTemplate(id) {
  const template = state.templates.find(item => item.id === id);
  if (!template) return;
  try {
    state.selectedTemplate = template;
    state.config = cloneData(template.config);
    state.workflow = cloneData(template.workflow);
    validateWorkflowMappings(state.config, state.workflow);
    const inputs = flattenInputs(state.config.input || {});
    state.values = buildDefaults(inputs);
    state.imageValues = {};
    state.imageSources = {};
    state.imagePreviews = {};
    els.templateSelect.value = id;
    els.workflowTitle.textContent = state.config?.app?.name || template.name;
    renderDynamicForm(inputs);
    setStatus(`Loaded workflow ${template.name}`);
    fetchServerChoices().then(() => updateServerSelects()).catch(() => {});
  } catch (error) {
    state.selectedTemplate = null;
    state.config = null;
    state.workflow = null;
    state.values = {};
    state.imageValues = {};
    state.imageSources = {};
    state.imagePreviews = {};
    els.dynamicForm.innerHTML = "";
    els.workflowTitle.textContent = "Inputs";
    setStatus(`Workflow load failed: ${error.message}`);
  }
}

function selectedTemplateId() {
  const selected = els.templateSelect.options?.[els.templateSelect.selectedIndex];
  return selected?.value || els.templateSelect.value;
}

function markdownToHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) =>
      `<a href="#" data-href="${url}" style="color:var(--accent)">${label}</a>`)
    .replace(/\n/g, "<br>");
}

function renderSeedField(key) {
  const wrap = document.createElement("div");
  wrap.className = "seedField";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "random_seed";
  input.value = state.values[key] === "random_seed" ? "" : (state.values[key] ?? "");
  input.addEventListener("input", () => {
    const v = input.value.trim();
    state.values[key] = v === "" ? "random_seed" : Number.isFinite(Number(v)) ? Number(v) : "random_seed";
  });
  const randBtn = document.createElement("button");
  randBtn.type = "button";
  randBtn.textContent = "🎲";
  randBtn.title = "Use random seed";
  randBtn.className = "iconButton seedRandom";
  randBtn.addEventListener("click", () => {
    input.value = "";
    state.values[key] = "random_seed";
  });
  wrap.append(input, randBtn);
  return wrap;
}

// Registry: canonical type → { nodeClass, field }
const DYNAMIC_TYPE_REGISTRY = {
  checkpoints:    { aliases: ["checkpoint", "ckpt"],                        node: "CheckpointLoaderSimple", field: "ckpt_name" },
  loras:          { aliases: ["lora"],                                       node: "LoraLoader",             field: "lora_name" },
  vae:            { aliases: ["vaes"],                                       node: "VAELoader",              field: "vae_name" },
  controlnets:    { aliases: ["controlnet", "control_net"],                  node: "ControlNetLoader",       field: "control_net_name" },
  upscale_models: { aliases: ["upscale_model", "upscalers"],                 node: "UpscaleModelLoader",     field: "model_name" },
  samplers:       { aliases: ["sampler"],                                    node: "KSampler",               field: "sampler_name" },
  schedulers:     { aliases: ["scheduler"],                                  node: "KSampler",               field: "scheduler" },
  unet:           { aliases: ["unets", "diffusion_models", "diffusion_model"], node: "UNETLoader",           field: "unet_name" },
  style_models:   { aliases: ["style_model"],                                node: "StyleModelLoader",       field: "style_model_name" },
  embeddings:     { aliases: ["embedding"],                                  node: "CLIPTextEncode",         field: "text" },
  clip:           { aliases: ["clips", "text_encoders", "text_encoder"],     node: "CLIPLoader",             field: "clip_name" },
  clip_vision:    { aliases: ["clipvision", "clip_visions"],                 node: "CLIPVisionLoader",       field: "clip_name" }
};

const DYNAMIC_TYPE_ALIAS_MAP = (() => {
  const map = {};
  for (const [canonical, cfg] of Object.entries(DYNAMIC_TYPE_REGISTRY)) {
    map[canonical] = canonical;
    for (const alias of cfg.aliases) map[alias] = canonical;
  }
  return map;
})();

function canonicalDynamicType(type) {
  return DYNAMIC_TYPE_ALIAS_MAP[String(type || "").toLowerCase()] || "";
}

async function fetchServerChoices() {
  if (!state.settings.serverUrl) return;
  try {
    const target = normalizeComfyTarget(state.settings.serverUrl);
    // Deduplicate node classes (e.g. samplers+schedulers both use KSampler)
    const nodeMap = {};
    for (const [canonical, cfg] of Object.entries(DYNAMIC_TYPE_REGISTRY)) {
      if (!nodeMap[cfg.node]) nodeMap[cfg.node] = [];
      nodeMap[cfg.node].push({ canonical, field: cfg.field });
    }
    const results = await Promise.allSettled(
      Object.entries(nodeMap).map(([nodeClass, targets]) =>
        fetch(`${target.httpBase}/object_info/${nodeClass}`, { headers: target.headers })
          .then(r => r.ok ? r.json() : null)
          .then(data => ({ nodeClass, targets, data }))
      )
    );
    for (const result of results) {
      if (result.status !== "fulfilled" || !result.value?.data) continue;
      const { nodeClass, targets, data } = result.value;
      const nodeInfo = data[nodeClass];
      for (const { canonical, field } of targets) {
        const choices =
          nodeInfo?.input?.required?.[field]?.[0] ||
          nodeInfo?.input?.optional?.[field]?.[0];
        if (Array.isArray(choices) && choices.length) {
          state.serverChoices[canonical] = choices;
        }
      }
    }
  } catch (error) {
    console.warn("fetchServerChoices failed", error);
  }
}

function updateServerSelects() {
  const selects = els.dynamicForm.querySelectorAll("select[data-server-type]");
  for (const select of selects) {
    const serverType = select.dataset.serverType;
    const choices = state.serverChoices[serverType];
    if (!choices?.length) continue;
    const current = select.value;
    select.innerHTML = "";
    for (const choice of choices) {
      const opt = document.createElement("option");
      opt.value = choice;
      opt.textContent = choice;
      select.append(opt);
    }
    select.value = choices.includes(current) ? current : choices[0];
    const key = select.dataset.stateKey;
    if (key) state.values[key] = select.value;
  }
}

function renderDynamicForm(items) {
  els.dynamicForm.innerHTML = "";
  for (const item of items) {
    const ui = item.ui || {};
    const type = String(ui.type || "string").toLowerCase();
    if (type === "note" || type === "markdown") {
      const note = document.createElement("div");
      note.className = "note";
      note.innerHTML = markdownToHtml(ui.markdown || ui.value || "");
      note.querySelectorAll("a[data-href]").forEach(a => {
        a.addEventListener("click", e => {
          e.preventDefault();
          try { require("uxp").shell.openExternal(a.dataset.href); } catch {}
        });
      });
      els.dynamicForm.append(note);
      continue;
    }
    if (type === "html") {
      const block = document.createElement("div");
      block.className = "note";
      block.innerHTML = ui.value || "";
      els.dynamicForm.append(block);
      continue;
    }
    if (!item.id) continue;
    const key = normalizeId(item.id);
    const field = document.createElement("label");
    field.className = "field";
    const label = document.createElement("span");
    label.textContent = ui.label || item.key;
    field.append(label);

    const isSlider = type === "slider" || ui.display === "slider";
    const isDynamic = Boolean(canonicalDynamicType(type));

    if (type === "image" || type === "image_mask" || type === "file") {
      field.append(renderImageField(key));
    } else if (type === "text") {
      const textarea = document.createElement("textarea");
      textarea.value = state.values[key] ?? "";
      textarea.addEventListener("input", () => { state.values[key] = textarea.value; });
      field.append(textarea);
    } else if (type === "string") {
      const multiline = ui.display === "multiline" || ui.multiline === true || Number(ui.lines || 1) > 1;
      if (multiline) {
        const textarea = document.createElement("textarea");
        textarea.rows = ui.lines || 3;
        textarea.placeholder = ui.placeholder || "";
        textarea.value = state.values[key] ?? "";
        textarea.addEventListener("input", () => { state.values[key] = textarea.value; });
        field.append(textarea);
      } else {
        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = ui.placeholder || "";
        input.value = state.values[key] ?? "";
        input.addEventListener("input", () => { state.values[key] = input.value; });
        field.append(input);
      }
    } else if (["int", "float", "number", "slider"].includes(type)) {
      if (isSlider) {
        field.classList.add("field--slider");
      } else {
        field.classList.add("field--inline");
      }
      field.append(renderNumberField(key, ui, type));
    } else if (type === "seed") {
      field.classList.add("field--inline");
      field.append(renderSeedField(key));
    } else if (type === "radio") {
      field.append(renderRadioField(key, ui));
    } else if (["dropdown", "menu"].includes(type) || isDynamic) {
      field.append(renderSelectField(key, ui, type));
    } else if (type === "boolean") {
      field.classList.add("field--inline");
      field.append(renderBooleanField(key));
    } else if (type === "checkbox") {
      field.classList.add("field--inline");
      field.append(renderCheckboxField(key));
    } else if (type === "colorpicker") {
      const input = document.createElement("input");
      input.type = "color";
      input.value = state.values[key] || "#10b981";
      input.addEventListener("input", () => { state.values[key] = input.value; });
      field.classList.add("field--inline");
      field.append(input);
    } else if (type === "date") {
      const input = document.createElement("input");
      input.type = "date";
      input.value = state.values[key] || "";
      input.addEventListener("input", () => { state.values[key] = input.value; });
      field.classList.add("field--inline");
      field.append(input);
    } else if (type === "json") {
      const textarea = document.createElement("textarea");
      textarea.rows = 5;
      textarea.value = state.values[key] ?? "{}";
      textarea.addEventListener("input", () => { state.values[key] = textarea.value; });
      field.append(textarea);
    } else {
      // fallback: single-line text
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = ui.placeholder || "";
      input.value = state.values[key] ?? "";
      input.addEventListener("input", () => { state.values[key] = input.value; });
      field.append(input);
    }
    els.dynamicForm.append(field);
  }
}

function renderImageField(key) {
  const wrap = document.createElement("div");
  wrap.className = "imageField";
  const actions = document.createElement("div");
  actions.className = "imageActions";
  const fromDoc = document.createElement("button");
  fromDoc.type = "button";
  fromDoc.textContent = "Document";
  const fromLayer = document.createElement("button");
  fromLayer.type = "button";
  fromLayer.textContent = "Layer";
  const choose = document.createElement("button");
  choose.type = "button";
  choose.textContent = "File";
  const preview = document.createElement("img");
  preview.className = "preview";
  preview.hidden = true;
  state.imagePreviews[key] = preview;

  const setImageValue = (dataUrl, source) => {
    setImageInputValue(key, dataUrl, source);
  };

  fromDoc.addEventListener("click", async () => {
    try {
      setStatus("Exporting active Photoshop document...");
      const dataUrl = await exportActiveDocumentDataUrl();
      setImageValue(dataUrl, "document");
      setStatus("Document image ready");
    } catch (error) {
      setStatus(`Export failed: ${error.message}`);
    }
  });

  fromLayer.addEventListener("click", async () => {
    try {
      setStatus("Exporting active Photoshop layer...");
      const dataUrl = await exportActiveLayerDataUrl();
      setImageValue(dataUrl, "layer");
      setStatus("Layer image ready");
    } catch (error) {
      setStatus(`Layer export failed: ${error.message}`);
    }
  });

  choose.addEventListener("click", async () => {
    try {
      const file = await storage.localFileSystem.getFileForOpening({
        types: ["png", "jpg", "jpeg", "webp"]
      });
      const dataUrl = await readUxFileAsDataUrl(file);
      setImageValue(dataUrl, "file");
      setStatus(`Selected ${file.name}`);
    } catch (error) {
      setStatus(`File selection failed: ${error.message}`);
    }
  });

  actions.append(fromDoc, fromLayer, choose);
  wrap.append(actions, preview);
  return wrap;
}

function renderNumberField(key, ui, type) {
  const wrap = document.createElement("div");
  const input = document.createElement("input");
  input.type = ui.display === "slider" || type === "slider" ? "range" : "number";
  if (ui.minimum != null) input.min = ui.minimum;
  if (ui.maximum != null) input.max = ui.maximum;
  if (ui.step != null) input.step = ui.step;
  input.value = state.values[key] ?? 0;
  const valueLabel = document.createElement("span");
  valueLabel.textContent = input.value;
  input.addEventListener("input", () => {
    const raw = input.value;
    state.values[key] = raw === "" ? "" : type === "int" ? Math.trunc(Number(raw)) : Number(raw);
    valueLabel.textContent = String(state.values[key]);
  });
  wrap.append(input, valueLabel);
  return wrap;
}

function renderSelectField(key, ui, type) {
  const select = document.createElement("select");
  const serverType = canonicalDynamicType(type);
  const serverChoices = serverType ? state.serverChoices[serverType] : null;
  const choices = serverChoices?.length ? serverChoices
    : ui.choices?.length ? ui.choices
    : [ui.value || ""].filter(Boolean);
  if (serverType && !choices.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Chưa kết nối server...";
    select.append(opt);
  }
  for (const choice of choices) {
    const option = document.createElement("option");
    option.value = choice;
    option.textContent = choice;
    select.append(option);
  }
  select.value = state.values[key] ?? choices[0] ?? "";
  select.addEventListener("change", () => { state.values[key] = select.value; });
  if (serverType) {
    select.dataset.serverType = serverType;
    select.dataset.stateKey = key;
  }
  return select;
}

function renderRadioField(key, ui) {
  const wrap = document.createElement("div");
  wrap.className = "radioGroup";
  const choices = ui.choices || [];
  for (const choice of choices) {
    const radioLabel = document.createElement("label");
    radioLabel.className = "radioItem";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = `radio-${key}`;
    input.value = choice;
    input.checked = (state.values[key] ?? choices[0]) === choice;
    input.addEventListener("change", () => { if (input.checked) state.values[key] = choice; });
    const span = document.createElement("span");
    span.textContent = choice;
    radioLabel.append(input, span);
    wrap.append(radioLabel);
  }
  return wrap;
}

function renderBooleanField(key) {
  const wrap = document.createElement("div");
  wrap.className = "booleanToggle";
  const trueBtn = document.createElement("button");
  trueBtn.type = "button";
  trueBtn.textContent = "True";
  const falseBtn = document.createElement("button");
  falseBtn.type = "button";
  falseBtn.textContent = "False";
  const update = () => {
    const val = state.values[key];
    trueBtn.classList.toggle("active", val === true);
    falseBtn.classList.toggle("active", val === false);
  };
  trueBtn.addEventListener("click", () => { state.values[key] = true; update(); });
  falseBtn.addEventListener("click", () => { state.values[key] = false; update(); });
  update();
  wrap.append(trueBtn, falseBtn);
  return wrap;
}

function renderCheckboxField(key) {
  const wrap = document.createElement("div");
  wrap.className = "inlineCheckbox";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = Boolean(state.values[key]);
  input.addEventListener("change", () => { state.values[key] = input.checked; });
  wrap.append(input);
  return wrap;
}

async function runWorkflow() {
  setStatus("Starting workflow...");
  if (state.running) {
    setStatus("Workflow is already running");
    return;
  }
  state.running = true;
  if (!state.config || !state.workflow) {
    await selectTemplate(selectedTemplateId());
    if (!state.config || !state.workflow) {
      setStatus("Select a workflow first");
      state.running = false;
      return;
    }
  }
  saveSettings();
  els.runBtn.disabled = true;
  els.cancelBtn.disabled = false;
  setProgress();
  state.abortController = new AbortController();

  try {
    const selectionInfo = await getSelectionInfo();
    if (selectionInfo) setStatus("Selection detected, preparing selection-aware run...");
    const target = normalizeComfyTarget(state.settings.serverUrl);
    const workflow = cloneData(state.workflow);
    const inputs = flattenInputs(state.config.input || {});
    const request = requestPayload(inputs, state.values);
    if (selectionInfo) {
      const imageInput = inputs.find(item => item.id && isImageInputItem(item));
      if (imageInput) {
        const imageKey = normalizeId(imageInput.id);
        const requestKey = Array.isArray(imageInput.id) ? imageInput.id[0] : imageInput.id;
        request[requestKey] = await prepareSelectionLayerInputDataUrl(selectionInfo, imageKey);
      }
    } else {
      // Không có vùng chọn: kiểm tra các image input chưa được gán giá trị
      const imageInputs = inputs.filter(item => item.id && isImageInputItem(item));
      const missingImageInputs = imageInputs.filter(item => {
        const key = normalizeId(item.id);
        const val = state.values[key];
        return !val || (typeof val === "string" && !val.startsWith("data:"));
      });
      if (missingImageInputs.length > 0) {
        setStatus("Không có ảnh input, tự động dùng document hiện tại...");
        const docDataUrl = await exportActiveDocumentDataUrl();
        for (const item of missingImageInputs) {
          const key = normalizeId(item.id);
          const requestKey = Array.isArray(item.id) ? item.id[0] : item.id;
          setImageInputValue(key, docDataUrl, "document");
          request[requestKey] = docDataUrl;
        }
      }
    }
    const normalized = await normalizeValues(request);
    setStatus("Patching workflow...");
    for (const [id, value] of Object.entries(normalized)) {
      await setWorkflowValue(workflow, id, value, target, state.abortController.signal);
    }
    const clientId = createId();
    setStatus("Queueing prompt...");
    const queued = await queuePrompt(target, workflow, clientId, state.abortController.signal);
    state.activePromptId = queued.prompt_id;
    setStatus(`Queued prompt ${queued.prompt_id}`);
    await waitForPromptCompletion(target, queued.prompt_id, clientId, state.abortController.signal);
    setStatus("Loading output history...");
    const historyRoot = await getHistory(target, queued.prompt_id, state.abortController.signal);
    const outputs = collectOutputs(state.config, historyRoot[queued.prompt_id], target);
    outputs.forEach(output => { output.fitBounds = selectionInfo; });
    let importedCount = 0;
    for (const output of outputs) {
      await importOutputAsLayer(output, state.abortController.signal, selectionInfo);
      importedCount += 1;
    }
    setProgress();
    setStatus(outputs.length ? `Completed prompt ${queued.prompt_id}, imported ${importedCount} layer(s)` : `Completed prompt ${queued.prompt_id}, no output images found`);
  } catch (error) {
    setProgress();
    setStatus(`Run failed: ${error.message}`);
    console.error(error);
  } finally {
    els.runBtn.disabled = false;
    els.cancelBtn.disabled = true;
    state.abortController = null;
    state.activePromptId = null;
    state.running = false;
  }
}

async function cancelRun() {
  try {
    if (!state.abortController && !state.activePromptId) {
      setStatus("No active request to cancel");
      return;
    }
    state.abortController?.abort();
    state.activeWebSocket?.close();
    const target = normalizeComfyTarget(state.settings.serverUrl);
    await fetch(`${target.httpBase}/interrupt`, {
      method: "POST",
      headers: { "content-type": "application/json", ...target.headers },
      body: "{}"
    });
    setStatus(state.activePromptId ? `Interrupt requested for prompt ${state.activePromptId}` : "Global interrupt requested");
  } catch (error) {
    setStatus(`Cancel failed: ${error.message}`);
  }
}

function startRunFromUi(event) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  const now = Date.now();
  if (now - state.lastRunEventAt < 600) return;
  state.lastRunEventAt = now;
  setStatus("Run click received...");
  if (els.runBtn.disabled && !state.running) {
    els.runBtn.disabled = false;
  }
  runWorkflow().catch(error => {
    console.error(error);
    setStatus(`Run failed: ${error.message}`);
    els.runBtn.disabled = false;
    els.cancelBtn.disabled = true;
    state.abortController = null;
    state.activePromptId = null;
    state.running = false;
  });
}

function isRunButtonEvent(event) {
  const target = event?.target;
  if (!target) return false;
  if (target.id === "runBtn") return true;
  if (target.dataset?.action === "run") return true;
  return Boolean(target.closest?.("#runBtn,[data-action='run']"));
}

function delegatedRunHandler(event) {
  if (!isRunButtonEvent(event)) return;
  startRunFromUi(event);
}

function safeBind(element, eventName, handler, label, options) {
  try {
    element?.addEventListener?.(eventName, handler, options);
  } catch (error) {
    console.warn(`Cannot bind ${label || eventName}`, error);
  }
}

function bindEvents() {
  els.runBtn.onclick = startRunFromUi;
  safeBind(els.runBtn, "click", startRunFromUi, "run click");
  safeBind(els.runBtn, "pointerup", startRunFromUi, "run pointerup");
  safeBind(els.runBtn, "mouseup", startRunFromUi, "run mouseup");
  safeBind(els.runBtn, "touchend", startRunFromUi, "run touchend");
  safeBind(document, "click", delegatedRunHandler, "document run click", true);
  safeBind(document, "pointerup", delegatedRunHandler, "document run pointerup", true);
  safeBind(document, "mouseup", delegatedRunHandler, "document run mouseup", true);
  safeBind(document.body, "click", delegatedRunHandler, "body run click", true);
  safeBind(window, "click", delegatedRunHandler, "window run click", true);
  safeBind(window, "pointerup", delegatedRunHandler, "window run pointerup", true);

  safeBind(els.testConnectionBtn, "click", testConnection, "test click");
  safeBind(els.refreshTemplatesBtn, "click", loadTemplates, "refresh click");
  safeBind(els.chooseTemplateFolderBtn, "click", chooseTemplateFolder, "folder click");
  safeBind(els.templateSelect, "change", () => selectTemplate(selectedTemplateId()), "template change");
  safeBind(els.templateSelect, "input", () => selectTemplate(selectedTemplateId()), "template input");
  safeBind(els.cancelBtn, "click", cancelRun, "cancel click");
}

function initElements() {
  [
    "serverUrlInput",
    "testConnectionBtn",
    "refreshTemplatesBtn",
    "chooseTemplateFolderBtn",
    "templateSelect",
    "workflowTitle",
    "dynamicForm",
    "statusText",
    "progressBar",
    "runBtn",
    "cancelBtn"
  ].forEach(id => { els[id] = byId(id); });
}

document.addEventListener("DOMContentLoaded", async () => {
  initElements();
  state.settings = readSettings();
  els.serverUrlInput.value = state.settings.serverUrl;
  bindEvents();
  await loadTemplates();
});
