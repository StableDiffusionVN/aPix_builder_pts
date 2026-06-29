import {
  state,
  els,
  BUILTIN_TEMPLATES,
  BUILTIN_RH_TEMPLATES,
  SETTINGS_KEY,
  TEMPLATE_FOLDER_KEY,
  templateFolderStorageKey,
  DEFAULT_SERVER,
  byId,
  setStatus,
  setProgress,
  syncRunButtonUi,
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
  isImageInputItem,
  getActiveInputItems
} from "./services/workflow.js";

import {
  renderDynamicForm,
  updateServerSelects
} from "./ui/form.js";

import {
  setButtonIcon,
  setSettingsToggleIcon,
  syncSecretToggleButton
} from "./ui/icons.js";

import {
  buildPatchedRunningHubWorkflow,
  buildRunningHubDefaults,
  buildRunningHubNodeInfoList,
  DEFAULT_RH_WEBAPP_ID,
  extractRunningHubWorkflowId,
  fetchRunningHubOutputBytes,
  getWebappCallDemo,
  getWorkflowJson,
  isRunningHubWfTemplate,
  listNodeChoices,
  nodeFieldKey,
  nodesWithValues,
  normalizeExecutionMode,
  outputFilename,
  parsePromptTips,
  prepareNodeInfoList,
  RUNNINGHUB_APP_OPTIONS,
  setRunningHubAppOptions,
  runningHubTaskOptions,
  saveExecutionMode,
  saveRunningHubSettings,
  submitAiAppTask,
  submitWorkflowTask,
  usesSavedWorkflowJson,
  waitForTaskOutputs
} from "./services/runninghub.js";

import {
  filterFolderEntries,
  isFolderEntry,
  MAX_TEMPLATE_SCAN_DEPTH,
  pickTemplateScanTargets,
  shouldRecurseIntoScanTarget,
  templateDisplayName,
  templateFolderId,
  TEMPLATE_MANIFEST_FILES
} from "./lib/templateFolder.js";

import YAML from "yaml";
import { templatesFromZipEntries } from "./lib/zipImport.js";

const fs = require("fs");
const { storage } = require("uxp");
const SETTINGS_COLLAPSED_KEY = "apix-builder:settings-collapsed:v1";

