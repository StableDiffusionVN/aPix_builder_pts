import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

const templatesDir = path.join(process.cwd(), "templates");
const entries = await readdir(templatesDir, { withFileTypes: true });

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(templatesDir, entry.name);
  const yamlPath = path.join(dir, "app_build.yaml");
  const jsonPath = path.join(dir, "app_build.json");
  try {
    await stat(yamlPath);
  } catch {
    continue;
  }
  const raw = await readFile(yamlPath, "utf8");
  const config = YAML.parse(raw);
  await writeFile(jsonPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Compiled ${entry.name}/app_build.json`);
}
