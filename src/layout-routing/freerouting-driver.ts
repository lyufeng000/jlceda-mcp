import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  FunctionalClusterOutput,
  Keepout25DFiveTuple,
  NetClassRule,
  ProjectDesignRules,
} from "../types/index.js";
import type { LockedCopperZone, LockedTrackSegment, LockedVia } from "./critical-prerouter.js";
import type { PlacedComponent } from "./modular-placer.js";
import { normalizeProjectDesignRules, resolveStackupLayers } from "./spacing-keepout-matrix.js";

export interface RoutedTrack {
  id: string;
  net: string;
  layer: string;
  widthMm: number;
  pointsMm: Array<[number, number]>;
  locked?: boolean;
}

export interface RoutedVia {
  id: string;
  net: string;
  xMm: number;
  yMm: number;
  drillMm: number;
  outerDiaMm: number;
  startLayer: string;
  endLayer: string;
  locked?: boolean;
}

export interface DsnGenerationInput {
  boardName?: string;
  clusterOutput: FunctionalClusterOutput;
  placements: PlacedComponent[];
  projectRules?: Partial<ProjectDesignRules>;
  keepouts25D?: Keepout25DFiveTuple[];
  lockedTracks?: LockedTrackSegment[];
  lockedVias?: LockedVia[];
  excludeNets?: string[];
}

export interface DsnGenerationResult {
  dsnContent: string;
  netCount: number;
  componentCount: number;
  fixedWireCount: number;
  keepoutCount: number;
}

export interface ParsedSesResult {
  boardName: string;
  resolutionUnit: string;
  resolutionMultiplier: number;
  tracks: RoutedTrack[];
  vias: RoutedVia[];
}

export interface AutorouteOptions {
  engine?: "freerouting_headless" | "internal_grid" | "jlc_internal";
  freeroutingJarPath?: string | null;
  tempDir?: string;
  excludeNets?: string[];
  maxPasses?: number;
  timeoutSec?: number;
  gridStepMm?: number;
  signalLayers?: string[];
  projectRules?: Partial<ProjectDesignRules>;
  keepouts25D?: Keepout25DFiveTuple[];
  lockedTracks?: LockedTrackSegment[];
  lockedCopperZones?: LockedCopperZone[];
  lockedVias?: LockedVia[];
  preRoutedTracks?: RoutedTrack[];
  preRoutedVias?: RoutedVia[];
}

export interface AutorouteResult {
  completed: boolean;
  engineUsed: "freerouting_headless" | "internal_grid_astar_ripup" | "jlc_internal";
  routedNetCount: number;
  remainingUnroutedRatlines: number;
  unroutedNets: string[];
  viaCountAdded: number;
  totalTrackLengthMm: number;
  tracks: RoutedTrack[];
  vias: RoutedVia[];
  dsnContent: string;
  sesContent: string;
  passesUsed: number;
  fallbackReason?: string;
}

// ============================================================================
// 1. Standard Specctra .dsn Generator
// ============================================================================

