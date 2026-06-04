const photoshop = require("photoshop");
const { app, core, imaging } = photoshop;
const { batchPlay } = photoshop.action;
const { storage } = require("uxp");
import { setStatus, setImageInputValue } from "../state.js";

// Helper utilities
function numericValue(value) {
  if (Number.isFinite(value)) return value;
  if (Number.isFinite(value?._value)) return value._value;
  if (Number.isFinite(value?.value)) return value.value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]);
}

async function readUxFileAsDataUrl(file) {
  const bytes = await file.read({ format: storage.formats.binary });
  const ext = String(file.name || "").toLowerCase();
  const mime = ext.endsWith(".jpg") || ext.endsWith(".jpeg") ? "image/jpeg" : ext.endsWith(".webp") ? "image/webp" : "image/png";
  let binary = "";
  const buffer = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer || bytes);
  for (let i = 0; i < buffer.length; i += 1) binary += String.fromCharCode(buffer[i]);
  return `data:${mime};base64,${btoa(binary)}`;
}

function loadDataUrlImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = dataUrl;
  });
}

export async function cropDataUrlToSelection(dataUrl, selectionInfo) {
  if (!selectionInfo) return dataUrl;
  if (typeof Image === "undefined") return dataUrl;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext?.("2d");
  if (!context) return dataUrl;
  const image = await loadDataUrlImage(dataUrl);
  const docWidth = numericValue(app.activeDocument.width) || image.naturalWidth;
  const docHeight = numericValue(app.activeDocument.height) || image.naturalHeight;
  const scaleX = image.naturalWidth / docWidth;
  const scaleY = image.naturalHeight / docHeight;
  const sx = Math.max(0, Math.round(selectionInfo.left * scaleX));
  const sy = Math.max(0, Math.round(selectionInfo.top * scaleY));
  const sw = Math.max(1, Math.round(selectionInfo.width * scaleX));
  const sh = Math.max(1, Math.round(selectionInfo.height * scaleY));
  canvas.width = sw;
  canvas.height = sh;
  context.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toDataURL("image/png");
}

