import { Clipper, FillRule, Path64, Paths64, Point64 } from "clipper2-js";
import type {
  ConstraintHandoffPackage,
  Keepout25DCategory,
  Keepout25DFiveTuple,
  KeepoutDisallowKind,
  KeepoutMountSide,
  NetClassRule,
  ProjectDesignRules,
} from "../types/index.js";

const CLIPPER_SCALE = 10_000; // 0.1 um precision

export type FabCapability = "jlc_standard_multi" | "jlc_2layer_basic";

export type SpacingPackageCategory =
  | "0201"
  | "0402"
  | "0603"
  | "0805"
  | "1206_PLUS"
  | "SOT_SOP_QFP"
  | "QFN"
  | "BGA"
  | "THT"
  | "TALL_ELEC_CAP"
  | "CONNECTOR_FPC"
  | "MOUNTING_HOLE"
  | "RF_SHIELD"
  | "OTHER";

export type EmiAggressorRole =
  | "NONE"
  | "DCDC_SW_INDUCTOR"
  | "POWER_MOS_LDO_RES"
  | "RELAY_MOTOR_BUZZER"
  | "HIGH_SPEED_CLK_RF"
  | "BOARD_EDGE_HOLE_CONN";

export type EmiVictimRole =
  | "NONE"
  | "PASSIVE_XTAL"
  | "PRECISION_OPAMP_SHUNT"
  | "PRECISION_ADC_VREF"
  | "RF_ANTENNA_GNSS"
  | "TEMP_HUMIDITY_SENSOR"
  | "HALL_MAG_SENSOR"
  | "MEMS_IMU_MIC"
  | "AL_ELEC_CAP"
  | "BRITTLE_MLCC";

export interface SpacingComponentProfile {
  designator: string;
  footprint: string;
  packageCategory: SpacingPackageCategory;
  heightMm?: number;
  emiAggressorRole?: EmiAggressorRole;
  emiVictimRole?: EmiVictimRole;
  thermalPowerW?: number;
  maxVoltageV?: number;
  isolationDomain?: string;
  isPrimaryHighVoltage?: boolean;
  isSecondaryLowVoltage?: boolean;
  netNames?: string[];
  netClasses?: string[];
  mountSide?: "TOP" | "BOTTOM";
}

export interface FourDimensionalSpacingResult {
  dDfmEffMm: number;
  dSafetyEffMm: number;
  dEmiMm: number;
  dThermalStressMm: number;
  dMinMm: number;
  activeSource: ProjectDesignRules["source"];
  reasons: string[];
}

export interface SafetyClearanceSpec {
  innerLayerClearanceMm: number;
  outerSoldermaskClearanceMm: number;
  outerBarePadClearanceMm: number;
  creepageMm: number;
  requiresIsolationSlot: boolean;
  slotWidthMm: number;
}

export interface Keepout25DSourceSpec {
  id?: string;
  category: Keepout25DCategory;
  ownerDesignator: string;
  polygon2D: Array<[number, number]>;
  mountSide: "TOP" | "BOTTOM";
  layerCount: number;
  stackup?: string[];
  allowedNets?: string[];
  isUnshieldedHighVoltage?: boolean;
  isPrimaryToSecondaryIsolation?: boolean;
  disallowMaskOverride?: KeepoutDisallowKind[];
}

export interface CheckablePcbPrimitive {
  id?: string;
  kind: KeepoutDisallowKind;
  layer: string;
  net?: string | null;
  polygon2D: Array<[number, number]>;
}

export interface KeepoutViolationCheckResult {
  violated: boolean;
  shortCircuitedBy: "NONE" | "LAYER_SET" | "DISALLOW_MASK" | "ALLOWED_NET" | "ZERO_AREA";
  intersectionAreaMm2: number;
}

// ============================================================================
// 1. Project DRC Rule Normalization & Synthesis (Native DRC Priority)
// ============================================================================

export function buildBaselineProjectRules(
  fabCapability: FabCapability = "jlc_standard_multi",
  copperWeightOuterOz = 1.0
): ProjectDesignRules {
  const isTwoLayerBasic = fabCapability === "jlc_2layer_basic";
  const thickCopperFloor = copperWeightOuterOz >= 2.0 ? 0.2 : 0.15;
  const defaultClearance = Math.max(isTwoLayerBasic ? 0.15 : 0.15, thickCopperFloor);
  const defaultWidth = Math.max(isTwoLayerBasic ? 0.2 : 0.15, thickCopperFloor);

  return {
    source: "MCP_DEFAULT_BASELINE",
    defaultTraceWidthMm: defaultWidth,
    defaultClearanceMm: defaultClearance,
    padToPadClearanceMm: Math.max(0.15, thickCopperFloor),
    viaToTrackClearanceMm: Math.max(0.15, thickCopperFloor),
    pourClearanceMm: 0.25,
    componentClearanceMm: 0.25,
    boardOutlineClearanceMm: 0.4,
    minViaDrillMm: isTwoLayerBasic ? 0.3 : 0.25,
    minViaOuterDiaMm: isTwoLayerBasic ? 0.6 : 0.5,
    minSilkToPadClearanceMm: 0.15,
    copperWeightOuterOz,
    netClasses: {},
  };
}

/**
 * Normalize project DRC rules, strictly prioritizing user-configured native
 * JLCEDA project rules when present, and filling unspecified fields with baseline defaults.
 */
