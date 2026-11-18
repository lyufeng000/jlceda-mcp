import fs from "node:fs";
import { PNG } from "pngjs";
import type { CdpCallFunctionOptions, ICdpRpcExecutor } from "../types/index.js";

export interface HudViolationMarker {
  id?: string;
  xMm: number;
  yMm: number;
  radiusMm?: number;
  label?: string;
  severity?: "BLOCKER" | "WARNING";
}

export interface HudOverlaySpec {
  viewportWidthPx?: number;
  viewportHeightPx?: number;
  regionMm?: [number, number, number, number];
  gridSpacingMm?: number;
  showOriginAxes?: boolean;
  violations?: HudViolationMarker[];
}

export interface LayerVisibilityEntry {
  id: number | string;
  name?: string;
  layerStatus: number;
  visible: boolean;
}

export interface SideBySideOptions {
  leftTitle?: string;
  rightTitle?: string;
  subtitle?: string;
  paddingPx?: number;
  gapPx?: number;
  headerHeightPx?: number;
  targetPanelHeightPx?: number;
}

export interface SideBySideResult {
  pngBuffer: Buffer;
  width: number;
  height: number;
  leftRect: { x: number; y: number; width: number; height: number };
  rightRect: { x: number; y: number; width: number; height: number };
}

export interface ViewCaptureHudOptions {
  document?: string | null;
  mode?: "2d_canvas" | "3d_model";
  view3d?: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  viewport?: "current" | "fit_board" | "selection" | "region";
  regionMm?: [number, number, number, number];
  overlayGridMm?: number;
  violations?: HudViolationMarker[];
  visibleLayers?: Array<number | string>;
  clip?: { x: number; y: number; width: number; height: number; scale?: number };
  compareWithDatasheetPng?: Buffer;
  compareWithDatasheetPath?: string;
  leftTitle?: string;
  rightTitle?: string;
  datasheetLabel?: string;
}

const HUD_OVERLAY_DOM_ID = "jlc-mcp-hud-overlay";

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Generate a non-intrusive transparent SVG metric grid + violation marker HUD overlay.
 */
