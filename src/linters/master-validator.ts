import type {
  CesmModel,
  CompiledNetlist,
  ElintAuditReport,
  MasterValidationReport,
  PcbLintReport,
} from "../types/index.js";
import { createBuiltInCesmResolver, runElectricalLinter } from "./electrical-linter.js";
import { type PcbBoardGeometrySnapshot, runGeometryPcbLinter } from "./geometry-pcb-linter.js";
import { AuthoritativeNetlistError, type CesmResolver } from "./hypergraph-propagator.js";

export interface BomVerificationEntry {
  designator: string;
  lcscId?: string | null;
  mpn?: string | null;
  footprint?: string | null;
  dnp?: boolean;
  virtualMechanical?: boolean;
}

export interface CplVerificationEntry {
  designator: string;
  layer: string;
  xMm: number;
  yMm: number;
  rotationDeg: number;
  originAnchorType?: "CENTER" | "PIN1" | "INVALID";
  polarityAngleDeg?: number;
  expectedPolarityAngleDeg?: number;
  isEdgeConnector?: boolean;
}

export interface MasterValidationInput {
  projectUuid?: string;
  schDocument: string;
  pcbDocument: string;
  schNetlist: CompiledNetlist;
  pcbNetlist: CompiledNetlist;
  pcbGeometry: PcbBoardGeometrySnapshot;
  cesmResolver?: CesmResolver;
  verifyManufacturability?: boolean;
  strictness?: "production" | "prototype";
  bomEntries?: BomVerificationEntry[];
  cplEntries?: CplVerificationEntry[];
}

export interface MasterValidationDetailedResult {
  report: MasterValidationReport;
  elintReport: ElintAuditReport;
  pcbReport: PcbLintReport;
}

function buildCanonicalNetEndpointMap(netlist: CompiledNetlist): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();

  for (const comp of netlist.components) {
    if (comp.extraProps?.virtualMechanical === true) continue;
    for (const pin of comp.pins) {
      if (!pin.isConnected || !pin.net) continue;
      const set = map.get(pin.net) ?? new Set<string>();
      set.add(`${comp.designator}.${pin.pinNumber}`);
      map.set(pin.net, set);
    }
  }

  for (const net of netlist.nets) {
    if (net.endpoints.length === 0) continue;
    const set = map.get(net.netName) ?? new Set<string>();
    for (const ep of net.endpoints) {
      set.add(`${ep.designator}.${ep.pinNumber}`);
    }
    map.set(net.netName, set);
  }

  return map;
}