export function normalizeProjectDesignRules(
  input?: Partial<ProjectDesignRules>,
  fabCapability: FabCapability = "jlc_standard_multi"
): ProjectDesignRules {
  const copperOz = input?.copperWeightOuterOz ?? 1.0;
  const baseline = buildBaselineProjectRules(fabCapability, copperOz);
  if (!input) {
    return baseline;
  }

  const hasExplicitUserFields =
    input.source === "JLC_PROJECT_DRC_ONLY" ||
    input.source === "JLC_PROJECT_DRC_MERGED" ||
    input.defaultClearanceMm !== undefined ||
    input.componentClearanceMm !== undefined ||
    input.padToPadClearanceMm !== undefined ||
    input.pourClearanceMm !== undefined ||
    (input.netClasses !== undefined && Object.keys(input.netClasses).length > 0);

  const source: ProjectDesignRules["source"] =
    input.source ?? (hasExplicitUserFields ? "JLC_PROJECT_DRC_MERGED" : "MCP_DEFAULT_BASELINE");

  const mergedNetClasses: Record<string, NetClassRule> = {};
  if (input.netClasses) {
    for (const [key, rule] of Object.entries(input.netClasses)) {
      mergedNetClasses[key] = {
        ...rule,
        prioritySource: rule.prioritySource ?? "project_drc",
      };
    }
  }

  // Thick copper (2oz+) requires >= 0.20 mm minimum trace/clearance unless user explicitly overrode
  const thickFloor = copperOz >= 2.0 ? 0.2 : 0;

  return {
    source,
    defaultTraceWidthMm: Math.max(input.defaultTraceWidthMm ?? baseline.defaultTraceWidthMm, thickFloor),
    defaultClearanceMm: Math.max(input.defaultClearanceMm ?? baseline.defaultClearanceMm, thickFloor),
    padToPadClearanceMm: Math.max(input.padToPadClearanceMm ?? baseline.padToPadClearanceMm, thickFloor),
    viaToTrackClearanceMm: Math.max(input.viaToTrackClearanceMm ?? baseline.viaToTrackClearanceMm, thickFloor),
    pourClearanceMm: input.pourClearanceMm ?? baseline.pourClearanceMm,
    componentClearanceMm: input.componentClearanceMm ?? baseline.componentClearanceMm,
    boardOutlineClearanceMm: input.boardOutlineClearanceMm ?? baseline.boardOutlineClearanceMm,
    minViaDrillMm: input.minViaDrillMm ?? baseline.minViaDrillMm,
    minViaOuterDiaMm: input.minViaOuterDiaMm ?? baseline.minViaOuterDiaMm,
    minSilkToPadClearanceMm: input.minSilkToPadClearanceMm ?? baseline.minSilkToPadClearanceMm,
    copperWeightOuterOz: copperOz,
    netClasses: mergedNetClasses,
  };
}

// ============================================================================
// 2. IPC-2221 Current Width, Table 9-4 Vias & Table 9-1 Safety Clearances
// ============================================================================

export function calculateIpc2221TraceWidthMm(
  currentA: number,
  options?: {
    tempRiseC?: number;
    copperOz?: number;
    isInnerLayer?: boolean;
    roleFloor?: "signal" | "local_power" | "main_power";
  }
): number {
  const deltaT = options?.tempRiseC ?? 10;
  const copperOz = options?.copperOz ?? 1.0;
  const isInner = options?.isInnerLayer ?? false;
  const k = isInner ? 0.024 : 0.048;
  const thicknessMil = copperOz * 1.3779527559;

  const floorMap = {
    signal: copperOz >= 2.0 ? 0.2 : 0.15,
    local_power: 0.3,
    main_power: 0.5,
  };
  const minFloor = floorMap[options?.roleFloor ?? "signal"];

  if (currentA <= 0) {
    return minFloor;
  }

  const areaMil2 = Math.pow(currentA / (k * Math.pow(deltaT, 0.44)), 1 / 0.725);
  const widthMm = (areaMil2 / thicknessMil) * 0.0254;
  return Math.max(minFloor, Number(widthMm.toFixed(3)));
}

export function getMinParallelVias(currentA: number, drillMm = 0.3): number {
  if (currentA <= 0) return 1;
  // Table 9-4 conservative single-via capacity (A)
  let singleViaCapA = 0.7;
  if (drillMm <= 0.22) singleViaCapA = 0.45;
  else if (drillMm <= 0.32) singleViaCapA = 0.7;
  else if (drillMm <= 0.42) singleViaCapA = 1.0;
  else if (drillMm <= 0.55) singleViaCapA = 1.3;
  else singleViaCapA = 1.9;

  // Include 25% current crowding redundancy
  return Math.max(1, Math.ceil((currentA * 1.25) / singleViaCapA));
}

/**
 * Table 9-1 (IPC-2221B & IEC 62368-1) voltage-based safety clearance and creepage.
 * Honors project DRC NetClass rules when configured (and takes max with statutory HV redlines > 48V).
 */
