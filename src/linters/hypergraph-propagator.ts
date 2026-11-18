import type {
  CesmCategory,
  CesmModel,
  CesmPin,
  CesmPinElecType,
  CompiledComponent,
  CompiledNet,
  CompiledNetlist,
  CompiledPin,
} from "../types/index.js";

/**
 * Thrown when a caller attempts to run electrical linting or hypergraph propagation
 * on a non-authoritative netlist (e.g. reconstructed from 2D `sch_PrimitiveWire` geometry).
 */
export class AuthoritativeNetlistError extends Error {
  readonly code = "ERR_NON_AUTHORITATIVE_NETLIST";

  constructor(message: string) {
    super(message);
    this.name = "AuthoritativeNetlistError";
  }
}

export interface VoltageRange {
  vMin: number;
  vMax: number;
  vSurge: number;
  sources: string[];
  isGround: boolean;
  isNegativeRail: boolean;
  confidence: "EXPLICIT" | "PROPAGATED" | "INFERRED" | "UNKNOWN";
}

export interface HypergraphPinRef {
  designator: string;
  pinNumber: string;
  pinName: string;
  elecType: CesmPinElecType | string;
  netName: string | null;
  isConnected: boolean;
  cesmPin?: CesmPin;
  component: CompiledComponent;
  compiledPin: CompiledPin;
}

export interface HypergraphComponentNode {
  designator: string;
  component: CompiledComponent;
  cesm?: CesmModel;
  inferredCategory: CesmCategory | "UNKNOWN";
  normalizedPackage: string;
  resistanceOhms?: number;
  capacitancePf?: number;
  ratedVoltageV?: number;
  powerRatedW?: number;
  pins: HypergraphPinRef[];
}

export type NetSignalClass =
  | "GROUND"
  | "POWER"
  | "SW_NODE"
  | "I2C"
  | "SPI"
  | "UART"
  | "DIFF_USB2"
  | "DIFF_USB3_HDMI"
  | "DIFF_ETH"
  | "DIFF_RS485_CAN"
  | "XTAL"
  | "RF"
  | "ANALOG"
  | "CONTROL"
  | "SIGNAL";

export interface HypergraphNetEdge {
  netName: string;
  endpoints: HypergraphPinRef[];
  voltage: VoltageRange;
  isolationDomain: string;
  signalClass: NetSignalClass;
  isGround: boolean;
  isPowerRail: boolean;
  isSurgeInput: boolean;
  maxCurrentA?: number;
}

export interface IsolatorBarrierInfo {
  designator: string;
  category: CesmCategory | "RELAY" | "ISOLATOR";
  primaryPins: HypergraphPinRef[];
  secondaryPins: HypergraphPinRef[];
  primaryNets: string[];
  secondaryNets: string[];
  primaryDomains: string[];
  secondaryDomains: string[];
  breached: boolean;
  breachReason?: string;
}

export interface ElectricalHypergraph {
  netlistSource: "eda.sch_Netlist" | "eda.pcb_Netlist";
  documentName: string;
  components: Map<string, HypergraphComponentNode>;
  nets: Map<string, HypergraphNetEdge>;
  isolationDomains: Map<string, Set<string>>;
  isolators: IsolatorBarrierInfo[];
}

export type CesmResolver = (lcscId: string) => CesmModel | undefined;

const GROUND_NET_PATTERN =
  /^(?:[ADPCS]?GND\d*|GND(?:_[A-Z0-9]+)?|[A-Z0-9]+_GND|VSS\d*|VSSA|VSSD|VSSIO|AGND\d*|DGND\d*|PGND\d*|CGND|SGND|COM_GND|0V)$/i;

const NEGATIVE_RAIL_PATTERN =
  /^[-](?:(\d+(?:\.\d+)?)V(\d+)?|VEE)|^(?:VEE|VSS_NEG|VNEG)(?:_(\d+(?:\.\d+)?)V)?$/i;

const EXPLICIT_POWER_NAME_PATTERN =
  /^(?:\+?(?:VCC|VDD|VDDA|VDDIO|VBUS|VBAT|VSYS|VIN|VOUT|AVDD|DVDD|IOVDD|PWR|HV|AC)(?:_[A-Z0-9]+)*|\+?\d+(?:V\d+|\.\d+V?|V)(?:_[A-Z0-9]+)*|V\d+(?:_\d+)?|SYS_\d+V\d*|USB_VBUS)$/i;

const PACKAGE_POWER_DEFAULTS_W: Record<string, number> = {
  "0201": 0.05,
  "0402": 0.0625,
  "0603": 0.1,
  "0805": 0.125,
  "1206": 0.25,
  "1210": 0.5,
  "2010": 0.75,
  "2512": 1.0,
};

const PACKAGE_WORKING_VOLT_MAX: Record<string, number> = {
  "0201": 30,
  "0402": 50,
  "0603": 75,
  "0805": 150,
  "1206": 200,
  "1210": 200,
  "2010": 200,
  "2512": 250,
};

const PACKAGE_RTHETA_JA_DEFAULTS: Record<string, number> = {
  "SOT-23": 200,
  "SOT-23-5": 200,
  "SOT-23-3": 210,
  "SOT-89": 115,
  "SOT-223": 65,
  "DFN": 48,
  "QFN": 45,
  "TO-252": 48,
  "DPAK": 48,
  "SOIC-8": 120,
  "SOP-8": 120,
};

export function getPackagePowerRatedW(pkg: string): number {
  const norm = normalizePackageCode(pkg);
  return PACKAGE_POWER_DEFAULTS_W[norm] ?? 0.125;
}

export function getPackageWorkingMaxV(pkg: string): number {
  const norm = normalizePackageCode(pkg);
  return PACKAGE_WORKING_VOLT_MAX[norm] ?? 150;
}

export function getPackageDefaultRThetaJA(pkg: string): number {
  const upper = pkg.toUpperCase();
  for (const [key, val] of Object.entries(PACKAGE_RTHETA_JA_DEFAULTS)) {
    if (upper.includes(key)) return val;
  }
  return 110;
}

export function normalizePackageCode(raw: string | null | undefined): string {
  if (!raw) return "UNKNOWN";
  const upper = raw.toUpperCase().trim();
  const smdMatch = upper.match(/(?:^|[^0-9])(0201|0402|0603|0805|1206|1210|2010|2512)(?:$|[^0-9])/);
  if (smdMatch) return smdMatch[1];
  return upper;
}

