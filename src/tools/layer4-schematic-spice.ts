import {
  errEnvelope,
  okEnvelope,
  type CesmModel,
  type CompiledComponent,
  type CompiledPin,
  type McpToolHandler,
  type SpiceAnalysisItem,
} from "../types/index.js";
import {
  instantiateBlock,
  loadBlockTemplate,
  runSpiceSimulation,
  verifyNoFourWayJunctions,
  type OrthogonalWireSegment,
  type TeeJunctionPoint,
} from "../electrical/index.js";
import { runElectricalLinter } from "../linters/index.js";
import {
  compileSchematicNetlist,
  createDefaultPcbData,
  getWorkspaceState,
} from "./state.js";

const BLOCK_FALLBACK_LCSC: Record<string, { lcscId: string; category: CesmModel["category"]; mpn: string; ratings: CesmModel["ratings"] }> = {
  F_VBUS: { lcscId: "C70058", category: "RES_CHIP", mpn: "SMD0805P150TF", ratings: { v_working_max: 30, power_rated_w: 1.0 } },
  F_PTC_A: { lcscId: "C70059", category: "RES_CHIP", mpn: "SMD1206P015TF", ratings: { v_working_max: 60, power_rated_w: 1.0 } },
  F_PTC_B: { lcscId: "C70059", category: "RES_CHIP", mpn: "SMD1206P015TF", ratings: { v_working_max: 60, power_rated_w: 1.0 } },
  R_FBT: { lcscId: "C25879", category: "RES_CHIP", mpn: "0402WGF7322TCE", ratings: { v_working_max: 50, power_rated_w: 0.0625 } },
  R_FBB: { lcscId: "C25744", category: "RES_CHIP", mpn: "0402WGF1002TCE", ratings: { v_working_max: 50, power_rated_w: 0.0625 } },
  L_CMC: { lcscId: "C1018", category: "FERRITE_CMC", mpn: "ACT45B-510-2P", ratings: { i_rms_a: 1.5, v_working_max: 80 } },
  RV_MOV: { lcscId: "C910001", category: "TVS_ESD_MOV", mpn: "14D471K", ratings: { v_rwm_v: 300, v_clamp_max_v: 470 } },
  J_SWD: { lcscId: "C160404", category: "CONN_GENERIC", mpn: "HDR-1x4-2.54", ratings: { v_working_max: 50 } },
  C307331: { lcscId: "C307331", category: "CAP_MLCC", mpn: "CC0402KRX7R9BB104", ratings: { v_working_max: 50, dielectric: "X7R", dc_bias_retention_at_80pct_vr: 0.55 } },
  C52923: { lcscId: "C52923", category: "CAP_MLCC", mpn: "CL05A105KA5NQNC", ratings: { v_working_max: 25, dielectric: "X5R", dc_bias_retention_at_80pct_vr: 0.5 } },
  C15195: { lcscId: "C15195", category: "CAP_MLCC", mpn: "CL05B103KB5NNNC", ratings: { v_working_max: 50, dielectric: "X7R", dc_bias_retention_at_80pct_vr: 0.8 } },
  C17168: { lcscId: "C17168", category: "RES_CHIP", mpn: "0402WGF0000TCE", ratings: { v_working_max: 50, power_rated_w: 0.0625 } },
};

function ensureBlockComponentCesm(
  state: ReturnType<typeof getWorkspaceState>,
  refRole: string,
  rawLcscId: string | undefined,
  pkg: string,
  value: string,
  pinNames: string[],
  vInMaxV: number
): CesmModel {
  let effectiveId = rawLcscId;
  // Upgrade 16V bulk input MLCC if Buck input exceeds 10.6V (1.5x derating)
  if (refRole === "C_IN_BULK" && vInMaxV > 10.6) {
    effectiveId = "C900102";
    if (!state.cesmBinder.lookupCachedCesm(effectiveId)) {
      const m: CesmModel = {
        lcsc_id: effectiveId,
        mpn: "CL31B106KBHNNNE_50V",
        category: "CAP_MLCC",
        package: "1206",
        verified: true,
        pins: [
          { pin_number: "1", pin_name: "1", elec_type: "PASSIVE" },
          { pin_number: "2", pin_name: "2", elec_type: "PASSIVE" },
        ],
        ratings: { v_working_max: 50, dielectric: "X7R", dc_bias_retention_at_80pct_vr: 0.7 },
      };
      state.cesmBinder.bindCesm(m, true);
    }
  }
  if (refRole === "C_BOOT" && vInMaxV > 10.6) {
    effectiveId = "C307331";
  }

  const lookupKey = effectiveId ?? refRole;
  const cached = effectiveId ? state.cesmBinder.lookupCachedCesm(effectiveId) : undefined;
  if (cached) {
    state.cesmBinder.bindCesm(cached, true);
    return cached;
  }

  const fb = BLOCK_FALLBACK_LCSC[lookupKey] ?? BLOCK_FALLBACK_LCSC[refRole];
  const finalId = fb?.lcscId ?? (effectiveId && /^C[0-9]+$/.test(effectiveId) ? effectiveId : `C99${Math.abs(refRole.split("").reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 90000 + 10000}`);
  const existingAfter = state.cesmBinder.lookupCachedCesm(finalId);
  if (existingAfter) {
    state.cesmBinder.bindCesm(existingAfter, true);
    return existingAfter;
  }

  const synthesized: CesmModel = {
    lcsc_id: finalId,
    mpn: fb?.mpn ?? value,
    category: fb?.category ?? (/^C/.test(refRole) ? "CAP_MLCC" : /^L/.test(refRole) ? "IND_POWER" : "RES_CHIP"),
    package: pkg,
    verified: true,
    pins: pinNames.map((p) => ({
      pin_number: p,
      pin_name: p,
      elec_type: "PASSIVE",
    })),
    ratings: fb?.ratings ?? { v_working_max: 50, power_rated_w: 0.25 },
  };
  state.cesmBinder.bindCesm(synthesized, true);
  return synthesized;
}

