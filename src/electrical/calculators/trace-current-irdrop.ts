import type { ElecCalcResult } from "../../types/index.js";

export interface TraceCurrentIrdropInputs {
  voltage_v: number;
  current_a?: number;
  power_w?: number;
  length_mm: number;
  copper_oz?: number;
  layer?: "EXT" | "INT";
  max_dt_c?: number;
  max_drop_pct?: number;
  return_path?: "SOLID_GND_PLANE" | "TRACE_RETURN";
  via_drill_mm?: number;
  mech_min_width_mm?: number;
}

export interface TraceCurrentIrdropResults {
  current_a: number;
  w_thermal_ipc2221_mm: number;
  w_irdrop_limit_mm: number;
  w_mech_min_mm: number;
  w_required_min_mm: number;
  recommended_trace_width_mm: number;
  governing_constraint: string;
  sheet_resistance_mohm_per_sq: number;
  estimated_ir_drop_mv: number;
  estimated_ir_drop_pct: number;
  min_clearance_inner_mm: number;
  min_clearance_surface_mm: number;
  min_clearance_bare_pad_mm: number;
  creepage_distance_mm: number;
  reinforced_pri_sec_clearance_mm?: number;
  reinforced_pri_sec_creepage_mm?: number;
  via_stitching_for_layer_change: {
    via_drill_mm: number;
    via_pad_mm: number;
    safe_current_per_via_a: number;
    min_parallel_vias: number;
    min_parallel_vias_with_redundancy: number;
  };
}

interface ViaSpec {
  drillMm: number;
  padMm: number;
  safeCurrentA: number;
}

const TABLE_9_4_VIAS: readonly ViaSpec[] = [
  { drillMm: 0.2, padMm: 0.4, safeCurrentA: 0.45 },
  { drillMm: 0.3, padMm: 0.6, safeCurrentA: 0.70 },
  { drillMm: 0.4, padMm: 0.7, safeCurrentA: 1.00 },
  { drillMm: 0.5, padMm: 0.85, safeCurrentA: 1.30 },
  { drillMm: 0.8, padMm: 1.3, safeCurrentA: 1.90 },
];

function getViaSpec(drillMm: number): ViaSpec {
  return TABLE_9_4_VIAS.reduce((best, spec) =>
    Math.abs(spec.drillMm - drillMm) < Math.abs(best.drillMm - drillMm) ? spec : best
  );
}

export function getSafetyClearanceByVoltage(voltageV: number): {
  innerMm: number;
  surfaceMm: number;
  barePadMm: number;
  creepageMm: number;
  reinforcedClearanceMm?: number;
  reinforcedCreepageMm?: number;
} {
  if (voltageV <= 15) {
    return { innerMm: 0.10, surfaceMm: 0.15, barePadMm: 0.20, creepageMm: 0.20 };
  }
  if (voltageV <= 30) {
    return { innerMm: 0.10, surfaceMm: 0.25, barePadMm: 0.50, creepageMm: 0.50 };
  }
  if (voltageV <= 60) {
    return { innerMm: 0.15, surfaceMm: 0.50, barePadMm: 1.00, creepageMm: 1.00 };
  }
  if (voltageV <= 150) {
    return { innerMm: 0.25, surfaceMm: 1.00, barePadMm: 1.50, creepageMm: 1.50 };
  }
  if (voltageV <= 350) {
    // 220V AC (peak ~311V)
    return {
      innerMm: 0.80,
      surfaceMm: 3.00,
      barePadMm: 3.00,
      creepageMm: 3.00,
      reinforcedClearanceMm: 5.00,
      reinforcedCreepageMm: 6.40,
    };
  }
  return {
    innerMm: 2.00,
    surfaceMm: 5.00,
    barePadMm: 8.00,
    creepageMm: 8.00,
    reinforcedClearanceMm: 8.00,
    reinforcedCreepageMm: 10.00,
  };
}

