import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCdpSessionManager } from "../../src/cdp/index.js";
import {
  JLC_TOOL_NAMES,
  type MasterValidationReport,
  type McpEnvelope,
  type McpToolContext,
  type McpToolResponse,
  type PcbLintReport,
} from "../../src/types/index.js";
import {
  getToolHandler,
  getWorkspaceState,
  resetWorkspaceState,
} from "../../src/tools/index.js";

async function invoke<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
  context: McpToolContext
): Promise<McpEnvelope<T>> {
  const handler = getToolHandler(name);
  if (!handler) {
    throw new Error(`Missing tool handler: ${name}`);
  }
  const res = await handler.execute(args, context);
  if ("content" in res && Array.isArray(res.content)) {
    const textItem = res.content.find((c) => c.type === "text" && typeof c.text === "string");
    return JSON.parse(textItem?.text ?? "{}") as McpEnvelope<T>;
  }
  return res as McpEnvelope<T>;
}

async function invokeRawResponse(
  name: string,
  args: Record<string, unknown>,
  context: McpToolContext
): Promise<McpToolResponse> {
  const handler = getToolHandler(name);
  if (!handler) {
    throw new Error(`Missing tool handler: ${name}`);
  }
  const res = await handler.execute(args, context);
  if ("content" in res && Array.isArray(res.content)) {
    return res as McpToolResponse;
  }
  return {
    content: [{ type: "text", text: JSON.stringify(res) }],
    isError: !(res as McpEnvelope<unknown>).ok,
  };
}

