import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BlockTemplateDefinition,
  ElecCalcResult,
} from "../types/index.js";
import { calculateCrystalLoadCap } from "./calculators/crystal-load-cap.js";
import { calculateDcdcInductorCap } from "./calculators/dcdc-inductor-cap.js";
import { calculateLdoThermal } from "./calculators/ldo-thermal.js";
import { calculateMosfetLossGate } from "./calculators/mosfet-loss-gate.js";
import { calculateVoltageDivider } from "./calculators/voltage-divider.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_BLOCKS_DIR = resolve(__dirname, "..", "..", "blocks");

export interface InstantiatedComponent {
  refRole: string;
  designator: string;
  lcscId?: string;
  package: string;
  value: string;
  posMm: [number, number];
  rotationDeg: number;
  mirror: boolean;
  clusterGroup: string;
  pinLocationsMm: Record<string, [number, number]>;
}

export interface OrthogonalWireSegment {
  id: string;
  netName: string;
  startMm: [number, number];
  endMm: [number, number];
}

export interface TeeJunctionPoint {
  netName: string;
  posMm: [number, number];
  degree: 3;
}

export interface PlacedNetLabel {
  netName: string;
  posMm: [number, number];
  kind: "label" | "power" | "gnd";
}

export interface BlockInstantiationResult {
  blockInstanceId: string;
  blockTemplateId: string;
  originMm: [number, number];
  parametersResolved: Record<string, unknown>;
  placedComponents: InstantiatedComponent[];
  wires: OrthogonalWireSegment[];
  junctions: TeeJunctionPoint[];
  netLabels: PlacedNetLabel[];
  exposedPortsMm: Record<string, { posMm: [number, number]; netName: string; direction: string }>;
  calcReport: Record<string, ElecCalcResult<any>>;
  warnings: string[];
  antiPitfalls: string[];
  fourWayJunctionCount: number;
  minJunctionSpacingMm: number | null;
}

let instanceCounter = 0;

function roundGrid(val: number): number {
  return Number(val.toFixed(4));
}

function approxEq(a: number, b: number, eps = 1e-4): boolean {
  return Math.abs(a - b) <= eps;
}

function pointKey(pt: [number, number]): string {
  return `${pt[0].toFixed(3)},${pt[1].toFixed(3)}`;
}

function isPointOnSegment(pt: [number, number], a: [number, number], b: [number, number], eps = 1e-4): boolean {
  if (approxEq(a[0], b[0], eps) && approxEq(pt[0], a[0], eps)) {
    const minY = Math.min(a[1], b[1]) - eps;
    const maxY = Math.max(a[1], b[1]) + eps;
    return pt[1] >= minY && pt[1] <= maxY;
  }
  if (approxEq(a[1], b[1], eps) && approxEq(pt[1], a[1], eps)) {
    const minX = Math.min(a[0], b[0]) - eps;
    const maxX = Math.max(a[0], b[0]) + eps;
    return pt[0] >= minX && pt[0] <= maxX;
  }
  return false;
}

function isInteriorPointOnSegment(pt: [number, number], a: [number, number], b: [number, number], eps = 1e-4): boolean {
  if (!isPointOnSegment(pt, a, b, eps)) return false;
  const atStart = approxEq(pt[0], a[0], eps) && approxEq(pt[1], a[1], eps);
  const atEnd = approxEq(pt[0], b[0], eps) && approxEq(pt[1], b[1], eps);
  return !atStart && !atEnd;
}

/**
 * Inspect orthogonal wires and junctions for any 4-way cross junction on the same net
 * and check minimum spacing between same-net junctions.
 */
