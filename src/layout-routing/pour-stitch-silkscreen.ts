import {
  Clipper,
  FillRule,
  Path64,
  Paths64,
  Point64,
} from "clipper2-js";
import RBush, { type BBox } from "rbush";
import type {
  FunctionalClusterOutput,
  Keepout25DFiveTuple,
  ProjectDesignRules,
} from "../types/index.js";
import { computeDiffPairPourClearanceMm } from "./diff-meander-router.js";
import type { RoutedTrack, RoutedVia } from "./freerouting-driver.js";
import type { FiducialMarker, PlacedComponent } from "./modular-placer.js";
import { getRotatedDims } from "./modular-placer.js";
import {
  classifyPackageCategory,
  fromClipperPath64,
  getSafetyClearanceSpec,
  normalizeProjectDesignRules,
  resolveStackupLayers,
  toClipperPath64,
} from "./spacing-keepout-matrix.js";

const CLIPPER_SCALE = 10_000;

export interface PourZoneRequest {
  net: string;
  layer: string;
  polygonMm?: "board_outline_inset" | Array<[number, number]>;
  insetMm?: number;
  clearanceMm?: number;
  spokeStyle?: "thermal_4" | "direct";
  removeIslands?: boolean;
  priority?: number;
}

export interface BuiltCopperPour {
  id: string;
  net: string;
  layer: string;
  polygonsMm: Array<Array<[number, number]>>;
  /** Negative interior hole rings (area >= 0.01 mm²) associated with kept outer polygons */
  holesMm?: Array<Array<[number, number]>>;
  /** Per-outer-ring grouped interior hole rings, indexed 1:1 with polygonsMm */
  polygonHolesMm?: Array<Array<Array<[number, number]>>>;
  totalAreaMm2: number;
  islandsRemoved: number;
  clearanceAppliedMm: number;
}

export interface PadPourStyleAssignment {
  designator: string;
  padNumber: string;
  footprint: string;
  net: string | null;
  connectStyle: "thermal_4" | "direct";
  spokeWidthMm: number;
  isSmallAntiTombstonePackage: boolean;
}

export interface StitchingViaOptions {
  enabled?: boolean;
  gridPitchMm?: number; // 5.0 ~ 8.0 mm
  boardEdgeFenceEnabled?: boolean;
  boardEdgePitchMm?: number; // 2.5 ~ 3.0 mm
  rfFencePitchMm?: number; // 1.0 ~ 1.5 mm
  rfTracks?: RoutedTrack[];
  drillMm?: number;
  outerDiaMm?: number;
  clearanceToTracksMm?: number;
}

export interface StitchingViaResult {
  viasPlaced: number;
  gridViasCount: number;
  edgeFenceViasCount: number;
  rfFenceViasCount: number;
  vias: RoutedVia[];
}

export interface PourAndStitchResult {
  poursRebuilt: number;
  islandsRemoved: number;
  pours: BuiltCopperPour[];
  padConnectionStyles: PadPourStyleAssignment[];
  smallPassiveThermalReliefCoverage: number; // 0..1, 1.0 = 100%
  stitchingViasPlaced: number;
  stitchingResult: StitchingViaResult;
  unpouredNetsWarning: string[];
}

export interface SilkscreenItem {
  designator: string;
  text: string;
  xMm: number;
  yMm: number;
  rotationDeg: 0 | 90;
  heightMm: number;
  strokeWidthMm: number;
  layer: "TopSilkscreen" | "BottomSilkscreen";
  padOverlapCleared: boolean;
  polarityMarkOutsideBody?: {
    markerType: "PIN1_DOT" | "ANODE_BAR" | "CATHODE_BAR" | "MINUS_SHADED";
    xMm: number;
    yMm: number;
  };
}

export interface SilkscreenTidyResult {
  adjustedDesignators: number;
  padOverlapCleared: number;
  polarityWarningsFixed: number;
  items: SilkscreenItem[];
}

interface SpatialBox extends BBox {
  tag: string;
}

function segmentToInflatedPath64(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  radiusMm: number
): Path64 {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy * radiusMm;
  const ny = ux * radiusMm;
  const ex = ux * radiusMm;
  const ey = uy * radiusMm;

  const pts: Array<[number, number]> = [
    [x1 - ex + nx, y1 - ey + ny],
    [x2 + ex + nx, y2 + ey + ny],
    [x2 + ex - nx, y2 + ey - ny],
    [x1 - ex - nx, y1 - ey - ny],
  ];
  return toClipperPath64(pts);
}

function rectToPath64(cx: number, cy: number, w: number, h: number): Path64 {
  const hw = w / 2;
  const hh = h / 2;
  return toClipperPath64([
    [cx - hw, cy - hh],
    [cx + hw, cy - hh],
    [cx + hw, cy + hh],
    [cx - hw, cy + hh],
  ]);
}

function circleToPath64(cx: number, cy: number, radiusMm: number, segs = 12): Path64 {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < segs; i++) {
    const th = (2 * Math.PI * i) / segs;
    pts.push([cx + radiusMm * Math.cos(th), cy + radiusMm * Math.sin(th)]);
  }
  return toClipperPath64(pts);
}

