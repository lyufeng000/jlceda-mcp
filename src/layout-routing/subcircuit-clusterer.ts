import { readFileSync } from "node:fs";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type {
  CesmModel,
  ClusterEdgeAffinity,
  ClusterMember,
  CompiledComponent,
  CompiledNet,
  CompiledNetlist,
  ConstraintHandoffPackage,
  FunctionalCluster,
  FunctionalClusterKeepoutZone,
  FunctionalClusterOutput,
  FunctionalModuleType,
  SchGroupBox,
} from "../types/index.js";
import {
  generate25DKeepoutFiveTuples,
  polygonFromRectMm,
  resolveStackupLayers,
} from "./spacing-keepout-matrix.js";

type AjvValidateFn = ((data: unknown) => boolean) & { errors?: unknown[] | null };
type AjvInstanceLike = { compile: (schema: Record<string, unknown>) => AjvValidateFn };
type AjvCtorLike = new (opts?: Record<string, unknown>) => AjvInstanceLike;

// Handle CommonJS-in-ESM interop cleanly for Ajv2020 and ajv-formats under NodeNext
const Ajv2020Ctor = ((Ajv2020Import as unknown as { default?: AjvCtorLike; Ajv2020?: AjvCtorLike })
  .default ??
  (Ajv2020Import as unknown as { Ajv2020?: AjvCtorLike }).Ajv2020 ??
  (Ajv2020Import as unknown as AjvCtorLike));
const addFormatsFn = ((addFormatsImport as unknown as { default?: (ajv: AjvInstanceLike) => unknown })
  .default ?? (addFormatsImport as unknown as (ajv: AjvInstanceLike) => unknown));

type AnchorTier = "MECHANICAL_EDGE_ANCHOR" | "FUNCTIONAL_IC_ANCHOR" | "SATELLITE_PASSIVE";

type AnchorArchetype =
  | "DCDC"
  | "LDO"
  | "MCU"
  | "CLOCK"
  | "ANALOG"
  | "IO_CONN"
  | "IO_XCVR"
  | "RF"
  | "ELECTROMECH"
  | "ISOLATOR"
  | "NONE";

export interface ClusterNetlistOptions {
  boardOutline?: FunctionalClusterOutput["board_outline"];
  cesmLookup?:
    | Map<string, CesmModel>
    | ((key: string, comp?: CompiledComponent) => CesmModel | undefined);
  constraintHandoff?: ConstraintHandoffPackage;
  powerGndNetsOverride?: string[];
  minClusterSize?: number;
  maxClusterSize?: number;
  footprintBboxLookup?: (footprint: string, comp: CompiledComponent) => [number, number];
  seed?: number;
}

export interface DecouplingAttachmentRecord {
  capacitorDesignator: string;
  targetIcDesignator: string;
  targetPins: string[];
  powerNet: string;
  groundNet: string;
  source: "SCH_EUCLIDEAN" | "PIN_QUOTA_BALANCED" | "NETLIST_FALLBACK";
}

export interface SubcircuitClusterDiagnostics {
  strippedGlobalNets: string[];
  prunedInterModuleBuses: string[];
  reattachedOrphans: DecouplingAttachmentRecord[];
  leidenModularityQ: number;
  leidenResolutionGamma: number;
  schemaValidated: boolean;
}

export interface SubcircuitClusterResult {
  output: FunctionalClusterOutput;
  diagnostics: SubcircuitClusterDiagnostics;
}

interface InternalEdge {
  u: number;
  v: number;
  weight: number;
}

interface InternalHyperedgeMeta {
  net: CompiledNet;
  componentIndices: number[];
  alpha: number;
  isInterModuleBus: boolean;
  signalClass: string;
}

let cachedValidator: AjvValidateFn | null = null;

function getFunctionalClusterValidator(): AjvValidateFn {
  if (cachedValidator) return cachedValidator;
  const schemaUrl = new URL("../../schemas/functional-cluster.schema.json", import.meta.url);
  const schemaRaw = readFileSync(schemaUrl, "utf-8");
  const schema = JSON.parse(schemaRaw) as Record<string, unknown>;
  const ajv = new Ajv2020Ctor({ allErrors: true, strict: false });
  addFormatsFn(ajv);
  cachedValidator = ajv.compile(schema);
  return cachedValidator;
}

// ============================================================================
// Regexes & Helpers for Net Classification and Component Anchoring
// ============================================================================

const GROUND_NET_REGEX =
  /^(?:A|D|P|C|S|CHASSIS_?|ISO_?|EARTH_?)?(?:GND|VSS|VEE|COM)(?:[A-Z0-9_]*)$/i;

const POWER_RAIL_NAME_REGEX =
  /^(?:[+-]?\d+(?:[._]?\d+)?V\d*|V(?:CC|DD|DDA|DDD|DDIO|DDQ|DDS|BUS|BAT|SYS|PP|MAIN|CORE|ANA|DIG|ISO)(?:[_0-9A-Z+-]*)?|VIN(?:_?\d+V\d*|_IN|_RAW|_PROT)?|PWR_[A-Z0-9_]+|RAIL_[A-Z0-9_]+)$/i;

const PARALLEL_BUS_NAME_REGEX =
  /^(?:DQ|DATA|D|ADDR|ADR|A|IO|GPIO|DB|AB|SD|FSMC|FMC|PA|PB|PC|PD|PE|PF|PG|PWM|ADC|DAC|TIM)[_[]?\d+(?:\.\.\d+)?\]?$/i;

const HIGH_BINDING_ALPHA15_REGEX =
  /(?:^|_)(?:SW|LX|PH|PHASE|BOOT|BST|FB|VFB|VSENSE|COMP|OSC_?IN|OSC_?OUT|XTAL[12]?|XIN|XOUT|HSE_?IN|HSE_?OUT|LSE_?IN|LSE_?OUT|IN[-+]|VIN[-+]|OP_?IN|I_?SENSE|ISENSE|SENSE[+-PN]?|SHUNT|CS[+-PN]?|GATE|DRV|HO|LO|GH|GL|CC[12]|COIL|FLYBACK)(?:$|_)/i;

const STRONG_BINDING_ALPHA5_REGEX =
  /(?:USB|D[PM]|D\+|D-|ETH|MDI|TX[+-PN]|RX[+-PN]|HDMI|TMDS|MIPI|CAN[HL]|RS485|485_[AB]|QSPI|OSPI|DDR|SDIO|RMII|RGMII|SWD|SWCLK|SWDIO|JTAG|BYP|NR|VREF|VDDA|AVDD|VCAP)/i;

const INTER_MODULE_BUS_REGEX =
  /(?:I2C|SDA|SCL|SPI|MOSI|MISO|SCK|SCLK|UART|TXD|RXD|USART|GPIO|INT|IRQ|ALERT|WAKE|PWM|NRST|RESET|EN_|ENABLE|BUS_)/i;

function isGroundNetName(name: string): boolean {
  return GROUND_NET_REGEX.test(name.trim());
}

function isSemanticPowerOrGndNet(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (isGroundNetName(trimmed)) return true;
  if (/^(?:SW|LX|PH|PHASE|BOOT|BST|FB|VFB|VSENSE|VREF|VIN[-+]|VOUT_SENSE)$/i.test(trimmed)) {
    return false;
  }
  return POWER_RAIL_NAME_REGEX.test(trimmed);
}

function isParallelBusNet(name: string, allNetNames: string[]): boolean {
  const trimmed = name.trim();
  if (PARALLEL_BUS_NAME_REGEX.test(trimmed)) return true;
  const m = /^([A-Za-z_]+?)(\d+)$/.exec(trimmed);
  if (m) {
    const prefix = m[1].toUpperCase();
    let siblings = 0;
    for (const other of allNetNames) {
      const om = /^([A-Za-z_]+?)(\d+)$/.exec(other.trim());
      if (om && om[1].toUpperCase() === prefix) siblings++;
    }
    if (siblings >= 4) return true;
  }
  return false;
}

function estimateFootprintBboxMm(
  footprint: string,
  comp: CompiledComponent,
  customLookup?: (fp: string, c: CompiledComponent) => [number, number]
): [number, number] {
  if (customLookup) {
    return customLookup(footprint, comp);
  }
  const fp = footprint.toUpperCase();
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
  const pinCount = comp.pins.length;
  if (pinCount >= 48) return [12.0, 12.0];
  if (pinCount >= 16) return [7.0, 6.0];
  if (pinCount >= 6) return [4.0, 3.5];
  return [2.0, 1.5];
}

function resolveCesm(
  comp: CompiledComponent,
  cesmLookup?: ClusterNetlistOptions["cesmLookup"]
): CesmModel | undefined {
  if (!cesmLookup) return undefined;
  if (typeof cesmLookup === "function") {
    return (
      cesmLookup(comp.designator, comp) ??
      (comp.lcscId ? cesmLookup(comp.lcscId, comp) : undefined)
    );
  }
  return (
    cesmLookup.get(comp.designator) ??
    (comp.lcscId ? cesmLookup.get(comp.lcscId) : undefined)
  );
}

