import { Clipper, FillRule, Point64, type Path64, type Paths64 } from "clipper2-js";
import type {
  CesmModel,
  CompiledNetlist,
  ConstraintHandoffPackage,
  FunctionalClusterOutput,
  Keepout25DFiveTuple,
  KeepoutDisallowKind,
  NetClassRule,
  PcbLintReport,
  PlintFinding,
  ProjectDesignRules,
} from "../types/index.js";
import {
  buildElectricalHypergraph,
  type CesmResolver,
  type ElectricalHypergraph,
  getPackageWorkingMaxV,
  isGroundNetName,
  normalizePackageCode,
  parseResistanceOhms,
} from "./hypergraph-propagator.js";
import { createBuiltInCesmResolver } from "./electrical-linter.js";

const CLIPPER_SCALE = 10_000; // 0.1 um integer grid

export interface PcbPadGeom {
  primitiveId: string;
  designator: string;
  padNumber: string;
  pinName?: string;
  elecType?: string;
  net: string | null;
  layer: string;
  centerMm: [number, number];
  sizeMm: [number, number];
  shape?: "RECT" | "CIRCLE" | "OVAL" | "ROUNDRECT" | string;
  drillMm?: number;
  copperConnection?: "THERMAL_RELIEF" | "DIRECT_CONNECT" | "NONE";
  spokeCount?: number;
  spokeWidthMm?: number;
  isEpad?: boolean;
  isGrounded?: boolean;
}

export interface PcbComponentGeom {
  primitiveId: string;
  designator: string;
  lcscId?: string | null;
  mpn?: string | null;
  value?: string | null;
  package: string;
  category?: CesmModel["category"];
  layer: string;
  centerMm: [number, number];
  rotationDeg: number;
  bboxMm: [number, number, number, number]; // [minX, minY, maxX, maxY]
  heightMm?: number;
  pads: PcbPadGeom[];
  frontOperationZoneMm?: [number, number, number, number];
  frontClearanceMm?: number;
  expectedPolarityAngleDeg?: number;
  polarityAngleDeg?: number;
  originAnchorType?: "CENTER" | "PIN1" | "INVALID";
  softTermination?: boolean;
  sensorType?: "TEMP_HUMIDITY" | "MEMS" | "VREF" | "HALL_MAG";
  thermalPowerW?: number;
  extraProps?: Record<string, unknown>;
}

export interface PcbTrackGeom {
  primitiveId: string;
  net: string;
  layer: string;
  startMm: [number, number];
  endMm: [number, number];
  widthMm: number;
  isLocked?: boolean;
  isSerpentine?: boolean;
}

export interface PcbViaGeom {
  primitiveId: string;
  net: string;
  centerMm: [number, number];
  drillMm: number;
  outerDiaMm: number;
  startLayer?: string;
  endLayer?: string;
  purpose?:
    | "SIGNAL"
    | "POWER_TRANSITION"
    | "THERMAL_EPAD"
    | "BLIND_THERMAL_ON_POWER"
    | "GND_STITCH"
    | "RETURN_VIA";
}

export interface PcbPourGeom {
  primitiveId: string;
  net: string;
  layer: string;
  polygon2D: Array<[number, number]>;
  holes2D?: Array<Array<[number, number]>>;
  areaMm2?: number;
  isSolid?: boolean;
  splitSlots?: Array<{ x1: number; y1: number; x2: number; y2: number }>;
}

export interface PcbMountingHoleGeom {
  id: string;
  size?: "M2" | "M2.5" | "M3" | "M4" | string;
  centerMm: [number, number];
  drillMm: number;
  keepoutDiaMm?: number;
  isGrounded?: boolean;
}

export interface PcbTestPointGeom {
  id: string;
  net: string;
  layer: string;
  centerMm: [number, number];
  diameterMm: number;
}

export interface PcbIsolationSlotGeom {
  id?: string;
  polygon2D: Array<[number, number]>;
  widthMm: number;
}

export interface PcbNativeDrcInput {
  unroutedRatlineCount: number;
  errors: Array<{
    code?: string;
    message: string;
    layer?: string;
    locationMm?: [number, number];
    primitives?: string[];
  }>;
}

export interface PcbBoardGeometrySnapshot {
  pcbDocument: string;
  boardOutline: {
    widthMm: number;
    heightMm: number;
    layerCount: number;
    copperWeightOuterOz?: number;
    stackup?: string[];
    polygonMm?: Array<[number, number]>;
    vCutLines?: Array<{ x1: number; y1: number; x2: number; y2: number }>;
    mouseBites?: Array<{ xMm: number; yMm: number; radiusMm: number }>;
    isolationSlots?: PcbIsolationSlotGeom[];
  };
  projectDesignRules?: ProjectDesignRules;
  components: PcbComponentGeom[];
  tracks: PcbTrackGeom[];
  vias: PcbViaGeom[];
  pours: PcbPourGeom[];
  keepoutZones?: Keepout25DFiveTuple[];
  mountingHoles?: PcbMountingHoleGeom[];
  testPoints?: PcbTestPointGeom[];
  nativeDrcResult?: PcbNativeDrcInput;
  netlist?: CompiledNetlist;
  clusters?: FunctionalClusterOutput;
  constraintHandoff?: ConstraintHandoffPackage;
  cesmResolver?: CesmResolver;
  options?: {
    checkScope?: "full_board" | "selection_neighborhood";
    selectedDesignators?: string[];
    useProjectDesignRulesFirst?: boolean;
    fabCapability?: "jlc_standard_multi" | "jlc_2layer_basic";
    ambientTempC?: number;
  };
}

// ============================================================================
// Design Rules Merging (Project DRC First + Physical Fallback)
// ============================================================================

export function buildEffectiveDesignRules(
  projectRules: ProjectDesignRules | undefined,
  useProjectFirst: boolean,
  fabCapability: "jlc_standard_multi" | "jlc_2layer_basic",
  copperOz: number
): ProjectDesignRules {
  const baselineMinTrace = copperOz >= 2.0 ? 0.2 : fabCapability === "jlc_2layer_basic" ? 0.15 : 0.127;
  const baselineClearance = copperOz >= 2.0 ? 0.2 : 0.15;

  const fallback: ProjectDesignRules = {
    source: "MCP_DEFAULT_BASELINE",
    defaultTraceWidthMm: baselineMinTrace,
    defaultClearanceMm: baselineClearance,
    padToPadClearanceMm: baselineClearance,
    viaToTrackClearanceMm: baselineClearance,
    pourClearanceMm: 0.25,
    componentClearanceMm: 0.25,
    boardOutlineClearanceMm: 0.35,
    minViaDrillMm: 0.3,
    minViaOuterDiaMm: 0.45,
    minSilkToPadClearanceMm: 0.15,
    copperWeightOuterOz: copperOz,
    netClasses: {},
  };

  if (!projectRules || !useProjectFirst) {
    return fallback;
  }

  return {
    source: projectRules.source === "JLC_PROJECT_DRC_ONLY" ? "JLC_PROJECT_DRC_MERGED" : projectRules.source,
    defaultTraceWidthMm: projectRules.defaultTraceWidthMm || fallback.defaultTraceWidthMm,
    defaultClearanceMm: projectRules.defaultClearanceMm || fallback.defaultClearanceMm,
    padToPadClearanceMm: projectRules.padToPadClearanceMm || fallback.padToPadClearanceMm,
    viaToTrackClearanceMm: projectRules.viaToTrackClearanceMm || fallback.viaToTrackClearanceMm,
    pourClearanceMm: projectRules.pourClearanceMm || fallback.pourClearanceMm,
    componentClearanceMm: projectRules.componentClearanceMm || fallback.componentClearanceMm,
    boardOutlineClearanceMm: projectRules.boardOutlineClearanceMm || fallback.boardOutlineClearanceMm,
    minViaDrillMm: projectRules.minViaDrillMm || fallback.minViaDrillMm,
    minViaOuterDiaMm: projectRules.minViaOuterDiaMm || fallback.minViaOuterDiaMm,
    minSilkToPadClearanceMm: projectRules.minSilkToPadClearanceMm || fallback.minSilkToPadClearanceMm,
    copperWeightOuterOz: projectRules.copperWeightOuterOz || fallback.copperWeightOuterOz,
    netClasses: { ...projectRules.netClasses },
  };
}

// ============================================================================
// Layer Resolution & 2.5D Clipper2 Geometry Helpers
// ============================================================================

export function normalizeLayerName(layer: string): string {
  const u = layer.trim().toLowerCase();
  if (u === "toplayer" || u === "top" || u === "f.cu" || u === "gtl") return "TopLayer";
  if (u === "bottomlayer" || u === "bottom" || u === "bot" || u === "b.cu" || u === "gbl") return "BottomLayer";
  if (u === "multilayer" || u === "multi") return "MultiLayer";
  if (u === "innerlayer1" || u === "inner1" || u === "in1.cu" || u === "innerlayer1_gnd") return "InnerLayer1";
  if (u === "innerlayer2" || u === "inner2" || u === "in2.cu" || u === "innerlayer2_pwr") return "InnerLayer2";
  if (u === "innerlayer3" || u === "inner3" || u === "in3.cu") return "InnerLayer3";
  if (u === "innerlayer4" || u === "inner4" || u === "in4.cu") return "InnerLayer4";
  return layer;
}

function getNormalizedStackup(board: PcbBoardGeometrySnapshot): string[] {
  if (board.boardOutline.stackup && board.boardOutline.stackup.length > 0) {
    return board.boardOutline.stackup.map(normalizeLayerName);
  }
  const n = Math.max(2, board.boardOutline.layerCount);
  if (n === 2) return ["TopLayer", "BottomLayer"];
  const inner: string[] = [];
  for (let i = 1; i <= n - 2; i++) inner.push(`InnerLayer${i}`);
  return ["TopLayer", ...inner, "BottomLayer"];
}

export function resolveKeepoutLayers(
  keepout: Keepout25DFiveTuple,
  stackup: string[]
): Set<string> {
  const resolved = new Set<string>();
  const top = stackup[0] ?? "TopLayer";
  const bottom = stackup[stackup.length - 1] ?? "BottomLayer";
  const isBottom = keepout.mountSide === "BOTTOM";
  const mountLayer = isBottom ? bottom : top;
  const adjacentLayer =
    stackup.length >= 4 ? (isBottom ? stackup[stackup.length - 2] : stackup[1]) : isBottom ? top : bottom;
  const oppositeLayer = isBottom ? top : bottom;

  for (const raw of keepout.layerSet) {
    const u = raw.toUpperCase();
    if (u === "ALL_COPPER_LAYERS" || u === "ALL") {
      for (const l of stackup) resolved.add(l);
    } else if (u === "MOUNT_LAYER") {
      resolved.add(mountLayer);
    } else if (u === "ADJACENT_REF_LAYER") {
      resolved.add(adjacentLayer);
    } else if (u === "OPPOSITE_LAYER") {
      resolved.add(oppositeLayer);
    } else {
      resolved.add(normalizeLayerName(raw));
    }
  }
  return resolved;
}

function resolvePrimitiveLayers(
  layer: string,
  stackup: string[],
  startLayer?: string,
  endLayer?: string
): Set<string> {
  const norm = normalizeLayerName(layer);
  if (norm === "MultiLayer") {
    if (startLayer && endLayer) {
      const sIdx = stackup.indexOf(normalizeLayerName(startLayer));
      const eIdx = stackup.indexOf(normalizeLayerName(endLayer));
      if (sIdx >= 0 && eIdx >= 0) {
        const lo = Math.min(sIdx, eIdx);
        const hi = Math.max(sIdx, eIdx);
        return new Set(stackup.slice(lo, hi + 1));
      }
    }
    return new Set(stackup);
  }
  return new Set([norm]);
}

function toPath64(poly: Array<[number, number]>): Path64 {
  return poly.map(([x, y]) => new Point64(Math.round(x * CLIPPER_SCALE), Math.round(y * CLIPPER_SCALE)));
}

function rectToPoly(minX: number, minY: number, maxX: number, maxY: number): Array<[number, number]> {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
}

function circleToPoly(cx: number, cy: number, radius: number, segments = 16): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    pts.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }
  return pts;
}

function trackToPoly(start: [number, number], end: [number, number], width: number): Array<[number, number]> {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const len = Math.hypot(dx, dy);
  const hw = Math.max(0.01, width / 2);
  if (len < 1e-6) {
    return circleToPoly(start[0], start[1], hw, 12);
  }
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy * hw;
  const ny = ux * hw;
  // Extend ends slightly by hw (round/square endcap envelope)
  const sx = start[0] - ux * hw;
  const sy = start[1] - uy * hw;
  const ex = end[0] + ux * hw;
  const ey = end[1] + uy * hw;
  return [
    [sx + nx, sy + ny],
    [ex + nx, ey + ny],
    [ex - nx, ey - ny],
    [sx - nx, sy - ny],
  ];
}

export function computePolygonOverlapAreaMm2(
  polyA: Array<[number, number]>,
  polyB: Array<[number, number]>
): number {
  if (polyA.length < 3 || polyB.length < 3) return 0;
  const res = Clipper.Intersect([toPath64(polyA)], [toPath64(polyB)], FillRule.EvenOdd);
  if (res.length === 0) return 0;
  return Math.abs(Clipper.areaPaths(res)) / (CLIPPER_SCALE * CLIPPER_SCALE);
}

export function computePolygonAreaMm2(poly: Array<[number, number]>): number {
  if (poly.length < 3) return 0;
  return Math.abs(Clipper.area(toPath64(poly))) / (CLIPPER_SCALE * CLIPPER_SCALE);
}

function ensurePositivePath64(poly: Array<[number, number]>): Path64 {
  const path = toPath64(poly);
  return Clipper.isPositive(path) ? path : Clipper.reversePath(path);
}

function buildPourPaths64(pour: PcbPourGeom): Paths64 {
  if (pour.polygon2D.length < 3) return [];
  const outer: Paths64 = [ensurePositivePath64(pour.polygon2D)];
  const validHoles = (pour.holes2D ?? []).filter((h) => h.length >= 3);
  if (validHoles.length === 0) return outer;
  const holePaths: Paths64 = validHoles.map(ensurePositivePath64);
  return Clipper.Difference(outer, holePaths, FillRule.NonZero);
}

function computePourNetAreaMm2(pour: PcbPourGeom): number {
  const hasHoles = Boolean(pour.holes2D && pour.holes2D.some((h) => h.length >= 3));
  if (!hasHoles && pour.areaMm2 !== undefined) return pour.areaMm2;
  if (pour.polygon2D.length < 3) return pour.areaMm2 ?? 0;
  const paths = buildPourPaths64(pour);
  if (paths.length === 0) return 0;
  return Math.abs(Clipper.areaPaths(paths)) / (CLIPPER_SCALE * CLIPPER_SCALE);
}

function computePourOverlapAreaMm2(
  pour: PcbPourGeom,
  targetPoly: Array<[number, number]>
): number {
  if (pour.polygon2D.length < 3 || targetPoly.length < 3) return 0;
  const hasHoles = Boolean(pour.holes2D && pour.holes2D.some((h) => h.length >= 3));
  if (!hasHoles) {
    return computePolygonOverlapAreaMm2(pour.polygon2D, targetPoly);
  }
  const subjectPaths = buildPourPaths64(pour);
  if (subjectPaths.length === 0) return 0;
  const res = Clipper.Intersect(
    subjectPaths,
    [ensurePositivePath64(targetPoly)],
    FillRule.NonZero
  );
  if (res.length === 0) return 0;
  return Math.abs(Clipper.areaPaths(res)) / (CLIPPER_SCALE * CLIPPER_SCALE);
}

function isPointInPour2D(pt: [number, number], pour: PcbPourGeom): boolean {
  if (!pointInPolygon2D(pt, pour.polygon2D)) return false;
  if (pour.holes2D && pour.holes2D.length > 0) {
    for (const hole of pour.holes2D) {
      if (hole.length >= 3 && pointInPolygon2D(pt, hole)) {
        return false;
      }
    }
  }
  return true;
}

function distPoints(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function distPointToRect(pt: [number, number], rect: [number, number, number, number]): number {
  const cx = Math.max(rect[0], Math.min(pt[0], rect[2]));
  const cy = Math.max(rect[1], Math.min(pt[1], rect[3]));
  return Math.hypot(pt[0] - cx, pt[1] - cy);
}

function distPointToSegment(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1e-12) return distPoints(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / lenSq));
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}

function segmentsDistance(
  a1: [number, number],
  a2: [number, number],
  b1: [number, number],
  b2: [number, number]
): number {
  if (segmentsIntersect2D(a1, a2, b1, b2)) return 0;
  return Math.min(
    distPointToSegment(a1, b1, b2),
    distPointToSegment(a2, b1, b2),
    distPointToSegment(b1, a1, a2),
    distPointToSegment(b2, a1, a2)
  );
}

function segmentsIntersect2D(
  a1: [number, number],
  a2: [number, number],
  b1: [number, number],
  b2: [number, number]
): boolean {
  const ccw = (p1: [number, number], p2: [number, number], p3: [number, number]) =>
    (p3[1] - p1[1]) * (p2[0] - p1[0]) > (p2[1] - p1[1]) * (p3[0] - p1[0]);
  const onSeg = (p: [number, number], q: [number, number], r: [number, number]) =>
    q[0] <= Math.max(p[0], r[0]) + 1e-9 &&
    q[0] >= Math.min(p[0], r[0]) - 1e-9 &&
    q[1] <= Math.max(p[1], r[1]) + 1e-9 &&
    q[1] >= Math.min(p[1], r[1]) - 1e-9;
  const o1 = (a2[0] - a1[0]) * (b1[1] - a1[1]) - (a2[1] - a1[1]) * (b1[0] - a1[0]);
  const o2 = (a2[0] - a1[0]) * (b2[1] - a1[1]) - (a2[1] - a1[1]) * (b2[0] - a1[0]);
  const o3 = (b2[0] - b1[0]) * (a1[1] - b1[1]) - (b2[1] - b1[1]) * (a1[0] - b1[0]);
  const o4 = (b2[0] - b1[0]) * (a2[1] - b1[1]) - (b2[1] - b1[1]) * (a2[0] - b1[0]);
  if ((o1 > 0 && o2 < 0 || o1 < 0 && o2 > 0) && (o3 > 0 && o4 < 0 || o3 < 0 && o4 > 0)) return true;
  if (Math.abs(o1) < 1e-9 && onSeg(a1, b1, a2)) return true;
  if (Math.abs(o2) < 1e-9 && onSeg(a1, b2, a2)) return true;
  if (Math.abs(o3) < 1e-9 && onSeg(b1, a1, b2)) return true;
  if (Math.abs(o4) < 1e-9 && onSeg(b1, a2, b2)) return true;
  return ccw(a1, b1, b2) !== ccw(a2, b1, b2) && ccw(a1, a2, b1) !== ccw(a1, a2, b2);
}

function pointInPolygon2D(pt: [number, number], poly: Array<[number, number]>): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    const intersect =
      yi > pt[1] !== yj > pt[1] &&
      pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function isPointInsideRect(pt: [number, number], rect: [number, number, number, number], margin = 0): boolean {
  return (
    pt[0] >= rect[0] - margin &&
    pt[0] <= rect[2] + margin &&
    pt[1] >= rect[1] - margin &&
    pt[1] <= rect[3] + margin
  );
}

