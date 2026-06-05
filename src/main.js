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
  saveSettings,
  normalizeId
} from "./state.js";

import {
  getSelectionInfo,
  prepareSelectionLayerInputDataUrl,
  exportActiveDocumentDataUrl,
  importBufferAsLayer
} from "./services/photoshop.js";

import {
  normalizeComfyTarget,
  setWorkflowValue,
  queuePrompt,
  waitForPromptCompletion,
  getHistory,
  collectOutputs,
  fetchOutputBytes,
  fetchServerChoices
} from "./services/comfy.js";

import {
  flattenInputs,
  buildDefaults,
  requestPayload,
  validateWorkflowMappings,
  normalizeValues,
  isImageInputItem
} from "./services/workflow.js";

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

async function loadBuiltInTemplate(id) {
  const config = JSON.parse(fs.readFileSync(`plugin:templates/${id}/app_build.json`, "utf8"));
  const workflow = JSON.parse(fs.readFileSync(`plugin:templates/${id}/api.json`, "utf8"));
  return { id, name: config?.app?.name || id, source: "bundled", config, workflow };
}

async function readFolderText(folder, name) {
  const file = await folder.getEntry(name);
  return file.read();
}

async function loadFolderTemplate(folder) {
  let config;
  try {
    config = JSON.parse(await readFolderText(folder, "app_build.json"));
  } catch {
    throw new Error("Folder must contain app_build.json and api.json. Run npm run build to generate JSON from app_build.yaml.");
  }
  const apiRaw = await readFolderText(folder, "api.json");
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
    setStatus("Saved — ComfyUI connected");
    fetchServerChoices().then(() => updateServerSelects()).catch(() => {});
  } catch (error) {
    const msg = error.message || String(error);
    if (/failed to fetch|network|blocked|insecure/i.test(msg)) {
      setStatus("Connection failed: check server URL and reload plugin if HTTP is blocked");
    } else {
      setStatus(`Connection failed: ${msg}`);
    }
  }
}

async function runWorkflow() {
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
    setStatus("Starting workflow...");
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
      const imageInputs = inputs.filter(item => item.id && isImageInputItem(item));
      const missingImageInputs = imageInputs.filter(item => {
        const key = normalizeId(item.id);
        const val = state.values[key];
        return !val || (typeof val === "string" && !val.startsWith("data:"));
      });
      if (missingImageInputs.length > 0) {
        setStatus("No image input set — using active document...");
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
    setStatus(outputs.length
      ? `Completed prompt ${queued.prompt_id}, imported ${importedCount} layer(s)`
      : `Completed prompt ${queued.prompt_id}, no output images found`);
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
  const now = Date.now();
  if (now - state.lastRunEventAt < 400) return;
  state.lastRunEventAt = now;
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

function safeBind(element, eventName, handler, label) {
  try {
    element?.addEventListener?.(eventName, handler);
  } catch (error) {
    console.warn(`Cannot bind ${label || eventName}`, error);
  }
}

function bindEvents() {
  safeBind(els.runBtn, "click", startRunFromUi, "run click");
  safeBind(els.runBtn, "pointerup", startRunFromUi, "run pointerup");
  safeBind(els.testConnectionBtn, "click", testConnection, "test click");
  safeBind(els.refreshTemplatesBtn, "click", loadTemplates, "refresh click");
  safeBind(els.chooseTemplateFolderBtn, "click", chooseTemplateFolder, "folder click");
  safeBind(els.templateSelect, "change", () => selectTemplate(selectedTemplateId()), "template change");
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
