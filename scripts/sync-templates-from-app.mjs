import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const PLUGIN_ROOT = process.cwd();
const APP_ROOT = path.resolve(PLUGIN_ROOT, "..");

/** Match main app bundled defaults: config/default + config/default-rh only. */
const SOURCE_TARGETS = [
  { from: "config/default", to: "templates" },
  { from: "config/default-rh", to: "templates-rh" }
];

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resetTargetRoot(targetRoot) {
  if (await exists(targetRoot)) {
    await rm(targetRoot, { recursive: true, force: true });
  }
  await mkdir(targetRoot, { recursive: true });
}

async function copyTemplateDir(sourceDir, targetRoot) {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  let copied = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const src = path.join(sourceDir, entry.name);
    const dest = path.join(targetRoot, entry.name);
    await cp(src, dest, { recursive: true, force: true });
    copied += 1;
    console.log(`Synced ${path.relative(APP_ROOT, src)} -> ${path.relative(PLUGIN_ROOT, dest)}`);
  }
  return copied;
}

async function runCompileTemplates() {
  await new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "compile:templates"], {
      cwd: PLUGIN_ROOT,
      stdio: "inherit"
    });
    child.on("exit", code => (code === 0 ? resolve() : reject(new Error(`compile:templates exited ${code}`))));
  });
}

let total = 0;
for (const { from, to } of SOURCE_TARGETS) {
  const sourceDir = path.join(APP_ROOT, from);
  const targetRoot = path.join(PLUGIN_ROOT, to);
  if (!(await exists(sourceDir))) {
    console.log(`Skip missing source: ${from}`);
    continue;
  }
  await resetTargetRoot(targetRoot);
  total += await copyTemplateDir(sourceDir, targetRoot);
}

if (!total) {
  console.error("No default templates synced. Expected ../config/default and ../config/default-rh");
  process.exit(1);
}

console.log(`Synced ${total} default template(s). Compiling YAML...`);
await runCompileTemplates();

const defaultAppsSource = path.join(APP_ROOT, "config/default-rh/apps.json");
const defaultAppsTarget = path.join(PLUGIN_ROOT, "default-rh-apps.json");
try {
  const raw = await readFile(defaultAppsSource, "utf8");
  await writeFile(defaultAppsTarget, raw, "utf8");
  console.log(`Synced ${path.relative(APP_ROOT, defaultAppsSource)} -> ${path.relative(PLUGIN_ROOT, defaultAppsTarget)}`);
} catch (error) {
  console.warn(`Skip default RH apps sync: ${error.message}`);
}

const markSource = path.join(APP_ROOT, "public/sdvn-mark-light.png");
const iconsDir = path.join(PLUGIN_ROOT, "icons");
const markTarget = path.join(iconsDir, "sdvn-mark-black.png");
try {
  await mkdir(iconsDir, { recursive: true });
  await cp(markSource, markTarget);
  console.log(`Synced ${path.relative(APP_ROOT, markSource)} -> ${path.relative(PLUGIN_ROOT, markTarget)}`);
  await new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "generate:icons"], {
      cwd: PLUGIN_ROOT,
      stdio: "inherit"
    });
    child.on("exit", code => (code === 0 ? resolve() : reject(new Error(`generate:icons exited ${code}`))));
  });
} catch (error) {
  console.warn(`Skip icon sync: ${error.message}`);
}

console.log("Done.");