// ============================================================================
// Main PLINT-01 ~ PLINT-18 Engine
// ============================================================================

export function runGeometryPcbLinter(board: PcbBoardGeometrySnapshot): PcbLintReport {
  const resolver = board.cesmResolver ?? createBuiltInCesmResolver();
  const useProjectFirst = board.options?.useProjectDesignRulesFirst ?? true;
  const fabCapability = board.options?.fabCapability ?? "jlc_standard_multi";
  const copperOz = board.boardOutline.copperWeightOuterOz ?? board.projectDesignRules?.copperWeightOuterOz ?? 1.0;

  const effectiveDesignRules = buildEffectiveDesignRules(
    board.projectDesignRules,
    useProjectFirst,
    fabCapability,
    copperOz
  );

  const stackup = getNormalizedStackup(board);
  const hypergraph = board.netlist ? buildElectricalHypergraph(board.netlist, resolver) : undefined;
  const findings: PlintFinding[] = [];

  checkPlint01AntiQueueingAndDispersion(board, findings);
  checkPlint02DecouplingDistanceAndOrder(board, findings);
  checkPlint03VoltageDeratingAndResistorAcross(board, hypergraph, resolver, findings);
  checkPlint04PolarityAndTypeC(board, hypergraph, resolver, findings);
  checkPlint05CrossVoltagePcb(board, hypergraph, resolver, findings);
  checkPlint06OpenDrainAndControlPads(board, hypergraph, resolver, findings);
  checkPlint07InductiveFlybackDistance(board, resolver, findings);
  checkPlint08LdoThermalCopperArea(board, hypergraph, resolver, findings);
  checkPlint09EsdStubViasAndCj(board, resolver, findings);
  checkPlint10Keepout25D(board, stackup, findings);
  checkPlint11CrystalLayerRules(board, stackup, resolver, findings);
  checkPlint12MechanicalAndThermalStress(board, resolver, findings);
  checkPlint13PowerWidthViasAndIrDrop(board, effectiveDesignRules, copperOz, findings);
  checkPlint14HighVoltageClearanceAndCreepage(board, effectiveDesignRules, hypergraph, stackup, findings);
  checkPlint15MountingHoleConnectorAndTestPoints(board, findings);
  checkPlint16SmallPassiveThermalReliefAndSymmetry(board, findings);
  checkPlint17DatasheetLayoutShuntInnerAndBlindVias(board, stackup, resolver, findings);
  checkPlint18DiffPairAndMemoryIntegrity(board, stackup, findings);

  // Optional scope filter for selection_neighborhood
  const scopedFindings =
    board.options?.checkScope === "selection_neighborhood" && board.options.selectedDesignators?.length
      ? findings.filter((f) =>
          f.involvedPrimitives.some((p) =>
            board.options!.selectedDesignators!.some((sel) => p.startsWith(sel))
          )
        )
      : findings;

  const unroutedRatlineCount = board.nativeDrcResult?.unroutedRatlineCount ?? 0;
  const nativeDrcErrors = board.nativeDrcResult?.errors ?? [];
  const blockerCount = scopedFindings.filter((f) => f.severity === "BLOCKER").length;
  const warningCount = scopedFindings.filter((f) => f.severity === "WARNING").length;

  const pass = unroutedRatlineCount === 0 && nativeDrcErrors.length === 0 && blockerCount === 0;

  return {
    pass,
    activeDesignRuleSource: effectiveDesignRules.source,
    effectiveDesignRules,
    unroutedRatlineCount,
    nativeDrcErrors,
    custom_linter_summary: {
      blocker_count: blockerCount,
      warning_count: warningCount,
    },
    customGeoLintFindings: scopedFindings,
  };
}

// ============================================================================
// Helper: Identify component category & net voltage
// ============================================================================

function getCompCategory(comp: PcbComponentGeom, resolver: CesmResolver): CesmModel["category"] | "UNKNOWN" {
  if (comp.category) return comp.category;
  if (comp.lcscId) {
    const cesm = resolver(comp.lcscId);
    if (cesm) return cesm.category;
  }
  const des = comp.designator.toUpperCase();
  const txt = `${comp.mpn ?? ""} ${comp.value ?? ""} ${comp.package}`.toUpperCase();
  if (/^R\d/.test(des)) return txt.includes("SHUNT") || txt.includes("MOHM") ? "RES_SHUNT" : "RES_CHIP";
  if (/^C\d/.test(des)) {
    if (txt.includes("TANT")) return "CAP_TANTALUM";
    if (txt.includes("ELEC")) return "CAP_AL_ELEC";
    return "CAP_MLCC";
  }
  if (/^FB\d/.test(des) || txt.includes("BEAD") || txt.includes("CMC")) return "FERRITE_CMC";
  if (/^L\d/.test(des)) return "IND_POWER";
  if (/^(?:Y|X)\d/.test(des)) return "XTAL_PASSIVE";
  if (/^(?:TVS|ESD)\d/.test(des) || txt.includes("USBLC6") || txt.includes("TVS")) return "TVS_ESD_MOV";
  if (/^LED\d/.test(des) || txt.includes("LED")) return "LED";
  if (/^D\d/.test(des)) return "DIODE_SCHOTTKY";
  if (/^(?:K|RLY|LS|BZ)\d/.test(des) || txt.includes("RELAY") || txt.includes("BUZZER")) return "RELAY_BUZZER";
  if (/^USB|^J\d/.test(des) && txt.includes("TYPE-C")) return "CONN_USB_TYPEC";
  if (/^J\d|^CN\d/.test(des)) return "CONN_GENERIC";
  if (/^U\d/.test(des)) {
    if (txt.includes("1117") || txt.includes("RT9013") || txt.includes("LDO")) return "PMIC_LDO";
    if (txt.includes("BUCK") || txt.includes("TPS54") || txt.includes("MP23")) return "PMIC_DCDC";
    if (txt.includes("STM32") || txt.includes("ESP32") || txt.includes("MCU")) return "MCU_SOC";
  }
  return "UNKNOWN";
}

function getNetVoltageInfo(
  netName: string,
  board: PcbBoardGeometrySnapshot,
  hypergraph?: ElectricalHypergraph
): { min: number; max: number; surge: number; isSurgeInput?: boolean } | undefined {
  const handoffRule = board.constraintHandoff?.perNetRoutingRules.find((r) => r.netName === netName);
  if (handoffRule?.voltageRangeV) {
    return {
      min: handoffRule.voltageRangeV.min,
      max: handoffRule.voltageRangeV.max,
      surge: handoffRule.voltageRangeV.surge ?? handoffRule.voltageRangeV.max,
      isSurgeInput: /^(?:VBUS|VIN|VBAT|DC_IN)/i.test(netName),
    };
  }
  const hNet = hypergraph?.nets.get(netName);
  if (hNet && hNet.voltage.confidence !== "UNKNOWN") {
    return {
      min: hNet.voltage.vMin,
      max: hNet.voltage.vMax,
      surge: hNet.voltage.vSurge,
      isSurgeInput: hNet.isSurgeInput,
    };
  }
  return undefined;
}

// ============================================================================
// PLINT-01: Anti-Queueing (R^2 > 0.95) & Intra-Cluster Dispersion (> 12 mm)
// ============================================================================

function computeCollinearityMetrics(pts: Array<[number, number]>): { r2: number; stepCv: number } {
  if (pts.length < 4) return { r2: 0, stepCv: 1 };
  const n = pts.length;
  const meanX = pts.reduce((s, p) => s + p[0], 0) / n;
  const meanY = pts.reduce((s, p) => s + p[1], 0) / n;
  const varX = pts.reduce((s, p) => s + (p[0] - meanX) ** 2, 0);
  const varY = pts.reduce((s, p) => s + (p[1] - meanY) ** 2, 0);
  const covXY = pts.reduce((s, p) => s + (p[0] - meanX) * (p[1] - meanY), 0);

  // Regress along the principal axis to stay invariant for horizontal & vertical queues
  let r2 = 0;
  let sorted: Array<[number, number]>;
  if (varX >= varY) {
    if (varX < 1e-9) return { r2: 0, stepCv: 1 };
    if (varY < 1e-6) {
      r2 = 1.0; // Perfect horizontal line
    } else {
      r2 = (covXY * covXY) / (varX * varY);
    }
    sorted = [...pts].sort((a, b) => a[0] - b[0]);
  } else {
    if (varY < 1e-9) return { r2: 0, stepCv: 1 };
    if (varX < 1e-6) {
      r2 = 1.0; // Perfect vertical line
    } else {
      r2 = (covXY * covXY) / (varX * varY);
    }
    sorted = [...pts].sort((a, b) => a[1] - b[1]);
  }

  const steps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    steps.push(distPoints(sorted[i - 1], sorted[i]));
  }
  const meanStep = steps.reduce((s, d) => s + d, 0) / steps.length;
  const stdStep = Math.sqrt(steps.reduce((s, d) => s + (d - meanStep) ** 2, 0) / steps.length);
  const stepCv = meanStep > 1e-6 ? stdStep / meanStep : 1;
  return { r2, stepCv };
}

function checkPlint01AntiQueueingAndDispersion(
  board: PcbBoardGeometrySnapshot,
  out: PlintFinding[]
): void {
  const compByDes = new Map(board.components.map((c) => [c.designator, c]));

  // Map each designator -> cluster_id if clusters provided
  const desToCluster = new Map<string, string>();
  if (board.clusters) {
    for (const clu of board.clusters.functional_clusters) {
      for (const m of clu.members) {
        desToCluster.set(m.designator, clu.cluster_id);
      }

      const anchor = compByDes.get(clu.anchor_designator);
      if (!anchor) continue;
      for (const m of clu.members) {
        if (m.designator === clu.anchor_designator) continue;
        const sat = compByDes.get(m.designator);
        if (!sat) continue;
        const d = distPointToRect(sat.centerMm, anchor.bboxMm);
        if (d > 12.0) {
          out.push({
            ruleId: "PLINT-01",
            severity: "BLOCKER",
            category: "INTRA_CLUSTER_DISPERSION",
            involvedPrimitives: [sat.designator, anchor.designator],
            locationMm: sat.centerMm,
            layer: sat.layer,
            measuredValue: `dist_to_anchor = ${d.toFixed(2)} mm`,
            threshold: "<= 12.0 mm",
            autoFixAction: "SNAP_SATELLITE_TO_ANCHOR",
            prescription: `Satellite ${sat.designator} in cluster ${clu.cluster_id} is ${d.toFixed(2)}mm away from anchor ${anchor.designator} (>12mm). Pull inside cluster neighborhood.`,
          });
        }
      }
    }
  }

  // Check decoupling pairs distance <= 12mm too if clusters wasn't supplied
  if (!board.clusters && board.constraintHandoff) {
    for (const dp of board.constraintHandoff.decouplingAndEsdAffinity.decouplingPairs) {
      const cap = compByDes.get(dp.capacitorDesignator);
      const ic = compByDes.get(dp.targetIcDesignator);
      if (cap && ic) {
        const d = distPointToRect(cap.centerMm, ic.bboxMm);
        if (d > 12.0) {
          out.push({
            ruleId: "PLINT-01",
            severity: "BLOCKER",
            category: "INTRA_CLUSTER_DISPERSION",
            involvedPrimitives: [cap.designator, ic.designator],
            locationMm: cap.centerMm,
            layer: cap.layer,
            measuredValue: `dist_to_anchor = ${d.toFixed(2)} mm`,
            threshold: "<= 12.0 mm",
            autoFixAction: "SNAP_SATELLITE_TO_ANCHOR",
            prescription: `Decoupling cap ${cap.designator} is ${d.toFixed(2)}mm from ${ic.designator} (>12mm).`,
          });
        }
      }
    }
  }

  // Collinear type-sorted queueing detection (R* or C* across >= 2 clusters or far from anchors)
  for (const prefix of ["R", "C"] as const) {
    const group = board.components.filter((c) => new RegExp(`^${prefix}\\d+`, "i").test(c.designator));
    if (group.length < 4) continue;

    const distinctClusters = new Set(group.map((c) => desToCluster.get(c.designator) ?? "UNCLUSTERED"));
    const { r2, stepCv } = computeCollinearityMetrics(group.map((c) => c.centerMm));

    // Trigger only when spanning >= 2 clusters (or >= 4 unclustered passives queued uniformly in a row)
    if (r2 > 0.95 && stepCv < 0.3 && (distinctClusters.size >= 2 || !board.clusters)) {
      // Avoid false positives when all 4 passives belong to a single IC's legitimate edge row
      const allSameCluster = board.clusters && distinctClusters.size === 1 && !distinctClusters.has("UNCLUSTERED");
      if (!allSameCluster) {
        out.push({
          ruleId: "PLINT-01",
          severity: "BLOCKER",
          category: "TYPE_SORTED_QUEUEING",
          involvedPrimitives: group.map((c) => c.designator),
          locationMm: group[0].centerMm,
          layer: group[0].layer,
          measuredValue: `R^2 = ${r2.toFixed(4)}, step_CV = ${stepCv.toFixed(2)} across ${group.length} ${prefix}* parts`,
          threshold: "R^2 <= 0.95 (no cross-cluster type-sorted queueing)",
          autoFixAction: "RUN_MODULAR_CLUSTER_PLACEMENT",
          prescription: `Detected warehouse-style type-sorted queueing of ${group.map((g) => g.designator).join(", ")} (R^2=${r2.toFixed(3)}). Re-place each passive adjacent to its functional anchor IC.`,
        });
      }
    }
  }
}

// ============================================================================
// PLINT-02: IC Decoupling Distance <= 2.5 mm & Power-Via -> Cap -> Pin Order
// ============================================================================

function checkPlint02DecouplingDistanceAndOrder(
  board: PcbBoardGeometrySnapshot,
  out: PlintFinding[]
): void {
  const pairs = board.constraintHandoff?.decouplingAndEsdAffinity.decouplingPairs ?? [];
  const compByDes = new Map(board.components.map((c) => [c.designator, c]));

  for (const pair of pairs) {
    const cap = compByDes.get(pair.capacitorDesignator);
    const ic = compByDes.get(pair.targetIcDesignator);
    if (!cap || !ic) continue;

    const icPin = ic.pads.find(
      (p) => p.padNumber === pair.targetPinNumber || p.pinName === pair.targetPinName
    );
    const capPwrPad = cap.pads.find((p) => p.net === pair.powerNet) ?? cap.pads[0];
    if (!icPin || !capPwrPad) continue;

    const d = distPoints(capPwrPad.centerMm, icPin.centerMm);
    const maxDist = Math.max(2.5, pair.maxPathLengthMm);
    if (d > maxDist) {
      out.push({
        ruleId: "PLINT-02",
        severity: "BLOCKER",
        category: "DECOUPLING_DISTANCE",
        net: pair.powerNet,
        involvedPrimitives: [cap.designator, `${ic.designator}.${icPin.padNumber}`],
        locationMm: capPwrPad.centerMm,
        layer: cap.layer,
        measuredValue: `${d.toFixed(2)} mm`,
        threshold: `<= ${maxDist.toFixed(2)} mm`,
        autoFixAction: "MOVE_DECAP_NEXT_TO_PIN",
        prescription: `Move ${cap.designator} within <= 2.0mm of ${ic.designator}.${icPin.padNumber}(${pair.powerNet}).`,
      });
    }

    if (pair.enforcePowerViaToCapToPinOrder) {
      const pwrTracks = board.tracks.filter((t) => t.net === pair.powerNet && t.layer === ic.layer);
      const pwrVias = board.vias.filter((v) => v.net === pair.powerNet);
      if (pwrTracks.length > 0 && pwrVias.length > 0) {
        // Locate nearest power source via on this rail
        let nearestVia = pwrVias[0];
        let minViaDist = Infinity;
        for (const v of pwrVias) {
          const dv = Math.min(distPoints(v.centerMm, capPwrPad.centerMm), distPoints(v.centerMm, icPin.centerMm));
          if (dv < minViaDist) {
            minViaDist = dv;
            nearestVia = v;
          }
        }

        // Only evaluate order when the feed via is locally part of this decoupling branch (<= 10mm)
        if (minViaDist <= 10.0) {
          const viaToIcDist = distPoints(nearestVia.centerMm, icPin.centerMm);
          const viaToCapDist = distPoints(nearestVia.centerMm, capPwrPad.centerMm);

          // Topological check: does a track go directly between via and icPin without visiting capPwrPad?
          const directViaToIcTrack = pwrTracks.some(
            (t) =>
              distPointToSegment(nearestVia.centerMm, t.startMm, t.endMm) < 0.5 &&
              distPointToSegment(icPin.centerMm, t.startMm, t.endMm) < 0.5 &&
              distPointToSegment(capPwrPad.centerMm, t.startMm, t.endMm) > 0.5
          );
          const capOnPathBetween =
            viaToCapDist < viaToIcDist && !directViaToIcTrack;

          if (!capOnPathBetween && viaToIcDist + 0.2 < viaToCapDist) {
            out.push({
              ruleId: "PLINT-02",
              severity: "BLOCKER",
              category: "DECOUPLING_CURRENT_ORDER",
              net: pair.powerNet,
              involvedPrimitives: [nearestVia.primitiveId, cap.designator, `${ic.designator}.${icPin.padNumber}`],
              locationMm: capPwrPad.centerMm,
              layer: cap.layer,
              measuredValue: `d(via,IC)=${viaToIcDist.toFixed(2)}mm < d(via,Cap)=${viaToCapDist.toFixed(2)}mm (stub branch)`,
              threshold: "Order: Power Via -> Cap Pad -> IC VDD Pin",
              autoFixAction: "REORDER_DECAP_VIA_FLOW",
              prescription: `Route power via through ${cap.designator} pad BEFORE entering ${ic.designator}.${icPin.padNumber} instead of tee-stubbing off the IC pin.`,
            });
          }
        }
      }
    }
  }
}

// ============================================================================
// PLINT-03: Component Voltage Derating & Resistor Across-Voltage Re-check
// ============================================================================

