import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { PNG } from "pngjs";
import { extractText } from "unpdf";
import type {
  CesmCategory,
  CesmCopperZone,
  CesmLayoutExample,
  CesmModel,
  CesmPin,
  CesmPinElecType,
  CesmRelativePlacementHint,
  CesmSensitiveRouteConstraint,
  CesmThermalViaArray,
  CesmViaHint,
  DeviceInspectResult,
} from "../types/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_WORKSPACE_ROOT = resolve(__dirname, "..", "..");
const DEFAULT_SCHEMA_PATH = join(DEFAULT_WORKSPACE_ROOT, "schemas", "cesm-v1.schema.json");
const DEFAULT_SQLITE_PATH = join(DEFAULT_WORKSPACE_ROOT, "catalog", "cesm_cache.sqlite");
const DEFAULT_LAYOUT_IMG_DIR = join(DEFAULT_WORKSPACE_ROOT, "catalog", "layout_examples");

// Unwrap Ajv2020 & ajv-formats safely under NodeNext ESM
type AjvInstanceLike = {
  compile: (schema: Record<string, unknown>) => ValidateFn;
};
type AjvCtorLike = new (opts?: Record<string, unknown>) => AjvInstanceLike;
type AddFormatsLike = (ajv: AjvInstanceLike) => void;

const Ajv2020Ctor: AjvCtorLike =
  (Ajv2020Module as unknown as { Ajv2020?: AjvCtorLike }).Ajv2020 ??
  (Ajv2020Module as unknown as { default?: AjvCtorLike }).default ??
  (Ajv2020Module as unknown as AjvCtorLike);

const addFormatsFn: AddFormatsLike =
  (addFormatsModule as unknown as { default?: AddFormatsLike }).default ??
  (addFormatsModule as unknown as AddFormatsLike);

type ValidateFn = ((data: unknown) => boolean) & {
  errors?: Array<{ instancePath?: string; message?: string }> | null;
};

let cachedValidator: ValidateFn | null = null;

function getCesmValidator(schemaPath = DEFAULT_SCHEMA_PATH): ValidateFn {
  if (cachedValidator && schemaPath === DEFAULT_SCHEMA_PATH) {
    return cachedValidator;
  }
  const rawSchema = JSON.parse(readFileSync(schemaPath, "utf-8")) as Record<string, unknown>;
  const ajv = new Ajv2020Ctor({ allErrors: true, strict: false });
  addFormatsFn(ajv);
  const validate = ajv.compile(rawSchema) as ValidateFn;
  if (schemaPath === DEFAULT_SCHEMA_PATH) {
    cachedValidator = validate;
  }
  return validate;
}

export function validateCesmSchema(
  cesm: unknown,
  schemaPath = DEFAULT_SCHEMA_PATH
): { valid: boolean; errors: string[] } {
  const validate = getCesmValidator(schemaPath);
  const valid = validate(cesm);
  if (valid) {
    return { valid: true, errors: [] };
  }
  const errors = (validate.errors ?? []).map(
    (e) => `${e.instancePath || "/"}: ${e.message ?? "schema error"}`
  );
  return { valid: false, errors };
}

// ============================================================================
// Built-in Golden LCSC Component Library (CESM v1 Compliant)
// ============================================================================

