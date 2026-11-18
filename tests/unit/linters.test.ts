import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import type {
  CesmCategory,
  CesmModel,
  CesmPin,
  CompiledComponent,
  CompiledNetlist,
  CompiledPin,
  ProjectDesignRules,
} from "../../src/types/index.js";
import {
  AuthoritativeNetlistError,
  buildElectricalHypergraph,
  type PcbBoardGeometrySnapshot,
  type PcbComponentGeom,
  type PcbTrackGeom,
  runElectricalLinter,
  runGeometryPcbLinter,
  runMasterValidation,
} from "../../src/linters/index.js";

// ============================================================================
// Test Fixture Builders
// ============================================================================

function makeCesm(
  lcsc_id: string,
  mpn: string,
  category: CesmCategory,
  pkg: string,
  pins: CesmPin[],
  ratings: CesmModel["ratings"] = {},
  extra: Partial<CesmModel> = {}
): CesmModel {
  return {
    lcsc_id,
    mpn,
    category,
    package: pkg,
    verified: true,
    pins,
    ratings,
    ...extra,
  };
}

function makeComp(
  designator: string,
  lcscId: string | null,
  mpn: string,
  footprint: string,
  pins: Array<{ n: string; name?: string; type?: string; net: string | null }>,
  options: { value?: string; extraProps?: Record<string, unknown>; posMm?: [number, number] } = {}
): CompiledComponent {
  const compiledPins: CompiledPin[] = pins.map((p) => ({
    pinNumber: p.n,
    pinName: p.name ?? p.n,
    elecType: p.type ?? "PASSIVE",
    net: p.net,
    isConnected: Boolean(p.net),
  }));
  return {
    primitiveId: `prim_${designator}`,
    designator,
    lcscId,
    mpn,
    value: options.value ?? mpn,
    footprint,
    posMm: options.posMm ?? [0, 0],
    pins: compiledPins,
    extraProps: options.extraProps,
  };
}

function buildNetlist(
  components: CompiledComponent[],
  source: "eda.sch_Netlist" | "eda.pcb_Netlist" = "eda.sch_Netlist",
  documentName = "SCH_TEST"
): CompiledNetlist {
  const netMap = new Map<
    string,
    Array<{ designator: string; pinNumber: string; pinName?: string; elecType?: string }>
  >();
  const unconnectedPins: CompiledNetlist["unconnectedPins"] = [];

  for (const c of components) {
    for (const p of c.pins) {
      if (p.isConnected && p.net) {
        const list = netMap.get(p.net) ?? [];
        list.push({
          designator: c.designator,
          pinNumber: p.pinNumber,
          pinName: p.pinName,
          elecType: p.elecType,
        });
        netMap.set(p.net, list);
      } else {
        unconnectedPins.push({
          designator: c.designator,
          pinNumber: p.pinNumber,
          pinName: p.pinName,
        });
      }
    }
  }

  return {
    netlistSource: source,
    documentName,
    componentCount: components.length,
    netCount: netMap.size,
    components,
    nets: Array.from(netMap.entries()).map(([netName, endpoints]) => ({
      netName,
      endpoints,
      fanout: endpoints.length,
    })),
    unconnectedPins,
  };
}

function twoPinCesm(
  lcsc: string,
  mpn: string,
  cat: CesmCategory,
  pkg: string,
  ratings: CesmModel["ratings"] = {},
  extra: Partial<CesmModel> = {}
): CesmModel {
  return makeCesm(
    lcsc,
    mpn,
    cat,
    pkg,
    [
      { pin_number: "1", pin_name: "1", elec_type: "PASSIVE" },
      { pin_number: "2", pin_name: "2", elec_type: "PASSIVE" },
    ],
    ratings,
    extra
  );
}

function makeRes(
  des: string,
  lcsc: string,
  ohmsStr: string,
  pkg: string,
  net1: string,
  net2: string,
  cesmMap: Record<string, CesmModel>,
  extraProps?: Record<string, unknown>
): CompiledComponent {
  if (!cesmMap[lcsc]) {
    cesmMap[lcsc] = twoPinCesm(lcsc, ohmsStr, "RES_CHIP", pkg);
  }
  return makeComp(
    des,
    lcsc,
    ohmsStr,
    pkg,
    [
      { n: "1", name: "1", type: "PASSIVE", net: net1 },
      { n: "2", name: "2", type: "PASSIVE", net: net2 },
    ],
    { value: ohmsStr, extraProps }
  );
}

function makeCap(
  des: string,
  lcsc: string,
  valStr: string,
  pkg: string,
  net1: string,
  net2: string,
  cesmMap: Record<string, CesmModel>,
  cat: CesmCategory = "CAP_MLCC",
  ratings: CesmModel["ratings"] = { v_working_max: 25, dielectric: "X7R" },
  extra: Partial<CesmModel> = {},
  extraProps?: Record<string, unknown>
): CompiledComponent {
  if (!cesmMap[lcsc]) {
    cesmMap[lcsc] = twoPinCesm(lcsc, valStr, cat, pkg, ratings, extra);
  }
  return makeComp(
    des,
    lcsc,
    valStr,
    pkg,
    [
      { n: "1", name: "1", type: "PASSIVE", net: net1 },
      { n: "2", name: "2", type: "PASSIVE", net: net2 },
    ],
    { value: valStr, extraProps }
  );
}

function makePcbCompFromSch(
  comp: CompiledComponent,
  centerMm: [number, number],
  layer = "TopLayer",
  sizeMm: [number, number] = [2.0, 1.2],
  rotationDeg = 0,
  extra: Partial<PcbComponentGeom> = {}
): PcbComponentGeom {
  const hw = sizeMm[0] / 2;
  const hh = sizeMm[1] / 2;
  const pads = comp.pins.map((pin, idx) => {
    const offset = comp.pins.length === 2 ? (idx === 0 ? -hw * 0.6 : hw * 0.6) : (idx - (comp.pins.length - 1) / 2) * 0.8;
    const rad = (rotationDeg * Math.PI) / 180;
    const px = centerMm[0] + offset * Math.cos(rad);
    const py = centerMm[1] + offset * Math.sin(rad);
    return {
      primitiveId: `pad_${comp.designator}_${pin.pinNumber}`,
      designator: comp.designator,
      padNumber: pin.pinNumber,
      pinName: pin.pinName,
      elecType: pin.elecType,
      net: pin.net,
      layer,
      centerMm: [px, py] as [number, number],
      sizeMm: [0.6, 0.6] as [number, number],
      copperConnection: "THERMAL_RELIEF" as const,
    };
  });

  return {
    primitiveId: comp.primitiveId,
    designator: comp.designator,
    lcscId: comp.lcscId,
    mpn: comp.mpn,
    value: comp.value,
    package: comp.footprint ?? "0603",
    layer,
    centerMm,
    rotationDeg,
    bboxMm: [centerMm[0] - hw, centerMm[1] - hh, centerMm[0] + hw, centerMm[1] + hh],
    pads,
    extraProps: comp.extraProps,
    ...extra,
  };
}

function makeRectPour(
  id: string,
  net: string,
  layer: string,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  splitSlots?: Array<{ x1: number; y1: number; x2: number; y2: number }>
) {
  return {
    primitiveId: id,
    net,
    layer,
    polygon2D: [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ] as Array<[number, number]>,
    areaMm2: (maxX - minX) * (maxY - minY),
    isSolid: true,
    splitSlots,
  };
}

function makeGuardRingTracks(
  prefix: string,
  layer: string,
  bbox: [number, number, number, number],
  widthMm = 0.3
): PcbTrackGeom[] {
  const m = 0.8;
  const x1 = bbox[0] - m;
  const y1 = bbox[1] - m;
  const x2 = bbox[2] + m;
  const y2 = bbox[3] + m;
  return [
    { primitiveId: `${prefix}_B`, net: "GND", layer, startMm: [x1, y1], endMm: [x2, y1], widthMm },
    { primitiveId: `${prefix}_R`, net: "GND", layer, startMm: [x2, y1], endMm: [x2, y2], widthMm },
    { primitiveId: `${prefix}_T`, net: "GND", layer, startMm: [x2, y2], endMm: [x1, y2], widthMm },
    { primitiveId: `${prefix}_L`, net: "GND", layer, startMm: [x1, y2], endMm: [x1, y1], widthMm },
  ];
}

// ============================================================================
// 1. Hypergraph Propagator & Crossover Immunity Tests
// ============================================================================

describe("Hypergraph Propagator & Authoritative Netlist Iron Law", () => {
  it("rejects non-authoritative netlists derived from sch_PrimitiveWire geometry", () => {
    const badNetlist = {
      netlistSource: "sch_PrimitiveWire",
      componentCount: 0,
      netCount: 0,
      components: [],
      nets: [],
      unconnectedPins: [],
    } as unknown as CompiledNetlist;

    expect(() => buildElectricalHypergraph(badNetlist)).toThrow(AuthoritativeNetlistError);
    expect(() => runElectricalLinter(badNetlist)).toThrow(AuthoritativeNetlistError);

    const injectedWireNetlist = {
      ...buildNetlist([]),
      wireSegments: [{ x1: 0, y1: 0, x2: 10, y2: 0 }],
    } as unknown as CompiledNetlist;
    expect(() => buildElectricalHypergraph(injectedWireNetlist)).toThrow(AuthoritativeNetlistError);
  });

  it("Scenario 1: Complex netlist with many crossing wires (without Junctions) yields 0 false shorts, accurate voltage propagation & isolation coloring, and validates ConstraintHandoffPackage JSON Schema", () => {
    const cesm: Record<string, CesmModel> = {
      C1001: makeCesm("C1001", "USB-C-16P", "CONN_USB_TYPEC", "USB-C", [
        { pin_number: "A4", pin_name: "VBUS", elec_type: "POWER_OUT" },
        { pin_number: "A1", pin_name: "GND", elec_type: "GND" },
        { pin_number: "A5", pin_name: "CC1", elec_type: "PASSIVE" },
        { pin_number: "B5", pin_name: "CC2", elec_type: "PASSIVE" },
        { pin_number: "A6", pin_name: "DP1", elec_type: "BIDIR_IO" },
        { pin_number: "B6", pin_name: "DP2", elec_type: "BIDIR_IO" },
        { pin_number: "A7", pin_name: "DN1", elec_type: "BIDIR_IO" },
        { pin_number: "B7", pin_name: "DN2", elec_type: "BIDIR_IO" },
      ]),
      C1002: twoPinCesm("C1002", "FUSE_2A", "RES_SHUNT", "1206", { v_working_max: 32 }),
      C1003: twoPinCesm("C1003", "FB600", "FERRITE_CMC", "0603", { i_rms_a: 1.5 }),
      C1004: makeCesm(
        "C1004",
        "RT9013-33",
        "PMIC_LDO",
        "SOT-23-5",
        [
          { pin_number: "1", pin_name: "VIN", elec_type: "POWER_IN", v_abs_max: 6.0 },
          { pin_number: "2", pin_name: "GND", elec_type: "GND" },
          { pin_number: "3", pin_name: "EN", elec_type: "INPUT_HIZ", v_abs_max: 6.0 },
          { pin_number: "5", pin_name: "VOUT", elec_type: "POWER_OUT" },
        ],
        { v_working_max: 5.5, r_theta_ja_c_per_w: 200, mlcc_output_stable: true }
      ),
      C1005: makeCesm(
        "C1005",
        "STM32F103C8T6",
        "MCU_SOC",
        "LQFP-48",
        [
          { pin_number: "1", pin_name: "VDD", elec_type: "POWER_IN" },
          { pin_number: "2", pin_name: "VDDA", elec_type: "POWER_IN" },
          { pin_number: "3", pin_name: "VSS", elec_type: "GND" },
          { pin_number: "4", pin_name: "NRST", elec_type: "INPUT_HIZ", supply_pin_ref: "VDD" },
          { pin_number: "5", pin_name: "BOOT0", elec_type: "INPUT_HIZ", supply_pin_ref: "VDD" },
          { pin_number: "6", pin_name: "PA9_TX", elec_type: "PUSH_PULL", supply_pin_ref: "VDD" },
          { pin_number: "7", pin_name: "PA10_RX", elec_type: "INPUT_HIZ", supply_pin_ref: "VDD" },
          { pin_number: "8", pin_name: "PA11_DM", elec_type: "BIDIR_IO", supply_pin_ref: "VDD" },
          { pin_number: "9", pin_name: "PA12_DP", elec_type: "BIDIR_IO", supply_pin_ref: "VDD" },
          { pin_number: "10", pin_name: "PB6_SCL", elec_type: "OPEN_DRAIN", supply_pin_ref: "VDD", five_volt_tolerant: true },
          { pin_number: "11", pin_name: "PB7_SDA", elec_type: "OPEN_DRAIN", supply_pin_ref: "VDD", five_volt_tolerant: true },
          { pin_number: "12", pin_name: "OSC_IN", elec_type: "ANALOG_IN", supply_pin_ref: "VDD" },
          { pin_number: "13", pin_name: "OSC_OUT", elec_type: "ANALOG_OUT", supply_pin_ref: "VDD" },
        ],
        {}
      ),
      C1006: makeCesm(
        "C1006",
        "CH340N_PEER",
        "INTERFACE_XCVR",
        "SOP-8",
        [
          { pin_number: "1", pin_name: "VDD", elec_type: "POWER_IN" },
          { pin_number: "2", pin_name: "GND", elec_type: "GND" },
          { pin_number: "3", pin_name: "TXD", elec_type: "PUSH_PULL", supply_pin_ref: "VDD" },
          { pin_number: "4", pin_name: "RXD", elec_type: "INPUT_HIZ", supply_pin_ref: "VDD" },
        ],
        {}
      ),
      C1007: makeCesm(
        "C1007",
        "ISO7721F",
        "ISOLATOR_OPTO",
        "SOIC-8",
        [
          { pin_number: "1", pin_name: "VCC1", elec_type: "POWER_IN" },
          { pin_number: "2", pin_name: "INA", elec_type: "INPUT_HIZ", supply_pin_ref: "VCC1" },
          { pin_number: "3", pin_name: "OUTB", elec_type: "PUSH_PULL", supply_pin_ref: "VCC1" },
          { pin_number: "4", pin_name: "GND1", elec_type: "GND" },
          { pin_number: "5", pin_name: "GND2", elec_type: "GND" },
          { pin_number: "6", pin_name: "INB", elec_type: "INPUT_HIZ", supply_pin_ref: "VCC2" },
          { pin_number: "7", pin_name: "OUTA", elec_type: "PUSH_PULL", supply_pin_ref: "VCC2" },
          { pin_number: "8", pin_name: "VCC2", elec_type: "POWER_IN" },
        ],
        { isolation_vrms: 3000, default_output_state: "LOW" }
      ),
      C1008: twoPinCesm("C1008", "CY_1NF_2KV", "CAP_MLCC", "1206", { v_working_max: 2000, dielectric: "C0G_NP0" }),
    };

    // Build a realistic schematic netlist where dozens of wires cross orthogonally without junctions
    // (e.g. VBUS crosses GND, UART_TX crosses I2C_SCL, 24V_ISO crosses 3V3, etc. -> distinct net names!)
    const comps: CompiledComponent[] = [
      makeComp("USB1", "C1001", "USB-C-16P", "USB-C", [
        { n: "A4", name: "VBUS", type: "POWER_OUT", net: "VBUS" },
        { n: "A1", name: "GND", type: "GND", net: "GND" },
        { n: "A5", name: "CC1", type: "PASSIVE", net: "USB_CC1" },
        { n: "B5", name: "CC2", type: "PASSIVE", net: "USB_CC2" },
        { n: "A6", name: "DP1", type: "BIDIR_IO", net: "USB_DP" },
        { n: "B6", name: "DP2", type: "BIDIR_IO", net: "USB_DP" },
        { n: "A7", name: "DN1", type: "BIDIR_IO", net: "USB_DM" },
        { n: "B7", name: "DN2", type: "BIDIR_IO", net: "USB_DM" },
      ]),
      makeRes("R_CC1", "C25905", "5.1k", "0402", "USB_CC1", "GND", cesm),
      makeRes("R_CC2", "C25905", "5.1k", "0402", "USB_CC2", "GND", cesm),
      // Fuse F1 creates anonymous intermediate net N_ANON_VBUS_PROT
      makeComp("F1", "C1002", "FUSE_2A", "1206", [
        { n: "1", name: "1", type: "PASSIVE", net: "VBUS" },
        { n: "2", name: "2", type: "PASSIVE", net: "N_ANON_VBUS_PROT" },
      ], { extraProps: { resistance_ohm: 0.05 } }),
      makeComp("U2", "C1004", "RT9013-33", "SOT-23-5", [
        { n: "1", name: "VIN", type: "POWER_IN", net: "N_ANON_VBUS_PROT" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "EN", type: "INPUT_HIZ", net: "N_ANON_VBUS_PROT" },
        { n: "5", name: "VOUT", type: "POWER_OUT", net: "3V3" },
      ], { extraProps: { i_load_a: 0.1 } }),
      // Ferrite bead FB1 creates anonymous analog supply N_ANON_VDDA
      makeComp("FB1", "C1003", "FB600", "0603", [
        { n: "1", name: "1", type: "PASSIVE", net: "3V3" },
        { n: "2", name: "2", type: "PASSIVE", net: "N_ANON_VDDA" },
      ], { extraProps: { i_dc_a: 0.05 } }),
      makeComp("U1", "C1005", "STM32F103C8T6", "LQFP-48", [
        { n: "1", name: "VDD", type: "POWER_IN", net: "3V3" },
        { n: "2", name: "VDDA", type: "POWER_IN", net: "N_ANON_VDDA" },
        { n: "3", name: "VSS", type: "GND", net: "GND" },
        { n: "4", name: "NRST", type: "INPUT_HIZ", net: "MCU_NRST" },
        { n: "5", name: "BOOT0", type: "INPUT_HIZ", net: "MCU_BOOT0" },
        { n: "6", name: "PA9_TX", type: "PUSH_PULL", net: "UART_MCU_TO_USB" },
        { n: "7", name: "PA10_RX", type: "INPUT_HIZ", net: "UART_USB_TO_MCU" },
        { n: "8", name: "PA11_DM", type: "BIDIR_IO", net: "USB_DM" },
        { n: "9", name: "PA12_DP", type: "BIDIR_IO", net: "USB_DP" },
        { n: "10", name: "PB6_SCL", type: "OPEN_DRAIN", net: "I2C_SCL" },
        { n: "11", name: "PB7_SDA", type: "OPEN_DRAIN", net: "I2C_SDA" },
        { n: "12", name: "OSC_IN", type: "ANALOG_IN", net: "OSC_IN" },
        { n: "13", name: "OSC_OUT", type: "ANALOG_OUT", net: "OSC_OUT" },
      ]),
      makeComp("U3", "C1006", "CH340N_PEER", "SOP-8", [
        { n: "1", name: "VDD", type: "POWER_IN", net: "3V3" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "TXD", type: "PUSH_PULL", net: "UART_USB_TO_MCU" },
        { n: "4", name: "RXD", type: "INPUT_HIZ", net: "UART_MCU_TO_USB" },
      ]),
      // Decoupling caps (3 VDD/VDDA pins -> 3x 100nF MLCC + 1uF bulk)
      makeCap("C1", "C1525", "100nF 16V", "0402", "3V3", "GND", cesm),
      makeCap("C2", "C1525", "100nF 16V", "0402", "N_ANON_VDDA", "GND", cesm),
      makeCap("C3", "C1525", "100nF 16V", "0402", "3V3", "GND", cesm),
      // Reset & Boot pull resistors
      makeRes("R_RST", "C1009", "10k", "0402", "MCU_NRST", "3V3", cesm),
      makeCap("C_RST", "C1525", "100nF 16V", "0402", "MCU_NRST", "GND", cesm),
      makeRes("R_BOOT", "C1009", "10k", "0402", "MCU_BOOT0", "GND", cesm),
      // I2C pull-ups
      makeRes("R_SCL", "C1010", "4.7k", "0402", "I2C_SCL", "3V3", cesm),
      makeRes("R_SDA", "C1010", "4.7k", "0402", "I2C_SDA", "3V3", cesm),
      // Isolated domain + Y-cap (must NOT merge isolation domains!)
      makeComp("U4", "C1007", "ISO7721F", "SOIC-8", [
        { n: "1", name: "VCC1", type: "POWER_IN", net: "3V3" },
        { n: "2", name: "INA", type: "INPUT_HIZ", net: "UART_MCU_TO_USB" },
        { n: "3", name: "OUTB", type: "PUSH_PULL", net: "ISO_RX_LOCAL" },
        { n: "4", name: "GND1", type: "GND", net: "GND" },
        { n: "5", name: "GND2", type: "GND", net: "GND_ISO" },
        { n: "6", name: "INB", type: "INPUT_HIZ", net: "ISO_TX_SEC" },
        { n: "7", name: "OUTA", type: "PUSH_PULL", net: "ISO_RX_SEC" },
        { n: "8", name: "VCC2", type: "POWER_IN", net: "VCC_5V_ISO" },
      ]),
      makeCap("CY1", "C1008", "1nF 2kV Y1", "1206", "GND", "GND_ISO", cesm, "CAP_MLCC", { v_working_max: 2000, dielectric: "C0G_NP0" }, {}, { isSafetyYCap: true }),
      // Isolated side bypass cap (not IC_VDD count fail since VCC_5V_ISO has 100nF)
      makeCap("C_ISO", "C1525", "100nF 16V", "0402", "VCC_5V_ISO", "GND_ISO", cesm),
    ];

    // Add 12 orthogonal wire-crossing dummy resistor divider/pullup pairs (crossing wires without junctions!)
    for (let k = 1; k <= 12; k++) {
      comps.push(
        makeRes(`R_CROSS_${k}`, "C1009", "10k", "0402", `CROSS_NET_A_${k}`, `CROSS_NET_B_${k}`, cesm, {
          posMm: [k * 5, 10],
        })
      );
    }

    const netlist = buildNetlist(comps, "eda.sch_Netlist", "SCH_CROSS_IMMUNE");
    const graph = buildElectricalHypergraph(netlist, (id) => cesm[id]);

    // Anonymous intermediate nets received propagated voltages
    expect(graph.nets.get("N_ANON_VBUS_PROT")?.voltage.vMax).toBeCloseTo(5.5, 2);
    expect(graph.nets.get("N_ANON_VDDA")?.voltage.vMax).toBeCloseTo(3.465, 2);
    // Primary and Secondary grounds sit in distinct isolation domains
    expect(graph.nets.get("GND")?.isolationDomain).not.toEqual(
      graph.nets.get("GND_ISO")?.isolationDomain
    );

    const report = runElectricalLinter(netlist, { cesmResolver: (id) => cesm[id] });
    expect(report.diagnostics).toEqual([]);
    expect(report.blockerCount).toBe(0);
    expect(report.warningCount).toBe(0);
    expect(report.pass).toBe(true);
    expect(report.gateStatus).toBe("READY_FOR_PCB");
    expect(report.constraintHandoffPackage).toBeDefined();

    // Validate generated ConstraintHandoffPackage against schemas/constraint-handoff.schema.json
    const schemaJson = JSON.parse(
      readFileSync(resolve(process.cwd(), "schemas/constraint-handoff.schema.json"), "utf8")
    );
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schemaJson);
    const valid = validate(report.constraintHandoffPackage);
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });
});