export function getSafetyClearanceSpec(
  maxVoltageV: number,
  isPrimaryToSecondary = false,
  projectRules?: ProjectDesignRules,
  netClassName?: string
): SafetyClearanceSpec {
  const v = Math.abs(maxVoltageV);
  let spec: SafetyClearanceSpec;

  if (isPrimaryToSecondary && v >= 48) {
    spec = v > 350
      ? {
          innerLayerClearanceMm: 5.0,
          outerSoldermaskClearanceMm: 10.0,
          outerBarePadClearanceMm: 12.0,
          creepageMm: 14.0,
          requiresIsolationSlot: true,
          slotWidthMm: 2.0,
        }
      : {
          innerLayerClearanceMm: 5.0,
          outerSoldermaskClearanceMm: 5.0,
          outerBarePadClearanceMm: 6.4,
          creepageMm: 8.0,
          requiresIsolationSlot: true,
          slotWidthMm: 1.8,
        };
  } else if (v <= 15) {
    spec = {
      innerLayerClearanceMm: 0.1,
      outerSoldermaskClearanceMm: 0.15,
      outerBarePadClearanceMm: 0.2,
      creepageMm: 0.2,
      requiresIsolationSlot: false,
      slotWidthMm: 0,
    };
  } else if (v <= 30) {
    spec = {
      innerLayerClearanceMm: 0.1,
      outerSoldermaskClearanceMm: 0.25,
      outerBarePadClearanceMm: 0.4,
      creepageMm: 0.4,
      requiresIsolationSlot: false,
      slotWidthMm: 0,
    };
  } else if (v <= 60) {
    spec = {
      innerLayerClearanceMm: 0.15,
      outerSoldermaskClearanceMm: 0.5,
      outerBarePadClearanceMm: 0.8,
      creepageMm: 0.8,
      requiresIsolationSlot: false,
      slotWidthMm: 0,
    };
  } else if (v <= 150) {
    spec = {
      innerLayerClearanceMm: 0.25,
      outerSoldermaskClearanceMm: 0.8,
      outerBarePadClearanceMm: 1.5,
      creepageMm: 1.5,
      requiresIsolationSlot: false,
      slotWidthMm: 0,
    };
  } else if (v <= 350) {
    // 220V AC L-N (peak 311V) basic insulation
    spec = {
      innerLayerClearanceMm: 0.8,
      outerSoldermaskClearanceMm: 3.0,
      outerBarePadClearanceMm: 3.0,
      creepageMm: 3.0,
      requiresIsolationSlot: true,
      slotWidthMm: 1.2,
    };
  } else {
    // 380V AC / 500-1000V DC
    spec = {
      innerLayerClearanceMm: 2.0,
      outerSoldermaskClearanceMm: 5.0,
      outerBarePadClearanceMm: 8.0,
      creepageMm: 8.0,
      requiresIsolationSlot: true,
      slotWidthMm: 2.0,
    };
  }

  // Merge with native project DRC rules
  if (projectRules) {
    const ncRule = netClassName ? projectRules.netClasses[netClassName] : undefined;
    const projectBase = ncRule?.minClearanceMm ?? projectRules.defaultClearanceMm;
    if (projectRules.source !== "MCP_DEFAULT_BASELINE" && v <= 48 && ncRule?.prioritySource === "project_drc") {
      spec.outerSoldermaskClearanceMm = ncRule.minClearanceMm;
    } else if (v > 48) {
      // High-voltage statutory redline: take stricter of project DRC and Table 9-1
      spec.outerSoldermaskClearanceMm = Math.max(spec.outerSoldermaskClearanceMm, projectBase);
    } else {
      spec.outerSoldermaskClearanceMm = Math.max(spec.outerSoldermaskClearanceMm, projectBase);
    }
  }

  return spec;
}

export function synthesizeNetClasses(
  handoff: ConstraintHandoffPackage | undefined,
  projectRules: ProjectDesignRules
): Record<string, NetClassRule> {
  const out: Record<string, NetClassRule> = {};
  for (const [name, rule] of Object.entries(projectRules.netClasses)) {
    out[name] = { ...rule, nets: [...rule.nets] };
  }

  const upsertClass = (
    name: string,
    net: string,
    minWidthMm: number,
    preferredWidthMm: number,
    minClearanceMm: number,
    extras?: Partial<NetClassRule>
  ) => {
    const existing = out[name];
    if (existing) {
      if (!existing.nets.includes(net)) {
        existing.nets.push(net);
      }
      if (existing.prioritySource === "project_drc") {
        // Keep user's explicit width/clearance, only bump HV statutory safety if higher
        if (minClearanceMm > 0.45 && minClearanceMm > existing.minClearanceMm) {
          existing.minClearanceMm = minClearanceMm;
          existing.prioritySource = "merged";
        }
        return;
      }
      existing.minWidthMm = Math.max(existing.minWidthMm, minWidthMm);
      existing.preferredWidthMm = Math.max(existing.preferredWidthMm ?? minWidthMm, preferredWidthMm);
      existing.minClearanceMm = Math.max(existing.minClearanceMm, minClearanceMm);
      return;
    }

    out[name] = {
      name,
      nets: [net],
      minWidthMm,
      preferredWidthMm,
      minClearanceMm,
      viaDrillMm: projectRules.minViaDrillMm,
      viaDiameterMm: projectRules.minViaOuterDiaMm,
      ...extras,
      prioritySource: "computed_handoff",
    };
  };

  if (handoff) {
    for (const rule of handoff.perNetRoutingRules) {
      const vPeak = Math.max(Math.abs(rule.voltageRangeV?.max ?? 5), Math.abs(rule.voltageRangeV?.surge ?? 0));
      const safety = getSafetyClearanceSpec(vPeak, Boolean(rule.requiresIsolationSlot), projectRules, rule.netClass);
      const calcWidth = rule.maxCurrentA
        ? calculateIpc2221TraceWidthMm(rule.maxCurrentA, {
            copperOz: projectRules.copperWeightOuterOz,
            roleFloor: rule.maxCurrentA >= 1.5 ? "main_power" : "local_power",
          })
        : rule.minWidthMm;

      const className =
        rule.netClass ??
        (vPeak >= 150
          ? "PWR_HV_AC220"
          : (rule.maxCurrentA ?? 0) >= 2.5
            ? "PWR_HC_3A_5A"
            : (rule.maxCurrentA ?? 0) >= 0.5
              ? "PWR_RAIL"
              : "DIGITAL_STD");

      upsertClass(
        className,
        rule.netName,
        Math.max(rule.minWidthMm, calcWidth, projectRules.defaultTraceWidthMm),
        Math.max(rule.preferredWidthMm, calcWidth),
        Math.max(rule.minClearanceMm, safety.outerSoldermaskClearanceMm)
      );
    }

    for (const tag of handoff.emiRoleTags) {
      if (tag.role === "AGGRESSOR_SW_NODE") {
        upsertClass("SW_NODE", tag.netName, 0.4, 0.6, Math.max(0.25, projectRules.defaultClearanceMm));
      } else if (tag.role === "IMPEDANCE_CTRL_DIFF") {
        const z = tag.targetDiffImpedanceOhm ?? 90;
        const cls = z >= 115 ? "DIFF_120" : z >= 95 ? "DIFF_100" : "DIFF_90";
        const gap = z >= 115 ? 0.25 : 0.18;
        upsertClass(cls, tag.netName, 0.22, 0.25, Math.max(0.2, projectRules.defaultClearanceMm), {
          diffPairGapMm: gap,
          targetImpedanceOhm: z,
        });
      } else if (tag.role === "SHUNT_KELVIN_SENSE") {
        upsertClass("SHUNT_SENSE", tag.netName, 0.15, 0.2, projectRules.defaultClearanceMm);
      } else if (tag.role === "VICTIM_HIGH_Z") {
        upsertClass("XTAL_CRITICAL", tag.netName, 0.18, 0.2, Math.max(0.25, projectRules.defaultClearanceMm));
      }
    }
  }

  return out;
}