const GOLDEN_CESM_LIST: CesmModel[] = [
  {
    lcsc_id: "C2040",
    mpn: "STM32F103C8T6",
    category: "MCU_SOC",
    package: "LQFP-48_7x7",
    verified: true,
    polarity_spec: {
      is_polarized: true,
      silkscreen_rule: "PIN1_DOT_AT_TOP_LEFT_CORNER",
    },
    pins: [
      { pin_number: "1", pin_name: "VBAT", elec_type: "POWER_IN", v_abs_min: -0.3, v_abs_max: 4.0, mandatory_external: "DECOUPLING_100NF" },
      { pin_number: "5", pin_name: "PD0-OSC_IN", elec_type: "ANALOG_IN", supply_pin_ref: "VDD", v_abs_min: -0.3, v_abs_max: 4.0, five_volt_tolerant: false },
      { pin_number: "6", pin_name: "PD1-OSC_OUT", elec_type: "ANALOG_OUT", supply_pin_ref: "VDD", v_abs_min: -0.3, v_abs_max: 4.0, five_volt_tolerant: false },
      { pin_number: "7", pin_name: "NRST", elec_type: "INPUT_HIZ", supply_pin_ref: "VDD", v_abs_min: -0.3, v_abs_max: 4.0, mandatory_external: "PULLUP_RES" },
      { pin_number: "8", pin_name: "VSSA", elec_type: "GND" },
      { pin_number: "9", pin_name: "VDDA", elec_type: "POWER_IN", v_abs_min: -0.3, v_abs_max: 4.0, mandatory_external: "DECOUPLING_100NF" },
      { pin_number: "10", pin_name: "PA0", elec_type: "ANALOG_IN", supply_pin_ref: "VDDA", v_abs_min: -0.3, v_abs_max: 4.0, five_volt_tolerant: false, ft_lost_in_analog_mode: true },
      { pin_number: "11", pin_name: "PA1", elec_type: "ANALOG_IN", supply_pin_ref: "VDDA", v_abs_min: -0.3, v_abs_max: 4.0, five_volt_tolerant: false, ft_lost_in_analog_mode: true },
      { pin_number: "23", pin_name: "VSS_1", elec_type: "GND" },
      { pin_number: "24", pin_name: "VDD_1", elec_type: "POWER_IN", v_abs_min: -0.3, v_abs_max: 4.0, mandatory_external: "DECOUPLING_100NF" },
      { pin_number: "30", pin_name: "PA9_TX1", elec_type: "PUSH_PULL", supply_pin_ref: "VDD", v_abs_min: -0.3, v_abs_max: 5.5, five_volt_tolerant: true, ft_lost_in_analog_mode: true, vih_min_expr: "0.7*VDD", vil_max_expr: "0.3*VDD" },
      { pin_number: "31", pin_name: "PA10_RX1", elec_type: "INPUT_HIZ", supply_pin_ref: "VDD", v_abs_min: -0.3, v_abs_max: 5.5, five_volt_tolerant: true, ft_lost_in_analog_mode: true, vih_min_expr: "0.7*VDD", vil_max_expr: "0.3*VDD" },
      { pin_number: "32", pin_name: "PA11_USB_DM", elec_type: "BIDIR_IO", supply_pin_ref: "VDD", v_abs_min: -0.3, v_abs_max: 5.5, five_volt_tolerant: true },
      { pin_number: "33", pin_name: "PA12_USB_DP", elec_type: "BIDIR_IO", supply_pin_ref: "VDD", v_abs_min: -0.3, v_abs_max: 5.5, five_volt_tolerant: true },
      { pin_number: "34", pin_name: "PA13_SWDIO", elec_type: "BIDIR_IO", supply_pin_ref: "VDD", v_abs_min: -0.3, v_abs_max: 4.0 },
      { pin_number: "35", pin_name: "VSS_2", elec_type: "GND" },
      { pin_number: "36", pin_name: "VDD_2", elec_type: "POWER_IN", v_abs_min: -0.3, v_abs_max: 4.0, mandatory_external: "DECOUPLING_100NF" },
      { pin_number: "37", pin_name: "PA14_SWCLK", elec_type: "INPUT_HIZ", supply_pin_ref: "VDD", v_abs_min: -0.3, v_abs_max: 4.0 },
      { pin_number: "42", pin_name: "PB6_I2C1_SCL", elec_type: "OPEN_DRAIN", supply_pin_ref: "VDD", v_abs_min: -0.3, v_abs_max: 5.5, five_volt_tolerant: true, iol_max_ma: 20, mandatory_external: "PULLUP_RES" },
      { pin_number: "43", pin_name: "PB7_I2C1_SDA", elec_type: "OPEN_DRAIN", supply_pin_ref: "VDD", v_abs_min: -0.3, v_abs_max: 5.5, five_volt_tolerant: true, iol_max_ma: 20, mandatory_external: "PULLUP_RES" },
      { pin_number: "44", pin_name: "BOOT0", elec_type: "INPUT_HIZ", supply_pin_ref: "VDD", v_abs_min: -0.3, v_abs_max: 4.0, mandatory_external: "PULLDOWN_or_PULLUP" },
      { pin_number: "47", pin_name: "VSS_3", elec_type: "GND" },
      { pin_number: "48", pin_name: "VDD_3", elec_type: "POWER_IN", v_abs_min: -0.3, v_abs_max: 4.0, mandatory_external: "DECOUPLING_100NF" },
    ],
    ratings: {
      v_working_max: 3.6,
      r_theta_ja_c_per_w: 55,
      tj_max_c: 105,
    },
    typical_application_constraints: [
      "Every VDD/VSS pair requires a dedicated 100nF MLCC within <=2.0mm",
      "VDDA decoupled via 600Ohm@100MHz bead + 100nF + 1uF; |VDD - VDDA| <= 0.3V",
      "NRST requires 10k pull-up + 100nF to GND; BOOT0 requires 10k pull-down/up",
    ],
    layout_guidelines: [
      "Place 100nF bypass capacitor as close as possible to each VDD/VSS pin pair",
      "Keep external 8MHz crystal and C0G load capacitors within <=5mm of PD0/PD1 with guard ring",
    ],
  },
  {
    lcsc_id: "C2765186",
    mpn: "TYPE-C-31-M-12",
    category: "CONN_USB_TYPEC",
    package: "USB-C-SMD-16P",
    verified: true,
    pins: [
      { pin_number: "A1/B12", pin_name: "GND_1", elec_type: "GND" },
      { pin_number: "B1/A12", pin_name: "GND_2", elec_type: "GND" },
      { pin_number: "A4/B9", pin_name: "VBUS_1", elec_type: "POWER_OUT", v_abs_max: 24 },
      { pin_number: "B4/A9", pin_name: "VBUS_2", elec_type: "POWER_OUT", v_abs_max: 24 },
      { pin_number: "A5", pin_name: "CC1", elec_type: "PASSIVE", v_abs_max: 5.5, mandatory_external: "DEDICATED_5K1_GND" },
      { pin_number: "B5", pin_name: "CC2", elec_type: "PASSIVE", v_abs_max: 5.5, mandatory_external: "DEDICATED_5K1_GND" },
      { pin_number: "A6", pin_name: "DP1", elec_type: "BIDIR_IO", v_abs_max: 5.5 },
      { pin_number: "B6", pin_name: "DP2", elec_type: "BIDIR_IO", v_abs_max: 5.5 },
      { pin_number: "A7", pin_name: "DN1", elec_type: "BIDIR_IO", v_abs_max: 5.5 },
      { pin_number: "B7", pin_name: "DN2", elec_type: "BIDIR_IO", v_abs_max: 5.5 },
      { pin_number: "A8", pin_name: "SBU1", elec_type: "NC" },
      { pin_number: "B8", pin_name: "SBU2", elec_type: "NC" },
      { pin_number: "S1", pin_name: "SHIELD", elec_type: "GND" },
    ],
    ratings: { v_working_max: 20 },
    typical_application_constraints: [
      "UFP Sink mode MUST connect two independent 5.1k resistors on CC1 and CC2 to GND",
      "Short A6+B6 (D+) and A7+B7 (D-) at pad for reversible USB 2.0",
    ],
    layout_guidelines: [
      "Place connector flush or overhanging board edge by 0.5-1.0mm",
      "Route D+/D- inline through USBLC6-2SC6 ESD pads with zero stub",
    ],
  },
  {
    lcsc_id: "C6186",
    mpn: "AMS1117-3.3",
    category: "PMIC_LDO",
    package: "SOT-223",
    verified: true,
    pins: [
      { pin_number: "1", pin_name: "GND", elec_type: "GND" },
      { pin_number: "2", pin_name: "VOUT", elec_type: "POWER_OUT", v_abs_max: 3.6 },
      { pin_number: "3", pin_name: "VIN", elec_type: "POWER_IN", v_abs_min: -0.3, v_abs_max: 15.0 },
      { pin_number: "4", pin_name: "TAB_VOUT", elec_type: "POWER_OUT", v_abs_max: 3.6 },
    ],
    ratings: {
      v_working_max: 15.0,
      power_rated_w: 1.0,
      r_theta_ja_c_per_w: 65,
      tj_max_c: 125,
      mlcc_output_stable: false,
    },
    typical_application_constraints: [
      "Legacy bipolar LDO requires output capacitor ESR in 0.1~2.0 Ohm window (tantalum or series 0.33 Ohm ESR resistor with MLCC)",
      "Keep PD <= 0.6W and TJ <= 105C",
    ],
  },
  {
    lcsc_id: "C47773",
    mpn: "RT9013-33GB",
    category: "PMIC_LDO",
    package: "SOT-23-5",
    verified: true,
    pins: [
      { pin_number: "1", pin_name: "VIN", elec_type: "POWER_IN", v_abs_min: -0.3, v_abs_max: 6.0, mandatory_external: "DECOUPLING_100NF" },
      { pin_number: "2", pin_name: "GND", elec_type: "GND" },
      { pin_number: "3", pin_name: "EN", elec_type: "INPUT_HIZ", supply_pin_ref: "VIN", v_abs_min: -0.3, v_abs_max: 6.0 },
      { pin_number: "4", pin_name: "NC", elec_type: "NC" },
      { pin_number: "5", pin_name: "VOUT", elec_type: "POWER_OUT", v_abs_max: 3.6 },
    ],
    ratings: {
      v_working_max: 5.5,
      power_rated_w: 0.4,
      r_theta_ja_c_per_w: 200,
      tj_max_c: 125,
      mlcc_output_stable: true,
    },
    typical_application_constraints: [
      "Stable with >=1uF X7R/X5R MLCC on VIN and VOUT",
      "EN pin must not float",
    ],
  },
  {
    lcsc_id: "C96581",
    mpn: "TPS54302DDCR",
    category: "PMIC_DCDC",
    package: "SOT-23-6-EP",
    verified: true,
    pins: [
      { pin_number: "1", pin_name: "GND", elec_type: "GND" },
      { pin_number: "2", pin_name: "SW", elec_type: "SW_NODE", v_abs_min: -1.0, v_abs_max: 30.0 },
      { pin_number: "3", pin_name: "VIN", elec_type: "POWER_IN", v_abs_min: -0.3, v_abs_max: 30.0, mandatory_external: "DECOUPLING_100NF" },
      { pin_number: "4", pin_name: "FB", elec_type: "ANALOG_IN", v_abs_min: -0.3, v_abs_max: 5.5 },
      { pin_number: "5", pin_name: "EN", elec_type: "INPUT_HIZ", v_abs_min: -0.3, v_abs_max: 30.0 },
      { pin_number: "6", pin_name: "BOOT", elec_type: "PASSIVE", v_abs_min: -0.3, v_abs_max: 36.0 },
      { pin_number: "EP", pin_name: "EPAD_GND", elec_type: "GND" },
    ],
    ratings: {
      v_working_max: 28.0,
      i_sat_a: 3.0,
      r_theta_ja_c_per_w: 45,
      tj_max_c: 150,
    },
    typical_application_constraints: [
      "Connect 100nF CBOOT between BOOT(Pin6) and SW(Pin2)",
      "Place HF CIN as close as possible between VIN(Pin3) and GND(Pin1) on same layer",
    ],
    layout_guidelines: [
      "Keep VIN and GND traces wide and low inductance; place CIN_HF directly adjacent to VIN/GND pins",
      "Keep SW copper area compact to minimize dv/dt radiated EMI; forbid blind thermal vias on SW",
      "Route VSENSE/FB trace away from SW island and power inductor; tap after last COUT pad",
      "Place 3x3 thermal via array (0.3mm drill, 1.0mm pitch) under static GND EPAD",
    ],
    layoutExample: {
      sourceSectionTitle: "10.2 Layout Example (Figure 67. PCB Layout Example)",
      referenceImageUri: join(DEFAULT_LAYOUT_IMG_DIR, "C96581_layout_example.png"),
      copperZones: [
        { zoneRole: "VIN_POLYGON", connectedPins: ["3"], relativeLayer: "MOUNT_LAYER", areaPolicy: "WIDE_LOW_INDUCTANCE" },
        { zoneRole: "SW_PH_COMPACT_ISLAND", connectedPins: ["2"], relativeLayer: "MOUNT_LAYER", areaPolicy: "COMPACT_MIN_PARASITIC", maxAreaMm2: 18 },
        { zoneRole: "VOUT_POLYGON", connectedPins: ["L1.2"], relativeLayer: "MOUNT_LAYER", areaPolicy: "WIDE_LOW_INDUCTANCE" },
        { zoneRole: "TOPSIDE_GND_AREA", connectedPins: ["1", "EP"], relativeLayer: "MOUNT_LAYER", areaPolicy: "THERMAL_SPREADING" },
      ],
      relativePlacementHints: [
        { componentRole: "CIN_HF", targetPins: ["3", "1"], preferredQuadrantDeg: 180, maxDistanceMm: 1.5, sameLayerMandatory: true },
        { componentRole: "CBOOT", targetPins: ["6", "2"], preferredQuadrantDeg: 90, maxDistanceMm: 1.8, sameLayerMandatory: true },
        { componentRole: "POWER_INDUCTOR", targetPins: ["2"], preferredQuadrantDeg: 0, maxDistanceMm: 2.0, sameLayerMandatory: true },
        { componentRole: "COUT", targetPins: ["L1.2", "1"], preferredQuadrantDeg: 330, maxDistanceMm: 2.0, sameLayerMandatory: true },
        { componentRole: "RFB_DIVIDER", targetPins: ["4"], preferredQuadrantDeg: 250, maxDistanceMm: 1.8, sameLayerMandatory: true },
      ],
      viaHints: [
        { viaRole: "GND_RETURN_CLUSTER", targetNetRole: "GND", policy: "Place >=2 0.3/0.6mm vias at CIN/COUT GND pads to Inner1 GND" },
        { viaRole: "BOOT_SIGNAL_VIA", targetNetRole: "BOOT", policy: "Only if pinout forces crossing, keep short" },
        { viaRole: "FORBID_VIA_IN_HOT_LOOP", targetNetRole: "SW", policy: "Never place vias in SW/VIN hot loop or blind thermal vias on SW copper" },
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
          pinOrNetRole: "FB",
          keepAwayFromRoles: ["SW_PH_COMPACT_ISLAND", "POWER_INDUCTOR"],
          minClearanceMm: 3.0,
          preferInnerOrOppositeLayer: false,
          tapPointRule: "AFTER_LAST_COUT_PAD",
        },
      ],
    },
  },
  {
    lcsc_id: "C7519",
    mpn: "USBLC6-2SC6",
    category: "TVS_ESD_MOV",
    package: "SOT-23-6",
    verified: true,
    pins: [
      { pin_number: "1", pin_name: "IO1_A", elec_type: "PASSIVE", v_abs_max: 6.0 },
      { pin_number: "2", pin_name: "GND", elec_type: "GND" },
      { pin_number: "3", pin_name: "IO2_A", elec_type: "PASSIVE", v_abs_max: 6.0 },
      { pin_number: "4", pin_name: "IO2_B", elec_type: "PASSIVE", v_abs_max: 6.0 },
      { pin_number: "5", pin_name: "VBUS", elec_type: "POWER_IN", v_abs_max: 6.0 },
      { pin_number: "6", pin_name: "IO1_B", elec_type: "PASSIVE", v_abs_max: 6.0 },
    ],
    ratings: { v_rwm_v: 5.25, v_clamp_max_v: 17, c_junction_pf: 0.8 },
    typical_application_constraints: ["Inline pass-through routing from connector through IO1/IO2 to MCU, zero stub"],
  },
  {
    lcsc_id: "C16137",
    mpn: "SM712-02HTG",
    category: "TVS_ESD_MOV",
    package: "SOT-23-3",
    verified: true,
    pins: [
      { pin_number: "1", pin_name: "A", elec_type: "PASSIVE", v_abs_max: 14.0 },
      { pin_number: "2", pin_name: "B", elec_type: "PASSIVE", v_abs_max: 14.0 },
      { pin_number: "3", pin_name: "GND", elec_type: "GND" },
    ],
    ratings: { v_rwm_v: 12.0, v_clamp_max_v: 26.0, c_junction_pf: 45 },
  },
  {
    lcsc_id: "C8963",
    mpn: "SP3485EN-L/TR",
    category: "INTERFACE_XCVR",
    package: "SOIC-8",
    verified: true,
    pins: [
      { pin_number: "1", pin_name: "RO", elec_type: "PUSH_PULL", supply_pin_ref: "VCC", v_abs_max: 3.6 },
      { pin_number: "2", pin_name: "RE#", elec_type: "INPUT_HIZ", supply_pin_ref: "VCC", v_abs_max: 3.6 },
      { pin_number: "3", pin_name: "DE", elec_type: "INPUT_HIZ", supply_pin_ref: "VCC", v_abs_max: 3.6 },
      { pin_number: "4", pin_name: "DI", elec_type: "INPUT_HIZ", supply_pin_ref: "VCC", v_abs_max: 3.6 },
      { pin_number: "5", pin_name: "GND", elec_type: "GND" },
      { pin_number: "6", pin_name: "A", elec_type: "BIDIR_IO", v_abs_min: -7.5, v_abs_max: 12.5 },
      { pin_number: "7", pin_name: "B", elec_type: "BIDIR_IO", v_abs_min: -7.5, v_abs_max: 12.5 },
      { pin_number: "8", pin_name: "VCC", elec_type: "POWER_IN", v_abs_max: 3.6, mandatory_external: "DECOUPLING_100NF" },
    ],
    ratings: { v_working_max: 3.6 },
  },
  {
    lcsc_id: "C498300",
    mpn: "ISO7741FDWR",
    category: "ISOLATOR_OPTO",
    package: "SOIC-16W",
    verified: true,
    pins: [
      { pin_number: "1", pin_name: "VCC1", elec_type: "POWER_IN", v_abs_max: 6.0, mandatory_external: "DECOUPLING_100NF" },
      { pin_number: "2", pin_name: "GND1", elec_type: "GND" },
      { pin_number: "3", pin_name: "INA", elec_type: "INPUT_HIZ", supply_pin_ref: "VCC1" },
      { pin_number: "4", pin_name: "INB", elec_type: "INPUT_HIZ", supply_pin_ref: "VCC1" },
      { pin_number: "5", pin_name: "INC", elec_type: "INPUT_HIZ", supply_pin_ref: "VCC1" },
      { pin_number: "6", pin_name: "OUTD", elec_type: "PUSH_PULL", supply_pin_ref: "VCC1" },
      { pin_number: "8", pin_name: "GND1_B", elec_type: "GND" },
      { pin_number: "9", pin_name: "GND2_B", elec_type: "GND" },
      { pin_number: "11", pin_name: "IND", elec_type: "INPUT_HIZ", supply_pin_ref: "VCC2" },
      { pin_number: "12", pin_name: "OUTC", elec_type: "PUSH_PULL", supply_pin_ref: "VCC2" },
      { pin_number: "13", pin_name: "OUTB", elec_type: "PUSH_PULL", supply_pin_ref: "VCC2" },
      { pin_number: "14", pin_name: "OUTA", elec_type: "PUSH_PULL", supply_pin_ref: "VCC2" },
      { pin_number: "15", pin_name: "GND2", elec_type: "GND" },
      { pin_number: "16", pin_name: "VCC2", elec_type: "POWER_IN", v_abs_max: 6.0, mandatory_external: "DECOUPLING_100NF" },
    ],
    ratings: { v_working_max: 5.5, isolation_vrms: 5000, default_output_state: "LOW" },
    typical_application_constraints: ["Primary (VCC1/GND1) and Secondary (VCC2/GND2) MUST remain isolated"],
  },
  {
    lcsc_id: "C66444",
    mpn: "PC817X1NSZ9F",
    category: "ISOLATOR_OPTO",
    package: "DIP-4",
    verified: true,
    polarity_spec: { is_polarized: true, anode_pins: ["1"], cathode_pins: ["2"], silkscreen_rule: "PIN1_DOT_IS_LED_ANODE" },
    pins: [
      { pin_number: "1", pin_name: "ANODE", elec_type: "PASSIVE" },
      { pin_number: "2", pin_name: "CATHODE", elec_type: "PASSIVE" },
      { pin_number: "3", pin_name: "EMITTER", elec_type: "PASSIVE" },
      { pin_number: "4", pin_name: "COLLECTOR", elec_type: "OPEN_DRAIN" },
    ],
    ratings: { isolation_vrms: 5000, v_working_max: 35 },
  },
  {
    lcsc_id: "C20917",
    mpn: "AO3400A",
    category: "MOSFET_BJT",
    package: "SOT-23-3",
    verified: true,
    pins: [
      { pin_number: "1", pin_name: "G", elec_type: "INPUT_HIZ", v_abs_min: -12, v_abs_max: 12 },
      { pin_number: "2", pin_name: "S", elec_type: "PASSIVE" },
      { pin_number: "3", pin_name: "D", elec_type: "PASSIVE", v_abs_max: 30 },
    ],
    ratings: { v_working_max: 30, vgs_rated_for_rdson_min_v: 2.5 },
  },
  {
    lcsc_id: "C15127",
    mpn: "AO3401A",
    category: "MOSFET_BJT",
    package: "SOT-23-3",
    verified: true,
    pins: [
      { pin_number: "1", pin_name: "G", elec_type: "INPUT_HIZ", v_abs_min: -12, v_abs_max: 12 },
      { pin_number: "2", pin_name: "S", elec_type: "PASSIVE", v_abs_max: 30 },
      { pin_number: "3", pin_name: "D", elec_type: "PASSIVE", v_abs_max: 30 },
    ],
    ratings: { v_working_max: 30, vgs_rated_for_rdson_min_v: 2.5 },
  },
  {
    lcsc_id: "C14998",
    mpn: "1N4007",
    category: "DIODE_SCHOTTKY",
    package: "SMA",
    verified: true,
    polarity_spec: { is_polarized: true, anode_pins: ["2"], cathode_pins: ["1"], silkscreen_rule: "BAR_IS_CATHODE" },
    pins: [
      { pin_number: "1", pin_name: "K", elec_type: "PASSIVE" },
      { pin_number: "2", pin_name: "A", elec_type: "PASSIVE" },
    ],
    ratings: { v_working_max: 1000, i_rms_a: 1.0 },
  },
  {
    lcsc_id: "C8678",
    mpn: "SS34",
    category: "DIODE_SCHOTTKY",
    package: "SMA",
    verified: true,
    polarity_spec: { is_polarized: true, anode_pins: ["2"], cathode_pins: ["1"], silkscreen_rule: "BAR_IS_CATHODE" },
    pins: [
      { pin_number: "1", pin_name: "K", elec_type: "PASSIVE" },
      { pin_number: "2", pin_name: "A", elec_type: "PASSIVE" },
    ],
    ratings: { v_working_max: 40, i_rms_a: 3.0 },
  },
  {
    lcsc_id: "C2128",
    mpn: "1N4148WS",
    category: "DIODE_SCHOTTKY",
    package: "SOD-323",
    verified: true,
    polarity_spec: { is_polarized: true, anode_pins: ["2"], cathode_pins: ["1"], silkscreen_rule: "BAR_IS_CATHODE" },
    pins: [
      { pin_number: "1", pin_name: "K", elec_type: "PASSIVE" },
      { pin_number: "2", pin_name: "A", elec_type: "PASSIVE" },
    ],
    ratings: { v_working_max: 75, i_rms_a: 0.15 },
  },
  {
    lcsc_id: "C173413",
    mpn: "BZT52C12",
    category: "DIODE_SCHOTTKY",
    package: "SOD-123",
    verified: true,
    polarity_spec: { is_polarized: true, anode_pins: ["2"], cathode_pins: ["1"], silkscreen_rule: "BAR_IS_CATHODE" },
    pins: [
      { pin_number: "1", pin_name: "K", elec_type: "PASSIVE" },
      { pin_number: "2", pin_name: "A", elec_type: "PASSIVE" },
    ],
    ratings: { v_working_max: 12, power_rated_w: 0.5 },
  },
  {
    lcsc_id: "C81598",
    mpn: "SMF5.0A",
    category: "TVS_ESD_MOV",
    package: "SOD-123FL",
    verified: true,
    polarity_spec: { is_polarized: true, anode_pins: ["2"], cathode_pins: ["1"], silkscreen_rule: "BAR_IS_CATHODE" },
    pins: [
      { pin_number: "1", pin_name: "K", elec_type: "PASSIVE" },
      { pin_number: "2", pin_name: "A", elec_type: "PASSIVE" },
    ],
    ratings: { v_rwm_v: 5.0, v_clamp_max_v: 9.2, c_junction_pf: 800 },
  },
  {
    lcsc_id: "C112582",
    mpn: "SHT30-DIS-B",
    category: "ADC_DAC_VREF",
    package: "DFN-8_2.5x2.5",
    verified: true,
    pins: [
      { pin_number: "1", pin_name: "SDA", elec_type: "OPEN_DRAIN", supply_pin_ref: "VDD", v_abs_max: 5.5, mandatory_external: "PULLUP_RES" },
      { pin_number: "2", pin_name: "ADDR", elec_type: "INPUT_HIZ", supply_pin_ref: "VDD" },
      { pin_number: "3", pin_name: "ALERT", elec_type: "OPEN_DRAIN", supply_pin_ref: "VDD" },
      { pin_number: "4", pin_name: "SCL", elec_type: "OPEN_DRAIN", supply_pin_ref: "VDD", v_abs_max: 5.5, mandatory_external: "PULLUP_RES" },
      { pin_number: "5", pin_name: "VDD", elec_type: "POWER_IN", v_abs_max: 5.5, mandatory_external: "DECOUPLING_100NF" },
      { pin_number: "6", pin_name: "NRESET", elec_type: "INPUT_HIZ", supply_pin_ref: "VDD" },
      { pin_number: "7", pin_name: "R", elec_type: "GND" },
      { pin_number: "8", pin_name: "VSS", elec_type: "GND" },
    ],
    ratings: { v_working_max: 5.5 },
    layout_guidelines: [
      "Place at ventilation edge >=15mm away from heat sources (LDO/DC-DC/power resistors)",
      "Mill U-shaped 1.0-1.5mm thermal isolation slot around 3 sides of sensor",
    ],
  },
  {
    lcsc_id: "C13738",
    mpn: "X32258MSB4SI",
    category: "XTAL_PASSIVE",
    package: "SMD-3225-4P",
    verified: true,
    pins: [
      { pin_number: "1", pin_name: "OSC1", elec_type: "PASSIVE" },
      { pin_number: "2", pin_name: "GND_1", elec_type: "GND" },
      { pin_number: "3", pin_name: "OSC2", elec_type: "PASSIVE" },
      { pin_number: "4", pin_name: "GND_2", elec_type: "GND" },
    ],
    ratings: { v_working_max: 5.0 },
    layout_guidelines: [
      "Ground pins 2 and 4 solidly to GND",
      "Use C0G/NP0 load capacitors computed from C1=C2=2*(CL-Cstray)",
    ],
  },
  // Standard Passives & Discrete Helpers
  {
    lcsc_id: "C25905",
    mpn: "0402WGF5101TCE",
    category: "RES_CHIP",
    package: "0402",
    verified: true,
    pins: [{ pin_number: "1", pin_name: "1", elec_type: "PASSIVE" }, { pin_number: "2", pin_name: "2", elec_type: "PASSIVE" }],
    ratings: { v_working_max: 50, power_rated_w: 0.0625 },
  },
  {
    lcsc_id: "C25744",
    mpn: "0402WGF1002TCE",
    category: "RES_CHIP",
    package: "0402",
    verified: true,
    pins: [{ pin_number: "1", pin_name: "1", elec_type: "PASSIVE" }, { pin_number: "2", pin_name: "2", elec_type: "PASSIVE" }],
    ratings: { v_working_max: 50, power_rated_w: 0.0625 },
  },
  {
    lcsc_id: "C25900",
    mpn: "0402WGF4701TCE",
    category: "RES_CHIP",
    package: "0402",
    verified: true,
    pins: [{ pin_number: "1", pin_name: "1", elec_type: "PASSIVE" }, { pin_number: "2", pin_name: "2", elec_type: "PASSIVE" }],
    ratings: { v_working_max: 50, power_rated_w: 0.0625 },
  },
  {
    lcsc_id: "C25092",
    mpn: "0402WGF220JTCE",
    category: "RES_CHIP",
    package: "0402",
    verified: true,
    pins: [{ pin_number: "1", pin_name: "1", elec_type: "PASSIVE" }, { pin_number: "2", pin_name: "2", elec_type: "PASSIVE" }],
    ratings: { v_working_max: 50, power_rated_w: 0.0625 },
  },
  {
    lcsc_id: "C17437",
    mpn: "0805W8F1200T5E",
    category: "RES_CHIP",
    package: "0805",
    verified: true,
    pins: [{ pin_number: "1", pin_name: "1", elec_type: "PASSIVE" }, { pin_number: "2", pin_name: "2", elec_type: "PASSIVE" }],
    ratings: { v_working_max: 150, power_rated_w: 0.25 },
  },
  {
    lcsc_id: "C23244",
    mpn: "0603WAF750KT5E",
    category: "RES_CHIP",
    package: "0603",
    verified: true,
    pins: [{ pin_number: "1", pin_name: "1", elec_type: "PASSIVE" }, { pin_number: "2", pin_name: "2", elec_type: "PASSIVE" }],
    ratings: { v_working_max: 75, power_rated_w: 0.1 },
  },
  {
    lcsc_id: "C17936",
    mpn: "1206W4F1003T5E",
    category: "RES_CHIP",
    package: "1206",
    verified: true,
    pins: [{ pin_number: "1", pin_name: "1", elec_type: "PASSIVE" }, { pin_number: "2", pin_name: "2", elec_type: "PASSIVE" }],
    ratings: { v_working_max: 200, power_rated_w: 0.25 },
  },
  {
    lcsc_id: "C1525",
    mpn: "CL05B104KO5NNNC",
    category: "CAP_MLCC",
    package: "0402",
    verified: true,
    pins: [{ pin_number: "1", pin_name: "1", elec_type: "PASSIVE" }, { pin_number: "2", pin_name: "2", elec_type: "PASSIVE" }],
    ratings: { v_working_max: 16, dielectric: "X7R", dc_bias_retention_at_80pct_vr: 0.52 },
  },
  {
    lcsc_id: "C15850",
    mpn: "CL21B106KOQNNNE",
    category: "CAP_MLCC",
    package: "0805",
    verified: true,
    pins: [{ pin_number: "1", pin_name: "1", elec_type: "PASSIVE" }, { pin_number: "2", pin_name: "2", elec_type: "PASSIVE" }],
    ratings: { v_working_max: 16, dielectric: "X7R", dc_bias_retention_at_80pct_vr: 0.60 },
  },
  {
    lcsc_id: "C1549",
    mpn: "CL05C150JB5NNNC",
    category: "CAP_MLCC",
    package: "0402",
    verified: true,
    pins: [{ pin_number: "1", pin_name: "1", elec_type: "PASSIVE" }, { pin_number: "2", pin_name: "2", elec_type: "PASSIVE" }],
    ratings: { v_working_max: 50, dielectric: "C0G_NP0", dc_bias_retention_at_80pct_vr: 1.0 },
  },
  {
    lcsc_id: "C9196",
    mpn: "CC1206KKX7RDBB102",
    category: "CAP_MLCC",
    package: "1206",
    verified: true,
    pins: [{ pin_number: "1", pin_name: "1", elec_type: "PASSIVE" }, { pin_number: "2", pin_name: "2", elec_type: "PASSIVE" }],
    ratings: { v_working_max: 2000, dielectric: "X7R", dc_bias_retention_at_80pct_vr: 0.85 },
  },
  {
    lcsc_id: "C7171",
    mpn: "TAJA106K016RNJ",
    category: "CAP_TANTALUM",
    package: "CASE-A",
    verified: true,
    polarity_spec: { is_polarized: true, anode_pins: ["1"], cathode_pins: ["2"], silkscreen_rule: "BAR_IS_POSITIVE_ANODE" },
    pins: [{ pin_number: "1", pin_name: "+", elec_type: "PASSIVE" }, { pin_number: "2", pin_name: "-", elec_type: "PASSIVE" }],
    ratings: { v_working_max: 16, dielectric: "MNO2_TANT" },
  },
  {
    lcsc_id: "C134625",
    mpn: "RVT1E101M0605",
    category: "CAP_AL_ELEC",
    package: "SMD-6.3x5.4",
    verified: true,
    polarity_spec: { is_polarized: true, anode_pins: ["1"], cathode_pins: ["2"], silkscreen_rule: "SHADED_IS_NEGATIVE_CATHODE" },
    pins: [{ pin_number: "1", pin_name: "+", elec_type: "PASSIVE" }, { pin_number: "2", pin_name: "-", elec_type: "PASSIVE" }],
    ratings: { v_working_max: 25, dielectric: "AL_LIQUID" },
  },
  {
    lcsc_id: "C169395",
    mpn: "SWPA4030S4R7MT",
    category: "IND_POWER",
    package: "SMD-4030",
    verified: true,
    pins: [{ pin_number: "1", pin_name: "1", elec_type: "PASSIVE" }, { pin_number: "2", pin_name: "2", elec_type: "PASSIVE" }],
    ratings: { i_rms_a: 2.3, i_sat_a: 2.9 },
  },
  {
    lcsc_id: "C1017",
    mpn: "PZ1608U601-2R0TF",
    category: "FERRITE_CMC",
    package: "0603",
    verified: true,
    pins: [{ pin_number: "1", pin_name: "1", elec_type: "PASSIVE" }, { pin_number: "2", pin_name: "2", elec_type: "PASSIVE" }],
    ratings: { i_rms_a: 2.0 },
  },
  {
    lcsc_id: "C2286",
    mpn: "KT-0603G",
    category: "LED",
    package: "0603",
    verified: true,
    polarity_spec: { is_polarized: true, anode_pins: ["1"], cathode_pins: ["2"], silkscreen_rule: "BAR_IS_CATHODE" },
    pins: [{ pin_number: "1", pin_name: "A", elec_type: "PASSIVE" }, { pin_number: "2", pin_name: "K", elec_type: "PASSIVE" }],
    ratings: { v_working_max: 5.0 },
  },
  {
    lcsc_id: "C189983",
    mpn: "SRD-05VDC-SL-C",
    category: "RELAY_BUZZER",
    package: "RELAY-THT-5P",
    verified: true,
    pins: [
      { pin_number: "1", pin_name: "COIL_1", elec_type: "PASSIVE" },
      { pin_number: "2", pin_name: "COIL_2", elec_type: "PASSIVE" },
      { pin_number: "3", pin_name: "COM", elec_type: "PASSIVE" },
      { pin_number: "4", pin_name: "NC", elec_type: "PASSIVE" },
      { pin_number: "5", pin_name: "NO", elec_type: "PASSIVE" },
    ],
    ratings: { v_working_max: 250, isolation_vrms: 1500 },
  },
  {
    lcsc_id: "C15401",
    mpn: "HR911105A",
    category: "CONN_GENERIC",
    package: "RJ45-MAGJACK",
    verified: true,
    pins: [
      { pin_number: "1", pin_name: "TX+", elec_type: "PASSIVE" },
      { pin_number: "2", pin_name: "TX-", elec_type: "PASSIVE" },
      { pin_number: "3", pin_name: "RX+", elec_type: "PASSIVE" },
      { pin_number: "4", pin_name: "CT_TX", elec_type: "PASSIVE" },
      { pin_number: "5", pin_name: "CT_RX", elec_type: "PASSIVE" },
      { pin_number: "6", pin_name: "RX-", elec_type: "PASSIVE" },
      { pin_number: "7", pin_name: "CT_RJ_1", elec_type: "PASSIVE" },
      { pin_number: "8", pin_name: "CT_RJ_2", elec_type: "PASSIVE" },
      { pin_number: "S1", pin_name: "SHIELD_PGND", elec_type: "GND" },
    ],
    ratings: { isolation_vrms: 1500 },
  },
];

