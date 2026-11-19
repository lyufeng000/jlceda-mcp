import type { CesmModel } from "../types/index.js";

export const MIL_TO_MM = 0.0254;

export type Point2D = [number, number];
export type Contour2D = Point2D[];
export type Bbox2D = [number, number, number, number]; // [minX, minY, maxX, maxY]

export interface EasyEdaSourceParseOptions {
  /** Number of interpolation steps per ARC segment (default: 32). */
  arcSteps?: number;
  /** Coordinate unit of input `source` (default: "mm"). Use "mil" for raw JLCEDA native coordinates. */
  unit?: "mm" | "mil";
}

export interface SourceGeomSelfCheckEntry {
  id: string;
  source: unknown;
  expectedBboxMm?: Bbox2D;
  unit?: "mm" | "mil";
}

export interface SourceGeomSelfCheckReport {
  passed: boolean;
  checkedBboxCount: number;
  bboxMismatches: Array<{
    id: string;
    expectedBboxMm: Bbox2D;
    parsedBboxMm: Bbox2D | null;
    maxDeltaMm: number;
  }>;
  checkedCircleCount: number;
  circleMismatches: Array<{
    id: string;
    contourIndex: number;
    maxRadiusErrorMm: number;
  }>;
  degradedReasons: string[];
}

export type CopperSensitiveKind = "crystal" | "oscillator" | "antenna" | "inductor";

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Expand a single EasyEDA ARC segment (start -> end with signed sweep angle in degrees)
 * into intermediate vertices (excluding start and end).
 *
 * NOTE: In EasyEDA native `source` format, the 3 numbers following `'ARC'` / `'CARC'` are
 * `[sweepDeg, endX, endY]` — NOT center coordinates.
 */
function expandArcPoints(
  start: Point2D,
  end: Point2D,
  sweepDeg: number,
  steps: number
): Point2D[] {
  const [sx, sy] = start;
  const [ex, ey] = end;
  const absSweep = Math.abs(sweepDeg);
  if (absSweep < 1e-9 || steps <= 1) return [];

  const chord = Math.hypot(ex - sx, ey - sy);
  if (chord < 1e-9) return [];

  const halfRad = ((absSweep * Math.PI) / 180) / 2;
  const sinHalf = Math.sin(halfRad);
  if (sinHalf < 1e-12) return [];

  const r = (chord / 2) / sinHalf;
  const mx = (sx + ex) / 2;
  const my = (sy + ey) / 2;

  let cx: number;
  let cy: number;
  if (Math.abs(absSweep - 180) < 1e-6) {
    cx = mx;
    cy = my;
  } else {
    const h = Math.sqrt(Math.max(r * r - (chord / 2) * (chord / 2), 0));
    const ux = (ex - sx) / chord;
    const uy = (ey - sy) / chord;
    // For |sweep| < 180: CCW (sweep > 0) center lies to the left (-uy, ux) of chord;
    // for |sweep| > 180 (major arc), center flips to the opposite side.
    const sideSign = (sweepDeg > 0 ? 1 : -1) * (absSweep > 180 ? -1 : 1);
    const nx = -uy * sideSign;
    const ny = ux * sideSign;
    cx = mx + h * nx;
    cy = my + h * ny;
  }

  const a0 = Math.atan2(sy - cy, sx - cx);
  const sweepRad = (sweepDeg * Math.PI) / 180;
  const out: Point2D[] = [];
  for (let k = 1; k < steps; k++) {
    const t = k / steps;
    const ang = a0 + sweepRad * t;
    out.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang)]);
  }
  return out;
}

/**
 * Parse EasyEDA rectangle syntax: `['R', x0, y0, w, h, rot, 0]`.
 *
 * Local corners `(0, 0), (w, 0), (w, -h), (0, -h)` rotated CCW by `rot` degrees around `(x0, y0)`.
 * Verified quadrants:
 * - rot=0   -> x in [x0, x0+w],   y in [y0-h, y0]
 * - rot=90  -> x in [x0, x0+h],   y in [y0, y0+w]
 * - rot=180 -> x in [x0-w, x0],   y in [y0, y0+h]
 * - rot=270 -> x in [x0-h, x0],   y in [y0-w, y0]
 */
