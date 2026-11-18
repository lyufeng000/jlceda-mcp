import type { ElecCalcResult, RecommendedStandardValue } from "../../types/index.js";
import {
  formatCapacitanceFromPf,
  formatResistance,
  matchStandardCapacitor,
  matchStandardResistor,
} from "../e-series-grid.js";

export interface RcFilterDampingInputs {
  mode: "LPF" | "DEBOUNCE" | "BEAD_DAMP";
  r_ohm?: number;
  c_pf?: number;
  c_nf?: number;
  c_uf?: number;
  fc_hz?: number;
  debounce_ms?: number;
  tau_ms?: number;
  l_bead_uh?: number;
  c_mlcc_uf?: number;
  r_dc_bead?: number;
  r_esr_cap?: number;
  r_source?: number;
}

export interface RcFilterDampingResults {
  mode: "LPF" | "DEBOUNCE" | "BEAD_DAMP";
  r_ohm?: number;
  c_uf?: number;
  fc_hz?: number;
  tau_ms?: number;
  group_delay_ms?: number;
  t_settle_90pct_ms?: number;
  // BEAD_DAMP fields
  l_bead_uh?: number;
  c_eff_uf?: number;
  r_total_ohm?: number;
  resonant_freq_hz?: number;
  resonant_freq_khz?: number;
  q_factor?: number;
  peak_gain_db?: number;
  needs_damping?: boolean;
  c_damp_ideal_uf?: number;
  c_damp_std_uf?: number;
  r_damp_ideal_ohm?: number;
  r_damp_std_ohm?: number;
  damped_q_factor?: number;
}

function getCapFarads(inputs: RcFilterDampingInputs): number | undefined {
  if (inputs.c_uf !== undefined) return inputs.c_uf * 1e-6;
  if (inputs.c_nf !== undefined) return inputs.c_nf * 1e-9;
  if (inputs.c_pf !== undefined) return inputs.c_pf * 1e-12;
  if (inputs.c_mlcc_uf !== undefined) return inputs.c_mlcc_uf * 1e-6;
  return undefined;
}