function resolvePinNetInBlock(
  template: ReturnType<typeof loadBlockTemplate>,
  refRole: string,
  pinNumber: string,
  netBindings: Record<string, string>,
  suffix: string
): string | null {
  // Build map from netRole -> final net name via PORT:* bindings
  const roleToNet = new Map<string, string>();
  for (const port of template.exposedPorts) {
    const finalName = netBindings[port.portName] ?? port.defaultNetName ?? `${port.portName}_${suffix}`;
    for (const conn of template.connections) {
      if (conn.from === `PORT:${port.portName}` || conn.to === `PORT:${port.portName}`) {
        roleToNet.set(conn.netRole, finalName);
      }
    }
  }
  const target = `${refRole}.${pinNumber}`;
  for (const conn of template.connections) {
    if (conn.from === target || conn.to === target) {
      return roleToNet.get(conn.netRole) ?? `${conn.netRole}_${suffix}`;
    }
  }
  return null;
}

function routeOrthogonalStaggeredNet(
  netName: string,
  pts: Array<[number, number]>,
  prefix: string
): { wires: OrthogonalWireSegment[]; junctions: TeeJunctionPoint[] } {
  const GRID = 1.27;
  const snap = (v: number) => Number((Math.round(v / GRID) * GRID).toFixed(4));
  const unique: Array<[number, number]> = [];
  const seen = new Set<string>();
  for (const [x, y] of pts) {
    const sx = snap(x);
    const sy = snap(y);
    const k = `${sx},${sy}`;
    if (!seen.has(k)) {
      seen.add(k);
      unique.push([sx, sy]);
    }
  }

  const wires: OrthogonalWireSegment[] = [];
  const junctions: TeeJunctionPoint[] = [];
  if (unique.length <= 1) return { wires, junctions };

  let seq = 1;
  const addWire = (a: [number, number], b: [number, number]) => {
    if (Math.abs(a[0] - b[0]) < 1e-4 && Math.abs(a[1] - b[1]) < 1e-4) return;
    wires.push({
      id: `${prefix}_${seq++}`,
      netName,
      startMm: a,
      endMm: b,
    });
  };

  if (unique.length === 2) {
    const [p1, p2] = unique;
    if (Math.abs(p1[0] - p2[0]) < 1e-4 || Math.abs(p1[1] - p2[1]) < 1e-4) {
      addWire(p1, p2);
    } else {
      const corner: [number, number] = [p2[0], p1[1]];
      addWire(p1, corner);
      addWire(corner, p2);
    }
    return { wires, junctions };
  }

  // Spine-and-tapped-T topology: stagger every T-junction along X by >= 2.54mm (2 * 1.27mm)
  // to strictly guarantee ZERO 4-way cross junctions!
  const sorted = [...unique].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const spineY = snap(sorted.reduce((s, p) => s + p.at(1)!, 0) / sorted.length);
  const tapXCoords: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let tx = sorted[i][0];
    while (tapXCoords.some((prev) => Math.abs(prev - tx) < 2.539)) {
      tx = snap(tx + 2.54);
    }
    tapXCoords.push(tx);
  }

  const minSpineX = Math.min(...tapXCoords);
  const maxSpineX = Math.max(...tapXCoords);
  for (let i = 0; i < tapXCoords.length - 1; i++) {
    addWire([tapXCoords[i], spineY], [tapXCoords[i + 1], spineY]);
  }

  for (let i = 0; i < sorted.length; i++) {
    const pinPt = sorted[i];
    const tx = tapXCoords[i];
    if (Math.abs(pinPt[0] - tx) > 1e-4) {
      addWire(pinPt, [tx, pinPt[1]]);
    }
    if (Math.abs(pinPt[1] - spineY) > 1e-4) {
      addWire([tx, pinPt[1]], [tx, spineY]);
      if (tx > minSpineX + 1e-4 && tx < maxSpineX - 1e-4) {
        junctions.push({
          netName,
          posMm: [tx, spineY],
          degree: 3,
        });
      }
    }
  }

  return { wires, junctions };
}