export async function getSelectionInfo() {
  try {
    const result = await core.executeAsModal(async () => batchPlay([
      {
        _obj: "get",
        _target: [
          { _property: "selection" },
          { _ref: "document", _id: app.activeDocument._id || app.activeDocument.id }
        ],
        _options: { dialogOptions: "dontDisplay" }
      }
    ], {
      synchronousExecution: true,
      modalBehavior: "execute"
    }), { commandName: "Read aPix selection" });
    const selection = result?.[0]?.selection;
    if (!selection?.left || !selection?.right || !selection?.top || !selection?.bottom) return null;
    const left = selection.left._value;
    const right = selection.right._value;
    const top = selection.top._value;
    const bottom = selection.bottom._value;
    if (![left, right, top, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
    return { left, right, top, bottom, width: right - left, height: bottom - top };
  } catch {
    return null;
  }
}

function selectionSourceBounds(selectionInfo) {
  return {
    left: Math.max(0, Math.floor(selectionInfo.left)),
    top: Math.max(0, Math.floor(selectionInfo.top)),
    right: Math.max(1, Math.ceil(selectionInfo.right)),
    bottom: Math.max(1, Math.ceil(selectionInfo.bottom))
  };
}

async function getPixelsAsDataUrl(options, commandName) {
  let imageObj = null;
  try {
    const base64 = await core.executeAsModal(async () => {
      imageObj = await imaging.getPixels(options);
      return imaging.encodeImageData({
        imageData: imageObj.imageData,
        base64: true
      });
    }, { commandName });
    return `data:image/jpeg;base64,${base64}`;
  } finally {
    try { imageObj?.imageData?.dispose?.(); } catch {}
  }
}

export async function exportSelectionCompositeDataUrl(selectionInfo) {
  if (!imaging?.getPixels || !imaging?.encodeImageData) {
    throw new Error("Photoshop Imaging API is not available");
  }
  const doc = app.activeDocument;
  if (!doc) throw new Error("No active Photoshop document");
  return getPixelsAsDataUrl({
    documentID: doc.id || doc._id,
    sourceBounds: selectionSourceBounds(selectionInfo),
    colorSpace: "RGB",
    componentSize: 8,
    applyAlpha: true
  }, "Export selected pixels");
}

async function exportVisibleLayerOnlyDataUrl(layer) {
  const visibility = [];
  await core.executeAsModal(async () => {
    for (const docLayer of app.activeDocument.layers || []) {
      visibility.push([docLayer, docLayer.visible]);
      docLayer.visible = docLayer === layer;
    }
  }, { commandName: "Prepare active layer export" });
  try {
    return await exportActiveDocumentDataUrl();
  } finally {
    await core.executeAsModal(async () => {
      for (const [docLayer, visible] of visibility) {
        try { docLayer.visible = visible; } catch {}
      }
    }, { commandName: "Restore layer visibility" });
  }
}

export async function exportActiveLayerDataUrl() {
  const doc = app.activeDocument;
  const layer = doc?.activeLayers?.[0];
  if (!doc || !layer) throw new Error("No active Photoshop layer");
  if (imaging?.getPixels && imaging?.encodeImageData) {
    return getPixelsAsDataUrl({
      documentID: doc.id || doc._id,
      layerID: layer.id || layer._id,
      colorSpace: "RGB",
      componentSize: 8,
      applyAlpha: true
    }, "Export active layer pixels");
  }
  return exportVisibleLayerOnlyDataUrl(layer);
}

export async function reselectSelection(selectionInfo) {
  if (!selectionInfo) return;
  await batchPlay([
    {
      _obj: "set",
      _target: [{ _ref: "channel", _property: "selection" }],
      to: {
        _obj: "rectangle",
        top: { _unit: "pixelsUnit", _value: selectionInfo.top },
        left: { _unit: "pixelsUnit", _value: selectionInfo.left },
        bottom: { _unit: "pixelsUnit", _value: selectionInfo.bottom },
        right: { _unit: "pixelsUnit", _value: selectionInfo.right }
      },
      _options: { dialogOptions: "dontDisplay" }
    }
  ], {
    synchronousExecution: true,
    modalBehavior: "execute"
  });
}

export async function copySelectionMergedToLayer(selectionInfo) {
  if (!selectionInfo) return null;
  let createdLayer = null;
  await core.executeAsModal(async () => {
    await reselectSelection(selectionInfo);
    try {
      await batchPlay([
        {
          _obj: "copyEvent",
          copyHint: "merged",
          _options: { dialogOptions: "dontDisplay" }
        }
      ], {
        synchronousExecution: true,
        modalBehavior: "execute"
      });
    } catch {
      await batchPlay([
        {
          _obj: "copy",
          merged: true,
          _options: { dialogOptions: "dontDisplay" }
        }
      ], {
        synchronousExecution: true,
        modalBehavior: "execute"
      });
    }
    await batchPlay([
      {
        _obj: "paste",
        antiAlias: { _enum: "antiAliasType", _value: "antiAliasNone" },
        as: { _class: "pixel" },
        _options: { dialogOptions: "dontDisplay" }
      }
    ], {
      synchronousExecution: true,
      modalBehavior: "execute"
    });
    createdLayer = app.activeDocument.activeLayers?.[0] || null;
    if (createdLayer) createdLayer.name = `aPix selection input ${Date.now()}`;
    await reselectSelection(selectionInfo);
  }, { commandName: "Create aPix selection input layer" });
  return createdLayer;
}

export async function deleteLayer(layer) {
  if (!layer) return;
  try {
    await core.executeAsModal(async () => {
      await layer.delete();
    }, { commandName: "Delete aPix temporary layer" });
  } catch (error) {
    console.warn("Cannot delete temporary selection layer", error);
  }
}

export async function fitActiveLayerToSelectionOrigin(selectionInfo) {
  const layer = app.activeDocument.activeLayers?.[0];
  const current = layerBounds(layer);
  if (!current) throw new Error("Cannot read temporary selection layer bounds");
  await layer.translate(-current.left, -current.top);
  const moved = layerBounds(layer);
  if (!moved) throw new Error("Cannot read moved temporary selection layer bounds");
  const widthPercent = (selectionInfo.width / moved.width) * 100;
  const heightPercent = (selectionInfo.height / moved.height) * 100;
  await batchPlay([
    {
      _obj: "transform",
      _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
      freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
      width: { _unit: "percentUnit", _value: widthPercent },
      height: { _unit: "percentUnit", _value: heightPercent },
      linked: false,
      interfaceIconFrameDimmed: { _enum: "interpolationType", _value: "bicubic" },
      _isCommand: true,
      _options: { dialogOptions: "dontDisplay" }
    }
  ], {
    synchronousExecution: true,
    modalBehavior: "execute"
  });
  const scaled = layerBounds(layer);
  if (scaled) await layer.translate(-scaled.left, -scaled.top);
}

export async function exportSelectionLayerCacheDataUrl(layer, selectionInfo) {
  if (!layer) throw new Error("Missing layer to export");
  const sourceDoc = app.activeDocument;
  let dataUrl = "";
  await core.executeAsModal(async () => {
    const tempDoc = await app.documents.add({
      width: Math.max(1, Math.round(selectionInfo.width)),
      height: Math.max(1, Math.round(selectionInfo.height)),
      resolution: sourceDoc.resolution,
      mode: "RGBColorMode",
      fill: "transparent"
    });
    const duplicatedLayer = await layer.duplicate(tempDoc);
    for (const docLayer of tempDoc.layers || []) {
      docLayer.visible = docLayer === duplicatedLayer;
      docLayer.selected = docLayer === duplicatedLayer;
    }
    await fitActiveLayerToSelectionOrigin(selectionInfo);
    dataUrl = await saveActiveDocumentPngDataUrlNoModal("apix_selection_cache");
    await tempDoc.closeWithoutSaving();
  }, { commandName: "Export aPix selection cache" });
  await core.executeAsModal(async () => {
    if (selectionInfo) await reselectSelection(selectionInfo);
  }, { commandName: "Restore aPix source selection" });
  return dataUrl;
}

export async function exportInputDataUrlForRun(selectionInfo) {
  const fullDataUrl = await exportActiveDocumentDataUrl();
  if (!selectionInfo) return fullDataUrl;
  try {
    return await cropDataUrlToSelection(fullDataUrl, selectionInfo);
  } catch (error) {
    console.warn("Selection crop failed, using full document input", error);
    return fullDataUrl;
  }
}

export async function prepareSelectionInputDataUrl(selectionInfo, existingValue) {
  try {
    setStatus("Exporting selected pixels in background...");
    return await withTimeout(
      exportSelectionCompositeDataUrl(selectionInfo),
      10000,
      "Export selected pixels timed out"
    );
  } catch (error) {
    console.warn("Selection pixel export failed", error);
  }
  if (typeof existingValue === "string" && existingValue.startsWith("data:")) return existingValue;
  throw new Error("Cannot export selected pixels and no image input fallback is available");
}

export async function prepareSelectionLayerInputDataUrl(selectionInfo, imageKey) {
  setStatus("Duplicating selection to input layer...");
  const layer = await copySelectionMergedToLayer(selectionInfo);
  if (!layer) throw new Error("Cannot create layer from selected pixels");
  setStatus("Exporting duplicated selection layer...");
  const dataUrl = await exportActiveLayerDataUrl();
  setImageInputValue(imageKey, dataUrl, "layer");
  setStatus("Selection layer image ready");
  return dataUrl;
}

export async function exportActiveDocumentDataUrl() {
  if (!app.activeDocument) throw new Error("No active Photoshop document");
  const tempFolder = await storage.localFileSystem.getTemporaryFolder();
  const file = await tempFolder.createFile(`apix_${Date.now()}.png`, { overwrite: true });
  await core.executeAsModal(async () => {
    await app.activeDocument.saveAs.png(file, { compression: 6 }, true);
  }, { commandName: "Export aPix input" });
  return readUxFileAsDataUrl(file);
}

export async function saveActiveDocumentPngDataUrlNoModal(prefix = "apix") {
  if (!app.activeDocument) throw new Error("No active Photoshop document");
  const tempFolder = await storage.localFileSystem.getTemporaryFolder();
  const file = await tempFolder.createFile(`${prefix}_${Date.now()}.png`, { overwrite: true });
  await app.activeDocument.saveAs.png(file, { compression: 6 }, true);
  return readUxFileAsDataUrl(file);
}

export function layerBounds(layer) {
  const bounds = layer?.bounds || layer?.boundsNoEffects;
  if (!bounds) return null;
  const left = Number(bounds.left ?? bounds._left);
  const right = Number(bounds.right ?? bounds._right);
  const top = Number(bounds.top ?? bounds._top);
  const bottom = Number(bounds.bottom ?? bounds._bottom);
  if (![left, right, top, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

export async function transformActiveLayerToBounds(bounds) {
  if (!bounds) return;
  await core.executeAsModal(async () => {
    const layer = app.activeDocument.activeLayers?.[0];
    const current = layerBounds(layer);
    if (!current) throw new Error("Cannot read imported layer bounds");
    const widthPercent = (bounds.width / current.width) * 100;
    const heightPercent = (bounds.height / current.height) * 100;
    await batchPlay([
      {
        _obj: "set",
        _target: [{ _ref: "channel", _property: "selection" }],
        to: { _enum: "ordinal", _value: "none" },
        _options: { dialogOptions: "dontDisplay" }
      },
      {
        _obj: "transform",
        _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
        freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
        width: { _unit: "percentUnit", _value: widthPercent },
        height: { _unit: "percentUnit", _value: heightPercent },
        linked: false,
        interfaceIconFrameDimmed: { _enum: "interpolationType", _value: "bicubic" },
        _isCommand: true,
        _options: { dialogOptions: "dontDisplay" }
      }
    ], {
      synchronousExecution: true,
      modalBehavior: "execute"
    });
    const scaled = layerBounds(layer);
    if (!scaled) throw new Error("Cannot read scaled layer bounds");
    await layer.translate(bounds.left - scaled.left, bounds.top - scaled.top);
  }, { commandName: "Fit aPix output to selection" });
}

export async function importBufferAsLayer(buffer, filename = "apix_output.png", fitBounds = null) {
  if (!app.activeDocument) throw new Error("No active Photoshop document");
  const tempFolder = await storage.localFileSystem.getTemporaryFolder();
  const safeName = String(filename || "apix_output.png").replace(/[^\w.-]+/g, "_");
  const file = await tempFolder.createFile(safeName, { overwrite: true });
  await file.write(buffer, { format: storage.formats.binary });
  const token = await storage.localFileSystem.createSessionToken(file);
  let placedLayer = null;
  await core.executeAsModal(async () => {
    await batchPlay([
      {
        _obj: "placeEvent",
        null: {
          _path: token,
          _kind: "local"
        },
        freeTransformCenterState: {
          _enum: "quadCenterState",
          _value: "QCSAverage"
        },
        offset: {
          _obj: "offset",
          horizontal: { _unit: "pixelsUnit", _value: 0 },
          vertical: { _unit: "pixelsUnit", _value: 0 }
        },
        _isCommand: true,
        _options: {
          dialogOptions: "dontDisplay"
        }
      }
    ], {
      synchronousExecution: true,
      modalBehavior: "execute"
    });
    placedLayer = app.activeDocument.activeLayers?.[0] || null;
    if (placedLayer) placedLayer.name = safeName.replace(/\.[^.]+$/, "");
  }, { commandName: "Import aPix output" });
  if (fitBounds) await transformActiveLayerToBounds(fitBounds);
  return placedLayer;
}
