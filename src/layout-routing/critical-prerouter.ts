import type {
  CesmModel,
  FunctionalClusterOutput,
} from "../types/index.js";
import type { PlacedComponent, PlacedPad } from "./modular-placer.js";
import { getMinParallelVias, polygonFromRectMm, resolveStackupLayers } from "./spacing-keepout-matrix.js";

export type CriticalTaskKind =
  | "datasheet_layout_copper"
  | "decap_loop"
  | "dcdc_hot_loop"
  | "inline_esd"
  | "guard_ring_clock"
  | "kelvin_sense"
  | "power_trunk";

export interface CriticalPrerouteTask {
  kind: CriticalTaskKind;
  nets: string[];
  widthMm?: number;
  clearanceMm?: number;
  layer?: string;
  anchorDesignator?: string;
  targetComponents?: string[];
  /** For decap_loop */
  icVddPin?: string; // e.g. "U1.19"
  smallCapDesignator?: string;
  bulkCapDesignator?: string;
  /** For inline_esd */
  connectorDesignator?: string;
  connectorPin?: string;
  esdDesignator?: string;
  esdPin?: string;
  esdGndPin?: string;
  targetIcDesignator?: string;
  targetIcPin?: string;
  /** For guard_ring_clock */
  crystalDesignator?: string;
  loadCapDesignators?: string[];
  /** For kelvin_sense */
  shuntDesignator?: string;
  senseTargetDesignator?: string;
  /** For power_trunk parallel vias */
  trunkCurrentA?: number;
  waypointsMm?: Array<[number, number]>;
  lockAfterRoute?: boolean;
}

export interface LockedTrackSegment {
  id: string;
  net: string;
  layer: string;
  widthMm: number;
  pointsMm: Array<[number, number]>;
  primitiveLock: true;
  roleTag: CriticalTaskKind;
  metadata?: {
    stubLengthMm?: number;
    tapSide?: "INNER_PAD_EDGE" | "CENTER";
    forbidBlindThermalVias?: boolean;
    forbidRedundantGuardRing?: boolean;
    routedSequence?: string[];
  };
}

export interface LockedCopperZone {
  id: string;
  net: string;
  layer: string;
  zoneRole: string;
  polygonMm: Array<[number, number]>;
  areaMm2: number;
  primitiveLock: true;
  roleTag: CriticalTaskKind;
}

export interface LockedVia {
  id: string;
  net: string;
  xMm: number;
  yMm: number;
  drillMm: number;
  outerDiaMm: number;
  startLayer: string;
  endLayer: string;
  tentedSolderMask: boolean;
  primitiveLock: true;
  viaRole:
    | "GND_RETURN_CLUSTER"
    | "BOOT_SIGNAL_VIA"
    | "FB_SENSE_ROUTING_VIA"
    | "EPAD_THERMAL_GND"
    | "GUARD_RING_STITCH"
    | "POWER_TRUNK_PARALLEL"
    | "POWER_FEED_VIA";
}

export interface GuardRingSummary {
  crystalDesignator: string;
  layer: string;
  ringPolygonMm: Array<[number, number]>;
  stitchViaCount: number;
  signalViaCount: 0;
  traceLengthsMm: Record<string, number>;
}

export interface KelvinSenseReport {
  shuntDesignator: string;
  topology: "LOW_SIDE_SINGLE_ENDED" | "HIGH_SIDE_KELVIN_PAIR";
  senseNets: string[];
  tappedFromInnerPadEdge: boolean;
  guardRingGenerated: false;
  thermalViasOnPowerOrShunt: 0;
}

export interface CriticalPrerouteResult {
  routedTasks: number;
  lockedPrimitivesCount: number;
  tracks: LockedTrackSegment[];
  copperZones: LockedCopperZone[];
  vias: LockedVia[];
  guardRings: GuardRingSummary[];
  kelvinReports: KelvinSenseReport[];
  lengthMatchReportMm: Record<string, number>;
  forbiddenThermalViaAuditPassed: boolean;
}

function polygonAreaMm2(poly: Array<[number, number]>): number {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

function boundingPolygon(pts: Array<[number, number]>, padMm: number): Array<[number, number]> {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return polygonFromRectMm(0, 0, 2, 2);
  return [
    [Number((minX - padMm).toFixed(4)), Number((minY - padMm).toFixed(4))],
    [Number((maxX + padMm).toFixed(4)), Number((minY - padMm).toFixed(4))],
    [Number((maxX + padMm).toFixed(4)), Number((maxY + padMm).toFixed(4))],
    [Number((minX - padMm).toFixed(4)), Number((maxY + padMm).toFixed(4))],
  ];
}

function polylineLengthMm(pts: Array<[number, number]>): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return Number(len.toFixed(4));
}