function classifyAnchor(
  comp: CompiledComponent,
  cesm?: CesmModel
): { tier: AnchorTier; archetype: AnchorArchetype } {
  const des = comp.designator.toUpperCase();
  const fp = (comp.footprint ?? "").toUpperCase();
  const mpn = (comp.mpn ?? comp.value ?? "").toUpperCase();
  const cat = cesm?.category;

  // 1. Check protection satellites first (TVS/ESD/MOV even if designator is U*)
  if (
    cat === "TVS_ESD_MOV" ||
    /USBLC|SRV05|TPD\d|SM712|PESD|PRTR|ESD|TVS/i.test(mpn) ||
    /^(?:TVS|ESD)\d*/.test(des)
  ) {
    return { tier: "SATELLITE_PASSIVE", archetype: "NONE" };
  }

  // 2. Mechanical / Edge Anchors
  if (
    cat === "CONN_USB_TYPEC" ||
    cat === "CONN_GENERIC" ||
    /^(?:J|CN|USB|RJ|HDMI|FPC|SD|TF|ANT|KEY|BTN|MH)\d*/.test(des) ||
    /USB|TYPE-?C|RJ45|HDMI|FPC|TERM|HEADER|JACK|ANTENNA|IPEX|SMA|SWITCH|BUTTON/i.test(
      `${fp} ${mpn}`
    )
  ) {
    const isRf = /ANTENNA|IPEX|SMA|RF_ANT/i.test(`${des} ${fp} ${mpn}`);
    const isInternalHeader = /SWD|JTAG|HDR|PH2\.54/i.test(`${fp} ${mpn}`) && !/USB|RJ45|HDMI|485|CAN|TERM/i.test(mpn);
    return {
      tier: isInternalHeader ? "SATELLITE_PASSIVE" : "MECHANICAL_EDGE_ANCHOR",
      archetype: isRf ? "RF" : isInternalHeader ? "MCU" : "IO_CONN",
    };
  }

  // 3. Functional Core Anchors
  if (cat === "PMIC_DCDC" || /TPS54|TPS62|MP1584|MP23|LM2596|SY80|XL40|BUCK|BOOST|DCDC/i.test(mpn)) {
    return { tier: "FUNCTIONAL_IC_ANCHOR", archetype: "DCDC" };
  }
  if (cat === "PMIC_LDO" || /1117|RT9013|ME6211|XC6206|TLV7|LP5907|TPS7A|LDO/i.test(mpn)) {
    return { tier: "FUNCTIONAL_IC_ANCHOR", archetype: "LDO" };
  }
  if (cat === "MCU_SOC" || /STM32|GD32|RP2040|NRF52|ATMEGA|SAMD|FPGA|MCU|SOC/i.test(mpn)) {
    return { tier: "FUNCTIONAL_IC_ANCHOR", archetype: "MCU" };
  }
  if (/ESP32|WROOM|SX12|LORA|NRF24|GNSS|GPS|SIM800|RF_/i.test(mpn)) {
    return { tier: "FUNCTIONAL_IC_ANCHOR", archetype: "RF" };
  }
  if (
    cat === "OPAMP_COMP" ||
    cat === "ADC_DAC_VREF" ||
    /OPA|LM358|LMV3|INA\d|AD8|ADS1|MCP3|REF3|ADR4|TL431/i.test(mpn)
  ) {
    return { tier: "FUNCTIONAL_IC_ANCHOR", archetype: "ANALOG" };
  }
  if (
    cat === "INTERFACE_XCVR" ||
    /CH340|CP210|FT232|MAX485|SP3485|TJA105|SN65HVD|LAN87|RTL82|PHY|HR911|HANRUN/i.test(mpn)
  ) {
    return { tier: "FUNCTIONAL_IC_ANCHOR", archetype: "IO_XCVR" };
  }
  if (cat === "ISOLATOR_OPTO" || /PC817|TLP|ADUM|ISO77|SI86|XFMR/i.test(mpn) || /^T\d+/.test(des)) {
    return { tier: "FUNCTIONAL_IC_ANCHOR", archetype: "ISOLATOR" };
  }
  if (
    cat === "RELAY_BUZZER" ||
    cat === "MOSFET_BJT" ||
    /^(?:K|RLY|BZ|LS|Q)\d*/.test(des) ||
    /RELAY|BUZZER|ULN2003|MOSFET|DRV8|IR21|HALF_BRIDGE/i.test(`${fp} ${mpn}`)
  ) {
    return { tier: "FUNCTIONAL_IC_ANCHOR", archetype: "ELECTROMECH" };
  }
  if (cat === "OSC_ACTIVE") {
    return { tier: "FUNCTIONAL_IC_ANCHOR", archetype: "CLOCK" };
  }

  // Fallback for generic U* ICs
  if (/^(?:U|IC)\d*/.test(des) && comp.pins.length >= 4) {
    // Check pin names for hints
    const pinNames = comp.pins.map((p) => p.pinName.toUpperCase()).join(" ");
    if (/\b(?:SW|LX|PH|BOOT)\b/.test(pinNames)) {
      return { tier: "FUNCTIONAL_IC_ANCHOR", archetype: "DCDC" };
    }
    if (/\b(?:IN-|IN\+|VOUT)\b/.test(pinNames) && comp.pins.length <= 8) {
      return { tier: "FUNCTIONAL_IC_ANCHOR", archetype: "ANALOG" };
    }
    if (/SRAM|FLASH|EEPROM|W25Q|IS62|24C|74HC|D0|D7/i.test(`${mpn} ${pinNames}`)) {
      return { tier: "FUNCTIONAL_IC_ANCHOR", archetype: "MCU" };
    }
    if (comp.pins.length >= 20) {
      return { tier: "FUNCTIONAL_IC_ANCHOR", archetype: "MCU" };
    }
    return { tier: "FUNCTIONAL_IC_ANCHOR", archetype: "IO_XCVR" };
  }

  // 4. Passive Crystal
  if (cat === "XTAL_PASSIVE" || /^(?:Y|X|XTAL)\d*/.test(des)) {
    return { tier: "SATELLITE_PASSIVE", archetype: "CLOCK" };
  }

  return { tier: "SATELLITE_PASSIVE", archetype: "NONE" };
}

function areAnchorsIncompatible(
  a: { designator: string; archetype: AnchorArchetype; tier: AnchorTier },
  b: { designator: string; archetype: AnchorArchetype; tier: AnchorTier },
  sameGroupBox: boolean
): boolean {
  if (a.designator === b.designator) return false;
  if (a.tier === "SATELLITE_PASSIVE" || b.tier === "SATELLITE_PASSIVE") return false;

  // Compatible co-anchored pairs:
  // - Edge connector + XCVR / Isolator (e.g. RJ45 + Eth Xfmr, or RS485 terminal + MAX485 in same groupBox)
  if (sameGroupBox) {
    if (
      (a.archetype === "IO_CONN" && (b.archetype === "IO_XCVR" || b.archetype === "ISOLATOR")) ||
      (b.archetype === "IO_CONN" && (a.archetype === "IO_XCVR" || a.archetype === "ISOLATOR"))
    ) {
      return false;
    }
    if (a.archetype === "ELECTROMECH" && b.archetype === "ELECTROMECH") {
      return false; // e.g., MOSFET + Relay in one driver stage
    }
    if (
      (a.archetype === "ELECTROMECH" && b.archetype === "IO_CONN") ||
      (b.archetype === "ELECTROMECH" && a.archetype === "IO_CONN")
    ) {
      return false; // Load screw terminal + Relay driver
    }
    if (a.archetype === "RF" && b.archetype === "RF") {
      return false; // RF module + matching/IPEX antenna in same RF groupBox
    }
  }

  // Otherwise distinct core/edge anchors repel each other so heterogeneous blocks never mash together
  return true;
}

function isPointInRect(pt: [number, number] | undefined, rect: [number, number, number, number]): boolean {
  if (!pt) return false;
  const [x, y] = pt;
  const [rx, ry, rw, rh] = rect;
  // Support both [minX, minY, maxX, maxY] and [x, y, w, h] gracefully:
  // In schemas/types, rectMm is [minX, minY, maxX, maxY] if rw > rx && rh > ry and convention is bbox,
  // or check if width/height vs maxX/maxY: if rx < rw and ry < rh we check bbox, wait:
  // If x0, y0, x1, y1 has x1 < x0 it's not valid bbox; standard in JLCEDA/types: [x1, y1, x2, y2] or [x, y, w, h]
  // Let's handle [minX, minY, maxX, maxY] when maxX > minX && maxY > minY (Wait: if x=10, y=10, w=50, h=40, maxX=50>10 too!
  // Let's check typical usage: memberDesignators is preferred if supplied, otherwise treat rectMm as [minX, minY, maxX, maxY]
  // matching `regionMm: [minX, minY, maxX, maxY]` in Section 4.4.1 line 1092).
  return x >= rx && x <= rw && y >= ry && y <= rh;
}

function findGroupBoxForComponent(
  comp: CompiledComponent,
  groupBoxes?: SchGroupBox[]
): SchGroupBox | undefined {
  if (!groupBoxes || groupBoxes.length === 0) return undefined;
  for (const box of groupBoxes) {
    if (box.memberDesignators && box.memberDesignators.includes(comp.designator)) {
      return box;
    }
  }
  for (const box of groupBoxes) {
    if (box.sheetId && comp.sheetId && box.sheetId !== comp.sheetId) continue;
    if (isPointInRect(comp.posMm, box.rectMm)) {
      return box;
    }
  }
  return undefined;
}

function parseCapacitanceUf(valStr: string | null | undefined): number | null {
  if (!valStr) return null;
  const s = valStr.trim().toUpperCase();
  const m = /(\d+(?:\.\d+)?)\s*(PF|NF|UF|ΜF|MF|F)/.exec(s);
  if (!m) return null;
  const v = parseFloat(m[1]);
  const unit = m[2];
  if (unit === "PF") return v * 1e-6;
  if (unit === "NF") return v * 1e-3;
  if (unit === "UF" || unit === "ΜF") return v;
  if (unit === "MF") return v * 1e3;
  return v * 1e6;
}

function isCapacitorComponent(comp: CompiledComponent, cesm?: CesmModel): boolean {
  if (
    cesm?.category === "CAP_MLCC" ||
    cesm?.category === "CAP_AL_ELEC" ||
    cesm?.category === "CAP_TANTALUM"
  ) {
    return true;
  }
  return /^C\d+/i.test(comp.designator) || /CAP/i.test(comp.footprint ?? "");
}

function isBulkCapacitor(comp: CompiledComponent): boolean {
  const uf = parseCapacitanceUf(comp.value ?? comp.mpn);
  if (uf !== null) {
    return uf >= 1.0;
  }
  return /0805|1206|1210|ELEC|TANT|CASE-/i.test(comp.footprint ?? "");
}

// ============================================================================
// Leiden Community Detection with Anchor Mutual-Exclusion Penalty
// ============================================================================

interface LeidenNodeMeta {
  index: number;
  anchors: Array<{ designator: string; archetype: AnchorArchetype; tier: AnchorTier }>;
  groupBoxId?: string;
}

