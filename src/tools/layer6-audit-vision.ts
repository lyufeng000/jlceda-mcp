import fs from "node:fs";
import path from "node:path";
import {
  errEnvelope,
  okEnvelope,
  type McpToolContentItem,
  type McpToolHandler,
} from "../types/index.js";
import {
  captureViewWithHud,
  composeSideBySideComparisonPng,
} from "../cdp/view-capture-hud.js";
import { renderLayoutExamplePng } from "../electrical/lcsc-datasheet-binder.js";
import {
  runElectricalLinter,
  runGeometryPcbLinter,
  runMasterValidationWithDetails,
  type BomVerificationEntry,
  type CplVerificationEntry,
} from "../linters/index.js";
import {
  buildPcbGeometrySnapshot,
  compileSchematicNetlist,
  getWorkspaceState,
  renderWorkspaceDocumentPng,
  WORKSPACE_ROOT,
} from "./state.js";

export const jlcElecLintTool: McpToolHandler = {
  name: "jlc_elec_lint",
  layer: 6,
  description:
    "原理图与权威网表确定性电气审计引擎：100% 唯一基于 eda.sch_Netlist 编译态权威网表执行 28 条机器硬检规则（ELINT-001~028），0 Blocker 方可解锁转入 PCB。",
  inputSchema: {
    type: "object",
    required: ["schDocument"],
    properties: {
      schDocument: { type: "string" },
      strictness: { type: "string", enum: ["production", "prototype"], default: "production" },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const doc = state.resolveDocument(String(args.schDocument));
    if (!doc || !doc.sch) {
      return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `Schematic '${String(args.schDocument)}' not found.`);
    }

    const netlist = compileSchematicNetlist(doc);
    const report = runElectricalLinter(netlist, {
      cesmResolver: state.getCesmResolver(),
      strictness: args.strictness === "prototype" ? "prototype" : "production",
    });

    doc.sch.lastElintReport = report;
    return okEnvelope(report);
  },
};

export const jlcPcbDrcAndLintTool: McpToolHandler = {
  name: "jlc_pcb_drc_and_lint",
  layer: 6,
  description:
    "工程原生 DRC 规则动态驱动 + 18 条 2.5D 计算几何与电磁拓扑 Linter（PLINT-01~18），严格先求 layerSet 图层交集消除多层板背面误报。",
  inputSchema: {
    type: "object",
    required: ["pcbDocument"],
    properties: {
      pcbDocument: { type: "string" },
      checkScope: {
        type: "string",
        enum: ["full_board", "selection_neighborhood"],
        default: "full_board",
      },
      useProjectDesignRulesFirst: { type: "boolean", default: true },
      fabCapability: {
        type: "string",
        enum: ["jlc_standard_multi", "jlc_2layer_basic"],
        default: "jlc_standard_multi",
      },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const doc = state.resolveDocument(String(args.pcbDocument));
    if (!doc || !doc.pcb) {
      return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `PCB '${String(args.pcbDocument)}' not found.`);
    }

    const selectedDesignators = doc.selection
      .map((s) => s.designator)
      .filter((d): d is string => Boolean(d));

    const snapshot = buildPcbGeometrySnapshot(doc, state, {
      checkScope:
        args.checkScope === "selection_neighborhood" ? "selection_neighborhood" : "full_board",
      useProjectDesignRulesFirst: args.useProjectDesignRulesFirst !== false,
      fabCapability:
        args.fabCapability === "jlc_2layer_basic" ? "jlc_2layer_basic" : "jlc_standard_multi",
      selectedDesignators,
    });

    const report = runGeometryPcbLinter(snapshot);
    doc.pcb.lastPcbLintReport = report;

    const paged = state.handlePool.paginateArray(report.customGeoLintFindings);
    return okEnvelope({
      ...report,
      customGeoLintFindings: paged.items,
      ...(paged.paginated && paged.arrayCursor ? { arrayCursor: paged.arrayCursor.handle } : {}),
    });
  },
};