export function buildHudSvgMarkup(spec: HudOverlaySpec = {}): string {
  const widthPx = Math.max(100, Math.round(spec.viewportWidthPx ?? 1280));
  const heightPx = Math.max(100, Math.round(spec.viewportHeightPx ?? 800));
  const [minX, minY, maxX, maxY] = spec.regionMm ?? [0, 0, 100, 62.5];
  const spanX = Math.max(0.1, maxX - minX);
  const spanY = Math.max(0.1, maxY - minY);

  let stepMm = Math.max(0.1, spec.gridSpacingMm ?? 5);
  while (spanX / stepMm > 32 || spanY / stepMm > 32) {
    stepMm *= 2;
  }

  const toPxX = (xMm: number): number => ((xMm - minX) / spanX) * widthPx;
  const toPxY = (yMm: number): number => ((yMm - minY) / spanY) * heightPx;

  const lines: string[] = [];
  const startX = Math.ceil(minX / stepMm) * stepMm;
  for (let x = startX; x <= maxX + 1e-9; x += stepMm) {
    const px = toPxX(x).toFixed(2);
    lines.push(
      `<line x1="${px}" y1="0" x2="${px}" y2="${heightPx}" stroke="rgba(56,189,248,0.28)" stroke-width="1" stroke-dasharray="3,3" />`
    );
    lines.push(
      `<text x="${(Number(px) + 3).toFixed(1)}" y="14" fill="rgba(125,211,252,0.9)" font-family="monospace" font-size="11">${x.toFixed(1)}mm</text>`
    );
  }

  const startY = Math.ceil(minY / stepMm) * stepMm;
  for (let y = startY; y <= maxY + 1e-9; y += stepMm) {
    const py = toPxY(y).toFixed(2);
    lines.push(
      `<line x1="0" y1="${py}" x2="${widthPx}" y2="${py}" stroke="rgba(56,189,248,0.28)" stroke-width="1" stroke-dasharray="3,3" />`
    );
    lines.push(
      `<text x="4" y="${(Number(py) - 3).toFixed(1)}" fill="rgba(125,211,252,0.9)" font-family="monospace" font-size="11">${y.toFixed(1)}mm</text>`
    );
  }

  if (spec.showOriginAxes !== false && minX <= 0 && maxX >= 0 && minY <= 0 && maxY >= 0) {
    const ox = toPxX(0).toFixed(2);
    const oy = toPxY(0).toFixed(2);
    lines.push(
      `<circle cx="${ox}" cy="${oy}" r="5" fill="none" stroke="#facc15" stroke-width="1.8" />`
    );
    lines.push(
      `<line x1="${ox}" y1="${oy}" x2="${(Number(ox) + 28).toFixed(1)}" y2="${oy}" stroke="#ef4444" stroke-width="2" />`
    );
    lines.push(
      `<line x1="${ox}" y1="${oy}" x2="${ox}" y2="${(Number(oy) + 28).toFixed(1)}" stroke="#22c55e" stroke-width="2" />`
    );
  }

  const violations = spec.violations ?? [];
  violations.forEach((v, idx) => {
    const cx = toPxX(v.xMm);
    const cy = toPxY(v.yMm);
    const radMm = v.radiusMm ?? 1.5;
    const rx = Math.max(8, (radMm / spanX) * widthPx);
    const color = v.severity === "WARNING" ? "#f59e0b" : "#ef4444";
    const tag = escapeXml(v.id ?? `#V${idx + 1}`);
    const label = v.label ? ` ${escapeXml(v.label)}` : "";
    lines.push(
      `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rx.toFixed(1)}" fill="rgba(239,68,68,0.12)" stroke="${color}" stroke-width="2.2" />`
    );
    lines.push(
      `<text x="${(cx + rx + 4).toFixed(1)}" y="${(cy + 4).toFixed(1)}" fill="${color}" font-family="monospace" font-weight="bold" font-size="12">${tag}${label}</text>`
    );
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${widthPx} ${heightPx}" style="display:block;width:100%;height:100%;pointer-events:none;">${lines.join("")}</svg>`;
}

const FN_INJECT_HUD = `function(payload) {
  var g = globalThis;
  var doc = g.document;
  if (!doc || !doc.body) {
    return { injected: false, reason: "no_document_body" };
  }
  var id = String(payload.domId);
  var existing = doc.getElementById(id);
  if (existing && existing.parentNode) {
    existing.parentNode.removeChild(existing);
  }
  var container = doc.createElement("div");
  container.id = id;
  container.style.position = "fixed";
  container.style.left = "0";
  container.style.top = "0";
  container.style.width = "100vw";
  container.style.height = "100vh";
  container.style.pointerEvents = "none";
  container.style.zIndex = "2147483647";
  container.innerHTML = String(payload.svgMarkup || "");
  doc.body.appendChild(container);
  return { injected: true, width: g.innerWidth || 1280, height: g.innerHeight || 800 };
}`;

const FN_REMOVE_HUD = `function(payload) {
  var doc = globalThis.document;
  if (!doc) return { removed: false };
  var el = doc.getElementById(String(payload.domId));
  if (el && el.parentNode) {
    el.parentNode.removeChild(el);
    return { removed: true };
  }
  return { removed: false };
}`;

const FN_GET_LAYER_VISIBILITY = `async function() {
  var eda = globalThis.eda;
  if (!eda || !eda.pcb_Layer || typeof eda.pcb_Layer.getAllLayers !== "function") {
    return [];
  }
  var layers = await eda.pcb_Layer.getAllLayers();
  if (!Array.isArray(layers)) return [];
  return layers.map(function(l) {
    return {
      id: l.id,
      name: l.name,
      layerStatus: l.layerStatus,
      visible: l.layerStatus === 1
    };
  });
}`;

const FN_APPLY_VISIBLE_LAYERS = `async function(payload) {
  var eda = globalThis.eda;
  if (!eda || !eda.pcb_Layer) return false;
  var targetIds = Array.isArray(payload.visibleLayers) ? payload.visibleLayers : [];
  if (typeof eda.pcb_Layer.setLayerVisible === "function" && targetIds.length > 0) {
    await eda.pcb_Layer.setLayerVisible(targetIds, true);
    return true;
  }
  return false;
}`;

const FN_RESTORE_LAYER_VISIBILITY = `async function(payload) {
  var eda = globalThis.eda;
  if (!eda || !eda.pcb_Layer) return false;
  var snapshot = Array.isArray(payload.snapshot) ? payload.snapshot : [];
  var showIds = [];
  var hideIds = [];
  for (var i = 0; i < snapshot.length; i++) {
    var item = snapshot[i];
    if (item.layerStatus === 0) continue;
    if (item.visible) showIds.push(item.id);
    else hideIds.push(item.id);
  }
  if (showIds.length > 0 && typeof eda.pcb_Layer.setLayerVisible === "function") {
    await eda.pcb_Layer.setLayerVisible(showIds, false);
  }
  if (hideIds.length > 0 && typeof eda.pcb_Layer.setLayerInvisible === "function") {
    await eda.pcb_Layer.setLayerInvisible(hideIds, false);
  }
  return true;
}`;

const FN_FOCUS_VIEWPORT = `async function(payload) {
  var eda = globalThis.eda;
  if (!eda) return false;
  var viewport = payload.viewport || "current";
  if (payload.mode === "3d_model" && eda.sys_HeaderMenu && typeof eda.sys_HeaderMenu.execute === "function") {
    // Best-effort 3D view switching if available
  }
  if (eda.dmt_EditorControl) {
    if (viewport === "fit_board" && typeof eda.dmt_EditorControl.zoomToAllPrimitives === "function") {
      await eda.dmt_EditorControl.zoomToAllPrimitives();
      return true;
    }
    if (viewport === "selection" && typeof eda.dmt_EditorControl.zoomToSelectedPrimitives === "function") {
      await eda.dmt_EditorControl.zoomToSelectedPrimitives();
      return true;
    }
    if (viewport === "region" && Array.isArray(payload.regionNative) && payload.regionNative.length === 4 && typeof eda.dmt_EditorControl.zoomToRegion === "function") {
      var r = payload.regionNative;
      await eda.dmt_EditorControl.zoomToRegion(r[0], r[2], r[1], r[3]);
      return true;
    }
  }
  return false;
}`;

export async function injectHudOverlay(
  executor: ICdpRpcExecutor,
  spec: HudOverlaySpec,
  callOptions: CdpCallFunctionOptions = {}
): Promise<void> {
  const svgMarkup = buildHudSvgMarkup(spec);
  await executor.callFunction(
    FN_INJECT_HUD,
    [{ domId: HUD_OVERLAY_DOM_ID, svgMarkup }],
    { ...callOptions, awaitPromise: false, returnByValue: true }
  );
}

export async function removeHudOverlay(
  executor: ICdpRpcExecutor,
  callOptions: CdpCallFunctionOptions = {}
): Promise<void> {
  await executor.callFunction(
    FN_REMOVE_HUD,
    [{ domId: HUD_OVERLAY_DOM_ID }],
    { ...callOptions, awaitPromise: false, returnByValue: true }
  );
}

export async function captureLayerVisibilitySnapshot(
  executor: ICdpRpcExecutor,
  callOptions: CdpCallFunctionOptions = {}
): Promise<LayerVisibilityEntry[]> {
  const res = await executor.callFunction<LayerVisibilityEntry[]>(
    FN_GET_LAYER_VISIBILITY,
    [],
    { ...callOptions, awaitPromise: true, returnByValue: true }
  );
  return Array.isArray(res) ? res : [];
}

export async function applyTemporaryLayerVisibility(
  executor: ICdpRpcExecutor,
  visibleLayers: Array<number | string>,
  callOptions: CdpCallFunctionOptions = {}
): Promise<void> {
  await executor.callFunction(
    FN_APPLY_VISIBLE_LAYERS,
    [{ visibleLayers }],
    { ...callOptions, awaitPromise: true, returnByValue: true }
  );
}

export async function restoreLayerVisibilitySnapshot(
  executor: ICdpRpcExecutor,
  snapshot: LayerVisibilityEntry[],
  callOptions: CdpCallFunctionOptions = {}
): Promise<void> {
  await executor.callFunction(
    FN_RESTORE_LAYER_VISIBILITY,
    [{ snapshot }],
    { ...callOptions, awaitPromise: true, returnByValue: true }
  );
}

// Minimal crisp 5x7 ASCII bitmap font for header titles rendered directly into PNG pixels.
const FONT_5X7: Record<string, string[]> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "/": ["00001", "00010", "00100", "00100", "01000", "10000", "00000"],
  "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
  ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
  "_": ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  "|": ["00100", "00100", "00100", "00100", "00100", "00100", "00100"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00110", "01000", "10000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11100", "10010", "10001", "10001", "10001", "10010", "11100"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
};

function setPixelRgba(
  png: PNG,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a = 255
): void {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) {
    return;
  }
  const idx = (png.width * y + x) << 2;
  png.data[idx] = r;
  png.data[idx + 1] = g;
  png.data[idx + 2] = b;
  png.data[idx + 3] = a;
}

function fillRectRgba(
  png: PNG,
  x: number,
  y: number,
  width: number,
  height: number,
  rgba: [number, number, number, number]
): void {
  const [r, g, b, a] = rgba;
  const xEnd = Math.min(png.width, x + width);
  const yEnd = Math.min(png.height, y + height);
  for (let py = Math.max(0, y); py < yEnd; py++) {
    for (let px = Math.max(0, x); px < xEnd; px++) {
      setPixelRgba(png, px, py, r, g, b, a);
    }
  }
}

function drawBitmapText(
  png: PNG,
  text: string,
  startX: number,
  startY: number,
  scale: number,
  color: [number, number, number, number]
): void {
  const upper = text.toUpperCase();
  let cursorX = startX;
  for (let cIdx = 0; cIdx < upper.length; cIdx++) {
    const ch = upper[cIdx];
    const glyph = FONT_5X7[ch] ?? FONT_5X7[" "];
    for (let row = 0; row < 7; row++) {
      const bits = glyph[row];
      for (let col = 0; col < 5; col++) {
        if (bits[col] === "1") {
          fillRectRgba(
            png,
            cursorX + col * scale,
            startY + row * scale,
            scale,
            scale,
            color
          );
        }
      }
    }
    cursorX += 6 * scale;
  }
}

function resizePngBilinear(src: PNG, targetW: number, targetH: number): PNG {
  if (src.width === targetW && src.height === targetH) {
    return src;
  }
  const dst = new PNG({ width: targetW, height: targetH, fill: true });
  const xRatio = src.width / targetW;
  const yRatio = src.height / targetH;

  for (let y = 0; y < targetH; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y + 0.5) * yRatio));
    for (let x = 0; x < targetW; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x + 0.5) * xRatio));
      const sIdx = (src.width * sy + sx) << 2;
      const dIdx = (dst.width * y + x) << 2;
      dst.data[dIdx] = src.data[sIdx];
      dst.data[dIdx + 1] = src.data[sIdx + 1];
      dst.data[dIdx + 2] = src.data[sIdx + 2];
      dst.data[dIdx + 3] = src.data[sIdx + 3];
    }
  }
  return dst;
}