// ============================================================================
// 2. All 28 ELINT Rules (ELINT-001 ~ ELINT-028) Positive & Negative Matrix
// ============================================================================

describe("Electrical Linter: All 28 Rules (ELINT-001 ~ ELINT-028) Positives & Negatives", () => {
  it("ELINT-001: rejects unverified/missing CESM or pin mismatch, passes when aligned", () => {
    const cesm: Record<string, CesmModel> = {
      C2001: twoPinCesm("C2001", "10k", "RES_CHIP", "0402"),
      C2002: { ...twoPinCesm("C2002", "10k", "RES_CHIP", "0402"), verified: false },
    };
    const ok = buildNetlist([makeRes("R1", "C2001", "10k", "0402", "3V3", "GND", cesm)]);
    expect(runElectricalLinter(ok, { cesmResolver: (id) => cesm[id] }).diagnostics.some((d) => d.rule_id === "ELINT-001")).toBe(false);

    const bad = buildNetlist([
      makeRes("R_NO_LCSC", "", "10k", "0402", "3V3", "GND", cesm),
      makeRes("R_UNVERIFIED", "C2002", "10k", "0402", "3V3", "GND", cesm),
      makeComp("R_MISMATCH", "C2001", "10k", "0402", [
        { n: "1", type: "PASSIVE", net: "3V3" },
        { n: "99", type: "PASSIVE", net: "GND" },
      ]),
    ]);
    const rBad = runElectricalLinter(bad, { cesmResolver: (id) => cesm[id] });
    expect(rBad.diagnostics.filter((d) => d.rule_id === "ELINT-001").length).toBe(3);
  });

  it("ELINT-002: detects unconnected IC POWER_IN / GND pins", () => {
    const cesm: Record<string, CesmModel> = {
      C2003: makeCesm("C2003", "MCU_TEST", "MCU_SOC", "LQFP-48", [
        { pin_number: "1", pin_name: "VDD", elec_type: "POWER_IN" },
        { pin_number: "2", pin_name: "VDDA", elec_type: "POWER_IN" },
        { pin_number: "3", pin_name: "VSS", elec_type: "GND" },
      ]),
    };
    const ok = buildNetlist([
      makeComp("U1", "C2003", "MCU_TEST", "LQFP-48", [
        { n: "1", name: "VDD", type: "POWER_IN", net: "3V3" },
        { n: "2", name: "VDDA", type: "POWER_IN", net: "3V3" },
        { n: "3", name: "VSS", type: "GND", net: "GND" },
      ]),
    ]);
    expect(runElectricalLinter(ok, { cesmResolver: (id) => cesm[id] }).diagnostics.some((d) => d.rule_id === "ELINT-002")).toBe(false);

    const bad = buildNetlist([
      makeComp("U1", "C2003", "MCU_TEST", "LQFP-48", [
        { n: "1", name: "VDD", type: "POWER_IN", net: "3V3" },
        { n: "2", name: "VDDA", type: "POWER_IN", net: null },
        { n: "3", name: "VSS", type: "GND", net: "GND" },
      ]),
    ]);
    expect(runElectricalLinter(bad, { cesmResolver: (id) => cesm[id] }).diagnostics.some((d) => d.rule_id === "ELINT-002")).toBe(true);
  });

  it("ELINT-003: detects PUSH_PULL contention and shorted POWER_OUT rails", () => {
    const cesm: Record<string, CesmModel> = {
      C2004: makeCesm("C2004", "DRV", "MCU_SOC", "SOP-8", [
        { pin_number: "1", pin_name: "VDD", elec_type: "POWER_IN" },
        { pin_number: "2", pin_name: "GND", elec_type: "GND" },
        { pin_number: "3", pin_name: "OUT", elec_type: "PUSH_PULL" },
      ]),
      C2005: makeCesm("C2005", "LDO", "PMIC_LDO", "SOT-23-5", [
        { pin_number: "1", pin_name: "VIN", elec_type: "POWER_IN" },
        { pin_number: "2", pin_name: "GND", elec_type: "GND" },
        { pin_number: "3", pin_name: "VOUT", elec_type: "POWER_OUT" },
      ], { mlcc_output_stable: true }),
    };
    const bad = buildNetlist([
      makeComp("U1", "C2004", "DRV", "SOP-8", [
        { n: "1", name: "VDD", type: "POWER_IN", net: "3V3" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "OUT", type: "PUSH_PULL", net: "SIG_SHORT" },
      ]),
      makeComp("U2", "C2004", "DRV", "SOP-8", [
        { n: "1", name: "VDD", type: "POWER_IN", net: "3V3" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "OUT", type: "PUSH_PULL", net: "SIG_SHORT" },
      ]),
      makeComp("U3", "C2005", "LDO", "SOT-23-5", [
        { n: "1", name: "VIN", type: "POWER_IN", net: "5V" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "VOUT", type: "POWER_OUT", net: "3V3" },
      ]),
      makeComp("U4", "C2005", "LDO", "SOT-23-5", [
        { n: "1", name: "VIN", type: "POWER_IN", net: "5V" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "VOUT", type: "POWER_OUT", net: "3V3" },
      ]),
    ]);
    const diags = runElectricalLinter(bad, { cesmResolver: (id) => cesm[id] }).diagnostics.filter(
      (d) => d.rule_id === "ELINT-003"
    );
    expect(diags.length).toBeGreaterThanOrEqual(2);
  });

  it("ELINT-004 & ELINT-005: open-drain missing pull-up (BLOCKER) and I2C pull-up window (WARNING)", () => {
    const cesm: Record<string, CesmModel> = {
      C2006: makeCesm("C2006", "I2C_DEV", "MCU_SOC", "SOP-8", [
        { pin_number: "1", pin_name: "VDD", elec_type: "POWER_IN" },
        { pin_number: "2", pin_name: "GND", elec_type: "GND" },
        { pin_number: "3", pin_name: "SDA", elec_type: "OPEN_DRAIN", iol_max_ma: 3 },
        { pin_number: "4", pin_name: "SCL", elec_type: "OPEN_DRAIN", iol_max_ma: 3 },
      ]),
    };

    const ok = buildNetlist([
      makeComp("U1", "C2006", "I2C_DEV", "SOP-8", [
        { n: "1", name: "VDD", type: "POWER_IN", net: "3V3" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "SDA", type: "OPEN_DRAIN", net: "I2C_SDA" },
        { n: "4", name: "SCL", type: "OPEN_DRAIN", net: "I2C_SCL" },
      ]),
      makeRes("R1", "C2007", "4.7k", "0402", "I2C_SDA", "3V3", cesm),
      makeRes("R2", "C2007", "4.7k", "0402", "I2C_SCL", "3V3", cesm),
    ]);
    const rOk = runElectricalLinter(ok, { cesmResolver: (id) => cesm[id] });
    expect(rOk.diagnostics.some((d) => d.rule_id === "ELINT-004" || d.rule_id === "ELINT-005")).toBe(false);

    const bad = buildNetlist([
      makeComp("U1", "C2006", "I2C_DEV", "SOP-8", [
        { n: "1", name: "VDD", type: "POWER_IN", net: "3V3" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "SDA", type: "OPEN_DRAIN", net: "I2C_SDA" },
        { n: "4", name: "SCL", type: "OPEN_DRAIN", net: "I2C_SCL" },
      ]),
      makeRes("R_TOO_HIGH", "C2008", "100k", "0402", "I2C_SCL", "3V3", cesm),
    ]);
    const rBad = runElectricalLinter(bad, { cesmResolver: (id) => cesm[id] });
    expect(rBad.diagnostics.some((d) => d.rule_id === "ELINT-004")).toBe(true);
    expect(rBad.diagnostics.some((d) => d.rule_id === "ELINT-005")).toBe(true);
  });

  it("ELINT-006: catches floating critical control pins (NRST, BOOT0, EN, CS#)", () => {
    const cesm: Record<string, CesmModel> = {
      C2009: makeCesm("C2009", "MCU_CTRL", "MCU_SOC", "LQFP-48", [
        { pin_number: "1", pin_name: "VDD", elec_type: "POWER_IN" },
        { pin_number: "2", pin_name: "GND", elec_type: "GND" },
        { pin_number: "3", pin_name: "NRST", elec_type: "INPUT_HIZ" },
        { pin_number: "4", pin_name: "BOOT0", elec_type: "INPUT_HIZ" },
      ]),
    };
    // NRST only has cap to GND (missing 10k pullup) and BOOT0 is unconnected
    const bad = buildNetlist([
      makeComp("U1", "C2009", "MCU_CTRL", "LQFP-48", [
        { n: "1", name: "VDD", type: "POWER_IN", net: "3V3" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "NRST", type: "INPUT_HIZ", net: "MCU_NRST" },
        { n: "4", name: "BOOT0", type: "INPUT_HIZ", net: null },
      ]),
      makeCap("C_NRST", "C1525", "100nF 16V", "0402", "MCU_NRST", "GND", cesm),
    ]);
    const diags = runElectricalLinter(bad, { cesmResolver: (id) => cesm[id] }).diagnostics.filter(
      (d) => d.rule_id === "ELINT-006"
    );
    expect(diags.length).toBe(2);
  });

  it("ELINT-007 & ELINT-008: cross-voltage breakdown (incl. FT lost in ANALOG mode) and VIH noise margin failure", () => {
    const cesm: Record<string, CesmModel> = {
      C2010: makeCesm("C2010", "DRV_5V", "MCU_SOC", "SOP-8", [
        { pin_number: "1", pin_name: "VDD", elec_type: "POWER_IN" },
        { pin_number: "2", pin_name: "GND", elec_type: "GND" },
        { pin_number: "3", pin_name: "OUT_DIG", elec_type: "PUSH_PULL" },
      ]),
      C2011: makeCesm("C2011", "MCU_3V3", "MCU_SOC", "LQFP-48", [
        { pin_number: "1", pin_name: "VDD", elec_type: "POWER_IN" },
        { pin_number: "2", pin_name: "GND", elec_type: "GND" },
        { pin_number: "3", pin_name: "PA0_FT_ADC", elec_type: "BIDIR_IO", five_volt_tolerant: true, ft_lost_in_analog_mode: true, v_abs_max: 5.5 },
        { pin_number: "4", pin_name: "PA1_DIG_FT", elec_type: "INPUT_HIZ", five_volt_tolerant: true, v_abs_max: 5.5 },
        { pin_number: "5", pin_name: "PB0_TX", elec_type: "PUSH_PULL" },
      ]),
      C2012: makeCesm("C2012", "WS2812B_5V", "INTERFACE_XCVR", "SOP-8", [
        { pin_number: "1", pin_name: "VDD", elec_type: "POWER_IN" },
        { pin_number: "2", pin_name: "GND", elec_type: "GND" },
        { pin_number: "3", pin_name: "DIN", elec_type: "INPUT_HIZ", vih_min_expr: "0.7*VDD", vil_max_expr: "0.3*VDD", v_abs_max: 5.5 },
      ]),
    };

    // Positive: 5V -> FT digital pin (PA1_DIG_FT) passes ELINT-007
    const ok = buildNetlist([
      makeComp("U_5V", "C2010", "DRV_5V", "SOP-8", [
        { n: "1", name: "VDD", type: "POWER_IN", net: "5V" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "OUT_DIG", type: "PUSH_PULL", net: "SIG_5V" },
      ]),
      makeComp("U_3V3", "C2011", "MCU_3V3", "LQFP-48", [
        { n: "1", name: "VDD", type: "POWER_IN", net: "3V3" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "PA0_FT_ADC", type: "ANALOG_IN", net: "ADC_SAFE" },
        { n: "4", name: "PA1_DIG_FT", type: "INPUT_HIZ", net: "SIG_5V" },
        { n: "5", name: "PB0_TX", type: "PUSH_PULL", net: "LOCAL_3V3_SIG" },
      ]),
    ]);
    const rOk = runElectricalLinter(ok, { cesmResolver: (id) => cesm[id] });
    expect(rOk.diagnostics.some((d) => d.rule_id === "ELINT-007" || d.rule_id === "ELINT-008")).toBe(false);

    // Negative: 5V -> FT pin used in ANALOG mode triggers ELINT-007, AND 3.3V -> 5V CMOS (0.7*5=3.5V) triggers ELINT-008
    const bad = buildNetlist([
      makeComp("U_5V", "C2010", "DRV_5V", "SOP-8", [
        { n: "1", name: "VDD", type: "POWER_IN", net: "5V" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "OUT_DIG", type: "PUSH_PULL", net: "SIG_5V" },
      ]),
      makeComp("U_3V3", "C2011", "MCU_3V3", "LQFP-48", [
        { n: "1", name: "VDD", type: "POWER_IN", net: "3V3" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "PA0_FT_ADC", type: "ANALOG_IN", net: "SIG_5V" },
        { n: "4", name: "PA1_DIG_FT", type: "INPUT_HIZ", net: "SIG_5V" },
        { n: "5", name: "PB0_TX", type: "PUSH_PULL", net: "LED_DIN" },
      ], { extraProps: { pinModes: { "3": "ANALOG" } } }),
      makeComp("U_LED", "C2012", "WS2812B_5V", "SOP-8", [
        { n: "1", name: "VDD", type: "POWER_IN", net: "5V" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "DIN", type: "INPUT_HIZ", net: "LED_DIN" },
      ]),
    ]);
    const rBad = runElectricalLinter(bad, { cesmResolver: (id) => cesm[id] });
    expect(rBad.diagnostics.some((d) => d.rule_id === "ELINT-007")).toBe(true);
    expect(rBad.diagnostics.some((d) => d.rule_id === "ELINT-008")).toBe(true);
  });

  it("ELINT-009: catches UART RX-RX and SPI MOSI-SDO same-direction miswiring", () => {
    const cesm: Record<string, CesmModel> = {
      C2013: makeCesm("C2013", "UART_PEER", "MCU_SOC", "SOP-8", [
        { pin_number: "1", pin_name: "VDD", elec_type: "POWER_IN" },
        { pin_number: "2", pin_name: "GND", elec_type: "GND" },
        { pin_number: "3", pin_name: "RX", elec_type: "INPUT_HIZ" },
        { pin_number: "4", pin_name: "TX", elec_type: "PUSH_PULL" },
      ]),
    };
    const bad = buildNetlist([
      makeComp("U1", "C2013", "UART_PEER", "SOP-8", [
        { n: "1", name: "VDD", type: "POWER_IN", net: "3V3" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "RX", type: "INPUT_HIZ", net: "UART_NET_RX_RX" },
        { n: "4", name: "TX", type: "PUSH_PULL", net: "UART_NET_TX_TX" },
      ]),
      makeComp("U2", "C2013", "UART_PEER", "SOP-8", [
        { n: "1", name: "VDD", type: "POWER_IN", net: "3V3" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "RX", type: "INPUT_HIZ", net: "UART_NET_RX_RX" },
        { n: "4", name: "TX", type: "PUSH_PULL", net: "UART_NET_TX_TX" },
      ]),
    ]);
    const diags = runElectricalLinter(bad, { cesmResolver: (id) => cesm[id] }).diagnostics.filter(
      (d) => d.rule_id === "ELINT-009"
    );
    expect(diags.length).toBe(2);
  });

  it("ELINT-010 & ELINT-011: LDO thermal overload (>0.8W / Tj>110C) and legacy 1117 MLCC oscillation", () => {
    const cesm: Record<string, CesmModel> = { ...{ C6186: undefined as unknown as CesmModel } };
    delete cesm.C6186;
    const bad = buildNetlist([
      makeComp("U2", "C6186", "AMS1117-3.3", "SOT-223", [
        { n: "1", name: "GND", type: "GND", net: "GND" },
        { n: "2", name: "VOUT", type: "POWER_OUT", net: "3V3" },
        { n: "3", name: "VIN", type: "POWER_IN", net: "VIN_12V" },
        { n: "4", name: "TAB", type: "POWER_OUT", net: "3V3" },
      ], { extraProps: { i_load_a: 0.35 } }),
      makeCap("C_OUT", "C1525", "10uF 16V", "0805", "3V3", "GND", cesm, "CAP_MLCC", {
        v_working_max: 16,
        dielectric: "X7R",
      }),
    ]);
    const rBad = runElectricalLinter(bad);
    expect(rBad.diagnostics.some((d) => d.rule_id === "ELINT-010")).toBe(true);
    expect(rBad.diagnostics.some((d) => d.rule_id === "ELINT-011")).toBe(true);

    // Positive: RT9013 (5V->3.3V @ 0.1A) with MLCC passes both
    const ok = buildNetlist([
      makeComp("U2", "C47773", "RT9013-33GB", "SOT-23-5", [
        { n: "1", name: "VIN", type: "POWER_IN", net: "5V" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "EN", type: "INPUT_HIZ", net: "5V" },
        { n: "4", name: "NC", type: "NC", net: null },
        { n: "5", name: "VOUT", type: "POWER_OUT", net: "3V3" },
      ], { extraProps: { i_load_a: 0.1 } }),
      makeCap("C_OUT", "C1525", "100nF 16V", "0402", "3V3", "GND", cesm),
    ]);
    const rOk = runElectricalLinter(ok);
    expect(rOk.diagnostics.some((d) => d.rule_id === "ELINT-010" || d.rule_id === "ELINT-011")).toBe(false);
  });

  it("ELINT-012: warns when IC VDD pin groups exceed decoupling 100nF MLCC count", () => {
    const cesm: Record<string, CesmModel> = {
      C2014: makeCesm("C2014", "STM32_MULTI_VDD", "MCU_SOC", "LQFP-48", [
        { pin_number: "1", pin_name: "VDD_1", elec_type: "POWER_IN" },
        { pin_number: "2", pin_name: "VDD_2", elec_type: "POWER_IN" },
        { pin_number: "3", pin_name: "VDD_3", elec_type: "POWER_IN" },
        { pin_number: "4", pin_name: "VSS", elec_type: "GND" },
      ]),
    };
    const bad = buildNetlist([
      makeComp("U1", "C2014", "STM32_MULTI_VDD", "LQFP-48", [
        { n: "1", name: "VDD_1", type: "POWER_IN", net: "3V3" },
        { n: "2", name: "VDD_2", type: "POWER_IN", net: "3V3" },
        { n: "3", name: "VDD_3", type: "POWER_IN", net: "3V3" },
        { n: "4", name: "VSS", type: "GND", net: "GND" },
      ]),
      makeCap("C1", "C1525", "100nF 16V", "0402", "3V3", "GND", cesm),
    ]);
    expect(runElectricalLinter(bad, { cesmResolver: (id) => cesm[id] }).diagnostics.some((d) => d.rule_id === "ELINT-012")).toBe(true);
  });

  it("ELINT-013: checks resistor 50% power derating and package max working voltage (series 1206 passes across 310V, single 1206/0603 fails)", () => {
    const cesm: Record<string, CesmModel> = {
      C2015: twoPinCesm("C2015", "500k", "RES_CHIP", "1206", { v_working_max: 200, power_rated_w: 0.25 }),
      C2016: twoPinCesm("C2016", "10k", "RES_CHIP", "0402", { v_working_max: 50, power_rated_w: 0.0625 }),
    };
    // Positive: 2x 1206 series resistors dividing 310V DC -> each sees ~153.5V < 200V!
    const ok = buildNetlist([
      makeRes("R1A", "C2015", "500k", "1206", "HV_310V", "MID_HV", cesm),
      makeRes("R1B", "C2015", "500k", "1206", "MID_HV", "ADC_SENSE", cesm),
      makeRes("R2", "C2016", "10k", "0402", "ADC_SENSE", "GND", cesm),
    ]);
    expect(runElectricalLinter(ok, { cesmResolver: (id) => cesm[id] }).diagnostics.some((d) => d.rule_id === "ELINT-013")).toBe(false);

    // Negative: single 1206 across 310V (306V > 200V) + 0402 100 ohm across 5V (0.25W > 0.03125W)
    const bad = buildNetlist([
      makeRes("R_HV_SINGLE", "C2015", "1M", "1206", "HV_310V", "ADC_SENSE", cesm),
      makeRes("R_BOT", "C2016", "10k", "0402", "ADC_SENSE", "GND", cesm),
      makeRes("R_HOT", "C2016", "100", "0402", "5V", "GND", cesm),
    ]);
    const diags = runElectricalLinter(bad, { cesmResolver: (id) => cesm[id] }).diagnostics.filter(
      (d) => d.rule_id === "ELINT-013"
    );
    expect(diags.length).toBe(2);
  });

  it("ELINT-014 & ELINT-015: MLCC Y5V ban, <1.5x voltage, C0G for XTAL, and X5R DC-bias effective capacitance deficit", () => {
    const cesm: Record<string, CesmModel> = {
      C2017: twoPinCesm("C2017", "10uF/6.3V", "CAP_MLCC", "0402", {
        v_working_max: 6.3,
        dielectric: "X5R",
        dc_bias_retention_at_80pct_vr: 0.18,
      }),
      C2018: twoPinCesm("C2018", "100nF Y5V", "CAP_MLCC", "0402", { v_working_max: 25, dielectric: "Y5V" }),
      C2019: twoPinCesm("C2019", "16pF X7R", "CAP_MLCC", "0402", { v_working_max: 50, dielectric: "X7R" }),
      C2020: makeCesm("C2020", "BUCK_5V", "PMIC_DCDC", "SOT-23-6", [
        { pin_number: "1", pin_name: "VIN", elec_type: "POWER_IN" },
        { pin_number: "2", pin_name: "GND", elec_type: "GND" },
        { pin_number: "3", pin_name: "VOUT", elec_type: "POWER_OUT" },
      ], {}, { typical_application_constraints: ["COUT_EFF >= 15uF"] }),
    };

    const bad = buildNetlist([
      makeComp("U_DC", "C2020", "BUCK_5V", "SOT-23-6", [
        { n: "1", name: "VIN", type: "POWER_IN", net: "VIN_12V" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "VOUT", type: "POWER_OUT", net: "5V" },
      ]),
      makeCap("C_BIAS1", "C2017", "10uF 6.3V", "0402", "5V", "GND", cesm),
      makeCap("C_BIAS2", "C2017", "10uF 6.3V", "0402", "5V", "GND", cesm),
      makeCap("C_Y5V", "C2018", "100nF Y5V", "0402", "3V3", "GND", cesm),
      makeCap("C_XTAL", "C2019", "16pF X7R", "0402", "OSC_IN", "GND", cesm),
    ]);
    const rBad = runElectricalLinter(bad, { cesmResolver: (id) => cesm[id] });
    expect(rBad.diagnostics.some((d) => d.rule_id === "ELINT-014")).toBe(true);
    expect(rBad.diagnostics.some((d) => d.rule_id === "ELINT-015")).toBe(true);
  });

  it("ELINT-016 & ELINT-017: MnO2 tantalum 3x surge derating & reverse polarity on tantalum/Al-elec/LED/TVS", () => {
    const cesm: Record<string, CesmModel> = {
      C2021: twoPinCesm("C2021", "10uF/16V_TANT", "CAP_TANTALUM", "CASE-B", { v_working_max: 16, dielectric: "MNO2_TANT" }, {
        polarity_spec: { is_polarized: true, anode_pins: ["1"], cathode_pins: ["2"], silkscreen_rule: "BAR_IS_POSITIVE_ANODE" },
      }),
      C2022: twoPinCesm("C2022", "10uF/50V_TANT", "CAP_TANTALUM", "CASE-C", { v_working_max: 50, dielectric: "MNO2_TANT" }, {
        polarity_spec: { is_polarized: true, anode_pins: ["1"], cathode_pins: ["2"] },
      }),
      C2023: twoPinCesm("C2023", "SMF15A", "TVS_ESD_MOV", "SOD-123FL", { v_rwm_v: 15.0, v_clamp_max_v: 24.4 }, {
        polarity_spec: { is_polarized: true, anode_pins: ["1"], cathode_pins: ["2"] },
      }),
    };

    // Positive: 50V tantalum on 12V surge input + proper clamping TVS (cathode to VIN_12V, anode to GND)
    const ok = buildNetlist([
      makeCap("C_TANT_OK", "C2022", "10uF 50V", "CASE-C", "VIN_12V", "GND", cesm),
      makeComp("D_TVS_OK", "C2023", "SMF15A", "SOD-123FL", [
        { n: "1", name: "A", type: "PASSIVE", net: "GND" },
        { n: "2", name: "K", type: "PASSIVE", net: "VIN_12V" },
      ]),
    ]);
    const rOk = runElectricalLinter(ok, { cesmResolver: (id) => cesm[id] });
    expect(rOk.diagnostics.some((d) => d.rule_id === "ELINT-016" || d.rule_id === "ELINT-017")).toBe(false);

    // Negative: 16V MnO2 tantalum on 12V surge input + reversed tantalum (Anode=GND, Cathode=VIN_12V) + forward-shorted TVS
    const bad = buildNetlist([
      makeCap("C_TANT_BAD", "C2021", "10uF 16V", "CASE-B", "GND", "VIN_12V", cesm),
      makeComp("D_TVS_BAD", "C2023", "SMF15A", "SOD-123FL", [
        { n: "1", name: "A", type: "PASSIVE", net: "VIN_12V" },
        { n: "2", name: "K", type: "PASSIVE", net: "GND" },
      ]),
    ]);
    const rBad = runElectricalLinter(bad, { cesmResolver: (id) => cesm[id] });
    expect(rBad.diagnostics.some((d) => d.rule_id === "ELINT-016")).toBe(true);
    expect(rBad.diagnostics.filter((d) => d.rule_id === "ELINT-017").length).toBe(2);
  });

  it("ELINT-018: checks inductor I_sat >= 1.3*I_peak and ferrite bead I_rated >= 1.5*I_dc", () => {
    const cesm: Record<string, CesmModel> = {
      C2024: twoPinCesm("C2024", "4.7uH", "IND_POWER", "SMD-5050", { i_sat_a: 2.0, i_rms_a: 2.0 }),
      C2025: twoPinCesm("C2025", "FB600", "FERRITE_CMC", "0603", { i_rms_a: 0.5 }),
    };
    const bad = buildNetlist([
      makeComp("L1", "C2024", "4.7uH", "SMD-5050", [
        { n: "1", type: "PASSIVE", net: "SW" },
        { n: "2", type: "PASSIVE", net: "3V3" },
      ], { extraProps: { i_peak_a: 2.2, i_rms_req_a: 1.8 } }),
      makeComp("FB1", "C2025", "FB600", "0603", [
        { n: "1", type: "PASSIVE", net: "3V3" },
        { n: "2", type: "PASSIVE", net: "VDDA" },
      ], { extraProps: { i_dc_a: 0.45 } }),
    ]);
    const diags = runElectricalLinter(bad, { cesmResolver: (id) => cesm[id] }).diagnostics.filter(
      (d) => d.rule_id === "ELINT-018"
    );
    expect(diags.length).toBe(2);
  });

  it("ELINT-019 & ELINT-020: Type-C tied CC1/CC2 & unmerged A6/B6, plus TVS C_j & V_rwm limits", () => {
    const cesm: Record<string, CesmModel> = {
      C2026: makeCesm("C2026", "TYPE-C-16P", "CONN_USB_TYPEC", "USB-C", [
        { pin_number: "A5", pin_name: "CC1", elec_type: "PASSIVE" },
        { pin_number: "B5", pin_name: "CC2", elec_type: "PASSIVE" },
        { pin_number: "A6", pin_name: "DP1", elec_type: "BIDIR_IO" },
        { pin_number: "B6", pin_name: "DP2", elec_type: "BIDIR_IO" },
        { pin_number: "A7", pin_name: "DN1", elec_type: "BIDIR_IO" },
        { pin_number: "B7", pin_name: "DN2", elec_type: "BIDIR_IO" },
      ]),
      C2027: twoPinCesm("C2027", "HI_CAP_TVS", "TVS_ESD_MOV", "SOD-323", { v_rwm_v: 3.3, v_clamp_max_v: 8.0, c_junction_pf: 15.0 }),
    };

    const bad = buildNetlist([
      makeComp("USB1", "C2026", "TYPE-C-16P", "USB-C", [
        { n: "A5", name: "CC1", type: "PASSIVE", net: "CC_TIED" },
        { n: "B5", name: "CC2", type: "PASSIVE", net: "CC_TIED" },
        { n: "A6", name: "DP1", type: "BIDIR_IO", net: "USB_DP" },
        { n: "B6", name: "DP2", type: "BIDIR_IO", net: "USB_DP_UNMERGED" },
        { n: "A7", name: "DN1", type: "BIDIR_IO", net: "USB_DM" },
        { n: "B7", name: "DN2", type: "BIDIR_IO", net: "USB_DM" },
      ]),
      makeRes("R_CC", "C25905", "5.1k", "0402", "CC_TIED", "GND", cesm),
      makeComp("D_ESD", "C2027", "HI_CAP_TVS", "SOD-323", [
        { n: "1", name: "A", type: "PASSIVE", net: "GND" },
        { n: "2", name: "K", type: "PASSIVE", net: "USB_DP" },
      ]),
    ]);
    const rBad = runElectricalLinter(bad, { cesmResolver: (id) => cesm[id] });
    expect(rBad.diagnostics.some((d) => d.rule_id === "ELINT-019")).toBe(true);
    expect(rBad.diagnostics.some((d) => d.rule_id === "ELINT-020")).toBe(true);
  });

  it("ELINT-021: warns on Schottky clamp attached to high-impedance (>=10k) analog net", () => {
    const cesm: Record<string, CesmModel> = {
      C2028: makeCesm("C2028", "ADC_IN_PIN", "MCU_SOC", "SOP-8", [
        { pin_number: "1", pin_name: "VDD", elec_type: "POWER_IN" },
        { pin_number: "2", pin_name: "GND", elec_type: "GND" },
        { pin_number: "3", pin_name: "ADC_IN", elec_type: "ANALOG_IN" },
      ]),
      C2029: twoPinCesm("C2029", "BAT54S", "DIODE_SCHOTTKY", "SOT-23", { v_working_max: 30 }),
    };
    const bad = buildNetlist([
      makeComp("U1", "C2028", "ADC_IN_PIN", "SOP-8", [
        { n: "1", name: "VDD", type: "POWER_IN", net: "3V3" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "ADC_IN", type: "ANALOG_IN", net: "ADC_HIGH_Z" },
      ]),
      makeRes("R_TOP", "C2030", "100k", "0402", "VIN_12V", "ADC_HIGH_Z", cesm),
      makeRes("R_BOT", "C2031", "22k", "0402", "ADC_HIGH_Z", "GND", cesm),
      makeComp("D_CLAMP", "C2029", "BAT54S", "SOT-23", [
        { n: "1", name: "A", type: "PASSIVE", net: "ADC_HIGH_Z" },
        { n: "2", name: "K", type: "PASSIVE", net: "3V3" },
      ]),
    ]);
    expect(runElectricalLinter(bad, { cesmResolver: (id) => cesm[id] }).diagnostics.some((d) => d.rule_id === "ELINT-021")).toBe(true);
  });

  it("ELINT-022 & ELINT-023: MOSFET Vgs drive + Rg/Rgs resistors, and reverse-protection PMOS S/D orientation + >12V Zener", () => {
    const cesm: Record<string, CesmModel> = {
      C2032: makeCesm("C2032", "AO3400A", "MOSFET_BJT", "SOT-23", [
        { pin_number: "1", pin_name: "G", elec_type: "PASSIVE" },
        { pin_number: "2", pin_name: "S", elec_type: "PASSIVE" },
        { pin_number: "3", pin_name: "D", elec_type: "PASSIVE" },
      ], { vgs_rated_for_rdson_min_v: 2.5 }),
      C2033: makeCesm("C2033", "IRF540N_10V", "MOSFET_BJT", "TO-252", [
        { pin_number: "1", pin_name: "G", elec_type: "PASSIVE" },
        { pin_number: "2", pin_name: "S", elec_type: "PASSIVE" },
        { pin_number: "3", pin_name: "D", elec_type: "PASSIVE" },
      ], { vgs_rated_for_rdson_min_v: 10.0 }),
      C2034: makeCesm("C2034", "MCU_PWM", "MCU_SOC", "SOP-8", [
        { pin_number: "1", pin_name: "VDD", elec_type: "POWER_IN" },
        { pin_number: "2", pin_name: "GND", elec_type: "GND" },
        { pin_number: "3", pin_name: "PWM", elec_type: "PUSH_PULL" },
      ]),
      C2035: makeCesm("C2035", "DC_JACK_24V", "CONN_GENERIC", "DC-005", [
        { pin_number: "1", pin_name: "VIN", elec_type: "POWER_OUT" },
        { pin_number: "2", pin_name: "GND", elec_type: "GND" },
      ]),
      C2036: twoPinCesm("C2036", "BZT52C12", "DIODE_SCHOTTKY", "SOD-123", { v_working_max: 12 }),
    };

    // Positive: AO3400A driven by 3.3V via Rg=22R + Rgs=10k, AND PMOS D=VIN_24V_RAW, S=VIN_24V_SYS with 12V Zener
    const ok = buildNetlist([
      makeComp("U1", "C2034", "MCU_PWM", "SOP-8", [
        { n: "1", name: "VDD", type: "POWER_IN", net: "3V3" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "PWM", type: "PUSH_PULL", net: "MCU_PWM" },
      ]),
      makeRes("R_G", "C2037", "22R", "0402", "MCU_PWM", "Q1_GATE", cesm),
      makeRes("R_GS", "C2038", "10k", "0402", "Q1_GATE", "GND", cesm),
      makeComp("Q1", "C2032", "AO3400A", "SOT-23", [
        { n: "1", name: "G", type: "PASSIVE", net: "Q1_GATE" },
        { n: "2", name: "S", type: "PASSIVE", net: "GND" },
        { n: "3", name: "D", type: "PASSIVE", net: "LOAD_DRAIN" },
      ]),
      makeComp("J1", "C2035", "DC_JACK_24V", "DC-005", [
        { n: "1", name: "VIN", type: "POWER_OUT", net: "VIN_24V" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
      ]),
      makeComp("Q_REV", "C2032", "PMOS_REV", "SOT-23", [
        { n: "1", name: "G", type: "PASSIVE", net: "PMOS_G" },
        { n: "2", name: "S", type: "PASSIVE", net: "VIN_PROT_SYS" },
        { n: "3", name: "D", type: "PASSIVE", net: "VIN_24V" },
      ], { extraProps: { role: "REVERSE_PROTECTION" } }),
      makeRes("R_PMOS_G", "C2038", "47k", "0603", "PMOS_G", "GND", cesm),
      makeComp("ZD1", "C2036", "BZT52C12", "SOD-123", [
        { n: "1", name: "A", type: "PASSIVE", net: "PMOS_G" },
        { n: "2", name: "K", type: "PASSIVE", net: "VIN_PROT_SYS" },
      ]),
    ]);
    const rOk = runElectricalLinter(ok, { cesmResolver: (id) => cesm[id] });
    expect(rOk.diagnostics.some((d) => d.rule_id === "ELINT-022" || d.rule_id === "ELINT-023")).toBe(false);

    // Negative: IRF540N (10V Vgs) driven directly at 3.3V with missing Rg/Rgs + swapped PMOS without Zener
    const bad = buildNetlist([
      makeComp("U1", "C2034", "MCU_PWM", "SOP-8", [
        { n: "1", name: "VDD", type: "POWER_IN", net: "3V3" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "PWM", type: "PUSH_PULL", net: "MCU_PWM" },
      ]),
      makeComp("Q_BAD", "C2033", "IRF540N_10V", "TO-252", [
        { n: "1", name: "G", type: "PASSIVE", net: "MCU_PWM" },
        { n: "2", name: "S", type: "PASSIVE", net: "GND" },
        { n: "3", name: "D", type: "PASSIVE", net: "LOAD_DRAIN" },
      ]),
      makeComp("J1", "C2035", "DC_JACK_24V", "DC-005", [
        { n: "1", name: "VIN", type: "POWER_OUT", net: "VIN_24V" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
      ]),
      makeComp("Q_REV_BAD", "C2032", "PMOS_REV", "SOT-23", [
        { n: "1", name: "G", type: "PASSIVE", net: "PMOS_G" },
        { n: "2", name: "S", type: "PASSIVE", net: "VIN_24V" },
        { n: "3", name: "D", type: "PASSIVE", net: "VIN_PROT_SYS" },
      ], { extraProps: { role: "REVERSE_PROTECTION" } }),
      makeRes("R_PMOS_G", "C2038", "47k", "0603", "PMOS_G", "GND", cesm),
    ]);
    const rBad = runElectricalLinter(bad, { cesmResolver: (id) => cesm[id] });
    expect(rBad.diagnostics.some((d) => d.rule_id === "ELINT-022")).toBe(true);
    expect(rBad.diagnostics.filter((d) => d.rule_id === "ELINT-023").length).toBe(2);
  });

  it("ELINT-024, ELINT-025 & ELINT-026: inductive flyback / ULN2003 COM, isolation ground sharing, and default-HIGH isolator driving actuator", () => {
    const cesm: Record<string, CesmModel> = {
      C2040: makeCesm("C2040", "RELAY_12V", "RELAY_BUZZER", "RELAY-5P", [
        { pin_number: "1", pin_name: "COIL+", elec_type: "PASSIVE" },
        { pin_number: "2", pin_name: "COIL-", elec_type: "PASSIVE" },
        { pin_number: "3", pin_name: "COM", elec_type: "PASSIVE" },
        { pin_number: "4", pin_name: "NO", elec_type: "PASSIVE" },
      ]),
      C2041: makeCesm("C2041", "ULN2003A", "INTERFACE_XCVR", "SOP-16", [
        { pin_number: "1", pin_name: "IN1", elec_type: "INPUT_HIZ" },
        { pin_number: "8", pin_name: "GND", elec_type: "GND" },
        { pin_number: "9", pin_name: "COM", elec_type: "POWER_IN" },
        { pin_number: "16", pin_name: "OUT1", elec_type: "OPEN_DRAIN" },
      ]),
      C2042: makeCesm("C2042", "ISO7721H", "ISOLATOR_OPTO", "SOIC-8", [
        { pin_number: "1", pin_name: "VCC1", elec_type: "POWER_IN" },
        { pin_number: "2", pin_name: "INA", elec_type: "INPUT_HIZ", supply_pin_ref: "VCC1" },
        { pin_number: "4", pin_name: "GND1", elec_type: "GND" },
        { pin_number: "5", pin_name: "GND2", elec_type: "GND" },
        { pin_number: "7", pin_name: "OUTA", elec_type: "PUSH_PULL", supply_pin_ref: "VCC2" },
        { pin_number: "8", pin_name: "VCC2", elec_type: "POWER_IN" },
      ], { isolation_vrms: 3000, default_output_state: "HIGH" }),
      C2043: makeCesm("C2043", "AO3400A", "MOSFET_BJT", "SOT-23", [
        { pin_number: "1", pin_name: "G", elec_type: "PASSIVE" },
        { pin_number: "2", pin_name: "S", elec_type: "PASSIVE" },
        { pin_number: "3", pin_name: "D", elec_type: "PASSIVE" },
      ], { vgs_rated_for_rdson_min_v: 2.5 }),
    };

    const bad = buildNetlist([
      makeComp("K1", "C2040", "RELAY_12V", "RELAY-5P", [
        { n: "1", name: "COIL+", type: "PASSIVE", net: "12V" },
        { n: "2", name: "COIL-", type: "PASSIVE", net: "RLY_DRV" },
        { n: "3", name: "COM", type: "PASSIVE", net: "AC_L_220V" },
        { n: "4", name: "NO", type: "PASSIVE", net: "AC_LOAD" },
      ]),
      makeComp("U_ULN", "C2041", "ULN2003A", "SOP-16", [
        { n: "1", name: "IN1", type: "INPUT_HIZ", net: "MCU_RLY" },
        { n: "8", name: "GND", type: "GND", net: "GND" },
        { n: "9", name: "COM", type: "POWER_IN", net: null }, // Floating COM!
        { n: "16", name: "OUT1", type: "OPEN_DRAIN", net: "RLY_DRV" },
      ]),
      makeComp("U_ISO", "C2042", "ISO7721H", "SOIC-8", [
        { n: "1", name: "VCC1", type: "POWER_IN", net: "3V3" },
        { n: "2", name: "INA", type: "INPUT_HIZ", net: "MCU_MOTOR" },
        { n: "4", name: "GND1", type: "GND", net: "GND" },
        { n: "5", name: "GND2", type: "GND", net: "GND" }, // Shared GND across isolation barrier!
        { n: "7", name: "OUTA", type: "PUSH_PULL", net: "ISO_GATE_PRE" },
        { n: "8", name: "VCC2", type: "POWER_IN", net: "5V_ISO" },
      ]),
      makeRes("R_G", "C2044", "10R", "0402", "ISO_GATE_PRE", "ISO_GATE", cesm),
      makeRes("R_GS", "C2045", "10k", "0402", "ISO_GATE", "GND", cesm),
      makeComp("Q_MTR", "C2043", "AO3400A", "SOT-23", [
        { n: "1", name: "G", type: "PASSIVE", net: "ISO_GATE" },
        { n: "2", name: "S", type: "PASSIVE", net: "GND" },
        { n: "3", name: "D", type: "PASSIVE", net: "MOTOR_D" },
      ]),
    ]);

    const rBad = runElectricalLinter(bad, { cesmResolver: (id) => cesm[id] });
    expect(rBad.diagnostics.some((d) => d.rule_id === "ELINT-024")).toBe(true);
    expect(rBad.diagnostics.some((d) => d.rule_id === "ELINT-025")).toBe(true);
    expect(rBad.diagnostics.some((d) => d.rule_id === "ELINT-026")).toBe(true);
  });

  it("ELINT-027 & ELINT-028: passive crystal load cap mismatch, shunt outer-trunk tap & ADC missing series damping", () => {
    const cesm: Record<string, CesmModel> = {
      C2050: makeCesm("C2050", "8MHz_12pF", "XTAL_PASSIVE", "SMD-3225", [
        { pin_number: "1", pin_name: "X1", elec_type: "PASSIVE" },
        { pin_number: "2", pin_name: "GND", elec_type: "GND" },
        { pin_number: "3", pin_name: "X2", elec_type: "PASSIVE" },
      ], {}),
      C2051: twoPinCesm("C2051", "27pF C0G", "CAP_MLCC", "0402", { v_working_max: 50, dielectric: "C0G_NP0" }),
      C2052: twoPinCesm("C2052", "15pF C0G", "CAP_MLCC", "0402", { v_working_max: 50, dielectric: "C0G_NP0" }),
      C2053: makeCesm("C2053", "SHUNT_10mR", "RES_SHUNT", "2512", [
        { pin_number: "1", pin_name: "I+", elec_type: "PASSIVE" },
        { pin_number: "2", pin_name: "I-", elec_type: "PASSIVE" },
        { pin_number: "3", pin_name: "S+", elec_type: "PASSIVE" },
        { pin_number: "4", pin_name: "S-", elec_type: "PASSIVE" },
      ], { power_rated_w: 1.0 }),
      C2054: makeCesm("C2054", "ADS1256", "ADC_DAC_VREF", "SSOP-28", [
        { pin_number: "1", pin_name: "VDD", elec_type: "POWER_IN" },
        { pin_number: "2", pin_name: "GND", elec_type: "GND" },
        { pin_number: "3", pin_name: "SCK", elec_type: "INPUT_HIZ" },
        { pin_number: "4", pin_name: "DIN", elec_type: "INPUT_HIZ" },
      ]),
      C2055: makeCesm("C2055", "STM32", "MCU_SOC", "LQFP-48", [
        { pin_number: "1", pin_name: "VDD", elec_type: "POWER_IN" },
        { pin_number: "2", pin_name: "GND", elec_type: "GND" },
        { pin_number: "3", pin_name: "SCK", elec_type: "PUSH_PULL" },
        { pin_number: "4", pin_name: "MOSI", elec_type: "PUSH_PULL" },
      ]),
    };

    // Positive: C1=C2=15pF for CL=12pF (0.5*15 + 4 = 11.5pF), separate Kelvin nets S+/S-, and 33 ohm SPI series damping
    const ok = buildNetlist([
      makeComp("Y1", "C2050", "8MHz_12pF", "SMD-3225", [
        { n: "1", name: "X1", type: "PASSIVE", net: "OSC_IN" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "X2", type: "PASSIVE", net: "OSC_OUT" },
      ], { extraProps: { cl_pf: 12, c_stray_pf: 4.0 } }),
      makeCap("C_X1", "C2052", "15pF C0G", "0402", "OSC_IN", "GND", cesm, "CAP_MLCC", { v_working_max: 50, dielectric: "C0G_NP0" }),
      makeCap("C_X2", "C2052", "15pF C0G", "0402", "OSC_OUT", "GND", cesm, "CAP_MLCC", { v_working_max: 50, dielectric: "C0G_NP0" }),
      makeComp("R_SH", "C2053", "10mR", "2512", [
        { n: "1", name: "I+", type: "PASSIVE", net: "PWR_MAIN" },
        { n: "2", name: "I-", type: "PASSIVE", net: "LOAD_IN" },
        { n: "3", name: "S+", type: "PASSIVE", net: "SHUNT_SENSE_P" },
        { n: "4", name: "S-", type: "PASSIVE", net: "SHUNT_SENSE_N" },
      ]),
      makeComp("U_ADC", "C2054", "ADS1256", "SSOP-28", [
        { n: "1", name: "VDD", type: "POWER_IN", net: "3V3" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "SCK", type: "INPUT_HIZ", net: "ADC_SCK_DAMP" },
        { n: "4", name: "DIN", type: "INPUT_HIZ", net: "ADC_MOSI_DAMP" },
      ]),
      makeComp("U_MCU", "C2055", "STM32", "LQFP-48", [
        { n: "1", name: "VDD", type: "POWER_IN", net: "3V3" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "SCK", type: "PUSH_PULL", net: "MCU_SCK" },
        { n: "4", name: "MOSI", type: "PUSH_PULL", net: "MCU_MOSI" },
      ]),
      makeRes("R_D1", "C2056", "33R", "0402", "MCU_SCK", "ADC_SCK_DAMP", cesm),
      makeRes("R_D2", "C2056", "33R", "0402", "MCU_MOSI", "ADC_MOSI_DAMP", cesm),
    ]);
    const rOk = runElectricalLinter(ok, { cesmResolver: (id) => cesm[id] });
    expect(rOk.diagnostics.some((d) => d.rule_id === "ELINT-027" || d.rule_id === "ELINT-028")).toBe(false);

    // Negative: 27pF on 12pF crystal (17.5pF vs 12pF), Kelvin S+ shorted to PWR_MAIN, ADC direct to MCU without 22..120R
    const bad = buildNetlist([
      makeComp("Y1", "C2050", "8MHz_12pF", "SMD-3225", [
        { n: "1", name: "X1", type: "PASSIVE", net: "OSC_IN" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "X2", type: "PASSIVE", net: "OSC_OUT" },
      ], { extraProps: { cl_pf: 12, c_stray_pf: 4.0 } }),
      makeCap("C_X1", "C2051", "27pF C0G", "0402", "OSC_IN", "GND", cesm, "CAP_MLCC", { v_working_max: 50, dielectric: "C0G_NP0" }),
      makeCap("C_X2", "C2051", "27pF C0G", "0402", "OSC_OUT", "GND", cesm, "CAP_MLCC", { v_working_max: 50, dielectric: "C0G_NP0" }),
      makeComp("R_SH", "C2053", "10mR", "2512", [
        { n: "1", name: "I+", type: "PASSIVE", net: "PWR_MAIN" },
        { n: "2", name: "I-", type: "PASSIVE", net: "LOAD_IN" },
        { n: "3", name: "S+", type: "PASSIVE", net: "PWR_MAIN" }, // Shorted to main trunk!
        { n: "4", name: "S-", type: "PASSIVE", net: "SHUNT_SENSE_N" },
      ]),
      makeComp("U_ADC", "C2054", "ADS1256", "SSOP-28", [
        { n: "1", name: "VDD", type: "POWER_IN", net: "3V3" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "SCK", type: "INPUT_HIZ", net: "SPI_SCK_DIRECT" },
        { n: "4", name: "DIN", type: "INPUT_HIZ", net: "SPI_MOSI_DIRECT" },
      ]),
      makeComp("U_MCU", "C2055", "STM32", "LQFP-48", [
        { n: "1", name: "VDD", type: "POWER_IN", net: "3V3" },
        { n: "2", name: "GND", type: "GND", net: "GND" },
        { n: "3", name: "SCK", type: "PUSH_PULL", net: "SPI_SCK_DIRECT" },
        { n: "4", name: "MOSI", type: "PUSH_PULL", net: "SPI_MOSI_DIRECT" },
      ]),
    ]);
    const rBad = runElectricalLinter(bad, { cesmResolver: (id) => cesm[id] });
    expect(rBad.diagnostics.some((d) => d.rule_id === "ELINT-027")).toBe(true);
    expect(rBad.diagnostics.filter((d) => d.rule_id === "ELINT-028").length).toBe(2);
  });
});

// ============================================================================
// 3. Critical PCB Scenarios ②, ③ & All 18 PLINT Rules (PLINT-01 ~ PLINT-18)
// ============================================================================

describe("Geometry PCB Linter: Critical Scenarios & All 18 Rules (PLINT-01 ~ PLINT-18)", () => {
  it("Scenario 2: 4-Layer PCB with TopLayer inductor & passive crystal allows BottomLayer routing and SMD passives directly underneath (0 false positives), while catching same-layer & ALL_COPPER_LAYERS intrusions", () => {
    const cesm: Record<string, CesmModel> = {
      C3001: twoPinCesm("C3001", "4.7uH", "IND_POWER", "IND-5050"),
      C3002: makeCesm("C3002", "8MHz", "XTAL_PASSIVE", "SMD-3225", [
        { pin_number: "1", pin_name: "X1", elec_type: "PASSIVE" },
        { pin_number: "2", pin_name: "GND", elec_type: "GND" },
        { pin_number: "3", pin_name: "X2", elec_type: "PASSIVE" },
      ]),
      C3003: makeCesm("C3003", "STM32", "MCU_SOC", "LQFP-48", [
        { pin_number: "1", pin_name: "OSC_IN", elec_type: "ANALOG_IN" },
        { pin_number: "2", pin_name: "OSC_OUT", elec_type: "ANALOG_OUT" },
      ]),
      C3004: twoPinCesm("C3004", "10k", "RES_CHIP", "0603"),
    };

    const baseBoard: PcbBoardGeometrySnapshot = {
      pcbDocument: "PCB_4LAYER_KEEPOUT",
      boardOutline: {
        widthMm: 80,
        heightMm: 60,
        layerCount: 4,
        stackup: ["TopLayer", "InnerLayer1", "InnerLayer2", "BottomLayer"],
      },
      cesmResolver: (id) => cesm[id],
      components: [
        {
          primitiveId: "L1",
          designator: "L1",
          lcscId: "C3001",
          package: "IND-5050",
          category: "IND_POWER",
          layer: "TopLayer",
          centerMm: [20, 20],
          rotationDeg: 0,
          bboxMm: [17.5, 17.5, 22.5, 22.5],
          pads: [
            { primitiveId: "L1_1", designator: "L1", padNumber: "1", net: "SW", layer: "TopLayer", centerMm: [18, 20], sizeMm: [1.2, 2.0] },
            { primitiveId: "L1_2", designator: "L1", padNumber: "2", net: "3V3", layer: "TopLayer", centerMm: [22, 20], sizeMm: [1.2, 2.0] },
          ],
        },
        {
          primitiveId: "U1",
          designator: "U1",
          lcscId: "C3003",
          package: "LQFP-48",
          category: "MCU_SOC",
          layer: "TopLayer",
          centerMm: [45, 30],
          rotationDeg: 0,
          bboxMm: [41, 26, 49, 34],
          pads: [
            { primitiveId: "U1_1", designator: "U1", padNumber: "1", pinName: "OSC_IN", net: "OSC_IN", layer: "TopLayer", centerMm: [41.5, 29], sizeMm: [0.5, 0.5] },
            { primitiveId: "U1_2", designator: "U1", padNumber: "2", pinName: "OSC_OUT", net: "OSC_OUT", layer: "TopLayer", centerMm: [41.5, 31], sizeMm: [0.5, 0.5] },
          ],
        },
        {
          primitiveId: "Y1",
          designator: "Y1",
          lcscId: "C3002",
          package: "SMD-3225",
          category: "XTAL_PASSIVE",
          layer: "TopLayer",
          centerMm: [36, 30],
          rotationDeg: 0,
          bboxMm: [34.4, 28.7, 37.6, 31.3],
          pads: [
            { primitiveId: "Y1_1", designator: "Y1", padNumber: "1", net: "OSC_IN", layer: "TopLayer", centerMm: [35, 29], sizeMm: [0.8, 0.8] },
            { primitiveId: "Y1_2", designator: "Y1", padNumber: "2", net: "GND", layer: "TopLayer", centerMm: [37, 29], sizeMm: [0.8, 0.8] },
            { primitiveId: "Y1_3", designator: "Y1", padNumber: "3", net: "OSC_OUT", layer: "TopLayer", centerMm: [37, 31], sizeMm: [0.8, 0.8] },
          ],
        },
        // Passives placed DIRECTLY underneath L1 and Y1 on BottomLayer!
        {
          primitiveId: "R_BOT_UNDER_L1",
          designator: "R_BOT1",
          lcscId: "C3004",
          package: "0603",
          category: "RES_CHIP",
          layer: "BottomLayer",
          centerMm: [20, 20],
          rotationDeg: 0,
          bboxMm: [19.0, 19.4, 21.0, 20.6],
          pads: [
            { primitiveId: "RB1_1", designator: "R_BOT1", padNumber: "1", net: "SIG_BOT_1", layer: "BottomLayer", centerMm: [19.3, 20], sizeMm: [0.6, 0.6] },
            { primitiveId: "RB1_2", designator: "R_BOT1", padNumber: "2", net: "GND", layer: "BottomLayer", centerMm: [20.7, 20], sizeMm: [0.6, 0.6] },
          ],
        },
        {
          primitiveId: "C_BOT_UNDER_Y1",
          designator: "C_BOT1",
          lcscId: "C3004",
          package: "0603",
          category: "CAP_MLCC",
          layer: "BottomLayer",
          centerMm: [36, 30],
          rotationDeg: 0,
          bboxMm: [35.0, 29.4, 37.0, 30.6],
          pads: [
            { primitiveId: "CB1_1", designator: "C_BOT1", padNumber: "1", net: "SIG_BOT_2", layer: "BottomLayer", centerMm: [35.3, 30], sizeMm: [0.6, 0.6] },
            { primitiveId: "CB1_2", designator: "C_BOT1", padNumber: "2", net: "GND", layer: "BottomLayer", centerMm: [36.7, 30], sizeMm: [0.6, 0.6] },
          ],
        },
      ],
      tracks: [
        // BottomLayer tracks running directly underneath L1 and Y1 -> MUST BE ALLOWED!
        { primitiveId: "TR_BOT_UNDER_L1", net: "SIG_BOT_1", layer: "BottomLayer", startMm: [14, 20], endMm: [26, 20], widthMm: 0.2 },
        { primitiveId: "TR_BOT_UNDER_Y1", net: "SIG_BOT_2", layer: "BottomLayer", startMm: [32, 30], endMm: [40, 30], widthMm: 0.2 },
        // TopLayer crystal short tracks & guard ring
        { primitiveId: "TR_OSC_IN", net: "OSC_IN", layer: "TopLayer", startMm: [35, 29], endMm: [41.5, 29], widthMm: 0.18 },
        { primitiveId: "TR_OSC_OUT", net: "OSC_OUT", layer: "TopLayer", startMm: [37, 31], endMm: [41.5, 31], widthMm: 0.18 },
        ...makeGuardRingTracks("Y1_GR", "TopLayer", [34.4, 28.7, 37.6, 31.3]),
      ],
      vias: [],
      pours: [
        // Solid InnerLayer1 GND reference plane (stops cleanly outside RF antenna keepout [68..78, 48..58])
        makeRectPour("POUR_IN1_GND", "GND", "InnerLayer1", 2, 2, 65, 58),
      ],
      keepoutZones: [
        {
          id: "KO_L1_MOUNT_ONLY",
          category: "POWER_INDUCTOR",
          ownerDesignator: "L1",
          polygon2D: [[17.5, 17.5], [22.5, 17.5], [22.5, 22.5], [17.5, 22.5]],
          layerSet: ["MOUNT_LAYER"],
          disallowMask: ["COPPER_POUR", "TRACK"],
          allowedNets: ["SW", "3V3"],
          mountSide: "TOP",
        },
        {
          id: "KO_Y1_MOUNT_ONLY",
          category: "PASSIVE_CRYSTAL",
          ownerDesignator: "Y1",
          polygon2D: [[34.4, 28.7], [37.6, 28.7], [37.6, 31.3], [34.4, 31.3]],
          layerSet: ["MOUNT_LAYER"],
          disallowMask: ["TRACK", "COPPER_POUR"],
          allowedNets: ["OSC_IN", "OSC_OUT", "GND"],
          mountSide: "TOP",
        },
        {
          id: "KO_RF_ANTENNA_ALL_LAYERS",
          category: "RF_ANTENNA",
          polygon2D: [[68, 48], [78, 48], [78, 58], [68, 58]],
          layerSet: ["ALL_COPPER_LAYERS"],
          disallowMask: ["COPPER_POUR", "TRACK", "VIA", "PAD", "COMPONENT"],
          allowedNets: [],
          mountSide: "ALL",
        },
      ],
    };

    const okReport = runGeometryPcbLinter(baseBoard);
    expect(okReport.customGeoLintFindings.filter((f) => f.ruleId === "PLINT-10" || f.ruleId === "PLINT-11")).toHaveLength(0);
    expect(okReport.pass).toBe(true);

    // Negative: TopLayer foreign track crossing under L1 AND BottomLayer track crossing ALL_COPPER_LAYERS RF Antenna
    const badBoard: PcbBoardGeometrySnapshot = {
      ...baseBoard,
      tracks: [
        ...baseBoard.tracks,
        { primitiveId: "TR_TOP_UNDER_L1", net: "BAD_TOP_SIG", layer: "TopLayer", startMm: [16, 20], endMm: [24, 20], widthMm: 0.2 },
        { primitiveId: "TR_BOT_IN_RF_ANT", net: "BAD_BOT_RF", layer: "BottomLayer", startMm: [65, 53], endMm: [76, 53], widthMm: 0.2 },
      ],
    };
    const badReport = runGeometryPcbLinter(badBoard);
    const plint10 = badReport.customGeoLintFindings.filter((f) => f.ruleId === "PLINT-10");
    expect(plint10.length).toBe(2);
  });

  it("Scenario 3: Low-side single-ended & high-side dual-ended shunt inner-pad sense exit WITHOUT guard ring pass PLINT-17, while outer-trunk sense tapping and blind thermal vias on power lines are caught by PLINT-17", () => {
    const cesm: Record<string, CesmModel> = {
      C3010: twoPinCesm("C3010", "10mR_SHUNT", "RES_SHUNT", "2512", { power_rated_w: 1.0 }),
    };

    const okBoard: PcbBoardGeometrySnapshot = {
      pcbDocument: "PCB_SHUNT_AND_POWER",
      boardOutline: { widthMm: 80, heightMm: 60, layerCount: 4 },
      cesmResolver: (id) => cesm[id],
      components: [
        // Low-side single-ended shunt R_LS at [20, 20]
        {
          primitiveId: "R_LS",
          designator: "R_LS",
          lcscId: "C3010",
          package: "2512",
          category: "RES_SHUNT",
          layer: "TopLayer",
          centerMm: [20, 20],
          rotationDeg: 0,
          bboxMm: [16.8, 18.4, 23.2, 21.6],
          pads: [
            { primitiveId: "RLS_1", designator: "R_LS", padNumber: "1", net: "LS_SENSE", layer: "TopLayer", centerMm: [17.8, 20], sizeMm: [1.5, 2.4] },
            { primitiveId: "RLS_2", designator: "R_LS", padNumber: "2", net: "GND", layer: "TopLayer", centerMm: [22.2, 20], sizeMm: [1.5, 2.4] },
          ],
        },
        // High-side dual-ended shunt R_HS at [50, 20]
        {
          primitiveId: "R_HS",
          designator: "R_HS",
          lcscId: "C3010",
          package: "2512",
          category: "RES_SHUNT",
          layer: "TopLayer",
          centerMm: [50, 20],
          rotationDeg: 0,
          bboxMm: [46.8, 18.4, 53.2, 21.6],
          pads: [
            { primitiveId: "RHS_1", designator: "R_HS", padNumber: "1", net: "HS_IN", layer: "TopLayer", centerMm: [47.8, 20], sizeMm: [1.5, 2.4] },
            { primitiveId: "RHS_2", designator: "R_HS", padNumber: "2", net: "HS_OUT", layer: "TopLayer", centerMm: [52.2, 20], sizeMm: [1.5, 2.4] },
          ],
        },
        // IC with static GND EPAD thermal via array (allowed!)
        {
          primitiveId: "U_BUCK",
          designator: "U_BUCK",
          package: "QFN-16",
          category: "PMIC_DCDC",
          layer: "TopLayer",
          centerMm: [30, 45],
          rotationDeg: 0,
          bboxMm: [28, 43, 32, 47],
          pads: [
            { primitiveId: "UB_EP", designator: "U_BUCK", padNumber: "17", net: "GND", layer: "TopLayer", centerMm: [30, 45], sizeMm: [2.2, 2.2], isEpad: true },
          ],
        },
      ],
      tracks: [
        // Heavy power trunks leaving outer edges of shunt pads
        { primitiveId: "TR_LS_PWR", net: "LS_SENSE", layer: "TopLayer", startMm: [10, 20], endMm: [17.8, 20], widthMm: 2.0 },
        { primitiveId: "TR_HS_IN_PWR", net: "HS_IN", layer: "TopLayer", startMm: [40, 20], endMm: [47.8, 20], widthMm: 2.0 },
        { primitiveId: "TR_HS_OUT_PWR", net: "HS_OUT", layer: "TopLayer", startMm: [52.2, 20], endMm: [60, 20], widthMm: 2.0 },
        // Inner-pad sense lines (NO guard ring!) -> MUST PASS!
        { primitiveId: "TR_LS_SENSE", net: "LS_SENSE", layer: "TopLayer", startMm: [18.5, 20], endMm: [18.5, 28], widthMm: 0.2 },
        { primitiveId: "TR_HS_SENSE_P", net: "HS_IN", layer: "TopLayer", startMm: [48.5, 20], endMm: [48.5, 28], widthMm: 0.2 },
        { primitiveId: "TR_HS_SENSE_N", net: "HS_OUT", layer: "TopLayer", startMm: [51.5, 20], endMm: [51.5, 28], widthMm: 0.2 },
        // Genuine power layer-transition trace on VIN_12V (TopLayer -> via -> BottomLayer)
        { primitiveId: "TR_VIN_TOP", net: "VIN_12V", layer: "TopLayer", startMm: [10, 40], endMm: [20, 40], widthMm: 1.5 },
        { primitiveId: "TR_VIN_BOT", net: "VIN_12V", layer: "BottomLayer", startMm: [20, 40], endMm: [20, 50], widthMm: 1.5 },
      ],
      vias: [
        // Legal EPAD GND thermal vias
        { primitiveId: "VIA_EP1", net: "GND", centerMm: [29.5, 45], drillMm: 0.3, outerDiaMm: 0.6, purpose: "THERMAL_EPAD" },
        { primitiveId: "VIA_EP2", net: "GND", centerMm: [30.5, 45], drillMm: 0.3, outerDiaMm: 0.6, purpose: "THERMAL_EPAD" },
        // Legal power transition via bridging TopLayer and BottomLayer on VIN_12V
        { primitiveId: "VIA_PWR_TRANS", net: "VIN_12V", centerMm: [20, 40], drillMm: 0.4, outerDiaMm: 0.7, purpose: "POWER_TRANSITION" },
      ],
      pours: [],
    };

    const okReport = runGeometryPcbLinter(okBoard);
    expect(okReport.customGeoLintFindings.filter((f) => f.ruleId === "PLINT-17")).toHaveLength(0);
    expect(okReport.pass).toBe(true);

    // Negative: (1) outer-trunk sense tap 4mm outside R_LS pad, (2) blind thermal vias on VIN_12V power line & SW node
    const badBoard: PcbBoardGeometrySnapshot = {
      ...okBoard,
      tracks: [
        ...okBoard.tracks,
        { primitiveId: "TR_LS_BAD_OUTER_TAP", net: "LS_SENSE", layer: "TopLayer", startMm: [13.5, 20], endMm: [13.5, 28], widthMm: 0.2 },
        { primitiveId: "TR_SW_ONLY_TOP", net: "SW", layer: "TopLayer", startMm: [32, 45], endMm: [38, 45], widthMm: 1.2 },
      ],
      vias: [
        ...okBoard.vias,
        // Blind thermal vias on TopLayer-only VIN_12V segment & SW node!
        { primitiveId: "VIA_BLIND_VIN", net: "VIN_12V", centerMm: [14, 40], drillMm: 0.3, outerDiaMm: 0.6, purpose: "BLIND_THERMAL_ON_POWER" },
        { primitiveId: "VIA_BLIND_SW", net: "SW", centerMm: [35, 45], drillMm: 0.3, outerDiaMm: 0.6 },
      ],
    };

    const badReport = runGeometryPcbLinter(badBoard);
    const plint17 = badReport.customGeoLintFindings.filter((f) => f.ruleId === "PLINT-17");
    expect(plint17.some((f) => f.category === "SHUNT_OUTER_TRUNK_SENSE_TAP")).toBe(true);
    expect(plint17.filter((f) => f.category === "FORBIDDEN_THERMAL_VIA_ON_POWER_LINE").length).toBe(2);
  });

  it("respects ProjectDesignRules (eda.pcb_Drc) priority and covers remaining PLINT-01 ~ PLINT-18 rules", () => {
    const cesm: Record<string, CesmModel> = {
      C4001: twoPinCesm("C4001", "10k", "RES_CHIP", "0402", { v_working_max: 50 }),
      C4002: twoPinCesm("C4002", "100nF 6.3V", "CAP_MLCC", "0402", { v_working_max: 6.3, dielectric: "X5R" }),
      C4003: makeCesm("C4003", "USB-C-16P", "CONN_USB_TYPEC", "USB-C", [
        { pin_number: "A5", pin_name: "CC1", elec_type: "PASSIVE" },
        { pin_number: "B5", pin_name: "CC2", elec_type: "PASSIVE" },
      ]),
      C4004: makeCesm("C4004", "MCU_CORE", "MCU_SOC", "LQFP-48", [
        { pin_number: "1", pin_name: "VDD", elec_type: "POWER_IN" },
        { pin_number: "2", pin_name: "PA0", elec_type: "INPUT_HIZ", v_abs_max: 3.6 },
        { pin_number: "3", pin_name: "NRST", elec_type: "INPUT_HIZ" },
        { pin_number: "4", pin_name: "OSC_IN", elec_type: "ANALOG_IN" },
      ]),
      C4005: makeCesm("C4005", "DRV_5V", "MCU_SOC", "SOP-8", [
        { pin_number: "1", pin_name: "VDD", elec_type: "POWER_IN" },
        { pin_number: "2", pin_name: "OUT", elec_type: "PUSH_PULL" },
      ]),
      C4006: makeCesm("C4006", "RELAY_12V", "RELAY_BUZZER", "RELAY-5P", [
        { pin_number: "1", pin_name: "COIL+", elec_type: "PASSIVE" },
        { pin_number: "2", pin_name: "COIL-", elec_type: "PASSIVE" },
      ]),
      C4007: twoPinCesm("C4007", "1N4148", "DIODE_SCHOTTKY", "SOD-123"),
      C4008: makeCesm("C4008", "AMS1117", "PMIC_LDO", "SOT-223", [
        { pin_number: "1", pin_name: "GND", elec_type: "GND" },
        { pin_number: "2", pin_name: "VOUT", elec_type: "POWER_OUT" },
        { pin_number: "3", pin_name: "VIN", elec_type: "POWER_IN" },
      ], { r_theta_ja_c_per_w: 65 }),
      C4009: twoPinCesm("C4009", "ESD_4PF", "TVS_ESD_MOV", "SOT-23-6", { c_junction_pf: 4.5 }),
      C4010: twoPinCesm("C4010", "10uF 25V", "CAP_MLCC", "1206", { v_working_max: 25, dielectric: "X7R" }),
      C4011: makeCesm("C4011", "SHT30", "INTERFACE_XCVR", "DFN-8", [
        { pin_number: "1", pin_name: "SDA", elec_type: "OPEN_DRAIN" },
      ]),
      C4012: makeCesm("C4012", "BUCK_DS", "PMIC_DCDC", "QFN-16", [
        { pin_number: "1", pin_name: "SW", elec_type: "SW_NODE" },
        { pin_number: "2", pin_name: "FB", elec_type: "ANALOG_IN" },
      ], {}, {
        layoutExample: {
          sourceSectionTitle: "Figure 67",
          copperZones: [
            { zoneRole: "SW_PH_COMPACT_ISLAND", connectedPins: ["1"], relativeLayer: "MOUNT_LAYER", areaPolicy: "COMPACT_MIN_PARASITIC", maxAreaMm2: 20 },
          ],
          sensitiveRouteConstraints: [
            { pinOrNetRole: "FB", keepAwayFromRoles: ["SW"], minClearanceMm: 3.0 },
          ],
        },
      }),
    };

    const projectDrc: ProjectDesignRules = {
      source: "JLC_PROJECT_DRC_ONLY",
      defaultTraceWidthMm: 0.2,
      defaultClearanceMm: 0.2,
      padToPadClearanceMm: 0.2,
      viaToTrackClearanceMm: 0.2,
      pourClearanceMm: 0.3,
      componentClearanceMm: 0.3,
      boardOutlineClearanceMm: 0.5,
      minViaDrillMm: 0.3,
      minViaOuterDiaMm: 0.5,
      minSilkToPadClearanceMm: 0.15,
      copperWeightOuterOz: 1.0,
      netClasses: {
        PWR_CUSTOM: {
          name: "PWR_CUSTOM",
          nets: ["3V3_CORE"],
          minWidthMm: 1.5,
          minClearanceMm: 0.25,
          prioritySource: "project_drc",
        },
      },
    };

    const board: PcbBoardGeometrySnapshot = {
      pcbDocument: "PCB_ALL_PLINT_NEG",
      boardOutline: { widthMm: 100, heightMm: 80, layerCount: 4 },
      projectDesignRules: projectDrc,
      cesmResolver: (id) => cesm[id],
      constraintHandoff: {
        perNetRoutingRules: [
          { netName: "5V", voltageRangeV: { min: 4.75, max: 5.25 }, minWidthMm: 0.3, preferredWidthMm: 0.5, minClearanceMm: 0.15, minParallelVias: 1 },
          { netName: "3V3_CORE", voltageRangeV: { min: 3.15, max: 3.45 }, maxCurrentA: 2.0, minWidthMm: 0.8, preferredWidthMm: 1.0, minClearanceMm: 0.15, minParallelVias: 3 },
          { netName: "AC_L_220V", voltageRangeV: { min: 0, max: 311 }, minWidthMm: 0.5, preferredWidthMm: 0.8, minClearanceMm: 3.0, minParallelVias: 1, creepageDistanceMm: 6.4, requiresIsolationSlot: true, isolationDomain: "DOM_PRI" },
          { netName: "LOW_SIG", voltageRangeV: { min: 0, max: 3.3 }, minWidthMm: 0.15, preferredWidthMm: 0.2, minClearanceMm: 0.15, minParallelVias: 1, isolationDomain: "DOM_SEC" },
        ],
        emiRoleTags: [
          { netName: "USB_DP", role: "IMPEDANCE_CTRL_DIFF", targetDiffImpedanceOhm: 90, intraPairSkewMaxMm: 1.25 },
          { netName: "USB_DM", role: "IMPEDANCE_CTRL_DIFF", targetDiffImpedanceOhm: 90, intraPairSkewMaxMm: 1.25 },
        ],
        datasheetLayoutExamples: [
          { designator: "U_BUCK", lcscId: "C4012", layoutExample: cesm.C4012.layoutExample! },
        ],
        decouplingAndEsdAffinity: {
          decouplingPairs: [
            {
              capacitorDesignator: "C_DECAP_FAR",
              targetIcDesignator: "U1",
              targetPinNumber: "1",
              powerNet: "3V3_CORE",
              groundNet: "GND",
              maxPathLengthMm: 2.0,
              enforcePowerViaToCapToPinOrder: true,
            },
          ],
          esdInlineChains: [
            {
              connectorDesignator: "J_ESD",
              connectorPin: "1",
              esdDesignator: "D_ESD",
              esdPin: "1",
              targetIcDesignator: "U1",
              targetIcPin: "2",
              netName: "USB_DP",
              maxStubMm: 1.5,
              minGroundVias: 2,
            },
          ],
        },
        keepoutZones25D: [],
      },
      components: [
        // PLINT-01: 4 collinear resistors R1..R4 across clusters
        ...[0, 1, 2, 3].map((i) => ({
          primitiveId: `RQ${i}`,
          designator: `R${i + 1}`,
          lcscId: "C4001",
          package: "0402",
          category: "RES_CHIP" as const,
          layer: "TopLayer",
          centerMm: [10 + i * 3, 10] as [number, number],
          rotationDeg: 0,
          bboxMm: [9.5 + i * 3, 9.7, 10.5 + i * 3, 10.3] as [number, number, number, number],
          pads: [
            { primitiveId: `RQ${i}_1`, designator: `R${i + 1}`, padNumber: "1", net: "LOW_SIG", layer: "TopLayer", centerMm: [9.7 + i * 3, 10] as [number, number], sizeMm: [0.5, 0.5] as [number, number], copperConnection: "DIRECT_CONNECT" as const },
            { primitiveId: `RQ${i}_2`, designator: `R${i + 1}`, padNumber: "2", net: "GND", layer: "TopLayer", centerMm: [10.3 + i * 3, 10] as [number, number], sizeMm: [0.5, 0.5] as [number, number], copperConnection: "THERMAL_RELIEF" as const },
          ],
        })),
        // PLINT-02 + PLINT-05 + PLINT-06: MCU U1 + far decap C_DECAP_FAR + 5V->3.3V U_5V
        {
          primitiveId: "U1",
          designator: "U1",
          lcscId: "C4004",
          package: "LQFP-48",
          category: "MCU_SOC",
          layer: "TopLayer",
          centerMm: [40, 40],
          rotationDeg: 0,
          bboxMm: [36, 36, 44, 44],
          pads: [
            { primitiveId: "U1_1", designator: "U1", padNumber: "1", pinName: "VDD", elecType: "POWER_IN", net: "3V3_CORE", layer: "TopLayer", centerMm: [36.5, 40], sizeMm: [0.5, 0.5] },
            { primitiveId: "U1_2", designator: "U1", padNumber: "2", pinName: "PA0", elecType: "INPUT_HIZ", net: "SIG_5V_TO_3V3", layer: "TopLayer", centerMm: [43.5, 40], sizeMm: [0.5, 0.5] },
            { primitiveId: "U1_3", designator: "U1", padNumber: "3", pinName: "NRST", elecType: "INPUT_HIZ", net: null, layer: "TopLayer", centerMm: [36.5, 42], sizeMm: [0.5, 0.5] },
          ],
        },
        {
          primitiveId: "C_DECAP_FAR",
          designator: "C_DECAP_FAR",
          lcscId: "C4002",
          package: "0402",
          category: "CAP_MLCC",
          layer: "TopLayer",
          centerMm: [25, 40],
          rotationDeg: 0,
          bboxMm: [24.4, 39.7, 25.6, 40.3],
          pads: [
            { primitiveId: "CDF_1", designator: "C_DECAP_FAR", padNumber: "1", net: "5V", layer: "TopLayer", centerMm: [24.6, 40], sizeMm: [0.5, 0.5] },
            { primitiveId: "CDF_2", designator: "C_DECAP_FAR", padNumber: "2", net: "GND", layer: "TopLayer", centerMm: [25.4, 40], sizeMm: [0.5, 0.5] },
          ],
        },
        {
          primitiveId: "U_5V",
          designator: "U_5V",
          lcscId: "C4005",
          package: "SOP-8",
          category: "MCU_SOC",
          layer: "TopLayer",
          centerMm: [50, 40],
          rotationDeg: 0,
          bboxMm: [48, 38, 52, 42],
          pads: [
            { primitiveId: "U5_1", designator: "U_5V", padNumber: "1", pinName: "VDD", elecType: "POWER_IN", net: "5V", layer: "TopLayer", centerMm: [48.5, 40], sizeMm: [0.5, 0.5] },
            { primitiveId: "U5_2", designator: "U_5V", padNumber: "2", pinName: "OUT", elec_type: "PUSH_PULL", elecType: "PUSH_PULL", net: "SIG_5V_TO_3V3", layer: "TopLayer", centerMm: [51.5, 40], sizeMm: [0.5, 0.5] } as never,
          ],
        },
        // PLINT-04: Reversed polarity rotation & Type-C tied CC
        {
          primitiveId: "USB1",
          designator: "USB1",
          lcscId: "C4003",
          package: "USB-C",
          category: "CONN_USB_TYPEC",
          layer: "TopLayer",
          centerMm: [5, 60],
          rotationDeg: 0,
          frontClearanceMm: 4.0,
          bboxMm: [1, 56, 9, 64],
          pads: [
            { primitiveId: "USB_CC1", designator: "USB1", padNumber: "A5", pinName: "CC1", net: "CC_TIED", layer: "TopLayer", centerMm: [6, 59], sizeMm: [0.4, 0.8] },
            { primitiveId: "USB_CC2", designator: "USB1", padNumber: "B5", pinName: "CC2", net: "CC_TIED", layer: "TopLayer", centerMm: [6, 61], sizeMm: [0.4, 0.8] },
          ],
        },
        // PLINT-15 blocker right in front of USB1!
        {
          primitiveId: "R_BLOCK_USB",
          designator: "R_BLK",
          lcscId: "C4001",
          package: "0402",
          category: "RES_CHIP",
          layer: "TopLayer",
          centerMm: [10.5, 60],
          rotationDeg: 0,
          bboxMm: [10, 59.5, 11, 60.5],
          pads: [],
        },
        // PLINT-04 angle mismatch
        {
          primitiveId: "D_POL_BAD",
          designator: "D_POL",
          lcscId: "C4007",
          package: "SOD-123",
          category: "DIODE_SCHOTTKY",
          layer: "TopLayer",
          centerMm: [70, 20],
          rotationDeg: 180,
          expectedPolarityAngleDeg: 0,
          polarityAngleDeg: 180,
          bboxMm: [69, 19, 71, 21],
          pads: [],
        },
        // PLINT-06: Open drain I2C without pullup
        {
          primitiveId: "U_I2C",
          designator: "U_I2C",
          lcscId: "C4011",
          package: "DFN-8",
          category: "INTERFACE_XCVR",
          layer: "TopLayer",
          centerMm: [60, 50],
          rotationDeg: 0,
          bboxMm: [58, 48, 62, 52],
          sensorType: "TEMP_HUMIDITY",
          mpn: "SHT30",
          pads: [
            { primitiveId: "UI_1", designator: "U_I2C", padNumber: "1", pinName: "SDA", elecType: "OPEN_DRAIN", net: "I2C_SDA_NO_PU", layer: "TopLayer", centerMm: [59, 50], sizeMm: [0.4, 0.4] },
          ],
        },
        // PLINT-07: Relay with flyback diode 8mm away (> 3mm)
        {
          primitiveId: "K1",
          designator: "K1",
          lcscId: "C4006",
          package: "RELAY-5P",
          category: "RELAY_BUZZER",
          layer: "TopLayer",
          centerMm: [80, 30],
          rotationDeg: 0,
          bboxMm: [76, 26, 84, 34],
          pads: [
            { primitiveId: "K1_1", designator: "K1", padNumber: "1", pinName: "COIL+", net: "5V", layer: "TopLayer", centerMm: [78, 28], sizeMm: [1.0, 1.0] },
            { primitiveId: "K1_2", designator: "K1", padNumber: "2", pinName: "COIL-", net: "RLY_COIL_N", layer: "TopLayer", centerMm: [78, 32], sizeMm: [1.0, 1.0] },
          ],
        },
        {
          primitiveId: "D_FLY",
          designator: "D_FLY",
          lcscId: "C4007",
          package: "SOD-123",
          category: "DIODE_SCHOTTKY",
          layer: "TopLayer",
          centerMm: [90, 30],
          rotationDeg: 0,
          bboxMm: [89, 29, 91, 31],
          pads: [
            { primitiveId: "DF_1", designator: "D_FLY", padNumber: "1", net: "RLY_COIL_N", layer: "TopLayer", centerMm: [89.5, 30], sizeMm: [0.6, 0.6] },
            { primitiveId: "DF_2", designator: "D_FLY", padNumber: "2", net: "5V", layer: "TopLayer", centerMm: [90.5, 30], sizeMm: [0.6, 0.6] },
          ],
        },
        // PLINT-08 + PLINT-12 (heat source near SHT30 U_I2C at dist ~10mm < 15mm!): LDO 1.2W with tiny copper (< 300mm2)
        {
          primitiveId: "U_LDO",
          designator: "U_LDO",
          lcscId: "C4008",
          package: "SOT-223",
          category: "PMIC_LDO",
          layer: "TopLayer",
          centerMm: [60, 42],
          rotationDeg: 0,
          bboxMm: [58, 40, 62, 44],
          thermalPowerW: 1.2,
          pads: [
            { primitiveId: "UL_1", designator: "U_LDO", padNumber: "1", elecType: "GND", net: "GND", layer: "TopLayer", centerMm: [60, 42], sizeMm: [1.5, 1.5] },
            { primitiveId: "UL_2", designator: "U_LDO", padNumber: "2", elecType: "POWER_OUT", net: "3V3_CORE", layer: "TopLayer", centerMm: [61, 42], sizeMm: [0.8, 0.8] },
            { primitiveId: "UL_3", designator: "U_LDO", padNumber: "3", elecType: "POWER_IN", net: "5V", layer: "TopLayer", centerMm: [59, 42], sizeMm: [0.8, 0.8] },
          ],
        },
        // PLINT-09: ESD with T-stub > 1.5mm, < 2 GND vias, Cj = 4.5pF
        {
          primitiveId: "J_ESD",
          designator: "J_ESD",
          package: "CONN",
          category: "CONN_GENERIC",
          layer: "TopLayer",
          centerMm: [20, 70],
          rotationDeg: 0,
          bboxMm: [18, 68, 22, 72],
          pads: [{ primitiveId: "JE_1", designator: "J_ESD", padNumber: "1", net: "USB_DP", layer: "TopLayer", centerMm: [20, 70], sizeMm: [0.6, 0.6] }],
        },
        {
          primitiveId: "D_ESD",
          designator: "D_ESD",
          lcscId: "C4009",
          package: "SOT-23-6",
          category: "TVS_ESD_MOV",
          layer: "TopLayer",
          centerMm: [25, 75],
          rotationDeg: 0,
          bboxMm: [24, 74, 26, 76],
          pads: [
            { primitiveId: "DE_1", designator: "D_ESD", padNumber: "1", net: "USB_DP", layer: "TopLayer", centerMm: [25, 75], sizeMm: [0.5, 0.5] },
            { primitiveId: "DE_2", designator: "D_ESD", padNumber: "2", net: "GND", layer: "TopLayer", centerMm: [25.5, 75.5], sizeMm: [0.5, 0.5] },
          ],
        },
        // PLINT-12: Brittle 1206 MLCC 1.5mm from board edge (< 3.0mm)
        {
          primitiveId: "C_EDGE",
          designator: "C_EDGE",
          lcscId: "C4010",
          package: "1206",
          category: "CAP_MLCC",
          layer: "TopLayer",
          centerMm: [50, 1.5],
          rotationDeg: 0,
          bboxMm: [48.4, 0.7, 51.6, 2.3],
          pads: [],
        },
        // PLINT-17: Buck datasheet layout example violation (SW area > 20mm2 & FB near SW)
        {
          primitiveId: "U_BUCK",
          designator: "U_BUCK",
          lcscId: "C4012",
          package: "QFN-16",
          category: "PMIC_DCDC",
          layer: "TopLayer",
          centerMm: [85, 65],
          rotationDeg: 0,
          bboxMm: [83, 63, 87, 67],
          pads: [
            { primitiveId: "UBK_1", designator: "U_BUCK", padNumber: "1", pinName: "SW", net: "SW_DS", layer: "TopLayer", centerMm: [84, 65], sizeMm: [0.6, 0.6] },
            { primitiveId: "UBK_2", designator: "U_BUCK", padNumber: "2", pinName: "FB", net: "FB_DS", layer: "TopLayer", centerMm: [86, 65], sizeMm: [0.6, 0.6] },
          ],
        },
      ],
      tracks: [
        // PLINT-09 stub: straight trunk J_ESD(20,70)->U1(43.5,40) with 5mm T-branch to D_ESD(25,75)
        { primitiveId: "TR_DP_MAIN", net: "USB_DP", layer: "TopLayer", startMm: [20, 70], endMm: [25, 70], widthMm: 0.2 },
        { primitiveId: "TR_DP_MAIN2", net: "USB_DP", layer: "TopLayer", startMm: [25, 70], endMm: [43.5, 40], widthMm: 0.2 },
        { primitiveId: "TR_DP_STUB", net: "USB_DP", layer: "TopLayer", startMm: [25, 70], endMm: [25, 75], widthMm: 0.2 },
        // PLINT-18: USB_DM much shorter -> skew > 1.25mm + serpentine < 3W
        { primitiveId: "TR_DM_SHORT", net: "USB_DM", layer: "TopLayer", startMm: [20, 68], endMm: [28, 68], widthMm: 0.2 },
        { primitiveId: "TR_SERP_1", net: "USB_DP", layer: "TopLayer", startMm: [30, 50], endMm: [35, 50], widthMm: 0.2, isSerpentine: true },
        { primitiveId: "TR_SERP_2", net: "USB_DP", layer: "TopLayer", startMm: [30, 50.4], endMm: [35, 50.4], widthMm: 0.2, isSerpentine: true }, // pitch 0.4 < 3*0.2=0.6
        // PLINT-13: 3V3_CORE bottleneck width (0.2mm < project DRC 1.5mm) + single 0.3mm via carrying 2.0A + IR drop > 3%
        { primitiveId: "TR_3V3_TOP", net: "3V3_CORE", layer: "TopLayer", startMm: [61, 42], endMm: [36.5, 40], widthMm: 0.2 },
        { primitiveId: "TR_3V3_BOT", net: "3V3_CORE", layer: "BottomLayer", startMm: [36.5, 40], endMm: [10, 40], widthMm: 0.2 },
        // PLINT-14: HV 220V AC L-N too close to LOW_SIG (< 5.0mm, no slot)
        { primitiveId: "TR_HV_1", net: "AC_L_220V", layer: "TopLayer", startMm: [10, 12], endMm: [20, 12], widthMm: 0.6 },
        // PLINT-17: FB_DS trace 0.5mm from SW_DS trace (< 3.0mm)
        { primitiveId: "TR_SW_DS", net: "SW_DS", layer: "TopLayer", startMm: [84, 65], endMm: [84, 72], widthMm: 0.5 },
        { primitiveId: "TR_FB_DS", net: "FB_DS", layer: "TopLayer", startMm: [84.6, 65], endMm: [84.6, 72], widthMm: 0.2 },
      ],
      vias: [
        // PLINT-13: single 0.3mm via (0.7A) carrying 2.0A on 3V3_CORE
        { primitiveId: "VIA_3V3_SINGLE", net: "3V3_CORE", centerMm: [36.5, 40], drillMm: 0.3, outerDiaMm: 0.6 },
        // PLINT-18: diff pair via without 2 companion GND return vias within 1.0mm
        { primitiveId: "VIA_USB_DP", net: "USB_DP", centerMm: [32, 60], drillMm: 0.25, outerDiaMm: 0.5 },
      ],
      pours: [
        // PLINT-08: tiny GND pour (< 300mm2)
        makeRectPour("POUR_LDO_SMALL", "GND", "TopLayer", 55, 38, 65, 46), // 80mm2 < 300mm2
        // PLINT-16: TopLayer pour covering R_Q1 DIRECT_CONNECT pad
        makeRectPour("POUR_RQ_SOLID", "LOW_SIG", "TopLayer", 8, 8, 12, 12),
        // PLINT-17: SW_DS copper area 50mm2 > 20mm2
        makeRectPour("POUR_SW_BIG", "SW_DS", "TopLayer", 80, 62, 90, 67),
        // PLINT-18: InnerLayer1 split slot crossing USB_DP
        makeRectPour("POUR_IN1_SPLIT", "GND", "InnerLayer1", 0, 0, 100, 80, [{ x1: 22, y1: 65, x2: 22, y2: 75 }]),
      ],
      mountingHoles: [
        // PLINT-15: M3 hole at (10, 10) collides with R_Q1
        { id: "MH1", size: "M3", centerMm: [10, 10], drillMm: 3.2, keepoutDiaMm: 7.0 },
      ],
      testPoints: [
        // PLINT-15: Double-sided test points
        { id: "TP1", net: "3V3_CORE", layer: "TopLayer", centerMm: [15, 30], diameterMm: 0.8 },
        { id: "TP2", net: "GND", layer: "BottomLayer", centerMm: [18, 30], diameterMm: 0.8 },
      ],
    };

    const report = runGeometryPcbLinter(board);
    expect(report.activeDesignRuleSource).toBe("JLC_PROJECT_DRC_MERGED");
    expect(report.effectiveDesignRules.netClasses.PWR_CUSTOM.minWidthMm).toBe(1.5);
    expect(report.pass).toBe(false);

    const hitRules = new Set(report.customGeoLintFindings.map((f) => f.ruleId));
    expect(hitRules.has("PLINT-01")).toBe(true);
    expect(hitRules.has("PLINT-02")).toBe(true);
    expect(hitRules.has("PLINT-03")).toBe(true);
    expect(hitRules.has("PLINT-04")).toBe(true);
    expect(hitRules.has("PLINT-05")).toBe(true);
    expect(hitRules.has("PLINT-06")).toBe(true);
    expect(hitRules.has("PLINT-07")).toBe(true);
    expect(hitRules.has("PLINT-08")).toBe(true);
    expect(hitRules.has("PLINT-09")).toBe(true);
    expect(hitRules.has("PLINT-12")).toBe(true);
    expect(hitRules.has("PLINT-13")).toBe(true);
    expect(hitRules.has("PLINT-14")).toBe(true);
    expect(hitRules.has("PLINT-15")).toBe(true);
    expect(hitRules.has("PLINT-16")).toBe(true);
    expect(hitRules.has("PLINT-17")).toBe(true);
    expect(hitRules.has("PLINT-18")).toBe(true);
  });

  it("PLINT-14 positive: 5.2mm primary-secondary gap WITH 2.0mm isolation slot passes, while without slot fails", () => {
    const base: PcbBoardGeometrySnapshot = {
      pcbDocument: "PCB_HV_SLOT",
      boardOutline: {
        widthMm: 60,
        heightMm: 40,
        layerCount: 2,
        isolationSlots: [{ id: "SLOT1", polygon2D: [[24, 5], [26, 5], [26, 35], [24, 35]], widthMm: 2.0 }],
      },
      constraintHandoff: {
        perNetRoutingRules: [
          { netName: "AC_L", voltageRangeV: { min: 0, max: 311 }, minWidthMm: 0.6, preferredWidthMm: 0.8, minClearanceMm: 3.0, minParallelVias: 1, creepageDistanceMm: 6.4, requiresIsolationSlot: true, isolationDomain: "PRI" },
          { netName: "LOW_3V3", voltageRangeV: { min: 3.15, max: 3.45 }, minWidthMm: 0.2, preferredWidthMm: 0.3, minClearanceMm: 0.15, minParallelVias: 1, isolationDomain: "SEC" },
        ],
        emiRoleTags: [],
        datasheetLayoutExamples: [],
        decouplingAndEsdAffinity: { decouplingPairs: [], esdInlineChains: [] },
        keepoutZones25D: [],
      },
      components: [],
      tracks: [
        { primitiveId: "T_PRI", net: "AC_L", layer: "TopLayer", startMm: [22.1, 10], endMm: [22.1, 30], widthMm: 0.6 },
        { primitiveId: "T_SEC", net: "LOW_3V3", layer: "TopLayer", startMm: [27.9, 10], endMm: [27.9, 30], widthMm: 0.2 }, // edge gap = 5.8 - 0.4 = 5.4mm (>=5.0mm air, <6.4mm without slot)
      ],
      vias: [],
      pours: [],
    };
    const withSlot = runGeometryPcbLinter(base);
    expect(withSlot.customGeoLintFindings.filter((f) => f.ruleId === "PLINT-14")).toHaveLength(0);

    const withoutSlot = runGeometryPcbLinter({
      ...base,
      boardOutline: { ...base.boardOutline, isolationSlots: [] },
    });
    expect(withoutSlot.customGeoLintFindings.filter((f) => f.ruleId === "PLINT-14").length).toBeGreaterThan(0);
  });

  it("PLINT-02, PLINT-16, PLINT-18 positive compliance checks (zero false positives on clean layout)", () => {
    const cesm: Record<string, CesmModel> = {
      C5001: makeCesm("C5001", "MCU", "MCU_SOC", "LQFP-48", [{ pin_number: "1", pin_name: "VDD", elec_type: "POWER_IN" }]),
      C5002: twoPinCesm("C5002", "100nF 16V", "CAP_MLCC", "0402", { v_working_max: 16, dielectric: "X7R" }),
    };

    const cleanBoard: PcbBoardGeometrySnapshot = {
      pcbDocument: "PCB_CLEAN_REFINED",
      boardOutline: { widthMm: 80, heightMm: 60, layerCount: 4 },
      cesmResolver: (id) => cesm[id],
      constraintHandoff: {
        perNetRoutingRules: [
          { netName: "3V3", voltageRangeV: { min: 3.15, max: 3.45 }, maxCurrentA: 0.5, minWidthMm: 0.3, preferredWidthMm: 0.4, minClearanceMm: 0.15, minParallelVias: 1 },
        ],
        emiRoleTags: [
          { netName: "USB_DP", role: "IMPEDANCE_CTRL_DIFF", targetDiffImpedanceOhm: 90, intraPairSkewMaxMm: 1.25 },
          { netName: "USB_DM", role: "IMPEDANCE_CTRL_DIFF", targetDiffImpedanceOhm: 90, intraPairSkewMaxMm: 1.25 },
        ],
        datasheetLayoutExamples: [],
        decouplingAndEsdAffinity: {
          decouplingPairs: [
            {
              capacitorDesignator: "C1",
              targetIcDesignator: "U1",
              targetPinNumber: "1",
              powerNet: "3V3",
              groundNet: "GND",
              maxPathLengthMm: 2.0,
              enforcePowerViaToCapToPinOrder: true,
            },
          ],
          esdInlineChains: [],
        },
        keepoutZones25D: [],
      },
      components: [
        {
          primitiveId: "U1",
          designator: "U1",
          lcscId: "C5001",
          package: "LQFP-48",
          category: "MCU_SOC",
          layer: "TopLayer",
          centerMm: [30, 30],
          rotationDeg: 0,
          bboxMm: [26, 26, 34, 34],
          pads: [{ primitiveId: "U1_1", designator: "U1", padNumber: "1", net: "3V3", layer: "TopLayer", centerMm: [26.5, 30], sizeMm: [0.5, 0.5] }],
        },
        {
          primitiveId: "C1",
          designator: "C1",
          lcscId: "C5002",
          package: "0402",
          category: "CAP_MLCC",
          layer: "TopLayer",
          centerMm: [25, 30],
          rotationDeg: 0,
          bboxMm: [24.4, 29.7, 25.6, 30.3],
          pads: [
            { primitiveId: "C1_1", designator: "C1", padNumber: "1", net: "3V3", layer: "TopLayer", centerMm: [25.3, 30], sizeMm: [0.5, 0.5], copperConnection: "THERMAL_RELIEF" },
            { primitiveId: "C1_2", designator: "C1", padNumber: "2", net: "GND", layer: "TopLayer", centerMm: [24.7, 30], sizeMm: [0.5, 0.5], copperConnection: "THERMAL_RELIEF" },
          ],
        },
      ],
      tracks: [
        // Via(23,30) -> Cap(25.3,30) -> IC Pin(26.5,30): proper order & symmetric 0402 widths
        { primitiveId: "TR_VIA_CAP", net: "3V3", layer: "TopLayer", startMm: [23, 30], endMm: [25.3, 30], widthMm: 0.35 },
        { primitiveId: "TR_CAP_IC", net: "3V3", layer: "TopLayer", startMm: [25.3, 30], endMm: [26.5, 30], widthMm: 0.35 },
        { primitiveId: "TR_CAP_GND", net: "GND", layer: "TopLayer", startMm: [24.7, 30], endMm: [24.0, 30], widthMm: 0.3 },
        // Matched diff pair (total length 18.0mm each) with >=3W serpentine & 2 companion GND return vias <= 1.0mm
        { primitiveId: "TR_DP", net: "USB_DP", layer: "TopLayer", startMm: [40, 20], endMm: [50, 20], widthMm: 0.2 },
        { primitiveId: "TR_DM", net: "USB_DM", layer: "TopLayer", startMm: [40, 20.5], endMm: [58.0, 20.5], widthMm: 0.2 },
        { primitiveId: "TR_SERP_OK1", net: "USB_DP", layer: "TopLayer", startMm: [52, 20], endMm: [56, 20], widthMm: 0.2, isSerpentine: true },
        { primitiveId: "TR_SERP_OK2", net: "USB_DP", layer: "TopLayer", startMm: [52, 20.8], endMm: [56, 20.8], widthMm: 0.2, isSerpentine: true }, // pitch 0.8 >= 0.6 (3W)
      ],
      vias: [
        { primitiveId: "V_PWR", net: "3V3", centerMm: [23, 30], drillMm: 0.3, outerDiaMm: 0.6 },
        { primitiveId: "V_DP", net: "USB_DP", centerMm: [50, 20], drillMm: 0.25, outerDiaMm: 0.5 },
        { primitiveId: "V_DM", net: "USB_DM", centerMm: [50.4, 20.5], drillMm: 0.25, outerDiaMm: 0.5 },
        // 2 symmetric GND return vias within 1.0mm of both diff vias
        { primitiveId: "V_RET1", net: "GND", centerMm: [50.0, 19.6], drillMm: 0.3, outerDiaMm: 0.5 },
        { primitiveId: "V_RET2", net: "GND", centerMm: [50.4, 20.9], drillMm: 0.3, outerDiaMm: 0.5 },
      ],
      pours: [
        makeRectPour("POUR_IN1", "GND", "InnerLayer1", 0, 0, 80, 60),
        makeRectPour("POUR_IN2_3V3", "3V3", "InnerLayer2", 0, 0, 80, 60),
      ],
    };

    const r = runGeometryPcbLinter(cleanBoard);
    expect(r.customGeoLintFindings).toHaveLength(0);
    expect(r.pass).toBe(true);
  });

  it("PLINT-07, PLINT-08, PLINT-09 positives & PLINT-11 negative crystal violations (via/guard-ring/distance/broken-ref)", () => {
    const cesm: Record<string, CesmModel> = {
      C5101: twoPinCesm("C5101", "1N4148", "DIODE_SCHOTTKY", "SOD-123"),
      C5102: makeCesm("C5102", "RELAY", "RELAY_BUZZER", "RELAY-5P", [
        { pin_number: "1", pin_name: "COIL+", elec_type: "PASSIVE" },
        { pin_number: "2", pin_name: "COIL-", elec_type: "PASSIVE" },
      ]),
      C5103: makeCesm("C5103", "LDO_MED", "PMIC_LDO", "SOT-223", [
        { pin_number: "1", pin_name: "GND", elec_type: "GND" },
        { pin_number: "2", pin_name: "VOUT", elec_type: "POWER_OUT" },
        { pin_number: "3", pin_name: "VIN", elec_type: "POWER_IN" },
      ], { r_theta_ja_c_per_w: 65 }),
      C5104: twoPinCesm("C5104", "USBLC6", "TVS_ESD_MOV", "SOT-23-6", { c_junction_pf: 0.8 }),
      C5105: makeCesm("C5105", "8MHz", "XTAL_PASSIVE", "SMD-3225", [
        { pin_number: "1", pin_name: "X1", elec_type: "PASSIVE" },
        { pin_number: "2", pin_name: "GND", elec_type: "GND" },
        { pin_number: "3", pin_name: "X2", elec_type: "PASSIVE" },
      ]),
      C5106: makeCesm("C5106", "MCU", "MCU_SOC", "LQFP-48", [
        { pin_number: "1", pin_name: "OSC_IN", elec_type: "ANALOG_IN" },
        { pin_number: "2", pin_name: "PA0", elec_type: "INPUT_HIZ" },
      ]),
    };

    // Positive: flyback <= 3mm, LDO 0.6W with >=300mm2 GND copper, inline zero-stub ESD + 2 GND vias + 0.8pF
    const posBoard: PcbBoardGeometrySnapshot = {
      pcbDocument: "PCB_POS_07_08_09",
      boardOutline: { widthMm: 80, heightMm: 60, layerCount: 4 },
      cesmResolver: (id) => cesm[id],
      constraintHandoff: {
        perNetRoutingRules: [
          { netName: "5V", voltageRangeV: { min: 4.8, max: 5.2 }, minWidthMm: 0.3, preferredWidthMm: 0.4, minClearanceMm: 0.15, minParallelVias: 1 },
          { netName: "3V3", voltageRangeV: { min: 3.2, max: 3.4 }, minWidthMm: 0.3, preferredWidthMm: 0.4, minClearanceMm: 0.15, minParallelVias: 1 },
        ],
        emiRoleTags: [],
        datasheetLayoutExamples: [],
        decouplingAndEsdAffinity: {
          decouplingPairs: [],
          esdInlineChains: [
            {
              connectorDesignator: "J1",
              connectorPin: "1",
              esdDesignator: "D_ESD",
              esdPin: "1",
              targetIcDesignator: "U1",
              targetIcPin: "2",
              netName: "USB_DP",
              maxStubMm: 1.5,
              minGroundVias: 2,
            },
          ],
        },
        keepoutZones25D: [],
      },
      components: [
        {
          primitiveId: "K1", designator: "K1", lcscId: "C5102", package: "RELAY-5P", category: "RELAY_BUZZER",
          layer: "TopLayer", centerMm: [20, 20], rotationDeg: 0, bboxMm: [18, 18, 22, 22],
          pads: [
            { primitiveId: "K1_1", designator: "K1", padNumber: "1", pinName: "COIL+", net: "5V", layer: "TopLayer", centerMm: [19, 20], sizeMm: [0.8, 0.8] },
            { primitiveId: "K1_2", designator: "K1", padNumber: "2", pinName: "COIL-", net: "COIL_SW", layer: "TopLayer", centerMm: [21, 20], sizeMm: [0.8, 0.8] },
          ],
        },
        {
          primitiveId: "D_FLY", designator: "D_FLY", lcscId: "C5101", package: "SOD-123", category: "DIODE_SCHOTTKY",
          layer: "TopLayer", centerMm: [20, 22.2], rotationDeg: 0, bboxMm: [19, 21.6, 21, 22.8],
          pads: [
            { primitiveId: "DF_1", designator: "D_FLY", padNumber: "1", net: "COIL_SW", layer: "TopLayer", centerMm: [21, 22.2], sizeMm: [0.6, 0.6] },
            { primitiveId: "DF_2", designator: "D_FLY", padNumber: "2", net: "5V", layer: "TopLayer", centerMm: [19, 22.2], sizeMm: [0.6, 0.6] },
          ],
        },
        {
          primitiveId: "U_LDO", designator: "U_LDO", lcscId: "C5103", package: "SOT-223", category: "PMIC_LDO",
          layer: "TopLayer", centerMm: [50, 30], rotationDeg: 0, bboxMm: [48, 28, 52, 32], thermalPowerW: 0.6,
          pads: [
            { primitiveId: "UL_1", designator: "U_LDO", padNumber: "1", elecType: "GND", net: "GND", layer: "TopLayer", centerMm: [50, 30], sizeMm: [1.5, 1.5] },
            { primitiveId: "UL_2", designator: "U_LDO", padNumber: "2", elecType: "POWER_OUT", net: "3V3", layer: "TopLayer", centerMm: [51, 30], sizeMm: [0.8, 0.8] },
            { primitiveId: "UL_3", designator: "U_LDO", padNumber: "3", elecType: "POWER_IN", net: "5V", layer: "TopLayer", centerMm: [49, 30], sizeMm: [0.8, 0.8] },
          ],
        },
        {
          primitiveId: "J1", designator: "J1", package: "USB-C", category: "CONN_GENERIC",
          layer: "TopLayer", centerMm: [10, 45], rotationDeg: 0, bboxMm: [8, 43, 12, 47],
          pads: [{ primitiveId: "J1_1", designator: "J1", padNumber: "1", net: "USB_DP", layer: "TopLayer", centerMm: [10, 45], sizeMm: [0.6, 0.6] }],
        },
        {
          primitiveId: "D_ESD", designator: "D_ESD", lcscId: "C5104", package: "SOT-23-6", category: "TVS_ESD_MOV",
          layer: "TopLayer", centerMm: [15, 45], rotationDeg: 0, bboxMm: [14, 44, 16, 46],
          pads: [
            { primitiveId: "DE_1", designator: "D_ESD", padNumber: "1", net: "USB_DP", layer: "TopLayer", centerMm: [15, 45], sizeMm: [0.5, 0.5] },
            { primitiveId: "DE_2", designator: "D_ESD", padNumber: "2", net: "GND", layer: "TopLayer", centerMm: [15, 46], sizeMm: [0.5, 0.5] },
          ],
        },
        {
          primitiveId: "U1", designator: "U1", lcscId: "C5106", package: "LQFP-48", category: "MCU_SOC",
          layer: "TopLayer", centerMm: [30, 45], rotationDeg: 0, bboxMm: [26, 41, 34, 49],
          pads: [
            { primitiveId: "U1_1", designator: "U1", padNumber: "1", pinName: "OSC_IN", net: "OSC_IN", layer: "TopLayer", centerMm: [26.5, 43], sizeMm: [0.5, 0.5] },
            { primitiveId: "U1_2", designator: "U1", padNumber: "2", pinName: "PA0", net: "USB_DP", layer: "TopLayer", centerMm: [26.5, 45], sizeMm: [0.5, 0.5] },
          ],
        },
      ],
      tracks: [
        // Inline zero-stub ESD: J1(10,45) -> D_ESD(15,45) -> U1(26.5,45)
        { primitiveId: "TR_INLINE_1", net: "USB_DP", layer: "TopLayer", startMm: [10, 45], endMm: [15, 45], widthMm: 0.2 },
        { primitiveId: "TR_INLINE_2", net: "USB_DP", layer: "TopLayer", startMm: [15, 45], endMm: [26.5, 45], widthMm: 0.2 },
      ],
      vias: [
        { primitiveId: "V_ESD_1", net: "GND", centerMm: [14.7, 46.5], drillMm: 0.3, outerDiaMm: 0.6 },
        { primitiveId: "V_ESD_2", net: "GND", centerMm: [15.3, 46.5], drillMm: 0.3, outerDiaMm: 0.6 },
      ],
      pours: [
        // 400mm2 (>= 300mm2) static GND thermal copper around U_LDO
        makeRectPour("POUR_LDO_400", "GND", "TopLayer", 40, 20, 60, 40),
      ],
    };

    const rPos = runGeometryPcbLinter(posBoard);
    expect(rPos.customGeoLintFindings.filter((f) => ["PLINT-07", "PLINT-08", "PLINT-09"].includes(f.ruleId))).toHaveLength(0);

    // Negative PLINT-11: crystal > 10mm from MCU, via on OSC_IN, missing guard ring, broken Inner1 ref plane
    const badCrystalBoard: PcbBoardGeometrySnapshot = {
      pcbDocument: "PCB_BAD_XTAL",
      boardOutline: { widthMm: 80, heightMm: 60, layerCount: 4 },
      cesmResolver: (id) => cesm[id],
      components: [
        {
          primitiveId: "U1", designator: "U1", lcscId: "C5106", package: "LQFP-48", category: "MCU_SOC",
          layer: "TopLayer", centerMm: [60, 45], rotationDeg: 0, bboxMm: [56, 41, 64, 49],
          pads: [{ primitiveId: "U1_1", designator: "U1", padNumber: "1", net: "OSC_IN", layer: "TopLayer", centerMm: [56.5, 45], sizeMm: [0.5, 0.5] }],
        },
        {
          primitiveId: "Y1", designator: "Y1", lcscId: "C5105", package: "SMD-3225", category: "XTAL_PASSIVE",
          layer: "TopLayer", centerMm: [20, 20], rotationDeg: 0, bboxMm: [18.4, 18.7, 21.6, 21.3],
          pads: [
            { primitiveId: "Y1_1", designator: "Y1", padNumber: "1", net: "OSC_IN", layer: "TopLayer", centerMm: [19, 20], sizeMm: [0.8, 0.8] },
            { primitiveId: "Y1_2", designator: "Y1", padNumber: "2", net: "GND", layer: "TopLayer", centerMm: [20, 20], sizeMm: [0.8, 0.8] },
            { primitiveId: "Y1_3", designator: "Y1", padNumber: "3", net: "OSC_OUT", layer: "TopLayer", centerMm: [21, 20], sizeMm: [0.8, 0.8] },
          ],
        },
      ],
      tracks: [
        { primitiveId: "TR_BAD_CROSS", net: "FOREIGN_SIG", layer: "TopLayer", startMm: [17, 20], endMm: [23, 20], widthMm: 0.2 },
      ],
      vias: [{ primitiveId: "V_OSC", net: "OSC_IN", centerMm: [25, 25], drillMm: 0.25, outerDiaMm: 0.5 }],
      pours: [],
    };
    const rXtal = runGeometryPcbLinter(badCrystalBoard);
    const plint11Cats = new Set(rXtal.customGeoLintFindings.filter((f) => f.ruleId === "PLINT-11").map((f) => f.category));
    expect(plint11Cats.has("XTAL_TOO_FAR_FROM_IC")).toBe(true);
    expect(plint11Cats.has("XTAL_TRACE_HAS_VIA")).toBe(true);
    expect(plint11Cats.has("XTAL_MISSING_GUARD_RING")).toBe(true);
    expect(plint11Cats.has("XTAL_MOUNT_LAYER_INTRUSION")).toBe(true);
    expect(plint11Cats.has("XTAL_ADJACENT_REF_PLANE_BROKEN")).toBe(true);
  });

  it("Hole-aware PcbPourGeom.holes2D: full-board pour with carved M3 MOUNTING_HOLE holes2D yields 0 PLINT-10 false positives, while uncarved pour triggers PLINT-10 BLOCKER (and deducts holes2D from PLINT-08 net area)", () => {
    const makeCircle = (cx: number, cy: number, r: number, reverse = false): Array<[number, number]> => {
      const pts: Array<[number, number]> = [];
      const steps = 24;
      for (let i = 0; i < steps; i++) {
        const angle = (2 * Math.PI * i) / steps;
        pts.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
      }
      return reverse ? pts.reverse() : pts;
    };

    const m3Centers: Array<{ id: string; c: [number, number] }> = [
      { id: "MH1", c: [4, 4] },
      { id: "MH2", c: [76, 4] },
      { id: "MH3", c: [4, 51] },
      { id: "MH4", c: [76, 51] },
    ];

    const m3Keepouts = m3Centers.map(({ id, c }) => ({
      id: `KO_${id}`,
      category: "MOUNTING_HOLE" as const,
      ownerDesignator: id,
      polygon2D: makeCircle(c[0], c[1], 3.5),
      layerSet: ["ALL_COPPER_LAYERS"],
      disallowMask: ["COPPER_POUR", "TRACK", "VIA", "PAD", "COMPONENT"] as Array<
        "COPPER_POUR" | "TRACK" | "VIA" | "PAD" | "COMPONENT"
      >,
      allowedNets: [],
      mountSide: "ALL" as const,
    }));

    // Mix CCW and CW hole windings to ensure FillRule.NonZero orientation invariance
    const carvedHoles = m3Centers.map(({ c }, idx) => makeCircle(c[0], c[1], 3.6, idx % 2 === 1));

    const boardWithHoles: PcbBoardGeometrySnapshot = {
      pcbDocument: "PCB_POUR_HOLES_2D",
      boardOutline: { widthMm: 80, heightMm: 55, layerCount: 4 },
      components: [],
      tracks: [],
      vias: [],
      pours: [
        {
          primitiveId: "POUR_GND_TOP_CARVED",
          net: "GND",
          layer: "TopLayer",
          polygon2D: [[0.4, 0.4], [79.6, 0.4], [79.6, 54.6], [0.4, 54.6]],
          holes2D: carvedHoles,
          isSolid: true,
        },
        {
          primitiveId: "POUR_GND_IN1_CARVED",
          net: "GND",
          layer: "InnerLayer1",
          polygon2D: [[0.4, 0.4], [79.6, 0.4], [79.6, 54.6], [0.4, 54.6]],
          holes2D: carvedHoles,
          isSolid: true,
        },
      ],
      keepoutZones: m3Keepouts,
    };

    const okReport = runGeometryPcbLinter(boardWithHoles);
    expect(okReport.customGeoLintFindings.filter((f) => f.ruleId === "PLINT-10")).toHaveLength(0);
    expect(okReport.pass).toBe(true);

    // Negative: pour missing holes2D triggers PLINT-10 BLOCKER for each overlapping mounting hole
    const boardWithoutHoles: PcbBoardGeometrySnapshot = {
      ...boardWithHoles,
      pours: [
        {
          primitiveId: "POUR_GND_TOP_SOLID",
          net: "GND",
          layer: "TopLayer",
          polygon2D: [[0.4, 0.4], [79.6, 0.4], [79.6, 54.6], [0.4, 54.6]],
          isSolid: true,
        },
      ],
    };
    const badReport = runGeometryPcbLinter(boardWithoutHoles);
    const plint10 = badReport.customGeoLintFindings.filter((f) => f.ruleId === "PLINT-10");
    expect(plint10).toHaveLength(4);
    expect(plint10.every((f) => f.severity === "BLOCKER" && f.category === "25D_KEEPOUT_VIOLATION_COPPER_POUR")).toBe(true);
    expect(badReport.pass).toBe(false);

    // Bonus: PLINT-08 net copper area deducts holes2D (outer 20x16 = 320mm2, minus 6x6 = 36mm2 hole => 284mm2 < 300mm2!)
    const cesmLdo: Record<string, CesmModel> = {
      C7001: makeCesm("C7001", "LDO_NETAREA", "PMIC_LDO", "SOT-223", [
        { pin_number: "1", pin_name: "GND", elec_type: "GND" },
        { pin_number: "2", pin_name: "VOUT", elec_type: "POWER_OUT" },
        { pin_number: "3", pin_name: "VIN", elec_type: "POWER_IN" },
      ], { r_theta_ja_c_per_w: 110 }),
    };
    const ldoBoardWithHole: PcbBoardGeometrySnapshot = {
      pcbDocument: "PCB_LDO_NET_AREA",
      boardOutline: { widthMm: 60, heightMm: 50, layerCount: 2 },
      cesmResolver: (id) => cesmLdo[id],
      constraintHandoff: {
        perNetRoutingRules: [
          { netName: "5V", voltageRangeV: { min: 4.9, max: 5.1 }, minWidthMm: 0.3, preferredWidthMm: 0.4, minClearanceMm: 0.15, minParallelVias: 1 },
          { netName: "3V3", voltageRangeV: { min: 3.2, max: 3.4 }, minWidthMm: 0.3, preferredWidthMm: 0.4, minClearanceMm: 0.15, minParallelVias: 1 },
        ],
        emiRoleTags: [],
        datasheetLayoutExamples: [],
        decouplingAndEsdAffinity: { decouplingPairs: [], esdInlineChains: [] },
        keepoutZones25D: [],
      },
      components: [
        {
          primitiveId: "U_LDO",
          designator: "U_LDO",
          lcscId: "C7001",
          package: "SOT-223",
          category: "PMIC_LDO",
          layer: "TopLayer",
          centerMm: [25, 25],
          rotationDeg: 0,
          bboxMm: [23, 23, 27, 27],
          thermalPowerW: 0.65,
          pads: [
            { primitiveId: "UL_1", designator: "U_LDO", padNumber: "1", elecType: "GND", net: "GND", layer: "TopLayer", centerMm: [25, 25], sizeMm: [1.5, 1.5] },
            { primitiveId: "UL_2", designator: "U_LDO", padNumber: "2", elecType: "POWER_OUT", net: "3V3", layer: "TopLayer", centerMm: [26, 25], sizeMm: [0.8, 0.8] },
            { primitiveId: "UL_3", designator: "U_LDO", padNumber: "3", elecType: "POWER_IN", net: "5V", layer: "TopLayer", centerMm: [24, 25], sizeMm: [0.8, 0.8] },
          ],
        },
      ],
      tracks: [],
      vias: [],
      pours: [
        {
          primitiveId: "POUR_LDO_HOLED",
          net: "GND",
          layer: "TopLayer",
          polygon2D: [[20, 17], [40, 17], [40, 33], [20, 33]], // 320 mm2 outer
          holes2D: [[[30, 20], [36, 20], [36, 26], [30, 26]]], // 36 mm2 cutout -> net 284 mm2 < 300 mm2
          isSolid: true,
        },
      ],
    };
    const ldoHoledRes = runGeometryPcbLinter(ldoBoardWithHole);
    expect(ldoHoledRes.customGeoLintFindings.some((f) => f.ruleId === "PLINT-08")).toBe(true);
  });

  it("PLINT-17 sensitiveRouteConstraints: SW_PH_COMPACT_ISLAND only treats actual SW/PH/LX pads as aggressors (0 false positives on FB self-net, VIN, EN; blocks when FB is < minClearanceMm from SW/PH)", () => {
    const buckCesm: Record<string, CesmModel> = {
      C96581: makeCesm("C96581", "TPS54302", "PMIC_DCDC", "SOT-23-6", [
        { pin_number: "1", pin_name: "GND", elec_type: "GND" },
        { pin_number: "2", pin_name: "SW", elec_type: "SW_NODE" },
        { pin_number: "3", pin_name: "VIN", elec_type: "POWER_IN" },
        { pin_number: "4", pin_name: "FB", elec_type: "ANALOG_IN" },
        { pin_number: "5", pin_name: "EN", elec_type: "INPUT_HIZ" },
      ]),
    };

    const layoutExample: NonNullable<CesmModel["layoutExample"]> = {
      sourceSectionTitle: "C96581 Datasheet Layout Example",
      copperZones: [
        { zoneRole: "SW_PH_COMPACT_ISLAND", connectedPins: ["2"], relativeLayer: "MOUNT_LAYER", areaPolicy: "COMPACT_MIN_PARASITIC", maxAreaMm2: 18 },
      ],
      sensitiveRouteConstraints: [
        {
          pinOrNetRole: "FB",
          keepAwayFromRoles: ["SW_PH_COMPACT_ISLAND", "POWER_INDUCTOR"],
          minClearanceMm: 3.0,
        },
      ],
    };

    const baseSafeBoard: PcbBoardGeometrySnapshot = {
      pcbDocument: "PCB_PLINT17_SENSITIVE_FB",
      boardOutline: { widthMm: 60, heightMm: 50, layerCount: 4 },
      cesmResolver: (id) => buckCesm[id],
      constraintHandoff: {
        perNetRoutingRules: [],
        emiRoleTags: [],
        datasheetLayoutExamples: [{ designator: "U_BUCK", lcscId: "C96581", layoutExample }],
        decouplingAndEsdAffinity: { decouplingPairs: [], esdClampTargets: [] },
        highVoltageCreepagePairs: [],
        thermalCopperRequirements: [],
        criticalSignalPriority: [],
        keepout25DFiveTuples: [],
      },
      components: [
        {
          primitiveId: "U_BUCK",
          designator: "U_BUCK",
          lcscId: "C96581",
          package: "SOT-23-6",
          category: "PMIC_DCDC",
          layer: "TopLayer",
          centerMm: [25, 25],
          rotationDeg: 0,
          bboxMm: [23, 23, 27, 27],
          pads: [
            { primitiveId: "UB_1", designator: "U_BUCK", padNumber: "1", pinName: "GND", elecType: "GND", net: "GND", layer: "TopLayer", centerMm: [25.0, 23.2], sizeMm: [0.8, 0.8], copperConnection: "THERMAL_RELIEF", spokeCount: 4, spokeWidthMm: 0.25 },
            { primitiveId: "UB_2", designator: "U_BUCK", padNumber: "2", pinName: "SW", elecType: "SW_NODE", net: "BUCK_SW", layer: "TopLayer", centerMm: [27.0, 25.5], sizeMm: [0.8, 0.8] },
            { primitiveId: "UB_3", designator: "U_BUCK", padNumber: "3", pinName: "VIN", elecType: "POWER_IN", net: "VIN_24V", layer: "TopLayer", centerMm: [23.2, 26.2], sizeMm: [0.8, 0.8] },
            { primitiveId: "UB_4", designator: "U_BUCK", padNumber: "4", pinName: "FB", elecType: "ANALOG_IN", net: "BUCK_FB", layer: "TopLayer", centerMm: [23.2, 24.5], sizeMm: [0.8, 0.8] },
            { primitiveId: "UB_5", designator: "U_BUCK", padNumber: "5", pinName: "EN", elecType: "INPUT_HIZ", net: "BUCK_EN", layer: "TopLayer", centerMm: [23.2, 23.6], sizeMm: [0.8, 0.8] },
          ],
        },
      ],
      tracks: [
        // FB multi-segment route (self-intersection/self-proximity check must never fire)
        { primitiveId: "TR_FB_1", net: "BUCK_FB", layer: "TopLayer", startMm: [23.2, 24.5], endMm: [18.0, 24.5], widthMm: 0.2 },
        { primitiveId: "TR_FB_2", net: "BUCK_FB", layer: "TopLayer", startMm: [18.0, 24.5], endMm: [18.0, 20.0], widthMm: 0.2 },
        // VIN & EN intentionally routed 0.4 mm (< 3.0 mm) alongside FB
        { primitiveId: "TR_VIN", net: "VIN_24V", layer: "TopLayer", startMm: [23.2, 24.9], endMm: [18.0, 24.9], widthMm: 0.4 },
        { primitiveId: "TR_EN", net: "BUCK_EN", layer: "TopLayer", startMm: [23.2, 24.1], endMm: [18.0, 24.1], widthMm: 0.2 },
        // Actual SW route stays >= 3.8 mm away from FB on the opposite side
        { primitiveId: "TR_SW_SAFE", net: "BUCK_SW", layer: "TopLayer", startMm: [27.0, 25.5], endMm: [33.0, 25.5], widthMm: 0.6 },
      ],
      vias: [],
      pours: [],
      nativeDrcResult: { unroutedRatlineCount: 0, errors: [] },
    };

    const safeRes = runGeometryPcbLinter(baseSafeBoard);
    expect(safeRes.customGeoLintFindings.filter((f) => f.category === "SENSITIVE_FB_NEAR_SW_AGGRESSOR")).toHaveLength(0);
    expect(safeRes.customGeoLintFindings.filter((f) => f.ruleId === "PLINT-17")).toHaveLength(0);

    // Negative 1: FB passes within 0.5 mm (< 3.0 mm) of SW track -> must fire PLINT-17 BLOCKER referencing BUCK_SW only
    const nearSwRes = runGeometryPcbLinter({
      ...baseSafeBoard,
      tracks: [
        ...baseSafeBoard.tracks,
        { primitiveId: "TR_SW_BAD", net: "BUCK_SW", layer: "TopLayer", startMm: [22.0, 25.0], endMm: [18.5, 25.0], widthMm: 0.6 },
      ],
    });
    const swFindings = nearSwRes.customGeoLintFindings.filter(
      (f) => f.ruleId === "PLINT-17" && f.category === "SENSITIVE_FB_NEAR_SW_AGGRESSOR"
    );
    expect(swFindings.length).toBeGreaterThanOrEqual(1);
    expect(swFindings.every((f) => f.severity === "BLOCKER" && f.measuredValue.includes("BUCK_SW"))).toBe(true);
    expect(swFindings.some((f) => f.measuredValue.includes("BUCK_FB") || f.measuredValue.includes("VIN_24V") || f.measuredValue.includes("BUCK_EN"))).toBe(false);

    // Negative 2: PH pin without SW_NODE elecType also recognized as switching aggressor while VIN/EN stay clean
    const phBoard: PcbBoardGeometrySnapshot = {
      ...baseSafeBoard,
      components: [
        {
          ...baseSafeBoard.components[0],
          pads: baseSafeBoard.components[0].pads.map((p) =>
            p.padNumber === "2" ? { ...p, pinName: "PH", elecType: "PASSIVE", net: "BUCK_PH" } : p
          ),
        },
      ],
      tracks: [
        ...baseSafeBoard.tracks.filter((t) => t.net !== "BUCK_SW"),
        { primitiveId: "TR_PH_BAD", net: "BUCK_PH", layer: "TopLayer", startMm: [22.0, 25.3], endMm: [18.5, 25.3], widthMm: 0.6 },
      ],
    };
    const phRes = runGeometryPcbLinter(phBoard);
    const phFindings = phRes.customGeoLintFindings.filter(
      (f) => f.ruleId === "PLINT-17" && f.category === "SENSITIVE_FB_NEAR_SW_AGGRESSOR"
    );
    expect(phFindings.length).toBeGreaterThanOrEqual(1);
    expect(phFindings.every((f) => f.severity === "BLOCKER" && f.measuredValue.includes("BUCK_PH"))).toBe(true);
  });
});

// ============================================================================
// 4. Master Validator (jlc_validate 4-in-1 Gate) Tests
// ============================================================================

describe("Master Validator (jlc_validate Four-in-One Gate)", () => {
  it("passes 100/100 on synchronized, DRC-clean, SMT-ready golden mini-board and blocks on sync/unrouted/BOM/CPL failures", () => {
    const cesm: Record<string, CesmModel> = {
      C6001: makeCesm("C6001", "MCU_OK", "MCU_SOC", "LQFP-48", [
        { pin_number: "1", pin_name: "VDD", elec_type: "POWER_IN" },
        { pin_number: "2", pin_name: "VSS", elec_type: "GND" },
      ]),
      C6002: twoPinCesm("C6002", "100nF 16V", "CAP_MLCC", "0402", { v_working_max: 16, dielectric: "X7R" }),
    };

    const schComps: CompiledComponent[] = [
      makeComp("U1", "C6001", "MCU_OK", "LQFP-48", [
        { n: "1", name: "VDD", type: "POWER_IN", net: "3V3" },
        { n: "2", name: "VSS", type: "GND", net: "GND" },
      ]),
      makeCap("C1", "C6002", "100nF 16V", "0402", "3V3", "GND", cesm),
    ];

    const schNetlist = buildNetlist(schComps, "eda.sch_Netlist", "SCH_GOLDEN");
    const pcbNetlist = buildNetlist(schComps, "eda.pcb_Netlist", "PCB_GOLDEN");
    const pcbGeometry: PcbBoardGeometrySnapshot = {
      pcbDocument: "PCB_GOLDEN",
      boardOutline: { widthMm: 50, heightMm: 50, layerCount: 4 },
      components: [
        makePcbCompFromSch(schComps[0], [25, 25], "TopLayer", [9, 9], 0, {
          originAnchorType: "CENTER",
          expectedPolarityAngleDeg: 0,
          polarityAngleDeg: 0,
        }),
        makePcbCompFromSch(schComps[1], [20.8, 25], "TopLayer", [1.1, 0.6], 0, {
          originAnchorType: "CENTER",
        }),
      ],
      tracks: [
        { primitiveId: "T1", net: "3V3", layer: "TopLayer", startMm: [20.47, 25], endMm: [22.3, 25], widthMm: 0.3 },
        { primitiveId: "T2", net: "GND", layer: "TopLayer", startMm: [21.13, 25], endMm: [19.8, 25], widthMm: 0.3 },
      ],
      vias: [],
      pours: [makeRectPour("P1", "GND", "InnerLayer1", 2, 2, 48, 48)],
      nativeDrcResult: { unroutedRatlineCount: 0, errors: [] },
    };

    const okRes = runMasterValidation({
      schDocument: "SCH_GOLDEN",
      pcbDocument: "PCB_GOLDEN",
      schNetlist,
      pcbNetlist,
      pcbGeometry,
      cesmResolver: (id) => cesm[id],
    });
    expect(okRes.pass).toBe(true);
    expect(okRes.summaryScore).toBe(100);
    expect(okRes.netlistInSync).toBe(true);
    expect(okRes.electricalAuditPass).toBe(true);
    expect(okRes.pcbDrcPass).toBe(true);
    expect(okRes.unroutedNets).toBe(0);
    expect(okRes.dfmSmtReady).toBe(true);

    // Negative 1: Netlist out of sync
    const outOfSyncPcb = buildNetlist([schComps[0]], "eda.pcb_Netlist", "PCB_GOLDEN");
    const syncFail = runMasterValidation({
      schDocument: "SCH_GOLDEN",
      pcbDocument: "PCB_GOLDEN",
      schNetlist,
      pcbNetlist: outOfSyncPcb,
      pcbGeometry,
      cesmResolver: (id) => cesm[id],
    });
    expect(syncFail.pass).toBe(false);
    expect(syncFail.netlistInSync).toBe(false);

    // Negative 2: Unrouted ratlines > 0 + bad CPL polarity + missing LCSC in BOM
    const dfmAndRouteFail = runMasterValidation({
      schDocument: "SCH_GOLDEN",
      pcbDocument: "PCB_GOLDEN",
      schNetlist,
      pcbNetlist,
      pcbGeometry: {
        ...pcbGeometry,
        nativeDrcResult: { unroutedRatlineCount: 3, errors: [] },
      },
      bomEntries: [{ designator: "U1", lcscId: "" }, { designator: "C1", lcscId: "C6002" }],
      cplEntries: [
        { designator: "U1", layer: "TopLayer", xMm: 25, yMm: 25, rotationDeg: 90, expectedPolarityAngleDeg: 0, originAnchorType: "INVALID" },
      ],
      cesmResolver: (id) => cesm[id],
    });
    expect(dfmAndRouteFail.pass).toBe(false);
    expect(dfmAndRouteFail.pcbDrcPass).toBe(false);
    expect(dfmAndRouteFail.unroutedNets).toBe(3);
    expect(dfmAndRouteFail.dfmSmtReady).toBe(false);
  });
});