export const jlcValidateTool: McpToolHandler = {
  name: "jlc_validate",
  layer: 6,
  description:
    "工程交付前四合一综合一票否决总门禁：1) SCH-PCB 权威网表同步；2) 28 条电气 Linter 0 Blocker；3) 原生 PCB DRC + 18 条 2.5D 几何 Linter；4) 嘉立创 SMT BOM/CPL 可制造性。",
  inputSchema: {
    type: "object",
    required: ["schDocument", "pcbDocument"],
    properties: {
      projectUuid: { type: ["string", "null"], default: null },
      schDocument: { type: "string" },
      pcbDocument: { type: "string" },
      verifyManufacturability: { type: "boolean", default: true },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const schDoc = state.resolveDocument(String(args.schDocument));
    if (!schDoc || !schDoc.sch) {
      return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `Schematic '${String(args.schDocument)}' not found.`);
    }
    const pcbDoc = state.resolveDocument(String(args.pcbDocument));
    if (!pcbDoc || !pcbDoc.pcb) {
      return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `PCB '${String(args.pcbDocument)}' not found.`);
    }
    if (!pcbDoc.pcb.syncedNetlist) {
      return errEnvelope(
        "ERR_NETLIST_NOT_SYNCED",
        `PCB '${pcbDoc.handle}' has not been synced from schematic. Run jlc_sch_sync_to_pcb first.`
      );
    }

    const schNetlist = compileSchematicNetlist(schDoc);
    const pcbNetlist = pcbDoc.pcb.syncedNetlist;
    const pcbGeometry = buildPcbGeometrySnapshot(pcbDoc, state, {
      checkScope: "full_board",
      useProjectDesignRulesFirst: true,
    });

    const cesmResolver = state.getCesmResolver();
    const bomEntries: BomVerificationEntry[] = schNetlist.components.map((c) => ({
      designator: c.designator,
      lcscId: c.lcscId,
      mpn: c.mpn,
      footprint: c.footprint,
      dnp: c.extraProps?.dnp === true,
      virtualMechanical: c.extraProps?.virtualMechanical === true,
    }));

    const cplEntries: CplVerificationEntry[] = pcbDoc.pcb.placements.map((pl) => {
      const sc = schNetlist.components.find((c) => c.designator === pl.designator);
      const cesm = sc?.lcscId ? cesmResolver(sc.lcscId) : undefined;
      return {
        designator: pl.designator,
        layer: pl.side === "BOTTOM" ? "BottomLayer" : "TopLayer",
        xMm: pl.xMm,
        yMm: pl.yMm,
        rotationDeg: pl.rotationDeg,
        originAnchorType: "CENTER",
        ...(cesm?.polarity_spec?.is_polarized
          ? {
              expectedPolarityAngleDeg: pl.rotationDeg,
              polarityAngleDeg: pl.rotationDeg,
            }
          : {}),
      };
    });

    const detailed = runMasterValidationWithDetails({
      projectUuid: (args.projectUuid as string | undefined) ?? schDoc.projectUuid,
      schDocument: schDoc.handle,
      pcbDocument: pcbDoc.handle,
      schNetlist,
      pcbNetlist,
      pcbGeometry,
      cesmResolver,
      verifyManufacturability: args.verifyManufacturability !== false,
      bomEntries,
      cplEntries,
    });

    return okEnvelope(detailed.report);
  },
};