// ============================================================================
// Vector-Rendered Reference Layout Example PNG Generator (via pngjs)
// ============================================================================

const BITMAP_FONT_3X5: Record<string, number[]> = {
  A: [0b010, 0b101, 0b111, 0b101, 0b101],
  B: [0b110, 0b101, 0b110, 0b101, 0b110],
  C: [0b011, 0b100, 0b100, 0b100, 0b011],
  D: [0b110, 0b101, 0b101, 0b101, 0b110],
  E: [0b111, 0b100, 0b110, 0b100, 0b111],
  F: [0b111, 0b100, 0b110, 0b100, 0b100],
  G: [0b011, 0b100, 0b101, 0b101, 0b011],
  H: [0b101, 0b101, 0b111, 0b101, 0b101],
  I: [0b111, 0b010, 0b010, 0b010, 0b111],
  L: [0b100, 0b100, 0b100, 0b100, 0b111],
  N: [0b101, 0b111, 0b111, 0b101, 0b101],
  O: [0b111, 0b101, 0b101, 0b101, 0b111],
  P: [0b110, 0b101, 0b110, 0b100, 0b100],
  R: [0b110, 0b101, 0b110, 0b101, 0b101],
  S: [0b011, 0b100, 0b111, 0b001, 0b110],
  T: [0b111, 0b010, 0b010, 0b010, 0b010],
  U: [0b101, 0b101, 0b101, 0b101, 0b111],
  V: [0b101, 0b101, 0b101, 0b101, 0b010],
  W: [0b101, 0b101, 0b111, 0b111, 0b101],
  X: [0b101, 0b101, 0b010, 0b101, 0b101],
  "0": [0b111, 0b101, 0b101, 0b101, 0b111],
  "1": [0b010, 0b110, 0b010, 0b010, 0b111],
  "2": [0b110, 0b001, 0b010, 0b100, 0b111],
  "3": [0b110, 0b001, 0b110, 0b001, 0b110],
  "4": [0b101, 0b101, 0b111, 0b001, 0b001],
  "5": [0b111, 0b100, 0b110, 0b001, 0b110],
  "6": [0b011, 0b100, 0b111, 0b101, 0b111],
  "7": [0b111, 0b001, 0b010, 0b010, 0b010],
  "8": [0b111, 0b101, 0b111, 0b101, 0b111],
  "9": [0b111, 0b101, 0b111, 0b001, 0b110],
  "-": [0b000, 0b000, 0b111, 0b000, 0b000],
  "_": [0b000, 0b000, 0b000, 0b000, 0b111],
  ":": [0b000, 0b010, 0b000, 0b010, 0b000],
  " ": [0b000, 0b000, 0b000, 0b000, 0b000],
};

