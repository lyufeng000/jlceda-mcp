import {
  Clipper,
  FillRule,
  Paths64,
} from "clipper2-js";
import {
  errEnvelope,
  okEnvelope,
  type Keepout25DFiveTuple,
  type KeepoutDisallowKind,
  type McpToolHandler,
  type ProjectDesignRules,
} from "../types/index.js";
import {
  buildPolygonPours,
  clusterCompiledNetlist,
  fromClipperPath64,
  generate25DKeepoutFiveTuples,
  getMinParallelVias,
  getRotatedDims,
  normalizeProjectDesignRules,
  polygonFromRectMm,
  resolveRelativeLayerToken,
  resolveStackupLayers,
  routeDifferentialPair,
  runCriticalPrerouter,
  runHybridAutoroute,
  runPourAndStitch,
  solveModularPlacement,
  synthesizeNetClasses,
  tidySilkscreen,
  toClipperPath64,
  type CriticalPrerouteTask,
  type ExplicitComponentTransform,
  type FloorplanZoneInput,
  type PourZoneRequest,
  type StitchingViaOptions,
} from "../layout-routing/index.js";
import {
  compileSchematicNetlist,
  getWorkspaceState,
  type WorkspaceDocument,
} from "./state.js";

function syncKeepoutsToPlacements(pcb: NonNullable<WorkspaceDocument["pcb"]>): void {
  const stackup = resolveStackupLayers(pcb.boardOutline.layerCount, pcb.boardOutline.stackup);
  const byDes = new Map(pcb.placements.map((pl) => [pl.designator, pl]));

  pcb.keepoutZones25D = pcb.keepoutZones25D.map((ko) => {
    const owner = ko.ownerDesignator ? byDes.get(ko.ownerDesignator) : undefined;
    const mountSide = owner ? owner.side : ko.mountSide;

    const resolvedLayers = Array.from(
      new Set(
        ko.layerSet.flatMap((token) =>
          resolveRelativeLayerToken(token, mountSide === "BOTTOM" ? "BOTTOM" : "TOP", stackup)
        )
      )
    );

    let poly = ko.polygon2D;
    if (owner && ko.polygon2D.length >= 3) {
      const xs = ko.polygon2D.map((p) => p[0]);
      const ys = ko.polygon2D.map((p) => p[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const isOriginPlaceholder =
        Math.max(...xs) <= 3 && Math.min(...xs) >= -3 && Math.hypot(owner.xMm, owner.yMm) > 5;
      const isCompBodyKeepout =
        ko.category === "POWER_INDUCTOR" ||
        ko.category === "FERRITE_OR_CMC" ||
        ko.category === "PASSIVE_CRYSTAL" ||
        /POWER_INDUCTOR|FERRITE|CMC|XTAL/i.test(ko.id ?? "");
      if (isOriginPlaceholder || (isCompBodyKeepout && Math.hypot(cx - owner.xMm, cy - owner.yMm) > 0.2)) {
        const [rw, rh] = getRotatedDims(owner.bboxMm, owner.rotationDeg);
        poly = [
          [Number((owner.xMm - rw / 2).toFixed(4)), Number((owner.yMm - rh / 2).toFixed(4))],
          [Number((owner.xMm + rw / 2).toFixed(4)), Number((owner.yMm - rh / 2).toFixed(4))],
          [Number((owner.xMm + rw / 2).toFixed(4)), Number((owner.yMm + rh / 2).toFixed(4))],
          [Number((owner.xMm - rw / 2).toFixed(4)), Number((owner.yMm + rh / 2).toFixed(4))],
        ];
      }
    }

    return {
      ...ko,
      mountSide,
      layerSet: resolvedLayers.length > 0 ? resolvedLayers : ko.layerSet,
      polygon2D: poly,
    };
  });
}

function collectEffectiveKeepouts25D(pcb: NonNullable<WorkspaceDocument["pcb"]>): Keepout25DFiveTuple[] {
  syncKeepoutsToPlacements(pcb);
  const holeDefaults: Record<string, number> = { M2: 4.5, M2_5: 5.5, "M2.5": 5.5, M3: 7.0, M4: 9.0 };
  const holeKeepouts: Keepout25DFiveTuple[] = [];
  for (const m of pcb.boardOutline.mountingHoles ?? []) {
    const reqDia = Math.max(
      m.keepoutDiaMm ?? 0,
      holeDefaults[m.size?.toUpperCase() ?? ""] ?? (m.drillMm >= 4.0 ? 9.0 : m.drillMm >= 3.0 ? 7.0 : 4.5)
    );
    const rad = reqDia / 2 + 0.05;
    const pts: Array<[number, number]> = [];
    for (let k = 0; k < 20; k++) {
      const a = (2 * Math.PI * k) / 20;
      pts.push([
        Number((m.centerMm[0] + rad * Math.cos(a)).toFixed(4)),
        Number((m.centerMm[1] + rad * Math.sin(a)).toFixed(4)),
      ]);
    }
    holeKeepouts.push(
      ...generate25DKeepoutFiveTuples({
        id: `KO_MECH_${m.id}`,
        category: "MOUNTING_HOLE",
        ownerDesignator: m.id,
        polygon2D: pts,
        mountSide: "TOP",
        layerCount: pcb.boardOutline.layerCount,
        stackup: pcb.boardOutline.stackup,
      })
    );
  }
  return [...pcb.keepoutZones25D, ...holeKeepouts];
}

function computePolygonArea(poly: Array<[number, number]>): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/**
 * 网格路由器按走线中心线判定 Keep-out，传入前将禁布区外扩半线宽+对角安全裕量，
 * 防止走线实体边缘蹭擦电感/晶振/安装孔 Keep-out 边界导致 PLINT-10。
 */
function expandKeepoutsForAutoroute(
  keepouts: Keepout25DFiveTuple[],
  defaultMarginMm = 0.72
): Keepout25DFiveTuple[] {
  return keepouts.map((ko) => {
    if (!ko.disallowMask.includes("TRACK") || ko.polygon2D.length < 3) return ko;
    const marginMm =
      ko.category === "PASSIVE_CRYSTAL" ||
      ko.category === "POWER_INDUCTOR" ||
      /POWER_INDUCTOR|XTAL/i.test(ko.id ?? "")
        ? 0.92
        : defaultMarginMm;
    const xs = ko.polygon2D.map((p) => p[0]);
    const ys = ko.polygon2D.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const isRect = ko.polygon2D.length <= 4;
    const expanded: Array<[number, number]> = ko.polygon2D.map(([x, y]) => {
      const dx = x - cx;
      const dy = y - cy;
      if (isRect) {
        return [
          Number((x + (dx >= 0 ? marginMm : -marginMm)).toFixed(4)),
          Number((y + (dy >= 0 ? marginMm : -marginMm)).toFixed(4)),
        ];
      }
      const len = Math.hypot(dx, dy) || 1;
      return [
        Number((x + (dx / len) * marginMm).toFixed(4)),
        Number((y + (dy / len) * marginMm).toFixed(4)),
      ];
    });
    return { ...ko, polygon2D: expanded };
  });
}

function resolveFootprintBboxMm(
  footprint: string,
  pinCount: number
): [number, number] {
  const fp = footprint.toUpperCase();
  if (/MOV-?14D/i.test(fp)) return [12.5, 4.5];
  if (/TERM-?2P-?7\.62/i.test(fp)) return [12.5, 4.5];
  if (/0201/.test(fp)) return [0.7, 0.4];
  if (/0402/.test(fp)) return [1.1, 0.6];
  if (/0603/.test(fp)) return [1.7, 0.95];
  if (/0805/.test(fp)) return [2.2, 1.4];
  if (/1206/.test(fp)) return [3.4, 1.8];
  if (/1210/.test(fp)) return [3.4, 2.7];
  if (/2512/.test(fp)) return [6.5, 3.4];
  if (/SOT-?23-?[56]/.test(fp)) return [3.1, 3.0];
  if (/SOT-?23/.test(fp)) return [3.0, 2.5];
  if (/SOT-?223/.test(fp)) return [6.7, 7.2];
  if (/SOT-?89/.test(fp)) return [4.7, 4.3];
  if (/SMA|DO-?214AC/.test(fp)) return [5.2, 2.8];
  if (/SMB|DO-?214AA/.test(fp)) return [5.6, 3.8];
  if (/3225|XTAL/.test(fp)) return [3.4, 2.7];
  if (/HC-?49/.test(fp)) return [11.5, 4.8];
  if (/IND.*5050|5040|5020/.test(fp)) return [5.4, 5.2];
  if (/IND.*4040|4020|4030/.test(fp)) return [4.3, 4.3];
  if (/IND.*6060|0630/.test(fp)) return [6.8, 6.8];
  if (/LQFP-?100/.test(fp)) return [16.4, 16.4];
  if (/LQFP-?64/.test(fp)) return [12.4, 12.4];
  if (/LQFP-?48/.test(fp)) return [9.4, 9.4];
  if (/QFN-?48/.test(fp)) return [7.2, 7.2];
  if (/QFN-?32/.test(fp)) return [5.2, 5.2];
  if (/QFN-?24|QFN-?20|QFN-?16/.test(fp)) return [4.2, 4.2];
  if (/SOIC-?8|SOP-?8|MSOP-?8/.test(fp)) return [6.2, 5.2];
  if (/SOIC-?16|SOP-?16|TSSOP-?16/.test(fp)) return [10.2, 6.2];
  if (/USB-?C|TYPE-?C/.test(fp)) return [9.0, 7.4];
  if (/RJ45/.test(fp)) return [16.0, 18.0];
  if (/RELAY/.test(fp)) return [19.0, 15.5];
  if (/ESP32|WROOM/.test(fp)) return [18.0, 25.5];
  if (/ELEC|6\.3X/.test(fp)) return [6.6, 6.6];
  if (pinCount >= 48) return [12.0, 12.0];
  if (pinCount >= 16) return [7.0, 6.0];
  if (pinCount >= 6) return [4.0, 3.5];
  return [2.0, 1.5];
}

export const jlcPcbBoardSetupTool: McpToolHandler = {
  name: "jlc_pcb_board_setup",
  layer: 5,
  description:
    "定义 PCB 板框、铣槽/隔热槽、层叠结构、安装孔、分层 2.5D Keep-out，并双向同步当前工程原生 DRC 规则与分级 NetClass。",
  inputSchema: {
    type: "object",
    required: ["document"],
    properties: {
      document: { type: "string" },
      outlineMm: {
        type: "object",
        properties: {
          shape: { type: "string", enum: ["RECTANGLE", "POLYGON"], default: "RECTANGLE" },
          widthMm: { type: "number" },
          heightMm: { type: "number" },
          polygonMm: { type: "array", items: { type: "array" } },
        },
      },
      cutoutsMm: { type: "array", items: { type: "object" } },
      layerStackup: {
        type: "object",
        properties: {
          layerCount: { type: "integer", enum: [2, 4, 6, 8], default: 4 },
          copperWeightOuterOz: { type: "number", default: 1.0 },
          stackup: { type: "array", items: { type: "string" } },
        },
      },
      mountingHoles: { type: "array", items: { type: "object" } },
      keepoutZones: { type: "array", items: { type: "object" } },
      ruleSyncMode: {
        type: "string",
        enum: ["read_only", "merge_project_first", "write_computed_netclasses"],
        default: "merge_project_first",
      },
      edaDesignRules: { type: "object" },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const doc = state.resolveDocument(String(args.document));
    if (!doc || !doc.pcb) {
      return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `PCB document '${String(args.document)}' not found.`);
    }

    const pcb = doc.pcb;
    const outlineIn = args.outlineMm as
      | { shape?: "RECTANGLE" | "POLYGON"; widthMm?: number; heightMm?: number; polygonMm?: Array<[number, number]> }
      | undefined;
    if (outlineIn) {
      if (outlineIn.shape) pcb.boardOutline.shape = outlineIn.shape;
      if (typeof outlineIn.widthMm === "number") pcb.boardOutline.widthMm = outlineIn.widthMm;
      if (typeof outlineIn.heightMm === "number") pcb.boardOutline.heightMm = outlineIn.heightMm;
      if (Array.isArray(outlineIn.polygonMm)) pcb.boardOutline.polygonMm = outlineIn.polygonMm;
    }

    const stackIn = args.layerStackup as
      | { layerCount?: number; copperWeightOuterOz?: number; stackup?: string[] }
      | undefined;
    if (stackIn) {
      const lc = stackIn.layerCount ?? pcb.boardOutline.layerCount;
      pcb.boardOutline.layerCount = lc;
      pcb.boardOutline.stackup = resolveStackupLayers(lc, stackIn.stackup);
      if (typeof stackIn.copperWeightOuterOz === "number") {
        pcb.boardOutline.copperWeightOuterOz = stackIn.copperWeightOuterOz;
      }
    }

    if (Array.isArray(args.cutoutsMm)) {
      pcb.boardOutline.isolationSlots = (args.cutoutsMm as Array<Record<string, unknown>>).map(
        (c, idx) => {
          const rect = c.rectMm as [number, number, number, number] | undefined;
          const poly =
            (c.polygon2D as Array<[number, number]> | undefined) ??
            (rect
              ? [
                  [rect[0], rect[1]],
                  [rect[2], rect[1]],
                  [rect[2], rect[3]],
                  [rect[0], rect[3]],
                ]
              : polygonFromRectMm(0, 0, 2, 10));
          const widthMm =
            typeof c.widthMm === "number"
              ? c.widthMm
              : rect
                ? Math.min(Math.abs(rect[2] - rect[0]), Math.abs(rect[3] - rect[1]))
                : 2.0;
          return {
            id: typeof c.id === "string" ? c.id : `SLOT_${idx + 1}`,
            polygon2D: poly,
            widthMm,
          };
        }
      );
    }

    if (Array.isArray(args.mountingHoles)) {
      pcb.boardOutline.mountingHoles = (args.mountingHoles as Array<Record<string, unknown>>).map(
        (m, idx) => ({
          id: typeof m.id === "string" ? m.id : `MH_${idx + 1}`,
          size: typeof m.size === "string" ? m.size : "M3",
          centerMm: (m.centerMm as [number, number]) ?? [Number(m.xMm ?? 4), Number(m.yMm ?? 4)],
          drillMm: Number(m.drillMm ?? 3.2),
          keepoutDiaMm: Number(m.keepoutDiaMm ?? 7.0),
          isGrounded: Boolean(m.isGrounded),
        })
      );
    }

    let keepoutsCreated = 0;
    if (Array.isArray(args.keepoutZones)) {
      for (const kz of args.keepoutZones as Array<Record<string, unknown>>) {
        const poly = (kz.polygonMm ?? kz.polygon2D) as Array<[number, number]>;
        if (!Array.isArray(poly) || poly.length < 3) continue;
        const tuple: Keepout25DFiveTuple = {
          id: typeof kz.id === "string" ? kz.id : state.nextId("KO"),
          ownerDesignator: typeof kz.ownerDesignator === "string" ? kz.ownerDesignator : undefined,
          polygon2D: poly,
          layerSet: Array.isArray(kz.layerSet) ? (kz.layerSet as string[]) : ["TopLayer"],
          disallowMask: Array.isArray(kz.disallowMask)
            ? (kz.disallowMask as KeepoutDisallowKind[])
            : ["COPPER_POUR", "TRACK"],
          allowedNets: Array.isArray(kz.allowedNets) ? (kz.allowedNets as string[]) : [],
          mountSide: (kz.mountSide as "TOP" | "BOTTOM" | "ALL") ?? "TOP",
        };
        pcb.keepoutZones25D.push(tuple);
        keepoutsCreated++;
      }
    }

    const ruleSyncMode = String(args.ruleSyncMode ?? "merge_project_first");
    const edaRulesIn = args.edaDesignRules as Partial<ProjectDesignRules> | undefined;
    if (ruleSyncMode !== "read_only") {
      const merged = normalizeProjectDesignRules({
        ...pcb.projectDesignRules,
        ...(edaRulesIn ?? {}),
        netClasses: {
          ...pcb.projectDesignRules.netClasses,
          ...(edaRulesIn?.netClasses ?? {}),
        },
        source: edaRulesIn ? "JLC_PROJECT_DRC_MERGED" : pcb.projectDesignRules.source,
      });
      const schDoc = pcb.sourceSchDocument ? state.resolveDocument(pcb.sourceSchDocument) : undefined;
      const handoff = schDoc?.sch?.lastElintReport?.constraintHandoffPackage;
      if (handoff) {
        const synthesized = synthesizeNetClasses(handoff, merged);
        merged.netClasses = { ...synthesized, ...merged.netClasses };
      }
      pcb.projectDesignRules = merged;
    }

    doc.isDirty = true;
    const area =
      pcb.boardOutline.shape === "POLYGON" && pcb.boardOutline.polygonMm
        ? computePolygonArea(pcb.boardOutline.polygonMm)
        : pcb.boardOutline.widthMm * pcb.boardOutline.heightMm;

    return okEnvelope({
      boardAreaMm2: Number(area.toFixed(2)),
      bboxMm: [0, 0, pcb.boardOutline.widthMm, pcb.boardOutline.heightMm],
      projectDesignRules: pcb.projectDesignRules,
      rulesApplied: Object.keys(pcb.projectDesignRules.netClasses).length,
      keepoutsCreated,
    });
  },
};

export const jlcPcbClusterNetlistTool: McpToolHandler = {
  name: "jlc_pcb_cluster_netlist",
  layer: 5,
  description:
    "模块化布局前置引擎：100% 唯一采信官方编译态权威网表（严禁读取 sch_PrimitiveWire），剥离全局电源/GND，执行去耦重绑定与加权 Leiden 图聚类，切分为功能子模块。",
  inputSchema: {
    type: "object",
    required: ["document"],
    properties: {
      document: { type: "string" },
      powerGndNetsOverride: { type: "array", items: { type: "string" } },
      minClusterSize: { type: "integer", default: 2 },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const doc = state.resolveDocument(String(args.document));
    if (!doc || !doc.pcb) {
      return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `PCB document '${String(args.document)}' not found.`);
    }

    const pcb = doc.pcb;
    const schDoc = pcb.sourceSchDocument ? state.resolveDocument(pcb.sourceSchDocument) : undefined;
    const netlist =
      pcb.syncedNetlist ?? (schDoc?.sch ? compileSchematicNetlist(schDoc) : undefined);
    if (!netlist) {
      return errEnvelope(
        "ERR_NETLIST_NOT_SYNCED",
        `PCB '${doc.handle}' has no authoritative compiled netlist. Run jlc_sch_sync_to_pcb first.`
      );
    }

    const cesmLookup = state.getCesmResolver();
    const handoff = schDoc?.sch?.lastElintReport?.constraintHandoffPackage;

    const clusterRes = clusterCompiledNetlist(netlist, {
      boardOutline: {
        shape: pcb.boardOutline.shape,
        width_mm: pcb.boardOutline.widthMm,
        height_mm: pcb.boardOutline.heightMm,
        layer_count: pcb.boardOutline.layerCount,
        copper_weight_outer_oz: pcb.boardOutline.copperWeightOuterOz,
        stackup: pcb.boardOutline.stackup,
        polygon_mm: pcb.boardOutline.polygonMm,
        fixed_mechanicals: pcb.boardOutline.mountingHoles.map((m) => ({
          id: m.id,
          type: `MOUNTING_HOLE_${m.size ?? "M3"}`,
          x_mm: m.centerMm[0],
          y_mm: m.centerMm[1],
          keepout_dia_mm: m.keepoutDiaMm ?? 7.0,
        })),
      },
      cesmLookup: (key, comp) => {
        const id = comp?.lcscId ?? key;
        return id ? cesmLookup(id) : undefined;
      },
      constraintHandoff: handoff,
      powerGndNetsOverride: Array.isArray(args.powerGndNetsOverride)
        ? (args.powerGndNetsOverride as string[])
        : undefined,
      minClusterSize: typeof args.minClusterSize === "number" ? args.minClusterSize : 2,
    });

    pcb.clusterResult = clusterRes;
    doc.isDirty = true;

    return okEnvelope({
      functional_clusters: clusterRes.output.functional_clusters,
      inter_cluster_edges: clusterRes.output.inter_cluster_edges,
      rigid_edge_anchors: clusterRes.output.rigid_edge_anchors ?? [],
      diagnostics: clusterRes.diagnostics,
    });
  },
};

export const jlcPcbLayoutApplyTool: McpToolHandler = {
  name: "jlc_pcb_layout_apply",
  layer: 5,
  description:
    "执行四阶段模块化布局：原厂 Layout Example > 工程原生 DRC > 四维最小间距矩阵；支持宏观分区求解（macro_floorplan_solve）或显式微调（explicit_transform），保证 Courtyard 零重叠。",
  inputSchema: {
    type: "object",
    required: ["document", "mode"],
    properties: {
      document: { type: "string" },
      mode: { type: "string", enum: ["macro_floorplan_solve", "explicit_transform"] },
      floorplanZones: { type: "array", items: { type: "object" } },
      transforms: { type: "array", items: { type: "object" } },
      applyDatasheetLayoutExample: { type: "boolean", default: true },
      useProjectDesignRulesFirst: { type: "boolean", default: true },
      enforceSpacingMatrix: { type: "boolean", default: true },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const doc = state.resolveDocument(String(args.document));
    if (!doc || !doc.pcb) {
      return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `PCB document '${String(args.document)}' not found.`);
    }

    const pcb = doc.pcb;
    if (!pcb.clusterResult || !pcb.syncedNetlist) {
      return errEnvelope(
        "ERR_CLUSTER_REQUIRED",
        "Run jlc_sch_sync_to_pcb and jlc_pcb_cluster_netlist before jlc_pcb_layout_apply."
      );
    }

    const cesmLookup = state.getCesmResolver();
    const compByDes = new Map(pcb.syncedNetlist.components.map((c) => [c.designator, c]));

    const res = solveModularPlacement(pcb.clusterResult.output, pcb.syncedNetlist, {
      mode: args.mode as "macro_floorplan_solve" | "explicit_transform",
      floorplanZones: Array.isArray(args.floorplanZones)
        ? (args.floorplanZones as FloorplanZoneInput[])
        : undefined,
      transforms: Array.isArray(args.transforms)
        ? (args.transforms as ExplicitComponentTransform[])
        : undefined,
      projectRules: pcb.projectDesignRules,
      cesmLookup: (desOrLcsc, comp) => {
        const lcsc = comp?.lcscId ?? compByDes.get(desOrLcsc)?.lcscId ?? desOrLcsc;
        return lcsc ? cesmLookup(lcsc) : undefined;
      },
      applyDatasheetLayoutExample: args.applyDatasheetLayoutExample !== false,
      useProjectDesignRulesFirst: args.useProjectDesignRulesFirst !== false,
      enforceSpacingMatrix: args.enforceSpacingMatrix !== false,
    });

    pcb.placementResult = res;
    pcb.placements = res.placements;
    pcb.fiducials = res.fiducials;
    if (res.keepoutZones25D.length > 0) {
      const existingIds = new Set(pcb.keepoutZones25D.map((k) => k.id).filter(Boolean));
      for (const kz of res.keepoutZones25D) {
        if (!kz.id || !existingIds.has(kz.id)) {
          pcb.keepoutZones25D.push(kz);
        }
      }
    }
    syncKeepoutsToPlacements(pcb);
    doc.isDirty = true;

    return okEnvelope({
      placedCount: res.placedCount,
      datasheetLayoutAppliedClusters: res.datasheetLayoutAppliedClusters,
      overlapCount: res.overlapCount,
      overlapAreaMm2: res.overlapAreaMm2,
      spacingViolations: res.spacingViolations,
      metrics: res.metrics,
      placements: res.placements,
    });
  },
};

export const jlcPcbRouteCriticalTool: McpToolHandler = {
  name: "jlc_pcb_route_critical",
  layer: 5,
  description:
    "第 1 级参数化关键网络先布并加锁：还原原厂 Layout Example 铜皮区与过孔阵、去耦微回路、DC-DC 热环路、TVS 穿焊盘零残桩、晶振无孔包地、采样电阻焊盘内侧独立引出与差分对。",
  inputSchema: {
    type: "object",
    required: ["document", "tasks"],
    properties: {
      document: { type: "string" },
      tasks: { type: "array", items: { type: "object" } },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const doc = state.resolveDocument(String(args.document));
    if (!doc || !doc.pcb) {
      return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `PCB document '${String(args.document)}' not found.`);
    }

    const pcb = doc.pcb;
    if (!pcb.clusterResult || pcb.placements.length === 0) {
      return errEnvelope("ERR_LAYOUT_REQUIRED", "Run jlc_pcb_layout_apply before routing critical nets.");
    }

    const tasks = Array.isArray(args.tasks) ? (args.tasks as Array<Record<string, unknown>>) : [];
    const criticalTasks = tasks.filter((t) => t.kind !== "diff_pair") as unknown as CriticalPrerouteTask[];
    const diffTasks = tasks.filter((t) => t.kind === "diff_pair");

    const cesmLookup = state.getCesmResolver();
    const compByDes = new Map(
      (pcb.syncedNetlist?.components ?? []).map((c) => [c.designator, c])
    );

    const critRes = runCriticalPrerouter(
      pcb.placements,
      pcb.clusterResult.output,
      criticalTasks,
      (des) => {
        const lcsc = compByDes.get(des)?.lcscId ?? des;
        return lcsc ? cesmLookup(lcsc) : undefined;
      }
    );

    const effectiveKeepouts = collectEffectiveKeepouts25D(pcb);
    const clippedCopperZones = critRes.copperZones.map((cz) => {
      const blockers = effectiveKeepouts.filter(
        (ko) =>
          ko.polygon2D.length >= 3 &&
          ko.disallowMask.includes("COPPER_POUR") &&
          !ko.allowedNets.includes(cz.net) &&
          (ko.layerSet.includes(cz.layer) || ko.layerSet.includes("ALL_COPPER_LAYERS"))
      );
      if (blockers.length === 0) return cz;
      const subj = new Paths64();
      subj.push(toClipperPath64(cz.polygonMm));
      const clip = new Paths64();
      for (const ko of blockers) {
        clip.push(toClipperPath64(ko.polygon2D));
      }
      const sol = Clipper.Difference(subj, clip, FillRule.NonZero);
      let bestPoly = cz.polygonMm;
      let bestArea = 0;
      for (const p of sol) {
        if (!Clipper.isPositive(p)) continue;
        const pts = fromClipperPath64(p);
        const a = computePolygonArea(pts);
        if (a > bestArea) {
          bestArea = a;
          bestPoly = pts;
        }
      }
      return bestArea > 0.05
        ? { ...cz, polygonMm: bestPoly, areaMm2: Number(bestArea.toFixed(3)) }
        : { ...cz, areaMm2: 0 };
    }).filter((cz) => cz.areaMm2 > 0.05);

    pcb.lockedTracks.push(...critRes.tracks);
    pcb.lockedCopperZones.push(...clippedCopperZones);
    pcb.lockedVias.push(...critRes.vias);

    let diffCount = 0;
    let diffLocked = 0;
    const lengthMatchReportMm: Record<string, number> = { ...critRes.lengthMatchReportMm };

    for (const dt of diffTasks) {
      const nets = (dt.nets as string[]) ?? [];
      if (nets.length < 2) continue;
      const findNetCenter = (net: string, first: boolean): [number, number] => {
        const pads: Array<[number, number]> = [];
        for (const pl of pcb.placements) {
          for (const p of pl.pads) {
            if (p.net === net) pads.push([p.xMm, p.yMm]);
          }
        }
        if (pads.length === 0) return first ? [10, 20] : [30, 20];
        return first ? pads[0] : pads[pads.length - 1];
      };

      const dRes = routeDifferentialPair({
        pairName: `${nets[0]}/${nets[1]}`,
        posNet: nets[0],
        negNet: nets[1],
        posStart: findNetCenter(nets[0], true),
        negStart: findNetCenter(nets[1], true),
        posEnd: findNetCenter(nets[0], false),
        negEnd: findNetCenter(nets[1], false),
        layer: typeof dt.layer === "string" ? dt.layer : "TopLayer",
        widthMm: typeof dt.widthMm === "number" ? dt.widthMm : 0.2,
        gapMm: typeof dt.gapMm === "number" ? dt.gapMm : 0.2,
      });

      for (const tr of [...dRes.posTracks, ...dRes.negTracks]) {
        pcb.tracks.push({
          id: tr.id,
          net: tr.net,
          layer: tr.layer,
          widthMm: tr.widthMm,
          pointsMm: tr.pointsMm,
          locked: Boolean(dt.lockAfterRoute),
        });
        diffLocked++;
      }
      for (const v of [...dRes.signalVias, ...dRes.gndReturnVias]) {
        pcb.lockedVias.push({
          id: v.id,
          net: v.net,
          xMm: v.xMm,
          yMm: v.yMm,
          drillMm: v.drillMm,
          outerDiaMm: v.outerDiaMm,
          startLayer: v.startLayer,
          endLayer: v.endLayer,
          tentedSolderMask: true,
          primitiveLock: true,
          viaRole: v.role === "GND_RETURN" ? "GND_RETURN_CLUSTER" : "BOOT_SIGNAL_VIA",
        });
        diffLocked++;
      }
      lengthMatchReportMm[`${nets[0]}_skew`] = dRes.skewMm;
      diffCount++;
    }

    doc.isDirty = true;

    return okEnvelope({
      routedTasks: critRes.routedTasks + diffCount,
      lockedPrimitivesCount: critRes.lockedPrimitivesCount + diffLocked,
      lengthMatchReportMm,
      guardRings: critRes.guardRings,
      kelvinReports: critRes.kelvinReports,
      forbiddenThermalViaAuditPassed: critRes.forbiddenThermalViaAuditPassed,
    });
  },
};

export const jlcPcbViaPlaceTool: McpToolHandler = {
  name: "jlc_pcb_via_place",
  layer: 5,
  description:
    "放置单颗过孔、大电流换层并联过孔矩阵、射频屏蔽过孔墙或严格遵照芯片 Datasheet Layout Example 规格的底部静态 GND EPAD 散热过孔阵列。",
  inputSchema: {
    type: "object",
    required: ["document", "mode", "net", "drillMm", "outerDiameterMm"],
    properties: {
      document: { type: "string" },
      mode: { type: "string", enum: ["single", "parallel_cluster", "via_fence", "epad_grid"] },
      net: { type: "string" },
      drillMm: { type: "number" },
      outerDiameterMm: { type: "number" },
      pointsMm: { type: "array", items: { type: "array" } },
      pathMm: { type: "array", items: { type: "array" } },
      centerMm: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
      rows: { type: "integer", default: 3 },
      cols: { type: "integer", default: 3 },
      pitchMm: { type: "number", default: 1.0 },
      tentingSolderMask: { type: "boolean", default: true },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const doc = state.resolveDocument(String(args.document));
    if (!doc || !doc.pcb) {
      return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `PCB document '${String(args.document)}' not found.`);
    }

    const pcb = doc.pcb;
    const mode = String(args.mode) as "single" | "parallel_cluster" | "via_fence" | "epad_grid";
    const net = String(args.net);
    const drillMm = Number(args.drillMm ?? 0.3);
    const outerDiaMm = Number(args.outerDiameterMm ?? 0.6);
    const tented = args.tentingSolderMask !== false;
    const stackup = pcb.boardOutline.stackup;
    const startLayer = stackup[0] ?? "TopLayer";
    const endLayer = stackup[stackup.length - 1] ?? "BottomLayer";

    const pts: Array<[number, number]> = [];
    if (Array.isArray(args.pointsMm) && args.pointsMm.length > 0) {
      for (const p of args.pointsMm as Array<[number, number]>) pts.push(p);
    } else if (mode === "epad_grid" || mode === "parallel_cluster") {
      const center = (args.centerMm as [number, number] | undefined) ?? [
        pcb.boardOutline.widthMm / 2,
        pcb.boardOutline.heightMm / 2,
      ];
      const rows = Number(args.rows ?? 3);
      const cols = Number(args.cols ?? 3);
      const pitch = Number(args.pitchMm ?? 1.0);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          pts.push([
            Number((center[0] + (c - (cols - 1) / 2) * pitch).toFixed(3)),
            Number((center[1] + (r - (rows - 1) / 2) * pitch).toFixed(3)),
          ]);
        }
      }
    } else if (Array.isArray(args.pathMm) && args.pathMm.length >= 2) {
      const pathPts = args.pathMm as Array<[number, number]>;
      const pitch = Number(args.pitchMm ?? 1.5);
      for (let i = 0; i < pathPts.length - 1; i++) {
        const [x0, y0] = pathPts[i];
        const [x1, y1] = pathPts[i + 1];
        const dist = Math.hypot(x1 - x0, y1 - y0);
        const count = Math.max(2, Math.floor(dist / pitch) + 1);
        for (let k = 0; k < count; k++) {
          const t = k / (count - 1);
          pts.push([Number((x0 + (x1 - x0) * t).toFixed(3)), Number((y0 + (y1 - y0) * t).toFixed(3))]);
        }
      }
    } else if (Array.isArray(args.centerMm)) {
      pts.push(args.centerMm as [number, number]);
    }

    const viaRole =
      mode === "epad_grid"
        ? ("EPAD_THERMAL_GND" as const)
        : mode === "parallel_cluster"
          ? ("POWER_TRUNK_PARALLEL" as const)
          : mode === "via_fence"
            ? ("GUARD_RING_STITCH" as const)
            : ("POWER_FEED_VIA" as const);

    for (const [xMm, yMm] of pts) {
      pcb.lockedVias.push({
        id: state.nextId("via"),
        net,
        xMm,
        yMm,
        drillMm,
        outerDiaMm,
        startLayer,
        endLayer,
        tentedSolderMask: tented,
        primitiveLock: true,
        viaRole,
      });
    }

    const singleSafeA = drillMm <= 0.2 ? 0.45 : drillMm <= 0.3 ? 0.7 : 1.0;
    void getMinParallelVias;
    doc.isDirty = true;

    return okEnvelope({
      viasPlaced: pts.length,
      estimatedCurrentCapacityA: Number((pts.length * singleSafeA).toFixed(2)),
    });
  },
};