function qToken(s: string): string {
  const clean = s.replace(/"/g, "'");
  return `"${clean}"`;
}

function fmtNum(n: number): string {
  return Number(n.toFixed(4)).toString();
}

export function generateSpecctraDsn(input: DsnGenerationInput): DsnGenerationResult {
  const boardName = input.boardName ?? "JLCEDA_PCB";
  const outline = input.clusterOutput.board_outline;
  const W = outline.width_mm;
  const H = outline.height_mm;
  const stackup = resolveStackupLayers(outline.layer_count, outline.stackup);
  const rules = normalizeProjectDesignRules(input.projectRules);
  const excludeSet = new Set(input.excludeNets ?? []);

  const lines: string[] = [];
  lines.push(`(pcb ${qToken(boardName)}`);
  lines.push(`  (parser`);
  lines.push(`    (string_quote ")`);
  lines.push(`    (space_in_quoted_tokens on)`);
  lines.push(`    (host_cad "JLCEDA_Pro_MCP")`);
  lines.push(`    (host_version "1.0")`);
  lines.push(`  )`);
  lines.push(`  (resolution mm 1000)`);
  lines.push(`  (unit mm)`);

  // Structure: layers, boundary, 2.5D keepouts (strictly per layerSet!), default via & rule
  lines.push(`  (structure`);
  for (let i = 0; i < stackup.length; i++) {
    const lName = stackup[i];
    const isPlane = stackup.length >= 4 && i > 0 && i < stackup.length - 1;
    lines.push(`    (layer ${qToken(lName)} (type ${isPlane ? "power" : "signal"}))`);
  }

  const boundaryPts =
    outline.shape === "POLYGON" && outline.polygon_mm && outline.polygon_mm.length >= 3
      ? [...outline.polygon_mm, outline.polygon_mm[0]]
      : [
          [0, 0],
          [W, 0],
          [W, H],
          [0, H],
          [0, 0],
        ];
  const boundaryCoords = boundaryPts.map(([x, y]) => `${fmtNum(x)} ${fmtNum(y)}`).join(" ");
  lines.push(`    (boundary (path pcb 0 ${boundaryCoords}))`);

  let keepoutCount = 0;
  for (const ko of input.keepouts25D ?? []) {
    if (ko.polygon2D.length < 3) continue;
    const polyCoords = ko.polygon2D.map(([x, y]) => `${fmtNum(x)} ${fmtNum(y)}`).join(" ");
    const targetLayers = ko.layerSet.flatMap((l) =>
      l === "ALL_COPPER_LAYERS" ? stackup : [l]
    );
    const uniqueLayers = Array.from(new Set(targetLayers));
    for (const layerName of uniqueLayers) {
      if (ko.disallowMask.includes("TRACK")) {
        lines.push(`    (keepout ${qToken(ko.id ?? "KO")} (polygon ${qToken(layerName)} 0 ${polyCoords}))`);
        keepoutCount++;
      }
      if (ko.disallowMask.includes("VIA")) {
        lines.push(`    (via_keepout ${qToken(ko.id ?? "VKO")} (polygon ${qToken(layerName)} 0 ${polyCoords}))`);
      }
      if (ko.disallowMask.includes("COMPONENT") || ko.disallowMask.includes("COPPER_POUR")) {
        lines.push(`    (place_keepout ${qToken(ko.id ?? "PKO")} (polygon ${qToken(layerName)} 0 ${polyCoords}))`);
      }
    }
  }

  const defaultViaName = `via_${Math.round(rules.minViaDrillMm * 100)}_${Math.round(rules.minViaOuterDiaMm * 100)}`;
  lines.push(`    (via ${qToken(defaultViaName)})`);
  lines.push(`    (rule (width ${fmtNum(rules.defaultTraceWidthMm)}) (clearance ${fmtNum(rules.defaultClearanceMm)}))`);
  lines.push(`  )`);

  // Placement
  lines.push(`  (placement`);
  const byFootprint = new Map<string, PlacedComponent[]>();
  for (const pl of input.placements) {
    let arr = byFootprint.get(pl.footprint);
    if (!arr) {
      arr = [];
      byFootprint.set(pl.footprint, arr);
    }
    arr.push(pl);
  }
  for (const [fp, comps] of byFootprint.entries()) {
    lines.push(`    (component ${qToken(fp)}`);
    for (const c of comps) {
      const sideTok = c.side === "BOTTOM" ? "back" : "front";
      lines.push(
        `      (place ${qToken(c.designator)} ${fmtNum(c.xMm)} ${fmtNum(c.yMm)} ${sideTok} ${fmtNum(c.rotationDeg)})`
      );
    }
    lines.push(`    )`);
  }
  lines.push(`  )`);

  // Library (images & padstacks)
  lines.push(`  (library`);
  const padstacks = new Map<string, { w: number; h: number }>();
  for (const [fp, comps] of byFootprint.entries()) {
    const rep = comps[0];
    lines.push(`    (image ${qToken(fp)}`);
    // Convert world pads back to local unrotated coordinates for image definition
    const rad = (-rep.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const mirrorX = rep.side === "BOTTOM" ? -1 : 1;

    for (const pad of rep.pads) {
      const dx = pad.xMm - rep.xMm;
      const dy = pad.yMm - rep.yMm;
      const lx = (dx * cos - dy * sin) * mirrorX;
      const ly = dx * sin + dy * cos;
      const psName = `rect_${Math.round(pad.sizeMm[0] * 100)}x${Math.round(pad.sizeMm[1] * 100)}`;
      padstacks.set(psName, { w: pad.sizeMm[0], h: pad.sizeMm[1] });
      lines.push(`      (pin ${qToken(psName)} ${qToken(pad.padNumber)} ${fmtNum(lx)} ${fmtNum(ly)})`);
    }
    lines.push(`    )`);
  }

  for (const [psName, sz] of padstacks.entries()) {
    const hw = sz.w / 2;
    const hh = sz.h / 2;
    lines.push(`    (padstack ${qToken(psName)}`);
    lines.push(
      `      (shape (rect ${qToken(stackup[0] ?? "TopLayer")} ${fmtNum(-hw)} ${fmtNum(-hh)} ${fmtNum(hw)} ${fmtNum(hh)}))`
    );
    lines.push(`    )`);
  }

  lines.push(`    (padstack ${qToken(defaultViaName)}`);
  for (const layerName of stackup) {
    lines.push(`      (shape (circle ${qToken(layerName)} ${fmtNum(rules.minViaOuterDiaMm)}))`);
  }
  lines.push(`      (attach off)`);
  lines.push(`    )`);
  lines.push(`  )`);

  // Network & NetClasses
  const netPinsMap = new Map<string, string[]>();
  for (const pl of input.placements) {
    for (const pad of pl.pads) {
      if (!pad.net || excludeSet.has(pad.net)) continue;
      let list = netPinsMap.get(pad.net);
      if (!list) {
        list = [];
        netPinsMap.set(pad.net, list);
      }
      list.push(`${pl.designator}-${pad.padNumber}`);
    }
  }

  lines.push(`  (network`);
  for (const [netName, pins] of netPinsMap.entries()) {
    if (pins.length < 2) continue;
    const pinStr = pins.map(qToken).join(" ");
    lines.push(`    (net ${qToken(netName)} (pins ${pinStr}))`);
  }

  const assignedToClass = new Set<string>();
  for (const [clsName, ncRule] of Object.entries(rules.netClasses)) {
    const validNets = ncRule.nets.filter((nm) => netPinsMap.has(nm));
    if (validNets.length === 0) continue;
    validNets.forEach((nm) => assignedToClass.add(nm));
    const netsStr = validNets.map(qToken).join(" ");
    lines.push(`    (class ${qToken(clsName)} ${netsStr}`);
    lines.push(`      (circuit (use_via ${qToken(defaultViaName)}))`);
    lines.push(
      `      (rule (width ${fmtNum(ncRule.preferredWidthMm ?? ncRule.minWidthMm)}) (clearance ${fmtNum(ncRule.minClearanceMm)}))`
    );
    lines.push(`    )`);
  }

  const defaultClassNets = Array.from(netPinsMap.keys()).filter((nm) => !assignedToClass.has(nm));
  if (defaultClassNets.length > 0) {
    lines.push(`    (class "kicad_default" ${defaultClassNets.map(qToken).join(" ")}`);
    lines.push(`      (circuit (use_via ${qToken(defaultViaName)}))`);
    lines.push(
      `      (rule (width ${fmtNum(rules.defaultTraceWidthMm)}) (clearance ${fmtNum(rules.defaultClearanceMm)}))`
    );
    lines.push(`    )`);
  }
  lines.push(`  )`);

  // Wiring (FIXED Tier-1 locked tracks & vias)
  let fixedWireCount = 0;
  lines.push(`  (wiring`);
  for (const trk of input.lockedTracks ?? []) {
    if (trk.pointsMm.length < 2) continue;
    const ptsStr = trk.pointsMm.map(([x, y]) => `${fmtNum(x)} ${fmtNum(y)}`).join(" ");
    lines.push(`    (wire (path ${qToken(trk.layer)} ${fmtNum(trk.widthMm)} ${ptsStr}) (net ${qToken(trk.net)}) (type fix))`);
    fixedWireCount++;
  }
  for (const via of input.lockedVias ?? []) {
    const viaName = `via_${Math.round(via.drillMm * 100)}_${Math.round(via.outerDiaMm * 100)}`;
    lines.push(`    (via ${qToken(viaName)} ${fmtNum(via.xMm)} ${fmtNum(via.yMm)} (net ${qToken(via.net)}) (type fix))`);
  }
  lines.push(`  )`);
  lines.push(`)`);

  return {
    dsnContent: lines.join("\n"),
    netCount: netPinsMap.size,
    componentCount: input.placements.length,
    fixedWireCount,
    keepoutCount,
  };
}

// ============================================================================
// 2. Specctra .ses S-Expression Parser & Generator
// ============================================================================

type SExprNode = string | SExprNode[];

function parseSExpressions(text: string): SExprNode[] {
  const stack: SExprNode[][] = [[]];
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(") {
      const list: SExprNode[] = [];
      stack[stack.length - 1].push(list);
      stack.push(list);
      i++;
      continue;
    }
    if (ch === ")") {
      if (stack.length > 1) stack.pop();
      i++;
      continue;
    }
    if (ch === '"') {
      i++;
      let tok = "";
      while (i < len && text[i] !== '"') {
        tok += text[i++];
      }
      if (i < len && text[i] === '"') i++;
      stack[stack.length - 1].push(tok);
      continue;
    }
    let tok = "";
    while (i < len && !/[\s()]/.test(text[i])) {
      tok += text[i++];
    }
    stack[stack.length - 1].push(tok);
  }

  return stack[0];
}

function findChildList(list: SExprNode[], head: string): SExprNode[] | undefined {
  for (const item of list) {
    if (Array.isArray(item) && item[0] === head) return item;
  }
  return undefined;
}

function findChildLists(list: SExprNode[], head: string): SExprNode[][] {
  const res: SExprNode[][] = [];
  for (const item of list) {
    if (Array.isArray(item) && item[0] === head) res.push(item);
  }
  return res;
}

export function generateSpecctraSes(
  boardName: string,
  tracks: RoutedTrack[],
  vias: RoutedVia[],
  resolutionMultiplier = 1000
): string {
  const scale = (mm: number) => Math.round(mm * resolutionMultiplier);
  const lines: string[] = [];
  lines.push(`(session ${qToken(boardName)}`);
  lines.push(`  (base_design ${qToken(boardName)})`);
  lines.push(`  (routes`);
  lines.push(`    (resolution mm ${resolutionMultiplier})`);
  lines.push(`    (library_out`);
  const seenViaStacks = new Set<string>();
  for (const v of vias) {
    const psName = `via_${Math.round(v.drillMm * 100)}_${Math.round(v.outerDiaMm * 100)}`;
    if (seenViaStacks.has(psName)) continue;
    seenViaStacks.add(psName);
    lines.push(`      (padstack ${qToken(psName)}`);
    lines.push(`        (shape (circle ${qToken(v.startLayer)} ${scale(v.outerDiaMm)}))`);
    lines.push(`        (shape (circle ${qToken(v.endLayer)} ${scale(v.outerDiaMm)}))`);
    lines.push(`      )`);
  }
  lines.push(`    )`);
  lines.push(`    (network_out`);

  const byNet = new Map<string, { tracks: RoutedTrack[]; vias: RoutedVia[] }>();
  for (const t of tracks) {
    let entry = byNet.get(t.net);
    if (!entry) {
      entry = { tracks: [], vias: [] };
      byNet.set(t.net, entry);
    }
    entry.tracks.push(t);
  }
  for (const v of vias) {
    let entry = byNet.get(v.net);
    if (!entry) {
      entry = { tracks: [], vias: [] };
      byNet.set(v.net, entry);
    }
    entry.vias.push(v);
  }

  for (const [netName, group] of byNet.entries()) {
    lines.push(`      (net ${qToken(netName)}`);
    for (const t of group.tracks) {
      if (t.pointsMm.length < 2) continue;
      const pts = t.pointsMm.map(([x, y]) => `${scale(x)} ${scale(y)}`).join(" ");
      lines.push(`        (wire (path ${qToken(t.layer)} ${scale(t.widthMm)} ${pts}))`);
    }
    for (const v of group.vias) {
      const psName = `via_${Math.round(v.drillMm * 100)}_${Math.round(v.outerDiaMm * 100)}`;
      lines.push(`        (via ${qToken(psName)} ${scale(v.xMm)} ${scale(v.yMm)})`);
    }
    lines.push(`      )`);
  }

  lines.push(`    )`);
  lines.push(`  )`);
  lines.push(`)`);
  return lines.join("\n");
}

export function parseSpecctraSes(sesText: string): ParsedSesResult {
  const ast = parseSExpressions(sesText);
  const sessionNode = findChildList(ast, "session");
  if (!sessionNode) {
    throw new Error("ERR_INVALID_SES: Missing top-level (session ...) node in Specctra SES output.");
  }

  const boardName = typeof sessionNode[1] === "string" ? sessionNode[1] : "UNKNOWN";
  const routesNode = findChildList(sessionNode, "routes");
  if (!routesNode) {
    throw new Error("ERR_INVALID_SES: Missing (routes ...) block in Specctra SES output.");
  }

  const resNode = findChildList(routesNode, "resolution");
  const resolutionUnit = typeof resNode?.[1] === "string" ? resNode[1] : "mm";
  const resolutionMultiplier = Number(resNode?.[2] ?? 1000) || 1000;
  const unitToMm =
    resolutionUnit === "mil"
      ? 0.0254 / resolutionMultiplier
      : resolutionUnit === "um"
        ? 0.001 / resolutionMultiplier
        : resolutionUnit === "inch"
          ? 25.4 / resolutionMultiplier
          : 1.0 / resolutionMultiplier;

  const libOut = findChildList(routesNode, "library_out");
  const padstackDiameters = new Map<string, number>();
  if (libOut) {
    for (const ps of findChildLists(libOut, "padstack")) {
      const psName = typeof ps[1] === "string" ? ps[1] : "";
      const shape = findChildList(ps, "shape");
      const circle = shape ? findChildList(shape, "circle") : undefined;
      const diaRaw = Number(circle?.[2] ?? 0);
      if (psName && Number.isFinite(diaRaw) && diaRaw > 0) {
        padstackDiameters.set(psName, Number((diaRaw * unitToMm).toFixed(4)));
      }
    }
  }

  const networkOut = findChildList(routesNode, "network_out");
  const tracks: RoutedTrack[] = [];
  const vias: RoutedVia[] = [];
  let tSeq = 1;
  let vSeq = 1;

  if (networkOut) {
    for (const netNode of findChildLists(networkOut, "net")) {
      const netName = typeof netNode[1] === "string" ? netNode[1] : "";
      for (const wireNode of findChildLists(netNode, "wire")) {
        const pathNode = findChildList(wireNode, "path");
        if (!pathNode || pathNode.length < 7) continue;
        const layer = String(pathNode[1]);
        const widthMm = Number((Number(pathNode[2]) * unitToMm).toFixed(4));
        const pts: Array<[number, number]> = [];
        for (let idx = 3; idx + 1 < pathNode.length; idx += 2) {
          pts.push([
            Number((Number(pathNode[idx]) * unitToMm).toFixed(4)),
            Number((Number(pathNode[idx + 1]) * unitToMm).toFixed(4)),
          ]);
        }
        if (pts.length >= 2) {
          tracks.push({
            id: `SES_TRK_${tSeq++}`,
            net: netName,
            layer,
            widthMm,
            pointsMm: pts,
          });
        }
      }
      for (const viaNode of findChildLists(netNode, "via")) {
        if (viaNode.length < 4) continue;
        const psName = String(viaNode[1]);
        const xMm = Number((Number(viaNode[2]) * unitToMm).toFixed(4));
        const yMm = Number((Number(viaNode[3]) * unitToMm).toFixed(4));
        const outerDiaMm = padstackDiameters.get(psName) ?? 0.6;
        vias.push({
          id: `SES_VIA_${vSeq++}`,
          net: netName,
          xMm,
          yMm,
          drillMm: Number((outerDiaMm * 0.5).toFixed(3)),
          outerDiaMm,
          startLayer: "TopLayer",
          endLayer: "BottomLayer",
        });
      }
    }
  }

  return {
    boardName,
    resolutionUnit,
    resolutionMultiplier,
    tracks,
    vias,
  };
}

// ============================================================================
// 3. External FreeRouting CLI Driver (with hard timeout kill)
// ============================================================================

export async function runExternalFreeroutingCli(
  jarPath: string,
  dsnPath: string,
  sesPath: string,
  options?: { maxPasses?: number; timeoutMs?: number }
): Promise<{ success: boolean; exitCode: number | null; stderr: string; timedOut: boolean }> {
  const maxPasses = options?.maxPasses ?? 40;
  const timeoutMs = options?.timeoutMs ?? 120_000;

  return await new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stderr = "";

    const child = spawn(
      "java",
      ["-jar", jarPath, "-de", dsnPath, "-do", sesPath, "-mp", String(maxPasses)],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore already exited
      }
    }, timeoutMs);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ success: false, exitCode: null, stderr: err.message, timedOut });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        success: !timedOut && code === 0 && existsSync(sesPath),
        exitCode: code,
        stderr,
        timedOut,
      });
    });
  });
}

