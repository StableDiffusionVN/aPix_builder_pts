# aPix Builder Photoshop Plugin

Photoshop UXP plugin that sends workflow parameters and the current Photoshop image to a ComfyUI server.

## Features

- Settings panel for the ComfyUI server URL.
- Workflow selector loaded from bundled template folders.
- Optional custom workflow folder picker. The folder must contain:
  - `api.json`
  - `app_build.yaml`
- Dynamic UI generated from `app_build.yaml`.
- Workflow patching using ids like `23-seed`, `14-resize_type.longer_size`, or `308-Menu`.
- Image upload to ComfyUI `/upload/image`.
- Prompt queue through `/prompt`.
- Progress/completion tracking through ComfyUI websocket `/ws`.
- Output image lookup through `/history/{prompt_id}`.

## Development

```bash
npm install
npm run build
```

For active development:

```bash
npm run watch
```

## Load in Photoshop

1. Open Adobe UXP Developer Tool.
2. Add this plugin folder: `/Users/LibraryM4/Documents/GitHub/aPix_builder_pts`.
3. Load the plugin, then open it from Photoshop: `Plugins > aPix Builder`.

## Template Format

Bundled templates live in `templates/<template-id>/`.

Each input in `app_build.yaml` can target a workflow value with:

```yaml
input:
  seed:
    id: 23-seed
    ui:
      type: seed
      label: Seed
      value: random_seed
```

The id maps to:

```text
api.json node 23 -> inputs.seed
```

Supported UI types include `image`, `text`, `string`, `int`, `float`, `number`, `slider`, `menu`, `dropdown`, `checkbox`, `boolean`, `seed`, `note`, and `markdown`.

## Notes

- Image fields can use the active Photoshop document or a local image file.
- `image_mask` currently behaves like `image`; the dedicated mask painting UI from the web app has not been ported into the Photoshop panel.
- Dynamic model discovery fields such as checkpoints/loras render as selects only when choices are provided in YAML.