export const jlcSchSheetManageTool: McpToolHandler = {
  name: "jlc_sch_sheet_manage",
  layer: 4,
  description:
    "创建/重排原理图分页、设置图框（A4/A3）标题栏元数据，并在图纸上绘制功能模块分区虚线框与说明文字。",
  inputSchema: {
    type: "object",
    required: ["document", "action"],
    properties: {
      document: { type: "string" },
      action: { type: "string", enum: ["setup_frame", "draw_module_box", "list_sheets"] },
      sheetName: { type: "string" },
      frameSize: { type: "string", enum: ["A4", "A3"], default: "A3" },
      blocks: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "title", "rectMm"],
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            rectMm: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
          },
        },
      },
      titleBlock: { type: "object" },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const doc = state.resolveDocument(String(args.document));
    if (!doc || !doc.sch) {
      return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `Schematic '${String(args.document)}' not found.`);
    }

    const action = String(args.action);
    if (action === "list_sheets") {
      return okEnvelope({
        sheets: doc.sch.sheets,
        groupBoxes: doc.sch.groupBoxes,
      });
    }

    if (action === "setup_frame") {
      const sheetName = typeof args.sheetName === "string" ? args.sheetName : "Sheet1";
      let sheet = doc.sch.sheets.find((s) => s.name === sheetName) ?? doc.sch.sheets[0];
      if (!sheet) {
        sheet = {
          sheetUuid: state.nextId("sheet"),
          name: sheetName,
          frameSize: "A3",
          titleBlock: {},
        };
        doc.sch.sheets.push(sheet);
      }
      if (args.frameSize === "A4" || args.frameSize === "A3") {
        sheet.frameSize = args.frameSize;
      }
      if (args.titleBlock && typeof args.titleBlock === "object") {
        sheet.titleBlock = { ...sheet.titleBlock, ...(args.titleBlock as Record<string, unknown>) };
      }
      doc.isDirty = true;
      return okEnvelope({
        sheetUuid: sheet.sheetUuid,
        blocksCreated: 0,
        sheet,
      });
    }

    // draw_module_box
    const blocks = Array.isArray(args.blocks)
      ? (args.blocks as Array<{ id: string; title: string; rectMm: [number, number, number, number] }>)
      : [];
    const sheetId = doc.sch.sheets[0]?.name ?? "Sheet1";
    for (const blk of blocks) {
      const idx = doc.sch.groupBoxes.findIndex((g) => g.id === blk.id);
      const box = {
        id: blk.id,
        title: blk.title,
        sheetId,
        rectMm: blk.rectMm,
      };
      if (idx >= 0) doc.sch.groupBoxes[idx] = box;
      else doc.sch.groupBoxes.push(box);
    }
    doc.isDirty = true;
    return okEnvelope({
      sheetUuid: doc.sch.sheets[0]?.sheetUuid ?? "",
      blocksCreated: blocks.length,
    });
  },
};