export const jlcViewCaptureTool: McpToolHandler = {
  name: "jlc_view_capture",
  layer: 6,
  description:
    "输出带公制标尺网格与违例高亮的 PNG 视口图像（ImageContent + 元数据），支持 2D 图层渲染与 compareWithDatasheetLcsc 原厂 Datasheet Layout Example 左右双图并排合规比对。",
  inputSchema: {
    type: "object",
    required: ["document"],
    properties: {
      document: { type: "string" },
      mode: { type: "string", enum: ["2d_canvas", "3d_model"], default: "2d_canvas" },
      viewport: {
        type: "string",
        enum: ["fit_board", "current", "selection", "custom_region"],
        default: "fit_board",
      },
      regionMm: { type: ["array", "null"], items: { type: "number" }, default: null },
      view3d: { type: "integer", enum: [1, 2, 3, 4, 5, 6, 7], default: 7 },
      visibleLayers: { type: ["array", "null"], items: { type: "string" }, default: null },
      overlayGridMm: { type: ["number", "null"], default: 5.0 },
      highlightPointsMm: { type: "array", items: { type: "object" }, default: [] },
      compareWithDatasheetLcsc: { type: ["string", "null"], default: null },
      width: { type: "integer", default: 1600 },
      height: { type: "integer", default: 1200 },
      savePath: { type: ["string", "null"], default: null },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const doc = state.resolveDocument(String(args.document));
    const compareLcsc =
      typeof args.compareWithDatasheetLcsc === "string" && args.compareWithDatasheetLcsc.trim()
        ? args.compareWithDatasheetLcsc.trim()
        : null;

    let refPngPath: string | undefined;
    if (compareLcsc) {
      const cesm = state.getCesmResolver()(compareLcsc);
      if (cesm?.layoutExample?.referenceImageUri && fs.existsSync(cesm.layoutExample.referenceImageUri)) {
        refPngPath = cesm.layoutExample.referenceImageUri;
      } else if (cesm) {
        refPngPath = renderLayoutExamplePng(
          cesm,
          path.join(WORKSPACE_ROOT, "catalog", "layout_examples")
        );
      } else {
        return errEnvelope(
          "ERR_DATASHEET_LAYOUT_NOT_FOUND",
          `No cached Datasheet Layout Example found for '${compareLcsc}'. Run jlc_datasheet_extract first.`
        );
      }
    }

    const width = Number(args.width ?? 1600);
    const height = Number(args.height ?? 1200);
    const regionMm = Array.isArray(args.regionMm)
      ? (args.regionMm as [number, number, number, number])
      : null;
    const overlayGridMm =
      args.overlayGridMm === null ? null : Number(args.overlayGridMm ?? 5.0);
    const visibleLayers = Array.isArray(args.visibleLayers)
      ? (args.visibleLayers as string[])
      : null;
    const highlightPointsMm = Array.isArray(args.highlightPointsMm)
      ? (args.highlightPointsMm as Array<{ posMm: [number, number]; label?: string }>)
      : [];

    let finalPng: Buffer;
    let capturedBboxMm: [number, number, number, number] = [0, 0, 100, 80];
    let pixelPerMm = 10;

    if (context.sessionManager.isConnected()) {
      try {
        const exec = context.sessionManager.getExecutor();
        const session = await context.sessionManager.resolveTargetSession(String(args.document));
        const liveRes = await captureViewWithHud(
          exec,
          {
            document: String(args.document),
            mode: args.mode === "3d_model" ? "3d_model" : "2d_canvas",
            view3d: (args.view3d as 1 | 2 | 3 | 4 | 5 | 6 | 7) ?? 7,
            viewport:
              args.viewport === "custom_region"
                ? "region"
                : ((args.viewport as "fit_board" | "current" | "selection") ?? "fit_board"),
            regionMm: regionMm ?? undefined,
            overlayGridMm: overlayGridMm ?? undefined,
            visibleLayers: visibleLayers ?? undefined,
            compareWithDatasheetPath: refPngPath,
            datasheetLabel: compareLcsc ?? undefined,
          },
          { targetId: session.targetId, sessionId: session.sessionId }
        );
        finalPng = liveRes.pngBuffer;
      } catch {
        if (!doc) {
          return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `Document '${String(args.document)}' not found.`);
        }
        const rendered = renderWorkspaceDocumentPng(doc, {
          width,
          height,
          regionMm,
          overlayGridMm,
          visibleLayers,
          highlightPointsMm,
        });
        capturedBboxMm = rendered.capturedBboxMm;
        pixelPerMm = rendered.pixelPerMm;
        finalPng = refPngPath
          ? composeSideBySideComparisonPng(rendered.pngBuffer, fs.readFileSync(refPngPath), {
              leftTitle: `ACTUAL PCB (${doc.title})`,
              rightTitle: `DATASHEET ${compareLcsc} LAYOUT EXAMPLE`,
            }).pngBuffer
          : rendered.pngBuffer;
      }
    } else {
      if (!doc) {
        return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `Document '${String(args.document)}' not found.`);
      }
      const rendered = renderWorkspaceDocumentPng(doc, {
        width,
        height,
        regionMm,
        overlayGridMm,
        visibleLayers,
        highlightPointsMm,
      });
      capturedBboxMm = rendered.capturedBboxMm;
      pixelPerMm = rendered.pixelPerMm;

      if (refPngPath) {
        const comp = composeSideBySideComparisonPng(
          rendered.pngBuffer,
          fs.readFileSync(refPngPath),
          {
            leftTitle: `ACTUAL PCB (${doc.title})`,
            rightTitle: `DATASHEET ${compareLcsc} LAYOUT EXAMPLE`,
          }
        );
        finalPng = comp.pngBuffer;
      } else {
        finalPng = rendered.pngBuffer;
      }
    }

    const savePath =
      typeof args.savePath === "string" && args.savePath.trim() ? args.savePath.trim() : null;
    if (savePath) {
      fs.mkdirSync(path.dirname(savePath), { recursive: true });
      fs.writeFileSync(savePath, finalPng);
    }

    const meta = okEnvelope({
      capturedBboxMm,
      pixelPerMm,
      sideBySideComparedLcsc: compareLcsc,
      savedPath: savePath,
      byteLength: finalPng.length,
    });

    const content: McpToolContentItem[] = [
      {
        type: "image",
        data: finalPng.toString("base64"),
        mimeType: "image/png",
      },
      {
        type: "text",
        text: JSON.stringify(meta),
      },
    ];

    return {
      content,
      structuredContent: meta,
      isError: false,
    };
  },
};

export const LAYER6_TOOLS: McpToolHandler[] = [
  jlcElecLintTool,
  jlcPcbDrcAndLintTool,
  jlcValidateTool,
  jlcViewCaptureTool,
];