function checkNetlistSync(
  schNetlist: CompiledNetlist,
  pcbNetlist: CompiledNetlist,
  blockers: MasterValidationReport["blockers"]
): boolean {
  if (schNetlist.netlistSource !== "eda.sch_Netlist") {
    throw new AuthoritativeNetlistError(
      `schNetlist.netlistSource must be "eda.sch_Netlist", got "${schNetlist.netlistSource}".`
    );
  }
  if (pcbNetlist.netlistSource !== "eda.pcb_Netlist") {
    throw new AuthoritativeNetlistError(
      `pcbNetlist.netlistSource must be "eda.pcb_Netlist", got "${pcbNetlist.netlistSource}".`
    );
  }

  const startCount = blockers.length;

  const schComps = new Map(
    schNetlist.components
      .filter((c) => c.extraProps?.virtualMechanical !== true)
      .map((c) => [c.designator, c])
  );
  const pcbComps = new Map(
    pcbNetlist.components
      .filter((c) => c.extraProps?.virtualMechanical !== true)
      .map((c) => [c.designator, c])
  );

  for (const [des, sc] of schComps.entries()) {
    const pc = pcbComps.get(des);
    if (!pc) {
      blockers.push({
        stage: "NETLIST_SYNC",
        code: "SYNC_MISSING_PCB_COMPONENT",
        message: `Schematic component ${des} (${sc.lcscId ?? sc.mpn ?? ""}) is missing on PCB netlist.`,
        prescription: "Run jlc_sch_sync_to_pcb to forward-annotate missing components to PCB.",
      });
      continue;
    }
    if (sc.lcscId && pc.lcscId && sc.lcscId !== pc.lcscId) {
      blockers.push({
        stage: "NETLIST_SYNC",
        code: "SYNC_COMPONENT_LCSC_MISMATCH",
        message: `Component ${des} LCSC mismatch: SCH='${sc.lcscId}' vs PCB='${pc.lcscId}'.`,
        prescription: "Synchronize PCB footprint/device metadata from schematic.",
      });
    }
  }

  for (const des of pcbComps.keys()) {
    if (!schComps.has(des)) {
      blockers.push({
        stage: "NETLIST_SYNC",
        code: "SYNC_EXTRA_PCB_COMPONENT",
        message: `PCB component ${des} does not exist in schematic netlist.`,
        prescription: "Remove orphan PCB component or back-annotate to schematic.",
      });
    }
  }

  const schNets = buildCanonicalNetEndpointMap(schNetlist);
  const pcbNets = buildCanonicalNetEndpointMap(pcbNetlist);

  const allNetNames = new Set([...schNets.keys(), ...pcbNets.keys()]);
  for (const netName of allNetNames) {
    const sSet = schNets.get(netName);
    const pSet = pcbNets.get(netName);
    if (!sSet && pSet) {
      blockers.push({
        stage: "NETLIST_SYNC",
        code: "SYNC_EXTRA_PCB_NET",
        message: `PCB net '${netName}' ([${Array.from(pSet).join(", ")}]) is absent in schematic netlist.`,
        prescription: "Re-sync PCB netlist with authoritative schematic netlist.",
      });
      continue;
    }
    if (sSet && !pSet) {
      // Ignore single-pin NC/dummy net unless multi-pin
      if (sSet.size >= 2) {
        blockers.push({
          stage: "NETLIST_SYNC",
          code: "SYNC_MISSING_PCB_NET",
          message: `Schematic net '${netName}' ([${Array.from(sSet).join(", ")}]) is missing in PCB netlist.`,
          prescription: "Run jlc_sch_sync_to_pcb to update PCB nets.",
        });
      }
      continue;
    }
    if (sSet && pSet) {
      const missingOnPcb = Array.from(sSet).filter((ep) => !pSet.has(ep));
      const extraOnPcb = Array.from(pSet).filter((ep) => !sSet.has(ep));
      if (missingOnPcb.length > 0 || extraOnPcb.length > 0) {
        blockers.push({
          stage: "NETLIST_SYNC",
          code: "SYNC_NET_ENDPOINT_MISMATCH",
          message: `Net '${netName}' connectivity mismatch: missing_on_pcb=[${missingOnPcb.join(", ")}], extra_on_pcb=[${extraOnPcb.join(", ")}].`,
          prescription: `Re-synchronize net '${netName}' between schematic and PCB.`,
        });
      }
    }
  }

  return blockers.length === startCount;
}