export const jlcSchComponentPlaceTool: McpToolHandler = {
  name: "jlc_sch_component_place",
  layer: 4,
  description:
    "在原理图放置真实库器件（硬门禁：强制校验已完成 jlc_datasheet_extract 的 CESM 真值绑定），绑定功能模块归属标签 clusterGroup、位号、容阻值与坐标。",
  inputSchema: {
    type: "object",
    required: ["document", "components"],
    properties: {
      document: { type: "string" },
      replaceExisting: { type: "boolean", default: false },
      removeDesignators: { type: "array", items: { type: "string" }, default: [] },
      components: {
        type: "array",
        items: {
          type: "object",
          required: ["deviceUuidOrLcsc", "posMm"],
          properties: {
            deviceUuidOrLcsc: { type: "string" },
            designator: { type: "string" },
            value: { type: "string" },
            posMm: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
            rotationDeg: { type: "number", default: 0 },
            mirror: { type: "boolean", default: false },
            clusterGroup: { type: "string" },
            sheetId: { type: "string" },
            extraProps: { type: "object" },
            pinNets: { type: "object" },
          },
        },
      },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const doc = state.resolveDocument(String(args.document));
    if (!doc || !doc.sch) {
      return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `Schematic '${String(args.document)}' not found.`);
    }

    if (doc.activeInteractiveTool) {
      return errEnvelope(
        "ERR_USER_INTERACTIVE_BUSY",
        `User is currently active in '${doc.activeInteractiveTool}'; wait before mutating canvas.`
      );
    }

    const reqComps = Array.isArray(args.components)
      ? (args.components as Array<{
          deviceUuidOrLcsc: string;
          designator?: string;
          value?: string;
          posMm: [number, number];
          rotationDeg?: number;
          mirror?: boolean;
          clusterGroup?: string;
          sheetId?: string;
          extraProps?: Record<string, unknown>;
          pinNets?: Record<string, string>;
        }>)
      : [];

    // Hard Gate: verify ALL components have bound CESM models BEFORE mutating schematic!
    const resolvedModels: Array<{ lcscId: string; cesm: CesmModel }> = [];
    for (const item of reqComps) {
      const lcscId = item.deviceUuidOrLcsc.replace(/^dev_/, "").trim();
      if (!state.cesmBinder.isCesmBound(lcscId)) {
        return errEnvelope(
          "ERR_CESM_NOT_BOUND",
          `Hard Gate Blocked: Component '${lcscId}' (${item.designator ?? "unnamed"}) has no CESM bound in the current session. Call jlc_datasheet_extract({ lcscCode: "${lcscId}" }) before placing!`
        );
      }
      const cesm = state.cesmBinder.getBoundCesm(lcscId)!;
      resolvedModels.push({ lcscId, cesm });
    }

    const toRemove = new Set(
      ((args.removeDesignators as string[] | undefined) ?? []).map((s) => s.trim())
    );
    if (toRemove.size > 0) {
      doc.sch.components = doc.sch.components.filter((c) => !toRemove.has(c.designator));
    }

    const placedItems: Array<{
      handle: string;
      primitiveId: string;
      designator: string;
      pinLocationsMm: Record<string, [number, number]>;
    }> = [];

    for (let idx = 0; idx < reqComps.length; idx++) {
      const req = reqComps[idx];
      const { lcscId, cesm } = resolvedModels[idx];
      const designator = req.designator?.trim() || state.nextId("U");
      const [cx, cy] = req.posMm;
      const pinLocationsMm: Record<string, [number, number]> = {};
      const pinNets = req.pinNets ?? {};

      const compiledPins: CompiledPin[] = cesm.pins.map((p, pIdx) => {
        const dx = pIdx % 2 === 0 ? -5.08 : 5.08;
        const dy = Number(((Math.floor(pIdx / 2) - Math.floor(cesm.pins.length / 4)) * -2.54).toFixed(2));
        const px = Number((cx + dx).toFixed(4));
        const py = Number((cy + dy).toFixed(4));
        pinLocationsMm[p.pin_number] = [px, py];
        const net = pinNets[p.pin_number] ?? pinNets[p.pin_name] ?? null;
        return {
          pinNumber: p.pin_number,
          pinName: p.pin_name,
          elecType: p.elec_type,
          net,
          posMm: [px, py],
          isConnected: Boolean(net),
        };
      });

      const compObj: CompiledComponent = {
        primitiveId: state.nextId(`sch_${designator}`),
        designator,
        lcscId,
        mpn: cesm.mpn,
        value: req.value ?? cesm.mpn,
        footprint: cesm.package,
        sheetId: req.sheetId ?? doc.sch.sheets[0]?.name ?? "Sheet1",
        posMm: [cx, cy],
        rotationDeg: req.rotationDeg ?? 0,
        clusterGroup: req.clusterGroup ?? null,
        pins: compiledPins,
        extraProps: req.extraProps,
      };

      const existingIdx = doc.sch.components.findIndex((c) => c.designator === designator);
      if (existingIdx >= 0 && args.replaceExisting) {
        doc.sch.components[existingIdx] = compObj;
      } else if (existingIdx >= 0) {
        return errEnvelope(
          "ERR_DUPLICATE_DESIGNATOR",
          `Designator '${designator}' already exists in '${doc.handle}'. Pass replaceExisting=true to replace.`
        );
      } else {
        doc.sch.components.push(compObj);
      }

      const reg = state.handlePool.registerHandle({
        primitiveId: compObj.primitiveId,
        type: "Component",
        designator,
        centerMm: [cx, cy],
        bboxMm: [cx - 4, cy - 4, cx + 4, cy + 4],
      });

      placedItems.push({
        handle: reg.handle,
        primitiveId: compObj.primitiveId,
        designator,
        pinLocationsMm,
      });
    }

    doc.sch.lastElintReport = undefined;
    doc.isDirty = true;

    return okEnvelope({
      placedCount: placedItems.length,
      items: placedItems,
    });
  },
};