// ============================================================================
// 3. Four-Dimensional Spacing Matrix (Tables 8-1, 8-2, 8-3, 8-4, 9-1)
// ============================================================================

export function classifyPackageCategory(footprint: string, designator = ""): SpacingPackageCategory {
  const fp = footprint.toUpperCase();
  const des = designator.toUpperCase();
  if (/^H\d*$|^MH\d*$|^HOLE|M[234](?:_|\b)|MOUNT/i.test(fp) || /^MH\d+/i.test(des)) {
    return "MOUNTING_HOLE";
  }
  if (/SHIELD/i.test(fp)) return "RF_SHIELD";
  if (/USB|TYPE-?C|RJ45|HDMI|FPC|SD|TF|HEADER|TERM|JST|CONN|PINHDR|DC-?JACK|KEY|SWITCH|TACT/i.test(fp) || /^J\d+/i.test(des)) {
    return "CONNECTOR_FPC";
  }
  if (/BGA|FBGA|WLCSP/i.test(fp)) return "BGA";
  if (/QFN|DFN|SON|LGA/i.test(fp)) return "QFN";
  if (/LQFP|TQFP|QFP|SOP|SOIC|SSOP|TSSOP|MSOP|SOT/i.test(fp)) return "SOT_SOP_QFP";
  if (/ELEC|ALUM|CAP-?RAD|SMD-?6\.3|SMD-?8|SMD-?10/i.test(fp)) return "TALL_ELEC_CAP";
  if (/DIP|THT|HDR|RELAY|TO-?220|TO-?247|AXIAL|RADIAL/i.test(fp)) return "THT";
  if (/0201/.test(fp)) return "0201";
  if (/0402/.test(fp)) return "0402";
  if (/0603/.test(fp)) return "0603";
  if (/0805/.test(fp)) return "0805";
  if (/1206|1210|1812|2010|2512/.test(fp)) return "1206_PLUS";
  return "OTHER";
}

function getTable81DfmBaselineMm(a: SpacingComponentProfile, b: SpacingComponentProfile): number {
  const catA = a.packageCategory;
  const catB = b.packageCategory;
  const pair = [catA, catB].sort();

  const isSmallPassive = (c: SpacingPackageCategory) =>
    c === "0201" || c === "0402" || c === "0603" || c === "0805" || c === "1206_PLUS";
  const isIc = (c: SpacingPackageCategory) =>
    c === "SOT_SOP_QFP" || c === "QFN" || c === "BGA";

  if (catA === "CONNECTOR_FPC" || catB === "CONNECTOR_FPC") return 3.5;
  if ((catA === "THT" && !isIc(catB) && catB !== "THT") || (catB === "THT" && !isIc(catA) && catA !== "THT")) {
    return 3.0;
  }
  if (catA === "THT" || catB === "THT") return 3.0;

  if ((a.heightMm ?? 1) > 5 || (b.heightMm ?? 1) > 5) {
    if ((a.heightMm ?? 1) <= 2 || (b.heightMm ?? 1) <= 2) {
      return 1.5; // Thermal shadow avoidance
    }
  }
  if (catA === "TALL_ELEC_CAP" && catB === "TALL_ELEC_CAP") return 1.2;
  if (catA === "TALL_ELEC_CAP" || catB === "TALL_ELEC_CAP") return 1.5;

  if (isIc(catA) && isIc(catB)) return 1.5;
  if (pair.includes("BGA") && isSmallPassive(pair[0] === "BGA" ? pair[1] : pair[0])) return 2.5;
  if (pair.includes("QFN") && isSmallPassive(pair[0] === "QFN" ? pair[1] : pair[0])) return 1.0;
  if (pair.includes("SOT_SOP_QFP") && isSmallPassive(pair[0] === "SOT_SOP_QFP" ? pair[1] : pair[0])) return 0.7;

  if (catA === "0201" && catB === "0201") return 0.2;
  if (catA === "0402" && catB === "0402") return 0.25;
  if (isSmallPassive(catA) && isSmallPassive(catB)) return 0.35;

  return 0.4;
}