function checkPlint03VoltageDeratingAndResistorAcross(
  board: PcbBoardGeometrySnapshot,
  hypergraph: ElectricalHypergraph | undefined,
  resolver: CesmResolver,
  out: PlintFinding[]
): void {
  for (const comp of board.components) {
    const cat = getCompCategory(comp, resolver);
    const cesm = comp.lcscId ? resolver(comp.lcscId) : undefined;

    if (cat === "CAP_MLCC" || cat === "CAP_TANTALUM") {
      const vRated = cesm?.ratings.v_working_max ?? (comp.extraProps?.v_rated as number | undefined);
      if (vRated === undefined) continue;
      for (const pad of comp.pads) {
        if (!pad.net || isGroundNetName(pad.net)) continue;
        const vInfo = getNetVoltageInfo(pad.net, board, hypergraph);
        if (!vInfo || vInfo.max <= 0) continue;

        if (cat === "CAP_MLCC" && vRated < 1.5 * vInfo.max - 1e-6) {
          out.push({
            ruleId: "PLINT-03",
            severity: "BLOCKER",
            category: "MLCC_VOLTAGE_DERATING",
            net: pad.net,
            involvedPrimitives: [comp.designator],
            locationMm: comp.centerMm,
            layer: comp.layer,
            measuredValue: `V_rated=${vRated}V (< 1.5 * ${vInfo.max.toFixed(2)}V)`,
            threshold: `>= ${(1.5 * vInfo.max).toFixed(2)}V`,
            autoFixAction: "UPGRADE_CAP_VOLTAGE_RATING",
            prescription: `Upgrade MLCC ${comp.designator} on '${pad.net}' to >= ${(1.5 * vInfo.max).toFixed(1)}V.`,
          });
        } else if (cat === "CAP_TANTALUM") {
          const dielectric = cesm?.ratings.dielectric ?? "MNO2_TANT";
          const factor = dielectric === "MNO2_TANT" ? (vInfo.isSurgeInput ? 3.0 : 2.0) : 1.5;
          if (vRated < factor * vInfo.max - 1e-6) {
            out.push({
              ruleId: "PLINT-03",
              severity: "BLOCKER",
              category: "TANTALUM_VOLTAGE_DERATING",
              net: pad.net,
              involvedPrimitives: [comp.designator],
              locationMm: comp.centerMm,
              layer: comp.layer,
              measuredValue: `V_rated=${vRated}V (< ${factor}x * ${vInfo.max.toFixed(2)}V)`,
              threshold: `>= ${(factor * vInfo.max).toFixed(2)}V`,
              autoFixAction: "UPGRADE_OR_REPLACE_TANTALUM",
              prescription: `Replace ${dielectric} tantalum ${comp.designator} with >= ${Math.ceil(factor * vInfo.max)}V or Polymer/X7R.`,
            });
          }
        }
      }
    }

    if ((cat === "RES_CHIP" || cat === "RES_SHUNT") && comp.pads.length >= 2) {
      const p0Net = comp.pads[0].net;
      const p1Net = comp.pads[1].net;
      if (!p0Net || !p1Net) continue;
      const v0 = isGroundNetName(p0Net) ? { min: 0, max: 0 } : getNetVoltageInfo(p0Net, board, hypergraph);
      const v1 = isGroundNetName(p1Net) ? { min: 0, max: 0 } : getNetVoltageInfo(p1Net, board, hypergraph);
      if (!v0 || !v1) continue;

      const vAcross = Math.max(Math.abs(v0.max - v1.min), Math.abs(v1.max - v0.min));
      const vPkgMax = cesm?.ratings.v_working_max ?? getPackageWorkingMaxV(comp.package);
      if (vAcross > vPkgMax + 1e-3) {
        out.push({
          ruleId: "PLINT-03",
          severity: "BLOCKER",
          category: "RESISTOR_WORKING_VOLTAGE",
          involvedPrimitives: [comp.designator],
          locationMm: comp.centerMm,
          layer: comp.layer,
          measuredValue: `V_across=${vAcross.toFixed(1)}V`,
          threshold: `<= ${vPkgMax}V (${normalizePackageCode(comp.package)})`,
          autoFixAction: "SPLIT_SERIES_1206_RESISTORS",
          prescription: `Resistor ${comp.designator} (${comp.package}) spans ${vAcross.toFixed(1)}V > ${vPkgMax}V limit; split into series 1206 resistors.`,
        });
      }
    }
  }
}

// ============================================================================
// PLINT-04: Polarity Orientation & Type-C Dual CC PCB Re-check
// ============================================================================

function checkPlint04PolarityAndTypeC(
  board: PcbBoardGeometrySnapshot,
  hypergraph: ElectricalHypergraph | undefined,
  resolver: CesmResolver,
  out: PlintFinding[]
): void {
  for (const comp of board.components) {
    const cat = getCompCategory(comp, resolver);
    const cesm = comp.lcscId ? resolver(comp.lcscId) : undefined;

    if (
      comp.expectedPolarityAngleDeg !== undefined &&
      comp.polarityAngleDeg !== undefined &&
      Math.abs(((comp.polarityAngleDeg - comp.expectedPolarityAngleDeg + 540) % 360) - 180) > 5
    ) {
      out.push({
        ruleId: "PLINT-04",
        severity: "BLOCKER",
        category: "POLARITY_ROTATION_MISMATCH",
        involvedPrimitives: [comp.designator],
        locationMm: comp.centerMm,
        layer: comp.layer,
        measuredValue: `${comp.polarityAngleDeg}°`,
        threshold: `${comp.expectedPolarityAngleDeg}° (±5°)`,
        autoFixAction: "ROTATE_POLARIZED_FOOTPRINT",
        prescription: `Polarized component ${comp.designator} angle ${comp.polarityAngleDeg}° disagrees with expected ${comp.expectedPolarityAngleDeg}°.`,
      });
    }

    if (cat === "CAP_AL_ELEC" || cat === "CAP_TANTALUM" || cat === "LED") {
      const anodeNum = cesm?.polarity_spec?.anode_pins?.[0] ?? "1";
      const cathodeNum = cesm?.polarity_spec?.cathode_pins?.[0] ?? "2";
      const aPad = comp.pads.find((p) => p.padNumber === anodeNum || /^(?:\+|A|ANODE)$/i.test(p.pinName ?? ""));
      const kPad = comp.pads.find((p) => p.padNumber === cathodeNum || /^(?:-|K|C|CATHODE)$/i.test(p.pinName ?? ""));
      if (aPad?.net && kPad?.net) {
        const va = isGroundNetName(aPad.net) ? { min: 0, max: 0 } : getNetVoltageInfo(aPad.net, board, hypergraph);
        const vk = isGroundNetName(kPad.net) ? { min: 0, max: 0 } : getNetVoltageInfo(kPad.net, board, hypergraph);
        if ((va && vk && va.max < vk.min - 0.1) || (isGroundNetName(aPad.net) && vk && vk.max > 0.2)) {
          out.push({
            ruleId: "PLINT-04",
            severity: "BLOCKER",
            category: "PAD_POLARITY_REVERSED",
            involvedPrimitives: [comp.designator],
            locationMm: comp.centerMm,
            layer: comp.layer,
            measuredValue: `Anode('${aPad.net}') < Cathode('${kPad.net}')`,
            threshold: "V_anode >= V_cathode",
            autoFixAction: "ROTATE_180_OR_REWIRE_PADS",
            prescription: `Flip polarized pads on ${comp.designator}: Anode must connect to higher potential than Cathode.`,
          });
        }
      }
    }

    if (cat === "CONN_USB_TYPEC" && comp.extraProps?.usbRole !== "DFP_HOST") {
      const cc1 = comp.pads.find((p) => /^CC1$/i.test(p.pinName ?? "") || /^A5$/i.test(p.padNumber));
      const cc2 = comp.pads.find((p) => /^CC2$/i.test(p.pinName ?? "") || /^B5$/i.test(p.padNumber));
      if (!cc1?.net || !cc2?.net || cc1.net === cc2.net) {
        out.push({
          ruleId: "PLINT-04",
          severity: "BLOCKER",
          category: "TYPEC_DUAL_CC_CHECK",
          involvedPrimitives: [comp.designator],
          locationMm: comp.centerMm,
          layer: comp.layer,
          measuredValue: `CC1='${cc1?.net ?? "NC"}', CC2='${cc2?.net ?? "NC"}'`,
          threshold: "CC1 and CC2 on separate nets, each with independent 5.1kΩ to GND",
          autoFixAction: "SPLIT_TYPEC_CC_PADS",
          prescription: `Separate ${comp.designator}.CC1 and CC2 and connect each to its own 5.1kΩ resistor to GND.`,
        });
      } else {
        for (const ccPad of [cc1, cc2]) {
          const has5k1 = board.components.some((r) => {
            if (getCompCategory(r, resolver) !== "RES_CHIP" && getCompCategory(r, resolver) !== "RES_SHUNT") return false;
            const ohms = parseResistanceOhms(`${r.value ?? ""} ${r.mpn ?? ""}`);
            if (ohms === undefined || ohms < 4080 || ohms > 6120) return false;
            return (
              r.pads.some((rp) => rp.net === ccPad.net) &&
              r.pads.some((rp) => rp.net && isGroundNetName(rp.net))
            );
          });
          if (!has5k1) {
            out.push({
              ruleId: "PLINT-04",
              severity: "BLOCKER",
              category: "TYPEC_DUAL_CC_CHECK",
              net: ccPad.net ?? undefined,
              involvedPrimitives: [comp.designator, `${comp.designator}.${ccPad.padNumber}`],
              locationMm: ccPad.centerMm,
              layer: comp.layer,
              measuredValue: `Missing 5.1kΩ pull-down on '${ccPad.net}'`,
              threshold: "Independent 5.1kΩ ±20% resistor to GND",
              autoFixAction: "ADD_5K1_CC_RESISTOR",
              prescription: `Attach dedicated 5.1kΩ resistor from ${comp.designator}.${ccPad.padNumber}('${ccPad.net}') to GND.`,
            });
          }
        }
      }

      const a6 = comp.pads.find((p) => /^A6$/i.test(p.padNumber) || /^DP1$/i.test(p.pinName ?? ""));
      const b6 = comp.pads.find((p) => /^B6$/i.test(p.padNumber) || /^DP2$/i.test(p.pinName ?? ""));
      const a7 = comp.pads.find((p) => /^A7$/i.test(p.padNumber) || /^DN1$/i.test(p.pinName ?? ""));
      const b7 = comp.pads.find((p) => /^B7$/i.test(p.padNumber) || /^DN2$/i.test(p.pinName ?? ""));
      if (a6 && b6 && a6.net !== b6.net) {
        out.push({
          ruleId: "PLINT-04",
          severity: "BLOCKER",
          category: "TYPEC_DP_DN_MERGE",
          involvedPrimitives: [comp.designator],
          locationMm: a6.centerMm,
          layer: comp.layer,
          measuredValue: `A6='${a6.net}', B6='${b6.net}'`,
          threshold: "A6 == B6 (merged USB_DP)",
          autoFixAction: "MERGE_TYPEC_DP_PADS",
          prescription: `Short ${comp.designator}.A6 and B6 together on PCB.`,
        });
      }
      if (a7 && b7 && a7.net !== b7.net) {
        out.push({
          ruleId: "PLINT-04",
          severity: "BLOCKER",
          category: "TYPEC_DP_DN_MERGE",
          involvedPrimitives: [comp.designator],
          locationMm: a7.centerMm,
          layer: comp.layer,
          measuredValue: `A7='${a7.net}', B7='${b7.net}'`,
          threshold: "A7 == B7 (merged USB_DN)",
          autoFixAction: "MERGE_TYPEC_DN_PADS",
          prescription: `Short ${comp.designator}.A7 and B7 together on PCB.`,
        });
      }
    }
  }
}

// ============================================================================
// PLINT-05: Cross-Voltage Net Tolerance Re-check on PCB
// ============================================================================

function checkPlint05CrossVoltagePcb(
  board: PcbBoardGeometrySnapshot,
  hypergraph: ElectricalHypergraph | undefined,
  resolver: CesmResolver,
  out: PlintFinding[]
): void {
  const netPads = new Map<string, Array<{ comp: PcbComponentGeom; pad: PcbPadGeom; cesm?: CesmModel }>>();
  for (const comp of board.components) {
    const cesm = comp.lcscId ? resolver(comp.lcscId) : undefined;
    for (const pad of comp.pads) {
      if (!pad.net || isGroundNetName(pad.net)) continue;
      const arr = netPads.get(pad.net) ?? [];
      arr.push({ comp, pad, cesm });
      netPads.set(pad.net, arr);
    }
  }

  for (const [netName, items] of netPads.entries()) {
    const vInfo = getNetVoltageInfo(netName, board, hypergraph);
    let vOhMax = vInfo?.max;

    // Also infer from any PUSH_PULL / POWER_OUT driver pad on this net
    for (const item of items) {
      const cPin = item.cesm?.pins.find((p) => p.pin_number === item.pad.padNumber);
      const elec = item.pad.elecType ?? cPin?.elec_type;
      if (elec === "PUSH_PULL" || elec === "POWER_OUT") {
        const pwrPad = item.comp.pads.find(
          (p) => (p.elecType === "POWER_IN" || /^(?:VDD|VCC)/i.test(p.pinName ?? "")) && p.net && !isGroundNetName(p.net)
        );
        const supInfo = pwrPad?.net ? getNetVoltageInfo(pwrPad.net, board, hypergraph) : undefined;
        if (supInfo) vOhMax = Math.max(vOhMax ?? 0, supInfo.max);
      }
    }

    if (vOhMax === undefined) continue;

    for (const item of items) {
      const cPin = item.cesm?.pins.find((p) => p.pin_number === item.pad.padNumber);
      const elec = item.pad.elecType ?? cPin?.elec_type;
      if (elec !== "INPUT_HIZ" && elec !== "BIDIR_IO" && elec !== "ANALOG_IN" && elec !== "OPEN_DRAIN") {
        continue;
      }
      const vAbsMax = cPin?.v_abs_max;
      if (vAbsMax !== undefined && vOhMax > vAbsMax + 0.05) {
        out.push({
          ruleId: "PLINT-05",
          severity: "BLOCKER",
          category: "PCB_CROSS_VOLTAGE_OVERVOLTAGE",
          net: netName,
          involvedPrimitives: [`${item.comp.designator}.${item.pad.padNumber}`],
          locationMm: item.pad.centerMm,
          layer: item.pad.layer,
          measuredValue: `V_net_max=${vOhMax.toFixed(2)}V > v_abs_max=${vAbsMax.toFixed(2)}V`,
          threshold: `<= ${vAbsMax.toFixed(2)}V`,
          autoFixAction: "BACK_TO_SCH_LEVEL_SHIFT",
          prescription: `Net '${netName}' applies ${vOhMax.toFixed(2)}V to ${item.comp.designator}.${item.pad.padNumber} (limit ${vAbsMax.toFixed(2)}V). Insert level translator or divider.`,
        });
      }
    }
  }
}

// ============================================================================
// PLINT-06: Open-Drain Pull-Up & Critical Control Pad Bias on PCB
// ============================================================================

