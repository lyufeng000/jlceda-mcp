import type {
  CesmModel,
  CompiledComponent,
  CompiledNetlist,
  FunctionalCluster,
  FunctionalClusterOutput,
  Keepout25DFiveTuple,
  ProjectDesignRules,
} from "../types/index.js";
import {
  classifyPackageCategory,
  computeClipperIntersectionAreaMm2,
  computeFourDimensionalSpacingMm,
  generate25DKeepoutFiveTuples,
  normalizeProjectDesignRules,
  polygonFromRectMm,
  resolveStackupLayers,
  type SpacingComponentProfile,
} from "./spacing-keepout-matrix.js";

export interface FloorplanZoneInput {
  clusterId: string;
  zoneRectMm: [number, number, number, number]; // [minX, minY, maxX, maxY]
  preferredSide?: "TOP" | "BOTTOM";
}

export interface ExplicitComponentTransform {
  designator: string;
  xMm: number;
  yMm: number;
  rotationDeg: number;
  side?: "TOP" | "BOTTOM";
  locked?: boolean;
}

export interface PlacedPad {
  padNumber: string;
  net: string | null;
  xMm: number;
  yMm: number;
  sizeMm: [number, number];
}

export interface PlacedComponent {
  designator: string;
  clusterId: string;
  footprint: string;
  role: string;
  xMm: number;
  yMm: number;
  rotationDeg: number;
  side: "TOP" | "BOTTOM";
  bboxMm: [number, number];
  locked: boolean;
  placedByDatasheetExample: boolean;
  pads: PlacedPad[];
}

export interface FiducialMarker {
  id: string;
  xMm: number;
  yMm: number;
  side: "TOP" | "BOTTOM";
  copperDiaMm: number;
  solderMaskOpeningDiaMm: number;
}

export interface SpacingViolationReport {
  compA: string;
  compB: string;
  actualGapMm: number;
  requiredMinMm: number;
  reasons: string[];
}

export interface ClusterDispersionMetrics {
  meanDistMm: number;
  maxEdgeDistMm: number;
  centroidDispersionMm: number;
}

export interface ModularPlacementMetrics {
  totalHpwlMm: number;
  ratlineCrossingRatio: number;
  intraClusterDispersionMm: Record<string, ClusterDispersionMetrics>;
  overlapAreaMm2: number;
  totalRatlinesChecked: number;
  crossingPairsCount: number;
}

export interface ModularPlacerOptions {
  mode?: "macro_floorplan_solve" | "explicit_transform";
  floorplanZones?: FloorplanZoneInput[];
  transforms?: ExplicitComponentTransform[];
  projectRules?: Partial<ProjectDesignRules>;
  cesmLookup?:
    | Map<string, CesmModel>
    | ((designatorOrLcsc: string, comp?: CompiledComponent) => CesmModel | undefined);
  componentProfiles?: Record<string, Partial<SpacingComponentProfile>>;
  applyDatasheetLayoutExample?: boolean;
  useProjectDesignRulesFirst?: boolean;
  enforceSpacingMatrix?: boolean;
  gridStepMm?: 0.05 | 0.1;
  seed?: number;
}

export interface ModularPlacementResult {
  placedCount: number;
  placements: PlacedComponent[];
  floorplanZones: FloorplanZoneInput[];
  fiducials: FiducialMarker[];
  keepoutZones25D: Keepout25DFiveTuple[];
  datasheetLayoutAppliedClusters: string[];
  overlapCount: number;
  overlapAreaMm2: number;
  spacingViolations: SpacingViolationReport[];
  metrics: ModularPlacementMetrics;
  effectiveRules: ProjectDesignRules;
}

// ============================================================================
// Geometry & Pad Synthesis Helpers
// ============================================================================

export function snapToGridMm(val: number, gridMm = 0.05): number {
  return Number((Math.round(val / gridMm) * gridMm).toFixed(4));
}

export function getRotatedDims(bboxMm: [number, number], rotationDeg: number): [number, number] {
  const norm = ((Math.round(rotationDeg / 90) * 90) % 360 + 360) % 360;
  if (norm === 90 || norm === 270) {
    return [bboxMm[1], bboxMm[0]];
  }
  return [bboxMm[0], bboxMm[1]];
}

export function computeRotatedPads(
  comp: CompiledComponent | undefined,
  bboxMm: [number, number],
  xMm: number,
  yMm: number,
  rotationDeg: number,
  side: "TOP" | "BOTTOM"
): PlacedPad[] {
  const [w, h] = bboxMm;
  const pins = comp?.pins ?? [];
  const pinCount = Math.max(pins.length, 2);

  // Build local relative pad coordinates before rotation
  const localPads: Array<{ padNumber: string; net: string | null; lx: number; ly: number; sx: number; sy: number }> = [];

  if (pinCount === 2) {
    const padX = Math.max(0.25, w * 0.35);
    const p1 = pins[0];
    const p2 = pins[1];
    localPads.push({
      padNumber: p1?.pinNumber ?? "1",
      net: p1?.net ?? null,
      lx: -padX,
      ly: 0,
      sx: Math.max(0.3, w * 0.32),
      sy: Math.max(0.3, h * 0.8),
    });
    localPads.push({
      padNumber: p2?.pinNumber ?? "2",
      net: p2?.net ?? null,
      lx: padX,
      ly: 0,
      sx: Math.max(0.3, w * 0.32),
      sy: Math.max(0.3, h * 0.8),
    });
  } else if (pinCount === 3 || pinCount === 4) {
    // 4 corners / SOT-23-3 / XTAL-4P
    const corners: Array<[number, number]> = [
      [-w * 0.35, -h * 0.35],
      [w * 0.35, -h * 0.35],
      [w * 0.35, h * 0.35],
      [-w * 0.35, h * 0.35],
    ];
    for (let i = 0; i < pins.length; i++) {
      const [lx, ly] = corners[i % 4];
      localPads.push({
        padNumber: pins[i].pinNumber,
        net: pins[i].net,
        lx,
        ly,
        sx: Math.max(0.4, w * 0.25),
        sy: Math.max(0.4, h * 0.25),
      });
    }
  } else if (pinCount <= 16) {
    // Dual inline / SOT-23-6 / SOIC / Connector
    const half = Math.ceil(pins.length / 2);
    const pitchY = Math.max(0.5, (h * 0.8) / Math.max(1, half - 1));
    for (let i = 0; i < pins.length; i++) {
      const p = pins[i];
      if (/EP|EPAD|PAD/i.test(p.pinName) || p.pinNumber === "0" || p.pinNumber === "EP") {
        localPads.push({
          padNumber: p.pinNumber,
          net: p.net,
          lx: 0,
          ly: 0,
          sx: w * 0.45,
          sy: h * 0.45,
        });
        continue;
      }
      const isLeft = i < half;
      const idxOnSide = isLeft ? i : pins.length - 1 - i;
      const ly = (idxOnSide - (half - 1) / 2) * pitchY;
      const lx = isLeft ? -w * 0.42 : w * 0.42;
      localPads.push({
        padNumber: p.pinNumber,
        net: p.net,
        lx,
        ly,
        sx: Math.max(0.35, w * 0.22),
        sy: Math.min(0.45, pitchY * 0.6),
      });
    }
  } else {
    // QFP / QFN perimeter distribution + optional EPAD
    const epadPins = pins.filter(
      (p) => /EP|EPAD/i.test(p.pinName) || p.pinNumber === "EP" || p.pinNumber === "0"
    );
    const perimPins = pins.filter((p) => !epadPins.includes(p));
    const perSide = Math.ceil(perimPins.length / 4);

    for (let i = 0; i < perimPins.length; i++) {
      const p = perimPins[i];
      const sideIdx = Math.floor(i / perSide);
      const posIdx = i % perSide;
      const frac = perSide > 1 ? (posIdx / (perSide - 1) - 0.5) * 0.78 : 0;
      let lx = 0;
      let ly = 0;
      if (sideIdx === 0) {
        lx = -w * 0.48;
        ly = -frac * h;
      } else if (sideIdx === 1) {
        lx = frac * w;
        ly = h * 0.48;
      } else if (sideIdx === 2) {
        lx = w * 0.48;
        ly = frac * h;
      } else {
        lx = -frac * w;
        ly = -h * 0.48;
      }
      localPads.push({
        padNumber: p.pinNumber,
        net: p.net,
        lx,
        ly,
        sx: 0.35,
        sy: 0.35,
      });
    }
    for (const ep of epadPins) {
      localPads.push({
        padNumber: ep.pinNumber,
        net: ep.net,
        lx: 0,
        ly: 0,
        sx: w * 0.42,
        sy: h * 0.42,
      });
    }
  }

  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const mirrorX = side === "BOTTOM" ? -1 : 1;

  return localPads.map((lp) => {
    const mx = lp.lx * mirrorX;
    const rx = mx * cos - lp.ly * sin;
    const ry = mx * sin + lp.ly * cos;
    return {
      padNumber: lp.padNumber,
      net: lp.net,
      xMm: Number((xMm + rx).toFixed(4)),
      yMm: Number((yMm + ry).toFixed(4)),
      sizeMm: [Number(lp.sx.toFixed(3)), Number(lp.sy.toFixed(3))],
    };
  });
}

