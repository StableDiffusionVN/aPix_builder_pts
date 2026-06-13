import { cp, mkdir, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const iconsDir = path.join(root, "icons");
const sourceCandidates = [
  path.join(root, "icons", "sdvn-mark-black.png"),
  path.join(root, "..", "public", "sdvn-mark-light.png")
];

const outputs = [
  { file: "sdvn-icon-24.png", size: 24 },
  { file: "sdvn-icon-48.png", size: 48 },
  { file: "sdvn-panel-23.png", size: 23 },
  { file: "sdvn-panel-46.png", size: 46 }
];

const NORMALIZED_SIZE = 256;

async function resolveSource() {
  for (const candidate of sourceCandidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error("Missing black mark source (icons/sdvn-mark-black.png or ../public/sdvn-mark-light.png)");
}

function runSips(args) {
  const result = spawnSync("/usr/bin/sips", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `sips failed: ${args.join(" ")}`);
  }
}

async function normalizeSquareSource(source) {
  const normalized = path.join(iconsDir, "_sdvn-mark-normalized.png");
  await cp(source, normalized);

  let width = 0;
  let height = 0;
  const probe = spawnSync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", normalized], {
    encoding: "utf8"
  });
  const widthMatch = probe.stdout.match(/pixelWidth:\s*(\d+)/);
  const heightMatch = probe.stdout.match(/pixelHeight:\s*(\d+)/);
  width = Number(widthMatch?.[1] || 0);
  height = Number(heightMatch?.[1] || 0);

  if (width !== NORMALIZED_SIZE || height !== NORMALIZED_SIZE) {
    runSips(["-Z", String(NORMALIZED_SIZE), normalized]);
    runSips(["--padToHeightWidth", String(NORMALIZED_SIZE), String(NORMALIZED_SIZE), normalized]);
  }

  return normalized;
}

const source = await resolveSource();
await mkdir(iconsDir, { recursive: true });

const syncedSource = path.join(iconsDir, "sdvn-mark-black.png");
if (path.resolve(source) !== path.resolve(syncedSource)) {
  await cp(source, syncedSource);
}

const normalized = await normalizeSquareSource(syncedSource);

for (const { file, size } of outputs) {
  runSips(["-z", String(size), String(size), normalized, "--out", path.join(iconsDir, file)]);
}

await rm(normalized, { force: true });

console.log(`Generated UXP icons from ${path.relative(root, syncedSource)}`);
console.log(outputs.map(({ file }) => file).join(", "));
