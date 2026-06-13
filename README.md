# aPix Builder — Photoshop Plugin · v1.0 (alpha)

**Website:** [apix.sdvn.vn](https://apix.sdvn.vn)

**English:** UXP panel for Adobe Photoshop that runs ComfyUI and RunningHub workflows from the active document. Select a template, fill parameters, send images from Photoshop, run the workflow, and import results as new layers.

**Tiếng Việt:** Plugin UXP cho Adobe Photoshop — chạy workflow ComfyUI và RunningHub trực tiếp từ document đang mở. Chọn template, điền tham số, gửi ảnh từ Photoshop, chạy workflow và nhận kết quả về layer mới.

Companion to the [aPix Builder](https://github.com/StableDiffusionVN/aPix_Builder) web/desktop app (v1.0.0). Templates can be synced from the parent repo via `npm run sync:templates`.

## Releases

Phiên bản hiện tại: **v1 alpha** · tương thích **aPix Builder 1.0.0**

| File | Nền tảng | Cài đặt |
| --- | --- | --- |
| [`aPixBuilder_v1.ccx`](https://github.com/StableDiffusionVN/aPix_builder_pts/releases) | Adobe Photoshop 24+ (UXP) | Tải `.ccx` từ GitHub Releases → double-click hoặc cài qua UXP Developer Tool |

**English:** Download `aPixBuilder_v1.ccx` from [GitHub Releases](https://github.com/StableDiffusionVN/aPix_builder_pts/releases), install the package, then open **Plugins → aPix Builder** in Photoshop.

```bash
# Build CCX locally (optional)
npm run prepare:package
# Package output: package/aPixBuilder_v1.ccx
```

## Requirements

| Component | Version |
|-----------|---------|
| Adobe Photoshop | 24.0.0+ (2023 / v24.3+ recommended for Imaging API) |
| Adobe UXP Developer Tool | Latest |
| Node.js | 18+ |
| ComfyUI server | Local or remote (default `http://127.0.0.1:8188`) |
| RunningHub (optional) | API Key for RH App / RH Workflow modes |

## Features

- **3 execution modes:** ComfyUI Local, RunningHub Workflow, RunningHub App
- ComfyUI server URL with connection test
- Bundled templates synced from main app defaults (see [Templates](#templates))
- Optional custom workflow folder per mode (local / RH Workflow)
- Dynamic form UI from `app_build.yaml` / `app_build.json`
- Workflow patching via node-field IDs (e.g. `23-seed`, `14-resize_type.longer_size`)
- Image input from active document, active layer, or local file
- Selection-aware runs: export selected pixels; fit output to selection bounds
- ComfyUI: upload, `/prompt`, WebSocket progress, history fallback, `/interrupt`
- RunningHub: task submit, polling, output import as layers
- Default RH App list from `default-rh-apps.json` (synced from parent `config/default-rh/apps.json`)
- Dynamic model lists from ComfyUI `/object_info`

## Quick Start

```bash
npm install
npm run build
npm test          # optional
```

Load the plugin in Photoshop — see [Load the Plugin](#load-the-plugin).

### Sync templates from parent web app

When the main `aPix_Builder` repo is checked out as the parent directory:

```bash
npm run sync:templates
```

This copies `../config/default` → `templates/`, `../config/default-rh` → `templates-rh/`, compiles YAML, syncs `default-rh-apps.json`, and regenerates manifest icons.

## npm Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Compile `app_build.yaml` → `app_build.json`, bundle `src/` → `dist/main.js` |
| `npm run sync:templates` | Pull default templates + RH apps from parent web app, then build |
| `npm run generate:icons` | Generate UXP icons from `icons/sdvn-mark-black.png` (macOS `sips`) |
| `npm run compile:templates` | Compile template YAML only |
| `npm run watch` | Rebuild bundle on source changes |
| `npm test` | Node unit tests |
| `npm run prepare:package` | `build` + icons + copy to `package/aPix Builder/` |

## Load the Plugin

### Option A — Development (repository root)

After `npm run build` or `npm run watch`:

1. Open **Adobe UXP Developer Tool**
2. **Add Plugin** → select this folder (contains `manifest.json`)
3. **Load** (or **Load & Watch** with `npm run watch`)
4. Photoshop → **Plugins → aPix Builder**

### Option B — Packaged build

```bash
npm run prepare:package
```

1. UXP Developer Tool → add folder `package/aPix Builder/`
2. **Unload** any previous copy of this plugin
3. **Load** the packaged folder
4. Photoshop → **Plugins → aPix Builder**

> Regenerate `package/` after changes to `manifest.json`, icons, or templates. The `package/` folder is gitignored.

### Reload after manifest or permission changes

1. **Unload** in UXP Developer Tool (do not only close the panel)
2. **Load** again
3. Re-open the panel in Photoshop

## Using the Panel

### Execution modes

| Mode | Use when |
|------|----------|
| **ComfyUI** | Local or remote ComfyUI server |
| **RH Workflow** | YAML template + RunningHub workflow ID |
| **RH App** | Hosted RunningHub WebApp |

### 1. Connect (ComfyUI mode)

1. Enter ComfyUI URL (default `http://127.0.0.1:8188`)
2. Click **Check** — expect `Saved — ComfyUI connected`
3. URL is saved in plugin storage

### 2. Select a template

- Choose from **Template** dropdown (bundled or custom folder)
- **↻** reload bundled templates
- **Folder** pick a custom template directory

### 3. Fill inputs & Run

| UI type | Behavior |
|---------|----------|
| `image` / `file` | **Document**, **Layer**, or **File** |
| `image_mask` | Same as image (mask painting UI not available in PS yet) |
| `text` / `string` | Prompt fields |
| `int`, `float`, `slider`, `seed` | Numeric / random seed |
| `dropdown`, `menu`, `menu-sub` | Static or conditional choices |
| `checkpoints`, `loras`, etc. | From ComfyUI after connect |
| `note`, `markdown` | Read-only help |

Click **Run** → progress in status bar → outputs as new layers. **Cancel** sends ComfyUI `/interrupt` or aborts RH polling.

### RunningHub App

1. Switch mode to **RH App**
2. Enter API Key; pick app from dropdown (defaults from `default-rh-apps.json`) or **Custom WebApp ID**
3. **Load RunningHub Nodes** → fill fields → **Run**

### RunningHub Workflow

1. Switch mode to **RH Workflow**
2. Enter API Key; select template from `templates-rh/`
3. Fill form → **Run**

RH Workflow YAML requires a `runninghub` section:

```yaml
runninghub:
  workflowId: "2064644362323189762"
  saveWorkflowJson: true
  addMetadata: false
  usePersonalQueue: false
  accessPassword: ""
```

RH Workflow templates do **not** need an `output` section — outputs come from task polling.

### Image input behavior

| Situation | Result |
|-----------|--------|
| Image field set (Document/Layer/File) | That image is sent |
| No image, no selection | Active document exported |
| Selection active | First image input uses selection pixels; output fitted to selection |
| Multiple image inputs, no selection | Same export applied to all empty fields |

## Project Structure

```text
aPix_builder_pts/
├── manifest.json
├── index.html
├── styles.css
├── default-rh-apps.json      # Default RH WebApp list (generated/synced)
├── dist/main.js              # Bundled plugin (generated)
├── icons/                    # sdvn-* UXP icons
├── src/
│   ├── main.js
│   ├── state.js
│   ├── services/
│   │   ├── photoshop.js
│   │   ├── comfy.js
│   │   ├── workflow.js
│   │   └── runninghub.js
│   ├── lib/
│   │   ├── menuChoices.js
│   │   └── templateFolder.js
│   ├── ui/form.js
│   └── utils/
│       ├── files.js
│       └── fetchRetry.js
├── templates/                # Local ComfyUI templates
├── templates-rh/             # RunningHub Workflow templates
├── scripts/
│   ├── build.mjs
│   ├── compile-templates.mjs
│   ├── sync-templates-from-app.mjs
│   ├── generate-icons.mjs
│   └── prepare-package.mjs
└── tests/
```

## Templates

### Bundled local templates (v1.0)

| ID | Description |
|----|-------------|
| `klein-edit-image` | Klein image editing |
| `sdvn-klein-upscale-ultimate` | SDVN Klein upscale |

### Bundled RunningHub Workflow templates (v1.0)

| ID | Description |
|----|-------------|
| `klein-edit-image-lora` | Klein edit + LoRA (cloud) |
| `sdvn-klein-upscale-ultimate` | SDVN Klein upscale (cloud) |

Registered in `src/state.js` (`BUILTIN_TEMPLATES`, `BUILTIN_RH_TEMPLATES`). Edit `app_build.yaml`, then `npm run build`.

### Template files

| File | Role |
|------|------|
| `app_build.yaml` | Source of truth (authors edit this) |
| `app_build.json` | Compiled config (generated — do not hand-edit) |
| `api.json` | ComfyUI workflow API JSON |

Runtime reads **`app_build.json`** + **`api.json`**. YAML is build-time only.

### Custom workflow folder

Pick a single template dir or a parent with multiple subdirs (one level). Each valid template needs `api.json` + (`app_build.json` or `app_build.yaml`). Path stored via UXP persistent token.

### Adding a bundled template

1. Add files under `templates/<id>/` or `templates-rh/<id>/`
2. Register id in `BUILTIN_TEMPLATES` or `BUILTIN_RH_TEMPLATES` in `src/state.js`
3. `npm run build` and reload plugin

Or run `npm run sync:templates` from parent web app defaults.

## Packaging

```bash
npm run prepare:package
```

Output:

```text
package/aPix Builder/
├── manifest.json
├── index.html
├── styles.css
├── default-rh-apps.json
├── dist/
├── templates/
├── templates-rh/
└── icons/
```

## Permissions

```json
"network": { "domains": "all", "allowInsecureRequests": true }
```

`localFileSystem: fullAccess` — file picker, temp exports, custom template folders.

Unload/reload plugin after changing `manifest.json`.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `Manifest entry not found` / `Permission denied` | Unload + reload in UXP Tool; confirm correct folder |
| Connection check fails | Verify ComfyUI URL in browser; check firewall |
| `No templates found` | Run `npm run build`; check `src/state.js` ids match folders |
| Custom folder fails | Need both `app_build.json` and `api.json` |
| Validation error on select | Fix YAML `id` mapping vs `api.json`, then rebuild |
| No output layers | Check ComfyUI history / RH task; verify `output` node ids |
| Slow export | Use selection to limit area; PS 24.3+ for Imaging API |

## Testing

```bash
npm test
```

Covers workflow mapping, menu-sub choices, template folder scan, ComfyUI helpers, RunningHub utilities, and execution mode normalization. Photoshop DOM is verified manually.

## License

Private project — see repository owner for distribution terms.
