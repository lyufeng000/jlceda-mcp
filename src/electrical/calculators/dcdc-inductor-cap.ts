import type { ElecCalcResult, RecommendedStandardValue } from "../../types/index.js";
import { matchStandardCapacitor, matchStandardInductor } from "../e-series-grid.js";

export interface DcdcInductorCapInputs {
  topology: "BUCK" | "BOOST";
  v_in_range: [number, number];
  v_out: number;
  i_out_max: number;
  f_sw_khz: number;
  ripple_ratio?: number;
  ic_ocp_limit_a?: number;
  efficiency?: number;
  c_out_eff_req_uf?: number;
  v_ripple_target_mv?: number;
  cap_dielectric?: "X5R" | "X7R";
  cap_package?: "0402" | "0603" | "0805" | "1206";
  cap_voltage_rating_v?: number;
}

export interface DcdcInductorCapResults {
  topology: "BUCK" | "BOOST";
  duty_cycle_min: number;
  duty_cycle_max: number;
  l_ideal_uh: number;
  l_uh: number;
  delta_il_a: number;
  i_l_avg_a: number;
  i_peak: number;
  i_rms_min: number;
  i_sat_min: number;
  i_cin_rms: number;
  c_out_eff_req_uf: number;
  dc_bias_retention_factor: number;
  c_out_nom_req_uf: number;
  c_out_unit_nom_uf: number;
  c_out_parallel_count: number;
  c_out_total_eff_uf: number;
  c_out_voltage_rating_v: number;
  c_out_package: string;
  c_out_dielectric: "X5R" | "X7R";
}

/**
 * Estimate MLCC DC-bias retention factor alpha in (0, 1] as a function of
 * DC voltage, rated voltage, package size, and Class-II dielectric (X5R/X7R).
 */
export function estimateMlccDcBiasRetention(
  vDc: number,
  vRated: number,
  pkg: "0402" | "0603" | "0805" | "1206",
  dielectric: "X5R" | "X7R"
): number {
  const u = Math.min(1.0, Math.max(0, vDc / Math.max(vRated, 0.1)));
  // Higher coefficient = steeper capacitance drop under DC field (smaller case = thinner dielectric layers = higher E-field)
  const kMap: Record<string, Record<"X5R" | "X7R", number>> = {
    "0402": { X5R: 1.12, X7R: 0.92 },
    "0603": { X5R: 0.86, X7R: 0.70 },
    "0805": { X5R: 0.62, X7R: 0.48 },
    "1206": { X5R: 0.42, X7R: 0.30 },
  };
  const k = kMap[pkg]?.[dielectric] ?? 0.6;
  const retention = 1.0 - k * Math.pow(u, 1.35);
  return Number(Math.max(0.14, Math.min(0.98, retention)).toFixed(4));
}

function selectStandardCapVoltage(vOut: number): number {
  const minReq = vOut * 1.8;
  const ratings = [6.3, 10, 16, 25, 35, 50, 100];
  return ratings.find((r) => r >= minReq) ?? 100;
}