/**
 * Composite the captured PCB PNG (left) and cached OEM Datasheet `Layout Example`
 * PNG (right) side-by-side into a single high-resolution labeled comparison PNG Buffer
 * using direct `pngjs` pixel Buffer manipulation.
 */
export function composeSideBySideComparisonPng(
  actualPngBuffer: Buffer,
  referencePngBuffer: Buffer,
  options: SideBySideOptions = {}
): SideBySideResult {
  const actualPng = PNG.sync.read(actualPngBuffer);
  const refPng = PNG.sync.read(referencePngBuffer);

  const paddingPx = Math.max(4, options.paddingPx ?? 16);
  const gapPx = Math.max(4, options.gapPx ?? 16);
  const headerHeightPx = Math.max(24, options.headerHeightPx ?? 40);

  const panelHeight = Math.max(
    64,
    options.targetPanelHeightPx ?? Math.max(actualPng.height, refPng.height)
  );

  const leftScale = panelHeight / actualPng.height;
  const rightScale = panelHeight / refPng.height;
  const leftWidth = Math.max(1, Math.round(actualPng.width * leftScale));
  const rightWidth = Math.max(1, Math.round(refPng.width * rightScale));

  const scaledLeft = resizePngBilinear(actualPng, leftWidth, panelHeight);
  const scaledRight = resizePngBilinear(refPng, rightWidth, panelHeight);

  const totalWidth = paddingPx * 2 + leftWidth + gapPx + rightWidth;
  const totalHeight = paddingPx * 2 + headerHeightPx + panelHeight;

  const canvas = new PNG({ width: totalWidth, height: totalHeight, fill: true });
  // Dark neutral canvas background (#161B22)
  fillRectRgba(canvas, 0, 0, totalWidth, totalHeight, [22, 27, 34, 255]);

  // Header accent bars & bitmap titles
  const leftX = paddingPx;
  const rightX = paddingPx + leftWidth + gapPx;
  const panelY = paddingPx + headerHeightPx;

  fillRectRgba(canvas, leftX, paddingPx, leftWidth, headerHeightPx - 6, [30, 38, 50, 255]);
  fillRectRgba(canvas, leftX, paddingPx, 4, headerHeightPx - 6, [47, 129, 247, 255]);
  drawBitmapText(
    canvas,
    options.leftTitle ?? "ACTUAL PCB VIEW",
    leftX + 12,
    paddingPx + 10,
    2,
    [230, 237, 243, 255]
  );

  fillRectRgba(canvas, rightX, paddingPx, rightWidth, headerHeightPx - 6, [30, 44, 38, 255]);
  fillRectRgba(canvas, rightX, paddingPx, 4, headerHeightPx - 6, [63, 185, 80, 255]);
  drawBitmapText(
    canvas,
    options.rightTitle ?? "DATASHEET LAYOUT EXAMPLE",
    rightX + 12,
    paddingPx + 10,
    2,
    [230, 237, 243, 255]
  );

  // Center vertical divider line
  const dividerX = paddingPx + leftWidth + Math.floor(gapPx / 2);
  fillRectRgba(canvas, dividerX, paddingPx, 2, headerHeightPx + panelHeight, [48, 54, 61, 255]);

  // Blit both image pixel buffers side-by-side
  PNG.bitblt(scaledLeft, canvas, 0, 0, leftWidth, panelHeight, leftX, panelY);
  PNG.bitblt(scaledRight, canvas, 0, 0, rightWidth, panelHeight, rightX, panelY);

  return {
    pngBuffer: PNG.sync.write(canvas),
    width: totalWidth,
    height: totalHeight,
    leftRect: { x: leftX, y: panelY, width: leftWidth, height: panelHeight },
    rightRect: { x: rightX, y: panelY, width: rightWidth, height: panelHeight },
  };
}