/** Exact ray-casting point-in-polygon check (avoids clipper2-js 1.2.4 pointInPolygon i===len bug). */
function isPointInsideOrOnPath64(pt: { x: number; y: number }, path: Path64): boolean {
  const n = path.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = path[i].x;
    const yi = path[i].y;
    const xj = path[j].x;
    const yj = path[j].y;

    // Check if point lies directly on segment (xj,yj)-(xi,yi)
    const dx = xi - xj;
    const dy = yi - yj;
    const cross = (pt.x - xj) * dy - (pt.y - yj) * dx;
    if (Math.abs(cross) <= 1) {
      const minX = Math.min(xi, xj);
      const maxX = Math.max(xi, xj);
      const minY = Math.min(yi, yj);
      const maxY = Math.max(yi, yj);
      if (pt.x >= minX && pt.x <= maxX && pt.y >= minY && pt.y <= maxY) {
        return true;
      }
    }

    const intersect =
      yi > pt.y !== yj > pt.y &&
      pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Exact inward polygon inset by insetMm (avoids clipper2-js 1.2.4 ClipperOffset edge-flip bug). */
function insetPolygonMm(poly: Array<[number, number]>, insetMm: number): Array<[number, number]> {
  if (poly.length < 3 || insetMm <= 0) return poly;
  let signedArea2 = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    signedArea2 += x1 * y2 - x2 * y1;
  }
  const orient = signedArea2 >= 0 ? 1 : -1;

  const edges: Array<{ ax: number; ay: number; dx: number; dy: number }> = [];
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const ex = x2 - x1;
    const ey = y2 - y1;
    const len = Math.hypot(ex, ey);
    if (len < 1e-6) continue;
    const ux = ex / len;
    const uy = ey / len;
    const nx = -uy * orient;
    const ny = ux * orient;
    edges.push({
      ax: x1 + nx * insetMm,
      ay: y1 + ny * insetMm,
      dx: ux,
      dy: uy,
    });
  }
  if (edges.length < 3) return poly;

  const out: Array<[number, number]> = [];
  for (let i = 0; i < edges.length; i++) {
    const e1 = edges[(i + edges.length - 1) % edges.length];
    const e2 = edges[i];
    const det = e1.dx * e2.dy - e1.dy * e2.dx;
    if (Math.abs(det) < 1e-6) {
      out.push([e2.ax, e2.ay]);
    } else {
      const rx = e2.ax - e1.ax;
      const ry = e2.ay - e1.ay;
      const t = (rx * e2.dy - ry * e2.dx) / det;
      out.push([e1.ax + t * e1.dx, e1.ay + t * e1.dy]);
    }
  }
  return out;
}

// ============================================================================
// 1. Dynamic Safety-Clearance Polygon Pour + Dead-Copper Island Removal
// ============================================================================

