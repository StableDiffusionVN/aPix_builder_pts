export const BUILTIN_TEMPLATES = [
  "klein-edit-image",
  "fashion-flatlay",
  "mask-upscale",
  "test-2output",
  "upscale-klein"
];
export const SETTINGS_KEY = "apix-builder:settings:v1";
export const TEMPLATE_FOLDER_KEY = "apix-builder:template-folder:v1";
export const DEFAULT_SERVER = "http://127.0.0.1:8188";

export const state = {
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

export const els = {};

export function byId(id) {
  return document.getElementById(id);
}

export function setStatus(message) {
  els.statusText.textContent = message;
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
    return { serverUrl: DEFAULT_SERVER, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { serverUrl: DEFAULT_SERVER };
  }
}

export function saveSettings() {
  state.settings.serverUrl = els.serverUrlInput.value.trim() || DEFAULT_SERVER;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  setStatus("Saved settings");
}

export function normalizeId(id) {
  return Array.isArray(id) ? id.join("|") : String(id);
}