function resolveCesmForPlacement(
  designator: string,
  comp: CompiledComponent | undefined,
  lookup?: ModularPlacerOptions["cesmLookup"]
): CesmModel | undefined {
  if (!lookup) return undefined;
  if (typeof lookup === "function") {
    return lookup(designator, comp) ?? (comp?.lcscId ? lookup(comp.lcscId, comp) : undefined);
  }
  return lookup.get(designator) ?? (comp?.lcscId ? lookup.get(comp.lcscId) : undefined);
}

function buildSpacingProfile(
  designator: string,
  footprint: string,
  role: string,
  cluster: FunctionalCluster,
  comp: CompiledComponent | undefined,
  cesm: CesmModel | undefined,
  side: "TOP" | "BOTTOM",
  override?: Partial<SpacingComponentProfile>
): SpacingComponentProfile {
  const pkgCat = override?.packageCategory ?? classifyPackageCategory(footprint, designator);
  let emiAggressorRole: SpacingComponentProfile["emiAggressorRole"] = "NONE";
  let emiVictimRole: SpacingComponentProfile["emiVictimRole"] = "NONE";

  if (cluster.module_type === "DCDC_POWER_STAGE" && (role.includes("ANCHOR") || role.includes("INDUCTOR"))) {
    emiAggressorRole = "DCDC_SW_INDUCTOR";
  } else if (cluster.module_type === "LDO_REGULATOR" && role.includes("ANCHOR")) {
    emiAggressorRole = "POWER_MOS_LDO_RES";
  } else if (cluster.module_type === "ELECTROMECH_DRIVER" && role.includes("ANCHOR")) {
    emiAggressorRole = "RELAY_MOTOR_BUZZER";
  } else if (role.includes("EDGE_CONNECTOR") || pkgCat === "CONNECTOR_FPC") {
    emiAggressorRole = "BOARD_EDGE_HOLE_CONN";
  }

  if (role.includes("CRYSTAL")) {
    emiVictimRole = "PASSIVE_XTAL";
  } else if (cluster.module_type === "PRECISION_ANALOG_FE" && (role.includes("ANCHOR") || role.includes("SHUNT"))) {
    emiVictimRole = "PRECISION_OPAMP_SHUNT";
  } else if (cluster.module_type === "RF_ANTENNA_BLOCK") {
    emiVictimRole = "RF_ANTENNA_GNSS";
  } else if (pkgCat === "TALL_ELEC_CAP") {
    emiVictimRole = "AL_ELEC_CAP";
  } else if ((pkgCat === "0805" || pkgCat === "1206_PLUS") && /^C\d+/i.test(designator)) {
    emiVictimRole = "BRITTLE_MLCC";
  }

  return {
    designator,
    footprint,
    packageCategory: pkgCat,
    emiAggressorRole,
    emiVictimRole,
    maxVoltageV: cluster.max_voltage_v ?? 5,
    thermalPowerW: cluster.thermal_power_w ?? 0.1,
    netNames: comp?.pins.map((p) => p.net).filter((x): x is string => Boolean(x)) ?? [],
    mountSide: side,
    ...override,
  };
}

function segmentsProperlyIntersect(
  a1: [number, number],
  a2: [number, number],
  b1: [number, number],
  b2: [number, number]
): boolean {
  const cross = (o: [number, number], p: [number, number], q: [number, number]) =>
    (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);

  // Skip shared endpoints
  const samePt = (p: [number, number], q: [number, number]) =>
    Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-4;
  if (samePt(a1, b1) || samePt(a1, b2) || samePt(a2, b1) || samePt(a2, b2)) return false;

  const d1 = cross(a1, a2, b1);
  const d2 = cross(a1, a2, b2);
  const d3 = cross(b1, b2, a1);
  const d4 = cross(b1, b2, a2);
  return ((d1 > 1e-6 && d2 < -1e-6) || (d1 < -1e-6 && d2 > 1e-6)) &&
    ((d3 > 1e-6 && d4 < -1e-6) || (d3 < -1e-6 && d4 > 1e-6));
}

// ============================================================================
// Stage 2: Automatic Signal-Flow & EMI-Isolated Macro Floorplanning
// ============================================================================