function checkPlint06OpenDrainAndControlPads(
  board: PcbBoardGeometrySnapshot,
  hypergraph: ElectricalHypergraph | undefined,
  resolver: CesmResolver,
  out: PlintFinding[]
): void {
  const netPads = new Map<string, Array<{ comp: PcbComponentGeom; pad: PcbPadGeom; elec?: string }>>();
  for (const comp of board.components) {
    const cesm = comp.lcscId ? resolver(comp.lcscId) : undefined;
    for (const pad of comp.pads) {
      const cPin = cesm?.pins.find((p) => p.pin_number === pad.padNumber);
      const elec = pad.elecType ?? cPin?.elec_type;

      // Critical control pad check
      const isCtrl =
        elec === "INPUT_HIZ" &&
        /^(?:NRST|N?RESET#?|BOOT\d*|EN|CE|SHDN#?|CS#?|OE#?)$/i.test(pad.pinName ?? "");
      if (isCtrl && !pad.net) {
        out.push({
          ruleId: "PLINT-06",
          severity: "BLOCKER",
          category: "PCB_FLOATING_CONTROL_PAD",
          involvedPrimitives: [`${comp.designator}.${pad.padNumber}`],
          locationMm: pad.centerMm,
          layer: pad.layer,
          measuredValue: "UNCONNECTED",
          threshold: "Bias resistor or active driver required",
          autoFixAction: "ADD_BIAS_RESISTOR",
          prescription: `Control pad ${comp.designator}.${pad.padNumber}(${pad.pinName}) is floating on PCB.`,
        });
      }

      if (pad.net) {
        const list = netPads.get(pad.net) ?? [];
        list.push({ comp, pad, elec });
        netPads.set(pad.net, list);
      }
    }
  }

  for (const [netName, items] of netPads.entries()) {
    const hasOd = items.some((i) => i.elec === "OPEN_DRAIN") || /(?:I2C|SDA|SCL)/i.test(netName);
    if (!hasOd || isGroundNetName(netName)) continue;

    const hasPullupRes = items.some((i) => {
      const cat = getCompCategory(i.comp, resolver);
      if (cat !== "RES_CHIP" && cat !== "RES_SHUNT") return false;
      const otherPad = i.comp.pads.find((p) => p.net !== netName);
      if (!otherPad?.net || isGroundNetName(otherPad.net)) return false;
      const otherV = getNetVoltageInfo(otherPad.net, board, hypergraph);
      return Boolean(otherV && otherV.min > 0.5) || /^(?:VCC|VDD|3V3|5V)/i.test(otherPad.net);
    });

    if (!hasPullupRes) {
      out.push({
        ruleId: "PLINT-06",
        severity: "BLOCKER",
        category: "PCB_OPEN_DRAIN_MISSING_PULLUP",
        net: netName,
        involvedPrimitives: items.map((i) => `${i.comp.designator}.${i.pad.padNumber}`),
        locationMm: items[0].pad.centerMm,
        layer: items[0].pad.layer,
        measuredValue: "0 pull-up resistors",
        threshold: ">= 1 pull-up resistor to positive rail",
        autoFixAction: "ADD_PULLUP_RESISTOR",
        prescription: `Open-drain / I2C net '${netName}' lacks a pull-up resistor on PCB.`,
      });
    }
  }
}

// ============================================================================
// PLINT-07: Inductive Load Flyback Diode Presence & Distance <= 3.0 mm
// ============================================================================

function checkPlint07InductiveFlybackDistance(
  board: PcbBoardGeometrySnapshot,
  resolver: CesmResolver,
  out: PlintFinding[]
): void {
  for (const comp of board.components) {
    const cat = getCompCategory(comp, resolver);
    if (cat !== "RELAY_BUZZER") continue;
    if (comp.extraProps?.isPiezo === true) continue;

    const coilPads =
      comp.pads.length > 2
        ? comp.pads.filter((p) => /COIL|A1|A2|\+|\-/i.test(p.pinName ?? "") || p.padNumber === "1" || p.padNumber === "2")
        : comp.pads;
    if (coilPads.length < 2 || !coilPads[0].net || !coilPads[1].net) continue;
    const netA = coilPads[0].net;
    const netB = coilPads[1].net;

    const flybackDiodes = board.components.filter((d) => {
      const dc = getCompCategory(d, resolver);
      if (dc !== "DIODE_SCHOTTKY" && dc !== "TVS_ESD_MOV") return false;
      const nets = new Set(d.pads.map((p) => p.net).filter(Boolean));
      return nets.has(netA) && nets.has(netB);
    });

    if (flybackDiodes.length === 0) {
      out.push({
        ruleId: "PLINT-07",
        severity: "BLOCKER",
        category: "MISSING_FLYBACK_DIODE",
        involvedPrimitives: [comp.designator],
        locationMm: comp.centerMm,
        layer: comp.layer,
        measuredValue: "0 flyback diodes",
        threshold: "Antiparallel flyback diode <= 3.0 mm from coil",
        autoFixAction: "PLACE_FLYBACK_DIODE_NEAR_COIL",
        prescription: `Inductive coil ${comp.designator} (${netA}<->${netB}) has no antiparallel flyback diode.`,
      });
      continue;
    }

    const minDist = Math.min(
      ...flybackDiodes.map((d) =>
        Math.min(
          ...d.pads.flatMap((dp) => coilPads.map((cp) => distPoints(dp.centerMm, cp.centerMm)))
        )
      )
    );
    if (minDist > 3.0) {
      out.push({
        ruleId: "PLINT-07",
        severity: "BLOCKER",
        category: "FLYBACK_DIODE_DISTANCE",
        involvedPrimitives: [comp.designator, flybackDiodes[0].designator],
        locationMm: flybackDiodes[0].centerMm,
        layer: flybackDiodes[0].layer,
        measuredValue: `${minDist.toFixed(2)} mm`,
        threshold: "<= 3.00 mm",
        autoFixAction: "SNAP_FLYBACK_DIODE_TO_COIL",
        prescription: `Flyback diode ${flybackDiodes[0].designator} is ${minDist.toFixed(2)}mm from ${comp.designator} coil pads (>3.0mm).`,
      });
    }
  }
}

// ============================================================================
// PLINT-08: LDO Thermal Dissipation & Copper Area >= 300 mm²
// ============================================================================

function checkPlint08LdoThermalCopperArea(
  board: PcbBoardGeometrySnapshot,
  hypergraph: ElectricalHypergraph | undefined,
  resolver: CesmResolver,
  out: PlintFinding[]
): void {
  for (const comp of board.components) {
    const cat = getCompCategory(comp, resolver);
    if (cat !== "PMIC_LDO") continue;

    const cesm = comp.lcscId ? resolver(comp.lcscId) : undefined;
    const vinPad = comp.pads.find((p) => p.elecType === "POWER_IN" && p.net && !isGroundNetName(p.net));
    const voutPad = comp.pads.find((p) => p.elecType === "POWER_OUT" && p.net);
    const gndPad = comp.pads.find((p) => p.elecType === "GND" || p.isEpad || (p.net && isGroundNetName(p.net)));
    if (!vinPad?.net || !voutPad?.net) continue;

    const vinInfo = getNetVoltageInfo(vinPad.net, board, hypergraph);
    const voutInfo = getNetVoltageInfo(voutPad.net, board, hypergraph);
    if (!vinInfo || !voutInfo) continue;

    const vInMax = vinInfo.max;
    const vOut = (voutInfo.min + voutInfo.max) / 2;
    const iLoad =
      typeof comp.extraProps?.i_load_a === "number"
        ? comp.extraProps.i_load_a
        : comp.thermalPowerW !== undefined
          ? comp.thermalPowerW / Math.max(0.1, vInMax - vOut)
          : 0.1;
    const pd = comp.thermalPowerW ?? Math.max(0, vInMax - vOut) * iLoad;

    // Sum thermal copper pour area touching the LDO's GND/EPAD net on MountLayer (plus thermal-via linked pours)
    const thermalNet = gndPad?.net ?? "GND";
    let copperAreaMm2 = 0;
    for (const pour of board.pours) {
      if (pour.net !== thermalNet) continue;
      const area = computePourNetAreaMm2(pour);
      const onSameLayer = normalizeLayerName(pour.layer) === normalizeLayerName(comp.layer);
      const touchesVia = board.vias.some(
        (v) =>
          v.net === thermalNet &&
          distPointToRect(v.centerMm, comp.bboxMm) <= 3.0 &&
          isPointInPour2D(v.centerMm, pour)
      );
      const touchesPad = gndPad ? isPointInPour2D(gndPad.centerMm, pour) : false;
      if ((onSameLayer && (touchesPad || distPointToRect(comp.centerMm, [Math.min(...pour.polygon2D.map((p) => p[0])), Math.min(...pour.polygon2D.map((p) => p[1])), Math.max(...pour.polygon2D.map((p) => p[0])), Math.max(...pour.polygon2D.map((p) => p[1]))]) <= 2.0)) || touchesVia) {
        copperAreaMm2 += area;
      }
    }

    const baseRtheta = cesm?.ratings.r_theta_ja_c_per_w ?? 65;
    const effectiveRtheta = copperAreaMm2 >= 300 ? Math.min(baseRtheta, 42) : baseRtheta;
    const tAmbient = board.options?.ambientTempC ?? 45.0;
    const tj = tAmbient + pd * effectiveRtheta;

    if (pd > 0.8 || (tj > 110.0 && copperAreaMm2 < 300)) {
      out.push({
        ruleId: "PLINT-08",
        severity: "BLOCKER",
        category: "LDO_THERMAL_COPPER_AREA",
        net: thermalNet,
        involvedPrimitives: [comp.designator],
        locationMm: comp.centerMm,
        layer: comp.layer,
        measuredValue: `P_D=${pd.toFixed(2)}W, T_J=${tj.toFixed(1)}°C, Area_cu=${copperAreaMm2.toFixed(1)}mm²`,
        threshold: "P_D <= 0.8W, T_J <= 110°C (or >= 300mm² static GND thermal copper for moderate Pd)",
        autoFixAction: pd > 0.8 ? "SWITCH_LDO_TO_DCDC_BUCK" : "EXPAND_EPAD_GND_THERMAL_COPPER",
        prescription:
          pd > 0.8
            ? `LDO ${comp.designator} dissipates ${pd.toFixed(2)}W (>0.8W, T_J=${tj.toFixed(1)}°C). Replace with DC-DC Buck.`
            : `LDO ${comp.designator} estimated T_J=${tj.toFixed(1)}°C with only ${copperAreaMm2.toFixed(1)}mm² thermal copper (<300mm²). Expand static GND EPAD copper >= 300mm² with Datasheet thermal via array.`,
      });
    }
  }
}

// ============================================================================
// PLINT-09: TVS / ESD Zero-Stub Inline Topology, >= 2 GND Vias & C_J Limit
// ============================================================================

function checkPlint09EsdStubViasAndCj(
  board: PcbBoardGeometrySnapshot,
  resolver: CesmResolver,
  out: PlintFinding[]
): void {
  const chains = board.constraintHandoff?.decouplingAndEsdAffinity.esdInlineChains ?? [];
  const compByDes = new Map(board.components.map((c) => [c.designator, c]));

  for (const chain of chains) {
    const esd = compByDes.get(chain.esdDesignator);
    const conn = compByDes.get(chain.connectorDesignator);
    const ic = compByDes.get(chain.targetIcDesignator);
    if (!esd) continue;

    const cesm = esd.lcscId ? resolver(esd.lcscId) : undefined;
    const cjPf = cesm?.ratings.c_junction_pf;
    if (cjPf !== undefined) {
      if (/(?:USB3|HDMI|PCIE|MIPI|RF)/i.test(chain.netName) && cjPf >= 0.5) {
        out.push({
          ruleId: "PLINT-09",
          severity: "BLOCKER",
          category: "ESD_JUNCTION_CAPACITANCE",
          net: chain.netName,
          involvedPrimitives: [esd.designator],
          locationMm: esd.centerMm,
          layer: esd.layer,
          measuredValue: `${cjPf} pF`,
          threshold: "< 0.50 pF",
          autoFixAction: "REPLACE_WITH_ULTRALOW_CJ_ESD",
          prescription: `ESD ${esd.designator} C_j=${cjPf}pF exceeds 0.5pF on high-speed net '${chain.netName}'.`,
        });
      } else if (/(?:USB|DP|DM|D\+|D-|ETH)/i.test(chain.netName) && cjPf >= 3.0) {
        out.push({
          ruleId: "PLINT-09",
          severity: "BLOCKER",
          category: "ESD_JUNCTION_CAPACITANCE",
          net: chain.netName,
          involvedPrimitives: [esd.designator],
          locationMm: esd.centerMm,
          layer: esd.layer,
          measuredValue: `${cjPf} pF`,
          threshold: "< 3.00 pF",
          autoFixAction: "REPLACE_WITH_LOW_CJ_ESD",
          prescription: `ESD ${esd.designator} C_j=${cjPf}pF exceeds 3.0pF on USB2/ETH net '${chain.netName}'.`,
        });
      }
    }

    // Check GND return vias near ESD GND pad
    const gndPad = esd.pads.find((p) => p.net && isGroundNetName(p.net));
    if (gndPad) {
      const gndViasNear = board.vias.filter(
        (v) => v.net === gndPad.net && distPoints(v.centerMm, gndPad.centerMm) <= 2.5
      );
      if (gndViasNear.length < chain.minGroundVias) {
        out.push({
          ruleId: "PLINT-09",
          severity: "BLOCKER",
          category: "ESD_GROUND_VIA_COUNT",
          net: chain.netName,
          involvedPrimitives: [esd.designator],
          locationMm: gndPad.centerMm,
          layer: esd.layer,
          measuredValue: `${gndViasNear.length} GND via(s)`,
          threshold: `>= ${chain.minGroundVias} GND vias within 2.5mm`,
          autoFixAction: "ADD_DUAL_ESD_GND_VIAS",
          prescription: `Add >= ${chain.minGroundVias} parallel GND vias immediately adjacent to ${esd.designator}.${gndPad.padNumber}.`,
        });
      }
    }

    // Check inline stub length from conn -> esd -> ic
    const connPad = conn?.pads.find((p) => p.padNumber === chain.connectorPin || p.net === chain.netName);
    const esdPad = esd.pads.find((p) => p.padNumber === chain.esdPin || p.net === chain.netName);
    const icPad = ic?.pads.find((p) => p.padNumber === chain.targetIcPin || p.net === chain.netName);

    if (connPad && esdPad && icPad) {
      const netTracks = board.tracks.filter((t) => t.net === chain.netName);
      if (netTracks.length > 0) {
        const stubLen = measureEsdStubLength(netTracks, connPad.centerMm, esdPad.centerMm, icPad.centerMm);
        if (stubLen > chain.maxStubMm) {
          out.push({
            ruleId: "PLINT-09",
            severity: "BLOCKER",
            category: "ESD_TOPOLOGY_STUB",
            net: chain.netName,
            involvedPrimitives: [conn!.designator, esd.designator, ic!.designator],
            locationMm: esdPad.centerMm,
            layer: esdPad.layer,
            measuredValue: `stub_length = ${stubLen.toFixed(2)} mm`,
            threshold: `<= ${chain.maxStubMm.toFixed(2)} mm (inline through pad)`,
            autoFixAction: "REROUTE_INLINE_THROUGH_PAD",
            prescription: `Eliminate T-stub (${stubLen.toFixed(2)}mm) to ${esd.designator}.${esdPad.padNumber}; route '${chain.netName}' inline from ${conn!.designator} directly through ${esd.designator} pad to ${ic!.designator}.`,
          });
        }
      }
    }
  }
}

function measureEsdStubLength(
  tracks: PcbTrackGeom[],
  connPt: [number, number],
  esdPt: [number, number],
  icPt: [number, number]
): number {
  const tol = 0.25;
  // Build node graph of track endpoints + pad anchors
  const nodes: Array<[number, number]> = [];
  const getOrAddNode = (pt: [number, number]): number => {
    const idx = nodes.findIndex((n) => distPoints(n, pt) <= tol);
    if (idx >= 0) return idx;
    nodes.push(pt);
    return nodes.length - 1;
  };

  const adj = new Map<number, Array<{ to: number; len: number }>>();
  const addEdge = (u: number, v: number, len: number) => {
    if (u === v) return;
    const lu = adj.get(u) ?? [];
    lu.push({ to: v, len });
    adj.set(u, lu);
    const lv = adj.get(v) ?? [];
    lv.push({ to: u, len });
    adj.set(v, lv);
  };

  const connNode = getOrAddNode(connPt);
  const esdNode = getOrAddNode(esdPt);
  const icNode = getOrAddNode(icPt);

  for (const t of tracks) {
    const u = getOrAddNode(t.startMm);
    const v = getOrAddNode(t.endMm);
    const len = distPoints(t.startMm, t.endMm);
    addEdge(u, v, len);

    // If ESD pad sits directly on the interior of a continuous segment, zero stub!
    if (distPointToSegment(esdPt, t.startMm, t.endMm) <= tol && distPoints(esdPt, t.startMm) > tol && distPoints(esdPt, t.endMm) > tol) {
      return 0;
    }
  }

  // Find shortest path from connNode to icNode WITHOUT visiting esdNode
  const dijkstra = (src: number, dst: number, banned?: number): { dist: number; visited: Set<number> } => {
    const dist = new Map<number, number>([[src, 0]]);
    const pq: Array<{ u: number; d: number }> = [{ u: src, d: 0 }];
    const visited = new Set<number>();
    while (pq.length > 0) {
      pq.sort((a, b) => a.d - b.d);
      const { u, d } = pq.shift()!;
      if (visited.has(u)) continue;
      visited.add(u);
      if (u === dst) return { dist: d, visited };
      for (const e of adj.get(u) ?? []) {
        if (e.to === banned) continue;
        const nd = d + e.len;
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd);
          pq.push({ u: e.to, d: nd });
        }
      }
    }
    return { dist: Infinity, visited };
  };

  // If removing esdNode disconnects connNode from icNode, the signal MUST pass inline through esdNode => stub = 0!
  const bypass = dijkstra(connNode, icNode, esdNode);
  if (!Number.isFinite(bypass.dist)) {
    return 0;
  }

  // Otherwise conn->ic has a bypass trunk; measure shortest distance from esdNode to any node on conn<->ic trunk
  const fromEsd = dijkstra(esdNode, icNode);
  // Check distance from esdNode to any T-junction node reachable in bypass (degree >= 3 or conn/ic)
  const distFromEsdMap = new Map<number, number>([[esdNode, 0]]);
  const pq = [{ u: esdNode, d: 0 }];
  while (pq.length > 0) {
    pq.sort((a, b) => a.d - b.d);
    const { u, d } = pq.shift()!;
    if (u !== esdNode && ((adj.get(u)?.length ?? 0) >= 3 || u === connNode || u === icNode)) {
      return d;
    }
    for (const e of adj.get(u) ?? []) {
      const nd = d + e.len;
      if (nd < (distFromEsdMap.get(e.to) ?? Infinity)) {
        distFromEsdMap.set(e.to, nd);
        pq.push({ u: e.to, d: nd });
      }
    }
  }
  return Number.isFinite(fromEsd.dist) ? 0 : distPoints(esdPt, connPt);
}

// ============================================================================
// PLINT-10: 2.5D Layer- and Object-Mask-Aware Keep-Out (Clipper2 Two-Stage)
// ============================================================================

function checkPlint10Keepout25D(
  board: PcbBoardGeometrySnapshot,
  stackup: string[],
  out: PlintFinding[]
): void {
  const keepouts: Keepout25DFiveTuple[] = [
    ...(board.keepoutZones ?? []),
    ...(board.constraintHandoff?.keepoutZones25D ?? []).filter(
      (k) => !(board.keepoutZones ?? []).some((ek) => ek.id && ek.id === k.id)
    ),
  ];

  // Ensure keepouts from constraintHandoff have real PCB coordinates if component moved
  const compByDes = new Map(board.components.map((c) => [c.designator, c]));

  for (const rawKo of keepouts) {
    let koPoly = rawKo.polygon2D;
    let koMountSide = rawKo.mountSide;
    if (rawKo.ownerDesignator && compByDes.has(rawKo.ownerDesignator)) {
      const owner = compByDes.get(rawKo.ownerDesignator)!;
      koMountSide = normalizeLayerName(owner.layer) === "BottomLayer" ? "BOTTOM" : "TOP";
      // If polygon is around origin [0,0] placeholder from SCH, translate to owner's PCB bbox
      const xs = koPoly.map((p) => p[0]);
      const ys = koPoly.map((p) => p[1]);
      if (Math.max(...xs) <= 3 && Math.min(...xs) >= -3 && Math.hypot(owner.centerMm[0], owner.centerMm[1]) > 5) {
        koPoly = rectToPoly(owner.bboxMm[0], owner.bboxMm[1], owner.bboxMm[2], owner.bboxMm[3]);
      }
    }

    const ko: Keepout25DFiveTuple = { ...rawKo, polygon2D: koPoly, mountSide: koMountSide };
    const koLayers = resolveKeepoutLayers(ko, stackup);
    const disallowSet = new Set<KeepoutDisallowKind>(ko.disallowMask);
    const allowedNets = new Set(ko.allowedNets);

    // 1. Tracks
    if (disallowSet.has("TRACK")) {
      for (const tr of board.tracks) {
        // Stage 1: Layer intersection short-circuit!
        const trLayers = resolvePrimitiveLayers(tr.layer, stackup);
        if (!hasLayerIntersection(trLayers, koLayers)) continue;
        if (allowedNets.has(tr.net)) continue;

        // Stage 2: Exact Clipper2 Intersection
        const area = computePolygonOverlapAreaMm2(trackToPoly(tr.startMm, tr.endMm, tr.widthMm), ko.polygon2D);
        if (area > 1e-4) {
          out.push(makePlint10Finding(ko, tr.primitiveId, tr.net, tr.layer, tr.startMm, area, "TRACK"));
        }
      }
    }

    // 2. Copper Pours (hole-aware 2.5D intersection)
    if (disallowSet.has("COPPER_POUR")) {
      for (const pour of board.pours) {
        const pLayers = resolvePrimitiveLayers(pour.layer, stackup);
        if (!hasLayerIntersection(pLayers, koLayers)) continue;
        if (allowedNets.has(pour.net)) continue;

        const area = computePourOverlapAreaMm2(pour, ko.polygon2D);
        if (area > 1e-4) {
          out.push(
            makePlint10Finding(
              ko,
              pour.primitiveId,
              pour.net,
              pour.layer,
              ko.polygon2D[0] ?? pour.polygon2D[0] ?? [0, 0],
              area,
              "COPPER_POUR"
            )
          );
        }
      }
    }

    // 3. Vias
    if (disallowSet.has("VIA")) {
      for (const via of board.vias) {
        const vLayers = resolvePrimitiveLayers("MultiLayer", stackup, via.startLayer, via.endLayer);
        if (!hasLayerIntersection(vLayers, koLayers)) continue;
        if (allowedNets.has(via.net)) continue;

        const area = computePolygonOverlapAreaMm2(
          circleToPoly(via.centerMm[0], via.centerMm[1], via.outerDiaMm / 2),
          ko.polygon2D
        );
        if (area > 1e-4) {
          out.push(makePlint10Finding(ko, via.primitiveId, via.net, "MultiLayer", via.centerMm, area, "VIA"));
        }
      }
    }

    // 4. Pads & Components
    for (const comp of board.components) {
      if (comp.designator === ko.ownerDesignator) continue;

      if (disallowSet.has("COMPONENT")) {
        const cLayers = resolvePrimitiveLayers(comp.layer, stackup);
        if (hasLayerIntersection(cLayers, koLayers)) {
          const area = computePolygonOverlapAreaMm2(
            rectToPoly(comp.bboxMm[0], comp.bboxMm[1], comp.bboxMm[2], comp.bboxMm[3]),
            ko.polygon2D
          );
          if (area > 1e-4) {
            out.push(makePlint10Finding(ko, comp.designator, undefined, comp.layer, comp.centerMm, area, "COMPONENT"));
          }
        }
      }

      if (disallowSet.has("PAD")) {
        for (const pad of comp.pads) {
          const padLayers = resolvePrimitiveLayers(pad.layer, stackup);
          if (!hasLayerIntersection(padLayers, koLayers)) continue;
          if (pad.net && allowedNets.has(pad.net)) continue;

          const padPoly = rectToPoly(
            pad.centerMm[0] - pad.sizeMm[0] / 2,
            pad.centerMm[1] - pad.sizeMm[1] / 2,
            pad.centerMm[0] + pad.sizeMm[0] / 2,
            pad.centerMm[1] + pad.sizeMm[1] / 2
          );
          const area = computePolygonOverlapAreaMm2(padPoly, ko.polygon2D);
          if (area > 1e-4) {
            out.push(
              makePlint10Finding(ko, `${comp.designator}.${pad.padNumber}`, pad.net ?? undefined, pad.layer, pad.centerMm, area, "PAD")
            );
          }
        }
      }
    }
  }
}