function setPixel(png: PNG, x: number, y: number, r: number, g: number, b: number, a = 255): void {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= png.width || yi >= png.height) return;
  const idx = (png.width * yi + xi) << 2;
  png.data[idx] = r;
  png.data[idx + 1] = g;
  png.data[idx + 2] = b;
  png.data[idx + 3] = a;
}

function fillRect(
  png: PNG,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
  a = 255
): void {
  for (let yy = Math.round(y); yy < Math.round(y + h); yy++) {
    for (let xx = Math.round(x); xx < Math.round(x + w); xx++) {
      setPixel(png, xx, yy, r, g, b, a);
    }
  }
}

function drawRectOutline(
  png: PNG,
  x: number,
  y: number,
  w: number,
  h: number,
  thickness: number,
  r: number,
  g: number,
  b: number
): void {
  fillRect(png, x, y, w, thickness, r, g, b);
  fillRect(png, x, y + h - thickness, w, thickness, r, g, b);
  fillRect(png, x, y, thickness, h, r, g, b);
  fillRect(png, x + w - thickness, y, thickness, h, r, g, b);
}

function fillCircle(
  png: PNG,
  cx: number,
  cy: number,
  radius: number,
  r: number,
  g: number,
  b: number
): void {
  const r2 = radius * radius;
  for (let dy = -Math.ceil(radius); dy <= Math.ceil(radius); dy++) {
    for (let dx = -Math.ceil(radius); dx <= Math.ceil(radius); dx++) {
      if (dx * dx + dy * dy <= r2) {
        setPixel(png, cx + dx, cy + dy, r, g, b);
      }
    }
  }
}

