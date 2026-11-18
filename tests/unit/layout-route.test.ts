import { describe, expect, it } from "vitest";
import type {
  CesmModel,
  CompiledComponent,
  CompiledNet,
  CompiledNetlist,
  ProjectDesignRules,
  SchGroupBox,
} from "../../src/types/index.js";
import {
  buildPolygonPours,
  calculateIpc2221TraceWidthMm,
  checkKeepout25DViolation,
  clusterCompiledNetlist,
  computeDiffPairPourClearanceMm,
  computeFourDimensionalSpacingMm,
  generate25DKeepoutFiveTuples,
  generateSpecctraDsn,
  getMinParallelVias,
  getSafetyClearanceSpec,
  insertAccordionMeander,
  normalizeProjectDesignRules,
  parseSpecctraSes,
  placeGndStitchingVias,
  polygonFromRectMm,
  routeDifferentialPair,
  runBuiltInGridAutoroute,
  runCriticalPrerouter,
  runHybridAutoroute,
  runPourAndStitch,
  solveModularPlacement,
  synthesizeNetClasses,
  tidySilkscreen,
} from "../../src/layout-routing/index.js";

// ============================================================================
// Helper to Build an 85+ Component Mixed-Signal Authoritative CompiledNetlist
// ============================================================================

function build85PlusMixedSignalFixture(): {
  netlist: CompiledNetlist;
  cesmMap: Map<string, CesmModel>;
} {
  const components: CompiledComponent[] = [];
  const cesmMap = new Map<string, CesmModel>();
  const netEndpoints = new Map<string, CompiledNet["endpoints"]>();

  const addPin = (
    designator: string,
    pinNumber: string,
    pinName: string,
    net: string | null,
    elecType = "PASSIVE",
    posMm?: [number, number]
  ) => {
    if (net) {
      let arr = netEndpoints.get(net);
      if (!arr) {
        arr = [];
        netEndpoints.set(net, arr);
      }
      arr.push({ designator, pinNumber, pinName, elecType });
    }
    return { pinNumber, pinName, elecType, net, posMm, isConnected: net !== null };
  };

  const makeComp = (
    designator: string,
    footprint: string,
    value: string,
    mpn: string,
    lcscId: string,
    sheetId: string,
    posMm: [number, number],
    pinDefs: Array<[string, string, string | null, string?]>
  ) => {
    components.push({
      primitiveId: `prim_${designator}`,
      designator,
      lcscId,
      mpn,
      value,
      footprint,
      sheetId,
      posMm,
      rotationDeg: 0,
      pins: pinDefs.map(([pn, pName, net, eType], idx) =>
        addPin(designator, pn, pName, net, eType ?? "PASSIVE", [
          posMm[0] + (idx % 2 === 0 ? -2 : 2),
          posMm[1],
        ])
      ),
    });
  };

  // --- 1. USB Type-C + ESD + Dual 5.1k CC + Fuse (5 components, Box 1) ---
  makeComp("J1", "USB-C-SMD-16P", "TYPE-C-16P", "TYPE-C-31-M-12", "C2765186", "S1", [20, 40], [
    ["A1", "GND", "GND", "GND"],
    ["A4", "VBUS", "VBUS_RAW", "POWER_OUT"],
    ["A5", "CC1", "USB_CC1", "BIDIR_IO"],
    ["B5", "CC2", "USB_CC2", "BIDIR_IO"],
    ["A6", "DP1", "USB_DP_EXT", "BIDIR_IO"],
    ["A7", "DM1", "USB_DM_EXT", "BIDIR_IO"],
  ]);
  makeComp("F1", "R0805", "1.5A_PTC", "SMD0805P150TF", "C70058", "S1", [28, 40], [
    ["1", "1", "VBUS_RAW"],
    ["2", "2", "VBUS_20V"],
  ]);
  makeComp("U2", "SOT-23-6", "USBLC6-2SC6", "USBLC6-2SC6", "C7519", "S1", [28, 45], [
    ["1", "IO1", "USB_DP_EXT"],
    ["2", "GND", "GND", "GND"],
    ["3", "IO2", "USB_DM_EXT"],
    ["4", "IO2_OUT", "USB_DM"],
    ["5", "VBUS", "VBUS_20V"],
    ["6", "IO1_OUT", "USB_DP"],
  ]);
  cesmMap.set("U2", {
    lcsc_id: "C7519",
    mpn: "USBLC6-2SC6",
    category: "TVS_ESD_MOV",
    package: "SOT-23-6",
    verified: true,
    pins: [],
    ratings: { v_rwm_v: 5.25, c_junction_pf: 2.8 },
  });
  makeComp("R1", "R0402", "5.1k", "0402WGF5101TCE", "C25905", "S1", [22, 34], [
    ["1", "1", "USB_CC1"],
    ["2", "2", "GND"],
  ]);
  makeComp("R2", "R0402", "5.1k", "0402WGF5101TCE", "C25905", "S1", [25, 34], [
    ["1", "1", "USB_CC2"],
    ["2", "2", "GND"],
  ]);
  makeComp("C1", "C0603", "100nF", "CC0603KRX7R9BB104", "C14663", "S1", [30, 35], [
    ["1", "1", "VBUS_20V"],
    ["2", "2", "GND"],
  ]);

  // --- 2. DC-DC Buck Stage with CESM layoutExample (10 components, Box 2) ---
  makeComp("U3", "QFN-16_3x3", "TPS54302", "TPS54302DDCR", "C96581", "S1", [65, 45], [
    ["1", "GND", "GND", "GND"],
    ["2", "SW", "BUCK_SW", "SW_NODE"],
    ["3", "VIN", "VBUS_20V", "POWER_IN"],
    ["4", "FB", "BUCK_FB", "ANALOG_IN"],
    ["5", "EN", "BUCK_EN", "INPUT_HIZ"],
    ["6", "BOOT", "BUCK_BOOT", "PASSIVE"],
    ["EP", "EPAD", "GND", "GND"],
  ]);
  cesmMap.set("U3", {
    lcsc_id: "C96581",
    mpn: "TPS54302DDCR",
    category: "PMIC_DCDC",
    package: "QFN-16",
    verified: true,
    pins: [],
    ratings: { v_working_max: 28, tj_max_c: 150 },
    layoutExample: {
      sourceSectionTitle: "10.2 Layout Example (Figure 67)",
      referenceImageUri: "cesm://C96581/fig67.png",
      copperZones: [
        {
          zoneRole: "VIN_POLYGON",
          connectedPins: ["3"],
          relativeLayer: "MOUNT_LAYER",
          areaPolicy: "WIDE_LOW_INDUCTANCE",
        },
        {
          zoneRole: "SW_PH_COMPACT_ISLAND",
          connectedPins: ["2"],
          relativeLayer: "MOUNT_LAYER",
          areaPolicy: "COMPACT_MIN_PARASITIC",
          maxAreaMm2: 24.0,
        },
        {
          zoneRole: "VOUT_POLYGON",
          connectedPins: ["3V3"],
          relativeLayer: "MOUNT_LAYER",
          areaPolicy: "WIDE_LOW_INDUCTANCE",
        },
        {
          zoneRole: "TOPSIDE_GND_AREA",
          connectedPins: ["1", "EP"],
          relativeLayer: "MOUNT_LAYER",
          areaPolicy: "THERMAL_SPREADING",
        },
      ],
      relativePlacementHints: [
        {
          componentRole: "HOT_LOOP_CIN_HF",
          targetPins: ["3", "1"],
          preferredQuadrantDeg: 180,
          maxDistanceMm: 3.5,
          sameLayerMandatory: true,
        },
        {
          componentRole: "POWER_INDUCTOR",
          targetPins: ["2"],
          preferredQuadrantDeg: 0,
          maxDistanceMm: 5.0,
          sameLayerMandatory: true,
        },
        {
          componentRole: "BOOT_CAP",
          targetPins: ["6", "2"],
          preferredQuadrantDeg: 90,
          maxDistanceMm: 3.0,
          sameLayerMandatory: true,
        },
        {
          componentRole: "FB_DIVIDER",
          targetPins: ["4"],
          preferredQuadrantDeg: 270,
          maxDistanceMm: 3.2,
          sameLayerMandatory: true,
        },
      ],
      viaHints: [
        { viaRole: "GND_RETURN_CLUSTER", targetNetRole: "GND", policy: "2 vias adjacent CIN GND" },
        { viaRole: "FORBID_VIA_IN_HOT_LOOP", targetNetRole: "BUCK_SW", policy: "No vias on SW" },
      ],
      thermalViaArray: {
        epadPinNumber: "EP",
        netRole: "GND",
        gridRows: 3,
        gridCols: 3,
        drillMm: 0.3,
        pitchMm: 1.0,
        solderMaskTentingOrPlug: true,
      },
      sensitiveRouteConstraints: [
        {
          pinOrNetRole: "BUCK_FB",
          keepAwayFromRoles: ["SW_PH_COMPACT_ISLAND", "POWER_INDUCTOR"],
          minClearanceMm: 2.5,
          preferInnerOrOppositeLayer: false,
          tapPointRule: "AFTER_LAST_COUT_PAD",
        },
      ],
    },
  });
  makeComp("L1", "IND-SMD-5050", "10uH", "SWPA5040S100MT", "C167213", "S1", [74, 45], [
    ["1", "1", "BUCK_SW"],
    ["2", "2", "3V3"],
  ]);
  cesmMap.set("L1", {
    lcsc_id: "C167213",
    mpn: "SWPA5040S100MT",
    category: "IND_POWER",
    package: "IND-SMD-5050",
    verified: true,
    pins: [],
    ratings: { i_sat_a: 3.2, i_rms_a: 2.5 },
  });
  makeComp("C2", "C0805", "10uF", "CL21A106KOQNNNE", "C15850", "S1", [61, 45], [
    ["1", "1", "VBUS_20V"],
    ["2", "2", "GND"],
  ]);
  makeComp("C3", "C0402", "100nF", "CC0402KRX7R7BB104", "C1525", "S1", [62, 47], [
    ["1", "1", "VBUS_20V"],
    ["2", "2", "GND"],
  ]);
  makeComp("C4", "C0402", "100nF", "CC0402KRX7R7BB104", "C1525", "S1", [66, 51], [
    ["1", "1", "BUCK_BOOT"],
    ["2", "2", "BUCK_SW"],
  ]);
  makeComp("R3", "R0402", "100k", "0402WGF1003TCE", "C25741", "S1", [61, 39], [
    ["1", "1", "VBUS_20V"],
    ["2", "2", "BUCK_EN"],
  ]);
  makeComp("R4", "R0402", "33k", "0402WGF3302TCE", "C25777", "S1", [68, 39], [
    ["1", "1", "3V3"],
    ["2", "2", "BUCK_FB"],
  ]);
  makeComp("R5", "R0402", "10k", "0402WGF1002TCE", "C25744", "S1", [68, 36], [
    ["1", "1", "BUCK_FB"],
    ["2", "2", "GND"],
  ]);
  makeComp("C5", "C0805", "22uF", "CL21A226MAYNNNE", "C45783", "S1", [78, 45], [
    ["1", "1", "3V3"],
    ["2", "2", "GND"],
  ]);
  makeComp("C6", "C0805", "22uF", "CL21A226MAYNNNE", "C45783", "S1", [81, 45], [
    ["1", "1", "3V3"],
    ["2", "2", "GND"],
  ]);

  // --- 3. Low-Noise LDO Stage (4 components, Box 3) ---
  makeComp("U4", "SOT-23-5", "TLV75533PDBVR", "TLV75533PDBVR", "C475214", "S1", [65, 80], [
    ["1", "IN", "5V", "POWER_IN"],
    ["2", "GND", "GND", "GND"],
    ["3", "EN", "LDO_EN", "INPUT_HIZ"],
    ["4", "NC", "LDO_BYP", "PASSIVE"],
    ["5", "OUT", "3V3_ANA", "POWER_OUT"],
  ]);
  cesmMap.set("U4", {
    lcsc_id: "C475214",
    mpn: "TLV75533PDBVR",
    category: "PMIC_LDO",
    package: "SOT-23-5",
    verified: true,
    pins: [],
    ratings: { mlcc_output_stable: true, r_theta_ja_c_per_w: 185, tj_max_c: 125 },
  });
  makeComp("C7", "C0603", "1uF", "CL10A105KB8NNNC", "C15849", "S1", [60, 80], [
    ["1", "1", "5V"],
    ["2", "2", "GND"],
  ]);
  makeComp("C8", "C0603", "2.2uF", "CL10A225KA8NNNC", "C23630", "S1", [70, 80], [
    ["1", "1", "3V3_ANA"],
    ["2", "2", "GND"],
  ]);
  makeComp("C9", "C0402", "10nF", "CC0402KRX7R9BB103", "C15195", "S1", [65, 85], [
    ["1", "1", "LDO_BYP"],
    ["2", "2", "GND"],
  ]);
  makeComp("R6", "R0402", "10k", "0402WGF1002TCE", "C25744", "S1", [61, 84], [
    ["1", "1", "5V"],
    ["2", "2", "LDO_EN"],
  ]);

  // --- 4. STM32 MCU Core + 4x100nF + Bulk + Crystal + Bus + Pullups (26 components, Box 4) ---
  const mcuPins: Array<[string, string, string | null, string?]> = [
    ["19", "VDD_1", "3V3", "POWER_IN"],
    ["18", "VSS_1", "GND", "GND"],
    ["32", "VDD_2", "3V3", "POWER_IN"],
    ["31", "VSS_2", "GND", "GND"],
    ["48", "VDD_3", "3V3", "POWER_IN"],
    ["47", "VSS_3", "GND", "GND"],
    ["64", "VDD_4", "3V3", "POWER_IN"],
    ["63", "VSS_4", "GND", "GND"],
    ["13", "VDDA", "MCU_VDDA", "POWER_IN"],
    ["12", "VSSA", "GND", "GND"],
    ["5", "OSC_IN", "OSC_IN", "ANALOG_IN"],
    ["6", "OSC_OUT", "OSC_OUT", "ANALOG_OUT"],
    ["7", "NRST", "MCU_NRST", "INPUT_HIZ"],
    ["60", "BOOT0", "MCU_BOOT0", "INPUT_HIZ"],
    ["44", "PA11", "USB_DM", "BIDIR_IO"],
    ["45", "PA12", "USB_DP", "BIDIR_IO"],
    ["58", "PB6", "I2C_SCL", "OPEN_DRAIN"],
    ["59", "PB7", "I2C_SDA", "OPEN_DRAIN"],
    ["42", "PA9", "UART_TX", "PUSH_PULL"],
    ["43", "PA10", "UART_RX", "INPUT_HIZ"],
    ["21", "PA5", "SPI_SCK", "PUSH_PULL"],
    ["22", "PA6", "SPI_MISO", "INPUT_HIZ"],
    ["23", "PA7", "SPI_MOSI", "PUSH_PULL"],
    ["20", "PA4", "SPI_CS_ADC", "PUSH_PULL"],
    ["14", "PA0", "ADC_SENSE_IN", "ANALOG_IN"],
    ["25", "PB0", "RELAY_CTRL", "PUSH_PULL"],
    ["26", "PB1", "LED_SYS", "PUSH_PULL"],
    ["27", "PB2", "RF_UART_TX", "PUSH_PULL"],
    ["28", "PB10", "RF_UART_RX", "INPUT_HIZ"],
  ];
  for (let d = 0; d < 8; d++) {
    mcuPins.push([String(33 + d), `PD${d}`, `DQ${d}`, "BIDIR_IO"]);
  }
  makeComp("U1", "LQFP-64_10x10", "STM32F405RGT6", "STM32F405RGT6", "C15742", "S2", [120, 60], mcuPins);
  cesmMap.set("U1", {
    lcsc_id: "C15742",
    mpn: "STM32F405RGT6",
    category: "MCU_SOC",
    package: "LQFP-64",
    verified: true,
    pins: [],
    ratings: { v_working_max: 3.6 },
  });

  // 4x 100nF Decoupling caps + 1x 4.7uF Bulk cap clustered near U1 on schematic (same Box 4!)
  for (let i = 0; i < 4; i++) {
    makeComp(`C${10 + i}`, "C0402", "100nF", "CC0402KRX7R7BB104", "C1525", "S2", [112 + i * 2, 50], [
      ["1", "1", "3V3"],
      ["2", "2", "GND"],
    ]);
  }
  makeComp("C14", "C0805", "4.7uF", "CL21A475KAQNNNE", "C1779", "S2", [110, 50], [
    ["1", "1", "3V3"],
    ["2", "2", "GND"],
  ]);
  // VDDA isolation bead + 2 caps
  makeComp("FB1", "L0603", "600R@100MHz", "MMZ1608B601CTA00", "C1002", "S2", [105, 62], [
    ["1", "1", "3V3"],
    ["2", "2", "MCU_VDDA"],
  ]);
  cesmMap.set("FB1", {
    lcsc_id: "C1002",
    mpn: "MMZ1608B601CTA00",
    category: "FERRITE_CMC",
    package: "0603",
    verified: true,
    pins: [],
    ratings: { i_rms_a: 0.5 },
  });
  makeComp("C15", "C0402", "100nF", "CC0402KRX7R7BB104", "C1525", "S2", [105, 66], [
    ["1", "1", "MCU_VDDA"],
    ["2", "2", "GND"],
  ]);
  makeComp("C16", "C0603", "1uF", "CL10A105KB8NNNC", "C15849", "S2", [103, 66], [
    ["1", "1", "MCU_VDDA"],
    ["2", "2", "GND"],
  ]);

  // Passive Crystal Y1 + 2x C0G Load Caps
  makeComp("Y1", "SMD-3225-4P", "8MHz", "X32258MSB4SI", "C115962", "S2", [112, 72], [
    ["1", "XIN", "OSC_IN"],
    ["2", "GND1", "GND"],
    ["3", "XOUT", "OSC_OUT"],
    ["4", "GND2", "GND"],
  ]);
  cesmMap.set("Y1", {
    lcsc_id: "C115962",
    mpn: "X32258MSB4SI",
    category: "XTAL_PASSIVE",
    package: "SMD-3225-4P",
    verified: true,
    pins: [],
    ratings: {},
  });
  makeComp("C17", "C0402", "18pF", "CC0402JRNPO9BN180", "C1552", "S2", [109, 75], [
    ["1", "1", "OSC_IN"],
    ["2", "2", "GND"],
  ]);
  makeComp("C18", "C0402", "18pF", "CC0402JRNPO9BN180", "C1552", "S2", [115, 75], [
    ["1", "1", "OSC_OUT"],
    ["2", "2", "GND"],
  ]);

  // NRST, BOOT0, I2C pullups, LED, Parallel bus termination resistor pack items
  makeComp("R7", "R0402", "10k", "0402WGF1002TCE", "C25744", "S2", [122, 72], [
    ["1", "1", "3V3"],
    ["2", "2", "MCU_NRST"],
  ]);
  makeComp("C19", "C0402", "100nF", "CC0402KRX7R7BB104", "C1525", "S2", [122, 75], [
    ["1", "1", "MCU_NRST"],
    ["2", "2", "GND"],
  ]);
  makeComp("R8", "R0402", "10k", "0402WGF1002TCE", "C25744", "S2", [126, 72], [
    ["1", "1", "MCU_BOOT0"],
    ["2", "2", "GND"],
  ]);
  makeComp("R9", "R0402", "4.7k", "0402WGF4701TCE", "C25900", "S2", [132, 55], [
    ["1", "1", "3V3"],
    ["2", "2", "I2C_SCL"],
  ]);
  makeComp("R10", "R0402", "4.7k", "0402WGF4701TCE", "C25900", "S2", [132, 58], [
    ["1", "1", "3V3"],
    ["2", "2", "I2C_SDA"],
  ]);
  makeComp("R11", "R0402", "1k", "0402WGF1001TCE", "C11702", "S2", [132, 62], [
    ["1", "1", "LED_SYS"],
    ["2", "2", "LED_K"],
  ]);
  makeComp("D1", "LED-0603", "GREEN", "19-217/GHC-YR1S2/3T", "C72043", "S2", [135, 62], [
    ["1", "A", "LED_K"],
    ["2", "K", "GND"],
  ]);
  // 8x series resistors on DQ0..DQ7 parallel bus + SRAM U8 (gives DQ0..DQ7 valid bus endpoints)
  for (let d = 0; d < 8; d++) {
    makeComp(`R${12 + d}`, "R0402", "33R", "0402WGF330JTCE", "C25105", "S2", [136, 40 + d * 2], [
      ["1", "1", `DQ${d}`],
      ["2", "2", `MEM_DQ${d}`],
    ]);
  }
  const sramPins: Array<[string, string, string | null, string?]> = [
    ["1", "VDD", "3V3", "POWER_IN"],
    ["2", "GND", "GND", "GND"],
    ["3", "CS", "SPI_CS_ADC", "INPUT_HIZ"],
  ];
  for (let d = 0; d < 8; d++) {
    sramPins.push([String(4 + d), `D${d}`, `MEM_DQ${d}`, "BIDIR_IO"]);
  }
  makeComp("U8", "TSSOP-16", "IS62WV2568", "IS62WV2568BLL", "C99001", "S2", [145, 50], sramPins);
  makeComp("C20", "C0402", "100nF", "CC0402KRX7R7BB104", "C1525", "S2", [145, 42], [
    ["1", "1", "3V3"],
    ["2", "2", "GND"],
  ]);

  // --- 5. Precision Analog Front-End + Current Shunt Resistor (11 components, Box 5) ---
  makeComp("U5", "SOIC-8", "OPA2333", "OPA2333AIDR", "C12948", "S3", [40, 120], [
    ["1", "OUTA", "ADC_SENSE_IN", "ANALOG_OUT"],
    ["2", "INA-", "AMP_INN", "ANALOG_IN"],
    ["3", "INA+", "SHUNT_SENSE_P", "ANALOG_IN"],
    ["4", "V-", "GND", "GND"],
    ["5", "INB+", "SHUNT_SENSE_N", "ANALOG_IN"],
    ["8", "V+", "3V3_ANA", "POWER_IN"],
  ]);
  cesmMap.set("U5", {
    lcsc_id: "C12948",
    mpn: "OPA2333AIDR",
    category: "OPAMP_COMP",
    package: "SOIC-8",
    verified: true,
    pins: [],
    ratings: { v_working_max: 5.5 },
  });
  makeComp("R20", "R2512", "10mR", "WSL2512R0100FEA", "C20291", "S3", [25, 120], [
    ["1", "1", "SHUNT_SENSE_P"],
    ["2", "2", "SHUNT_SENSE_N"],
  ]);
  cesmMap.set("R20", {
    lcsc_id: "C20291",
    mpn: "WSL2512R0100FEA",
    category: "RES_SHUNT",
    package: "2512",
    verified: true,
    pins: [],
    ratings: { power_rated_w: 1.0 },
  });
  makeComp("R21", "R0603", "1k", "0603WAF1001T5E", "C21190", "S3", [33, 118], [
    ["1", "1", "SHUNT_SENSE_N"],
    ["2", "2", "AMP_INN"],
  ]);
  makeComp("R22", "R0603", "20k", "0603WAF2002T5E", "C4184", "S3", [37, 115], [
    ["1", "1", "AMP_INN"],
    ["2", "2", "ADC_SENSE_IN"],
  ]);
  makeComp("C21", "C0402", "100nF", "CC0402KRX7R7BB104", "C1525", "S3", [43, 126], [
    ["1", "1", "3V3_ANA"],
    ["2", "2", "GND"],
  ]);
  makeComp("C22", "C0603", "10uF", "CL10A106KP8NNNC", "C19702", "S3", [46, 126], [
    ["1", "1", "3V3_ANA"],
    ["2", "2", "GND"],
  ]);
  makeComp("C23", "C0402", "100pF", "CC0402JRNPO9BN101", "C1546", "S3", [37, 112], [
    ["1", "1", "AMP_INN"],
    ["2", "2", "ADC_SENSE_IN"],
  ]);
  // Additional I2C temperature sensor U9 + SPI ADC U10 in analog box (7 more parts)
  makeComp("U9", "MSOP-8", "ADS1115", "ADS1115IDGSR", "C37593", "S3", [55, 120], [
    ["1", "ADDR", "GND"],
    ["4", "GND", "GND", "GND"],
    ["8", "VDD", "3V3_ANA", "POWER_IN"],
    ["9", "SDA", "I2C_SDA", "OPEN_DRAIN"],
    ["10", "SCL", "I2C_SCL", "OPEN_DRAIN"],
    ["5", "AIN0", "ADC_SENSE_IN", "ANALOG_IN"],
  ]);
  makeComp("R23", "R0402", "47R", "0402WGF470JTCE", "C25117", "S3", [50, 120], [
    ["1", "1", "ADC_SENSE_IN"],
    ["2", "2", "ADC_AIN0_FILT"],
  ]);
  makeComp("C24", "C0402", "10nF", "CC0402KRX7R9BB103", "C15195", "S3", [52, 124], [
    ["1", "1", "ADC_AIN0_FILT"],
    ["2", "2", "GND"],
  ]);
  makeComp("C25", "C0402", "100nF", "CC0402KRX7R7BB104", "C1525", "S3", [55, 126], [
    ["1", "1", "3V3_ANA"],
    ["2", "2", "GND"],
  ]);

  // --- 6. Electromechanical Relay + MOSFET Driver Block (10 components, Box 6) ---
  makeComp("Q1", "SOT-23", "AO3400A", "AO3400A", "C20917", "S4", [110, 120], [
    ["1", "G", "MOS_GATE"],
    ["2", "S", "GND", "GND"],
    ["3", "D", "RELAY_COIL_N"],
  ]);
  cesmMap.set("Q1", {
    lcsc_id: "C20917",
    mpn: "AO3400A",
    category: "MOSFET_BJT",
    package: "SOT-23",
    verified: true,
    pins: [],
    ratings: { vgs_rated_for_rdson_min_v: 2.5 },
  });
  makeComp("R24", "R0402", "22R", "0402WGF220JTCE", "C25092", "S4", [105, 120], [
    ["1", "1", "RELAY_CTRL"],
    ["2", "2", "MOS_GATE"],
  ]);
  makeComp("R25", "R0402", "20k", "0402WGF2002TCE", "C25765", "S4", [107, 124], [
    ["1", "1", "MOS_GATE"],
    ["2", "2", "GND"],
  ]);
  makeComp("K1", "RELAY-SMD-5P", "HK4100F-DC5V", "HK4100F-DC5V-SHG", "C12841", "S4", [122, 120], [
    ["1", "COIL1", "5V"],
    ["2", "COIL2", "RELAY_COIL_N"],
    ["3", "COM", "LOAD_COM"],
    ["4", "NO", "LOAD_NO"],
  ]);
  cesmMap.set("K1", {
    lcsc_id: "C12841",
    mpn: "HK4100F-DC5V-SHG",
    category: "RELAY_BUZZER",
    package: "RELAY-5P",
    verified: true,
    pins: [],
    ratings: {},
  });
  makeComp("D2", "SOD-123", "1N4148W", "1N4148W", "C81598", "S4", [116, 124], [
    ["1", "K", "5V"],
    ["2", "A", "RELAY_COIL_N"],
  ]);
  makeComp("C26", "C0603", "100nF", "CC0603KRX7R9BB104", "C14663", "S4", [116, 115], [
    ["1", "1", "5V"],
    ["2", "2", "GND"],
  ]);
  makeComp("J2", "TERM-2P-5.08", "KF301-2P", "KF301-5.0-2P", "C8460", "S4", [135, 120], [
    ["1", "1", "LOAD_COM"],
    ["2", "2", "LOAD_NO"],
  ]);
  makeComp("R26", "R1206", "100R", "1206W4F1000T5E", "C17901", "S4", [130, 126], [
    ["1", "1", "LOAD_COM"],
    ["2", "2", "SNUB_MID"],
  ]);
  makeComp("C27", "C1206", "100nF", "CL31B104KBCNNNC", "C24497", "S4", [134, 126], [
    ["1", "1", "SNUB_MID"],
    ["2", "2", "LOAD_NO"],
  ]);

  // --- 7. RF Wireless Block (ESP32 / BLE + Pi-Match + Decaps, 8 components, Box 7) ---
  makeComp("U7", "ESP32-WROOM-32E", "ESP32-WROOM-32E", "ESP32-WROOM-32E-N8", "C701342", "S5", [175, 25], [
    ["1", "GND", "GND", "GND"],
    ["2", "3V3", "3V3", "POWER_IN"],
    ["3", "EN", "RF_EN", "INPUT_HIZ"],
    ["34", "RXD0", "RF_UART_TX", "INPUT_HIZ"],
    ["35", "TXD0", "RF_UART_RX", "PUSH_PULL"],
    ["38", "GND_EP", "GND", "GND"],
    ["39", "ANT", "RF_ANT_NET", "ANALOG_OUT"],
  ]);
  makeComp("C28", "C0805", "22uF", "CL21A226MAYNNNE", "C45783", "S5", [170, 20], [
    ["1", "1", "3V3"],
    ["2", "2", "GND"],
  ]);
  makeComp("C29", "C0402", "100nF", "CC0402KRX7R7BB104", "C1525", "S5", [170, 24], [
    ["1", "1", "3V3"],
    ["2", "2", "GND"],
  ]);
  makeComp("R27", "R0402", "10k", "0402WGF1002TCE", "C25744", "S5", [172, 30], [
    ["1", "1", "3V3"],
    ["2", "2", "RF_EN"],
  ]);
  makeComp("C30", "C0402", "1uF", "CL05A105KA5NQNC", "C52923", "S5", [172, 33], [
    ["1", "1", "RF_EN"],
    ["2", "2", "GND"],
  ]);
  makeComp("C31", "C0402", "1.5pF", "GJM1555C1H1R5WB01D", "C1540", "S5", [180, 25], [
    ["1", "1", "RF_ANT_NET"],
    ["2", "2", "RF_ANT_FEED"],
  ]);
  makeComp("L2", "L0402", "2.7nH", "LQW15AN2N7C00D", "C91002", "S5", [183, 25], [
    ["1", "1", "RF_ANT_FEED"],
    ["2", "2", "GND"],
  ]);
  makeComp("ANT1", "IPEX-SMD", "IPEX-RF", "U.FL-R-SMT-1", "C88374", "S5", [188, 25], [
    ["1", "SIG", "RF_ANT_FEED"],
    ["2", "GND", "GND"],
  ]);

  // --- 8. RS-485 Interface Transceiver + Termination (8 components, Box 8) ---
  makeComp("U6", "SOIC-8", "SP3485EN", "SP3485EN-L/TR", "C8963", "S6", [175, 95], [
    ["1", "RO", "UART_RX", "PUSH_PULL"],
    ["2", "RE", "RS485_DIR", "INPUT_HIZ"],
    ["3", "DE", "RS485_DIR", "INPUT_HIZ"],
    ["4", "DI", "UART_TX", "INPUT_HIZ"],
    ["5", "GND", "GND", "GND"],
    ["6", "A", "RS485_A", "BIDIR_IO"],
    ["7", "B", "RS485_B", "BIDIR_IO"],
    ["8", "VCC", "3V3", "POWER_IN"],
  ]);
  cesmMap.set("U6", {
    lcsc_id: "C8963",
    mpn: "SP3485EN-L/TR",
    category: "INTERFACE_XCVR",
    package: "SOIC-8",
    verified: true,
    pins: [],
    ratings: {},
  });
  makeComp("C32", "C0402", "100nF", "CC0402KRX7R7BB104", "C1525", "S6", [175, 89], [
    ["1", "1", "3V3"],
    ["2", "2", "GND"],
  ]);
  makeComp("R28", "R0805", "120R", "0805W8F1200T5E", "C17440", "S6", [182, 95], [
    ["1", "1", "RS485_A"],
    ["2", "2", "RS485_B"],
  ]);
  makeComp("R29", "R0402", "10k", "0402WGF1002TCE", "C25744", "S6", [172, 100], [
    ["1", "1", "RS485_DIR"],
    ["2", "2", "GND"],
  ]);
  makeComp("D3", "SOT-23", "SM712", "SM712-02HTG", "C184145", "S6", [186, 95], [
    ["1", "A", "RS485_A"],
    ["2", "B", "RS485_B"],
    ["3", "GND", "GND"],
  ]);
  cesmMap.set("D3", {
    lcsc_id: "C184145",
    mpn: "SM712-02HTG",
    category: "TVS_ESD_MOV",
    package: "SOT-23",
    verified: true,
    pins: [],
    ratings: {},
  });
  makeComp("J3", "TERM-3P-3.81", "RS485_CONN", "WJ15EDGK-3.81-3P", "C18910", "S6", [192, 95], [
    ["1", "A", "RS485_A"],
    ["2", "B", "RS485_B"],
    ["3", "GND", "GND"],
  ]);

  // --- 9. Extra Bypass/Test/Debug Header & Auxiliary Passives to reach 85+ components ---
  makeComp("J4", "HDR-4P-2.54", "SWD_HDR", "PH2.54-4P", "C492401", "S2", [145, 78], [
    ["1", "VCC", "3V3"],
    ["2", "SWDIO", "SWD_IO"],
    ["3", "SWCLK", "SWD_CLK"],
    ["4", "GND", "GND"],
  ]);
  makeComp("R30", "R0402", "22R", "0402WGF220JTCE", "C25092", "S2", [140, 78], [
    ["1", "1", "SWD_IO"],
    ["2", "2", "MCU_BOOT0"],
  ]);
  makeComp("R31", "R0402", "22R", "0402WGF220JTCE", "C25092", "S2", [140, 81], [
    ["1", "1", "SWD_CLK"],
    ["2", "2", "MCU_NRST"],
  ]);
  // Additional 12 decoupling/pull-up/LED indicator components across MCU/Power/IO so total >= 85
  for (let i = 0; i < 6; i++) {
    makeComp(`C${33 + i}`, "C0201", "100nF", "CC0201KRX7R5BB104", "C150001", "S2", [115 + i, 47], [
      ["1", "1", "3V3"],
      ["2", "2", "GND"],
    ]);
  }
  for (let i = 0; i < 4; i++) {
    makeComp(`R${32 + i}`, "R0603", "10k", "0603WAF1002T5E", "C25804", "S2", [125 + i, 47], [
      ["1", "1", "3V3"],
      ["2", "2", `DQ${i}`],
    ]);
  }
  makeComp("C39", "C0603", "10uF", "CL10A106KP8NNNC", "C19702", "S1", [76, 51], [
    ["1", "1", "5V"],
    ["2", "2", "GND"],
  ]);
  makeComp("C40", "C0603", "10uF", "CL10A106KP8NNNC", "C19702", "S4", [122, 112], [
    ["1", "1", "5V"],
    ["2", "2", "GND"],
  ]);

  const groupBoxes: SchGroupBox[] = [
    { id: "GB_USB", title: "USB-C ESD Input", sheetId: "S1", rectMm: [15, 30, 35, 52], memberDesignators: ["J1", "F1", "U2", "R1", "R2", "C1"] },
    { id: "GB_DCDC", title: "DC-DC 20V-3V3 Buck", sheetId: "S1", rectMm: [58, 33, 85, 55], memberDesignators: ["U3", "L1", "C2", "C3", "C4", "R3", "R4", "R5", "C5", "C6"] },
    { id: "GB_LDO", title: "Low-Noise Analog LDO", sheetId: "S1", rectMm: [58, 76, 75, 88], memberDesignators: ["U4", "C7", "C8", "C9", "R6"] },
    { id: "GB_MCU", title: "STM32 Core + XTAL + SRAM", sheetId: "S2", rectMm: [100, 38, 152, 86] },
    { id: "GB_AFE", title: "Precision Analog Shunt FE", sheetId: "S3", rectMm: [20, 108, 60, 130] },
    { id: "GB_RELAY", title: "Relay MOSFET Driver", sheetId: "S4", rectMm: [100, 110, 140, 132] },
    { id: "GB_RF", title: "ESP32 RF Block", sheetId: "S5", rectMm: [165, 15, 195, 38] },
    { id: "GB_RS485", title: "RS485 Bus ESD", sheetId: "S6", rectMm: [168, 86, 196, 104], memberDesignators: ["U6", "C32", "R28", "R29", "D3", "J3"] },
  ];

  const nets: CompiledNet[] = Array.from(netEndpoints.entries()).map(([netName, endpoints]) => ({
    netName,
    endpoints,
    fanout: new Set(endpoints.map((ep) => ep.designator)).size,
  }));

  return {
    netlist: {
      netlistSource: "eda.sch_Netlist",
      projectUuid: "proj-test-85",
      documentUuid: "doc-sch-1",
      documentName: "MainMixedSignal",
      componentCount: components.length,
      netCount: nets.length,
      components,
      nets,
      unconnectedPins: [],
      groupBoxes,
    },
    cesmMap,
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe("Wave 2: layout-routing full-pipeline unit & integration tests", () => {
  it("1. subcircuit-clusterer: rejects sch_PrimitiveWire, strips global rails (keeping DQ0..7 bus), re-attaches decaps 1-to-1 across STM32 VDD pins, runs Leiden, and passes Ajv schema validation", () => {
    const { netlist, cesmMap } = build85PlusMixedSignalFixture();
    expect(netlist.components.length).toBeGreaterThanOrEqual(80);

    // Must forbid raw sch_PrimitiveWire geometry reconstruction
    expect(() =>
      clusterCompiledNetlist({
        ...netlist,
        wires: [{ x1: 0, y1: 0, x2: 10, y2: 10 }],
      } as unknown as CompiledNetlist)
    ).toThrow(/ERR_FORBIDDEN_WIRE_INTERSECTION/);

    const boardOutline = {
      shape: "RECTANGLE" as const,
      width_mm: 120,
      height_mm: 85,
      layer_count: 4,
      copper_weight_outer_oz: 1.0,
      stackup: ["TopLayer", "InnerLayer1", "InnerLayer2", "BottomLayer"],
      fixed_mechanicals: [
        { id: "MH1", type: "MOUNTING_HOLE_M3", x_mm: 4.5, y_mm: 4.5, keepout_dia_mm: 7.0 },
        { id: "MH2", type: "MOUNTING_HOLE_M3", x_mm: 115.5, y_mm: 4.5, keepout_dia_mm: 7.0 },
        { id: "MH3", type: "MOUNTING_HOLE_M3", x_mm: 4.5, y_mm: 80.5, keepout_dia_mm: 7.0 },
        { id: "MH4", type: "MOUNTING_HOLE_M3", x_mm: 115.5, y_mm: 80.5, keepout_dia_mm: 7.0 },
      ],
    };

    const result = clusterCompiledNetlist(netlist, {
      boardOutline,
      cesmLookup: cesmMap,
    });

    expect(result.diagnostics.schemaValidated).toBe(true);
    // Global nets stripped; DQ0..DQ7 parallel bus preserved!
    expect(result.diagnostics.strippedGlobalNets).toContain("GND");
    expect(result.diagnostics.strippedGlobalNets).toContain("3V3");
    expect(result.diagnostics.strippedGlobalNets).not.toContain("DQ0");
    expect(result.diagnostics.strippedGlobalNets).not.toContain("DQ7");

    // Shared inter-module buses pruned in micro-clustering & restored as inter_cluster_edges
    expect(result.diagnostics.prunedInterModuleBuses).toContain("I2C_SDA");
    expect(result.diagnostics.prunedInterModuleBuses).toContain("I2C_SCL");

    // 4x 100nF decaps balanced 1-to-1 across STM32 U1's 4 VDD pins (19, 32, 48, 64)
    const u1HfDecaps = result.diagnostics.reattachedOrphans.filter(
      (r) =>
        r.targetIcDesignator === "U1" &&
        ["C10", "C11", "C12", "C13"].includes(r.capacitorDesignator)
    );
    expect(u1HfDecaps).toHaveLength(4);
    const assignedPins = new Set(u1HfDecaps.map((r) => r.targetPins[0]));
    expect(assignedPins).toEqual(new Set(["U1.19", "U1.32", "U1.48", "U1.64"]));

    // Every cluster converges within 3..35 members (no type-sorted queuing)
    for (const c of result.output.functional_clusters) {
      expect(c.members.length).toBeGreaterThanOrEqual(3);
      expect(c.members.length).toBeLessThanOrEqual(35);
    }

    // DC-DC cluster carries CESM layoutExample and MountLayer-only inductor keepout
    const dcdcCluster = result.output.functional_clusters.find(
      (c) => c.module_type === "DCDC_POWER_STAGE"
    );
    expect(dcdcCluster).toBeDefined();
    expect(dcdcCluster!.datasheet_layout_example?.has_reference_layout).toBe(true);
    expect(dcdcCluster!.datasheet_layout_example?.thermal_via_array?.grid_rows).toBe(3);

    const indKeepout = dcdcCluster!.keepout_zones?.find((k) => k.target === "L1");
    expect(indKeepout).toBeDefined();
    expect(indKeepout!.layerSet).toEqual(["TopLayer"]);
    expect(indKeepout!.layerSet).not.toContain("BottomLayer");

    // Also test pure-netlist fallback (strip all posMm/groupBoxes) -> still reattaches decaps!
    const pureNetlist: CompiledNetlist = {
      ...netlist,
      groupBoxes: undefined,
      components: netlist.components.map((c) => ({
        ...c,
        posMm: undefined,
        pins: c.pins.map((p) => ({ ...p, posMm: undefined })),
      })),
    };
    const fallbackRes = clusterCompiledNetlist(pureNetlist, { boardOutline, cesmLookup: cesmMap });
    expect(fallbackRes.diagnostics.schemaValidated).toBe(true);
    expect(fallbackRes.diagnostics.reattachedOrphans.length).toBeGreaterThan(5);
  });

  it("2. spacing-keepout-matrix: honors native ProjectDesignRules override, synthesizes 4D spacing & enforces exact 2.5D layer-aware Keep-outs (4L BottomLayer open vs 2L protected)", () => {
    // A. Native project DRC override test
    const customRules = normalizeProjectDesignRules({
      source: "JLC_PROJECT_DRC_ONLY",
      componentClearanceMm: 0.75,
      padToPadClearanceMm: 0.45,
      defaultClearanceMm: 0.25,
    });
    const profA = {
      designator: "R100",
      footprint: "R0402",
      packageCategory: "0402" as const,
      maxVoltageV: 5,
    };
    const profB = {
      designator: "C100",
      footprint: "C0402",
      packageCategory: "0402" as const,
      maxVoltageV: 5,
    };
    const spacingRes = computeFourDimensionalSpacingMm(profA, profB, customRules);
    expect(spacingRes.dDfmEffMm).toBe(0.75);
    expect(spacingRes.dMinMm).toBe(0.75);

    // Table 8-2 EMI/Thermal isolation check (DCDC inductor vs Passive Crystal >= 8.0mm)
    const emiSpacing = computeFourDimensionalSpacingMm(
      {
        designator: "L1",
        footprint: "IND-SMD-5050",
        packageCategory: "OTHER",
        emiAggressorRole: "DCDC_SW_INDUCTOR",
      },
      {
        designator: "Y1",
        footprint: "SMD-3225-4P",
        packageCategory: "OTHER",
        emiVictimRole: "PASSIVE_XTAL",
      },
      customRules
    );
    expect(emiSpacing.dEmiMm).toBeGreaterThanOrEqual(8.0);
    expect(emiSpacing.dMinMm).toBeGreaterThanOrEqual(8.0);

    // Table 9-1 HV safety clearance + IPC-2221 + Table 9-4
    const hvSafety = getSafetyClearanceSpec(220, true);
    expect(hvSafety.creepageMm).toBeGreaterThanOrEqual(6.4);
    expect(hvSafety.requiresIsolationSlot).toBe(true);
    expect(calculateIpc2221TraceWidthMm(3.0, { copperOz: 1, tempRiseC: 10 })).toBeGreaterThan(1.2);
    expect(getMinParallelVias(3.0, 0.3)).toBeGreaterThanOrEqual(5);

    // B. All 6 classes of Table 8-5 2.5D Keep-outs on 4-layer board
    const stackup4 = ["TopLayer", "InnerLayer1", "InnerLayer2", "BottomLayer"];
    const box = polygonFromRectMm(30, 30, 4.0, 4.0);

    const koInd4 = generate25DKeepoutFiveTuples({
      category: "POWER_INDUCTOR",
      ownerDesignator: "L1",
      polygon2D: box,
      mountSide: "TOP",
      layerCount: 4,
      stackup: stackup4,
      allowedNets: ["BUCK_SW", "3V3"],
    });
    expect(koInd4[0].layerSet).toEqual(["TopLayer"]);

    const koXtal4 = generate25DKeepoutFiveTuples({
      category: "PASSIVE_CRYSTAL",
      ownerDesignator: "Y1",
      polygon2D: box,
      mountSide: "TOP",
      layerCount: 4,
      stackup: stackup4,
      allowedNets: ["OSC_IN", "OSC_OUT"],
    });
    expect(koXtal4).toHaveLength(1);
    expect(koXtal4[0].layerSet).toEqual(["TopLayer"]);
    expect(koXtal4[0].layerSet).not.toContain("BottomLayer");

    // Two-stage short-circuit Clipper2 test: BottomLayer track & 0402 component directly under Y1 & L1 -> NO VIOLATION!
    const bottomTrack = {
      id: "TRK_BOT",
      kind: "TRACK" as const,
      layer: "BottomLayer",
      net: "UART_TX",
      polygon2D: polygonFromRectMm(30, 30, 3.0, 0.2),
    };
    const topForeignTrack = {
      id: "TRK_TOP",
      kind: "TRACK" as const,
      layer: "TopLayer",
      net: "UART_TX",
      polygon2D: polygonFromRectMm(30, 30, 3.0, 0.2),
    };
    const topAllowedOscTrack = {
      id: "TRK_OSC",
      kind: "TRACK" as const,
      layer: "TopLayer",
      net: "OSC_IN",
      polygon2D: polygonFromRectMm(30, 30, 3.0, 0.2),
    };

    const resBotXtal = checkKeepout25DViolation(bottomTrack, koXtal4[0], stackup4);
    expect(resBotXtal.violated).toBe(false);
    expect(resBotXtal.shortCircuitedBy).toBe("LAYER_SET");

    const resBotInd = checkKeepout25DViolation(bottomTrack, koInd4[0], stackup4);
    expect(resBotInd.violated).toBe(false);
    expect(resBotInd.shortCircuitedBy).toBe("LAYER_SET");

    const resTopForeign = checkKeepout25DViolation(topForeignTrack, koXtal4[0], stackup4);
    expect(resTopForeign.violated).toBe(true);
    expect(resTopForeign.intersectionAreaMm2).toBeGreaterThan(0.5);

    const resTopAllowed = checkKeepout25DViolation(topAllowedOscTrack, koXtal4[0], stackup4);
    expect(resTopAllowed.violated).toBe(false);
    expect(resTopAllowed.shortCircuitedBy).toBe("ALLOWED_NET");

    // Verify 2-layer crystal adds local BottomLayer reference protection
    const koXtal2 = generate25DKeepoutFiveTuples({
      category: "PASSIVE_CRYSTAL",
      ownerDesignator: "Y1",
      polygon2D: box,
      mountSide: "TOP",
      layerCount: 2,
      allowedNets: ["OSC_IN", "OSC_OUT"],
    });
    expect(koXtal2).toHaveLength(2);
    expect(koXtal2[1].layerSet).toEqual(["BottomLayer"]);

    // Verify classes #2, #4, #5, #6
    const koCmc = generate25DKeepoutFiveTuples({
      category: "FERRITE_OR_CMC",
      ownerDesignator: "FB1",
      polygon2D: box,
      mountSide: "TOP",
      layerCount: 4,
      stackup: stackup4,
    });
    expect(koCmc[0].layerSet).toEqual(["TopLayer", "InnerLayer1"]);

    const koHv = generate25DKeepoutFiveTuples({
      category: "SAFETY_ISOLATION_OR_ETH_HV",
      ownerDesignator: "T1",
      polygon2D: box,
      mountSide: "TOP",
      layerCount: 4,
      stackup: stackup4,
    });
    expect(koHv[0].layerSet).toEqual(stackup4);

    const koAnt = generate25DKeepoutFiveTuples({
      category: "RF_ANTENNA",
      ownerDesignator: "ANT1",
      polygon2D: box,
      mountSide: "TOP",
      layerCount: 4,
      stackup: stackup4,
    });
    expect(koAnt[0].layerSet).toEqual(stackup4);

    const koInMinus = generate25DKeepoutFiveTuples({
      category: "OPAMP_IN_MINUS",
      ownerDesignator: "U5",
      polygon2D: box,
      mountSide: "TOP",
      layerCount: 4,
      stackup: stackup4,
    });
    expect(koInMinus[0].layerSet).toEqual(["TopLayer", "InnerLayer1"]);
    expect(koInMinus[0].disallowMask).toEqual(["COPPER_POUR"]);
  });

  it("3. modular-placer + critical-prerouter + diff-meander + freerouting-driver + pour-stitch-silkscreen: full Tier 1~3 closed loop on 85+ component board", async () => {
    const { netlist, cesmMap } = build85PlusMixedSignalFixture();
    const boardOutline = {
      shape: "RECTANGLE" as const,
      width_mm: 130,
      height_mm: 95,
      layer_count: 4,
      copper_weight_outer_oz: 1.0,
      stackup: ["TopLayer", "InnerLayer1", "InnerLayer2", "BottomLayer"],
      fixed_mechanicals: [
        { id: "MH1", type: "MOUNTING_HOLE_M3", x_mm: 4.5, y_mm: 4.5, keepout_dia_mm: 7.0 },
        { id: "MH2", type: "MOUNTING_HOLE_M3", x_mm: 125.5, y_mm: 4.5, keepout_dia_mm: 7.0 },
        { id: "MH3", type: "MOUNTING_HOLE_M3", x_mm: 4.5, y_mm: 90.5, keepout_dia_mm: 7.0 },
        { id: "MH4", type: "MOUNTING_HOLE_M3", x_mm: 125.5, y_mm: 90.5, keepout_dia_mm: 7.0 },
      ],
    };

    // --- Stage 1: Cluster netlist ---
    const clusterRes = clusterCompiledNetlist(netlist, { boardOutline, cesmLookup: cesmMap });

    // --- Stage 2: Modular Placement (4-stage hybrid + Force-Directed + SA + Clipper2 0.00 mm^2) ---
    const projectRules: Partial<ProjectDesignRules> = {
      source: "JLC_PROJECT_DRC_MERGED",
      defaultTraceWidthMm: 0.18,
      defaultClearanceMm: 0.15,
      componentClearanceMm: 0.25,
      pourClearanceMm: 0.25,
      boardOutlineClearanceMm: 0.4,
    };

    const placeRes = solveModularPlacement(clusterRes.output, netlist, {
      mode: "macro_floorplan_solve",
      projectRules,
      cesmLookup: cesmMap,
      applyDatasheetLayoutExample: true,
      useProjectDesignRulesFirst: true,
      enforceSpacingMatrix: true,
      gridStepMm: 0.05,
    });

    expect(placeRes.placedCount).toBe(netlist.components.length);
    // Exact Clipper2 collision convergence to 0.00 mm^2!
    expect(placeRes.overlapCount).toBe(0);
    expect(placeRes.overlapAreaMm2).toBe(0);
    expect(placeRes.fiducials).toHaveLength(3);
    expect(placeRes.metrics.ratlineCrossingRatio).toBeLessThan(0.08);
    // Non-locked placements snapped to 0.05 mm process grid
    for (const pl of placeRes.placements) {
      if (!pl.locked) {
        expect(Math.abs(pl.xMm * 20 - Math.round(pl.xMm * 20))).toBeLessThan(1e-6);
        expect(Math.abs(pl.yMm * 20 - Math.round(pl.yMm * 20))).toBeLessThan(1e-6);
      }
    }
    // Crystal load caps symmetrically placed <= 1.5 mm from crystal body edge
    const y1Pl = placeRes.placements.find((p) => p.designator === "Y1")!;
    const c17Pl = placeRes.placements.find((p) => p.designator === "C17")!;
    const c18Pl = placeRes.placements.find((p) => p.designator === "C18")!;
    expect(Math.hypot(c17Pl.xMm - y1Pl.xMm, c17Pl.yMm - y1Pl.yMm) - y1Pl.bboxMm[0] / 2).toBeLessThanOrEqual(1.6);
    expect(Math.hypot(c18Pl.xMm - y1Pl.xMm, c18Pl.yMm - y1Pl.yMm) - y1Pl.bboxMm[0] / 2).toBeLessThanOrEqual(1.6);

    // Datasheet Layout Example applied to DC-DC cluster
    const dcdcCluster = clusterRes.output.functional_clusters.find(
      (c) => c.module_type === "DCDC_POWER_STAGE"
    )!;
    expect(placeRes.datasheetLayoutAppliedClusters).toContain(dcdcCluster.cluster_id);

    // No type-sorted queuing: intra-cluster dispersion stays compact
    for (const [cId, disp] of Object.entries(placeRes.metrics.intraClusterDispersionMm)) {
      expect(disp.meanDistMm, `Cluster ${cId} mean dispersion too large`).toBeLessThan(8.5);
    }

    // --- Stage 3 (Tier 1): Critical Pre-router (all 6 generators, primitiveLock = true) ---
    const criticalTasks = [
      {
        kind: "datasheet_layout_copper" as const,
        nets: ["VBUS_20V", "BUCK_SW", "3V3", "GND", "BUCK_FB"],
        anchorDesignator: "U3",
      },
      {
        kind: "decap_loop" as const,
        nets: ["3V3", "GND"],
        icVddPin: "U1.19",
        smallCapDesignator: "C10",
        bulkCapDesignator: "C14",
      },
      {
        kind: "decap_loop" as const,
        nets: ["3V3", "GND"],
        icVddPin: "U1.32",
        smallCapDesignator: "C11",
      },
      {
        kind: "dcdc_hot_loop" as const,
        nets: ["BUCK_SW"],
        targetComponents: ["U3", "L1"],
      },
      {
        kind: "inline_esd" as const,
        nets: ["USB_DP_EXT"],
        connectorDesignator: "J1",
        connectorPin: "A6",
        esdDesignator: "U2",
        esdPin: "1",
        esdGndPin: "2",
        targetIcDesignator: "U2",
        targetIcPin: "6",
      },
      {
        kind: "guard_ring_clock" as const,
        nets: ["OSC_IN", "OSC_OUT"],
        anchorDesignator: "U1",
        crystalDesignator: "Y1",
        loadCapDesignators: ["C17", "C18"],
      },
      {
        kind: "kelvin_sense" as const,
        nets: ["SHUNT_SENSE_P", "SHUNT_SENSE_N"],
        shuntDesignator: "R20",
        senseTargetDesignator: "U5",
      },
    ];

    const tier1 = runCriticalPrerouter(placeRes.placements, clusterRes.output, criticalTasks, cesmMap);
    expect(tier1.routedTasks).toBe(criticalTasks.length);
    expect(tier1.lockedPrimitivesCount).toBeGreaterThan(15);
    expect(tier1.forbiddenThermalViaAuditPassed).toBe(true);
    expect(tier1.tracks.every((t) => t.primitiveLock === true)).toBe(true);
    expect(tier1.copperZones.every((z) => z.primitiveLock === true)).toBe(true);
    expect(tier1.vias.every((v) => v.primitiveLock === true)).toBe(true);

    // Guard ring clock: 0 signal vias, closed ring + stitch vias
    expect(tier1.guardRings).toHaveLength(1);
    expect(tier1.guardRings[0].signalViaCount).toBe(0);
    expect(tier1.guardRings[0].stitchViaCount).toBeGreaterThanOrEqual(4);

    // Kelvin sense high-side dual-ended: inner-edge tap, no forced guard ring, zero blind thermal vias
    expect(tier1.kelvinReports).toHaveLength(1);
    expect(tier1.kelvinReports[0].topology).toBe("HIGH_SIDE_KELVIN_PAIR");
    expect(tier1.kelvinReports[0].tappedFromInnerPadEdge).toBe(true);
    expect(tier1.kelvinReports[0].guardRingGenerated).toBe(false);
    expect(tier1.kelvinReports[0].thermalViasOnPowerOrShunt).toBe(0);

    // Also test low-side single-ended Kelvin sense topology explicitly
    const lowSideShunt = {
      ...placeRes.placements.find((p) => p.designator === "R20")!,
      pads: [
        { padNumber: "1", net: "GND", xMm: 24, yMm: 120, sizeMm: [1.5, 1.5] as [number, number] },
        { padNumber: "2", net: "I_SENSE_LOW", xMm: 27, yMm: 120, sizeMm: [1.5, 1.5] as [number, number] },
      ],
    };
    const lowSideRes = runCriticalPrerouter([lowSideShunt], clusterRes.output, [
      { kind: "kelvin_sense", nets: ["I_SENSE_LOW"], shuntDesignator: "R20" },
    ]);
    expect(lowSideRes.kelvinReports[0].topology).toBe("LOW_SIDE_SINGLE_ENDED");
    expect(lowSideRes.kelvinReports[0].senseNets).toEqual(["I_SENSE_LOW"]);
    expect(lowSideRes.kelvinReports[0].guardRingGenerated).toBe(false);

    // --- Stage 4a (Tier 2 Diff + Meander Router) ---
    const u2Pl = placeRes.placements.find((p) => p.designator === "U2")!;
    const u1Pl = placeRes.placements.find((p) => p.designator === "U1")!;
    const usbDpStart = u2Pl.pads.find((p) => p.net === "USB_DP")!;
    const usbDmStart = u2Pl.pads.find((p) => p.net === "USB_DM")!;
    const usbDpEnd = u1Pl.pads.find((p) => p.net === "USB_DP")!;
    const usbDmEnd = u1Pl.pads.find((p) => p.net === "USB_DM")!;

    const diffRes = routeDifferentialPair({
      pairName: "USB_HS",
      posNet: "USB_DP",
      negNet: "USB_DM",
      posStart: [usbDpStart.xMm, usbDpStart.yMm],
      negStart: [usbDmStart.xMm, usbDmStart.yMm],
      posEnd: [usbDpEnd.xMm, usbDpEnd.yMm],
      negEnd: [usbDmEnd.xMm, usbDmEnd.yMm],
      layer: "TopLayer",
      targetLayer: "BottomLayer",
      widthMm: 0.25,
      gapMm: 0.18,
      maxSkewMm: 1.25,
    });
    expect(diffRes.withinSkewBudget).toBe(true);
    expect(diffRes.pourClearanceMm).toBeGreaterThanOrEqual(0.45);
    expect(diffRes.pourClearanceMm).toBeGreaterThanOrEqual(0.18 * 3);
    expect(diffRes.gndReturnVias).toHaveLength(2);
    // Verify each GND return via is <= 1.0 mm from its signal via
    for (let k = 0; k < 2; k++) {
      const distToSig = Math.hypot(
        diffRes.gndReturnVias[k].xMm - diffRes.signalVias[k].xMm,
        diffRes.gndReturnVias[k].yMm - diffRes.signalVias[k].yMm
      );
      expect(distToSig).toBeLessThanOrEqual(1.0);
    }

    // Verify accordion meander >= 3W spacing
    const meanderRes = insertAccordionMeander(
      [
        [10, 10],
        [30, 10],
      ],
      26.0,
      0.2,
      { pitchMultiplier: 3.5 }
    );
    expect(meanderRes.achievedLengthMm).toBeGreaterThanOrEqual(25.5);
    expect(meanderRes.minSelfSpacingMm).toBeGreaterThanOrEqual(0.2 * 3);

    // --- Stage 4b (Tier 2 Full-Board Hybrid Autorouter + DSN/SES Round-Trip) ---
    const autorouteRes = await runHybridAutoroute(clusterRes.output, placeRes.placements, {
      engine: "internal_grid",
      excludeNets: ["GND", "AGND", "PGND"],
      maxPasses: 30,
      gridStepMm: 0.35,
      projectRules,
      keepouts25D: placeRes.keepoutZones25D,
      lockedTracks: tier1.tracks,
      lockedVias: tier1.vias,
      preRoutedTracks: [...diffRes.posTracks, ...diffRes.negTracks],
      preRoutedVias: [...diffRes.signalVias, ...diffRes.gndReturnVias],
    });

    expect(autorouteRes.remainingUnroutedRatlines).toBe(0);
    expect(autorouteRes.completed).toBe(true);
    expect(autorouteRes.routedNetCount).toBeGreaterThanOrEqual(20);

    // Verify Specctra DSN validity & 2.5D layer scoping
    expect(autorouteRes.dsnContent).toContain('(pcb "JLCEDA_PCB"');
    expect(autorouteRes.dsnContent).toContain("(type fix)");
    // Verify 4-layer crystal keepout in DSN targets TopLayer and NOT BottomLayer!
    const dsnLines = autorouteRes.dsnContent.split("\n");
    const xtalKeepoutLines = dsnLines.filter((ln) => ln.includes("KO_XTAL") || ln.includes("_Y1_"));
    expect(xtalKeepoutLines.some((ln) => ln.includes('"TopLayer"'))).toBe(true);
    expect(xtalKeepoutLines.some((ln) => ln.includes('"BottomLayer"'))).toBe(false);

    // Verify Specctra SES round-trip parsing
    const parsedSes = parseSpecctraSes(autorouteRes.sesContent);
    expect(parsedSes.tracks.length).toBe(autorouteRes.tracks.length);
    expect(parsedSes.vias.length).toBe(autorouteRes.vias.length);

    // --- Stage 5 (Tier 3): Pour + 0603/0402/0201 Thermal Relief + RBush Stitch + Silkscreen ---
    const allTracks = [
      ...tier1.tracks,
      ...diffRes.posTracks,
      ...diffRes.negTracks,
      ...autorouteRes.tracks,
    ];
    const allVias = [...tier1.vias, ...diffRes.signalVias, ...diffRes.gndReturnVias, ...autorouteRes.vias];

    const pourRes = runPourAndStitch(
      clusterRes.output,
      placeRes.placements,
      allTracks,
      allVias,
      [
        { net: "GND", layer: "TopLayer", insetMm: 0.4, removeIslands: true, priority: 1 },
        { net: "GND", layer: "BottomLayer", insetMm: 0.4, removeIslands: true, priority: 1 },
        { net: "GND", layer: "InnerLayer1", insetMm: 0.4, removeIslands: false, priority: 1 },
      ],
      {
        projectRules,
        keepouts25D: placeRes.keepoutZones25D,
        autoStitchGndVias: { enabled: true, gridPitchMm: 7.0, boardEdgePitchMm: 3.0 },
      }
    );

    expect(pourRes.poursRebuilt).toBe(3);
    // 100% thermal_4 relief on ALL 0603, 0402, 0201 two-terminal passives!
    expect(pourRes.smallPassiveThermalReliefCoverage).toBe(1.0);
    expect(pourRes.padConnectionStyles.filter((a) => a.isSmallAntiTombstonePackage).length).toBeGreaterThan(30);
    expect(pourRes.stitchingViasPlaced).toBeGreaterThan(10);

    // Verify 4-layer BottomLayer GND pour stays solid (no crystal/inductor TopLayer hole punched through BottomLayer!)
    const botPour = pourRes.pours.find((p) => p.layer === "BottomLayer")!;
    const topPour = pourRes.pours.find((p) => p.layer === "TopLayer")!;
    expect(botPour.totalAreaMm2).toBeGreaterThan(topPour.totalAreaMm2);
    expect(botPour.holesMm && botPour.holesMm.length).toBeGreaterThanOrEqual(4);

    // Silkscreen tidy: strictly 0° or 90° reading orientation, pad overlaps cleared
    const silkRes = tidySilkscreen(
      placeRes.placements,
      [...allVias, ...pourRes.stitchingResult.vias],
      placeRes.fiducials,
      clusterRes.output
    );
    expect(silkRes.items).toHaveLength(placeRes.placements.length);
    expect(silkRes.items.every((it) => it.rotationDeg === 0 || it.rotationDeg === 90)).toBe(true);
    expect(silkRes.items.every((it) => it.padOverlapCleared)).toBe(true);
  });

  it("4. edge-case algorithms: NetClass synthesis, multi-pass A* Rip-up & Reroute crossing corridor, dead-copper island removal & RF via fence", async () => {
    // A. NetClass synthesis prioritizing project_drc while clamping HV safety
    const baseRules = normalizeProjectDesignRules({
      source: "JLC_PROJECT_DRC_MERGED",
      netClasses: {
        USER_DIFF: {
          name: "USER_DIFF",
          nets: ["USB_DP", "USB_DM"],
          minWidthMm: 0.22,
          minClearanceMm: 0.18,
          prioritySource: "project_drc",
        },
      },
    });
    const synthesized = synthesizeNetClasses(
      {
        perNetRoutingRules: [
          {
            netName: "AC_LINE",
            voltageRangeV: { min: 0, max: 311 },
            maxCurrentA: 5.0,
            minWidthMm: 0.5,
            preferredWidthMm: 2.8,
            minClearanceMm: 3.0,
            minParallelVias: 7,
          },
        ],
        emiRoleTags: [
          { netName: "USB_DP", role: "IMPEDANCE_CTRL_DIFF", targetDiffImpedanceOhm: 90 },
          { netName: "SHUNT_P", role: "SHUNT_KELVIN_SENSE", shuntTopology: "HIGH_SIDE_KELVIN_PAIR" },
        ],
        datasheetLayoutExamples: [],
        decouplingAndEsdAffinity: { decouplingPairs: [], esdInlineChains: [] },
        keepoutZones25D: [],
      },
      baseRules
    );
    expect(synthesized["USER_DIFF"].minClearanceMm).toBe(0.18);
    expect(synthesized["PWR_HV_AC220"].minClearanceMm).toBeGreaterThanOrEqual(3.0);
    expect(synthesized["PWR_HV_AC220"].minWidthMm).toBeGreaterThanOrEqual(2.5);

    // B. Single-layer constrained crossing corridor forcing A* Rip-up and Reroute
    const miniCluster = {
      schema_version: "1.0.0",
      board_outline: { shape: "RECTANGLE" as const, width_mm: 24, height_mm: 20, layer_count: 2 },
      functional_clusters: [],
      inter_cluster_edges: [],
    };
    const miniPlacements = [
      {
        designator: "P1",
        clusterId: "C1",
        footprint: "R0603",
        role: "SATELLITE_PASSIVE",
        xMm: 4,
        yMm: 10,
        rotationDeg: 0,
        side: "TOP" as const,
        bboxMm: [1.7, 1.0] as [number, number],
        locked: true,
        placedByDatasheetExample: false,
        pads: [
          { padNumber: "1", net: "NET_A", xMm: 4, yMm: 6, sizeMm: [0.6, 0.6] as [number, number] },
          { padNumber: "2", net: "NET_B", xMm: 4, yMm: 14, sizeMm: [0.6, 0.6] as [number, number] },
        ],
      },
      {
        designator: "P2",
        clusterId: "C1",
        footprint: "R0603",
        role: "SATELLITE_PASSIVE",
        xMm: 20,
        yMm: 10,
        rotationDeg: 0,
        side: "TOP" as const,
        bboxMm: [1.7, 1.0] as [number, number],
        locked: true,
        placedByDatasheetExample: false,
        pads: [
          { padNumber: "1", net: "NET_A", xMm: 20, yMm: 14, sizeMm: [0.6, 0.6] as [number, number] },
          { padNumber: "2", net: "NET_B", xMm: 20, yMm: 6, sizeMm: [0.6, 0.6] as [number, number] },
        ],
      },
    ];
    // Route across 2 layers (Top+Bottom) AND verify DSN generation + freerouting fallback
    const hr = await runHybridAutoroute(miniCluster, miniPlacements, {
      engine: "freerouting_headless",
      freeroutingJarPath: "C:\\nonexistent\\freerouting.jar",
      maxPasses: 15,
      gridStepMm: 0.25,
    });
    expect(hr.completed).toBe(true);
    expect(hr.remainingUnroutedRatlines).toBe(0);
    expect(hr.fallbackReason).toBeDefined();
    expect(hr.dsnContent).toContain('(net "NET_A"');
    const sesParsed = parseSpecctraSes(hr.sesContent);
    expect(sesParsed.tracks.length).toBeGreaterThanOrEqual(2);

    // Single-layer forced rip-up test with a vertical fence gap
    const singleLayerRes = runBuiltInGridAutoroute(miniCluster, miniPlacements, {
      signalLayers: ["TopLayer"],
      gridStepMm: 0.25,
      maxPasses: 12,
    });
    expect(singleLayerRes.completed).toBe(true);
    expect(singleLayerRes.remainingUnroutedRatlines).toBe(0);

    // C. Dead-copper island removal + RF via fence (1.0..1.5mm pitch)
    const pourIslandRes = buildPolygonPours(
      miniCluster,
      [{ net: "GND", layer: "TopLayer", insetMm: 0.5, removeIslands: true }],
      [
        {
          ...miniPlacements[0],
          pads: [{ padNumber: "1", net: "GND", xMm: 3, yMm: 10, sizeMm: [0.8, 0.8] }],
        },
      ],
      [
        // Splitting track right across x=12 from top to bottom creates an isolated right half (no GND pad!)
        { id: "DIV", net: "PWR_SPLIT", layer: "TopLayer", widthMm: 0.5, pointsMm: [[12, 0.2], [12, 19.8]] },
      ],
      []
    );
    expect(pourIslandRes.islandsRemoved).toBeGreaterThanOrEqual(1);
    expect(pourIslandRes.pours[0].polygonsMm).toHaveLength(1);

    const rfStitch = placeGndStitchingVias(
      miniCluster,
      [],
      [{ id: "RF1", net: "RF_50", layer: "TopLayer", widthMm: 0.35, pointsMm: [[4, 10], [18, 10]] }],
      [],
      [],
      pourIslandRes.pours,
      {
        enabled: true,
        gridPitchMm: 7.0,
        boardEdgeFenceEnabled: false,
        rfFencePitchMm: 1.2,
        rfTracks: [{ id: "RF1", net: "RF_50", layer: "TopLayer", widthMm: 0.35, pointsMm: [[4, 10], [18, 10]] }],
        clearanceToTracksMm: 0.4,
      }
    );
    expect(rfStitch.rfFenceViasCount).toBeGreaterThanOrEqual(8);
  });

  it("5. buildPolygonPours: preserves interior circular mounting-hole rings in holesMm and subtracts hole area from totalAreaMm2", () => {
    const shoelaceArea = (poly: Array<[number, number]>): number => {
      let s = 0;
      for (let i = 0; i < poly.length; i++) {
        const [x1, y1] = poly[i];
        const [x2, y2] = poly[(i + 1) % poly.length];
        s += x1 * y2 - x2 * y1;
      }
      return Math.abs(s) / 2;
    };

    const holeCenter: [number, number] = [4, 4];
    const holeRadiusMm = 3.2; // 6.4 mm M3 keepout circle strictly inside 0.4 mm board inset ([0.4..29.6] x [0.4..19.6])
    const holePoly: Array<[number, number]> = Array.from({ length: 24 }, (_, idx) => {
      const th = (2 * Math.PI * idx) / 24;
      return [
        Number((holeCenter[0] + holeRadiusMm * Math.cos(th)).toFixed(4)),
        Number((holeCenter[1] + holeRadiusMm * Math.sin(th)).toFixed(4)),
      ];
    });

    const boardCluster = {
      schema_version: "1.0.0",
      board_outline: { shape: "RECTANGLE" as const, width_mm: 30, height_mm: 20, layer_count: 4 },
      functional_clusters: [],
      inter_cluster_edges: [],
    };

    const gndComp = {
      designator: "J_GND",
      clusterId: "C_PWR",
      footprint: "HDR_1X2",
      role: "RIGID_ANCHOR",
      xMm: 20,
      yMm: 10,
      rotationDeg: 0,
      side: "TOP" as const,
      bboxMm: [2.5, 2.5] as [number, number],
      locked: true,
      placedByDatasheetExample: false,
      pads: [{ padNumber: "1", net: "GND", xMm: 20, yMm: 10, sizeMm: [1.2, 1.2] as [number, number] }],
    };

    const res = buildPolygonPours(
      boardCluster,
      [{ net: "GND", layer: "TopLayer", insetMm: 0.4, removeIslands: true }],
      [gndComp],
      [],
      [],
      {
        keepouts25D: [
          {
            id: "KO_MH_4_4",
            reason: "MOUNTING_HOLE_M3",
            polygon2D: holePoly,
            layerSet: ["ALL_COPPER_LAYERS"],
            disallowMask: ["COPPER_POUR", "TRACK", "VIA", "PAD"],
            allowedNets: [],
            mountSide: "BOTH",
          },
        ],
      }
    );

    const gndPour = res.pours[0];
    expect(gndPour.polygonsMm).toHaveLength(1);
    expect(gndPour.holesMm).toBeDefined();
    expect(gndPour.holesMm).toHaveLength(1);
    expect(gndPour.polygonHolesMm).toHaveLength(1);
    expect(gndPour.polygonHolesMm![0]).toHaveLength(1);

    const outerAreaMm2 = shoelaceArea(gndPour.polygonsMm[0]);
    const holeAreaMm2 = shoelaceArea(gndPour.holesMm![0]);
    const holeCx =
      gndPour.holesMm![0].reduce((acc, p) => acc + p[0], 0) / gndPour.holesMm![0].length;
    const holeCy =
      gndPour.holesMm![0].reduce((acc, p) => acc + p[1], 0) / gndPour.holesMm![0].length;

    expect(Math.hypot(holeCx - 4, holeCy - 4)).toBeLessThan(0.05);
    expect(outerAreaMm2).toBeCloseTo(29.2 * 19.2, 1); // 560.64 mm²
    expect(holeAreaMm2).toBeGreaterThan(30); // ~31.8 mm² (24-gon of r=3.2mm)
    expect(Math.abs(gndPour.totalAreaMm2 - (outerAreaMm2 - holeAreaMm2))).toBeLessThan(0.05);
    expect(gndPour.totalAreaMm2).toBeLessThan(outerAreaMm2 - 30);

    // Ensure stitching via placer also honors holesMm without drilling inside (4, 4)
    const stitchRes = placeGndStitchingVias(
      boardCluster,
      [gndComp],
      [],
      [],
      [],
      res.pours,
      { enabled: true, gridPitchMm: 5.0, boardEdgeFenceEnabled: false }
    );
    const viaInsideHole = stitchRes.vias.some((v) => Math.hypot(v.xMm - 4, v.yMm - 4) < holeRadiusMm);
    expect(viaInsideHole).toBe(false);
  });
});