export function parseResistanceOhms(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const cleaned = text.trim().replace(/Ω|OHM|OHMS/gi, "");
  // Match forms like 4k7, 5K1, 10k, 4.7k, 0R, 22R, 10m, 1M, 100
  const rNotation = cleaned.match(/(?:^|[\s_/])(\d+)([RrKkMm])(\d+)(?:$|[\s_/])/);
  if (rNotation) {
    const whole = Number(rNotation[1]);
    const sep = rNotation[2];
    const frac = Number(rNotation[3]) / Math.pow(10, rNotation[3].length);
    const val = whole + frac;
    if (sep === "k" || sep === "K") return val * 1e3;
    if (sep === "M") return val * 1e6;
    if (sep === "m") return val * 1e-3;
    return val;
  }
  const stdMatch = cleaned.match(/(?:^|[\s_/])(\d+(?:\.\d+)?)\s*(m|k|K|M|Meg|MEG|R)?(?:$|[\s_/])/);
  if (!stdMatch) return undefined;
  const num = Number(stdMatch[1]);
  if (!Number.isFinite(num)) return undefined;
  const unit = stdMatch[2] ?? "";
  if (unit === "m") return num * 1e-3;
  if (unit === "k" || unit === "K") return num * 1e3;
  if (unit === "M" || unit === "Meg" || unit === "MEG") return num * 1e6;
  return num;
}

export function parseCapacitancePf(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const m = text.match(/(\d+(?:\.\d+)?)\s*(pF|nF|uF|μF|mF)/i);
  if (!m) return undefined;
  const num = Number(m[1]);
  if (!Number.isFinite(num)) return undefined;
  const unit = m[2].toLowerCase();
  if (unit === "pf") return num;
  if (unit === "nf") return num * 1e3;
  if (unit === "uf" || unit === "μf") return num * 1e6;
  if (unit === "mf") return num * 1e9;
  return undefined;
}

export function parseRatedVoltageV(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const kvMatch = text.match(/(\d+(?:\.\d+)?)\s*kV/i);
  if (kvMatch) return Number(kvMatch[1]) * 1000;
  const vMatch = text.match(/(?:^|[\s/,_-])(\d+(?:\.\d+)?)\s*V(?:DC|AC)?(?:$|[\s/,_-])/i);
  if (vMatch) return Number(vMatch[1]);
  return undefined;
}

export function isGroundNetName(netName: string | null | undefined): boolean {
  if (!netName) return false;
  const trimmed = netName.trim();
  return GROUND_NET_PATTERN.test(trimmed);
}

/**
 * Parse nominal voltage from a rail name such as `VBUS`, `3V3`, `+5V`, `VIN_24V`, `AC_220V`.
 * Intentionally avoids misinterpreting chip/bus names like `RS485`, `CH340`, `USB2`, `DDR3`.
 */
export function parseVoltageFromNetName(netName: string): VoltageRange | undefined {
  const name = netName.trim();
  if (isGroundNetName(name)) {
    return {
      vMin: 0,
      vMax: 0,
      vSurge: 0,
      sources: [`GroundLabel:${name}`],
      isGround: true,
      isNegativeRail: false,
      confidence: "EXPLICIT",
    };
  }

  // Negative voltage rails e.g. -5V, -12V, VEE
  const negMatch = name.match(NEGATIVE_RAIL_PATTERN);
  if (negMatch) {
    let mag = 5.0;
    if (negMatch[1]) {
      mag = Number(negMatch[1] + (negMatch[2] ? `.${negMatch[2]}` : ""));
    } else if (negMatch[3]) {
      mag = Number(negMatch[3]);
    }
    return {
      vMin: -mag * 1.1,
      vMax: -mag * 0.9,
      vSurge: -mag * 1.25,
      sources: [`NegativeRail:${name}`],
      isGround: false,
      isNegativeRail: true,
      confidence: "EXPLICIT",
    };
  }

  // AC mains detection (220V / 230V / 110V / 380V AC)
  const acMatch = name.match(/(?:^|[_\-\s])(110|120|220|230|240|380|400)\s*V?(?:AC|MAINS|LINE|L_AC|N_AC)(?:$|[_\-\s])|(?:^|[_\-\s])AC[_\-]?(110|120|220|230|240|380)(?:V)?(?:$|[_\-\s])/i);
  if (acMatch) {
    const rms = Number(acMatch[1] ?? acMatch[2]);
    const peak = Math.round(rms * Math.SQRT2 * 10) / 10;
    return {
      vMin: 0,
      vMax: peak,
      vSurge: Math.round(peak * 1.2 * 10) / 10,
      sources: [`AcMains:${name}`],
      isGround: false,
      isNegativeRail: false,
      confidence: "EXPLICIT",
    };
  }

  if (/^(?:AC_L|AC_N|MAINS_L|MAINS_N|L_220V|N_220V)$/i.test(name)) {
    return {
      vMin: 0,
      vMax: 311,
      vSurge: 375,
      sources: [`AcMains:${name}`],
      isGround: false,
      isNegativeRail: false,
      confidence: "EXPLICIT",
    };
  }

  // Explicit 3V3 / 1V8 / 5V0 / VDD3V3 / VCC5V / 12V / 24V / 48V / 310V patterns with clear token boundaries
  const vSepMatch = name.match(/(?:^|[_\-\s+]|VDD|VCC|VOUT|VIN|PWR|V)(\d+)V(\d+)(?:$|[_\-\s])/i);
  if (vSepMatch) {
    const nom = Number(`${vSepMatch[1]}.${vSepMatch[2]}`);
    return makeNominalRange(nom, `RailLabel:${name}`, /VBUS/i.test(name));
  }

  const vSuffixMatch = name.match(/(?:^|[_\-\s+]|VDD|VCC|VOUT|VIN|PWR)(\d+(?:\.\d+)?)V(?:DC)?(?:$|[_\-\s])/i);
  if (vSuffixMatch) {
    const nom = Number(vSuffixMatch[1]);
    if (nom > 0 && nom <= 1500) {
      return makeNominalRange(nom, `RailLabel:${name}`, /VBUS/i.test(name));
    }
  }

  // Standard VBUS (USB 5V default with hot-plug ringing surge 11V)
  if (/^(?:VBUS|USB_VBUS|VBUS_IN|VBUS_RAW)$/i.test(name)) {
    return {
      vMin: 4.75,
      vMax: 5.5,
      vSurge: 11.0,
      sources: [`UsbVbus:${name}`],
      isGround: false,
      isNegativeRail: false,
      confidence: "EXPLICIT",
    };
  }

  // Standard VBAT (single Li-ion default 3.0V..4.2V)
  if (/^(?:VBAT|VBAT_IN|BAT_POS)$/i.test(name)) {
    return {
      vMin: 3.0,
      vMax: 4.2,
      vSurge: 5.0,
      sources: [`BatteryRail:${name}`],
      isGround: false,
      isNegativeRail: false,
      confidence: "EXPLICIT",
    };
  }

  return undefined;
}