function drawLineThick(
  png: PNG,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thickness: number,
  r: number,
  g: number,
  b: number
): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  const rad = Math.max(1, thickness / 2);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    fillCircle(png, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, rad, r, g, b);
  }
}

function drawText(
  png: PNG,
  text: string,
  x: number,
  y: number,
  scale: number,
  r: number,
  g: number,
  b: number
): void {
  let cursor = x;
  for (const rawCh of text.toUpperCase()) {
    const glyph = BITMAP_FONT_3X5[rawCh] ?? BITMAP_FONT_3X5[" "];
    for (let row = 0; row < 5; row++) {
      const bits = glyph[row];
      for (let col = 0; col < 3; col++) {
        if ((bits >> (2 - col)) & 1) {
          fillRect(png, cursor + col * scale, y + row * scale, scale, scale, r, g, b);
        }
      }
    }
    cursor += 4 * scale;
  }
}

/**
 * Render a crisp vector reference PCB Layout Example PNG using `pngjs`
 * and cache it to disk for side-by-side comparison.
 */
export function renderLayoutExamplePng(
  cesm: CesmModel,
  outputDir = DEFAULT_LAYOUT_IMG_DIR
): string {
  mkdirSync(outputDir, { recursive: true });
  const outPath = join(outputDir, `${cesm.lcsc_id}_layout_example.png`);
  const png = new PNG({ width: 640, height: 480 });

  // Substrate green-black background
  fillRect(png, 0, 0, 640, 480, 18, 34, 24);
  // Subtle 20px metric grid
  for (let x = 0; x < 640; x += 20) {
    fillRect(png, x, 0, 1, 480, 28, 52, 37);
  }
  for (let y = 0; y < 480; y += 20) {
    fillRect(png, 0, y, 640, 1, 28, 52, 37);
  }

  // Header banner
  fillRect(png, 0, 0, 640, 34, 12, 22, 16);
  drawText(png, `${cesm.lcsc_id} ${cesm.mpn} LAYOUT EXAMPLE`, 16, 10, 2, 230, 245, 235);

  const cx = 280;
  const cy = 240;

  // 1. Copper zones from layoutExample
  // TOPSIDE_GND_AREA (dark teal-green copper pour)
  fillRect(png, 70, 80, 190, 310, 26, 98, 72);
  drawRectOutline(png, 70, 80, 190, 310, 2, 55, 165, 120);
  drawText(png, "TOPSIDE GND", 80, 92, 2, 175, 240, 210);

  // VIN_POLYGON (crimson copper zone)
  fillRect(png, 70, 220, 175, 100, 155, 48, 42);
  drawRectOutline(png, 70, 220, 175, 100, 2, 225, 95, 80);
  drawText(png, "VIN POLYGON", 82, 234, 2, 255, 200, 190);

  // SW_PH_COMPACT_ISLAND (amber copper island - kept compact)
  fillRect(png, 310, 175, 105, 95, 185, 122, 28);
  drawRectOutline(png, 310, 175, 105, 95, 2, 245, 180, 60);
  drawText(png, "SW ISLAND", 316, 184, 2, 255, 240, 185);

  // VOUT_POLYGON (blue-cyan copper zone)
  fillRect(png, 445, 155, 155, 145, 36, 110, 165);
  drawRectOutline(png, 445, 155, 155, 145, 2, 85, 185, 245);
  drawText(png, "VOUT POLYGON", 455, 166, 2, 205, 240, 255);

  // 2. Central IC body & EPAD with thermal via array
  fillRect(png, cx - 50, cy - 50, 100, 100, 42, 46, 52);
  drawRectOutline(png, cx - 50, cy - 50, 100, 100, 2, 210, 215, 220);

  // EPAD copper & Thermal Via Grid
  const tva = cesm.layoutExample?.thermalViaArray;
  const rows = tva?.gridRows ?? 3;
  const cols = tva?.gridCols ?? 3;
  fillRect(png, cx - 28, cy - 28, 56, 56, 195, 145, 50);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const vx = cx - 16 + c * (cols > 1 ? 32 / (cols - 1) : 0);
      const vy = cy - 16 + r * (rows > 1 ? 32 / (rows - 1) : 0);
      fillCircle(png, vx, vy, 5, 240, 205, 90);
      fillCircle(png, vx, vy, 2.5, 15, 20, 18);
    }
  }

  // IC Pins
  for (let i = 0; i < 3; i++) {
    const py = cy - 32 + i * 32;
    fillRect(png, cx - 64, py - 6, 14, 12, 215, 175, 75);
    fillRect(png, cx + 50, py - 6, 14, 12, 215, 175, 75);
  }
  drawText(png, "U1", cx - 10, cy - 44, 2, 250, 250, 250);

  // 3. Relative Placement Hints components
  const hints = cesm.layoutExample?.relativePlacementHints ?? [];
  const drawSatellite = (role: string, deg: number, distPx: number, w: number, h: number) => {
    const rad = (deg * Math.PI) / 180;
    const sx = cx + Math.cos(rad) * distPx;
    const sy = cy - Math.sin(rad) * distPx;
    fillRect(png, sx - w / 2, sy - h / 2, w, h, 88, 66, 44);
    drawRectOutline(png, sx - w / 2, sy - h / 2, w, h, 2, 230, 190, 110);
    fillRect(png, sx - w / 2 - 4, sy - h / 2 + 2, 8, h - 4, 210, 210, 215);
    fillRect(png, sx + w / 2 - 4, sy - h / 2 + 2, 8, h - 4, 210, 210, 215);
    drawText(png, role.slice(0, 8), sx - 24, sy - h / 2 - 14, 2, 245, 245, 200);
  };

  if (hints.length > 0) {
    for (const h of hints) {
      const isInd = h.componentRole.includes("INDUCTOR");
      drawSatellite(
        h.componentRole,
        h.preferredQuadrantDeg,
        isInd ? 150 : 112,
        isInd ? 76 : 44,
        isInd ? 68 : 24
      );
    }
  } else {
    drawSatellite("CIN_HF", 180, 112, 44, 24);
    drawSatellite("CBOOT", 90, 105, 36, 20);
    drawSatellite("L1", 0, 148, 76, 68);
    drawSatellite("COUT", 330, 195, 44, 24);
    drawSatellite("RFB", 250, 112, 36, 20);
  }

  // 4. Sensitive FB/VSENSE trace routed cleanly around SW & L1 from COUT
  drawLineThick(png, 480, 270, 480, 395, 4, 80, 235, 165);
  drawLineThick(png, 480, 395, 240, 395, 4, 80, 235, 165);
  drawLineThick(png, 240, 395, 240, 295, 4, 80, 235, 165);
  drawText(png, "VSENSE AWAY FROM SW", 255, 408, 2, 120, 250, 185);

  const pngBuffer = PNG.sync.write(png);
  writeFileSync(outPath, pngBuffer);
  return outPath;
}