export function buildPolygonPours(
  clusterOutput: FunctionalClusterOutput,
  pours: PourZoneRequest[],
  placements: PlacedComponent[],
  tracks: RoutedTrack[],
  vias: RoutedVia[],
  options?: {
    projectRules?: Partial<ProjectDesignRules>;
    keepouts25D?: Keepout25DFiveTuple[];
    diffPairGapsMm?: Map<string, number>;
    netVoltagesV?: Map<string, number>;
    isolatedPrimaryNets?: Set<string>;
  }
): { pours: BuiltCopperPour[]; islandsRemoved: number; unpouredNetsWarning: string[] } {
  const outline = clusterOutput.board_outline;
  const W = outline.width_mm;
  const H = outline.height_mm;
  const rules = normalizeProjectDesignRules(options?.projectRules);
  const keepouts = options?.keepouts25D ?? [];

  const sortedPours = [...pours].sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1));
  const builtPours: BuiltCopperPour[] = [];
  let totalIslandsRemoved = 0;
  const unpouredNetsWarning: string[] = [];

  for (let pIdx = 0; pIdx < sortedPours.length; pIdx++) {
    const req = sortedPours[pIdx];
    const insetMm = req.insetMm ?? rules.boardOutlineClearanceMm ?? 0.4;
    const baseClearanceMm = req.clearanceMm ?? rules.pourClearanceMm ?? 0.25;

    // Build initial board boundary polygon
    const rawPoly: Array<[number, number]> =
      req.polygonMm && req.polygonMm !== "board_outline_inset"
        ? req.polygonMm
        : outline.shape === "POLYGON" && outline.polygon_mm && outline.polygon_mm.length >= 3
          ? outline.polygon_mm
          : [
              [0, 0],
              [W, 0],
              [W, H],
              [0, H],
            ];

    let subjectPaths = new Paths64();
    if (!req.polygonMm || req.polygonMm === "board_outline_inset") {
      const rawPaths = new Paths64();
      rawPaths.push(toClipperPath64(rawPoly));
      const insetCandidate = new Paths64();
      insetCandidate.push(toClipperPath64(insetPolygonMm(rawPoly, insetMm)));
      subjectPaths = Clipper.Intersect(insetCandidate, rawPaths, FillRule.NonZero);
    } else {
      subjectPaths.push(toClipperPath64(rawPoly));
    }

    const clipObstacles = new Paths64();

    // 1. Subtract 2.5D Keepouts ONLY if layerSet includes req.layer & disallowMask includes COPPER_POUR
    for (const ko of keepouts) {
      if (ko.polygon2D.length < 3) continue;
      if (!ko.disallowMask.includes("COPPER_POUR")) continue;
      if (ko.allowedNets.includes(req.net)) continue;

      const appliesToLayer =
        ko.layerSet.includes("ALL_COPPER_LAYERS") || ko.layerSet.includes(req.layer);
      if (!appliesToLayer) continue;

      clipObstacles.push(toClipperPath64(ko.polygon2D));
    }

    const clearanceForForeignNet = (foreignNet: string): number => {
      let c = baseClearanceMm;
      const diffGap = options?.diffPairGapsMm?.get(foreignNet);
      if (diffGap !== undefined) {
        c = Math.max(c, computeDiffPairPourClearanceMm(diffGap, 3.5));
      }
      const vForeign = options?.netVoltagesV?.get(foreignNet) ?? 5;
      const vPour = options?.netVoltagesV?.get(req.net) ?? 5;
      const crossIso =
        (options?.isolatedPrimaryNets?.has(foreignNet) && !options?.isolatedPrimaryNets?.has(req.net)) ||
        (options?.isolatedPrimaryNets?.has(req.net) && !options?.isolatedPrimaryNets?.has(foreignNet));
      const safety = getSafetyClearanceSpec(Math.max(vForeign, vPour), Boolean(crossIso), rules);
      c = Math.max(c, safety.outerSoldermaskClearanceMm);
      return c;
    };

    // 2. Subtract foreign-net tracks on the same layer
    for (const trk of tracks) {
      if (trk.layer !== req.layer || trk.net === req.net) continue;
      const clr = clearanceForForeignNet(trk.net);
      const rad = trk.widthMm / 2 + clr;
      for (let i = 1; i < trk.pointsMm.length; i++) {
        clipObstacles.push(
          segmentToInflatedPath64(
            trk.pointsMm[i - 1][0],
            trk.pointsMm[i - 1][1],
            trk.pointsMm[i][0],
            trk.pointsMm[i][1],
            rad
          )
        );
      }
    }

    // 3. Subtract foreign-net pads on the same mount layer
    for (const pl of placements) {
      const mountLayer = pl.side === "BOTTOM" ? "BottomLayer" : "TopLayer";
      if (req.layer !== mountLayer) continue;
      for (const pad of pl.pads) {
        if (pad.net === req.net) continue;
        const clr = pad.net ? clearanceForForeignNet(pad.net) : baseClearanceMm;
        clipObstacles.push(
          rectToPath64(pad.xMm, pad.yMm, pad.sizeMm[0] + 2 * clr, pad.sizeMm[1] + 2 * clr)
        );
      }
    }

    // 4. Subtract foreign-net vias (through-board vias span all layers)
    for (const via of vias) {
      if (via.net === req.net) continue;
      const clr = clearanceForForeignNet(via.net);
      clipObstacles.push(circleToPath64(via.xMm, via.yMm, via.outerDiaMm / 2 + clr, 10));
    }

    let finalPaths = subjectPaths;
    if (clipObstacles.length > 0 && subjectPaths.length > 0) {
      finalPaths = Clipper.Difference(subjectPaths, clipObstacles, FillRule.NonZero);
    }

    // Collect valid anchor points (pads & vias belonging to req.net on req.layer) to detect dead islands
    const anchorPts: Point64[] = [];
    for (const pl of placements) {
      const mountLayer = pl.side === "BOTTOM" ? "BottomLayer" : "TopLayer";
      if (req.layer !== mountLayer && !req.layer.startsWith("InnerLayer")) continue;
      if (req.layer === mountLayer) {
        for (const pad of pl.pads) {
          if (pad.net === req.net) {
            anchorPts.push(
              new Point64(Math.round(pad.xMm * CLIPPER_SCALE), Math.round(pad.yMm * CLIPPER_SCALE))
            );
          }
        }
      }
    }
    for (const via of vias) {
      if (via.net === req.net) {
        anchorPts.push(
          new Point64(Math.round(via.xMm * CLIPPER_SCALE), Math.round(via.yMm * CLIPPER_SCALE))
        );
      }
    }

    const keptOuterEntries: Array<{
      path: Path64;
      poly: Array<[number, number]>;
      areaMm2: number;
      holes: Array<Array<[number, number]>>;
    }> = [];
    const negativePaths: Path64[] = [];
    let removedHere = 0;
    let totalOuterAreaMm2 = 0;
    const removeIslands = req.removeIslands !== false;

    for (const path of finalPaths) {
      if (!Clipper.isPositive(path)) {
        negativePaths.push(path);
        continue;
      }
      const areaMm2 = Math.abs(Clipper.area(path)) / (CLIPPER_SCALE * CLIPPER_SCALE);
      if (areaMm2 < 0.05) {
        removedHere++;
        continue;
      }

      if (removeIslands && anchorPts.length > 0) {
        const hasAnchor = anchorPts.some((pt) => isPointInsideOrOnPath64(pt, path));
        if (!hasAnchor) {
          removedHere++;
          continue;
        }
      }

      keptOuterEntries.push({
        path,
        poly: fromClipperPath64(path),
        areaMm2,
        holes: [],
      });
      totalOuterAreaMm2 += areaMm2;
    }

    // Associate interior hole rings (area >= 0.01 mm²) with their tightest enclosing kept outer ring
    const keptHoles: Array<Array<[number, number]>> = [];
    let totalHoleAreaMm2 = 0;
    if (keptOuterEntries.length > 0 && negativePaths.length > 0) {
      const sortedOutersAsc = [...keptOuterEntries].sort((a, b) => a.areaMm2 - b.areaMm2);
      for (const holePath of negativePaths) {
        if (holePath.length < 3) continue;
        const holeAreaMm2 = Math.abs(Clipper.area(holePath)) / (CLIPPER_SCALE * CLIPPER_SCALE);
        if (holeAreaMm2 < 0.01) continue;

        const v0 = holePath[0];
        const v1 = holePath[1];
        const midPt = new Point64(Math.round((v0.x + v1.x) / 2), Math.round((v0.y + v1.y) / 2));

        const ownerOuter = sortedOutersAsc.find(
          (outer) =>
            outer.areaMm2 > holeAreaMm2 &&
            isPointInsideOrOnPath64(v0, outer.path) &&
            isPointInsideOrOnPath64(midPt, outer.path)
        );
        if (!ownerOuter) continue;

        const holeMm = fromClipperPath64(holePath);
        keptHoles.push(holeMm);
        ownerOuter.holes.push(holeMm);
        totalHoleAreaMm2 += holeAreaMm2;
      }
    }

    const keptPolygons = keptOuterEntries.map((e) => e.poly);
    const netAreaMm2 = Math.max(0, totalOuterAreaMm2 - totalHoleAreaMm2);

    totalIslandsRemoved += removedHere;
    if (keptPolygons.length === 0) {
      unpouredNetsWarning.push(req.net);
    }

    builtPours.push({
      id: `POUR_${pIdx + 1}_${req.layer}_${req.net}`,
      net: req.net,
      layer: req.layer,
      polygonsMm: keptPolygons,
      holesMm: keptHoles,
      polygonHolesMm: keptOuterEntries.map((e) => e.holes),
      totalAreaMm2: Number(netAreaMm2.toFixed(3)),
      islandsRemoved: removedHere,
      clearanceAppliedMm: baseClearanceMm,
    });
  }

  return {
    pours: builtPours,
    islandsRemoved: totalIslandsRemoved,
    unpouredNetsWarning,
  };
}