function makeNominalRange(nom: number, source: string, isUsbVbus = false): VoltageRange {
  const tol = nom <= 5.5 ? 0.05 : 0.1;
  const vMin = Math.round(nom * (1 - tol) * 1000) / 1000;
  const vMax = Math.round(nom * (1 + tol) * 1000) / 1000;
  const vSurge = isUsbVbus
    ? Math.max(11.0, Math.round(nom * 1.4 * 1000) / 1000)
    : Math.round(nom * (nom >= 12 ? 1.25 : 1.15) * 1000) / 1000;
  return {
    vMin,
    vMax,
    vSurge,
    sources: [source],
    isGround: false,
    isNegativeRail: false,
    confidence: "EXPLICIT",
  };
}

function inferCategoryFromComponent(comp: CompiledComponent, cesm?: CesmModel): CesmCategory | "UNKNOWN" {
  if (cesm) return cesm.category;
  const des = comp.designator.toUpperCase();
  const val = `${comp.mpn ?? ""} ${comp.value ?? ""} ${comp.footprint ?? ""}`.toUpperCase();
  if (/^R\d/.test(des)) return val.includes("SHUNT") || val.includes("MOHM") ? "RES_SHUNT" : "RES_CHIP";
  if (/^C\d/.test(des)) {
    if (val.includes("TANT")) return "CAP_TANTALUM";
    if (val.includes("ELEC") || val.includes("AL_")) return "CAP_AL_ELEC";
    return "CAP_MLCC";
  }
  if (/^FB\d/.test(des) || val.includes("BEAD") || val.includes("CMC")) return "FERRITE_CMC";
  if (/^L\d/.test(des)) return "IND_POWER";
  if (/^(?:Y|X)\d/.test(des)) return val.includes("OSC") || val.includes("TCXO") ? "OSC_ACTIVE" : "XTAL_PASSIVE";
  if (/^(?:TVS|ESD)\d/.test(des) || val.includes("TVS") || val.includes("USBLC6") || val.includes("SM712")) return "TVS_ESD_MOV";
  if (/^LED\d/.test(des) || val.includes("LED")) return "LED";
  if (/^D\d/.test(des)) return "DIODE_SCHOTTKY";
  if (/^Q\d/.test(des)) return "MOSFET_BJT";
  if (/^(?:K|RLY|LS|BZ)\d/.test(des) || val.includes("RELAY") || val.includes("BUZZER")) return "RELAY_BUZZER";
  if (/^J\d|^USB\d|^CN\d/.test(des)) {
    if (val.includes("TYPE-C") || val.includes("TYPEC") || val.includes("USB-C")) return "CONN_USB_TYPEC";
    return "CONN_GENERIC";
  }
  if (/^U\d/.test(des)) {
    if (val.includes("1117") || val.includes("RT9013") || val.includes("LDO") || val.includes("XC6206") || val.includes("TLV755")) return "PMIC_LDO";
    if (val.includes("BUCK") || val.includes("TPS54") || val.includes("MP23") || val.includes("XL4015") || val.includes("B0505")) return "PMIC_DCDC";
    if (val.includes("ISO") || val.includes("PC817") || val.includes("6N137") || val.includes("OPTO") || val.includes("NSI82")) return "ISOLATOR_OPTO";
    if (val.includes("STM32") || val.includes("ESP32") || val.includes("MCU") || val.includes("RP2040")) return "MCU_SOC";
    if (val.includes("ADS") || val.includes("ADC") || val.includes("REF")) return "ADC_DAC_VREF";
  }
  return "UNKNOWN";
}