export function parseEasyEdaRect(
  source: unknown[],
  unit: "mm" | "mil" = "mm"
): Contour2D {
  const nums: number[] = [];
  for (let i = 1; i < Math.min(source.length, 6); i++) {
    if (isFiniteNumber(source[i])) nums.push(source[i] as number);
  }
  if (nums.length < 4) return [];

  const scale = unit === "mil" ? MIL_TO_MM : 1.0;
  const [x0, y0, w, h] = nums;
  const rotDeg = nums.length >= 5 ? nums[4] : 0;
  const rad = (rotDeg * Math.PI) / 180;
  const ca = Math.cos(rad);
  const sa = Math.sin(rad);

  const localCorners: Point2D[] = [
    [0, 0],
    [w, 0],
    [w, -h],
    [0, -h],
  ];
  return localCorners.map(([lx, ly]) => [
    (x0 + lx * ca - ly * sa) * scale,
    (y0 + lx * sa + ly * ca) * scale,
  ]);
}

/**
 * Parse a single EasyEDA contour array (polyline + `'L'` + `'ARC'`/`'CARC'`).
 */
export function parseEasyEdaContour(
  seg: unknown[],
  options: EasyEdaSourceParseOptions = {}
): Contour2D {
  const arcSteps = Math.max(4, options.arcSteps ?? 32);
  const scale = options.unit === "mil" ? MIL_TO_MM : 1.0;
  const pts: Point2D[] = [];
  let i = 0;
  const n = seg.length;

  while (i < n) {
    const v = seg[i];
    if (typeof v === "string") {
      const cmd = v.toUpperCase();
      if (cmd === "ARC" || cmd === "CARC") {
        if (i + 3 >= n) break;
        const sweep = Number(seg[i + 1]);
        const ex = Number(seg[i + 2]) * scale;
        const ey = Number(seg[i + 3]) * scale;
        if (Number.isFinite(sweep) && Number.isFinite(ex) && Number.isFinite(ey)) {
          if (pts.length > 0) {
            pts.push(...expandArcPoints(pts[pts.length - 1], [ex, ey], sweep, arcSteps));
          }
          pts.push([ex, ey]);
        }
        i += 4;
        continue;
      }
      // Skip 'L' or other command tokens
      i += 1;
      continue;
    }

    if (isFiniteNumber(v) && i + 1 < n && isFiniteNumber(seg[i + 1])) {
      pts.push([v * scale, (seg[i + 1] as number) * scale]);
      i += 2;
    } else {
      i += 1;
    }
  }

  return pts;
}

/**
 * Parse EasyEDA native `source` (rectangle, single contour, or multi-contour complex polygon)
 * into a list of independent closed contours (for even-odd point-in-polygon evaluation).
 */
export function parseEasyEdaSourceContours(
  source: unknown,
  options: EasyEdaSourceParseOptions = {}
): Contour2D[] {
  if (!Array.isArray(source) || source.length === 0) return [];

  if (source[0] === "R" || source[0] === "r") {
    const rect = parseEasyEdaRect(source, options.unit ?? "mm");
    return rect.length >= 3 ? [rect] : [];
  }

  const segs: unknown[][] = Array.isArray(source[0])
    ? (source as unknown[][])
    : [source];

  const out: Contour2D[] = [];
  for (const seg of segs) {
    if (!Array.isArray(seg) || seg.length === 0) continue;
    if (seg[0] === "R" || seg[0] === "r") {
      const rect = parseEasyEdaRect(seg, options.unit ?? "mm");
      if (rect.length >= 3) out.push(rect);
      continue;
    }
    const pts = parseEasyEdaContour(seg, options);
    if (pts.length >= 3) {
      out.push(pts);
    }
  }
  return out;
}

