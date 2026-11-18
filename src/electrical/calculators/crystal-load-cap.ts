import type { ElecCalcResult, RecommendedStandardValue } from "../../types/index.js";
import { matchStandardCapacitor, matchStandardResistor } from "../e-series-grid.js";

export interface CrystalLoadCapInputs {
  cl_datasheet_pf: number;
  freq_mhz: number;
  c_pin_pf?: number;
  c_trace_pf?: number;
  max_dl_uw?: number;
}

export interface CrystalLoadCapResults {
  c_stray_pf: number;
  c1_c2_ideal_pf: number;
  c1_c2_standard_pf: number;
  cl_actual_pf: number;
  cl_mismatch_pf: number;
  r_ext_ideal_ohm: number;
  r_ext_ohm: number;
  recommend_reserve_r_ext: boolean;
  dielectric: "C0G_NP0";
}

export function calculateCrystalLoadCap(
  inputs: CrystalLoadCapInputs
): ElecCalcResult<CrystalLoadCapResults> {
  const cPin = inputs.c_pin_pf ?? 2.0;
  const cTrace = inputs.c_trace_pf ?? 2.0;
  const cStray = cPin + cTrace;
  const cIdeal = 2 * (inputs.cl_datasheet_pf - cStray);
  const warnings: string[] = [];

  if (cIdeal <= 0) {
    return {
      calculator: "crystal_load_cap",
      formulaUsed: "Cstray = Cpin + Ctrace; C1 = C2 = 2*(CL - Cstray)",
      results: {
        c_stray_pf: Number(cStray.toFixed(3)),
        c1_c2_ideal_pf: Number(cIdeal.toFixed(3)),
        c1_c2_standard_pf: 0,
        cl_actual_pf: Number(cStray.toFixed(3)),
        cl_mismatch_pf: Number((cStray - inputs.cl_datasheet_pf).toFixed(3)),
        r_ext_ideal_ohm: 0,
        r_ext_ohm: 0,
        recommend_reserve_r_ext: true,
        dielectric: "C0G_NP0",
      },
      recommendedStandardValues: [],
      deratingPass: false,
      status: "FAIL_STRAY_EXCEEDS_CL",
      warnings: [
        `杂散电容 C_stray=${cStray}pF >= 晶振标称负载电容 CL=${inputs.cl_datasheet_pf}pF，无法匹配！需缩短走线或改用更大 CL 晶振。`,
      ],
    };
  }

  const matchedCap = matchStandardCapacitor(cIdeal, "pF", {
    dielectric: "C0G_NP0",
    minVoltageV: 50,
    preferredPkg: "0402",
  });
  const cStd = matchedCap.nominalValue;
  const clActual = cStd / 2 + cStray;
  const clMismatch = clActual - inputs.cl_datasheet_pf;

  // Series damping resistor estimate: R_ext ≈ 1 / (2 * pi * f0 * C2)
  const f0Hz = inputs.freq_mhz * 1e6;
  const rExtIdeal = f0Hz > 0 && cStd > 0 ? 1 / (2 * Math.PI * f0Hz * (cStd * 1e-12)) : 0;
  const rExtMatch = matchStandardResistor(rExtIdeal, "E24", { preferredPkg: "0402" });

  const isLowPowerOrTiny =
    inputs.freq_mhz <= 0.1 || (inputs.max_dl_uw !== undefined && inputs.max_dl_uw <= 100);
  if (Math.abs(clMismatch) > 2.5) {
    warnings.push(
      `标准电容吸附后负载电容偏差 ${clMismatch.toFixed(2)}pF > 2.5pF，存在频偏风险。`
    );
  }
  if (isLowPowerOrTiny) {
    warnings.push(
      `低激励功率或 32.768kHz 晶振建议在 OSC_OUT 串联预留 0Ω/限流阻尼电阻位（参考阻尼估算 ${rExtMatch.formatted}），防过驱震裂晶片。`
    );
  }

  const recommendedStandardValues: RecommendedStandardValue[] = [
    {
      role: "C1_load (C0G/NP0)",
      nominalValue: cStd,
      unit: "pF",
      eSeries: "E24",
      package: "0402",
      ...(matchedCap.lcscCandidate ? { lcscCandidate: matchedCap.lcscCandidate.lcscId } : {}),
    },
    {
      role: "C2_load (C0G/NP0)",
      nominalValue: cStd,
      unit: "pF",
      eSeries: "E24",
      package: "0402",
      ...(matchedCap.lcscCandidate ? { lcscCandidate: matchedCap.lcscCandidate.lcscId } : {}),
    },
    {
      role: "R_ext_damping",
      nominalValue: rExtMatch.nominalValue,
      unit: "Ohm",
      eSeries: "E24",
      package: "0402",
      ...(rExtMatch.lcscCandidate ? { lcscCandidate: rExtMatch.lcscCandidate.lcscId } : {}),
    },
  ];

  const deratingPass = Math.abs(clMismatch) <= 2.5;

  return {
    calculator: "crystal_load_cap",
    formulaUsed:
      "Cstray = Cpin + Ctrace; C1 = C2 = 2*(CL - Cstray); Rext ≈ 1/(2*pi*f0*C2)",
    results: {
      c_stray_pf: Number(cStray.toFixed(4)),
      c1_c2_ideal_pf: Number(cIdeal.toFixed(4)),
      c1_c2_standard_pf: cStd,
      cl_actual_pf: Number(clActual.toFixed(4)),
      cl_mismatch_pf: Number(clMismatch.toFixed(4)),
      r_ext_ideal_ohm: Number(rExtIdeal.toFixed(2)),
      r_ext_ohm: rExtMatch.nominalValue,
      recommend_reserve_r_ext: true,
      dielectric: "C0G_NP0",
    },
    recommendedStandardValues,
    deratingPass,
    status: deratingPass ? "PASS" : "WARN_CL_MISMATCH",
    warnings,
  };
}
