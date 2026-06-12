export const TEMPLATE_MANIFEST_FILES = ["app_build.yaml", "app_build.json"];
export const CONFIG_BUCKET_NAMES = new Set(["default", "templates", "default-rh", "templates-rh", "config"]);
export const TEMPLATE_BUCKET_NAMES = new Set(["default", "templates", "default-rh", "templates-rh"]);
export const MAX_TEMPLATE_SCAN_DEPTH = 2;

export function isConfigBucketName(name) {
  return CONFIG_BUCKET_NAMES.has(String(name || "").trim());
}

export function isTemplateBucketName(name) {
  return TEMPLATE_BUCKET_NAMES.has(String(name || "").trim());
}

export function isFolderEntry(entry) {
  return Boolean(entry && (entry.isFolder || entry.isDirectory || typeof entry.getEntries === "function"));
}

export function filterFolderEntries(entries = []) {
  if (!Array.isArray(entries)) return [];
  return entries.filter(entry => isFolderEntry(entry));
}

/** Which child folders to inspect under `rootFolderName` (matches main app config layout). */
export function pickTemplateScanTargets(rootFolderName, childEntries = []) {
  const folders = filterFolderEntries(childEntries);
  if (isTemplateBucketName(rootFolderName)) {
    return folders;
  }
  const buckets = folders.filter(entry => isTemplateBucketName(entry.name));
  if (buckets.length > 0) {
    return buckets;
  }
  const configFolder = folders.find(entry => entry.name === "config");
  if (configFolder) {
    return [configFolder];
  }
  return folders;
}

export function shouldRecurseIntoScanTarget(folderName, depth) {
  if (depth >= MAX_TEMPLATE_SCAN_DEPTH) return false;
  return isTemplateBucketName(folderName) || folderName === "config";
}

export function templateFolderId(prefix, folderName) {
  return prefix ? `folder:${prefix}${folderName}` : `folder:${folderName}`;
}

export function templateDisplayName(config, folderName, prefix = "") {
  const base = config?.app?.name || folderName;
  return prefix ? `${base} (${prefix.replace(/\/$/, "")})` : base;
}