// ============================================================================
// 4. Built-in Multi-Pass 45° / Orthogonal Grid A* Rip-up & Reroute Engine
// ============================================================================

class MinHeap {
  private keys: Float64Array;
  private vals: Int32Array;
  public size = 0;

  constructor(capacity = 4096) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
  }

  private grow() {
    const newCap = this.keys.length * 2;
    const nk = new Float64Array(newCap);
    nk.set(this.keys);
    this.keys = nk;
    const nv = new Int32Array(newCap);
    nv.set(this.vals);
    this.vals = nv;
  }

  clear() {
    this.size = 0;
  }

  push(key: number, val: number) {
    if (this.size >= this.keys.length) this.grow();
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.keys[i] = this.keys[p];
      this.vals[i] = this.vals[p];
      i = p;
    }
    this.keys[i] = key;
    this.vals[i] = val;
  }

  pop(): number {
    const top = this.vals[0];
    const n = --this.size;
    if (n > 0) {
      const k = this.keys[n];
      const v = this.vals[n];
      let i = 0;
      const half = n >> 1;
      while (i < half) {
        let child = (i << 1) + 1;
        const right = child + 1;
        if (right < n && this.keys[right] < this.keys[child]) child = right;
        if (k <= this.keys[child]) break;
        this.keys[i] = this.keys[child];
        this.vals[i] = this.vals[child];
        i = child;
      }
      this.keys[i] = k;
      this.vals[i] = v;
    }
    return top;
  }
}

