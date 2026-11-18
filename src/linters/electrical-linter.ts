import type {
  CesmModel,
  CompiledNetlist,
  ConstraintHandoffPackage,
  DatasheetLayoutExampleHandoff,
  DecouplingAndEsdAffinity,
  ElintAuditReport,
  ElintDiagnostic,
  ElintRuleId,
  EmiRoleTag,
  Keepout25DFiveTuple,
  PerNetRoutingRule,
} from "../types/index.js";
import {
  buildElectricalHypergraph,
  type CesmResolver,
  type ElectricalHypergraph,
  findAnodePin,
  findCathodePin,
  getPackageDefaultRThetaJA,
  getPackagePowerRatedW,
  getPackageWorkingMaxV,
  getPinSupplyVoltage,
  type HypergraphComponentNode,
  type HypergraphNetEdge,
  type HypergraphPinRef,
  isGroundNetName,
  parseCapacitancePf,
} from "./hypergraph-propagator.js";

export interface ElectricalLinterOptions {
  cesmResolver?: CesmResolver;
  strictness?: "production" | "prototype";
  ambientTempC?: number;
}

const DEFAULT_BUILT_IN_CESM: Record<string, CesmModel> = {
  C25905: {
    lcsc_id: "C25905",
    mpn: "0402WGF5101TCE",
    category: "RES_CHIP",
    package: "0402",
    verified: true,
    pins: [
      { pin_number: "1", pin_name: "1", elec_type: "PASSIVE" },
      { pin_number: "2", pin_name: "2", elec_type: "PASSIVE" },
    ],
    ratings: { v_working_max: 50, power_rated_w: 0.0625 },
  },
  C1525: {
    lcsc_id: "C1525",
    mpn: "CL05B104KO5NNNC",
    category: "CAP_MLCC",
    package: "0402",
    verified: true,
    pins: [
      { pin_number: "1", pin_name: "1", elec_type: "PASSIVE" },
      { pin_number: "2", pin_name: "2", elec_type: "PASSIVE" },
    ],
    ratings: { v_working_max: 16, dielectric: "X7R", dc_bias_retention_at_80pct_vr: 0.45 },
  },
  C7519: {
    lcsc_id: "C7519",
    mpn: "USBLC6-2SC6",
    category: "TVS_ESD_MOV",
    package: "SOT-23-6",
    verified: true,
    pins: [
      { pin_number: "1", pin_name: "IO1", elec_type: "PASSIVE" },
      { pin_number: "2", pin_name: "GND", elec_type: "GND" },
      { pin_number: "3", pin_name: "IO2", elec_type: "PASSIVE" },
      { pin_number: "4", pin_name: "IO2_OUT", elec_type: "PASSIVE" },
      { pin_number: "5", pin_name: "VBUS", elec_type: "POWER_IN" },
      { pin_number: "6", pin_name: "IO1_OUT", elec_type: "PASSIVE" },
    ],
    ratings: { v_rwm_v: 5.25, v_clamp_max_v: 5.4, c_junction_pf: 0.8 },
  },
  C47773: {
    lcsc_id: "C47773",
    mpn: "RT9013-33GB",
    category: "PMIC_LDO",
    package: "SOT-23-5",
    verified: true,
    pins: [
      { pin_number: "1", pin_name: "VIN", elec_type: "POWER_IN", v_abs_max: 6.0 },
      { pin_number: "2", pin_name: "GND", elec_type: "GND" },
      { pin_number: "3", pin_name: "EN", elec_type: "INPUT_HIZ", v_abs_max: 6.0 },
      { pin_number: "4", pin_name: "NC", elec_type: "NC" },
      { pin_number: "5", pin_name: "VOUT", elec_type: "POWER_OUT" },
    ],
    ratings: { v_working_max: 5.5, r_theta_ja_c_per_w: 200, tj_max_c: 125, mlcc_output_stable: true },
  },
  C6186: {
    lcsc_id: "C6186",
    mpn: "AMS1117-3.3",
    category: "PMIC_LDO",
    package: "SOT-223",
    verified: true,
    pins: [
      { pin_number: "1", pin_name: "GND", elec_type: "GND" },
      { pin_number: "2", pin_name: "VOUT", elec_type: "POWER_OUT" },
      { pin_number: "3", pin_name: "VIN", elec_type: "POWER_IN", v_abs_max: 15.0 },
      { pin_number: "4", pin_name: "TAB", elec_type: "POWER_OUT" },
    ],
    ratings: { v_working_max: 15.0, r_theta_ja_c_per_w: 65, tj_max_c: 125, mlcc_output_stable: false },
  },
};

export function createBuiltInCesmResolver(
  customEntries?: Record<string, CesmModel>
): CesmResolver {
  return (lcscId: string) => customEntries?.[lcscId] ?? DEFAULT_BUILT_IN_CESM[lcscId];
}

function addDiag(
  list: ElintDiagnostic[],
  diag: ElintDiagnostic
): void {
  list.push(diag);
}

function evaluateExprVoltage(expr: string | undefined, vdd: number, fallbackRatio: number): number {
  if (!expr) return vdd * fallbackRatio;
  const cleaned = expr.trim().toUpperCase();
  const multMatch = cleaned.match(/^(\d+(?:\.\d+)?)\s*\*\s*VDD$/);
  if (multMatch) return Number(multMatch[1]) * vdd;
  const fixed = Number(cleaned.replace(/V$/i, ""));
  if (Number.isFinite(fixed)) return fixed;
  return vdd * fallbackRatio;
}

function getEffectiveDriverLevels(
  compNode: HypergraphComponentNode,
  pin: HypergraphPinRef,
  nets: Map<string, HypergraphNetEdge>
): { vOhMin: number; vOhMax: number; vOlMax: number } | undefined {
  if (pin.elecType === "POWER_OUT") {
    const net = pin.netName ? nets.get(pin.netName) : undefined;
    if (net && net.voltage.confidence !== "UNKNOWN") {
      return { vOhMin: net.voltage.vMin, vOhMax: net.voltage.vMax, vOlMax: 0 };
    }
  }
  const supply = getPinSupplyVoltage(compNode, pin, nets);
  if (!supply || supply.confidence === "UNKNOWN") return undefined;
  return {
    vOhMin: Math.max(0, supply.vMin - Math.min(0.35, supply.vMin * 0.1)),
    vOhMax: supply.vMax,
    vOlMax: Math.min(0.4, supply.vMin * 0.1),
  };
}

function hasPathThroughSeriesResToRail(
  startNet: string,
  graph: ElectricalHypergraph,
  target: "POSITIVE_RAIL" | "GROUND" | "ANY_RAIL"
): { found: boolean; resistors: HypergraphComponentNode[]; railVoltage?: number; railNetName?: string } {
  const edge = graph.nets.get(startNet);
  if (!edge) return { found: false, resistors: [] };

  const attachedRes: HypergraphComponentNode[] = [];
  let targetRailNet: string | undefined;
  let railVoltage: number | undefined;

  for (const ep of edge.endpoints) {
    const compNode = graph.components.get(ep.designator);
    if (!compNode) continue;
    if (compNode.inferredCategory === "RES_CHIP" || compNode.inferredCategory === "RES_SHUNT") {
      const otherPin = compNode.pins.find((p) => p !== ep);
      if (!otherPin?.netName) continue;
      const otherNet = graph.nets.get(otherPin.netName);
      if (!otherNet) continue;

      const isPos = !otherNet.isGround && otherNet.voltage.confidence !== "UNKNOWN" && otherNet.voltage.vMin > 0.5;
      const isGnd = otherNet.isGround;
      const hasSupplyPin = otherNet.endpoints.some((o) => o.elecType === "POWER_OUT" || o.elecType === "POWER_IN");

      if (
        (target === "POSITIVE_RAIL" && (isPos || (hasSupplyPin && !isGnd))) ||
        (target === "GROUND" && isGnd) ||
        (target === "ANY_RAIL" && (isPos || isGnd || hasSupplyPin))
      ) {
        attachedRes.push(compNode);
        if (targetRailNet === undefined) {
          targetRailNet = otherNet.netName;
          railVoltage = otherNet.voltage.confidence !== "UNKNOWN" ? otherNet.voltage.vMax : 3.3;
        }
      }
    }
  }

  return {
    found: attachedRes.length > 0,
    resistors: attachedRes,
    railVoltage,
    railNetName: targetRailNet,
  };
}

function getCapacitorUf(node: HypergraphComponentNode): number | undefined {
  if (typeof node.component.extraProps?.capacitance_uf === "number") {
    return node.component.extraProps.capacitance_uf;
  }
  const pf = node.capacitancePf ?? parseCapacitancePf(`${node.component.value ?? ""} ${node.component.mpn ?? ""}`);
  if (pf !== undefined) return pf / 1e6;
  return undefined;
}

function getDcBiasRetentionFactor(node: HypergraphComponentNode, vRail: number): number {
  const dielectric = node.cesm?.ratings.dielectric ?? "X7R";
  if (dielectric === "C0G_NP0") return 1.0;
  const vRated = node.ratedVoltageV ?? 16;
  const explicitAt80 = node.cesm?.ratings.dc_bias_retention_at_80pct_vr;
  const ratio = Math.max(0, Math.min(1.2, vRail / Math.max(0.5, vRated)));

  if (explicitAt80 !== undefined) {
    if (ratio <= 0.1) return 1.0;
    const slope = (1.0 - explicitAt80) / 0.8;
    return Math.max(0.08, Math.min(1.0, 1.0 - slope * ratio));
  }

  const pkg = node.normalizedPackage;
  const pkgPenalty = pkg === "0402" ? 0.65 : pkg === "0603" ? 0.5 : pkg === "0805" ? 0.3 : 0.18;
  return Math.max(0.12, Math.min(1.0, 1.0 - pkgPenalty * Math.pow(ratio, 1.15)));
}

/**
 * Execute all 28 deterministic Electrical Linter rules (`ELINT-001` ~ `ELINT-028`)
 * strictly over the authoritative `CompiledNetlist`.
 */
export function runElectricalLinter(
  netlist: CompiledNetlist,
  options?: ElectricalLinterOptions
): ElintAuditReport {
  const resolver = options?.cesmResolver ?? createBuiltInCesmResolver();
  const strictness = options?.strictness ?? "production";
  const defaultAmbientC = options?.ambientTempC ?? 45.0;

  const graph = buildElectricalHypergraph(netlist, resolver);
  const diagnostics: ElintDiagnostic[] = [];

  checkElint001CesmAndPins(graph, strictness, diagnostics);
  checkElint002PowerPinIntegrity(graph, netlist, diagnostics);
  checkElint003PushPullAndPowerShort(graph, diagnostics);
  checkElint004OpenDrainPullup(graph, diagnostics);
  checkElint005I2cPullupWindow(graph, diagnostics);
  checkElint006FloatingControlPins(graph, diagnostics);
  checkElint007OvervoltageBreakdown(graph, diagnostics);
  checkElint008NoiseMarginThreshold(graph, diagnostics);
  checkElint009SerialDirection(graph, diagnostics);
  checkElint010LdoThermal(graph, defaultAmbientC, diagnostics);
  checkElint011LegacyLdoMlcc(graph, diagnostics);
  checkElint012IcDecouplingCount(graph, diagnostics);
  checkElint013ResistorPowerAndVoltage(graph, diagnostics);
  checkElint014MlccDeratingAndDielectric(graph, diagnostics);
  checkElint015MlccDcBiasDerating(graph, diagnostics);
  checkElint016TantalumDerating(graph, diagnostics);
  checkElint017PolarizedReverse(graph, diagnostics);
  checkElint018InductorAndBeadCurrent(graph, diagnostics);
  checkElint019TypeCUfp(graph, diagnostics);
  checkElint020TvsCapacitanceAndVoltage(graph, diagnostics);
  checkElint021AnalogSchottkyLeakage(graph, diagnostics);
  checkElint022MosfetDriveAndGateResistors(graph, diagnostics);
  checkElint023ReversePmosOrientationAndZener(graph, diagnostics);
  checkElint024InductiveFlybackDiode(graph, diagnostics);
  checkElint025IsolationBreach(graph, diagnostics);
  checkElint026IsolatorDefaultHighActuator(graph, diagnostics);
  checkElint027CrystalLoadCapMismatch(graph, diagnostics);
  checkElint028ShuntTapAndAdcSeriesDamping(graph, diagnostics);

  const blockerCount = diagnostics.filter((d) => d.severity === "BLOCKER").length;
  const warningCount = diagnostics.filter((d) => d.severity === "WARNING").length;
  const pass = blockerCount === 0;

  const constraintHandoffPackage = pass
    ? buildConstraintHandoffPackage(graph)
    : undefined;

  return {
    audit_timestamp: new Date().toISOString(),
    schDocument: graph.documentName,
    pass,
    gateStatus: pass ? "READY_FOR_PCB" : "BLOCKED_FOR_PCB",
    blockerCount,
    warningCount,
    diagnostics,
    ...(constraintHandoffPackage ? { constraintHandoffPackage } : {}),
  };
}

// ============================================================================
// ELINT-001 ~ ELINT-028 Rule Implementations
// ============================================================================

function checkElint001CesmAndPins(
  graph: ElectricalHypergraph,
  strictness: "production" | "prototype",
  out: ElintDiagnostic[]
): void {
  for (const node of graph.components.values()) {
    if (node.component.extraProps?.virtualMechanical === true) continue;
    const lcscId = node.component.lcscId;

    if (!lcscId) {
      if (strictness === "production") {
        addDiag(out, {
          rule_id: "ELINT-001",
          severity: "BLOCKER",
          category: "Model & Pin Truth",
          offending_objects: [node.designator],
          mathematical_evidence: `Component ${node.designator} (${node.component.mpn ?? "unknown"}) has no LCSC C-code bound.`,
          prescribed_fix: {
            action: "BIND_LCSC_AND_CESM",
            tool: "jlc_lib_device_inspect",
            steps: [
              `Search and inspect ${node.designator} via jlc_lib_device_inspect`,
              "Run jlc_datasheet_extract(bindCesmToSession=true) to lock verified CESM pinout.",
            ],
          },
        });
      }
      continue;
    }

    if (!node.cesm || !node.cesm.verified) {
      addDiag(out, {
        rule_id: "ELINT-001",
        severity: "BLOCKER",
        category: "Model & Pin Truth",
        offending_objects: [`${node.designator} (${lcscId})`],
        mathematical_evidence: node.cesm
          ? `CESM model for ${lcscId} has verified=false.`
          : `No CESM model registered for ${lcscId}.`,
        prescribed_fix: {
          action: "VERIFY_CESM",
          tool: "jlc_datasheet_extract",
          steps: [`Call jlc_lib_device_inspect and jlc_datasheet_extract for ${lcscId} to align symbol and datasheet pinout.`],
        },
      });
      continue;
    }

    const cesmPinNums = new Set(node.cesm.pins.map((p) => p.pin_number));
    const compPinNums = new Set(node.pins.map((p) => p.pinNumber));
    const missingInComp = node.cesm.pins.filter((p) => !compPinNums.has(p.pin_number)).map((p) => p.pin_number);
    const extraInComp = node.pins.filter((p) => !cesmPinNums.has(p.pinNumber)).map((p) => p.pinNumber);

    if (missingInComp.length > 0 || extraInComp.length > 0) {
      addDiag(out, {
        rule_id: "ELINT-001",
        severity: "BLOCKER",
        category: "Model & Pin Truth",
        offending_objects: [`${node.designator} (${lcscId})`],
        mathematical_evidence: `Pinout mismatch against verified CESM ${lcscId}: missing=${missingInComp.join(",") || "none"}, extra=${extraInComp.join(",") || "none"}.`,
        prescribed_fix: {
          action: "REALIGN_SYMBOL_PINS",
          tool: "jlc_lib_device_inspect",
          steps: [`Replace symbol on ${node.designator} using verified LCSC part ${lcscId}.`],
        },
      });
    }
  }
}