function classifyNetSignal(netName: string, endpoints: HypergraphPinRef[]): NetSignalClass {
  if (isGroundNetName(netName)) return "GROUND";
  const upper = netName.toUpperCase();
  const pinNames = endpoints.map((e) => e.pinName.toUpperCase()).join(" ");
  if (/\b(?:SW|LX|PH|SW_NODE)\b/.test(upper) || endpoints.some((e) => e.elecType === "SW_NODE")) {
    return "SW_NODE";
  }
  if (/(?:USB3|SSTX|SSRX|HDMI|TMDS|PCIE|MIPI)/i.test(upper)) return "DIFF_USB3_HDMI";
  if (/(?:USB_D[PM]|USB_D[+-]|D\+|D-|DP[12]?|DM[12]?|DN[12]?)/i.test(upper) || /DP|DM|D\+|D-/.test(pinNames)) {
    if (!/(?:VDD|VCC|GND)/.test(upper)) return "DIFF_USB2";
  }
  if (/(?:ETH|MDI|TX[+-]|RX[+-])/i.test(upper) && !/UART/i.test(upper)) return "DIFF_ETH";
  if (/(?:RS485|485_[AB]|CAN_?[HL])/i.test(upper)) return "DIFF_RS485_CAN";
  if (/(?:I2C|SDA|SCL)/i.test(upper) || /\b(?:SDA|SCL)\b/.test(pinNames)) return "I2C";
  if (/(?:SPI|SCK|SCLK|MOSI|MISO|CS#?|NSS)/i.test(upper)) return "SPI";
  if (/(?:UART|USART|TXD|RXD)/i.test(upper)) return "UART";
  if (/(?:XTAL|OSC_IN|OSC_OUT|XIN|XOUT|CLK_?32K|HSE|LSE)/i.test(upper) || /\b(?:OSC_IN|OSC_OUT|XTAL1|XTAL2|X1|X2)\b/.test(pinNames)) {
    return "XTAL";
  }
  if (/(?:RF|ANT)/i.test(upper)) return "RF";
  if (/(?:ADC|AIN|VSENSE|FB|IN[-+]|VREF|ISENSE|SHUNT)/i.test(upper) || endpoints.some((e) => e.elecType === "ANALOG_IN" || e.elecType === "ANALOG_OUT")) {
    return "ANALOG";
  }
  if (EXPLICIT_POWER_NAME_PATTERN.test(upper) || endpoints.some((e) => e.elecType === "POWER_OUT" || e.elecType === "POWER_IN")) {
    return "POWER";
  }
  if (/(?:NRST|RESET|BOOT|EN|SHDN|OE)/i.test(upper)) return "CONTROL";
  return "SIGNAL";
}

function isSafetyIsolationCapacitor(node: HypergraphComponentNode): boolean {
  const val = `${node.component.value ?? ""} ${node.component.mpn ?? ""}`.toUpperCase();
  const extra = node.component.extraProps;
  if (extra?.isSafetyYCap === true) return true;
  if (node.inferredCategory === "CAP_MLCC" || /^C\d/i.test(node.designator)) {
    if (/(?:Y1|Y2|SAFETY|2KV|3KV|4KV)/i.test(val)) return true;
    if ((node.ratedVoltageV ?? 0) >= 1500) return true;
  }
  return false;
}

function isIsolatorNode(node: HypergraphComponentNode): boolean {
  if (node.inferredCategory === "ISOLATOR_OPTO") return true;
  if (node.cesm?.ratings.isolation_vrms && node.cesm.ratings.isolation_vrms > 0) return true;
  if (node.component.extraProps?.isIsolated === true) return true;
  const text = `${node.component.mpn ?? ""} ${node.component.value ?? ""}`.toUpperCase();
  if (/B0505|B1205|B2405|ISO\d|ADUM|NSI82|PC817|6N137|TLP|EL817|HR911105|H1102/.test(text)) return true;
  if (node.inferredCategory === "RELAY_BUZZER") {
    const hasCoil = node.pins.some((p) => /COIL|A1|A2/i.test(p.pinName));
    const hasContact = node.pins.some((p) => /^(?:COM|NO|NC|POLE|LOAD)$/i.test(p.pinName));
    return hasCoil && hasContact;
  }
  return false;
}

function partitionIsolatorPins(node: HypergraphComponentNode): {
  primary: HypergraphPinRef[];
  secondary: HypergraphPinRef[];
} {
  const primary: HypergraphPinRef[] = [];
  const secondary: HypergraphPinRef[] = [];

  for (const pin of node.pins) {
    const name = pin.pinName.toUpperCase();
    const ref = (pin.cesmPin?.supply_pin_ref ?? "").toUpperCase();

    // Explicit side hints
    if (
      /PRI|COIL|A1|A2|ANODE|CATHODE|^A$|^K$|IN_1|OUT_1|VCC1|VDD1|GND1|VSS1|VCCA|GNDA|TD[+-]|TCT|PHY/.test(name) ||
      /VCC1|VDD1|VCCA/.test(ref)
    ) {
      primary.push(pin);
      continue;
    }
    if (
      /SEC|COM|NO|NC|CONTACT|EMITTER|COLLECTOR|^E$|^C$|VCC2|VDD2|GND2|VSS2|VCCB|GNDB|ISO|MX[+-]|MCT|RJ45|LINE/.test(name) ||
      /VCC2|VDD2|VCCB|ISO/.test(ref)
    ) {
      secondary.push(pin);
      continue;
    }

    // Optocoupler / Digital isolator / Isolated DC-DC pin number half-split fallback
    const num = Number(pin.pinNumber);
    const total = node.pins.length;
    if (Number.isFinite(num) && total >= 4) {
      if (num <= Math.floor(total / 2)) primary.push(pin);
      else secondary.push(pin);
    } else {
      primary.push(pin);
    }
  }

  return { primary, secondary };
}

function inferRegulatorOutputVoltage(node: HypergraphComponentNode): VoltageRange | undefined {
  const extra = node.component.extraProps;
  if (typeof extra?.v_out === "number" && Number.isFinite(extra.v_out)) {
    return makeNominalRange(extra.v_out, `RegulatorProp:${node.designator}`);
  }
  const text = `${node.component.mpn ?? ""} ${node.component.value ?? ""}`.toUpperCase();
  const mpnVolt = text.match(/(?:1117|9013|6206|755|5907|7A20|78|79|B05|B12|B24|LM2596|MP2315|TPS543\d\d)[-_]?(\d+(?:\.\d+)?|33|50|18|12|25|05|09|15)/);
  if (mpnVolt) {
    const token = mpnVolt[1];
    let v: number | undefined;
    if (token === "33") v = 3.3;
    else if (token === "50" || token === "05") v = 5.0;
    else if (token === "18") v = 1.8;
    else if (token === "12") v = 12.0;
    else if (token === "25") v = 2.5;
    else if (token === "09") v = 9.0;
    else if (token === "15") v = 15.0;
    else if (token.includes(".")) v = Number(token);
    if (v && Number.isFinite(v)) {
      return makeNominalRange(v, `RegulatorMPN:${node.designator}`);
    }
  }
  // Check pin name e.g. VOUT_3V3
  for (const pin of node.pins) {
    if (pin.elecType === "POWER_OUT") {
      const fromPin = parseVoltageFromNetName(pin.pinName);
      if (fromPin) return fromPin;
    }
  }
  return undefined;
}

/**
 * Build the authoritative Directed Electrical Hypergraph strictly from `CompiledNetlist`
 * (`eda.sch_Netlist` or `eda.pcb_Netlist`), execute forward voltage range propagation
 * across series pass-through elements & resistive dividers, and perform isolation domain coloring.
 */
export function buildElectricalHypergraph(
  netlist: CompiledNetlist,
  cesmResolver?: CesmResolver
): ElectricalHypergraph {
  if (
    !netlist ||
    (netlist.netlistSource !== "eda.sch_Netlist" && netlist.netlistSource !== "eda.pcb_Netlist")
  ) {
    throw new AuthoritativeNetlistError(
      `CompiledNetlist.netlistSource must be "eda.sch_Netlist" or "eda.pcb_Netlist", got "${String(
        (netlist as unknown as Record<string, unknown>)?.netlistSource
      )}". Raw sch_PrimitiveWire geometric intersection is strictly forbidden.`
    );
  }

  // Runtime guard against accidental injection of raw geometric wire intersection flags
  const rawRecord = netlist as unknown as Record<string, unknown>;
  if ("wireSegments" in rawRecord || "sch_PrimitiveWire" in rawRecord || "derivedFromWires" in rawRecord) {
    throw new AuthoritativeNetlistError(
      "CompiledNetlist must not carry or derive connectivity from sch_PrimitiveWire geometry."
    );
  }

  const components = new Map<string, HypergraphComponentNode>();
  const nets = new Map<string, HypergraphNetEdge>();

  // 1. Index components and pins
  for (const comp of netlist.components) {
    const cesm = comp.lcscId && cesmResolver ? cesmResolver(comp.lcscId) : undefined;
    const category = inferCategoryFromComponent(comp, cesm);
    const normPkg = normalizePackageCode(cesm?.package ?? comp.footprint);
    const valueStr = `${comp.value ?? ""} ${comp.mpn ?? ""}`;
    const resistanceOhms =
      typeof comp.extraProps?.resistance_ohm === "number"
        ? comp.extraProps.resistance_ohm
        : category === "RES_CHIP" || category === "RES_SHUNT"
          ? parseResistanceOhms(valueStr)
          : undefined;
    const capacitancePf =
      typeof comp.extraProps?.capacitance_pf === "number"
        ? comp.extraProps.capacitance_pf
        : category === "CAP_MLCC" || category === "CAP_AL_ELEC" || category === "CAP_TANTALUM"
          ? parseCapacitancePf(valueStr)
          : undefined;
    const ratedVoltageV =
      typeof comp.extraProps?.v_rated === "number"
        ? comp.extraProps.v_rated
        : cesm?.ratings.v_working_max ?? parseRatedVoltageV(valueStr);
    const powerRatedW =
      typeof comp.extraProps?.power_rated_w === "number"
        ? comp.extraProps.power_rated_w
        : cesm?.ratings.power_rated_w ??
          (category === "RES_CHIP" || category === "RES_SHUNT"
            ? getPackagePowerRatedW(normPkg)
            : undefined);

    const cesmPinMap = new Map<string, CesmPin>();
    if (cesm && Array.isArray(cesm.pins)) {
      for (const cp of cesm.pins) {
        cesmPinMap.set(cp.pin_number, cp);
      }
    }

    const node: HypergraphComponentNode = {
      designator: comp.designator,
      component: comp,
      cesm,
      inferredCategory: category,
      normalizedPackage: normPkg,
      resistanceOhms,
      capacitancePf,
      ratedVoltageV,
      powerRatedW,
      pins: [],
    };

    for (const pin of comp.pins) {
      const cesmPin = cesmPinMap.get(pin.pinNumber);
      const elecType = cesmPin?.elec_type ?? pin.elecType ?? "PASSIVE";
      const ref: HypergraphPinRef = {
        designator: comp.designator,
        pinNumber: pin.pinNumber,
        pinName: pin.pinName,
        elecType,
        netName: pin.net,
        isConnected: pin.isConnected && Boolean(pin.net),
        cesmPin,
        component: comp,
        compiledPin: pin,
      };
      node.pins.push(ref);

      if (pin.isConnected && pin.net) {
        let edge = nets.get(pin.net);
        if (!edge) {
          edge = createEmptyNetEdge(pin.net);
          nets.set(pin.net, edge);
        }
        edge.endpoints.push(ref);
      }
    }

    components.set(comp.designator, node);
  }

  // Ensure any net declared in netlist.nets (even if endpoints omitted on components) exists
  for (const cNet of netlist.nets) {
    if (!nets.has(cNet.netName)) {
      const edge = createEmptyNetEdge(cNet.netName);
      for (const ep of cNet.endpoints) {
        const compNode = components.get(ep.designator);
        if (compNode) {
          const matchedPin = compNode.pins.find((p) => p.pinNumber === ep.pinNumber);
          if (matchedPin) {
            matchedPin.netName = cNet.netName;
            matchedPin.isConnected = true;
            edge.endpoints.push(matchedPin);
          }
        }
      }
      nets.set(cNet.netName, edge);
    }
  }

  // 2. Classify nets & seed explicit voltage ranges
  for (const edge of nets.values()) {
    edge.signalClass = classifyNetSignal(edge.netName, edge.endpoints);
    edge.isGround = isGroundNetName(edge.netName);

    const parsed = parseVoltageFromNetName(edge.netName);
    if (parsed) {
      edge.voltage = parsed;
      edge.isPowerRail = !parsed.isGround;
    }

    // Check explicit connector/net properties for surge or explicit voltage
    edge.isSurgeInput =
      /^(?:VBUS|VIN(?:_\d+V(?:AC|DC)?|_RAW|_IN|_EXT)?|VBAT(?:_\d+V|_RAW|_IN)?|DC_IN|PWR_IN|AC_|MAINS)/i.test(
        edge.netName
      ) ||
      edge.endpoints.some(
        (ep) =>
          ep.component.extraProps?.isSurgeInput === true ||
          ((components.get(ep.designator)?.inferredCategory === "CONN_USB_TYPEC" ||
            components.get(ep.designator)?.inferredCategory === "CONN_GENERIC") &&
            /^(?:VBUS|VIN|VBAT|PWR|VCC|DC\+)$/i.test(ep.pinName))
      );

    for (const ep of edge.endpoints) {
      const vOverride = ep.component.extraProps?.netVoltages as
        | Record<string, { min: number; max: number; surge?: number }>
        | undefined;
      if (vOverride && vOverride[edge.netName]) {
        const ov = vOverride[edge.netName];
        edge.voltage = {
          vMin: ov.min,
          vMax: ov.max,
          vSurge: ov.surge ?? ov.max * 1.15,
          sources: [`ExplicitProp:${ep.designator}`],
          isGround: ov.min === 0 && ov.max === 0,
          isNegativeRail: ov.max < 0,
          confidence: "EXPLICIT",
        };
      }
      if (typeof ep.component.extraProps?.i_load_a === "number" && ep.elecType === "POWER_IN") {
        edge.maxCurrentA = Math.max(edge.maxCurrentA ?? 0, ep.component.extraProps.i_load_a);
      }
    }
  }

  // Seed regulator POWER_OUT pins onto unknown nets
  for (const node of components.values()) {
    if (node.inferredCategory === "PMIC_LDO" || node.inferredCategory === "PMIC_DCDC") {
      const regVolt = inferRegulatorOutputVoltage(node);
      if (regVolt) {
        for (const pin of node.pins) {
          if (pin.elecType === "POWER_OUT" && pin.netName) {
            const edge = nets.get(pin.netName);
            if (edge && edge.voltage.confidence === "UNKNOWN") {
              edge.voltage = { ...regVolt };
              edge.isPowerRail = true;
            }
          }
        }
      }
    }
  }

  // 3. Forward BFS / Fixed-point voltage range propagation across series elements
  propagateVoltages(components, nets);

  // 4. Isolation Domain Coloring (BFS over galvanic edges excluding isolators & Y-caps)
  const { domains, isolators } = computeIsolationDomains(components, nets);
  for (const [netName, edge] of nets.entries()) {
    for (const [domId, memberNets] of domains.entries()) {
      if (memberNets.has(netName)) {
        edge.isolationDomain = domId;
        break;
      }
    }
  }

  return {
    netlistSource: netlist.netlistSource,
    documentName: netlist.documentName ?? netlist.documentUuid ?? "SCH_MAIN",
    components,
    nets,
    isolationDomains: domains,
    isolators,
  };
}

function createEmptyNetEdge(netName: string): HypergraphNetEdge {
  return {
    netName,
    endpoints: [],
    voltage: {
      vMin: 0,
      vMax: 0,
      vSurge: 0,
      sources: [],
      isGround: false,
      isNegativeRail: false,
      confidence: "UNKNOWN",
    },
    isolationDomain: "DOMAIN_0",
    signalClass: "SIGNAL",
    isGround: false,
    isPowerRail: false,
    isSurgeInput: false,
  };
}

function propagateVoltages(
  components: Map<string, HypergraphComponentNode>,
  nets: Map<string, HypergraphNetEdge>
): void {
  const MAX_PASSES = 24;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;

    for (const node of components.values()) {
      if (node.pins.length < 2) continue;

      // A) Zero/low-drop series pass-through elements:
      // Ferrite beads, fuses/PTC, 0-ohm jumpers, shunt resistors (<= 2 ohm), power inductors (excluding SW-node push into regulated VOUT)
      const isJumpOrShunt =
        (node.inferredCategory === "RES_CHIP" || node.inferredCategory === "RES_SHUNT") &&
        node.resistanceOhms !== undefined &&
        node.resistanceOhms <= 2.0;
      const isFuse = /^(?:F|PTC)\d/i.test(node.designator) || /FUSE|PTC/i.test(node.component.mpn ?? "");
      const isBead = node.inferredCategory === "FERRITE_CMC" && node.pins.length === 2;
      const isInductor = node.inferredCategory === "IND_POWER" && node.pins.length === 2;

      if (isJumpOrShunt || isFuse || isBead || isInductor) {
        const p0 = node.pins[0];
        const p1 = node.pins[1];
        if (p0.netName && p1.netName && p0.netName !== p1.netName) {
          const e0 = nets.get(p0.netName);
          const e1 = nets.get(p1.netName);
          if (e0 && e1) {
            const p0IsSw = e0.signalClass === "SW_NODE";
            const p1IsSw = e1.signalClass === "SW_NODE";
            // Propagate from known non-ground net to UNKNOWN non-ground net (do not overwrite explicit SW or regulated rail)
            if (e0.voltage.confidence !== "UNKNOWN" && !e0.isGround && e1.voltage.confidence === "UNKNOWN" && !e1.isGround && !p0IsSw) {
              e1.voltage = {
                ...e0.voltage,
                sources: [...e0.voltage.sources, `Via:${node.designator}`],
                confidence: "PROPAGATED",
              };
              e1.isPowerRail = e0.isPowerRail;
              changed = true;
            } else if (e1.voltage.confidence !== "UNKNOWN" && !e1.isGround && e0.voltage.confidence === "UNKNOWN" && !e0.isGround && !p1IsSw) {
              e0.voltage = {
                ...e1.voltage,
                sources: [...e1.voltage.sources, `Via:${node.designator}`],
                confidence: "PROPAGATED",
              };
              e0.isPowerRail = e1.isPowerRail;
              changed = true;
            }
          }
        }
      }

      // B) Reverse-protection PMOS: D -> S forward propagation when gate is pulled down / static
      if (node.inferredCategory === "MOSFET_BJT") {
        const dPin = node.pins.find((p) => /^(?:D|DRAIN)$/i.test(p.pinName) || p.pinNumber === "3");
        const sPin = node.pins.find((p) => /^(?:S|SOURCE)$/i.test(p.pinName) || p.pinNumber === "2");
        if (dPin?.netName && sPin?.netName && dPin.netName !== sPin.netName) {
          const ed = nets.get(dPin.netName);
          const es = nets.get(sPin.netName);
          if (ed && es && !ed.isGround && !es.isGround) {
            if (ed.voltage.confidence !== "UNKNOWN" && es.voltage.confidence === "UNKNOWN") {
              es.voltage = {
                vMin: Math.max(0, ed.voltage.vMin - 0.1),
                vMax: ed.voltage.vMax,
                vSurge: ed.voltage.vSurge,
                sources: [...ed.voltage.sources, `PMOS:${node.designator}`],
                isGround: false,
                isNegativeRail: false,
                confidence: "PROPAGATED",
              };
              es.isPowerRail = true;
              changed = true;
            } else if (es.voltage.confidence !== "UNKNOWN" && ed.voltage.confidence === "UNKNOWN") {
              // Handle reversed PMOS topology so downstream still gets potential
              ed.voltage = {
                vMin: Math.max(0, es.voltage.vMin - 0.7),
                vMax: es.voltage.vMax,
                vSurge: es.voltage.vSurge,
                sources: [...es.voltage.sources, `PMOSBody:${node.designator}`],
                isGround: false,
                isNegativeRail: false,
                confidence: "PROPAGATED",
              };
              ed.isPowerRail = true;
              changed = true;
            }
          }
        }
      }

      // C) Series Diode (forward Anode -> Cathode drop) when cathode is an UNKNOWN non-ground net
      if (node.inferredCategory === "DIODE_SCHOTTKY") {
        const aPin = findAnodePin(node);
        const kPin = findCathodePin(node);
        if (aPin?.netName && kPin?.netName && aPin.netName !== kPin.netName) {
          const ea = nets.get(aPin.netName);
          const ek = nets.get(kPin.netName);
          if (ea && ek && !ea.isGround && !ek.isGround && ea.voltage.confidence !== "UNKNOWN" && ek.voltage.confidence === "UNKNOWN") {
            const isSchottky = /SCHOTTKY|SS\d|BAT54|1N58|MBR/i.test(`${node.component.mpn ?? ""} ${node.component.value ?? ""}`);
            const vfMin = isSchottky ? 0.25 : 0.6;
            const vfMax = isSchottky ? 0.45 : 0.85;
            ek.voltage = {
              vMin: Math.max(0, ea.voltage.vMin - vfMax),
              vMax: Math.max(0, ea.voltage.vMax - vfMin),
              vSurge: ea.voltage.vSurge,
              sources: [...ea.voltage.sources, `Diode:${node.designator}`],
              isGround: false,
              isNegativeRail: false,
              confidence: "PROPAGATED",
            };
            ek.isPowerRail = ea.isPowerRail;
            changed = true;
          }
        }
      }

      // D) DC-DC SW node gets VIN max voltage from its VIN pin
      if (node.inferredCategory === "PMIC_DCDC") {
        const vinPin = node.pins.find((p) => p.elecType === "POWER_IN" && p.netName && !isGroundNetName(p.netName));
        const swPin = node.pins.find((p) => (p.elecType === "SW_NODE" || /^(?:SW|LX|PH)$/i.test(p.pinName)) && p.netName);
        if (vinPin?.netName && swPin?.netName) {
          const eVin = nets.get(vinPin.netName);
          const eSw = nets.get(swPin.netName);
          if (eVin && eSw && eVin.voltage.confidence !== "UNKNOWN" && eSw.voltage.confidence === "UNKNOWN") {
            eSw.voltage = {
              vMin: 0,
              vMax: eVin.voltage.vMax,
              vSurge: eVin.voltage.vSurge,
              sources: [...eVin.voltage.sources, `SwitchNode:${node.designator}`],
              isGround: false,
              isNegativeRail: false,
              confidence: "PROPAGATED",
            };
            changed = true;
          }
        }
      }
    }

    // E) Passive resistive divider / pull-up DC nodal relaxation
    for (const edge of nets.values()) {
      if (edge.isGround || edge.voltage.confidence === "EXPLICIT" || edge.voltage.confidence === "PROPAGATED") {
        continue;
      }
      // Do not overwrite actively driven push-pull / power-out nets with resistive divider averaging
      const hasActiveDriver = edge.endpoints.some(
        (ep) => ep.elecType === "PUSH_PULL" || ep.elecType === "POWER_OUT" || ep.elecType === "ANALOG_OUT"
      );
      if (hasActiveDriver) continue;

      let sumG = 0;
      let sumGVMin = 0;
      let sumGVMax = 0;
      let sumGVSurge = 0;
      const contribSources: string[] = [];

      for (const ep of edge.endpoints) {
        const compNode = components.get(ep.designator);
        if (
          !compNode ||
          (compNode.inferredCategory !== "RES_CHIP" && compNode.inferredCategory !== "RES_SHUNT") ||
          !compNode.resistanceOhms ||
          compNode.resistanceOhms <= 0
        ) {
          continue;
        }
        const otherPin = compNode.pins.find((p) => p !== ep);
        if (!otherPin?.netName) continue;
        const otherNet = nets.get(otherPin.netName);
        if (!otherNet || otherNet.voltage.confidence === "UNKNOWN") continue;

        const g = 1 / compNode.resistanceOhms;
        sumG += g;
        sumGVMin += g * otherNet.voltage.vMin;
        sumGVMax += g * otherNet.voltage.vMax;
        sumGVSurge += g * otherNet.voltage.vSurge;
        contribSources.push(`${compNode.designator}(${otherNet.netName})`);
      }

      if (sumG > 0 && contribSources.length >= 1) {
        const newMin = Math.round((sumGVMin / sumG) * 10000) / 10000;
        const newMax = Math.round((sumGVMax / sumG) * 10000) / 10000;
        const newSurge = Math.round((sumGVSurge / sumG) * 10000) / 10000;
        if (
          edge.voltage.confidence === "UNKNOWN" ||
          Math.abs(edge.voltage.vMax - newMax) > 1e-3 ||
          Math.abs(edge.voltage.vMin - newMin) > 1e-3
        ) {
          edge.voltage = {
            vMin: newMin,
            vMax: newMax,
            vSurge: newSurge,
            sources: [`Divider:${contribSources.join("+")}`],
            isGround: false,
            isNegativeRail: newMax < 0,
            confidence: "INFERRED",
          };
          changed = true;
        }
      }
    }

    // F) Active digital driver output propagation onto unseeded signal nets
    for (const edge of nets.values()) {
      if (edge.isGround || edge.voltage.confidence !== "UNKNOWN") continue;
      for (const ep of edge.endpoints) {
        if (ep.elecType === "PUSH_PULL" || ep.elecType === "BIDIR_IO" || ep.elecType === "ANALOG_OUT") {
          const compNode = components.get(ep.designator);
          if (!compNode) continue;
          const supply = getPinSupplyVoltage(compNode, ep, nets);
          if (supply) {
            edge.voltage = {
              vMin: 0,
              vMax: supply.vMax,
              vSurge: supply.vSurge,
              sources: [`Driver:${ep.designator}.${ep.pinName}`],
              isGround: false,
              isNegativeRail: false,
              confidence: "INFERRED",
            };
            changed = true;
            break;
          }
        }
      }
    }

    if (!changed) break;
  }
}

export function getPinSupplyVoltage(
  compNode: HypergraphComponentNode,
  pin: HypergraphPinRef,
  nets: Map<string, HypergraphNetEdge>
): VoltageRange | undefined {
  // 1. Check explicit supply_pin_ref in CESM
  const refName = pin.cesmPin?.supply_pin_ref;
  if (refName) {
    const supplyPin = compNode.pins.find(
      (p) => p.pinName.toUpperCase() === refName.toUpperCase() && p.netName
    );
    if (supplyPin?.netName) {
      const e = nets.get(supplyPin.netName);
      if (e && e.voltage.confidence !== "UNKNOWN") return e.voltage;
    }
  }

  // 2. Fallback: find first positive POWER_IN pin on component with known voltage
  const positiveSupplyPins = compNode.pins.filter(
    (p) =>
      p.elecType === "POWER_IN" &&
      p.netName &&
      !isGroundNetName(p.netName) &&
      nets.get(p.netName)?.voltage.confidence !== "UNKNOWN"
  );
  if (positiveSupplyPins.length > 0) {
    const netName = positiveSupplyPins[0].netName!;
    return nets.get(netName)?.voltage;
  }

  // 3. Fallback: check component extraProps.nominal_vdd
  if (typeof compNode.component.extraProps?.nominal_vdd === "number") {
    return makeNominalRange(compNode.component.extraProps.nominal_vdd, `NominalVdd:${compNode.designator}`);
  }

  return undefined;
}

export function findAnodePin(node: HypergraphComponentNode): HypergraphPinRef | undefined {
  if (node.cesm?.polarity_spec?.anode_pins?.length) {
    const p = node.pins.find((pin) => node.cesm!.polarity_spec!.anode_pins!.includes(pin.pinNumber));
    if (p) return p;
  }
  return (
    node.pins.find((p) => /^(?:\+|A|ANODE|POS|VIN)$/i.test(p.pinName)) ??
    node.pins.find((p) => p.pinNumber === "1")
  );
}

export function findCathodePin(node: HypergraphComponentNode): HypergraphPinRef | undefined {
  if (node.cesm?.polarity_spec?.cathode_pins?.length) {
    const p = node.pins.find((pin) => node.cesm!.polarity_spec!.cathode_pins!.includes(pin.pinNumber));
    if (p) return p;
  }
  return (
    node.pins.find((p) => /^(?:-|K|C|CATHODE|NEG|GND)$/i.test(p.pinName)) ??
    node.pins.find((p) => p.pinNumber === "2")
  );
}

function computeIsolationDomains(
  components: Map<string, HypergraphComponentNode>,
  nets: Map<string, HypergraphNetEdge>
): { domains: Map<string, Set<string>>; isolators: IsolatorBarrierInfo[] } {
  const adjacency = new Map<string, Set<string>>();
  for (const netName of nets.keys()) {
    adjacency.set(netName, new Set<string>());
  }

  const isolatorNodes: HypergraphComponentNode[] = [];

  for (const node of components.values()) {
    if (isIsolatorNode(node)) {
      isolatorNodes.push(node);
      // Do NOT bridge primary and secondary nets across the isolator!
      // Instead, bridge within primary pins and within secondary pins separately.
      const { primary, secondary } = partitionIsolatorPins(node);
      connectPinNets(primary, adjacency);
      connectPinNets(secondary, adjacency);
      continue;
    }

    // Do not merge domains across high-voltage safety Y-capacitors (AC safety bridge)
    if (isSafetyIsolationCapacitor(node)) {
      continue;
    }

    // Standard non-isolating component connects all its attached nets in the same galvanic domain
    connectPinNets(node.pins, adjacency);
  }

  const visited = new Set<string>();
  const domains = new Map<string, Set<string>>();
  const netToDomain = new Map<string, string>();
  let domainIndex = 0;

  for (const netName of nets.keys()) {
    if (visited.has(netName)) continue;
    const queue = [netName];
    visited.add(netName);
    const componentNets = new Set<string>();

    while (queue.length > 0) {
      const curr = queue.shift()!;
      componentNets.add(curr);
      for (const nxt of adjacency.get(curr) ?? []) {
        if (!visited.has(nxt)) {
          visited.add(nxt);
          queue.push(nxt);
        }
      }
    }

    const domLabel = inferDomainLabel(domainIndex++, componentNets);
    domains.set(domLabel, componentNets);
    for (const mn of componentNets) {
      netToDomain.set(mn, domLabel);
    }
  }

  const isolators: IsolatorBarrierInfo[] = [];
  for (const isoNode of isolatorNodes) {
    const { primary, secondary } = partitionIsolatorPins(isoNode);
    const primaryNets = Array.from(new Set(primary.map((p) => p.netName).filter((n): n is string => Boolean(n))));
    const secondaryNets = Array.from(new Set(secondary.map((p) => p.netName).filter((n): n is string => Boolean(n))));
    const primaryDomains = Array.from(new Set(primaryNets.map((n) => netToDomain.get(n)!).filter(Boolean)));
    const secondaryDomains = Array.from(new Set(secondaryNets.map((n) => netToDomain.get(n)!).filter(Boolean)));

    const overlapDomains = primaryDomains.filter((d) => secondaryDomains.includes(d));
    const sharedNets = primaryNets.filter((n) => secondaryNets.includes(n));
    const breached = overlapDomains.length > 0 || sharedNets.length > 0;
    const breachReason = breached
      ? sharedNets.length > 0
        ? `Primary and secondary share identical net(s): ${sharedNets.join(", ")}`
        : `Primary and secondary bridge into the same galvanic domain: ${overlapDomains.join(", ")}`
      : undefined;

    isolators.push({
      designator: isoNode.designator,
      category: isoNode.inferredCategory === "RELAY_BUZZER" ? "RELAY" : isoNode.inferredCategory === "ISOLATOR_OPTO" ? "ISOLATOR_OPTO" : "ISOLATOR",
      primaryPins: primary,
      secondaryPins: secondary,
      primaryNets,
      secondaryNets,
      primaryDomains,
      secondaryDomains,
      breached,
      breachReason,
    });
  }

  return { domains, isolators };
}

function connectPinNets(pins: HypergraphPinRef[], adjacency: Map<string, Set<string>>): void {
  const netNames = Array.from(new Set(pins.map((p) => p.netName).filter((n): n is string => Boolean(n))));
  if (netNames.length < 2) return;
  const root = netNames[0];
  for (let i = 1; i < netNames.length; i++) {
    const other = netNames[i];
    adjacency.get(root)?.add(other);
    adjacency.get(other)?.add(root);
  }
}

function inferDomainLabel(idx: number, memberNets: Set<string>): string {
  const joined = Array.from(memberNets).join(" ").toUpperCase();
  if (/ISO|SEC|485|CAN_ISO/.test(joined)) return `DOMAIN_ISO_${idx}`;
  if (/PGND|CHASSIS|EARTH|PE\b/.test(joined)) return `DOMAIN_CHASSIS_${idx}`;
  if (/AC_|220V|MAINS|PRI/.test(joined)) return `DOMAIN_AC_PRI_${idx}`;
  return `DOMAIN_SYS_${idx}`;
}
