import type { ElecCalcResult, RecommendedStandardValue } from "../../types/index.js";
import { findLcscResistorCandidate, matchStandardResistor } from "../e-series-grid.js";

export interface MosfetLossGateInputs {
  v_bus: number;
  i_rms: number;
  i_peak: number;
  v_drive: number;
  rdson_25c_mohm: number;
  vgs_spec_min: number;
  qg_nc: number;
  f_sw_khz: number;
  t_rise_ns?: number;
  t_fall_ns?: number;
  r_theta_ja?: number;
  t_ambient_c?: number;
}

export interface MosfetLossGateResults {
  gate_drive_ok: boolean;
  rdson_hot_mohm: number;
  p_conduction_w: number;
  p_switching_w: number;
  p_gate_drive_w: number;
  p_total_w: number;
  t_rise_ns_used: number;
  t_fall_ns_used: number;
  rg_recommended_ohm: number;
  rgs_bleeder_kohm: number;
  estimated_tj_c?: number;
}

export function calculateMosfetLossGate(
  inputs: MosfetLossGateInputs
): ElecCalcResult<MosfetLossGateResults> {
  const warnings: string[] = [];
  const gateDriveOk = inputs.v_drive >= inputs.vgs_spec_min;

  // Recommend Rg (2.2~22 Ohm): faster switching => lower Rg
  const rgTarget = inputs.f_sw_khz >= 200 ? 4.7 : inputs.f_sw_khz >= 50 ? 10 : 22;
  const rgMatch = matchStandardResistor(rgTarget, "E24", { preferredPkg: "0402" });
  const rgsKohm = 10; // Mandatory 10k~47k G-S bleeder

  // Hot RDS(on) = 1.5x 25C spec
  const rdsonHotOhm = (inputs.rdson_25c_mohm * 1.5) / 1000;
  const pCondW = inputs.i_rms * inputs.i_rms * rdsonHotOhm;

  // Switching rise/fall time: use user input or derive from Qg / I_drv
  const driverSourceCurrentA = Math.max(0.1, inputs.v_drive / (rgMatch.nominalValue + 2.0));
  const estEdgeNs = Math.max(10, Math.min(200, (inputs.qg_nc / driverSourceCurrentA) * 0.6));
  const tRiseNs = inputs.t_rise_ns ?? Number(estEdgeNs.toFixed(2));
  const tFallNs = inputs.t_fall_ns ?? Number(estEdgeNs.toFixed(2));
  const fSwHz = inputs.f_sw_khz * 1000;

  const pSwW = 0.5 * inputs.v_bus * inputs.i_peak * ((tRiseNs + tFallNs) * 1e-9) * fSwHz;
  const pGateW = inputs.qg_nc * 1e-9 * inputs.v_drive * fSwHz;
  const pTotalW = pCondW + pSwW + pGateW;

  let estTjC: number | undefined;
  if (inputs.r_theta_ja !== undefined) {
    estTjC = (inputs.t_ambient_c ?? 45) + pTotalW * inputs.r_theta_ja;
  }

  let deratingPass = true;
  let status = "PASS";

  if (!gateDriveOk) {
    deratingPass = false;
    status = "FAIL_GATE_DRIVE_INSUFFICIENT";
    warnings.push(
      `栅极驱动电压不足！V_drive(${inputs.v_drive}V) < V_GS,spec_min(${inputs.vgs_spec_min}V)，MOSFET 无法进入完全饱和区（可能停留在高阻线性区烧管）！请改用逻辑电平管（如 AO3400A @2.5V）或增加栅极驱动 IC。`
    );
  }

  if (estTjC !== undefined && estTjC > 125) {
    deratingPass = false;
    status = gateDriveOk ? "FAIL_THERMAL_OVERLOAD" : status;
    warnings.push(
      `MOSFET 预估结温 TJ=${estTjC.toFixed(1)}°C > 125°C，请降低 RDS(on) 或增大散热铜皮。`
    );
  }

  const rgsCand = findLcscResistorCandidate(rgsKohm * 1000, "0402");
  const recommendedStandardValues: RecommendedStandardValue[] = [
    {
      role: "Rg_series_damping",
      nominalValue: rgMatch.nominalValue,
      unit: "Ohm",
      eSeries: "E24",
      package: "0402",
      ...(rgMatch.lcscCandidate ? { lcscCandidate: rgMatch.lcscCandidate.lcscId } : {}),
    },
    {
      role: "Rgs_bleeder_pulldown",
      nominalValue: rgsKohm,
      unit: "kOhm",
      eSeries: "E24",
      package: "0402",
      ...(rgsCand ? { lcscCandidate: rgsCand.lcscId } : {}),
    },
  ];

  return {
    calculator: "mosfet_loss_gate",
    formulaUsed:
      "P_cond = I_rms^2 * (1.5 * Rdson_25C); P_sw = 0.5 * Vbus * Ipeak * (tr + tf) * fsw; V_drive >= V_GS,spec_min",
    results: {
      gate_drive_ok: gateDriveOk,
      rdson_hot_mohm: Number((rdsonHotOhm * 1000).toFixed(3)),
      p_conduction_w: Number(pCondW.toFixed(6)),
      p_switching_w: Number(pSwW.toFixed(6)),
      p_gate_drive_w: Number(pGateW.toFixed(6)),
      p_total_w: Number(pTotalW.toFixed(6)),
      t_rise_ns_used: tRiseNs,
      t_fall_ns_used: tFallNs,
      rg_recommended_ohm: rgMatch.nominalValue,
      rgs_bleeder_kohm: rgsKohm,
      ...(estTjC !== undefined ? { estimated_tj_c: Number(estTjC.toFixed(2)) } : {}),
    },
    recommendedStandardValues,
    deratingPass,
    status,
    warnings,
  };
}