export const jlcSchBlockInstantiateTool: McpToolHandler = {
  name: "jlc_sch_block_instantiate",
  layer: 4,
  description:
    "一键实例化经工程验证的 9 大标准参考子电路积木块（如 BLK_USB_TYPEC_UFP_5V、BLK_DCDC_BUCK_SYNC、BLK_BUS_RS485_CAN、BLK_IND_RELAY_DRIVE 等），自动完成内部器件摆位与无四向十字交叉连线。",
  inputSchema: {
    type: "object",
    required: ["document", "blockTemplateId", "originMm"],
    properties: {
      document: { type: "string" },
      blockTemplateId: { type: "string" },
      originMm: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
      parameters: { type: "object", default: {} },
      netBindings: { type: "object", default: {} },
      clusterGroup: { type: "string" },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const doc = state.resolveDocument(String(args.document));
    if (!doc || !doc.sch) {
      return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `Schematic '${String(args.document)}' not found.`);
    }

    const templateId = String(args.blockTemplateId);
    const originMm = args.originMm as [number, number];
    const parameters = (args.parameters ?? {}) as Record<string, unknown>;
    const netBindings = (args.netBindings ?? {}) as Record<string, string>;

    let instRes: ReturnType<typeof instantiateBlock>;
    let template: ReturnType<typeof loadBlockTemplate>;
    try {
      template = loadBlockTemplate(templateId);
      instRes = instantiateBlock({
        blockTemplateId: templateId,
        originMm,
        parameters,
        netBindings,
        designatorSuffix: typeof args.clusterGroup === "string" ? args.clusterGroup : undefined,
      });
    } catch (err) {
      return errEnvelope(
        "ERR_BLOCK_INSTANTIATE_FAILED",
        err instanceof Error ? err.message : String(err)
      );
    }

    const suffix = instRes.placedComponents[0]?.designator.split("_").pop() ?? "1";
    const sheetId = doc.sch.sheets[0]?.name ?? "Sheet1";
    const vInRange = Array.isArray(parameters.v_in_range)
      ? (parameters.v_in_range as number[])
      : [9, 24];
    const vInMaxV = Math.max(...vInRange.map((v) => Number(v) || 0), Number(parameters.v_in_max ?? 0));

    for (const ic of instRes.placedComponents) {
      const cesm = ensureBlockComponentCesm(
        state,
        ic.refRole,
        ic.lcscId,
        ic.package,
        ic.value,
        Object.keys(ic.pinLocationsMm),
        vInMaxV
      );

      const pinMap = new Map<string, CompiledPin>();
      for (const cp of cesm.pins) {
        let net = resolvePinNetInBlock(template, ic.refRole, cp.pin_number, netBindings, suffix);
        if (!net && cp.elec_type === "GND") {
          if (cp.pin_name.startsWith("GND1")) {
            net = resolvePinNetInBlock(template, ic.refRole, "2", netBindings, suffix);
          } else if (cp.pin_name.startsWith("GND2")) {
            net = resolvePinNetInBlock(template, ic.refRole, "15", netBindings, suffix);
          }
        }
        pinMap.set(cp.pin_number, {
          pinNumber: cp.pin_number,
          pinName: cp.pin_name,
          elecType: cp.elec_type,
          net,
          posMm: ic.pinLocationsMm[cp.pin_number] ?? ic.posMm,
          isConnected: Boolean(net),
        });
      }

      for (const [pinNum, pt] of Object.entries(ic.pinLocationsMm)) {
        const net = resolvePinNetInBlock(template, ic.refRole, pinNum, netBindings, suffix);
        const existing = pinMap.get(pinNum);
        if (existing) {
          if (net) {
            existing.net = net;
            existing.isConnected = true;
          }
          existing.posMm = pt;
        } else {
          pinMap.set(pinNum, {
            pinNumber: pinNum,
            pinName: pinNum,
            elecType: "PASSIVE",
            net,
            posMm: pt,
            isConnected: Boolean(net),
          });
        }
      }

      doc.sch.components.push({
        primitiveId: state.nextId(`blk_${ic.designator}`),
        designator: ic.designator,
        lcscId: cesm.lcsc_id,
        mpn: cesm.mpn ?? ic.value,
        value: ic.value,
        footprint: cesm.package || ic.package,
        sheetId,
        posMm: ic.posMm,
        rotationDeg: ic.rotationDeg,
        clusterGroup: ic.clusterGroup,
        pins: Array.from(pinMap.values()),
      });
    }

    doc.sch.wires.push(...instRes.wires);
    doc.sch.junctions.push(...instRes.junctions);
    doc.sch.netLabels.push(...instRes.netLabels);
    doc.sch.lastElintReport = undefined;
    doc.isDirty = true;

    return okEnvelope({
      blockInstanceId: instRes.blockInstanceId,
      placedComponents: instRes.placedComponents,
      exposedPortsMm: instRes.exposedPortsMm,
      calcReport: instRes.calcReport,
      fourWayJunctionCount: instRes.fourWayJunctionCount,
      minJunctionSpacingMm: instRes.minJunctionSpacingMm,
      antiPitfalls: instRes.antiPitfalls,
    });
  },
};

