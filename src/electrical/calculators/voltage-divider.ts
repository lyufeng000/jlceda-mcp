import type { ElecCalcResult, RecommendedStandardValue } from "../../types/index.js";
import {
  type ESeriesType,
  ORDERED_RESISTOR_PACKAGES,
  RESISTOR_PACKAGE_SPECS,
  findLcscResistorCandidate,
  formatResistance,
  generateResistorGrid,
  matchStandardCapacitor,
  matchStandardResistor,
  optimizeSeriesResistorCombination,
} from "../e-series-grid.js";

export interface VoltageDividerInputs {
  mode: "FB" | "ADC";
  v_in_max: number;
  v_target_or_vref: number;
  v_out?: number;
  i_fb_ua?: number;
  r_series?: ESeriesType;
  adc_z_max_kohm?: number;
  package?: "0201" | "0402" | "0603" | "0805" | "1206" | "2512";
}

export interface VoltageDividerResults {
  mode: "FB" | "ADC";
  r_top_ohm: number;
  r_bot_ohm: number;
  r_top_formatted: string;
  r_bot_formatted: string;
  r_top_series_count: number;
  r_top_series_array_ohm: number[];
  r_top_package: string;
  r_bot_package: string;
  v_actual: number;
  v_target: number;
  error_pct: number;
  i_fb_offset_mv: number;
  r_th_ohm: number;
  divider_current_ma: number;
  power_top_total_mw: number;
  power_top_each_mw: number;
  power_bot_mw: number;
  v_top_each_v: number;
  v_bot_v: number;
  c_charge_nf: number | null;
  hv_series_split: boolean;
}

function selectPackageForStress(vStress: number, pStressW: number): string | null {
  for (const pkg of ORDERED_RESISTOR_PACKAGES) {
    const spec = RESISTOR_PACKAGE_SPECS[pkg];
    // For 0603, enforce conservative 50V limit when auto-selecting
    const vSafeLimit = pkg === "0603" ? 50 : spec.safeWorkingVoltage80PctV;
    if (vStress <= vSafeLimit && pStressW <= spec.safePower50PctW) {
      return pkg;
    }
  }
  return null;
}