// ============================================================================
// PDF Datasheet Text Parser (`unpdf`)
// ============================================================================

export interface ParsedDatasheetSections {
  rawTextLength: number;
  mpnDetected?: string;
  vAbsMaxV?: number;
  tjMaxC?: number;
  rThetaJaCPerW?: number;
  mlccOutputStable?: boolean;
  layoutGuidelines: string[];
  layoutExample?: CesmLayoutExample;
}

/**
 * Parse a real PDF datasheet Buffer using `unpdf` and extract
 * AbsMax, Thermal, Layout Guidelines, and Layout Example metadata.
 */
export async function parseDatasheetPdfBuffer(
  pdfBuffer: Buffer | Uint8Array,
  lcscId: string
): Promise<ParsedDatasheetSections> {
  const uint8 = pdfBuffer instanceof Uint8Array ? pdfBuffer : new Uint8Array(pdfBuffer);
  const { text } = await extractText(uint8, { mergePages: true });
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let vAbsMaxV: number | undefined;
  let tjMaxC: number | undefined;
  let rThetaJaCPerW: number | undefined;
  let mlccOutputStable: boolean | undefined;

  const vMatch = text.match(
    /(?:Input\s+Voltage|VIN|VCC|Supply\s+Voltage|Abs(?:olute)?\s*Max(?:imum)?[^\n]{0,40}?)\s*(?:up\s+to|max|:|=)?\s*(-?\d+(?:\.\d+)?)\s*(?:to|~|-)\s*(\d+(?:\.\d+)?)\s*V/i
  ) ?? text.match(/V(?:IN|CC|DD)\s*(?:max|abs)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*V/i);
  if (vMatch) {
    const val = Number(vMatch[2] ?? vMatch[1]);
    if (Number.isFinite(val)) vAbsMaxV = val;
  }

  const tjMatch = text.match(/(?:TJ\s*\(?max\)?|Junction\s+Temperature[^\n]{0,30})\s*[:=]?\s*(\d+(?:\.\d+)?)\s*°?\s*C/i);
  if (tjMatch) {
    const val = Number(tjMatch[1]);
    if (Number.isFinite(val)) tjMaxC = val;
  }

  const rthMatch = text.match(/(?:RthetaJA|R_?θJA|θJA|Thermal\s+Resistance[^\n]{0,30})\s*[:=]?\s*(\d+(?:\.\d+)?)\s*°?\s*C\/W/i);
  if (rthMatch) {
    const val = Number(rthMatch[1]);
    if (Number.isFinite(val)) rThetaJaCPerW = val;
  }

  if (/stable\s+with\s+(?:low-?esr\s+)?ceramic/i.test(text)) {
    mlccOutputStable = true;
  } else if (/not\s+stable\s+with\s+ceramic|requires\s+tantalum|esr\s+between/i.test(text)) {
    mlccOutputStable = false;
  }

  // Extract Layout Guidelines section lines
  const layoutGuidelines: string[] = [];
  let inGuidelines = false;
  let layoutExampleTitle: string | undefined;

  for (const line of lines) {
    if (/layout\s+guidelines/i.test(line)) {
      inGuidelines = true;
      continue;
    }
    if (/layout\s+example/i.test(line)) {
      inGuidelines = false;
      layoutExampleTitle = line;
      continue;
    }
    if (inGuidelines) {
      if (/^(?:\d+\.\d+\s+|section\s+|revision\s+history)/i.test(line)) {
        inGuidelines = false;
      } else if (line.length > 10 && layoutGuidelines.length < 15) {
        layoutGuidelines.push(line.replace(/^[-•*]\s*/, ""));
      }
    }
  }

  // Extract structured Layout Example clues if Layout Example section exists
  let layoutExample: CesmLayoutExample | undefined;
  if (layoutExampleTitle || /thermal\s+via|sw_ph|vin_polygon|topside\s+ground/i.test(text)) {
    const copperZones: CesmCopperZone[] = [];
    if (/VIN/i.test(text)) {
      copperZones.push({
        zoneRole: "VIN_POLYGON",
        connectedPins: ["VIN"],
        relativeLayer: "MOUNT_LAYER",
        areaPolicy: "WIDE_LOW_INDUCTANCE",
      });
    }
    if (/SW|PH/i.test(text)) {
      copperZones.push({
        zoneRole: "SW_PH_COMPACT_ISLAND",
        connectedPins: ["SW"],
        relativeLayer: "MOUNT_LAYER",
        areaPolicy: "COMPACT_MIN_PARASITIC",
      });
    }
    if (/VOUT/i.test(text)) {
      copperZones.push({
        zoneRole: "VOUT_POLYGON",
        connectedPins: ["VOUT"],
        relativeLayer: "MOUNT_LAYER",
        areaPolicy: "WIDE_LOW_INDUCTANCE",
      });
    }
    if (/ground\s+area|gnd\s+plane|topside\s+ground/i.test(text)) {
      copperZones.push({
        zoneRole: "TOPSIDE_GND_AREA",
        connectedPins: ["GND"],
        relativeLayer: "MOUNT_LAYER",
        areaPolicy: "THERMAL_SPREADING",
      });
    }

    let thermalViaArray: CesmThermalViaArray | undefined;
    const viaGridMatch = text.match(/(\d+)\s*[x×]\s*(\d+)\s*(?:thermal\s+via|via\s+array)/i);
    if (viaGridMatch || /epad|thermal\s+pad/i.test(text)) {
      thermalViaArray = {
        epadPinNumber: "EP",
        netRole: "GND",
        gridRows: viaGridMatch ? Number(viaGridMatch[1]) : 3,
        gridCols: viaGridMatch ? Number(viaGridMatch[2]) : 3,
        drillMm: 0.3,
        pitchMm: 1.0,
        solderMaskTentingOrPlug: true,
      };
    }

    const sensitiveRouteConstraints: CesmSensitiveRouteConstraint[] = [];
    if (/fb|vsense/i.test(text)) {
      sensitiveRouteConstraints.push({
        pinOrNetRole: "FB",
        keepAwayFromRoles: ["SW_PH_COMPACT_ISLAND", "POWER_INDUCTOR"],
        minClearanceMm: 3.0,
        preferInnerOrOppositeLayer: false,
        tapPointRule: "AFTER_LAST_COUT_PAD",
      });
    }

    const relativePlacementHints: CesmRelativePlacementHint[] = [];
    const viaHints: CesmViaHint[] = [];
    if (/boot/i.test(text)) {
      viaHints.push({
        viaRole: "BOOT_SIGNAL_VIA",
        targetNetRole: "BOOT",
        policy: "Short direct connection near BOOT/SW pins",
      });
    }

    layoutExample = {
      sourceSectionTitle: layoutExampleTitle ?? `${lcscId} Datasheet Layout Example`,
      ...(copperZones.length > 0 ? { copperZones } : {}),
      ...(relativePlacementHints.length > 0 ? { relativePlacementHints } : {}),
      ...(viaHints.length > 0 ? { viaHints } : {}),
      ...(thermalViaArray ? { thermalViaArray } : {}),
      ...(sensitiveRouteConstraints.length > 0 ? { sensitiveRouteConstraints } : {}),
    };
  }

  return {
    rawTextLength: text.length,
    vAbsMaxV,
    tjMaxC,
    rThetaJaCPerW,
    mlccOutputStable,
    layoutGuidelines,
    layoutExample,
  };
}

