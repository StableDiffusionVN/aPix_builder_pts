export const BUILTIN_TEMPLATES = [
  "sdvn-klein-upscale-ultimate",
  "klein-edit-image"
];
export const BUILTIN_RH_TEMPLATES = [
  "sdvn-klein-upscale-ultimate",
  "klein-edit-image-lora"
];
import {
  DEFAULT_RH_WEBAPP_ID,
  RUNNINGHUB_APP_OPTIONS,
  loadExecutionMode,
  loadRunningHubSettings,
  normalizeExecutionMode,
  saveExecutionMode,
  saveRunningHubSettings
} from "./services/runninghub.js";

export const SETTINGS_KEY = "apix-builder:settings:v1";
/** @deprecated migrated to scope-specific keys on read */
export const TEMPLATE_FOLDER_KEY = "apix-builder:template-folder:v1";
export const TEMPLATE_FOLDER_KEY_LOCAL = "apix-builder:template-folder:local:v1";
export const TEMPLATE_FOLDER_KEY_RH_WF = "apix-builder:template-folder:runninghub-wf:v1";
export const DEFAULT_SERVER = "http://127.0.0.1:8188";

export function templateFolderStorageKey(scope) {
  return scope === "runninghub-wf" ? TEMPLATE_FOLDER_KEY_RH_WF : TEMPLATE_FOLDER_KEY_LOCAL;
}

export const state = {
  settings: {
    serverUrl: DEFAULT_SERVER,
    executionMode: "local",
    runningHub: { apiKey: "", webappId: DEFAULT_RH_WEBAPP_ID, workflowId: "" }
  },
  templates: [],
  selectedTemplate: null,
  config: null,
  workflow: null,
  values: {},
  localValues: {},
  imageValues: {},
  imageSources: {},
  imagePreviews: {},
  serverChoices: {},
  sdvnChoices: {},
  runningHubNodes: [],
  runningHubWebappName: "",
  runningHubNodeValues: {},
  runningHubNodesLoading: false,
  runningHubNodesError: "",
  abortController: null,
  activeWebSocket: null,
  activePromptId: null,
  activeRunningHubTaskId: null,
  running: false,
  lastRunEventAt: 0
};

export const els = {};

export function byId(id) {
  return document.getElementById(id);
}

export function setStatus(message) {
  els.statusText.textContent = message;
}

export function syncRunButtonUi() {
  if (!els.runBtn) return;
  const busy = Boolean(state.running);
  els.runBtn.textContent = busy ? "Run..." : "Run";
  els.runBtn.classList.toggle("is-running", busy);
  els.runBtn.setAttribute("aria-busy", busy ? "true" : "false");
}

export function setProgress(value, max) {
  if (Number.isFinite(value) && Number.isFinite(max) && max > 0) {
    els.progressBar.hidden = false;
    els.progressBar.max = max;
    els.progressBar.value = value;
  } else {
    els.progressBar.hidden = true;
    els.progressBar.value = 0;
  }
}

export function setImageInputValue(key, dataUrl, source) {
  state.values[key] = dataUrl;
  state.imageValues[key] = dataUrl;
  state.imageSources[key] = source;
  const preview = state.imagePreviews[key];
  if (preview) {
    preview.src = dataUrl;
    preview.hidden = false;
  }
}

export function readSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return {
      serverUrl: DEFAULT_SERVER,
      ...parsed,
      executionMode: loadExecutionMode(),
      runningHub: loadRunningHubSettings()
    };
  } catch {
    return {
      serverUrl: DEFAULT_SERVER,
      executionMode: loadExecutionMode(),
      runningHub: loadRunningHubSettings()
    };
  }
}

export function saveSettings() {
  state.settings.serverUrl = els.serverUrlInput.value.trim() || DEFAULT_SERVER;
  state.settings.executionMode = normalizeExecutionMode(state.settings.executionMode);
  if (els.executionModeSelect) {
    els.executionModeSelect.value = state.settings.executionMode;
  }
  const selectedWebapp = els.runningHubAppSelect?.value || DEFAULT_RH_WEBAPP_ID;
  const isDefaultWebapp = RUNNINGHUB_APP_OPTIONS.some(app => app.id === selectedWebapp);
  const webappId = isDefaultWebapp
    ? selectedWebapp
    : (els.runningHubCustomWebappIdInput?.value.trim() || DEFAULT_RH_WEBAPP_ID);
  state.settings.runningHub = {
    apiKey: els.runningHubApiKeyInput?.value.trim() || "",
    webappId
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  saveExecutionMode(state.settings.executionMode);
  saveRunningHubSettings(state.settings.runningHub);
  setStatus("Saved settings");
}

export function normalizeId(id) {
  return Array.isArray(id) ? id.join("|") : String(id);
}