export const jlcPcbAutorouteTool: McpToolHandler = {
  name: "jlc_pcb_autoroute",
  layer: 5,
  description:
    "第 2 级常规信号网络自动布线闭环：支持无头 FreeRouting（导出 Specctra DSN -> 多趟推挤拆线重布 -> 回导 SES）及内置多趟 45° A* 路由器。",
  inputSchema: {
    type: "object",
    required: ["document"],
    properties: {
      document: { type: "string" },
      engine: {
        type: "string",
        enum: ["freerouting_headless", "jlc_internal", "internal_grid"],
        default: "freerouting_headless",
      },
      excludeNets: { type: "array", items: { type: "string" }, default: ["GND", "AGND", "PGND"] },
      maxPasses: { type: "integer", default: 40 },
      timeoutSec: { type: "integer", default: 180 },
      gridStepMm: { type: "number" },
      signalLayers: { type: "array", items: { type: "string" } },
      autoAddTeardrops: { type: "boolean", default: true },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const doc = state.resolveDocument(String(args.document));
    if (!doc || !doc.pcb) {
      return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `PCB document '${String(args.document)}' not found.`);
    }
    const pcb = doc.pcb;
    if (!pcb.clusterResult || pcb.placements.length === 0) {
      return errEnvelope("ERR_LAYOUT_REQUIRED", "Run jlc_pcb_layout_apply before autorouting.");
    }

    const envInfo = await state.ensureEnvInfo(context);
    const excludeNets = Array.isArray(args.excludeNets)
      ? (args.excludeNets as string[])
      : ["GND", "AGND", "PGND"];

    const res = await runHybridAutoroute(pcb.clusterResult.output, pcb.placements, {
      engine: (args.engine as "freerouting_headless" | "jlc_internal" | "internal_grid") ?? "freerouting_headless",
      freeroutingJarPath: envInfo.paths.freeroutingJarPath,
      tempDir: envInfo.paths.tempDir,
      excludeNets,
      maxPasses: typeof args.maxPasses === "number" ? args.maxPasses : 40,
      timeoutSec: typeof args.timeoutSec === "number" ? args.timeoutSec : 180,
      ...(typeof args.gridStepMm === "number" ? { gridStepMm: args.gridStepMm } : {}),
      ...(Array.isArray(args.signalLayers) ? { signalLayers: args.signalLayers as string[] } : {}),
      projectRules: pcb.projectDesignRules,
      keepouts25D: expandKeepoutsForAutoroute(collectEffectiveKeepouts25D(pcb)),
      lockedTracks: pcb.lockedTracks,
      lockedCopperZones: pcb.lockedCopperZones,
      lockedVias: pcb.lockedVias,
      preRoutedTracks: pcb.tracks,
      preRoutedVias: pcb.vias,
    });

    pcb.tracks = res.tracks;
    pcb.vias = res.vias;
    pcb.nativeDrcResult.unroutedRatlineCount = res.remainingUnroutedRatlines;
    doc.isDirty = true;

    return okEnvelope({
      completed: res.completed,
      engineUsed: res.engineUsed,
      routedNetCount: res.routedNetCount,
      remainingUnroutedRatlines: res.remainingUnroutedRatlines,
      unroutedNets: res.unroutedNets,
      viaCountAdded: res.viaCountAdded,
      totalTrackLengthMm: res.totalTrackLengthMm,
      passesUsed: res.passesUsed,
      ...(res.fallbackReason ? { fallbackReason: res.fallbackReason } : {}),
    });
  },
};