describe("E2E Phase 5: Industrial IoT Controller 4-Layer Golden Board Full Closed Loop", () => {
  let context: McpToolContext;
  let tempOutDir: string;
  let schDoc = "";
  let pcbDoc = "";

  beforeAll(() => {
    context = { sessionManager: createCdpSessionManager() };
    tempOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "jlceda-golden-iot-"));
    resetWorkspaceState(context, {
      cesmSqlitePath: path.join(tempOutDir, "cesm_cache.sqlite"),
      layoutImageDir: path.join(tempOutDir, "layout_examples"),
    });
  });

  afterAll(async () => {
    if (pcbDoc) {
      await invoke("jlc_document_close", { document: pcbDoc, releaseProcess: true }, context).catch(
        () => undefined
      );
    }
    if (schDoc) {
      await invoke("jlc_document_close", { document: schDoc, releaseProcess: true }, context).catch(
        () => undefined
      );
    }
    resetWorkspaceState(context);
    fs.rmSync(tempOutDir, { recursive: true, force: true });
  });

  it("executes end-to-end 41-tool hardware design, error traps + self-healing, 4-layer synthesis, vision comparison, validation, and clean export", async () => {
    // 0. Sanity: all 41 tools registered
    expect(JLC_TOOL_NAMES.all).toHaveLength(41);

    // 1. Layer 1: Create project, schematic sheet, PCB document & setup sheet frames
    const projRes = await invoke<{
      projectUuid: string;
      documentHandle: string;
      path: string;
    }>("jlc_document_new", { kind: "project", name: "Industrial_IoT_Controller" }, context);
    expect(projRes.ok).toBe(true);
    schDoc = projRes.data!.documentHandle;
    const projectUuid = projRes.data!.projectUuid;

    const pcbNewRes = await invoke<{ documentHandle: string }>(
      "jlc_document_new",
      { kind: "pcb", name: "IoT_Controller_4L", parentProjectUuid: projectUuid },
      context
    );
    expect(pcbNewRes.ok).toBe(true);
    pcbDoc = pcbNewRes.data!.documentHandle;

    const docsList = await invoke<{ documents: Array<{ handle: string }> }>(
      "jlc_documents",
      { projectUuid },
      context
    );
    expect(docsList.ok).toBe(true);
    expect(docsList.data!.documents.length).toBeGreaterThanOrEqual(2);

    const actSch = await invoke("jlc_document_activate", { document: schDoc }, context);
    expect(actSch.ok).toBe(true);

    const sheetRes = await invoke(
      "jlc_sch_sheet_manage",
      {
        document: schDoc,
        action: "setup_frame",
        frameSize: "A3",
        titleBlock: { title: "Industrial IoT Controller", rev: "1.0" },
      },
      context
    );
    expect(sheetRes.ok).toBe(true);

    const boxRes = await invoke(
      "jlc_sch_sheet_manage",
      {
        document: schDoc,
        action: "draw_module_box",
        blocks: [
          { id: "blk_pwr", title: "24V->5V Buck & 3.3V LDO", rectMm: [10, 10, 120, 90] },
          { id: "blk_mcu", title: "STM32F103C8T6 + 8MHz XTAL", rectMm: [130, 10, 260, 120] },
          { id: "blk_io", title: "USB-C / SHT30 / ISO RS-485 / 220V Relay", rectMm: [10, 130, 260, 240] },
        ],
      },
      context
    );
    expect(boxRes.ok).toBe(true);

    // 2. Layer 3: Search library, inspect device, run electrical calculations, create custom shunt/connectors
    const libSearch = await invoke<{ items: Array<{ lcscCode: string }> }>(
      "jlc_lib_search",
      { query: "TPS54302", limit: 10 },
      context
    );
    expect(libSearch.ok).toBe(true);
    expect(libSearch.data!.items.some((r) => r.lcscCode === "C96581")).toBe(true);

    const inspectBuck = await invoke<{ lcscId: string; mpn: string }>(
      "jlc_lib_device_inspect",
      { deviceUuidOrLcsc: "C96581" },
      context
    );
    expect(inspectBuck.ok).toBe(true);
    expect(inspectBuck.data!.mpn).toContain("TPS54302");

    const xtalCalc = await invoke<{ results: Record<string, unknown> }>(
      "jlc_elec_calc",
      {
        calculator: "crystal_load_cap",
        inputs: { cl_datasheet_pf: 12, freq_mhz: 8, c_pin_pf: 2.0, c_trace_pf: 1.5 },
      },
      context
    );
    expect(xtalCalc.ok).toBe(true);

    const buckCalc = await invoke(
      "jlc_elec_calc",
      {
        calculator: "dcdc_inductor_cap",
        inputs: {
          topology: "BUCK",
          v_in_range: [9, 24],
          v_out: 5,
          i_out_max: 1.0,
          f_sw_khz: 400,
          ripple_ratio: 0.3,
        },
      },
      context
    );
    expect(buckCalc.ok).toBe(true);

    // Custom LCSC parts for Shunt, Isolated Aux Brick, Terminal Blocks
    expect(
      (
        await invoke(
          "jlc_lib_custom_create",
          {
            name: "SHUNT_50MR_2512",
            lcscCode: "C910050",
            category: "RES_SHUNT",
            packageType: "2512",
            dimensionsMm: { bodyWidth: 6.3, bodyHeight: 3.1 },
            pins: [
              { pinNumber: "1", pinName: "IN", elecType: "PASSIVE" },
              { pinNumber: "2", pinName: "OUT", elecType: "PASSIVE" },
            ],
          },
          context
        )
      ).ok
    ).toBe(true);

    expect(
      (
        await invoke(
          "jlc_lib_custom_create",
          {
            name: "HDR_ISO_3V3_FIELD",
            lcscCode: "C910051",
            category: "CONN_GENERIC",
            packageType: "TERM-2P-3.81",
            dimensionsMm: { bodyWidth: 8.0, bodyHeight: 6.5 },
            pins: [
              { pinNumber: "1", pinName: "VOUT+", elecType: "POWER_OUT" },
              { pinNumber: "2", pinName: "GND_ISO", elecType: "GND" },
            ],
          },
          context
        )
      ).ok
    ).toBe(true);

    for (const conn of [
      { name: "HDR_24V_IN", lcscCode: "C910052", p1: "VIN+", p2: "GND", pkg: "TERM-2P-5.08" },
      { name: "HDR_RS485_BUS", lcscCode: "C910053", p1: "A", p2: "B", pkg: "TERM-3P-3.81" },
      { name: "HDR_AC_220V", lcscCode: "C910054", p1: "L_IN", p2: "LOAD", pkg: "TERM-2P-7.62" },
    ]) {
      const cRes = await invoke(
        "jlc_lib_custom_create",
        {
          name: conn.name,
          lcscCode: conn.lcscCode,
          category: "CONN_GENERIC",
          packageType: conn.pkg,
          dimensionsMm: { bodyWidth: 10.0, bodyHeight: 7.5 },
          pins: [
            { pinNumber: "1", pinName: conn.p1, elecType: conn.p1 === "VIN+" ? "POWER_OUT" : "PASSIVE" },
            { pinNumber: "2", pinName: conn.p2, elecType: conn.p2 === "GND" ? "GND" : "PASSIVE" },
          ],
        },
        context
      );
      expect(cRes.ok).toBe(true);
    }

    // I2C GPIO Expander (PCF8574-style) for isolated RS-485 DE & Relay Driver control outputs
    expect(
      (
        await invoke(
          "jlc_lib_custom_create",
          {
            name: "PCA9536_IOEXP",
            lcscCode: "C910055",
            category: "INTERFACE_XCVR",
            packageType: "MSOP-8",
            dimensionsMm: { bodyWidth: 3.0, bodyHeight: 3.0 },
            pins: [
              { pinNumber: "1", pinName: "SCL", elecType: "OPEN_DRAIN" },
              { pinNumber: "2", pinName: "SDA", elecType: "OPEN_DRAIN" },
              { pinNumber: "3", pinName: "VCC", elecType: "POWER_IN" },
              { pinNumber: "4", pinName: "GND", elecType: "GND" },
              { pinNumber: "5", pinName: "GP0_RELAY", elecType: "PUSH_PULL" },
              { pinNumber: "6", pinName: "GP1_DE", elecType: "PUSH_PULL" },
            ],
          },
          context
        )
      ).ok
    ).toBe(true);

    // 3. AI Error Trap #1: Placing C112582 (SHT30) BEFORE jlc_datasheet_extract must fail with ERR_CESM_NOT_BOUND
    const unboundPlaceRes = await invoke(
      "jlc_sch_component_place",
      {
        document: schDoc,
        components: [
          {
            deviceUuidOrLcsc: "C112582",
            designator: "U_SHT30",
            posMm: [240, 200],
            clusterGroup: "sensor",
            pinNets: { "1": "I2C1_SDA", "4": "I2C1_SCL", "5": "3V3", "8": "GND" },
          },
        ],
      },
      context
    );
    expect(unboundPlaceRes.ok).toBe(false);
    expect(unboundPlaceRes.errorCode).toBe("ERR_CESM_NOT_BOUND");

    // Self-heal Trap #1: bind SHT30 (C112582) and key ICs/passives via jlc_datasheet_extract
    const shtExtract = await invoke<{ verified: boolean; cesm: { lcsc_id: string } }>(
      "jlc_datasheet_extract",
      { lcscCode: "C112582", bindCesmToSession: true },
      context
    );
    expect(shtExtract.ok).toBe(true);
    expect(shtExtract.data!.verified).toBe(true);
    expect(shtExtract.data!.cesm.lcsc_id).toBe("C112582");

    for (const lcscCode of ["C96581", "C6186", "C1525", "C25900", "C25744", "C15850", "C1017"]) {
      const ex = await invoke("jlc_datasheet_extract", { lcscCode, bindCesmToSession: true }, context);
      expect(ex.ok).toBe(true);
    }

    // Extract & bind C2040 and ESD/TVS clamping ratings verified below IC v_abs_max
    expect(
      (await invoke("jlc_datasheet_extract", { lcscCode: "C2040", bindCesmToSession: true }, context)).ok
    ).toBe(true);

    expect(
      (
        await invoke(
          "jlc_datasheet_extract",
          {
            lcscCode: "C81598",
            bindCesmToSession: true,
            overrides: { ratings: { v_rwm_v: 5.5, v_clamp_max_v: 5.4, c_junction_pf: 120 } },
          },
          context
        )
      ).ok
    ).toBe(true);
    expect(
      (
        await invoke(
          "jlc_datasheet_extract",
          {
            lcscCode: "C7519",
            bindCesmToSession: true,
            overrides: { ratings: { v_rwm_v: 5.25, v_clamp_max_v: 5.4, c_junction_pf: 0.8 } },
          },
          context
        )
      ).ok
    ).toBe(true);
    expect(
      (
        await invoke(
          "jlc_datasheet_extract",
          {
            lcscCode: "C16137",
            bindCesmToSession: true,
            overrides: { ratings: { v_rwm_v: 12.0, v_clamp_max_v: 12.2, c_junction_pf: 45 } },
          },
          context
        )
      ).ok
    ).toBe(true);

    // Now SHT30 placement succeeds! Isolate analog sensor rail locally via ferrite bead FB_SHT30 (3V3 -> 3V3_SENS)
    // so decoupling assignment pairs C_SHT30_DEC strictly 1-to-1 with U_SHT30.
    const shtPlaceRes = await invoke(
      "jlc_sch_component_place",
      {
        document: schDoc,
        components: [
          {
            deviceUuidOrLcsc: "C1017",
            designator: "FB_SHT30",
            value: "600R@100MHz",
            posMm: [338, 185],
            clusterGroup: "sensor",
            pinNets: { "1": "3V3", "2": "3V3_SENS" },
          },
          {
            deviceUuidOrLcsc: "C112582",
            designator: "U_SHT30",
            value: "SHT30-DIS-B",
            posMm: [360, 185],
            clusterGroup: "sensor",
            pinNets: {
              "1": "I2C1_SDA",
              "2": "GND",
              "3": "SHT30_ALERT",
              "4": "I2C1_SCL",
              "5": "3V3_SENS",
              "6": "3V3_SENS",
              "7": "GND",
              "8": "GND",
            },
          },
          {
            deviceUuidOrLcsc: "C1525",
            designator: "C_SHT30_DEC",
            value: "100nF",
            posMm: [375, 185],
            clusterGroup: "sensor",
            pinNets: { "1": "3V3_SENS", "2": "GND" },
          },
          {
            deviceUuidOrLcsc: "C25900",
            designator: "R_I2C_SCL",
            value: "4.7k",
            posMm: [345, 175],
            clusterGroup: "sensor",
            pinNets: { "1": "3V3", "2": "I2C1_SCL" },
          },
          {
            deviceUuidOrLcsc: "C25900",
            designator: "R_I2C_SDA",
            value: "4.7k",
            posMm: [350, 175],
            clusterGroup: "sensor",
            pinNets: { "1": "3V3", "2": "I2C1_SDA" },
          },
          {
            deviceUuidOrLcsc: "C25744",
            designator: "R_SHT_ALERT",
            value: "10k",
            posMm: [355, 175],
            clusterGroup: "sensor",
            pinNets: { "1": "3V3", "2": "SHT30_ALERT" },
          },
        ],
      },
      context
    );
    expect(shtPlaceRes.ok).toBe(true);

    // 4. Instantiate 7 standard building blocks via jlc_sch_block_instantiate (well-spaced across A3 sheet)
    // Instantiate MCU min system before LDO so U_MCU's 4 VDD pins bind 1-to-1 with C_DEC_1..4_mcu
    const blockPlans: Array<{
      blockTemplateId: string;
      clusterGroup: string;
      originMm: [number, number];
      parameters?: Record<string, unknown>;
      netBindings: Record<string, string>;
    }> = [
      {
        blockTemplateId: "BLK_MCU_MIN_SYS",
        clusterGroup: "mcu",
        originMm: [215, 45],
        netBindings: { VDD_3V3: "3V3", OSC_IN: "OSC_IN", OSC_OUT: "OSC_OUT", GND: "GND" },
      },
      {
        blockTemplateId: "BLK_USB_TYPEC_UFP_5V",
        clusterGroup: "usb",
        originMm: [30, 160],
        netBindings: { VBUS_5V: "VBUS_5V", USB_DP: "USB_DP", USB_DN: "USB_DM", GND: "GND" },
      },
      {
        blockTemplateId: "BLK_DCDC_BUCK_SYNC",
        clusterGroup: "buck",
        originMm: [30, 40],
        parameters: { v_in_range: [9, 24], v_out: 5.0, i_out_max: 1.0, f_sw_khz: 400 },
        netBindings: { VIN: "VIN_24V", VOUT: "5V", GND: "GND" },
      },
      {
        blockTemplateId: "BLK_LDO_LOWNOISE",
        clusterGroup: "ldo",
        originMm: [130, 40],
        netBindings: { VIN: "5V", VOUT: "3V3", GND: "GND" },
      },
      {
        blockTemplateId: "BLK_XTAL_PASSIVE",
        clusterGroup: "xtal",
        originMm: [335, 45],
        parameters: { freq_mhz: 8, cl_datasheet_pf: 12, c_stray_pf: 4.5 },
        netBindings: { OSC_IN: "OSC_IN", OSC_OUT: "OSC_OUT", GND: "GND" },
      },
      {
        blockTemplateId: "BLK_BUS_RS485_CAN",
        clusterGroup: "rs485",
        originMm: [130, 185],
        netBindings: {
          VCC_PRI: "3V3",
          GND_PRI: "GND",
          UART_TX: "RS485_TX",
          UART_RX: "RS485_RX",
          RS485_DE: "RS485_DE",
          VCC_ISO: "VCC_ISO_3V3",
          GND_ISO: "GND_ISO",
          BUS_A: "RS485_A",
          BUS_B: "RS485_B",
        },
      },
      {
        blockTemplateId: "BLK_IND_RELAY_DRIVE",
        clusterGroup: "relay",
        originMm: [245, 185],
        netBindings: {
          CTRL_IN: "RELAY_CTRL",
          VCC_COIL: "5V",
          GND: "GND",
          LOAD_COM: "AC_L_220V",
          LOAD_NO: "AC_LOAD_220V",
        },
      },
    ];

    for (const bp of blockPlans) {
      const bRes = await invoke("jlc_sch_block_instantiate", { document: schDoc, ...bp }, context);
      expect(bRes.ok).toBe(true);
    }

    // Place external connectors, isolated DC/DC brick, and low-side current shunt circuit
    const auxPlace = await invoke(
      "jlc_sch_component_place",
      {
        document: schDoc,
        components: [
          {
            deviceUuidOrLcsc: "C910052",
            designator: "J_PWR_24V",
            value: "24V_IN",
            posMm: [18, 40],
            clusterGroup: "buck",
            pinNets: { "1": "VIN_24V", "2": "GND" },
          },
          {
            deviceUuidOrLcsc: "C910051",
            designator: "J_ISO_PWR",
            value: "ISO_3V3_IN",
            posMm: [110, 175],
            clusterGroup: "rs485",
            pinNets: { "1": "VCC_ISO_3V3", "2": "GND_ISO" },
          },
          {
            deviceUuidOrLcsc: "C910053",
            designator: "J_RS485",
            value: "RS485_TERM",
            posMm: [105, 200],
            clusterGroup: "rs485",
            pinNets: { "1": "RS485_A", "2": "RS485_B" },
          },
          {
            deviceUuidOrLcsc: "C910054",
            designator: "J_AC_220V",
            value: "AC_220V_OUT",
            posMm: [200, 200],
            clusterGroup: "relay",
            pinNets: { "1": "AC_L_220V", "2": "AC_LOAD_220V" },
          },
          {
            deviceUuidOrLcsc: "C910050",
            designator: "R_SHUNT1",
            value: "50mR",
            posMm: [120, 115],
            clusterGroup: "shunt",
            pinNets: { "1": "ISENSE_SHUNT_P", "2": "GND" },
          },
          {
            deviceUuidOrLcsc: "C25744",
            designator: "R_ISENSE_DAMP",
            value: "100R",
            posMm: [132, 115],
            clusterGroup: "shunt",
            pinNets: { "1": "ISENSE_SHUNT_P", "2": "ISENSE_OUT" },
          },
          {
            deviceUuidOrLcsc: "C1525",
            designator: "C_ISENSE_FILT",
            value: "100nF",
            posMm: [140, 115],
            clusterGroup: "shunt",
            pinNets: { "1": "ISENSE_OUT", "2": "GND" },
          },
          {
            deviceUuidOrLcsc: "C1017",
            designator: "FB_IOEXP",
            value: "600R@100MHz",
            posMm: [232, 140],
            clusterGroup: "mcu",
            pinNets: { "1": "3V3", "2": "3V3_IO" },
          },
          {
            deviceUuidOrLcsc: "C910055",
            designator: "U_IOEXP",
            value: "PCA9536",
            posMm: [240, 140],
            clusterGroup: "mcu",
            pinNets: {
              "1": "I2C1_SCL",
              "2": "I2C1_SDA",
              "3": "3V3_IO",
              "4": "GND",
              "5": "RELAY_CTRL",
              "6": "RS485_DE",
            },
          },
          {
            deviceUuidOrLcsc: "C1525",
            designator: "C_IOEXP_DEC",
            value: "100nF",
            posMm: [248, 140],
            clusterGroup: "mcu",
            pinNets: { "1": "3V3_IO", "2": "GND" },
          },
        ],
      },
      context
    );
    expect(auxPlace.ok).toBe(true);

    // Connect MCU functional signals & verify jlc_sch_wire_connect eliminates 4-way crosses
    const ws = getWorkspaceState(context);
    const schObj = ws.resolveDocument(schDoc)!;
    // Use IPC DO-214AC footprint label on flyback diode so SMA doesn't trigger RF SMA connector heuristic
    const dFlyback = schObj.sch!.components.find((c) => c.designator.startsWith("D_FLYBACK"));
    if (dFlyback) dFlyback.footprint = "DO-214AC";
    const mcuComp = schObj.sch!.components.find((c) => c.designator.startsWith("U_MCU"));
    expect(mcuComp).toBeDefined();
    const mcuPinTargets: Record<string, string> = {
      "10": "ISENSE_OUT",
      "30": "RS485_TX",
      "31": "RS485_RX",
      "32": "USB_DM",
      "33": "USB_DP",
      "34": "SWDIO",
      "37": "SWCLK",
      "42": "I2C1_SCL",
      "43": "I2C1_SDA",
    };
    for (const pin of mcuComp!.pins) {
      if (mcuPinTargets[pin.pinNumber]) {
        pin.net = mcuPinTargets[pin.pinNumber];
        pin.isConnected = true;
      }
    }

    const wireRes = await invoke<{ fourWayJunctionCount: number; minJunctionSpacingMm: number }>(
      "jlc_sch_wire_connect",
      {
        document: schDoc,
        connections: [
          {
            fromPin: `${mcuComp!.designator}.42`,
            toPin: "U_SHT30.4",
            netName: "I2C1_SCL",
          },
          {
            fromPin: `${mcuComp!.designator}.43`,
            toPin: "U_SHT30.1",
            netName: "I2C1_SDA",
          },
        ],
        staggerCrossJunctions: true,
      },
      context
    );
    expect(wireRes.ok).toBe(true);
    expect(wireRes.data!.fourWayJunctionCount).toBe(0);
    expect(wireRes.data!.minJunctionSpacingMm).toBeGreaterThanOrEqual(2.54);

    // =========================================================================
    // 5. AI Error Traps #2 & #3: Inject 3 classic ELINT Blockers -> verify Gate Locks Sync
    // =========================================================================
    const jUsb = schObj.sch!.components.find((c) => c.designator.startsWith("J_USB"))!;
    const cc1Pin = jUsb.pins.find((p) => p.pinNumber === "A5")!;
    const cc2Pin = jUsb.pins.find((p) => p.pinNumber === "B5")!;
    const origCc1Net = cc1Pin.net;
    const origCc2Net = cc2Pin.net;

    const uIso = schObj.sch!.components.find((c) => c.designator.startsWith("U_ISO"))!;
    const isoGnd2Pins = uIso.pins.filter((p) => p.pinNumber === "9" || p.pinNumber === "15");
    const origIsoGnd2 = isoGnd2Pins.map((p) => p.net);

    // Trigger ELINT-019 (shared single 5.1k CC resistor), ELINT-010/011 (AMS1117 24V->3.3V), ELINT-025 (ISO7741 pri/sec GND short)
    cc1Pin.net = "USB_CC_SHARED";
    cc2Pin.net = "USB_CC_SHARED";
    for (const p of isoGnd2Pins) {
      p.net = "GND";
    }
    const badPlace = await invoke(
      "jlc_sch_component_place",
      {
        document: schDoc,
        components: [
          {
            deviceUuidOrLcsc: "C6186",
            designator: "U_LDO_BAD",
            value: "AMS1117-3.3",
            posMm: [90, 95],
            pinNets: { "1": "GND", "2": "3V3", "3": "VIN_24V", "4": "3V3" },
          },
          {
            deviceUuidOrLcsc: "C25905",
            designator: "R_CC_BAD",
            value: "5.1k",
            posMm: [45, 160],
            pinNets: { "1": "USB_CC_SHARED", "2": "GND" },
          },
        ],
      },
      context
    );
    expect(badPlace.ok).toBe(true);

    const badElint = await invoke<{
      gateStatus: string;
      blockerCount: number;
      diagnostics: Array<{ rule_id: string; severity: string }>;
    }>("jlc_elec_lint", { schDocument: schDoc, strictness: "production" }, context);
    expect(badElint.ok).toBe(true);
    expect(badElint.data!.gateStatus).toBe("BLOCKED_FOR_PCB");
    expect(badElint.data!.blockerCount).toBeGreaterThanOrEqual(3);

    const blockerRuleIds = new Set(
      badElint.data!.diagnostics.filter((d) => d.severity === "BLOCKER").map((d) => d.rule_id)
    );
    expect(blockerRuleIds.has("ELINT-019")).toBe(true);
    expect(blockerRuleIds.has("ELINT-010") || blockerRuleIds.has("ELINT-011")).toBe(true);
    expect(blockerRuleIds.has("ELINT-025")).toBe(true);

    // Attempt sync while ELINT is BLOCKED -> HARD REJECTED!
    const blockedSync = await invoke(
      "jlc_sch_sync_to_pcb",
      { schDocument: schDoc, pcbDocument: pcbDoc },
      context
    );
    expect(blockedSync.ok).toBe(false);
    expect(blockedSync.errorCode).toBe("ERR_ELINT_BLOCKED");

    // =========================================================================
    // 6. Self-Heal all ELINT errors -> 0 Blocker -> Netlist / SPICE / Sync PCB
    // =========================================================================
    await invoke(
      "jlc_sch_component_place",
      {
        document: schDoc,
        removeDesignators: ["U_LDO_BAD", "R_CC_BAD"],
        components: [],
      },
      context
    );
    cc1Pin.net = origCc1Net;
    cc2Pin.net = origCc2Net;
    isoGnd2Pins.forEach((p, i) => {
      p.net = origIsoGnd2[i] ?? "GND_ISO";
    });

    const netlistQuery = await invoke<{
      netlistSource: string;
      componentCount: number;
      netCount: number;
      arrayCursor?: string;
    }>("jlc_sch_netlist_query", { document: schDoc }, context);
    expect(netlistQuery.ok).toBe(true);
    expect(netlistQuery.data!.netlistSource).toBe("eda.sch_Netlist");
    expect(netlistQuery.data!.componentCount).toBeGreaterThan(25);

    const spiceRes = await invoke<{ solverUsed: string }>(
      "jlc_spice_run",
      {
        document: schDoc,
        spiceNetlist: "* RC filter\nV1 in 0 DC 5\nR1 in out 100\nC1 out 0 100n\n.end\n",
        analysisSuite: [
          { type: "OP", params: {} },
          { type: "TRAN", params: { step: "1u", stop: "2m" } },
        ],
      },
      context
    );
    expect(spiceRes.ok).toBe(true);

    const cleanElint = await invoke<{
      gateStatus: string;
      blockerCount: number;
      diagnostics: Array<{ rule_id: string; severity: string; mathematical_evidence: string }>;
    }>("jlc_elec_lint", { schDocument: schDoc, strictness: "production" }, context);
    expect(cleanElint.ok).toBe(true);
    expect(
      cleanElint.data!.diagnostics.filter((d) => d.severity === "BLOCKER"),
      "Expected 0 ELINT blockers after self-healing"
    ).toEqual([]);
    expect(cleanElint.data!.blockerCount).toBe(0);
    expect(cleanElint.data!.gateStatus).toBe("READY_FOR_PCB");

    const syncOk = await invoke<{ synced: boolean; pcbDocument: string }>(
      "jlc_sch_sync_to_pcb",
      { schDocument: schDoc, pcbDocument: pcbDoc },
      context
    );
    expect(syncOk.ok).toBe(true);
    expect(syncOk.data!.synced).toBe(true);

    // Exercise Layer 1 select / array / transaction tools
    await invoke("jlc_document_activate", { document: pcbDoc }, context);
    expect(
      (
        await invoke(
          "jlc_select",
          { document: pcbDoc, readOnly: true },
          context
        )
      ).ok
    ).toBe(true);
    if (netlistQuery.data!.arrayCursor) {
      const arrRes = await invoke<{ items: unknown[] }>(
        "jlc_array_read",
        { handle: netlistQuery.data!.arrayCursor, offset: 0, limit: 10 },
        context
      );
      expect(arrRes.ok).toBe(true);
      expect(arrRes.data!.items.length).toBeGreaterThan(0);
    }

    const txRes = await invoke<{ checkpointId: string }>(
      "jlc_transaction",
      { document: schDoc, action: "begin", label: "e2e_check" },
      context
    );
    expect(txRes.ok).toBe(true);
    expect(
      (
        await invoke(
          "jlc_transaction",
          { document: schDoc, action: "commit", checkpointId: txRes.data!.checkpointId },
          context
        )
      ).ok
    ).toBe(true);

    // =========================================================================
    // 7. Layer 5 Physical PCB Synthesis (4-Layer Board)
    // =========================================================================
    const boardSetup = await invoke(
      "jlc_pcb_board_setup",
      {
        document: pcbDoc,
        outlineMm: { shape: "RECTANGLE", widthMm: 120, heightMm: 80 },
        layerStackup: { layerCount: 4, copperWeightOuterOz: 1.0 },
        mountingHoles: [
          { id: "MH1", size: "M3", centerMm: [4, 4], drillMm: 3.2, keepoutDiaMm: 6.5 },
          { id: "MH2", size: "M3", centerMm: [116, 4], drillMm: 3.2, keepoutDiaMm: 6.5 },
          { id: "MH3", size: "M3", centerMm: [116, 76], drillMm: 3.2, keepoutDiaMm: 6.5 },
          { id: "MH4", size: "M3", centerMm: [4, 76], drillMm: 3.2, keepoutDiaMm: 6.5 },
        ],
        edaDesignRules: {
          netClasses: {
            PWR_RAIL: {
              name: "PWR_RAIL",
              nets: ["3V3", "3V3_SENS", "3V3_IO", "VDDA_mcu", "5V", "VBUS_5V", "VIN_24V", "VCC_ISO_3V3"],
              minWidthMm: 0.25,
              preferredWidthMm: 1.2,
              minClearanceMm: 0.25,
              viaDrillMm: 0.35,
              viaDiameterMm: 0.65,
              prioritySource: "project_drc",
            },
          },
        },
        ruleSyncMode: "write_computed_netclasses",
      },
      context
    );
    expect(boardSetup.ok).toBe(true);

    const clusterRes = await invoke<{
      functional_clusters: Array<{
        cluster_id: string;
        module_type: string;
        semantic_label: string;
        members: unknown[];
      }>;
    }>("jlc_pcb_cluster_netlist", { document: pcbDoc }, context);
    expect(clusterRes.ok).toBe(true);
    expect(clusterRes.data!.functional_clusters.length).toBeGreaterThanOrEqual(4);
    expect(
      clusterRes.data!.functional_clusters.some((c) => c.module_type === "DCDC_POWER_STAGE")
    ).toBe(true);

    const layoutRes = await invoke<{
      placedCount: number;
      overlapCount: number;
      overlapAreaMm2: number;
      datasheetLayoutAppliedClusters: string[];
    }>(
      "jlc_pcb_layout_apply",
      {
        document: pcbDoc,
        mode: "macro_floorplan_solve",
        applyDatasheetLayoutExample: true,
      },
      context
    );
    expect(layoutRes.ok).toBe(true);
    expect(layoutRes.data!.overlapCount).toBe(0);
    expect(layoutRes.data!.overlapAreaMm2).toBe(0);
    expect(layoutRes.data!.placedCount).toBeGreaterThan(25);

    const pcbState = ws.resolveDocument(pcbDoc)!.pcb!;

    // Upgrade J_AC_220V (TERM-2P-7.62) & RV_MOV (MOV-14D) physical HV pitch bboxes AFTER macro_floorplan_solve
    // so other clusters retain clean floorplan zones while HV terminals meet >= 3.0mm air / >= 6.4mm creepage.
    for (const clu of pcbState.clusterResult?.output.functional_clusters ?? []) {
      for (const m of clu.members) {
        if (m.designator === "J_AC_220V" || m.designator.startsWith("RV_MOV")) {
          m.bbox_mm = [12.5, 4.5];
        }
      }
    }
    for (const pl of pcbState.placements) {
      if (pl.designator === "J_AC_220V" || pl.designator.startsWith("RV_MOV")) {
        pl.bboxMm = [12.5, 4.5];
      }
    }

    // Refine precision decoupling, crystal, flyback diode, sensor corner & 220V HV relay bay via explicit_transform
    type TrItem = { designator: string; xMm: number; yMm: number; rotationDeg: number; side?: "TOP" | "BOTTOM"; locked?: boolean };
    const trMap = new Map<string, TrItem>(
      pcbState.placements.map((p) => [
        p.designator,
        { designator: p.designator, xMm: p.xMm, yMm: p.yMm, rotationDeg: p.rotationDeg, side: p.side, locked: true },
      ])
    );
    const plByDes = new Map(pcbState.placements.map((p) => [p.designator, p]));
    const rotDims = (bbox: [number, number], rot: number): [number, number] =>
      Math.abs(Math.round(rot) % 180) === 90 ? [bbox[1], bbox[0]] : [bbox[0], bbox[1]];
    const rotatePt = (lx: number, ly: number, deg: number): [number, number] => {
      const r = (deg * Math.PI) / 180;
      const c = Math.cos(r);
      const s = Math.sin(r);
      return [lx * c - ly * s, lx * s + ly * c];
    };
    const localPadOffset = (pl: (typeof pcbState.placements)[number], padNum: string): [number, number] | undefined => {
      const p = pl.pads.find((pp) => pp.padNumber === padNum);
      if (!p) return undefined;
      return rotatePt(p.xMm - pl.xMm, p.yMm - pl.yMm, -pl.rotationDeg);
    };
    const isSpotClear = (des: string, cx: number, cy: number, rot: number, ignoreDes = new Set<string>()): boolean => {
      const pl = plByDes.get(des);
      if (!pl) return false;
      const [w, h] = rotDims(pl.bboxMm, rot);
      if (cx - w / 2 < 2.2 || cx + w / 2 > 117.8 || cy - h / 2 < 2.2 || cy + h / 2 > 77.8) return false;
      for (const mh of pcbState.boardOutline.mountingHoles ?? []) {
        const dx = Math.max(0, Math.abs(cx - mh.centerMm[0]) - w / 2);
        const dy = Math.max(0, Math.abs(cy - mh.centerMm[1]) - h / 2);
        if (Math.hypot(dx, dy) < 3.6) return false;
      }
      for (const [oDes, oTr] of trMap.entries()) {
        if (oDes === des || ignoreDes.has(oDes)) continue;
        const oPl = plByDes.get(oDes);
        if (!oPl || (oTr.side ?? "TOP") !== (pl.side ?? "TOP")) continue;
        const [ow, oh] = rotDims(oPl.bboxMm, oTr.rotationDeg);
        if (Math.abs(cx - oTr.xMm) < (w + ow) / 2 + 0.12 && Math.abs(cy - oTr.yMm) < (h + oh) / 2 + 0.12) {
          return false;
        }
      }
      return true;
    };
    const findFreeNear = (des: string, tx: number, ty: number, rot: number): [number, number] => {
      for (let r = 0; r <= 24; r += 0.5) {
        const steps = r === 0 ? 1 : 16;
        for (let k = 0; k < steps; k++) {
          const a = (2 * Math.PI * k) / steps;
          const cx = Number((tx + r * Math.cos(a)).toFixed(2));
          const cy = Number((ty + r * Math.sin(a)).toFixed(2));
          if (isSpotClear(des, cx, cy, rot)) return [cx, cy];
        }
      }
      return [tx, ty];
    };

    const mcuInit = pcbState.placements.find((p) => p.designator.startsWith("U_MCU"));
    const xtalInit = pcbState.placements.find((p) => p.designator.startsWith("Y_XTAL"));
    const cLoad1Init = pcbState.placements.find((p) => p.designator.startsWith("C_LOAD_1"));
    const cLoad2Init = pcbState.placements.find((p) => p.designator.startsWith("C_LOAD_2"));
    const rExtInit = pcbState.placements.find((p) => p.designator.startsWith("R_EXT"));
    const shtInit = pcbState.placements.find((p) => p.designator === "U_SHT30");
    const cShtDecInit = pcbState.placements.find((p) => p.designator === "C_SHT30_DEC");
    const fbShtInit = pcbState.placements.find((p) => p.designator === "FB_SHT30");
    const rI2cSclInit = pcbState.placements.find((p) => p.designator === "R_I2C_SCL");
    const rI2cSdaInit = pcbState.placements.find((p) => p.designator === "R_I2C_SDA");
    const rShtAlertInit = pcbState.placements.find((p) => p.designator === "R_SHT_ALERT");
    const ioexpInit = pcbState.placements.find((p) => p.designator === "U_IOEXP");
    const cIoexpDecInit = pcbState.placements.find((p) => p.designator === "C_IOEXP_DEC");
    const xcvrInit = pcbState.placements.find((p) => p.designator.startsWith("U_XCVR"));
    const cDecRsInit = pcbState.placements.find((p) => p.designator.startsWith("C_DEC_rs485"));
    const relayInit = pcbState.placements.find((p) => p.designator.startsWith("K_RELAY"));
    const dFlyInit = pcbState.placements.find((p) => p.designator.startsWith("D_FLYBACK"));
    const qDrvInit = pcbState.placements.find((p) => p.designator.startsWith("Q_DRV"));
    const rGInit = pcbState.placements.find((p) => p.designator.startsWith("R_G"));
    const rGsInit = pcbState.placements.find((p) => p.designator.startsWith("R_GS"));
    const rvMovInit = pcbState.placements.find((p) => p.designator.startsWith("RV_MOV"));
    const jAcInit = pcbState.placements.find((p) => p.designator === "J_AC_220V");
    const lBuckInit = pcbState.placements.find((p) => p.designator.startsWith("L_PWR"));
    const cBootInit = pcbState.placements.find((p) => p.designator.startsWith("C_BOOT"));
    const rFb1Init = pcbState.placements.find((p) => p.designator.startsWith("R_FB1"));
    const rFb2Init = pcbState.placements.find((p) => p.designator.startsWith("R_FB2"));

    // A) Place U_SHT30 + sensor cluster satellites inside cool top-right ventilation zone [104..115, 58..72]
    //    and relocate relay HV components cleanly into bottom-right bay [82..116, 10..42]
    const shtTargetX = 109.5;
    const shtTargetY = 65.0;
    if (shtInit) {
      trMap.set(shtInit.designator, { designator: shtInit.designator, xMm: shtTargetX, yMm: shtTargetY, rotationDeg: 0, side: "TOP", locked: true });
    }
    const hvProtected = new Set(
      [
        relayInit?.designator,
        dFlyInit?.designator,
        qDrvInit?.designator,
        rGInit?.designator,
        rGsInit?.designator,
        rvMovInit?.designator,
        jAcInit?.designator,
        shtInit?.designator,
        cShtDecInit?.designator,
        fbShtInit?.designator,
        rI2cSclInit?.designator,
        rI2cSdaInit?.designator,
        rShtAlertInit?.designator,
      ].filter((x): x is string => Boolean(x))
    );

    // Reserve relay HV bay [81..117, 6..30]: put K_RELAY at [95.0, 18.0] rot=0 (5V at TOP-LEFT, COIL_SW at MID-LEFT,
    // AC_L_220V at BOT-LEFT, AC_LOAD_220V at TOP-RIGHT), RV_MOV & J_AC_220V aligned horizontally on the right.
    const bestRelayRot = 0;
    if (relayInit) {
      trMap.set(relayInit.designator, { designator: relayInit.designator, xMm: 95.0, yMm: 18.0, rotationDeg: bestRelayRot, side: "TOP", locked: true });
    }
    const relayTr = relayInit ? trMap.get(relayInit.designator)! : undefined;
    if (jAcInit && relayInit && relayTr) {
      const [rw] = rotDims(relayInit.bboxMm, bestRelayRot);
      // Pin 3 (AC_L_220V) is bottom (+y), pin 5 (AC_LOAD_220V) is top (-y) at rot=0
      const l3 = localPadOffset(relayInit, "3") ?? [-7.98, 6.2];
      const l5 = localPadOffset(relayInit, "5") ?? [7.98, -6.2];
      const p3 = rotatePt(l3[0], l3[1], bestRelayRot);
      const p5 = rotatePt(l5[0], l5[1], bestRelayRot);
      const acLSignY = Math.sign(p3[1] - p5[1]) || 1; // +1 = AC_L bottom, AC_LOAD top

      const jL1 = localPadOffset(jAcInit, "1") ?? [-4.375, 0];
      const jL2 = localPadOffset(jAcInit, "2") ?? [4.375, 0];
      const j90p1 = rotatePt(jL1[0], jL1[1], 90);
      const j90p2 = rotatePt(jL2[0], jL2[1], 90);
      // Match pin 1 (AC_L_220V) Y sign with acLSignY (+1 = bottom, -1 = top)
      const jRot = Math.sign(j90p1[1] - j90p2[1]) === acLSignY ? 90 : 270;
      const [jw] = rotDims(jAcInit.bboxMm, jRot);
      const jx = Number((117.2 - jw / 2).toFixed(2));
      trMap.set(jAcInit.designator, { designator: jAcInit.designator, xMm: jx, yMm: 18.0, rotationDeg: jRot, side: "TOP", locked: true });

      if (rvMovInit) {
        const mL1 = localPadOffset(rvMovInit, "1") ?? [-4.375, 0];
        const mL2 = localPadOffset(rvMovInit, "2") ?? [4.375, 0];
        const m90p1 = rotatePt(mL1[0], mL1[1], 90);
        const m90p2 = rotatePt(mL2[0], mL2[1], 90);
        const movRot = Math.sign(m90p1[1] - m90p2[1]) === acLSignY ? 90 : 270;
        const [movW] = rotDims(rvMovInit.bboxMm, movRot);
        const relayRight = relayTr.xMm + rw / 2;
        const jLeft = jx - jw / 2;
        const movX = Number(Math.min(jLeft - movW / 2 - 0.8, Math.max(relayRight + movW / 2 + 0.8, (relayRight + jLeft) / 2)).toFixed(2));
        trMap.set(rvMovInit.designator, {
          designator: rvMovInit.designator,
          xMm: movX,
          yMm: 18.0,
          rotationDeg: movRot,
          side: "TOP",
          locked: true,
        });
      }
    }
    if (dFlyInit && relayInit && relayTr) {
      const [rw] = rotDims(relayInit.bboxMm, bestRelayRot);
      const l1 = localPadOffset(relayInit, "1") ?? [-7.98, -6.2];
      const l2 = localPadOffset(relayInit, "2") ?? [-7.98, 0];
      const p1 = rotatePt(l1[0], l1[1], bestRelayRot);
      const p2 = rotatePt(l2[0], l2[1], bestRelayRot);
      const coil1 = [relayTr.xMm + p1[0], relayTr.yMm + p1[1]] as const;
      const coil2 = [relayTr.xMm + p2[0], relayTr.yMm + p2[1]] as const;
      const avgCoilY = (coil1[1] + coil2[1]) / 2;
      const avgCoilX = (coil1[0] + coil2[0]) / 2;
      trMap.set(dFlyInit.designator, {
        designator: dFlyInit.designator,
        xMm: Number((avgCoilX - 1.2).toFixed(2)),
        yMm: Number(avgCoilY.toFixed(2)),
        rotationDeg: 90,
        side: "BOTTOM",
        locked: true,
      });
      const lvBaseX = relayTr.xMm - rw / 2 - 4.8;
      if (qDrvInit) trMap.set(qDrvInit.designator, { designator: qDrvInit.designator, xMm: Number(lvBaseX.toFixed(2)), yMm: Number((avgCoilY + 1.5).toFixed(2)), rotationDeg: 0, side: "TOP", locked: true });
      if (rGInit) trMap.set(rGInit.designator, { designator: rGInit.designator, xMm: Number(lvBaseX.toFixed(2)), yMm: Number((avgCoilY + 4.8).toFixed(2)), rotationDeg: 0, side: "TOP", locked: true });
      if (rGsInit) trMap.set(rGsInit.designator, { designator: rGsInit.designator, xMm: Number((lvBaseX - 3.2).toFixed(2)), yMm: Number((avgCoilY + 4.8).toFixed(2)), rotationDeg: 90, side: "TOP", locked: true });
    }

    // Relocate ONLY non-protected, non-anchor satellites colliding with HV bay [80..118, 7..29] or sensor bay [103..118, 57..74]
    const anchorsSet = new Set(
      (pcbState.clusterResult?.output.functional_clusters ?? []).map((c) => c.anchor_designator)
    );
    for (const [des, tr] of trMap.entries()) {
      if (hvProtected.has(des) || anchorsSet.has(des)) continue;
      if ((tr.xMm >= 80 && tr.yMm <= 29) || (tr.xMm >= 103 && tr.yMm >= 57)) {
        const [nx, ny] = findFreeNear(des, 60.0, 56.0, tr.rotationDeg);
        trMap.set(des, { ...tr, xMm: nx, yMm: ny });
      }
    }

    // B) Snap crystal Y_XTAL_xtal & C_LOAD_1/2 tightly next to U_MCU_mcu pins 5/6 (OSC_IN/OSC_OUT)
    // Protect ALL DCDC_POWER_STAGE (_buck) parts from Step D/E nudging so datasheet Layout Example <=1.8mm/2.0mm distances stay intact.
    const protectedSet = new Set(hvProtected);
    for (const p of pcbState.placements) {
      if (p.designator.endsWith("_buck")) {
        protectedSet.add(p.designator);
      }
    }
    const pinWorld = (pl: (typeof pcbState.placements)[number], tr: TrItem, pinNum: string): [number, number] | undefined => {
      const lo = localPadOffset(pl, pinNum);
      if (!lo) return undefined;
      const r = rotatePt(lo[0], lo[1], tr.rotationDeg);
      return [tr.xMm + r[0], tr.yMm + r[1]];
    };
    const mcuTr = mcuInit ? trMap.get(mcuInit.designator)! : undefined;
    if (mcuInit && mcuTr && xtalInit) {
      protectedSet.add(mcuInit.designator);
      const p5 = pinWorld(mcuInit, mcuTr, "5");
      const p6 = pinWorld(mcuInit, mcuTr, "6");
      if (p5 && p6) {
        const oscCx = (p5[0] + p6[0]) / 2;
        const oscCy = (p5[1] + p6[1]) / 2;
        const outDx = oscCx - mcuTr.xMm;
        const outDy = oscCy - mcuTr.yMm;
        const [mw, mh] = rotDims(mcuInit.bboxMm, mcuTr.rotationDeg);
        const [xw, xh] = rotDims(xtalInit.bboxMm, 0);
        let xx = oscCx;
        let xy = oscCy;
        if (Math.abs(outDx) >= Math.abs(outDy)) {
          const sx = Math.sign(outDx) || 1;
          xx = Number((mcuTr.xMm + sx * (mw / 2 + xw / 2 + 2.4)).toFixed(2));
          xy = Number((oscCy + 0.6).toFixed(2));
        } else {
          const sy = Math.sign(outDy) || 1;
          xx = Number((oscCx + 0.6).toFixed(2));
          xy = Number((mcuTr.yMm + sy * (mh / 2 + xh / 2 + 2.4)).toFixed(2));
        }
        trMap.set(xtalInit.designator, { designator: xtalInit.designator, xMm: xx, yMm: xy, rotationDeg: 0, side: "TOP", locked: true });
        protectedSet.add(xtalInit.designator);
        if (cLoad1Init) {
          const [cw] = rotDims(cLoad1Init.bboxMm, 90);
          trMap.set(cLoad1Init.designator, { designator: cLoad1Init.designator, xMm: Number((xx - xw / 2 - cw / 2 - 0.45).toFixed(2)), yMm: xy, rotationDeg: 90, side: "TOP", locked: true });
          protectedSet.add(cLoad1Init.designator);
        }
        if (cLoad2Init) {
          const [cw] = rotDims(cLoad2Init.bboxMm, 90);
          trMap.set(cLoad2Init.designator, { designator: cLoad2Init.designator, xMm: Number((xx + xw / 2 + cw / 2 + 0.45).toFixed(2)), yMm: xy, rotationDeg: 90, side: "TOP", locked: true });
          protectedSet.add(cLoad2Init.designator);
        }
        if (rExtInit) {
          const [, rExtH] = rotDims(rExtInit.bboxMm, 0);
          trMap.set(rExtInit.designator, {
            designator: rExtInit.designator,
            xMm: xx,
            yMm: Number((xy + xh / 2 + rExtH / 2 + 0.45).toFixed(2)),
            rotationDeg: 0,
            side: "TOP",
            locked: true,
          });
          protectedSet.add(rExtInit.designator);
        }
      }
    }

    // C) Snap all 7 decoupling caps within <= 1.8mm of their paired IC VDD pin (outside IC courtyard!)
    const snapDecapToIcPin = (capPl: (typeof pcbState.placements)[number] | undefined, icPl: (typeof pcbState.placements)[number] | undefined, pinNum: string) => {
      if (!capPl || !icPl) return;
      const icTr = trMap.get(icPl.designator)!;
      const pw = pinWorld(icPl, icTr, pinNum);
      if (!pw) return;
      const [icW, icH] = rotDims(icPl.bboxMm, icTr.rotationDeg);
      const dx = pw[0] - icTr.xMm;
      const dy = pw[1] - icTr.yMm;
      const horiz = Math.abs(dx) >= Math.abs(dy);
      const rot = horiz ? 90 : 0;
      const [capW, capH] = rotDims(capPl.bboxMm, rot);
      let cx = horiz
        ? icTr.xMm + (Math.sign(dx) || 1) * (icW / 2 + capW / 2 + 0.35)
        : pw[0];
      let cy = horiz
        ? pw[1]
        : icTr.yMm + (Math.sign(dy) || 1) * (icH / 2 + capH / 2 + 0.35);
      // Tangent nudge if needed to avoid neighboring locked cap/crystal
      if (!isSpotClear(capPl.designator, cx, cy, rot)) {
        for (const delta of [0.8, -0.8, 1.4, -1.4]) {
          const tx = horiz ? cx : pw[0] + delta;
          const ty = horiz ? pw[1] + delta : cy;
          if (isSpotClear(capPl.designator, tx, ty, rot)) {
            cx = tx;
            cy = ty;
            break;
          }
        }
      }
      trMap.set(capPl.designator, {
        designator: capPl.designator,
        xMm: Number(cx.toFixed(2)),
        yMm: Number(cy.toFixed(2)),
        rotationDeg: rot,
        side: "TOP",
        locked: true,
      });
      protectedSet.add(capPl.designator);
    };

    const cDec1Init = pcbState.placements.find((p) => p.designator.startsWith("C_DEC_1"));
    const cDec2Init = pcbState.placements.find((p) => p.designator.startsWith("C_DEC_2"));
    const cDec3Init = pcbState.placements.find((p) => p.designator.startsWith("C_DEC_3"));
    const cDec4Init = pcbState.placements.find((p) => p.designator.startsWith("C_DEC_4"));
    const cVddaHfInit = pcbState.placements.find((p) => p.designator.startsWith("C_VDDA_HF"));
    const cVddaBulkInit = pcbState.placements.find((p) => p.designator.startsWith("C_VDDA_BULK"));
    const fbVddaInit = pcbState.placements.find((p) => p.designator.startsWith("FB_VDDA"));

    snapDecapToIcPin(cDec1Init, mcuInit, "1");
    snapDecapToIcPin(cVddaHfInit, mcuInit, "9");
    snapDecapToIcPin(cDec2Init, mcuInit, "24");
    snapDecapToIcPin(cDec3Init, mcuInit, "36");
    snapDecapToIcPin(cDec4Init, mcuInit, "48");
    snapDecapToIcPin(cShtDecInit, shtInit, "5");
    snapDecapToIcPin(cIoexpDecInit, ioexpInit, "3");
    snapDecapToIcPin(cDecRsInit, xcvrInit, "8");

    // Place C_VDDA_BULK and FB_VDDA strictly outboard of C_VDDA_HF so VDDA routes through C_VDDA_HF before U_MCU.9
    if (cVddaHfInit && mcuInit) {
      const mTr = trMap.get(mcuInit.designator)!;
      const vddaTr = trMap.get(cVddaHfInit.designator)!;
      const ox = vddaTr.xMm - mTr.xMm;
      const oy = vddaTr.yMm - mTr.yMm;
      const len = Math.hypot(ox, oy) || 1;
      const ux = ox / len;
      const uy = oy / len;
      if (cVddaBulkInit) {
        const [bx, by] = findFreeNear(cVddaBulkInit.designator, vddaTr.xMm + ux * 2.4, vddaTr.yMm + uy * 2.4, vddaTr.rotationDeg);
        trMap.set(cVddaBulkInit.designator, { designator: cVddaBulkInit.designator, xMm: bx, yMm: by, rotationDeg: vddaTr.rotationDeg, side: "TOP", locked: true });
        protectedSet.add(cVddaBulkInit.designator);
      }
      if (fbVddaInit) {
        const [fx, fy] = findFreeNear(fbVddaInit.designator, vddaTr.xMm + ux * 5.0, vddaTr.yMm + uy * 5.0, 0);
        trMap.set(fbVddaInit.designator, { designator: fbVddaInit.designator, xMm: fx, yMm: fy, rotationDeg: 0, side: "TOP", locked: true });
        protectedSet.add(fbVddaInit.designator);
      }
    }

    if (shtInit) {
      const shtTr = trMap.get(shtInit.designator)!;
      const sensorSats = [
        { pl: fbShtInit, dx: -3.8, dy: 3.5 },
        { pl: rI2cSclInit, dx: -3.8, dy: -2.2 },
        { pl: rI2cSdaInit, dx: -3.8, dy: 0.4 },
        { pl: rShtAlertInit, dx: 3.8, dy: -2.2 },
      ];
      for (const s of sensorSats) {
        if (!s.pl) continue;
        const [sx, sy] = findFreeNear(s.pl.designator, shtTr.xMm + s.dx, shtTr.yMm + s.dy, 0);
        trMap.set(s.pl.designator, { designator: s.pl.designator, xMm: sx, yMm: sy, rotationDeg: 0, side: "TOP", locked: true });
        protectedSet.add(s.pl.designator);
      }
    }

    // D) Keep Buck distances <= 4.0mm from U_BUCK pads and orient connectors so >= 3.5mm front zones are unobstructed (PLINT-15)
    const buckInit = pcbState.placements.find((p) => p.designator.startsWith("U_BUCK"));
    if (buckInit && lBuckInit) {
      const bTr = trMap.get(buckInit.designator)!;
      const lTr = trMap.get(lBuckInit.designator)!;
      const swPad = pinWorld(buckInit, bTr, "2") ?? [bTr.xMm + 1.4, bTr.yMm];
      const dx = lTr.xMm - swPad[0];
      const dy = lTr.yMm - swPad[1];
      const d = Math.hypot(dx, dy);
      if (d > 3.9) {
        for (const targetD of [3.8, 3.88, 3.94]) {
          const scale = targetD / d;
          const nx = Number((swPad[0] + dx * scale).toFixed(2));
          const ny = Number((swPad[1] + dy * scale).toFixed(2));
          if (isSpotClear(lBuckInit.designator, nx, ny, lTr.rotationDeg)) {
            trMap.set(lBuckInit.designator, { ...lTr, xMm: nx, yMm: ny });
            break;
          }
        }
      }
    }
    const rFbbInit = pcbState.placements.find((p) => p.designator.startsWith("R_FBB"));
    if (buckInit && rFbbInit) {
      const bTr = trMap.get(buckInit.designator)!;
      const fTr = trMap.get(rFbbInit.designator)!;
      const fbPad = pinWorld(buckInit, bTr, "4") ?? [bTr.xMm - 1.4, bTr.yMm];
      const d = Math.hypot(fTr.xMm - fbPad[0], fTr.yMm - fbPad[1]);
      if (d > 3.85) {
        const [fx, fy] = findFreeNear(rFbbInit.designator, fbPad[0] - 2.2, fbPad[1] + 1.8, fTr.rotationDeg);
        if (Math.hypot(fx - fbPad[0], fy - fbPad[1]) <= 3.95) {
          trMap.set(rFbbInit.designator, { ...fTr, xMm: fx, yMm: fy });
        }
      }
    }
    const isFrontZoneClear = (des: string, cx: number, cy: number, rot: number): boolean => {
      const pl = plByDes.get(des);
      if (!pl) return true;
      const [w, h] = rotDims(pl.bboxMm, rot);
      const x0 = cx - w / 2;
      const y0 = cy - h / 2;
      const x1 = cx + w / 2;
      const y1 = cy + h / 2;
      const rNorm = ((rot % 360) + 360) % 360;
      const opZone: [number, number, number, number] =
        rNorm === 0
          ? [x1, y0, x1 + 3.5, y1]
          : rNorm === 90
            ? [x0, y1, x1, y1 + 3.5]
            : rNorm === 180
              ? [x0 - 3.5, y0, x0, y1]
              : [x0, y0 - 3.5, x1, y0];
      for (const [oDes, oTr] of trMap.entries()) {
        if (oDes === des || (oTr.side ?? "TOP") !== (pl.side ?? "TOP")) continue;
        const oPl = plByDes.get(oDes);
        if (!oPl) continue;
        const [ow, oh] = rotDims(oPl.bboxMm, oTr.rotationDeg);
        if (
          opZone[0] < oTr.xMm + ow / 2 &&
          opZone[2] > oTr.xMm - ow / 2 &&
          opZone[1] < oTr.yMm + oh / 2 &&
          opZone[3] > oTr.yMm - oh / 2
        ) {
          return false;
        }
      }
      return true;
    };
    const clearBlockersInFrontZone = (des: string, cx: number, cy: number, rot: number): string[] => {
      const pl = plByDes.get(des);
      if (!pl) return [];
      const [w, h] = rotDims(pl.bboxMm, rot);
      const rNorm = ((rot % 360) + 360) % 360;
      const opZone: [number, number, number, number] =
        rNorm === 0
          ? [cx + w / 2, cy - h / 2, cx + w / 2 + 3.5, cy + h / 2]
          : rNorm === 90
            ? [cx - w / 2, cy + h / 2, cx + w / 2, cy + h / 2 + 3.5]
            : rNorm === 180
              ? [cx - w / 2 - 3.5, cy - h / 2, cx - w / 2, cy + h / 2]
              : [cx - w / 2, cy - h / 2 - 3.5, cx + w / 2, cy - h / 2];
      const blockers: string[] = [];
      for (const [oDes, oTr] of trMap.entries()) {
        if (oDes === des || (oTr.side ?? "TOP") !== (pl.side ?? "TOP")) continue;
        const oPl = plByDes.get(oDes);
        if (!oPl) continue;
        const [ow, oh] = rotDims(oPl.bboxMm, oTr.rotationDeg);
        if (
          opZone[0] < oTr.xMm + ow / 2 &&
          opZone[2] > oTr.xMm - ow / 2 &&
          opZone[1] < oTr.yMm + oh / 2 &&
          opZone[3] > oTr.yMm - oh / 2
        ) {
          blockers.push(oDes);
        }
      }
      return blockers;
    };
    for (const connDes of ["J_USB_usb", "J_RS485", "J_ISO_PWR", "J_SWD_mcu"]) {
      const cPl = pcbState.placements.find((p) => p.designator === connDes || p.designator.startsWith(connDes));
      if (!cPl) continue;
      const cTr = trMap.get(cPl.designator)!;
      // Only rotate in place (prefer outward board edge); never relocate connector anchors across board!
      const edgeOrder = Array.from(
        new Set([
          cTr.xMm < 20 ? 180 : cTr.xMm > 100 ? 0 : cTr.rotationDeg,
          cTr.yMm < 20 ? 270 : cTr.yMm > 60 ? 90 : cTr.rotationDeg,
          0,
          90,
          180,
          270,
        ])
      );
      let bestRot = edgeOrder[0];
      let bestBlockers = Infinity;
      for (const candRot of edgeOrder) {
        const blkCount = clearBlockersInFrontZone(cPl.designator, cTr.xMm, cTr.yMm, candRot).length;
        if (blkCount < bestBlockers) {
          bestBlockers = blkCount;
          bestRot = candRot;
          if (blkCount === 0) break;
        }
      }
      trMap.set(cPl.designator, { ...cTr, rotationDeg: bestRot });
      protectedSet.add(cPl.designator);
      if (bestBlockers > 0) {
        const blockers = clearBlockersInFrontZone(cPl.designator, cTr.xMm, cTr.yMm, bestRot);
        for (const bDes of blockers) {
          if (protectedSet.has(bDes) || anchorsSet.has(bDes)) continue;
          const bTr = trMap.get(bDes)!;
          for (let r = 2.0; r <= 7.0; r += 0.5) {
            let moved = false;
            for (const ang of [0, 90, 180, 270, 45, 135, 225, 315]) {
              const rad = (ang * Math.PI) / 180;
              const nx = Number((bTr.xMm + r * Math.cos(rad)).toFixed(2));
              const ny = Number((bTr.yMm + r * Math.sin(rad)).toFixed(2));
              if (isSpotClear(bDes, nx, ny, bTr.rotationDeg)) {
                trMap.set(bDes, { ...bTr, xMm: nx, yMm: ny });
                if (isFrontZoneClear(cPl.designator, cTr.xMm, cTr.yMm, bestRot)) {
                  moved = true;
                  break;
                }
                trMap.set(bDes, bTr);
              }
            }
            if (moved) break;
          }
        }
      }
    }

    // E) Resolve ONLY overlaps caused against components we actually moved (never touch undisturbed cluster anchors or _buck)
    for (const [des, tr] of trMap.entries()) {
      if (protectedSet.has(des) || anchorsSet.has(des)) continue;
      if (!isSpotClear(des, tr.xMm, tr.yMm, tr.rotationDeg)) {
        const [nx, ny] = findFreeNear(des, tr.xMm, tr.yMm, tr.rotationDeg);
        trMap.set(des, { ...tr, xMm: nx, yMm: ny });
      }
    }

    const refineRes = await invoke<{ overlapCount: number; overlapAreaMm2: number }>(
      "jlc_pcb_layout_apply",
      {
        document: pcbDoc,
        mode: "explicit_transform",
        applyDatasheetLayoutExample: true,
        transforms: Array.from(trMap.values()),
      },
      context
    );
    expect(refineRes.ok).toBe(true);
    expect(refineRes.data!.overlapCount).toBe(0);
    expect(refineRes.data!.overlapAreaMm2).toBe(0);

    const shtPl = pcbState.placements.find((p) => p.designator === "U_SHT30");
    const relayPl = pcbState.placements.find((p) => p.designator.startsWith("K_RELAY"));
    const shtX = shtPl?.xMm ?? 109.5;
    const shtY = shtPl?.yMm ?? 65;

    // Pre-route 5V coil feed out to the left of K_RELAY.1 all the way through safe corridor to all 5V pads,
    // and pre-route clean parallel HV AC_L / AC_LOAD rails (uncrossed).
    const relayCoil1Pad = relayPl?.pads.find((p) => p.padNumber === "1");
    const dFly5vPad = pcbState.placements.find((p) => p.designator.startsWith("D_FLYBACK"))?.pads.find((p) => p.net === "5V");
    const other5vPads = pcbState.placements
      .filter((pl) => !pl.designator.startsWith("K_RELAY") && !pl.designator.startsWith("D_FLYBACK"))
      .flatMap((pl) => pl.pads.filter((p) => p.net === "5V"));
    const jAcPl = pcbState.placements.find((p) => p.designator === "J_AC_220V");
    const rvMovPl = pcbState.placements.find((p) => p.designator.startsWith("RV_MOV"));
    if (relayCoil1Pad && other5vPads.length > 0) {
      const safeX = 72.0;
      const firstOther = other5vPads[0];
      pcbState.lockedTracks.push({
        id: "trk_5v_relay_safe_exit",
        net: "5V",
        layer: "InnerLayer2",
        widthMm: 1.0,
        pointsMm: [
          [relayCoil1Pad.xMm, relayCoil1Pad.yMm],
          [safeX, relayCoil1Pad.yMm],
          [safeX, firstOther.yMm],
          ...other5vPads.map((p) => [p.xMm, p.yMm] as [number, number]),
        ],
        primitiveLock: true,
        roleTag: "power_trunk",
      });
      pcbState.lockedVias.push({
        id: "VIA_5V_RELAY_COIL1",
        net: "5V",
        xMm: relayCoil1Pad.xMm,
        yMm: relayCoil1Pad.yMm,
        drillMm: 0.35,
        outerDiaMm: 0.65,
        startLayer: "TopLayer",
        endLayer: "BottomLayer",
        tentedSolderMask: true,
        primitiveLock: true,
        viaRole: "POWER_TRUNK_PARALLEL",
      });
      other5vPads.forEach((p, idx) => {
        pcbState.lockedVias.push({
          id: `VIA_5V_BUS_${idx}`,
          net: "5V",
          xMm: p.xMm,
          yMm: p.yMm,
          drillMm: 0.35,
          outerDiaMm: 0.65,
          startLayer: "TopLayer",
          endLayer: "BottomLayer",
          tentedSolderMask: true,
          primitiveLock: true,
          viaRole: "POWER_TRUNK_PARALLEL",
        });
      });
      if (dFly5vPad) {
        pcbState.lockedTracks.push({
          id: "trk_5v_dfly_coil1",
          net: "5V",
          layer: "BottomLayer",
          widthMm: 0.8,
          pointsMm: [
            [dFly5vPad.xMm, dFly5vPad.yMm],
            [relayCoil1Pad.xMm, relayCoil1Pad.yMm],
          ],
          primitiveLock: true,
          roleTag: "power_trunk",
        });
      }
    }
    const rAcL = relayPl?.pads.find((p) => p.padNumber === "3");
    const mAcL = rvMovPl?.pads.find((p) => p.net === "AC_L_220V");
    const jAcL = jAcPl?.pads.find((p) => p.net === "AC_L_220V");
    if (rAcL && mAcL && jAcL) {
      pcbState.lockedTracks.push({
        id: "trk_hv_ac_l_220v",
        net: "AC_L_220V",
        layer: "TopLayer",
        widthMm: 0.8,
        pointsMm: [
          [rAcL.xMm, rAcL.yMm],
          [mAcL.xMm, rAcL.yMm],
          [mAcL.xMm, mAcL.yMm],
          [jAcL.xMm, jAcL.yMm],
        ],
        primitiveLock: true,
        roleTag: "power_trunk",
      });
    }
    const rAcLoad = relayPl?.pads.find((p) => p.padNumber === "5");
    const mAcLoad = rvMovPl?.pads.find((p) => p.net === "AC_LOAD_220V");
    const jAcLoad = jAcPl?.pads.find((p) => p.net === "AC_LOAD_220V");
    if (rAcLoad && mAcLoad && jAcLoad) {
      pcbState.lockedTracks.push({
        id: "trk_hv_ac_load_220v",
        net: "AC_LOAD_220V",
        layer: "TopLayer",
        widthMm: 0.8,
        pointsMm: [
          [rAcLoad.xMm, rAcLoad.yMm],
          [mAcLoad.xMm, rAcLoad.yMm],
          [mAcLoad.xMm, mAcLoad.yMm],
          [jAcLoad.xMm, jAcLoad.yMm],
        ],
        primitiveLock: true,
        roleTag: "power_trunk",
      });
    }

    // Shield sensitive BUCK_FB_buck on BottomLayer beneath solid InnerLayer1 GND plane so it never parallels TopLayer BUCK_SW_buck
    const fbPads = pcbState.placements.flatMap((pl) => pl.pads.filter((p) => p.net === "BUCK_FB_buck"));
    if (fbPads.length >= 2) {
      pcbState.lockedTracks.push({
        id: "trk_buck_fb_shielded_bot",
        net: "BUCK_FB_buck",
        layer: "BottomLayer",
        widthMm: 0.25,
        pointsMm: fbPads.map((p) => [p.xMm, p.yMm] as [number, number]),
        primitiveLock: true,
        roleTag: "decap_loop",
      });
      fbPads.forEach((p, idx) => {
        pcbState.lockedVias.push({
          id: `VIA_BUCK_FB_${idx}`,
          net: "BUCK_FB_buck",
          xMm: p.xMm,
          yMm: p.yMm,
          drillMm: 0.3,
          outerDiaMm: 0.55,
          startLayer: "TopLayer",
          endLayer: "BottomLayer",
          tentedSolderMask: true,
          primitiveLock: true,
          viaRole: "BOOT_SIGNAL_VIA",
        });
      });
    }

    // Add thermal isolation slot adjacent to U_SHT30 and 2.0mm HV safety slots
    const acLPad = relayPl?.pads.find((p) => p.padNumber === "3");
    const coil2Pad = relayPl?.pads.find((p) => p.padNumber === "2");
    const coilHvGapY = acLPad && coil2Pad ? (acLPad.yMm + coil2Pad.yMm) / 2 : 21.1;
    await invoke(
      "jlc_pcb_board_setup",
      {
        document: pcbDoc,
        cutoutsMm: [
          {
            id: "SLOT_THERMAL_SHT30",
            rectMm: [Number((shtX - 6.0).toFixed(2)), Number((shtY - 6.0).toFixed(2)), Number((shtX - 4.5).toFixed(2)), Number((shtY + 6.0).toFixed(2))],
            widthMm: 1.5,
          },
          {
            id: "SLOT_AC_ISO_220V",
            rectMm: [82.0, Number((coilHvGapY - 1.0).toFixed(2)), 92.0, Number((coilHvGapY + 1.0).toFixed(2))],
            widthMm: 2.0,
          },
          {
            id: "SLOT_AC_POLE_220V",
            rectMm: [97.0, 17.0, 117.0, 19.0],
            widthMm: 2.0,
          },
        ],
      },
      context
    );

    const xtalPl = pcbState.placements.find((p) => p.designator.startsWith("Y_XTAL"));
    const indPl = pcbState.placements.find((p) => p.designator.startsWith("L_PWR"));
    const mcuPl = pcbState.placements.find((p) => p.designator.startsWith("U_MCU"));
    const buckPl = pcbState.placements.find((p) => p.designator.startsWith("U_BUCK"));
    const esdPl = pcbState.placements.find((p) => p.designator.startsWith("U_ESD"));
    const cDec1Pl = pcbState.placements.find((p) => p.designator.startsWith("C_DEC_1"));
    const cDec2Pl = pcbState.placements.find((p) => p.designator.startsWith("C_DEC_2"));
    const cDec3Pl = pcbState.placements.find((p) => p.designator.startsWith("C_DEC_3"));
    const cDec4Pl = pcbState.placements.find((p) => p.designator.startsWith("C_DEC_4"));
    const cVddaHfPl = pcbState.placements.find((p) => p.designator.startsWith("C_VDDA_HF"));
    const cShtDecPl = pcbState.placements.find((p) => p.designator === "C_SHT30_DEC");
    const ioexpPl = pcbState.placements.find((p) => p.designator === "U_IOEXP");
    const cIoexpDecPl = pcbState.placements.find((p) => p.designator === "C_IOEXP_DEC");
    const xcvrPl = pcbState.placements.find((p) => p.designator.startsWith("U_XCVR"));
    const cDecRsPl = pcbState.placements.find((p) => p.designator.startsWith("C_DEC_rs485"));
    const jUsbPl = pcbState.placements.find((p) => p.designator.startsWith("J_USB"));
    const cLoad1Pl = pcbState.placements.find((p) => p.designator.startsWith("C_LOAD_1"));
    const cLoad2Pl = pcbState.placements.find((p) => p.designator.startsWith("C_LOAD_2"));
    const rExtPl = pcbState.placements.find((p) => p.designator.startsWith("R_EXT"));

    const critRes = await invoke<{
      routedTasks: number;
      forbiddenThermalViaAuditPassed: boolean;
    }>(
      "jlc_pcb_route_critical",
      {
        document: pcbDoc,
        tasks: [
          {
            kind: "datasheet_layout_copper",
            nets: ["5V", "GND"],
            anchorDesignator: buckPl?.designator ?? "U_BUCK_buck",
          },
          {
            kind: "decap_loop",
            nets: ["3V3", "GND"],
            icVddPin: `${mcuPl?.designator ?? "U_MCU_mcu"}.1`,
            smallCapDesignator: cDec1Pl?.designator,
          },
          {
            kind: "decap_loop",
            nets: ["VDDA_mcu", "GND"],
            icVddPin: `${mcuPl?.designator ?? "U_MCU_mcu"}.9`,
            smallCapDesignator: cVddaHfPl?.designator,
          },
          {
            kind: "decap_loop",
            nets: ["3V3", "GND"],
            icVddPin: `${mcuPl?.designator ?? "U_MCU_mcu"}.24`,
            smallCapDesignator: cDec2Pl?.designator,
          },
          {
            kind: "decap_loop",
            nets: ["3V3", "GND"],
            icVddPin: `${mcuPl?.designator ?? "U_MCU_mcu"}.36`,
            smallCapDesignator: cDec3Pl?.designator,
          },
          {
            kind: "decap_loop",
            nets: ["3V3", "GND"],
            icVddPin: `${mcuPl?.designator ?? "U_MCU_mcu"}.48`,
            smallCapDesignator: cDec4Pl?.designator,
          },
          {
            kind: "decap_loop",
            nets: ["3V3_SENS", "GND"],
            icVddPin: `${shtPl?.designator ?? "U_SHT30"}.5`,
            smallCapDesignator: cShtDecPl?.designator,
          },
          {
            kind: "decap_loop",
            nets: ["3V3_IO", "GND"],
            icVddPin: `${ioexpPl?.designator ?? "U_IOEXP"}.3`,
            smallCapDesignator: cIoexpDecPl?.designator,
          },
          {
            kind: "decap_loop",
            nets: ["VCC_ISO_3V3", "GND_ISO"],
            icVddPin: `${xcvrPl?.designator ?? "U_XCVR_rs485"}.8`,
            smallCapDesignator: cDecRsPl?.designator,
          },
          {
            kind: "inline_esd",
            nets: ["USB_DP"],
            connectorDesignator: jUsbPl?.designator,
            esdDesignator: esdPl?.designator,
            targetIcDesignator: mcuPl?.designator,
          },
          {
            kind: "guard_ring_clock",
            nets: ["OSC_IN", "OSC_OUT"],
            anchorDesignator: mcuPl?.designator,
            crystalDesignator: xtalPl?.designator,
            loadCapDesignators: [cLoad1Pl?.designator, cLoad2Pl?.designator, rExtPl?.designator].filter(Boolean),
          },
          {
            kind: "kelvin_sense",
            nets: ["ISENSE_SHUNT_P", "GND"],
            shuntDesignator: "R_SHUNT1",
            senseTargetDesignator: mcuPl?.designator,
          },
          {
            kind: "diff_pair",
            nets: ["USB_DP", "USB_DM"],
            layer: "TopLayer",
            widthMm: 0.22,
            gapMm: 0.18,
          },
        ],
      },
      context
    );
    expect(critRes.ok).toBe(true);
    expect(critRes.data!.routedTasks).toBeGreaterThan(0);
    expect(critRes.data!.forbiddenThermalViaAuditPassed).toBe(true);

    // Connect decap VIA_PWRs cleanly onto InnerLayer2 power distribution so every VIA_PWR is a genuine 2-layer transition (PLINT-17),
    // and connect non-MCU 3V3 satellite pads to InnerLayer2 so autoroute never drops tee-stub vias on MCU VDD pins (PLINT-02).
    const viaByNet = new Map<string, Array<{ xMm: number; yMm: number }>>();
    for (const lv of pcbState.lockedVias) {
      if (lv.viaRole === "POWER_FEED_VIA") {
        const arr = viaByNet.get(lv.net) ?? [];
        arr.push({ xMm: lv.xMm, yMm: lv.yMm });
        viaByNet.set(lv.net, arr);
      }
    }
    const extra3v3Pts: Array<{ xMm: number; yMm: number }> = [];
    for (const pl of pcbState.placements) {
      if (pl.designator.startsWith("U_MCU") || pl.designator.startsWith("C_DEC_")) continue;
      for (const pad of pl.pads) {
        if (pad.net !== "3V3") continue;
        const drop: [number, number] = [Number(pad.xMm.toFixed(3)), Number(pad.yMm.toFixed(3))];
        extra3v3Pts.push({ xMm: drop[0], yMm: drop[1] });
        pcbState.lockedVias.push({
          id: `VIA_3V3_SRC_${pl.designator}_${pad.padNumber}`,
          net: "3V3",
          xMm: drop[0],
          yMm: drop[1],
          drillMm: 0.35,
          outerDiaMm: 0.65,
          startLayer: "TopLayer",
          endLayer: "BottomLayer",
          tentedSolderMask: true,
          primitiveLock: true,
          viaRole: "POWER_TRUNK_PARALLEL",
        });
      }
    }
    if (extra3v3Pts.length > 0) {
      const arr = viaByNet.get("3V3") ?? [];
      arr.push(...extra3v3Pts);
      viaByNet.set("3V3", arr);
    }
    for (const [net, pts] of viaByNet.entries()) {
      if (pts.length >= 2) {
        // Connect in Prim's MST order with wide 1.8mm InnerLayer2 trunk so IR drop stays well <= 3%
        const used = new Uint8Array(pts.length);
        used[0] = 1;
        for (let step = 1; step < pts.length; step++) {
          let bu = -1;
          let bv = -1;
          let bd = Infinity;
          for (let u = 0; u < pts.length; u++) {
            if (!used[u]) continue;
            for (let v = 0; v < pts.length; v++) {
              if (used[v]) continue;
              const dist = Math.hypot(pts[u].xMm - pts[v].xMm, pts[u].yMm - pts[v].yMm);
              if (dist < bd) {
                bd = dist;
                bu = u;
                bv = v;
              }
            }
          }
          if (bu >= 0 && bv >= 0) {
            used[bv] = 1;
            pcbState.lockedTracks.push({
              id: `trk_il2_bus_${net}_${step}`,
              net,
              layer: "InnerLayer2",
              widthMm: 1.8,
              pointsMm: [
                [pts[bu].xMm, pts[bu].yMm],
                [pts[bv].xMm, pts[bv].yMm],
              ],
              primitiveLock: true,
              roleTag: "power_trunk",
            });
          }
        }
      } else if (pts.length === 1) {
        // Connect single-load local filtered via to its ferrite bead / isolated terminal feed on InnerLayer2
        const feedComp =
          net === "3V3_SENS"
            ? pcbState.placements.find((p) => p.designator === "FB_SHT30")
            : net === "3V3_IO"
              ? pcbState.placements.find((p) => p.designator === "FB_IOEXP")
              : net === "VDDA_mcu"
                ? pcbState.placements.find((p) => p.designator.startsWith("FB_VDDA"))
                : pcbState.placements.find((p) => p.designator === "J_ISO_PWR");
        const feedPad = feedComp?.pads.find((p) => p.net === net);
        if (feedPad) {
          const dropPt: [number, number] = [Number((feedPad.xMm + 0.5).toFixed(3)), Number(feedPad.yMm.toFixed(3))];
          pcbState.lockedTracks.push(
            {
              id: `trk_top_feed_${net}`,
              net,
              layer: "TopLayer",
              widthMm: 0.45,
              pointsMm: [[feedPad.xMm, feedPad.yMm], dropPt],
              primitiveLock: true,
              roleTag: "power_trunk",
            },
            {
              id: `trk_il2_feed_${net}`,
              net,
              layer: "InnerLayer2",
              widthMm: 0.6,
              pointsMm: [dropPt, [pts[0].xMm, pts[0].yMm]],
              primitiveLock: true,
              roleTag: "power_trunk",
            }
          );
          pcbState.lockedVias.push({
            id: `VIA_IL2_${net}`,
            net,
            xMm: dropPt[0],
            yMm: dropPt[1],
            drillMm: 0.35,
            outerDiaMm: 0.65,
            startLayer: "TopLayer",
            endLayer: "BottomLayer",
            tentedSolderMask: true,
            primitiveLock: true,
            viaRole: "POWER_FEED_VIA",
          });
        }
      }
    }

    const viaRes = await invoke<{ viasPlaced: number }>(
      "jlc_pcb_via_place",
      {
        document: pcbDoc,
        mode: "epad_grid",
        net: "GND",
        centerMm: buckPl ? [buckPl.xMm, buckPl.yMm] : [20, 20],
        rows: 3,
        cols: 3,
        pitchMm: 0.9,
        drillMm: 0.3,
        outerDiameterMm: 0.55,
      },
      context
    );
    expect(viaRes.ok).toBe(true);
    expect(viaRes.data!.viasPlaced).toBe(9);

    const routeRes = await invoke<{
      remainingUnroutedRatlines: number;
      unroutedNets: string[];
    }>(
      "jlc_pcb_autoroute",
      {
        document: pcbDoc,
        engine: "internal_grid",
        excludeNets: ["GND", "AGND", "PGND", "GND_ISO"],
        gridStepMm: 0.35,
        maxPasses: 40,
      },
      context
    );
    expect(routeRes.ok).toBe(true);
    const dbgPads = pcbState.placements.flatMap((pl) =>
      pl.pads
        .filter((p) => routeRes.data!.unroutedNets.includes(p.net ?? ""))
        .map((p) => ({
          des: pl.designator,
          side: pl.side,
          x: pl.xMm,
          y: pl.yMm,
          pad: p.padNumber,
          net: p.net,
          px: p.xMm,
          py: p.yMm,
          sz: p.sizeMm,
        }))
    );
    expect(routeRes.data!.unroutedNets, JSON.stringify(dbgPads)).toEqual([]);
    expect(routeRes.data!.remainingUnroutedRatlines).toBe(0);

    // Upgrade every single 0.3mm power-rail via into a parallel 2-via cluster (>= 1.25A >= 0.60A per PLINT-13)
    const powerRails = new Set(["3V3", "3V3_SENS", "3V3_IO", "VDDA_mcu", "5V", "VBUS_5V", "VIN_24V", "VCC_ISO_3V3"]);
    const pwrViasList = [...pcbState.vias.filter((v) => powerRails.has(v.net))];
    const companionPool = [
      ...pwrViasList,
      ...pcbState.lockedVias.filter((v) => powerRails.has(v.net)),
    ];
    for (const pv of pwrViasList) {
      const hasCompanion = companionPool.some(
        (other) => other !== pv && other.net === pv.net && Math.hypot(other.xMm - pv.xMm, other.yMm - pv.yMm) <= 0.6
      );
      if (hasCompanion) continue;
      // Offset companion via slightly away from nearby ICs and away from other ~2.8mm neighbor vias so PLINT-13 never steals it
      let bestOffset: [number, number] = [0.55, 0];
      let bestScore = -Infinity;
      for (const [dx, dy] of [
        [0.55, 0],
        [-0.55, 0],
        [0, 0.55],
        [0, -0.55],
      ]) {
        const cx = pv.xMm + dx;
        const cy = pv.yMm + dy;
        if (cx < 2.5 || cx > 117.5 || cy < 2.5 || cy > 77.5) continue;
        let minIcD = Infinity;
        for (const pl of pcbState.placements) {
          for (const pad of pl.pads) {
            if (pad.net === pv.net && /^U_/.test(pl.designator)) {
              minIcD = Math.min(minIcD, Math.hypot(cx - pad.xMm, cy - pad.yMm));
            }
          }
        }
        let minNeighborViaD = Infinity;
        for (const nv of companionPool) {
          if (nv !== pv && nv.net === pv.net) {
            minNeighborViaD = Math.min(minNeighborViaD, Math.hypot(cx - nv.xMm, cy - nv.yMm));
          }
        }
        const score = Math.min(minIcD, 5) + Math.min(minNeighborViaD, 5);
        if (score > bestScore) {
          bestScore = score;
          bestOffset = [dx, dy];
        }
      }
      const companion: [number, number] = [
        Number((pv.xMm + bestOffset[0]).toFixed(3)),
        Number((pv.yMm + bestOffset[1]).toFixed(3)),
      ];
      await invoke(
        "jlc_pcb_via_place",
        {
          document: pcbDoc,
          mode: "single",
          net: pv.net,
          pointsMm: [companion],
          drillMm: 0.35,
          outerDiameterMm: 0.65,
        },
        context
      );
      companionPool.push({ ...pv, xMm: companion[0], yMm: companion[1] });
    }

    // Add deliberate 4-layer BottomLayer traces passing under top-layer crystal/inductor
    // to prove PLINT-10 / PLINT-11 layer intersection yields 0 false positives on 4-layer PCBs!
    if (xtalPl) {
      pcbState.lockedTracks.push({
        id: "trk_4L_bottom_under_xtal",
        net: "3V3",
        layer: "BottomLayer",
        widthMm: 0.25,
        pointsMm: [
          [xtalPl.xMm - 4, xtalPl.yMm],
          [xtalPl.xMm + 4, xtalPl.yMm],
        ],
        primitiveLock: true,
        roleTag: "decap_loop",
      });
    }
    if (indPl) {
      pcbState.lockedTracks.push({
        id: "trk_4L_bottom_under_ind",
        net: "3V3",
        layer: "BottomLayer",
        widthMm: 0.25,
        pointsMm: [
          [indPl.xMm - 4, indPl.yMm],
          [indPl.xMm + 4, indPl.yMm],
        ],
        primitiveLock: true,
        roleTag: "decap_loop",
      });
    }

    const pourRes = await invoke<{
      poursRebuilt: number;
      stitchingViasPlaced: number;
      smallPassiveThermalReliefCoverage: number;
    }>(
      "jlc_pcb_pour_and_stitch",
      {
        document: pcbDoc,
        pours: [
          { net: "GND", layer: "InnerLayer1", minIslandAreaMm2: 1.0, smallPassiveThermalRelief: true },
          { net: "GND", layer: "TopLayer", minIslandAreaMm2: 2.0, smallPassiveThermalRelief: true },
          { net: "GND", layer: "BottomLayer", minIslandAreaMm2: 2.0, smallPassiveThermalRelief: true },
        ],
        autoStitchGndVias: { enabled: true, gridPitchMm: 8.0, edgePitchMm: 8.0, drillMm: 0.3 },
      },
      context
    );
    expect(pourRes.ok).toBe(true);
    expect(pourRes.data!.poursRebuilt).toBeGreaterThanOrEqual(3);
    expect(pourRes.data!.stitchingViasPlaced).toBeGreaterThan(0);
    expect(pourRes.data!.smallPassiveThermalReliefCoverage).toBe(1);

    const silkRes = await invoke(
      "jlc_pcb_silkscreen_tidy",
      { document: pcbDoc, autoAvoidPadsClearanceMm: 0.15, enforcePolarityMarksOutsideBody: true },
      context
    );
    expect(silkRes.ok).toBe(true);

    // =========================================================================
    // 8. Layer 6 Verification: PCB DRC/PLINT + Dual-Image PNG + Master Gate
    // =========================================================================
    const pcbLint = await invoke<PcbLintReport>(
      "jlc_pcb_drc_and_lint",
      { pcbDocument: pcbDoc, checkScope: "full_board" },
      context
    );
    expect(pcbLint.ok).toBe(true);
    expect(pcbLint.data!.unroutedRatlineCount).toBe(0);
    expect(pcbLint.data!.nativeDrcErrors).toEqual([]);

    // Confirm 0 false positives on 4-layer bottom traces under crystal / inductor
    const bottomFalsePositives = pcbLint.data!.customGeoLintFindings.filter(
      (d) =>
        (d.ruleId === "PLINT-10" || d.ruleId === "PLINT-11") &&
        d.layer === "BottomLayer" &&
        d.severity === "BLOCKER"
    );
    expect(bottomFalsePositives).toEqual([]);
    expect(
      pcbLint.data!.customGeoLintFindings.filter((d) => d.severity === "BLOCKER"),
      "Expected 0 PLINT blockers on golden board"
    ).toEqual([]);
    expect(pcbLint.data!.pass).toBe(true);

    // Side-by-side vision capture comparing Buck area against TPS54302 C96581 datasheet layout
    const viewResp = await invokeRawResponse(
      "jlc_view_capture",
      {
        document: pcbDoc,
        mode: "2d_canvas",
        viewport: "fit_board",
        compareWithDatasheetLcsc: "C96581",
        width: 1000,
        height: 750,
      },
      context
    );
    expect(viewResp.isError).not.toBe(true);
    const imgItem = viewResp.content.find((c) => c.type === "image");
    expect(imgItem).toBeDefined();
    expect(imgItem!.mimeType).toBe("image/png");
    const pngBytes = Buffer.from(imgItem!.data ?? "", "base64");
    expect(pngBytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    // Master Gate: jlc_validate
    const masterRes = await invoke<MasterValidationReport>(
      "jlc_validate",
      { schDocument: schDoc, pcbDocument: pcbDoc, verifyManufacturability: true },
      context
    );
    expect(masterRes.ok).toBe(true);
    expect(masterRes.data!.blockers).toEqual([]);
    expect(masterRes.data!.pass).toBe(true);
    expect(masterRes.data!.electricalAuditPass).toBe(true);
    expect(masterRes.data!.pcbDrcPass).toBe(true);
    expect(masterRes.data!.netlistInSync).toBe(true);
    expect(masterRes.data!.unroutedNets).toBe(0);
    expect(masterRes.data!.dfmSmtReady).toBe(true);

    // =========================================================================
    // 9. Delivery: Gerber, BOM (100% LCSC C-codes), CPL + Release Lock
    // =========================================================================
    const gerberDir = path.join(tempOutDir, "gerber");
    const bomPath = path.join(tempOutDir, "BOM_IoT_Controller.csv");
    const cplPath = path.join(tempOutDir, "CPL_IoT_Controller.csv");

    const gerberRes = await invoke<{ saved: boolean; summary: { fileCount: number; files: string[] } }>(
      "jlc_document_save",
      { document: pcbDoc, format: "gerber", path: gerberDir, overwrite: true },
      context
    );
    expect(gerberRes.ok).toBe(true);
    expect(gerberRes.data!.saved).toBe(true);
    expect(fs.existsSync(path.join(gerberDir, "Gerber_BoardOutline.GKO"))).toBe(true);
    expect(fs.existsSync(path.join(gerberDir, "Gerber_InnerLayer1.G1"))).toBe(true);

    const bomRes = await invoke(
      "jlc_document_save",
      { document: pcbDoc, format: "bom", path: bomPath, overwrite: true },
      context
    );
    expect(bomRes.ok).toBe(true);
    const bomText = fs.readFileSync(bomPath, "utf8");
    const bomLines = bomText.trim().split(/\r?\n/);
    expect(bomLines.length).toBeGreaterThan(5);
    for (const line of bomLines.slice(1)) {
      expect(line).toMatch(/"C\d+"/);
    }

    const cplRes = await invoke(
      "jlc_document_save",
      { document: pcbDoc, format: "cpl", path: cplPath, overwrite: true },
      context
    );
    expect(cplRes.ok).toBe(true);
    const cplText = fs.readFileSync(cplPath, "utf8");
    expect(cplText).toContain("Designator,Mid X,Mid Y,Layer,Rotation");
    expect(cplText).toContain("U_SHT30");

    const closeRes = await invoke<{ closed: boolean; lockReleased: boolean }>(
      "jlc_document_close",
      { document: pcbDoc, releaseProcess: true },
      context
    );
    expect(closeRes.ok).toBe(true);
    expect(closeRes.data!.closed).toBe(true);
    expect(closeRes.data!.lockReleased).toBe(true);
  }, 30000);
});