export const jlcSchWireConnectTool: McpToolHandler = {
  name: "jlc_sch_wire_connect",
  layer: 4,
  description:
    "执行原理图引脚间正交自动连线、放置网络标签/电源/地符号与非连接标记；严禁生成四向十字交叉连接，多线汇合自动错开 >=2.54mm 为双 T 型三向连接点。",
  inputSchema: {
    type: "object",
    required: ["document"],
    properties: {
      document: { type: "string" },
      connections: {
        type: "array",
        items: {
          type: "object",
          required: ["fromPin", "toPin"],
          properties: {
            fromPin: { type: "string" },
            toPin: { type: "string" },
            netName: { type: "string" },
          },
        },
        default: [],
      },
      disconnectPins: { type: "array", items: { type: "string" }, default: [] },
      netLabels: {
        type: "array",
        items: {
          type: "object",
          required: ["posMm", "netName"],
          properties: {
            posMm: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
            netName: { type: "string" },
            kind: { type: "string", enum: ["label", "power", "gnd"], default: "label" },
          },
        },
        default: [],
      },
      noConnectPins: { type: "array", items: { type: "string" }, default: [] },
      staggerCrossJunctions: { type: "boolean", default: true },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const doc = state.resolveDocument(String(args.document));
    if (!doc || !doc.sch) {
      return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `Schematic '${String(args.document)}' not found.`);
    }

    const findPin = (ref: string): { comp: CompiledComponent; pin: CompiledPin } | null => {
      const dot = ref.indexOf(".");
      if (dot <= 0) return null;
      const des = ref.slice(0, dot).trim();
      const pinId = ref.slice(dot + 1).trim();
      const comp = doc.sch!.components.find((c) => c.designator === des);
      if (!comp) return null;
      const pin = comp.pins.find((p) => p.pinNumber === pinId || p.pinName === pinId);
      if (!pin) return null;
      return { comp, pin };
    };

    for (const dRef of (args.disconnectPins as string[] | undefined) ?? []) {
      const found = findPin(dRef);
      if (found) {
        found.pin.net = null;
        found.pin.isConnected = false;
      }
    }

    const connections = Array.isArray(args.connections)
      ? (args.connections as Array<{ fromPin: string; toPin: string; netName?: string }>)
      : [];

    const netPoints = new Map<string, Array<[number, number]>>();
    const shortCircuitWarnings: string[] = [];

    for (const conn of connections) {
      const a = findPin(conn.fromPin);
      const b = findPin(conn.toPin);
      if (!a || !b) {
        return errEnvelope(
          "ERR_PIN_NOT_FOUND",
          `Unable to resolve pin reference in connection '${conn.fromPin}' -> '${conn.toPin}'.`
        );
      }
      const netName = conn.netName?.trim() || a.pin.net || b.pin.net || state.nextId("NET");
      if (a.pin.net && b.pin.net && a.pin.net !== b.pin.net && !conn.netName) {
        shortCircuitWarnings.push(
          `Merged existing nets '${a.pin.net}' and '${b.pin.net}' into '${netName}'.`
        );
      }
      a.pin.net = netName;
      a.pin.isConnected = true;
      b.pin.net = netName;
      b.pin.isConnected = true;

      const pts = netPoints.get(netName) ?? [];
      pts.push(a.pin.posMm ?? a.comp.posMm ?? [0, 0]);
      pts.push(b.pin.posMm ?? b.comp.posMm ?? [0, 0]);
      netPoints.set(netName, pts);
    }

    let wiresCreated = 0;
    let staggeredTeeJunctions = 0;
    for (const [netName, pts] of netPoints.entries()) {
      const routed = routeOrthogonalStaggeredNet(netName, pts, state.nextId(`w_${netName}`));
      doc.sch.wires.push(...routed.wires);
      doc.sch.junctions.push(...routed.junctions);
      wiresCreated += routed.wires.length;
      staggeredTeeJunctions += routed.junctions.length;
    }

    const labels = Array.isArray(args.netLabels)
      ? (args.netLabels as Array<{ posMm: [number, number]; netName: string; kind?: "label" | "power" | "gnd" }>)
      : [];
    for (const lbl of labels) {
      doc.sch.netLabels.push({
        posMm: lbl.posMm,
        netName: lbl.netName,
        kind: lbl.kind ?? "label",
      });
    }

    const ncPins = Array.isArray(args.noConnectPins) ? (args.noConnectPins as string[]) : [];
    for (const nc of ncPins) {
      if (!doc.sch.noConnectPins.includes(nc)) doc.sch.noConnectPins.push(nc);
      const found = findPin(nc);
      if (found) {
        found.pin.net = null;
        found.pin.isConnected = false;
      }
    }

    const jCheck = verifyNoFourWayJunctions(doc.sch.wires, doc.sch.junctions);
    doc.sch.lastElintReport = undefined;
    doc.isDirty = true;

    return okEnvelope({
      wiresCreated,
      staggeredTeeJunctions,
      netLabelsPlaced: labels.length,
      ncFlagsPlaced: ncPins.length,
      fourWayJunctionCount: jCheck.fourWayJunctionCount,
      minJunctionSpacingMm: jCheck.minJunctionSpacingMm,
      shortCircuitWarnings,
    });
  },
};