/**
 * Full view capture pipeline:
 * 1) Optional viewport zoom/focus
 * 2) Optional temporary layer visibility snapshot/filter (restored in finally)
 * 3) Optional metric HUD SVG overlay injection (removed in finally)
 * 4) CDP `Page.captureScreenshot`
 * 5) Optional side-by-side Datasheet `Layout Example` composition via `pngjs`
 */
export async function captureViewWithHud(
  executor: ICdpRpcExecutor,
  options: ViewCaptureHudOptions = {},
  callOptions: CdpCallFunctionOptions = {}
): Promise<{
  pngBuffer: Buffer;
  sideBySide?: SideBySideResult;
  layerSnapshotRestored: boolean;
  hudCleanedUp: boolean;
}> {
  let layerSnapshot: LayerVisibilityEntry[] | null = null;
  let hudInjected = false;
  let layerSnapshotRestored = false;
  let hudCleanedUp = false;
  let pngBuffer!: Buffer;
  let sideBySide: SideBySideResult | undefined;

  try {
    if (options.viewport && options.viewport !== "current") {
      await executor.callFunction(
        FN_FOCUS_VIEWPORT,
        [
          {
            viewport: options.viewport,
            mode: options.mode ?? "2d_canvas",
            view3d: options.view3d,
            regionNative: options.regionMm
              ? options.regionMm.map((v) => v / 0.0254)
              : undefined,
          },
        ],
        { ...callOptions, awaitPromise: true, returnByValue: true }
      );
    }

    if (options.visibleLayers && options.visibleLayers.length > 0) {
      layerSnapshot = await captureLayerVisibilitySnapshot(executor, callOptions);
      await applyTemporaryLayerVisibility(
        executor,
        options.visibleLayers,
        callOptions
      );
    }

    if (options.overlayGridMm !== undefined || (options.violations && options.violations.length > 0)) {
      await injectHudOverlay(
        executor,
        {
          regionMm: options.regionMm,
          gridSpacingMm: options.overlayGridMm,
          violations: options.violations,
        },
        callOptions
      );
      hudInjected = true;
    }

    const captured = await executor.captureScreenshot({
      format: "png",
      clip: options.clip,
      document: options.document,
    });

    let referenceBuf = options.compareWithDatasheetPng;
    if (!referenceBuf && options.compareWithDatasheetPath) {
      referenceBuf = fs.readFileSync(options.compareWithDatasheetPath);
    }

    if (referenceBuf) {
      const rightTitle = options.rightTitle
        ?? (options.datasheetLabel
          ? `DATASHEET ${options.datasheetLabel}`
          : "DATASHEET LAYOUT EXAMPLE");
      sideBySide = composeSideBySideComparisonPng(captured, referenceBuf, {
        leftTitle: options.leftTitle ?? "ACTUAL PCB VIEW",
        rightTitle,
      });
      pngBuffer = sideBySide.pngBuffer;
    } else {
      pngBuffer = captured;
    }
  } finally {
    if (hudInjected) {
      await removeHudOverlay(executor, callOptions).catch(() => undefined);
      hudCleanedUp = true;
    }
    if (layerSnapshot !== null) {
      await restoreLayerVisibilitySnapshot(
        executor,
        layerSnapshot,
        callOptions
      ).catch(() => undefined);
      layerSnapshotRestored = true;
    }
  }

  return {
    pngBuffer,
    ...(sideBySide ? { sideBySide } : {}),
    layerSnapshotRestored,
    hudCleanedUp,
  };
}
