import type { ElecCalcResult, RecommendedStandardValue } from "../../types/index.js";

export interface LdoThermalInputs {
  v_in_min: number;
  v_in_max: number;
  v_out: number;
  i_load_avg: number;
  i_load_peak?: number;
  v_dropout: number;
  r_theta_ja: number;
  t_ambient_c?: number;
  mlcc_stable?: boolean;
  i_q_ma?: number;
}

export interface LdoThermalResults {
  dropout_margin_v: number;
  dropout_pass: boolean;
  pd_watts: number;
  tj_celsius: number;
  efficiency_at_vin_max_pct: number;
  efficiency_at_vin_min_pct: number;
  mlcc_stable: boolean;
  series_esr_required_ohm: number | null;
}

export function calculateLdoThermal(
  inputs: LdoThermalInputs
): ElecCalcResult<LdoThermalResults> {
  const iLoadAvg = inputs.i_load_avg;
  const iLoadPeak = inputs.i_load_peak ?? iLoadAvg;
  const tAmbient = inputs.t_ambient_c ?? 45.0;
  const mlccStable = inputs.mlcc_stable ?? true;
  const iQ = (inputs.i_q_ma ?? 0) / 1000;

  const dropoutMarginV = inputs.v_in_min - inputs.v_out - inputs.v_dropout;
  const dropoutPass = inputs.v_in_min - inputs.v_out >= inputs.v_dropout;

  const pdWatts =
    (inputs.v_in_max - inputs.v_out) * iLoadAvg + inputs.v_in_max * iQ;
  const tjCelsius = tAmbient + pdWatts * inputs.r_theta_ja;

  const etaMaxVin =
    inputs.v_in_max > 0 && iLoadAvg + iQ > 0
      ? ((inputs.v_out * iLoadAvg) / (inputs.v_in_max * (iLoadAvg + iQ))) * 100
      : 0;
  const etaMinVin =
    inputs.v_in_min > 0 && iLoadAvg + iQ > 0
      ? ((inputs.v_out * iLoadAvg) / (inputs.v_in_min * (iLoadAvg + iQ))) * 100
      : 0;

  const warnings: string[] = [];
  let status = "PASS";
  let deratingPass = true;

  if (!dropoutPass) {
    deratingPass = false;
    status = "FAIL_DROPOUT_INSUFFICIENT";
    warnings.push(
      `最小输入压差不足: Vin_min(${inputs.v_in_min}V) - Vout(${inputs.v_out}V) = ${(inputs.v_in_min - inputs.v_out).toFixed(3)}V < Vdropout(${inputs.v_dropout}V) @ Ipeak=${iLoadPeak}A。`
    );
  }

  if (pdWatts > 0.6 || tjCelsius > 105.0) {
    deratingPass = false;
    status = "FAIL_SWITCH_TO_DCDC";
    warnings.push(
      `LDO 热耗散超标 (PD=${pdWatts.toFixed(3)}W, TJ=${tjCelsius.toFixed(1)}°C，超过 0.6W / 105°C 红线)！必须切换为同步 DC-DC Buck（BLK_DCDC_BUCK_SYNC）或采用前级 DC-DC 预降压。`
    );
  }

  let seriesEsrOhm: number | null = null;
  const recommendedStandardValues: RecommendedStandardValue[] = [];
  if (!mlccStable) {
    seriesEsrOhm = 0.33;
    warnings.push(
      `该 LDO (mlcc_stable=false，如传统 1117 架构) 不兼容超低 ESR 陶瓷电容！必须在输出 MLCC 支路串联 0.22Ω~0.47Ω 人工 ESR 电阻（推荐 0.33Ω），或改换 RT9013/TLV755P 等 MLCC 稳定型 LDO。`
    );
    recommendedStandardValues.push({
      role: "R_esr_damping",
      nominalValue: 0.33,
      unit: "Ohm",
      eSeries: "E24",
      package: "0603",
      lcscCandidate: "C25365",
    });
  }

  return {
    calculator: "ldo_thermal",
    formulaUsed:
      "PD = (Vin_max - Vout)*Iload_avg + Vin_max*Iq; TJ = TA + PD*RthetaJA",
    results: {
      dropout_margin_v: Number(dropoutMarginV.toFixed(4)),
      dropout_pass: dropoutPass,
      pd_watts: Number(pdWatts.toFixed(6)),
      tj_celsius: Number(tjCelsius.toFixed(4)),
      efficiency_at_vin_max_pct: Number(etaMaxVin.toFixed(2)),
      efficiency_at_vin_min_pct: Number(etaMinVin.toFixed(2)),
      mlcc_stable: mlccStable,
      series_esr_required_ohm: seriesEsrOhm,
    },
    recommendedStandardValues,
    deratingPass,
    status,
    warnings,
  };
}
