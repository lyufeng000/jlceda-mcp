import type { ElecCalcResult, RecommendedStandardValue } from "../../types/index.js";
import { findLcscResistorCandidate, formatResistance, generateResistorGrid } from "../e-series-grid.js";

export type I2cSpeedMode = "100k" | "400k" | "1M";

export interface I2cPullupInputs {
  vdd_v: number;
  speed_mode: I2cSpeedMode;
  c_bus_pf: number;
  existing_pullups_kohm?: number[];
  i_ol_ma?: number;
  v_ol_max_v?: number;
}

export interface I2cPullupResults {
  rp_min_ohm: number;
  rp_max_ohm: number;
  existing_eq_ohm: number | null;
  recommended_add_ohm: number | null;
  recommended_add_formatted: string;
  resulting_total_rp_ohm: number;
  sink_current_ma: number;
  estimated_rise_time_ns: number;
  max_rise_time_ns: number;
}

export function calculateI2cPullup(
  inputs: I2cPullupInputs
): ElecCalcResult<I2cPullupResults> {
  const vdd = inputs.vdd_v;
  const vOlMax = inputs.v_ol_max_v ?? 0.4;
  // NXP UM10204 Table 10 specs: 100k->tr=1000ns/3mA, 400k->tr=300ns/3mA, 1M (Fm+)->tr=120ns/20mA
  const trMaxNs =
    inputs.speed_mode === "100k" ? 1000 : inputs.speed_mode === "400k" ? 300 : 120;
  const iOlMa = inputs.i_ol_ma ?? (inputs.speed_mode === "1M" ? 20 : 3);
  const iOlA = iOlMa / 1000;
  const cBusF = inputs.c_bus_pf * 1e-12;

  const rpMinOhm = (vdd - vOlMax) / iOlA;
  const rpMaxOhm = (trMaxNs * 1e-9) / (0.8473 * cBusF);

  const existing = (inputs.existing_pullups_kohm ?? []).filter((k) => k > 0);
  const gExist = existing.reduce((sum, kohm) => sum + 1 / (kohm * 1000), 0);
  const rExistEq = gExist > 0 ? 1 / gExist : null;

  const warnings: string[] = [];
  const recommendedStandardValues: RecommendedStandardValue[] = [];

  if (rpMinOhm > rpMaxOhm) {
    return {
      calculator: "i2c_pullup",
      formulaUsed: "Rp_min = (VDD - 0.4V)/IOL; Rp_max = tr_max / (0.8473 * Cbus)",
      results: {
        rp_min_ohm: Number(rpMinOhm.toFixed(2)),
        rp_max_ohm: Number(rpMaxOhm.toFixed(2)),
        existing_eq_ohm: rExistEq !== null ? Number(rExistEq.toFixed(2)) : null,
        recommended_add_ohm: null,
        recommended_add_formatted: "INVALID_WINDOW",
        resulting_total_rp_ohm: rExistEq ?? 0,
        sink_current_ma: iOlMa,
        estimated_rise_time_ns: trMaxNs,
        max_rise_time_ns: trMaxNs,
      },
      recommendedStandardValues: [],
      deratingPass: false,
      status: "FAIL_NO_VALID_WINDOW",
      warnings: [
        `总线电容 ${inputs.c_bus_pf}pF 过大导致 Rp_min(${rpMinOhm.toFixed(0)}Ω) > Rp_max(${rpMaxOhm.toFixed(0)}Ω)，请降低速率或减小总线电容！`,
      ],
    };
  }

  // Case 1: existing pullups already violate lower bound
  if (rExistEq !== null && rExistEq < rpMinOhm) {
    const sinkActualMa = ((vdd - vOlMax) / rExistEq) * 1000;
    return {
      calculator: "i2c_pullup",
      formulaUsed: "Rp_min = (VDD - 0.4V)/IOL; Rp_max = tr_max / (0.8473 * Cbus)",
      results: {
        rp_min_ohm: Number(rpMinOhm.toFixed(2)),
        rp_max_ohm: Number(rpMaxOhm.toFixed(2)),
        existing_eq_ohm: Number(rExistEq.toFixed(2)),
        recommended_add_ohm: null,
        recommended_add_formatted: "REMOVE_EXISTING_PULLUPS",
        resulting_total_rp_ohm: Number(rExistEq.toFixed(2)),
        sink_current_ma: Number(sinkActualMa.toFixed(3)),
        estimated_rise_time_ns: Number((0.8473 * rExistEq * cBusF * 1e9).toFixed(2)),
        max_rise_time_ns: trMaxNs,
      },
      recommendedStandardValues: [],
      deratingPass: false,
      status: "FAIL_OVERCURRENT_VOL_VIOLATION",
      warnings: [
        `既有模块并联上拉等效阻值 ${rExistEq.toFixed(1)}Ω < Rp_min(${rpMinOhm.toFixed(1)}Ω)，灌电流达 ${sinkActualMa.toFixed(2)}mA > ${iOlMa}mA，器件无法将低电平拉低至 0.4V 以下！必须拆除多余模块上拉电阻。`,
      ],
    };
  }

  // Case 2: existing pullups are already inside [rpMin, rpMax]
  if (rExistEq !== null && rExistEq >= rpMinOhm && rExistEq <= rpMaxOhm) {
    const sinkMa = ((vdd - vOlMax) / rExistEq) * 1000;
    const trNs = 0.8473 * rExistEq * cBusF * 1e9;
    return {
      calculator: "i2c_pullup",
      formulaUsed: "Rp_min = (VDD - 0.4V)/IOL; Rp_max = tr_max / (0.8473 * Cbus)",
      results: {
        rp_min_ohm: Number(rpMinOhm.toFixed(2)),
        rp_max_ohm: Number(rpMaxOhm.toFixed(2)),
        existing_eq_ohm: Number(rExistEq.toFixed(2)),
        recommended_add_ohm: null,
        recommended_add_formatted: "NONE_NEEDED",
        resulting_total_rp_ohm: Number(rExistEq.toFixed(2)),
        sink_current_ma: Number(sinkMa.toFixed(3)),
        estimated_rise_time_ns: Number(trNs.toFixed(2)),
        max_rise_time_ns: trMaxNs,
      },
      recommendedStandardValues: [],
      deratingPass: true,
      status: "PASS_EXISTING_SUFFICIENT",
      warnings: ["既有并联上拉电阻已处于合规窗口内，无需额外增加板载上拉电阻。"],
    };
  }

  // Case 3: compute additional E24 resistor R_add such that (rExistEq || R_add) in [rpMin, rpMax]
  const rAddMin = 1 / (1 / rpMinOhm - gExist);
  const rAddMax = 1 / (1 / rpMaxOhm - gExist);
  // Ideal sweet-spot target: ~0.65 * Rp_max (or geometric mean clamped inside window)
  const targetTotal = Math.min(rpMaxOhm * 0.68, Math.max(rpMinOhm * 1.4, Math.sqrt(rpMinOhm * rpMaxOhm)));
  const targetAdd = 1 / Math.max(1e-9, 1 / targetTotal - gExist);

  const grid = generateResistorGrid("E24", 100, 1_000_000);
  const validCandidates = grid.filter((r) => r >= rAddMin && r <= rAddMax);

  let chosenAdd: number;
  let deratingPass = true;
  if (validCandidates.length > 0) {
    chosenAdd = validCandidates.reduce((best, r) =>
      Math.abs(r - targetAdd) < Math.abs(best - targetAdd) ? r : best
    );
  } else {
    deratingPass = false;
    chosenAdd = grid.reduce((best, r) =>
      Math.abs(r - targetAdd) < Math.abs(best - targetAdd) ? r : best
    );
    warnings.push(`未找到严格落入 [${rAddMin.toFixed(0)}Ω, ${rAddMax.toFixed(0)}Ω] 的标准 E24 阻值。`);
  }

  const totalRp = 1 / (gExist + 1 / chosenAdd);
  const sinkMa = ((vdd - vOlMax) / totalRp) * 1000;
  const trNs = 0.8473 * totalRp * cBusF * 1e9;
  const cand = findLcscResistorCandidate(chosenAdd, "0402");

  recommendedStandardValues.push({
    role: "R_pullup_i2c",
    nominalValue: chosenAdd,
    unit: "Ohm",
    eSeries: "E24",
    package: "0402",
    ...(cand ? { lcscCandidate: cand.lcscId } : {}),
  });

  return {
    calculator: "i2c_pullup",
    formulaUsed: "Rp_min = (VDD - 0.4V)/IOL; Rp_max = tr_max / (0.8473 * Cbus)",
    results: {
      rp_min_ohm: Number(rpMinOhm.toFixed(2)),
      rp_max_ohm: Number(rpMaxOhm.toFixed(2)),
      existing_eq_ohm: rExistEq !== null ? Number(rExistEq.toFixed(2)) : null,
      recommended_add_ohm: chosenAdd,
      recommended_add_formatted: formatResistance(chosenAdd),
      resulting_total_rp_ohm: Number(totalRp.toFixed(2)),
      sink_current_ma: Number(sinkMa.toFixed(3)),
      estimated_rise_time_ns: Number(trNs.toFixed(2)),
      max_rise_time_ns: trMaxNs,
    },
    recommendedStandardValues,
    deratingPass,
    status: deratingPass ? "PASS" : "FAIL_NO_VALID_WINDOW",
    warnings,
  };
}