// ============================================================================
// 2. Mandatory 0603 & Below (0603/0402/0201) Anti-Tombstoning Thermal Relief
// ============================================================================

export function assignThermalReliefStyles(
  placements: PlacedComponent[],
  pours: PourZoneRequest[],
  options?: {
    datasheetDirectOverrides?: Set<string>; // e.g., "C_IN.1"
    spokeWidthMm?: number;
  }
): { assignments: PadPourStyleAssignment[]; smallPassiveThermalReliefCoverage: number } {
  const pouredNetLayers = new Set(pours.map((p) => `${p.layer}::${p.net}`));
  const directOverrides = options?.datasheetDirectOverrides ?? new Set<string>();
  const spokeWidthMm = options?.spokeWidthMm ?? 0.25;

  const assignments: PadPourStyleAssignment[] = [];
  let smallTotal = 0;
  let smallThermalCount = 0;

  for (const pl of placements) {
    const pkgCat = classifyPackageCategory(pl.footprint, pl.designator);
    const isTwoPin = pl.pads.length === 2;
    const isSmallPassive =
      isTwoPin && (pkgCat === "0603" || pkgCat === "0402" || pkgCat === "0201");
    const mountLayer = pl.side === "BOTTOM" ? "BottomLayer" : "TopLayer";

    for (const pad of pl.pads) {
      const key = `${pl.designator}.${pad.padNumber}`;
      const connectsToPour = Boolean(pad.net && pouredNetLayers.has(`${mountLayer}::${pad.net}`));

      if (isSmallPassive) {
        smallTotal++;
        // Mandatory thermal_4 for 0603 / 0402 / 0201 two-terminal components unless datasheet high-ripple override!
        const style: "thermal_4" | "direct" = directOverrides.has(key)
          ? "direct"
          : "thermal_4";
        if (style === "thermal_4") smallThermalCount++;

        assignments.push({
          designator: pl.designator,
          padNumber: pad.padNumber,
          footprint: pl.footprint,
          net: pad.net,
          connectStyle: style,
          spokeWidthMm: style === "thermal_4" ? spokeWidthMm : 0,
          isSmallAntiTombstonePackage: true,
        });
      } else if (connectsToPour) {
        const isHighCurrentBigPad =
          /EP|EPAD/i.test(pad.padNumber) ||
          pkgCat === "1206_PLUS" ||
          pkgCat === "THT" ||
          pl.role.includes("POWER_INDUCTOR") ||
          pl.role.includes("ANCHOR");
        assignments.push({
          designator: pl.designator,
          padNumber: pad.padNumber,
          footprint: pl.footprint,
          net: pad.net,
          connectStyle: isHighCurrentBigPad ? "direct" : "thermal_4",
          spokeWidthMm: isHighCurrentBigPad ? 0 : spokeWidthMm,
          isSmallAntiTombstonePackage: false,
        });
      }
    }
  }

  const coverage = smallTotal > 0 ? Number((smallThermalCount / smallTotal).toFixed(4)) : 1.0;
  return { assignments, smallPassiveThermalReliefCoverage: coverage };
}

