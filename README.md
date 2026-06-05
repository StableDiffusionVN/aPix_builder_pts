# aPix Builder — Photoshop Plugin

Photoshop UXP panel that connects the active document to a [ComfyUI](https://github.com/comfyanonymous/ComfyUI) server. Select a workflow template, fill in parameters, send images from Photoshop, run the workflow, and import results back as new layers.

## Requirements

| Component | Version |
|-----------|---------|
| Adobe Photoshop | 24.0.0+ (2023 / v24.3+ recommended for Imaging API) |
| Adobe UXP Developer Tool | Latest |
| Node.js | 18+ |
| ComfyUI server | Running locally or on a reachable host (default `http://127.0.0.1:8188`) |

## Features

- ComfyUI server URL settings with connection test
- Five bundled workflow templates (editable via YAML source files)
- Optional custom workflow folder picker
- Dynamic form UI generated from template config
- Workflow patching via node-field IDs (e.g. `23-seed`, `14-resize_type.longer_size`)
- Image input from active document, active layer, or local file
- Automatic document export when image inputs are empty
- Selection-aware runs: exports selected pixels and fits output to selection bounds
- Image upload to ComfyUI `/upload/image`
- Prompt queue via `/prompt`
- Progress tracking via WebSocket `/ws` with history polling fallback
- Output download via `/history/{prompt_id}` and import as Photoshop layers
- Dynamic model lists (checkpoints, LoRAs, samplers, etc.) from ComfyUI `/object_info`

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Compile templates + bundle plugin
npm run build

# 3. (Optional) Run tests
npm test
```

Then load the plugin in Photoshop (see [Load the Plugin](#load-the-plugin)).

## npm Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Compile `app_build.yaml` → `app_build.json`, then bundle `src/` → `dist/main.js` |
| `npm run compile:templates` | Only compile template YAML files to JSON |
| `npm run watch` | Rebuild bundle on source changes (run during active UI/JS development) |
| `npm test` | Run Node unit tests for workflow mapping and ComfyUI helpers |
| `npm run prepare:package` | `build` + copy production files to `.package/aPix Builder/` |

## Load the Plugin

You can load either the **repository root** (development) or the **packaged folder** (distribution).

### Option A — Development (repository root)

Best when editing source code. After `npm run build` or `npm run watch`:

1. Open **Adobe UXP Developer Tool**
2. Click **Add Plugin** → select this repository folder (the one containing `manifest.json`)
3. Click **Load** (or **Load & Watch** if using `npm run watch` in parallel)
4. Open Photoshop → **Plugins → aPix Builder**

### Option B — Packaged build

Best for sharing or testing a clean copy:

```bash
npm run prepare:package
```

1. In UXP Developer Tool, add folder: `.package/aPix Builder/`
2. **Unload** any previously loaded copy of this plugin first
3. **Load** the packaged folder
4. Open Photoshop → **Plugins → aPix Builder**

> **Important:** If you change `manifest.json`, icons, or templates, run `npm run prepare:package` again before loading the packaged folder. The `.package/` copy is not updated automatically.

### Reload after manifest or permission changes

UXP caches manifest permissions. After editing `manifest.json`:

1. **Unload** the plugin in UXP Developer Tool (do not only close the Photoshop panel)
2. **Load** again
3. Re-open the panel in Photoshop

Skipping unload/reload often causes errors like:

```text
Permission denied to the url http://127.0.0.1:8188/...
Manifest entry not found.
```

## Using the Panel

### 1. Connect to ComfyUI

1. Enter your ComfyUI server URL (default: `http://127.0.0.1:8188`)
2. Click **Check** — status should show `Saved — ComfyUI connected`
3. The URL is saved in plugin local storage

Start ComfyUI before connecting:

```bash
# Example — run from your ComfyUI install directory
python main.py --listen 127.0.0.1 --port 8188
```

### 2. Select a workflow

- Choose a template from the **Template** dropdown
- Bundled templates load automatically on panel open
- Click **↻** to reload bundled templates
- Click **Folder** to pick a custom workflow directory (see [Custom Workflow Folder](#custom-workflow-folder))

### 3. Fill in inputs

The form is generated from the template config. Common controls:

| UI type | Behavior |
|---------|----------|
| `image` / `file` | **Document**, **Layer**, or **File** buttons |
| `image_mask` | Same as image; mask painting UI is not available in Photoshop yet |
| `text` / `string` | Text or multiline prompt fields |
| `int`, `float`, `slider` | Numeric inputs |
| `seed` | Random seed or fixed number (🎲 button) |
| `dropdown`, `menu` | Static choices from YAML |
| `checkpoints`, `loras`, etc. | Populated from ComfyUI after server connection |
| `note`, `markdown` | Read-only help text |

### 4. Run workflow

1. Click **Run Workflow**
2. Progress appears in the status bar and progress indicator
3. On completion, output images are placed as new layers in the active document
4. Click **Cancel** to abort (sends ComfyUI `/interrupt`)

### Image input behavior

| Situation | What happens |
|-----------|----------------|
| Image field has a value (Document/Layer/File) | That image is sent |
| No image set, no selection | Active document is exported automatically |
| Photoshop selection active | First image input uses merged pixels from the selection; output layers are fitted to selection bounds |
| Multiple image inputs, no selection | Same document export is applied to all empty image fields |

## Project Structure

```text
aPix_builder_pts/
├── manifest.json          # UXP plugin manifest (v5)
├── index.html             # Panel markup
├── styles.css             # Panel styles
├── dist/main.js           # Bundled plugin code (generated)
├── icons/                 # Plugin and panel icons
├── src/
│   ├── main.js            # App orchestration
│   ├── state.js           # Shared state and settings
│   ├── services/
│   │   ├── photoshop.js   # Export/import, selection handling
│   │   ├── comfy.js       # ComfyUI HTTP + WebSocket client
│   │   └── workflow.js    # Template parsing and value mapping
│   ├── ui/form.js         # Dynamic form renderer
│   └── utils/files.js     # UXP file helpers
├── templates/
│   └── <template-id>/
│       ├── app_build.yaml # Source config (edit this)
│       ├── app_build.json # Compiled config (generated at build)
│       └── api.json       # ComfyUI workflow API format
├── scripts/
│   ├── build.mjs          # esbuild bundle
│   ├── compile-templates.mjs
│   └── prepare-package.mjs
└── tests/                 # Node unit tests
```

## Templates

### Bundled templates

| ID | Description |
|----|-------------|
| `klein-edit-image` | Klein image editing workflow |
| `fashion-flatlay` | Fashion flatlay generation |
| `mask-upscale` | Mask-aware upscale |
| `test-2output` | Two-output test workflow |
| `upscale-klein` | Klein upscale workflow |

Source files live in `templates/<id>/`. Edit `app_build.yaml`, then run `npm run build` to regenerate `app_build.json` and reload the plugin.

### Template file roles

| File | Role |
|------|------|
| `app_build.yaml` | Human-editable UI and mapping config (source of truth for authors) |
| `app_build.json` | Compiled config loaded at runtime (generated — do not hand-edit) |
| `api.json` | ComfyUI workflow in API format |

At runtime the plugin reads **`app_build.json`** and **`api.json`**. YAML is only used at build time.

### Custom workflow folder

Click **Folder** in the panel and select a directory containing:

- `api.json` — ComfyUI workflow
- `app_build.json` — UI config

If you only have `app_build.yaml`, generate JSON first:

```bash
npm run build
# or only templates:
npm run compile:templates
```

Then copy `app_build.json` into your custom folder alongside `api.json`.

The folder path is stored via UXP persistent token and reloaded on next panel open.

### Template ID mapping

Each input in `app_build.yaml` targets a workflow node field:

```yaml
input:
  seed:
    id: 23-seed
    ui:
      type: seed
      label: Seed
      value: random_seed
  output_size:
    id: 14-resize_type.longer_size
    ui:
      type: int
      label: Output size
      value: 2048
```

Mapping rules:

```text
23-seed                      → api.json node "23" → inputs.seed
14-resize_type.longer_size   → api.json node "14" → inputs["resize_type.longer_size"]
```

Output nodes are declared under `output`:

```yaml
output:
  result_image:
    id: "11"
    ui:
      type: image
      label: Result
```

### Supported UI types

`image`, `image_mask`, `file`, `text`, `string`, `int`, `float`, `number`, `slider`, `menu`, `dropdown`, `radio`, `checkbox`, `boolean`, `seed`, `colorpicker`, `date`, `json`, `note`, `markdown`, `html`, `col`

Dynamic model types (populated from server): `checkpoints`, `loras`, `vae`, `controlnets`, `upscale_models`, `samplers`, `schedulers`, `unet`, `style_models`, `embeddings`, `clip`, `clip_vision` (and aliases).

## Development Workflow

```bash
# Terminal 1 — auto-rebuild JS on save
npm run watch

# Terminal 2 — run tests after logic changes
npm test
```

Typical edit cycle:

1. Change `src/` or `styles.css`
2. `watch` rebuilds `dist/main.js` automatically
3. In UXP Developer Tool, use **Load & Watch** or reload the plugin
4. For `manifest.json` or template YAML changes: run `npm run build` and **unload/reload** the plugin

### Adding a new bundled template

1. Create `templates/my-workflow/` with `app_build.yaml` and `api.json`
2. Add `"my-workflow"` to `BUILTIN_TEMPLATES` in `src/state.js`
3. Run `npm run build`
4. Reload plugin in UXP Developer Tool

## Packaging

Create a clean distributable folder:

```bash
npm run prepare:package
```

Output:

```text
.package/aPix Builder/
├── manifest.json
├── index.html
├── styles.css
├── dist/
├── templates/
└── icons/
```

Share this folder or load it directly in UXP Developer Tool. Re-run `prepare:package` after any change to source, manifest, templates, or icons.

## Permissions (`manifest.json`)

Current network permissions:

```json
"network": {
  "domains": "all",
  "allowInsecureRequests": true
}
```

This allows HTTP to local ComfyUI (`http://127.0.0.1:8188`) and remote hosts. `localFileSystem: fullAccess` is required for file picker, temp export files, and custom template folders.

If you restrict `domains` to a specific list, include the full origin **with port**, for example:

```json
"domains": [
  "http://127.0.0.1:8188",
  "ws://127.0.0.1:8188"
]
```

Always unload and reload the plugin after changing permissions.

## Troubleshooting

### `Manifest entry not found` / `Permission denied`

- Unload and reload the plugin in UXP Developer Tool (not just close the panel)
- Confirm you loaded the correct folder (repo root vs `.package/aPix Builder/`)
- If using `.package/`, run `npm run prepare:package` so manifest matches source
- Verify ComfyUI URL matches allowed domains if you restricted `manifest.json`
- Ensure `allowInsecureRequests: true` when using `http://` (not `https://`)

### Connection check fails

- Confirm ComfyUI is running: open `http://127.0.0.1:8188` in a browser
- Check firewall / port binding (`--listen 127.0.0.1`)
- Try reloading the plugin after saving server URL

### `No templates found`

- Run `npm run build` to generate `app_build.json` files
- Check console in UXP Developer Tool for per-template load errors
- Verify template IDs in `src/state.js` match folder names under `templates/`

### Custom folder load fails

- Folder must contain both `app_build.json` and `api.json`
- Run `npm run compile:templates` on a folder with only YAML, or copy generated JSON from a built template

### Workflow validation error on template select

- YAML `id` fields must match nodes/fields in `api.json`
- Error message names the missing node or field — fix mapping in `app_build.yaml`, then `npm run build`

### Run succeeds but no output layers

- Check ComfyUI history for the prompt ID shown in status
- Verify `output` section in template points to the correct node ID
- Some workflows write to non-image outputs only

### Selection / export issues

- Imaging API requires Photoshop 24.3+; older versions fall back to `saveAs.png` (slower)
- Very large documents may be slow to export — consider using a selection to limit area
- Temporary selection layers are deleted automatically after export

### Cancel does not stop immediately

- Cancel sends ComfyUI `/interrupt` and aborts in-flight HTTP requests
- Some nodes may finish their current step before stopping

## Testing

```bash
npm test
```

Tests cover:

- Workflow ID resolution (`resolveWorkflowInput`)
- Template input flattening and default values
- ComfyUI URL normalization and data URL parsing

Photoshop DOM and UXP APIs are not tested in Node — verify those manually in Photoshop.

## License

Private project — see repository owner for distribution terms.