function hasLayerIntersection(a: Set<string>, b: Set<string>): boolean {
  for (const l of a) {
    if (b.has(l)) return true;
  }
  return false;
}

function makePlint10Finding(
  ko: Keepout25DFiveTuple,
  primId: string,
  net: string | undefined,
  layer: string,
  loc: [number, number],
  area: number,
  kind: KeepoutDisallowKind
): PlintFinding {
  return {
    ruleId: "PLINT-10",
    severity: "BLOCKER",
    category: `25D_KEEPOUT_VIOLATION_${kind}`,
    net,
    involvedPrimitives: [primId, ko.ownerDesignator ?? ko.id ?? "KEEPOUT_25D"],
    locationMm: loc,
    layer,
    measuredValue: `overlap_area = ${area.toFixed(4)} mm²`,
    threshold: "0 mm² inside active layerSet (<= 1e-4 mm²)",
    autoFixAction: "REMOVE_INTRUDING_PRIMITIVE_IN_LAYERSET",
    prescription: `Remove ${kind} ${primId} on ${layer} intersecting 2.5D Keep-out '${ko.id ?? ko.category ?? "zone"}' (layers: ${ko.layerSet.join(",")}).`,
  };
}

// ============================================================================
// PLINT-11: Passive Crystal 4 Mandatory Layer-Aware Rules (4L+ Opposite Exempt)
// ============================================================================

function checkPlint11CrystalLayerRules(
  board: PcbBoardGeometrySnapshot,
  stackup: string[],
  resolver: CesmResolver,
  out: PlintFinding[]
): void {
  const is4PlusLayers = board.boardOutline.layerCount >= 4;

  for (const xtal of board.components) {
    if (getCompCategory(xtal, resolver) !== "XTAL_PASSIVE") continue;

    const mountLayer = normalizeLayerName(xtal.layer);
    const isBottom = mountLayer === "BottomLayer";
    const adjacentRefLayer = is4PlusLayers
      ? isBottom
        ? stackup[stackup.length - 2]
        : stackup[1]
      : isBottom
        ? stackup[0]
        : stackup[stackup.length - 1];

    const sigPads = xtal.pads.filter((p) => p.net && !isGroundNetName(p.net));
    const xtalNets = new Set(sigPads.map((p) => p.net!));

    // 1. Distance to connected IC clock pins <= 10.0 mm
    let minIcDist = Infinity;
    let hostIcDes = "";
    for (const ic of board.components) {
      if (ic.designator === xtal.designator) continue;
      const cat = getCompCategory(ic, resolver);
      if (cat !== "MCU_SOC" && cat !== "INTERFACE_XCVR" && cat !== "ADC_DAC_VREF" && ic.pads.length < 6) continue;
      for (const pad of ic.pads) {
        if (pad.net && xtalNets.has(pad.net)) {
          const d = distPoints(pad.centerMm, xtal.centerMm);
          if (d < minIcDist) {
            minIcDist = d;
            hostIcDes = ic.designator;
          }
        }
      }
    }
    if (Number.isFinite(minIcDist) && minIcDist > 10.0) {
      out.push({
        ruleId: "PLINT-11",
        severity: "BLOCKER",
        category: "XTAL_TOO_FAR_FROM_IC",
        involvedPrimitives: [xtal.designator, hostIcDes],
        locationMm: xtal.centerMm,
        layer: mountLayer,
        measuredValue: `${minIcDist.toFixed(2)} mm`,
        threshold: "<= 10.0 mm (recommended <= 5.0 mm)",
        autoFixAction: "SNAP_XTAL_TO_MCU_CLOCK_PINS",
        prescription: `Move passive crystal ${xtal.designator} within <= 5–10mm of ${hostIcDes} OSC pins.`,
      });
    }

    // 2. Zero vias on OSC_IN / OSC_OUT nets
    const xtalVias = board.vias.filter((v) => xtalNets.has(v.net));
    if (xtalVias.length > 0) {
      out.push({
        ruleId: "PLINT-11",
        severity: "BLOCKER",
        category: "XTAL_TRACE_HAS_VIA",
        net: xtalVias[0].net,
        involvedPrimitives: [xtal.designator, ...xtalVias.map((v) => v.primitiveId)],
        locationMm: xtalVias[0].centerMm,
        layer: "MultiLayer",
        measuredValue: `${xtalVias.length} via(s) on crystal trace`,
        threshold: "0 vias on passive crystal clock nets",
        autoFixAction: "ROUTE_XTAL_SAME_LAYER_NO_VIA",
        prescription: `Remove via(s) on crystal clock net '${xtalVias[0].net}' and route on ${mountLayer} only.`,
      });
    }

    // 3. Closed GND guard ring on MountLayer around crystal
    const ringTracks = board.tracks.filter(
      (t) =>
        normalizeLayerName(t.layer) === mountLayer &&
        isGroundNetName(t.net) &&
        t.widthMm >= 0.2 &&
        distPointToRect(t.startMm, xtal.bboxMm) <= 3.5 &&
        distPointToRect(t.endMm, xtal.bboxMm) <= 3.5
    );
    const surroundsAllSides = checkGuardRingSurroundsBbox(ringTracks, xtal.bboxMm);
    if (!surroundsAllSides) {
      out.push({
        ruleId: "PLINT-11",
        severity: "BLOCKER",
        category: "XTAL_MISSING_GUARD_RING",
        involvedPrimitives: [xtal.designator],
        locationMm: xtal.centerMm,
        layer: mountLayer,
        measuredValue: `${ringTracks.length} GND ring segments (incomplete enclosure)`,
        threshold: "Closed >= 0.25mm GND guard ring on MountLayer",
        autoFixAction: "GENERATE_XTAL_GUARD_RING",
        prescription: `Add a closed >= 0.25mm GND guard ring with stitching vias around ${xtal.designator} on ${mountLayer}.`,
      });
    }

    // 4a. MountLayer projection keep-out for non-crystal signals/power
    const xtalPoly = rectToPoly(xtal.bboxMm[0], xtal.bboxMm[1], xtal.bboxMm[2], xtal.bboxMm[3]);
    for (const tr of board.tracks) {
      if (normalizeLayerName(tr.layer) !== mountLayer) continue;
      if (xtalNets.has(tr.net) || isGroundNetName(tr.net)) continue;
      const area = computePolygonOverlapAreaMm2(trackToPoly(tr.startMm, tr.endMm, tr.widthMm), xtalPoly);
      if (area > 1e-4) {
        out.push({
          ruleId: "PLINT-11",
          severity: "BLOCKER",
          category: "XTAL_MOUNT_LAYER_INTRUSION",
          net: tr.net,
          involvedPrimitives: [xtal.designator, tr.primitiveId],
          locationMm: tr.startMm,
          layer: mountLayer,
          measuredValue: `Foreign track '${tr.net}' overlaps ${mountLayer} crystal projection`,
          threshold: "0 non-crystal tracks under crystal on MountLayer",
          autoFixAction: "REROUTE_FOREIGN_TRACE_OUT_OF_XTAL_MOUNT",
          prescription: `Move foreign track '${tr.net}' away from ${xtal.designator} projection on ${mountLayer}.`,
        });
      }
    }

    // 4b. 4-layer+: check AdjacentRefLayer (Inner1) has continuous GND reference (NO split!),
    // while OppositeLayer (BottomLayer) is 100% ALLOWED for tracks, pours, and SMD passives!
    if (is4PlusLayers) {
      const refGndPours = board.pours.filter(
        (p) => normalizeLayerName(p.layer) === adjacentRefLayer && isGroundNetName(p.net)
      );
      const xtalArea = computePolygonAreaMm2(xtalPoly);
      const coveredRefArea = refGndPours.reduce(
        (sum, p) => sum + computePourOverlapAreaMm2(p, xtalPoly),
        0
      );
      const splitAcross = refGndPours.some((p) =>
        (p.splitSlots ?? []).some((s) =>
          segmentsDistance([s.x1, s.y1], [s.x2, s.y2], [xtal.bboxMm[0], xtal.bboxMm[1]], [xtal.bboxMm[2], xtal.bboxMm[3]]) < 0.5
        )
      );
      if (refGndPours.length === 0 || coveredRefArea < xtalArea * 0.85 || splitAcross) {
        out.push({
          ruleId: "PLINT-11",
          severity: "BLOCKER",
          category: "XTAL_ADJACENT_REF_PLANE_BROKEN",
          involvedPrimitives: [xtal.designator],
          locationMm: xtal.centerMm,
          layer: adjacentRefLayer,
          measuredValue: `GND coverage ${(coveredRefArea / Math.max(0.01, xtalArea) * 100).toFixed(0)}%, split=${splitAcross}`,
          threshold: "100% solid GND reference on AdjacentRefLayer (OppositeLayer allowed freely)",
          autoFixAction: "RESTORE_ADJACENT_GND_REFERENCE",
          prescription: `Ensure unbroken solid GND copper plane on ${adjacentRefLayer} underneath ${xtal.designator}.`,
        });
      }
    } else {
      // 2-layer board: OppositeLayer acts as sole adjacent reference layer -> forbid high-speed/power foreign tracks crossing under crystal
      for (const tr of board.tracks) {
        if (normalizeLayerName(tr.layer) !== adjacentRefLayer) continue;
        if (xtalNets.has(tr.net) || isGroundNetName(tr.net)) continue;
        const area = computePolygonOverlapAreaMm2(trackToPoly(tr.startMm, tr.endMm, tr.widthMm), xtalPoly);
        if (area > 1e-4) {
          out.push({
            ruleId: "PLINT-11",
            severity: "BLOCKER",
            category: "XTAL_2LAYER_BOTTOM_CROSSING",
            net: tr.net,
            involvedPrimitives: [xtal.designator, tr.primitiveId],
            locationMm: tr.startMm,
            layer: adjacentRefLayer,
            measuredValue: `Foreign trace '${tr.net}' crosses under 2-layer crystal on ${adjacentRefLayer}`,
            threshold: "0 non-GND traces cutting 2-layer local crystal ground island",
            autoFixAction: "REROUTE_2L_TRACE_AROUND_XTAL",
            prescription: `On 2-layer PCB, route '${tr.net}' around ${xtal.designator} so ${adjacentRefLayer} preserves local GND island.`,
          });
        }
      }
    }
  }
}

function checkGuardRingSurroundsBbox(
  ringTracks: PcbTrackGeom[],
  bbox: [number, number, number, number]
): boolean {
  if (ringTracks.length < 3) return false;
  const cx = (bbox[0] + bbox[2]) / 2;
  const cy = (bbox[1] + bbox[3]) / 2;
  let hasLeft = false;
  let hasRight = false;
  let hasTop = false;
  let hasBottom = false;

  for (const t of ringTracks) {
    const midX = (t.startMm[0] + t.endMm[0]) / 2;
    const midY = (t.startMm[1] + t.endMm[1]) / 2;
    const minX = Math.min(t.startMm[0], t.endMm[0]);
    const maxX = Math.max(t.startMm[0], t.endMm[0]);
    const minY = Math.min(t.startMm[1], t.endMm[1]);
    const maxY = Math.max(t.startMm[1], t.endMm[1]);

    if (minX <= bbox[0] + 0.2 && maxY >= cy && minY <= cy) hasLeft = true;
    if (maxX >= bbox[2] - 0.2 && maxY >= cy && minY <= cy) hasRight = true;
    if (maxY >= bbox[3] - 0.2 && maxX >= cx && minX <= cx) hasTop = true;
    if (minY <= bbox[1] + 0.2 && maxX >= cx && minX <= cx) hasBottom = true;
    if (midX < bbox[0] && Math.abs(t.startMm[1] - t.endMm[1]) > 0.5) hasLeft = true;
    if (midX > bbox[2] && Math.abs(t.startMm[1] - t.endMm[1]) > 0.5) hasRight = true;
    if (midY > bbox[3] && Math.abs(t.startMm[0] - t.endMm[0]) > 0.5) hasTop = true;
    if (midY < bbox[1] && Math.abs(t.startMm[0] - t.endMm[0]) > 0.5) hasBottom = true;
  }

  return hasLeft && hasRight && hasTop && hasBottom;
}

// ============================================================================
// PLINT-12: Brittle MLCC (>=0805), MEMS & VREF Mechanical/Thermal Stress Zones
// ============================================================================

function checkPlint12MechanicalAndThermalStress(
  board: PcbBoardGeometrySnapshot,
  resolver: CesmResolver,
  out: PlintFinding[]
): void {
  const { widthMm, heightMm, vCutLines = [], mouseBites = [] } = board.boardOutline;
  const mountingHoles = board.mountingHoles ?? [];

  const boardEdgeSegments: Array<{ a: [number, number]; b: [number, number]; label: string }> = [
    { a: [0, 0], b: [widthMm, 0], label: "BottomEdge" },
    { a: [widthMm, 0], b: [widthMm, heightMm], label: "RightEdge" },
    { a: [widthMm, heightMm], b: [0, heightMm], label: "TopEdge" },
    { a: [0, heightMm], b: [0, 0], label: "LeftEdge" },
    ...vCutLines.map((v, i) => ({ a: [v.x1, v.y1] as [number, number], b: [v.x2, v.y2] as [number, number], label: `V-Cut#${i + 1}` })),
  ];

  const heatSources = board.components.filter((c) => {
    const cat = getCompCategory(c, resolver);
    return (
      (c.thermalPowerW ?? 0) >= 0.3 ||
      ((cat === "PMIC_LDO" || cat === "PMIC_DCDC" || cat === "MOSFET_BJT") && (c.thermalPowerW ?? 0) >= 0.25)
    );
  });

  const relaysBuzzers = board.components.filter((c) => getCompCategory(c, resolver) === "RELAY_BUZZER");
  const connectors = board.components.filter((c) => {
    const cat = getCompCategory(c, resolver);
    return cat === "CONN_GENERIC" || cat === "CONN_USB_TYPEC";
  });

  const minDistToStressSources = (comp: PcbComponentGeom): { dist: number; source: string; isEdgeOrVcut: boolean; edgeDir?: [number, number] } => {
    let minD = Infinity;
    let source = "";
    let isEdgeOrVcut = false;
    let edgeDir: [number, number] | undefined;

    for (const seg of boardEdgeSegments) {
      const d = distPointToSegment(comp.centerMm, seg.a, seg.b);
      if (d < minD) {
        minD = d;
        source = seg.label;
        isEdgeOrVcut = true;
        const dx = seg.b[0] - seg.a[0];
        const dy = seg.b[1] - seg.a[1];
        const len = Math.hypot(dx, dy) || 1;
        edgeDir = [dx / len, dy / len];
      }
    }
    for (const mb of mouseBites) {
      const d = distPoints(comp.centerMm, [mb.xMm, mb.yMm]) - mb.radiusMm;
      if (d < minD) {
        minD = d;
        source = "MouseBite";
        isEdgeOrVcut = false;
      }
    }
    for (const mh of mountingHoles) {
      const d = distPoints(comp.centerMm, mh.centerMm) - mh.drillMm / 2;
      if (d < minD) {
        minD = d;
        source = `Hole:${mh.id}`;
        isEdgeOrVcut = false;
      }
    }
    for (const conn of connectors) {
      const d = distPointToRect(comp.centerMm, conn.bboxMm);
      if (d < minD) {
        minD = d;
        source = `Connector:${conn.designator}`;
        isEdgeOrVcut = false;
      }
    }
    return { dist: Math.max(0, minD), source, isEdgeOrVcut, edgeDir };
  };

  for (const comp of board.components) {
    const cat = getCompCategory(comp, resolver);
    const normPkg = normalizePackageCode(comp.package);
    const mpnUpper = `${comp.mpn ?? ""} ${comp.value ?? ""}`.toUpperCase();

    // A) Brittle >=0805 MLCC
    if (cat === "CAP_MLCC" && !comp.softTermination && ["0805", "1206", "1210", "2010", "2512"].includes(normPkg)) {
      const stress = minDistToStressSources(comp);
      if (stress.dist < 3.0) {
        out.push({
          ruleId: "PLINT-12",
          severity: "BLOCKER",
          category: "BRITTLE_MLCC_STRESS_ZONE",
          involvedPrimitives: [comp.designator],
          locationMm: comp.centerMm,
          layer: comp.layer,
          measuredValue: `${stress.dist.toFixed(2)} mm from ${stress.source}`,
          threshold: ">= 3.00 mm (or soft-termination MLCC)",
          autoFixAction: "MOVE_MLCC_AWAY_FROM_STRESS",
          prescription: `Move brittle ${normPkg} MLCC ${comp.designator} >= 3.0mm from ${stress.source} (or use soft-termination / dual 0603).`,
        });
      } else if (stress.isEdgeOrVcut && stress.dist < 5.0 && stress.edgeDir) {
        // Check if long axis is perpendicular to edge/V-cut
        const rad = (comp.rotationDeg * Math.PI) / 180;
        const w = comp.bboxMm[2] - comp.bboxMm[0];
        const h = comp.bboxMm[3] - comp.bboxMm[1];
        const axis: [number, number] =
          w >= h ? [Math.cos(rad), Math.sin(rad)] : [-Math.sin(rad), Math.cos(rad)];
        const dot = Math.abs(axis[0] * stress.edgeDir[0] + axis[1] * stress.edgeDir[1]);
        if (dot < 0.35) {
          out.push({
            ruleId: "PLINT-12",
            severity: "WARNING",
            category: "BRITTLE_MLCC_PERPENDICULAR_TO_EDGE",
            involvedPrimitives: [comp.designator],
            locationMm: comp.centerMm,
            layer: comp.layer,
            measuredValue: `Perpendicular to ${stress.source} at ${stress.dist.toFixed(2)} mm`,
            threshold: "Long axis parallel to board edge/V-Cut within 5.0 mm",
            autoFixAction: "ROTATE_MLCC_PARALLEL_TO_EDGE",
            prescription: `Rotate ${normPkg} MLCC ${comp.designator} 90° so its long axis runs parallel to ${stress.source}.`,
          });
        }
      }
    }

    // B) MEMS sensors
    const isMems =
      comp.sensorType === "MEMS" ||
      /\b(?:MPU|ICM|BMI|BMP|BME|LPS|LIS|SPH|INMP)\d/i.test(mpnUpper);
    if (isMems) {
      const stress = minDistToStressSources(comp);
      if (stress.dist < 5.0) {
        out.push({
          ruleId: "PLINT-12",
          severity: "BLOCKER",
          category: "MEMS_MECHANICAL_STRESS",
          involvedPrimitives: [comp.designator],
          locationMm: comp.centerMm,
          layer: comp.layer,
          measuredValue: `${stress.dist.toFixed(2)} mm from ${stress.source}`,
          threshold: ">= 5.00 mm",
          autoFixAction: "MOVE_MEMS_AWAY_FROM_STRESS",
          prescription: `Move MEMS sensor ${comp.designator} >= 5.0mm away from ${stress.source}.`,
        });
      }
      for (const rb of relaysBuzzers) {
        const d = distPoints(comp.centerMm, rb.centerMm);
        if (d < 10.0) {
          out.push({
            ruleId: "PLINT-12",
            severity: "BLOCKER",
            category: "MEMS_VIBRATION_ISOLATION",
            involvedPrimitives: [comp.designator, rb.designator],
            locationMm: comp.centerMm,
            layer: comp.layer,
            measuredValue: `${d.toFixed(2)} mm to ${rb.designator}`,
            threshold: ">= 10.0 mm",
            autoFixAction: "SEPARATE_MEMS_AND_RELAY",
            prescription: `Keep MEMS ${comp.designator} >= 10.0mm away from mechanical vibration source ${rb.designator}.`,
          });
        }
      }
    }

    // C) Precision VREF
    const isVref =
      comp.sensorType === "VREF" ||
      /\b(?:REF30|ADR45|LM4040|MAX6126)\b/i.test(mpnUpper);
    if (isVref) {
      const stress = minDistToStressSources(comp);
      if (stress.dist < 8.0) {
        out.push({
          ruleId: "PLINT-12",
          severity: "WARNING",
          category: "VREF_STRESS_ISOLATION",
          involvedPrimitives: [comp.designator],
          locationMm: comp.centerMm,
          layer: comp.layer,
          measuredValue: `${stress.dist.toFixed(2)} mm from ${stress.source}`,
          threshold: ">= 8.00 mm",
          autoFixAction: "MOVE_VREF_OR_ADD_STRESS_SLOT",
          prescription: `Keep precision reference ${comp.designator} >= 8.0mm from ${stress.source} or mill U-shaped stress slot.`,
        });
      }
    }

    // D) Temp/Humidity sensor thermal isolation >= 15.0 mm
    const isTempHumid =
      comp.sensorType === "TEMP_HUMIDITY" ||
      /\b(?:SHT3|SHT4|AHT20|HDC10|SI7021)\b/i.test(mpnUpper);
    if (isTempHumid) {
      for (const hs of heatSources) {
        if (hs.designator === comp.designator) continue;
        const d = distPoints(comp.centerMm, hs.centerMm);
        if (d < 15.0) {
          out.push({
            ruleId: "PLINT-12",
            severity: "BLOCKER",
            category: "TEMP_SENSOR_THERMAL_ISOLATION",
            involvedPrimitives: [comp.designator, hs.designator],
            locationMm: comp.centerMm,
            layer: comp.layer,
            measuredValue: `${d.toFixed(2)} mm to heat source ${hs.designator}`,
            threshold: ">= 15.0 mm",
            autoFixAction: "SEPARATE_TEMP_SENSOR_FROM_HEAT",
            prescription: `Separate temp/humidity sensor ${comp.designator} >= 15.0mm from heat source ${hs.designator} and add thermal slot.`,
          });
        }
      }
    }
  }
}