const TABLE_8_2_MATRIX: Record<EmiVictimRole, Partial<Record<EmiAggressorRole, number>>> = {
  NONE: {},
  PASSIVE_XTAL: {
    DCDC_SW_INDUCTOR: 8.0,
    POWER_MOS_LDO_RES: 8.0,
    RELAY_MOTOR_BUZZER: 10.0,
    HIGH_SPEED_CLK_RF: 5.0,
    BOARD_EDGE_HOLE_CONN: 3.0,
  },
  PRECISION_OPAMP_SHUNT: {
    DCDC_SW_INDUCTOR: 10.0,
    POWER_MOS_LDO_RES: 8.0,
    RELAY_MOTOR_BUZZER: 12.0,
    HIGH_SPEED_CLK_RF: 8.0,
    BOARD_EDGE_HOLE_CONN: 3.0,
  },
  PRECISION_ADC_VREF: {
    DCDC_SW_INDUCTOR: 10.0,
    POWER_MOS_LDO_RES: 10.0,
    RELAY_MOTOR_BUZZER: 12.0,
    HIGH_SPEED_CLK_RF: 8.0,
    BOARD_EDGE_HOLE_CONN: 8.0,
  },
  RF_ANTENNA_GNSS: {
    DCDC_SW_INDUCTOR: 15.0,
    POWER_MOS_LDO_RES: 8.0,
    RELAY_MOTOR_BUZZER: 15.0,
    HIGH_SPEED_CLK_RF: 10.0,
    BOARD_EDGE_HOLE_CONN: 5.0,
  },
  TEMP_HUMIDITY_SENSOR: {
    DCDC_SW_INDUCTOR: 15.0,
    POWER_MOS_LDO_RES: 15.0,
    RELAY_MOTOR_BUZZER: 10.0,
    HIGH_SPEED_CLK_RF: 5.0,
    BOARD_EDGE_HOLE_CONN: 5.0,
  },
  HALL_MAG_SENSOR: {
    DCDC_SW_INDUCTOR: 15.0,
    POWER_MOS_LDO_RES: 10.0,
    RELAY_MOTOR_BUZZER: 20.0,
    HIGH_SPEED_CLK_RF: 5.0,
    BOARD_EDGE_HOLE_CONN: 15.0,
  },
  MEMS_IMU_MIC: {
    DCDC_SW_INDUCTOR: 5.0,
    POWER_MOS_LDO_RES: 5.0,
    RELAY_MOTOR_BUZZER: 10.0,
    HIGH_SPEED_CLK_RF: 10.0,
    BOARD_EDGE_HOLE_CONN: 5.0,
  },
  AL_ELEC_CAP: {
    DCDC_SW_INDUCTOR: 2.0,
    POWER_MOS_LDO_RES: 5.0,
    RELAY_MOTOR_BUZZER: 3.0,
    HIGH_SPEED_CLK_RF: 0,
    BOARD_EDGE_HOLE_CONN: 2.0,
  },
  BRITTLE_MLCC: {
    DCDC_SW_INDUCTOR: 0,
    POWER_MOS_LDO_RES: 3.0,
    RELAY_MOTOR_BUZZER: 3.0,
    HIGH_SPEED_CLK_RF: 0,
    BOARD_EDGE_HOLE_CONN: 3.0,
  },
};

function lookupEmiAndThermalPair(
  victim: SpacingComponentProfile,
  aggressor: SpacingComponentProfile
): { emiMm: number; thermalStressMm: number; reasons: string[] } {
  const vRole = victim.emiVictimRole ?? "NONE";
  const aRole = aggressor.emiAggressorRole ?? "NONE";
  const reasons: string[] = [];
  if (vRole === "NONE" || aRole === "NONE") {
    return { emiMm: 0, thermalStressMm: 0, reasons };
  }

  const dist = TABLE_8_2_MATRIX[vRole]?.[aRole] ?? 0;
  if (dist <= 0) {
    return { emiMm: 0, thermalStressMm: 0, reasons };
  }

  let emiMm = 0;
  let thermalStressMm = 0;
  if (aRole === "POWER_MOS_LDO_RES" || aRole === "BOARD_EDGE_HOLE_CONN" || vRole === "AL_ELEC_CAP" || vRole === "BRITTLE_MLCC") {
    thermalStressMm = dist;
    reasons.push(`Thermal/Stress(${victim.designator}[${vRole}] vs ${aggressor.designator}[${aRole}]) >= ${dist}mm`);
  } else {
    emiMm = dist;
    reasons.push(`EMI(${victim.designator}[${vRole}] vs ${aggressor.designator}[${aRole}]) >= ${dist}mm`);
  }

  // Extra thermal rule: high-power heater (>0.5W) vs plastic connector
  if ((aggressor.thermalPowerW ?? 0) > 0.5 && victim.packageCategory === "CONNECTOR_FPC") {
    thermalStressMm = Math.max(thermalStressMm, 3.0);
    reasons.push(`HighPower(>0.5W) vs Connector >= 3.0mm`);
  }

  return { emiMm, thermalStressMm, reasons };
}

/**
 * Compute D_min(i, j) = max(D_DFM^eff, D_Safety^eff, D_EMI, D_Thermal_Stress).
 * Strictly applies native ProjectDesignRules override first when configured.
 */