function checkDfmSmtReadiness(
  input: MasterValidationInput,
  cesmResolver: (lcscId: string) => CesmModel | undefined,
  blockers: MasterValidationReport["blockers"],
  warnings: MasterValidationReport["warnings"]
): boolean {
  const startCount = blockers.length;

  // 1. BOM LCSC C-number verification
  const bomList: BomVerificationEntry[] =
    input.bomEntries ??
    input.schNetlist.components.map((c) => ({
      designator: c.designator,
      lcscId: c.lcscId,
      mpn: c.mpn,
      footprint: c.footprint,
      dnp: c.extraProps?.dnp === true,
      virtualMechanical: c.extraProps?.virtualMechanical === true,
    }));

  for (const item of bomList) {
    if (item.dnp || item.virtualMechanical) continue;
    if (/^(?:H|MH|FID|TP)\d/i.test(item.designator)) continue;
    if (!item.lcscId || !/^C[0-9]+$/.test(item.lcscId)) {
      blockers.push({
        stage: "DFM_SMT",
        code: "DFM_BOM_MISSING_LCSC_ID",
        message: `BOM entry ${item.designator} (${item.mpn ?? item.footprint ?? "unknown"}) lacks a valid LCSC C-number ('${item.lcscId ?? ""}').`,
        prescription: `Bind a valid LCSC C-number via jlc_lib_search / jlc_lib_device_inspect for ${item.designator}.`,
      });
    }
  }

  // 2. CPL Coordinate Origin, Bounds & Polarity Angle Verification
  const { widthMm, heightMm } = input.pcbGeometry.boardOutline;
  const cplList: CplVerificationEntry[] =
    input.cplEntries ??
    input.pcbGeometry.components.map((c) => ({
      designator: c.designator,
      layer: c.layer,
      xMm: c.centerMm[0],
      yMm: c.centerMm[1],
      rotationDeg: c.rotationDeg,
      originAnchorType: c.originAnchorType,
      polarityAngleDeg: c.polarityAngleDeg,
      expectedPolarityAngleDeg: c.expectedPolarityAngleDeg,
      isEdgeConnector:
        c.category === "CONN_USB_TYPEC" ||
        c.category === "CONN_GENERIC" ||
        /^J\d|^USB/i.test(c.designator),
    }));

  for (const cpl of cplList) {
    if (/^(?:H|MH|FID|TP)\d/i.test(cpl.designator)) continue;

    if (!Number.isFinite(cpl.xMm) || !Number.isFinite(cpl.yMm)) {
      blockers.push({
        stage: "DFM_SMT",
        code: "DFM_CPL_INVALID_COORDS",
        message: `CPL entry ${cpl.designator} has non-finite coordinates (${cpl.xMm}, ${cpl.yMm}).`,
        prescription: `Re-compute valid placement origin for ${cpl.designator}.`,
      });
      continue;
    }

    if (cpl.originAnchorType === "INVALID") {
      blockers.push({
        stage: "DFM_SMT",
        code: "DFM_CPL_INVALID_ORIGIN",
        message: `CPL entry ${cpl.designator} has invalid/offset footprint origin anchor.`,
        locationMm: [cpl.xMm, cpl.yMm],
        prescription: `Re-center pick-and-place origin on component body center for ${cpl.designator}.`,
      });
    }

    const edgeTol = cpl.isEdgeConnector ? 3.5 : 0.0;
    if (
      cpl.xMm < -edgeTol ||
      cpl.xMm > widthMm + edgeTol ||
      cpl.yMm < -edgeTol ||
      cpl.yMm > heightMm + edgeTol
    ) {
      blockers.push({
        stage: "DFM_SMT",
        code: "DFM_CPL_OUT_OF_BOARD",
        message: `CPL entry ${cpl.designator} at (${cpl.xMm.toFixed(2)}, ${cpl.yMm.toFixed(2)}) falls outside board outline ${widthMm}x${heightMm}mm.`,
        locationMm: [cpl.xMm, cpl.yMm],
        prescription: `Move ${cpl.designator} inside board outline.`,
      });
    }

    // Polarity angle alignment verification
    const actualAngle = cpl.polarityAngleDeg ?? cpl.rotationDeg;
    if (cpl.expectedPolarityAngleDeg !== undefined) {
      const diff = Math.abs(((actualAngle - cpl.expectedPolarityAngleDeg + 540) % 360) - 180);
      if (diff > 5.0) {
        blockers.push({
          stage: "DFM_SMT",
          code: "DFM_CPL_POLARITY_ANGLE_MISMATCH",
          message: `CPL polarity/Pin-1 rotation for ${cpl.designator} is ${actualAngle}°, expected ${cpl.expectedPolarityAngleDeg}° (±5°).`,
          locationMm: [cpl.xMm, cpl.yMm],
          prescription: `Adjust CPL rotation offset or footprint orientation of ${cpl.designator} to align Pin-1/polarity with JLC SMT pick-and-place standard.`,
        });
      }
    }

    // Warn if polarized CESM component has no explicit polarity check metadata on CPL when non-standard rotation
    const schComp = input.schNetlist.components.find((c) => c.designator === cpl.designator);
    const cesm = schComp?.lcscId ? cesmResolver(schComp.lcscId) : undefined;
    if (cesm?.polarity_spec?.is_polarized && cpl.expectedPolarityAngleDeg === undefined && cpl.originAnchorType === undefined) {
      warnings.push({
        stage: "DFM_SMT",
        code: "DFM_CPL_POLARITY_VERIFY_PREVIEW",
        message: `Polarized part ${cpl.designator} (${cesm.mpn}) relies on default rotation ${cpl.rotationDeg}°; verify visual Pin-1/polarity preview before SMT submission.`,
      });
    }
  }

  return blockers.length === startCount;
}

/**
 * Execute the 4-in-1 Master Delivery Gate (`jlc_validate`) returning both the
 * `MasterValidationReport` and the underlying `ElintAuditReport` & `PcbLintReport`.
 */