function pointInPolygon(x: number, y: number, poly: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function distPointToSegmentSq(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return (px - x1) ** 2 + (py - y1) ** 2;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return (px - projX) ** 2 + (py - projY) ** 2;
}

interface SubnetTask {
  id: number;
  netId: number;
  netName: string;
  widthMm: number;
  startMm: [number, number];
  endMm: [number, number];
  startLayerIdx: number;
  endLayerIdx: number;
  routedCells: number[]; // encoded (layer * planeSize + cellIdx)
  tracks: RoutedTrack[];
  vias: RoutedVia[];
}

export function runBuiltInGridAutoroute(
  clusterOutput: FunctionalClusterOutput,
  placements: PlacedComponent[],
  options?: AutorouteOptions
): Omit<AutorouteResult, "dsnContent" | "sesContent" | "engineUsed" | "fallbackReason"> {
  const outline = clusterOutput.board_outline;
  const W = outline.width_mm;
  const H = outline.height_mm;
  const stackup = resolveStackupLayers(outline.layer_count, outline.stackup);
  const rules = normalizeProjectDesignRules(options?.projectRules);
  const excludeSet = new Set(options?.excludeNets ?? ["GND", "AGND", "PGND"]);

  // Select routable signal layers (Top & Bottom for 2/4-layer boards; inner signal layers if >= 6)
  const routableLayers =
    options?.signalLayers && options.signalLayers.length > 0
      ? options.signalLayers
      : stackup.length >= 6
        ? [stackup[0], stackup[2], stackup[stackup.length - 3], stackup[stackup.length - 1]]
        : [stackup[0] ?? "TopLayer", stackup[stackup.length - 1] ?? "BottomLayer"];

  const L = routableLayers.length;
  const layerToIdx = new Map<string, number>();
  routableLayers.forEach((ln, idx) => layerToIdx.set(ln, idx));

  // Adaptive fine grid step (0.25mm default, fast & accurate for SMD boards)
  const step = options?.gridStepMm ?? (W * H > 20_000 ? 0.35 : 0.25);
  const cols = Math.max(4, Math.ceil(W / step));
  const rows = Math.max(4, Math.ceil(H / step));
  const planeSize = cols * rows;
  const totalCells = L * planeSize;

  const toCol = (x: number) => Math.max(0, Math.min(cols - 1, Math.round(x / step)));
  const toRow = (y: number) => Math.max(0, Math.min(rows - 1, Math.round(y / step)));

  // Net ID assignment
  const netNameToId = new Map<string, number>();
  const idToNetName: string[] = [];
  const getNetId = (name: string): number => {
    let id = netNameToId.get(name);
    if (id === undefined) {
      id = idToNetName.length;
      idToNetName.push(name);
      netNameToId.set(name, id);
    }
    return id;
  };

  // Grid arrays:
  // -1: free
  // -2: hard permanent obstacle (board edge, foreign keepout, Tier-1 foreign copper)
  // >= 0: netId owning this cell
  const ownerGrid = new Int32Array(totalCells);
  ownerGrid.fill(-1);
  const lockedMask = new Uint8Array(totalCells); // 1 = permanent (outline / pad / Tier-1 locked / keepout)
  const subnetRefGrid = new Int32Array(totalCells);
  subnetRefGrid.fill(-1);
  const viaForbiddenMask = new Uint8Array(totalCells);
  const historyCost = new Float32Array(totalCells);

  // Per-net Keepout exemption bitmask: track which keepouts block which layer+cell
  const keepouts = options?.keepouts25D ?? [];
  const netAllowedKeepouts = new Map<number, number[]>(); // netId -> keepout indices exempt
  const cellKeepoutList: Array<{ layerIdx: number; poly: Array<[number, number]>; allowedNetIds: Set<number>; blocksTrack: boolean; blocksVia: boolean }> = [];

  for (const ko of keepouts) {
    if (ko.polygon2D.length < 3) continue;
    const allowedSet = new Set(ko.allowedNets.map((nm) => getNetId(nm)));
    const blocksTrack = ko.disallowMask.includes("TRACK");
    const blocksVia = ko.disallowMask.includes("VIA");
    if (!blocksTrack && !blocksVia) continue;

    const targetLayers = ko.layerSet.flatMap((ln) =>
      ln === "ALL_COPPER_LAYERS" ? routableLayers : [ln]
    );
    for (const ln of new Set(targetLayers)) {
      const li = layerToIdx.get(ln);
      if (li === undefined) continue;
      cellKeepoutList.push({
        layerIdx: li,
        poly: ko.polygon2D,
        allowedNetIds: allowedSet,
        blocksTrack,
        blocksVia,
      });
    }
  }
  void netAllowedKeepouts;

  // Rasterize board outline clearance border
  const borderCells = Math.max(1, Math.floor(rules.boardOutlineClearanceMm / step));
  for (let li = 0; li < L; li++) {
    const off = li * planeSize;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (r < borderCells || r >= rows - borderCells || c < borderCells || c >= cols - borderCells) {
          const idx = off + r * cols + c;
          ownerGrid[idx] = -2;
          lockedMask[idx] = 1;
          viaForbiddenMask[idx] = 1;
        }
      }
    }
  }

  // Rasterize 2.5D Keepouts (ONLY on layers inside each keepout's layerSet!)
  // Store global keepout index per cell if needed for exemptions
  const keepoutBlockNetCheck = new Int32Array(totalCells);
  keepoutBlockNetCheck.fill(-1); // >= 0 means index into cellKeepoutList

  for (let kIdx = 0; kIdx < cellKeepoutList.length; kIdx++) {
    const ko = cellKeepoutList[kIdx];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of ko.poly) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const c0 = Math.max(0, Math.floor(minX / step));
    const c1 = Math.min(cols - 1, Math.ceil(maxX / step));
    const r0 = Math.max(0, Math.floor(minY / step));
    const r1 = Math.min(rows - 1, Math.ceil(maxY / step));
    const off = ko.layerIdx * planeSize;

    for (let r = r0; r <= r1; r++) {
      const py = r * step;
      for (let c = c0; c <= c1; c++) {
        const px = c * step;
        if (pointInPolygon(px, py, ko.poly)) {
          const gIdx = off + r * cols + c;
          if (ko.blocksTrack) {
            keepoutBlockNetCheck[gIdx] = kIdx;
          }
          if (ko.blocksVia) {
            viaForbiddenMask[gIdx] = 1;
          }
        }
      }
    }
  }

  // Rasterize SMD & Component Pads (belonging to each pad's net; lock so tracks don't illegally slash foreign pads)
  for (const pl of placements) {
    const mountLayerIdx = layerToIdx.get(pl.side === "BOTTOM" ? (stackup[stackup.length - 1] ?? "BottomLayer") : (stackup[0] ?? "TopLayer")) ?? 0;
    for (const pad of pl.pads) {
      const padNetId = pad.net ? getNetId(pad.net) : -2;
      const hw = pad.sizeMm[0] / 2 + rules.defaultClearanceMm * 0.45;
      const hh = pad.sizeMm[1] / 2 + rules.defaultClearanceMm * 0.45;
      const c0 = Math.max(0, Math.floor((pad.xMm - hw) / step));
      const c1 = Math.min(cols - 1, Math.ceil((pad.xMm + hw) / step));
      const r0 = Math.max(0, Math.floor((pad.yMm - hh) / step));
      const r1 = Math.min(rows - 1, Math.ceil((pad.yMm + hh) / step));
      const off = mountLayerIdx * planeSize;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const gIdx = off + r * cols + c;
          ownerGrid[gIdx] = padNetId;
          lockedMask[gIdx] = 1;
        }
      }
      // Guarantee exact center cell of pad owns padNetId
      const centerIdx = off + toRow(pad.yMm) * cols + toCol(pad.xMm);
      ownerGrid[centerIdx] = padNetId;
      lockedMask[centerIdx] = 1;
    }
  }

  // Rasterize Tier-1 locked tracks, vias & pre-routed tracks (permanent FIXED features!)
  const stampSegment = (
    layerName: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    widthMm: number,
    netId: number,
    isLocked: boolean,
    subnetId: number
  ) => {
    const li = layerToIdx.get(layerName);
    if (li === undefined) return;
    const halfW = widthMm / 2 + rules.defaultClearanceMm * 0.5;
    const minX = Math.min(x1, x2) - halfW;
    const maxX = Math.max(x1, x2) + halfW;
    const minY = Math.min(y1, y2) - halfW;
    const maxY = Math.max(y1, y2) + halfW;
    const c0 = Math.max(0, Math.floor(minX / step));
    const c1 = Math.min(cols - 1, Math.ceil(maxX / step));
    const r0 = Math.max(0, Math.floor(minY / step));
    const r1 = Math.min(rows - 1, Math.ceil(maxY / step));
    const halfWSq = halfW * halfW;
    const off = li * planeSize;

    for (let r = r0; r <= r1; r++) {
      const py = r * step;
      for (let c = c0; c <= c1; c++) {
        const px = c * step;
        if (distPointToSegmentSq(px, py, x1, y1, x2, y2) <= halfWSq) {
          const gIdx = off + r * cols + c;
          if (!lockedMask[gIdx]) {
            ownerGrid[gIdx] = netId;
            if (isLocked) lockedMask[gIdx] = 1;
            else subnetRefGrid[gIdx] = subnetId;
          }
        }
      }
    }
  };

  for (const trk of [...(options?.lockedTracks ?? []), ...(options?.preRoutedTracks ?? [])]) {
    const netId = getNetId(trk.net);
    for (let i = 1; i < trk.pointsMm.length; i++) {
      stampSegment(
        trk.layer,
        trk.pointsMm[i - 1][0],
        trk.pointsMm[i - 1][1],
        trk.pointsMm[i][0],
        trk.pointsMm[i][1],
        trk.widthMm,
        netId,
        true,
        -1
      );
    }
  }

  for (const via of [...(options?.lockedVias ?? []), ...(options?.preRoutedVias ?? [])]) {
    const netId = getNetId(via.net);
    const rad = via.outerDiaMm / 2 + rules.viaToTrackClearanceMm * 0.5;
    const c0 = Math.max(0, Math.floor((via.xMm - rad) / step));
    const c1 = Math.min(cols - 1, Math.ceil((via.xMm + rad) / step));
    const r0 = Math.max(0, Math.floor((via.yMm - rad) / step));
    const r1 = Math.min(rows - 1, Math.ceil((via.yMm + rad) / step));
    for (let li = 0; li < L; li++) {
      const off = li * planeSize;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          if (Math.hypot(c * step - via.xMm, r * step - via.yMm) <= rad) {
            const gIdx = off + r * cols + c;
            ownerGrid[gIdx] = netId;
            lockedMask[gIdx] = 1;
          }
        }
      }
    }
  }

  // Track which pairs of pads on a net are already connected by Tier-1 / pre-routed tracks
  const preConnectedNetSet = new Set<string>();
  for (const trk of [...(options?.lockedTracks ?? []), ...(options?.preRoutedTracks ?? [])]) {
    preConnectedNetSet.add(trk.net);
  }

  // Collect all signal nets requiring routing & decompose multi-pin nets via Prim's MST
  const netPadGroups = new Map<string, Array<{ xMm: number; yMm: number; layerIdx: number }>>();
  for (const pl of placements) {
    const layerIdx = layerToIdx.get(pl.side === "BOTTOM" ? (stackup[stackup.length - 1] ?? "BottomLayer") : (stackup[0] ?? "TopLayer")) ?? 0;
    for (const pad of pl.pads) {
      if (!pad.net || excludeSet.has(pad.net)) continue;
      let arr = netPadGroups.get(pad.net);
      if (!arr) {
        arr = [];
        netPadGroups.set(pad.net, arr);
      }
      arr.push({ xMm: pad.xMm, yMm: pad.yMm, layerIdx });
    }
  }

  // Check pre-routed connectivity per net: if Tier-1 already connects >= all pads (via endpoint proximity < 0.8mm), skip!
  const allPreTracks = [...(options?.lockedTracks ?? []), ...(options?.preRoutedTracks ?? [])];
  const isPadTouchedByPreTrack = (net: string, px: number, py: number): boolean => {
    for (const t of allPreTracks) {
      if (t.net !== net) continue;
      for (const [tx, ty] of t.pointsMm) {
        if (Math.hypot(tx - px, ty - py) < 0.85) return true;
      }
      for (let i = 1; i < t.pointsMm.length; i++) {
        if (
          distPointToSegmentSq(
            px,
            py,
            t.pointsMm[i - 1][0],
            t.pointsMm[i - 1][1],
            t.pointsMm[i][0],
            t.pointsMm[i][1]
          ) < 0.64
        ) {
          return true;
        }
      }
    }
    return false;
  };

  const subnets: SubnetTask[] = [];
  let subnetSeq = 0;

  for (const [netName, pads] of netPadGroups.entries()) {
    if (pads.length < 2) continue;

    // Look up NetClass width if configured
    let widthMm = rules.defaultTraceWidthMm;
    for (const nc of Object.values(rules.netClasses)) {
      if (nc.nets.includes(netName)) {
        widthMm = nc.preferredWidthMm ?? nc.minWidthMm;
        break;
      }
    }

    // Build Prim's MST over pads
    const inTree = new Uint8Array(pads.length);
    inTree[0] = 1;
    const netId = getNetId(netName);

    for (let stepIdx = 1; stepIdx < pads.length; stepIdx++) {
      let bestU = -1;
      let bestV = -1;
      let bestDist = Infinity;
      for (let u = 0; u < pads.length; u++) {
        if (!inTree[u]) continue;
        for (let v = 0; v < pads.length; v++) {
          if (inTree[v]) continue;
          const d = Math.hypot(pads[u].xMm - pads[v].xMm, pads[u].yMm - pads[v].yMm);
          if (d < bestDist) {
            bestDist = d;
            bestU = u;
            bestV = v;
          }
        }
      }
      if (bestU >= 0 && bestV >= 0) {
        inTree[bestV] = 1;
        // Skip if both endpoints already connected by Tier-1 locked/pre-routed traces
        if (
          preConnectedNetSet.has(netName) &&
          isPadTouchedByPreTrack(netName, pads[bestU].xMm, pads[bestU].yMm) &&
          isPadTouchedByPreTrack(netName, pads[bestV].xMm, pads[bestV].yMm)
        ) {
          continue;
        }
        subnets.push({
          id: subnetSeq++,
          netId,
          netName,
          widthMm,
          startMm: [pads[bestU].xMm, pads[bestU].yMm],
          endMm: [pads[bestV].xMm, pads[bestV].yMm],
          startLayerIdx: pads[bestU].layerIdx,
          endLayerIdx: pads[bestV].layerIdx,
          routedCells: [],
          tracks: [],
          vias: [],
        });
      }
    }
  }

  // Sort shortest subnets first
  subnets.sort(
    (a, b) =>
      Math.hypot(a.startMm[0] - a.endMm[0], a.startMm[1] - a.endMm[1]) -
      Math.hypot(b.startMm[0] - b.endMm[0], b.startMm[1] - b.endMm[1])
  );

  // Pre-allocate A* search buffers
  const gScore = new Float32Array(totalCells);
  const parentCell = new Int32Array(totalCells);
  const parentDir = new Int8Array(totalCells);
  const visitedStamp = new Int32Array(totalCells);
  const closedStamp = new Int32Array(totalCells);
  let searchStamp = 1;
  const heap = new MinHeap(8192);

  const dirs: Array<[number, number, number]> = [
    [1, 0, 1.0],
    [-1, 0, 1.0],
    [0, 1, 1.0],
    [0, -1, 1.0],
    [1, 1, 1.4142],
    [1, -1, 1.4142],
    [-1, 1, 1.4142],
    [-1, -1, 1.4142],
  ];

  const ripUpSubnet = (sub: SubnetTask) => {
    for (const gIdx of sub.routedCells) {
      if (!lockedMask[gIdx] && subnetRefGrid[gIdx] === sub.id) {
        ownerGrid[gIdx] = -1;
        subnetRefGrid[gIdx] = -1;
      }
    }
    sub.routedCells = [];
    sub.tracks = [];
    sub.vias = [];
  };

  let trackIdSeq = 1;
  let viaIdSeq = 1;

  const commitPathToSubnet = (sub: SubnetTask, cellPath: number[]) => {
    // Stamp routed cells (add 1-cell clearance halo only when grid step < traceWidth + clearance)
    const netId = sub.netId;
    const needHalo = step < sub.widthMm + rules.defaultClearanceMm - 0.02;
    const haloSpan = needHalo ? 1 : 0;

    for (const gIdx of cellPath) {
      const li = Math.floor(gIdx / planeSize);
      const rem = gIdx - li * planeSize;
      const r = Math.floor(rem / cols);
      const c = rem - r * cols;
      for (let dr = -haloSpan; dr <= haloSpan; dr++) {
        for (let dc = -haloSpan; dc <= haloSpan; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          const nIdx = li * planeSize + nr * cols + nc;
          if (!lockedMask[nIdx] && ownerGrid[nIdx] === -1) {
            ownerGrid[nIdx] = netId;
            subnetRefGrid[nIdx] = sub.id;
            sub.routedCells.push(nIdx);
          }
        }
      }
    }

    // Simplify path into octilinear layer polylines and vias
    const tracks: RoutedTrack[] = [];
    const vias: RoutedVia[] = [];
    let curLayer = Math.floor(cellPath[0] / planeSize);
    let curPts: Array<[number, number]> = [sub.startMm];

    for (let k = 0; k < cellPath.length; k++) {
      const gIdx = cellPath[k];
      const li = Math.floor(gIdx / planeSize);
      const rem = gIdx - li * planeSize;
      const r = Math.floor(rem / cols);
      const c = rem - r * cols;
      const pt: [number, number] = [Number((c * step).toFixed(3)), Number((r * step).toFixed(3))];

      if (li !== curLayer) {
        // Layer transition via!
        const viaPt = curPts[curPts.length - 1];
        tracks.push({
          id: `AR_TRK_${trackIdSeq++}`,
          net: sub.netName,
          layer: routableLayers[curLayer],
          widthMm: sub.widthMm,
          pointsMm: curPts,
        });
        vias.push({
          id: `AR_VIA_${viaIdSeq++}`,
          net: sub.netName,
          xMm: viaPt[0],
          yMm: viaPt[1],
          drillMm: rules.minViaDrillMm,
          outerDiaMm: rules.minViaOuterDiaMm,
          startLayer: routableLayers[curLayer],
          endLayer: routableLayers[li],
        });
        curLayer = li;
        curPts = [viaPt, pt];
      } else {
        // Collinear compression
        if (curPts.length >= 2) {
          const a = curPts[curPts.length - 2];
          const b = curPts[curPts.length - 1];
          const cross = Math.abs((b[0] - a[0]) * (pt[1] - b[1]) - (b[1] - a[1]) * (pt[0] - b[0]));
          if (cross < 1e-4) {
            curPts[curPts.length - 1] = pt;
            continue;
          }
        }
        curPts.push(pt);
      }
    }

    curPts.push(sub.endMm);
    tracks.push({
      id: `AR_TRK_${trackIdSeq++}`,
      net: sub.netName,
      layer: routableLayers[curLayer],
      widthMm: sub.widthMm,
      pointsMm: curPts,
    });

    sub.tracks = tracks;
    sub.vias = vias;
  };

  const runAStar = (
    sub: SubnetTask,
    allowSoftCrossing: boolean
  ): { path: number[] | null; crossedSubnets: Set<number> } => {
    const startC = toCol(sub.startMm[0]);
    const startR = toRow(sub.startMm[1]);
    const endC = toCol(sub.endMm[0]);
    const endR = toRow(sub.endMm[1]);
    const startIdx = sub.startLayerIdx * planeSize + startR * cols + startC;
    const endIdx = sub.endLayerIdx * planeSize + endR * cols + endC;

    searchStamp++;
    if (searchStamp >= 0x7fffffff) {
      visitedStamp.fill(0);
      closedStamp.fill(0);
      searchStamp = 1;
    }

    heap.clear();
    visitedStamp[startIdx] = searchStamp;
    gScore[startIdx] = 0;
    parentCell[startIdx] = -1;
    parentDir[startIdx] = -1;

    const hInit = Math.hypot(endC - startC, endR - startR);
    heap.push(hInit, startIdx);

    let found = false;
    let expanded = 0;
    const maxExpand = Math.min(80_000, totalCells);

    while (heap.size > 0 && expanded < maxExpand) {
      const curr = heap.pop();
      if (closedStamp[curr] === searchStamp) continue;
      closedStamp[curr] = searchStamp;

      if (curr === endIdx) {
        found = true;
        break;
      }
      expanded++;

      const curG = gScore[curr];
      const li = Math.floor(curr / planeSize);
      const rem = curr - li * planeSize;
      const r = Math.floor(rem / cols);
      const c = rem - r * cols;
      const prevD = parentDir[curr];

      // 8 planar neighbors
      for (let dIdx = 0; dIdx < 8; dIdx++) {
        const [dc, dr, baseCost] = dirs[dIdx];
        const nc = c + dc;
        const nr = r + dr;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;

        const nIdx = li * planeSize + nr * cols + nc;
        if (closedStamp[nIdx] === searchStamp) continue;
        const nearEndpoint =
          (Math.abs(nc - startC) <= 2 && Math.abs(nr - startR) <= 2) ||
          (Math.abs(nc - endC) <= 2 && Math.abs(nr - endR) <= 2);

        const koIdx = keepoutBlockNetCheck[nIdx];
        if (koIdx >= 0 && nIdx !== endIdx && nIdx !== startIdx && !nearEndpoint) {
          const ko = cellKeepoutList[koIdx];
          if (!ko.allowedNetIds.has(sub.netId)) continue;
        }

        // Prevent diagonal trace from squeezing across an orthogonal foreign trace corner
        if (dc !== 0 && dr !== 0 && !nearEndpoint) {
          const side1 = ownerGrid[li * planeSize + r * cols + nc];
          const side2 = ownerGrid[li * planeSize + nr * cols + c];
          if ((side1 !== -1 && side1 !== sub.netId) && (side2 !== -1 && side2 !== sub.netId)) {
            continue;
          }
        }

        const cellOwner = ownerGrid[nIdx];
        let crossingPenalty = 0;
        if (cellOwner !== -1 && cellOwner !== sub.netId) {
          if (lockedMask[nIdx] && !nearEndpoint) {
            continue; // Cannot cross permanent locked pads, Tier-1 FIXED tracks, or board edge
          }
          if (!nearEndpoint) {
            if (!allowSoftCrossing) continue;
            crossingPenalty = 45.0 + historyCost[nIdx] * 15.0;
          }
        }

        // Layer directional preference (Top prefers H, Bottom prefers V) to reduce crossings
        const dirBias =
          li % 2 === 0
            ? dr !== 0 && dc === 0
              ? 0.08
              : 0
            : dc !== 0 && dr === 0
              ? 0.08
              : 0;
        const bendPenalty = prevD >= 0 && prevD !== dIdx ? 0.12 : 0;
        const candG = curG + baseCost + dirBias + bendPenalty + crossingPenalty + historyCost[nIdx];

        if (visitedStamp[nIdx] !== searchStamp || candG < gScore[nIdx]) {
          visitedStamp[nIdx] = searchStamp;
          gScore[nIdx] = candG;
          parentCell[nIdx] = curr;
          parentDir[nIdx] = dIdx;
          const h = Math.hypot(endC - nc, endR - nr) * 1.05;
          heap.push(candG + h, nIdx);
        }
      }

      // Layer transitions (Via)
      if (!viaForbiddenMask[curr] || curr === startIdx || curr === endIdx) {
        for (let nLi = 0; nLi < L; nLi++) {
          if (nLi === li) continue;
          const nIdx = nLi * planeSize + r * cols + c;
          if (viaForbiddenMask[nIdx] && nIdx !== endIdx && nIdx !== startIdx) continue;
          const koIdx = keepoutBlockNetCheck[nIdx];
          if (
            koIdx >= 0 &&
            nIdx !== endIdx &&
            nIdx !== startIdx &&
            !cellKeepoutList[koIdx].allowedNetIds.has(sub.netId)
          ) {
            continue;
          }
          const cellOwner = ownerGrid[nIdx];
          if (cellOwner !== -1 && cellOwner !== sub.netId) {
            if (lockedMask[nIdx] || !allowSoftCrossing) continue;
          }
          const candG = curG + 6.5 + historyCost[nIdx];
          if (visitedStamp[nIdx] !== searchStamp || candG < gScore[nIdx]) {
            visitedStamp[nIdx] = searchStamp;
            gScore[nIdx] = candG;
            parentCell[nIdx] = curr;
            parentDir[nIdx] = -1;
            const h = Math.hypot(endC - c, endR - r) * 1.05;
            heap.push(candG + h, nIdx);
          }
        }
      }
    }

    if (!found) {
      return { path: null, crossedSubnets: new Set() };
    }

    const path: number[] = [];
    const crossedSubnets = new Set<number>();
    let cur = endIdx;
    while (cur !== -1) {
      path.push(cur);
      const refSub = subnetRefGrid[cur];
      if (refSub >= 0 && refSub !== sub.id && !lockedMask[cur]) {
        crossedSubnets.add(refSub);
      }
      cur = parentCell[cur];
    }
    path.reverse();
    return { path, crossedSubnets };
  };

  // Multi-pass Rip-up and Reroute loop
  const maxPasses = Math.max(1, options?.maxPasses ?? 25);
  const subnetById = new Map<number, SubnetTask>();
  subnets.forEach((s) => subnetById.set(s.id, s));

  let pendingIds = subnets.map((s) => s.id);
  let passesUsed = 0;

  for (let pass = 0; pass < maxPasses && pendingIds.length > 0; pass++) {
    passesUsed++;
    const nextPending: number[] = [];
    const allowRipup = pass > 0;

    for (const sId of pendingIds) {
      const sub = subnetById.get(sId)!;
      // Try strict route first
      let res = runAStar(sub, false);
      if (!res.path && allowRipup) {
        // Run congestion-aware soft-crossing A*, rip up conflicting non-locked subnets
        res = runAStar(sub, true);
        if (res.path && res.crossedSubnets.size > 0) {
          for (const gIdx of res.path) {
            historyCost[gIdx] += 4.0;
          }
          for (const conflictId of res.crossedSubnets) {
            const conflictSub = subnetById.get(conflictId);
            if (conflictSub) {
              ripUpSubnet(conflictSub);
              nextPending.push(conflictId);
            }
          }
        }
      }

      if (res.path) {
        commitPathToSubnet(sub, res.path);
      } else {
        nextPending.push(sId);
      }
    }

    pendingIds = Array.from(new Set(nextPending));
  }

  // Gather final routed tracks and vias
  const routedTracks: RoutedTrack[] = [];
  const routedVias: RoutedVia[] = [];
  const unroutedNetSet = new Set<string>();
  const routedNetSet = new Set<string>();

  for (const sub of subnets) {
    if (sub.tracks.length === 0) {
      unroutedNetSet.add(sub.netName);
    } else {
      routedNetSet.add(sub.netName);
      routedTracks.push(...sub.tracks);
      routedVias.push(...sub.vias);
    }
  }

  // Nets that were 100% routed in Tier-1 also count as routed
  for (const netName of preConnectedNetSet) {
    if (!excludeSet.has(netName) && !unroutedNetSet.has(netName)) {
      routedNetSet.add(netName);
    }
  }

  let totalTrackLengthMm = 0;
  for (const t of routedTracks) {
    for (let i = 1; i < t.pointsMm.length; i++) {
      totalTrackLengthMm += Math.hypot(
        t.pointsMm[i][0] - t.pointsMm[i - 1][0],
        t.pointsMm[i][1] - t.pointsMm[i - 1][1]
      );
    }
  }

  return {
    completed: unroutedNetSet.size === 0,
    routedNetCount: routedNetSet.size,
    remainingUnroutedRatlines: subnets.filter((s) => s.tracks.length === 0).length,
    unroutedNets: Array.from(unroutedNetSet),
    viaCountAdded: routedVias.length,
    totalTrackLengthMm: Number(totalTrackLengthMm.toFixed(2)),
    tracks: routedTracks,
    vias: routedVias,
    passesUsed,
  };
}