export function verifyNoFourWayJunctions(
  wires: OrthogonalWireSegment[],
  junctions: TeeJunctionPoint[]
): {
  fourWayJunctionCount: number;
  invalidJunctions: Array<{ netName: string; posMm: [number, number]; degree: number }>;
  minJunctionSpacingMm: number | null;
} {
  const byNet = new Map<string, OrthogonalWireSegment[]>();
  for (const w of wires) {
    const arr = byNet.get(w.netName) ?? [];
    arr.push(w);
    byNet.set(w.netName, arr);
  }

  const invalidJunctions: Array<{ netName: string; posMm: [number, number]; degree: number }> = [];
  let fourWayCount = 0;
  let minSpacing: number | null = null;

  for (const [netName, segs] of byNet.entries()) {
    const candidatePts = new Map<string, [number, number]>();
    for (const s of segs) {
      candidatePts.set(pointKey(s.startMm), s.startMm);
      candidatePts.set(pointKey(s.endMm), s.endMm);
    }

    // Also check orthogonal crossings within the same net
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const s1 = segs[i];
        const s2 = segs[j];
        const s1Vert = approxEq(s1.startMm[0], s1.endMm[0]);
        const s2Vert = approxEq(s2.startMm[0], s2.endMm[0]);
        if (s1Vert !== s2Vert) {
          const v = s1Vert ? s1 : s2;
          const h = s1Vert ? s2 : s1;
          const ix = v.startMm[0];
          const iy = h.startMm[1];
          const xInH = ix >= Math.min(h.startMm[0], h.endMm[0]) - 1e-4 && ix <= Math.max(h.startMm[0], h.endMm[0]) + 1e-4;
          const yInV = iy >= Math.min(v.startMm[1], v.endMm[1]) - 1e-4 && iy <= Math.max(v.startMm[1], v.endMm[1]) + 1e-4;
          if (xInH && yInV) {
            const pt: [number, number] = [roundGrid(ix), roundGrid(iy)];
            candidatePts.set(pointKey(pt), pt);
          }
        }
      }
    }

    for (const pt of candidatePts.values()) {
      let degree = 0;
      for (const s of segs) {
        if (approxEq(s.startMm[0], s.endMm[0]) && approxEq(s.startMm[1], s.endMm[1])) continue;
        if (isInteriorPointOnSegment(pt, s.startMm, s.endMm)) {
          degree += 2;
        } else if (
          (approxEq(pt[0], s.startMm[0]) && approxEq(pt[1], s.startMm[1])) ||
          (approxEq(pt[0], s.endMm[0]) && approxEq(pt[1], s.endMm[1]))
        ) {
          degree += 1;
        }
      }
      if (degree >= 4) {
        fourWayCount++;
        invalidJunctions.push({ netName, posMm: pt, degree });
      }
    }

    const netJunctions = junctions.filter((j) => j.netName === netName);
    for (let i = 0; i < netJunctions.length; i++) {
      for (let j = i + 1; j < netJunctions.length; j++) {
        const dx = netJunctions[i].posMm[0] - netJunctions[j].posMm[0];
        const dy = netJunctions[i].posMm[1] - netJunctions[j].posMm[1];
        const dist = Math.hypot(dx, dy);
        if (minSpacing === null || dist < minSpacing) {
          minSpacing = roundGrid(dist);
        }
      }
    }
  }

  return {
    fourWayJunctionCount: fourWayCount,
    invalidJunctions,
    minJunctionSpacingMm: minSpacing,
  };
}

/**
 * Route N pins on the same net orthogonally on a 1.27 mm (50 mil) schematic grid
 * without ever creating a 4-way cross junction.
 * All multi-way joints are pure perpendicular 3-way T-junctions staggered by >= 2.54 mm.
 */