export function calculateTraceCurrentIrdrop(
  inputs: TraceCurrentIrdropInputs
): ElecCalcResult<TraceCurrentIrdropResults> {
  const voltageV = inputs.voltage_v;
  const currentA =
    inputs.current_a ??
    (inputs.power_w !== undefined && voltageV > 0 ? inputs.power_w / voltageV : 0);

  if (voltageV <= 0 || currentA <= 0 || inputs.length_mm <= 0) {
    throw new Error(
      "Invalid trace_current_irdrop inputs: voltage_v, current_a (or power_w), and length_mm must be > 0."
    );
  }

  const copperOz = inputs.copper_oz ?? 1;
  const layer = inputs.layer ?? "EXT";
  const maxDt = inputs.max_dt_c ?? 10;
  const maxDropPct = inputs.max_drop_pct ?? 2.0;
  const loopFactor = inputs.return_path === "TRACE_RETURN" ? 2.0 : 1.0;

  // 1. IPC-2221 Thermal cross-section area & width
  const k = layer === "INT" ? 0.024 : 0.048;
  const areaMil2 = Math.pow(currentA / (k * Math.pow(maxDt, 0.44)), 1 / 0.725);
  // 1 oz copper thickness = 35 um = 1.37795 mil (35 / 25.4)
  const thicknessMil = (35 * copperOz) / 25.4;
  const wThermalMm = (areaMil2 / thicknessMil) * 0.0254;

  // 2. Sheet resistance IR drop width limit
  const sheetResOhm = 0.0005 / copperOz; // 0.5 mOhm/sq @1oz, 0.25 mOhm/sq @2oz
  const vDropLimitV = voltageV * (maxDropPct / 100);
  const wIrdropMm = (currentA * sheetResOhm * loopFactor * inputs.length_mm) / vDropLimitV;

  // 3. Mechanical & etching minimum floor (Table 9-1 & 9-2)
  const defaultMechMin =
    voltageV >= 150 ? 0.50 : copperOz >= 2 ? 0.20 : currentA >= 0.5 ? 0.25 : 0.15;
  const wMechMinMm = Math.max(inputs.mech_min_width_mm ?? 0, defaultMechMin);

  const wRequiredMin = Math.max(wThermalMm, wIrdropMm, wMechMinMm);
  // Snap upward cleanly to 0.05mm step (or 0.10mm for >= 1.0mm)
  const wRecommended =
    wRequiredMin >= 1.0
      ? Number((Math.ceil(wRequiredMin * 10) / 10).toFixed(2))
      : Number((Math.ceil(wRequiredMin * 20) / 20).toFixed(2));

  let governingConstraint = `THERMAL_RISE_${maxDt}C`;
  if (wIrdropMm >= wThermalMm && wIrdropMm >= wMechMinMm) {
    governingConstraint = `IR_DROP_${maxDropPct}PCT`;
  } else if (wMechMinMm >= wThermalMm && wMechMinMm >= wIrdropMm) {
    governingConstraint = "MECH_MIN_WIDTH";
  }

  const estDropV =
    currentA * sheetResOhm * loopFactor * (inputs.length_mm / wRecommended);
  const estDropMv = estDropV * 1000;
  const estDropPct = (estDropV / voltageV) * 100;

  // 4. Table 9-4 via stitching
  const viaSpec = getViaSpec(inputs.via_drill_mm ?? 0.3);
  const minParallelVias = Math.max(1, Math.ceil(currentA / viaSpec.safeCurrentA));
  const minParallelViasRedundant =
    currentA > viaSpec.safeCurrentA
      ? Math.max(minParallelVias, Math.ceil((currentA * 1.2) / viaSpec.safeCurrentA))
      : 1;

  // 5. Table 9-1 safety clearance & creepage
  const clr = getSafetyClearanceByVoltage(voltageV);
  const surfaceClr = copperOz >= 2 ? Math.max(clr.surfaceMm, 0.20) : clr.surfaceMm;

  const warnings: string[] = [];
  if (wRecommended >= 5.0) {
    warnings.push(
      `所需线宽 ${wRecommended}mm >= 5mm，强烈建议改用实心多边形铺铜（Polygon Pour）、阻焊开窗堆锡或升级 2oz 厚铜！`
    );
  }
  if (voltageV >= 150) {
    warnings.push(
      `高压网络 (${voltageV}V) 表层安全线距须 >= ${surfaceClr}mm，跨初次级加强绝缘须满足电气间隙 >= ${clr.reinforcedClearanceMm ?? surfaceClr}mm、爬电距离 >= ${clr.reinforcedCreepageMm ?? clr.creepageMm}mm。`
    );
  }

  return {
    calculator: "trace_current_irdrop",
    formulaUsed: `IPC-2221(k=${k}) + SheetResistance(${(sheetResOhm * 1000).toFixed(2)}mOhm/sq@${copperOz}oz)`,
    results: {
      current_a: Number(currentA.toFixed(4)),
      w_thermal_ipc2221_mm: Number(wThermalMm.toFixed(4)),
      w_irdrop_limit_mm: Number(wIrdropMm.toFixed(4)),
      w_mech_min_mm: Number(wMechMinMm.toFixed(4)),
      w_required_min_mm: Number(wRequiredMin.toFixed(4)),
      recommended_trace_width_mm: wRecommended,
      governing_constraint: governingConstraint,
      sheet_resistance_mohm_per_sq: Number((sheetResOhm * 1000).toFixed(3)),
      estimated_ir_drop_mv: Number(estDropMv.toFixed(3)),
      estimated_ir_drop_pct: Number(estDropPct.toFixed(4)),
      min_clearance_inner_mm: clr.innerMm,
      min_clearance_surface_mm: surfaceClr,
      min_clearance_bare_pad_mm: clr.barePadMm,
      creepage_distance_mm: clr.creepageMm,
      ...(clr.reinforcedClearanceMm !== undefined
        ? { reinforced_pri_sec_clearance_mm: clr.reinforcedClearanceMm }
        : {}),
      ...(clr.reinforcedCreepageMm !== undefined
        ? { reinforced_pri_sec_creepage_mm: clr.reinforcedCreepageMm }
        : {}),
      via_stitching_for_layer_change: {
        via_drill_mm: viaSpec.drillMm,
        via_pad_mm: viaSpec.padMm,
        safe_current_per_via_a: viaSpec.safeCurrentA,
        min_parallel_vias: minParallelVias,
        min_parallel_vias_with_redundancy: minParallelViasRedundant,
      },
    },
    recommendedStandardValues: [],
    deratingPass: estDropPct <= maxDropPct,
    status: estDropPct <= maxDropPct ? "PASS" : "WARN_DROP_EXCEEDED",
    warnings,
  };
}