function checkElint002PowerPinIntegrity(
  graph: ElectricalHypergraph,
  netlist: CompiledNetlist,
  out: ElintDiagnostic[]
): void {
  const icCategories = new Set([
    "MCU_SOC",
    "PMIC_LDO",
    "PMIC_DCDC",
    "OPAMP_COMP",
    "ADC_DAC_VREF",
    "INTERFACE_XCVR",
    "ISOLATOR_OPTO",
    "OSC_ACTIVE",
  ]);

  for (const node of graph.components.values()) {
    const isIc = icCategories.has(node.inferredCategory) || node.pins.length >= 4;
    if (!isIc) continue;

    for (const pin of node.pins) {
      if (pin.elecType === "NC") continue;
      const isPwrOrGnd =
        pin.elecType === "POWER_IN" ||
        pin.elecType === "GND" ||
        /^(?:VDD[A-Z0-9_]*|VCC[A-Z0-9_]*|VSS[A-Z0-9_]*|GND[A-Z0-9_]*|EPAD|VSSA|VDDA|AVDD|DVDD|VBAT)$/i.test(
          pin.pinName
        );
      if (isPwrOrGnd && (!pin.isConnected || !pin.netName || pin.netName === "UNCONNECTED")) {
        addDiag(out, {
          rule_id: "ELINT-002",
          severity: "BLOCKER",
          category: "Power Pin Integrity",
          offending_objects: [`${node.designator}.${pin.pinNumber}(${pin.pinName})`],
          mathematical_evidence: `Power/Ground pin ${node.designator}.${pin.pinName} (Pin ${pin.pinNumber}, ${pin.elecType}) is unconnected.`,
          prescribed_fix: {
            action: "CONNECT_POWER_OR_GROUND_PIN",
            steps: [`Connect ${node.designator}.${pin.pinNumber}(${pin.pinName}) to its corresponding power rail or GND net.`],
          },
        });
      }
    }
  }

  for (const u of netlist.unconnectedPins ?? []) {
    const node = graph.components.get(u.designator);
    const pin = node?.pins.find((p) => p.pinNumber === u.pinNumber);
    if (pin && (pin.elecType === "POWER_IN" || pin.elecType === "GND")) {
      const already = out.some(
        (d) => d.rule_id === "ELINT-002" && d.offending_objects.includes(`${u.designator}.${u.pinNumber}(${u.pinName})`)
      );
      if (!already) {
        addDiag(out, {
          rule_id: "ELINT-002",
          severity: "BLOCKER",
          category: "Power Pin Integrity",
          offending_objects: [`${u.designator}.${u.pinNumber}(${u.pinName})`],
          mathematical_evidence: `Compiled netlist reports unconnected power/ground pin ${u.designator}.${u.pinName}.`,
          prescribed_fix: {
            action: "CONNECT_POWER_OR_GROUND_PIN",
            steps: [`Connect ${u.designator}.${u.pinNumber} to valid power/GND.`],
          },
        });
      }
    }
  }
}

function checkElint003PushPullAndPowerShort(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  for (const edge of graph.nets.values()) {
    const pushPulls = edge.endpoints.filter((e) => e.elecType === "PUSH_PULL");
    const powerOuts = edge.endpoints.filter(
      (e) => e.elecType === "POWER_OUT" && e.component.extraProps?.parallelOring !== true
    );

    if (pushPulls.length >= 2) {
      addDiag(out, {
        rule_id: "ELINT-003",
        severity: "BLOCKER",
        category: "Output Contention",
        offending_objects: [
          `Net:${edge.netName}`,
          ...pushPulls.map((p) => `${p.designator}.${p.pinNumber}(${p.pinName})`),
        ],
        mathematical_evidence: `${pushPulls.length} PUSH_PULL drivers shorted on net '${edge.netName}': ${pushPulls.map((p) => `${p.designator}.${p.pinName}`).join(", ")}.`,
        prescribed_fix: {
          action: "RESOLVE_OUTPUT_CONTENTION",
          steps: [
            `Separate conflicting PUSH_PULL pins on net '${edge.netName}', switch to OPEN_DRAIN with pull-up, or add multiplexer/series isolation.`,
          ],
        },
      });
    }

    if (powerOuts.length >= 2) {
      // Allow same-IC internal parallel output pins like AMS1117 Pin 2 & Pin 4 (TAB) both marked VOUT POWER_OUT
      const distinctIcs = new Set(powerOuts.map((p) => p.designator));
      if (distinctIcs.size >= 2) {
        addDiag(out, {
          rule_id: "ELINT-003",
          severity: "BLOCKER",
          category: "Power Output Short",
          offending_objects: [
            `Net:${edge.netName}`,
            ...powerOuts.map((p) => `${p.designator}.${p.pinNumber}(${p.pinName})`),
          ],
          mathematical_evidence: `${distinctIcs.size} distinct POWER_OUT regulators shorted together on net '${edge.netName}'.`,
          prescribed_fix: {
            action: "ISOLATE_POWER_OUTPUTS",
            steps: [`Split power rail '${edge.netName}' or isolate regulators via Schottky / ideal OR-ing diodes.`],
          },
        });
      }
    }

    if (pushPulls.length >= 1 && (edge.isGround || powerOuts.length >= 1 || edge.isPowerRail)) {
      addDiag(out, {
        rule_id: "ELINT-003",
        severity: "BLOCKER",
        category: "Driver Short to Rail",
        offending_objects: [
          `Net:${edge.netName}`,
          ...pushPulls.map((p) => `${p.designator}.${p.pinNumber}(${p.pinName})`),
        ],
        mathematical_evidence: `PUSH_PULL driver ${pushPulls[0].designator}.${pushPulls[0].pinName} is directly shorted to power/ground net '${edge.netName}'.`,
        prescribed_fix: {
          action: "DISCONNECT_DRIVER_FROM_RAIL",
          steps: [`Disconnect ${pushPulls[0].designator}.${pushPulls[0].pinName} from rail '${edge.netName}'.`],
        },
      });
    }
  }
}

function checkElint004OpenDrainPullup(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  for (const edge of graph.nets.values()) {
    const odPins = edge.endpoints.filter(
      (e) =>
        e.elecType === "OPEN_DRAIN" ||
        e.cesmPin?.mandatory_external === "PULLUP_RES"
    );
    if (odPins.length === 0) continue;

    // Check direct pullup resistor or through small series resistor (e.g. <= 100 ohm damping)
    const direct = hasPathThroughSeriesResToRail(edge.netName, graph, "POSITIVE_RAIL");
    let foundThroughSeries = direct.found;
    if (!foundThroughSeries) {
      for (const ep of edge.endpoints) {
        const comp = graph.components.get(ep.designator);
        if (comp?.inferredCategory === "RES_CHIP" && (comp.resistanceOhms ?? 999) <= 120) {
          const other = comp.pins.find((p) => p !== ep);
          if (other?.netName && hasPathThroughSeriesResToRail(other.netName, graph, "POSITIVE_RAIL").found) {
            foundThroughSeries = true;
            break;
          }
        }
      }
    }

    if (!foundThroughSeries) {
      addDiag(out, {
        rule_id: "ELINT-004",
        severity: "BLOCKER",
        category: "Open-Drain Missing Pull-Up",
        offending_objects: [
          `Net:${edge.netName}`,
          ...odPins.map((p) => `${p.designator}.${p.pinNumber}(${p.pinName})`),
        ],
        mathematical_evidence: `Open-drain net '${edge.netName}' (${odPins.map((p) => `${p.designator}.${p.pinName}`).join(", ")}) has no pull-up resistor to a positive supply rail.`,
        prescribed_fix: {
          action: "ADD_PULLUP_RESISTOR",
          tool: "jlc_elec_calc",
          parameters: { calculator: "i2c_pullup" },
          steps: [`Add a 2.2kΩ–4.7kΩ (or 10kΩ for PG/INT#) pull-up resistor from '${edge.netName}' to target VDD.`],
        },
      });
    }
  }
}

function checkElint005I2cPullupWindow(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  for (const edge of graph.nets.values()) {
    if (edge.signalClass !== "I2C") continue;
    const pullup = hasPathThroughSeriesResToRail(edge.netName, graph, "POSITIVE_RAIL");
    if (!pullup.found) continue; // Covered by ELINT-004

    const resistors = pullup.resistors.filter((r) => (r.resistanceOhms ?? 0) > 0);
    if (resistors.length === 0) continue;

    const invSum = resistors.reduce((acc, r) => acc + 1 / r.resistanceOhms!, 0);
    const rEq = 1 / invSum;
    const vdd = pullup.railVoltage ?? 3.3;

    const iolValues = edge.endpoints
      .map((e) => e.cesmPin?.iol_max_ma)
      .filter((v): v is number => typeof v === "number" && v > 0);
    const iolMa = iolValues.length > 0 ? Math.min(...iolValues) : 3.0;
    const rMin = (vdd - 0.4) / (iolMa / 1000);

    const busCapPf =
      edge.endpoints.find((e) => typeof e.component.extraProps?.c_bus_pf === "number")?.component.extraProps
        ?.c_bus_pf as number | undefined ??
      Math.max(40, edge.endpoints.length * 10 + 20);
    const speedKhz =
      (edge.endpoints.find((e) => typeof e.component.extraProps?.i2c_speed_khz === "number")?.component.extraProps
        ?.i2c_speed_khz as number | undefined) ?? 400;
    const trNs = speedKhz <= 100 ? 1000 : speedKhz <= 400 ? 300 : 120;
    const rMax = (trNs * 1e-9) / (0.8473 * (busCapPf * 1e-12));

    if (rEq < rMin || rEq > rMax) {
      addDiag(out, {
        rule_id: "ELINT-005",
        severity: "WARNING",
        category: "I2C Pull-Up Range",
        offending_objects: [
          `Net:${edge.netName}`,
          ...resistors.map((r) => `${r.designator}(${r.resistanceOhms}Ω)`),
        ],
        mathematical_evidence: `Equivalent I2C pull-up R_eq = ${rEq.toFixed(1)}Ω on '${edge.netName}' (VDD=${vdd.toFixed(2)}V, C_bus≈${busCapPf}pF, ${speedKhz}kHz) violates UM10204 window [${rMin.toFixed(0)}Ω, ${rMax.toFixed(0)}Ω].`,
        prescribed_fix: {
          action: "ADJUST_I2C_PULLUP",
          tool: "jlc_elec_calc",
          parameters: { calculator: "i2c_pullup", v_dd: vdd, c_bus_pf: busCapPf, mode_khz: speedKhz },
          steps: [`Adjust total parallel pull-up on '${edge.netName}' into [${Math.ceil(rMin)}Ω, ${Math.floor(rMax)}Ω].`],
        },
      });
    }
  }
}