export function computeFourDimensionalSpacingMm(
  compA: SpacingComponentProfile,
  compB: SpacingComponentProfile,
  projectRules: ProjectDesignRules,
  options?: {
    enforceEmiThermalIsolation?: boolean;
    respectReworkEnvelopes?: boolean;
  }
): FourDimensionalSpacingResult {
  const reasons: string[] = [];

  // 1. D_DFM^eff (Native DRC overrides baseline when projectRules.source !== MCP_DEFAULT_BASELINE)
  const table81 = getTable81DfmBaselineMm(compA, compB);
  const nativeDfm = Math.max(projectRules.componentClearanceMm, projectRules.padToPadClearanceMm);
  let dDfmEffMm: number;
  if (projectRules.source === "JLC_PROJECT_DRC_ONLY") {
    dDfmEffMm = nativeDfm;
    reasons.push(`DFM native DRC override = ${dDfmEffMm.toFixed(2)}mm`);
  } else if (projectRules.source === "JLC_PROJECT_DRC_MERGED") {
    // User's explicit project DRC overrides generic SMD passive spacing while respecting rework / tall shadow if enabled
    dDfmEffMm = options?.respectReworkEnvelopes ? Math.max(nativeDfm, table81) : nativeDfm;
    reasons.push(`DFM merged (project=${nativeDfm.toFixed(2)}mm, table8-1=${table81.toFixed(2)}mm)`);
  } else {
    dDfmEffMm = Math.max(nativeDfm, table81);
    reasons.push(`DFM baseline(table8-1) = ${dDfmEffMm.toFixed(2)}mm`);
  }

  // 2. D_Safety^eff (Table 9-1 + NetClass override)
  const vMax = Math.max(compA.maxVoltageV ?? 5, compB.maxVoltageV ?? 5);
  const crossesIsolation =
    (Boolean(compA.isPrimaryHighVoltage) && Boolean(compB.isSecondaryLowVoltage)) ||
    (Boolean(compB.isPrimaryHighVoltage) && Boolean(compA.isSecondaryLowVoltage)) ||
    (compA.isolationDomain !== undefined &&
      compB.isolationDomain !== undefined &&
      compA.isolationDomain !== compB.isolationDomain);

  // Check if same net group or distinct nets
  const netsA = new Set(compA.netNames ?? []);
  const sharedNonGnd = (compB.netNames ?? []).some((n) => netsA.has(n) && !/^(?:GND|AGND|PGND|DGND)$/i.test(n));
  const netClassKey = compA.netClasses?.[0] ?? compB.netClasses?.[0];
  const safety = getSafetyClearanceSpec(vMax, crossesIsolation, projectRules, netClassKey);
  const dSafetyEffMm =
    crossesIsolation
      ? safety.creepageMm
      : sharedNonGnd && vMax <= 30
        ? projectRules.defaultClearanceMm
        : safety.outerSoldermaskClearanceMm;
  if (dSafetyEffMm > dDfmEffMm) {
    reasons.push(`Safety(${vMax}V${crossesIsolation ? ", isolated" : ""}) >= ${dSafetyEffMm.toFixed(2)}mm`);
  }

  // 3 & 4. D_EMI and D_Thermal_Stress (Table 8-2)
  let dEmiMm = 0;
  let dThermalStressMm = 0;
  if (options?.enforceEmiThermalIsolation !== false) {
    const ab = lookupEmiAndThermalPair(compA, compB);
    const ba = lookupEmiAndThermalPair(compB, compA);
    dEmiMm = Math.max(ab.emiMm, ba.emiMm);
    dThermalStressMm = Math.max(ab.thermalStressMm, ba.thermalStressMm);
    reasons.push(...ab.reasons, ...ba.reasons);
  }

  const dMinMm = Math.max(dDfmEffMm, dSafetyEffMm, dEmiMm, dThermalStressMm);

  return {
    dDfmEffMm,
    dSafetyEffMm,
    dEmiMm,
    dThermalStressMm,
    dMinMm,
    activeSource: projectRules.source,
    reasons,
  };
}

export function getMountingHoleKeepoutDiameterMm(holeSpec: string): number {
  const s = holeSpec.toUpperCase();
  if (s.includes("M2.5") || s.includes("2.7")) return 5.5;
  if (s.includes("M2") || s.includes("2.2")) return 4.5;
  if (s.includes("M4") || s.includes("4.3")) return 9.0;
  return 7.0; // Default M3 (3.2mm drill -> 7.0mm keepout dia)
}

// ============================================================================
// 4. Table 8-5: All 6 Classes of 2.5D Layer-Aware Keep-out Five-Tuples
// ============================================================================

export function resolveStackupLayers(layerCount: number, customStackup?: string[]): string[] {
  if (customStackup && customStackup.length >= 2) {
    return [...customStackup];
  }
  if (layerCount <= 2) {
    return ["TopLayer", "BottomLayer"];
  }
  const layers = ["TopLayer"];
  for (let i = 1; i <= layerCount - 2; i++) {
    layers.push(`InnerLayer${i}`);
  }
  layers.push("BottomLayer");
  return layers;
}

export function resolveRelativeLayerToken(
  token: "MOUNT_LAYER" | "ADJACENT_REF_LAYER" | "OPPOSITE_LAYER" | "ALL_COPPER_LAYERS" | string,
  mountSide: "TOP" | "BOTTOM",
  stackup: string[]
): string[] {
  const upper = token.toUpperCase();
  const top = stackup[0] ?? "TopLayer";
  const bottom = stackup[stackup.length - 1] ?? "BottomLayer";
  const mountLayer = mountSide === "BOTTOM" ? bottom : top;
  const oppositeLayer = mountSide === "BOTTOM" ? top : bottom;
  const adjacentRefLayer =
    stackup.length >= 4
      ? mountSide === "BOTTOM"
        ? stackup[stackup.length - 2]
        : stackup[1]
      : oppositeLayer;

  if (upper === "ALL_COPPER_LAYERS") return [...stackup];
  if (upper === "MOUNT_LAYER") return [mountLayer];
  if (upper === "ADJACENT_REF_LAYER") return [adjacentRefLayer];
  if (upper === "OPPOSITE_LAYER") return [oppositeLayer];
  return [token];
}

/**
 * Generate a Table 8-5 2.5D Keep-out five-tuple (or pair for 2-layer crystal)
 * with exact layerSet & disallowMask scoping.
 * Never bans BottomLayer on 4+ layer boards for inductors or passive crystals!
 */