export function calculateDcdcInductorCap(
  inputs: DcdcInductorCapInputs
): ElecCalcResult<DcdcInductorCapResults> {
  const [vInMin, vInMax] = inputs.v_in_range;
  const vOut = inputs.v_out;
  const iOutMax = inputs.i_out_max;
  const fSwHz = inputs.f_sw_khz * 1000;
  const r = inputs.ripple_ratio ?? 0.3;
  const eta = inputs.efficiency ?? (inputs.topology === "BUCK" ? 0.9 : 0.88);
  const warnings: string[] = [];

  if (vInMin <= 0 || vInMax < vInMin || vOut <= 0 || iOutMax <= 0 || fSwHz <= 0) {
    throw new Error("Invalid dcdc_inductor_cap inputs: voltages, current, and frequency must be positive.");
  }

  let dMin: number;
  let dMax: number;
  let iLAvg: number;
  let lIdealH: number;
  let lStdUh: number;
  let deltaIL: number;
  let iPeak: number;
  let iRms: number;
  let iCinRms: number;

  if (inputs.topology === "BUCK") {
    if (vInMin <= vOut) {
      warnings.push(`Buck 最小输入电压 ${vInMin}V <= 输出电压 ${vOut}V，可能发生压差失稳！`);
    }
    dMin = Math.min(0.98, vOut / (vInMax * eta));
    dMax = Math.min(0.98, vOut / (vInMin * eta));
    iLAvg = iOutMax;
    const targetDeltaI = r * iOutMax;
    lIdealH = (vOut * (vInMax - vOut)) / (vInMax * fSwHz * targetDeltaI);
    const matchedL = matchStandardInductor(lIdealH * 1e6);
    lStdUh = matchedL.nominalValue;
    const lStdH = lStdUh * 1e-6;
    deltaIL = (vOut * (vInMax - vOut)) / (vInMax * fSwHz * lStdH);
    iPeak = iLAvg + deltaIL / 2;
    iRms = Math.sqrt(iLAvg * iLAvg + (deltaIL * deltaIL) / 12);
    // Input capacitor RMS ripple: max(Iout * sqrt(D*(1-D))) over D in [dMin, dMax]
    const dWorst = dMin <= 0.5 && dMax >= 0.5 ? 0.5 : (Math.abs(dMin - 0.5) < Math.abs(dMax - 0.5) ? dMin : dMax);
    iCinRms = iOutMax * Math.sqrt(dWorst * (1 - dWorst));
  } else {
    if (vOut <= vInMin) {
      warnings.push(`Boost 输出电压 ${vOut}V <= 最小输入电压 ${vInMin}V，无法正常升压！`);
    }
    dMax = Math.min(0.92, Math.max(0.05, 1 - (vInMin * eta) / vOut));
    dMin = Math.min(0.92, Math.max(0.05, 1 - (vInMax * eta) / vOut));
    iLAvg = (vOut * iOutMax) / (vInMin * eta);
    const targetDeltaI = r * iLAvg;
    lIdealH = (vInMin * dMax) / (fSwHz * targetDeltaI);
    const matchedL = matchStandardInductor(lIdealH * 1e6);
    lStdUh = matchedL.nominalValue;
    const lStdH = lStdUh * 1e-6;
    deltaIL = (vInMin * dMax) / (fSwHz * lStdH);
    iPeak = iLAvg + deltaIL / 2;
    iRms = Math.sqrt(iLAvg * iLAvg + (deltaIL * deltaIL) / 12);
    iCinRms = deltaIL / Math.sqrt(12);
  }

  const iSatMin = Math.max(1.3 * iPeak, 1.1 * (inputs.ic_ocp_limit_a ?? 0));

  // Output capacitor requirement & DC bias derating compensation
  const vRippleTargetV = (inputs.v_ripple_target_mv ?? 20) / 1000;
  const cEffReqF =
    inputs.c_out_eff_req_uf !== undefined
      ? inputs.c_out_eff_req_uf * 1e-6
      : inputs.topology === "BUCK"
        ? Math.max(22e-6, deltaIL / (8 * fSwHz * vRippleTargetV))
        : Math.max(22e-6, (iOutMax * dMax) / (fSwHz * vRippleTargetV));
  const cEffReqUf = cEffReqF * 1e6;

  const dielectric = inputs.cap_dielectric ?? "X7R";
  const pkg = inputs.cap_package ?? "0805";
  const vRated = inputs.cap_voltage_rating_v ?? selectStandardCapVoltage(vOut);

  let deratingPass = true;
  if (vRated < 1.5 * vOut) {
    deratingPass = false;
    warnings.push(
      `输出 MLCC 额定耐压 ${vRated}V < 1.5 * Vout(${(1.5 * vOut).toFixed(1)}V)，存在耐压与偏置双风险！`
    );
  }

  const retention = estimateMlccDcBiasRetention(vOut, vRated, pkg, dielectric);
  if (retention < 0.35) {
    warnings.push(
      `${pkg} ${dielectric} ${vRated}V 在 ${vOut}V 偏压下有效容量保持率仅 ${(retention * 100).toFixed(1)}%，建议改用更大封装(0805/1206)或更高耐压电容！`
    );
  }

  const cNomReqUf = cEffReqUf / retention;
  // Choose unit nominal cap (typically 10uF or 22uF in 0805/1206)
  const unitCapNomUf = cNomReqUf > 30 && pkg !== "0402" ? 22 : 10;
  const parallelCount = Math.max(1, Math.ceil(cNomReqUf / unitCapNomUf));
  const totalEffUf = parallelCount * unitCapNomUf * retention;

  const indMatched = matchStandardInductor(lStdUh);
  const capMatched = matchStandardCapacitor(unitCapNomUf, "uF", {
    dielectric,
    minVoltageV: vRated,
    preferredPkg: pkg,
  });

  const recommendedStandardValues: RecommendedStandardValue[] = [
    {
      role: "L_power",
      nominalValue: lStdUh,
      unit: "uH",
      package: "SMD-5040",
      ...(indMatched.lcscCandidate ? { lcscCandidate: indMatched.lcscCandidate.lcscId } : {}),
    },
    {
      role: `C_out (x${parallelCount})`,
      nominalValue: unitCapNomUf,
      unit: "uF",
      package: pkg,
      ...(capMatched.lcscCandidate ? { lcscCandidate: capMatched.lcscCandidate.lcscId } : {}),
    },
  ];

  return {
    calculator: "dcdc_inductor_cap",
    formulaUsed:
      inputs.topology === "BUCK"
        ? "D=Vout/(Vin*eta); L=Vout*(Vin_max-Vout)/(Vin_max*fsw*r*Iout); Isat>=max(1.3*Ipeak,1.1*Iocp); Cnom=Ceff/alpha_bias"
        : "D=1-(Vin_min*eta)/Vout; L=Vin_min*D/(fsw*r*Iin); Isat>=max(1.3*Ipeak,1.1*Iocp); Cnom=Ceff/alpha_bias",
    results: {
      topology: inputs.topology,
      duty_cycle_min: Number(dMin.toFixed(4)),
      duty_cycle_max: Number(dMax.toFixed(4)),
      l_ideal_uh: Number((lIdealH * 1e6).toFixed(4)),
      l_uh: lStdUh,
      delta_il_a: Number(deltaIL.toFixed(4)),
      i_l_avg_a: Number(iLAvg.toFixed(4)),
      i_peak: Number(iPeak.toFixed(4)),
      i_rms_min: Number(iRms.toFixed(4)),
      i_sat_min: Number(iSatMin.toFixed(4)),
      i_cin_rms: Number(iCinRms.toFixed(4)),
      c_out_eff_req_uf: Number(cEffReqUf.toFixed(2)),
      dc_bias_retention_factor: retention,
      c_out_nom_req_uf: Number(cNomReqUf.toFixed(2)),
      c_out_unit_nom_uf: unitCapNomUf,
      c_out_parallel_count: parallelCount,
      c_out_total_eff_uf: Number(totalEffUf.toFixed(2)),
      c_out_voltage_rating_v: vRated,
      c_out_package: pkg,
      c_out_dielectric: dielectric,
    },
    recommendedStandardValues,
    deratingPass,
    status: deratingPass ? "PASS" : "FAIL_DERATING",
    warnings,
  };
}