function checkElint006FloatingControlPins(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  const ctrlNamePattern = /^(?:NRST|N?RESET#?|RST#?|BOOT\d*|EN|CE|SHDN#?|CS#?|NSS|OE#?|WP#?|HOLD#?)$/i;

  for (const node of graph.components.values()) {
    for (const pin of node.pins) {
      if (pin.elecType === "NC") continue;
      const isCtrl =
        (pin.elecType === "INPUT_HIZ" && ctrlNamePattern.test(pin.pinName)) ||
        pin.cesmPin?.mandatory_external === "PULLDOWN_or_PULLUP" ||
        (/^(?:NRST|BOOT\d*|SHDN#?|OE#?)$/i.test(pin.pinName) && pin.elecType === "INPUT_HIZ");

      if (!isCtrl) continue;

      if (!pin.isConnected || !pin.netName) {
        addDiag(out, {
          rule_id: "ELINT-006",
          severity: "BLOCKER",
          category: "Floating Control Pin",
          offending_objects: [`${node.designator}.${pin.pinNumber}(${pin.pinName})`],
          mathematical_evidence: `Critical INPUT_HIZ control pin ${node.designator}.${pin.pinName} is floating (unconnected).`,
          prescribed_fix: {
            action: "ADD_BIAS_RESISTOR",
            steps: [`Connect a 10kΩ pull-up/pull-down resistor (and 100nF capacitor to GND for NRST) to ${node.designator}.${pin.pinName}.`],
          },
        });
        continue;
      }

      const edge = graph.nets.get(pin.netName);
      if (!edge) continue;

      const hasDriverOrTie =
        edge.isGround ||
        edge.isPowerRail ||
        edge.endpoints.some(
          (e) =>
            e !== pin &&
            (e.elecType === "PUSH_PULL" ||
              e.elecType === "OPEN_DRAIN" ||
              e.elecType === "BIDIR_IO" ||
              e.elecType === "POWER_OUT" ||
              e.elecType === "ANALOG_OUT")
        );
      const hasBiasResistor = hasPathThroughSeriesResToRail(edge.netName, graph, "ANY_RAIL").found;

      if (!hasDriverOrTie && !hasBiasResistor) {
        addDiag(out, {
          rule_id: "ELINT-006",
          severity: "BLOCKER",
          category: "Floating Control Pin",
          offending_objects: [`${node.designator}.${pin.pinNumber}(${pin.pinName})`, `Net:${edge.netName}`],
          mathematical_evidence: `Critical control pin ${node.designator}.${pin.pinName} on net '${edge.netName}' has no active driver and no DC pull-up/pull-down bias path.`,
          prescribed_fix: {
            action: "ADD_BIAS_RESISTOR",
            steps: [`Add 10kΩ pull-up or pull-down resistor on '${edge.netName}'.`],
          },
        });
      }
    }
  }
}

function checkElint007OvervoltageBreakdown(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  for (const edge of graph.nets.values()) {
    if (edge.isGround || edge.voltage.confidence === "UNKNOWN") continue;

    // Max high voltage on this net (either from active drivers or direct rail potential)
    let vMaxApplied = edge.voltage.vMax;
    const driverLabels: string[] = [];

    for (const ep of edge.endpoints) {
      if (ep.elecType === "PUSH_PULL" || ep.elecType === "BIDIR_IO" || ep.elecType === "POWER_OUT") {
        const comp = graph.components.get(ep.designator);
        if (comp) {
          const lvl = getEffectiveDriverLevels(comp, ep, graph.nets);
          if (lvl) {
            vMaxApplied = Math.max(vMaxApplied, lvl.vOhMax);
            driverLabels.push(`${ep.designator}.${ep.pinName}(${lvl.vOhMax.toFixed(2)}V)`);
          }
        }
      }
    }

    for (const ep of edge.endpoints) {
      if (
        ep.elecType !== "INPUT_HIZ" &&
        ep.elecType !== "BIDIR_IO" &&
        ep.elecType !== "ANALOG_IN" &&
        ep.elecType !== "OPEN_DRAIN" &&
        !(ep.elecType === "POWER_IN" && ep.cesmPin?.v_abs_max !== undefined)
      ) {
        continue;
      }

      const comp = graph.components.get(ep.designator);
      if (!comp) continue;
      const supply = getPinSupplyVoltage(comp, ep, graph.nets);
      const vddRcv = supply && supply.confidence !== "UNKNOWN" ? supply.vMax : undefined;

      const pinModes = ep.component.extraProps?.pinModes as Record<string, string> | undefined;
      const isAnalogMode =
        ep.elecType === "ANALOG_IN" ||
        ep.compiledPin.elecType === "ANALOG_IN" ||
        pinModes?.[ep.pinNumber] === "ANALOG" ||
        ep.component.extraProps?.mode === "ANALOG";

      const isFt = Boolean(ep.cesmPin?.five_volt_tolerant);
      const ftLostInAnalog = ep.cesmPin?.ft_lost_in_analog_mode ?? true;

      let vAbsMax: number | undefined;
      if (isAnalogMode && isFt && ftLostInAnalog && vddRcv !== undefined) {
        // FT protection disappears when analog switch engages!
        vAbsMax = vddRcv + 0.3;
      } else if (ep.cesmPin?.v_abs_max !== undefined) {
        vAbsMax = ep.cesmPin.v_abs_max;
      } else if (isFt && (!isAnalogMode || !ftLostInAnalog)) {
        vAbsMax = 5.5;
      } else if (vddRcv !== undefined && ep.elecType !== "POWER_IN") {
        vAbsMax = vddRcv + 0.3;
      }

      if (vAbsMax !== undefined && vMaxApplied > vAbsMax + 0.05) {
        addDiag(out, {
          rule_id: "ELINT-007",
          severity: "BLOCKER",
          category: "Cross-Voltage Overvoltage",
          offending_objects: [
            `Net:${edge.netName}`,
            `${ep.designator}.${ep.pinNumber}(${ep.pinName})`,
            ...driverLabels,
          ],
          mathematical_evidence: `Applied peak voltage ${vMaxApplied.toFixed(2)}V on '${edge.netName}' exceeds receiver ${ep.designator}.${ep.pinName} v_abs_max = ${vAbsMax.toFixed(2)}V${
            isAnalogMode && isFt ? " (5V-tolerant FT lost in ANALOG mode)" : ""
          }.`,
          prescribed_fix: {
            action: "INSERT_LEVEL_SHIFTER_OR_DIVIDER",
            tool: "jlc_elec_calc",
            parameters: { calculator: "voltage_divider", v_in_max: vMaxApplied, v_target_or_vref: vAbsMax - 0.3 },
            steps: [
              `Insert level translator (SN74LVC1T45 / BSS138) or resistive voltage divider before ${ep.designator}.${ep.pinName}.`,
            ],
          },
        });
      }
    }
  }
}

function checkElint008NoiseMarginThreshold(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  for (const edge of graph.nets.values()) {
    if (edge.isGround || edge.isPowerRail) continue;

    // Note: if net has OPEN_DRAIN drivers with pull-up, high level comes from pull-up rail, not driver's VDD
    const pushPullDrivers = edge.endpoints.filter(
      (e) => e.elecType === "PUSH_PULL" || e.elecType === "BIDIR_IO"
    );
    if (pushPullDrivers.length === 0) continue;

    const receivers = edge.endpoints.filter(
      (e) => e.elecType === "INPUT_HIZ" || e.elecType === "BIDIR_IO"
    );
    if (receivers.length === 0) continue;

    for (const drv of pushPullDrivers) {
      const drvComp = graph.components.get(drv.designator);
      if (!drvComp) continue;
      const drvLvl = getEffectiveDriverLevels(drvComp, drv, graph.nets);
      if (!drvLvl) continue;

      for (const rcv of receivers) {
        if (rcv.designator === drv.designator && rcv.pinNumber === drv.pinNumber) continue;
        // Skip passive bidirectional peer if both are same voltage domain
        const rcvComp = graph.components.get(rcv.designator);
        if (!rcvComp) continue;
        const rcvSupply = getPinSupplyVoltage(rcvComp, rcv, graph.nets);
        if (!rcvSupply || rcvSupply.confidence === "UNKNOWN") continue;

        const vihMin = evaluateExprVoltage(rcv.cesmPin?.vih_min_expr, rcvSupply.vMax, 0.7);
        const vilMax = evaluateExprVoltage(rcv.cesmPin?.vil_max_expr, rcvSupply.vMin, 0.3);

        // Only check when receiver explicitly differs in voltage or explicitly specifies VIH/VIL
        const nmH = drvLvl.vOhMin - vihMin;
        const nmL = vilMax - drvLvl.vOlMax;
        const explicitThreshold = Boolean(rcv.cesmPin?.vih_min_expr || rcv.cesmPin?.vil_max_expr);
        const crossDomain = Math.abs(drvLvl.vOhMax - rcvSupply.vMax) > 0.35;

        if ((explicitThreshold || crossDomain) && (nmH < 0.25 || nmL < 0.25)) {
          addDiag(out, {
            rule_id: "ELINT-008",
            severity: "BLOCKER",
            category: "Noise Margin / Logic Threshold",
            offending_objects: [
              `Net:${edge.netName}`,
              `Driver:${drv.designator}.${drv.pinName}`,
              `Receiver:${rcv.designator}.${rcv.pinName}`,
            ],
            mathematical_evidence: `Insufficient noise margin on '${edge.netName}': driver V_OH(min)=${drvLvl.vOhMin.toFixed(2)}V vs receiver V_IH(min)=${vihMin.toFixed(2)}V (NM_H=${nmH.toFixed(2)}V < 0.25V), V_OL(max)=${drvLvl.vOlMax.toFixed(2)}V vs V_IL(max)=${vilMax.toFixed(2)}V (NM_L=${nmL.toFixed(2)}V).`,
            prescribed_fix: {
              action: "INSERT_TTL_BUFFER_OR_LEVEL_SHIFTER",
              recommended_lcsc_candidates: [
                { lcsc_id: "C7894", desc: "74HCT1G125 / SN74LVC1T45 level-up buffer" },
              ],
              steps: [`Insert 74HCT1G125 (TTL VIH_min=2.0V) or dual-supply SN74LVC1T45 between ${drv.designator} and ${rcv.designator}.`],
            },
          });
        }
      }
    }
  }
}

function checkElint009SerialDirection(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  const isSerialDataPin = (pinName: string): "DRV" | "RCV" | null => {
    const u = pinName.toUpperCase();
    if (/^(?:UART_?TX|USART_?TX|TXD\d*|TX\d*|MOSI|SDO|DOUT)$/i.test(u)) return "DRV";
    if (/^(?:UART_?RX|USART_?RX|RXD\d*|RX\d*|MISO|SDI|DIN)$/i.test(u)) return "RCV";
    return null;
  };

  for (const edge of graph.nets.values()) {
    if (edge.endpoints.length < 2) continue;
    if (edge.signalClass !== "UART" && edge.signalClass !== "SPI") {
      // Also catch nets where at least 2 pins explicitly carry UART/SPI TX/RX/MOSI/MISO names
      const serialNamed = edge.endpoints.filter((e) => isSerialDataPin(e.pinName) !== null);
      if (serialNamed.length < 2) continue;
    }

    // Ignore clock / CS / handshake-agnostic nets if no directional data pins exist
    const roles = edge.endpoints.map((e) => ({
      pin: e,
      dir:
        e.elecType === "PUSH_PULL"
          ? "DRV"
          : e.elecType === "INPUT_HIZ"
            ? "RCV"
            : isSerialDataPin(e.pinName),
    }));

    const hasDirectionalSerial = edge.endpoints.some((e) => isSerialDataPin(e.pinName) !== null);
    if (!hasDirectionalSerial) continue;

    const drivers = roles.filter((r) => r.dir === "DRV");
    const receivers = roles.filter((r) => r.dir === "RCV");
    const bidirs = edge.endpoints.filter((e) => e.elecType === "BIDIR_IO");

    if (bidirs.length > 0 && (drivers.length > 0 || receivers.length > 0)) {
      // BIDIR_IO can serve opposite role unless two explicit same-direction pin names collide
      const nameDirs = edge.endpoints.map((e) => isSerialDataPin(e.pinName)).filter(Boolean);
      const drvNames = nameDirs.filter((d) => d === "DRV").length;
      const rcvNames = nameDirs.filter((d) => d === "RCV").length;
      if (drvNames >= 2 && rcvNames === 0) {
        addDiag(out, makeElint009Diag(edge, "TX-TX / Output-Output same-direction miswiring"));
      } else if (rcvNames >= 2 && drvNames === 0) {
        addDiag(out, makeElint009Diag(edge, "RX-RX / Input-Input same-direction miswiring (0 drivers)"));
      }
      continue;
    }

    if (drivers.length === 0 || receivers.length === 0) {
      const reason =
        drivers.length === 0
          ? `0 drivers (${edge.endpoints.map((e) => `${e.designator}.${e.pinName}`).join(" <-> ")})`
          : `0 receivers (${edge.endpoints.map((e) => `${e.designator}.${e.pinName}`).join(" <-> ")})`;
      addDiag(out, makeElint009Diag(edge, reason));
    }
  }
}

function makeElint009Diag(edge: HypergraphNetEdge, reason: string): ElintDiagnostic {
  return {
    rule_id: "ELINT-009",
    severity: "BLOCKER",
    category: "Serial Bus Direction",
    offending_objects: [`Net:${edge.netName}`, ...edge.endpoints.map((e) => `${e.designator}.${e.pinName}`)],
    mathematical_evidence: `Serial bus '${edge.netName}' has same-direction wiring defect: ${reason}.`,
    prescribed_fix: {
      action: "CROSS_SERIAL_TX_RX",
      steps: [
        `Swap TX/RX (or MOSI->SDI / MISO<-SDO) on '${edge.netName}' so each serial link pairs one Output driver with Input receiver(s).`,
      ],
    },
  };
}

function checkElint010LdoThermal(
  graph: ElectricalHypergraph,
  defaultAmbientC: number,
  out: ElintDiagnostic[]
): void {
  for (const node of graph.components.values()) {
    if (node.inferredCategory !== "PMIC_LDO") continue;

    const vinPin = node.pins.find((p) => p.elecType === "POWER_IN" && p.netName && !isGroundNetName(p.netName));
    const voutPin = node.pins.find((p) => p.elecType === "POWER_OUT" && p.netName);
    if (!vinPin?.netName || !voutPin?.netName) continue;

    const vinNet = graph.nets.get(vinPin.netName);
    const voutNet = graph.nets.get(voutPin.netName);
    if (!vinNet || !voutNet || vinNet.voltage.confidence === "UNKNOWN" || voutNet.voltage.confidence === "UNKNOWN") {
      continue;
    }

    const vInMax = vinNet.voltage.vMax;
    const vOut = (voutNet.voltage.vMin + voutNet.voltage.vMax) / 2;
    const iLoad =
      typeof node.component.extraProps?.i_load_a === "number"
        ? node.component.extraProps.i_load_a
        : typeof node.component.extraProps?.i_out_a === "number"
          ? node.component.extraProps.i_out_a
          : voutNet.maxCurrentA ?? 0.1;

    const iq = typeof node.component.extraProps?.iq_a === "number" ? node.component.extraProps.iq_a : 0.002;
    const pd = Math.max(0, vInMax - vOut) * iLoad + vInMax * iq;
    const tAmbient =
      typeof node.component.extraProps?.t_ambient_c === "number"
        ? node.component.extraProps.t_ambient_c
        : defaultAmbientC;
    const rThetaJa = node.cesm?.ratings.r_theta_ja_c_per_w ?? getPackageDefaultRThetaJA(node.normalizedPackage);
    const tj = tAmbient + pd * rThetaJa;

    if (pd > 0.8 || tj > 110.0) {
      addDiag(out, {
        rule_id: "ELINT-010",
        severity: "BLOCKER",
        category: "Power Tree & Thermal Budget",
        offending_objects: [`${node.designator} (${node.component.mpn ?? node.normalizedPackage})`],
        mathematical_evidence: `V_in_max=${vInMax.toFixed(2)}V, V_out=${vOut.toFixed(2)}V, I_load=${iLoad.toFixed(3)}A -> P_D=${pd.toFixed(3)}W, T_J=${tAmbient.toFixed(1)}°C + ${pd.toFixed(3)}W * ${rThetaJa}°C/W = ${tj.toFixed(1)}°C (limits: P_D <= 0.8W, T_J <= 110°C).`,
        prescribed_fix: {
          action: "INSTANTIATE_REFERENCE_BLOCK",
          tool: "jlc_sch_block_instantiate",
          blockTemplateId: "BLK_DCDC_BUCK_SYNC",
          parameters: { v_in_max: vInMax, v_out: vOut, i_out_max: Math.max(0.5, iLoad * 1.5) },
          steps: [`Replace LDO ${node.designator} with synchronous DC-DC Buck converter (or cascade Buck -> LDO).`],
        },
      });
    }
  }
}

function checkElint011LegacyLdoMlcc(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  for (const node of graph.components.values()) {
    if (node.inferredCategory !== "PMIC_LDO") continue;
    const isLegacyNonMlcc =
      node.cesm?.ratings.mlcc_output_stable === false ||
      (/1117|LM317|LM78\d\d/i.test(`${node.component.mpn ?? ""} ${node.component.value ?? ""}`) &&
        node.cesm?.ratings.mlcc_output_stable !== true);
    if (!isLegacyNonMlcc) continue;

    const voutPin = node.pins.find((p) => p.elecType === "POWER_OUT" && p.netName);
    if (!voutPin?.netName) continue;
    const voutNet = graph.nets.get(voutPin.netName);
    if (!voutNet) continue;

    const outputCaps: Array<{ node: HypergraphComponentNode; hasSeriesEsrRes: boolean }> = [];
    for (const ep of voutNet.endpoints) {
      const cNode = graph.components.get(ep.designator);
      if (!cNode) continue;
      if (
        cNode.inferredCategory === "CAP_MLCC" ||
        cNode.inferredCategory === "CAP_AL_ELEC" ||
        cNode.inferredCategory === "CAP_TANTALUM"
      ) {
        // Check if series ESR resistor exists on the other pin
        const other = cNode.pins.find((p) => p !== ep);
        let hasEsr = false;
        if (other?.netName && !isGroundNetName(other.netName)) {
          const midNet = graph.nets.get(other.netName);
          if (midNet) {
            hasEsr = midNet.endpoints.some((mep) => {
              const r = graph.components.get(mep.designator);
              return r?.inferredCategory === "RES_CHIP" && (r.resistanceOhms ?? 0) >= 0.1 && (r.resistanceOhms ?? 0) <= 5.0;
            });
          }
        }
        outputCaps.push({ node: cNode, hasSeriesEsrRes: hasEsr });
      }
    }

    if (outputCaps.length === 0) continue;
    const hasStableCap = outputCaps.some(
      (c) =>
        c.node.inferredCategory === "CAP_TANTALUM" ||
        c.node.inferredCategory === "CAP_AL_ELEC" ||
        c.hasSeriesEsrRes
    );
    const allLowEsrMlcc = outputCaps.every(
      (c) =>
        c.node.inferredCategory === "CAP_MLCC" &&
        !c.hasSeriesEsrRes &&
        (c.node.cesm?.ratings.dielectric === "X5R" ||
          c.node.cesm?.ratings.dielectric === "X7R" ||
          c.node.cesm?.ratings.dielectric === undefined)
    );

    if (!hasStableCap && allLowEsrMlcc) {
      addDiag(out, {
        rule_id: "ELINT-011",
        severity: "BLOCKER",
        category: "LDO Stability / ESR Oscillation",
        offending_objects: [
          node.designator,
          ...outputCaps.map((c) => c.node.designator),
        ],
        mathematical_evidence: `Legacy LDO ${node.designator} (${node.component.mpn ?? "1117"}) has mlcc_output_stable=false but output '${voutNet.netName}' uses only ultra-low-ESR MLCC (${outputCaps.map((c) => c.node.designator).join(", ")}) with R_series=0Ω.`,
        prescribed_fix: {
          action: "REPLACE_LDO_OR_ADD_ESR",
          recommended_lcsc_candidates: [
            { lcsc_id: "C47773", desc: "RT9013-33GB (MLCC-stable CMOS LDO)" },
          ],
          steps: [`Replace ${node.designator} with MLCC-stable LDO (RT9013 / TLV755P) or insert 0.33Ω series ESR resistor / tantalum capacitor.`],
        },
      });
    }
  }
}

function checkElint012IcDecouplingCount(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  const icCats = new Set(["MCU_SOC", "ADC_DAC_VREF", "INTERFACE_XCVR", "OSC_ACTIVE", "OPAMP_COMP"]);

  // Group total positive POWER_IN pins per supply net
  const domainRequirements = new Map<string, { requiredCount: number; ics: string[] }>();

  for (const node of graph.components.values()) {
    if (!icCats.has(node.inferredCategory)) continue;
    const vddPins = node.pins.filter(
      (p) => p.elecType === "POWER_IN" && p.netName && !isGroundNetName(p.netName)
    );
    for (const vp of vddPins) {
      const net = vp.netName!;
      const entry = domainRequirements.get(net) ?? { requiredCount: 0, ics: [] };
      entry.requiredCount += 1;
      if (!entry.ics.includes(node.designator)) entry.ics.push(node.designator);
      domainRequirements.set(net, entry);
    }
  }

  for (const [netName, req] of domainRequirements.entries()) {
    const edge = graph.nets.get(netName);
    if (!edge) continue;

    let decap100nCount = 0;
    for (const ep of edge.endpoints) {
      const cNode = graph.components.get(ep.designator);
      if (!cNode || cNode.inferredCategory !== "CAP_MLCC") continue;
      const otherPin = cNode.pins.find((p) => p !== ep);
      if (!otherPin?.netName || !isGroundNetName(otherPin.netName)) continue;
      const capUf = getCapacitorUf(cNode);
      if (capUf === undefined || (capUf >= 0.01 && capUf <= 1.0)) {
        decap100nCount += 1;
      }
    }

    if (decap100nCount < req.requiredCount) {
      addDiag(out, {
        rule_id: "ELINT-012",
        severity: "WARNING",
        category: "IC Decoupling Coverage",
        offending_objects: [`Net:${netName}`, ...req.ics],
        mathematical_evidence: `Supply domain '${netName}' feeds ${req.requiredCount} IC VDD pin(s) (${req.ics.join(", ")}) but only has ${decap100nCount} decoupling MLCC (10nF–1uF).`,
        prescribed_fix: {
          action: "ADD_DECOUPLING_100NF",
          recommended_lcsc_candidates: [{ lcsc_id: "C1525", desc: "100nF 16V X7R 0402 MLCC" }],
          steps: [`Add ${req.requiredCount - decap100nCount}x 100nF MLCC decoupling capacitor(s) between '${netName}' and GND, placed <= 2.0mm from each VDD pin.`],
        },
      });
    }
  }
}

function checkElint013ResistorPowerAndVoltage(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  for (const node of graph.components.values()) {
    if (node.inferredCategory !== "RES_CHIP" && node.inferredCategory !== "RES_SHUNT") continue;
    if (node.pins.length < 2) continue;

    const p0 = node.pins[0];
    const p1 = node.pins[1];
    const n0 = p0.netName ? graph.nets.get(p0.netName) : undefined;
    const n1 = p1.netName ? graph.nets.get(p1.netName) : undefined;

    const vWorkingMax = node.cesm?.ratings.v_working_max ?? getPackageWorkingMaxV(node.normalizedPackage);
    const pRatedW = node.powerRatedW ?? getPackagePowerRatedW(node.normalizedPackage);

    let vAcrossMax =
      typeof node.component.extraProps?.v_across_max === "number"
        ? node.component.extraProps.v_across_max
        : undefined;

    if (vAcrossMax === undefined && n0 && n1 && n0.voltage.confidence !== "UNKNOWN" && n1.voltage.confidence !== "UNKNOWN") {
      const oppositePolarity =
        (n0.voltage.vMax > 0 && n1.voltage.vMin < 0) ||
        (n1.voltage.vMax > 0 && n0.voltage.vMin < 0);
      vAcrossMax = oppositePolarity
        ? Math.max(
            Math.abs(n0.voltage.vMax - n1.voltage.vMin),
            Math.abs(n1.voltage.vMax - n0.voltage.vMin)
          )
        : Math.max(
            Math.abs(n0.voltage.vMax - n1.voltage.vMax),
            Math.abs(n0.voltage.vMin - n1.voltage.vMin)
          );
    }

    let pActualW =
      typeof node.component.extraProps?.p_actual_w === "number"
        ? node.component.extraProps.p_actual_w
        : undefined;
    const iRms =
      typeof node.component.extraProps?.i_rms_a === "number"
        ? node.component.extraProps.i_rms_a
        : undefined;
    if (pActualW === undefined && iRms !== undefined && node.resistanceOhms !== undefined) {
      pActualW = iRms * iRms * node.resistanceOhms;
    } else if (
      pActualW === undefined &&
      vAcrossMax !== undefined &&
      node.resistanceOhms !== undefined &&
      node.resistanceOhms > 0 &&
      // Do not evaluate steady V^2/R power for an open-drain pull-up (only pulsed low)
      !(n0?.endpoints.some((e) => e.elecType === "OPEN_DRAIN") || n1?.endpoints.some((e) => e.elecType === "OPEN_DRAIN")) &&
      // Shunt resistors carry specified current rather than full rail voltage across them
      node.inferredCategory !== "RES_SHUNT"
    ) {
      pActualW = (vAcrossMax * vAcrossMax) / node.resistanceOhms;
    }

    const overVoltage = vAcrossMax !== undefined && vAcrossMax > vWorkingMax + 1e-3;
    const overPower = pActualW !== undefined && pActualW > 0.5 * pRatedW + 1e-6;

    if (overVoltage || overPower) {
      const reasons: string[] = [];
      if (overVoltage && vAcrossMax !== undefined) {
        reasons.push(`V_across_max=${vAcrossMax.toFixed(1)}V > V_working_max=${vWorkingMax}V (${node.normalizedPackage})`);
      }
      if (overPower && pActualW !== undefined) {
        reasons.push(`P_actual=${pActualW.toFixed(4)}W > 50% derated limit ${(0.5 * pRatedW).toFixed(4)}W`);
      }
      addDiag(out, {
        rule_id: "ELINT-013",
        severity: "BLOCKER",
        category: "Resistor Derating & Breakdown",
        offending_objects: [node.designator],
        mathematical_evidence: `Resistor ${node.designator} (${node.normalizedPackage}, ${node.component.value ?? ""}): ${reasons.join("; ")}.`,
        prescribed_fix: {
          action: overVoltage ? "SERIES_SPLIT_OR_UPGRADE_PACKAGE" : "UPGRADE_RESISTOR_POWER_PACKAGE",
          tool: "jlc_elec_calc",
          parameters: { calculator: "voltage_divider" },
          steps: [
            overVoltage
              ? `Split high-voltage drop across 2–4 series 1206 resistors (max 200V each) or upgrade package.`
              : `Upgrade ${node.designator} to a higher wattage package so P_actual <= 0.5 * P_rated.`,
          ],
        },
      });
    }
  }
}

function checkElint014MlccDeratingAndDielectric(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  for (const node of graph.components.values()) {
    if (node.inferredCategory !== "CAP_MLCC") continue;
    const dielectric =
      node.cesm?.ratings.dielectric ??
      (/Y5V|Z5U/i.test(`${node.component.value ?? ""} ${node.component.mpn ?? ""}`)
        ? "Y5V"
        : /C0G|NP0/i.test(`${node.component.value ?? ""} ${node.component.mpn ?? ""}`)
          ? "C0G_NP0"
          : "X7R");

    const vRated = node.ratedVoltageV;
    const pinNets = node.pins
      .map((p) => (p.netName ? graph.nets.get(p.netName) : undefined))
      .filter((n): n is HypergraphNetEdge => Boolean(n));

    let vNetMax = 0;
    if (pinNets.length === 2 && pinNets[0].voltage.confidence !== "UNKNOWN" && pinNets[1].voltage.confidence !== "UNKNOWN") {
      vNetMax = Math.max(
        Math.abs(pinNets[0].voltage.vMax - pinNets[1].voltage.vMin),
        Math.abs(pinNets[1].voltage.vMax - pinNets[0].voltage.vMin)
      );
    } else {
      for (const n of pinNets) {
        if (!n.isGround && n.voltage.confidence !== "UNKNOWN") {
          vNetMax = Math.max(vNetMax, Math.abs(n.voltage.vMax));
        }
      }
    }

    const isCriticalPrecisionNet = pinNets.some(
      (n) => n.signalClass === "XTAL" || n.signalClass === "RF" || /PLL/i.test(n.netName)
    );

    const isY5v = dielectric === "Y5V";
    const underRated = vRated !== undefined && vNetMax > 0 && vRated < 1.5 * vNetMax - 1e-6;
    const missingCog = isCriticalPrecisionNet && dielectric !== "C0G_NP0";

    if (isY5v || underRated || missingCog) {
      const reasons: string[] = [];
      if (isY5v) reasons.push(`banned dielectric Y5V/Z5U`);
      if (underRated && vRated !== undefined) {
        reasons.push(`V_rated=${vRated}V < 1.5 * V_net_max=${(1.5 * vNetMax).toFixed(2)}V (V_net_max=${vNetMax.toFixed(2)}V)`);
      }
      if (missingCog) reasons.push(`crystal/RF/PLL net uses ${dielectric} instead of mandatory C0G_NP0`);

      addDiag(out, {
        rule_id: "ELINT-014",
        severity: "BLOCKER",
        category: "MLCC Dielectric & Voltage Derating",
        offending_objects: [node.designator, ...pinNets.map((n) => `Net:${n.netName}`)],
        mathematical_evidence: `MLCC ${node.designator}: ${reasons.join("; ")}.`,
        prescribed_fix: {
          action: "REPLACE_MLCC",
          steps: [
            missingCog
              ? `Replace ${node.designator} with C0G/NP0 dielectric MLCC.`
              : `Replace ${node.designator} with X7R/X5R MLCC rated >= ${(1.5 * Math.max(vNetMax, 3.3)).toFixed(1)}V.`,
          ],
        },
      });
    }
  }
}

function checkElint015MlccDcBiasDerating(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  for (const edge of graph.nets.values()) {
    if (edge.isGround || edge.voltage.confidence === "UNKNOWN") continue;

    // Identify rails driven by a DC-DC converter or carrying explicit effective capacitance constraint
    const dcdcDriver = edge.endpoints.find((ep) => {
      const comp = graph.components.get(ep.designator);
      return comp?.inferredCategory === "PMIC_DCDC" && (ep.elecType === "POWER_OUT" || ep.elecType === "SW_NODE");
    });

    let cMinReqUf: number | undefined;
    for (const ep of edge.endpoints) {
      const extraReq = ep.component.extraProps?.c_effective_min_req_uf;
      if (typeof extraReq === "number" && extraReq > 0) {
        cMinReqUf = Math.max(cMinReqUf ?? 0, extraReq);
      }
      const constraints = graph.components.get(ep.designator)?.cesm?.typical_application_constraints ?? [];
      for (const c of constraints) {
        const m = c.match(/COUT_EFF\s*>=\s*(\d+(?:\.\d+)?)\s*uF/i);
        if (m) cMinReqUf = Math.max(cMinReqUf ?? 0, Number(m[1]));
      }
    }

    if (cMinReqUf === undefined && !dcdcDriver) continue;

    // Collect MLCCs on this rail to GND
    const mlccs: HypergraphComponentNode[] = [];
    for (const ep of edge.endpoints) {
      const cNode = graph.components.get(ep.designator);
      if (!cNode || cNode.inferredCategory !== "CAP_MLCC") continue;
      const other = cNode.pins.find((p) => p !== ep);
      if (other?.netName && isGroundNetName(other.netName)) {
        mlccs.push(cNode);
      }
    }
    if (mlccs.length === 0) continue;

    const vRail = (edge.voltage.vMin + edge.voltage.vMax) / 2;
    let totalNomUf = 0;
    let totalEffUf = 0;
    for (const cap of mlccs) {
      const nom = getCapacitorUf(cap) ?? 0;
      const factor = getDcBiasRetentionFactor(cap, vRail);
      totalNomUf += nom;
      totalEffUf += nom * factor;
    }

    // If no explicit c_effective_min_req_uf on DC-DC output, trigger if effective capacity drops below 40% of nominal bulk (> 4.7uF)
    const thresholdUf = cMinReqUf ?? (totalNomUf >= 4.7 ? totalNomUf * 0.45 : undefined);
    if (thresholdUf !== undefined && totalEffUf < thresholdUf - 1e-6) {
      addDiag(out, {
        rule_id: "ELINT-015",
        severity: "WARNING",
        category: "MLCC DC Bias Derating",
        offending_objects: [`Net:${edge.netName}`, ...mlccs.map((m) => m.designator)],
        mathematical_evidence: `At V_rail=${vRail.toFixed(2)}V on '${edge.netName}', nominal MLCC sum ${totalNomUf.toFixed(2)}uF drops under DC bias to effective ${totalEffUf.toFixed(2)}uF < required ${thresholdUf.toFixed(2)}uF.`,
        prescribed_fix: {
          action: "UPGRADE_CAP_PACKAGE_OR_ADD_PARALLEL",
          tool: "jlc_elec_calc",
          parameters: { calculator: "dcdc_inductor_cap" },
          steps: [`Upgrade small 0402 X5R caps on '${edge.netName}' to 0805/1206 >=25V X7R or add parallel capacitors.`],
        },
      });
    }
  }
}

function checkElint016TantalumDerating(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  for (const node of graph.components.values()) {
    if (node.inferredCategory !== "CAP_TANTALUM") continue;
    const dielectric = node.cesm?.ratings.dielectric ?? "MNO2_TANT";
    const vRated = node.ratedVoltageV;
    if (vRated === undefined) continue;

    const posNet = node.pins
      .map((p) => (p.netName ? graph.nets.get(p.netName) : undefined))
      .find((n) => n && !n.isGround && n.voltage.confidence !== "UNKNOWN");
    if (!posNet) continue;

    const vMax = posNet.voltage.vMax;
    const reqRatio = dielectric === "MNO2_TANT" ? (posNet.isSurgeInput ? 3.0 : 2.0) : 1.5;

    if (vRated < reqRatio * vMax - 1e-6) {
      addDiag(out, {
        rule_id: "ELINT-016",
        severity: "BLOCKER",
        category: "Capacitor Voltage Derating & Polarity",
        offending_objects: [`${node.designator} (${node.component.mpn ?? ""})`, `Net:${posNet.netName}`],
        mathematical_evidence: `Net '${posNet.netName}' has V_max=${vMax.toFixed(2)}V${posNet.isSurgeInput ? " (surge input)" : ""}. ${dielectric} tantalum ${node.designator} is rated ${vRated}V (ratio ${(vRated / vMax).toFixed(2)}x < mandatory ${reqRatio.toFixed(1)}x = ${(reqRatio * vMax).toFixed(1)}V).`,
        prescribed_fix: {
          action: "REPLACE_COMPONENT",
          recommended_lcsc_candidates: [
            { lcsc_id: "C96123", desc: "10uF / 35V X7R 1206 MLCC" },
            { lcsc_id: "C335812", desc: "22uF / 25V Solid Polymer Aluminum Capacitor" },
          ],
          steps: [`Replace ${node.designator} with >=${Math.ceil(reqRatio * vMax)}V MnO2 tantalum, Polymer tantalum, or X7R MLCC.`],
        },
      });
    }
  }
}

function checkElint017PolarizedReverse(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  for (const node of graph.components.values()) {
    const isPolarized =
      node.inferredCategory === "CAP_AL_ELEC" ||
      node.inferredCategory === "CAP_TANTALUM" ||
      node.inferredCategory === "DIODE_SCHOTTKY" ||
      node.inferredCategory === "LED" ||
      node.inferredCategory === "TVS_ESD_MOV" ||
      node.cesm?.polarity_spec?.is_polarized === true;
    if (!isPolarized) continue;
    if (node.component.extraProps?.bidirectional === true) continue;

    const aPin = findAnodePin(node);
    const kPin = findCathodePin(node);
    if (!aPin?.netName || !kPin?.netName) continue;

    const aNet = graph.nets.get(aPin.netName);
    const kNet = graph.nets.get(kPin.netName);
    if (!aNet || !kNet || aNet.voltage.confidence === "UNKNOWN" || kNet.voltage.confidence === "UNKNOWN") {
      continue;
    }

    if (node.inferredCategory === "CAP_AL_ELEC" || node.inferredCategory === "CAP_TANTALUM") {
      if (aNet.voltage.vMax < kNet.voltage.vMin - 0.1 || (aNet.isGround && kNet.voltage.vMax > 0.2)) {
        addDiag(out, {
          rule_id: "ELINT-017",
          severity: "BLOCKER",
          category: "Polarized Component Reverse Polarity",
          offending_objects: [node.designator, `Anode:${aNet.netName}`, `Cathode:${kNet.netName}`],
          mathematical_evidence: `Polarized capacitor ${node.designator} (${node.inferredCategory}) has Anode(+) at ${aNet.voltage.vMax.toFixed(2)}V ('${aNet.netName}') < Cathode(-) at ${kNet.voltage.vMin.toFixed(2)}V ('${kNet.netName}').`,
          prescribed_fix: {
            action: "FLIP_POLARITY",
            steps: [`Swap Anode/Cathode connections on ${node.designator} (remember: Tantalum bar = +, Al-Elec shaded = -).`],
          },
        });
      }
      continue;
    }

    if (node.inferredCategory === "LED") {
      if (aNet.voltage.vMax < kNet.voltage.vMin - 0.1 || (aNet.isGround && !kNet.isGround && kNet.voltage.vMax > 0.5)) {
        addDiag(out, {
          rule_id: "ELINT-017",
          severity: "BLOCKER",
          category: "Polarized Component Reverse Polarity",
          offending_objects: [node.designator, `Anode:${aNet.netName}`, `Cathode:${kNet.netName}`],
          mathematical_evidence: `LED ${node.designator} is reverse-wired between Anode('${aNet.netName}') and Cathode('${kNet.netName}').`,
          prescribed_fix: {
            action: "FLIP_POLARITY",
            steps: [`Flip LED ${node.designator} pins so Anode connects toward higher potential.`],
          },
        });
      }
      continue;
    }

    // Diodes / TVS: reverse-blocking or clamping (K at VCC/VBUS, A at GND/Drain) is valid!
    // Catch dead-short forward placement across supply-to-GND or reversed flyback across coil (A at +V rail, K at GND or switch drain)
    if (node.inferredCategory === "TVS_ESD_MOV" || node.inferredCategory === "DIODE_SCHOTTKY") {
      const isDeadShortAcrossRailToGnd = aNet.isPowerRail && aNet.voltage.vMin > 1.5 && kNet.isGround;
      const isFlybackRole =
        node.component.extraProps?.role === "FLYBACK" ||
        kNet.endpoints.some((e) => graph.components.get(e.designator)?.inferredCategory === "MOSFET_BJT") ||
        aNet.endpoints.some((e) => graph.components.get(e.designator)?.inferredCategory === "RELAY_BUZZER");
      const isReversedFlyback =
        isFlybackRole &&
        aNet.isPowerRail &&
        aNet.voltage.vMin > 1.5 &&
        !kNet.isPowerRail &&
        kNet.voltage.vMin < aNet.voltage.vMin;

      if (isDeadShortAcrossRailToGnd || isReversedFlyback) {
        addDiag(out, {
          rule_id: "ELINT-017",
          severity: "BLOCKER",
          category: "Diode / TVS Reverse Polarity Short",
          offending_objects: [node.designator, `Anode:${aNet.netName}`, `Cathode:${kNet.netName}`],
          mathematical_evidence: `${node.designator} has Anode on positive rail '${aNet.netName}' (${aNet.voltage.vMin.toFixed(2)}V) and Cathode on '${kNet.netName}' (${kNet.voltage.vMax.toFixed(2)}V), causing direct forward short.`,
          prescribed_fix: {
            action: "FLIP_DIODE_POLARITY",
            steps: [`Flip ${node.designator} so Cathode (bar) faces '${aNet.netName}' and Anode faces '${kNet.netName}'.`],
          },
        });
      }
    }
  }
}

function checkElint018InductorAndBeadCurrent(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  for (const node of graph.components.values()) {
    if (node.inferredCategory === "IND_POWER") {
      const iPeak =
        typeof node.component.extraProps?.i_peak_a === "number"
          ? node.component.extraProps.i_peak_a
          : typeof node.component.extraProps?.i_dc_a === "number"
            ? node.component.extraProps.i_dc_a * 1.2
            : undefined;
      const iRmsReq =
        typeof node.component.extraProps?.i_rms_req_a === "number"
          ? node.component.extraProps.i_rms_req_a
          : typeof node.component.extraProps?.i_dc_a === "number"
            ? node.component.extraProps.i_dc_a
            : undefined;
      const iSat = node.cesm?.ratings.i_sat_a ?? (node.component.extraProps?.i_sat_a as number | undefined);
      const iRmsRated = node.cesm?.ratings.i_rms_a ?? (node.component.extraProps?.i_rms_a as number | undefined);

      if (
        (iSat !== undefined && iPeak !== undefined && iSat < 1.3 * iPeak - 1e-6) ||
        (iRmsRated !== undefined && iRmsReq !== undefined && iRmsRated < iRmsReq - 1e-6)
      ) {
        addDiag(out, {
          rule_id: "ELINT-018",
          severity: "BLOCKER",
          category: "Inductor Current Derating",
          offending_objects: [node.designator],
          mathematical_evidence: `Inductor ${node.designator}: I_sat=${iSat ?? "N/A"}A vs 1.3*I_peak=${iPeak ? (1.3 * iPeak).toFixed(2) : "N/A"}A, I_rms=${iRmsRated ?? "N/A"}A vs I_req=${iRmsReq ?? "N/A"}A.`,
          prescribed_fix: {
            action: "UPGRADE_POWER_INDUCTOR",
            tool: "jlc_elec_calc",
            parameters: { calculator: "dcdc_inductor_cap" },
            steps: [`Select shielded inductor with I_sat >= 1.3 * I_peak and I_rms >= I_load_rms.`],
          },
        });
      }
    }

    if (node.inferredCategory === "FERRITE_CMC") {
      const iDc =
        typeof node.component.extraProps?.i_dc_a === "number"
          ? node.component.extraProps.i_dc_a
          : typeof node.component.extraProps?.i_load_max_a === "number"
            ? node.component.extraProps.i_load_max_a
            : undefined;
      const iRated = node.cesm?.ratings.i_rms_a ?? (node.component.extraProps?.i_rated_a as number | undefined);
      if (iRated !== undefined && iDc !== undefined && iRated < 1.5 * iDc - 1e-6) {
        addDiag(out, {
          rule_id: "ELINT-018",
          severity: "BLOCKER",
          category: "Ferrite Bead DC Saturation",
          offending_objects: [node.designator],
          mathematical_evidence: `Ferrite bead ${node.designator}: I_rated=${iRated}A < 1.5 * I_dc=${(1.5 * iDc).toFixed(2)}A (DC bias saturates core impedance).`,
          prescribed_fix: {
            action: "UPGRADE_FERRITE_BEAD",
            steps: [`Replace ${node.designator} with ferrite bead rated >= ${(1.5 * iDc).toFixed(2)}A.`],
          },
        });
      }
    }
  }
}

function checkElint019TypeCUfp(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  for (const node of graph.components.values()) {
    if (node.inferredCategory !== "CONN_USB_TYPEC") continue;
    if (node.component.extraProps?.usbRole === "DFP_HOST") continue;

    const cc1Pin = node.pins.find((p) => /^CC1$/i.test(p.pinName) || /^A5$/i.test(p.pinNumber));
    const cc2Pin = node.pins.find((p) => /^CC2$/i.test(p.pinName) || /^B5$/i.test(p.pinNumber));

    if (!cc1Pin?.netName || !cc2Pin?.netName) {
      addDiag(out, {
        rule_id: "ELINT-019",
        severity: "BLOCKER",
        category: "USB Type-C Configuration",
        offending_objects: [node.designator],
        mathematical_evidence: `Type-C UFP ${node.designator} is missing CC1 or CC2 connection.`,
        prescribed_fix: {
          action: "ADD_INDEPENDENT_5K1_CC_RESISTORS",
          blockTemplateId: "BLK_USB_TYPEC_UFP_5V",
          steps: [`Connect independent 5.1kΩ resistors from CC1 and CC2 to GND.`],
        },
      });
    } else if (cc1Pin.netName === cc2Pin.netName) {
      addDiag(out, {
        rule_id: "ELINT-019",
        severity: "BLOCKER",
        category: "USB Type-C Configuration",
        offending_objects: [node.designator, `Net:${cc1Pin.netName}`],
        mathematical_evidence: `Pin ${node.designator}.CC1 and CC2 are shorted on net '${cc1Pin.netName}' sharing a single resistor. E-Marker C-to-C cable Ra≈1kΩ drops Rd to 5.1kΩ || 1kΩ = 836Ω, violating USB-C Rd = 5.1kΩ ±20%.`,
        prescribed_fix: {
          action: "SPLIT_NET_AND_ADD_COMPONENT",
          recommended_lcsc_candidates: [{ lcsc_id: "C25905", desc: "5.1kΩ 1% 0402 resistor" }],
          steps: [
            `Split CC1 and CC2 onto separate nets and attach two independent 5.1kΩ resistors to GND.`,
          ],
        },
      });
    } else {
      for (const [label, netName] of [
        ["CC1", cc1Pin.netName],
        ["CC2", cc2Pin.netName],
      ] as const) {
        const gndPull = hasPathThroughSeriesResToRail(netName, graph, "GROUND");
        const has5k1 = gndPull.resistors.some(
          (r) => r.resistanceOhms !== undefined && r.resistanceOhms >= 4080 && r.resistanceOhms <= 6120
        );
        if (!has5k1) {
          addDiag(out, {
            rule_id: "ELINT-019",
            severity: "BLOCKER",
            category: "USB Type-C Configuration",
            offending_objects: [`${node.designator}.${label}`, `Net:${netName}`],
            mathematical_evidence: `Type-C pin ${node.designator}.${label} ('${netName}') lacks an independent 5.1kΩ (±20%) pull-down resistor to GND.`,
            prescribed_fix: {
              action: "ADD_5K1_CC_RESISTOR",
              recommended_lcsc_candidates: [{ lcsc_id: "C25905", desc: "5.1kΩ 1% 0402 resistor" }],
              steps: [`Place an independent 5.1kΩ resistor between '${netName}' and GND.`],
            },
          });
        }
      }
    }

    // Check A6/B6 (DP1/DP2) & A7/B7 (DN1/DN2) merge on 16P/24P Type-C receptacle
    const dp1 = node.pins.find((p) => /^A6$/i.test(p.pinNumber) || /^DP1$/i.test(p.pinName));
    const dp2 = node.pins.find((p) => /^B6$/i.test(p.pinNumber) || /^DP2$/i.test(p.pinName));
    const dn1 = node.pins.find((p) => /^A7$/i.test(p.pinNumber) || /^DN1$/i.test(p.pinName));
    const dn2 = node.pins.find((p) => /^B7$/i.test(p.pinNumber) || /^DN2$/i.test(p.pinName));

    if (dp1 && dp2 && (dp1.isConnected || dp2.isConnected) && dp1.netName !== dp2.netName) {
      addDiag(out, {
        rule_id: "ELINT-019",
        severity: "BLOCKER",
        category: "USB Type-C Reversible Data Merge",
        offending_objects: [`${node.designator}.A6`, `${node.designator}.B6`],
        mathematical_evidence: `Type-C D+ pins A6('${dp1.netName}') and B6('${dp2.netName}') are not shorted together for reversible plug orientation.`,
        prescribed_fix: {
          action: "MERGE_TYPEC_DP_DN",
          steps: [`Connect ${node.designator}.A6 and B6 to the same USB_DP net.`],
        },
      });
    }
    if (dn1 && dn2 && (dn1.isConnected || dn2.isConnected) && dn1.netName !== dn2.netName) {
      addDiag(out, {
        rule_id: "ELINT-019",
        severity: "BLOCKER",
        category: "USB Type-C Reversible Data Merge",
        offending_objects: [`${node.designator}.A7`, `${node.designator}.B7`],
        mathematical_evidence: `Type-C D- pins A7('${dn1.netName}') and B7('${dn2.netName}') are not shorted together for reversible plug orientation.`,
        prescribed_fix: {
          action: "MERGE_TYPEC_DP_DN",
          steps: [`Connect ${node.designator}.A7 and B7 to the same USB_DN net.`],
        },
      });
    }
  }
}

function checkElint020TvsCapacitanceAndVoltage(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  for (const node of graph.components.values()) {
    if (node.inferredCategory !== "TVS_ESD_MOV") continue;
    const vRwm = node.cesm?.ratings.v_rwm_v;
    const vClamp = node.cesm?.ratings.v_clamp_max_v;
    const cjPf = node.cesm?.ratings.c_junction_pf;

    for (const pin of node.pins) {
      if (!pin.netName || isGroundNetName(pin.netName)) continue;
      const edge = graph.nets.get(pin.netName);
      if (!edge) continue;

      const reasons: string[] = [];
      if (vRwm !== undefined && edge.voltage.confidence !== "UNKNOWN" && vRwm < edge.voltage.vMax - 1e-6) {
        reasons.push(`V_RWM=${vRwm}V < V_net_max=${edge.voltage.vMax.toFixed(2)}V`);
      }

      if (vClamp !== undefined) {
        const icVabsList = edge.endpoints
          .filter((ep) => ep.designator !== node.designator && ep.cesmPin?.v_abs_max !== undefined)
          .map((ep) => ep.cesmPin!.v_abs_max!);
        if (icVabsList.length > 0) {
          const minIcAbs = Math.min(...icVabsList);
          if (vClamp >= minIcAbs) {
            reasons.push(`V_clamp=${vClamp}V >= IC v_abs_max=${minIcAbs}V`);
          }
        }
      }

      if (cjPf !== undefined) {
        if (edge.signalClass === "DIFF_USB2" && cjPf >= 3.0) {
          reasons.push(`C_j=${cjPf}pF >= 3.0pF limit on USB 2.0 line '${edge.netName}'`);
        } else if (
          (edge.signalClass === "DIFF_USB3_HDMI" || edge.signalClass === "RF") &&
          cjPf >= 0.5
        ) {
          reasons.push(`C_j=${cjPf}pF >= 0.5pF limit on high-speed/RF line '${edge.netName}'`);
        }
      }

      if (reasons.length > 0) {
        addDiag(out, {
          rule_id: "ELINT-020",
          severity: "BLOCKER",
          category: "TVS / ESD Rating & Junction Capacitance",
          offending_objects: [node.designator, `Net:${edge.netName}`],
          mathematical_evidence: `TVS/ESD ${node.designator} on '${edge.netName}': ${reasons.join("; ")}.`,
          prescribed_fix: {
            action: "REPLACE_TVS_ESD",
            recommended_lcsc_candidates: [
              { lcsc_id: "C7519", desc: "USBLC6-2SC6 (0.8pF USB2 ESD array)" },
            ],
            steps: [`Select TVS with V_RWM > V_net_max, V_clamp < IC v_abs_max, and C_j < 3pF (USB2) or < 0.5pF (USB3/HDMI/RF).`],
          },
        });
        break;
      }
    }
  }
}

function checkElint021AnalogSchottkyLeakage(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  for (const edge of graph.nets.values()) {
    if (edge.isGround || edge.isPowerRail) continue;
    const hasAnalogInput = edge.endpoints.some((e) => e.elecType === "ANALOG_IN");
    if (!hasAnalogInput) continue;

    // Estimate Thevenin source impedance on this analog net
    const resList = edge.endpoints
      .map((e) => graph.components.get(e.designator))
      .filter((c): c is HypergraphComponentNode => Boolean(c && c.inferredCategory === "RES_CHIP" && c.resistanceOhms));
    const maxR = resList.reduce((m, r) => Math.max(m, r.resistanceOhms ?? 0), 0);
    const explicitZ = edge.endpoints.find((e) => typeof e.component.extraProps?.z_source_ohm === "number")
      ?.component.extraProps?.z_source_ohm as number | undefined;
    const zSource = explicitZ ?? maxR;

    if (zSource < 10_000) continue;

    const schottkyClamps = edge.endpoints.filter((ep) => {
      const comp = graph.components.get(ep.designator);
      if (!comp || comp.inferredCategory !== "DIODE_SCHOTTKY") return false;
      const text = `${comp.component.mpn ?? ""} ${comp.component.value ?? ""}`.toUpperCase();
      return comp.component.extraProps?.isSchottky !== false && (comp.inferredCategory === "DIODE_SCHOTTKY" || /BAT54|SS\d|SCHOTTKY|1N58/.test(text)) && !/BAV99|BAS416|1N4148/.test(text);
    });

    if (schottkyClamps.length > 0) {
      addDiag(out, {
        rule_id: "ELINT-021",
        severity: "WARNING",
        category: "High-Z Analog Schottky Leakage",
        offending_objects: [`Net:${edge.netName}`, ...schottkyClamps.map((s) => s.designator)],
        mathematical_evidence: `High-impedance analog net '${edge.netName}' (Z_source=${zSource}Ω >= 10kΩ) has Schottky clamp ${schottkyClamps[0].designator}, causing mA-level reverse leakage drift at high temperature.`,
        prescribed_fix: {
          action: "REPLACE_WITH_LOW_LEAKAGE_DIODE",
          steps: [`Replace Schottky diode ${schottkyClamps[0].designator} with pA/nA ultra-low-leakage silicon diode BAV99 or BAS416.`],
        },
      });
    }
  }
}

function isReverseProtectionPmos(node: HypergraphComponentNode, graph: ElectricalHypergraph): boolean {
  if (node.component.extraProps?.role === "REVERSE_PROTECTION") return true;
  const gPin = node.pins.find((p) => /^(?:G|GATE)$/i.test(p.pinName) || p.pinNumber === "1");
  if (!gPin?.netName) return false;
  const gNet = graph.nets.get(gPin.netName);
  if (!gNet) return false;

  // If Gate has NO active digital driver (PUSH_PULL/BIDIR_IO/PWM) and connects to GND via resistor or directly
  const hasActiveDriver = gNet.endpoints.some(
    (e) => e.designator !== node.designator && (e.elecType === "PUSH_PULL" || e.elecType === "BIDIR_IO")
  );
  const dPin = node.pins.find((p) => /^(?:D|DRAIN)$/i.test(p.pinName) || p.pinNumber === "3");
  const sPin = node.pins.find((p) => /^(?:S|SOURCE)$/i.test(p.pinName) || p.pinNumber === "2");
  const dNet = dPin?.netName ? graph.nets.get(dPin.netName) : undefined;
  const sNet = sPin?.netName ? graph.nets.get(sPin.netName) : undefined;
  const isPowerInline = Boolean(dNet && sNet && !dNet.isGround && !sNet.isGround && (dNet.isPowerRail || sNet.isPowerRail));

  return !hasActiveDriver && isPowerInline;
}

function checkElint022MosfetDriveAndGateResistors(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  for (const node of graph.components.values()) {
    if (node.inferredCategory !== "MOSFET_BJT") continue;
    if (node.component.extraProps?.isBjt === true) continue;
    if (isReverseProtectionPmos(node, graph)) continue;

    const gPin = node.pins.find((p) => /^(?:G|GATE)$/i.test(p.pinName) || p.pinNumber === "1");
    const sPin = node.pins.find((p) => /^(?:S|SOURCE)$/i.test(p.pinName) || p.pinNumber === "2");
    if (!gPin?.netName || !sPin?.netName) continue;

    const gNet = graph.nets.get(gPin.netName);
    if (!gNet) continue;

    // 1. Series Rg damping resistor check (1 ohm <= R <= 220 ohm directly attached to Gate pin)
    let seriesRg: HypergraphComponentNode | undefined;
    let preRgNet: HypergraphNetEdge | undefined;
    for (const ep of gNet.endpoints) {
      const comp = graph.components.get(ep.designator);
      if (comp?.inferredCategory === "RES_CHIP" && comp.resistanceOhms !== undefined && comp.resistanceOhms <= 220) {
        const other = comp.pins.find((p) => p !== ep);
        const otherNet = other?.netName ? graph.nets.get(other.netName) : undefined;
        if (otherNet && !otherNet.isGround) {
          seriesRg = comp;
          preRgNet = otherNet;
          break;
        }
      }
    }

    // 2. R_gs bleeder resistor check (4.7k .. 100k between G or pre-Rg net and S/GND)
    const checkNetsForBleeder = [gNet, ...(preRgNet ? [preRgNet] : [])];
    const hasRgsBleeder = checkNetsForBleeder.some((net) =>
      net.endpoints.some((ep) => {
        const comp = graph.components.get(ep.designator);
        if (!comp || comp.inferredCategory !== "RES_CHIP" || comp.resistanceOhms === undefined) return false;
        if (comp.resistanceOhms < 4700 || comp.resistanceOhms > 100_000) return false;
        const other = comp.pins.find((p) => p !== ep);
        return other?.netName === sPin.netName || isGroundNetName(other?.netName);
      })
    );

    // 3. Drive voltage check
    const driveNet = preRgNet ?? gNet;
    const vDrive = driveNet.voltage.confidence !== "UNKNOWN" ? driveNet.voltage.vMax : undefined;
    const vgsMin = node.cesm?.ratings.vgs_rated_for_rdson_min_v;
    const underDriven = vDrive !== undefined && vgsMin !== undefined && vDrive < vgsMin - 0.05;

    if (!seriesRg || !hasRgsBleeder || underDriven) {
      const issues: string[] = [];
      if (underDriven) issues.push(`V_drive=${vDrive!.toFixed(2)}V < vgs_rated_for_rdson_min_v=${vgsMin}V`);
      if (!seriesRg) issues.push(`missing series gate damping resistor R_g (2.2–100Ω)`);
      if (!hasRgsBleeder) issues.push(`missing G-S bleeder pull-down resistor R_gs (10k–47kΩ)`);

      addDiag(out, {
        rule_id: "ELINT-022",
        severity: "BLOCKER",
        category: "MOSFET Gate Drive",
        offending_objects: [node.designator, `GateNet:${gNet.netName}`],
        mathematical_evidence: `MOSFET ${node.designator}: ${issues.join("; ")}.`,
        prescribed_fix: {
          action: "FIX_MOSFET_GATE_DRIVE",
          tool: "jlc_elec_calc",
          parameters: { calculator: "mosfet_loss_gate" },
          steps: [
            `Ensure logic-level MOSFET or gate driver satisfies V_drive >= V_GS(rated), add series R_g (10–22Ω) and G-S bleeder R_gs (10k–47kΩ).`,
          ],
        },
      });
    }
  }
}

function checkElint023ReversePmosOrientationAndZener(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  for (const node of graph.components.values()) {
    if (node.inferredCategory !== "MOSFET_BJT") continue;
    if (!isReverseProtectionPmos(node, graph)) continue;

    const dPin = node.pins.find((p) => /^(?:D|DRAIN)$/i.test(p.pinName) || p.pinNumber === "3");
    const sPin = node.pins.find((p) => /^(?:S|SOURCE)$/i.test(p.pinName) || p.pinNumber === "2");
    const gPin = node.pins.find((p) => /^(?:G|GATE)$/i.test(p.pinName) || p.pinNumber === "1");
    if (!dPin?.netName || !sPin?.netName) continue;

    const dNet = graph.nets.get(dPin.netName);
    const sNet = graph.nets.get(sPin.netName);
    if (!dNet || !sNet) continue;

    // Source connected to external raw power input (D connected to internal system rail) is REVERSED!
    const isExternalRaw = (net: HypergraphNetEdge): boolean =>
      (!/(?:PROT|SYS|LOAD|OUT|REG)/i.test(net.netName) && net.isSurgeInput) ||
      /RAW|IN_EXT|VIN_IN|BATT?_IN|J\d/i.test(net.netName) ||
      net.endpoints.some((e) => {
        const c = graph.components.get(e.designator);
        return c?.inferredCategory === "CONN_GENERIC" || c?.inferredCategory === "CONN_USB_TYPEC";
      });
    const sIsRawInput = isExternalRaw(sNet);
    const dIsRawInput = isExternalRaw(dNet);

    if (sIsRawInput && !dIsRawInput) {
      addDiag(out, {
        rule_id: "ELINT-023",
        severity: "BLOCKER",
        category: "Reverse-Polarity PMOS Orientation",
        offending_objects: [node.designator, `Source:${sNet.netName}`, `Drain:${dNet.netName}`],
        mathematical_evidence: `High-side reverse-protection PMOS ${node.designator} has Source(S) on raw input '${sNet.netName}' and Drain(D) on system '${dNet.netName}' — body diode conducts in reverse polarity!`,
        prescribed_fix: {
          action: "SWAP_PMOS_DRAIN_SOURCE",
          blockTemplateId: "BLK_PWR_REVERSE_PMOS",
          steps: [`Connect PMOS Drain(D) to raw input '${sNet.netName}' and Source(S) to protected system side '${dNet.netName}'.`],
        },
      });
    }

    const vInMax = Math.max(dNet.voltage.vMax, sNet.voltage.vMax);
    if (vInMax > 12.0 && gPin?.netName) {
      const gNet = graph.nets.get(gPin.netName);
      const hasZener = gNet?.endpoints.some((ep) => {
        const comp = graph.components.get(ep.designator);
        if (!comp) return false;
        const isZener =
          comp.inferredCategory === "DIODE_SCHOTTKY" ||
          comp.inferredCategory === "TVS_ESD_MOV" ||
          /ZENER|BZT|MMSZ|1N47|ZD/i.test(`${comp.designator} ${comp.component.mpn ?? ""} ${comp.component.value ?? ""}`);
        if (!isZener) return false;
        return comp.pins.some((p) => p.netName === sPin.netName);
      });
      if (!hasZener) {
        addDiag(out, {
          rule_id: "ELINT-023",
          severity: "BLOCKER",
          category: "Reverse-Polarity PMOS Gate Clamp",
          offending_objects: [node.designator, `Gate:${gPin.netName}`],
          mathematical_evidence: `Reverse-protection PMOS ${node.designator} operates at V_in_max=${vInMax.toFixed(1)}V (>12V) without a 10–12V Zener diode protecting G-S oxide.`,
          prescribed_fix: {
            action: "ADD_ZENER_GS_CLAMP",
            blockTemplateId: "BLK_PWR_REVERSE_PMOS",
            steps: [`Add a 12V Zener diode (cathode to Source '${sPin.netName}', anode to Gate '${gPin.netName}') and 47kΩ Gate-to-GND resistor.`],
          },
        });
      }
    }
  }
}

function checkElint024InductiveFlybackDiode(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  for (const node of graph.components.values()) {
    if (node.inferredCategory !== "RELAY_BUZZER") continue;
    if (node.component.extraProps?.isPiezo === true) continue;

    // Extract the two coil pins (or 2 pins of magnetic buzzer)
    const coilPins =
      node.pins.length > 2
        ? node.pins.filter((p) => /COIL|A1|A2|\+|\-/i.test(p.pinName) || p.pinNumber === "1" || p.pinNumber === "2")
        : node.pins;
    if (coilPins.length < 2 || !coilPins[0].netName || !coilPins[1].netName) continue;

    const netA = coilPins[0].netName;
    const netB = coilPins[1].netName;
    const edgeA = graph.nets.get(netA);
    const edgeB = graph.nets.get(netB);
    if (!edgeA || !edgeB) continue;

    // 1. Check antiparallel flyback diode spanning netA and netB
    const hasAntiparallelDiode = edgeA.endpoints.some((ep) => {
      const comp = graph.components.get(ep.designator);
      if (!comp || (comp.inferredCategory !== "DIODE_SCHOTTKY" && comp.inferredCategory !== "TVS_ESD_MOV")) return false;
      const otherPin = comp.pins.find((p) => p !== ep);
      return otherPin?.netName === netB;
    });

    // 2. Or ULN2003/ULN2803 Darlington driver whose COM pin is tied to the coil supply rail
    const highSideNet =
      edgeA.voltage.vMax >= edgeB.voltage.vMax ? netA : netB;
    const lowSideEdge = highSideNet === netA ? edgeB : edgeA;
    let hasClampedDriverWithComTied = false;
    let ulnComFloating = false;

    for (const ep of lowSideEdge.endpoints) {
      const drv = graph.components.get(ep.designator);
      if (!drv) continue;
      if (/ULN2003|ULN2803|TBD62083/i.test(`${drv.component.mpn ?? ""} ${drv.component.value ?? ""}`) || drv.component.extraProps?.hasInternalFlybackCom === true) {
        const comPin = drv.pins.find((p) => /^COM$/i.test(p.pinName));
        if (comPin?.isConnected && comPin.netName === highSideNet) {
          hasClampedDriverWithComTied = true;
        } else {
          ulnComFloating = true;
        }
      }
    }

    if (!hasAntiparallelDiode && !hasClampedDriverWithComTied) {
      addDiag(out, {
        rule_id: "ELINT-024",
        severity: "BLOCKER",
        category: "Inductive Load Flyback Protection",
        offending_objects: [node.designator, `Coil:${netA}<->${netB}`],
        mathematical_evidence: ulnComFloating
          ? `Inductive coil ${node.designator} is driven by ULN2003/2803 whose COM pin is floating/not tied to '${highSideNet}', disabling internal flyback diodes.`
          : `Inductive coil ${node.designator} (${netA} <-> ${netB}) has no antiparallel flyback diode; turn-off spike (-L*di/dt > 150V) will destroy switch.`,
        prescribed_fix: {
          action: ulnComFloating ? "TIE_ULN_COM_TO_COIL_SUPPLY" : "ADD_FLYBACK_DIODE",
          blockTemplateId: "BLK_IND_RELAY_DRIVE",
          steps: [
            ulnComFloating
              ? `Connect ULN2003/ULN2803 COM pin directly to coil positive rail '${highSideNet}'.`
              : `Place antiparallel 1N4148/1N4007 flyback diode across '${netA}' and '${netB}' (Cathode to positive rail '${highSideNet}').`,
          ],
        },
      });
    }
  }
}

function checkElint025IsolationBreach(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  for (const iso of graph.isolators) {
    if (!iso.breached) continue;
    addDiag(out, {
      rule_id: "ELINT-025",
      severity: "BLOCKER",
      category: "Safety Isolation Barrier Breach",
      offending_objects: [iso.designator, ...iso.primaryNets, ...iso.secondaryNets],
      mathematical_evidence: `Safety isolation barrier ${iso.designator} (${iso.category}) breached: ${iso.breachReason}.`,
      prescribed_fix: {
        action: "SEPARATE_ISOLATED_DOMAINS",
        steps: [
          `Separate primary and secondary grounds/rails around ${iso.designator} into strictly isolated nets (e.g. GND_PRI vs GND_ISO, VCC vs VCC_ISO).`,
        ],
      },
    });
  }
}

function checkElint026IsolatorDefaultHighActuator(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  for (const node of graph.components.values()) {
    if (node.inferredCategory !== "ISOLATOR_OPTO") continue;
    if (node.cesm?.ratings.default_output_state !== "HIGH") continue;

    // Inspect secondary outputs to check if they drive an actuator/MOSFET/relay/heater
    const secOutputs = node.pins.filter(
      (p) => (p.elecType === "PUSH_PULL" || p.elecType === "OPEN_DRAIN" || /OUT/i.test(p.pinName)) && p.netName
    );
    let drivesActuator = false;
    for (const outPin of secOutputs) {
      const edge = graph.nets.get(outPin.netName!);
      if (!edge) continue;
      if (/(?:MOTOR|HEATER|RELAY|PWM_PWR|GATE|SOLENOID|ACTUATOR|COIL)/i.test(edge.netName)) {
        drivesActuator = true;
        break;
      }
      for (const ep of edge.endpoints) {
        if (ep.designator === node.designator) continue;
        const target = graph.components.get(ep.designator);
        if (target && (target.inferredCategory === "MOSFET_BJT" || target.inferredCategory === "RELAY_BUZZER")) {
          drivesActuator = true;
          break;
        }
        // Check 1-hop through gate resistor R_g
        if (target?.inferredCategory === "RES_CHIP") {
          const other = target.pins.find((p) => p !== ep);
          const nextEdge = other?.netName ? graph.nets.get(other.netName) : undefined;
          if (
            nextEdge?.endpoints.some((nep) => {
              const nt = graph.components.get(nep.designator);
              return nt?.inferredCategory === "MOSFET_BJT" || nt?.inferredCategory === "RELAY_BUZZER";
            })
          ) {
            drivesActuator = true;
            break;
          }
        }
      }
      if (drivesActuator) break;
    }

    if (drivesActuator) {
      addDiag(out, {
        rule_id: "ELINT-026",
        severity: "WARNING",
        category: "Fail-Safe Isolation Output State",
        offending_objects: [node.designator],
        mathematical_evidence: `Digital isolator ${node.designator} (${node.component.mpn ?? ""}) drives a power actuator/gate with default_output_state="HIGH" — primary power loss will force actuator ON.`,
        prescribed_fix: {
          action: "USE_FAIL_SAFE_LOW_ISOLATOR",
          steps: [`Replace ${node.designator} with fail-safe default-LOW suffix variant (e.g. ISO7741F / NSi8241L).`],
        },
      });
    }
  }
}

function checkElint027CrystalLoadCapMismatch(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  for (const node of graph.components.values()) {
    if (node.inferredCategory !== "XTAL_PASSIVE") continue;
    const clPf =
      typeof node.component.extraProps?.cl_pf === "number"
        ? node.component.extraProps.cl_pf
        : undefined;
    if (clPf === undefined) continue;

    const sigPins = node.pins.filter(
      (p) => p.netName && !isGroundNetName(p.netName) && p.elecType !== "GND"
    );
    if (sigPins.length < 2) continue;

    const capValuesPf: number[] = [];
    for (const sp of sigPins.slice(0, 2)) {
      const edge = graph.nets.get(sp.netName!);
      if (!edge) continue;
      for (const ep of edge.endpoints) {
        const cNode = graph.components.get(ep.designator);
        if (cNode?.inferredCategory === "CAP_MLCC") {
          const other = cNode.pins.find((p) => p !== ep);
          if (other?.netName && isGroundNetName(other.netName)) {
            const pf = cNode.capacitancePf ?? parseCapacitancePf(cNode.component.value);
            if (pf !== undefined) capValuesPf.push(pf);
          }
        }
      }
    }

    const cStray =
      typeof node.component.extraProps?.c_stray_pf === "number"
        ? node.component.extraProps.c_stray_pf
        : 4.0;

    if (capValuesPf.length < 2) {
      addDiag(out, {
        rule_id: "ELINT-027",
        severity: "WARNING",
        category: "Crystal Load Capacitance",
        offending_objects: [node.designator],
        mathematical_evidence: `Passive crystal ${node.designator} (C_L=${clPf}pF) is missing C0G load capacitors on one or both terminals.`,
        prescribed_fix: {
          action: "CALCULATE_CRYSTAL_LOAD_CAPS",
          tool: "jlc_elec_calc",
          parameters: { calculator: "crystal_load_cap", cl_pf: clPf, c_stray_pf: cStray },
          steps: [`Add C1=C2=${(2 * (clPf - cStray)).toFixed(1)}pF C0G/NP0 capacitors to GND.`],
        },
      });
      continue;
    }

    const c1 = capValuesPf[0];
    const c2 = capValuesPf[1];
    const cEff = (c1 * c2) / (c1 + c2) + cStray;
    if (Math.abs(cEff - clPf) > 2.5) {
      addDiag(out, {
        rule_id: "ELINT-027",
        severity: "WARNING",
        category: "Crystal Load Capacitance",
        offending_objects: [node.designator],
        mathematical_evidence: `C1=${c1}pF, C2=${c2}pF, C_stray=${cStray}pF -> C_eff=${cEff.toFixed(2)}pF deviates by ${Math.abs(cEff - clPf).toFixed(2)}pF (> 2.5pF) from crystal spec C_L=${clPf}pF.`,
        prescribed_fix: {
          action: "CALCULATE_CRYSTAL_LOAD_CAPS",
          tool: "jlc_elec_calc",
          parameters: { calculator: "crystal_load_cap", cl_pf: clPf, c_stray_pf: cStray },
          steps: [`Update C1/C2 to standard C0G value closest to ${Math.max(2, 2 * (clPf - cStray)).toFixed(1)}pF.`],
        },
      });
    }
  }
}

function checkElint028ShuntTapAndAdcSeriesDamping(graph: ElectricalHypergraph, out: ElintDiagnostic[]): void {
  // Part A: Current Shunt Sense Tap Isolation
  for (const node of graph.components.values()) {
    if (node.inferredCategory !== "RES_SHUNT") continue;

    // 4-pin Kelvin shunt: pins 3/4 must NOT be shorted to main current pins 1/2 in netlist
    const hasExplicitKelvinPins = node.pins.length >= 4;
    const p1Net = node.pins[0]?.netName;
    const p2Net = node.pins[1]?.netName;
    const p3Net = node.pins[2]?.netName;
    const p4Net = node.pins[3]?.netName;
    const fourPinShorted =
      hasExplicitKelvinPins &&
      Boolean((p3Net && (p3Net === p1Net || p3Net === p2Net)) || (p4Net && (p4Net === p1Net || p4Net === p2Net)));

    const flaggedTrunk =
      node.component.extraProps?.senseSharesPowerTrunk === true ||
      node.component.extraProps?.senseTapLocation === "OUTER_TRUNK";

    // Also detect if sense amplifier connects straight into a global high-fanout power/ground trunk (>=4 power pins)
    // instead of dedicated shunt pad tap when shunt has a non-ground sense net
    let senseReusesGlobalTrunk = false;
    for (const sp of node.pins) {
      if (!sp.netName) continue;
      const edge = graph.nets.get(sp.netName);
      if (!edge || edge.isGround) continue;
      const hasSenseAmp = edge.endpoints.some((e) => e.elecType === "ANALOG_IN");
      const heavyPowerCount = edge.endpoints.filter((e) => e.elecType === "POWER_IN" || e.elecType === "POWER_OUT").length;
      if (hasSenseAmp && heavyPowerCount >= 3) {
        senseReusesGlobalTrunk = true;
      }
    }

    if (fourPinShorted || flaggedTrunk || senseReusesGlobalTrunk) {
      addDiag(out, {
        rule_id: "ELINT-028",
        severity: "WARNING",
        category: "Shunt Inner-Pad Sense Tap",
        offending_objects: [node.designator],
        mathematical_evidence: `Current shunt ${node.designator} sense connection taps into main high-current power trunk rather than an independent inner-pad Kelvin/sense branch.`,
        prescribed_fix: {
          action: "SPLIT_SHUNT_INNER_PAD_SENSE",
          steps: [
            `Route sense trace(s) independently from the inner edge of ${node.designator} pad(s) (single-ended for low-side or twin parallel for high-side; no guard ring needed).`,
          ],
        },
      });
    }
  }

  // Part B: External Precision ADC SPI / Digital Series Damping Resistors (22~120 ohm)
  for (const node of graph.components.values()) {
    if (node.inferredCategory !== "ADC_DAC_VREF") continue;
    const idText = `${node.component.mpn ?? ""} ${node.component.value ?? ""}`.toUpperCase();
    // Skip pure voltage references (e.g. REF3030, ADR4550, TL431, LM4040)
    if (/\b(?:REF|ADR|LM4040|TL431|VREF)\b/.test(idText) && !/ADC|ADS|AD7|MCP3|LTC24|NAU78/i.test(idText)) {
      continue;
    }

    const spiDigitalPins = node.pins.filter((p) =>
      p.netName && /^(?:SCK|SCLK|MOSI|MISO|DIN|DOUT|DRDY|CS#?|SDI|SDO|SDA|SCL)$/i.test(p.pinName)
    );
    const unDampedPins: string[] = [];

    for (const dp of spiDigitalPins) {
      const edge = graph.nets.get(dp.netName!);
      if (!edge) continue;
      const directMcu = edge.endpoints.some((ep) => {
        if (ep.designator === node.designator) return false;
        const peer = graph.components.get(ep.designator);
        return peer?.inferredCategory === "MCU_SOC";
      });
      const hasSeriesResistor = edge.endpoints.some((ep) => {
        const comp = graph.components.get(ep.designator);
        return (
          comp?.inferredCategory === "RES_CHIP" &&
          comp.resistanceOhms !== undefined &&
          comp.resistanceOhms >= 22 &&
          comp.resistanceOhms <= 120
        );
      });

      if (directMcu && !hasSeriesResistor) {
        unDampedPins.push(`${node.designator}.${dp.pinName}`);
      }
    }

    if (unDampedPins.length > 0) {
      addDiag(out, {
        rule_id: "ELINT-028",
        severity: "WARNING",
        category: "Precision ADC Digital Edge Damping",
        offending_objects: [node.designator, ...unDampedPins],
        mathematical_evidence: `External precision ADC ${node.designator} digital pin(s) [${unDampedPins.join(", ")}] connect directly to MCU without 22–120Ω series damping resistors.`,
        prescribed_fix: {
          action: "ADD_ADC_SERIES_DAMPING",
          steps: [`Insert 33Ω–100Ω series damping resistors on ${unDampedPins.join(", ")} close to signal source.`],
        },
      });
    }
  }
}

// ============================================================================
// Constraint Handoff Package Builder (when blockerCount === 0)
// ============================================================================

function computeMinWidthFromIpc2221(currentA: number, vMax: number, isPower: boolean): number {
  if (currentA <= 0) return isPower ? 0.3 : 0.15;
  const k = 0.048; // Outer layer
  const dT = 10;
  const areaMil2 = Math.pow(currentA / (k * Math.pow(dT, 0.44)), 1 / 0.725);
  const thicknessMil = 1.378; // 1 oz = 35 um
  const wMm = (areaMil2 / thicknessMil) * 0.0254;
  const floor = isPower ? (vMax >= 100 ? 0.5 : 0.3) : 0.15;
  return Math.round(Math.max(floor, wMm) * 1000) / 1000;
}

function computeSafetyClearanceMm(vMax: number): number {
  if (vMax <= 15) return 0.15;
  if (vMax <= 30) return 0.25;
  if (vMax <= 60) return 0.5;
  if (vMax <= 150) return 1.0;
  if (vMax <= 350) return 3.0;
  return 5.0;
}

function buildConstraintHandoffPackage(graph: ElectricalHypergraph): ConstraintHandoffPackage {
  const perNetRoutingRules: PerNetRoutingRule[] = [];
  const emiRoleTags: EmiRoleTag[] = [];
  const datasheetLayoutExamples: DatasheetLayoutExampleHandoff[] = [];
  const decouplingPairs: DecouplingAndEsdAffinity["decouplingPairs"] = [];
  const esdInlineChains: DecouplingAndEsdAffinity["esdInlineChains"] = [];
  const keepoutZones25D: Keepout25DFiveTuple[] = [];

  for (const edge of graph.nets.values()) {
    const vMax = edge.voltage.confidence !== "UNKNOWN" ? edge.voltage.vMax : 5.0;
    const currentA = edge.maxCurrentA ?? (edge.isPowerRail ? 0.5 : 0.05);
    const minWidthMm = computeMinWidthFromIpc2221(currentA, vMax, edge.isPowerRail || edge.isGround);
    const preferredWidthMm = Math.round(Math.max(minWidthMm * 1.25, edge.isPowerRail ? 0.4 : 0.2) * 1000) / 1000;
    const minClearanceMm = computeSafetyClearanceMm(vMax);
    const minParallelVias = edge.isPowerRail ? Math.max(1, Math.ceil((currentA * 1.25) / 0.7)) : 1;

    const netClass =
      vMax > 150
        ? "PWR_HV_AC220"
        : edge.signalClass === "SW_NODE"
          ? "SW_NODE"
          : edge.signalClass === "DIFF_USB2" || edge.signalClass === "DIFF_USB3_HDMI"
            ? "DIFF_90"
            : edge.signalClass === "DIFF_ETH"
              ? "DIFF_100"
              : edge.signalClass === "DIFF_RS485_CAN"
                ? "DIFF_120"
                : edge.signalClass === "XTAL"
                  ? "XTAL_CRITICAL"
                  : edge.isPowerRail
                    ? "PWR_RAIL"
                    : "DIGITAL_STD";

    perNetRoutingRules.push({
      netName: edge.netName,
      netClass,
      voltageRangeV: {
        min: edge.voltage.vMin,
        max: edge.voltage.vMax,
        surge: edge.voltage.vSurge,
      },
      maxCurrentA: currentA,
      minWidthMm,
      preferredWidthMm,
      minClearanceMm,
      minParallelVias,
      ...(vMax > 150 ? { creepageDistanceMm: 6.4, requiresIsolationSlot: true } : {}),
      isolationDomain: edge.isolationDomain,
    });

    // EMI role tags
    if (edge.signalClass === "SW_NODE") {
      emiRoleTags.push({
        netName: edge.netName,
        role: "AGGRESSOR_SW_NODE",
        compactPolygonOnly: true,
        forbidBlindThermalVias: true,
      });
    } else if (edge.signalClass === "XTAL" || /FB|VSENSE|IN-/i.test(edge.netName)) {
      emiRoleTags.push({
        netName: edge.netName,
        role: "VICTIM_HIGH_Z",
      });
    } else if (/SENSE|SHUNT|ISENSE/i.test(edge.netName) || edge.endpoints.some((e) => graph.components.get(e.designator)?.inferredCategory === "RES_SHUNT")) {
      const hasGndReturn = edge.endpoints.some((e) => {
        const c = graph.components.get(e.designator);
        return c?.inferredCategory === "RES_SHUNT" && c.pins.some((p) => p.netName && isGroundNetName(p.netName));
      });
      emiRoleTags.push({
        netName: edge.netName,
        role: "SHUNT_KELVIN_SENSE",
        shuntTopology: hasGndReturn ? "LOW_SIDE_SINGLE_ENDED" : "HIGH_SIDE_KELVIN_PAIR",
        forbidRedundantGuardRing: true,
        forbidBlindThermalVias: true,
      });
    } else if (edge.signalClass === "DIFF_USB2") {
      emiRoleTags.push({
        netName: edge.netName,
        role: "IMPEDANCE_CTRL_DIFF",
        targetDiffImpedanceOhm: 90,
        intraPairSkewMaxMm: 1.25,
      });
    } else if (edge.signalClass === "DIFF_USB3_HDMI") {
      emiRoleTags.push({
        netName: edge.netName,
        role: "IMPEDANCE_CTRL_DIFF",
        targetDiffImpedanceOhm: 100,
        intraPairSkewMaxMm: 0.125,
      });
    } else if (edge.signalClass === "DIFF_ETH") {
      emiRoleTags.push({
        netName: edge.netName,
        role: "IMPEDANCE_CTRL_DIFF",
        targetDiffImpedanceOhm: 100,
        intraPairSkewMaxMm: 0.5,
      });
    } else if (edge.signalClass === "DIFF_RS485_CAN") {
      emiRoleTags.push({
        netName: edge.netName,
        role: "IMPEDANCE_CTRL_DIFF",
        targetDiffImpedanceOhm: 120,
        intraPairSkewMaxMm: 2.5,
      });
    } else if (edge.signalClass === "RF") {
      emiRoleTags.push({ netName: edge.netName, role: "RF_CONTROLLED" });
    } else if (edge.isPowerRail) {
      emiRoleTags.push({
        netName: edge.netName,
        role: "POWER_RAIL",
        forbidBlindThermalVias: true,
      });
    }
  }

  // Datasheet layout examples, 2.5D Keep-out hints & decoupling/ESD affinity
  for (const node of graph.components.values()) {
    if (node.cesm?.layoutExample && node.component.lcscId && /^C[0-9]+$/.test(node.component.lcscId)) {
      datasheetLayoutExamples.push({
        designator: node.designator,
        lcscId: node.component.lcscId,
        mpn: node.cesm.mpn,
        layoutGuidelines: node.cesm.layout_guidelines,
        layoutExample: node.cesm.layoutExample,
      });
    }

    const cx = node.component.posMm?.[0] ?? 0;
    const cy = node.component.posMm?.[1] ?? 0;
    const box = (hw: number, hh: number): Array<[number, number]> => [
      [cx - hw, cy - hh],
      [cx + hw, cy - hh],
      [cx + hw, cy + hh],
      [cx - hw, cy + hh],
    ];

    if (node.inferredCategory === "IND_POWER") {
      const ownNets = Array.from(new Set(node.pins.map((p) => p.netName).filter((n): n is string => Boolean(n))));
      keepoutZones25D.push({
        id: `KO_${node.designator}_IND`,
        category: "POWER_INDUCTOR",
        ownerDesignator: node.designator,
        polygon2D: box(2.5, 2.5),
        layerSet: ["MOUNT_LAYER"],
        disallowMask: ["COPPER_POUR", "TRACK"],
        allowedNets: ownNets,
        mountSide: "TOP",
      });
    } else if (node.inferredCategory === "XTAL_PASSIVE") {
      const ownNets = Array.from(new Set([...node.pins.map((p) => p.netName).filter((n): n is string => Boolean(n)), "GND"]));
      keepoutZones25D.push({
        id: `KO_${node.designator}_XTAL`,
        category: "PASSIVE_CRYSTAL",
        ownerDesignator: node.designator,
        polygon2D: box(2.0, 1.5),
        layerSet: ["MOUNT_LAYER"],
        disallowMask: ["TRACK", "COPPER_POUR"],
        allowedNets: ownNets,
        mountSide: "TOP",
      });
    }

    // Decoupling pairs for ICs
    if (node.inferredCategory === "MCU_SOC" || node.inferredCategory === "ADC_DAC_VREF" || node.inferredCategory === "INTERFACE_XCVR") {
      const vddPins = node.pins.filter((p) => p.elecType === "POWER_IN" && p.netName && !isGroundNetName(p.netName));
      const usedCaps = new Set<string>();
      for (const vp of vddPins) {
        const edge = graph.nets.get(vp.netName!);
        if (!edge) continue;
        const candidateCap = edge.endpoints
          .map((e) => graph.components.get(e.designator))
          .find((c) => {
            if (!c || c.inferredCategory !== "CAP_MLCC" || usedCaps.has(c.designator)) return false;
            const uf = getCapacitorUf(c);
            const other = c.pins.find((p) => p.netName !== vp.netName);
            return Boolean(other?.netName && isGroundNetName(other.netName)) && (uf === undefined || uf <= 1.0);
          });
        if (candidateCap) {
          usedCaps.add(candidateCap.designator);
          const gndPin = candidateCap.pins.find((p) => p.netName && isGroundNetName(p.netName));
          decouplingPairs.push({
            capacitorDesignator: candidateCap.designator,
            targetIcDesignator: node.designator,
            targetPinNumber: vp.pinNumber,
            targetPinName: vp.pinName,
            powerNet: vp.netName!,
            groundNet: gndPin?.netName ?? "GND",
            maxPathLengthMm: 2.0,
            enforcePowerViaToCapToPinOrder: true,
          });
        }
      }
    }

    // ESD inline chains
    if (node.inferredCategory === "TVS_ESD_MOV") {
      for (const pin of node.pins) {
        if (!pin.netName || isGroundNetName(pin.netName)) continue;
        const edge = graph.nets.get(pin.netName);
        if (!edge) continue;
        const connPin = edge.endpoints.find((ep) => {
          const c = graph.components.get(ep.designator);
          return c?.inferredCategory === "CONN_USB_TYPEC" || c?.inferredCategory === "CONN_GENERIC";
        });
        const icPin = edge.endpoints.find((ep) => {
          const c = graph.components.get(ep.designator);
          return c && c.designator !== node.designator && (c.inferredCategory === "MCU_SOC" || c.inferredCategory === "INTERFACE_XCVR");
        });
        if (connPin && icPin) {
          esdInlineChains.push({
            connectorDesignator: connPin.designator,
            connectorPin: connPin.pinNumber,
            esdDesignator: node.designator,
            esdPin: pin.pinNumber,
            targetIcDesignator: icPin.designator,
            targetIcPin: icPin.pinNumber,
            netName: edge.netName,
            maxStubMm: 1.5,
            minGroundVias: 2,
          });
        }
      }
    }
  }

  return {
    schemaVersion: "1.0.0",
    schDocument: graph.documentName,
    generatedAt: new Date().toISOString(),
    perNetRoutingRules,
    emiRoleTags,
    datasheetLayoutExamples,
    decouplingAndEsdAffinity: {
      decouplingPairs,
      esdInlineChains,
    },
    keepoutZones25D,
  };
}