// ============================================================================
// PLINT-13: Power Bottleneck Width, Parallel Via Capacity & IR Drop (> 3%)
// ============================================================================

function computeIpc2221RequiredWidthMm(currentA: number, isInner: boolean, oz: number): number {
  if (currentA <= 0.1) return 0.15;
  const k = isInner ? 0.024 : 0.048;
  const dT = 15.0; // Table 9-6: W_IPC2221(I, deltaT=15C)
  const areaMil2 = Math.pow(currentA / (k * Math.pow(dT, 0.44)), 1 / 0.725);
  const thicknessMil = oz * 1.378;
  return (areaMil2 / thicknessMil) * 0.0254;
}

function getSingleViaSafeCurrentA(drillMm: number): number {
  if (drillMm <= 0.2) return 0.45;
  if (drillMm <= 0.3) return 0.45 + ((drillMm - 0.2) / 0.1) * 0.25; // 0.70A @ 0.3mm
  if (drillMm <= 0.4) return 0.7 + ((drillMm - 0.3) / 0.1) * 0.3; // 1.0A @ 0.4mm
  if (drillMm <= 0.5) return 1.0 + ((drillMm - 0.4) / 0.1) * 0.3; // 1.3A @ 0.5mm
  if (drillMm <= 0.8) return 1.3 + ((drillMm - 0.5) / 0.3) * 0.6; // 1.9A @ 0.8mm
  return 2.0;
}

function checkPlint13PowerWidthViasAndIrDrop(
  board: PcbBoardGeometrySnapshot,
  effectiveRules: ProjectDesignRules,
  copperOz: number,
  out: PlintFinding[]
): void {
  const netRules = board.constraintHandoff?.perNetRoutingRules ?? [];
  const netClassByNet = new Map<string, NetClassRule>();
  for (const nc of Object.values(effectiveRules.netClasses)) {
    for (const n of nc.nets) netClassByNet.set(n, nc);
  }

  // Gather power nets carrying specified current
  const powerNetCurrents = new Map<string, { currentA: number; vNom?: number }>();
  for (const rule of netRules) {
    if ((rule.maxCurrentA ?? 0) >= 0.3 && !isGroundNetName(rule.netName)) {
      const vNom = rule.voltageRangeV ? (rule.voltageRangeV.min + rule.voltageRangeV.max) / 2 : undefined;
      powerNetCurrents.set(rule.netName, { currentA: rule.maxCurrentA!, vNom });
    }
  }
  for (const [netName, nc] of netClassByNet.entries()) {
    if (!powerNetCurrents.has(netName) && !isGroundNetName(netName) && nc.minWidthMm >= 0.3) {
      powerNetCurrents.set(netName, { currentA: 1.0 });
    }
  }

  for (const [netName, { currentA, vNom }] of powerNetCurrents.entries()) {
    const netTracks = board.tracks.filter((t) => t.net === netName);
    if (netTracks.length === 0) continue;

    const projectClass = netClassByNet.get(netName);
    const projectMinW = projectClass?.minWidthMm ?? effectiveRules.defaultTraceWidthMm;

    // 1. Bottleneck track width check (skip short <1.2mm fine-pitch pad neckdowns)
    for (const tr of netTracks) {
      const isInner = normalizeLayerName(tr.layer).startsWith("Inner");
      const ipcW = computeIpc2221RequiredWidthMm(currentA, isInner, copperOz);
      const reqW = Math.max(projectMinW, ipcW);
      const segLen = distPoints(tr.startMm, tr.endMm);
      if (segLen > 1.2 && tr.widthMm < reqW - 0.01) {
        out.push({
          ruleId: "PLINT-13",
          severity: "BLOCKER",
          category: "POWER_TRACE_BOTTLENECK_WIDTH",
          net: netName,
          involvedPrimitives: [tr.primitiveId],
          locationMm: tr.startMm,
          layer: tr.layer,
          measuredValue: `W=${tr.widthMm.toFixed(3)} mm (I=${currentA.toFixed(2)}A)`,
          threshold: `>= ${reqW.toFixed(3)} mm (max(ProjectDRC=${projectMinW.toFixed(3)}, IPC2221=${ipcW.toFixed(3)}))`,
          autoFixAction: "WIDEN_POWER_TRACE",
          prescription: `Widen segment ${tr.primitiveId} on '${netName}' (${tr.layer}) from ${tr.widthMm}mm to >= ${reqW.toFixed(2)}mm.`,
        });
      }
    }

    // 2. Parallel via current capacity at layer transitions
    const netVias = board.vias.filter((v) => v.net === netName);
    const distinctLayers = new Set(netTracks.map((t) => normalizeLayerName(t.layer)));
    if (netVias.length > 0 && (distinctLayers.size >= 2 || currentA >= 1.0)) {
      // Cluster vias within 3.0mm of each other
      const visited = new Set<number>();
      for (let i = 0; i < netVias.length; i++) {
        if (visited.has(i)) continue;
        const cluster: PcbViaGeom[] = [netVias[i]];
        visited.add(i);
        for (let j = i + 1; j < netVias.length; j++) {
          if (!visited.has(j) && distPoints(netVias[i].centerMm, netVias[j].centerMm) <= 3.0) {
            cluster.push(netVias[j]);
            visited.add(j);
          }
        }
        // Only check clusters that actually bridge tracks on >= 2 distinct layers
        const nearLayers = new Set<string>();
        for (const v of cluster) {
          for (const tr of netTracks) {
            if (distPointToSegment(v.centerMm, tr.startMm, tr.endMm) <= 1.0) {
              nearLayers.add(normalizeLayerName(tr.layer));
            }
          }
        }
        if (nearLayers.size >= 2) {
          const totalCap = cluster.reduce((s, v) => s + getSingleViaSafeCurrentA(v.drillMm), 0);
          if (totalCap < 1.2 * currentA - 1e-6) {
            out.push({
              ruleId: "PLINT-13",
              severity: "BLOCKER",
              category: "VIA_CURRENT_BOTTLENECK",
              net: netName,
              involvedPrimitives: cluster.map((v) => v.primitiveId),
              locationMm: cluster[0].centerMm,
              layer: "MultiLayer",
              measuredValue: `${cluster.length} via(s), capacity=${totalCap.toFixed(2)}A for ${currentA.toFixed(2)}A`,
              threshold: `Total via capacity >= ${(1.2 * currentA).toFixed(2)}A`,
              autoFixAction: "INSERT_PARALLEL_VIA_ARRAY",
              prescription: `Expand via cluster on '${netName}' at (${cluster[0].centerMm[0].toFixed(1)}, ${cluster[0].centerMm[1].toFixed(1)}) to handle >= ${(1.2 * currentA).toFixed(2)}A.`,
            });
          }
        }
      }
    }

    // 3. Sheet Resistance IR Drop (> 3% of V_nom)
    if (vNom && vNom > 0 && vNom <= 15 && currentA >= 0.5) {
      const rSheet = 0.0005 / Math.max(0.5, copperOz); // 0.5 mOhm/sq @ 1oz
      const totalSquares = netTracks.reduce(
        (sum, tr) => sum + distPoints(tr.startMm, tr.endMm) / Math.max(0.05, tr.widthMm),
        0
      );
      const rPath = rSheet * totalSquares;
      const deltaV = currentA * rPath;
      const dropPct = (deltaV / vNom) * 100;
      if (dropPct > 3.0) {
        out.push({
          ruleId: "PLINT-13",
          severity: "BLOCKER",
          category: "SHEET_RESISTANCE_IR_DROP",
          net: netName,
          involvedPrimitives: netTracks.map((t) => t.primitiveId),
          locationMm: netTracks[0].startMm,
          layer: netTracks[0].layer,
          measuredValue: `ΔV=${(deltaV * 1000).toFixed(1)}mV (${dropPct.toFixed(2)}%, N_□=${totalSquares.toFixed(1)})`,
          threshold: "<= 3.0% of nominal rail voltage",
          autoFixAction: "WIDEN_OR_POUR_POWER_TRUNK",
          prescription: `IR drop on '${netName}' (${dropPct.toFixed(2)}%) exceeds 3%. Widen copper trace or convert to solid polygon pour.`,
        });
      }
    }
  }
}

// ============================================================================
// PLINT-14: High-Voltage Clearance, Creepage & Isolation Slot Check
// ============================================================================

function getRequiredHvClearance(vMax: number): { clearanceMm: number; creepageMm: number } {
  if (vMax <= 48) return { clearanceMm: 0.25, creepageMm: 0.25 };
  if (vMax <= 60) return { clearanceMm: 0.5, creepageMm: 0.6 };
  if (vMax <= 150) return { clearanceMm: 1.0, creepageMm: 1.5 };
  if (vMax <= 350) return { clearanceMm: 2.5, creepageMm: 3.0 }; // 220V AC L-N basic
  return { clearanceMm: 5.0, creepageMm: 6.4 };
}

function checkPlint14HighVoltageClearanceAndCreepage(
  board: PcbBoardGeometrySnapshot,
  effectiveRules: ProjectDesignRules,
  hypergraph: ElectricalHypergraph | undefined,
  stackup: string[],
  out: PlintFinding[]
): void {
  const hvNets = new Map<string, { vMax: number; domain?: string; reqClearance: number; reqCreepage: number }>();

  // Map NetClass overrides from Project DRC first
  const projectClassClearance = new Map<string, number>();
  for (const nc of Object.values(effectiveRules.netClasses)) {
    for (const n of nc.nets) {
      projectClassClearance.set(n, nc.minClearanceMm);
    }
  }

  for (const r of board.constraintHandoff?.perNetRoutingRules ?? []) {
    const vMax = r.voltageRangeV?.max ?? 0;
    if (vMax > 48 || r.requiresIsolationSlot) {
      const tbl = getRequiredHvClearance(vMax);
      const projClr = projectClassClearance.get(r.netName) ?? 0;
      hvNets.set(r.netName, {
        vMax,
        domain: r.isolationDomain,
        reqClearance: Math.max(projClr, r.minClearanceMm, tbl.clearanceMm),
        reqCreepage: Math.max(projClr, r.creepageDistanceMm ?? tbl.creepageMm),
      });
    }
  }

  if (hypergraph) {
    for (const [netName, edge] of hypergraph.nets.entries()) {
      if (!hvNets.has(netName) && edge.voltage.confidence !== "UNKNOWN" && edge.voltage.vMax > 48) {
        const tbl = getRequiredHvClearance(edge.voltage.vMax);
        const projClr = projectClassClearance.get(netName) ?? 0;
        hvNets.set(netName, {
          vMax: edge.voltage.vMax,
          domain: edge.isolationDomain,
          reqClearance: Math.max(projClr, tbl.clearanceMm),
          reqCreepage: Math.max(projClr, tbl.creepageMm),
        });
      }
    }
  }

  if (hvNets.size === 0) return;

  interface CopperElem {
    id: string;
    net: string;
    layer: string;
    center: [number, number];
    bbox: [number, number, number, number];
    segment?: [[number, number], [number, number], number];
  }

  const elems: CopperElem[] = [];
  for (const tr of board.tracks) {
    const hw = tr.widthMm / 2;
    elems.push({
      id: tr.primitiveId,
      net: tr.net,
      layer: normalizeLayerName(tr.layer),
      center: [(tr.startMm[0] + tr.endMm[0]) / 2, (tr.startMm[1] + tr.endMm[1]) / 2],
      bbox: [
        Math.min(tr.startMm[0], tr.endMm[0]) - hw,
        Math.min(tr.startMm[1], tr.endMm[1]) - hw,
        Math.max(tr.startMm[0], tr.endMm[0]) + hw,
        Math.max(tr.startMm[1], tr.endMm[1]) + hw,
      ],
      segment: [tr.startMm, tr.endMm, tr.widthMm],
    });
  }
  for (const comp of board.components) {
    for (const pad of comp.pads) {
      if (!pad.net) continue;
      elems.push({
        id: `${comp.designator}.${pad.padNumber}`,
        net: pad.net,
        layer: normalizeLayerName(pad.layer),
        center: pad.centerMm,
        bbox: [
          pad.centerMm[0] - pad.sizeMm[0] / 2,
          pad.centerMm[1] - pad.sizeMm[1] / 2,
          pad.centerMm[0] + pad.sizeMm[0] / 2,
          pad.centerMm[1] + pad.sizeMm[1] / 2,
        ],
      });
    }
  }

  const slots = board.boardOutline.isolationSlots ?? [];
  const reportedPairs = new Set<string>();

  for (let i = 0; i < elems.length; i++) {
    const a = elems[i];
    const hvA = hvNets.get(a.net);
    if (!hvA) continue;

    for (let j = 0; j < elems.length; j++) {
      if (i === j) continue;
      const b = elems[j];
      if (a.net === b.net) continue;
      const hvB = hvNets.get(b.net);

      // Determine cross-isolation vs same-primary HV requirement
      const crossIsolation =
        (hvA.domain && hvB?.domain && hvA.domain !== hvB.domain) ||
        (hvA.vMax > 150 && !hvB && !/(?:HV|AC|PRI|MAINS)/i.test(b.net));

      const pairKey = [a.id, b.id].sort().join("|");
      if (reportedPairs.has(pairKey)) continue;

      const reqClr = crossIsolation ? 5.0 : Math.max(hvA.reqClearance, hvB?.reqClearance ?? 0);
      const reqCreep = crossIsolation ? 6.4 : Math.max(hvA.reqCreepage, hvB?.reqCreepage ?? 0);

      // Check vertical overlap across layers for primary-vs-secondary (>150V reinforced insulation)
      const aLayers = resolvePrimitiveLayers(a.layer, stackup);
      const bLayers = resolvePrimitiveLayers(b.layer, stackup);
      const sameLayer = hasLayerIntersection(aLayers, bLayers);

      if (crossIsolation && !sameLayer) {
        const horizDist = computeElemsDistance(a, b);
        if (horizDist < 5.0) {
          reportedPairs.add(pairKey);
          out.push({
            ruleId: "PLINT-14",
            severity: "BLOCKER",
            category: "HV_CROSS_LAYER_OVERLAP",
            net: `${a.net} <-> ${b.net}`,
            involvedPrimitives: [a.id, b.id],
            locationMm: a.center,
            layer: `${a.layer}/${b.layer}`,
            measuredValue: `Vertical/inner horizontal separation = ${horizDist.toFixed(2)} mm`,
            threshold: ">= 5.00 mm reinforced isolation (no primary/secondary layer stacking)",
            autoFixAction: "SEPARATE_PRIMARY_SECONDARY_ZONES",
            prescription: `Primary HV '${a.net}' overlaps/approaches secondary '${b.net}' across layers (${horizDist.toFixed(2)}mm < 5.0mm). Keep primary and secondary strictly disjoint.`,
          });
        }
        continue;
      }

      if (!sameLayer) continue;

      const airClearance = computeElemsDistance(a, b);
      // Surface creepage check: an isolation slot >= 1.5mm intersecting the segment a->b increases creepage path
      const slotDetour = slots.some((sl) => sl.widthMm >= 1.5 && segmentCrossesPoly(a.center, b.center, sl.polygon2D));
      const effectiveCreepage = slotDetour ? airClearance + 4.0 : airClearance;

      if (airClearance < reqClr - 1e-3 || effectiveCreepage < reqCreep - 1e-3) {
        reportedPairs.add(pairKey);
        out.push({
          ruleId: "PLINT-14",
          severity: "BLOCKER",
          category: "HV_CLEARANCE_OR_CREEPAGE",
          net: `${a.net} <-> ${b.net}`,
          involvedPrimitives: [a.id, b.id],
          locationMm: a.center,
          layer: a.layer,
          measuredValue: `clearance=${airClearance.toFixed(2)}mm, creepage=${effectiveCreepage.toFixed(2)}mm`,
          threshold: `clearance >= ${reqClr.toFixed(2)}mm, creepage >= ${reqCreep.toFixed(2)}mm`,
          autoFixAction: "INCREASE_HV_SPACING_OR_ADD_SLOT",
          prescription: `Increase HV separation between '${a.net}' and '${b.net}' (or mill >= 1.5mm isolation slot).`,
        });
      }
    }
  }
}

function computeElemsDistance(
  a: { bbox: [number, number, number, number]; segment?: [[number, number], [number, number], number] },
  b: { bbox: [number, number, number, number]; segment?: [[number, number], [number, number], number] }
): number {
  if (a.segment && b.segment) {
    const centerDist = segmentsDistance(a.segment[0], a.segment[1], b.segment[0], b.segment[1]);
    return Math.max(0, centerDist - (a.segment[2] + b.segment[2]) / 2);
  }
  const dx = Math.max(0, Math.max(a.bbox[0] - b.bbox[2], b.bbox[0] - a.bbox[2]));
  const dy = Math.max(0, Math.max(a.bbox[1] - b.bbox[3], b.bbox[1] - a.bbox[3]));
  return Math.hypot(dx, dy);
}