// ============================================================================
// 3. RBush R-Tree Indexed GND Stitching Via Array & RF / Board-Edge Fence
// ============================================================================

export function placeGndStitchingVias(
  clusterOutput: FunctionalClusterOutput,
  placements: PlacedComponent[],
  tracks: RoutedTrack[],
  existingVias: RoutedVia[],
  keepouts25D: Keepout25DFiveTuple[],
  pours: BuiltCopperPour[],
  options?: StitchingViaOptions
): StitchingViaResult {
  if (options?.enabled === false) {
    return {
      viasPlaced: 0,
      gridViasCount: 0,
      edgeFenceViasCount: 0,
      rfFenceViasCount: 0,
      vias: [],
    };
  }

  const outline = clusterOutput.board_outline;
  const W = outline.width_mm;
  const H = outline.height_mm;
  const stackup = resolveStackupLayers(outline.layer_count, outline.stackup);
  const topLayer = stackup[0] ?? "TopLayer";
  const bottomLayer = stackup[stackup.length - 1] ?? "BottomLayer";

  const drillMm = options?.drillMm ?? 0.3;
  const outerDiaMm = options?.outerDiaMm ?? 0.6;
  const viaR = outerDiaMm / 2;
  const clearance = options?.clearanceToTracksMm ?? 0.5;
  // Obstacles are expanded by `clearance`; queryBox expands the candidate via by `viaR`
  // so collision occurs strictly when edge-to-edge distance < clearance (no double-counting of viaR!).
  const obsPad = clearance;

  const rtree = new RBush<SpatialBox>();
  const obstacles: SpatialBox[] = [];

  // Index tracks
  for (const t of tracks) {
    const pad = t.widthMm / 2 + obsPad;
    for (let i = 1; i < t.pointsMm.length; i++) {
      const [x1, y1] = t.pointsMm[i - 1];
      const [x2, y2] = t.pointsMm[i];
      obstacles.push({
        minX: Math.min(x1, x2) - pad,
        minY: Math.min(y1, y2) - pad,
        maxX: Math.max(x1, x2) + pad,
        maxY: Math.max(y1, y2) + pad,
        tag: `TRK_${t.net}`,
      });
    }
  }

  // Index pads
  for (const pl of placements) {
    for (const pad of pl.pads) {
      obstacles.push({
        minX: pad.xMm - pad.sizeMm[0] / 2 - obsPad,
        minY: pad.yMm - pad.sizeMm[1] / 2 - obsPad,
        maxX: pad.xMm + pad.sizeMm[0] / 2 + obsPad,
        maxY: pad.yMm + pad.sizeMm[1] / 2 + obsPad,
        tag: `PAD_${pl.designator}.${pad.padNumber}`,
      });
    }
  }

  // Index existing vias
  for (const v of existingVias) {
    const pad = v.outerDiaMm / 2 + obsPad;
    obstacles.push({
      minX: v.xMm - pad,
      minY: v.yMm - pad,
      maxX: v.xMm + pad,
      maxY: v.yMm + pad,
      tag: `VIA_${v.net}`,
    });
  }

  // Index 2.5D Keepouts that forbid VIA or PAD or COPPER_POUR across via span (e.g. RF antenna, HV isolation, mounting holes)
  for (const ko of keepouts25D) {
    if (ko.polygon2D.length < 3) continue;
    if (ko.allowedNets.includes("GND")) continue;
    if (
      !ko.disallowMask.includes("VIA") &&
      !ko.disallowMask.includes("PAD") &&
      !ko.layerSet.includes("ALL_COPPER_LAYERS")
    ) {
      // Single-layer TopLayer keepout on 4-layer board? Wait: a through-via penetrates TopLayer too!
      // So if TopLayer is in keepout.layerSet and disallowMask forbids VIA or TRACK/COPPER_POUR, avoid drilling via right through that keepout!
      if (!ko.disallowMask.includes("COPPER_POUR") && !ko.disallowMask.includes("TRACK")) continue;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of ko.polygon2D) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    obstacles.push({
      minX: minX - viaR,
      minY: minY - viaR,
      maxX: maxX + viaR,
      maxY: maxY + viaR,
      tag: `KO_${ko.id ?? "ZONE"}`,
    });
  }

  rtree.load(obstacles);

  const gndPourGeom = pours
    .filter((p) => p.net === "GND" && (p.layer === bottomLayer || p.layer === topLayer || p.layer.startsWith("InnerLayer")))
    .map((p) => ({
      outers: p.polygonsMm.map((poly) => toClipperPath64(poly)),
      holes: (p.holesMm ?? []).map((hole) => toClipperPath64(hole)),
    }))
    .filter((g) => g.outers.length > 0);

  const isInsideBoardAndGnd = (x: number, y: number): boolean => {
    if (x < 1.0 || x > W - 1.0 || y < 1.0 || y > H - 1.0) return false;
    if (gndPourGeom.length === 0) return true;
    const pt = new Point64(Math.round(x * CLIPPER_SCALE), Math.round(y * CLIPPER_SCALE));
    return gndPourGeom.some(
      (g) =>
        g.outers.some((path) => isPointInsideOrOnPath64(pt, path)) &&
        !g.holes.some((h) => isPointInsideOrOnPath64(pt, h))
    );
  };

  const placedVias: RoutedVia[] = [];
  let seq = 1;

  const tryPlaceVia = (x: number, y: number, prefix: string): boolean => {
    const rx = Number(x.toFixed(3));
    const ry = Number(y.toFixed(3));
    if (!isInsideBoardAndGnd(rx, ry)) return false;

    const queryBox: BBox = {
      minX: rx - viaR,
      minY: ry - viaR,
      maxX: rx + viaR,
      maxY: ry + viaR,
    };
    if (rtree.collides(queryBox)) return false;

    const via: RoutedVia = {
      id: `${prefix}_${seq++}`,
      net: "GND",
      xMm: rx,
      yMm: ry,
      drillMm,
      outerDiaMm,
      startLayer: topLayer,
      endLayer: bottomLayer,
    };
    placedVias.push(via);
    rtree.insert({
      minX: rx - viaR - obsPad,
      minY: ry - viaR - obsPad,
      maxX: rx + viaR + obsPad,
      maxY: ry + viaR + obsPad,
      tag: via.id,
    });
    return true;
  };

  // A. Global 5~8 mm Grid GND Stitching Array
  const gridPitch = Math.max(5.0, Math.min(8.0, options?.gridPitchMm ?? 6.0));
  let gridViasCount = 0;
  for (let y = 2.5; y <= H - 2.5; y += gridPitch) {
    for (let x = 2.5; x <= W - 2.5; x += gridPitch) {
      if (tryPlaceVia(x, y, "VIA_STITCH")) {
        gridViasCount++;
      }
    }
  }

  // B. Board-Edge Faraday Shielding Via Ring (2.5~3.0 mm pitch)
  let edgeFenceViasCount = 0;
  if (options?.boardEdgeFenceEnabled !== false) {
    const edgePitch = Math.max(2.0, Math.min(3.5, options?.boardEdgePitchMm ?? 2.8));
    const edgeInset = 1.2;
    for (let x = edgeInset; x <= W - edgeInset; x += edgePitch) {
      if (tryPlaceVia(x, edgeInset, "VIA_EDGE")) edgeFenceViasCount++;
      if (tryPlaceVia(x, H - edgeInset, "VIA_EDGE")) edgeFenceViasCount++;
    }
    for (let y = edgeInset + edgePitch; y <= H - edgeInset - edgePitch; y += edgePitch) {
      if (tryPlaceVia(edgeInset, y, "VIA_EDGE")) edgeFenceViasCount++;
      if (tryPlaceVia(W - edgeInset, y, "VIA_EDGE")) edgeFenceViasCount++;
    }
  }

  // C. 50-Ohm RF Via Fence (1.0~1.5 mm pitch along both sides of RF tracks)
  let rfFenceViasCount = 0;
  if (options?.rfTracks && options.rfTracks.length > 0) {
    const rfPitch = Math.max(1.0, Math.min(1.5, options?.rfFencePitchMm ?? 1.25));
    for (const trk of options.rfTracks) {
      const lateralOffset = trk.widthMm / 2 + clearance + viaR + 0.15;
      for (let i = 1; i < trk.pointsMm.length; i++) {
        const [x1, y1] = trk.pointsMm[i - 1];
        const [x2, y2] = trk.pointsMm[i];
        const segLen = Math.hypot(x2 - x1, y2 - y1);
        if (segLen < 0.5) continue;
        const ux = (x2 - x1) / segLen;
        const uy = (y2 - y1) / segLen;
        const nx = -uy;
        const ny = ux;
        const steps = Math.max(1, Math.floor(segLen / rfPitch));
        for (let s = 0; s <= steps; s++) {
          const px = x1 + ux * (s * rfPitch);
          const py = y1 + uy * (s * rfPitch);
          if (tryPlaceVia(px + nx * lateralOffset, py + ny * lateralOffset, "VIA_RF_FENCE")) {
            rfFenceViasCount++;
          }
          if (tryPlaceVia(px - nx * lateralOffset, py - ny * lateralOffset, "VIA_RF_FENCE")) {
            rfFenceViasCount++;
          }
        }
      }
    }
  }

  return {
    viasPlaced: placedVias.length,
    gridViasCount,
    edgeFenceViasCount,
    rfFenceViasCount,
    vias: placedVias,
  };
}