export function runMasterValidationWithDetails(
  input: MasterValidationInput
): MasterValidationDetailedResult {
  const resolver = input.cesmResolver ?? createBuiltInCesmResolver();
  const blockers: MasterValidationReport["blockers"] = [];
  const warnings: MasterValidationReport["warnings"] = [];

  // 1. Authoritative SCH <-> PCB netlist 100% sync verification
  const netlistInSync = checkNetlistSync(input.schNetlist, input.pcbNetlist, blockers);

  // 2. 28-rule deterministic Electrical Linter
  const elintReport = runElectricalLinter(input.schNetlist, {
    cesmResolver: resolver,
    strictness: input.strictness ?? "production",
  });

  for (const diag of elintReport.diagnostics) {
    if (diag.severity === "BLOCKER") {
      blockers.push({
        stage: "ELECTRICAL_LINT",
        code: diag.rule_id,
        message: `[${diag.category}] ${diag.mathematical_evidence}`,
        prescription: diag.prescribed_fix.steps?.join(" ") ?? diag.prescribed_fix.action,
      });
    } else {
      warnings.push({
        stage: "ELECTRICAL_LINT",
        code: diag.rule_id,
        message: `[${diag.category}] ${diag.mathematical_evidence}`,
      });
    }
  }
  const electricalAuditPass = elintReport.pass;

  // 3. Native DRC + 18-rule 2.5D Geometry PCB Linter
  const pcbReport = runGeometryPcbLinter({
    ...input.pcbGeometry,
    netlist: input.pcbGeometry.netlist ?? input.pcbNetlist,
    constraintHandoff: input.pcbGeometry.constraintHandoff ?? elintReport.constraintHandoffPackage,
    cesmResolver: input.pcbGeometry.cesmResolver ?? resolver,
  });

  const unroutedNets = pcbReport.unroutedRatlineCount;
  if (unroutedNets > 0) {
    blockers.push({
      stage: "PCB_DRC",
      code: "UNROUTED_RATLINES",
      message: `PCB contains ${unroutedNets} unrouted ratline(s) — must be 0 before delivery.`,
      prescription: "Run jlc_pcb_autoroute to achieve 100% routing completion.",
    });
  }
  for (const drcErr of pcbReport.nativeDrcErrors) {
    blockers.push({
      stage: "PCB_DRC",
      code: drcErr.code ?? "NATIVE_DRC_ERROR",
      message: drcErr.message,
      locationMm: drcErr.locationMm,
      prescription: "Resolve native JLCEDA DRC violation.",
    });
  }
  for (const finding of pcbReport.customGeoLintFindings) {
    if (finding.severity === "BLOCKER") {
      blockers.push({
        stage: "PCB_GEOMETRY_LINT",
        code: finding.ruleId,
        message: `[${finding.category}] ${finding.measuredValue} (threshold: ${finding.threshold})`,
        locationMm: finding.locationMm,
        prescription: finding.prescription,
      });
    } else {
      warnings.push({
        stage: "PCB_GEOMETRY_LINT",
        code: finding.ruleId,
        message: `[${finding.category}] ${finding.measuredValue} (threshold: ${finding.threshold})`,
      });
    }
  }
  const pcbDrcPass = pcbReport.pass;

  // 4. JLC SMT Manufacturability (BOM LCSC C-code + CPL origin/polarity angle)
  const dfmSmtReady =
    input.verifyManufacturability === false
      ? true
      : checkDfmSmtReadiness(input, resolver, blockers, warnings);

  const pass =
    netlistInSync &&
    electricalAuditPass &&
    pcbDrcPass &&
    unroutedNets === 0 &&
    dfmSmtReady &&
    blockers.length === 0;

  const summaryScore = Math.max(
    0,
    Math.min(100, 100 - blockers.length * 15 - warnings.length * 3 - unroutedNets * 5)
  );

  return {
    report: {
      pass,
      summaryScore,
      netlistInSync,
      electricalAuditPass,
      pcbDrcPass,
      unroutedNets,
      dfmSmtReady,
      blockers,
      warnings,
    },
    elintReport,
    pcbReport,
  };
}

/**
 * Execute the 4-in-1 Master Delivery Gate (`jlc_validate`).
 */
export function runMasterValidation(input: MasterValidationInput): MasterValidationReport {
  return runMasterValidationWithDetails(input).report;
}