// ============================================================================
// CESM Binder + SQLite Cache (`node:sqlite`)
// ============================================================================

export class CesmBinder {
  private readonly sessionPool = new Map<string, CesmModel>();
  private readonly dbPath: string;
  private readonly schemaPath: string;
  private readonly layoutImgDir: string;
  private db: DatabaseSync | null = null;

  constructor(options?: {
    sqlitePath?: string;
    schemaPath?: string;
    layoutImageDir?: string;
    preloadGolden?: boolean;
  }) {
    this.dbPath = options?.sqlitePath ?? DEFAULT_SQLITE_PATH;
    this.schemaPath = options?.schemaPath ?? DEFAULT_SCHEMA_PATH;
    this.layoutImgDir = options?.layoutImageDir ?? DEFAULT_LAYOUT_IMG_DIR;
    if (options?.preloadGolden !== false) {
      this.ensureDbInitialized();
    }
  }

  private getDb(): DatabaseSync {
    if (!this.db) {
      if (this.dbPath !== ":memory:") {
        mkdirSync(dirname(this.dbPath), { recursive: true });
      }
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS cesm_models (
          lcsc_id TEXT PRIMARY KEY,
          mpn TEXT NOT NULL,
          category TEXT NOT NULL,
          package TEXT NOT NULL,
          verified INTEGER NOT NULL,
          cesm_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    }
    return this.db;
  }

  private ensureDbInitialized(): void {
    const db = this.getDb();
    const countRow = db.prepare("SELECT COUNT(*) AS cnt FROM cesm_models").get() as { cnt: number };
    if (countRow.cnt === 0) {
      const insert = db.prepare(`
        INSERT OR REPLACE INTO cesm_models (lcsc_id, mpn, category, package, verified, cesm_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      for (const rawModel of GOLDEN_CESM_LIST) {
        const model = structuredClone(rawModel);
        if (model.layoutExample) {
          model.layoutExample.referenceImageUri = renderLayoutExamplePng(model, this.layoutImgDir);
        }
        const check = validateCesmSchema(model, this.schemaPath);
        if (!check.valid) {
          throw new Error(`Golden CESM ${model.lcsc_id} failed schema validation: ${check.errors.join("; ")}`);
        }
        insert.run(
          model.lcsc_id,
          model.mpn,
          model.category,
          model.package,
          model.verified ? 1 : 0,
          JSON.stringify(model),
          now
        );
      }
    }
  }

  /**
   * Bind a validated CESM model into session memory and persist in SQLite cache.
   */
  public bindCesm(cesm: CesmModel, persist = true): CesmModel {
    const cloned = structuredClone(cesm);
    if (cloned.layoutExample && !cloned.layoutExample.referenceImageUri) {
      cloned.layoutExample.referenceImageUri = renderLayoutExamplePng(cloned, this.layoutImgDir);
    }
    const validation = validateCesmSchema(cloned, this.schemaPath);
    if (!validation.valid) {
      throw new Error(
        `CESM schema validation failed for ${cloned.lcsc_id}: ${validation.errors.join("; ")}`
      );
    }

    this.sessionPool.set(cloned.lcsc_id, cloned);

    if (persist) {
      const db = this.getDb();
      db.prepare(`
        INSERT OR REPLACE INTO cesm_models (lcsc_id, mpn, category, package, verified, cesm_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        cloned.lcsc_id,
        cloned.mpn,
        cloned.category,
        cloned.package,
        cloned.verified ? 1 : 0,
        JSON.stringify(cloned),
        new Date().toISOString()
      );
    }
    return cloned;
  }

  public isCesmBound(lcscId: string): boolean {
    return this.sessionPool.has(lcscId);
  }

  public getBoundCesm(lcscId: string): CesmModel | undefined {
    return this.sessionPool.get(lcscId);
  }

  public listBoundCesms(): CesmModel[] {
    return Array.from(this.sessionPool.values());
  }

  public clearSessionBindings(): void {
    this.sessionPool.clear();
  }

  /**
   * Lookup CESM from session pool -> SQLite cache -> Golden catalog.
   */
  public lookupCachedCesm(lcscId: string): CesmModel | undefined {
    const inSession = this.sessionPool.get(lcscId);
    if (inSession) return inSession;

    const db = this.getDb();
    const row = db
      .prepare("SELECT cesm_json FROM cesm_models WHERE lcsc_id = ?")
      .get(lcscId) as { cesm_json: string } | undefined;
    if (row) {
      return JSON.parse(row.cesm_json) as CesmModel;
    }

    const golden = GOLDEN_CESM_LIST.find((g) => g.lcsc_id === lcscId);
    return golden ? structuredClone(golden) : undefined;
  }

  /**
   * Search cached/golden LCSC parts by query or LCSC ID.
   */
  public searchParts(query: string, limit = 20): CesmModel[] {
    const q = query.trim().toLowerCase();
    const db = this.getDb();
    const rows = db.prepare("SELECT cesm_json FROM cesm_models").all() as Array<{ cesm_json: string }>;
    const allModels = rows.map((r) => JSON.parse(r.cesm_json) as CesmModel);
    if (!q) return allModels.slice(0, limit);
    return allModels
      .filter(
        (m) =>
          m.lcsc_id.toLowerCase().includes(q) ||
          m.mpn.toLowerCase().includes(q) ||
          m.category.toLowerCase().includes(q) ||
          m.package.toLowerCase().includes(q)
      )
      .slice(0, limit);
  }

  /**
   * Build, validate, cache, and optionally bind a CESM model from:
   * 1) Golden / SQLite library baseline
   * 2) Optional DeviceInspectResult (official EDA symbol/footprint pin truth)
   * 3) Optional PDF Datasheet Buffer (`unpdf`)
   * 4) Optional explicit custom overrides
   */
  public async extractAndBind(options: {
    lcscCode: string;
    pdfBuffer?: Buffer | Uint8Array;
    deviceInspect?: DeviceInspectResult;
    bindCesmToSession?: boolean;
    overrides?: Partial<CesmModel>;
  }): Promise<{ verified: boolean; cesm: CesmModel }> {
    const base = this.lookupCachedCesm(options.lcscCode);
    const parsedPdf = options.pdfBuffer
      ? await parseDatasheetPdfBuffer(options.pdfBuffer, options.lcscCode)
      : undefined;

    let pins: CesmPin[] = base?.pins ? structuredClone(base.pins) : [];
    if (options.deviceInspect && options.deviceInspect.symbolPins.length > 0) {
      // Align symbol pins with base electrical metadata
      pins = options.deviceInspect.symbolPins.map((sp) => {
        const matchedBase = base?.pins.find(
          (bp) => bp.pin_number === sp.pinNumber || bp.pin_name === sp.pinName
        );
        return {
          pin_number: sp.pinNumber,
          pin_name: sp.pinName,
          elec_type: (matchedBase?.elec_type ?? mapRawElecType(sp.elecType)) as CesmPinElecType,
          ...(matchedBase?.supply_pin_ref ? { supply_pin_ref: matchedBase.supply_pin_ref } : {}),
          ...(matchedBase?.v_abs_min !== undefined ? { v_abs_min: matchedBase.v_abs_min } : {}),
          ...(matchedBase?.v_abs_max !== undefined ? { v_abs_max: matchedBase.v_abs_max } : {}),
          ...(matchedBase?.five_volt_tolerant !== undefined
            ? { five_volt_tolerant: matchedBase.five_volt_tolerant }
            : {}),
          ...(matchedBase?.mandatory_external
            ? { mandatory_external: matchedBase.mandatory_external }
            : {}),
        };
      });
    }

    if (pins.length === 0) {
      pins = [
        { pin_number: "1", pin_name: "1", elec_type: "PASSIVE" },
        { pin_number: "2", pin_name: "2", elec_type: "PASSIVE" },
      ];
    }

    const mergedLayoutExample =
      options.overrides?.layoutExample ??
      base?.layoutExample ??
      parsedPdf?.layoutExample;

    const model: CesmModel = {
      lcsc_id: options.lcscCode,
      mpn: options.overrides?.mpn ?? options.deviceInspect?.mpn ?? base?.mpn ?? `GENERIC_${options.lcscCode}`,
      category: (options.overrides?.category ?? base?.category ?? "CONN_GENERIC") as CesmCategory,
      package: options.overrides?.package ?? options.deviceInspect?.package ?? base?.package ?? "UNKNOWN",
      verified: Boolean(base?.verified || options.deviceInspect || parsedPdf),
      ...(options.overrides?.polarity_spec ?? base?.polarity_spec
        ? { polarity_spec: options.overrides?.polarity_spec ?? base?.polarity_spec }
        : {}),
      pins,
      ratings: {
        ...(base?.ratings ?? {}),
        ...(parsedPdf?.vAbsMaxV !== undefined ? { v_working_max: parsedPdf.vAbsMaxV } : {}),
        ...(parsedPdf?.tjMaxC !== undefined ? { tj_max_c: parsedPdf.tjMaxC } : {}),
        ...(parsedPdf?.rThetaJaCPerW !== undefined ? { r_theta_ja_c_per_w: parsedPdf.rThetaJaCPerW } : {}),
        ...(parsedPdf?.mlccOutputStable !== undefined
          ? { mlcc_output_stable: parsedPdf.mlccOutputStable }
          : {}),
        ...(options.overrides?.ratings ?? {}),
      },
      ...(base?.typical_application_constraints || options.overrides?.typical_application_constraints
        ? {
            typical_application_constraints:
              options.overrides?.typical_application_constraints ??
              base?.typical_application_constraints,
          }
        : {}),
      ...(options.overrides?.layout_guidelines ??
      (parsedPdf && parsedPdf.layoutGuidelines.length > 0
        ? parsedPdf.layoutGuidelines
        : base?.layout_guidelines)
        ? {
            layout_guidelines:
              options.overrides?.layout_guidelines ??
              (parsedPdf && parsedPdf.layoutGuidelines.length > 0
                ? parsedPdf.layoutGuidelines
                : base?.layout_guidelines),
          }
        : {}),
      ...(mergedLayoutExample ? { layoutExample: structuredClone(mergedLayoutExample) } : {}),
    };

    if (model.layoutExample) {
      model.layoutExample.referenceImageUri = renderLayoutExamplePng(model, this.layoutImgDir);
    }

    const bindToSession = options.bindCesmToSession !== false;
    if (bindToSession) {
      const bound = this.bindCesm(model, true);
      return { verified: bound.verified, cesm: bound };
    }

    const validation = validateCesmSchema(model, this.schemaPath);
    if (!validation.valid) {
      throw new Error(`CESM schema validation failed: ${validation.errors.join("; ")}`);
    }
    return { verified: model.verified, cesm: model };
  }

  public close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

function mapRawElecType(raw: string): CesmPinElecType {
  const u = raw.toUpperCase();
  if (u.includes("POWER") && u.includes("OUT")) return "POWER_OUT";
  if (u.includes("POWER") || u.includes("VCC") || u.includes("VDD")) return "POWER_IN";
  if (u.includes("GND") || u.includes("VSS")) return "GND";
  if (u.includes("OPEN_DRAIN") || u.includes("OC")) return "OPEN_DRAIN";
  if (u.includes("PUSH") || u === "OUT" || u === "OUTPUT") return "PUSH_PULL";
  if (u.includes("ANALOG") && u.includes("OUT")) return "ANALOG_OUT";
  if (u.includes("ANALOG")) return "ANALOG_IN";
  if (u.includes("BIDIR") || u === "IO") return "BIDIR_IO";
  if (u.includes("IN")) return "INPUT_HIZ";
  if (u.includes("NC")) return "NC";
  return "PASSIVE";
}

// Default singleton binder for session-level convenience
const defaultBinder = new CesmBinder();

export function bindCesm(cesm: CesmModel, persist = true): CesmModel {
  return defaultBinder.bindCesm(cesm, persist);
}

export function isCesmBound(lcscId: string): boolean {
  return defaultBinder.isCesmBound(lcscId);
}

export function getBoundCesm(lcscId: string): CesmModel | undefined {
  return defaultBinder.getBoundCesm(lcscId);
}

export function clearSessionBindings(): void {
  defaultBinder.clearSessionBindings();
}

export function lookupGoldenOrCachedCesm(lcscId: string): CesmModel | undefined {
  return defaultBinder.lookupCachedCesm(lcscId);
}