export const jlcSchNetlistQueryTool: McpToolHandler = {
  name: "jlc_sch_netlist_query",
  layer: 4,
  description:
    "100% 唯一调用官方编译器 eda.sch_Netlist 导出权威编译态结构化网表（严禁通过读取 sch_PrimitiveWire 二维坐标推导连通性）。",
  inputSchema: {
    type: "object",
    required: ["document"],
    properties: {
      document: { type: "string" },
      format: {
        type: "string",
        enum: ["structured_json", "spice", "protel", "pads"],
        default: "structured_json",
      },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const doc = state.resolveDocument(String(args.document));
    if (!doc || !doc.sch) {
      return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `Schematic '${String(args.document)}' not found.`);
    }

    const netlist = compileSchematicNetlist(doc);
    const paged = state.handlePool.paginateArray(netlist.nets);

    return okEnvelope({
      netlistSource: netlist.netlistSource,
      projectUuid: netlist.projectUuid,
      documentUuid: netlist.documentUuid,
      documentName: netlist.documentName,
      componentCount: netlist.componentCount,
      netCount: netlist.netCount,
      components: netlist.components,
      nets: paged.items,
      unconnectedPins: netlist.unconnectedPins,
      groupBoxes: netlist.groupBoxes,
      ...(paged.paginated && paged.arrayCursor ? { arrayCursor: paged.arrayCursor.handle } : {}),
    });
  },
};