export function calculateRcFilterDamping(
  inputs: RcFilterDampingInputs
): ElecCalcResult<RcFilterDampingResults> {
  const warnings: string[] = [];
  const recommendedStandardValues: RecommendedStandardValue[] = [];

  if (inputs.mode === "BEAD_DAMP") {
    const lUh = inputs.l_bead_uh ?? 1.2;
    const cEffUf = inputs.c_mlcc_uf ?? inputs.c_uf ?? 4.7;
    const rTotal =
      (inputs.r_dc_bead ?? 0.15) +
      (inputs.r_esr_cap ?? 0.02) +
      (inputs.r_source ?? 0);

    if (lUh <= 0 || cEffUf <= 0 || rTotal <= 0) {
      throw new Error("Invalid BEAD_DAMP inputs: L, C, and R_total must be > 0.");
    }

    const L = lUh * 1e-6;
    const C = cEffUf * 1e-6;
    const f0 = 1 / (2 * Math.PI * Math.sqrt(L * C));
    const z0 = Math.sqrt(L / C);
    const q = z0 / rTotal;
    const needsDamping = q > 1.0;
    const peakGainDb = needsDamping ? 20 * Math.log10(q) : 0;

    let cDampIdealUf: number | undefined;
    let cDampStdUf: number | undefined;
    let rDampIdealOhm: number | undefined;
    let rDampStdOhm: number | undefined;
    let dampedQ: number | undefined;

    if (needsDamping) {
      cDampIdealUf = 4 * cEffUf;
      rDampIdealOhm = z0; // sqrt(L / C)
      const cMatch = matchStandardCapacitor(cDampIdealUf, "uF", {
        dielectric: "X7R",
        minVoltageV: 16,
        preferredPkg: "0805",
        preferCeil: true,
      });
      const rMatch = matchStandardResistor(rDampIdealOhm, "E24", {
        preferredPkg: "0603",
      });
      cDampStdUf = cMatch.nominalValue;
      rDampStdOhm = rMatch.nominalValue;
      // Approximate effective Q after parallel RC damping branch
      const cDampF = cDampStdUf * 1e-6;
      const rEqDamp = 1 / (1 / rDampStdOhm + rTotal / z0 ** 2);
      dampedQ = Math.min(0.85, Math.sqrt(L / (C + cDampF)) / Math.max(rTotal, 1e-3) * (rDampStdOhm / (z0 + rDampStdOhm)));

      warnings.push(
        `磁珠+MLCC 呈欠阻尼谐振 (Q=${q.toFixed(2)} > 1, f0=${(f0 / 1000).toFixed(2)}kHz, 谐振峰 +${peakGainDb.toFixed(2)}dB)！需并联 C_damp=${cDampStdUf}uF 串联 R_damp=${rMatch.formatted} 阻尼网络。`
      );
      recommendedStandardValues.push(
        {
          role: "C_damp",
          nominalValue: cDampStdUf,
          unit: "uF",
          eSeries: "E24",
          package: "0805",
          ...(cMatch.lcscCandidate ? { lcscCandidate: cMatch.lcscCandidate.lcscId } : {}),
        },
        {
          role: "R_damp",
          nominalValue: rDampStdOhm,
          unit: "Ohm",
          eSeries: "E24",
          package: "0603",
          ...(rMatch.lcscCandidate ? { lcscCandidate: rMatch.lcscCandidate.lcscId } : {}),
        }
      );
    }

    return {
      calculator: "rc_filter_damping",
      formulaUsed:
        "f0 = 1/(2*pi*sqrt(L*C)); Q = (1/R_total)*sqrt(L/C); Peak_dB = 20*log10(Q); Cdamp=4*C, Rdamp=sqrt(L/C)",
      results: {
        mode: "BEAD_DAMP",
        l_bead_uh: lUh,
        c_eff_uf: cEffUf,
        r_total_ohm: Number(rTotal.toFixed(4)),
        resonant_freq_hz: Number(f0.toFixed(2)),
        resonant_freq_khz: Number((f0 / 1000).toFixed(3)),
        q_factor: Number(q.toFixed(4)),
        peak_gain_db: Number(peakGainDb.toFixed(4)),
        needs_damping: needsDamping,
        ...(cDampIdealUf !== undefined ? { c_damp_ideal_uf: Number(cDampIdealUf.toFixed(3)) } : {}),
        ...(cDampStdUf !== undefined ? { c_damp_std_uf: cDampStdUf } : {}),
        ...(rDampIdealOhm !== undefined ? { r_damp_ideal_ohm: Number(rDampIdealOhm.toFixed(4)) } : {}),
        ...(rDampStdOhm !== undefined ? { r_damp_std_ohm: rDampStdOhm } : {}),
        ...(dampedQ !== undefined ? { damped_q_factor: Number(dampedQ.toFixed(4)) } : {}),
      },
      recommendedStandardValues,
      deratingPass: !needsDamping,
      status: needsDamping ? "FAIL_RESONANCE_PEAK_DAMPING_REQUIRED" : "PASS",
      warnings,
    };
  }

  if (inputs.mode === "DEBOUNCE") {
    const targetTauS =
      inputs.tau_ms !== undefined
        ? inputs.tau_ms / 1000
        : inputs.debounce_ms !== undefined
          ? inputs.debounce_ms / 1000
          : undefined;
    let rOhm = inputs.r_ohm;
    let cF = getCapFarads(inputs);

    if (rOhm !== undefined && cF !== undefined) {
      const rMatch = matchStandardResistor(rOhm, "E24", { preferredPkg: "0402" });
      const cMatch = matchStandardCapacitor(cF * 1e9, "nF", { dielectric: "X7R" });
      rOhm = rMatch.nominalValue;
      cF = cMatch.nominalValue * 1e-9;
    } else if (targetTauS !== undefined) {
      if (cF !== undefined) {
        rOhm = matchStandardResistor(targetTauS / cF, "E24", { preferredPkg: "0402" }).nominalValue;
        cF = matchStandardCapacitor(cF * 1e9, "nF", { dielectric: "X7R" }).nominalValue * 1e-9;
      } else if (rOhm !== undefined) {
        cF = matchStandardCapacitor((targetTauS / rOhm) * 1e9, "nF", { dielectric: "X7R" }).nominalValue * 1e-9;
        rOhm = matchStandardResistor(rOhm, "E24", { preferredPkg: "0402" }).nominalValue;
      } else {
        // Default 100nF standard cap -> solve R
        cF = 100e-9;
        rOhm = matchStandardResistor(targetTauS / cF, "E24", { preferredPkg: "0402" }).nominalValue;
      }
    } else {
      // Default 10ms -> 100k + 100nF
      rOhm = 100_000;
      cF = 100e-9;
    }

    const tauMs = rOhm * cF * 1000;
    const fcHz = 1 / (2 * Math.PI * rOhm * cF);
    const t90Ms = 2.302585 * tauMs;
    const rMatch = matchStandardResistor(rOhm, "E24", { preferredPkg: "0402" });
    const cMatch = matchStandardCapacitor(cF * 1e6, "uF", { dielectric: "X7R", minVoltageV: 16, preferredPkg: "0402" });

    recommendedStandardValues.push(
      {
        role: "R_debounce",
        nominalValue: rMatch.nominalValue,
        unit: "Ohm",
        eSeries: "E24",
        package: "0402",
        ...(rMatch.lcscCandidate ? { lcscCandidate: rMatch.lcscCandidate.lcscId } : {}),
      },
      {
        role: "C_debounce",
        nominalValue: Number((cF * 1e9).toPrecision(4)),
        unit: "nF",
        eSeries: "E24",
        package: "0402",
        ...(cMatch.lcscCandidate ? { lcscCandidate: cMatch.lcscCandidate.lcscId } : {}),
      }
    );

    return {
      calculator: "rc_filter_damping",
      formulaUsed: "tau = R * C; t_90% = 2.3026 * tau; fc = 1/(2*pi*R*C)",
      results: {
        mode: "DEBOUNCE",
        r_ohm: rMatch.nominalValue,
        c_uf: Number((cF * 1e6).toPrecision(6)),
        tau_ms: Number(tauMs.toFixed(4)),
        t_settle_90pct_ms: Number(t90Ms.toFixed(4)),
        fc_hz: Number(fcHz.toFixed(4)),
      },
      recommendedStandardValues,
      deratingPass: true,
      status: "PASS",
      warnings,
    };
  }

  // LPF Mode
  let rOhm = inputs.r_ohm;
  let cF = getCapFarads(inputs);
  if (rOhm === undefined || cF === undefined) {
    if (inputs.fc_hz !== undefined && inputs.fc_hz > 0) {
      if (rOhm !== undefined) {
        cF = matchStandardCapacitor(1 / (2 * Math.PI * inputs.fc_hz * rOhm) * 1e9, "nF", {
          dielectric: "C0G_NP0",
        }).nominalValue * 1e-9;
        rOhm = matchStandardResistor(rOhm, "E24").nominalValue;
      } else if (cF !== undefined) {
        rOhm = matchStandardResistor(1 / (2 * Math.PI * inputs.fc_hz * cF), "E24").nominalValue;
        cF = matchStandardCapacitor(cF * 1e9, "nF", { dielectric: "C0G_NP0" }).nominalValue * 1e-9;
      } else {
        // Choose practical 10nF or 100nF so R lands in 100 Ohm .. 100 kOhm
        const tryCaps = [100e-12, 1e-9, 10e-9, 100e-9, 1e-6];
        cF = tryCaps.find((c) => {
          const r = 1 / (2 * Math.PI * inputs.fc_hz! * c);
          return r >= 200 && r <= 100_000;
        }) ?? 10e-9;
        rOhm = matchStandardResistor(1 / (2 * Math.PI * inputs.fc_hz * cF), "E24").nominalValue;
      }
    } else {
      throw new Error("LPF mode requires either (r_ohm and c) or fc_hz.");
    }
  } else {
    rOhm = matchStandardResistor(rOhm, "E24").nominalValue;
    cF = matchStandardCapacitor(cF * 1e12, "pF").nominalValue * 1e-12;
  }

  const tauMs = rOhm * cF * 1000;
  const fcHz = 1 / (2 * Math.PI * rOhm * cF);
  const groupDelayMs = tauMs;
  const rMatch = matchStandardResistor(rOhm, "E24", { preferredPkg: "0402" });
  const cMatch = matchStandardCapacitor(cF * 1e12, "pF", { preferredPkg: "0402" });

  recommendedStandardValues.push(
    {
      role: `R_lpf (${formatResistance(rOhm)})`,
      nominalValue: rOhm,
      unit: "Ohm",
      eSeries: "E24",
      package: "0402",
      ...(rMatch.lcscCandidate ? { lcscCandidate: rMatch.lcscCandidate.lcscId } : {}),
    },
    {
      role: `C_lpf (${formatCapacitanceFromPf(cF * 1e12)})`,
      nominalValue: Number((cF * 1e9).toPrecision(4)),
      unit: "nF",
      eSeries: "E24",
      package: "0402",
      ...(cMatch.lcscCandidate ? { lcscCandidate: cMatch.lcscCandidate.lcscId } : {}),
    }
  );

  return {
    calculator: "rc_filter_damping",
    formulaUsed: "fc = 1/(2*pi*R*C); tau = R*C",
    results: {
      mode: "LPF",
      r_ohm: rOhm,
      c_uf: Number((cF * 1e6).toPrecision(6)),
      fc_hz: Number(fcHz.toFixed(4)),
      tau_ms: Number(tauMs.toFixed(6)),
      group_delay_ms: Number(groupDelayMs.toFixed(6)),
    },
    recommendedStandardValues,
    deratingPass: true,
    status: "PASS",
    warnings,
  };
}
