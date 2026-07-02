import YAML from "yaml";
import { strFromU8 } from "fflate";
import { extractRunningHubWorkflowId, isRunningHubWfTemplate } from "../services/runninghub.js";

// Dựng template item từ các entry trong tệp .zip (mỗi thư mục có app_build → 1 template).
// entries: { "<path>": Uint8Array } (kết quả fflate.unzipSync).
// Decode bằng strFromU8 của fflate — UXP (Photoshop) không có sẵn TextDecoder.
export function templatesFromZipEntries(entries, zipName) {
  const dec = { decode: bytes => strFromU8(bytes) };
  const byDir = {};
  for (const [entryPath, data] of Object.entries(entries || {})) {
    if (entryPath.endsWith("/")) continue;
    const slash = entryPath.lastIndexOf("/");
    const dir = slash >= 0 ? entryPath.slice(0, slash) : "";
    const base = slash >= 0 ? entryPath.slice(slash + 1) : entryPath;
    (byDir[dir] ||= {})[base] = data;
  }
  const templates = [];
  for (const [dir, files] of Object.entries(byDir)) {
    const manifestRaw = files["app_build.json"] || files["app_build.yaml"] || files["app_build.yml"];
    if (!manifestRaw) continue;
    let config;
    if (files["app_build.json"]) {
      config = JSON.parse(dec.decode(files["app_build.json"]));
    } else {
      const raw = dec.decode(manifestRaw);
      config = YAML.parse(raw);
      if (config?.runninghub) config.runninghub.workflowId = extractRunningHubWorkflowId(raw, config);
    }
    let workflow = null;
    if (files["api.json"]) {
      try { workflow = JSON.parse(dec.decode(files["api.json"])); } catch { workflow = null; }
    }
    const folderName = dir.split("/").pop() || String(zipName || "template").replace(/\.zip$/i, "");
    templates.push({
      id: `zip:${folderName}`,
      name: `${config?.app?.name || folderName} (zip)`,
      source: "zip",
      scope: isRunningHubWfTemplate(config) ? "runninghub-wf" : "local",
      config,
      workflow
    });
  }
  return templates;
}