export function calculateVoltageDivider(
  inputs: VoltageDividerInputs
): ElecCalcResult<VoltageDividerResults> {
  const mode = inputs.mode;
  const rSeries: ESeriesType = inputs.r_series ?? "E96";
  const iFbA = (inputs.i_fb_ua ?? 0) * 1e-6;
  const vTopTotal = mode === "FB" ? (inputs.v_out ?? inputs.v_in_max) : inputs.v_in_max;
  const vTarget = inputs.v_target_or_vref;

  if (vTopTotal <= 0 || vTarget <= 0 || vTarget >= vTopTotal) {
    throw new Error(
      `Invalid voltage_divider inputs: require 0 < target (${vTarget}) < top voltage (${vTopTotal}).`
    );
  }

  const hvSplit = inputs.v_in_max > 150 || vTopTotal > 150;
  const warnings: string[] = [];

  // Search standard E24/E96 resistor pairs over practical engineering range
  const minRBot = hvSplit ? 1_000 : 500;
  const maxRBot = hvSplit ? 47_000 : 100_000;
  const rBotCandidates = generateResistorGrid(rSeries, minRBot, maxRBot);

  let bestScore = Infinity;
  let bestRTop = 10_000;
  let bestRBot = 10_000;
  let bestSeriesArray: number[] = [10_000];
  let bestVActual = vTarget;
  let bestErrPct = 0;

  // Determine target series count if HV (>150V)
  const vDropTopApprox = vTopTotal - (mode === "FB" ? vTarget : vTarget);
  const hvSeriesCount = hvSplit ? Math.max(2, Math.ceil(vDropTopApprox / 150)) : 1;

  for (const rBot of rBotCandidates) {
    // Check divider current within sensible bounds: [25uA, 5mA]
    const iDiv = vTarget / rBot;
    if (iDiv < 25e-6 || iDiv > 5e-3) continue;
    // Check power on R_bot <= 50% of 1206 (0.125W) and reasonable (<50mW preferred)
    const pBot = (vTarget * vTarget) / rBot;
    if (pBot > 0.1) continue;

    let rTopIdeal: number;
    if (mode === "FB") {
      // V_out = V_ref * (1 + R_top / R_bot) + I_FB * R_top
      rTopIdeal = (vTopTotal - vTarget) / (vTarget / rBot + iFbA);
    } else {
      // V_adc = V_in * R_bot / (R_top + R_bot) - I_FB * (R_top * R_bot)/(R_top + R_bot)
      // Solve for R_top: V_adc * (R_top + R_bot) = V_in * R_bot - I_FB * R_top * R_bot
      const denom = vTarget + iFbA * rBot;
      rTopIdeal = (rBot * (vTopTotal - vTarget)) / denom;
    }

    if (rTopIdeal <= 0 || rTopIdeal > 20_000_000) continue;

    let rTopActual: number;
    let seriesArray: number[];
    if (hvSplit) {
      // For fast search, evaluate equal split first; refine top candidates at end
      const eachMatch = matchStandardResistor(rTopIdeal / hvSeriesCount, rSeries);
      rTopActual = eachMatch.nominalValue * hvSeriesCount;
      seriesArray = Array<number>(hvSeriesCount).fill(eachMatch.nominalValue);
    } else {
      const topMatch = matchStandardResistor(rTopIdeal, rSeries);
      rTopActual = topMatch.nominalValue;
      seriesArray = [rTopActual];
    }

    const rTh = (rTopActual * rBot) / (rTopActual + rBot);
    const vActual =
      mode === "FB"
        ? vTarget * (1 + rTopActual / rBot) + iFbA * rTopActual
        : vTopTotal * (rBot / (rTopActual + rBot)) - iFbA * rTh;

    const errPct = Math.abs((vActual - (mode === "FB" ? vTopTotal : vTarget)) / (mode === "FB" ? vTopTotal : vTarget)) * 100;
    const pTopTotal = Math.pow(vTopTotal - (mode === "FB" ? vTarget : vActual), 2) / rTopActual;
    // Penalize excessive power or excessive impedance (>500k in FB if I_FB present)
    const powerPenalty = pTopTotal > 0.125 ? (pTopTotal - 0.125) * 100 : 0;
    const biasPenalty = iFbA > 0 && mode === "FB" ? (iFbA * rTopActual) / vTopTotal * 0.2 : 0;
    const adcPenalty =
      mode === "ADC" && inputs.adc_z_max_kohm && rTh > inputs.adc_z_max_kohm * 1000
        ? 0.02
        : 0;
    const score = errPct + powerPenalty + biasPenalty + adcPenalty;

    if (score < bestScore) {
      bestScore = score;
      bestRTop = rTopActual;
      bestRBot = rBot;
      bestSeriesArray = seriesArray;
      bestVActual = vActual;
      bestErrPct = errPct;
    }
  }

  // Refine HV series array using optimizeSeriesResistorCombination if err > 0.05%
  if (hvSplit && bestErrPct > 0.05) {
    const rTopIdealBest =
      mode === "FB"
        ? (vTopTotal - vTarget) / (vTarget / bestRBot + iFbA)
        : (bestRBot * (vTopTotal - vTarget)) / (vTarget + iFbA * bestRBot);
    const powerNeedCount = Math.ceil(
      Math.pow(vTopTotal - vTarget, 2) / Math.max(rTopIdealBest, 1) / 0.125
    );
    const finalCount = Math.max(hvSeriesCount, powerNeedCount);
    const opt = optimizeSeriesResistorCombination(rTopIdealBest, finalCount, rSeries);
    const rThOpt = (opt.totalOhm * bestRBot) / (opt.totalOhm + bestRBot);
    const vActOpt =
      mode === "FB"
        ? vTarget * (1 + opt.totalOhm / bestRBot) + iFbA * opt.totalOhm
        : vTopTotal * (bestRBot / (opt.totalOhm + bestRBot)) - iFbA * rThOpt;
    const errOpt =
      Math.abs((vActOpt - (mode === "FB" ? vTopTotal : vTarget)) / (mode === "FB" ? vTopTotal : vTarget)) *
      100;
    if (errOpt <= bestErrPct) {
      bestRTop = opt.totalOhm;
      bestSeriesArray = opt.valuesOhm;
      bestVActual = vActOpt;
      bestErrPct = errOpt;
    }
  }

  const rTh = (bestRTop * bestRBot) / (bestRTop + bestRBot);
  const vTap = mode === "FB" ? vTarget : bestVActual;
  const vAcrossTopTotal = vTopTotal - vTap;
  const vAcrossTopEach = vAcrossTopTotal / bestSeriesArray.length;
  const pTopTotal = (vAcrossTopTotal * vAcrossTopTotal) / bestRTop;
  const pTopEach = pTopTotal / bestSeriesArray.length;
  const pBot = (vTap * vTap) / bestRBot;
  const iDivMa = (vTap / bestRBot) * 1000;
  const iFbOffsetMv =
    mode === "FB" ? iFbA * bestRTop * 1000 : -iFbA * rTh * 1000;

  // Package & derating verification
  let rTopPkg = inputs.package ?? (hvSplit ? "1206" : selectPackageForStress(vAcrossTopEach, pTopEach) ?? "1206");
  let rBotPkg = inputs.package ?? (selectPackageForStress(vTap, pBot) ?? "1206");
  let deratingPass = true;

  const checkResStress = (role: string, pkg: string, v: number, pW: number) => {
    const spec = RESISTOR_PACKAGE_SPECS[pkg];
    if (!spec) {
      warnings.push(`${role}: 未知封装 ${pkg}`);
      deratingPass = false;
      return;
    }
    if (pW > spec.safePower50PctW) {
      deratingPass = false;
      warnings.push(
        `${role} 封装 ${pkg} 功率 ${(pW * 1000).toFixed(2)}mW 超过 50% 降额上限 ${(spec.safePower50PctW * 1000).toFixed(2)}mW！`
      );
    }
    if (v > spec.maxWorkingVoltageV) {
      deratingPass = false;
      warnings.push(
        `${role} 封装 ${pkg} 承受电压 ${v.toFixed(1)}V 超过封装极限耐压 ${spec.maxWorkingVoltageV}V！`
      );
    } else if (v > spec.safeWorkingVoltage80PctV) {
      deratingPass = false;
      warnings.push(
        `${role} 封装 ${pkg} 承受电压 ${v.toFixed(1)}V 超过 80% 安全降额线 ${spec.safeWorkingVoltage80PctV}V！`
      );
    } else if (pkg === "0603" && v > 50) {
      warnings.push(
        `${role} 0603 封装承受 ${v.toFixed(1)}V 接近 50~75V 耐压边缘，建议升级为 0805。`
      );
    }
  };

  if (hvSplit) {
    // When Vin_max > 150V, enforce 1206 series array
    if (inputs.package && inputs.package !== "1206" && inputs.package !== "2512") {
      // Check single package or user-forced undersized package
      checkResStress("R_top(单颗指定封装)", inputs.package, vAcrossTopTotal, pTopTotal);
      warnings.push(
        `输入最高电压 ${vTopTotal}V > 150V，禁止单颗 ${inputs.package} 直跨，已生成 ${bestSeriesArray.length} 颗 1206 串联均压方案。`
      );
    } else {
      rTopPkg = "1206";
      checkResStress("R_top(串联单颗)", rTopPkg, vAcrossTopEach, pTopEach);
      warnings.push(
        `高压母线 ${vTopTotal}V > 150V，已自动将上臂拆分为 ${bestSeriesArray.length} 颗 1206 串联均压（每颗 ${vAcrossTopEach.toFixed(1)}V, ${(pTopEach * 1000).toFixed(1)}mW）。`
      );
    }
    checkResStress("R_bot", rBotPkg, vTap, pBot);
  } else {
    checkResStress("R_top", rTopPkg, vAcrossTopEach, pTopEach);
    checkResStress("R_bot", rBotPkg, vTap, pBot);
  }

  // ADC Thevenin source impedance check
  let cChargeNf: number | null = null;
  if (mode === "ADC" && inputs.adc_z_max_kohm !== undefined) {
    const zMaxOhm = inputs.adc_z_max_kohm * 1000;
    if (rTh > zMaxOhm) {
      // SAR ADC charge bucket cap >= 2^13 * 10pF (~82nF -> 100nF standard)
      const capMatch = matchStandardCapacitor(100, "nF", { dielectric: "X7R", minVoltageV: 16 });
      cChargeNf = capMatch.nominalValue;
      warnings.push(
        `分压戴维南等效内阻 R_th=${(rTh / 1000).toFixed(2)}kΩ > ADC 允许上限 ${inputs.adc_z_max_kohm}kΩ，请在 ADC 引脚并联 ${cChargeNf}nF 电荷池滤波电容或增加运放跟随器。`
      );
    }
  }

  const recommendedStandardValues: RecommendedStandardValue[] = [];
  if (hvSplit) {
    bestSeriesArray.forEach((val, idx) => {
      const cand = findLcscResistorCandidate(val, "1206");
      recommendedStandardValues.push({
        role: `R_top_${idx + 1}`,
        nominalValue: val,
        unit: "Ohm",
        eSeries: rSeries,
        package: "1206",
        ...(cand ? { lcscCandidate: cand.lcscId } : {}),
      });
    });
  } else {
    const candTop = findLcscResistorCandidate(bestRTop, rTopPkg);
    recommendedStandardValues.push({
      role: "R_top",
      nominalValue: bestRTop,
      unit: "Ohm",
      eSeries: rSeries,
      package: rTopPkg,
      ...(candTop ? { lcscCandidate: candTop.lcscId } : {}),
    });
  }
  const candBot = findLcscResistorCandidate(bestRBot, rBotPkg);
  recommendedStandardValues.push({
    role: "R_bot",
    nominalValue: bestRBot,
    unit: "Ohm",
    eSeries: rSeries,
    package: rBotPkg,
    ...(candBot ? { lcscCandidate: candBot.lcscId } : {}),
  });
  if (cChargeNf !== null) {
    recommendedStandardValues.push({
      role: "C_charge",
      nominalValue: cChargeNf,
      unit: "nF",
      package: "0402",
      lcscCandidate: "C1525",
    });
  }

  return {
    calculator: "voltage_divider",
    formulaUsed:
      mode === "FB"
        ? "Vout = Vref*(1 + Rtop/Rbot) + Ifb*Rtop"
        : "Vadc = Vin*Rbot/(Rtop+Rbot) - Ifb*(Rtop||Rbot); Rth = Rtop||Rbot",
    results: {
      mode,
      r_top_ohm: bestRTop,
      r_bot_ohm: bestRBot,
      r_top_formatted: formatResistance(bestRTop),
      r_bot_formatted: formatResistance(bestRBot),
      r_top_series_count: bestSeriesArray.length,
      r_top_series_array_ohm: bestSeriesArray,
      r_top_package: rTopPkg,
      r_bot_package: rBotPkg,
      v_actual: Number(bestVActual.toFixed(6)),
      v_target: Number((mode === "FB" ? vTopTotal : vTarget).toFixed(6)),
      error_pct: Number(bestErrPct.toFixed(4)),
      i_fb_offset_mv: Number(iFbOffsetMv.toFixed(4)),
      r_th_ohm: Number(rTh.toFixed(2)),
      divider_current_ma: Number(iDivMa.toFixed(4)),
      power_top_total_mw: Number((pTopTotal * 1000).toFixed(3)),
      power_top_each_mw: Number((pTopEach * 1000).toFixed(3)),
      power_bot_mw: Number((pBot * 1000).toFixed(3)),
      v_top_each_v: Number(vAcrossTopEach.toFixed(3)),
      v_bot_v: Number(vTap.toFixed(3)),
      c_charge_nf: cChargeNf,
      hv_series_split: hvSplit,
    },
    recommendedStandardValues,
    deratingPass,
    status: deratingPass ? "PASS" : "FAIL_DERATING",
    warnings,
  };
}