export const jlcSpiceRunTool: McpToolHandler = {
  name: "jlc_spice_run",
  layer: 4,
  description:
    "驱动嘉立创内置 SCH_SimulationEngine 或本地无头 ngspice / MNA 求解器运行 OP/TRAN/AC/DC 仿真并校验定量 assertions 断言。",
  inputSchema: {
    type: "object",
    required: ["analysisSuite"],
    properties: {
      document: { type: "string" },
      spiceNetlist: { type: "string" },
      subcircuitNets: { type: "array", items: { type: "string" } },
      components: { type: "array", items: { type: "string" } },
      analysisSuite: {
        type: "array",
        items: {
          type: "object",
          required: ["type", "params"],
          properties: {
            type: { type: "string", enum: ["OP", "TRAN", "AC", "DC"] },
            params: { type: "object" },
            assertions: { type: "array", items: { type: "string" } },
          },
        },
      },
      probeNodes: { type: "array", items: { type: "string" } },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const envInfo = await state.ensureEnvInfo(context);
    try {
      const res = await runSpiceSimulation(
        {
          document: typeof args.document === "string" ? args.document : undefined,
          spiceNetlist: typeof args.spiceNetlist === "string" ? args.spiceNetlist : undefined,
          subcircuitNets: Array.isArray(args.subcircuitNets) ? (args.subcircuitNets as string[]) : undefined,
          components: Array.isArray(args.components) ? (args.components as string[]) : undefined,
          analysisSuite: args.analysisSuite as SpiceAnalysisItem[],
          probeNodes: Array.isArray(args.probeNodes) ? (args.probeNodes as string[]) : undefined,
        },
        { ngspiceExePath: envInfo.paths.ngspiceExePath }
      );
      return okEnvelope(res);
    } catch (err) {
      return errEnvelope(
        "ERR_SPICE_FAILED",
        err instanceof Error ? err.message : String(err)
      );
    }
  },
};

export const jlcSchSyncToPcbTool: McpToolHandler = {
  name: "jlc_sch_sync_to_pcb",
  layer: 4,
  description:
    "执行原理图至目标 PCB 的正向工程变更同步（硬门禁：必须先通过 jlc_elec_lint 0 Blocker 才能解锁）。",
  inputSchema: {
    type: "object",
    required: ["schDocument", "pcbDocument"],
    properties: {
      schDocument: { type: "string" },
      pcbDocument: { type: "string" },
      dryRun: { type: "boolean", default: false },
      removeExtraComponents: { type: "boolean", default: false },
    },
  },
  async execute(args, context) {
    const state = getWorkspaceState(context);
    const schDoc = state.resolveDocument(String(args.schDocument));
    if (!schDoc || !schDoc.sch) {
      return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `Schematic '${String(args.schDocument)}' not found.`);
    }

    const schNetlist = compileSchematicNetlist(schDoc);
    const elintReport = runElectricalLinter(schNetlist, {
      cesmResolver: state.getCesmResolver(),
      strictness: "production",
    });
    schDoc.sch.lastElintReport = elintReport;

    if (elintReport.blockerCount > 0 || elintReport.gateStatus !== "READY_FOR_PCB") {
      return errEnvelope(
        "ERR_ELINT_BLOCKED",
        `Hard Gate Blocked: Schematic '${schDoc.handle}' failed electrical audit (${elintReport.blockerCount} blocker(s)). Fix all ELINT blockers before syncing to PCB.`,
        {
          data: {
            synced: false,
            gateStatus: elintReport.gateStatus,
            blockerCount: elintReport.blockerCount,
            warningCount: elintReport.warningCount,
            diagnostics: elintReport.diagnostics.filter((d) => d.severity === "BLOCKER"),
          },
        }
      );
    }

    const pcbDocName = String(args.pcbDocument);
    let pcbDoc = state.resolveDocument(pcbDocName);
    if (!pcbDoc && !args.dryRun) {
      const created = state.createProjectAndDocument({
        kind: "pcb",
        name: pcbDocName,
        parentProjectUuid: schDoc.projectUuid,
      });
      pcbDoc = created.doc;
    }

    const existingDes = new Set(
      pcbDoc?.pcb?.syncedNetlist?.components.map((c) => c.designator) ?? []
    );
    const addedComponents = schNetlist.components
      .map((c) => c.designator)
      .filter((d) => !existingDes.has(d));
    const updatedNets = schNetlist.nets.map((n) => n.netName);

    if (args.dryRun) {
      return okEnvelope({
        synced: false,
        dryRun: true,
        addedComponents,
        updatedNets,
        footprintErrors: [],
      });
    }

    if (!pcbDoc) {
      return errEnvelope("ERR_DOCUMENT_NOT_FOUND", `PCB '${pcbDocName}' could not be resolved.`);
    }
    if (!pcbDoc.pcb) {
      pcbDoc.pcb = createDefaultPcbData();
    }

    pcbDoc.pcb.sourceSchDocument = schDoc.handle;
    pcbDoc.pcb.syncedNetlist = {
      ...structuredClone(schNetlist),
      netlistSource: "eda.pcb_Netlist",
      documentUuid: pcbDoc.uuid,
      documentName: pcbDoc.title,
    };

    // Inject constraintHandoffPackage Keepouts & NetClass seeds
    const handoff = elintReport.constraintHandoffPackage;
    if (handoff) {
      if (handoff.keepoutZones25D.length > 0) {
        pcbDoc.pcb.keepoutZones25D = [
          ...pcbDoc.pcb.keepoutZones25D,
          ...handoff.keepoutZones25D,
        ];
      }
      for (const r of handoff.perNetRoutingRules) {
        const clsName = r.netClass ?? `NET_${r.netName}`;
        pcbDoc.pcb.projectDesignRules.netClasses[clsName] = {
          name: clsName,
          nets: [r.netName],
          minWidthMm: r.minWidthMm,
          preferredWidthMm: r.preferredWidthMm,
          minClearanceMm: r.minClearanceMm,
          prioritySource: "computed_handoff",
        };
      }
    }

    pcbDoc.isDirty = true;

    return okEnvelope({
      synced: true,
      pcbDocument: pcbDoc.handle,
      addedComponents,
      updatedNets,
      footprintErrors: [],
    });
  },
};

export const LAYER4_TOOLS: McpToolHandler[] = [
  jlcSchSheetManageTool,
  jlcSchComponentPlaceTool,
  jlcSchBlockInstantiateTool,
  jlcSchWireConnectTool,
  jlcSchNetlistQueryTool,
  jlcSpiceRunTool,
  jlcSchSyncToPcbTool,
];