function routeNetStaggeredTee(
  netName: string,
  rawPoints: Array<[number, number]>,
  wireIdPrefix: string,
  otherPinObstacles: Array<[number, number]> = []
): { wires: OrthogonalWireSegment[]; junctions: TeeJunctionPoint[] } {
  const GRID = 1.27; // 50 mil schematic grid; 2 grid steps = 2.54 mm
  const toGrid = (v: number): number => Math.round(v / GRID);
  const fromGrid = (g: number): number => roundGrid(g * GRID);
  const gKey = (gx: number, gy: number): string => `${gx},${gy}`;

  // Deduplicate points on grid
  const uniqueMap = new Map<string, [number, number]>();
  for (const p of rawPoints) {
    const rounded: [number, number] = [roundGrid(p[0]), roundGrid(p[1])];
    uniqueMap.set(pointKey(rounded), rounded);
  }
  const pts = Array.from(uniqueMap.values());
  const wires: OrthogonalWireSegment[] = [];
  const junctions: TeeJunctionPoint[] = [];

  if (pts.length <= 1) {
    return { wires, junctions };
  }

  let segSeq = 0;
  const addSeg = (a: [number, number], b: [number, number]) => {
    if (approxEq(a[0], b[0]) && approxEq(a[1], b[1])) return;
    wires.push({
      id: `${wireIdPrefix}_${++segSeq}`,
      netName,
      startMm: [roundGrid(a[0]), roundGrid(a[1])],
      endMm: [roundGrid(b[0]), roundGrid(b[1])],
    });
  };

  if (pts.length === 2) {
    const [p1, p2] = pts;
    if (approxEq(p1[0], p2[0]) || approxEq(p1[1], p2[1])) {
      addSeg(p1, p2);
    } else {
      const corner: [number, number] = [p2[0], p1[1]];
      addSeg(p1, corner);
      addSeg(corner, p2);
    }
    return { wires, junctions };
  }

  // Convert pins to integer grid coordinates
  const gPts = pts.map(([x, y]) => ({
    gx: toGrid(x),
    gy: toGrid(y),
    raw: [x, y] as [number, number],
  }));

  // Compute generous bounding box in grid units (expanded enough so spurs & detours never crowd)
  const pad = 12 + gPts.length * 4;
  const allGx = [...gPts.map((p) => p.gx), ...otherPinObstacles.map((p) => toGrid(p[0]))];
  const allGy = [...gPts.map((p) => p.gy), ...otherPinObstacles.map((p) => toGrid(p[1]))];
  const minGx = Math.min(...allGx) - pad;
  const maxGx = Math.max(...allGx) + pad;
  const minGy = Math.min(...allGy) - pad;
  const maxGy = Math.max(...allGy) + pad;

  // Grid tree representation: segments along grid lines
  interface GridSeg {
    ax: number;
    ay: number;
    bx: number;
    by: number;
  }
  const treeSegs: GridSeg[] = [];
  const junctionGridPts: Array<{ gx: number; gy: number }> = [];
  const treeCells = new Set<string>();
  const pinBlockedCells = new Set<string>(gPts.map((p) => gKey(p.gx, p.gy)));
  for (const op of otherPinObstacles) {
    pinBlockedCells.add(gKey(toGrid(op[0]), toGrid(op[1])));
  }

  const markSegCells = (seg: GridSeg) => {
    const dx = Math.sign(seg.bx - seg.ax);
    const dy = Math.sign(seg.by - seg.ay);
    let cx = seg.ax;
    let cy = seg.ay;
    treeCells.add(gKey(cx, cy));
    while (cx !== seg.bx || cy !== seg.by) {
      cx += dx;
      cy += dy;
      treeCells.add(gKey(cx, cy));
    }
  };

  // BFS shortest orthogonal path on grid between start and goalPredicate
  const findGridPath = (
    start: { gx: number; gy: number },
    isGoal: (gx: number, gy: number) => boolean,
    isBlocked: (gx: number, gy: number) => boolean
  ): Array<{ gx: number; gy: number }> | null => {
    const startKey = gKey(start.gx, start.gy);
    const visited = new Set<string>([startKey]);
    const parent = new Map<string, string>();
    const coordMap = new Map<string, { gx: number; gy: number }>([[startKey, start]]);
    const queue: Array<{ gx: number; gy: number }> = [start];
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];

    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      const curKey = gKey(cur.gx, cur.gy);
      if (curKey !== startKey && isGoal(cur.gx, cur.gy)) {
        const path: Array<{ gx: number; gy: number }> = [];
        let k: string | undefined = curKey;
        while (k) {
          path.push(coordMap.get(k)!);
          k = parent.get(k);
        }
        path.reverse();
        return path;
      }

      for (const [dx, dy] of dirs) {
        const nx = cur.gx + dx;
        const ny = cur.gy + dy;
        if (nx < minGx || nx > maxGx || ny < minGy || ny > maxGy) continue;
        const nk = gKey(nx, ny);
        if (visited.has(nk)) continue;
        if (!isGoal(nx, ny) && isBlocked(nx, ny)) continue;
        visited.add(nk);
        parent.set(nk, curKey);
        coordMap.set(nk, { gx: nx, gy: ny });
        queue.push({ gx: nx, gy: ny });
      }
    }
    return null;
  };

  const pathToSegs = (path: Array<{ gx: number; gy: number }>): GridSeg[] => {
    const out: GridSeg[] = [];
    if (path.length < 2) return out;
    let start = path[0];
    let prevDirX = Math.sign(path[1].gx - path[0].gx);
    let prevDirY = Math.sign(path[1].gy - path[0].gy);
    for (let i = 2; i < path.length; i++) {
      const dx = Math.sign(path[i].gx - path[i - 1].gx);
      const dy = Math.sign(path[i].gy - path[i - 1].gy);
      if (dx !== prevDirX || dy !== prevDirY) {
        out.push({ ax: start.gx, ay: start.gy, bx: path[i - 1].gx, by: path[i - 1].gy });
        start = path[i - 1];
        prevDirX = dx;
        prevDirY = dy;
      }
    }
    out.push({ ax: start.gx, ay: start.gy, bx: path[path.length - 1].gx, by: path[path.length - 1].gy });
    return out;
  };

  // Seed initial tree via a dedicated wide horizontal trunk corridor strictly below all pins,
  // guaranteeing ample straight segment length (>= 4 * k grid units) for staggered >=2.54mm T-taps!
  let bestPair: [number, number] = [0, 1];
  let bestDist = -1;
  for (let i = 0; i < gPts.length; i++) {
    for (let j = i + 1; j < gPts.length; j++) {
      const d = Math.abs(gPts[i].gx - gPts[j].gx) + Math.abs(gPts[i].gy - gPts[j].gy);
      if (d > bestDist) {
        bestDist = d;
        bestPair = [i, j];
      }
    }
  }

  const connectedIndices = new Set<number>(bestPair);
  const pA = gPts[bestPair[0]];
  const pB = gPts[bestPair[1]];
  const trunkY = Math.min(...allGy) - 4;
  const minTrunkSpan = Math.max(8, gPts.length * 4);
  const trunkStartX = Math.min(pA.gx, pB.gx);
  const trunkEndX = Math.max(Math.max(pA.gx, pB.gx), trunkStartX + minTrunkSpan);

  // Draw trunk segment along trunkY from trunkStartX to trunkEndX
  const trunkSeg: GridSeg = { ax: trunkStartX, ay: trunkY, bx: trunkEndX, by: trunkY };
  treeSegs.push(trunkSeg);
  markSegCells(trunkSeg);

  // Connect pA to trunkStartX and pB to trunkEndX cleanly (using BFS avoiding pinBlockedCells & existing trunk except target endpoint)
  const connectToTrunkEnd = (pin: { gx: number; gy: number }, goalX: number, goalY: number) => {
    const path = findGridPath(
      pin,
      (gx, gy) => gx === goalX && gy === goalY,
      (gx, gy) => treeCells.has(gKey(gx, gy)) || pinBlockedCells.has(gKey(gx, gy))
    );
    if (!path) {
      throw new Error(`Could not route seed pin on net '${netName}' to trunk (${goalX}, ${goalY})`);
    }
    for (const s of pathToSegs(path)) {
      treeSegs.push(s);
      markSegCells(s);
    }
  };

  if (pA.gx <= pB.gx) {
    connectToTrunkEnd(pA, trunkStartX, trunkY);
    connectToTrunkEnd(pB, trunkEndX, trunkY);
  } else {
    connectToTrunkEnd(pB, trunkStartX, trunkY);
    connectToTrunkEnd(pA, trunkEndX, trunkY);
  }

  // Connect remaining pins one by one via valid degree-3 T-junctions (>= 2 grid steps = 2.54mm from ends/junctions)
  const remaining = gPts
    .map((p, idx) => ({ p, idx }))
    .filter((item) => !connectedIndices.has(item.idx))
    .sort((a, b) => a.p.gx - b.p.gx || a.p.gy - b.p.gy);

  for (const { p } of remaining) {
    // Identify valid tap cells: strictly interior to a single treeSeg AND >= 2 grid units from both endpoints and all existing junctions
    const validTapMap = new Map<string, number>(); // cellKey -> index in treeSegs
    for (let si = 0; si < treeSegs.length; si++) {
      const s = treeSegs[si];
      const len = Math.abs(s.bx - s.ax) + Math.abs(s.by - s.ay);
      if (len < 4) continue;
      const dx = Math.sign(s.bx - s.ax);
      const dy = Math.sign(s.by - s.ay);
      for (let step = 2; step <= len - 2; step++) {
        const tx = s.ax + dx * step;
        const ty = s.ay + dy * step;
        const tk = gKey(tx, ty);
        if (pinBlockedCells.has(tk)) continue;
        const tooCloseToJunc = junctionGridPts.some(
          (jp) => Math.hypot(jp.gx - tx, jp.gy - ty) < 2 - 1e-6
        );
        if (tooCloseToJunc) continue;
        validTapMap.set(tk, si);
      }
    }

    const path =
      validTapMap.size > 0
        ? findGridPath(
            p,
            (gx, gy) => validTapMap.has(gKey(gx, gy)),
            (gx, gy) => treeCells.has(gKey(gx, gy)) || pinBlockedCells.has(gKey(gx, gy))
          )
        : null;

    if (!path) {
      throw new Error(`Could not find valid T-junction path for net '${netName}' pin (${p.raw[0]}, ${p.raw[1]})`);
    }

    const tapCell = path[path.length - 1];
    const tapSegIdx = validTapMap.get(gKey(tapCell.gx, tapCell.gy));
    if (tapSegIdx === undefined) {
      throw new Error(`Invalid tap cell resolved on net '${netName}'`);
    }

    // Split target segment at tapCell so tapCell is strictly degree-3
    const origSeg = treeSegs[tapSegIdx];
    const segA: GridSeg = { ax: origSeg.ax, ay: origSeg.ay, bx: tapCell.gx, by: tapCell.gy };
    const segB: GridSeg = { ax: tapCell.gx, ay: tapCell.gy, bx: origSeg.bx, by: origSeg.by };
    treeSegs.splice(tapSegIdx, 1, segA, segB);

    const newSegs = pathToSegs(path);
    for (const s of newSegs) {
      treeSegs.push(s);
      markSegCells(s);
    }

    junctionGridPts.push({ gx: tapCell.gx, gy: tapCell.gy });
    junctions.push({
      netName,
      posMm: [fromGrid(tapCell.gx), fromGrid(tapCell.gy)],
      degree: 3,
    });
  }

  for (const s of treeSegs) {
    addSeg([fromGrid(s.ax), fromGrid(s.ay)], [fromGrid(s.bx), fromGrid(s.by)]);
  }

  return { wires, junctions };
}