export function computeContoursBbox(contours: Contour2D[]): Bbox2D | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = false;

  for (const c of contours) {
    for (const [x, y] of c) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      found = true;
    }
  }
  return found ? [minX, minY, maxX, maxY] : null;
}

export function pointInContour2D(pt: Point2D, poly: Contour2D): boolean {
  if (poly.length < 3) return false;
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[j];
    if ((y1 > y) !== (y2 > y)) {
      const xIntersect = ((x2 - x1) * (y - y1)) / (y2 - y1) + x1;
      if (x < xIntersect) inside = !inside;
    }
  }
  return inside;
}

/**
 * Even-odd point-in-complex-polygon test:
 * A point is inside copper iff enclosed by an odd number of contours,
 * properly excluding inner cutouts / keepout voids without filling them solid.
 */
export function pointInComplexContours(pt: Point2D, contours: Contour2D[]): boolean {
  let hits = 0;
  for (const c of contours) {
    if (pointInContour2D(pt, c)) hits += 1;
  }
  return hits % 2 === 1;
}

function isDouble180ArcSegment(seg: unknown[]): boolean {
  if (!Array.isArray(seg) || seg.length < 10) return false;
  const arcIndices: number[] = [];
  for (let i = 0; i < seg.length; i++) {
    if (typeof seg[i] === "string") {
      const cmd = (seg[i] as string).toUpperCase();
      if (cmd === "ARC" || cmd === "CARC") {
        arcIndices.push(i);
      }
    }
  }
  if (arcIndices.length !== 2) return false;
  const s1 = Number(seg[arcIndices[0] + 1]);
  const s2 = Number(seg[arcIndices[1] + 1]);
  return Math.abs(Math.abs(s1) - 180) < 1e-4 && Math.abs(Math.abs(s2) - 180) < 1e-4;
}

/**
 * Verify parsed EasyEDA `source` geometry against platform ground-truth `expectedBboxMm`
 * and dual-180°-ARC circle invariants (tolerance defaults to 1 mil = 0.0254 mm).
 */