// ============================================================================
// 4. Unified Tier-3 Pour & Stitch Orchestrator
// ============================================================================

export function runPourAndStitch(
  clusterOutput: FunctionalClusterOutput,
  placements: PlacedComponent[],
  tracks: RoutedTrack[],
  vias: RoutedVia[],
  poursReq: PourZoneRequest[],
  options?: {
    projectRules?: Partial<ProjectDesignRules>;
    keepouts25D?: Keepout25DFiveTuple[];
    diffPairGapsMm?: Map<string, number>;
    netVoltagesV?: Map<string, number>;
    isolatedPrimaryNets?: Set<string>;
    datasheetDirectOverrides?: Set<string>;
    autoStitchGndVias?: StitchingViaOptions;
  }
): PourAndStitchResult {
  const pourRes = buildPolygonPours(clusterOutput, poursReq, placements, tracks, vias, options);
  const thermalRes = assignThermalReliefStyles(placements, poursReq, {
    datasheetDirectOverrides: options?.datasheetDirectOverrides,
  });
  const stitchRes = placeGndStitchingVias(
    clusterOutput,
    placements,
    tracks,
    vias,
    options?.keepouts25D ?? [],
    pourRes.pours,
    options?.autoStitchGndVias
  );

  return {
    poursRebuilt: pourRes.pours.length,
    islandsRemoved: pourRes.islandsRemoved,
    pours: pourRes.pours,
    padConnectionStyles: thermalRes.assignments,
    smallPassiveThermalReliefCoverage: thermalRes.smallPassiveThermalReliefCoverage,
    stitchingViasPlaced: stitchRes.viasPlaced,
    stitchingResult: stitchRes,
    unpouredNetsWarning: pourRes.unpouredNetsWarning,
  };
}