export function generate25DKeepoutFiveTuples(spec: Keepout25DSourceSpec): Keepout25DFiveTuple[] {
  const stackup = resolveStackupLayers(spec.layerCount, spec.stackup);
  const mountSide = spec.mountSide;
  const mountLayer = resolveRelativeLayerToken("MOUNT_LAYER", mountSide, stackup)[0];
  const adjacentRefLayer = resolveRelativeLayerToken("ADJACENT_REF_LAYER", mountSide, stackup)[0];
  const oppositeLayer = resolveRelativeLayerToken("OPPOSITE_LAYER", mountSide, stackup)[0];
  const allowedNets = spec.allowedNets ? [...spec.allowedNets] : [];

  switch (spec.category) {
    case "POWER_INDUCTOR": {
      // Table 8-5 #1: Default ONLY {MountLayer}; never penetrates inner/bottom unless unshielded HV
      const layerSet = spec.isUnshieldedHighVoltage
        ? Array.from(new Set([mountLayer, adjacentRefLayer]))
        : [mountLayer];
      return [
        {
          id: spec.id ?? `KO_IND_${spec.ownerDesignator}`,
          category: "POWER_INDUCTOR",
          ownerDesignator: spec.ownerDesignator,
          polygon2D: spec.polygon2D,
          layerSet,
          disallowMask: spec.disallowMaskOverride ?? ["COPPER_POUR", "TRACK"],
          allowedNets,
          mountSide,
        },
      ];
    }

    case "FERRITE_OR_CMC": {
      // Table 8-5 #2: {MountLayer} and immediate adjacent shallow layer (not BottomLayer on 4+ layer)
      const layerSet =
        stackup.length >= 4 ? Array.from(new Set([mountLayer, adjacentRefLayer])) : [mountLayer];
      return [
        {
          id: spec.id ?? `KO_CMC_${spec.ownerDesignator}`,
          category: "FERRITE_OR_CMC",
          ownerDesignator: spec.ownerDesignator,
          polygon2D: spec.polygon2D,
          layerSet,
          disallowMask: spec.disallowMaskOverride ?? ["COPPER_POUR", "TRACK"],
          allowedNets,
          mountSide,
        },
      ];
    }

    case "PASSIVE_CRYSTAL": {
      // Table 8-5 #3:
      // - 4+ layers: ONLY {MountLayer} (BottomLayer completely open!)
      // - 2 layers: {MountLayer} blocks TRACK/POUR + {OppositeLayer} preserves local GND & blocks foreign TRACK/VIA
      const mountKeepout: Keepout25DFiveTuple = {
        id: spec.id ?? `KO_XTAL_${spec.ownerDesignator}`,
        category: "PASSIVE_CRYSTAL",
        ownerDesignator: spec.ownerDesignator,
        polygon2D: spec.polygon2D,
        layerSet: [mountLayer],
        disallowMask: spec.disallowMaskOverride ?? ["TRACK", "COPPER_POUR"],
        allowedNets: Array.from(new Set([...allowedNets, "GND", "GND_GUARD"])),
        mountSide,
      };
      if (stackup.length <= 2) {
        const oppRefKeepout: Keepout25DFiveTuple = {
          id: `${mountKeepout.id}_2L_REF`,
          category: "PASSIVE_CRYSTAL",
          ownerDesignator: spec.ownerDesignator,
          polygon2D: spec.polygon2D,
          layerSet: [oppositeLayer],
          disallowMask: ["TRACK", "VIA"],
          allowedNets: ["GND", "GND_GUARD"],
          mountSide,
        };
        return [mountKeepout, oppRefKeepout];
      }
      return [mountKeepout];
    }

    case "SAFETY_ISOLATION_OR_ETH_HV": {
      // Table 8-5 #4: ALL_COPPER_LAYERS
      return [
        {
          id: spec.id ?? `KO_HV_${spec.ownerDesignator}`,
          category: "SAFETY_ISOLATION_OR_ETH_HV",
          ownerDesignator: spec.ownerDesignator,
          polygon2D: spec.polygon2D,
          layerSet: [...stackup],
          disallowMask: spec.disallowMaskOverride ?? ["COPPER_POUR", "TRACK", "VIA", "PAD", "COMPONENT"],
          allowedNets,
          mountSide: "ALL",
        },
      ];
    }

    case "RF_ANTENNA": {
      // Table 8-5 #5: ALL_COPPER_LAYERS
      return [
        {
          id: spec.id ?? `KO_ANT_${spec.ownerDesignator}`,
          category: "RF_ANTENNA",
          ownerDesignator: spec.ownerDesignator,
          polygon2D: spec.polygon2D,
          layerSet: [...stackup],
          disallowMask: spec.disallowMaskOverride ?? ["COPPER_POUR", "TRACK", "VIA", "PAD", "COMPONENT"],
          allowedNets,
          mountSide: "ALL",
        },
      ];
    }

    case "OPAMP_IN_MINUS": {
      // Table 8-5 #6: ONLY {MountLayer, AdjacentRefLayer}, disallowMask = ["COPPER_POUR"]
      return [
        {
          id: spec.id ?? `KO_INM_${spec.ownerDesignator}`,
          category: "OPAMP_IN_MINUS",
          ownerDesignator: spec.ownerDesignator,
          polygon2D: spec.polygon2D,
          layerSet: Array.from(new Set([mountLayer, adjacentRefLayer])),
          disallowMask: spec.disallowMaskOverride ?? ["COPPER_POUR"],
          allowedNets,
          mountSide,
        },
      ];
    }

    case "MOUNTING_HOLE": {
      return [
        {
          id: spec.id ?? `KO_HOLE_${spec.ownerDesignator}`,
          category: "MOUNTING_HOLE",
          ownerDesignator: spec.ownerDesignator,
          polygon2D: spec.polygon2D,
          layerSet: [...stackup],
          disallowMask: spec.disallowMaskOverride ?? ["COMPONENT", "TRACK", "PAD", "COPPER_POUR"],
          allowedNets,
          mountSide: "ALL",
        },
      ];
    }

    case "CONNECTOR_CLEARANCE": {
      return [
        {
          id: spec.id ?? `KO_CONN_${spec.ownerDesignator}`,
          category: "CONNECTOR_CLEARANCE",
          ownerDesignator: spec.ownerDesignator,
          polygon2D: spec.polygon2D,
          layerSet: [mountLayer],
          disallowMask: spec.disallowMaskOverride ?? ["COMPONENT"],
          allowedNets,
          mountSide,
        },
      ];
    }
  }
}