function runWeightedLeiden(
  nodeCount: number,
  edges: InternalEdge[],
  nodeMetas: LeidenNodeMeta[],
  gamma: number,
  anchorPenaltyWeight: number,
  seed: number
): { communities: number[]; modularityQ: number } {
  if (nodeCount === 0) return { communities: [], modularityQ: 0 };

  // Build adjacency list for fast neighbor lookup
  const adj: Array<Array<{ to: number; w: number }>> = Array.from({ length: nodeCount }, () => []);
  const deg = new Float64Array(nodeCount);
  let totalWeight2m = 0;

  for (const e of edges) {
    if (e.u === e.v || e.weight <= 0) continue;
    adj[e.u].push({ to: e.v, w: e.weight });
    adj[e.v].push({ to: e.u, w: e.weight });
    deg[e.u] += e.weight;
    deg[e.v] += e.weight;
    totalWeight2m += 2 * e.weight;
  }

  if (totalWeight2m <= 0) {
    // Disconnected trivial partition
    return {
      communities: Array.from({ length: nodeCount }, (_, i) => i),
      modularityQ: 0,
    };
  }

  // Helper to check if merging node set A and community B incurs anchor incompatibility
  const countIncompatibleAnchorPairs = (
    anchorsA: LeidenNodeMeta["anchors"],
    anchorsB: LeidenNodeMeta["anchors"],
    boxA?: string,
    boxB?: string
  ): number => {
    let conflicts = 0;
    const sameBox = Boolean(boxA && boxB && boxA === boxB);
    for (const a of anchorsA) {
      for (const b of anchorsB) {
        if (areAnchorsIncompatible(a, b, sameBox)) {
          conflicts++;
        }
      }
    }
    return conflicts;
  };

  // Deterministic PRNG for tie-breaking / ordering
  let rngState = seed || 1337;
  const nextRand = () => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 0x100000000;
  };

  // Iterative hierarchical Leiden (local move -> refinement -> aggregation)
  let currentNodeCount = nodeCount;
  let currentAdj = adj;
  let currentDeg = deg;
  let currentMetas = nodeMetas;
  const hierarchyMaps: number[][] = [];

  for (let level = 0; level < 6; level++) {
    const comm = Array.from({ length: currentNodeCount }, (_, i) => i);
    const commDeg = new Float64Array(currentNodeCount);
    const commAnchors: Array<LeidenNodeMeta["anchors"]> = currentMetas.map((m) => [...m.anchors]);
    const commBoxIds: Array<string | undefined> = currentMetas.map((m) => m.groupBoxId);
    const commMembers: Array<Set<number>> = Array.from({ length: currentNodeCount }, (_, i) => new Set([i]));

    for (let i = 0; i < currentNodeCount; i++) {
      commDeg[i] = currentDeg[i];
    }

    // Phase 1: Fast Local Moving with Queue
    const order = Array.from({ length: currentNodeCount }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(nextRand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    const inQueue = new Uint8Array(currentNodeCount);
    const queue: number[] = [];
    for (const idx of order) {
      queue.push(idx);
      inQueue[idx] = 1;
    }

    let head = 0;
    let movesCount = 0;
    const maxMoves = currentNodeCount * 16;

    while (head < queue.length && movesCount < maxMoves) {
      const u = queue[head++];
      inQueue[u] = 0;

      const oldC = comm[u];
      const uDeg = currentDeg[u];
      const uMeta = currentMetas[u];

      // Temporarily remove u from oldC
      commMembers[oldC].delete(u);
      commDeg[oldC] -= uDeg;

      // Rebuild oldC anchor list without u (fast since anchors per cluster <= a few)
      const rebuildCommAnchors = (cId: number): LeidenNodeMeta["anchors"] => {
        const res: LeidenNodeMeta["anchors"] = [];
        for (const mIdx of commMembers[cId]) {
          res.push(...currentMetas[mIdx].anchors);
        }
        return res;
      };
      commAnchors[oldC] = rebuildCommAnchors(oldC);

      // Accumulate edge weights to neighboring communities
      const weightsToComm = new Map<number, number>();
      weightsToComm.set(oldC, 0);
      for (const edge of currentAdj[u]) {
        const targetC = comm[edge.to];
        weightsToComm.set(targetC, (weightsToComm.get(targetC) ?? 0) + edge.w);
      }

      // Evaluate delta-Q for candidate communities
      let bestC = oldC;
      const oldW = weightsToComm.get(oldC) ?? 0;
      const oldConflicts = countIncompatibleAnchorPairs(
        uMeta.anchors,
        commAnchors[oldC],
        uMeta.groupBoxId,
        commBoxIds[oldC]
      );
      let bestScore =
        oldW - (gamma * uDeg * commDeg[oldC]) / totalWeight2m - anchorPenaltyWeight * oldConflicts;

      for (const [candC, wToCand] of weightsToComm.entries()) {
        if (candC === oldC) continue;
        const conflicts = countIncompatibleAnchorPairs(
          uMeta.anchors,
          commAnchors[candC],
          uMeta.groupBoxId,
          commBoxIds[candC]
        );
        const score =
          wToCand -
          (gamma * uDeg * commDeg[candC]) / totalWeight2m -
          anchorPenaltyWeight * conflicts;
        if (score > bestScore + 1e-9) {
          bestScore = score;
          bestC = candC;
        }
      }

      // Check singleton empty community score (= 0)
      if (bestScore < -1e-9 && commMembers[oldC].size > 0) {
        // Find an empty community slot
        const emptySlot = commMembers.findIndex((s) => s.size === 0);
        if (emptySlot >= 0) {
          bestC = emptySlot;
        }
      }

      // Commit move to bestC
      comm[u] = bestC;
      commMembers[bestC].add(u);
      commDeg[bestC] += uDeg;
      commAnchors[bestC] = rebuildCommAnchors(bestC);
      if (!commBoxIds[bestC] && uMeta.groupBoxId) {
        commBoxIds[bestC] = uMeta.groupBoxId;
      }

      if (bestC !== oldC) {
        movesCount++;
        for (const edge of currentAdj[u]) {
          if (comm[edge.to] !== bestC && inQueue[edge.to] === 0) {
            queue.push(edge.to);
            inQueue[edge.to] = 1;
          }
        }
      }
    }

    // Phase 2: Leiden Refinement Phase (guarantees connected sub-communities!)
    const refined = new Int32Array(currentNodeCount);
    refined.fill(-1);
    let nextRefinedId = 0;

    // Group nodes by coarse community
    const coarseGroups = new Map<number, number[]>();
    for (let i = 0; i < currentNodeCount; i++) {
      const c = comm[i];
      let arr = coarseGroups.get(c);
      if (!arr) {
        arr = [];
        coarseGroups.set(c, arr);
      }
      arr.push(i);
    }

    for (const members of coarseGroups.values()) {
      const memberSet = new Set(members);
      const subCommAnchors = new Map<number, LeidenNodeMeta["anchors"]>();
      const subCommDeg = new Map<number, number>();
      const subCommBox = new Map<number, string | undefined>();

      // Initialize singleton subcommunities inside S
      for (const u of members) {
        const rid = nextRefinedId++;
        refined[u] = rid;
        subCommAnchors.set(rid, [...currentMetas[u].anchors]);
        subCommDeg.set(rid, currentDeg[u]);
        subCommBox.set(rid, currentMetas[u].groupBoxId);
      }

      // Merge well-connected singletons within S
      const sTotalDeg = members.reduce((acc, idx) => acc + currentDeg[idx], 0);
      for (const u of members) {
        const ridU = refined[u];
        // Only merge if still singleton in refinement
        const uDeg = currentDeg[u];
        const wToS = currentAdj[u].reduce(
          (acc, e) => (memberSet.has(e.to) ? acc + e.w : acc),
          0
        );
        const wellConnectedU =
          wToS >= (gamma * uDeg * Math.max(0, sTotalDeg - uDeg)) / totalWeight2m - 1e-9;
        if (!wellConnectedU) continue;

        let bestTargetRid = ridU;
        let bestGain = 0;
        const wToSub = new Map<number, number>();
        for (const e of currentAdj[u]) {
          if (!memberSet.has(e.to)) continue;
          const rTo = refined[e.to];
          if (rTo === ridU) continue;
          wToSub.set(rTo, (wToSub.get(rTo) ?? 0) + e.w);
        }

        for (const [candRid, w] of wToSub.entries()) {
          const candAnchors = subCommAnchors.get(candRid) ?? [];
          const candBox = subCommBox.get(candRid);
          const conflicts = countIncompatibleAnchorPairs(
            subCommAnchors.get(ridU) ?? [],
            candAnchors,
            subCommBox.get(ridU),
            candBox
          );
          if (conflicts > 0) continue;
          const cDeg = subCommDeg.get(candRid) ?? 0;
          const gain = w - (gamma * uDeg * cDeg) / totalWeight2m;
          if (gain > bestGain + 1e-9) {
            bestGain = gain;
            bestTargetRid = candRid;
          }
        }

        if (bestTargetRid !== ridU) {
          // Reassign all nodes currently in ridU to bestTargetRid
          for (const m of members) {
            if (refined[m] === ridU) refined[m] = bestTargetRid;
          }
          const mergedAnchors = [
            ...(subCommAnchors.get(bestTargetRid) ?? []),
            ...(subCommAnchors.get(ridU) ?? []),
          ];
          subCommAnchors.set(bestTargetRid, mergedAnchors);
          subCommDeg.set(
            bestTargetRid,
            (subCommDeg.get(bestTargetRid) ?? 0) + (subCommDeg.get(ridU) ?? 0)
          );
        }
      }
    }

    // Compact refined IDs to 0..K-1
    const remap = new Map<number, number>();
    const compactRefined = new Array<number>(currentNodeCount);
    for (let i = 0; i < currentNodeCount; i++) {
      const r = refined[i];
      let id = remap.get(r);
      if (id === undefined) {
        id = remap.size;
        remap.set(r, id);
      }
      compactRefined[i] = id;
    }

    hierarchyMaps.push(compactRefined);

    const nextCount = remap.size;
    if (nextCount >= currentNodeCount || nextCount <= 1) {
      break;
    }

    // Phase 3: Aggregate Graph
    const aggMetas: LeidenNodeMeta[] = Array.from({ length: nextCount }, (_, i) => ({
      index: i,
      anchors: [],
      groupBoxId: undefined,
    }));
    for (let i = 0; i < currentNodeCount; i++) {
      const c = compactRefined[i];
      aggMetas[c].anchors.push(...currentMetas[i].anchors);
      if (!aggMetas[c].groupBoxId && currentMetas[i].groupBoxId) {
        aggMetas[c].groupBoxId = currentMetas[i].groupBoxId;
      }
    }

    const aggEdgeMap = new Map<string, number>();
    const aggDeg = new Float64Array(nextCount);
    for (let u = 0; u < currentNodeCount; u++) {
      const cu = compactRefined[u];
      aggDeg[cu] += currentDeg[u];
      for (const e of currentAdj[u]) {
        const cv = compactRefined[e.to];
        if (cu < cv) {
          const key = `${cu}:${cv}`;
          aggEdgeMap.set(key, (aggEdgeMap.get(key) ?? 0) + e.w);
        }
      }
    }

    const aggAdj: Array<Array<{ to: number; w: number }>> = Array.from(
      { length: nextCount },
      () => []
    );
    for (const [key, w] of aggEdgeMap.entries()) {
      const [su, sv] = key.split(":");
      const u = Number(su);
      const v = Number(sv);
      aggAdj[u].push({ to: v, w });
      aggAdj[v].push({ to: u, w });
    }

    currentNodeCount = nextCount;
    currentAdj = aggAdj;
    currentDeg = aggDeg;
    currentMetas = aggMetas;
  }

  // Compose hierarchy maps back to original nodes
  const finalComm = Array.from({ length: nodeCount }, (_, i) => i);
  for (const levelMap of hierarchyMaps) {
    for (let i = 0; i < nodeCount; i++) {
      finalComm[i] = levelMap[finalComm[i]];
    }
  }

  // Compute final modularity Q
  const commWeightIn = new Map<number, number>();
  const commTotalDeg = new Map<number, number>();
  for (let u = 0; u < nodeCount; u++) {
    const cu = finalComm[u];
    commTotalDeg.set(cu, (commTotalDeg.get(cu) ?? 0) + deg[u]);
    for (const e of adj[u]) {
      if (finalComm[e.to] === cu) {
        commWeightIn.set(cu, (commWeightIn.get(cu) ?? 0) + e.w);
      }
    }
  }

  let q = 0;
  for (const [cId, tot] of commTotalDeg.entries()) {
    const inW = commWeightIn.get(cId) ?? 0;
    q += inW / totalWeight2m - gamma * Math.pow(tot / totalWeight2m, 2);
  }

  return { communities: finalComm, modularityQ: Number(q.toFixed(4)) };
}

// ============================================================================
// Main Subcircuit Clusterer Entrypoint
// ============================================================================

export function clusterCompiledNetlist(
  netlist: CompiledNetlist,
  options?: ClusterNetlistOptions
): SubcircuitClusterResult {
  // Enforce authoritative netlist rule — strictly forbid raw sch_PrimitiveWire geometry reconstruction
  const rawRecord = netlist as unknown as Record<string, unknown>;
  if ("wires" in rawRecord || "schPrimitiveWires" in rawRecord || "wireSegments" in rawRecord) {
    throw new Error(
      "ERR_FORBIDDEN_WIRE_INTERSECTION: subcircuit-clusterer strictly forbids reading or parsing sch_PrimitiveWire geometry; only CompiledNetlist (eda.sch_Netlist / eda.pcb_Netlist) is allowed."
    );
  }
  if (netlist.netlistSource !== "eda.sch_Netlist" && netlist.netlistSource !== "eda.pcb_Netlist") {
    throw new Error(
      `ERR_UNTRUSTED_NETLIST_SOURCE: expected 'eda.sch_Netlist' or 'eda.pcb_Netlist', got '${String(
        netlist.netlistSource
      )}'`
    );
  }

  const components = netlist.components;
  const n = components.length;
  const compIndexByDes = new Map<string, number>();
  components.forEach((c, idx) => compIndexByDes.set(c.designator, idx));

  const compCesms = components.map((c) => resolveCesm(c, options?.cesmLookup));
  const compAnchorInfo = components.map((c, idx) => classifyAnchor(c, compCesms[idx]));
  const compGroupBoxes = components.map((c) => findGroupBoxForComponent(c, netlist.groupBoxes));

  const minClusterSize = options?.minClusterSize ?? 3;
  const maxClusterSize = options?.maxClusterSize ?? 35;

  // ========================================================================
  // Step 1: Global Power / Ground Stripping
  // ========================================================================
  const allNetNames = netlist.nets.map((net) => net.netName);
  const overrideSet = new Set((options?.powerGndNetsOverride ?? []).map((s) => s.trim()));
  const fanoutThreshold = Math.max(8, Math.ceil(0.15 * n));

  const globalNets = new Set<string>();
  const localNets: CompiledNet[] = [];

  for (const net of netlist.nets) {
    const uniqueComps = new Set(net.endpoints.map((ep) => ep.designator));
    const degree = Math.max(uniqueComps.size, net.fanout);
    const isBus = isParallelBusNet(net.netName, allNetNames);
    const isGlobal =
      overrideSet.has(net.netName) ||
      net.isPowerOrGround === true ||
      isSemanticPowerOrGndNet(net.netName) ||
      (!isBus && degree > fanoutThreshold);

    if (isGlobal) {
      globalNets.add(net.netName);
    } else {
      localNets.push(net);
    }
  }

  // Track local degree for every component
  const localDegree = new Int32Array(n);
  for (const net of localNets) {
    const uniqueIdxs = new Set<number>();
    for (const ep of net.endpoints) {
      const idx = compIndexByDes.get(ep.designator);
      if (idx !== undefined) uniqueIdxs.add(idx);
    }
    if (uniqueIdxs.size >= 2) {
      for (const idx of uniqueIdxs) localDegree[idx]++;
    }
  }

  // ========================================================================
  // Step 2: Three-Source Re-attachment for Orphan Decoupling & Power Passives
  // ========================================================================
  const reattachedOrphans: DecouplingAttachmentRecord[] = [];
  const syntheticEdges: Array<{ u: number; v: number; weight: number }> = [];
  const memberMetadata = new Map<
    string,
    {
      role?: string;
      target_anchor?: string;
      target_pin?: string;
      target_pins?: string[];
      max_dist_mm?: number;
      power_order?: string;
    }
  >();

  // Helper to get schematic distance
  const schDistance = (a: CompiledComponent, b: CompiledComponent, pinPos?: [number, number]): number => {
    if (!a.posMm || (!b.posMm && !pinPos)) return Number.POSITIVE_INFINITY;
    const pB = pinPos ?? b.posMm!;
    return Math.hypot(a.posMm[0] - pB[0], a.posMm[1] - pB[1]);
  };

  // Identify orphan capacitors (and orphan 2-pin power passives like ferrite beads / fuses)
  const orphanCapIndices: number[] = [];
  const orphanOtherPassiveIndices: number[] = [];

  for (let i = 0; i < n; i++) {
    if (localDegree[i] > 0) continue;
    const comp = components[i];
    if (compAnchorInfo[i].tier !== "SATELLITE_PASSIVE") continue;
    const connectedNets = comp.pins.map((p) => p.net).filter((x): x is string => Boolean(x));
    if (connectedNets.length === 0) continue;

    if (isCapacitorComponent(comp, compCesms[i])) {
      orphanCapIndices.push(i);
    } else {
      orphanOtherPassiveIndices.push(i);
    }
  }

  // Group orphan caps by chosen host IC & power rail to enable 1-to-1 pin quota balancing
  interface CapHostAssignment {
    capIdx: number;
    hostIdx: number;
    powerNet: string;
    groundNet: string;
    source: DecouplingAttachmentRecord["source"];
  }

  const capHostAssignments: CapHostAssignment[] = [];

  for (const capIdx of orphanCapIndices) {
    const cap = components[capIdx];
    const capNets = Array.from(
      new Set(cap.pins.map((p) => p.net).filter((x): x is string => Boolean(x)))
    );
    const groundNet = capNets.find((nm) => isGroundNetName(nm)) ?? "GND";
    const powerNet = capNets.find((nm) => !isGroundNetName(nm)) ?? capNets[0] ?? "VCC";

    // Find all non-orphan-cap candidate host components connected to powerNet
    const candidateHosts: Array<{
      hostIdx: number;
      score: number;
      dist: number;
      sameSheet: boolean;
      sameBox: boolean;
      source: DecouplingAttachmentRecord["source"];
    }> = [];

    const capBox = compGroupBoxes[capIdx];

    for (let hIdx = 0; hIdx < n; hIdx++) {
      if (hIdx === capIdx) continue;
      if (isCapacitorComponent(components[hIdx], compCesms[hIdx])) continue;
      if (compAnchorInfo[hIdx].tier === "SATELLITE_PASSIVE") continue;

      const host = components[hIdx];
      const matchingPins = host.pins.filter((p) => p.net === powerNet);
      if (matchingPins.length === 0) continue;

      const sameSheet = Boolean(cap.sheetId && host.sheetId && cap.sheetId === host.sheetId);
      const hostBox = compGroupBoxes[hIdx];
      const sameBox = Boolean(capBox && hostBox && capBox.id === hostBox.id);

      let minDist = Number.POSITIVE_INFINITY;
      for (const pin of matchingPins) {
        const d = schDistance(cap, host, pin.posMm);
        if (d < minDist) minDist = d;
      }

      if (Number.isFinite(minDist)) {
        // Source 1: Schematic page + group box + Euclidean distance
        const sheetBonus = sameSheet ? 0 : 1000;
        const boxBonus = sameBox ? -500 : 0;
        candidateHosts.push({
          hostIdx: hIdx,
          score: minDist + sheetBonus + boxBonus,
          dist: minDist,
          sameSheet,
          sameBox,
          source: "SCH_EUCLIDEAN",
        });
      } else {
        // Source 3: Netlist fallback weighted by power pin count * IC pin weight
        const weight = matchingPins.length * Math.sqrt(Math.max(1, host.pins.length));
        candidateHosts.push({
          hostIdx: hIdx,
          score: -weight - (sameBox ? 500 : 0) - (sameSheet ? 100 : 0),
          dist: Infinity,
          sameSheet,
          sameBox,
          source: "NETLIST_FALLBACK",
        });
      }
    }

    if (candidateHosts.length > 0) {
      candidateHosts.sort((a, b) => a.score - b.score);
      const best = candidateHosts[0];
      capHostAssignments.push({
        capIdx,
        hostIdx: best.hostIdx,
        powerNet,
        groundNet,
        source: best.source,
      });
    }
  }

  // Group by (hostIdx, powerNet) for Source 2 multi-VDD quota 1-to-1 balanced assignment
  const hostRailGroups = new Map<string, CapHostAssignment[]>();
  for (const item of capHostAssignments) {
    const key = `${item.hostIdx}::${item.powerNet}`;
    let list = hostRailGroups.get(key);
    if (!list) {
      list = [];
      hostRailGroups.set(key, list);
    }
    list.push(item);
  }

  for (const group of hostRailGroups.values()) {
    const hostIdx = group[0].hostIdx;
    const host = components[hostIdx];
    const powerNet = group[0].powerNet;
    const vddPins = host.pins.filter((p) => p.net === powerNet);
    const gndPins = host.pins.filter((p) => p.net === group[0].groundNet);

    // Split bulk vs HF caps
    const hfCaps = group.filter((g) => !isBulkCapacitor(components[g.capIdx]));
    const bulkCaps = group.filter((g) => isBulkCapacitor(components[g.capIdx]));

    const pinAssignCount = new Map<string, number>();
    for (const vp of vddPins) pinAssignCount.set(vp.pinNumber, 0);

    // Assign HF decoupling caps with strict load-balanced 1-to-1 pin quota
    for (const item of hfCaps) {
      const cap = components[item.capIdx];
      let chosenPin = vddPins[0];
      let bestCost = Number.POSITIVE_INFINITY;

      for (const vp of vddPins) {
        const currentCount = pinAssignCount.get(vp.pinNumber) ?? 0;
        const dist = schDistance(cap, host, vp.posMm);
        const normDist = Number.isFinite(dist) ? dist : 0;
        // Quota balancing dominates, Euclidean distance breaks ties
        const cost = currentCount * 10_000 + normDist;
        if (cost < bestCost) {
          bestCost = cost;
          chosenPin = vp;
        }
      }

      if (chosenPin) {
        pinAssignCount.set(chosenPin.pinNumber, (pinAssignCount.get(chosenPin.pinNumber) ?? 0) + 1);
      }

      // Find nearest VSS/GND pin on the host IC if available
      const pairedGndPin = gndPins.length > 0 ? gndPins[0] : undefined;
      const targetPins = chosenPin
        ? pairedGndPin
          ? [`${host.designator}.${chosenPin.pinNumber}`, `${host.designator}.${pairedGndPin.pinNumber}`]
          : [`${host.designator}.${chosenPin.pinNumber}`]
        : [];

      const usedQuotaSource: DecouplingAttachmentRecord["source"] =
        vddPins.length > 1 && hfCaps.length > 1 ? "PIN_QUOTA_BALANCED" : item.source;

      reattachedOrphans.push({
        capacitorDesignator: cap.designator,
        targetIcDesignator: host.designator,
        targetPins,
        powerNet: item.powerNet,
        groundNet: item.groundNet,
        source: usedQuotaSource,
      });

      memberMetadata.set(cap.designator, {
        role: "DECAP_PIN_PAIR",
        target_anchor: host.designator,
        target_pins: targetPins,
        max_dist_mm: 1.8,
        power_order: "VIA_TO_CAP_TO_PIN",
      });

      syntheticEdges.push({ u: item.capIdx, v: hostIdx, weight: 16.0 });
    }

    // Assign bulk caps to primary power entry pin
    for (const item of bulkCaps) {
      const cap = components[item.capIdx];
      const primaryPin =
        vddPins.find((p) => /VIN|VDD_?MAIN|PVDD|VBAT|AVDD/i.test(p.pinName)) ?? vddPins[0];
      const targetPins = primaryPin ? [`${host.designator}.${primaryPin.pinNumber}`] : [];

      reattachedOrphans.push({
        capacitorDesignator: cap.designator,
        targetIcDesignator: host.designator,
        targetPins,
        powerNet: item.powerNet,
        groundNet: item.groundNet,
        source: item.source,
      });

      memberMetadata.set(cap.designator, {
        role: "DECAP_BULK",
        target_anchor: host.designator,
        target_pins: targetPins,
        max_dist_mm: 2.8,
        power_order: "VIA_TO_CAP_TO_PIN",
      });

      syntheticEdges.push({ u: item.capIdx, v: hostIdx, weight: 15.0 });
    }
  }

  // Reattach other 2-pin power passives (e.g. ferrite bead FB* between 3V3 and VDDA, or fuse F*)
  const netFanoutMap = new Map<string, number>();
  for (const net of netlist.nets) {
    netFanoutMap.set(net.netName, new Set(net.endpoints.map((ep) => ep.designator)).size);
  }
  for (const pIdx of orphanOtherPassiveIndices) {
    const passive = components[pIdx];
    const pNets = Array.from(
      new Set(passive.pins.map((p) => p.net).filter((x): x is string => Boolean(x)))
    );
    if (pNets.length === 0) continue;

    // Pick the lowest-fanout non-ground net (e.g. VDDA over 3V3) to find its local host IC
    const nonGnd = pNets.filter((nm) => !isGroundNetName(nm));
    nonGnd.sort((a, b) => (netFanoutMap.get(a) ?? 999) - (netFanoutMap.get(b) ?? 999));
    const targetNet = nonGnd[0] ?? pNets[0];

    let bestHostIdx = -1;
    let bestScore = Infinity;
    for (let hIdx = 0; hIdx < n; hIdx++) {
      if (hIdx === pIdx || compAnchorInfo[hIdx].tier === "SATELLITE_PASSIVE") continue;
      if (!components[hIdx].pins.some((p) => p.net === targetNet)) continue;
      const dist = schDistance(passive, components[hIdx]);
      const score = Number.isFinite(dist) ? dist : -components[hIdx].pins.length;
      if (score < bestScore) {
        bestScore = score;
        bestHostIdx = hIdx;
      }
    }
    if (bestHostIdx >= 0) {
      syntheticEdges.push({ u: pIdx, v: bestHostIdx, weight: 14.0 });
    }
  }

  // ========================================================================
  // Step 3: Weighted Clique Expansion + Inter-Module Bus Pruning
  // ========================================================================
  const edgeAccumulator = new Map<string, number>();
  const addEdgeWeight = (u: number, v: number, w: number) => {
    if (u === v || w <= 0) return;
    const a = u < v ? u : v;
    const b = u < v ? v : u;
    const key = `${a}:${b}`;
    edgeAccumulator.set(key, (edgeAccumulator.get(key) ?? 0) + w);
  };

  for (const se of syntheticEdges) {
    addEdgeWeight(se.u, se.v, se.weight);
  }

  const hyperedgeMetas: InternalHyperedgeMeta[] = [];

  for (const net of localNets) {
    const uniqueIdxSet = new Set<number>();
    for (const ep of net.endpoints) {
      const idx = compIndexByDes.get(ep.designator);
      if (idx !== undefined) uniqueIdxSet.add(idx);
    }
    const compIdxs = Array.from(uniqueIdxSet);
    if (compIdxs.length < 2) continue;

    // Count distinct non-satellite anchors on this net
    const anchorsOnNet = compIdxs.filter(
      (idx) => compAnchorInfo[idx].tier !== "SATELLITE_PASSIVE"
    );

    const netUpper = net.netName.toUpperCase();
    const pinNamesUpper = net.endpoints.map((ep) => (ep.pinName ?? "").toUpperCase()).join(" ");
    const hasSwPin = net.endpoints.some((ep) => ep.elecType === "SW_NODE");

    let alpha = 1.5;
    let isInterModuleBus = false;
    let signalClass = "DIGITAL_CTRL";

    // Check high-coupling alpha=15 criteria
    const hasConnector = compIdxs.some((idx) => compAnchorInfo[idx].archetype === "IO_CONN");
    const hasProtection = compIdxs.some((idx) => {
      const cat = compCesms[idx]?.category;
      const d = components[idx].designator.toUpperCase();
      return (
        cat === "TVS_ESD_MOV" ||
        cat === "FERRITE_CMC" ||
        /^(?:TVS|ESD|FB|F|PTC)\d*/.test(d) ||
        /USBLC|SM712|PESD/i.test(components[idx].mpn ?? "")
      );
    });

    if (
      hasSwPin ||
      HIGH_BINDING_ALPHA15_REGEX.test(netUpper) ||
      /\b(?:SW|LX|PH|BOOT|FB|OSC_?IN|OSC_?OUT|XTAL|IN-|GATE|SENSE)\b/i.test(pinNamesUpper) ||
      (hasConnector && hasProtection && anchorsOnNet.length <= 1)
    ) {
      alpha = 15.0;
      signalClass = hasSwPin || /SW|LX|PH/.test(netUpper) ? "SW_NODE" : "CRITICAL_LOCAL";
    } else if (STRONG_BINDING_ALPHA5_REGEX.test(netUpper)) {
      alpha = 5.0;
      if (/USB|D[PM]|D\+|D-/.test(netUpper)) signalClass = "DIFF_90_OHM";
      else if (/ETH|MDI|HDMI|TMDS|MIPI/.test(netUpper)) signalClass = "DIFF_100_OHM";
      else if (/CAN|485/.test(netUpper)) signalClass = "DIFF_120_OHM";
      else signalClass = "HIGH_SPEED_SIGNAL";
    }

    // Check INTER_MODULE_BUS pruning condition:
    // Shared multi-anchor bus connecting >= 2 distinct anchors (e.g. I2C, SPI, UART, GPIO, or >= 3 anchors)
    if (
      anchorsOnNet.length >= 2 &&
      (INTER_MODULE_BUS_REGEX.test(netUpper) ||
        anchorsOnNet.length >= 3 ||
        (alpha <= 5.0 &&
          anchorsOnNet.some((idx) => compAnchorInfo[idx].archetype === "MCU") &&
          anchorsOnNet.some((idx) => compAnchorInfo[idx].archetype !== "MCU")))
    ) {
      // Wait: if this net ALSO connects an interface connector to its local ESD chip (3-pin chain J1 -> ESD -> U1),
      // keep the J1<->ESD primary segment in G_strong at alpha=15, and prune only the ESD/J1<->MCU link!
      isInterModuleBus = true;
      alpha = 0.3;
    }

    hyperedgeMetas.push({
      net,
      componentIndices: compIdxs,
      alpha,
      isInterModuleBus,
      signalClass,
    });

    if (isInterModuleBus) {
      // Exception: if net has connector + protection satellite + remote MCU, keep connector<->protection tightly bound!
      if (hasConnector && hasProtection) {
        const connAndProt = compIdxs.filter(
          (idx) =>
            compAnchorInfo[idx].archetype === "IO_CONN" ||
            compAnchorInfo[idx].tier === "SATELLITE_PASSIVE"
        );
        for (let i = 0; i < connAndProt.length; i++) {
          for (let j = i + 1; j < connAndProt.length; j++) {
            addEdgeWeight(connAndProt[i], connAndProt[j], 15.0);
          }
        }
      }
      // Do NOT add inter-anchor cross-module bus edges to G_strong (pruned!)
      continue;
    }

    const cliqueDenom = Math.max(1, compIdxs.length - 1);
    const baseW = alpha / cliqueDenom;
    for (let i = 0; i < compIdxs.length; i++) {
      for (let j = i + 1; j < compIdxs.length; j++) {
        const u = compIdxs[i];
        const v = compIdxs[j];
        let betaSch = 0;
        const boxU = compGroupBoxes[u];
        const boxV = compGroupBoxes[v];
        if (boxU && boxV && boxU.id === boxV.id) {
          betaSch = 1.5;
        } else if (
          components[u].clusterGroup &&
          components[u].clusterGroup === components[v].clusterGroup
        ) {
          betaSch = 1.5;
        } else if (
          components[u].sheetId &&
          components[u].sheetId === components[v].sheetId &&
          schDistance(components[u], components[v]) < 25
        ) {
          betaSch = 0.3;
        }
        addEdgeWeight(u, v, baseW + betaSch);
      }
    }
  }

  // Also add groupBox intra-box co-membership affinity for passives inside the same SchGroupBox
  for (let i = 0; i < n; i++) {
    const boxI = compGroupBoxes[i];
    if (!boxI) continue;
    for (let j = i + 1; j < n; j++) {
      const boxJ = compGroupBoxes[j];
      if (boxJ && boxI.id === boxJ.id) {
        if (
          !areAnchorsIncompatible(
            { designator: components[i].designator, ...compAnchorInfo[i] },
            { designator: components[j].designator, ...compAnchorInfo[j] },
            true
          )
        ) {
          addEdgeWeight(i, j, 0.5);
        }
      }
    }
  }

  const strongEdges: InternalEdge[] = [];
  for (const [key, w] of edgeAccumulator.entries()) {
    const [su, sv] = key.split(":");
    strongEdges.push({ u: Number(su), v: Number(sv), weight: w });
  }

  // ========================================================================
  // Step 4: Anchor-Constrained Leiden Clustering + Size Convergence [3..35]
  // ========================================================================
  const nodeMetas: LeidenNodeMeta[] = components.map((c, idx) => ({
    index: idx,
    anchors:
      compAnchorInfo[idx].tier !== "SATELLITE_PASSIVE"
        ? [{ designator: c.designator, ...compAnchorInfo[idx] }]
        : [],
    groupBoxId: compGroupBoxes[idx]?.id,
  }));

  let chosenGamma = 1.25;
  let leidenRes = runWeightedLeiden(
    n,
    strongEdges,
    nodeMetas,
    chosenGamma,
    100.0,
    options?.seed ?? 42
  );

  // Sweep gamma in [1.25..2.5] if any cluster exceeds maxClusterSize (35)
  const getGroupSizes = (comms: number[]) => {
    const map = new Map<number, number[]>();
    comms.forEach((cId, idx) => {
      let arr = map.get(cId);
      if (!arr) {
        arr = [];
        map.set(cId, arr);
      }
      arr.push(idx);
    });
    return map;
  };

  let groups = getGroupSizes(leidenRes.communities);
  for (const gammaTry of [1.6, 2.0, 2.5]) {
    const hasOversized = Array.from(groups.values()).some((m) => m.length > maxClusterSize);
    if (!hasOversized) break;
    chosenGamma = gammaTry;
    leidenRes = runWeightedLeiden(
      n,
      strongEdges,
      nodeMetas,
      chosenGamma,
      100.0,
      options?.seed ?? 42
    );
    groups = getGroupSizes(leidenRes.communities);
  }

  // Post-process oversized clusters (> 35) by deterministic k-way sub-partitioning
  const commAssignments = [...leidenRes.communities];
  let nextNewCommId = Math.max(-1, ...commAssignments) + 1;

  for (const [cId, members] of getGroupSizes(commAssignments).entries()) {
    if (members.length <= maxClusterSize) continue;
    // Pick primary anchor (most pins among anchors in cluster)
    const memberSet = new Set(members);
    const primaryAnchor = [...members].sort((a, b) => {
      const rank = (t: AnchorTier) =>
        t === "MECHANICAL_EDGE_ANCHOR" ? 0 : t === "FUNCTIONAL_IC_ANCHOR" ? 1 : 2;
      const ra = rank(compAnchorInfo[a].tier);
      const rb = rank(compAnchorInfo[b].tier);
      if (ra !== rb) return ra - rb;
      return components[b].pins.length - components[a].pins.length;
    })[0];

    // Build intra-cluster adjacency sorted by descending edge weight so cohesive sub-blocks stay together
    const intraAdj = new Map<number, Array<{ to: number; w: number }>>();
    members.forEach((m) => intraAdj.set(m, []));
    for (const e of strongEdges) {
      if (memberSet.has(e.u) && memberSet.has(e.v)) {
        intraAdj.get(e.u)!.push({ to: e.v, w: e.weight });
        intraAdj.get(e.v)!.push({ to: e.u, w: e.weight });
      }
    }

    // Priority-first traversal from primaryAnchor (attaches highest-weight tightly bound satellites first, e.g. decaps & crystal+caps!)
    const visited = new Set<number>();
    const orderedByAffinity: number[] = [];
    const frontier = new Map<number, number>();
    frontier.set(primaryAnchor, Infinity);

    while (visited.size < members.length) {
      let bestNode = -1;
      let bestW = -Infinity;
      for (const [node, w] of frontier.entries()) {
        if (!visited.has(node) && w > bestW) {
          bestW = w;
          bestNode = node;
        }
      }
      if (bestNode === -1) {
        bestNode = members.find((m) => !visited.has(m))!;
      }
      frontier.delete(bestNode);
      visited.add(bestNode);
      orderedByAffinity.push(bestNode);

      for (const edge of intraAdj.get(bestNode) ?? []) {
        if (!visited.has(edge.to)) {
          frontier.set(edge.to, Math.max(frontier.get(edge.to) ?? 0, edge.w));
        }
      }
    }

    // Also pull crystal + its load caps together if any boundary straddles them
    const chunkCount = Math.ceil(members.length / maxClusterSize);
    const keepCount = Math.min(maxClusterSize, Math.ceil(members.length / chunkCount));
    const overflow = orderedByAffinity.slice(keepCount);
    const overflowPerChunk = Math.ceil(overflow.length / Math.max(1, chunkCount - 1));

    for (let k = 0; k < chunkCount - 1; k++) {
      const slice = overflow.slice(k * overflowPerChunk, (k + 1) * overflowPerChunk);
      if (slice.length === 0) continue;
      const newCid = nextNewCommId++;
      for (const idx of slice) {
        commAssignments[idx] = newCid;
      }
    }
    void cId;
  }

  // Post-process undersized clusters (< minClusterSize, e.g. < 3):
  // Merge orphan 1-2 node fragments into their strongest compatible neighbor cluster (size + fragment <= maxClusterSize)
  let mergedAny = true;
  while (mergedAny) {
    mergedAny = false;
    const curGroups = getGroupSizes(commAssignments);
    for (const [cId, members] of curGroups.entries()) {
      if (members.length >= minClusterSize) continue;
      if (curGroups.size <= 1) break;

      // Score all candidate target clusters via strongEdges + localNets + same groupBox + power rail affinity
      const targetScores = new Map<number, number>();
      const memberSet = new Set(members);

      for (const e of strongEdges) {
        if (memberSet.has(e.u) && !memberSet.has(e.v)) {
          const tc = commAssignments[e.v];
          targetScores.set(tc, (targetScores.get(tc) ?? 0) + e.weight * 2);
        } else if (memberSet.has(e.v) && !memberSet.has(e.u)) {
          const tc = commAssignments[e.u];
          targetScores.set(tc, (targetScores.get(tc) ?? 0) + e.weight * 2);
        }
      }
      for (const hm of hyperedgeMetas) {
        const hitsMine = hm.componentIndices.some((idx) => memberSet.has(idx));
        if (!hitsMine) continue;
        for (const idx of hm.componentIndices) {
          if (!memberSet.has(idx)) {
            const tc = commAssignments[idx];
            targetScores.set(tc, (targetScores.get(tc) ?? 0) + Math.max(0.2, hm.alpha));
          }
        }
      }

      // Check schematic group box & global power-net overlap as gentle tie-breaker
      for (const [tc, tMembers] of curGroups.entries()) {
        if (tc === cId) continue;
        if (tMembers.length + members.length > maxClusterSize) continue;
        for (const m of members) {
          for (const tm of tMembers) {
            if (compGroupBoxes[m] && compGroupBoxes[tm] && compGroupBoxes[m]!.id === compGroupBoxes[tm]!.id) {
              targetScores.set(tc, (targetScores.get(tc) ?? 0) + 5.0);
            }
          }
        }
      }

      // Choose best target that won't exceed maxClusterSize and avoids incompatible anchor clash if possible
      const myAnchors = members.flatMap((idx) => nodeMetas[idx].anchors);
      const hasMyAnchor = myAnchors.length > 0;
      let bestTarget = -1;
      let bestScore = -Infinity;

      for (const [tc, tMembers] of curGroups.entries()) {
        if (tc === cId) continue;
        if (tMembers.length + members.length > maxClusterSize) continue;
        const targetAnchors = tMembers.flatMap((idx) => nodeMetas[idx].anchors);
        const sameBox = members.some((m) =>
          tMembers.some(
            (tm) =>
              compGroupBoxes[m] &&
              compGroupBoxes[tm] &&
              compGroupBoxes[m]!.id === compGroupBoxes[tm]!.id
          )
        );
        const hasConflict =
          hasMyAnchor &&
          myAnchors.some((a) =>
            targetAnchors.some((b) => areAnchorsIncompatible(a, b, sameBox))
          );

        const rawScore = targetScores.get(tc) ?? 0.01;
        const effectiveScore = hasConflict ? rawScore - 500 : rawScore;
        if (effectiveScore > bestScore) {
          bestScore = effectiveScore;
          bestTarget = tc;
        }
      }

      // If no compatible target exists for a genuine 2-part anchor subcircuit and total clusters > 1,
      // only force-merge if this fragment has NO anchor at all (pure passive fragment)
      if (bestTarget >= 0 && (bestScore > 0 || !hasMyAnchor)) {
        for (const m of members) {
          commAssignments[m] = bestTarget;
        }
        mergedAny = true;
        break;
      }
    }
  }

  // ========================================================================
  // Build FunctionalClusters, Prototype Mapping, CESM layoutExample & Keepouts
  // ========================================================================
  const finalGroups = getGroupSizes(commAssignments);
  const boardOutline: FunctionalClusterOutput["board_outline"] = options?.boardOutline ?? {
    shape: "RECTANGLE",
    width_mm: 100.0,
    height_mm: 70.0,
    layer_count: 4,
    copper_weight_outer_oz: 1.0,
    stackup: ["TopLayer", "InnerLayer1", "InnerLayer2", "BottomLayer"],
  };
  const stackup = resolveStackupLayers(boardOutline.layer_count, boardOutline.stackup);

  const rigidEdgeAnchors: string[] = [];
  const functionalClusters: FunctionalCluster[] = [];
  const compToClusterId = new Map<number, string>();

  let clusterSeq = 1;
  const sortedGroupEntries = Array.from(finalGroups.entries()).sort((a, b) => a[1][0] - b[1][0]);

  for (const [, memberIndices] of sortedGroupEntries) {
    // Select primary anchor designator (prefer active RF IC over passive antenna connector within RF block)
    const sortedForAnchor = [...memberIndices].sort((a, b) => {
      const rank = (idx: number) => {
        const t = compAnchorInfo[idx].tier;
        if (compAnchorInfo[idx].archetype === "RF" && t === "FUNCTIONAL_IC_ANCHOR") return 0;
        if (t === "MECHANICAL_EDGE_ANCHOR") return 1;
        if (t === "FUNCTIONAL_IC_ANCHOR") return 2;
        return 3;
      };
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      return components[b].pins.length - components[a].pins.length;
    });

    const anchorIdx = sortedForAnchor[0];
    const anchorComp = components[anchorIdx];
    const anchorCesm = compCesms[anchorIdx];
    const anchorArchetype = compAnchorInfo[anchorIdx].archetype;

    for (const idx of memberIndices) {
      if (compAnchorInfo[idx].tier === "MECHANICAL_EDGE_ANCHOR") {
        rigidEdgeAnchors.push(components[idx].designator);
      }
    }

    // Determine module_type (one of the 8 functional prototypes)
    const archetypesInCluster = new Set(memberIndices.map((idx) => compAnchorInfo[idx].archetype));
    const netNamesInCluster = new Set<string>();
    for (const idx of memberIndices) {
      for (const pin of components[idx].pins) {
        if (pin.net) netNamesInCluster.add(pin.net);
      }
    }
    const netsJoined = Array.from(netNamesInCluster).join(" ");

    let moduleType: FunctionalModuleType = "MCU_DIGITAL_CORE";
    if (archetypesInCluster.has("DCDC") || /\b(?:SW|LX|PH|BOOT)\b/i.test(netsJoined)) {
      moduleType = "DCDC_POWER_STAGE";
    } else if (archetypesInCluster.has("LDO")) {
      moduleType = "LDO_REGULATOR";
    } else if (archetypesInCluster.has("RF")) {
      moduleType = "RF_ANTENNA_BLOCK";
    } else if (archetypesInCluster.has("ELECTROMECH")) {
      moduleType = "ELECTROMECH_DRIVER";
    } else if (archetypesInCluster.has("IO_CONN") || archetypesInCluster.has("IO_XCVR")) {
      moduleType = "HIGH_SPEED_IO_ESD";
    } else if (archetypesInCluster.has("ANALOG")) {
      moduleType = "PRECISION_ANALOG_FE";
    } else if (
      anchorArchetype === "CLOCK" ||
      (archetypesInCluster.has("CLOCK") && !archetypesInCluster.has("MCU"))
    ) {
      moduleType = "CLOCK_OSCILLATOR";
    } else {
      moduleType = "MCU_DIGITAL_CORE";
    }

    // Edge affinity & noise role
    let edgeAffinity: ClusterEdgeAffinity = "NONE";
    if (moduleType === "RF_ANTENNA_BLOCK") edgeAffinity = "CORNER";
    else if (moduleType === "HIGH_SPEED_IO_ESD") edgeAffinity = "LEFT_EDGE";
    else if (moduleType === "ELECTROMECH_DRIVER") edgeAffinity = "RIGHT_EDGE";
    else if (moduleType === "MCU_DIGITAL_CORE") edgeAffinity = "CENTER";

    const noiseRoleMap: Record<FunctionalModuleType, string> = {
      DCDC_POWER_STAGE: "STRONG_MAGNETIC_SWITCHING_AGGRESSOR",
      LDO_REGULATOR: "QUIET_LINEAR_REGULATOR_THERMAL_SOURCE",
      MCU_DIGITAL_CORE: "DIGITAL_SSN_SOURCE_AND_CLOCK_VICTIM",
      CLOCK_OSCILLATOR: "HIGH_Z_RESONANT_CLOCK_VICTIM",
      PRECISION_ANALOG_FE: "LOW_LEVEL_ANALOG_VICTIM",
      HIGH_SPEED_IO_ESD: "ESD_SURGE_ENTRY_AND_DIFF_IO",
      RF_ANTENNA_BLOCK: "RF_RADIATOR_AND_SENSITIVE_RX",
      ELECTROMECH_DRIVER: "HIGH_DI_DT_INDUCTIVE_SWITCH_AGGRESSOR",
    };

    const clusterId = `CLU_${String(clusterSeq++).padStart(2, "0")}_${moduleType}`;
    const boxTitle = memberIndices.map((idx) => compGroupBoxes[idx]?.title).find(Boolean);

    // Check for crystal sub-satellite inside MCU cluster
    const subSatellites: string[] = [];
    for (const idx of memberIndices) {
      if (moduleType === "MCU_DIGITAL_CORE" && compAnchorInfo[idx].archetype === "CLOCK") {
        subSatellites.push(`${clusterId}_XTAL_${components[idx].designator}`);
      }
    }

    // Build members array & estimate area
    let estimatedAreaMm2 = 0;
    const members: ClusterMember[] = memberIndices.map((idx) => {
      const comp = components[idx];
      const fp = comp.footprint ?? "UNKNOWN";
      const bbox = estimateFootprintBboxMm(fp, comp, options?.footprintBboxLookup);
      estimatedAreaMm2 += bbox[0] * bbox[1] * 1.45;
      const meta = memberMetadata.get(comp.designator);
      const cesm = compCesms[idx];

      let role = meta?.role ?? "SATELLITE_PASSIVE";
      if (idx === anchorIdx) {
        role = `${moduleType}_ANCHOR`;
      } else if (compAnchorInfo[idx].archetype === "CLOCK") {
        role = "PASSIVE_CRYSTAL";
      } else if (cesm?.category === "IND_POWER") {
        role = "POWER_INDUCTOR";
      } else if (cesm?.category === "TVS_ESD_MOV") {
        role = "INLINE_ESD_ARRAY";
      } else if (cesm?.category === "FERRITE_CMC") {
        role = "ISOLATION_BEAD_OR_CMC";
      } else if (cesm?.category === "RES_SHUNT") {
        role = "CURRENT_SHUNT_SENSE";
      } else if (comp.pins.some((p) => /BOOT|BST/i.test(p.net ?? ""))) {
        role = "BOOT_CAP";
      } else if (comp.pins.some((p) => /FB|VSENSE/i.test(p.net ?? ""))) {
        role = "FB_DIVIDER";
      }

      const memberObj: ClusterMember = {
        designator: comp.designator,
        footprint: fp,
        role,
        bbox_mm: [Number(bbox[0].toFixed(2)), Number(bbox[1].toFixed(2))],
      };

      if (compAnchorInfo[idx].tier === "MECHANICAL_EDGE_ANCHOR") {
        memberObj.clearance_front_mm = 4.0;
      }
      if (meta?.target_anchor) memberObj.target_anchor = meta.target_anchor;
      if (meta?.target_pins && meta.target_pins.length > 0) {
        memberObj.target_pins = meta.target_pins;
      }
      if (meta?.max_dist_mm !== undefined) memberObj.max_dist_mm = meta.max_dist_mm;
      if (meta?.power_order) memberObj.power_order = meta.power_order;

      if (role === "INLINE_ESD_ARRAY") {
        memberObj.target_anchor = anchorComp.designator;
        memberObj.max_dist_mm = 3.5;
        memberObj.zero_stub = true;
      } else if (role === "PASSIVE_CRYSTAL") {
        memberObj.target_anchor = anchorComp.designator;
        memberObj.max_dist_mm = 4.5;
        memberObj.guard_ring = true;
      } else if (role === "POWER_INDUCTOR" || role === "BOOT_CAP") {
        memberObj.target_anchor = anchorComp.designator;
        memberObj.max_dist_mm = 2.0;
        memberObj.same_layer_mandatory = true;
      }

      return memberObj;
    });

    // Inject CESM Layout Example if present on anchor (or any IC in cluster)
    const layoutExampleCompIdx =
      anchorCesm?.layoutExample !== undefined
        ? anchorIdx
        : memberIndices.find((idx) => compCesms[idx]?.layoutExample !== undefined);

    let datasheetLayoutExample: FunctionalCluster["datasheet_layout_example"] | undefined;
    if (layoutExampleCompIdx !== undefined) {
      const le = compCesms[layoutExampleCompIdx]!.layoutExample!;
      datasheetLayoutExample = {
        has_reference_layout: true,
        ...(le.sourceSectionTitle ? { source_section: le.sourceSectionTitle } : {}),
        ...(le.referenceImageUri ? { reference_image_uri: le.referenceImageUri } : {}),
        ...(le.copperZones && le.copperZones.length > 0
          ? { copper_zones: le.copperZones.map((z) => z.zoneRole) }
          : {}),
        ...(le.thermalViaArray
          ? {
              thermal_via_array: {
                ...(le.thermalViaArray.epadPinNumber
                  ? { epad_pin: le.thermalViaArray.epadPinNumber }
                  : {}),
                ...(le.thermalViaArray.gridRows
                  ? { grid_rows: le.thermalViaArray.gridRows }
                  : {}),
                ...(le.thermalViaArray.gridCols
                  ? { grid_cols: le.thermalViaArray.gridCols }
                  : {}),
                ...(le.thermalViaArray.drillMm ? { drill_mm: le.thermalViaArray.drillMm } : {}),
                ...(le.thermalViaArray.pitchMm ? { pitch_mm: le.thermalViaArray.pitchMm } : {}),
              },
            }
          : {}),
        ...(le.sensitiveRouteConstraints && le.sensitiveRouteConstraints.length > 0
          ? {
              sensitive_route_constraints: le.sensitiveRouteConstraints.map(
                (s) => `${s.pinOrNetRole}:${s.tapPointRule ?? s.keepAwayFromRoles.join("+")}`
              ),
            }
          : {}),
      };
    }

    // Generate 2.5D Keepout zones for sensitive/magnetic/RF members (strictly scoped layerSet!)
    const keepoutZones: FunctionalClusterKeepoutZone[] = [];
    for (const idx of memberIndices) {
      const comp = components[idx];
      const cesm = compCesms[idx];
      const bbox = estimateFootprintBboxMm(comp.footprint ?? "", comp, options?.footprintBboxLookup);
      const poly = polygonFromRectMm(0, 0, bbox[0], bbox[1]);
      const nets = comp.pins.map((p) => p.net).filter((x): x is string => Boolean(x));

      if (
        cesm?.category === "IND_POWER" ||
        (/^L\d+/i.test(comp.designator) && !/0201|0402/i.test(comp.footprint ?? ""))
      ) {
        const tuples = generate25DKeepoutFiveTuples({
          category: "POWER_INDUCTOR",
          ownerDesignator: comp.designator,
          polygon2D: poly,
          mountSide: "TOP",
          layerCount: boardOutline.layer_count,
          stackup,
          allowedNets: nets,
        });
        for (const t of tuples) {
          keepoutZones.push({
            target: comp.designator,
            type: "POWER_INDUCTOR_MOUNT_LAYER_ONLY",
            polygon2D: t.polygon2D,
            layerSet: t.layerSet,
            disallowMask: t.disallowMask,
            allowedNets: t.allowedNets,
            mountSide: t.mountSide,
          });
        }
      } else if (cesm?.category === "XTAL_PASSIVE" || /^(?:Y|X|XTAL)\d+/i.test(comp.designator)) {
        const tuples = generate25DKeepoutFiveTuples({
          category: "PASSIVE_CRYSTAL",
          ownerDesignator: comp.designator,
          polygon2D: poly,
          mountSide: "TOP",
          layerCount: boardOutline.layer_count,
          stackup,
          allowedNets: nets,
        });
        for (const t of tuples) {
          keepoutZones.push({
            target: comp.designator,
            type: boardOutline.layer_count >= 4 ? "XTAL_4L_MOUNT_LAYER_ONLY" : "XTAL_2L_PROTECTED",
            polygon2D: t.polygon2D,
            layerSet: t.layerSet,
            disallowMask: t.disallowMask,
            allowedNets: t.allowedNets,
            mountSide: t.mountSide,
          });
        }
      } else if (cesm?.category === "FERRITE_CMC" || /^FB\d+/i.test(comp.designator)) {
        const tuples = generate25DKeepoutFiveTuples({
          category: "FERRITE_OR_CMC",
          ownerDesignator: comp.designator,
          polygon2D: poly,
          mountSide: "TOP",
          layerCount: boardOutline.layer_count,
          stackup,
          allowedNets: nets,
        });
        for (const t of tuples) {
          keepoutZones.push({
            target: comp.designator,
            type: "FERRITE_OR_CMC_SHALLOW_LAYERS",
            polygon2D: t.polygon2D,
            layerSet: t.layerSet,
            disallowMask: t.disallowMask,
            allowedNets: t.allowedNets,
            mountSide: t.mountSide,
          });
        }
      } else if (cesm?.category === "OPAMP_COMP") {
        const inMinusNets = comp.pins
          .filter((p) => /IN-|INN/i.test(p.pinName))
          .map((p) => p.net)
          .filter((x): x is string => Boolean(x));
        const tuples = generate25DKeepoutFiveTuples({
          category: "OPAMP_IN_MINUS",
          ownerDesignator: comp.designator,
          polygon2D: polygonFromRectMm(0, 0, 1.5, 1.5),
          mountSide: "TOP",
          layerCount: boardOutline.layer_count,
          stackup,
          allowedNets: inMinusNets,
        });
        for (const t of tuples) {
          keepoutZones.push({
            target: comp.designator,
            type: "OPAMP_IN_MINUS_NO_POUR",
            polygon2D: t.polygon2D,
            layerSet: t.layerSet,
            disallowMask: t.disallowMask,
            allowedNets: t.allowedNets,
            mountSide: t.mountSide,
          });
        }
      } else if (
        moduleType === "RF_ANTENNA_BLOCK" &&
        idx === anchorIdx
      ) {
        // Place RF antenna keepout at the protruding antenna region (above module pins, not covering 3V3/UART pads!)
        const antOffsetY = bbox[1] * 0.5 + 3.0;
        const clusterRfNets = Array.from(netNamesInCluster).filter((nm) => /RF|ANT/i.test(nm));
        const tuples = generate25DKeepoutFiveTuples({
          category: "RF_ANTENNA",
          ownerDesignator: comp.designator,
          polygon2D: polygonFromRectMm(0, antOffsetY, Math.max(bbox[0], 10), 6.0),
          mountSide: "TOP",
          layerCount: boardOutline.layer_count,
          stackup,
          allowedNets: Array.from(new Set([...clusterRfNets, "GND"])),
        });
        for (const t of tuples) {
          keepoutZones.push({
            target: comp.designator,
            type: "RF_ANTENNA_ALL_LAYERS_KEEPOUT",
            polygon2D: t.polygon2D,
            layerSet: t.layerSet,
            disallowMask: t.disallowMask,
            allowedNets: t.allowedNets,
            mountSide: t.mountSide,
          });
        }
      }
    }

    for (const idx of memberIndices) {
      compToClusterId.set(idx, clusterId);
    }

    const clusterObj: FunctionalCluster = {
      cluster_id: clusterId,
      module_type: moduleType,
      semantic_label: boxTitle ?? `${moduleType} (${anchorComp.designator})`,
      anchor_designator: anchorComp.designator,
      edge_affinity: edgeAffinity,
      estimated_area_mm2: Number(Math.max(1, estimatedAreaMm2).toFixed(2)),
      noise_role: noiseRoleMap[moduleType],
      ...(subSatellites.length > 0 ? { sub_satellites: subSatellites } : {}),
      ...(datasheetLayoutExample ? { datasheet_layout_example: datasheetLayoutExample } : {}),
      ...(keepoutZones.length > 0 ? { keepout_zones: keepoutZones } : {}),
      members,
    };

    functionalClusters.push(clusterObj);
  }

  // Build inter_cluster_edges from all local nets (and global power rails connecting distinct power/load clusters)
  const interEdgeMap = new Map<
    string,
    { from: string; to: string; nets: Set<string>; signalClass: string; weight: number }
  >();

  for (const hm of hyperedgeMetas) {
    const clusterIds = Array.from(
      new Set(
        hm.componentIndices
          .map((idx) => compToClusterId.get(idx))
          .filter((id): id is string => Boolean(id))
      )
    );
    if (clusterIds.length < 2) continue;
    for (let i = 0; i < clusterIds.length; i++) {
      for (let j = i + 1; j < clusterIds.length; j++) {
        const cA = clusterIds[i] < clusterIds[j] ? clusterIds[i] : clusterIds[j];
        const cB = clusterIds[i] < clusterIds[j] ? clusterIds[j] : clusterIds[i];
        const key = `${cA}-->${cB}::${hm.signalClass}`;
        let entry = interEdgeMap.get(key);
        if (!entry) {
          entry = {
            from: cA,
            to: cB,
            nets: new Set(),
            signalClass: hm.signalClass,
            weight: 0,
          };
          interEdgeMap.set(key, entry);
        }
        entry.nets.add(hm.net.netName);
        entry.weight += hm.signalClass.startsWith("DIFF") ? 8.0 : 2.0;
      }
    }
  }

  // Add non-ground global power rails as inter-cluster power links
  for (const net of netlist.nets) {
    if (!globalNets.has(net.netName) || isGroundNetName(net.netName)) continue;
    const cIds = Array.from(
      new Set(
        net.endpoints
          .map((ep) => compIndexByDes.get(ep.designator))
          .filter((idx): idx is number => idx !== undefined)
          .map((idx) => compToClusterId.get(idx))
          .filter((id): id is string => Boolean(id))
      )
    );
    if (cIds.length < 2 || cIds.length > 6) continue; // connect primary supply trunk clusters
    for (let i = 1; i < cIds.length; i++) {
      const cA = cIds[0] < cIds[i] ? cIds[0] : cIds[i];
      const cB = cIds[0] < cIds[i] ? cIds[i] : cIds[0];
      const key = `${cA}-->${cB}::PWR_RAIL`;
      let entry = interEdgeMap.get(key);
      if (!entry) {
        entry = { from: cA, to: cB, nets: new Set(), signalClass: "PWR_MAIN_RAIL", weight: 0 };
        interEdgeMap.set(key, entry);
      }
      entry.nets.add(net.netName);
      entry.weight += 5.0;
    }
  }

  const interClusterEdges: FunctionalClusterOutput["inter_cluster_edges"] = Array.from(
    interEdgeMap.values()
  ).map((e) => ({
    from: e.from,
    to: e.to,
    nets: Array.from(e.nets),
    signal_class: e.signalClass,
    weight: Number(e.weight.toFixed(2)),
  }));

  const output: FunctionalClusterOutput = {
    schema_version: "1.0.0",
    board_outline: boardOutline,
    rigid_edge_anchors: Array.from(new Set(rigidEdgeAnchors)),
    functional_clusters: functionalClusters,
    inter_cluster_edges: interClusterEdges,
  };

  // Strict Ajv Draft 2020-12 Validation against schemas/functional-cluster.schema.json
  const validate = getFunctionalClusterValidator();
  if (!validate(output)) {
    throw new Error(
      `ERR_SCHEMA_VALIDATION_FAILED: FunctionalClusterOutput failed schemas/functional-cluster.schema.json: ${JSON.stringify(
        validate.errors
      )}`
    );
  }

  return {
    output,
    diagnostics: {
      strippedGlobalNets: Array.from(globalNets),
      prunedInterModuleBuses: hyperedgeMetas
        .filter((h) => h.isInterModuleBus)
        .map((h) => h.net.netName),
      reattachedOrphans,
      leidenModularityQ: leidenRes.modularityQ,
      leidenResolutionGamma: chosenGamma,
      schemaValidated: true,
    },
  };
}