function segmentCrossesPoly(p1: [number, number], p2: [number, number], poly: Array<[number, number]>): boolean {
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (segmentsIntersect2D(p1, p2, poly[j], poly[i])) return true;
  }
  return false;
}

// ============================================================================
// PLINT-15: Mounting Holes, Connector/FPC Front Clearance & Test Points
// ============================================================================

function checkPlint15MountingHoleConnectorAndTestPoints(
  board: PcbBoardGeometrySnapshot,
  out: PlintFinding[]
): void {
  const holeDefaults: Record<string, number> = { M2: 4.5, M2_5: 5.5, "M2.5": 5.5, M3: 7.0, M4: 9.0 };

  for (const hole of board.mountingHoles ?? []) {
    const reqDia = Math.max(
      hole.keepoutDiaMm ?? 0,
      holeDefaults[hole.size?.toUpperCase() ?? ""] ?? (hole.drillMm >= 4.0 ? 9.0 : hole.drillMm >= 3.0 ? 7.0 : hole.drillMm >= 2.5 ? 5.5 : 4.5)
    );
    const radius = reqDia / 2;

    for (const comp of board.components) {
      if (distPointToRect(hole.centerMm, comp.bboxMm) < radius - 1e-3) {
        out.push({
          ruleId: "PLINT-15",
          severity: "BLOCKER",
          category: "MOUNTING_HOLE_HEAD_COLLISION",
          involvedPrimitives: [hole.id, comp.designator],
          locationMm: comp.centerMm,
          layer: comp.layer,
          measuredValue: `Component ${comp.designator} inside Ø${reqDia.toFixed(1)}mm screw-head keepout`,
          threshold: `>= Ø${reqDia.toFixed(1)} mm clearance around ${hole.id}`,
          autoFixAction: "PUSH_COMPONENT_OUT_OF_HOLE_KEEPOUT",
          prescription: `Move ${comp.designator} outside Ø${reqDia.toFixed(1)}mm mounting hole keep-out around ${hole.id}.`,
        });
      }
    }

    for (const tr of board.tracks) {
      if (hole.isGrounded && isGroundNetName(tr.net)) continue;
      if (normalizeLayerName(tr.layer).startsWith("Inner")) continue;
      if (distPointToSegment(hole.centerMm, tr.startMm, tr.endMm) - tr.widthMm / 2 < radius - 1e-3) {
        out.push({
          ruleId: "PLINT-15",
          severity: "BLOCKER",
          category: "MOUNTING_HOLE_TRACE_COLLISION",
          net: tr.net,
          involvedPrimitives: [hole.id, tr.primitiveId],
          locationMm: tr.startMm,
          layer: tr.layer,
          measuredValue: `Surface track '${tr.net}' enters Ø${reqDia.toFixed(1)}mm screw-head keepout`,
          threshold: `>= Ø${reqDia.toFixed(1)} mm clearance`,
          autoFixAction: "REROUTE_AROUND_MOUNTING_HOLE",
          prescription: `Reroute exposed track '${tr.net}' outside Ø${reqDia.toFixed(1)}mm screw-head keep-out of ${hole.id}.`,
        });
      }
    }
  }

  // Connector / FPC / SD Card front operation clearance (>= 3.5 mm)
  for (const conn of board.components) {
    let opZone = conn.frontOperationZoneMm;
    if (!opZone && conn.frontClearanceMm && conn.frontClearanceMm > 0) {
      // Infer front zone along rotation angle (+X at 0°, +Y at 90°, -X at 180°, -Y at 270°)
      const clr = Math.max(3.5, conn.frontClearanceMm);
      const rot = ((conn.rotationDeg % 360) + 360) % 360;
      if (rot === 0) opZone = [conn.bboxMm[2], conn.bboxMm[1], conn.bboxMm[2] + clr, conn.bboxMm[3]];
      else if (rot === 90) opZone = [conn.bboxMm[0], conn.bboxMm[3], conn.bboxMm[2], conn.bboxMm[3] + clr];
      else if (rot === 180) opZone = [conn.bboxMm[0] - clr, conn.bboxMm[1], conn.bboxMm[0], conn.bboxMm[3]];
      else if (rot === 270) opZone = [conn.bboxMm[0], conn.bboxMm[1] - clr, conn.bboxMm[2], conn.bboxMm[1]];
    }
    if (!opZone) continue;

    for (const other of board.components) {
      if (other.designator === conn.designator) continue;
      if (normalizeLayerName(other.layer) !== normalizeLayerName(conn.layer)) continue;
      const overlap = computePolygonOverlapAreaMm2(
        rectToPoly(opZone[0], opZone[1], opZone[2], opZone[3]),
        rectToPoly(other.bboxMm[0], other.bboxMm[1], other.bboxMm[2], other.bboxMm[3])
      );
      if (overlap > 1e-4) {
        out.push({
          ruleId: "PLINT-15",
          severity: "BLOCKER",
          category: "CONNECTOR_FPC_OPERATION_CLEARANCE",
          involvedPrimitives: [conn.designator, other.designator],
          locationMm: other.centerMm,
          layer: other.layer,
          measuredValue: `${other.designator} blocks connector/FPC front zone`,
          threshold: ">= 3.5 mm unobstructed front clearance",
          autoFixAction: "CLEAR_CONNECTOR_FRONT_ZONE",
          prescription: `Move ${other.designator} out of ${conn.designator} >= 3.5mm plug/latch operation zone.`,
        });
      }
    }
  }

  // Test Points: single-sided & >= 2.5mm from tall components (H > 5.0mm)
  const testPoints = board.testPoints ?? [];
  if (testPoints.length > 0) {
    const tpLayers = new Set(testPoints.map((tp) => normalizeLayerName(tp.layer)));
    if (tpLayers.size > 1) {
      out.push({
        ruleId: "PLINT-15",
        severity: "BLOCKER",
        category: "TEST_POINT_DOUBLE_SIDED",
        involvedPrimitives: testPoints.map((t) => t.id),
        locationMm: testPoints[0].centerMm,
        layer: testPoints[0].layer,
        measuredValue: `Test points split across ${Array.from(tpLayers).join(", ")}`,
        threshold: "100% single-sided test points (default BottomLayer)",
        autoFixAction: "CONSOLIDATE_TEST_POINTS_ONE_SIDE",
        prescription: "Move all DFT test points onto a single board side (BottomLayer) to avoid dual-sided fixture.",
      });
    }
    for (const tp of testPoints) {
      for (const comp of board.components) {
        if ((comp.heightMm ?? 0) <= 5.0) continue;
        if (normalizeLayerName(comp.layer) !== normalizeLayerName(tp.layer)) continue;
        const d = distPointToRect(tp.centerMm, comp.bboxMm);
        if (d < 2.5) {
          out.push({
            ruleId: "PLINT-15",
            severity: "BLOCKER",
            category: "TEST_POINT_TALL_COMPONENT_COLLISION",
            involvedPrimitives: [tp.id, comp.designator],
            locationMm: tp.centerMm,
            layer: tp.layer,
            measuredValue: `${d.toFixed(2)} mm to tall ${comp.designator} (H=${comp.heightMm}mm)`,
            threshold: ">= 2.50 mm",
            autoFixAction: "MOVE_TEST_POINT_AWAY_FROM_TALL_PART",
            prescription: `Move test point ${tp.id} >= 2.5mm away from tall component ${comp.designator}.`,
          });
        }
      }
    }
  }
}

// ============================================================================
// PLINT-16: 0603 & Below (0603 / 0402 / 0201) Anti-Tombstoning Thermal Relief & Symmetry
// ============================================================================

function checkPlint16SmallPassiveThermalReliefAndSymmetry(
  board: PcbBoardGeometrySnapshot,
  out: PlintFinding[]
): void {
  const is0603OrBelow = (pkg: string): boolean => {
    const code = normalizePackageCode(pkg);
    return code === "0603" || code === "0402" || code === "0201";
  };

  for (const comp of board.components) {
    if (comp.pads.length !== 2) continue;
    if (!is0603OrBelow(comp.package)) continue;

    const p1 = comp.pads[0];
    const p2 = comp.pads[1];
    const layer = normalizeLayerName(comp.layer);

    // Check copper pour connections for Thermal Relief vs Direct Connect
    const p1InPour = board.pours.some(
      (pr) => normalizeLayerName(pr.layer) === layer && pr.net === p1.net && isPointInPour2D(p1.centerMm, pr)
    );
    const p2InPour = board.pours.some(
      (pr) => normalizeLayerName(pr.layer) === layer && pr.net === p2.net && isPointInPour2D(p2.centerMm, pr)
    );

    if (
      (p1InPour && p1.copperConnection === "DIRECT_CONNECT") ||
      (p2InPour && p2.copperConnection === "DIRECT_CONNECT")
    ) {
      out.push({
        ruleId: "PLINT-16",
        severity: "WARNING",
        category: "TOMBSTONING_MISSING_THERMAL_RELIEF",
        net: p1.copperConnection === "DIRECT_CONNECT" ? p1.net ?? undefined : p2.net ?? undefined,
        involvedPrimitives: [comp.designator],
        locationMm: comp.centerMm,
        layer,
        measuredValue: `Direct solid pour connection on ${normalizePackageCode(comp.package)} pad`,
        threshold: "Thermal Relief (4-spoke) required for 0603 / 0402 / 0201",
        autoFixAction: "ENABLE_THERMAL_RELIEF_SPOKES",
        prescription: `Set copper pour connection on ${comp.designator} (${comp.package}) pads to 4-spoke Thermal Relief to prevent tombstoning.`,
      });
    }

    // Track width symmetry check
    const maxTrackW = (pad: PcbPadGeom): number => {
      let maxW = 0;
      for (const tr of board.tracks) {
        if (tr.net !== pad.net || normalizeLayerName(tr.layer) !== layer) continue;
        if (
          distPoints(tr.startMm, pad.centerMm) <= Math.max(pad.sizeMm[0], pad.sizeMm[1]) ||
          distPoints(tr.endMm, pad.centerMm) <= Math.max(pad.sizeMm[0], pad.sizeMm[1])
        ) {
          maxW = Math.max(maxW, tr.widthMm);
        }
      }
      return maxW;
    };

    const w1 = maxTrackW(p1);
    const w2 = maxTrackW(p2);
    if (w1 > 0 && w2 > 0) {
      const ratio = Math.max(w1, w2) / Math.min(w1, w2);
      if (ratio > 2.5) {
        out.push({
          ruleId: "PLINT-16",
          severity: "WARNING",
          category: "TOMBSTONING_ASYMMETRIC_TRACE_WIDTH",
          involvedPrimitives: [comp.designator],
          locationMm: comp.centerMm,
          layer,
          measuredValue: `W1=${w1.toFixed(2)}mm vs W2=${w2.toFixed(2)}mm (ratio ${ratio.toFixed(2)}:1)`,
          threshold: "Pad trace width ratio <= 2.5:1 for 0603 / 0402 / 0201",
          autoFixAction: "BALANCE_PAD_EXIT_TRACE_WIDTH",
          prescription: `Equalize trace exit widths on both pads of ${comp.designator} (${comp.package}) to preserve thermal balance.`,
        });
      }
    }
  }
}

// ============================================================================
// PLINT-17: Datasheet Layout Example, Shunt Inner-Pad Tap & Forbid Blind Thermal Vias
// ============================================================================