// ============================================================================
// 5. Polygon Helpers & Two-Stage Short-Circuit Clipper2 2.5D Intersection
// ============================================================================

export function polygonFromRectMm(
  cxMm: number,
  cyMm: number,
  widthMm: number,
  heightMm: number,
  rotationDeg = 0
): Array<[number, number]> {
  const hw = widthMm / 2;
  const hh = heightMm / 2;
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners: Array<[number, number]> = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  return corners.map(([lx, ly]) => [
    Number((cxMm + lx * cos - ly * sin).toFixed(4)),
    Number((cyMm + lx * sin + ly * cos).toFixed(4)),
  ]);
}

export function circlePolygonMm(
  cxMm: number,
  cyMm: number,
  diameterMm: number,
  segments = 24
): Array<[number, number]> {
  const r = diameterMm / 2;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < segments; i++) {
    const theta = (2 * Math.PI * i) / segments;
    pts.push([
      Number((cxMm + r * Math.cos(theta)).toFixed(4)),
      Number((cyMm + r * Math.sin(theta)).toFixed(4)),
    ]);
  }
  return pts;
}

export function toClipperPath64(polyMm: Array<[number, number]>): Path64 {
  const path = new Path64();
  for (const [x, y] of polyMm) {
    path.push(new Point64(Math.round(x * CLIPPER_SCALE), Math.round(y * CLIPPER_SCALE)));
  }
  return path;
}

export function fromClipperPath64(path: Path64): Array<[number, number]> {
  return path.map((pt) => [
    Number((pt.x / CLIPPER_SCALE).toFixed(4)),
    Number((pt.y / CLIPPER_SCALE).toFixed(4)),
  ]);
}

export function computeClipperIntersectionAreaMm2(
  polyA: Array<[number, number]>,
  polyB: Array<[number, number]>
): number {
  if (polyA.length < 3 || polyB.length < 3) return 0;

  // Fast AABB reject before invoking Clipper2
  let minAx = Infinity, minAy = Infinity, maxAx = -Infinity, maxAy = -Infinity;
  for (const [x, y] of polyA) {
    if (x < minAx) minAx = x;
    if (y < minAy) minAy = y;
    if (x > maxAx) maxAx = x;
    if (y > maxAy) maxAy = y;
  }
  let minBx = Infinity, minBy = Infinity, maxBx = -Infinity, maxBy = -Infinity;
  for (const [x, y] of polyB) {
    if (x < minBx) minBx = x;
    if (y < minBy) minBy = y;
    if (x > maxBx) maxBx = x;
    if (y > maxBy) maxBy = y;
  }
  if (maxAx <= minBx || maxBx <= minAx || maxAy <= minBy || maxBy <= minAy) {
    return 0;
  }

  const subj = new Paths64();
  subj.push(toClipperPath64(polyA));
  const clip = new Paths64();
  clip.push(toClipperPath64(polyB));

  const sol = Clipper.Intersect(subj, clip, FillRule.NonZero);
  if (!sol || sol.length === 0) return 0;

  const areaRaw = Math.abs(Clipper.areaPaths(sol));
  return areaRaw / (CLIPPER_SCALE * CLIPPER_SCALE);
}

/**
 * Two-stage short-circuit 2.5D Keep-out violation checker:
 * Stage 1: layerSet intersection, disallowMask membership, allowedNets exemption.
 * Stage 2: Exact Clipper2 2D polygon intersection area > 1e-4 mm^2.
 */
export function checkKeepout25DViolation(
  primitive: CheckablePcbPrimitive,
  keepout: Keepout25DFiveTuple,
  allCopperLayers: string[]
): KeepoutViolationCheckResult {
  // Stage 1a: Expand MultiLayer / ALL_COPPER_LAYERS and verify layer intersection
  const primLayers =
    primitive.layer === "MultiLayer" || primitive.layer === "ALL_COPPER_LAYERS"
      ? allCopperLayers
      : [primitive.layer];

  const expandedKeepoutLayers = keepout.layerSet.flatMap((l) =>
    l === "ALL_COPPER_LAYERS" ? allCopperLayers : [l]
  );

  const hasLayerOverlap = primLayers.some((l) => expandedKeepoutLayers.includes(l));
  if (!hasLayerOverlap) {
    return { violated: false, shortCircuitedBy: "LAYER_SET", intersectionAreaMm2: 0 };
  }

  // Stage 1b: disallowMask check
  if (!keepout.disallowMask.includes(primitive.kind)) {
    return { violated: false, shortCircuitedBy: "DISALLOW_MASK", intersectionAreaMm2: 0 };
  }

  // Stage 1c: allowedNets exemption
  if (primitive.net && keepout.allowedNets.includes(primitive.net)) {
    return { violated: false, shortCircuitedBy: "ALLOWED_NET", intersectionAreaMm2: 0 };
  }

  // Stage 2: Exact Clipper2 boolean intersection area
  const area = computeClipperIntersectionAreaMm2(primitive.polygon2D, keepout.polygon2D);
  if (area <= 1e-4) {
    return { violated: false, shortCircuitedBy: "ZERO_AREA", intersectionAreaMm2: area };
  }

  return { violated: true, shortCircuitedBy: "NONE", intersectionAreaMm2: area };
}