function cloneData(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function currentExecutionMode() {
  return normalizeExecutionMode(state.settings.executionMode);
}

function modeFromElement(element) {
  return element?.getAttribute?.("data-mode") || "";
}

function isRunningHubAppMode() {
  return currentExecutionMode() === "runninghub-app";
}

function isRunningHubWfMode() {
  return currentExecutionMode() === "runninghub-wf";
}

function isRunningHubMode() {
  return isRunningHubAppMode() || isRunningHubWfMode();
}

function currentTemplateScope() {
  return isRunningHubWfMode() ? "runninghub-wf" : "local";
}

function readTemplateFolderToken(scope = currentTemplateScope()) {
  const key = templateFolderStorageKey(scope);
  let token = localStorage.getItem(key);
  if (!token && scope === "local") {
    const legacy = localStorage.getItem(TEMPLATE_FOLDER_KEY);
    if (legacy) {
      localStorage.setItem(key, legacy);
      localStorage.removeItem(TEMPLATE_FOLDER_KEY);
      token = legacy;
    }
  }
  return token;
}

function saveTemplateFolderToken(scope, token) {
  localStorage.setItem(templateFolderStorageKey(scope), token);
}

function clearTemplateFolderToken(scope) {
  localStorage.removeItem(templateFolderStorageKey(scope));
}

function runningHubNodeToInput(node) {
  const fieldType = String(node.fieldType || "").toUpperCase();
  const value = state.runningHubNodeValues[nodeFieldKey(node)] ?? node.fieldValue ?? "";
  const choices = listNodeChoices(node);
  const isLongText = String(value || "").length > 80 || /prompt|text|caption|value/i.test(node.fieldName || "");
  const type = fieldType === "IMAGE" ? "image"
    : fieldType === "AUDIO" || fieldType === "VIDEO" ? "file"
      : fieldType === "LIST" ? "dropdown"
        : fieldType === "INT" || fieldType === "INTEGER" ? "int"
          : fieldType === "FLOAT" || fieldType === "NUMBER" ? "float"
            : isLongText ? "text"
              : "string";
  return {
    key: nodeFieldKey(node),
    id: nodeFieldKey(node),
    ui: {
      type,
      label: node.description || node.nodeName || node.fieldName || node.nodeId,
      choices,
      value,
      lines: isLongText ? 4 : undefined
    }
  };
}

function runningHubAppDisplayName() {
  if (state.runningHubWebappName) return state.runningHubWebappName;
  const webappId = state.settings.runningHub?.webappId?.trim() || DEFAULT_RH_WEBAPP_ID;
  const preset = RUNNINGHUB_APP_OPTIONS.find(app => app.id === webappId);
  return preset?.name || "RunningHub Inputs";
}

function renderRunningHubForm() {
  state.values = state.runningHubNodeValues;
  els.workflowTitle.textContent = runningHubAppDisplayName();
  renderDynamicForm(state.runningHubNodes.map(runningHubNodeToInput));
}

function renderLocalForm() {
  state.values = state.localValues;
  const inputs = flattenInputs(state.config?.input || {});
  els.workflowTitle.textContent = state.config?.app?.name || state.selectedTemplate?.name || "Inputs";
  renderDynamicForm(inputs);
}

function renderActiveForm() {
  if (isRunningHubAppMode()) {
    renderRunningHubForm();
  } else if (state.config) {
    renderLocalForm();
  } else {
    els.dynamicForm.innerHTML = "";
    els.workflowTitle.textContent = "Inputs";
  }
}

function syncExecutionModeUi(mode = currentExecutionMode()) {
  if (els.executionModeSelect) els.executionModeSelect.value = mode;
  if (!els.executionModeToggle) return;
  els.executionModeToggle.querySelectorAll("[data-mode]").forEach(button => {
    const active = modeFromElement(button) === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
}

function bindExecutionModeTabs() {
  if (!els.executionModeToggle) return;
  els.executionModeToggle.querySelectorAll("[data-mode]").forEach(button => {
    safeBind(button, "click", () => {
      const nextMode = modeFromElement(button);
      if (nextMode && nextMode !== currentExecutionMode()) {
        switchExecutionMode(nextMode);
      }
    }, "mode tab");
  });
}

function syncModeVisibility() {
  const runningHub = isRunningHubMode();
  const runningHubApp = isRunningHubAppMode();
  els.runningHubSettings.hidden = !runningHub;
  if (els.runningHubAppSettings) {
    els.runningHubAppSettings.hidden = !runningHubApp;
    els.runningHubAppSettings.style.display = runningHubApp ? "" : "none";
  }
  const serverRow = findServerRow();
  if (serverRow) {
    serverRow.hidden = runningHub;
    serverRow.style.display = runningHub ? "none" : "";
  }
  if (els.localWorkflowSettings) {
    els.localWorkflowSettings.hidden = runningHubApp;
    els.localWorkflowSettings.style.display = runningHubApp ? "none" : "";
  }
  els.testConnectionBtn.disabled = runningHub;
  els.templateSelect.disabled = runningHubApp;
  els.chooseTemplateFolderBtn.disabled = runningHubApp;
  if (els.chooseTemplateZipBtn) els.chooseTemplateZipBtn.disabled = runningHubApp;
  syncRunButtonUi();
  syncRunningHubAppUi();
}

function loadBundledDefaultRhApps() {
  try {
    const raw = fs.readFileSync("plugin:default-rh-apps.json", "utf8");
    setRunningHubAppOptions(JSON.parse(raw));
  } catch (error) {
    console.warn("Using built-in RunningHub default app list", error);
  }
}

function syncRunningHubAppSelect() {
  const select = els.runningHubAppSelect || byId("runningHubAppSelect");
  if (!select) return;
  const previous = select.value;
  const savedWebappId = state.settings.runningHub?.webappId?.trim() || DEFAULT_RH_WEBAPP_ID;
  select.innerHTML = "";
  const seen = new Set();
  for (const app of RUNNINGHUB_APP_OPTIONS) {
    if (!app?.id || seen.has(app.id)) continue;
    seen.add(app.id);
    const option = document.createElement("option");
    option.value = app.id;
    option.textContent = app.name;
    select.append(option);
  }
  const customOption = document.createElement("option");
  customOption.value = "custom";
  customOption.textContent = "Custom WebApp ID";
  select.append(customOption);
  const knownPrevious = RUNNINGHUB_APP_OPTIONS.some(app => app.id === previous);
  const knownSaved = RUNNINGHUB_APP_OPTIONS.some(app => app.id === savedWebappId);
  if (previous === "custom") {
    select.value = "custom";
  } else if (knownPrevious) {
    select.value = previous;
  } else if (knownSaved) {
    select.value = savedWebappId;
  } else {
    select.value = DEFAULT_RH_WEBAPP_ID;
  }
}

function syncRunningHubAppUi() {
  if (!els.runningHubAppSelect || !els.runningHubCustomWebappField) return;
  const isCustom = els.runningHubAppSelect.value === "custom";
  els.runningHubCustomWebappField.hidden = !isCustom;
  els.runningHubCustomWebappField.style.display = isCustom ? "" : "none";
}

function applySettingsToUi() {
  els.serverUrlInput.value = state.settings.serverUrl;
  syncExecutionModeUi(currentExecutionMode());
  els.runningHubApiKeyInput.value = state.settings.runningHub?.apiKey || "";
  const webappId = state.settings.runningHub?.webappId || DEFAULT_RH_WEBAPP_ID;
  const knownApp = RUNNINGHUB_APP_OPTIONS.find(app => app.id === webappId);
  els.runningHubAppSelect.value = knownApp ? knownApp.id : "custom";
  els.runningHubCustomWebappIdInput.value = knownApp ? "" : webappId;
  syncModeVisibility();
}

async function loadBuiltInTemplate(id, scope = "local") {
  const pluginRoot = scope === "runninghub-wf" ? "plugin:templates-rh" : "plugin:templates";
  const config = JSON.parse(fs.readFileSync(`${pluginRoot}/${id}/app_build.json`, "utf8"));
  let workflow = null;
  try {
    workflow = JSON.parse(fs.readFileSync(`${pluginRoot}/${id}/api.json`, "utf8"));
  } catch {
    workflow = null;
  }
  return {
    id,
    name: config?.app?.name || id,
    source: "bundled",
    scope,
    config,
    workflow
  };
}

async function readFolderText(folder, name) {
  if (!isFolderEntry(folder)) throw new Error("Folder entry is missing");
  let file;
  try {
    file = await folder.getEntry(name);
  } catch (error) {
    throw new Error(`Cannot read ${name}: ${error.message}`);
  }
  if (!file) throw new Error(`Missing file: ${name}`);
  return file.read();
}

async function readFolderConfig(folder) {
  try {
    return JSON.parse(await readFolderText(folder, "app_build.json"));
  } catch {
    try {
      const raw = await readFolderText(folder, "app_build.yaml");
      const config = YAML.parse(raw);
      if (config?.runninghub) {
        config.runninghub.workflowId = extractRunningHubWorkflowId(raw, config);
      }
      return config;
    } catch {
      throw new Error("Folder must contain app_build.json or app_build.yaml.");
    }
  }
}

async function loadFolderTemplate(folder, options = {}) {
  const config = await readFolderConfig(folder);
  let workflow = null;
  try {
    workflow = JSON.parse(await readFolderText(folder, "api.json"));
  } catch {
    workflow = null;
  }
  const scope = isRunningHubWfTemplate(config) ? "runninghub-wf" : "local";
  return {
    id: options.id || `folder:${folder.name}`,
    name: options.name || `${config?.app?.name || folder.name} (folder)`,
    source: "folder",
    scope,
    folder,
    config,
    workflow
  };
}

async function folderEntries(folder) {
  if (!isFolderEntry(folder)) return [];
  try {
    const entries = await folder.getEntries();
    return filterFolderEntries(Array.isArray(entries) ? entries : []);
  } catch (error) {
    console.warn(`Cannot list folder ${folder.name || ""}:`, error);
    return [];
  }
}

async function folderHasTemplateManifest(folder) {
  if (!isFolderEntry(folder)) return false;
  for (const name of TEMPLATE_MANIFEST_FILES) {
    try {
      const entry = await folder.getEntry(name);
      if (entry && entry.isFile !== false) return true;
    } catch {}
  }
  return false;
}

async function discoverTemplateFolders(rootFolder, depth = 0, prefix = "") {
  const found = [];
  if (!isFolderEntry(rootFolder)) return found;

  if (await folderHasTemplateManifest(rootFolder)) {
    found.push({ folder: rootFolder, prefix });
    return found;
  }
  if (depth >= MAX_TEMPLATE_SCAN_DEPTH) return found;

  const targets = pickTemplateScanTargets(rootFolder.name, await folderEntries(rootFolder));
  for (const entry of targets) {
    if (await folderHasTemplateManifest(entry)) {
      found.push({
        folder: entry,
        prefix: prefix ? `${prefix}${entry.name}` : entry.name
      });
      continue;
    }
    if (!shouldRecurseIntoScanTarget(entry.name, depth)) continue;
    const nested = await discoverTemplateFolders(
      entry,
      depth + 1,
      prefix ? `${prefix}${entry.name}/` : `${entry.name}/`
    );
    found.push(...nested);
  }
  return found;
}

async function resolveTemplateWorkflow(template) {
  if (template.workflow) return template.workflow;
  const config = template.config;
  if (!isRunningHubWfTemplate(config)) return null;
  if (!usesSavedWorkflowJson(config, false)) return null;

  const workflowId = String(config.runninghub?.workflowId || "").trim();
  if (!workflowId) return null;

  const apiKey = state.settings.runningHub?.apiKey?.trim();
  if (!apiKey) {
    throw new Error("RunningHub API key required to fetch workflow JSON for this template");
  }

  setStatus(`Fetching workflow ${workflowId} from RunningHub...`);
  return getWorkflowJson(apiKey, workflowId, state.abortController?.signal);
}

async function loadFolderTemplates(folder) {
  const templates = [];
  const errors = [];
  const discovered = await discoverTemplateFolders(folder);

  for (const { folder: templateFolder, prefix } of discovered) {
    try {
      const template = await loadFolderTemplate(templateFolder, {
        id: templateFolderId(prefix, templateFolder.name),
        name: templateDisplayName(null, templateFolder.name, prefix)
      });
      template.name = templateDisplayName(template.config, templateFolder.name, prefix);
      templates.push(template);
    } catch (error) {
      errors.push(`${prefix || templateFolder.name}: ${error.message}`);
    }
  }

  if (!templates.length) {
    throw new Error(
      `No valid templates found. Point to a template folder or an aPix Builder config directory (default/, templates/, default-rh/, templates-rh/).${errors.length ? ` First error: ${errors[0]}` : ""}`
    );
  }
  return templates;
}

async function loadBundledTemplates(scope = "local") {
  const templates = [];
  const errors = [];
  const ids = scope === "runninghub-wf" ? BUILTIN_RH_TEMPLATES : BUILTIN_TEMPLATES;
  for (const id of ids) {
    try {
      templates.push(await loadBuiltInTemplate(id, scope));
    } catch (error) {
      errors.push(`${id}: ${error.message}`);
      console.warn(`Failed to load bundled template ${id}`, error);
    }
  }
  return { templates, errors };
}

async function loadTemplates() {
  const scope = currentTemplateScope();
  const { templates, errors } = await loadBundledTemplates(scope);
  try {
    const token = readTemplateFolderToken(scope);
    if (token && !isRunningHubAppMode()) {
      const folder = await storage.localFileSystem.getEntryForPersistentToken(token);
      if (!isFolderEntry(folder)) {
        clearTemplateFolderToken(scope);
      } else {
        const folderTemplates = (await loadFolderTemplates(folder))
          .filter(template => template.scope === scope);
        templates.push(...folderTemplates);
      }
    }
  } catch (error) {
    console.warn(`Stored template folder for ${scope} is no longer available`, error);
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
  } else if (isRunningHubAppMode()) {
    state.selectedTemplate = null;
    state.config = null;
    state.workflow = null;
    renderActiveForm();
    setStatus("RunningHub AI App mode — load nodes to begin");
  } else {
    setStatus(errors.length ? `No templates found: ${errors[0]}` : "No templates found");
  }
}

async function chooseTemplateFolder() {
  try {
    const folder = await storage.localFileSystem.getFolder();
    if (!isFolderEntry(folder)) {
      throw new Error("Please select a folder (e.g. config/ or config/default-rh/)");
    }
    const scope = currentTemplateScope();
    const token = await storage.localFileSystem.createPersistentToken(folder);
    saveTemplateFolderToken(scope, token);
    const templates = (await loadFolderTemplates(folder))
      .filter(template => template.scope === scope);
    if (!templates.length) {
      throw new Error(scope === "runninghub-wf"
        ? "No RunningHub Workflow templates found (missing runninghub.workflowId in YAML)"
        : "No local ComfyUI templates found in folder");
    }
    state.templates = state.templates
      .filter(item => item.source !== "folder" || item.scope !== scope)
      .concat(templates);
    await refreshTemplateSelect(templates[0].id);
    setStatus(`Loaded ${templates.length} template(s) from ${folder.name}`);
  } catch (error) {
    setStatus(`Cannot load folder: ${error.message}`);
  }
}

async function chooseTemplateZip() {
  try {
    const file = await storage.localFileSystem.getFileForOpening({ types: ["zip"] });
    if (!file) return;
    const { unzipSync } = await import("fflate");
    const buffer = await file.read({ format: storage.formats.binary });
    const entries = unzipSync(new Uint8Array(buffer));
    const scope = currentTemplateScope();
    const templates = templatesFromZipEntries(entries, file.name).filter(t => t.scope === scope);
    if (!templates.length) {
      throw new Error(scope === "runninghub-wf"
        ? "No RunningHub Workflow templates in .zip (missing runninghub.workflowId)"
        : "No local ComfyUI templates in .zip");
    }
    state.templates = state.templates
      .filter(item => item.source !== "zip" || item.scope !== scope)
      .concat(templates);
    await refreshTemplateSelect(templates[0].id);
    setStatus(`Loaded ${templates.length} template(s) from ${file.name}`);
  } catch (error) {
    setStatus(`Cannot load .zip: ${error.message}`);
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
    state.workflow = template.workflow ? cloneData(template.workflow) : null;
    const rhWf = template.scope === "runninghub-wf" || isRunningHubWfTemplate(state.config);
    if (rhWf && !isRunningHubWfTemplate(state.config)) {
      throw new Error("RunningHub Workflow template is missing runninghub.workflowId");
    }
    if (!state.workflow && rhWf && usesSavedWorkflowJson(state.config, false)) {
      state.workflow = await resolveTemplateWorkflow(template);
      template.workflow = cloneData(state.workflow);
    }
    if (state.workflow) {
      validateWorkflowMappings(state.config, state.workflow, { requireOutput: !rhWf });
    } else if (rhWf && usesSavedWorkflowJson(state.config, false)) {
      throw new Error("Template requires workflow JSON — add api.json or set RunningHub API key to fetch by workflowId");
    }
    const inputs = flattenInputs(state.config.input || {});
    state.localValues = buildDefaults(inputs);
    if (!isRunningHubAppMode()) state.values = state.localValues;
    state.imageValues = {};
    state.imageSources = {};
    state.imagePreviews = {};
    els.templateSelect.value = id;
    renderActiveForm();
    setStatus(`Loaded workflow ${template.name}`);
    if (!isRunningHubMode()) {
      fetchServerChoices().then(() => updateServerSelects()).catch(() => {});
    }
  } catch (error) {
    state.selectedTemplate = null;
    state.config = null;
    state.workflow = null;
    state.values = {};
    state.localValues = {};
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

async function loadRunningHubNodes() {
  saveSettings();
  const apiKey = state.settings.runningHub.apiKey.trim();
  const webappId = state.settings.runningHub.webappId.trim();
  if (!apiKey) {
    setStatus("Missing RunningHub API key");
    return [];
  }
  if (!webappId) {
    setStatus("Missing RunningHub WebApp ID");
    return [];
  }
  state.runningHubNodesLoading = true;
  state.runningHubNodesError = "";
  els.loadRunningHubNodesBtn.disabled = true;
  setStatus("Loading RunningHub app info...");
  try {
    const webapp = await getWebappCallDemo(apiKey, webappId, state.abortController?.signal);
    const nodes = webapp.nodeInfoList || [];
    state.runningHubWebappName = webapp.webappName || "";
    state.runningHubNodes = nodes;
    state.runningHubNodeValues = buildRunningHubDefaults(nodes);
    if (isRunningHubAppMode()) renderRunningHubForm();
    const appLabel = webapp.webappName ? `"${webapp.webappName}"` : webappId;
    setStatus(nodes.length
      ? `Loaded ${nodes.length} node(s) for ${appLabel}`
      : `RunningHub returned 0 nodes for ${appLabel}`);
    return nodes;
  } catch (error) {
    state.runningHubNodes = [];
    state.runningHubWebappName = "";
    state.runningHubNodeValues = {};
    state.runningHubNodesError = error.message;
    if (isRunningHubAppMode()) renderRunningHubForm();
    setStatus(`RunningHub load failed: ${error.message}`);
    return [];
  } finally {
    state.runningHubNodesLoading = false;
    els.loadRunningHubNodesBtn.disabled = false;
  }
}

function switchExecutionMode(mode) {
  const nextMode = normalizeExecutionMode(mode);
  if (isRunningHubAppMode()) state.runningHubNodeValues = state.values;
  else state.localValues = state.values;
  state.settings.executionMode = nextMode;
  syncExecutionModeUi(nextMode);
  syncModeVisibility();
  saveExecutionMode(nextMode);
  saveSettings();
  loadTemplates().then(() => {
    if (nextMode === "runninghub-app") {
      state.values = state.runningHubNodeValues;
      renderRunningHubForm();
      if (!state.runningHubNodes.length && state.settings.runningHub.apiKey) {
        loadRunningHubNodes().catch(error => setStatus(`RunningHub load failed: ${error.message}`));
      }
    } else if (nextMode === "runninghub-wf") {
      state.values = state.localValues;
      renderLocalForm();
    } else {
      state.values = state.localValues;
      renderLocalForm();
      fetchServerChoices().then(() => updateServerSelects()).catch(() => {});
    }
  }).catch(error => setStatus(`Mode switch failed: ${error.message}`));
}

async function runRunningHubWorkflow(selectionInfo) {
  const apiKey = state.settings.runningHub.apiKey.trim();
  const webappId = state.settings.runningHub.webappId.trim();
  if (!apiKey) throw new Error("Missing RunningHub API key");
  if (!webappId) throw new Error("Missing RunningHub WebApp ID");
  if (!state.runningHubNodes.length) {
    const nodes = await loadRunningHubNodes();
    if (!nodes.length) throw new Error("RunningHub node list is empty");
  }

  const imageItems = state.runningHubNodes
    .filter(node => String(node.fieldType || "").toUpperCase() === "IMAGE")
    .map(runningHubNodeToInput);
  if (selectionInfo && imageItems.length) {
    const key = normalizeId(imageItems[0].id);
    setStatus("Selection detected, using selected pixels for RunningHub image input...");
    const selectionDataUrl = await prepareSelectionLayerInputDataUrl(selectionInfo, key);
    state.values[key] = selectionDataUrl;
    state.runningHubNodeValues[key] = selectionDataUrl;
  } else {
    const missingImageItems = imageItems.filter(item => {
      const key = normalizeId(item.id);
      const val = state.values[key];
      return !val || (typeof val === "string" && !val.startsWith("data:"));
    });
    if (missingImageItems.length) {
      setStatus("No RunningHub image input set — using active document...");
      const docDataUrl = await exportActiveDocumentDataUrl();
      for (const item of missingImageItems) {
        const key = normalizeId(item.id);
        setImageInputValue(key, docDataUrl, "document");
      }
    }
  }

  const nodeInfoList = await prepareNodeInfoList(
    apiKey,
    nodesWithValues(state.runningHubNodes, state.values),
    state.abortController.signal,
    setStatus
  );
  setStatus("Submitting RunningHub task...");
  const submitted = await submitAiAppTask(apiKey, webappId, nodeInfoList, state.abortController.signal);
  const taskId = submitted.taskId;
  if (!taskId) throw new Error("RunningHub did not return taskId");
  state.activeRunningHubTaskId = String(taskId);
  setStatus(`RunningHub task ${taskId} queued`);
  const outputs = await waitForTaskOutputs(apiKey, taskId, {
    signal: state.abortController.signal,
    onStatus: setStatus
  });
  let importedCount = 0;
  for (const [index, output] of outputs.entries()) {
    const { buffer } = await fetchRunningHubOutputBytes(output, state.abortController.signal, { onStatus: setStatus });
    await importBufferAsLayer(buffer, outputFilename(output, index), selectionInfo);
    importedCount += 1;
  }
  setStatus(outputs.length
    ? `RunningHub task ${taskId} completed, imported ${importedCount} layer(s)`
    : `RunningHub task ${taskId} completed, no output files found`);
}

function activeImageInputs(inputs) {
  return getActiveInputItems(inputs, state.values)
    .filter(item => item.id && isImageInputItem(item));
}

function requestKeys(item) {
  return Array.isArray(item.id) ? item.id : [item.id];
}

function setRequestImageValue(request, item, dataUrl) {
  for (const requestKey of requestKeys(item)) {
    request[requestKey] = dataUrl;
  }
}

async function runRunningHubWfWorkflow(selectionInfo) {
  const apiKey = state.settings.runningHub.apiKey.trim();
  if (!apiKey) throw new Error("Missing RunningHub API key");
  if (!state.config) throw new Error("Select a RunningHub Workflow template first");

  const workflowId = String(state.config.runninghub?.workflowId || "").trim();
  const hasWorkflowFile = Boolean(state.workflow);
  const useSavedJson = usesSavedWorkflowJson(state.config, hasWorkflowFile);
  if (!workflowId && !useSavedJson) {
    throw new Error("Template is missing runninghub.workflowId");
  }
  if (useSavedJson && !state.workflow) {
    setStatus("Fetching RunningHub workflow JSON...");
    state.workflow = await resolveTemplateWorkflow({ config: state.config, workflow: null });
    if (!state.workflow) {
      throw new Error("Template requires workflow JSON — add api.json or set RunningHub API key to fetch by workflowId");
    }
  }

  const inputs = flattenInputs(state.config.input || {});
  const request = requestPayload(inputs, state.values);
  const imageInputs = activeImageInputs(inputs);
  if (selectionInfo) {
    const imageInput = imageInputs[0];
    if (imageInput) {
      const imageKey = normalizeId(imageInput.id);
      const selectionDataUrl = await prepareSelectionLayerInputDataUrl(selectionInfo, imageKey);
      setRequestImageValue(request, imageInput, selectionDataUrl);
    }
  } else {
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
        setImageInputValue(key, docDataUrl, "document");
        setRequestImageValue(request, item, docDataUrl);
      }
    }
  }

  const normalized = await normalizeValues(request);
  const taskOptions = runningHubTaskOptions(state.config);
  const signal = state.abortController.signal;
  let submitData;

  if (useSavedJson) {
    setStatus("Patching workflow for RunningHub...");
    const patchedWorkflow = await buildPatchedRunningHubWorkflow(
      state.workflow,
      normalized,
      apiKey,
      { signal, onStatus: setStatus }
    );
    setStatus("Submitting RunningHub workflow task...");
    submitData = await submitWorkflowTask(apiKey, {
      workflow: patchedWorkflow,
      workflowId,
      ...taskOptions
    }, signal);
  } else {
    setStatus("Preparing RunningHub node list...");
    const nodeInfoList = await buildRunningHubNodeInfoList(normalized, apiKey, {
      signal,
      onStatus: setStatus
    });
    setStatus("Submitting RunningHub workflow task...");
    submitData = await submitWorkflowTask(apiKey, {
      nodeInfoList,
      workflowId,
      ...taskOptions
    }, signal);
  }

  const promptTips = parsePromptTips(submitData.promptTips);
  if (promptTips?.node_errors && Object.keys(promptTips.node_errors).length > 0) {
    const firstError = Object.entries(promptTips.node_errors)[0];
    throw new Error(`Node ${firstError[0]} error: ${JSON.stringify(firstError[1])}`);
  }

  const taskId = submitData.taskId;
  if (!taskId) throw new Error("RunningHub did not return taskId");
  state.activeRunningHubTaskId = String(taskId);
  setStatus(`RunningHub task ${taskId} queued`);
  const outputs = await waitForTaskOutputs(apiKey, taskId, {
    signal,
    onStatus: setStatus
  });
  let importedCount = 0;
  for (const [index, output] of outputs.entries()) {
    const { buffer } = await fetchRunningHubOutputBytes(output, signal, { onStatus: setStatus });
    await importBufferAsLayer(buffer, outputFilename(output, index), selectionInfo);
    importedCount += 1;
  }
  setStatus(outputs.length
    ? `RunningHub task ${taskId} completed, imported ${importedCount} layer(s)`
    : `RunningHub task ${taskId} completed, no output files found`);
}

async function runWorkflow() {
  if (state.running) {
    setStatus("Workflow is already running");
    return;
  }
  state.running = true;
  syncRunButtonUi();
  if (!isRunningHubAppMode() && (!state.config || (!state.workflow && !isRunningHubWfMode()))) {
    await selectTemplate(selectedTemplateId());
    if (!state.config) {
      setStatus("Select a workflow first");
      state.running = false;
      syncRunButtonUi();
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
    if (isRunningHubAppMode()) {
      await runRunningHubWorkflow(selectionInfo);
      setProgress();
      return;
    }
    if (isRunningHubWfMode()) {
      await runRunningHubWfWorkflow(selectionInfo);
      setProgress();
      return;
    }
    const target = normalizeComfyTarget(state.settings.serverUrl);
    const workflow = cloneData(state.workflow);
    const inputs = flattenInputs(state.config.input || {});
    const request = requestPayload(inputs, state.values);
    const imageInputs = activeImageInputs(inputs);
    if (selectionInfo) {
      const imageInput = imageInputs[0];
      if (imageInput) {
        const imageKey = normalizeId(imageInput.id);
        const selectionDataUrl = await prepareSelectionLayerInputDataUrl(selectionInfo, imageKey);
        setRequestImageValue(request, imageInput, selectionDataUrl);
      }
    } else {
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
          setImageInputValue(key, docDataUrl, "document");
          setRequestImageValue(request, item, docDataUrl);
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
      const { buffer } = await fetchOutputBytes(output, state.abortController.signal, { onStatus: setStatus });
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
    state.activeRunningHubTaskId = null;
    state.running = false;
    syncRunButtonUi();
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
    if (isRunningHubAppMode() || isRunningHubWfMode()) {
      setStatus(state.activeRunningHubTaskId
        ? `Cancelled local wait for RunningHub task ${state.activeRunningHubTaskId}`
        : "Cancelled RunningHub request");
      return;
    }
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
    syncRunButtonUi();
  });
}

function safeBind(element, eventName, handler, label) {
  try {
    element?.addEventListener?.(eventName, handler);
  } catch (error) {
    console.warn(`Cannot bind ${label || eventName}`, error);
  }
}

function createRhAppPickerField() {
  const field = document.createElement("label");
  field.className = "field rhAppField";
  const label = document.createElement("span");
  label.textContent = "Web App";
  const row = document.createElement("div");
  row.className = "rhAppSelectRow";
  const appSelect = document.createElement("select");
  appSelect.id = "runningHubAppSelect";
  const loadBtn = document.createElement("button");
  loadBtn.id = "loadRunningHubNodesBtn";
  loadBtn.className = "iconButton";
  loadBtn.type = "button";
  row.append(appSelect, loadBtn);
  field.append(label, row);
  return field;
}

function ensureRunningHubAppPickerLayout(appWrap) {
  let appSelect = byId("runningHubAppSelect");
  let loadBtn = byId("loadRunningHubNodesBtn");

  if (!loadBtn) {
    loadBtn = document.createElement("button");
    loadBtn.id = "loadRunningHubNodesBtn";
    loadBtn.type = "button";
    loadBtn.className = "iconButton";
  }

  let row = appSelect?.closest?.(".rhAppSelectRow");
  if (!row) {
    row = document.createElement("div");
    row.className = "rhAppSelectRow";
    if (!appSelect) {
      appSelect = document.createElement("select");
      appSelect.id = "runningHubAppSelect";
    }
    const oldField = appSelect.closest?.(".field");
    if (oldField?.parentElement === appWrap && oldField.classList.contains("rhAppField")) {
      oldField.querySelector(".rhAppSelectRow")?.remove();
      row.append(appSelect, loadBtn);
      oldField.append(row);
    } else {
      if (oldField?.parentElement === appWrap) oldField.remove();
      loadBtn.remove();
      const field = createRhAppPickerField();
      appWrap.prepend(field);
      appSelect = byId("runningHubAppSelect");
      loadBtn = byId("loadRunningHubNodesBtn");
    }
  } else if (!row.contains(loadBtn)) {
    row.append(loadBtn);
  }

  loadBtn.className = "iconButton";
  setButtonIcon(loadBtn, "refresh", "Reload RunningHub nodes");
  syncRunningHubAppSelect();
}

function createField(labelText, control) {
  const field = document.createElement("label");
  field.className = "field";
  const label = document.createElement("span");
  label.textContent = labelText;
  field.append(label, control);
  return field;
}

function createSecretField(labelText, input, toggleId) {
  const field = document.createElement("div");
  field.className = "field";
  const label = document.createElement("span");
  label.textContent = labelText;
  const row = document.createElement("div");
  row.className = "inputWithBtn";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.id = toggleId;
  toggle.className = "iconButton";
  row.append(input, toggle);
  field.append(label, row);
  return field;
}

function bindSecretToggle(toggleBtn, input, labels = {}) {
  if (!toggleBtn || !input) return;
  syncSecretToggleButton(toggleBtn, input, labels);
  safeBind(toggleBtn, "click", () => {
    input.type = input.type === "password" ? "text" : "password";
    syncSecretToggleButton(toggleBtn, input, labels);
  }, "toggle secret");
}

function findSettingsSection() {
  const serverInput = byId("serverUrlInput");
  let node = serverInput?.parentElement || null;
  while (node && node !== document.body) {
    if (node.classList?.contains("section")) return node;
    node = node.parentElement;
  }
  return document.querySelector(".section");
}

function findServerRow() {
  const serverInput = byId("serverUrlInput");
  let node = serverInput?.parentElement || null;
  while (node && node !== document.body) {
    if (node.classList?.contains("inputWithBtn")) return node;
    node = node.parentElement;
  }
  return serverInput?.parentElement || null;
}

function findTemplateSection() {
  const templateSelect = byId("templateSelect");
  let node = templateSelect?.parentElement || null;
  while (node && node !== document.body) {
    if (node.classList?.contains("section")) return node;
    node = node.parentElement;
  }
  return null;
}

function ensureSettingsBody() {
  const settingsSection = findSettingsSection();
  const serverRow = findServerRow();
  if (!settingsSection || !serverRow) return null;

  let body = byId("settingsBody");
  if (!body) {
    body = document.createElement("div");
    body.id = "settingsBody";
    body.className = "settingsBody";
    const header = settingsSection.querySelector(".sectionHeader");
    const firstBodyNode = header?.nextSibling || settingsSection.firstChild;
    settingsSection.insertBefore(body, firstBodyNode);
    let node = body.nextSibling;
    while (node) {
      const next = node.nextSibling;
      body.append(node);
      node = next;
    }
  }

  let toggle = byId("settingsToggleBtn");
  if (!toggle) {
    toggle = document.createElement("button");
    toggle.id = "settingsToggleBtn";
    toggle.className = "iconButton";
    toggle.type = "button";
    toggle.textContent = "▲";
    setSettingsToggleIcon(toggle, false);
    const header = settingsSection.querySelector(".sectionHeader");
    if (header) header.append(toggle);
    else settingsSection.insertBefore(toggle, body);
  }
  return body;
}

function ensureSettingsOrder(settingsBody) {
  if (!settingsBody) return;
  const nodes = [
    findServerRow(),
    byId("runningHubSettings"),
    byId("localWorkflowSettings")
  ].filter(node => node && node.parentElement === settingsBody);
  for (const node of nodes) settingsBody.append(node);
}

function ensureLocalWorkflowSettings(settingsBody) {
  if (!settingsBody) return;
  let wrap = byId("localWorkflowSettings");
  const templateSelect = byId("templateSelect");
  const folderBtn = byId("chooseTemplateFolderBtn");
  if (!templateSelect || !folderBtn) return;

  const oldSection = findTemplateSection();
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "localWorkflowSettings";
    wrap.className = "localWorkflowSettings";
  }

  if (wrap.parentElement !== settingsBody) {
    settingsBody.append(wrap);
  }

  let header = wrap.querySelector(".compactHeader");
  if (!header) {
    header = document.createElement("div");
    header.className = "sectionHeader compactHeader";
    const title = document.createElement("h2");
    header.append(title);
    wrap.insertBefore(header, wrap.firstChild);
  }
  const title = header.querySelector("h2") || document.createElement("h2");
  title.textContent = "Workflow";
  if (!title.parentElement) header.insertBefore(title, header.firstChild);

  let actions = header.querySelector(".row");
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "row";
    header.append(actions);
  }
  const refreshBtn = byId("refreshTemplatesBtn");
  if (refreshBtn && refreshBtn.parentElement !== actions) actions.append(refreshBtn);
  if (folderBtn.parentElement !== actions) actions.append(folderBtn);

  const templateField = templateSelect.closest?.(".field") || templateSelect.parentElement;
  if (templateField && templateField.parentElement !== wrap) wrap.append(templateField);

  if (oldSection && oldSection !== findSettingsSection() && !oldSection.contains(templateSelect) && !oldSection.contains(folderBtn)) {
    oldSection.remove();
  }

  ensureSettingsOrder(settingsBody);
}

function initToolbarIcons() {
  setButtonIcon(els.testConnectionBtn, "check", "Test connection");
  setButtonIcon(els.refreshTemplatesBtn, "refresh", "Reload templates");
  setButtonIcon(els.loadRunningHubNodesBtn, "refresh", "Reload RunningHub nodes");
  setSettingsToggleIcon(els.settingsToggleBtn, Boolean(els.settingsBody?.hidden));
  bindSecretToggle(els.toggleServerUrlBtn, els.serverUrlInput, {
    show: "Show server address",
    hide: "Hide server address"
  });
  bindSecretToggle(els.toggleRunningHubApiKeyBtn, els.runningHubApiKeyInput, {
    show: "Show API key",
    hide: "Hide API key"
  });
}

function setSettingsCollapsed(collapsed) {
  if (!els.settingsBody || !els.settingsToggleBtn) return;
  els.settingsBody.hidden = collapsed;
  els.settingsBody.style.display = collapsed ? "none" : "";
  setSettingsToggleIcon(els.settingsToggleBtn, collapsed);
  localStorage.setItem(SETTINGS_COLLAPSED_KEY, collapsed ? "1" : "0");
}

function toggleSettings() {
  setSettingsCollapsed(!els.settingsBody.hidden);
}

function ensureSettingsControls() {
  const serverRow = findServerRow();
  const settingsSection = findSettingsSection();
  if (!settingsSection || !serverRow) {
    console.warn("Cannot install RunningHub controls: settings section not found");
    return;
  }
  const settingsBody = ensureSettingsBody() || settingsSection;
  ensureLocalWorkflowSettings(settingsBody);
  byId("apixVersionMarker")?.remove?.();

  if (!byId("executionModeSelect")) {
    const modeSelect = document.createElement("select");
    modeSelect.id = "executionModeSelect";
    modeSelect.hidden = true;
    modeSelect.setAttribute("aria-hidden", "true");
    modeSelect.innerHTML = `
      <option value="local">ComfyUI Local</option>
      <option value="runninghub-wf">RunningHub Workflow</option>
      <option value="runninghub-app">RunningHub AI App</option>
    `;
    (byId("app") || document.body).append(modeSelect);
  }

  let wrap = byId("runningHubSettings");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "runningHubSettings";
    wrap.className = "runningHubSettings";
    wrap.hidden = true;
    settingsBody.append(wrap);
  }

  if (!byId("runningHubApiKeyInput")) {
    const apiInput = document.createElement("input");
    apiInput.id = "runningHubApiKeyInput";
    apiInput.type = "password";
    apiInput.placeholder = "API key";
    apiInput.autocomplete = "off";
    wrap.append(createSecretField("RunningHub API Key", apiInput, "toggleRunningHubApiKeyBtn"));
  }

  let appWrap = byId("runningHubAppSettings");
  if (!appWrap) {
    appWrap = document.createElement("div");
    appWrap.id = "runningHubAppSettings";
    appWrap.className = "runningHubAppSettings";
    appWrap.hidden = true;
    wrap.append(appWrap);
  }

  if (byId("runningHubWebappIdInput")) {
    const legacyField = byId("runningHubWebappIdInput").closest?.(".field") || byId("runningHubWebappIdInput").parentElement;
    legacyField?.remove?.();
  }

  if (!byId("runningHubAppSelect")) {
    appWrap.prepend(createRhAppPickerField());
  }
  ensureRunningHubAppPickerLayout(appWrap);

  if (!byId("runningHubCustomWebappIdInput")) {
    const customInput = document.createElement("input");
    customInput.id = "runningHubCustomWebappIdInput";
    customInput.type = "text";
    customInput.placeholder = "2039924771751731201";
    const customField = createField("Custom WebApp ID", customInput);
    customField.id = "runningHubCustomWebappField";
    customField.hidden = true;
    appWrap.append(customField);
  } else if (!byId("runningHubCustomWebappField")) {
    const customInput = byId("runningHubCustomWebappIdInput");
    const customField = customInput.parentElement;
    if (customField) customField.id = "runningHubCustomWebappField";
  }

  ensureSettingsOrder(settingsBody);
}

function bindEvents() {
  safeBind(els.runBtn, "click", startRunFromUi, "run click");
  safeBind(els.runBtn, "pointerup", startRunFromUi, "run pointerup");
  safeBind(els.testConnectionBtn, "click", testConnection, "test click");
  safeBind(els.settingsToggleBtn, "click", toggleSettings, "settings toggle");
  safeBind(els.executionModeSelect, "change", () => switchExecutionMode(els.executionModeSelect.value), "mode change");
  bindExecutionModeTabs();
  safeBind(els.runningHubApiKeyInput, "input", saveSettings, "runninghub api key");
  safeBind(els.runningHubAppSelect, "change", () => {
    syncRunningHubAppUi();
    saveSettings();
    if (isRunningHubAppMode()) {
      state.runningHubWebappName = "";
      loadRunningHubNodes().catch(error => setStatus(`RunningHub load failed: ${error.message}`));
    }
  }, "runninghub app");
  safeBind(els.runningHubCustomWebappIdInput, "input", saveSettings, "runninghub custom webapp id");
  safeBind(els.runningHubCustomWebappIdInput, "change", () => {
    if (!isRunningHubAppMode()) return;
    state.runningHubWebappName = "";
    loadRunningHubNodes().catch(error => setStatus(`RunningHub load failed: ${error.message}`));
  }, "runninghub custom webapp reload");
  safeBind(els.loadRunningHubNodesBtn, "click", () => loadRunningHubNodes(), "runninghub nodes");
  safeBind(els.refreshTemplatesBtn, "click", loadTemplates, "refresh click");
  safeBind(els.chooseTemplateFolderBtn, "click", chooseTemplateFolder, "folder click");
  safeBind(els.chooseTemplateZipBtn, "click", chooseTemplateZip, "zip click");
  safeBind(els.templateSelect, "change", () => selectTemplate(selectedTemplateId()), "template change");
  safeBind(els.cancelBtn, "click", cancelRun, "cancel click");
}

function initElements() {
  loadBundledDefaultRhApps();
  ensureSettingsControls();
  [
    "settingsBody",
    "settingsToggleBtn",
    "executionModeToggle",
    "executionModeSelect",
    "serverUrlInput",
    "toggleServerUrlBtn",
    "runningHubSettings",
    "runningHubAppSettings",
    "runningHubApiKeyInput",
    "toggleRunningHubApiKeyBtn",
    "runningHubAppSelect",
    "runningHubCustomWebappField",
    "runningHubCustomWebappIdInput",
    "loadRunningHubNodesBtn",
    "localWorkflowSettings",
    "testConnectionBtn",
    "refreshTemplatesBtn",
    "chooseTemplateFolderBtn",
    "chooseTemplateZipBtn",
    "templateSelect",
    "workflowTitle",
    "dynamicForm",
    "statusText",
    "progressBar",
    "runBtn",
    "cancelBtn"
  ].forEach(id => { els[id] = byId(id); });
  initToolbarIcons();
  setSettingsCollapsed(localStorage.getItem(SETTINGS_COLLAPSED_KEY) === "1");
}

document.addEventListener("DOMContentLoaded", async () => {
  initElements();
  state.settings = readSettings();
  applySettingsToUi();
  bindEvents();
  await loadTemplates();
  renderActiveForm();
  if (isRunningHubAppMode() && state.settings.runningHub.apiKey) {
    loadRunningHubNodes().catch(error => setStatus(`RunningHub load failed: ${error.message}`));
  }
});