function synthesizeMacroFloorplanZones(
  clusterOutput: FunctionalClusterOutput
): FloorplanZoneInput[] {
  const W = clusterOutput.board_outline.width_mm;
  const H = clusterOutput.board_outline.height_mm;
  const margin = 4.5;
  const clusters = clusterOutput.functional_clusters;

  // Deterministic slot assignment obeying signal flow & Table 8-2 diagonal separation:
  // LEFT_EDGE: HIGH_SPEED_IO_ESD
  // TOP_LEFT / MID_LEFT: DCDC_POWER_STAGE, LDO_REGULATOR
  // CENTER: MCU_DIGITAL_CORE, CLOCK_OSCILLATOR
  // TOP_RIGHT (CORNER): RF_ANTENNA_BLOCK
  // BOTTOM_RIGHT (diagonal away from DCDC!): PRECISION_ANALOG_FE
  // BOTTOM_LEFT / RIGHT_EDGE: ELECTROMECH_DRIVER
  const zones: FloorplanZoneInput[] = [];
  const innerW = W - 2 * margin;
  const innerH = H - 2 * margin;

  // Partition into a clean 3x2 / dynamic grid based on module count and affinity
  const edgeLeft = clusters.filter(
    (c) => c.edge_affinity === "LEFT_EDGE" || c.module_type === "HIGH_SPEED_IO_ESD"
  );
  const dcdcAndLdo = clusters.filter(
    (c) =>
      !edgeLeft.includes(c) &&
      (c.module_type === "DCDC_POWER_STAGE" || c.module_type === "LDO_REGULATOR")
  );
  const mcuCenter = clusters.filter(
    (c) =>
      !edgeLeft.includes(c) &&
      !dcdcAndLdo.includes(c) &&
      (c.module_type === "MCU_DIGITAL_CORE" || c.module_type === "CLOCK_OSCILLATOR")
  );
  const rfRight = clusters.filter(
    (c) =>
      !edgeLeft.includes(c) &&
      !dcdcAndLdo.includes(c) &&
      !mcuCenter.includes(c) &&
      c.module_type === "RF_ANTENNA_BLOCK"
  );
  const analogDiag = clusters.filter(
    (c) =>
      !edgeLeft.includes(c) &&
      !dcdcAndLdo.includes(c) &&
      !mcuCenter.includes(c) &&
      !rfRight.includes(c) &&
      c.module_type === "PRECISION_ANALOG_FE"
  );
  const driversAndOthers = clusters.filter(
    (c) =>
      !edgeLeft.includes(c) &&
      !dcdcAndLdo.includes(c) &&
      !mcuCenter.includes(c) &&
      !rfRight.includes(c) &&
      !analogDiag.includes(c)
  );

  const assignRowStack = (
    list: FunctionalCluster[],
    x0: number,
    x1: number,
    yStart: number,
    yEnd: number
  ) => {
    if (list.length === 0) return;
    const totalArea = list.reduce((acc, c) => acc + Math.max(20, c.estimated_area_mm2), 0);
    let curY = yStart;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const frac = Math.max(20, c.estimated_area_mm2) / totalArea;
      const nextY = i === list.length - 1 ? yEnd : curY + (yEnd - yStart) * frac;
      zones.push({
        clusterId: c.cluster_id,
        zoneRectMm: [
          Number(x0.toFixed(2)),
          Number(curY.toFixed(2)),
          Number(x1.toFixed(2)),
          Number(nextY.toFixed(2)),
        ],
        preferredSide: "TOP",
      });
      curY = nextY;
    }
  };

  const hasLeft = edgeLeft.length > 0;
  const hasPower = dcdcAndLdo.length > 0;
  const hasRight = rfRight.length + analogDiag.length + driversAndOthers.length > 0;

  const col1X0 = margin;
  const col1X1 = hasLeft ? margin + innerW * 0.23 : margin;

  const col2X0 = hasLeft ? col1X1 + 1.5 : margin;
  const col2X1 = hasPower ? col2X0 + innerW * 0.24 : col2X0;

  const col4X1 = W - margin;
  const col4X0 = hasRight ? col4X1 - innerW * 0.26 : col4X1;

  const col3X0 = hasPower ? col2X1 + 1.5 : hasLeft ? col1X1 + 1.5 : margin;
  const col3X1 = hasRight ? col4X0 - 1.5 : col4X1;

  // Right column: RF top-right, Drivers mid-right, Analog bottom-right (diagonal from DCDC top-left!)
  const rightOrdered = [...rfRight, ...driversAndOthers, ...analogDiag];
  assignRowStack(edgeLeft, col1X0, col1X1, margin, H - margin);
  assignRowStack(dcdcAndLdo, col2X0, col2X1, margin, H - margin);
  assignRowStack(mcuCenter, col3X0, col3X1, margin, H - margin);
  assignRowStack(rightOrdered, col4X0, col4X1, margin, H - margin);

  // Stage 2 Crossing Minimization: Sugiyama-style pairwise swap of vertical slot assignments
  // (keeping RF_ANTENNA_BLOCK pinned in corner and preserving DCDC vs Analog diagonal separation)
  const zoneById = new Map<string, FloorplanZoneInput>();
  zones.forEach((z) => zoneById.set(z.clusterId, z));

  const countCrossingsAndLen = () => {
    const segs: Array<{ a: [number, number]; b: [number, number]; w: number }> = [];
    let wLen = 0;
    for (const edge of clusterOutput.inter_cluster_edges) {
      const zA = zoneById.get(edge.from);
      const zB = zoneById.get(edge.to);
      if (!zA || !zB) continue;
      const a: [number, number] = [
        (zA.zoneRectMm[0] + zA.zoneRectMm[2]) / 2,
        (zA.zoneRectMm[1] + zA.zoneRectMm[3]) / 2,
      ];
      const b: [number, number] = [
        (zB.zoneRectMm[0] + zB.zoneRectMm[2]) / 2,
        (zB.zoneRectMm[1] + zB.zoneRectMm[3]) / 2,
      ];
      segs.push({ a, b, w: edge.weight });
      wLen += Math.hypot(a[0] - b[0], a[1] - b[1]) * edge.weight;
    }
    let crosses = 0;
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        if (segmentsProperlyIntersect(segs[i].a, segs[i].b, segs[j].a, segs[j].b)) {
          crosses++;
        }
      }
    }
    return crosses * 10000 + wLen;
  };

  const optimizeGroupOrder = (group: FunctionalCluster[]) => {
    if (group.length < 2) return;
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const ci = group[i];
          const cj = group[j];
          // Do not move RF_ANTENNA_BLOCK out of its corner or Analog into DCDC's horizontal band
          if (ci.module_type === "RF_ANTENNA_BLOCK" || cj.module_type === "RF_ANTENNA_BLOCK") {
            continue;
          }
          const zi = zoneById.get(ci.cluster_id)!;
          const zj = zoneById.get(cj.cluster_id)!;
          const before = countCrossingsAndLen();
          const tmp = zi.zoneRectMm;
          zi.zoneRectMm = zj.zoneRectMm;
          zj.zoneRectMm = tmp;
          const after = countCrossingsAndLen();
          if (after < before - 1e-4) {
            improved = true;
          } else {
            // revert
            zj.zoneRectMm = zi.zoneRectMm;
            zi.zoneRectMm = tmp;
          }
        }
      }
    }
  };

  for (let pass = 0; pass < 4; pass++) {
    optimizeGroupOrder(edgeLeft);
    optimizeGroupOrder(dcdcAndLdo);
    optimizeGroupOrder(mcuCenter);
    optimizeGroupOrder(rightOrdered);
  }

  // Also check swapping non-edge/non-RF adjacent column zones (e.g. col2 vs col4 drivers/analog) if crossing count drops
  const swappableClusters = clusters.filter(
    (c) =>
      c.edge_affinity !== "LEFT_EDGE" &&
      c.edge_affinity !== "CORNER" &&
      c.module_type !== "HIGH_SPEED_IO_ESD" &&
      c.module_type !== "RF_ANTENNA_BLOCK"
  );
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let i = 0; i < swappableClusters.length; i++) {
      for (let j = i + 1; j < swappableClusters.length; j++) {
        const ci = swappableClusters[i];
        const cj = swappableClusters[j];
        const zi = zoneById.get(ci.cluster_id)!;
        const zj = zoneById.get(cj.cluster_id)!;
        // Preserve DCDC vs Analog diagonal separation (do not put Analog adjacent to DCDC if they share a close column)
        const before = countCrossingsAndLen();
        const tmp = zi.zoneRectMm;
        zi.zoneRectMm = zj.zoneRectMm;
        zj.zoneRectMm = tmp;
        // Check Table 8-2 DCDC <-> Analog separation >= 12 mm
        const dcdcZ = zones.find((z) => {
          const cl = clusters.find((c) => c.cluster_id === z.clusterId);
          return cl?.module_type === "DCDC_POWER_STAGE";
        });
        const anaZ = zones.find((z) => {
          const cl = clusters.find((c) => c.cluster_id === z.clusterId);
          return cl?.module_type === "PRECISION_ANALOG_FE";
        });
        let violatesTable82 = false;
        if (dcdcZ && anaZ) {
          const d = Math.hypot(
            (dcdcZ.zoneRectMm[0] + dcdcZ.zoneRectMm[2]) / 2 - (anaZ.zoneRectMm[0] + anaZ.zoneRectMm[2]) / 2,
            (dcdcZ.zoneRectMm[1] + dcdcZ.zoneRectMm[3]) / 2 - (anaZ.zoneRectMm[1] + anaZ.zoneRectMm[3]) / 2
          );
          if (d < 15.0) violatesTable82 = true;
        }
        const after = countCrossingsAndLen();
        if (!violatesTable82 && after < before - 100) {
          changed = true;
        } else {
          zj.zoneRectMm = zi.zoneRectMm;
          zi.zoneRectMm = tmp;
        }
      }
    }
    if (!changed) break;
  }

  return zones;
}

// ============================================================================
// Stage 3 & 4: Main Modular Placer Solver
// ============================================================================