/**
 * Compute deterministic schematic pin coordinates for a placed component role.
 */
function computeComponentPinLocations(
  originMm: [number, number],
  relOffsetMm: [number, number],
  rotationDeg: number,
  pinNames: string[]
): Record<string, [number, number]> {
  const cx = originMm[0] + relOffsetMm[0];
  const cy = originMm[1] + relOffsetMm[1];
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const rotatePt = (dx: number, dy: number): [number, number] => [
    roundGrid(cx + dx * cos - dy * sin),
    roundGrid(cy + dx * sin + dy * cos),
  ];

  const locs: Record<string, [number, number]> = {};
  const count = pinNames.length;

  if (count <= 2) {
    locs[pinNames[0] ?? "1"] = rotatePt(-2.54, 0);
    if (count === 2) {
      locs[pinNames[1]] = rotatePt(2.54, 0);
    }
    return locs;
  }

  // Multi-pin IC: distribute pins cleanly on left and right columns on 2.54mm grid
  const half = Math.ceil(count / 2);
  for (let i = 0; i < count; i++) {
    const isLeft = i < half;
    const row = isLeft ? i : i - half;
    const dx = isLeft ? -5.08 : 5.08;
    const dy = (half / 2 - row - 0.5) * 2.54;
    locs[pinNames[i]] = rotatePt(dx, dy);
  }
  return locs;
}