function checkPlint17DatasheetLayoutShuntInnerAndBlindVias(
  board: PcbBoardGeometrySnapshot,
  stackup: string[],
  resolver: CesmResolver,
  out: PlintFinding[]
): void {
  const compByDes = new Map(board.components.map((c) => [c.designator, c]));

  // 1. Datasheet Layout Example compliance & DC-DC Hot Loop check
  for (const ds of board.constraintHandoff?.datasheetLayoutExamples ?? []) {
    const ic = compByDes.get(ds.designator);
    if (!ic) continue;
    const lex = ds.layoutExample;

    // Check copperZones maxAreaMm2 (e.g. SW_PH_COMPACT_ISLAND)
    for (const cz of lex.copperZones ?? []) {
      if (cz.maxAreaMm2 === undefined) continue;
      const targetNets = new Set(
        ic.pads
          .filter((p) => cz.connectedPins.includes(p.padNumber) || cz.connectedPins.includes(p.pinName ?? ""))
          .map((p) => p.net)
          .filter((n): n is string => Boolean(n))
      );
      for (const pour of board.pours) {
        if (!targetNets.has(pour.net)) continue;
        const area = computePourNetAreaMm2(pour);
        if (area > cz.maxAreaMm2) {
          out.push({
            ruleId: "PLINT-17",
            severity: "BLOCKER",
            category: "DATASHEET_LAYOUT_COPPER_AREA_EXCEEDED",
            net: pour.net,
            involvedPrimitives: [ic.designator, pour.primitiveId],
            locationMm: ic.centerMm,
            layer: pour.layer,
            measuredValue: `${cz.zoneRole} area=${area.toFixed(1)}mm²`,
            threshold: `<= ${cz.maxAreaMm2} mm² per ${lex.sourceSectionTitle ?? "Datasheet Layout Example"}`,
            autoFixAction: "SHRINK_SW_COPPER_ISLAND",
            prescription: `Shrink '${pour.net}' (${cz.zoneRole}) copper polygon to <= ${cz.maxAreaMm2}mm² per ${ic.designator} Datasheet Layout Example.`,
          });
        }
      }
    }

    // Check relativePlacementHints (same-layer & maxDistanceMm)
    for (const hint of lex.relativePlacementHints ?? []) {
      const targetPads = ic.pads.filter(
        (p) => hint.targetPins.includes(p.padNumber) || hint.targetPins.includes(p.pinName ?? "")
      );
      const hintNets = new Set(targetPads.map((p) => p.net).filter((n): n is string => Boolean(n) && !isGroundNetName(n)));
      if (hintNets.size === 0 || targetPads.length === 0) continue;

      const matchingSatellites = board.components.filter(
        (c) =>
          c.designator !== ic.designator &&
          c.pads.some((p) => p.net && hintNets.has(p.net)) &&
          matchesHintRole(c, hint.componentRole, resolver)
      );
      for (const sat of matchingSatellites) {
        if (hint.sameLayerMandatory !== false && normalizeLayerName(sat.layer) !== normalizeLayerName(ic.layer)) {
          out.push({
            ruleId: "PLINT-17",
            severity: "BLOCKER",
            category: "HOT_LOOP_OPPOSITE_LAYER_VIOLATION",
            involvedPrimitives: [ic.designator, sat.designator],
            locationMm: sat.centerMm,
            layer: sat.layer,
            measuredValue: `${sat.designator} on ${sat.layer} != ${ic.designator} on ${ic.layer}`,
            threshold: `Same layer mandatory per ${lex.sourceSectionTitle ?? "Datasheet Layout Example"}`,
            autoFixAction: "MOVE_HOT_LOOP_COMPONENT_TO_MOUNT_LAYER",
            prescription: `Place ${sat.designator} (${hint.componentRole}) on ${ic.layer} next to ${ic.designator} instead of opposite layer.`,
          });
        }
        const d = Math.min(...targetPads.map((tp) => distPoints(sat.centerMm, tp.centerMm)));
        if (d > hint.maxDistanceMm * 1.5 && d > 4.0) {
          out.push({
            ruleId: "PLINT-17",
            severity: "BLOCKER",
            category: "DATASHEET_LAYOUT_DISTANCE_EXCEEDED",
            involvedPrimitives: [ic.designator, sat.designator],
            locationMm: sat.centerMm,
            layer: sat.layer,
            measuredValue: `${d.toFixed(2)} mm`,
            threshold: `<= ${hint.maxDistanceMm.toFixed(2)} mm`,
            autoFixAction: "SNAP_PER_DATASHEET_LAYOUT_EXAMPLE",
            prescription: `Move ${sat.designator} (${hint.componentRole}) within ${hint.maxDistanceMm}mm of ${ic.designator} per Datasheet Layout Example.`,
          });
        }
      }
    }

    // Check sensitiveRouteConstraints (e.g., FB / VSENSE clearance from SW / Inductor)
    for (const sc of lex.sensitiveRouteConstraints ?? []) {
      const roleUp = sc.pinOrNetRole.trim().toUpperCase();
      if (!roleUp) continue;
      const sensPads = ic.pads.filter((p) => (p.pinName ?? "").trim().toUpperCase().includes(roleUp));
      const sensNets = new Set(sensPads.map((p) => p.net).filter((n): n is string => Boolean(n)));
      if (sensNets.size === 0) continue;

      const isSwPin = (p: PcbPadGeom): boolean => {
        if (p.elecType === "SW_NODE") return true;
        const pinUp = (p.pinName ?? "").trim().toUpperCase();
        if (!pinUp) return false;
        return /(?:^|_)(?:SW|PH|PHASE|LX)\d*(?:_|$)/.test(pinUp);
      };

      const aggressorPads = ic.pads.filter((p) => {
        const pinUp = (p.pinName ?? "").trim().toUpperCase();
        return sc.keepAwayFromRoles.some((r) => {
          const rUp = r.trim().toUpperCase();
          if (!rUp) return false;
          if (/(?:^|_)(?:SW|PH|PHASE|LX)\d*(?:_|$)|SW_NODE/.test(rUp)) {
            return (
              isSwPin(p) ||
              (lex.copperZones ?? []).some(
                (cz) =>
                  cz.zoneRole.toUpperCase() === rUp &&
                  (cz.connectedPins.includes(p.padNumber) || (p.pinName ? cz.connectedPins.includes(p.pinName) : false))
              )
            );
          }
          return pinUp.length > 0 && pinUp.includes(rUp);
        });
      });
      const aggNets = new Set(
        aggressorPads
          .map((p) => p.net)
          .filter((n): n is string => typeof n === "string" && n.length > 0 && !isGroundNetName(n) && !sensNets.has(n))
      );

      for (const sTr of board.tracks.filter((t) => sensNets.has(t.net))) {
        for (const aTr of board.tracks.filter(
          (t) => t.net !== sTr.net && aggNets.has(t.net) && normalizeLayerName(t.layer) === normalizeLayerName(sTr.layer)
        )) {
          const d = segmentsDistance(sTr.startMm, sTr.endMm, aTr.startMm, aTr.endMm);
          if (d < sc.minClearanceMm) {
            out.push({
              ruleId: "PLINT-17",
              severity: "BLOCKER",
              category: "SENSITIVE_FB_NEAR_SW_AGGRESSOR",
              net: sTr.net,
              involvedPrimitives: [ic.designator, sTr.primitiveId, aTr.primitiveId],
              locationMm: sTr.startMm,
              layer: sTr.layer,
              measuredValue: `${d.toFixed(2)} mm to SW '${aTr.net}'`,
              threshold: `>= ${sc.minClearanceMm.toFixed(2)} mm`,
              autoFixAction: "REROUTE_FB_AWAY_FROM_SW",
              prescription: `Route sensitive feedback '${sTr.net}' >= ${sc.minClearanceMm}mm away from switching node '${aTr.net}'.`,
            });
          }
        }
      }
    }
  }

  // 2. Shunt resistor inner-pad sense tap check (Low-side single-ended OR High-side dual-ended, NO guard ring!)
  const shuntSenseNets = new Set(
    (board.constraintHandoff?.emiRoleTags ?? [])
      .filter((t) => t.role === "SHUNT_KELVIN_SENSE")
      .map((t) => t.netName)
  );

  for (const comp of board.components) {
    if (getCompCategory(comp, resolver) !== "RES_SHUNT" || comp.pads.length < 2) continue;

    // 4-pin Kelvin shunt: check pad 3/4 sense tracks vs pad 1/2 main tracks
    const mainPads = comp.pads.slice(0, 2);
    const padCenterAvg: [number, number] = [
      (mainPads[0].centerMm[0] + mainPads[1].centerMm[0]) / 2,
      (mainPads[0].centerMm[1] + mainPads[1].centerMm[1]) / 2,
    ];

    for (const pad of mainPads) {
      if (!pad.net || isGroundNetName(pad.net)) continue;
      // Vector pointing INWARD from this pad toward resistor body center
      const inDx = padCenterAvg[0] - pad.centerMm[0];
      const inDy = padCenterAvg[1] - pad.centerMm[1];
      const inLen = Math.hypot(inDx, inDy) || 1;
      const uIn: [number, number] = [inDx / inLen, inDy / inLen];

      const padTracks = board.tracks.filter(
        (t) =>
          (t.net === pad.net || shuntSenseNets.has(t.net)) &&
          normalizeLayerName(t.layer) === normalizeLayerName(comp.layer)
      );

      // Identify thin sense tracks (width <= 0.40 mm) and heavy power trunk tracks (width >= 0.80 mm)
      const senseTracks = padTracks.filter((t) => t.widthMm <= 0.45);
      const powerTrunkTracks = padTracks.filter((t) => t.widthMm >= 0.8);
      if (senseTracks.length === 0 || powerTrunkTracks.length === 0) continue;

      // Find the sense track starting closest to the shunt pad / power trunk
      for (const st of senseTracks) {
        const dStartToPad = distPoints(st.startMm, pad.centerMm);
        const dEndToPad = distPoints(st.endMm, pad.centerMm);
        const nearPt = dStartToPad <= dEndToPad ? st.startMm : st.endMm;
        const farPt = dStartToPad <= dEndToPad ? st.endMm : st.startMm;
        const distNearToPad = Math.min(dStartToPad, dEndToPad);

        // Check if sense track taps onto the outer heavy power trunk AWAY from the shunt pad!
        const touchesPowerTrunk = powerTrunkTracks.some(
          (pt) => distPointToSegment(nearPt, pt.startMm, pt.endMm) <= pt.widthMm / 2 + 0.15
        );
        const outerProjection =
          (nearPt[0] - pad.centerMm[0]) * uIn[0] + (nearPt[1] - pad.centerMm[1]) * uIn[1];
        const padHalfExtent = Math.max(pad.sizeMm[0], pad.sizeMm[1]) / 2 + 0.3;

        // If the sense line taps off the outer trunk beyond the outer edge of the pad,
        // OR starts on the power trunk far from the pad (outerProjection < -padHalfExtent)
        const dirVec = [farPt[0] - nearPt[0], farPt[1] - nearPt[1]];
        const dirLen = Math.hypot(dirVec[0], dirVec[1]) || 1;
        const exitInwardDot = (dirVec[0] / dirLen) * uIn[0] + (dirVec[1] / dirLen) * uIn[1];

        const tapsOuterTrunk =
          touchesPowerTrunk &&
          ((distNearToPad > padHalfExtent && outerProjection < 0) ||
            (outerProjection < -padHalfExtent && exitInwardDot < -0.2));

        if (tapsOuterTrunk) {
          out.push({
            ruleId: "PLINT-17",
            severity: "BLOCKER",
            category: "SHUNT_OUTER_TRUNK_SENSE_TAP",
            net: st.net,
            involvedPrimitives: [comp.designator, st.primitiveId],
            locationMm: nearPt,
            layer: st.layer,
            measuredValue: `Sense trace taps outer high-current trunk ${distNearToPad.toFixed(2)}mm outside pad`,
            threshold: "Independent sense tap from inner edge of shunt pad (no guard ring needed)",
            autoFixAction: "REROUTE_SENSE_FROM_INNER_PAD_EDGE",
            prescription: `Disconnect sense trace ${st.primitiveId} from outer power trunk and tap independently from the inner edge of ${comp.designator}.${pad.padNumber} pad.`,
          });
        }
      }
    }
  }

  // 3. Forbid blind thermal vias on power rails / SW nodes / shunt main traces
  const swAndPowerNets = new Set<string>();
  for (const tag of board.constraintHandoff?.emiRoleTags ?? []) {
    if (tag.forbidBlindThermalVias || tag.role === "AGGRESSOR_SW_NODE" || tag.role === "POWER_RAIL") {
      swAndPowerNets.add(tag.netName);
    }
  }
  for (const r of board.constraintHandoff?.perNetRoutingRules ?? []) {
    if ((r.maxCurrentA ?? 0) >= 0.5 && !isGroundNetName(r.netName)) {
      swAndPowerNets.add(r.netName);
    }
  }
  for (const comp of board.components) {
    if (getCompCategory(comp, resolver) === "RES_SHUNT") {
      for (const p of comp.pads) {
        if (p.net && !isGroundNetName(p.net)) swAndPowerNets.add(p.net);
      }
    }
  }

  // Build IC static GND EPAD rectangles (ONLY legal place for thermal via arrays)
  const legalEpadRects: Array<{ designator: string; bbox: [number, number, number, number]; net: string | null }> = [];
  for (const comp of board.components) {
    for (const pad of comp.pads) {
      if (pad.isEpad && (!pad.net || isGroundNetName(pad.net))) {
        legalEpadRects.push({
          designator: comp.designator,
          net: pad.net,
          bbox: [
            pad.centerMm[0] - pad.sizeMm[0] / 2 - 0.3,
            pad.centerMm[1] - pad.sizeMm[1] / 2 - 0.3,
            pad.centerMm[0] + pad.sizeMm[0] / 2 + 0.3,
            pad.centerMm[1] + pad.sizeMm[1] / 2 + 0.3,
          ],
        });
      }
    }
  }

  for (const via of board.vias) {
    // Allow GND stitching / return vias and legal IC static GND EPAD thermal vias
    if (via.purpose === "GND_STITCH" || via.purpose === "RETURN_VIA") continue;
    const inLegalEpad = legalEpadRects.some(
      (ep) => isPointInsideRect(via.centerMm, ep.bbox) && (ep.net === null || ep.net === via.net)
    );
    if (inLegalEpad && via.purpose === "THERMAL_EPAD") continue;

    const isPowerOrSwOrShunt =
      swAndPowerNets.has(via.net) ||
      /^(?:SW|LX|PH|VIN|VBUS|VOUT|VCC|VDD|PWR|SHUNT|ISENSE)/i.test(via.net);
    if (!isPowerOrSwOrShunt || isGroundNetName(via.net)) continue;

    // Determine whether this via actually bridges tracks/pours across >= 2 copper layers
    const connectedLayers = new Set<string>();
    for (const tr of board.tracks) {
      if (tr.net !== via.net) continue;
      if (distPointToSegment(via.centerMm, tr.startMm, tr.endMm) <= Math.max(via.outerDiaMm / 2, tr.widthMm / 2) + 0.25) {
        connectedLayers.add(normalizeLayerName(tr.layer));
      }
    }
    for (const pour of board.pours) {
      if (pour.net !== via.net) continue;
      if (isPointInPour2D(via.centerMm, pour)) {
        connectedLayers.add(normalizeLayerName(pour.layer));
      }
    }
    for (const comp of board.components) {
      for (const pad of comp.pads) {
        if (pad.net !== via.net) continue;
        const pRect: [number, number, number, number] = [
          pad.centerMm[0] - pad.sizeMm[0] / 2 - 0.2,
          pad.centerMm[1] - pad.sizeMm[1] / 2 - 0.2,
          pad.centerMm[0] + pad.sizeMm[0] / 2 + 0.2,
          pad.centerMm[1] + pad.sizeMm[1] / 2 + 0.2,
        ];
        if (isPointInsideRect(via.centerMm, pRect)) {
          for (const pl of resolvePrimitiveLayers(pad.layer, stackup)) {
            connectedLayers.add(pl);
          }
        }
      }
    }

    const isExplicitBlindThermal = via.purpose === "BLIND_THERMAL_ON_POWER";
    const isSwNode = /^(?:SW|LX|PH)$/i.test(via.net);
    const notNeededForLayerTransition = connectedLayers.size <= 1;

    if (isExplicitBlindThermal || notNeededForLayerTransition || (isSwNode && !inLegalEpad)) {
      out.push({
        ruleId: "PLINT-17",
        severity: "BLOCKER",
        category: "FORBIDDEN_THERMAL_VIA_ON_POWER_LINE",
        net: via.net,
        involvedPrimitives: [via.primitiveId],
        locationMm: via.centerMm,
        layer: "MultiLayer",
        measuredValue: isSwNode
          ? `Via placed on switching node '${via.net}'`
          : `Blind/non-transition thermal via on power/shunt trace '${via.net}' (${connectedLayers.size} active layer)`,
        threshold: "0 blind thermal vias on power/SW/shunt traces (EPAD GND only)",
        autoFixAction: "REMOVE_BLIND_THERMAL_VIA",
        prescription: `Delete redundant/blind thermal via ${via.primitiveId} on '${via.net}' to avoid via stub ringing and shattering the GND reference plane.`,
      });
    }
  }
}

function matchesHintRole(comp: PcbComponentGeom, role: string, resolver: CesmResolver): boolean {
  const cat = getCompCategory(comp, resolver);
  const r = role.toUpperCase();
  if (r.includes("INDUCTOR")) return cat === "IND_POWER";
  if (r.includes("CIN") || r.includes("COUT") || r.includes("BOOT")) return cat === "CAP_MLCC" || cat === "CAP_AL_ELEC" || cat === "CAP_TANTALUM";
  if (r.includes("FB") || r.includes("COMP")) return cat === "RES_CHIP" || cat === "CAP_MLCC";
  return true;
}

// ============================================================================
// PLINT-18: Diff-Pair / High-Speed Split Crossing, Skew, >=3W Serpentine & Return Vias
// ============================================================================

function checkPlint18DiffPairAndMemoryIntegrity(
  board: PcbBoardGeometrySnapshot,
  stackup: string[],
  out: PlintFinding[]
): void {
  const diffTags = (board.constraintHandoff?.emiRoleTags ?? []).filter(
    (t) => t.role === "IMPEDANCE_CTRL_DIFF"
  );

  // Build differential pairs (P/N)
  const pairs: Array<{ pNet: string; nNet: string; maxSkewMm: number }> = [];
  const pairedNames = new Set<string>();
  const allNetNames = Array.from(new Set(board.tracks.map((t) => t.net)));

  for (const name of allNetNames) {
    if (pairedNames.has(name)) continue;
    if (isGroundNetName(name) || /^(?:VDD|VCC|PWR|VIN|VOUT|VBUS)/i.test(name)) continue;
    const matchP = name.match(/^(.+?)(_?DP|D\+|\+|_?P|_?H|_?A)$/i);
    if (!matchP) continue;
    const base = matchP[1];
    const suf = matchP[2].toUpperCase();
    const nCandidateSuffixes =
      suf.includes("DP") ? ["DM", "DN", "_DM", "_DN"] :
      suf === "+" || suf === "D+" ? ["-", "D-"] :
      suf.endsWith("P") ? [suf.replace(/P$/, "N")] :
      suf.endsWith("H") ? [suf.replace(/H$/, "L")] :
      [suf.replace(/A$/, "B")];

    for (const ns of nCandidateSuffixes) {
      const candidate = base + ns;
      if (allNetNames.includes(candidate)) {
        const tag = diffTags.find((t) => t.netName === name || t.netName === candidate);
        const defaultSkew =
          /USB3|HDMI|PCIE|MIPI/i.test(name) ? 0.125 :
          /ETH|MDI/i.test(name) ? 0.5 :
          /485|CAN/i.test(name) ? 2.5 : 1.25;
        pairs.push({ pNet: name, nNet: candidate, maxSkewMm: tag?.intraPairSkewMaxMm ?? defaultSkew });
        pairedNames.add(name);
        pairedNames.add(candidate);
        break;
      }
    }
  }

  const highSpeedNets = new Set([
    ...pairedNames,
    ...allNetNames.filter((n) => /^(?:QSPI|DDR|SDIO|CLK_|MCLK)/i.test(n)),
  ]);

  // 1. Reference plane split crossing
  for (const net of highSpeedNets) {
    const netTracks = board.tracks.filter((t) => t.net === net);
    for (const tr of netTracks) {
      const trLayer = normalizeLayerName(tr.layer);
      const refLayer =
        board.boardOutline.layerCount >= 4
          ? trLayer === "BottomLayer"
            ? stackup[stackup.length - 2]
            : stackup[1]
          : trLayer === "TopLayer"
            ? "BottomLayer"
            : "TopLayer";

      const refPours = board.pours.filter((p) => normalizeLayerName(p.layer) === refLayer);
      if (refPours.length === 0) continue;

      for (const pour of refPours) {
        for (const slot of pour.splitSlots ?? []) {
          if (segmentsIntersect2D(tr.startMm, tr.endMm, [slot.x1, slot.y1], [slot.x2, slot.y2])) {
            out.push({
              ruleId: "PLINT-18",
              severity: "BLOCKER",
              category: "DIFF_OR_HS_SPLIT_PLANE_CROSSING",
              net,
              involvedPrimitives: [tr.primitiveId, pour.primitiveId],
              locationMm: tr.startMm,
              layer: tr.layer,
              measuredValue: `Crosses split slot on ${refLayer}`,
              threshold: "0 split crossings on adjacent reference plane",
              autoFixAction: "BRIDGE_REFERENCE_SPLIT_OR_REROUTE",
              prescription: `High-speed trace '${net}' (${tr.primitiveId}) crosses a reference plane split on ${refLayer}. Route over solid unbroken GND plane.`,
            });
          }
        }
      }
    }
  }

  // 2. Intra-pair skew & layer-change companion GND return vias <= 1.0mm
  for (const pair of pairs) {
    const pTracks = board.tracks.filter((t) => t.net === pair.pNet);
    const nTracks = board.tracks.filter((t) => t.net === pair.nNet);
    const lenP = pTracks.reduce((s, t) => s + distPoints(t.startMm, t.endMm), 0);
    const lenN = nTracks.reduce((s, t) => s + distPoints(t.startMm, t.endMm), 0);
    const skew = Math.abs(lenP - lenN);
    if (pTracks.length > 0 && nTracks.length > 0 && skew > pair.maxSkewMm + 1e-6) {
      out.push({
        ruleId: "PLINT-18",
        severity: "BLOCKER",
        category: "DIFF_INTRA_PAIR_SKEW",
        net: `${pair.pNet}/${pair.nNet}`,
        involvedPrimitives: [pair.pNet, pair.nNet],
        locationMm: pTracks[0].startMm,
        layer: pTracks[0].layer,
        measuredValue: `skew=${skew.toFixed(3)} mm (L_P=${lenP.toFixed(2)}, L_N=${lenN.toFixed(2)})`,
        threshold: `<= ${pair.maxSkewMm.toFixed(3)} mm`,
        autoFixAction: "TUNE_DIFF_PAIR_LENGTH_AT_SOURCE",
        prescription: `Tune intra-pair skew on ${pair.pNet}/${pair.nNet} from ${skew.toFixed(3)}mm down to <= ${pair.maxSkewMm}mm near mismatch source.`,
      });
    }

    // Companion GND return vias within 1.0mm when diff pair changes layers
    const diffVias = board.vias.filter((v) => v.net === pair.pNet || v.net === pair.nNet);
    const gndVias = board.vias.filter((v) => isGroundNetName(v.net));
    for (const dv of diffVias) {
      const nearbyGndVias = gndVias.filter((gv) => distPoints(dv.centerMm, gv.centerMm) <= 1.0);
      if (nearbyGndVias.length < 2) {
        out.push({
          ruleId: "PLINT-18",
          severity: "BLOCKER",
          category: "DIFF_MISSING_RETURN_GND_VIAS",
          net: dv.net,
          involvedPrimitives: [dv.primitiveId],
          locationMm: dv.centerMm,
          layer: "MultiLayer",
          measuredValue: `${nearbyGndVias.length} GND return via(s) within 1.0mm`,
          threshold: ">= 2 symmetric GND return vias within 1.0mm of diff signal via",
          autoFixAction: "INSERT_SYMMETRIC_RETURN_GND_VIAS",
          prescription: `Place 2 symmetric GND return vias within 1.0mm of differential via ${dv.primitiveId} ('${dv.net}').`,
        });
      }
    }
  }

  // 3. Serpentine self-coupling spacing >= 3W
  for (const net of highSpeedNets) {
    const serpTracks = board.tracks.filter((t) => t.net === net && t.isSerpentine);
    for (let i = 0; i < serpTracks.length; i++) {
      for (let j = i + 1; j < serpTracks.length; j++) {
        const a = serpTracks[i];
        const b = serpTracks[j];
        if (normalizeLayerName(a.layer) !== normalizeLayerName(b.layer)) continue;
        // Skip directly connected consecutive segments
        if (
          distPoints(a.startMm, b.startMm) < 0.05 ||
          distPoints(a.startMm, b.endMm) < 0.05 ||
          distPoints(a.endMm, b.startMm) < 0.05 ||
          distPoints(a.endMm, b.endMm) < 0.05
        ) {
          continue;
        }
        const dirA = [a.endMm[0] - a.startMm[0], a.endMm[1] - a.startMm[1]];
        const dirB = [b.endMm[0] - b.startMm[0], b.endMm[1] - b.startMm[1]];
        const lenA = Math.hypot(dirA[0], dirA[1]) || 1;
        const lenB = Math.hypot(dirB[0], dirB[1]) || 1;
        const cosAngle = Math.abs((dirA[0] * dirB[0] + dirA[1] * dirB[1]) / (lenA * lenB));
        if (cosAngle > 0.95) {
          const pitch = segmentsDistance(a.startMm, a.endMm, b.startMm, b.endMm);
          const minPitch = 3.0 * Math.max(a.widthMm, b.widthMm);
          if (pitch < minPitch - 1e-3) {
            out.push({
              ruleId: "PLINT-18",
              severity: "BLOCKER",
              category: "SERPENTINE_SELF_COUPLING_LT_3W",
              net,
              involvedPrimitives: [a.primitiveId, b.primitiveId],
              locationMm: a.startMm,
              layer: a.layer,
              measuredValue: `pitch=${pitch.toFixed(3)} mm (< 3W=${minPitch.toFixed(3)} mm)`,
              threshold: ">= 3W center-to-center spacing",
              autoFixAction: "EXPAND_MEANDER_PITCH_TO_3W",
              prescription: `Widen serpentine meander spacing on '${net}' from ${pitch.toFixed(2)}mm to >= ${minPitch.toFixed(2)}mm (3W) to prevent crosstalk shortcutting.`,
            });
          }
        }
      }
    }
  }
}