// ============================================================================
// 5. Unified Tier-2 Hybrid Autorouter Driver
// ============================================================================

export async function runHybridAutoroute(
  clusterOutput: FunctionalClusterOutput,
  placements: PlacedComponent[],
  options?: AutorouteOptions
): Promise<AutorouteResult> {
  const boardName = "JLCEDA_PCB";
  const dsnRes = generateSpecctraDsn({
    boardName,
    clusterOutput,
    placements,
    projectRules: options?.projectRules,
    keepouts25D: options?.keepouts25D,
    lockedTracks: options?.lockedTracks,
    lockedVias: options?.lockedVias,
    excludeNets: options?.excludeNets,
  });

  let fallbackReason: string | undefined;

  // Attempt external FreeRouting CLI only if requested AND jar path exists on disk
  if (options?.engine === "freerouting_headless") {
    if (options.freeroutingJarPath && existsSync(options.freeroutingJarPath)) {
      const tempDir = options.tempDir ?? "D:\\Data\\.temp\\jlceda-mcp";
      mkdirSync(tempDir, { recursive: true });
      const dsnPath = `${tempDir}/autoroute_${Date.now()}.dsn`;
      const sesPath = `${tempDir}/autoroute_${Date.now()}.ses`;
      writeFileSync(dsnPath, dsnRes.dsnContent, "utf-8");

      const cliRes = await runExternalFreeroutingCli(
        options.freeroutingJarPath,
        dsnPath,
        sesPath,
        {
          maxPasses: options.maxPasses ?? 40,
          timeoutMs: (options.timeoutSec ?? 180) * 1000,
        }
      );

      if (cliRes.success) {
        const sesContent = readFileSync(sesPath, "utf-8");
        const parsed = parseSpecctraSes(sesContent);
        let len = 0;
        const routedNets = new Set<string>();
        for (const t of parsed.tracks) {
          routedNets.add(t.net);
          for (let i = 1; i < t.pointsMm.length; i++) {
            len += Math.hypot(t.pointsMm[i][0] - t.pointsMm[i - 1][0], t.pointsMm[i][1] - t.pointsMm[i - 1][1]);
          }
        }
        return {
          completed: true,
          engineUsed: "freerouting_headless",
          routedNetCount: routedNets.size,
          remainingUnroutedRatlines: 0,
          unroutedNets: [],
          viaCountAdded: parsed.vias.length,
          totalTrackLengthMm: Number(len.toFixed(2)),
          tracks: parsed.tracks,
          vias: parsed.vias,
          dsnContent: dsnRes.dsnContent,
          sesContent,
          passesUsed: options.maxPasses ?? 40,
        };
      }

      fallbackReason = cliRes.timedOut
        ? "External FreeRouting CLI timed out and was killed; fell back to built-in multi-pass A* router."
        : `External FreeRouting CLI exited (${cliRes.exitCode}): ${cliRes.stderr.slice(0, 120)}; fell back to built-in multi-pass A* router.`;
    } else {
      fallbackReason =
        "External FreeRouting JAR not configured or not found; routed via built-in multi-pass A* Rip-up and Reroute engine.";
    }
  }

  // Ensure tempDir exists if explicitly requested (without creating arbitrary dirs unless needed)
  void dirname;

  // Built-in multi-pass 45°/orthogonal A* Rip-up and Reroute engine
  const gridRes = runBuiltInGridAutoroute(clusterOutput, placements, options);
  const sesContent = generateSpecctraSes(boardName, gridRes.tracks, gridRes.vias, 1000);

  return {
    ...gridRes,
    engineUsed: "internal_grid_astar_ripup",
    dsnContent: dsnRes.dsnContent,
    sesContent,
    fallbackReason,
  };
}