export function loadBlockTemplate(
  blockTemplateId: string,
  blocksDir = DEFAULT_BLOCKS_DIR
): BlockTemplateDefinition {
  const filePath = join(blocksDir, `${blockTemplateId}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`Block template '${blockTemplateId}' not found at ${filePath}`);
  }
  return JSON.parse(readFileSync(filePath, "utf-8")) as BlockTemplateDefinition;
}

export function instantiateBlock(options: {
  blockTemplateId: string;
  originMm: [number, number];
  parameters?: Record<string, unknown>;
  netBindings?: Record<string, string>;
  blocksDir?: string;
  designatorSuffix?: string;
}): BlockInstantiationResult {
  const template = loadBlockTemplate(options.blockTemplateId, options.blocksDir);
  const params: Record<string, unknown> = {
    ...template.defaultParameters,
    ...(options.parameters ?? {}),
  };
  const suffix = options.designatorSuffix ?? String(++instanceCounter);
  const clusterGroup = `${template.blockTemplateId}_${suffix}`;
  const blockInstanceId = `blk_${clusterGroup}`;
  const warnings: string[] = [];
  const calcReport: Record<string, ElecCalcResult<any>> = {};

  // Dynamic parameter calculations & conditional component filtering
  const activeRoles = new Set<string>(template.components.map((c) => c.refRole));
  const dynamicValues = new Map<string, string>();
  const dynamicLcsc = new Map<string, string>();

  if (template.blockTemplateId === "BLK_USB_TYPEC_UFP_5V") {
    const fuseA = Number(params.vbus_fuse_a ?? 1.5);
    dynamicValues.set("F_VBUS", `${fuseA}A_PPTC`);
    if (fuseA <= 0) activeRoles.delete("F_VBUS");
  }

  if (template.blockTemplateId === "BLK_PWR_REVERSE_PMOS") {
    const vInMax = Number(params.v_in_max ?? 12.0);
    if (vInMax <= 12.0) {
      activeRoles.delete("D_ZENER_GS");
    }
  }

  if (template.blockTemplateId === "BLK_DCDC_BUCK_SYNC") {
    const vInRange = (params.v_in_range as [number, number]) ?? [9.0, 24.0];
    const vOut = Number(params.v_out ?? 5.0);
    const iOutMax = Number(params.i_out_max ?? 2.0);
    const fSwKhz = Number(params.f_sw_khz ?? 400);
    const vRef = Number(params.v_ref ?? 0.596);

    const dcdcCalc = calculateDcdcInductorCap({
      topology: "BUCK",
      v_in_range: vInRange,
      v_out: vOut,
      i_out_max: iOutMax,
      f_sw_khz: fSwKhz,
    });
    calcReport.dcdc_inductor_cap = dcdcCalc;
    warnings.push(...dcdcCalc.warnings);

    const divCalc = calculateVoltageDivider({
      mode: "FB",
      v_in_max: vOut,
      v_out: vOut,
      v_target_or_vref: vRef,
      i_fb_ua: 0.1,
      r_series: "E96",
    });
    calcReport.voltage_divider = divCalc;
    warnings.push(...divCalc.warnings);

    dynamicValues.set("L_PWR", `${dcdcCalc.results.l_uh}uH`);
    dynamicValues.set("R_FBT", divCalc.results.r_top_formatted);
    dynamicValues.set("R_FBB", divCalc.results.r_bot_formatted);
    dynamicValues.set("C_OUT_1", `${dcdcCalc.results.c_out_unit_nom_uf}uF`);
    dynamicValues.set("C_OUT_2", `${dcdcCalc.results.c_out_unit_nom_uf}uF`);
    const lCand = dcdcCalc.recommendedStandardValues.find((v) => v.role === "L_power");
    if (lCand?.lcscCandidate) dynamicLcsc.set("L_PWR", lCand.lcscCandidate);
  }

  if (template.blockTemplateId === "BLK_LDO_LOWNOISE") {
    const vInMin = Number(params.v_in_min ?? 4.5);
    const vInMax = Number(params.v_in_max ?? 5.5);
    const vOut = Number(params.v_out ?? 3.3);
    const iLoadAvg = Number(params.i_load_avg ?? 0.15);
    const tAmb = Number(params.t_ambient_c ?? 45);
    const ldoCalc = calculateLdoThermal({
      v_in_min: vInMin,
      v_in_max: vInMax,
      v_out: vOut,
      i_load_avg: iLoadAvg,
      v_dropout: 0.25,
      r_theta_ja: 200,
      t_ambient_c: tAmb,
      mlcc_stable: true,
    });
    calcReport.ldo_thermal = ldoCalc;
    warnings.push(...ldoCalc.warnings);
  }

  if (template.blockTemplateId === "BLK_XTAL_PASSIVE") {
    const freqMhz = Number(params.freq_mhz ?? 8.0);
    const clPf = Number(params.cl_datasheet_pf ?? 12.0);
    const cPinPf = Number(params.c_pin_pf ?? 2.0);
    const cTracePf = Number(params.c_trace_pf ?? 2.0);
    const xtalCalc = calculateCrystalLoadCap({
      cl_datasheet_pf: clPf,
      freq_mhz: freqMhz,
      c_pin_pf: cPinPf,
      c_trace_pf: cTracePf,
    });
    calcReport.crystal_load_cap = xtalCalc;
    warnings.push(...xtalCalc.warnings);
    dynamicValues.set("Y_XTAL", `${freqMhz}MHz_${clPf}pF`);
    dynamicValues.set("C_LOAD_1", `${xtalCalc.results.c1_c2_standard_pf}pF_C0G`);
    dynamicValues.set("C_LOAD_2", `${xtalCalc.results.c1_c2_standard_pf}pF_C0G`);
    const cCand = xtalCalc.recommendedStandardValues.find((v) => v.role.startsWith("C1"));
    if (cCand?.lcscCandidate) {
      dynamicLcsc.set("C_LOAD_1", cCand.lcscCandidate);
      dynamicLcsc.set("C_LOAD_2", cCand.lcscCandidate);
    }
  }

  if (template.blockTemplateId === "BLK_IND_RELAY_DRIVE") {
    const coilV = Number(params.coil_voltage_v ?? 5.0);
    const vDrive = Number(params.v_drive ?? 3.3);
    const loadType = String(params.load_type ?? "AC_220V");
    const mosCalc = calculateMosfetLossGate({
      v_bus: coilV,
      i_rms: 0.1,
      i_peak: 0.15,
      v_drive: vDrive,
      rdson_25c_mohm: 40,
      vgs_spec_min: 2.5,
      qg_nc: 6.0,
      f_sw_khz: 1.0,
    });
    calcReport.mosfet_loss_gate = mosCalc;
    warnings.push(...mosCalc.warnings);
    dynamicValues.set("K_RELAY", `SRD-${coilV}VDC`);
    dynamicValues.set("R_G", `${mosCalc.results.rg_recommended_ohm}Ω`);
    dynamicValues.set("R_GS", `${mosCalc.results.rgs_bleeder_kohm}kΩ`);
    if (loadType !== "AC_220V") {
      activeRoles.delete("RV_MOV");
    }
  }

  if (template.blockTemplateId === "BLK_BUS_RS485_CAN") {
    const isolated = params.isolated !== false;
    const isEndNode = params.is_end_node !== false;
    if (!isolated) activeRoles.delete("U_ISO");
    if (!isEndNode) activeRoles.delete("R_TERM");
  }

  // Collect all pin names referenced per component role
  const rolePinsMap = new Map<string, Set<string>>();
  for (const conn of template.connections) {
    for (const end of [conn.from, conn.to]) {
      if (end.startsWith("PORT:")) continue;
      const dotIdx = end.indexOf(".");
      if (dotIdx > 0) {
        const role = end.slice(0, dotIdx);
        const pin = end.slice(dotIdx + 1);
        if (!activeRoles.has(role)) continue;
        const set = rolePinsMap.get(role) ?? new Set<string>();
        set.add(pin);
        rolePinsMap.set(role, set);
      }
    }
  }

  // Expand placed components
  const placedComponents: InstantiatedComponent[] = [];
  const componentPinWorld = new Map<string, [number, number]>();

  for (const comp of template.components) {
    if (!activeRoles.has(comp.refRole)) continue;
    const pins = Array.from(rolePinsMap.get(comp.refRole) ?? ["1", "2"]);
    const pinLocs = computeComponentPinLocations(
      options.originMm,
      comp.relOffsetMm,
      comp.rotationDeg ?? 0,
      pins
    );
    for (const [pName, pt] of Object.entries(pinLocs)) {
      componentPinWorld.set(`${comp.refRole}.${pName}`, pt);
    }

    const designator = `${comp.refRole}_${suffix}`;
    const value =
      dynamicValues.get(comp.refRole) ??
      (comp.valueExpr ?? comp.defaultPackage ?? comp.refRole);

    placedComponents.push({
      refRole: comp.refRole,
      designator,
      ...(dynamicLcsc.get(comp.refRole) ?? comp.lcscId
        ? { lcscId: dynamicLcsc.get(comp.refRole) ?? comp.lcscId }
        : {}),
      package: comp.defaultPackage ?? "UNKNOWN",
      value,
      posMm: [
        roundGrid(options.originMm[0] + comp.relOffsetMm[0]),
        roundGrid(options.originMm[1] + comp.relOffsetMm[1]),
      ],
      rotationDeg: comp.rotationDeg ?? 0,
      mirror: Boolean(comp.mirror),
      clusterGroup,
      pinLocationsMm: pinLocs,
    });
  }

  // Resolve exposed ports
  const exposedPortsMm: Record<
    string,
    { posMm: [number, number]; netName: string; direction: string }
  > = {};
  const portNetOverride = options.netBindings ?? {};

  for (const port of template.exposedPorts) {
    const netName =
      portNetOverride[port.portName] ?? port.defaultNetName ?? `${port.portName}_${suffix}`;
    exposedPortsMm[port.portName] = {
      posMm: [
        roundGrid(options.originMm[0] + port.relOffsetMm[0]),
        roundGrid(options.originMm[1] + port.relOffsetMm[1]),
      ],
      netName,
      direction: port.direction,
    };
  }

  // Group endpoints by netName (with union-find if multiple connections touch same netRole)
  const netEndpoints = new Map<string, Array<[number, number]>>();
  const addEndpoint = (netName: string, pt: [number, number]) => {
    const arr = netEndpoints.get(netName) ?? [];
    arr.push(pt);
    netEndpoints.set(netName, arr);
  };

  // Resolve actual netName per connection (respecting port bindings when connection involves PORT:*)
  const netRoleToFinalName = new Map<string, string>();
  for (const conn of template.connections) {
    for (const end of [conn.from, conn.to]) {
      if (end.startsWith("PORT:")) {
        const portName = end.slice(5);
        const portInfo = exposedPortsMm[portName];
        if (portInfo) {
          netRoleToFinalName.set(conn.netRole, portInfo.netName);
        }
      }
    }
  }

  // Special handling for non-isolated RS485 fallback: bypass U_ISO connections if U_ISO deleted
  const effectiveConnections = [...template.connections];
  if (template.blockTemplateId === "BLK_BUS_RS485_CAN" && !activeRoles.has("U_ISO")) {
    effectiveConnections.push(
      { from: "PORT:VCC_PRI", to: "U_XCVR.8", netRole: "VCC_PRI" },
      { from: "PORT:VCC_PRI", to: "C_DEC.1", netRole: "VCC_PRI" },
      { from: "PORT:GND_PRI", to: "U_XCVR.5", netRole: "GND_PRI" },
      { from: "PORT:GND_PRI", to: "C_DEC.2", netRole: "GND_PRI" },
      { from: "PORT:GND_PRI", to: "D_TVS.3", netRole: "GND_PRI" },
      { from: "PORT:UART_TX", to: "U_XCVR.4", netRole: "UART_TX" },
      { from: "PORT:RS485_DE", to: "U_XCVR.3", netRole: "RS485_DE" },
      { from: "PORT:RS485_DE", to: "U_XCVR.2", netRole: "RS485_DE" },
      { from: "U_XCVR.1", to: "PORT:UART_RX", netRole: "UART_RX" }
    );
  }

  for (const conn of effectiveConnections) {
    const checkEndpointActive = (end: string): [number, number] | null => {
      if (end.startsWith("PORT:")) {
        const pName = end.slice(5);
        return exposedPortsMm[pName]?.posMm ?? null;
      }
      const dotIdx = end.indexOf(".");
      if (dotIdx > 0) {
        const role = end.slice(0, dotIdx);
        if (!activeRoles.has(role)) return null;
      }
      return componentPinWorld.get(end) ?? null;
    };

    const ptA = checkEndpointActive(conn.from);
    const ptB = checkEndpointActive(conn.to);
    if (!ptA || !ptB) continue;

    const finalNetName =
      netRoleToFinalName.get(conn.netRole) ?? `${conn.netRole}_${suffix}`;
    addEndpoint(finalNetName, ptA);
    addEndpoint(finalNetName, ptB);
  }

  // Route every net orthogonally with staggered 3-way T-junctions (>= 2.54mm apart, 0 four-way crosses)
  const allWires: OrthogonalWireSegment[] = [];
  const allJunctions: TeeJunctionPoint[] = [];
  const netLabels: PlacedNetLabel[] = [];

  const allPinCoords = Array.from(componentPinWorld.values());
  for (const [netName, pts] of netEndpoints.entries()) {
    const netPinKeys = new Set(pts.map((p) => pointKey(p)));
    const otherPins = allPinCoords.filter((p) => !netPinKeys.has(pointKey(p)));
    const routed = routeNetStaggeredTee(netName, pts, `w_${clusterGroup}_${netName}`, otherPins);
    allWires.push(...routed.wires);
    allJunctions.push(...routed.junctions);

    const upper = netName.toUpperCase();
    const kind: "label" | "power" | "gnd" =
      upper.includes("GND") || upper.includes("VSS")
        ? "gnd"
        : upper.includes("VCC") || upper.includes("VDD") || upper.includes("VBUS") || upper.includes("VOUT") || upper.includes("VIN")
          ? "power"
          : "label";
    netLabels.push({
      netName,
      posMm: pts[0],
      kind,
    });
  }

  const check = verifyNoFourWayJunctions(allWires, allJunctions);
  if (check.fourWayJunctionCount > 0) {
    throw new Error(
      `Internal router invariant failed: detected ${check.fourWayJunctionCount} four-way junctions in ${template.blockTemplateId}`
    );
  }

  return {
    blockInstanceId,
    blockTemplateId: template.blockTemplateId,
    originMm: options.originMm,
    parametersResolved: params,
    placedComponents,
    wires: allWires,
    junctions: allJunctions,
    netLabels,
    exposedPortsMm,
    calcReport,
    warnings,
    antiPitfalls: template.antiPitfalls ?? [],
    fourWayJunctionCount: check.fourWayJunctionCount,
    minJunctionSpacingMm: check.minJunctionSpacingMm,
  };
}