function findPad(comp: PlacedComponent | undefined, pinRefOrNet: string): PlacedPad | undefined {
  if (!comp) return undefined;
  const pinNum = pinRefOrNet.includes(".") ? pinRefOrNet.split(".")[1] : pinRefOrNet;
  return (
    comp.pads.find((p) => p.padNumber === pinNum) ??
    comp.pads.find((p) => p.net === pinRefOrNet)
  );
}

export function runCriticalPrerouter(
  placements: PlacedComponent[],
  clusterOutput: FunctionalClusterOutput,
  tasks: CriticalPrerouteTask[],
  cesmLookup?: Map<string, CesmModel> | ((designator: string) => CesmModel | undefined)
): CriticalPrerouteResult {
  const compByDes = new Map<string, PlacedComponent>();
  placements.forEach((p) => compByDes.set(p.designator, p));

  const stackup = resolveStackupLayers(
    clusterOutput.board_outline.layer_count,
    clusterOutput.board_outline.stackup
  );
  const topLayer = stackup[0] ?? "TopLayer";
  const bottomLayer = stackup[stackup.length - 1] ?? "BottomLayer";
  const adjLayer = stackup.length >= 4 ? stackup[1] : bottomLayer;

  const tracks: LockedTrackSegment[] = [];
  const copperZones: LockedCopperZone[] = [];
  const vias: LockedVia[] = [];
  const guardRings: GuardRingSummary[] = [];
  const kelvinReports: KelvinSenseReport[] = [];
  const lengthMatchReportMm: Record<string, number> = {};

  let idSeq = 1;
  const nextId = (prefix: string) => `${prefix}_${idSeq++}`;

  const getCesm = (des: string): CesmModel | undefined => {
    if (!cesmLookup) return undefined;
    return typeof cesmLookup === "function" ? cesmLookup(des) : cesmLookup.get(des);
  };

  for (const task of tasks) {
    const mountLayerFallback = task.layer ?? topLayer;

    switch (task.kind) {
      // ====================================================================
      // 1. Datasheet Layout Example Copper Islands, EPAD Thermal Vias & FB
      // ====================================================================
      case "datasheet_layout_copper": {
        const anchor = task.anchorDesignator ? compByDes.get(task.anchorDesignator) : undefined;
        if (!anchor) break;
        const mountLayer = anchor.side === "BOTTOM" ? bottomLayer : topLayer;
        const cesm = getCesm(anchor.designator);
        const le = cesm?.layoutExample;
        const cluster = clusterOutput.functional_clusters.find(
          (c) => c.anchor_designator === anchor.designator
        );
        const clusterComps = cluster
          ? cluster.members
              .map((m) => compByDes.get(m.designator))
              .filter((x): x is PlacedComponent => Boolean(x))
          : [anchor];

        if (le?.copperZones) {
          for (const cz of le.copperZones) {
            const targetLayer =
              cz.relativeLayer === "OPPOSITE_LAYER"
                ? anchor.side === "BOTTOM"
                  ? topLayer
                  : bottomLayer
                : cz.relativeLayer === "ADJACENT_REF_LAYER"
                  ? adjLayer
                  : mountLayer;

            const matchingPads: PlacedPad[] = [];
            for (const c of clusterComps) {
              for (const pad of c.pads) {
                if (
                  cz.connectedPins.some(
                    (cp) => pad.padNumber === cp || pad.net?.toUpperCase().includes(cp.toUpperCase())
                  ) ||
                  (cz.zoneRole === "VIN_POLYGON" && /VIN|VBUS/i.test(pad.net ?? "")) ||
                  (cz.zoneRole === "VOUT_POLYGON" && /VOUT|3V3|5V/i.test(pad.net ?? "")) ||
                  (cz.zoneRole === "SW_PH_COMPACT_ISLAND" && /\b(?:SW|PH|LX)\b/i.test(pad.net ?? "")) ||
                  (cz.zoneRole === "TOPSIDE_GND_AREA" && /^(?:GND|PGND|AGND)$/i.test(pad.net ?? ""))
                ) {
                  matchingPads.push(pad);
                }
              }
            }

            const pts =
              matchingPads.length > 0
                ? matchingPads.map((p): [number, number] => [p.xMm, p.yMm])
                : [[anchor.xMm, anchor.yMm] as [number, number]];
            let poly = boundingPolygon(pts, cz.areaPolicy === "COMPACT_MIN_PARASITIC" ? 0.45 : 0.85);
            let area = polygonAreaMm2(poly);
            if (cz.maxAreaMm2 && area > cz.maxAreaMm2) {
              // Clamp compact SW island tightly to respect maxAreaMm2
              const scale = Math.sqrt(cz.maxAreaMm2 / area);
              const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
              const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
              poly = poly.map(([x, y]): [number, number] => [
                Number((cx + (x - cx) * scale).toFixed(4)),
                Number((cy + (y - cy) * scale).toFixed(4)),
              ]);
              area = polygonAreaMm2(poly);
            }

            const zoneNet =
              matchingPads.find((p) => p.net)?.net ??
              (cz.zoneRole.includes("GND") ? "GND" : task.nets[0] ?? "PWR");

            copperZones.push({
              id: nextId("CZ"),
              net: zoneNet,
              layer: targetLayer,
              zoneRole: cz.zoneRole,
              polygonMm: poly,
              areaMm2: Number(area.toFixed(3)),
              primitiveLock: true,
              roleTag: "datasheet_layout_copper",
            });
          }
        }

        // Thermal VIA array strictly on static GND EPAD
        if (le?.thermalViaArray) {
          const tv = le.thermalViaArray;
          const epadPad =
            findPad(anchor, tv.epadPinNumber ?? "EP") ??
            anchor.pads.find((p) => /^(?:EP|0)$/i.test(p.padNumber) || /^(?:GND|PGND)$/i.test(p.net ?? ""));
          const cx = epadPad?.xMm ?? anchor.xMm;
          const cy = epadPad?.yMm ?? anchor.yMm;
          const rows = tv.gridRows ?? 2;
          const cols = tv.gridCols ?? 2;
          const maxPitchX = epadPad ? Math.max(0.55, (epadPad.sizeMm[0] * 0.72) / Math.max(1, cols - 1)) : (tv.pitchMm ?? 1.0);
          const maxPitchY = epadPad ? Math.max(0.55, (epadPad.sizeMm[1] * 0.72) / Math.max(1, rows - 1)) : (tv.pitchMm ?? 1.0);
          const pitchX = Math.min(tv.pitchMm ?? 1.0, maxPitchX);
          const pitchY = Math.min(tv.pitchMm ?? 1.0, maxPitchY);
          const drill = tv.drillMm ?? 0.3;

          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const vx = cx + (c - (cols - 1) / 2) * pitchX;
              const vy = cy + (r - (rows - 1) / 2) * pitchY;
              vias.push({
                id: nextId("VIA_EPAD"),
                net: tv.netRole ?? "GND",
                xMm: Number(vx.toFixed(4)),
                yMm: Number(vy.toFixed(4)),
                drillMm: drill,
                outerDiaMm: Number((drill + 0.25).toFixed(3)),
                startLayer: topLayer,
                endLayer: bottomLayer,
                tentedSolderMask: tv.solderMaskTentingOrPlug ?? true,
                primitiveLock: true,
                viaRole: "EPAD_THERMAL_GND",
              });
            }
          }
        }

        // Process sensitiveRouteConstraints (e.g. VSENSE/FB routed behind COUT away from SW/L)
        if (le?.sensitiveRouteConstraints) {
          for (const sc of le.sensitiveRouteConstraints) {
            const fbPad = anchor.pads.find(
              (p) =>
                p.padNumber.toUpperCase() === sc.pinOrNetRole.toUpperCase() ||
                (p.net ?? "").toUpperCase().includes(sc.pinOrNetRole.toUpperCase())
            );
            const coutComp = clusterComps.find((c) =>
              c.role.includes("COUT") || c.role.includes("FILTER")
            );
            const voutPad = coutComp?.pads.find((p) => p.net && !/GND/i.test(p.net));
            if (fbPad && voutPad && fbPad.net) {
              // Route around the back side of COUT away from SW island
              const detourY =
                voutPad.yMm + (voutPad.yMm >= anchor.yMm ? sc.minClearanceMm : -sc.minClearanceMm);
              const pts: Array<[number, number]> = [
                [fbPad.xMm, fbPad.yMm],
                [fbPad.xMm, detourY],
                [voutPad.xMm, detourY],
                [voutPad.xMm, voutPad.yMm],
              ];
              const segLen = polylineLengthMm(pts);
              lengthMatchReportMm[fbPad.net] = segLen;
              tracks.push({
                id: nextId("TRK_FB"),
                net: fbPad.net,
                layer: sc.preferInnerOrOppositeLayer ? adjLayer : mountLayer,
                widthMm: 0.2,
                pointsMm: pts,
                primitiveLock: true,
                roleTag: "datasheet_layout_copper",
                metadata: { forbidBlindThermalVias: true },
              });
            }
          }
        }
        break;
      }

      // ====================================================================
      // 2. Decoupling Loop: Power Via -> Bulk Cap -> Small Cap -> IC VDD
      // ====================================================================
      case "decap_loop": {
        const pwrNet = task.nets.find((n) => !/^GND/i.test(n)) ?? task.nets[0] ?? "3V3";
        const gndNet = task.nets.find((n) => /^GND/i.test(n)) ?? "GND";
        const widthMm = Math.max(0.3, task.widthMm ?? 0.35);

        let icComp: PlacedComponent | undefined;
        let icPad: PlacedPad | undefined;
        if (task.icVddPin && task.icVddPin.includes(".")) {
          const [des, pin] = task.icVddPin.split(".");
          icComp = compByDes.get(des);
          icPad = findPad(icComp, pin);
        } else if (task.anchorDesignator) {
          icComp = compByDes.get(task.anchorDesignator);
          icPad = icComp?.pads.find((p) => p.net === pwrNet);
        }

        const smallCap = task.smallCapDesignator
          ? compByDes.get(task.smallCapDesignator)
          : placements.find(
              (p) =>
                p.designator !== icComp?.designator &&
                /^C\d+/i.test(p.designator) &&
                p.pads.some((pad) => pad.net === pwrNet)
            );
        const bulkCap = task.bulkCapDesignator ? compByDes.get(task.bulkCapDesignator) : undefined;

        if (!icComp || !icPad || !smallCap) break;

        const mountLayer = icComp.side === "BOTTOM" ? bottomLayer : topLayer;
        const smallPwrPad =
          smallCap.pads.find((p) => p.net === pwrNet) ?? smallCap.pads[0];
        const smallGndPad =
          smallCap.pads.find((p) => p.net === gndNet || p !== smallPwrPad) ?? smallCap.pads[1];

        const chainPoints: Array<[number, number]> = [];
        const chainLabels: string[] = [];

        let feedOriginX = smallPwrPad.xMm;
        let feedOriginY = smallPwrPad.yMm;

        if (bulkCap) {
          const bulkPwrPad =
            bulkCap.pads.find((p) => p.net === pwrNet) ?? bulkCap.pads[0];
          const bulkGndPad =
            bulkCap.pads.find((p) => p.net === gndNet || p !== bulkPwrPad) ?? bulkCap.pads[1];

          // Power via placed outboard of bulk cap
          const dx = bulkPwrPad.xMm - smallPwrPad.xMm;
          const dy = bulkPwrPad.yMm - smallPwrPad.yMm;
          const dist = Math.hypot(dx, dy) || 1;
          const viaX = bulkPwrPad.xMm + (dx / dist) * 0.7;
          const viaY = bulkPwrPad.yMm + (dy / dist) * 0.7;

          vias.push({
            id: nextId("VIA_PWR"),
            net: pwrNet,
            xMm: Number(viaX.toFixed(4)),
            yMm: Number(viaY.toFixed(4)),
            drillMm: 0.3,
            outerDiaMm: 0.6,
            startLayer: topLayer,
            endLayer: bottomLayer,
            tentedSolderMask: true,
            primitiveLock: true,
            viaRole: "POWER_FEED_VIA",
          });
          chainPoints.push([Number(viaX.toFixed(4)), Number(viaY.toFixed(4))]);
          chainLabels.push("POWER_VIA");

          chainPoints.push([bulkPwrPad.xMm, bulkPwrPad.yMm]);
          chainLabels.push(`${bulkCap.designator}.${bulkPwrPad.padNumber}`);

          // Dual GND return vias outboard of bulk cap GND pad
          for (const offsetSign of [-1, 1]) {
            vias.push({
              id: nextId("VIA_GND"),
              net: gndNet,
              xMm: Number((bulkGndPad.xMm + offsetSign * 0.35).toFixed(4)),
              yMm: Number((bulkGndPad.yMm + 0.45).toFixed(4)),
              drillMm: 0.3,
              outerDiaMm: 0.6,
              startLayer: topLayer,
              endLayer: bottomLayer,
              tentedSolderMask: true,
              primitiveLock: true,
              viaRole: "GND_RETURN_CLUSTER",
            });
          }
          feedOriginX = bulkPwrPad.xMm;
          feedOriginY = bulkPwrPad.yMm;
        } else {
          // Place power feed via outboard of small cap away from IC pin
          const dx = smallPwrPad.xMm - icPad.xMm;
          const dy = smallPwrPad.yMm - icPad.yMm;
          const dist = Math.hypot(dx, dy) || 1;
          const viaX = smallPwrPad.xMm + (dx / dist) * 0.65;
          const viaY = smallPwrPad.yMm + (dy / dist) * 0.65;

          vias.push({
            id: nextId("VIA_PWR"),
            net: pwrNet,
            xMm: Number(viaX.toFixed(4)),
            yMm: Number(viaY.toFixed(4)),
            drillMm: 0.3,
            outerDiaMm: 0.6,
            startLayer: topLayer,
            endLayer: bottomLayer,
            tentedSolderMask: true,
            primitiveLock: true,
            viaRole: "POWER_FEED_VIA",
          });
          chainPoints.push([Number(viaX.toFixed(4)), Number(viaY.toFixed(4))]);
          chainLabels.push("POWER_VIA");
          void feedOriginX;
          void feedOriginY;
        }

        chainPoints.push([smallPwrPad.xMm, smallPwrPad.yMm]);
        chainLabels.push(`${smallCap.designator}.${smallPwrPad.padNumber}`);
        chainPoints.push([icPad.xMm, icPad.yMm]);
        chainLabels.push(`${icComp.designator}.${icPad.padNumber}`);

        // Dual GND return vias directly outboard of small cap GND pad
        const gOutX = smallGndPad.xMm - smallPwrPad.xMm;
        const gOutY = smallGndPad.yMm - smallPwrPad.yMm;
        const gLen = Math.hypot(gOutX, gOutY) || 1;
        const gx = gOutX / gLen;
        const gy = gOutY / gLen;
        const px = -gy;
        const py = gx;

        for (const sideSign of [-0.35, 0.35]) {
          vias.push({
            id: nextId("VIA_GND"),
            net: gndNet,
            xMm: Number((smallGndPad.xMm + gx * 0.5 + px * sideSign).toFixed(4)),
            yMm: Number((smallGndPad.yMm + gy * 0.5 + py * sideSign).toFixed(4)),
            drillMm: 0.3,
            outerDiaMm: 0.6,
            startLayer: topLayer,
            endLayer: bottomLayer,
            tentedSolderMask: true,
            primitiveLock: true,
            viaRole: "GND_RETURN_CLUSTER",
          });
        }

        lengthMatchReportMm[`${pwrNet}_${icComp.designator}`] = polylineLengthMm(chainPoints);
        tracks.push({
          id: nextId("TRK_DECAP"),
          net: pwrNet,
          layer: mountLayer,
          widthMm,
          pointsMm: chainPoints,
          primitiveLock: true,
          roleTag: "decap_loop",
          metadata: {
            routedSequence: chainLabels,
            forbidBlindThermalVias: true,
          },
        });
        break;
      }

      // ====================================================================
      // 3. DC-DC Hot Loop: Compact SW Copper Block, Zero Blind Thermal Vias
      // ====================================================================
      case "dcdc_hot_loop": {
        const swNet = task.nets.find((n) => /\b(?:SW|LX|PH)\b/i.test(n)) ?? task.nets[0] ?? "SW";
        const targetNames = new Set(task.targetComponents ?? []);
        const swPads: PlacedPad[] = [];

        for (const p of placements) {
          if (targetNames.size > 0 && !targetNames.has(p.designator)) continue;
          for (const pad of p.pads) {
            if (pad.net === swNet) swPads.push(pad);
          }
        }
        if (swPads.length === 0) break;

        const swPoly = boundingPolygon(
          swPads.map((p): [number, number] => [p.xMm, p.yMm]),
          0.45
        );
        copperZones.push({
          id: nextId("CZ_SW"),
          net: swNet,
          layer: mountLayerFallback,
          zoneRole: "SW_PH_COMPACT_ISLAND",
          polygonMm: swPoly,
          areaMm2: Number(polygonAreaMm2(swPoly).toFixed(3)),
          primitiveLock: true,
          roleTag: "dcdc_hot_loop",
        });

        // Connect hot loop pads with short thick track; NEVER inject thermal vias on SW!
        if (swPads.length >= 2) {
          const pts = swPads.map((p): [number, number] => [p.xMm, p.yMm]);
          lengthMatchReportMm[swNet] = polylineLengthMm(pts);
          tracks.push({
            id: nextId("TRK_SW"),
            net: swNet,
            layer: mountLayerFallback,
            widthMm: Math.max(0.8, task.widthMm ?? 1.0),
            pointsMm: pts,
            primitiveLock: true,
            roleTag: "dcdc_hot_loop",
            metadata: { forbidBlindThermalVias: true },
          });
        }
        break;
      }

      // ====================================================================
      // 4. Inline ESD: Zero-Stub Straight Through Pad + Dual GND Vias
      // ====================================================================
      case "inline_esd": {
        const conn = task.connectorDesignator ? compByDes.get(task.connectorDesignator) : undefined;
        const esd = task.esdDesignator ? compByDes.get(task.esdDesignator) : undefined;
        const ic = task.targetIcDesignator ? compByDes.get(task.targetIcDesignator) : undefined;
        const net = task.nets[0] ?? "USB_DP";
        if (!conn || !esd || !ic) break;

        const connPad =
          (task.connectorPin ? findPad(conn, task.connectorPin) : undefined) ??
          conn.pads.find((p) => p.net === net);
        const esdPad =
          (task.esdPin ? findPad(esd, task.esdPin) : undefined) ??
          esd.pads.find((p) => p.net === net);
        const icPad =
          (task.targetIcPin ? findPad(ic, task.targetIcPin) : undefined) ??
          ic.pads.find((p) => p.net === net);
        const esdGndPad =
          (task.esdGndPin ? findPad(esd, task.esdGndPin) : undefined) ??
          esd.pads.find((p) => /^(?:GND|PGND)$/i.test(p.net ?? ""));

        if (!connPad || !esdPad || !icPad) break;

        const pts: Array<[number, number]> = [
          [connPad.xMm, connPad.yMm],
          [esdPad.xMm, esdPad.yMm], // Strictly passes through center of ESD pad -> stubLengthMm = 0!
          [icPad.xMm, icPad.yMm],
        ];
        lengthMatchReportMm[net] = polylineLengthMm(pts);
        tracks.push({
          id: nextId("TRK_ESD"),
          net,
          layer: mountLayerFallback,
          widthMm: task.widthMm ?? 0.25,
          pointsMm: pts,
          primitiveLock: true,
          roleTag: "inline_esd",
          metadata: { stubLengthMm: 0.0 },
        });

        // Dual GND discharge vias immediately outboard of ESD GND pad
        if (esdGndPad) {
          const gndNet = esdGndPad.net ?? "GND";
          for (const offset of [-0.35, 0.35]) {
            vias.push({
              id: nextId("VIA_ESD_GND"),
              net: gndNet,
              xMm: Number((esdGndPad.xMm + offset).toFixed(4)),
              yMm: Number((esdGndPad.yMm + (esdGndPad.yMm >= esd.yMm ? 0.55 : -0.55)).toFixed(4)),
              drillMm: 0.3,
              outerDiaMm: 0.6,
              startLayer: topLayer,
              endLayer: bottomLayer,
              tentedSolderMask: true,
              primitiveLock: true,
              viaRole: "GND_RETURN_CLUSTER",
            });
          }
        }
        break;
      }

      // ====================================================================
      // 5. Guard Ring Clock: 0-Via Top-Layer Short Trace + Closed GND Ring
      // ====================================================================
      case "guard_ring_clock": {
        const xtal = task.crystalDesignator ? compByDes.get(task.crystalDesignator) : undefined;
        const mcu = task.anchorDesignator ? compByDes.get(task.anchorDesignator) : undefined;
        if (!xtal || !mcu) break;

        const mountLayer = xtal.side === "BOTTOM" ? bottomLayer : topLayer;
        const loadCaps = (task.loadCapDesignators ?? [])
          .map((d) => compByDes.get(d))
          .filter((c): c is PlacedComponent => Boolean(c));

        const oscNets = task.nets.length > 0 ? task.nets : ["OSC_IN", "OSC_OUT"];
        const traceLengths: Record<string, number> = {};
        const enclosedPads: Array<[number, number]> = [];

        for (const oscNet of oscNets) {
          const mcuPad = mcu.pads.find((p) => p.net === oscNet);
          const xtalPad = xtal.pads.find((p) => p.net === oscNet);
          const capPad = loadCaps
            .flatMap((c) => c.pads)
            .find((p) => p.net === oscNet);

          const pts: Array<[number, number]> = [];
          if (mcuPad) pts.push([mcuPad.xMm, mcuPad.yMm]);
          if (xtalPad) {
            pts.push([xtalPad.xMm, xtalPad.yMm]);
            enclosedPads.push([xtalPad.xMm, xtalPad.yMm]);
          }
          if (capPad) {
            pts.push([capPad.xMm, capPad.yMm]);
            enclosedPads.push([capPad.xMm, capPad.yMm]);
          }
          if (pts.length >= 2) {
            const len = polylineLengthMm(pts);
            traceLengths[oscNet] = len;
            lengthMatchReportMm[oscNet] = len;
            tracks.push({
              id: nextId("TRK_XTAL"),
              net: oscNet,
              layer: mountLayer, // Strictly mount layer, 0 vias!
              widthMm: task.widthMm ?? 0.18,
              pointsMm: pts,
              primitiveLock: true,
              roleTag: "guard_ring_clock",
            });
          }
        }

        // Closed GND guard ring enclosing crystal + load caps (min 0.25mm width, 2.5mm via pitch)
        const allEnvelopePts: Array<[number, number]> = [
          [xtal.xMm - xtal.bboxMm[0] / 2, xtal.yMm - xtal.bboxMm[1] / 2],
          [xtal.xMm + xtal.bboxMm[0] / 2, xtal.yMm + xtal.bboxMm[1] / 2],
          ...loadCaps.flatMap((c): Array<[number, number]> => [
            [c.xMm - c.bboxMm[0] / 2, c.yMm - c.bboxMm[1] / 2],
            [c.xMm + c.bboxMm[0] / 2, c.yMm + c.bboxMm[1] / 2],
          ]),
          ...enclosedPads,
        ];

        const ringRect = boundingPolygon(allEnvelopePts, 0.55);
        const closedRingPts = [...ringRect, ringRect[0]];
        tracks.push({
          id: nextId("TRK_GUARD_RING"),
          net: "GND",
          layer: mountLayer,
          widthMm: 0.3, // >= 0.25 mm required
          pointsMm: closedRingPts,
          primitiveLock: true,
          roleTag: "guard_ring_clock",
        });

        // Stitch GND vias along closed guard ring at <= 2.5 mm spacing
        let stitchCount = 0;
        for (let e = 0; e < 4; e++) {
          const p0 = ringRect[e];
          const p1 = ringRect[(e + 1) % 4];
          const edgeLen = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
          const steps = Math.max(1, Math.ceil(edgeLen / 2.4));
          for (let s = 0; s < steps; s++) {
            const t = s / steps;
            vias.push({
              id: nextId("VIA_GUARD"),
              net: "GND",
              xMm: Number((p0[0] + (p1[0] - p0[0]) * t).toFixed(4)),
              yMm: Number((p0[1] + (p1[1] - p0[1]) * t).toFixed(4)),
              drillMm: 0.3,
              outerDiaMm: 0.55,
              startLayer: topLayer,
              endLayer: bottomLayer,
              tentedSolderMask: true,
              primitiveLock: true,
              viaRole: "GUARD_RING_STITCH",
            });
            stitchCount++;
          }
        }

        guardRings.push({
          crystalDesignator: xtal.designator,
          layer: mountLayer,
          ringPolygonMm: ringRect,
          stitchViaCount: stitchCount,
          signalViaCount: 0,
          traceLengthsMm: traceLengths,
        });
        break;
      }

      // ====================================================================
      // 6. Kelvin Sense: Low-Side Single-Ended vs High-Side Dual Inner-Edge Tap
      //    NEVER forces guard ring, NEVER places blind thermal vias!
      // ====================================================================
      case "kelvin_sense": {
        const shunt = task.shuntDesignator ? compByDes.get(task.shuntDesignator) : undefined;
        const amp = task.senseTargetDesignator
          ? compByDes.get(task.senseTargetDesignator)
          : task.anchorDesignator
            ? compByDes.get(task.anchorDesignator)
            : undefined;
        if (!shunt || shunt.pads.length < 2) break;

        const mountLayer = shunt.side === "BOTTOM" ? bottomLayer : topLayer;
        const pad1 = shunt.pads[0];
        const pad2 = shunt.pads[1];
        const isGnd1 = /^(?:GND|PGND|AGND)$/i.test(pad1.net ?? "");
        const isGnd2 = /^(?:GND|PGND|AGND)$/i.test(pad2.net ?? "");

        const isLowSideSingleEnded = (isGnd1 && !isGnd2) || (isGnd2 && !isGnd1);
        const cx = shunt.xMm;
        const cy = shunt.yMm;

        // Inner edge of pad points inward toward component center (cx, cy) — away from outer heavy power trace!
        const innerTapPoint = (pad: PlacedPad): [number, number] => {
          const dx = cx - pad.xMm;
          const dy = cy - pad.yMm;
          const dist = Math.hypot(dx, dy) || 1;
          const shift = Math.min(pad.sizeMm[0], pad.sizeMm[1]) * 0.35;
          return [
            Number((pad.xMm + (dx / dist) * shift).toFixed(4)),
            Number((pad.yMm + (dy / dist) * shift).toFixed(4)),
          ];
        };

        if (isLowSideSingleEnded) {
          const hotPad = isGnd1 ? pad2 : pad1;
          const senseNet = hotPad.net ?? task.nets[0] ?? "I_SENSE";
          const tapPt = innerTapPoint(hotPad);
          const targetPad = amp?.pads.find((p) => p.net === senseNet) ?? amp?.pads[0];
          const destPt: [number, number] = targetPad
            ? [targetPad.xMm, targetPad.yMm]
            : [tapPt[0], tapPt[1] + 4.0];

          const pts: Array<[number, number]> = [tapPt, [tapPt[0], destPt[1]], destPt];
          lengthMatchReportMm[senseNet] = polylineLengthMm(pts);
          tracks.push({
            id: nextId("TRK_KELVIN_SE"),
            net: senseNet,
            layer: mountLayer,
            widthMm: 0.18,
            pointsMm: pts,
            primitiveLock: true,
            roleTag: "kelvin_sense",
            metadata: {
              tapSide: "INNER_PAD_EDGE",
              forbidBlindThermalVias: true,
              forbidRedundantGuardRing: true,
            },
          });

          kelvinReports.push({
            shuntDesignator: shunt.designator,
            topology: "LOW_SIDE_SINGLE_ENDED",
            senseNets: [senseNet],
            tappedFromInnerPadEdge: true,
            guardRingGenerated: false,
            thermalViasOnPowerOrShunt: 0,
          });
        } else {
          // High-side / Dual-ended Kelvin pair: tap inner edges of BOTH pads, route tightly parallel (no guard ring!)
          const net1 = pad1.net ?? task.nets[0] ?? "SENSE_P";
          const net2 = pad2.net ?? task.nets[1] ?? "SENSE_N";
          const tap1 = innerTapPoint(pad1);
          const tap2 = innerTapPoint(pad2);

          const ampPad1 = amp?.pads.find((p) => p.net === net1);
          const ampPad2 = amp?.pads.find((p) => p.net === net2);
          const midX = (tap1[0] + tap2[0]) / 2;
          const dirY = amp ? (amp.yMm >= cy ? 1 : -1) : 1;
          const meetY = cy + dirY * 1.2;

          const dest1: [number, number] = ampPad1
            ? [ampPad1.xMm, ampPad1.yMm]
            : [midX - 0.18, meetY + dirY * 4.0];
          const dest2: [number, number] = ampPad2
            ? [ampPad2.xMm, ampPad2.yMm]
            : [midX + 0.18, meetY + dirY * 4.0];

          const pts1: Array<[number, number]> = [tap1, [midX - 0.18, meetY], dest1];
          const pts2: Array<[number, number]> = [tap2, [midX + 0.18, meetY], dest2];

          lengthMatchReportMm[net1] = polylineLengthMm(pts1);
          lengthMatchReportMm[net2] = polylineLengthMm(pts2);

          for (const [netName, pts] of [
            [net1, pts1],
            [net2, pts2],
          ] as Array<[string, Array<[number, number]>]>) {
            tracks.push({
              id: nextId("TRK_KELVIN_DIFF"),
              net: netName,
              layer: mountLayer,
              widthMm: 0.18,
              pointsMm: pts,
              primitiveLock: true,
              roleTag: "kelvin_sense",
              metadata: {
                tapSide: "INNER_PAD_EDGE",
                forbidBlindThermalVias: true,
                forbidRedundantGuardRing: true,
              },
            });
          }

          kelvinReports.push({
            shuntDesignator: shunt.designator,
            topology: "HIGH_SIDE_KELVIN_PAIR",
            senseNets: [net1, net2],
            tappedFromInnerPadEdge: true,
            guardRingGenerated: false,
            thermalViasOnPowerOrShunt: 0,
          });
        }
        break;
      }

      // ====================================================================
      // 7. Power Trunk Parallel Cluster Vias (Table 9-4)
      // ====================================================================
      case "power_trunk": {
        const net = task.nets[0] ?? "PWR";
        const currentA = task.trunkCurrentA ?? 3.0;
        const drillMm = 0.3;
        const count = getMinParallelVias(currentA, drillMm);
        const pts = task.waypointsMm ?? [];
        if (pts.length >= 2) {
          lengthMatchReportMm[net] = polylineLengthMm(pts);
          tracks.push({
            id: nextId("TRK_PWR"),
            net,
            layer: mountLayerFallback,
            widthMm: task.widthMm ?? 1.4,
            pointsMm: pts,
            primitiveLock: true,
            roleTag: "power_trunk",
          });
          // Parallel via cluster at trunk transition endpoint
          const [vx0, vy0] = pts[pts.length - 1];
          const cols = Math.ceil(Math.sqrt(count));
          for (let k = 0; k < count; k++) {
            const r = Math.floor(k / cols);
            const c = k % cols;
            vias.push({
              id: nextId("VIA_TRUNK"),
              net,
              xMm: Number((vx0 + c * 0.85).toFixed(4)),
              yMm: Number((vy0 + r * 0.85).toFixed(4)),
              drillMm,
              outerDiaMm: 0.6,
              startLayer: topLayer,
              endLayer: bottomLayer,
              tentedSolderMask: true,
              primitiveLock: true,
              viaRole: "POWER_TRUNK_PARALLEL",
            });
          }
        }
        break;
      }
    }
  }

  // Self-audit: verify NO blind thermal vias were generated on SW/power/kelvin traces
  const hasForbiddenThermalVia = vias.some(
    (v) =>
      v.viaRole === "EPAD_THERMAL_GND" &&
      !/^(?:GND|AGND|PGND)$/i.test(v.net)
  );

  return {
    routedTasks: tasks.length,
    lockedPrimitivesCount: tracks.length + copperZones.length + vias.length,
    tracks,
    copperZones,
    vias,
    guardRings,
    kelvinReports,
    lengthMatchReportMm,
    forbiddenThermalViaAuditPassed: !hasForbiddenThermalVia,
  };
}
