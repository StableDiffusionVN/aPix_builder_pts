import YAML from "yaml";
import {
  state,
  els,
  BUILTIN_TEMPLATES,
  SETTINGS_KEY,
  TEMPLATE_FOLDER_KEY,
  DEFAULT_SERVER,
  byId,
  setStatus,
  setProgress,
  setImageInputValue,
  readSettings,
  saveSettings
} from "./state.js";

import {
  getSelectionInfo,
  prepareSelectionLayerInputDataUrl,
  exportActiveDocumentDataUrl,
  importBufferAsLayer
} from "./services/photoshop.js";

import {
  normalizeComfyTarget,
  getClientId,
  parseDataUrl,
  uploadImageToComfy,
  resolveWorkflowInput,
  setWorkflowValue,
  queuePrompt,
  waitForPromptCompletion,
  getHistory,
  collectOutputs,
  fetchOutputBytes,
  fetchServerChoices,
  canonicalDynamicType
} from "./services/comfy.js";

import {
  renderDynamicForm,
  updateServerSelects
} from "./ui/form.js";

const fs = require("fs");
const { storage } = require("uxp");

function cloneData(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function isImageInputItem(item) {
  const type = String(item?.ui?.type || "").toLowerCase();
  return type === "image" || type === "image_mask" || type === "file";
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
    setStatus("Queueing prompt...");
    const queued = await queuePrompt(target, workflow, state.abortController.signal);
    state.activePromptId = queued.prompt_id;
    setStatus(`Queued prompt ${queued.prompt_id}`);
    await waitForPromptCompletion(target, queued.prompt_id, state.abortController.signal);
    setStatus("Loading output history...");
    const historyRoot = await getHistory(target, queued.prompt_id, state.abortController.signal);
    const outputs = collectOutputs(state.config, historyRoot[queued.prompt_id], target);
    
    let importedCount = 0;
    for (const output of outputs) {
      const { buffer } = await fetchOutputBytes(output, state.abortController.signal);
      await importBufferAsLayer(buffer, output.filename, selectionInfo);
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