export const jlcPcbPourAndStitchTool: McpToolHandler = {
  name: "jlc_pcb_pour_and_stitch",
  layer: 5,
  description:
    "第 3 级多边形铺铜与地平面过孔缝合：按工程 DRC 与安规退避生成铜皮并清除死铜孤岛，对 0603/0402/0201 强制设 4 辐条十字花隔热焊盘防立碑，并自动排布网格/板边 GND 缝合过孔阵。",
  inputSchema: {
    type: "object",
    required: ["document", "pours"],
    properties: {
      document: { type: "string" },
      pours: { type: "array", items: { type: "object" } },
      autoStitchGndVias: { type: "object" },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const doc = state.resolveDocument(String(args.document));
    if (!doc || !doc.pcb) {
      return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `PCB document '${String(args.document)}' not found.`);
    }
    const pcb = doc.pcb;
    if (!pcb.clusterResult || pcb.placements.length === 0) {
      return errEnvelope("ERR_LAYOUT_REQUIRED", "Run jlc_pcb_layout_apply before pouring copper.");
    }

    const poursReq = Array.isArray(args.pours) ? (args.pours as PourZoneRequest[]) : [];
    const allTracks = [
      ...pcb.tracks,
      ...pcb.lockedTracks.map((lt) => ({
        id: lt.id,
        net: lt.net,
        layer: lt.layer,
        widthMm: lt.widthMm,
        pointsMm: lt.pointsMm,
        locked: true,
      })),
    ];
    const allVias = [
      ...pcb.vias,
      ...pcb.lockedVias.map((lv) => ({
        id: lv.id,
        net: lv.net,
        xMm: lv.xMm,
        yMm: lv.yMm,
        drillMm: lv.drillMm,
        outerDiaMm: lv.outerDiaMm,
        startLayer: lv.startLayer,
        endLayer: lv.endLayer,
        locked: true,
      })),
    ];

    void buildPolygonPours;
    const res = runPourAndStitch(
      pcb.clusterResult.output,
      pcb.placements,
      allTracks,
      allVias,
      poursReq,
      {
        projectRules: pcb.projectDesignRules,
        keepouts25D: collectEffectiveKeepouts25D(pcb),
        autoStitchGndVias: args.autoStitchGndVias as StitchingViaOptions | undefined,
      }
    );

    pcb.pours = res.pours;
    pcb.padPourStyles = res.padConnectionStyles;
    pcb.vias.push(...res.stitchingResult.vias);
    doc.isDirty = true;

    return okEnvelope({
      poursRebuilt: res.poursRebuilt,
      islandsRemoved: res.islandsRemoved,
      stitchingViasPlaced: res.stitchingViasPlaced,
      smallPassiveThermalReliefCoverage: res.smallPassiveThermalReliefCoverage,
      unpouredNetsWarning: res.unpouredNetsWarning,
    });
  },
};