export function selfCheckSourceGeometry(
  entries: SourceGeomSelfCheckEntry[],
  options: { arcSteps?: number; toleranceMm?: number } = {}
): SourceGeomSelfCheckReport {
  const toleranceMm = options.toleranceMm ?? MIL_TO_MM;
  const arcSteps = options.arcSteps ?? 32;

  const bboxMismatches: SourceGeomSelfCheckReport["bboxMismatches"] = [];
  const circleMismatches: SourceGeomSelfCheckReport["circleMismatches"] = [];
  const degradedReasons: string[] = [];
  let checkedBboxCount = 0;
  let checkedCircleCount = 0;

  for (const entry of entries) {
    const unit = entry.unit ?? "mm";
    const contours = parseEasyEdaSourceContours(entry.source, { arcSteps, unit });
    if (contours.length === 0) {
      degradedReasons.push(`Geometry '${entry.id}' could not be parsed into valid contours.`);
      continue;
    }

    if (entry.expectedBboxMm) {
      checkedBboxCount += 1;
      const parsedBbox = computeContoursBbox(contours);
      if (!parsedBbox) {
        bboxMismatches.push({
          id: entry.id,
          expectedBboxMm: entry.expectedBboxMm,
          parsedBboxMm: null,
          maxDeltaMm: Infinity,
        });
      } else {
        const deltas = [
          Math.abs(parsedBbox[0] - entry.expectedBboxMm[0]),
          Math.abs(parsedBbox[1] - entry.expectedBboxMm[1]),
          Math.abs(parsedBbox[2] - entry.expectedBboxMm[2]),
          Math.abs(parsedBbox[3] - entry.expectedBboxMm[3]),
        ];
        const maxDeltaMm = Math.max(...deltas);
        if (maxDeltaMm > toleranceMm) {
          bboxMismatches.push({
            id: entry.id,
            expectedBboxMm: entry.expectedBboxMm,
            parsedBboxMm: parsedBbox,
            maxDeltaMm,
          });
        }
      }
    }

    // Check dual-180°-ARC circles for constant radius invariant
    if (Array.isArray(entry.source) && entry.source[0] !== "R" && entry.source[0] !== "r") {
      const segs: unknown[][] = Array.isArray(entry.source[0])
        ? (entry.source as unknown[][])
        : [entry.source];
      segs.forEach((seg, idx) => {
        if (!isDouble180ArcSegment(seg)) return;
        const pts = parseEasyEdaContour(seg, { arcSteps, unit });
        const bb = computeContoursBbox([pts]);
        if (!bb || pts.length < 4) return;
        checkedCircleCount += 1;
        const cx = (bb[0] + bb[2]) / 2;
        const cy = (bb[1] + bb[3]) / 2;
        const expectedR = ((bb[2] - bb[0]) + (bb[3] - bb[1])) / 4;
        let maxErr = 0;
        for (const [px, py] of pts) {
          const err = Math.abs(Math.hypot(px - cx, py - cy) - expectedR);
          if (err > maxErr) maxErr = err;
        }
        if (maxErr > toleranceMm) {
          circleMismatches.push({
            id: entry.id,
            contourIndex: idx,
            maxRadiusErrorMm: maxErr,
          });
        }
      });
    }
  }

  for (const m of bboxMismatches) {
    degradedReasons.push(
      `Geometry self-check bbox mismatch on '${m.id}': maxDelta=${m.maxDeltaMm.toFixed(4)}mm (> ${toleranceMm.toFixed(4)}mm).`
    );
  }
  for (const c of circleMismatches) {
    degradedReasons.push(
      `Geometry self-check dual-ARC circle error on '${c.id}'#${c.contourIndex}: maxRadiusErr=${c.maxRadiusErrorMm.toFixed(4)}mm.`
    );
  }

  return {
    passed: bboxMismatches.length === 0 && circleMismatches.length === 0 && degradedReasons.length === 0,
    checkedBboxCount,
    bboxMismatches,
    checkedCircleCount,
    circleMismatches,
    degradedReasons,
  };
}

/**
 * Classify whether a PCB component is copper-pour-sensitive under its signal pads.
 *
 * Explicitly excludes LEDs (e.g. `LED1` starts with `L` and must never be misclassified
 * as an inductor). Inductor classification on `L` prefix requires device/footprint/category
 * corroboration.
 */
export function classifyCopperSensitiveComponent(
  designator: string,
  deviceOrMpn?: string | null,
  footprint?: string | null,
  category?: CesmModel["category"] | "UNKNOWN"
): CopperSensitiveKind | null {
  const des = (designator || "").trim().toUpperCase();
  const texts = `${deviceOrMpn ?? ""} ${footprint ?? ""}`.toUpperCase();

  // Explicit exclusions first (prevents LED1 -> inductor false positive)
  if (category === "LED" || des.startsWith("LED") || /\bLED\b/.test(texts)) {
    return null;
  }

  if (category === "XTAL_PASSIVE") return "crystal";
  if (category === "IND_POWER") return "inductor";

  if (/CRYSTAL|XTAL|X3225|X2520/.test(texts)) return "crystal";
  if (/\bOSC\b|OSCILLATOR|TCXO|VCXO/.test(texts)) return "oscillator";
  if (/^X\d/.test(des)) return "crystal";
  if (/^Y\d/.test(des)) return "oscillator";

  if (/\bANT\b|ANTENNA|PCB_ANT|CHIP_ANT/.test(texts)) return "antenna";

  if (
    /^L\d/.test(des) &&
    /(?:IND|L_|UH|MH|NH|CHOKE|CDRH|NR\d|SWPA|SRP|IHLP)/.test(texts)
  ) {
    return "inductor";
  }

  return null;
}
