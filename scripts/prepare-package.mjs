import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const packageRoot = path.join(root, "package");
const pluginDirName = "aPix Builder";
const outDir = path.join(packageRoot, pluginDirName);

const copyEntries = [
  "manifest.json",
  "index.html",
  "styles.css",
  "default-rh-apps.json",
  "dist",
  "templates",
  "templates-rh"
];

const iconFiles = [
  "sdvn-icon-24.png",
  "sdvn-icon-48.png",
  "sdvn-panel-23.png",
  "sdvn-panel-46.png"
];

async function assertExists(targetPath, label) {
  try {
    await stat(targetPath);
  } catch {
    throw new Error(`Missing ${label}: ${path.relative(root, targetPath)}`);
  }
}

async function copyIcons() {
  const iconsDir = path.join(outDir, "icons");
  await mkdir(iconsDir, { recursive: true });
  for (const fileName of iconFiles) {
    const source = path.join(root, "icons", fileName);
    await assertExists(source, "icon");
    await cp(source, path.join(iconsDir, fileName));
  }
}

async function writePackageReadme() {
  const text = [
    "aPix Builder — UXP package folder",
    "",
    "Load this folder in Adobe UXP Developer Tool:",
    `  package/${pluginDirName}/`,
    "",
    "Regenerate after source changes:",
    "  npm run prepare:package",
    "",
    "This directory is generated locally and is not tracked in git.",
    ""
  ].join("\n");

  await writeFile(path.join(packageRoot, "README.txt"), text, "utf8");
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

for (const entry of copyEntries) {
  const source = path.join(root, entry);
  const target = path.join(outDir, entry);
  await assertExists(source, "package file");
  await cp(source, target, {
    recursive: true,
    filter: (sourcePath) => {
      const base = path.basename(sourcePath);
      if (base === ".DS_Store") return false;
      if (base.endsWith(".yaml")) return false;
      return true;
    }
  });
}

await copyIcons();
await writePackageReadme();

const packagedFiles = await readdir(outDir);
console.log(`Prepared UXP package: ${path.relative(root, outDir)}`);
console.log(`Top-level entries: ${packagedFiles.join(", ")}`);