export const jlcPcbSilkscreenTidyTool: McpToolHandler = {
  name: "jlc_pcb_silkscreen_tidy",
  layer: 5,
  description:
    "丝印层自动化整洁与极性防呆加固：统一 0°/90° 正交朝向，自动避开裸铜焊盘与开窗过孔，校验外部可见强极性标识。",
  inputSchema: {
    type: "object",
    required: ["document"],
    properties: {
      document: { type: "string" },
      textHeightMm: { type: "number", default: 1.0 },
      strokeWidthMm: { type: "number", default: 0.15 },
      autoAvoidPadsClearanceMm: { type: "number", default: 0.15 },
      enforcePolarityMarksOutsideBody: { type: "boolean", default: true },
      boardMarkings: { type: "array", items: { type: "object" } },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const doc = state.resolveDocument(String(args.document));
    if (!doc || !doc.pcb) {
      return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `PCB document '${String(args.document)}' not found.`);
    }
    const pcb = doc.pcb;
    if (!pcb.clusterResult || pcb.placements.length === 0) {
      return errEnvelope("ERR_LAYOUT_REQUIRED", "Run jlc_pcb_layout_apply before tidying silkscreen.");
    }

    const allVias = [
      ...pcb.vias,
      ...pcb.lockedVias.map((lv) => ({
        id: lv.id,
        net: lv.net,
        xMm: lv.xMm,
        yMm: lv.yMm,
        drillMm: lv.drillMm,
        outerDiaMm: lv.outerDiaMm,
        startLayer: lv.startLayer,
        endLayer: lv.endLayer,
      })),
    ];

    const res = tidySilkscreen(pcb.placements, allVias, pcb.fiducials, pcb.clusterResult.output, {
      textHeightMm: typeof args.textHeightMm === "number" ? args.textHeightMm : 1.0,
      strokeWidthMm: typeof args.strokeWidthMm === "number" ? args.strokeWidthMm : 0.15,
      autoAvoidPadsClearanceMm:
        typeof args.autoAvoidPadsClearanceMm === "number" ? args.autoAvoidPadsClearanceMm : 0.15,
      enforcePolarityMarksOutsideBody: args.enforcePolarityMarksOutsideBody !== false,
    });

    pcb.silkscreenResult = res;
    doc.isDirty = true;

    return okEnvelope({
      adjustedDesignators: res.adjustedDesignators,
      padOverlapCleared: res.padOverlapCleared,
      polarityWarningsFixed: res.polarityWarningsFixed,
      itemCount: res.items.length,
    });
  },
};

export const LAYER5_TOOLS: McpToolHandler[] = [
  jlcPcbBoardSetupTool,
  jlcPcbClusterNetlistTool,
  jlcPcbLayoutApplyTool,
  jlcPcbRouteCriticalTool,
  jlcPcbViaPlaceTool,
  jlcPcbAutorouteTool,
  jlcPcbPourAndStitchTool,
  jlcPcbSilkscreenTidyTool,
];
