import type { ElecCalcResult, RecommendedStandardValue } from "../../types/index.js";
import {
  ORDERED_RESISTOR_PACKAGES,
  RESISTOR_PACKAGE_SPECS,
  findLcscResistorCandidate,
  formatResistance,
  matchStandardResistor,
} from "../e-series-grid.js";

export interface LedOptocouplerInputs {
  device_type: "STATUS_LED" | "OPTO";
  v_supply: number;
  vf_typ?: number;
  i_target_ma?: number;
  opto_ic_ma?: number;
  ctr_min_pct?: number;
  r_package?: "0201" | "0402" | "0603" | "0805" | "1206" | "2512";
}

export interface LedOptocouplerResults {
  device_type: "STATUS_LED" | "OPTO";
  i_f_target_ma: number;
  i_f_actual_ma: number;
  r_ideal_ohm: number;
  r_std_ohm: number;
  r_formatted: string;
  resistor_power_mw: number;
  recommended_min_package: string;
  selected_package: string;
  package_safe_power_mw: number;
  package_max_voltage_v: number;
}

export function calculateLedOptocoupler(
  inputs: LedOptocouplerInputs
): ElecCalcResult<LedOptocouplerResults> {
  const vf = inputs.vf_typ ?? (inputs.device_type === "STATUS_LED" ? 2.0 : 1.2);
  const warnings: string[] = [];

  if (inputs.v_supply <= vf) {
    throw new Error(
      `Supply voltage (${inputs.v_supply}V) must exceed forward voltage Vf (${vf}V).`
    );
  }

  let iFTargetMa: number;
  if (inputs.device_type === "STATUS_LED") {
    iFTargetMa = inputs.i_target_ma ?? 2.0; // Default soft 1.5~2.5mA
    if (iFTargetMa > 5.0) {
      warnings.push(
        `状态指示灯目标电流 ${iFTargetMa}mA 偏高可能刺眼，常规 SMD 指示灯推荐 1.5~2.5mA。`
      );
    }
  } else {
    const icMa = inputs.opto_ic_ma ?? 2.0;
    const ctrMin = inputs.ctr_min_pct ?? 50;
    if (ctrMin <= 0) throw new Error("ctr_min_pct must be > 0.");
    // 2.0x margin for CTR aging and cold temperature degradation
    iFTargetMa = 2.0 * (icMa / (ctrMin / 100));
  }

  const rIdealOhm = (inputs.v_supply - vf) / (iFTargetMa / 1000);
  const rMatch = matchStandardResistor(rIdealOhm, "E24");
  const rStdOhm = rMatch.nominalValue;
  const iFActualMa = ((inputs.v_supply - vf) / rStdOhm) * 1000;
  const pResW = Math.pow(inputs.v_supply - vf, 2) / rStdOhm;
  const pResMw = pResW * 1000;

  // Find smallest SMD package meeting BOTH 50% power derating AND 80% voltage derating
  const minPkg =
    ORDERED_RESISTOR_PACKAGES.find((pkg) => {
      const spec = RESISTOR_PACKAGE_SPECS[pkg];
      const vSafe = pkg === "0603" ? 50 : spec.safeWorkingVoltage80PctV;
      return pResW <= spec.safePower50PctW && inputs.v_supply <= vSafe;
    }) ?? "POWER_RESISTOR_OR_SERIES";

  const selectedPkg = inputs.r_package ?? (minPkg === "POWER_RESISTOR_OR_SERIES" ? "2512" : minPkg);
  const spec = RESISTOR_PACKAGE_SPECS[selectedPkg] ?? RESISTOR_PACKAGE_SPECS["2512"];

  let deratingPass = true;
  if (pResW > spec.safePower50PctW) {
    deratingPass = false;
    warnings.push(
      `限流电阻功耗 ${pResMw.toFixed(2)}mW 超过封装 ${selectedPkg} 的 50% 降额上限 ${(spec.safePower50PctW * 1000).toFixed(2)}mW！推荐最低使用 ${minPkg} 封装或提高阻值/改用直流降压。`
    );
  }
  if (inputs.v_supply > spec.maxWorkingVoltageV) {
    deratingPass = false;
    warnings.push(
      `电源电压 ${inputs.v_supply}V 超过封装 ${selectedPkg} 最高耐压 ${spec.maxWorkingVoltageV}V！请升至 ${minPkg} 或多颗串联。`
    );
  }

  const lcscCand = findLcscResistorCandidate(rStdOhm, selectedPkg);
  const recommendedStandardValues: RecommendedStandardValue[] = [
    {
      role: inputs.device_type === "STATUS_LED" ? "R_led_limit" : "R_opto_primary",
      nominalValue: rStdOhm,
      unit: "Ohm",
      eSeries: "E24",
      package: selectedPkg,
      ...(lcscCand ? { lcscCandidate: lcscCand.lcscId } : {}),
    },
  ];

  return {
    calculator: "led_optocoupler",
    formulaUsed:
      inputs.device_type === "STATUS_LED"
        ? "R = (Vsup - Vf) / I_led; P_R = (Vsup - Vf)^2 / R <= 0.5 * P_rated"
        : "I_F = 2.0 * I_C / CTR_min; R = (Vsup - Vf) / I_F; P_R <= 0.5 * P_rated",
    results: {
      device_type: inputs.device_type,
      i_f_target_ma: Number(iFTargetMa.toFixed(4)),
      i_f_actual_ma: Number(iFActualMa.toFixed(4)),
      r_ideal_ohm: Number(rIdealOhm.toFixed(2)),
      r_std_ohm: rStdOhm,
      r_formatted: formatResistance(rStdOhm),
      resistor_power_mw: Number(pResMw.toFixed(3)),
      recommended_min_package: minPkg,
      selected_package: selectedPkg,
      package_safe_power_mw: Number((spec.safePower50PctW * 1000).toFixed(2)),
      package_max_voltage_v: spec.maxWorkingVoltageV,
    },
    recommendedStandardValues,
    deratingPass,
    status: deratingPass ? "PASS" : "FAIL_RESISTOR_DERATING",
    warnings,
  };
}