export function solveModularPlacement(
  clusterOutput: FunctionalClusterOutput,
  netlist: CompiledNetlist,
  options?: ModularPlacerOptions
): ModularPlacementResult {
  const mode = options?.mode ?? "macro_floorplan_solve";
  const gridStepMm = options?.gridStepMm ?? 0.05;
  const applyDatasheet = options?.applyDatasheetLayoutExample ?? true;
  const useProjectFirst = options?.useProjectDesignRulesFirst ?? true;
  const enforceSpacing = options?.enforceSpacingMatrix ?? true;

  const effectiveRules = normalizeProjectDesignRules(
    useProjectFirst ? options?.projectRules : undefined
  );

  const boardW = clusterOutput.board_outline.width_mm;
  const boardH = clusterOutput.board_outline.height_mm;
  const layerCount = clusterOutput.board_outline.layer_count;
  const stackup = resolveStackupLayers(layerCount, clusterOutput.board_outline.stackup);
  const edgeClearance = effectiveRules.boardOutlineClearanceMm;

  const compByDes = new Map<string, CompiledComponent>();
  for (const c of netlist.components) compByDes.set(c.designator, c);

  // Stage 1: Rigid mechanicals (mounting holes & Fiducials) & 2.5D Keepouts
  const fixedMechanicals = clusterOutput.board_outline.fixed_mechanicals ?? [];
  const keepoutZones25D: Keepout25DFiveTuple[] = [];
  const holeCircles: Array<{ id: string; xMm: number; yMm: number; radiusMm: number }> = [];

  for (const mech of fixedMechanicals) {
    const r = mech.keepout_dia_mm / 2;
    holeCircles.push({ id: mech.id, xMm: mech.x_mm, yMm: mech.y_mm, radiusMm: r });
    const poly: Array<[number, number]> = [];
    for (let k = 0; k < 20; k++) {
      const th = (2 * Math.PI * k) / 20;
      poly.push([
        Number((mech.x_mm + r * Math.cos(th)).toFixed(4)),
        Number((mech.y_mm + r * Math.sin(th)).toFixed(4)),
      ]);
    }
    keepoutZones25D.push(
      ...generate25DKeepoutFiveTuples({
        id: `KO_MECH_${mech.id}`,
        category: "MOUNTING_HOLE",
        ownerDesignator: mech.id,
        polygon2D: poly,
        mountSide: "TOP",
        layerCount,
        stackup,
      })
    );
  }

  // Generate 3 L-shaped asymmetric Fiducials avoiding mounting holes
  const fidOffset = Math.max(3.0, edgeClearance + 2.2);
  const fidCandidates: Array<[number, number]> = [
    [fidOffset + 6.0, fidOffset],
    [boardW - fidOffset - 6.0, fidOffset],
    [fidOffset + 6.0, boardH - fidOffset - 3.5],
  ];
  const fiducials: FiducialMarker[] = fidCandidates.map(([fx, fy], idx) => {
    let x = fx;
    let y = fy;
    for (const h of holeCircles) {
      if (Math.hypot(x - h.xMm, y - h.yMm) < h.radiusMm + 1.8) {
        x += idx === 1 ? -4.0 : 4.0;
      }
    }
    return {
      id: `FID${idx + 1}`,
      xMm: snapToGridMm(x, gridStepMm),
      yMm: snapToGridMm(y, gridStepMm),
      side: "TOP",
      copperDiaMm: 1.0,
      solderMaskOpeningDiaMm: 2.5,
    };
  });

  // Stage 2: Floorplan zones
  const floorplanZones =
    options?.floorplanZones && options.floorplanZones.length > 0
      ? options.floorplanZones
      : synthesizeMacroFloorplanZones(clusterOutput);

  const zoneByClusterId = new Map<string, FloorplanZoneInput>();
  for (const z of floorplanZones) zoneByClusterId.set(z.clusterId, z);

  const explicitByDes = new Map<string, ExplicitComponentTransform>();
  if (options?.transforms) {
    for (const t of options.transforms) explicitByDes.set(t.designator, t);
  }

  // Track internal placement entities
  interface MutableEntity {
    designator: string;
    clusterId: string;
    cluster: FunctionalCluster;
    member: FunctionalCluster["members"][number];
    comp?: CompiledComponent;
    cesm?: CesmModel;
    profile: SpacingComponentProfile;
    xMm: number;
    yMm: number;
    targetXMm: number;
    targetYMm: number;
    rotationDeg: number;
    side: "TOP" | "BOTTOM";
    bboxMm: [number, number];
    locked: boolean;
    isAnchor: boolean;
    placedByDatasheetExample: boolean;
    zoneRect: [number, number, number, number];
  }

  const entities: MutableEntity[] = [];
  const entityByDes = new Map<string, MutableEntity>();
  const datasheetLayoutAppliedClusters: string[] = [];

  // Pre-create entities and set Stage 3 initial placements
  for (const cluster of clusterOutput.functional_clusters) {
    const zone = zoneByClusterId.get(cluster.cluster_id) ?? {
      clusterId: cluster.cluster_id,
      zoneRectMm: [edgeClearance + 2, edgeClearance + 2, boardW - edgeClearance - 2, boardH - edgeClearance - 2] as [number, number, number, number],
      preferredSide: "TOP" as const,
    };
    const [zx0, zy0, zx1, zy1] = zone.zoneRectMm;
    const zCx = (zx0 + zx1) / 2;
    const zCy = (zy0 + zy1) / 2;

    const anchorMember =
      cluster.members.find((m) => m.designator === cluster.anchor_designator) ??
      cluster.members[0];
    const anchorComp = compByDes.get(anchorMember.designator);
    const anchorCesm = resolveCesmForPlacement(anchorMember.designator, anchorComp, options?.cesmLookup);

    // Determine anchor initial position & 4-way rotation optimization
    let anchorX = zCx;
    let anchorY = zCy;
    let anchorRot = 0;
    let anchorSide: "TOP" | "BOTTOM" = zone.preferredSide ?? "TOP";
    let anchorLocked = false;

    const expAnchor = explicitByDes.get(anchorMember.designator);
    if (expAnchor && (mode === "explicit_transform" || expAnchor.locked)) {
      anchorX = expAnchor.xMm;
      anchorY = expAnchor.yMm;
      anchorRot = expAnchor.rotationDeg;
      anchorSide = expAnchor.side ?? anchorSide;
      anchorLocked = expAnchor.locked ?? mode === "explicit_transform";
    } else if (
      anchorMember.role.includes("EDGE_CONNECTOR") ||
      (clusterOutput.rigid_edge_anchors?.includes(anchorMember.designator) &&
        cluster.edge_affinity !== "CENTER" &&
        cluster.edge_affinity !== "NONE")
    ) {
      // Stage 1: Rigid edge connector anchored cleanly inside board edge clearance (keep pads inside routable area!)
      const [bw, bh] = anchorMember.bbox_mm;
      const safeMargin = edgeClearance + 1.2;
      if (cluster.edge_affinity === "CORNER") {
        anchorX = boardW - bw / 2 - safeMargin - 2.0;
        anchorY = boardH - bh / 2 - safeMargin - 7.0;
        anchorRot = 0;
      } else if (cluster.edge_affinity === "RIGHT_EDGE") {
        anchorX = boardW - bw / 2 - safeMargin;
        anchorY = Math.min(Math.max(zCy, bh / 2 + 7), boardH - bh / 2 - 7);
        anchorRot = 180;
      } else if (cluster.edge_affinity === "TOP_EDGE") {
        anchorX = Math.min(Math.max(zCx, bw / 2 + 7), boardW - bw / 2 - 7);
        anchorY = boardH - bh / 2 - safeMargin;
        anchorRot = 270;
      } else if (cluster.edge_affinity === "BOTTOM_EDGE") {
        anchorX = Math.min(Math.max(zCx, bw / 2 + 7), boardW - bw / 2 - 7);
        anchorY = bh / 2 + safeMargin;
        anchorRot = 90;
      } else {
        // Default LEFT_EDGE
        anchorX = bw / 2 + safeMargin;
        anchorY = Math.min(Math.max(zCy, bh / 2 + 7), boardH - bh / 2 - 7);
        anchorRot = 0;
      }
      anchorLocked = true;
    } else {
      // 4-way rotation optimization (0, 90, 180, 270) minimizing Manhattan distance to connected external clusters
      const externalEdges = clusterOutput.inter_cluster_edges.filter(
        (e) => e.from === cluster.cluster_id || e.to === cluster.cluster_id
      );
      if (externalEdges.length > 0 && anchorComp) {
        let bestRot = 0;
        let bestScore = Infinity;
        for (const candRot of [0, 90, 180, 270]) {
          const pads = computeRotatedPads(anchorComp, anchorMember.bbox_mm, anchorX, anchorY, candRot, anchorSide);
          let score = 0;
          for (const edge of externalEdges) {
            const peerId = edge.from === cluster.cluster_id ? edge.to : edge.from;
            const peerZone = zoneByClusterId.get(peerId);
            if (!peerZone) continue;
            const px = (peerZone.zoneRectMm[0] + peerZone.zoneRectMm[2]) / 2;
            const py = (peerZone.zoneRectMm[1] + peerZone.zoneRectMm[3]) / 2;
            for (const pad of pads) {
              if (pad.net && edge.nets.includes(pad.net)) {
                score += (Math.abs(pad.xMm - px) + Math.abs(pad.yMm - py)) * edge.weight;
              }
            }
          }
          if (score < bestScore) {
            bestScore = score;
            bestRot = candRot;
          }
        }
        anchorRot = bestRot;
      }
    }

    // Push anchor out of any mounting hole keepout
    for (const h of holeCircles) {
      const dx = anchorX - h.xMm;
      const dy = anchorY - h.yMm;
      const d = Math.hypot(dx, dy);
      const minD = h.radiusMm + Math.hypot(anchorMember.bbox_mm[0], anchorMember.bbox_mm[1]) / 2 + 0.5;
      if (d < minD && !anchorLocked) {
        const ang = d > 1e-4 ? Math.atan2(dy, dx) : 0;
        anchorX = h.xMm + Math.cos(ang) * minD;
        anchorY = h.yMm + Math.sin(ang) * minD;
      }
    }

    const anchorEntity: MutableEntity = {
      designator: anchorMember.designator,
      clusterId: cluster.cluster_id,
      cluster,
      member: anchorMember,
      comp: anchorComp,
      cesm: anchorCesm,
      profile: buildSpacingProfile(
        anchorMember.designator,
        anchorMember.footprint,
        anchorMember.role,
        cluster,
        anchorComp,
        anchorCesm,
        anchorSide,
        options?.componentProfiles?.[anchorMember.designator]
      ),
      xMm: snapToGridMm(anchorX, gridStepMm),
      yMm: snapToGridMm(anchorY, gridStepMm),
      targetXMm: anchorX,
      targetYMm: anchorY,
      rotationDeg: anchorRot,
      side: anchorSide,
      bboxMm: anchorMember.bbox_mm,
      locked: anchorLocked,
      isAnchor: true,
      placedByDatasheetExample: false,
      zoneRect: zone.zoneRectMm,
    };
    entities.push(anchorEntity);
    entityByDes.set(anchorEntity.designator, anchorEntity);

    // Compute anchor rotated pads for topological snap-to-pin
    const anchorPads = computeRotatedPads(
      anchorComp,
      anchorMember.bbox_mm,
      anchorEntity.xMm,
      anchorEntity.yMm,
      anchorEntity.rotationDeg,
      anchorEntity.side
    );

    const assignedByHint = new Set<string>();
    const hintTargetCoords = new Map<string, { x: number; y: number; rot: number; side: "TOP" | "BOTTOM" }>();

    // Priority 1: Original Datasheet Layout Example relativePlacementHints
    if (applyDatasheet && anchorCesm?.layoutExample?.relativePlacementHints?.length) {
      let appliedAnyHint = false;
      for (const hint of anchorCesm.layoutExample.relativePlacementHints) {
        const hintRoleUpper = hint.componentRole.toUpperCase();
        // Match unassigned satellite member in this cluster
        const match = cluster.members.find((m) => {
          if (m.designator === anchorMember.designator || assignedByHint.has(m.designator)) {
            return false;
          }
          const r = m.role.toUpperCase();
          const d = m.designator.toUpperCase();
          if (r.includes(hintRoleUpper) || hintRoleUpper.includes(r)) return true;
          if (hintRoleUpper.includes("INDUCTOR") && (r.includes("INDUCTOR") || /^L\d+/.test(d))) return true;
          if (hintRoleUpper.includes("BOOT") && r.includes("BOOT")) return true;
          if (hintRoleUpper.includes("CIN") && (r.includes("CIN") || r.includes("DECAP"))) return true;
          if (hintRoleUpper.includes("COUT") && (r.includes("COUT") || r.includes("FILTER"))) return true;
          if (hintRoleUpper.includes("FB") && (r.includes("FB") || /^R\d+/.test(d))) return true;
          return false;
        });

        if (match) {
          assignedByHint.add(match.designator);
          appliedAnyHint = true;
          const totalDeg = (hint.preferredQuadrantDeg + anchorEntity.rotationDeg) % 360;
          const rad = (totalDeg * Math.PI) / 180;
          const baseDist =
            Math.max(anchorMember.bbox_mm[0], anchorMember.bbox_mm[1]) / 2 +
            Math.max(match.bbox_mm[0], match.bbox_mm[1]) / 2 +
            0.8;
          const dist = Math.min(baseDist, Math.max(1.0, hint.maxDistanceMm));
          hintTargetCoords.set(match.designator, {
            x: anchorEntity.xMm + Math.cos(rad) * dist,
            y: anchorEntity.yMm + Math.sin(rad) * dist,
            rot: totalDeg % 180 === 0 ? 0 : 90,
            side: hint.sameLayerMandatory !== false ? anchorSide : anchorSide,
          });
        }
      }
      if (appliedAnyHint) {
        datasheetLayoutAppliedClusters.push(cluster.cluster_id);
      }
    }

    // Group decap/satellite members for radial/topological placement around anchor
    let radialFallbackIdx = 0;
    const bulkIndexByPin = new Map<string, number>();

    for (const member of cluster.members) {
      if (member.designator === anchorMember.designator) continue;

      const mComp = compByDes.get(member.designator);
      const mCesm = resolveCesmForPlacement(member.designator, mComp, options?.cesmLookup);
      const exp = explicitByDes.get(member.designator);

      let mx = anchorEntity.xMm;
      let my = anchorEntity.yMm;
      let mRot = 0;
      let mSide: "TOP" | "BOTTOM" = anchorSide;
      let mLocked = false;
      let fromDatasheet = false;

      if (exp && (mode === "explicit_transform" || exp.locked)) {
        mx = exp.xMm;
        my = exp.yMm;
        mRot = exp.rotationDeg;
        mSide = exp.side ?? anchorSide;
        mLocked = exp.locked ?? mode === "explicit_transform";
      } else if (hintTargetCoords.has(member.designator)) {
        const ht = hintTargetCoords.get(member.designator)!;
        mx = ht.x;
        my = ht.y;
        mRot = ht.rot;
        mSide = ht.side;
        fromDatasheet = true;
      } else if (member.target_pins && member.target_pins.length > 0) {
        // Topological snap-to-pin (decap pair, crystal load cap, etc.)
        const firstRef = member.target_pins[0];
        const pinNum = firstRef.includes(".") ? firstRef.split(".")[1] : firstRef;
        const pad =
          anchorPads.find((p) => p.padNumber === pinNum) ?? anchorPads[radialFallbackIdx % anchorPads.length];
        const dx = pad.xMm - anchorEntity.xMm;
        const dy = pad.yMm - anchorEntity.yMm;
        const norm = Math.hypot(dx, dy) || 1;
        const nx = dx / norm;
        const ny = dy / norm;

        const isBulk = member.role.includes("BULK");
        const tierCount = bulkIndexByPin.get(pinNum) ?? 0;
        bulkIndexByPin.set(pinNum, tierCount + 1);

        const maxAllowedDist = member.max_dist_mm ?? 1.8;
        const standOff = isBulk
          ? Math.min(maxAllowedDist + 1.1, 2.5 + tierCount * 1.1)
          : Math.min(maxAllowedDist * 0.85, 1.2 + member.bbox_mm[1] * 0.5);

        mx = pad.xMm + nx * standOff;
        my = pad.yMm + ny * standOff;
        // Orient passive perpendicular to outward pin normal so power pad faces pin and GND faces out
        mRot = Math.abs(nx) >= Math.abs(ny) ? 0 : 90;
      } else {
        // Radial arrangement tightly around anchor body within max_dist_mm
        const angle = (2 * Math.PI * radialFallbackIdx) / Math.max(1, cluster.members.length - 1);
        radialFallbackIdx++;
        const halfAnchor = Math.max(anchorMember.bbox_mm[0], anchorMember.bbox_mm[1]) / 2;
        const halfMember = Math.max(member.bbox_mm[0], member.bbox_mm[1]) / 2;
        const dist = halfAnchor + halfMember + 0.9;
        mx = anchorEntity.xMm + Math.cos(angle) * dist;
        my = anchorEntity.yMm + Math.sin(angle) * dist;
        mRot = Math.abs(Math.cos(angle)) > 0.7 ? 90 : 0;
      }

      // Clamp inside board edge clearance (keep minimum 1.0 mm clear of outline so edge pads remain routable)
      const [rw, rh] = getRotatedDims(member.bbox_mm, mRot);
      const minClear = Math.max(edgeClearance + 0.6, 1.0);
      mx = Math.min(Math.max(mx, minClear + rw / 2), boardW - minClear - rw / 2);
      my = Math.min(Math.max(my, minClear + rh / 2), boardH - minClear - rh / 2);

      const ent: MutableEntity = {
        designator: member.designator,
        clusterId: cluster.cluster_id,
        cluster,
        member,
        comp: mComp,
        cesm: mCesm,
        profile: buildSpacingProfile(
          member.designator,
          member.footprint,
          member.role,
          cluster,
          mComp,
          mCesm,
          mSide,
          options?.componentProfiles?.[member.designator]
        ),
        xMm: snapToGridMm(mx, gridStepMm),
        yMm: snapToGridMm(my, gridStepMm),
        targetXMm: mx,
        targetYMm: my,
        rotationDeg: mRot,
        side: mSide,
        bboxMm: member.bbox_mm,
        locked: mLocked,
        isAnchor: false,
        placedByDatasheetExample: fromDatasheet,
        zoneRect: zone.zoneRectMm,
      };
      entities.push(ent);
      entityByDes.set(ent.designator, ent);
    }

    // Also add cluster keepouts transformed to world coordinates
    if (cluster.keepout_zones) {
      for (const kz of cluster.keepout_zones) {
        const owner = kz.target ? entityByDes.get(kz.target) : anchorEntity;
        if (!owner || !kz.polygon2D) continue;
        const worldPoly = kz.polygon2D.map(([px, py]): [number, number] => [
          Number((owner.xMm + px).toFixed(4)),
          Number((owner.yMm + py).toFixed(4)),
        ]);
        keepoutZones25D.push({
          id: `${cluster.cluster_id}_${kz.target ?? "KO"}_${kz.type ?? "ZONE"}`,
          ownerDesignator: kz.target ?? cluster.anchor_designator,
          polygon2D: worldPoly,
          layerSet: kz.layerSet.flatMap((tok) =>
            tok === "ALL_COPPER_LAYERS"
              ? stackup
              : tok === "MOUNT_LAYER"
                ? [owner.side === "BOTTOM" ? stackup[stackup.length - 1] : stackup[0]]
                : tok === "ADJACENT_REF_LAYER"
                  ? [stackup.length >= 4 ? (owner.side === "BOTTOM" ? stackup[stackup.length - 2] : stackup[1]) : stackup[stackup.length - 1]]
                  : [tok]
          ),
          disallowMask: kz.disallowMask,
          allowedNets: kz.allowedNets,
          mountSide: kz.mountSide,
        });
      }
    }
  }

  // Re-refine crystal load capacitors symmetrically around crystal (facing outward away from host IC!)
  for (const ent of entities) {
    if (ent.member.role === "PASSIVE_CRYSTAL") {
      const hostEnt = entityByDes.get(ent.member.target_anchor ?? ent.cluster.anchor_designator);
      if (hostEnt) {
        const xtalNets = new Set(
          (ent.comp?.pins ?? [])
            .map((p) => p.net)
            .filter((x): x is string => Boolean(x) && !/^(?:GND|AGND|PGND|DGND|VSS)$/i.test(x!))
        );
        const loadCaps = entities.filter(
          (other) =>
            other.clusterId === ent.clusterId &&
            other !== ent &&
            /^C\d+/i.test(other.designator) &&
            (other.comp?.pins ?? []).some((p) => p.net && xtalNets.has(p.net))
        );
        if (loadCaps.length >= 2) {
          // Place Y1 slightly further out along radial normal so load caps never collide with MCU ring neighbors
          const dx = ent.xMm - hostEnt.xMm;
          const dy = ent.yMm - hostEnt.yMm;
          const len = Math.hypot(dx, dy) || 1;
          const ux = dx / len;
          const uy = dy / len;
          const perpX = -uy;
          const perpY = ux;
          const [xw, xh] = getRotatedDims(ent.bboxMm, ent.rotationDeg);

          // Outward placement of C1 & C2 right beside crystal pads (exact rotated projection clearance!)
          const capRot = Math.abs(ux) >= Math.abs(uy) ? 90 : 0;
          const [cw, ch] = getRotatedDims(loadCaps[0].bboxMm, capRot);
          const yExtentU = (Math.abs(ux) * xw + Math.abs(uy) * xh) / 2;
          const cExtentU = (Math.abs(ux) * cw + Math.abs(uy) * ch) / 2;
          const cExtentP = (Math.abs(perpX) * cw + Math.abs(perpY) * ch) / 2;
          const capOut = yExtentU + cExtentU + effectiveRules.componentClearanceMm + 0.25;
          const lateralOffset = cExtentP + effectiveRules.componentClearanceMm * 0.6 + 0.2;

          for (let k = 0; k < 2; k++) {
            const sign = k === 0 ? -1 : 1;
            const lc = loadCaps[k];
            lc.rotationDeg = capRot;
            lc.xMm = snapToGridMm(ent.xMm + ux * capOut + perpX * sign * lateralOffset, gridStepMm);
            lc.yMm = snapToGridMm(ent.yMm + uy * capOut + perpY * sign * lateralOffset, gridStepMm);
            lc.targetXMm = lc.xMm;
            lc.targetYMm = lc.yMm;
          }
        }
      }
    }
  }

  // Helper: compute required padding between two entities
  const pairMinGap = (a: MutableEntity, b: MutableEntity): number => {
    if (!enforceSpacing) return effectiveRules.componentClearanceMm;
    // Use compact DFM gap during courtyard collision checks (EMI/Thermal are cluster-to-cluster)
    const d = computeFourDimensionalSpacingMm(a.profile, b.profile, effectiveRules, {
      enforceEmiThermalIsolation: a.clusterId !== b.clusterId,
      respectReworkEnvelopes: false,
    });
    // Within same cluster, keep tight DFM clearance so decoupling <= 1.8mm stays valid
    return a.clusterId === b.clusterId ? d.dDfmEffMm : Math.min(d.dMinMm, Math.max(d.dDfmEffMm, d.dSafetyEffMm));
  };

  const entityPolygon = (e: MutableEntity, padEachSideMm = 0): Array<[number, number]> =>
    polygonFromRectMm(e.xMm, e.yMm, e.bboxMm[0] + 2 * padEachSideMm, e.bboxMm[1] + 2 * padEachSideMm, e.rotationDeg);

  // ========================================================================
  // Phase 3a: Force-Directed Repulsion Solver (push overlaps apart cleanly)
  // ========================================================================
  if (mode === "macro_floorplan_solve") {
    const numE = entities.length;
    for (let iter = 0; iter < 45; iter++) {
      let moved = false;
      const fx = new Float64Array(numE);
      const fy = new Float64Array(numE);

      for (let i = 0; i < numE; i++) {
        const ei = entities[i];
        const [wi, hi] = getRotatedDims(ei.bboxMm, ei.rotationDeg);

        // Anchor spring attraction toward targetX/Y
        if (!ei.locked) {
          fx[i] += (ei.targetXMm - ei.xMm) * 0.12;
          fy[i] += (ei.targetYMm - ei.yMm) * 0.12;
        }

        // Mounting hole repulsion
        for (const h of holeCircles) {
          const dx = ei.xMm - h.xMm;
          const dy = ei.yMm - h.yMm;
          const minDist = h.radiusMm + Math.hypot(wi, hi) / 2 + 0.3;
          const dist = Math.hypot(dx, dy) || 0.01;
          if (dist < minDist) {
            const push = (minDist - dist) * 0.85;
            fx[i] += (dx / dist) * push;
            fy[i] += (dy / dist) * push;
          }
        }

        for (let j = i + 1; j < numE; j++) {
          const ej = entities[j];
          if (ei.side !== ej.side) continue;
          const [wj, hj] = getRotatedDims(ej.bboxMm, ej.rotationDeg);
          const reqGap =
            ei.clusterId === ej.clusterId
              ? effectiveRules.componentClearanceMm
              : Math.max(effectiveRules.componentClearanceMm, 0.3);

          const halfW = (wi + wj) / 2 + reqGap;
          const halfH = (hi + hj) / 2 + reqGap;
          const dx = ei.xMm - ej.xMm;
          const dy = ei.yMm - ej.yMm;
          const ox = halfW - Math.abs(dx);
          const oy = halfH - Math.abs(dy);

          if (ox > 0 && oy > 0) {
            moved = true;
            // Minimum translation vector along smaller penetration axis
            let px = 0;
            let py = 0;
            if (ox < oy) {
              px = (dx >= 0 ? 1 : -1) * (ox + 0.05);
            } else {
              py = (dy >= 0 ? 1 : -1) * (oy + 0.05);
            }
            const wiWeight = ei.locked ? 0 : ei.isAnchor ? 0.2 : 0.8;
            const wjWeight = ej.locked ? 0 : ej.isAnchor ? 0.2 : 0.8;
            const totW = wiWeight + wjWeight || 1;
            fx[i] += (px * wiWeight) / totW;
            fy[i] += (py * wiWeight) / totW;
            fx[j] -= (px * wjWeight) / totW;
            fy[j] -= (py * wjWeight) / totW;
          }
        }
      }

      for (let i = 0; i < numE; i++) {
        const ei = entities[i];
        if (ei.locked) continue;
        const [wi, hi] = getRotatedDims(ei.bboxMm, ei.rotationDeg);
        ei.xMm = Math.min(
          Math.max(ei.xMm + fx[i] * 0.75, edgeClearance + wi / 2 + 0.2),
          boardW - edgeClearance - wi / 2 - 0.2
        );
        ei.yMm = Math.min(
          Math.max(ei.yMm + fy[i] * 0.75, edgeClearance + hi / 2 + 0.2),
          boardH - edgeClearance - hi / 2 - 0.2
        );
      }

      if (!moved && iter > 5) break;
    }

    // ======================================================================
    // Phase 3b: Low-Temperature Simulated Annealing (with 90 deg rotation)
    // ======================================================================
    let rng = options?.seed ?? 20261118;
    const rand = () => {
      rng = (rng * 1664525 + 1013904223) >>> 0;
      return rng / 0x100000000;
    };

    const movableIndices = entities
      .map((e, idx) => ({ e, idx }))
      .filter(({ e }) => !e.locked)
      .map(({ idx }) => idx);

    if (movableIndices.length > 0) {
      const computeLocalEnergy = (idx: number): number => {
        const ei = entities[idx];
        const [wi, hi] = getRotatedDims(ei.bboxMm, ei.rotationDeg);
        const polyI = entityPolygon(ei, effectiveRules.componentClearanceMm * 0.45);
        let energy =
          Math.hypot(ei.xMm - ei.targetXMm, ei.yMm - ei.targetYMm) *
          (ei.isAnchor ? 3.0 : 2.5);

        // Penalize courtyard overlap using exact Clipper2 area when AABBs touch
        for (let j = 0; j < entities.length; j++) {
          if (j === idx || entities[j].side !== ei.side) continue;
          const ej = entities[j];
          const [wj, hj] = getRotatedDims(ej.bboxMm, ej.rotationDeg);
          const margin = effectiveRules.componentClearanceMm;
          if (
            Math.abs(ei.xMm - ej.xMm) < (wi + wj) / 2 + margin &&
            Math.abs(ei.yMm - ej.yMm) < (hi + hj) / 2 + margin
          ) {
            const polyJ = entityPolygon(ej, margin * 0.45);
            const ovArea = computeClipperIntersectionAreaMm2(polyI, polyJ);
            if (ovArea > 0) {
              energy += 5000.0 * ovArea + 50.0;
            }
          }
        }

        // Penalize mounting hole intrusion
        for (const h of holeCircles) {
          const d = Math.hypot(ei.xMm - h.xMm, ei.yMm - h.yMm);
          const req = h.radiusMm + Math.hypot(wi, hi) / 2 + 0.2;
          if (d < req) energy += 4000.0 * (req - d);
        }

        // Grid snap penalty
        const gx = Math.abs(ei.xMm - snapToGridMm(ei.xMm, gridStepMm));
        const gy = Math.abs(ei.yMm - snapToGridMm(ei.yMm, gridStepMm));
        energy += (gx + gy) * 5.0;
        return energy;
      };

      const totalSteps = Math.min(1800, Math.max(400, movableIndices.length * 14));
      let temp = 2.5;
      const cooling = Math.pow(0.05 / temp, 1 / totalSteps);

      for (let step = 0; step < totalSteps; step++) {
        const idx = movableIndices[Math.floor(rand() * movableIndices.length)];
        const ei = entities[idx];

        const oldX = ei.xMm;
        const oldY = ei.yMm;
        const oldRot = ei.rotationDeg;
        const oldE = computeLocalEnergy(idx);

        // Propose either small translation or 90-degree rotation perturbation
        if (rand() < 0.22 && !ei.placedByDatasheetExample) {
          ei.rotationDeg = (ei.rotationDeg + 90 * (rand() < 0.5 ? 1 : 3)) % 360;
        } else {
          const span = Math.max(0.25, temp * 1.2);
          ei.xMm = snapToGridMm(ei.xMm + (rand() - 0.5) * 2 * span, gridStepMm);
          ei.yMm = snapToGridMm(ei.yMm + (rand() - 0.5) * 2 * span, gridStepMm);
        }

        const [wi, hi] = getRotatedDims(ei.bboxMm, ei.rotationDeg);
        ei.xMm = Math.min(
          Math.max(ei.xMm, edgeClearance + wi / 2 + 0.2),
          boardW - edgeClearance - wi / 2 - 0.2
        );
        ei.yMm = Math.min(
          Math.max(ei.yMm, edgeClearance + hi / 2 + 0.2),
          boardH - edgeClearance - hi / 2 - 0.2
        );

        const newE = computeLocalEnergy(idx);
        const delta = newE - oldE;
        if (delta > 0 && rand() >= Math.exp(-delta / temp)) {
          ei.xMm = oldX;
          ei.yMm = oldY;
          ei.rotationDeg = oldRot;
        }
        temp *= cooling;
      }
    }

    // ======================================================================
    // Phase 3c: Deterministic Exact Clipper2 Legalization -> 0.00 mm^2 Overlap
    // ======================================================================
    for (const e of entities) {
      if (!e.locked) {
        e.xMm = snapToGridMm(e.xMm, gridStepMm);
        e.yMm = snapToGridMm(e.yMm, gridStepMm);
      }
    }

    const hasExactOverlapWithOthers = (idx: number): boolean => {
      const ei = entities[idx];
      const [wi, hi] = getRotatedDims(ei.bboxMm, ei.rotationDeg);
      if (
        ei.xMm - wi / 2 < edgeClearance ||
        ei.xMm + wi / 2 > boardW - edgeClearance ||
        ei.yMm - hi / 2 < edgeClearance ||
        ei.yMm + hi / 2 > boardH - edgeClearance
      ) {
        if (!ei.locked) return true;
      }

      for (const h of holeCircles) {
        if (Math.hypot(ei.xMm - h.xMm, ei.yMm - h.yMm) < h.radiusMm + Math.hypot(wi, hi) / 2 + 0.15) {
          return true;
        }
      }

      const polyI = entityPolygon(ei, effectiveRules.componentClearanceMm * 0.5);
      for (let j = 0; j < entities.length; j++) {
        if (j === idx || entities[j].side !== ei.side) continue;
        const polyJ = entityPolygon(entities[j], effectiveRules.componentClearanceMm * 0.5);
        if (computeClipperIntersectionAreaMm2(polyI, polyJ) > 0) {
          return true;
        }
      }
      return false;
    };

    for (let sweep = 0; sweep < 3; sweep++) {
      let fixedAny = false;
      for (let i = 0; i < entities.length; i++) {
        if (entities[i].locked) continue;
        if (!hasExactOverlapWithOthers(i)) continue;

        const ei = entities[i];
        const origX = ei.xMm;
        const origY = ei.yMm;
        const origRot = ei.rotationDeg;
        let resolved = false;

        // Spiral grid search out to 20 mm around current/target position
        outerSearch: for (let r = gridStepMm * 4; r <= 20.0; r += 0.35) {
          for (let a = 0; a < 16; a++) {
            const theta = (2 * Math.PI * a) / 16;
            for (const candRot of [origRot, (origRot + 90) % 360]) {
              ei.xMm = snapToGridMm(origX + Math.cos(theta) * r, gridStepMm);
              ei.yMm = snapToGridMm(origY + Math.sin(theta) * r, gridStepMm);
              ei.rotationDeg = candRot;
              if (!hasExactOverlapWithOthers(i)) {
                resolved = true;
                fixedAny = true;
                break outerSearch;
              }
            }
          }
        }
        if (!resolved) {
          ei.xMm = origX;
          ei.yMm = origY;
          ei.rotationDeg = origRot;
        }
      }
      if (!fixedAny) break;
    }
  }

  // ========================================================================
  // Stage 4: Final Placement Materialization, Clipper2 Audit & Metrics
  // ========================================================================
  const placements: PlacedComponent[] = entities.map((e) => ({
    designator: e.designator,
    clusterId: e.clusterId,
    footprint: e.member.footprint,
    role: e.member.role,
    xMm: e.xMm,
    yMm: e.yMm,
    rotationDeg: e.rotationDeg,
    side: e.side,
    bboxMm: e.bboxMm,
    locked: e.locked,
    placedByDatasheetExample: e.placedByDatasheetExample,
    pads: computeRotatedPads(e.comp, e.bboxMm, e.xMm, e.yMm, e.rotationDeg, e.side),
  }));

  const placementByDes = new Map<string, PlacedComponent>();
  placements.forEach((p) => placementByDes.set(p.designator, p));

  // Exact Clipper2 raw courtyard overlap check (must be 0.00 mm^2!)
  let overlapCount = 0;
  let overlapAreaMm2 = 0;
  const spacingViolations: SpacingViolationReport[] = [];

  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      if (entities[i].side !== entities[j].side) continue;

      const rawPolyI = entityPolygon(entities[i], 0);
      const rawPolyJ = entityPolygon(entities[j], 0);
      const rawOv = computeClipperIntersectionAreaMm2(rawPolyI, rawPolyJ);
      if (rawOv > 1e-6) {
        overlapCount++;
        overlapAreaMm2 += rawOv;
      }

      if (enforceSpacing) {
        const [wi, hi] = getRotatedDims(entities[i].bboxMm, entities[i].rotationDeg);
        const [wj, hj] = getRotatedDims(entities[j].bboxMm, entities[j].rotationDeg);
        const gapX = Math.abs(entities[i].xMm - entities[j].xMm) - (wi + wj) / 2;
        const gapY = Math.abs(entities[i].yMm - entities[j].yMm) - (hi + hj) / 2;
        const actualGap = Math.max(gapX, gapY);

        const reqMin = pairMinGap(entities[i], entities[j]);
        if (actualGap < reqMin - 0.02) {
          const fullRes = computeFourDimensionalSpacingMm(
            entities[i].profile,
            entities[j].profile,
            effectiveRules,
            { enforceEmiThermalIsolation: entities[i].clusterId !== entities[j].clusterId }
          );
          if (actualGap < fullRes.dDfmEffMm - 0.02) {
            spacingViolations.push({
              compA: entities[i].designator,
              compB: entities[j].designator,
              actualGapMm: Number(actualGap.toFixed(3)),
              requiredMinMm: Number(reqMin.toFixed(3)),
              reasons: fullRes.reasons,
            });
          }
        }
      }
    }
  }

  // Weighted HPWL over local + inter-cluster nets
  let totalHpwlMm = 0;
  for (const net of netlist.nets) {
    if (net.isPowerOrGround) continue;
    const pts: Array<[number, number]> = [];
    for (const ep of net.endpoints) {
      const pl = placementByDes.get(ep.designator);
      if (!pl) continue;
      const pad = pl.pads.find((p) => p.padNumber === ep.pinNumber);
      pts.push(pad ? [pad.xMm, pad.yMm] : [pl.xMm, pl.yMm]);
    }
    if (pts.length < 2) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    totalHpwlMm += (maxX - minX) + (maxY - minY);
  }

  // Inter-cluster ratline crossing ratio
  const interSegments: Array<{ a: [number, number]; b: [number, number] }> = [];
  for (const edge of clusterOutput.inter_cluster_edges) {
    const cFrom = clusterOutput.functional_clusters.find((c) => c.cluster_id === edge.from);
    const cTo = clusterOutput.functional_clusters.find((c) => c.cluster_id === edge.to);
    if (!cFrom || !cTo) continue;
    const pFrom = placementByDes.get(cFrom.anchor_designator);
    const pTo = placementByDes.get(cTo.anchor_designator);
    if (!pFrom || !pTo) continue;
    interSegments.push({ a: [pFrom.xMm, pFrom.yMm], b: [pTo.xMm, pTo.yMm] });
  }
  let crossingPairsCount = 0;
  const totalSegPairs = (interSegments.length * (interSegments.length - 1)) / 2;
  for (let i = 0; i < interSegments.length; i++) {
    for (let j = i + 1; j < interSegments.length; j++) {
      if (segmentsProperlyIntersect(interSegments[i].a, interSegments[i].b, interSegments[j].a, interSegments[j].b)) {
        crossingPairsCount++;
      }
    }
  }
  const ratlineCrossingRatio = totalSegPairs > 0 ? Number((crossingPairsCount / totalSegPairs).toFixed(4)) : 0;

  // Intra-Cluster Dispersion (ICD)
  const intraClusterDispersionMm: Record<string, ClusterDispersionMetrics> = {};
  for (const cluster of clusterOutput.functional_clusters) {
    const cPlacements = placements.filter((p) => p.clusterId === cluster.cluster_id);
    const anchor = placementByDes.get(cluster.anchor_designator) ?? cPlacements[0];
    const cx = cPlacements.reduce((s, p) => s + p.xMm, 0) / Math.max(1, cPlacements.length);
    const cy = cPlacements.reduce((s, p) => s + p.yMm, 0) / Math.max(1, cPlacements.length);

    let sumDist = 0;
    let maxEdgeDist = 0;
    let sumCentroidDist = 0;
    let satCount = 0;

    for (const p of cPlacements) {
      sumCentroidDist += Math.hypot(p.xMm - cx, p.yMm - cy);
      if (p.designator === anchor.designator) continue;
      const distCenter = Math.hypot(p.xMm - anchor.xMm, p.yMm - anchor.yMm);
      const anchorRadius = Math.max(anchor.bboxMm[0], anchor.bboxMm[1]) / 2;
      const edgeDist = Math.max(0, distCenter - anchorRadius);
      sumDist += edgeDist;
      if (edgeDist > maxEdgeDist) maxEdgeDist = edgeDist;
      satCount++;
    }

    intraClusterDispersionMm[cluster.cluster_id] = {
      meanDistMm: satCount > 0 ? Number((sumDist / satCount).toFixed(3)) : 0,
      maxEdgeDistMm: Number(maxEdgeDist.toFixed(3)),
      centroidDispersionMm: Number((sumCentroidDist / Math.max(1, cPlacements.length)).toFixed(3)),
    };
  }

  return {
    placedCount: placements.length,
    placements,
    floorplanZones,
    fiducials,
    keepoutZones25D,
    datasheetLayoutAppliedClusters,
    overlapCount,
    overlapAreaMm2: Number(overlapAreaMm2.toFixed(6)),
    spacingViolations,
    metrics: {
      totalHpwlMm: Number(totalHpwlMm.toFixed(2)),
      ratlineCrossingRatio,
      intraClusterDispersionMm,
      overlapAreaMm2: Number(overlapAreaMm2.toFixed(6)),
      totalRatlinesChecked: interSegments.length,
      crossingPairsCount,
    },
    effectiveRules,
  };
}