// ============================================================================
// 5. Silkscreen Tidy: 0°/90° Orientation + RBush Pad Avoidance + Polarity
// ============================================================================

export function tidySilkscreen(
  placements: PlacedComponent[],
  vias: RoutedVia[],
  fiducials: FiducialMarker[],
  clusterOutput: FunctionalClusterOutput,
  options?: {
    textHeightMm?: number;
    strokeWidthMm?: number;
    autoAvoidPadsClearanceMm?: number;
    enforcePolarityMarksOutsideBody?: boolean;
  }
): SilkscreenTidyResult {
  const textHeightMm = options?.textHeightMm ?? 1.0;
  const strokeWidthMm = options?.strokeWidthMm ?? 0.15;
  const padClearanceMm = options?.autoAvoidPadsClearanceMm ?? 0.15;
  const enforcePolarity = options?.enforcePolarityMarksOutsideBody ?? true;

  const W = clusterOutput.board_outline.width_mm;
  const H = clusterOutput.board_outline.height_mm;

  const topTree = new RBush<SpatialBox>();
  const botTree = new RBush<SpatialBox>();
  const topBoxes: SpatialBox[] = [];
  const botBoxes: SpatialBox[] = [];

  for (const pl of placements) {
    const arr = pl.side === "BOTTOM" ? botBoxes : topBoxes;
    for (const pad of pl.pads) {
      arr.push({
        minX: pad.xMm - pad.sizeMm[0] / 2 - padClearanceMm,
        minY: pad.yMm - pad.sizeMm[1] / 2 - padClearanceMm,
        maxX: pad.xMm + pad.sizeMm[0] / 2 + padClearanceMm,
        maxY: pad.yMm + pad.sizeMm[1] / 2 + padClearanceMm,
        tag: `PAD_${pl.designator}.${pad.padNumber}`,
      });
    }
  }

  for (const v of vias) {
    const r = v.outerDiaMm / 2 + padClearanceMm;
    const box = { minX: v.xMm - r, minY: v.yMm - r, maxX: v.xMm + r, maxY: v.yMm + r, tag: `VIA_${v.id}` };
    topBoxes.push(box);
    botBoxes.push(box);
  }

  for (const f of fiducials) {
    const r = f.solderMaskOpeningDiaMm / 2 + padClearanceMm;
    const arr = f.side === "BOTTOM" ? botBoxes : topBoxes;
    arr.push({ minX: f.xMm - r, minY: f.yMm - r, maxX: f.xMm + r, maxY: f.yMm + r, tag: f.id });
  }

  topTree.load(topBoxes);
  botTree.load(botBoxes);

  let adjustedDesignators = 0;
  let padOverlapCleared = 0;
  let polarityWarningsFixed = 0;
  const items: SilkscreenItem[] = [];

  for (const pl of placements) {
    const tree = pl.side === "BOTTOM" ? botTree : topTree;
    const layer = pl.side === "BOTTOM" ? "BottomSilkscreen" : "TopSilkscreen";
    const [rw, rh] = getRotatedDims(pl.bboxMm, pl.rotationDeg);

    // Strictly normalize reading orientation to 0° or 90° positive direction
    const mod180 = ((pl.rotationDeg % 180) + 180) % 180;
    const rot: 0 | 90 = mod180 >= 45 && mod180 < 135 ? 90 : 0;
    if (Math.abs(pl.rotationDeg - rot) > 1e-3) {
      adjustedDesignators++;
    }

    const makeBoxDims = (h: number, rDeg: 0 | 90): [number, number] => {
      const tw = Math.max(1.0, pl.designator.length * h * 0.62);
      return rDeg === 0 ? [tw, h] : [h, tw];
    };

    const isFree = (cx: number, cy: number, bw: number, bh: number): boolean => {
      if (cx - bw / 2 < 0.3 || cx + bw / 2 > W - 0.3 || cy - bh / 2 < 0.3 || cy + bh / 2 > H - 0.3) {
        return false;
      }
      return !tree.collides({
        minX: cx - bw / 2,
        minY: cy - bh / 2,
        maxX: cx + bw / 2,
        maxY: cy + bh / 2,
      });
    };

    let chosenRot: 0 | 90 = rot;
    let chosenHeight = textHeightMm;
    let [boxW, boxH] = makeBoxDims(chosenHeight, chosenRot);
    let chosenX = pl.xMm;
    let chosenY = pl.yMm + rh / 2 + boxH * 0.75 + 0.25;
    let cleared = isFree(chosenX, chosenY, boxW, boxH);

    if (!cleared) {
      const rotCandidates: Array<0 | 90> = [rot, rot === 0 ? 90 : 0];
      const heightCandidates = [textHeightMm, Math.max(0.75, textHeightMm * 0.78)];
      outer: for (const hCand of heightCandidates) {
        for (let r = 0.35; r <= 16.0; r += 0.45) {
          for (const rCand of rotCandidates) {
            const [bw, bh] = makeBoxDims(hCand, rCand);
            const cardinalOffsets: Array<[number, number]> = [
              [pl.xMm, pl.yMm + rh / 2 + bh / 2 + r],
              [pl.xMm, pl.yMm - rh / 2 - bh / 2 - r],
              [pl.xMm - rw / 2 - bw / 2 - r, pl.yMm],
              [pl.xMm + rw / 2 + bw / 2 + r, pl.yMm],
            ];
            for (let a = 0; a < 12; a++) {
              const theta = (2 * Math.PI * a) / 12;
              cardinalOffsets.push([
                pl.xMm + Math.cos(theta) * (Math.max(rw, rh) / 2 + Math.max(bw, bh) / 2 + r),
                pl.yMm + Math.sin(theta) * (Math.max(rw, rh) / 2 + Math.max(bw, bh) / 2 + r),
              ]);
            }
            for (const [cx, cy] of cardinalOffsets) {
              if (isFree(cx, cy, bw, bh)) {
                chosenX = Number(cx.toFixed(3));
                chosenY = Number(cy.toFixed(3));
                chosenRot = rCand;
                chosenHeight = Number(hCand.toFixed(2));
                boxW = bw;
                boxH = bh;
                cleared = true;
                padOverlapCleared++;
                adjustedDesignators++;
                break outer;
              }
            }
          }
        }
      }
    }

    // Reserve placed text bbox in tree so texts don't pile on each other
    tree.insert({
      minX: chosenX - boxW / 2,
      minY: chosenY - boxH / 2,
      maxX: chosenX + boxW / 2,
      maxY: chosenY + boxH / 2,
      tag: `SILK_${pl.designator}`,
    });

    // External polarity marker for polarized components & IC Pin 1
    let polarityMarkOutsideBody: SilkscreenItem["polarityMarkOutsideBody"];
    if (enforcePolarity) {
      const desU = pl.designator.toUpperCase();
      const fpU = pl.footprint.toUpperCase();
      if (/^(?:U|IC)\d+/.test(desU) || pl.pads.length >= 4) {
        const pin1 = pl.pads[0];
        if (pin1) {
          polarityMarkOutsideBody = {
            markerType: "PIN1_DOT",
            xMm: Number((pl.xMm - rw / 2 - 0.5).toFixed(3)),
            yMm: Number((pl.yMm - rh / 2 - 0.5).toFixed(3)),
          };
          polarityWarningsFixed++;
        }
      } else if (/TANT/i.test(fpU)) {
        polarityMarkOutsideBody = {
          markerType: "ANODE_BAR",
          xMm: Number((pl.xMm - rw / 2 - 0.45).toFixed(3)),
          yMm: pl.yMm,
        };
        polarityWarningsFixed++;
      } else if (/ELEC/i.test(fpU)) {
        polarityMarkOutsideBody = {
          markerType: "MINUS_SHADED",
          xMm: Number((pl.xMm + rw / 2 + 0.45).toFixed(3)),
          yMm: pl.yMm,
        };
        polarityWarningsFixed++;
      } else if (/^(?:D|LED|TVS)\d+/.test(desU)) {
        polarityMarkOutsideBody = {
          markerType: "CATHODE_BAR",
          xMm: Number((pl.xMm + rw / 2 + 0.4).toFixed(3)),
          yMm: pl.yMm,
        };
        polarityWarningsFixed++;
      }
    }

    items.push({
      designator: pl.designator,
      text: pl.designator,
      xMm: chosenX,
      yMm: chosenY,
      rotationDeg: chosenRot,
      heightMm: chosenHeight,
      strokeWidthMm,
      layer,
      padOverlapCleared: cleared,
      ...(polarityMarkOutsideBody ? { polarityMarkOutsideBody } : {}),
    });
  }

  return {
    adjustedDesignators,
    padOverlapCleared,
    polarityWarningsFixed,
    items,
  };
}
